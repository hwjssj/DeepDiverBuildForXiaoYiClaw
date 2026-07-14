# DeepDiver Headless API

无状态 REST + SSE 接口，用于以编程方式与 DeepDiver agent pipeline 交互。适用于批量处理、自动化、CLI/TUI 客户端及第三方集成。

**基础路径**: `/api/v1`

---

## 认证

所有端点均需在 `Authorization` 请求头中携带 Bearer token:

```
Authorization: Bearer sk-hdls-<32位十六进制字符>
```

### Key 格式

`sk-hdls-{32位十六进制字符}`（如 `sk-hdls-a1b2c3d4e5f6...`）。明文密钥仅在生成时展示**一次**，数据库只存储 SHA-256 哈希值。

### 验证顺序

1. **环境变量回退** — `HEADLESS_API_KEYS`（逗号分隔的明文密钥）。开发/测试用的快速通道。
2. **内存 TTL 缓存** — 已验证的密钥哈希缓存 5 分钟，避免频繁查询数据库。
3. **数据库查询** — 查询 `headless_api_keys` 表中的活跃密钥。验证成功后更新 `last_used_at`。

### 错误码

| 状态码 | 含义 |
|--------|------|
| 401 | 缺少或无效的 API key |
| 503 | 数据库不可用且未配置环境变量密钥 |

### 密钥管理

**通过 CLI 工具** (`web-demo/manage_headless_keys.py`):

```bash
python manage_headless_keys.py generate --name "acme-corp" --user-email ops@acme.com   # 创建密钥
python manage_headless_keys.py list                           # 列出所有密钥
python manage_headless_keys.py revoke --name "acme-corp"      # 按名称吊销
python manage_headless_keys.py revoke --id "550e8400-..."     # 按 ID 吊销
```

**通过 Web UI**（账户设置 > TUI API Key）:

用户可在前端自助生成/吊销 headless 密钥。每位用户限 1 个活跃密钥。端点:

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/users/me/headless-key` | 获取当前用户的密钥信息 |
| POST | `/api/users/me/headless-key` | 生成密钥（明文仅返回一次） |
| DELETE | `/api/users/me/headless-key` | 吊销密钥 |

---

## 端点

### POST `/api/v1/tasks` — 提交任务

提交新任务或追问查询。立即返回 `202 Accepted`，agent 在后台运行。

**请求体**:

```json
{
  "query": "创建一个 React 计数器应用",
  "model": null,
  "workspace_id": null,
  "resume_token": null,
  "skip_rewriter": false,
  "interaction_mode": "manual",
  "settings": null
}
```

| 字段 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `query` | string | *必填* | 用户查询 / 提示词 |
| `model` | string? | `null` | 覆盖模型名称（为 null 时使用服务器默认配置） |
| `workspace_id` | string? | `null` | 追问时使用：关联到已有工作区 |
| `resume_token` | string? | `null` | 提供 `workspace_id` 时**必填** |
| `skip_rewriter` | bool | `false` | 跳过 rewriter 预处理步骤 |
| `interaction_mode` | `"auto"` \| `"manual"` | `"manual"` | `ask_question` 交互的处理方式 |
| `settings` | object? | `null` | 按会话覆盖 LLM 设置 |
| `screenshot` | bool | `false` | 构建成功后截取预览截图；URL 会作为 `screenshot_url` 附加在 `build_complete` 事件和任务 `result` 中 |
| `platform` | string? | `null` | 生成应用的目标平台（如 `"web"`、`"harmonyos"`） |
| `callback_url` | string? | `null` | 任务结束时我们 POST 的 webhook URL，详见 [headless-api-webhooks-zh.md](./headless-api-webhooks-zh.md)。 |
| `callback_secret` | string? | `null` | 用于对 webhook body 做 HMAC 签名的共享密钥。 |
| `callback_headers` | object? | `null` | 我们在出站 webhook POST 里附加转发的请求头。 |

**响应** (`202`):

```json
{
  "task_id": "uuid",
  "workspace_id": "uuid",
  "resume_token": "string or null",
  "status": "running"
}
```

- `resume_token` 仅在**新建**会话时返回（追问时不返回）。请保存此 token 用于后续追问。

**错误**:

| 状态码 | 条件 |
|--------|------|
| 400 | 提供了 `workspace_id` 但未提供 `resume_token`，或 `callback_url` 校验失败 |
| 409 | 该工作区已有未完成的活跃任务 |
| 502 | MCP 连接 / 会话创建失败 |

---

### GET `/api/v1/tasks/{task_id}` — 轮询状态

返回当前任务状态、所有事件及结果（若已完成）。

**响应**:

```json
{
  "task_id": "uuid",
  "workspace_id": "uuid",
  "status": "running",
  "current_iteration": 3,
  "events": [
    {"seq": 1, "type": "start", "data": {...}, "timestamp": 1234567890.123},
    {"seq": 2, "type": "thinking", "data": {...}, "timestamp": 1234567891.456}
  ],
  "result": null,
  "interaction": null
}
```

**状态值**: `running`（运行中）、`paused`（已暂停）、`waiting_interaction`（等待交互）、`completed`（已完成）、`failed`（失败）、`cancelled`（已取消）

**`result`**（仅当 `status == "completed"` 时）:

```json
{
  "success": true,
  "iterations": 5,
  "execution_time": 42.3,
  "final_answer": "...",
  "key_files": ["src/App.tsx", "src/index.css"],
  "preview_url": "https://deepdiver.app/preview/{workspace_id}/?token={resume_token}",
  "project_name": "Climate Change Explorer",
  "screenshot_url": "/screenshots/ws-456abc_1a2b3c4d.png"
}
```

- `screenshot_url`（string?）仅在提交任务时设置了 `screenshot: true` 且截图成功时返回。

**`interaction`**（仅当 `status == "waiting_interaction"` 时）: 包含待处理的 `ask_question` 载荷。

---

### GET `/api/v1/tasks/{task_id}/stream` — SSE 事件流

实时 Server-Sent Events 流。支持迟到连接的客户端——先回放所有历史事件，再切换到实时推送。

**SSE 事件格式**:

```
event: agent
data: {"seq": 1, "type": "thinking", "data": {...}, "timestamp": 1234567890.123}

