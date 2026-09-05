# Open-XiaoAI MCP Server

标准 MCP 网关：小爱音箱上的现有 Rust `client` 主动连接本服务；Agent 通过 Streamable HTTP 或 stdio 调用 MCP 工具。

```text
Agent ── MCP (HTTP / stdio) ── mcp-server ── WebSocket（音箱主动出站）── client-rust ── 小爱系统服务
```

## 能力

- `xiaoai_list_devices`：列出已连接音箱。
- `xiaoai_speak`：小爱原生 TTS 播报。
- `xiaoai_play_url`：播放 HTTP(S) 音频链接。
- `xiaoai_interrupt`：打断 TTS 和媒体播放。
- `xiaoai_wake` / `xiaoai_sleep`：控制小爱监听。
- `xiaoai_ask`：将自然语言指令交给原生小爱处理。
- `xiaoai_status`：查询播放状态。
- `xiaoai_device_info`：查询设备型号和序列号。
- `xiaoai_mic`：查询或控制麦克风。
- `xiaoai_version`：查询 Rust 客户端版本。

服务端**不暴露**任意 `run_shell` MCP 工具。所有工具映射为固定、类型化的小爱系统命令。

## 安装

Node.js 20 或更高版本：

```bash
cd packages/mcp-server
npm install
npm run build
```

## 运行

### HTTP 模式：供其他 Agent 用 URL 注册

默认仅绑定本机，MCP URL 为 `http://127.0.0.1:8080/mcp`：

```bash
npm start
```

要供局域网中其他 Agent 使用，必须显式绑定并设置 HTTP Bearer token：

```bash
DEVICE_WS_HOST=0.0.0.0 \
DEVICE_TOKEN='device-secret' \
MCP_HOST=0.0.0.0 \
MCP_AUTH_TOKEN='mcp-secret' \
npm start
```

- MCP 地址：`http://<server-ip>:8080/mcp`
- Agent 请求头：`Authorization: Bearer mcp-secret`
- 健康检查：`GET http://<server-ip>:8080/health`

支持 Streamable HTTP 的 Agent 可按以下通用配置接入：

```json
{
  "mcpServers": {
    "xiaoai": {
      "url": "http://<server-ip>:8080/mcp",
      "headers": {
        "Authorization": "Bearer mcp-secret"
      }
    }
  }
}
```

不同 Agent 的配置字段可能不同，但 MCP URL 与 `Authorization` 头相同。

### stdio 模式：供同机 Agent 拉起

```bash
DEVICE_WS_HOST=0.0.0.0 DEVICE_TOKEN='device-secret' npm run start -- --stdio
```

示例：

```json
{
  "mcpServers": {
    "xiaoai": {
      "command": "node",
      "args": ["/absolute/path/open-xiaoai/packages/mcp-server/dist/index.js", "--stdio"],
      "env": {
        "DEVICE_WS_HOST": "0.0.0.0",
        "DEVICE_TOKEN": "device-secret"
      }
    }
  }
}
```

stdio 只走标准输入输出；日志写到 stderr，不会污染 MCP 通信。

## 音箱连接

沿用现有 `packages/client-rust` 的 client，不需要新设备端二进制。

在音箱上设置服务地址并重启 client：

```sh
cat > /data/open-xiaoai/server.txt <<'EOF'
ws://<server-ip>:4399/?device=living-room&token=device-secret
EOF

/data/open-xiaoai/client "$(cat /data/open-xiaoai/server.txt)"
```

- `device` 是可选、稳定的设备名；多个音箱时必须指定，格式为字母/数字/`_`/`-`，最长 64 个字符。
- `token` 仅在服务端设置 `DEVICE_TOKEN` 后需要。现有 Rust client 会原样使用 URL 查询参数，因此不需要修改客户端即可鉴权。
- 不设置 `DEVICE_TOKEN` 时不要将 WebSocket 端口暴露到不可信网络。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `DEVICE_WS_HOST` | `0.0.0.0` | 设备 WebSocket 监听地址 |
| `DEVICE_WS_PORT` | `4399` | 设备 WebSocket 监听端口 |
| `DEVICE_TOKEN` | 未设置 | 设备连接 Bearer token 或 URL `token` 参数 |
| `MCP_HOST` | `127.0.0.1` | MCP HTTP 监听地址 |
| `MCP_PORT` | `8080` | MCP HTTP 监听端口 |
| `MCP_AUTH_TOKEN` | 未设置 | MCP HTTP Bearer token；非 loopback 绑定时必填 |

## 多设备

每台音箱在 WebSocket URL 中设置不同 `device`：

```text
ws://server:4399/?device=living-room&token=device-secret
ws://server:4399/?device=bedroom&token=device-secret
```

先调用 `xiaoai_list_devices`。当连接超过一台时，其他 MCP 工具必须传 `device`，避免误控制。

## 验证

```bash
npm test
```

测试包含：

1. 设备主动 WebSocket 连接、query token、Request/Response RPC 匹配；
2. MCP Streamable HTTP 客户端列出工具并调用 `xiaoai_version`；
3. Agent 文本中的单引号在 `xiaoai_speak` 的设备命令中被安全转义；
4. stdio MCP 客户端通过反向连接设备调用 `xiaoai_version`。

真机部署后先调用 `xiaoai_version` 和 `xiaoai_status`，再测试 `xiaoai_speak`。

## 安全边界

- 不要暴露 `run_shell`；它是设备 root 权限的任意命令执行入口。
- 对远程 MCP 强制 `MCP_AUTH_TOKEN`，并使用可信内网、VPN 或反向代理 TLS。
- `xiaoai_ask` 可能影响家居设备。涉及门锁、安防、支付、删除等高风险动作时，Agent 必须先取得用户明确确认。
- `xiaoai_play_url` 会让音箱访问目标 URL；只让可信 Agent 使用该工具。
