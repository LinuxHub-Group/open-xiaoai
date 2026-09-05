# 小爱音箱 MCP 使用与部署

本指南将已刷机的小爱音箱接入 `open-xiaoai` MCP 服务。完成后，支持 **Streamable HTTP MCP** 的 Agent 软件可以通过 MCP 工具控制小爱音箱。

```text
Agent ── MCP HTTP / stdio ── mcp-server ── WebSocket（音箱主动连接）── Rust client ── 小爱系统服务
```

- 音箱不需要运行 Node.js 或 MCP server。
- 音箱复用现有 `packages/client-rust` 的 `client` 二进制。
- 音箱主动连接服务器，因此服务器不需要向音箱发起入站连接。

## 前置条件

1. 小爱音箱已按项目刷机流程开启 SSH。
2. 音箱上已安装 Rust Client：`/data/open-xiaoai/client`。
3. 运行 MCP 服务的服务器与音箱网络可达；建议同一局域网，并给服务器分配固定 IP 或 DHCP 保留地址。
4. 服务器安装 Node.js 20 或更高版本。

以下示例假定：

| 项目 | 示例值 |
|---|---|
| 服务器 IP | `192.168.1.10` |
| 音箱名称 | `living-room` |
| 设备连接密钥 | `device-secret` |
| Agent 访问密钥 | `mcp-secret` |

请替换为自己的实际值，并使用随机长字符串代替示例密钥：

```bash
openssl rand -hex 32
```

## 一、部署 MCP 服务端

在本项目目录的服务器上执行：

```bash
cd /home/server/mycode/open-xiaoai/packages/mcp-server
npm install
npm run build
```

面向局域网 Agent 启动服务：

```bash
DEVICE_WS_HOST=0.0.0.0 \
DEVICE_WS_PORT=4399 \
DEVICE_TOKEN='device-secret' \
MCP_HOST=0.0.0.0 \
MCP_PORT=8080 \
MCP_AUTH_TOKEN='mcp-secret' \
npm start
```

成功启动后日志应包含：

```text
[device] listening on ws://0.0.0.0:4399
[mcp] listening on http://0.0.0.0:8080/mcp
```

服务端端口：

| 端口 | 协议 | 用途 |
|---:|---|---|
| `4399` | WebSocket | 音箱 Rust Client 主动连接 |
| `8080` | HTTP | Agent 连接 MCP |

健康检查：

```bash
curl \
  -H 'Authorization: Bearer mcp-secret' \
  http://192.168.1.10:8080/health
```

初始状态示例：

```json
{
  "devices": [],
  "status": "ok"
}
```

> `MCP_HOST=0.0.0.0` 时，服务会强制要求 `MCP_AUTH_TOKEN`。不要将 4399 或 8080 暴露到公网；跨网络访问应使用 VPN、Tailscale 或可信 TLS 反向代理。

## 二、配置音箱

SSH 登录音箱后，写入服务地址：

```sh
cat > /data/open-xiaoai/server.txt <<'EOF'
ws://192.168.1.10:4399/?device=living-room&token=device-secret
EOF
```

参数含义：

- `192.168.1.10:4399`：MCP 服务的设备 WebSocket 地址。
- `device=living-room`：稳定且唯一的设备名；多个音箱必须使用不同名称。
- `token=device-secret`：必须等于服务器的 `DEVICE_TOKEN`。

`device` 的格式限制：字母、数字、`_`、`-`，以字母或数字开始，最长 64 个字符。

重启音箱，或按当前已配置的启动方式重启客户端。已将仓库启动脚本部署为 `/data/init.sh` 时，直接重启最可靠：

```sh
reboot
```

如果手动启动客户端：

```sh
/data/open-xiaoai/client "$(cat /data/open-xiaoai/server.txt)"
```

连接成功后，服务端日志应出现：

```text
[device] connected: living-room (192.168.1.x)
```

再次检查服务端：

```bash
curl \
  -H 'Authorization: Bearer mcp-secret' \
  http://192.168.1.10:8080/health
```

返回的 `devices` 应包含 `living-room`。

## 三、在 Agent 软件中增加 MCP

### 推荐：Streamable HTTP

在 Agent 软件的远程 MCP 配置中填：

| 配置项 | 值 |
|---|---|
| Transport | Streamable HTTP |
| MCP URL | `http://192.168.1.10:8080/mcp` |
| 请求头 | `Authorization: Bearer mcp-secret` |

通用配置示例：

```json
{
  "mcpServers": {
    "xiaoai": {
      "url": "http://192.168.1.10:8080/mcp",
      "headers": {
        "Authorization": "Bearer mcp-secret"
      }
    }
  }
}
```