event: done
data: {"success": true, ...}

event: ping
data: {}
```

**SSE 事件类型**: `status`、`agent`、`done`、`ping`

**Agent 事件类型**（`event: agent` 内）:

| 类型 | 描述 |
|------|------|
| `start` | 任务已启动 |
| `iteration` | 循环迭代，附带 token 计数（`iteration`、`token_count`、`token_threshold`） |
| `thinking` | 推理/思考输出 |
| `tool_call` | 工具调用（包含 `tool`、`arguments`、`result`、`status`） |
| `error` | 执行错误 |
| `complete` | Agent 完成（`success: bool`）。`success == false` 时为终止事件 |
| `build_complete` | 静态预览构建完成。成功任务的终止事件 |
| `agent_handoff` | Pipeline 中 agent 之间的交接 |
| `paused` / `resumed` | 执行控制状态变更 |
| `interaction_required` | 等待用户回复 `ask_question` |
| `cancelled` | 用户取消了任务 |
| `subagent_start` / `subagent_complete` / `subagent_event` | 子 agent 生命周期事件 |
| `streaming` | 增量推理/内容 token（`text`、`type`、`done`） |

**终止事件**（流在这些事件后关闭）:
- `build_complete` — 成功完成并附带构建状态
- `error` — 致命错误
- `cancelled` — 用户发起的取消
- `complete` 且 `success == false` — 失败完成（不会有后续 build）

**心跳**: 无其他事件时每 15 秒发送 `ping` 事件。

**事件元数据**: 所有 agent 事件均包含 `source_agent_name` 和 `source_agent_type`（`"rewriter"`、`"ddt_agent"`、`"subagent"`、`"unknown"`）。

---

### POST `/api/v1/tasks/{task_id}/respond` — 回复交互

当 agent 等待 `ask_question` 的回复时，调用此端点解除阻塞。

**请求体**:

```json
{
  "interaction_id": "uuid",
  "response": {"answer": "是的，使用 TypeScript"}
}
```

**响应**: `{"status": "running"}`

**错误**: 任务不在 `waiting_interaction` 状态时返回 `409`。

---

### POST `/api/v1/tasks/{task_id}/cancel` — 取消任务

**响应**: `{"status": "cancelling"}`

**错误**: 任务未在运行中时返回 `409`。

---

### POST `/api/v1/tasks/{task_id}/pause` — 暂停任务

在下一个迭代边界处暂停执行。

**响应**: `{"status": "paused"}`

暂停期间，`GET /api/v1/tasks/{task_id}` 会持续返回 `status: "paused"`，直到任务被恢复。

**错误**: 任务未在运行中时返回 `409`。

---

### POST `/api/v1/tasks/{task_id}/resume` — 恢复任务

恢复已暂停的任务。

**响应**: `{"status": "running"}`

**错误**: 任务未在运行中时返回 `409`。

---

### POST `/api/v1/tasks/{task_id}/message` — 注入用户消息

将一条用户消息追加到运行中任务的对话里，在下一个迭代边界被取用；若任务处于暂停状态，此调用也会恢复它。

**请求**:
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `message` | string | 是 | 要注入对话的文本 |

**响应**: `{"status": "message_queued"}`

**错误**: 任务未在运行中时返回 `409`。

---

## 与他人共享 App

项目对应的 App 构建完成、可在 `/preview/{workspace_id}/` 访问后，Headless API 可为每个项目铸造最多 **15 个 viewer link**，让其他人无需注册 DeepDiver 账号即可使用该 App。每个访客获得稳定身份 `vwr_<hex>`，被工作区的 RLS 策略当作 `auth.uid()` 处理 —— 因此 owner-scoped 类型的 App（例如个人云盘）会让每位访客拥有自己独立的数据空间，而 shared-read 类型的 App（例如团队聊天）则在所有访客间共享状态。

Viewer link 与 **share link**（`db.share.create()`）是两种不同的原语：share link 是在运行中的 App **内部**铸造的，用于分发某一个具体资源（例如单个文件下载），不通过 Headless API 暴露 —— 由 Agent 的 App 代码通过 SDK 直接调用。

> **必须使用 DB-backed key。** 以下三个端点都会拒绝 env-var-only 的 API key（`HEADLESS_API_KEYS=...`），返回 `400` —— 这类 key 是匿名的，没有 `user_id` 可归属链接所有权。

### POST `/api/v1/projects/viewer-links` — 铸造链接

```bash
curl -X POST https://api.example.com/api/v1/projects/viewer-links \
  -H "Authorization: Bearer sk-hdls-..." \
  -H "Content-Type: application/json" \
  -d '{"workspace_id": "ws_abc123", "label": "alice@example.com"}'
