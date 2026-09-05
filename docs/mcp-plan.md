# 小爱音箱 MCP 工具化改造计划

> 目标：把小爱音箱的能力封装成标准 MCP 工具，让任意支持 MCP 的 Agent「填一个地址 / 加一段配置」就能控制小爱。
>
> 状态：**计划文档，未开始开发**。

---

## 一、结论（先看这个）

1. **不需要新写 `client_mcp_rust`。** 现有 `packages/client-rust` 的 `client` 二进制已经是「反向连接客户端」——它主动**向外拨号** WebSocket 到服务端，并暴露了全部所需 RPC 能力（`run_shell` / `start_play` / `stop_play` / `start_recording` / `stop_recording` / `get_version`）。再写一个重复的二进制是冗余，应直接复用。

2. **只需要新写一个 MCP 服务端（Node.js + TypeScript）**，放在 `packages/mcp-server/`。它做两件事：
   - 监听 WebSocket（默认 `:4399`），接受音箱的**出站**连接，讲 open-xiaoai 现有 `AppMessage` 协议；
   - 对外暴露标准 MCP 工具（**Streamable HTTP**，Agent 填 URL 即可注册；同时可选 **stdio** 给本地 Agent）。

3. **没有现成的「客户端填服务端地址来注册客户端 MCP」的反向 MCP 工具**能直接用在这个场景（详见第三节）。因此采用「设备出站连服务端，服务端当 MCP 入口」的自建方案——这正好就是反向连接。

```
┌─────────────┐   stdio 或 HTTP(MCP)   ┌──────────────────────┐   WebSocket(设备主动出站)   ┌────────────────┐
│  Agent (任意)│ ◄──────────────────► │  mcp-server (Node+TS) │ ◄────────────────────────► │ client (Rust)  │
│ Claude 等    │   Agent 填 URL 注册   │  packages/mcp-server  │   音箱拨号 ws://host:4399   │  packages/...  │
└─────────────┘                       └──────────────────────┘                            └────────────────┘
                                                                      │
                                                              工具调用 → RPC → run_shell/播放/唤醒
```

---

## 二、为什么不需要改设备端（复用清单）

现有 `client` 已提供全部底层能力，MCP 服务端只需通过 RPC 驱动它：

| 能力 | 设备端实现 | MCP 服务端如何触发 |
|---|---|---|
| 文字转语音 TTS | `/usr/sbin/tts_play.sh '<text>'`（阻塞） | RPC `run_shell` |
| 非阻塞 TTS | `ubus call mibrain text_to_speech '{"text":..,"save":0}'` | RPC `run_shell` |
| 播放音频链接 | `ubus call mediaplayer player_play_url '{"url":..,"type":1}'` | RPC `run_shell` |
| 唤醒 / 静默唤醒 | `ubus call pnshelper event_notify '{"src":1,"event":0}'`（silent） / `'{"src":0,...}'` | RPC `run_shell` |
| 退出监听 | `pnshelper event_notify '{"src":3,"event":7}'` + `'{"src":3,"event":8}'` | RPC `run_shell` |
| 打断播放 | `killall tts_play.sh miplayer; mphelper pause` | RPC `run_shell` |
| 把指令交给原生小爱 | `ubus call mibrain ai_service '{"nlp":1,"nlp_text":"..","tts":1}'` | RPC `run_shell` |
| 播放状态 | `mphelper mute_stat`（1=playing/2=paused/其他=idle） | RPC `run_shell` |
| 设备型号/SN | `micocfg_model` / `micocfg_sn` | RPC `run_shell` |
| 麦克风开关/状态 | `pnshelper event_notify` / 检测 `/tmp/mipns/mute` | RPC `run_shell` |
| 版本 | — | RPC `get_version` |
| PCM 采集/播放 | `start_recording`/`start_play` + `Stream` 二进制帧 | （v2，非必须） |

**关键安全约束**：`run_shell` 是任意命令执行，**绝不能**作为 MCP 工具直接暴露。所有 MCP 工具必须是**类型化、白名单化**的，服务端内部拼接固定命令模板，Agent 只能传受限参数（文本、URL、布尔）。