不同 Agent 软件可能把 MCP 地址字段命名为 `url`、`endpoint` 或 `serverUrl`；使用相同的 URL 和 Bearer token 即可。

### 可选：stdio

只有在 Agent 与 MCP 服务运行于同一台机器时使用。Agent 配置：

```json
{
  "mcpServers": {
    "xiaoai": {
      "command": "node",
      "args": [
        "/home/server/mycode/open-xiaoai/packages/mcp-server/dist/index.js",
        "--stdio"
      ],
      "env": {
        "DEVICE_WS_HOST": "0.0.0.0",
        "DEVICE_TOKEN": "device-secret"
      }
    }
  }
}
```

跨机器 Agent 应使用 HTTP，不使用 stdio。

## 四、首次调用顺序

连接 MCP 后，建议按顺序调用：

1. `xiaoai_list_devices`
2. `xiaoai_version`
3. `xiaoai_status`
4. `xiaoai_speak`

单台音箱可省略 `device` 参数。多台音箱时，除 `xiaoai_list_devices` 外的工具必须带设备名：

```json
{
  "device": "living-room"
}
```

文字播报：

```json
{
  "device": "living-room",
  "text": "你好，MCP 控制已连接成功"
}
```

交给原生小爱处理：

```json
{
  "device": "living-room",
  "text": "今天天气怎么样"
}
```

## 五、可用 MCP 工具

| 工具 | 作用 |
|---|---|
| `xiaoai_list_devices` | 列出已连接设备 |
| `xiaoai_speak` | 使用原生 TTS 播报文字 |
| `xiaoai_play_url` | 播放 HTTP(S) 音频 URL |
| `xiaoai_interrupt` | 停止当前 TTS 和媒体播放 |
| `xiaoai_wake` | 唤醒小爱；默认静默唤醒 |
| `xiaoai_sleep` | 停止当前监听 |
| `xiaoai_ask` | 将自然语言指令交给原生小爱 |
| `xiaoai_status` | 查询播放状态 |
| `xiaoai_device_info` | 查询设备型号和序列号 |
| `xiaoai_mic` | 打开、关闭或查询麦克风 |
| `xiaoai_version` | 查询 Rust Client 版本 |

服务端不提供任意 `run_shell` 工具。Agent 只能调用上述类型化工具。

## 六、多设备示例

客厅音箱：

```text
ws://192.168.1.10:4399/?device=living-room&token=device-secret
```

卧室音箱：

```text
ws://192.168.1.10:4399/?device=bedroom&token=device-secret
```

Agent 调用卧室音箱：

```json
{
  "device": "bedroom",
  "text": "晚安"
}
```

## 七、安全边界

- 不要将服务端端口公开到互联网。
- 非 loopback MCP 服务必须设置 `MCP_AUTH_TOKEN`。
- 必须为设备连接设置 `DEVICE_TOKEN`。
- `xiaoai_ask` 可能控制家庭设备；门锁、安防、支付、删除等高风险操作应要求用户明确确认。
- `xiaoai_play_url` 会让音箱访问 URL；仅向可信 Agent 授权。
- 当前服务端不提供任意 shell 命令执行 MCP 工具。

## 八、排障

### 服务端没有出现设备连接日志

检查音箱：

```sh
cat /data/open-xiaoai/server.txt
```

确认 IP、端口、`device`、`token` 正确；确认音箱能访问服务器：

```sh
ping -c 1 192.168.1.10
```

确认服务器防火墙允许 TCP 4399。

### Agent 返回 401 Unauthorized

确认 MCP URL 为：

```text
http://192.168.1.10:8080/mcp
```

并确认请求头为：

```text
Authorization: Bearer mcp-secret
```

确认服务器防火墙允许 TCP 8080。

### Agent 返回“没有已连接的小爱设备”

先调用 `xiaoai_list_devices`。如果列表为空，问题在音箱到服务器的 WebSocket 连接，而不是 MCP 配置。

### TTS 或原生小爱命令失败

先执行 `xiaoai_version` 验证 MCP→服务端→音箱 RPC 链路；再执行 `xiaoai_status`。若二者成功而 TTS 失败，检查设备型号和固件是否包含 `/usr/sbin/tts_play.sh`、`ubus`、`mibrain`、`pnshelper` 等小爱系统组件。

## 九、验证状态

服务端执行：

```bash
cd packages/mcp-server
npm test
```

当前测试覆盖：

1. 音箱反向 WebSocket 接入、query token 与 RPC id 匹配；
2. Streamable HTTP MCP 调用穿透到设备 WebSocket；
3. stdio MCP 调用穿透到设备 WebSocket；
4. TTS 文本参数的 shell 安全转义。

测试使用模拟设备；首次真机接入仍应完成第四节的调用顺序验证。
