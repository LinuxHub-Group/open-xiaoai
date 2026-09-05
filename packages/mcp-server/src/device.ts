import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

import WebSocket, { type RawData, WebSocketServer } from "ws";

import {
  type DeviceEvent,
  type DeviceResponse,
  parseAppMessage,
} from "./protocol.js";

export class DeviceUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DeviceUnavailableError";
  }
}

export class DeviceCommandError extends Error {
  public readonly response: DeviceResponse;

  public constructor(response: DeviceResponse) {
    super(response.msg ?? `设备命令失败（code=${response.code ?? "unknown"}）`);
    this.name = "DeviceCommandError";
    this.response = response;
  }
}

export interface DeviceInfo {
  id: string;
  remoteAddress?: string;
  connectedAt: string;
}

export interface DeviceGatewayOptions {
  host: string;
  port: number;
  token?: string;
}

interface PendingRequest {
  reject: (reason: Error) => void;
  resolve: (response: DeviceResponse) => void;
  timer: NodeJS.Timeout;
}

class DeviceSession extends EventEmitter {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private closed = false;

  public constructor(
    public readonly info: DeviceInfo,
    private readonly socket: WebSocket,
  ) {
    super();
    socket.on("message", (data, isBinary) => this.handleMessage(data, isBinary));
    socket.once("close", () => this.close(new DeviceUnavailableError("设备连接已断开")));
    socket.once("error", (error) => this.close(error));
  }

  public async call(command: string, payload?: unknown, timeoutMs = 10_000): Promise<DeviceResponse> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new DeviceUnavailableError(`设备 ${this.info.id} 未连接`);
    }

    const id = randomUUID();
    const response = await new Promise<DeviceResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new DeviceUnavailableError(`设备命令 ${command} 超时`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ Request: { id, command, payload } }), (error) => {
          if (!error) {
            return;
          }
          const pending = this.pendingRequests.get(id);
          if (!pending) {
            return;
          }
          clearTimeout(pending.timer);
          this.pendingRequests.delete(id);
          pending.reject(error);
        });
      } catch (error) {
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    if (response.code !== undefined && response.code !== 0) {
      throw new DeviceCommandError(response);
    }
    return response;
  }

  public terminate(): void {
    this.socket.terminate();
  }

  private handleMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      return;
    }

    const message = parseAppMessage(data.toString());
    if (!message) {
      return;
    }

    if ("Response" in message) {
      const pending = this.pendingRequests.get(message.Response.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pendingRequests.delete(message.Response.id);
      pending.resolve(message.Response);
      return;
    }

    if ("Event" in message) {
      this.emit("event", message.Event satisfies DeviceEvent);
    }
  }

  private close(reason: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pendingRequests.delete(id);
    }
    this.emit("close", reason);
  }
}

export class DeviceGateway extends EventEmitter {
  private readonly sessions = new Map<string, DeviceSession>();
  private server?: WebSocketServer;
  private nextDeviceNumber = 1;

  public async start(options: DeviceGatewayOptions): Promise<void> {
    if (this.server) {
      throw new Error("设备 WebSocket 服务已启动");
    }

    this.server = new WebSocketServer({
      host: options.host,
      port: options.port,
      verifyClient: (info, done) => {
        if (!options.token) {
          done(true);
          return;
        }
        const authorization = info.req.headers.authorization;
        const queryToken = new URL(info.req.url ?? "/", "ws://device").searchParams.get("token");
        const authorized = authorization === `Bearer ${options.token}` || queryToken === options.token;
        done(authorized, 401, "Unauthorized");
      },
    });
    this.server.on("connection", (socket, request) => this.addConnection(socket, request));

    await new Promise<void>((resolve, reject) => {
      this.server?.once("listening", resolve);
      this.server?.once("error", reject);
    });
  }

  public async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.terminate();
    }
    this.sessions.clear();

    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  public listDevices(): DeviceInfo[] {
    return [...this.sessions.values()].map((session) => session.info);
  }
  public listeningPort(): number {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      throw new Error("设备 WebSocket 服务未监听 TCP 端口");
    }
    return address.port;
  }


  public async call(deviceId: string | undefined, command: string, payload?: unknown): Promise<DeviceResponse> {
    const session = this.selectSession(deviceId);
    return session.call(command, payload);
  }

  private addConnection(socket: WebSocket, request: IncomingMessage): void {
    const deviceId = this.getRequestedDeviceId(request);
    const existing = this.sessions.get(deviceId);
    if (existing) {
      existing.terminate();
    }

    const session = new DeviceSession(
      {
        id: deviceId,
        remoteAddress: request.socket.remoteAddress,
        connectedAt: new Date().toISOString(),
      },
      socket,
    );
    this.sessions.set(deviceId, session);
    session.on("event", (event: DeviceEvent) => this.emit("deviceEvent", deviceId, event));
    session.once("close", () => {
      if (this.sessions.get(deviceId) === session) {
        this.sessions.delete(deviceId);
      }
      this.emit("deviceDisconnected", deviceId);
    });
    this.emit("deviceConnected", session.info);
  }

  private getRequestedDeviceId(request: IncomingMessage): string {
    const rawName = new URL(request.url ?? "/", "ws://device").searchParams.get("device")?.trim();
    if (rawName && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(rawName)) {
      return rawName;
    }

    const generated = `device-${this.nextDeviceNumber}`;
    this.nextDeviceNumber += 1;
    return generated;
  }

  private selectSession(deviceId?: string): DeviceSession {
    if (deviceId) {
      const selected = this.sessions.get(deviceId);
      if (selected) {
        return selected;
      }
      throw new DeviceUnavailableError(`设备 ${deviceId} 未连接`);
    }

    if (this.sessions.size === 1) {
      const session = this.sessions.values().next().value;
      if (session) {
        return session;
      }
    }

    if (this.sessions.size === 0) {
      throw new DeviceUnavailableError("没有已连接的小爱设备");
    }
    throw new DeviceUnavailableError("已连接多个设备，请指定 device");
  }
}