---

## 三、关于「现成的反向连接 MCP 工具」

调研结论：**没有完全契合的现成方案**，原因如下：

| 方案 | 方向 | 是否适用 |
|---|---|---|
| `mcp-remote`（geoffreyhuntley） | stdio ↔ 远程 SSE 桥，让本地 Agent 连远程 MCP | 方向相反，且设备端跑不了 |
| Cloudflare / Pangolin MCP Tunnel | 在**私网内**跑一个 MCP server + 隧道守护进程，把它暴露出去 | 需要在音箱上跑 MCP server + tunnel daemon，ARMv7 / 128–256MB 内存不现实 |
| MetaMCP / mcp-gateway | 聚合多个**已存在**的 MCP server，由网关去连它们 | 是「服务端主动去连」，不是「设备注册进来」 |
| MCP-AX（IETF 草案） | 分层工具命名空间委派 | 仅为草案，无成熟实现 |

**根因**：MCP 标准里没有「设备/工具方主动出站、向 MCP 入口注册自己」的官方模式；MCP 的连接方向默认是 Client→Server。而本场景设备在 NAT 后、资源受限、不能入站，正确做法就是让设备**出站**连到一个中继——这个中继顺便当 MCP 入口。这正是现有 `client`（出站 WebSocket）+ 新建 `mcp-server`（MCP 入口）的形态。

> 换句话说：我们要的就是一个「反向连接 + MCP 网关」二合一的小服务，没有现成轮子比「复用现有 client + 写一个薄 Node 服务」更简单。

---

## 四、设备↔服务端线协议（已从源码核实）

来源：`packages/client-rust/src/services/connect/{data,message,rpc,handler}.rs`。

- 传输：WebSocket，文本帧 + 二进制帧。
- 文本帧 = JSON 序列化的 `AppMessage`（externally tagged enum）：
  ```json
  {"Request":  {"id": "<uuid>", "command": "run_shell", "payload": "<script string>"}}
  {"Response": {"id": "<uuid>", "code": 0, "msg": "success", "data": {...}}}
  {"Event":    {"id": "<uuid>", "event": "instruction|playing|kws", "data": {...}}}
  ```
- 二进制帧 = JSON 序列化的 `Stream`：`{"id","tag":"record|play","bytes":[...],"data":?}`。
- RPC 语义（服务端→设备）：服务端发 `Request`（自带 uuid `id`），设备回 `Response`（**同 id**），服务端按 `id` 匹配、带超时（默认 10s）。
- 设备→服务端事件（`Event`）：
  - `instruction`：`data.NewLine` 是一行 JSON（小爱原生 ASR/指令日志，含 `header.namespace/name`、`payload.results[0].text`、`is_final`、`is_vad_begin`、`dialog_id`）。
  - `playing`：`data` 为 `"Playing"|"Paused"|"Idle"`（由 `PlayingMonitor` 用 `mphelper mute_stat` 轮询产生）。
  - `kws`：`data` 为 `{"Keyword":"..."}` 或 `"Started"`（来自 `/tmp/open-xiaoai/kws.log`）。

服务端实现要点：
- 用 `ws` 起 WebSocketServer，首个文本帧即设备接入。
- 维护 `pending: Map<id, {resolve,reject,timer}>`，发 `Request` 后等 `Response`。
- `run_shell` 的 `data` 是 `{"stdout","stderr","exit_code"}`（`CommandResult`）。

---

## 五、MCP 服务端设计（packages/mcp-server，Node.js + TS）

### 5.1 目录结构

```
packages/mcp-server/
  package.json
  tsconfig.json
  src/
    index.ts       # 入口：解析模式/端口/token，启动 WS 设备服务 + MCP transport
    protocol.ts    # AppMessage / Request / Response / Event / Stream 的 zod 运行时 schema
    device.ts      # WebSocket 服务 + RPC 客户端（callRemote(command,payload,timeout)）
    tools.ts       # MCP 工具定义（zod schema）→ 映射到 device.callRemote
  test/
    device.test.mjs    # 设备出站连接与 RPC 匹配
    mcp-http.test.mjs  # MCP HTTP → WebSocket → 设备的端到端测试
  README.md
```

