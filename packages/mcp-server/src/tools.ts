import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import {
  DeviceCommandError,
  type DeviceGateway,
  DeviceUnavailableError,
} from "./device.js";
import {
  type CommandResult,
  parseCommandResult,
} from "./protocol.js";

const DeviceSelectorSchema = z.object({
  device: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional(),
});

class ShellCommandError extends Error {
  public constructor(public readonly result: CommandResult) {
    super(result.stderr.trim() || result.stdout.trim() || `设备命令失败（exit=${result.exit_code}）`);
    this.name = "ShellCommandError";
  }
}

class XiaoaiToolService {
  public constructor(private readonly devices: DeviceGateway) {}

  public register(server: McpServer): void {
    server.registerTool(
      "xiaoai_list_devices",
      {
        title: "列出小爱设备",
        description: "列出当前通过反向 WebSocket 连接到网关的小爱音箱。多个设备时，其他工具必须传入 device。",
        inputSchema: z.object({}),
      },
      async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ devices: this.devices.listDevices() }),
          },
        ],
      }),
    );

    server.registerTool(
      "xiaoai_speak",
      {
        title: "小爱文字播报",
        description: "使用小爱音箱原生 TTS 播报文字。blocking=true 会等待播放脚本结束。",
        inputSchema: DeviceSelectorSchema.extend({
          text: z.string().trim().min(1).max(500),
          blocking: z.boolean().optional().default(false),
        }),
      },
      async ({ device, text, blocking }) =>
        this.runTool(async () => {
          const payload = blocking ? this.blockingTtsCommand(text) : this.nonBlockingTtsCommand(text);
          const result = await this.runShell(device, payload);
          return { action: "speak", blocking, ...result };
        }),
    );

    server.registerTool(
      "xiaoai_play_url",
      {
        title: "小爱播放音频链接",
        description: "让小爱音箱播放一个 HTTP 或 HTTPS 音频 URL。",
        inputSchema: DeviceSelectorSchema.extend({
          url: z.url().max(2_048).refine((value) => {
            const protocol = new URL(value).protocol;
            return protocol === "http:" || protocol === "https:";
          }, "只允许 http 或 https URL"),
        }),
      },
      async ({ device, url }) =>
        this.runTool(async () => {
          const result = await this.runShell(device, this.playUrlCommand(url));
          return { action: "play_url", url, ...result };
        }),
    );

    server.registerTool(
      "xiaoai_interrupt",
      {
        title: "打断小爱播放",
        description: "停止当前小爱 TTS 和媒体播放。",
        inputSchema: DeviceSelectorSchema,
      },
      async ({ device }) =>
        this.runTool(async () => {
          const result = await this.runShell(device, "killall tts_play.sh miplayer 2>/dev/null; mphelper pause");
          return { action: "interrupt", ...result };
        }),
    );

    server.registerTool(
      "xiaoai_wake",
      {
        title: "唤醒小爱",
        description: "唤醒小爱并进入监听。默认静默唤醒，不播放系统唤醒提示音。",
        inputSchema: DeviceSelectorSchema.extend({
          silent: z.boolean().optional().default(true),
        }),
      },
      async ({ device, silent }) =>
        this.runTool(async () => {
          const source = silent ? 1 : 0;
          const result = await this.runShell(device, `ubus call pnshelper event_notify '{"src":${source},"event":0}'`);
          return { action: "wake", silent, ...result };
        }),
    );

    server.registerTool(
      "xiaoai_sleep",
      {
        title: "退出小爱监听",
        description: "停止小爱当前监听状态。",
        inputSchema: DeviceSelectorSchema,
      },
      async ({ device }) =>
        this.runTool(async () => {
          const result = await this.runShell(
            device,
            "ubus call pnshelper event_notify '{\"src\":3,\"event\":7}'; sleep 0.1; ubus call pnshelper event_notify '{\"src\":3,\"event\":8}'",
          );
          return { action: "sleep", ...result };
        }),
    );

    server.registerTool(
      "xiaoai_ask",
      {
        title: "交给原生小爱处理",
        description: "将自然语言指令交给小爱原生能力处理。不要用于支付、门锁、安防等高风险操作，除非用户明确确认。",
        inputSchema: DeviceSelectorSchema.extend({
          text: z.string().trim().min(1).max(500),
          silent: z.boolean().optional().default(false),
        }),
      },
      async ({ device, text, silent }) =>
        this.runTool(async () => {
          const result = await this.runShell(device, this.askXiaoaiCommand(text, silent));
          return { action: "ask", silent, ...result };
        }),
    );

    server.registerTool(
      "xiaoai_status",
      {
        title: "查询小爱播放状态",
        description: "返回小爱音箱当前播放状态：playing、paused 或 idle。",
        inputSchema: DeviceSelectorSchema,
      },
      async ({ device }) =>
        this.runTool(async () => {
          const result = await this.runShell(device, "mphelper mute_stat");
          const status = result.stdout.includes("1") ? "playing" : result.stdout.includes("2") ? "paused" : "idle";
          return { action: "status", status, ...result };
        }),
    );

    server.registerTool(
      "xiaoai_device_info",
      {
        title: "查询小爱设备信息",
        description: "返回小爱音箱型号和序列号。",
        inputSchema: DeviceSelectorSchema,
      },
      async ({ device }) =>
        this.runTool(async () => {
          const result = await this.runShell(device, "printf '%s %s\\n' \"$(micocfg_model)\" \"$(micocfg_sn)\"");
          const [model = "unknown", serialNumber = "unknown"] = result.stdout.trim().split(/\s+/, 2);
          return { action: "device_info", model, serialNumber, ...result };
        }),
    );

    server.registerTool(
      "xiaoai_mic",
      {
        title: "控制或查询小爱麦克风",
        description: "打开、关闭或查询小爱音箱麦克风状态。",
        inputSchema: DeviceSelectorSchema.extend({
          action: z.enum(["on", "off", "status"]),
        }),
      },
      async ({ device, action }) =>
        this.runTool(async () => {
          if (action === "status") {
            const result = await this.runShell(device, "[ ! -f /tmp/mipns/mute ] && echo on || echo off");
            return { action, status: result.stdout.includes("on") ? "on" : "off", ...result };
          }

          const event = action === "on" ? 7 : 8;
          const result = await this.runShell(device, `ubus -t1 -S call pnshelper event_notify '{"src":3,"event":${event}}'`);
          return { action, ...result };
        }),
    );

    server.registerTool(
      "xiaoai_version",
      {
        title: "查询小爱客户端版本",
        description: "返回已连接 Rust 客户端的构建版本。",
        inputSchema: DeviceSelectorSchema,
      },
      async ({ device }) =>
        this.runTool(async () => {
          const response = await this.devices.call(device, "get_version");
          if (typeof response.data !== "string") {
            throw new Error("设备返回了无效版本数据");
          }
          return { action: "version", version: response.data };
        }),
    );
  }

  private async runShell(device: string | undefined, script: string): Promise<CommandResult> {
    const response = await this.devices.call(device, "run_shell", script);
    const result = parseCommandResult(response.data);
    if (!result) {
      throw new Error("设备返回了无效命令结果");
    }
    if (result.exit_code !== 0) {
      throw new ShellCommandError(result);
    }
    return result;
  }

  private async runTool(action: () => Promise<Record<string, unknown>>) {
    try {
      const output = await action();
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...output }) }],
        structuredContent: { success: true, ...output },
      };
    } catch (error) {
      const details = this.errorDetails(error);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, ...details }) }],
        structuredContent: { success: false, ...details },
        isError: true,
      };
    }
  }

  private blockingTtsCommand(text: string): string {
    return `exec /usr/sbin/tts_play.sh ${this.shellQuote(text)}`;
  }

  private nonBlockingTtsCommand(text: string): string {
    return `ubus call mibrain text_to_speech ${this.shellQuote(JSON.stringify({ text, save: 0 }))}`;
  }

  private playUrlCommand(url: string): string {
    return `ubus call mediaplayer player_play_url ${this.shellQuote(JSON.stringify({ url, type: 1 }))}`;
  }

  private askXiaoaiCommand(text: string, silent: boolean): string {
    return `ubus call mibrain ai_service ${this.shellQuote(JSON.stringify({ nlp: 1, nlp_text: text, tts: silent ? 0 : 1 }))}`;
  }

  private shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
  }

  private errorDetails(error: unknown): Record<string, unknown> {
    if (error instanceof ShellCommandError) {
      return { error: error.message, ...error.result };
    }
    if (error instanceof DeviceCommandError) {
      return { error: error.message, response: error.response };
    }
    if (error instanceof DeviceUnavailableError) {
      return { error: error.message, unavailable: true };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function createXiaoaiMcpServer(devices: DeviceGateway): McpServer {
  const server = new McpServer({ name: "open-xiaoai", version: "0.1.0" });
  new XiaoaiToolService(devices).register(server);
  return server;
}
