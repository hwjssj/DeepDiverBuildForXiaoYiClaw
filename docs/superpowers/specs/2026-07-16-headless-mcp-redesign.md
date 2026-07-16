# MCP Server Headless v1 全面重构 — 设计规格

## 背景与目标

当前 MCP Server (`mcp_server/index.js`) 基于主站 JWT + WebSocket 模式，存在以下问题：

1. **认证复杂**：需要邮箱密码登录，token 24h 过期且无 refresh
2. **实现脆弱**：手动管理 WebSocket 连接发送 prompt，通过轮询 files + dev-server-status 检查进度
3. **能力缺失**：不支持暂停/恢复/取消/回答交互、无 SSE 事件流、无任务本地记录

**目标**：全面切换到 Headless API v1 (`/api/v1/*`)，以 headless key 认证，覆盖完整任务生命周期。

## 范围

- 重写 `mcp_server/index.js` — 8 个 MCP 工具
- 重写 `mcp_server/lib/api.js` — Headless v1 REST 客户端
- 新增 `mcp_server/lib/store.js` — 本地状态持久化
- 不涉及外部文档、后端代码或其他目录

## 方案对比

| 维度 | 方案 A（最小改动，5 工具） | 方案 B（全面重构，8 工具）✅ | 方案 C（渐进） |
|------|--------------------------|---------------------------|---------------|
| 改动量 | 最低 | 中 | 分两次 |
| 能力覆盖 | 与现在相同 | 完整 v1 能力 | 第一次同 A |
| 代码清洁度 | 遗留 WebSocket/轮询逻辑 | 纯 REST，更干净 | 遗留两套并存 |
| 维护成本 | 未来仍需重构 | 一步到位 | 两次变更 |

**选择方案 B**：当前代码量小（387 行 + 100 行），重构成本可控；一次性覆盖全能力避免后续反复改。

## 架构设计

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Client (Claude)                    │
│           tool calls via stdio ──────────────────┐       │
└──────────────────────────────────────────────────┼───────┘
                                                   │
┌──────────────────────────────────────────────────┼───────┐
│              mcp_server/index.js                  ▼       │
│                                                          │
│  ┌──────────┐ ┌─────────────┐ ┌──────────────┐          │
│  │ ddb_setup│ │ddb_create   │ │ddb_check     │  ...8个   │
│  │          │ │  _task      │ │  _progress   │          │
│  └────┬─────┘ └──────┬──────┘ └──────┬───────┘          │
│       │              │              │                    │
│  ┌────┴──────────────┴──────────────┴────────────────┐   │
│  │              lib/api.js (v1 客户端)                 │   │
│  │  createTask / getTask / streamTask / respond /     │   │
│  │  cancel / pause / resume / injectMessage           │   │
│  └───────────────────────┬───────────────────────────┘   │
│                          │                               │
│  ┌───────────────────────┴───────────────────────────┐   │
│  │              lib/store.js                          │   │
│  │  loadKey / saveKey / loadTasks / saveTasks         │   │
│  └───────────────────────────────────────────────────┘   │
│                          │                               │
└──────────────────────────┼───────────────────────────────┘
                           │ HTTPS (Authorization: Bearer sk-hdls-...)
                           ▼
