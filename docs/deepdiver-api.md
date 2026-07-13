# DeepDiver Build API 接口文档

> 取自 https://cn.deepdiver.app/ 前端源码逆向分析 + Chrome DevTools 网络抓包
>
> 前提文档：[deepdiver-auth.md](./deepdiver-auth.md)（认证方式、JWT 结构）

---

## 目录

1. [架构概览](#架构概览)
2. [REST API 清单](#rest-api-清单)
3. [WebSocket API](#websocket-api)
4. [创建任务的完整调用链路](#创建任务的完整调用链路)

---

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│                    前端 (React SPA)                   │
│                                                     │
│  REST API (authedFetch)          WebSocket           │
│  Authorization: Bearer <JWT>     wss://.../ws/agent  │
│         │                              │              │
└─────────┼──────────────────────────────┼──────────────┘
          │                              │
          ▼                              ▼
┌─────────────────────────────────────────────────────┐
│              后端 (FastAPI, 推测)                      │
│                                                     │
│  /api/*           RESTful CRUD            /ws/agent │
│  - projects       项目管理              - AI 对话流    │
│  - files          文件管理              - 工具调用     │
│  - users          用户管理              - 检查点管理   │
│  - models         模型列表                            │
│  - collections    合集管理                            │
└─────────────────────────────────────────────────────┘
```

**核心要点：**
- 所有 REST 请求通过 `Authorization: Bearer <JWT>` 认证
- **AI 对话不通过 REST API**，全部走 WebSocket
- `session_id` = `workspace_id`，在项目创建时由前端生成（UUID v4）

---

## REST API 清单

### 项目 (Projects)

#### `GET /api/projects`

获取用户的项目列表。

```
Authorization: Bearer <token>
```

**响应 (200):**
```json
{
  "projects": [
    {
      "id": "77069e90-...",
      "workspace_id": "f69fc35b-...",
      "name": "Project f69fc35b",
      "name_source": "default",
      "description": null,
      "settings": { "model": "ddexp" },
      "cached_file_count": null,
      "cached_project_name": null,
      "collection_id": null,
      "screenshot_path": null,
      "created_at": "2026-07-11T10:02:32.440346Z",
      "updated_at": "2026-07-11T10:02:32.783066Z",
      "last_opened": "2026-07-11T02:02:32.786372Z",
      "last_activity_at": null,
      "opened_after_build": false
    }
  ],
  "total": 1,
  "building_workspace_ids": []
}
```

#### `POST /api/projects`

创建新项目（任务）。

```
Authorization: Bearer <token>
Content-Type: application/json
```

**请求体:**
```json
{
  "name": "Project f69fc35b",
  "workspace_id": "f69fc35b-a4af-46e1-9a92-b1df69d96a77",
  "resume_token": "oWJTi_2LDxV8jmIzvN3Q8KZMKFi-Hv02s73KB5MCOsM",
  "settings": {
    "model": "ddexp"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 项目名称（自动生成，格式 `Project <8位hex>`） |
| `workspace_id` | UUID | 前端生成的 UUID v4，作为 session_id 使用 |
| `resume_token` | string | 前端生成的随机 token，用于预览 URL 鉴权 |
| `settings.model` | string | AI 模型 ID，如 `"ddexp"` |

**响应 (201):**
```json
{
  "id": "77069e90-1910-471f-9605-5ef3f614874b",
  "workspace_id": "f69fc35b-a4af-46e1-9a92-b1df69d96a77",
  "name": "Project f69fc35b",
  "name_source": "default",
  "description": null,
  "settings": { "model": "ddexp" },
  "cached_file_count": null,
  "cached_project_name": null,
  "collection_id": null,
  "screenshot_path": null,
  "created_at": "2026-07-11T10:02:32.440346Z",
  "updated_at": "2026-07-11T10:02:32.783066Z",
  "last_opened": "2026-07-11T02:02:32.786372Z",
  "last_activity_at": null,
  "opened_after_build": false
}
```

**注意：** 这个接口只创建项目容器，**不包含用户的 prompt**。Prompt 通过 WebSocket 发送。

---

### 文件 (Files)

#### `GET /api/files/{session_id}`

获取 session 的文件列表。前端在项目生成期间轮询此接口。

```
Authorization: Bearer <token>
```

**查询参数:**
| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 目录路径，空字符串表示根目录 |
| `max_depth` | int | 最大递归深度，默认 `10` |

**响应 (200):**
```json
{
  "files": [
    {
      "name": "pnpm-lock.yaml",
      "path": "pnpm-lock.yaml",
      "type": "file",
      "size": 366819,
      "modified": "2026-07-09T19:44:52.314717"
    },
    {
      "name": "workspace_metadata.json",
      "path": "workspace_metadata.json",
      "type": "file",
      "size": 311,
      "modified": "2026-07-11T18:02:31.494680"
    }
  ],
  "session_id": "f69fc35b-a4af-46e1-9a92-b1df69d96a77"
}
```

---

### 开发服务器 (Dev Server)

#### `GET /api/dev-server-status`

查询开发服务器状态。前端在项目生成期间轮询此接口。

```
Authorization: Bearer <token>
```

**查询参数:**
| 参数 | 类型 | 说明 |
|------|------|------|
| `session_id` | UUID | 即 workspace_id |

**响应 — 未启动 (200):**
```json
{
  "success": false,
  "metadata": { "running": false }
}
```

**响应 — 已启动 (200):**
```json
{
  "success": true,
  "metadata": {
    "running": true,
    "url": "https://deepdiver.app/preview/f69fc35b-.../?token=oWJTi_...",
    "mode": "active",
    "port": 9927,
    "server_type": "vite"
  }
}
```

#### `POST /api/start-dev-server`

启动 Vite 开发服务器以提供预览。

```
Authorization: Bearer <token>
Content-Length: 0
```

**查询参数:**
| 参数 | 类型 | 说明 |
|------|------|------|
| `session_id` | UUID | 即 workspace_id |

**响应 (200):**
```json
{
  "success": true,
  "metadata": {
    "running": true,
    "url": "https://deepdiver.app/preview/f69fc35b-.../?token=oWJTi_...",
    "mode": "active",
    "port": 9927,
    "server_type": "vite"
  }
}
```

**预览 URL 格式:** `https://deepdiver.app/preview/{session_id}/?token={resume_token}`

#### `POST /api/stop-dev-server`

停止开发服务器。

```
Authorization: Bearer <token>
```

---

### 用户 (Users)

> 详见 [deepdiver-auth.md](./deepdiver-auth.md)

| 方法 | 端点 | 说明 |
|------|------|------|
| `POST` | `/api/users/login` | 登录，返回 JWT |
| `POST` | `/api/users/register` | 注册（需申请理由） |
| `GET` | `/api/users/me` | 获取当前用户信息 |
| `GET` | `/api/users/me/api-keys` | 获取 API Key 列表 |
| `POST` | `/api/users/me/api-keys` | 添加 API Key |
| `DELETE` | `/api/users/me/api-keys/{id}` | 删除 API Key |
| `POST` | `/api/users/me/change-password` | 修改密码 |
| `PUT` | `/api/users/me/email` | 修改邮箱 |
| `GET` | `/api/users/me/headless-key` | 获取 headless key |
| `POST` | `/api/users/me/mobile-onboarding/complete` | 完成移动端引导 |

### 其他

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/models` | 获取可用 AI 模型列表 |
| `GET` | `/api/collections` | 获取合集列表 |
| `POST` | `/api/collections/` | 创建合集 |
| `POST` | `/api/collections/move-project/` | 移动项目到合集 |
| `GET` | `/api/gallery` | 获取精选展示列表 |
| `POST` | `/api/clear-static-preview` | 清除静态预览缓存 |
| `GET` | `/api/preview/{id}` | 获取预览内容 |

---

## WebSocket API

### 连接

```
URL:     wss://cn.deepdiver.app/ws/agent?token=<JWT>
协议:    JSON 文本帧（每帧一个完整的 JSON 对象）
心跳:    未发现 ping/pong 机制（依赖 TCP keepalive）
```

前端代码中 URL 的构造逻辑：
```js
const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${window.location.host}/ws/agent`;
const wsUrlWithAuth = token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl;
```

### 客户端 → 服务端消息

#### 1. 绑定 Session（WebSocket 连接后首发）

```json
{
  "session_id": "f69fc35b-a4af-46e1-9a92-b1df69d96a77"
}
```

#### 2. 新 Session 初始化 — 配置模型 + 发送查询

**连续发送两条消息**（前端合并为一个原子操作）：

```json
// 第 1 条：模型配置
{
  "model": "ddexp",
  "settings": {
    "model_temperature": 0.7,
    "model_max_tokens": 64000
  }
}

// 第 2 条：用户查询
{
  "type": "query",
  "query": "帮我页面，介绍一下记忆是怎样形成的",
  "is_followup": false
}
```

#### 3. 已有 Session 发送查询

```json
{
  "type": "query",
  "query": "帮我页面，介绍一下记忆是怎样形成的",
  "is_followup": false,
  "model": "ddexp"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `"query"` | 消息类型 |
| `query` | string | 用户输入的任务描述/prompt |
| `is_followup` | bool | 是否为跟进消息（`false` = 新任务，`true` = 对话中追问） |
| `model` | string | AI 模型 ID |

#### 4. 对话中发送补充消息

```json
{
  "type": "user_message",
  "message": "请把背景颜色改成深色"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `"user_message"` | 消息类型 |
| `message` | string | 用户补充说明的内容 |

#### 5. 暂停执行

```json
{
  "type": "pause"
}
```

#### 6. 恢复执行

```json
{
  "type": "resume",
  "user_message": "继续，但使用 React 而不是 Vue"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `"resume"` | 消息类型 |
| `user_message` | string? | 暂停期间用户输入的可选附加指令 |

#### 7. 回退到历史轮次

```json
{
  "type": "revert",
  "turn_index": 2,
  "checkpoint_id": "optional-checkpoint-uuid"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `"revert"` | 消息类型 |
| `turn_index` | int | 目标轮次索引（0-based） |
| `checkpoint_id` | string? | 目标检查点 ID（可选） |

#### 8. 回答交互式提问

```json
{
  "type": "interaction_response",
  "interaction_id": "request-uuid",
  "response": { "selected_option": "浅色主题" },
  "metadata": {}
}
```

---

### 服务端 → 客户端消息

所有消息以 `type` 字段区分事件类型。

#### Session 生命周期

```json
// Session 创建成功
{
  "type": "session_created",
  "session_id": "f69fc35b-...",
  "is_executing": true,
  "model": "ddexp"
}

// Session 恢复（重新连接）
{
  "type": "session_resumed",
  "session_id": "f69fc35b-...",
  "is_executing": true,
  "model": "ddexp",
  "current_iteration": 8
}

// Session 不存在或已过期
{
  "type": "session_not_found",
  "session_id": "f69fc35b-...",
  "error": "Session expired"
}
```

#### `execution_start` — 开始执行

```json
{
  "type": "execution_start",
  "query": "帮我页面，介绍一下记忆是怎样形成的",
  "checkpoint_id": "checkpoint-uuid"
}
```

#### `thinking` — AI 思考过程

```json
{
  "type": "thinking",
  "content": "Now I'm analyzing the three stages of memory formation...",
  "iteration": 3,
  "agent_id": "1",
  "timestamp": 1783764185.123
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `content` | string | AI 的思考内容（英文） |
| `iteration` | int | 当前迭代编号 |
| `agent_id` | string | 当前 Agent 的 ID |
| `timestamp` | float | Unix 时间戳（秒） |

#### `tool_call` — 工具调用

```json
{
  "type": "tool_call",
  "tool": "file_write",
  "status": "Success",
  "arguments": "{\"path\":\"src/App.tsx\",\"content\":\"import React...\"}",
  "iteration": 5,
  "agent_id": "1",
  "timestamp": 1783764186.456,
  "file_operation": "write",
  "key_files": ["src/App.tsx"],
  "final_answer": null
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `tool` | string | 工具名称：`file_read`, `file_write`, `file_edit`, `bash`, `grep`, `semantic_search`, `ask_question` 等 |
| `status` | string | 执行状态：`"Success"`, `"Running"`, `"Error"` |
| `arguments` | string | JSON 序列化的工具参数 |
| `key_files` | string[] | 涉及的关键文件路径 |
| `file_operation` | string? | 文件操作类型：`"write"`, `"edit"`, `"delete"`, `"read"` |
| `final_answer` | string? | 如果有最终答案则包含 |

#### `checkpoint_complete` — 检查点完成

```json
{
  "type": "checkpoint_complete",
  "success": true,
  "final_answer": "I've created an interactive page about memory formation with 7 sections...",
  "key_files": ["src/App.tsx", "src/index.css", "src/components/MemoryStages.tsx"],
  "thinking_duration": 12.5
}
```

#### `iteration` — 迭代计数

```json
{
  "type": "iteration",
  "iteration": 10
}
```

#### `agent_handoff` — Agent 切换

```json
{
  "type": "agent_handoff",
  "previous_iterations": 5,
  "new_agent_id": "2"
}
```

#### `subagent_start` — 子 Agent 启动

```json
{
  "type": "subagent_start",
  "agent_id": "2",
  "task": "Research the neuroscience of memory",
  "summary": "Running 研究记忆的神经科学机制"
}
```

#### `subagent_event` — 子 Agent 事件

```json
{
  "type": "subagent_event",
  "agent_id": "2",
  "event_type": "thinking",
  "content": "Searching for recent papers on synaptic plasticity..."
}
```

#### `subagent_complete` — 子 Agent 完成

```json
{
  "type": "subagent_complete",
  "agent_id": "2",
  "success": true,
  "iterations_used": 3,
  "result_length": 1500,
  "summary": "Completed neuroscience research"
}
```

#### `context_length` — 上下文长度

```json
{
  "type": "context_length",
  "context_length": 12500,
  "max_context_length": 200000
}
```

#### `interaction_required` — 需要用户交互

```json
{
  "type": "interaction_required",
  "interaction_id": "request-uuid",
  "questions": [
    {
      "type": "ask_question",
      "question": "你希望使用哪种配色方案？",
      "options": ["浅色主题", "深色主题", "渐变风格"]
    }
  ]
}
```

#### 错误

```json
{
  "type": "error",
  "content": "API rate limit exceeded. Please try again later."
}
```

---

## 创建任务的完整调用链路

以下是用户输入 "帮我页面，介绍一下记忆是怎样形成的" 后，前端的完整调用时序：

```
┌──────┐                                          ┌──────────┐
│ 前端  │                                          │ 服务器    │
└──┬───┘                                          └────┬─────┘
   │                                                   │
   │  ① GET /api/projects                              │
   │──────────────────────────────────────────────────▶│
   │  ← { projects: [], total: 0 }                     │
   │                                                   │
   │  ② GET /api/users/me                              │
   │──────────────────────────────────────────────────▶│
   │  ← { id, email, display_name, ... }               │
   │                                                   │
   │  ③ GET /api/users/me/api-keys                     │
   │──────────────────────────────────────────────────▶│
   │  ← { api_keys: [...] }                            │
   │                                                   │
   │  ④ GET /api/collections                           │
   │──────────────────────────────────────────────────▶│
   │  ← { collections: [] }                            │
   │                                                   │
   │  ⑤ GET /api/gallery                               │
   │──────────────────────────────────────────────────▶│
   │  ← { gallery_items: [...] }                       │
   │                                                   │
   │  ═══════ 用户输入 prompt 并提交 ═══════              │
   │                                                   │
   │  ⑥ POST /api/projects                             │
   │  { name, workspace_id, resume_token, settings }   │
   │──────────────────────────────────────────────────▶│
   │  ← 201 { id, workspace_id, ... }                  │
   │                                                   │
   │  ⑦ wss://cn.deepdiver.app/ws/agent?token=<JWT>    │
   │◀══════════════════════════════════════════════════▶│
   │                                                   │
   │  ⑧ WS → { model, settings }                       │
   │──────────────────────────────────────────────────▶│
   │  ⑨ WS → { type:"query", query:"帮我页面...", ... } │
   │──────────────────────────────────────────────────▶│
   │                                                   │
   │  ⑩ WS ← { type:"session_created", ... }           │
   │◀──────────────────────────────────────────────────│
   │  ⑪ WS ← { type:"execution_start", query, ... }    │
   │◀──────────────────────────────────────────────────│
   │  ⑫ WS ← { type:"thinking", content, ... }         │
   │◀──────────────────────────────────────────────────│
   │  ⑬ WS ← { type:"tool_call", tool, ... }           │
   │◀──────────────────────────────────────────────────│
   │     ... (多次 thinking + tool_call 循环) ...       │
   │                                                   │
   │  ⑭ GET /api/files/{session_id} (轮询)              │
   │──────────────────────────────────────────────────▶│
   │  ← { files: [...], session_id }                   │
   │                                                   │
   │  ⑮ GET /api/dev-server-status (轮询)               │
   │──────────────────────────────────────────────────▶│
   │  ← { success: false, ... }                        │
   │     ... (重复轮询直到 ready) ...                     │
   │                                                   │
   │  ⑯ POST /api/start-dev-server                     │
   │──────────────────────────────────────────────────▶│
   │  ← { success: true, url, port, ... }              │
   │                                                   │
   │  ⑰ WS ← { type:"checkpoint_complete", ... }       │
   │◀──────────────────────────────────────────────────│
   │                                                   │
   │  ⑱ iframe 加载预览 URL                             │
   │──────────────────────────────────────────────────▶│
   │  ← Vite HMR + React 应用                          │
   │                                                   │
```

**关键时序说明：**
1. **①-⑤** 页面加载时并发请求，建立 UI 状态
2. **⑥** 用户提交后，先创建项目容器（REST）
3. **⑦-⑨** 立即建立 WebSocket 并发送 prompt
4. **⑩-⑬** 服务端通过 WebSocket 实时推送 AI 的执行过程
5. **⑭-⑮** 前端持续轮询文件列表和开发服务器状态
6. **⑯** 代码生成完毕后启动 Vite 开发服务器
7. **⑰** 最后一个检查点完成
8. **⑱** 预览 iframe 加载生成的应用

---

## 预览 URL

### URL 格式

```
https://cn.deepdiver.app/preview/{session_id}/?token={resume_token}
```

### 参数来源

| 参数 | 来源 | 说明 |
|------|------|------|
| `session_id` | `POST /api/projects` 请求体中的 `workspace_id` | 前端生成的 UUID v4 |
| `resume_token` | `POST /api/projects` 请求体中的 `resume_token` | 前端生成的随机 token（43 字符） |

### 获取方式

1. **`POST /api/start-dev-server`** 成功后返回：
   ```json
   {
     "success": true,
     "metadata": {
       "running": true,
       "url": "https://deepdiver.app/preview/f69fc35b-.../?token=oWJTi_...",
       "mode": "active",
       "port": 9927,
       "server_type": "vite"
     }
   }
   ```

2. **前端构造逻辑**（JS 逆向）：
   ```js
   const previewUrl = `https://deepdiver.app/preview/${sessionId}/?token=${resumeToken}`;
   ```

### 特点

- 预览运行在 Vite 开发服务器上（`server_type: "vite"`），支持 HMR 热更新
- `resume_token` 作为鉴权凭证，防止未授权访问
- 预览 iframe 中的资源路径也是相对此 URL 的（如 `.../preview/{session_id}/assets/memory-funnel.jpg`）
- 开发服务器端口动态分配（示例端口：9927）

---

## 任务生命周期总结

```
┌──────────────────────────────────────────────────────────────┐
│                      任务完整生命周期                          │
│                                                              │
│  ① 用户输入 prompt                                            │
│       │                                                      │
│       ▼                                                      │
│  ② POST /api/projects          ← 创建项目容器                  │
│       返回: { id, workspace_id }                              │
│       │                                                      │
│       ▼                                                      │
│  ③ WebSocket /ws/agent          ← 发送 prompt，AI 开始执行     │
│       │                                                      │
│       ├─▶ thinking              ← AI 思考过程                 │
│       ├─▶ tool_call             ← AI 读写文件                  │
│       ├─▶ subagent_start/event/complete  ← 子 Agent 并行研究  │
│       ├─▶ iteration             ← 迭代计数                    │
│       ├─▶ interaction_required  ← AI 反问用户（可选）          │
│       │                                                      │
│       ▼                                                      │
│  ④ 轮询 GET /api/files/{id}     ← 等待文件生成                 │
│     轮询 GET /api/dev-server-status  ← 等待服务就绪            │
│       │                                                      │
│       ▼                                                      │
│  ⑤ POST /api/start-dev-server  ← 启动 Vite 预览              │
│       返回: { url: "https://...preview/.../?token=..." }      │
│       │                                                      │
│       ▼                                                      │
│  ⑥ checkpoint_complete          ← AI 执行完成                 │
│       │                                                      │
│       ▼                                                      │
│  ⑦ iframe 加载预览 URL          ← 用户看到生成的页面            │
│                                                              │
│  [状态变化]                                                   │
│  - 项目名称: "Project f69fc35b" → AI 自动命名                   │
│  - building_workspace_ids: 添加 → 移除                         │
│  - last_activity_at: null → 更新                               │
└──────────────────────────────────────────────────────────────┘
```