```

**请求**:
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `workspace_id` | string | 是 | 项目创建响应中返回 |
| `label` | string | 否 | 任意字符串，≤100 字符。仅供调用方记账（API 不依据此字段去重） |

**响应 `201`**:
```json
{
  "viewer_id":     "vwr_a1b2c3d4e5f6",
  "viewer_token":  "Wk9...long_random_string...",
  "preview_url":   "/preview/ws_abc123/?viewer=Wk9...",
  "label":         "alice@example.com"
}
```

明文 `viewer_token` **仅在此次响应中返回一次**（与 GitHub PAT 语义一致）—— 必须立即保存，无法再次取回。在 `preview_url` 前拼接你的部署源后交给收件人。无幂等性：每次调用都会铸造新 token；如需去重请在调用方依据 `label` 自行处理。

**错误**:
| 状态码 | 触发条件 |
|---|---|
| `400` | env-var-only key，或项目已有 15 个活跃链接 |
| `404` | `workspace_id` 与该 key 拥有的任何项目都不匹配 |

### GET `/api/v1/projects/viewer-links?workspace_id=...` — 列出链接

```bash
curl "https://api.example.com/api/v1/projects/viewer-links?workspace_id=ws_abc123" \
  -H "Authorization: Bearer sk-hdls-..."