┌──────────────────────────────────────────────────────────┐
│              DeepDiver Backend  /api/v1/*                 │
│  POST /tasks  GET /tasks/{id}  GET /tasks/{id}/stream    │
│  POST /tasks/{id}/respond /cancel /pause /resume /message │
└──────────────────────────────────────────────────────────┘

本地状态:
  .deepdiver-key          ← 纯文本，一行 headless API key
  .deepdiver-tasks.json   ← JSON 数组，任务记录
```

## 工具设计

### 1. `ddb_setup`

- **输入**：`headless_key`（格式 `sk-hdls-<32 hex chars>`）
- **行为**：校验格式，写入 `.deepdiver-key`
- **输出**：保存确认

### 2. `ddb_create_task`

- **输入**：`prompt`（必填），`model`、`interaction_mode`（auto/manual，默认 manual）、`screenshot`、`callback_url`（可选）
- **行为**：`POST /api/v1/tasks` → 拿到响应 → 追加写入 `.deepdiver-tasks.json`
- **输出**：`{task_id, workspace_id, resume_token, status}` + 下一步提示

### 3. `ddb_check_progress`

- **输入**：`task_id`（不传则从 `.deepdiver-tasks.json` 找最近一个非终态任务）
- **行为**：`GET /api/v1/tasks/{task_id}` → 展示 status、iteration、事件摘要、preview_url、result
- **特殊状态处理**：`waiting_interaction` 时明确提示用户使用 `ddb_respond`
- **事件摘要**：最近 10 条 events，每条显示 type + 简要信息

### 4. `ddb_stream_task`

- **输入**：`task_id`、`max_events`（默认 50）
- **行为**：连接 SSE 端点，收集最近 `max_events` 条 events 后断开，以可读格式返回
- **快照模式**（非长驻流），适配 MCP 请求-响应模型
- **注意**：如果端点是只追加的历史 events + 实时切换模式，首次连接可能立即收到全量历史；实现时需要检测 done/build_complete/error 事件并在收到后关闭连接

### 5. `ddb_get_preview`

- **输入**：`task_id`
- **行为**：`GET /api/v1/tasks/{task_id}` → 如果 completed 返回 `result.preview_url`；否则返回当前状态
- 不再轮询 dev-server-status + start-dev-server

### 6. `ddb_respond`

- **输入**：`task_id`、`interaction_id`、`response`（回答内容，JSON 对象）
- **行为**：`POST /api/v1/tasks/{id}/respond`
- **场景**：task 处于 `waiting_interaction` 时使用

### 7. `ddb_pause`

- **输入**：`task_id`
- **行为**：`POST /api/v1/tasks/{id}/pause`

### 8. `ddb_cancel`

- **输入**：`task_id`
- **行为**：`POST /api/v1/tasks/{id}/cancel`

### 9. `ddb_resume`

- **输入**：`task_id`
- **行为**：`POST /api/v1/tasks/{id}/resume`

## 数据流

### 本地文件

**`.deepdiver-key`**：纯文本，一行 headless API key

**`.deepdiver-tasks.json`**：
```json
[
  {
    "task_id": "uuid",
    "workspace_id": "uuid",
    "resume_token": "...",
    "prompt": "Create a React counter app",
    "model": "ddexp",
    "interaction_mode": "manual",
    "created_at": "2026-07-16T10:30:00Z",
    "updated_at": "2026-07-16T10:32:00Z"
  }
]
```

每次 `ddb_create_task` 追加一条，`ddb_check_progress` 后更新 `updated_at`。

### 典型调用流

```
① ddb_setup       → 写入 .deepdiver-key
② ddb_create_task → POST /api/v1/tasks → 写入 .deepdiver-tasks.json
③ ddb_check_progress → GET /api/v1/tasks/{id}（可反复调）
   ├─ status=running → 显示 iteration/events 摘要
   ├─ status=waiting_interaction → 提示用 ddb_respond
   │    └─ ddb_respond → POST /api/v1/tasks/{id}/respond
   ├─ status=completed → 显示 preview_url + result
   └─ status=failed/cancelled → 显示错误
```

### task_id 智能解析

```
ddb_check_progress(task_id?)
  → 传了 task_id → 直接用
  → 没传 → 从 .deepdiver-tasks.json 找最近一条(status ∈ running/paused/waiting_interaction)
  → 找不到 → 报错让用户先 create_task
```

## 边界情况 / 错误处理

| 场景 | 处理 |
|------|------|
| 未 setup 就调其他工具 | 提示先执行 `ddb_setup` |
| API 401 | key 无效，提示重新 `ddb_setup` |
| API 409 | 活跃任务冲突，返回冲突 task_id |
| API 404 | task_id 不存在或已过期 |
| .deepdiver-tasks.json 不存在或空 | 提示先 create_task |
| 网络超时 | 重试 1 次 + 友好报错 |
| SSE 流连接断开 | 返回已收集的 events + 断连提示 |

## 实施建议

### 文件改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `mcp_server/index.js` | 重写 | 8 工具定义 + handler，删 WebSocket |
| `mcp_server/lib/api.js` | 重写 | 全部替换为 v1 端点 |
| `mcp_server/lib/store.js` | 新增 | key/tasks JSON 读写 |

### 推荐实施步骤

1. 先写 `lib/store.js`（key 管理和 tasks JSON 读写）
2. 写 `lib/api.js`（v1 REST 客户端，8 个函数）
3. 写 `index.js`（工具定义 + handler 路由 + main）
4. 自测：用 `npx @modelcontextprotocol/inspector node index.js` 检查工具列表和调用
5. 更新 `.deepdiver-tasks.json` 在 `.gitignore` 中确保不入库

### 测试策略

- `ddb_setup`：提供合法/非法 key 格式
- `ddb_create_task`：提交 prompt，验证返回 task_id + 写入 tasks 文件
- `ddb_check_progress`：按 task_id 查询，覆盖 running/completed/waiting_interaction 各状态
- `ddb_respond`：构造 waiting_interaction 的 task 测试回答
- `ddb_pause/resume/cancel`：对 running task 做控制操作
- 空状态测试：无 tasks 文件时各工具的降级行为