### 5.2 依赖

- `@modelcontextprotocol/server`、`@modelcontextprotocol/node`（MCP TypeScript SDK v2，2026-07-28 spec）
- `ws`（WebSocket 服务端）
- `zod`（工具入参和设备协议 schema）
- 开发：`typescript`、`@types/node`、`@types/ws`、`@modelcontextprotocol/client`（端到端测试）

### 5.3 对外 Transport（两种，满足不同 Agent）

1. **Streamable HTTP（默认，推荐）**：监听 `http://<host>:<port>/mcp`。
   - Agent 侧「填地址注册」即指这个：在 Agent 的 MCP 配置里填该 URL 即可。
   - 适合跨机器 / 容器内 Agent。
   - 实现：MCP SDK v2 的 `createMcpHandler`（HTTP 端无状态，兼容当前与 legacy MCP 客户端）。
2. **stdio（可选）**：本地 Agent（如 Claude Desktop）以子进程方式拉起，`--stdio` 开启。

### 5.4 设备接入（反向连接）

- WebSocketServer 监听 `:4399`（与现有 `boot.sh`/`init.sh` 默认端口一致）。
- 音箱上 `/data/open-xiaoai/server.txt` 填 `ws://<mcp-server-host>:4399/?device=<name>`，运行现有 `client` 即自动出站连上。
- 支持多设备：`device` 是稳定的 URL query 参数；连接超过一台时，MCP 工具必须传 `device`。

### 5.5 MCP 工具清单（类型化、白名单，**不暴露 run_shell**）

| 工具名 | 入参（zod） | 设备命令模板 | 说明 |
|---|---|---|---|
| `xiaoai_list_devices` | `{}` | — | 列出已连接设备 |
| `xiaoai_speak` | `{text: string, blocking?: bool}` | 阻塞:`/usr/sbin/tts_play.sh '<t>'`；非阻塞:`ubus call mibrain text_to_speech '{"text":"<t>","save":0}'` | 原生 TTS 播报 |
| `xiaoai_play_url` | `{url: string(http/https)}` | `ubus call mediaplayer player_play_url '{"url":"<u>","type":1}'` | 播放音频链接 |
| `xiaoai_interrupt` | `{}` | `killall tts_play.sh miplayer 2>/dev/null; mphelper pause` | 打断当前播报/播放 |
| `xiaoai_wake` | `{silent?: bool=true}` | `pnshelper event_notify '{"src":1,"event":0}'`（silent）/ `'{"src":0,...}'` | 唤醒小爱 |
| `xiaoai_sleep` | `{}` | `pnshelper event_notify '{"src":3,"event":7}'; sleep 0.1; ...'{"src":3,"event":8}'` | 退出监听 |
| `xiaoai_ask` | `{text: string, silent?: bool=false}` | `ubus call mibrain ai_service '{"nlp":1,"nlp_text":"<t>","tts":1}'` | 把指令交给原生小爱执行 |
| `xiaoai_status` | `{}` | `mphelper mute_stat` → 映射 playing/paused/idle | 播放状态 |
| `xiaoai_device_info` | `{}` | `echo $(micocfg_model) $(micocfg_sn)` | 型号/SN |
| `xiaoai_mic` | `{action: "on"\|"off"\|"status"}` | on/off:`pnshelper event_notify`；status:检测 `/tmp/mipns/mute` | 麦克风 |
| `xiaoai_version` | `{}` | RPC `get_version` | 客户端版本 |

入参校验与转义：
- 文本类：限制长度，以 shell 单引号转义（`'` → `'"'"'`），使内容只作为一个参数传递。
- URL：仅允许 `http(s)://`，限制长度；内网地址限制可按部署策略在后续加入。
- 所有工具返回 `{success, stdout?, stderr?, exit_code?}` 的结构化文本。