```

**响应 `200`**（token 已脱敏，可安全写入日志）:
```json
{
  "active_count": 2,
  "links": [
    {
      "link_id":        "f1e2d3c4-...",
      "viewer_id":      "vwr_a1b2c3d4e5f6",
      "label":          "alice@example.com",
      "is_active":      true,
      "view_count":     7,
      "created_at":     "2026-04-30T10:00:00Z",
      "last_viewed_at": "2026-04-30T14:23:11Z",
      "preview_url":    "/preview/ws_abc123/?viewer=<redacted>"
    }
  ]
}
```

返回活跃和已撤销的全部链接（按创建时间倒序）。`active_count` 仅统计 `is_active: true`。`viewer_token` 不会再次暴露 —— 若收件人弄丢了 URL，只能撤销并重新创建。

### DELETE `/api/v1/projects/viewer-links/{link_id}?workspace_id=...` — 撤销

```bash
curl -X DELETE \
  "https://api.example.com/api/v1/projects/viewer-links/f1e2d3c4-...?workspace_id=ws_abc123" \
  -H "Authorization: Bearer sk-hdls-..."
```

**响应 `204`**（无响应体）。软撤销：将 `is_active` 置为 `false`，保留访问统计。幂等 —— 撤销已撤销的链接同样返回 `204`。撤销后该 token 在 preview 时立即被拒绝，且立即释放 15 链接配额中的一个名额。

**错误**:
| 状态码 | 触发条件 |
|---|---|
| `400` | `link_id` 不是 UUID，或使用了 env-var-only key |
| `404` | 该 workspace 下找不到对应 ID 的链接，或 workspace 不属于该 key |

---

## 交互模式

### Manual 模式（默认）

Agent 在 `ask_question` 调用时阻塞，任务进入 `waiting_interaction` 状态。客户端需调用 `POST /tasks/{task_id}/respond` 来解除阻塞。

### Auto 模式

自动发送回复: `{"auto": true, "message": "Proceed with your best judgment"}`。在 `interaction_required` 事件发出后延迟 300ms 再响应，以确保 agent 已进入等待循环。

---

## 追问查询

在已有工作区中继续对话:

1. 提交新任务时携带原始响应中的 `workspace_id` + `resume_token`。
2. API 检查该工作区是否有并发任务（若有活跃任务则返回 `409`）。
3. 若会话仍在内存中，直接复用。否则通过 MCP 使用 resume token 恢复会话。
4. 执行前会清除静态预览标记（`POST /api/preview/clear-static`），使工作区从 nginx 静态文件服务切回 Vite dev server。

---

## 构建状态追踪

任务成功完成后，API 轮询 MCP 服务器检查静态构建是否完成:

1. 轮询 `GET /api/preview/status`，最多 **45 次**，间隔 **2 秒**（最长等待约 90 秒）。
2. 等待 `mode == "static"`（nginx 开始服务构建产物 `dist/` 目录）。
3. 获取 `TODO_AGENT_1.md` 以提取项目名称。
4. 发送 `build_complete` 事件，包含构建状态、预览 URL 和项目名称。

`_is_executing` 标志在 `build_complete` 发送前保持为 `true`，确保 SSE 流和轮询不会过早看到 `"completed"` 状态。

---

## 任务生命周期

```
提交 → running → [waiting_interaction → respond → running] → completed
              → [paused → resumed → running]
              → cancelled
              → failed