### 5.6 安全

- MCP HTTP 端点：当绑定到非 loopback 的 `MCP_HOST` 时，强制设置 `MCP_AUTH_TOKEN` 并校验 `Authorization: Bearer <token>`。
- 设备 WS：可选 `DEVICE_TOKEN`；现有 Rust client 可在 `server.txt` 中通过 `?token=<token>` 鉴权，无需改客户端，也兼容 `Authorization: Bearer <token>`。
- 工具层已限制文本长度、限制 URL scheme、以 shell 单引号安全转义动态参数，并沿用小爱 RPC 10s 超时。速率限制尚未实施。

---

## 六、部署与使用

1. 服务端（NAS / 常开主机）：
   ```bash
   cd packages/mcp-server
   npm install && npm run build
   # HTTP 模式（Agent 用 URL 注册）
   MCP_PORT=8080 DEVICE_WS_PORT=4399 node dist/index.js
   # 或 stdio 模式（本地 Agent）
   node dist/index.js --stdio
   ```
2. 音箱（沿用现有刷机流程）：
   ```bash
   echo 'ws://<mcp-server-host>:4399' > /data/open-xiaoai/server.txt
   # 运行现有 client（init.sh / boot.sh）
   ```
3. Agent 注册：
   - **HTTP**：在 Agent 的 MCP 配置填 `http://<mcp-server-host>:8080/mcp`。
   - **stdio**：
     ```json
     { "mcpServers": { "xiaoai": { "command": "node", "args": ["/path/packages/mcp-server/dist/index.js", "--stdio"] } } }
     ```

---

## 七、实施阶段

- [x] **P1 骨架**：`protocol.ts`（协议 schema）+ `device.ts`（WS 接入 + RPC 调用 + 超时）。
- [x] **P2 工具层**：`tools.ts` 实现类型化小爱控制工具、zod 入参校验和命令转义。
- [x] **P3 传输**：Streamable HTTP（默认）+ stdio（可选）。
- [x] **P4 基础安全**：可选 token、入参校验、禁止暴露 `run_shell`。速率限制留作后续增强。
- [x] **P5 本地验证**：设备 WebSocket RPC、MCP HTTP 端到端、MCP stdio 端到端测试。
- [x] **P6 文档/部署**：`packages/mcp-server/README.md`。

## 八、验证计划（无真机可做的本地端到端）

1. `cd packages/client-rust && cargo build`（主机 target，非 ARM）。
2. 启动 `mcp-server`（HTTP 模式，`:4399` 等设备，`:8080` MCP）。
3. 运行真实 Rust 客户端指向本机：`./target/debug/client ws://127.0.0.1:4399`。
   - 说明：客户端的 `PlayingMonitor`/KWS/ASR 监控在本机会因缺 `mphelper`/日志文件而不产生事件（非致命，循环等待），不影响 RPC 通路。
4. 用 MCP 客户端（或脚本调 `/mcp`）调用：
   - `xiaoai_version` → 应返回真实 Rust 客户端版本（证明「MCP→WS→Rust→返回」全链路）。
   - `xiaoai_speak {text:"..."}` → 本机无 `tts_play.sh`，会返回非零 `exit_code`，但能证明命令下发与 `CommandResult` 回传。
5. 真机阶段：刷机后重复 3–4，验证真实 TTS/播放/唤醒。

## 九、风险与注意

- **run_shell 风险**：只在服务端内部用固定模板，绝不把任意命令暴露成工具。
- **固件命令依赖**：`tts_play.sh`/`ubus`/`mphelper`/`micocfg_*` 依赖小爱固件，真机型号差异需实测。
- **多设备**：v1 建议单设备；多设备需在工具加 `device` 路由，列为后续增强。
- **事件流（ASR/播放状态）**：v1 工具以「主动控制 + 查询」为主；若要「监听小爱识别结果」类工具，需额外订阅 `instruction` 事件并做会话管理（列入 v2，对应更早的 OpenClaw 对话方案）。