```

### 内存追踪

| 注册表 | Key → Value | 用途 |
|--------|-------------|------|
| `_task_registry` | `task_id → {workspace_id, resume_token, created_at, completed_at, query, is_followup, screenshot, callback_url, callback_secret, callback_headers}` | 任务元数据 |
| `_workspace_active_task` | `workspace_id → task_id` | 防止并发任务 |
| `_task_to_session` | `task_id → session_id` | 任务到会话的映射 |

### 清理

后台循环每 **5 分钟**运行一次，清除完成时间超过 `COMPLETED_TASK_TTL`（默认 30 分钟，可通过环境变量 `HEADLESS_COMPLETED_TASK_TTL` 配置）的任务。

---

## 配置

| 环境变量 | 默认值 | 描述 |
|----------|--------|------|
| `HEADLESS_API_KEYS` | `""` | 逗号分隔的明文 API 密钥（开发/测试回退） |
| `HEADLESS_COMPLETED_TASK_TTL` | `1800` | 已完成任务在内存中保留的秒数 |
| `HEADLESS_MAX_WORKERS` | `10` | Agent 执行线程池大小 |

---

## CLI 二进制分发

预构建二进制文件通过 nginx 的 `/cli/` 路径提供:

| 二进制文件 | 平台 |
|-----------|------|
| `deepdiver-linux-x64` | Linux x86_64 |
| `deepdiver-darwin-x64` | macOS Intel |
| `deepdiver-darwin-arm64` | macOS Apple Silicon |

### 安装

```bash
curl -fsSL https://deepdiver.app/install.sh | bash
```

安装脚本自动检测平台/架构，下载对应二进制文件到 `~/.local/bin/deepdiver`，并在需要时提示 PATH 配置。

### 使用

```bash
export DEEPDIVER_API_KEY=sk-hdls-...
deepdiver
```

---

## 数据库 schema

### `headless_api_keys`

| 列名 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `name` | VARCHAR(100) | 描述性名称 |
| `key_hash` | VARCHAR(64) | SHA-256 哈希值，唯一索引 |
| `key_prefix` | VARCHAR(20) | 前 12 个字符 + `"..."`，用于展示 |
| `is_active` | BOOLEAN | 软吊销，不删除记录 |
| `user_id` | UUID? | FK → `users.id`（ON DELETE SET NULL）。管理员创建的密钥可为空 |
| `created_at` | DATETIME | 已建索引 |
| `last_used_at` | DATETIME? | 每次认证成功后更新 |

---

## 消费 SSE 流（客户端实现指南）

本节介绍如何正确解析和处理来自 `/tasks/{task_id}/stream` 端点的事件。参考实现为 DeepDiver TUI（`tui/src/`）。

### 连接流

```
GET /api/v1/tasks/{task_id}/stream
Authorization: Bearer sk-hdls-...
Accept: text/event-stream
Cache-Control: no-cache
```

响应为标准 SSE 流。逐行解析：

```
event: <event_type>     ← "agent"、"done"、"ping" 或 "status"
data: <json_payload>    ← JSON 对象
                        ← 空行标记消息结束
```

仅处理 `event: agent` 和 `event: done`。忽略 `event: ping`（心跳）和 `event: status`（初始握手）。

收到 `event: done` 时关闭流——任务已结束。

### 事件信封

每个 `event: agent` 的载荷都有统一的信封格式：

```json
{
  "seq": 1,
  "type": "thinking",
  "data": { ... },
  "timestamp": 1711411200.123
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `seq` | int | 单调递增的序列号 |
| `type` | string | 下列事件类型之一 |
| `data` | object | 事件特定的载荷（因类型而异） |
| `timestamp` | float | Unix 时间戳（秒） |

### 事件类型参考

以下是每种事件类型 `data` 载荷的完整 schema 及处理指南。

---

#### `start`

任务开始时发送一次。

```json
{
  "query": "创建一个 React 计数器应用",
  "is_followup": false,
  "session_id": "ws-456",
  "run_id": "run-789",
  "task_id": "abc-123"
}
```

用于确认任务已被接受并记录 `run_id`。

---

#### `iteration`

每次 agent 循环迭代时发送。用于跟踪进度。

```json
{
  "iteration": 3,
  "token_count": 45000,
  "token_threshold": 200000,
  "source_agent_name": "DDT Agent",
  "source_agent_type": "ddt_agent"
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `iteration` | int | 当前迭代编号（可能为 0，此时应自动递增） |
| `token_count` | int | 已消耗 token 数 |
| `token_threshold` | int | Token 预算上限 |
| `source_agent_name` | string | 活跃 agent 的名称 |
| `source_agent_type` | string | `"rewriter"`、`"ddt_agent"`、`"subagent"` 或 `"unknown"` |

**备选字段名**: 后端可能使用不同名称——接受 `iter` / `iteration_number` 作为 iteration，`tokens` / `token_usage` / `tokenCount` 作为 token_count，`token_limit` / `max_tokens` 作为 token_threshold。

**处理提示**: 若在 `waiting_interaction` 状态下收到 `iteration` 事件，表示 agent 已恢复运行——清除待处理的交互。

---

#### `thinking`

Agent 的推理/思维链输出。

```json
{
  "content": "让我分析一下需求...",
  "source_agent_name": "DDT Agent",
  "source_agent_type": "ddt_agent"
}
```

**去重**: 相同的推理文本可能同时出现在 `thinking` 和 `streaming` 事件中。显示前务必检查重复。

---

#### `streaming`

LLM 实时 token 输出（增量文本块）。

```json
{
  "text": "我将创建一个 ",
  "type": "content"
}
```

| `type` 值 | 含义 |
|-----------|------|
| `"content"` | 常规输出文本——追加到内容缓冲区 |
| `"reasoning"` | 推理文本——追加到推理缓冲区 |
| `"done"` | 流刷新信号——将两个缓冲区内容作为消息部件固化 |

**处理**: 在缓冲区中累积文本。收到 `type: "done"` 或 `tool_call`（pending）事件时刷新缓冲区。刷新时需对已有消息内容进行去重。

---

#### `tool_call`

工具执行事件。每个工具发送**两次**：一次 `status: "pending"`（执行前），一次完成状态（执行后）。

```json
{
  "tool": "file_edit",
  "status": "pending",
  "arguments": {
    "file_path": "src/App.tsx",
    "old_string": "...",
    "new_string": "..."
  },
  "result": null,
  "source_agent_name": "DDT Agent",
  "source_agent_type": "ddt_agent"
}
```

**执行后**:

```json
{
  "tool": "file_edit",
  "status": "Success",
  "arguments": { ... },
  "result": "File edited successfully (3 lines changed)",
  "source_agent_name": "DDT Agent",
  "source_agent_type": "ddt_agent"
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `tool` | string | 工具名称（见下方工具列表） |
| `status` | string | `"pending"`、`"Success"`、`"Failure"` 或其他 |
| `arguments` | object | 工具输入参数（值截断至 500 字符，`final_answer` 除外） |
| `result` | string? | 工具输出（截断至 5000 字符） |
| `source_agent_type` | string | 调用工具的 agent 类型 |

**处理**:
1. `status: "pending"` 时：先刷新流缓冲区，再添加一个 "pending" 工具条目。
2. 完成时：按工具名查找匹配的 pending 条目并原地更新。若无 pending 条目则新增。

**特殊工具**:

- **`think` / `reflect`**: 内部推理——视为 `thinking` 事件处理。从 `arguments.thought` 提取内容。
- **`task_done`**: Agent 的最终答案。仅在 `status !== "pending"` 时处理（避免重复）。检查 `source_agent_type`:
  - `"rewriter"` → rewriter 完成。`arguments.final_answer` 包含精炼后的查询。
  - `"ddt_agent"` → 主 agent 完成。`arguments.final_answer` 是要展示的答案。
- **`delegate_task`**（`arguments.mode === "subtask"` 时）: Agent 正在派生子 agent。`arguments.what_needs_to_be_done` 包含任务列表（数组、JSON 字符串或纯文本）。`arguments.run_async` 标识是否并行执行。可据此预创建子 agent 占位 UI。
- **`ask_question`**: Agent 正在向用户提问。`arguments` 包含问题内容。（这是工具调用本身；`interaction_required` 事件才是 agent 阻塞的信号。）

**文件操作元数据**（`file_edit`、`file_write`、`file_insert`、`file_delete`）:

`data` 可能包含 `file_operation` 对象：

```json
{
  "file_path": "src/App.tsx",
  "operation_type": "edited",
  "lines_added": 5,
  "lines_removed": 3,
  "old_string": "...",
  "new_string": "...",
  "is_truncated": false
}
```

**常见工具名**: `plan_next_steps`、`bash` / `shell_exec` / `shell_exec_background`、`file_read`、`file_write` / `create_file`、`file_edit`、`file_insert`、`file_delete`、`glob` / `file_find_by_name`、`grep`、`list_directory` / `list_workspace`、`batch_web_search` / `web_search`、`web_fetch` / `extract_content`、`vite_init`、`start_dev_server`、`dev_server_status`、`delegate_task`、`ask_question`、`subagent_done`、`task_done`。

---

#### `interaction_required`

Agent 阻塞，等待用户输入。

```json
{
  "interaction_id": "int-001",
  "type": "ask_question",
  "questions": [
    {
      "id": "q1",
      "prompt": "你想使用哪个 CSS 框架？",
      "options": ["Tailwind", "Bootstrap", "无"],
      "allow_multiple": false
    }
  ]
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `interaction_id` | string | 调用 `/respond` 时需要此 ID |
| `type` | string | 交互类型（如 `"ask_question"`） |
| `questions` | array | 问题列表，包含 `id`、`prompt`，可选 `options` 和 `allow_multiple` |

**处理**: 将任务状态设为 `waiting_interaction`，向用户展示问题。用户回答后调用 `POST /tasks/{task_id}/respond`，传入 `interaction_id` 和回复对象。

---

#### `agent_handoff`

Pipeline 在 agent 之间交接（如 rewriter → 主 agent）。

```json
{
  "previous_iterations": 3,
  "new_agent_id": "ddt-agent-001"
}
```

---

#### `subagent_start`

子 agent 已被派生（来自 `delegate_task`）。

```json
{
  "agent_id": "sub-001",
  "is_async": true,
  "task": "实现 API 端点",
  "description": "实现 API 端点"
}
```

**处理**: 若已从 `delegate_task` 预创建了占位组，用 `agent_id` 认领第一个未认领的占位组。否则新建子 agent 组。

---

#### `subagent_complete`

子 agent 已完成。

```json
{
  "agent_id": "sub-001",
  "success": true,
  "iterations_used": 4,
  "result_length": 1523
}
```

**处理**: 按 `agent_id` 查找子 agent 组，更新状态为 `"done"` 或 `"failed"`。

---

#### `subagent_event`

子 agent 内部的工具调用事件。

```json
{
  "agent_id": "sub-001",
  "event_type": "tool_call",
  "data": {
    "tool": "file_write",
    "status": "Success",
    "arguments": { "file_path": "src/api.ts", "content": "..." },
    "result": "File written"
  }
}
```

**处理**: 按 `agent_id` 查找子 agent 组，将工具追加到其 tools 列表。去重：若存在同名 pending 工具，原地更新而非新增。

---

#### `complete`

Agent pipeline 执行完毕。对于成功任务，这**不是**终止事件——后面还有 `build_complete`。

```json
{
  "success": true,
  "iterations": 8,
  "execution_time": 65.2,
  "final_answer": "我已创建了一个 React 计数器应用...",
  "key_files": [
    {"file_path": "src/App.tsx", "desc": "主组件", "is_final_output_file": true}
  ],
  "preview_url": "https://deepdiver.app/preview/ws-456/?token=rt-789",
  "session_id": "ws-456",
  "run_id": "run-789"
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `success` | bool | Agent 是否成功 |
| `iterations` | int | 总迭代次数 |
| `execution_time` | float | 耗时（秒） |
| `final_answer` | string? | Agent 的回答（若 `task_done` 工具已提供则可能为空） |
| `key_files` | array? | 关键文件，含路径、描述和输出标记 |
| `preview_url` | string? | 持久预览 URL |
| `error` | string? | 错误消息（`success == false` 时） |

**处理**:
- `success == false`：终止事件。设状态为 `"failed"`。
- `success == true`：设状态为 `"completed"` 但继续监听——`build_complete` 紧随其后。
- 若 `task_done` 工具已提供最终答案，跳过此事件的 `final_answer` 以避免重复显示。
- 清空流缓冲区（`final_answer` 是权威版本）。

---

#### `build_complete`

静态预览构建完成。成功任务的**终止事件**。

```json
{
  "workspace_id": "ws-456",
  "task_id": "abc-123",
  "success": true,
  "mode": "static",
  "preview_url": "https://deepdiver.app/preview/ws-456/?token=rt-789",
  "project_name": "React Counter App",
  "screenshot_url": "/screenshots/ws-456abc_1a2b3c4d.png"
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `success` | bool | 构建是否成功 |
| `mode` | string | 构建成功时为 `"static"` |
| `preview_url` | string | 持久预览 URL |
| `project_name` | string? | 从 `TODO_AGENT_1.md` 提取 |
| `screenshot_url` | string? | 预览截图 URL（仅在提交任务时设置了 `screenshot: true` 且截图成功时返回） |
| `error` | string? | 构建错误消息（`success == false` 时） |

**处理**: 存储 `preview_url` 和 `project_name`。关闭流。

---

#### `error`

致命执行错误。

```json
{
  "message": "MCP connection lost",
  "session_id": "ws-456"
}
```

**处理**: 设状态为 `"failed"`，显示错误消息。

---

#### `cancelled`

用户取消了任务。

```json
{}
```

**处理**: 设状态为 `"cancelled"`。

---

#### `paused` / `resumed`

执行状态变更。

```json
{}
```

**处理**: 切换暂停标志。

---

### 典型事件序列

成功任务的事件顺序：

```
start
  → iteration (rewriter)
  → thinking (rewriter 推理)
  → tool_call (rewriter 工具)
  → tool_call: task_done (source_agent_type: "rewriter")
  → agent_handoff
  → iteration (DDT agent)
  → thinking (DDT agent 推理)
  → tool_call (file_write, bash 等)
  → ...
  → [delegate_task → subagent_start × N → subagent_event × M → subagent_complete × N]
  → tool_call: task_done (source_agent_type: "ddt_agent")
  → complete (success: true)
  → build_complete ← 终止事件，关闭流
```

失败任务：

```
start → iteration → ... → complete (success: false) ← 终止事件
```

或：

```
start → iteration → ... → error ← 终止事件
```

### 关键实现模式

**1. 去重**: 相同内容可能通过 `thinking`、`streaming` 和 `tool_call`（task_done）重复到达。渲染前务必检查重复。

**2. pending → completed 工具转换**: 工具调用到达两次（pending 然后 completed）。按工具名匹配并原地更新。

**3. task_done vs complete**: `task_done` 工具调用在 `complete` 事件之前提供 `final_answer`。若已渲染 `task_done`，跳过 `complete` 中的 `final_answer` 以避免重复显示。

**4. 子 agent 占位认领**: `delegate_task` 在子 agent 实际启动前预先公告。先创建占位组，`subagent_start` 到达时认领第一个未认领的占位组。

**5. 流缓冲区管理**: 在缓冲区中累积 `streaming` 文本。在以下时机刷新：pending `tool_call` 到达时、`streaming` `"done"` 事件到达时、或 `complete` 事件到达时。

---

## 使用示例

### 提交新任务（auto 模式）

```bash
# 提交
curl -s -X POST https://deepdiver.app/api/v1/tasks \
  -H "Authorization: Bearer sk-hdls-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "创建一个 React 计数器应用", "interaction_mode": "auto"}' \
  | jq .

# 响应:
# {"task_id": "abc-123", "workspace_id": "ws-456", "resume_token": "rt-789", "status": "running"}
```

### 流式接收事件

```bash
curl -N https://deepdiver.app/api/v1/tasks/abc-123/stream \
  -H "Authorization: Bearer sk-hdls-YOUR_KEY"
```

### 轮询状态

```bash
curl -s https://deepdiver.app/api/v1/tasks/abc-123 \
  -H "Authorization: Bearer sk-hdls-YOUR_KEY" | jq .status
```

### 追问

```bash
curl -s -X POST https://deepdiver.app/api/v1/tasks \
  -H "Authorization: Bearer sk-hdls-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "添加一个重置按钮",
    "workspace_id": "ws-456",
    "resume_token": "rt-789"
  }'
```

### 回复交互（manual 模式）

```bash
curl -s -X POST https://deepdiver.app/api/v1/tasks/abc-123/respond \
  -H "Authorization: Bearer sk-hdls-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"interaction_id": "int-001", "response": {"answer": "使用 TypeScript"}}'
```

### 取消运行中的任务

```bash
curl -s -X POST https://deepdiver.app/api/v1/tasks/abc-123/cancel \
  -H "Authorization: Bearer sk-hdls-YOUR_KEY"
```
