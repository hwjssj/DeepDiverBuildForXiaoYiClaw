# Headless API — `ask_question` 工具接入指南

**读者**：基于 DeepDiver Headless API 构建界面的前端工程师与交互设计师。本文档**只**讲 `ask_question`(用户提问)这一条链路 —— Agent 在运行中如何向用户提问、前端应如何渲染、用户作答后如何把答复回传以解除 Agent 的阻塞。

完整的 Headless API 说明（任务提交、SSE、轮询、生命周期）请参见 `docs/headless-api.md`。本文档只覆盖交互入口,所有结论均可通过下方列出的源码位置核对。

---

## 1. `ask_question` 是什么

`ask_question` 是服务端的一个 Agent 工具,它允许 Agent 在继续执行前暂停下来,向用户提出 1–3 个澄清性问题。Agent 调用它时:

1. 工具返回一个 `interaction_required=True` 的包装体,而不是普通的工具结果。
2. Base Agent 检测到这个包装体后,发出一个 `interaction_required` 事件,并在一个条件变量上**阻塞等待**回答。
3. 会话状态切换为 `waiting_interaction`。
4. 前端通过 SSE(或轮询)接收到事件,渲染提问 UI,收集用户答复,再 `POST` 到 `/tasks/{task_id}/respond`。
5. Agent 被阻塞的调用返回,拿到的答复会作为该次工具调用的结果,Agent 继续执行。

源码对照:

| 组件 | 文件 | 符号 |
|---|---|---|
| 工具定义 | `deepdiver-server-nginx-preview/src/tools/mcp/interaction.py:19` | `InteractionTools.ask_question` |
| Agent 交互循环 | `src/agents/base_agent.py:1128` | interaction 分发块 |
| Agent 等待答复 | `src/agents/base_agent.py:912` | `_wait_for_interaction_response` |
| Agent 提交答复 | `src/agents/base_agent.py:873` | `submit_interaction_response` |
| HTTP 请求模型 | `web-demo/backend/routes/headless_api.py:172` | `TaskSubmitRequest`、`InteractionResponse`、`TaskStatusResponse` |
| `POST /respond` 路由 | `web-demo/backend/routes/headless_api.py:986` | `respond_to_interaction` |
| `GET /tasks/{id}` 路由 | `web-demo/backend/routes/headless_api.py:859` | `get_task_status` |
| SSE 流路由 | `web-demo/backend/routes/headless_api.py:889` | `task_stream` |
| 会话状态迁移 | `web-demo/backend/sessions/session.py:108` | `set_waiting_interaction`、`clear_pending_interaction` |
| 自动应答回调 | `web-demo/backend/routes/headless_api.py:455` | `_auto_interaction_callback` |
| TS 事件类型 | `tui/src/api/types.ts:73` | `InteractionData`、`SSEEventType` |
| TUI SSE 处理 | `tui/src/context/sync.tsx:383` | `interaction_required` 分支 |
| TUI 状态清理 | `tui/src/context/sync.tsx:122` + `:172` | `clearInteraction`、iteration 自动清理 |
| TUI respond / dismiss | `tui/src/app.tsx:255` | `handleInteractionRespond`、`handleInteractionDismiss` |
| TUI 对话框组件 | `tui/src/component/dialog-question.tsx:12` | `QuestionPrompt` |
| TUI 回调客户端 | `tui/src/api/client.ts:34` | `respond()` |
| Web-demo WS 处理 | `web-demo/frontend/src/hooks/useWebSocket.ts:1104` | `interaction_required` 分支(WebSocket,**非** Headless API) |
| Web-demo 作答钩子 | `web-demo/frontend/src/hooks/useInteractionAnswer.ts:25` | `submitAnswer` |
| Web-demo 选项 UI | `web-demo/frontend/src/components/shared/InteractionOptionsPanel.tsx:20` | `InteractionOptionsPanel` |

---

## 2. 提问 payload — 精确 schema

### 2.1 服务端工具返回的原始结构

`interaction.py:47-54` 原文:

```python
{
  "success": True,
  "interaction_required": True,
  "interaction": {
    "type": "ask_question",
    "questions": questions   # Agent 传入的列表,超过 3 条会被裁剪
  }
}
```

单个 question 对象的字段(`interaction.py:28-33`):

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 每个问题唯一,用于作答时回填答案。 |
| `prompt` | string | 是 | 展示给用户看的问题文本。 |
| `options` | string \| string[] | 否 | 选项列表。工具协议写的是"逗号分隔字符串",但 TUI 同时接受**逗号分隔字符串和数组**(`tui/src/component/dialog-question.tsx:36-42`)。前端应两种形态都兼容。 |
| `allow_multiple` | boolean \| `"true"` \| `"false"` | 否 | 为真时允许多选。布尔 `true` 和字符串 `"true"` 都必须视为启用(`dialog-question.tsx:31-34`)。 |

注意:
- Agent 一次调用 `ask_question` 可能带 **1 到 3** 个问题。超过 3 条的会被服务端静默裁剪到前 3 条(`interaction.py:41-43`)。
- 若传入空列表或非法结构,工具返回 `{"success": False, "error": "..."}` 且**不会**触发交互流程 —— 此时前端不会收到 `interaction_required` 事件。

### 2.2 前端实际收到的内容

事件离开 Agent 前,Base Agent 会追加两个字段(`base_agent.py:1131-1133`):

```python
interaction_id = interaction_payload.get("interaction_id") or f"interaction-{uuid.uuid4()}"
interaction_payload["interaction_id"] = interaction_id
interaction_payload["tool"] = tool_name
```

因此前端在线上看到的事件 `data` 始终是这个形状:

```json
{
  "interaction_id": "interaction-9f5e3b2a-...",
  "type": "ask_question",
  "tool": "ask_question",
  "questions": [
    {
      "id": "q1",
      "prompt": "想用哪个 CSS 框架?",
      "options": ["Tailwind", "Bootstrap", "None"],
      "allow_multiple": false
    },
    {
      "id": "q2",
      "prompt": "需要哪些页面?",
      "options": "Home,About,Contact",
      "allow_multiple": true
    }
  ]
}
```

对应的 TypeScript 类型(`tui/src/api/types.ts:73-82`):

```ts
export interface InteractionData {
  interaction_id: string
  type: string
  questions: Array<{
    id: string
    prompt: string
    options?: string | string[]
    allow_multiple?: boolean
  }>
}
```

**`interaction_id` 必须当作不透明字符串处理** —— 作答时原样回填。

---

## 3. 问题如何抵达前端

有两条下发通道,前端**任选其一**即可,不必同时订阅。

### 3.1 SSE 流(推荐)

接口: `GET /api/v1/tasks/{task_id}/stream`
鉴权: `Authorization: Bearer <api_key>`

SSE 帧格式见 `headless_api.py:895`:

```
event: <事件名>
data: <json>
\n
```

会出现的 `event:` 名称共 4 种:

| `event:` 名称 | 含义 |
|---|---|
| `status` | 流的第一帧。初始任务状态快照。 |
| `agent` | Agent 的每一个事件(start、iteration、tool_call、**interaction_required**、complete 等)。 |
| `done` | 终止帧,流会立即关闭。 |
| `ping` | 空闲时每 ~15 秒一次的心跳,直接忽略。 |

每条 `agent` 帧的 JSON 结构(见 `headless_api.py:922-928`):

```json
{
  "seq": 42,
  "type": "interaction_required",
  "data": { /* 即 §2.2 的 InteractionData */ },
  "timestamp": 1744300000.123
}
```

所以一条完整的提问帧长这样:

```
event: agent
data: {"seq":42,"type":"interaction_required","data":{"interaction_id":"interaction-9f5e...","type":"ask_question","tool":"ask_question","questions":[{"id":"q1","prompt":"想用哪个 CSS 框架?","options":["Tailwind","Bootstrap","None"],"allow_multiple":false}]},"timestamp":1744300000.123}

```

SSE `type` 的完整枚举见 `tui/src/api/types.ts:25-39`。对于提问流程只需要关心:

- `interaction_required` —— 收到一条提问,渲染 UI,暂停"Agent 工作中"的动效。
- `iteration` / `tool_call` / `thinking` / `streaming` / `complete` / `cancelled` / `error` —— 作答提交成功后,恢复正常渲染。

**断线重连 / 晚到场景**:如果前端是在问题发出**之后**才接上流,`task_stream` 会先重放 `session.events_history`(`headless_api.py:919-932`),`interaction_required` 事件会原样重发。前端不需要做任何额外逻辑 —— 照常处理事件即可。

### 3.2 轮询(备选)

接口: `GET /api/v1/tasks/{task_id}`

返回结构(`headless_api.py:877-885`):

```json
{
  "task_id": "...",
  "workspace_id": "...",
  "status": "waiting_interaction",
  "current_iteration": 7,
  "events": [ /* 完整历史,每条都有 seq/type/data/timestamp */ ],
  "result": null,
  "interaction": {
    "interaction_id": "interaction-9f5e...",
    "type": "ask_question",
    "tool": "ask_question",
    "questions": [ /* ... */ ]
  }
}
```

- `status == "waiting_interaction"` **就是**存在待答问题的信号(`headless_api.py:875`)。
- 任务处于其它状态时,`interaction` 字段为 `null`。
- Headless API 返回的 status 枚举: `running`、`waiting_interaction`、`completed`、`failed`、`cancelled`。

---

## 4. 提交答复

接口: `POST /api/v1/tasks/{task_id}/respond`
鉴权: `Authorization: Bearer <api_key>`
Content-Type: `application/json`

### 4.1 请求体

Pydantic 模型(`headless_api.py:194-196`):

```python
class InteractionResponse(BaseModel):
    interaction_id: str
    response: Dict[str, Any]
```

```json
{
  "interaction_id": "interaction-9f5e3b2a-...",
  "response": {
    "q1": "Tailwind",
    "q2": ["Home", "About"]
  }
}
```

构造 `response` 的规则:

1. Key **必须**是原始问题的 `id`。
2. 单选题(`allow_multiple` 为假值)—— value 为**字符串**,是被选中的选项,或用户在选项之外自填的自由文本。
3. 多选题(`allow_multiple` 为真值,包括字符串 `"true"`)—— value 为**字符串数组**。API 接受空数组,但通常无意义;TUI 至少要选中一项才允许提交(`dialog-question.tsx:102-106`)。
4. 原始 payload 中出现的每个问题,`response` 里都应有对应 key。参考 TUI 对于未作答的单选题会自动回填第一个选项(`dialog-question.tsx:82`),前端可沿用这个策略,也可强制要求用户显式作答。
5. `response` 的形态服务端**不做校验** —— 它是一个透传给 Agent 的 `Dict[str, Any]`,Agent 会把它当作原工具调用的返回结果直接使用(`base_agent.py:1141-1143`)。请严格遵循"以 `id` 为 key"的约定,否则 Agent 解析不了答案。

### 4.2 成功响应

```
200 OK
{ "status": "running" }
```

这次调用之后,Agent 的 `_wait_for_interaction_response` 会解除阻塞,`tool_result` 被替换为 `response` 字典(`base_agent.py:1143`),任务状态回到 `running`,新的 `agent` 事件(`iteration`、`tool_call`…)会重新出现在 SSE 流中。

### 4.3 错误响应

参见 `headless_api.py:986-995`:

| 状态码 | 条件 | 响应体 |
|---|---|---|
| `401` | 缺失或非法的 `Authorization` 头 | `{"detail": "..."}` |
| `404` | `task_id` 不存在 | `{"detail": "Task not found"}` |
| `409` | 任务当前并非在等待交互(例如已答、已取消、已完成) | `{"detail": "Task is not waiting for interaction (status: <state>)"}` |
| `409` | 会话上没有活跃 Agent | `{"detail": "No active agent to respond to"}` |

**重要**: 服务端**不会**严格校验提交的 `interaction_id` 是否与当前待答的一致。Agent 自身会忽略 `interaction_id` 不匹配的答复(`base_agent.py:876`)并继续阻塞等待。如果 UI 提交了一个过期/旧的 `interaction_id`,API 会返回 `200` 但 Agent 永远不会解除阻塞。**前端务必用最近一条 `interaction_required` 事件里的 `interaction_id` 原样回填。**

---

## 5. UI 行为清单

下面这些是前端正确实现应当具备的行为,取自参考 TUI(`tui/src/component/dialog-question.tsx`)和后端契约。

### 状态机

```
          ┌──────────┐   收到 interaction_required 事件
          │ running  │ ───────────────────────────┐
          └──────────┘                            ▼
                ▲                        ┌─────────────────────┐
                │ POST /respond 返回 200 │ waiting_interaction │
                └────────────────────────│  (渲染对话框)       │
                                         └─────────────────────┘
```

- 收到 `interaction_required` 时: 取出 `data.interaction_id` 和 `data.questions`,渲染提问 UI,冻结所有"Agent 正在思考"的动画。
- **乐观关闭 —— 不必等 POST 完成。** 参考 TUI 的做法是**先**清理本地对话框状态,**再**触发 `client.respond()`(`tui/src/app.tsx:260-264`)。用户感觉到对话框立即关闭,网络请求在后台完成。不要等到 `200` 再关。
- **`/respond` 返回 409 时静默吞掉。** 如果 `/respond` 返回 `409`,通常意味着任务状态已经发生漂移(被取消、自动应答、或另一个客户端已经先一步作答)。参考 TUI 把 409 视为非致命错误,直接忽略不向用户报错(`tui/src/app.tsx:265-275`)。其他失败(500、网络错误等)则应该正常向用户反馈。
- **按 `interaction_id` 去重。** 如果前端有可能对同一个 `interaction_required` 事件看到两次(SSE 重连后重放、多标签页同一任务等),维护一个已应答 `interaction_id` 的集合并丢弃重复。web-demo 在 `useWebSocket.ts:1106-1108` 就是这么做的:
  ```ts
  if (interactionId && answeredInteractionsRef.current.has(interactionId)) break;
  ```
- **Agent 一旦继续就自动清理对话框。** 如果对话框还挂着,却收到了一条 `iteration`(或任何作答之后才会出现的 Agent 事件),说明 Agent 已经越过这个问题 —— 关掉对话框。TUI 就在 `iteration` 分支里清理 `pendingInteraction`(`tui/src/context/sync.tsx:172-176`)。这对崩溃恢复、多标签页这些边缘场景是一条稳健的兜底。
- 用户在问题弹出时主动取消任务(`POST /tasks/{task_id}/cancel`): 直接关闭 UI,Agent 会在等待循环中感知到取消并退出(`base_agent.py:921-923`)。
- 问题弹出时 SSE 断连: 重连即可。`interaction_required` 事件会从历史中重放,或下一条 `agent` 帧会带回最新状态。上面那条"按 id 去重"的机制会防止重放把已答过的对话框再度弹出。
- **"不答而关"也是合法路径。** TUI 的 Esc 处理就是直接清掉本地状态,**什么也不发**(`tui/src/app.tsx:278-281`)。这时 Agent 会继续阻塞在等待循环里。常见的用法是"我反悔了,整个任务不要了" —— 为了干净起见,请在 dismiss 动作里一并调用 `POST /tasks/{task_id}/cancel`,否则 Agent 会一直等下去。

### 渲染问题

- **问题数量**: 1 到 3 条之间。三种数量都要能正常渲染。
- **单个问题**: 直接展示 prompt + 选项即可,TUI 在此情况下不显示翻页。
- **多个问题**: TUI 逐条引导用户作答,顶部有"当前序号 / 总数"的指示。步骤条或手风琴都是合理替代方案。
- **选项解析**:
  ```ts
  const options =
    typeof raw === "string"
      ? raw.split(",").map(s => s.trim()).filter(Boolean)
      : Array.isArray(raw) ? raw.map(String) : []
  ```
  (对应 `dialog-question.tsx:36-42`。)web-demo 还额外兼容了数组里的对象形式 `{ id?, label? }`(`useWebSocket.ts:1143-1168`)。兼容这种形式不是必须,但能让你的客户端在工具将来输出更丰富的选项结构时保持前向兼容。
- **未提供 options**: 视为自由文本题,参考 TUI 会展示一个文本输入区。
- **选项 + 自由文本并存(强烈建议)**: **即使有选项也要**提供"自填答案"入口。TUI 无条件把"Type your own answer"渲染为第 N+1 个选项(`dialog-question.tsx:217-253`);web-demo 则在后端没给"Other..."时自动注入一个(`InteractionOptionsPanel.tsx:35-40`)。Agent 给的选项往往只是建议,用户可能想自定义。
- **多选**: 使用复选框样式。`allow_multiple` 可能是布尔 `true` **或**字符串 `"true"`,用 `raw === true || raw === 'true'` 归一化(`useWebSocket.ts:1126-1129`,`dialog-question.tsx:31-34`)。
- **提交**: 按 §4.1 构造 `response`,形状为 `Record<questionId, string | string[]>`。
- **跳过 / 空答案的处理**: web-demo 的 Skip 按钮会把该题答案填为字符串 `"skip this question"`(`InteractionOptionsPanel.tsx:121`、`useInteractionAnswer.ts:65`)。这比空字符串更能让 Agent 明确识别"用户选择了不作答"。任何"跳过"交互都推荐采用这种约定。

### 可用性 / UX 要点

- 此时 Agent 是**阻塞**的。UI 要清晰地表达"任务已暂停,正等你作答",不要让界面还在给出"后台还在干活"的错觉。
- **不要**给对话框加自动关闭的倒计时。服务端不会超时(等待循环在 `base_agent.py:912-937` 中以 0.2 秒为粒度轮询,直到收到答复或被取消)。
- 问题的顺序对 Agent 是有语义的(每个问题都有语义 id)。**不要**在发送答复前重新排序问题列表。
- Agent 需要通过 `id → answer` 的映射来识别答复。**绝不能**用问题文本或数组下标作为 key。

---

## 6. 自动应答模式(无需 UI)

提交任务时若传入 `interaction_mode: "auto"`(`headless_api.py:500`),服务端的一个回调会短路整条交互流程(`headless_api.py:455-479`,注册位置在 `:501`):

- 每收到一次 `interaction_required` 事件,300 ms 后定时器触发,自动提交这个回复:
  ```json
  { "auto": true, "message": "Proceed with your best judgment" }
  ```
- UI 仍然会**收到** `interaction_required` 事件以便提示,但不应弹出阻塞式模态框。用 Toast 或横幅("Agent 正在自动回答自己的提问")更合适。
- 在这种模式下,UI 发 `POST /respond` 是多余的(几乎一定会和自动应答器竞争,最终返回 `409`)。

`interaction_mode` 默认为 `"manual"`,除非客户端显式声明要用 auto,否则无需改变行为。

---

## 7. 端到端完整示例

### 7.1 提交任务

```http
POST /api/v1/tasks HTTP/1.1
Authorization: Bearer sk-hdls-...
Content-Type: application/json

{
  "query": "创建一个 React 计数器应用",
  "interaction_mode": "manual"
}
```

```
HTTP/1.1 202 Accepted
{
  "task_id": "t_abc123",
  "workspace_id": "ws_xyz",
  "resume_token": null,
  "status": "running"
}
```

### 7.2 订阅 SSE 流

```http
GET /api/v1/tasks/t_abc123/stream HTTP/1.1
Authorization: Bearer sk-hdls-...
Accept: text/event-stream
```

流式事件陆续到达,其中某一条:

```
event: agent
data: {"seq":17,"type":"interaction_required","data":{"interaction_id":"interaction-9f5e3b2a","type":"ask_question","tool":"ask_question","questions":[{"id":"framework","prompt":"想用哪个 CSS 框架?","options":["Tailwind","Bootstrap","None"],"allow_multiple":false},{"id":"pages","prompt":"需要哪些页面?","options":"Home,About,Contact","allow_multiple":"true"}]},"timestamp":1744300123.456}
```

UI 动作: 渲染两个问题的弹窗,等待用户作答。

### 7.3 用户作答,POST 到 `/respond`

```http
POST /api/v1/tasks/t_abc123/respond HTTP/1.1
Authorization: Bearer sk-hdls-...
Content-Type: application/json

{
  "interaction_id": "interaction-9f5e3b2a",
  "response": {
    "framework": "Tailwind",
    "pages": ["Home", "About"]
  }
}
```

```
HTTP/1.1 200 OK
{ "status": "running" }
```

### 7.4 流继续推进

```
event: agent
data: {"seq":18,"type":"iteration","data":{"iteration":8,"token_count":...,"token_threshold":...},"timestamp":...}
event: agent
data: {"seq":19,"type":"tool_call","data":{"tool":"file_write",...},"timestamp":...}
...
event: agent
data: {"seq":55,"type":"build_complete","data":{"success":true,...},"timestamp":...}
event: done
data: {"success":true,...}
```

---

## 8. 仓库内参考实现

本仓库里有两个一方客户端都处理了 `ask_question`,两者的参考价值完全不同:

### 8.1 TUI —— 标准 Headless API 接入范式

**路径**: `tui/src/`。传输: SSE + `POST /respond`(也就是本文档描述的 Headless API)。**请把它当作协议 / 传输层的唯一权威参考。**

关键文件和借鉴点:

| 文件 | 值得照搬的地方 |
|---|---|
| `tui/src/api/client.ts:34-44` | 最精简的 `respond()` 实现 —— 精确到字节的 HTTP 结构。 |
| `tui/src/api/sse.ts` | SSE 原始帧的解析(`event:` / `data:` / `\n\n`),`agent` / `done` / `ping` 的分流。 |
| `tui/src/context/sync.tsx:383-387` | 事件处理只有一行: 存 payload,把 status 切到 `waiting_interaction`。 |
| `tui/src/context/sync.tsx:172-176` | "iteration 事件到来即自动清理待答对话框"的兜底。 |
| `tui/src/app.tsx:255-281` | 完整的应答 / dismiss 生命周期,包括"先关再发"的乐观关闭和"409 静默吞掉"的约定。 |
| `tui/src/component/dialog-question.tsx` | 实际的提问 UI —— 选项渲染、多选、自填回退、键盘导航。 |

`dialog-question.tsx` 的功能清单:

- **选项渲染**: 单选用 `1.` / `2.` / `3.` … 编号;多选用 `[ ] / [✓]` 复选框。
- **自填答案永远可用**: 无条件把 "Type your own answer" 作为第 N+1 个选项渲染(217-253 行)。选中后会展开一个内联文本输入区。
- **键盘快捷键**(115-163 行):
  - `↑` / `k` —— 上一个
  - `↓` / `j` —— 下一个
  - `1`–`9` —— 按序号直达
  - `space` —— 多选模式下切换勾选
  - `enter` —— 确认当前选项(单选),或整个多选批次提交
  - `esc` —— 不作答直接关闭
- **多选提示**: 在选项上方展示 `(space to toggle, enter to confirm)` 这条帮助文案(183-187 行)。
- **多选校验**: 至少选中一个才允许回车提交(102-106 行)。
- **单选兜底**: 如果用户没选任何项就提交,自动回填第一个选项(82 行)。如果你要的是严格校验就不要照抄这个兜底。
- **多问题批次**: `questions.length > 1` 时,对话框会在内部按顺序逐题推进,只在最后一题才触发 `onRespond`(67-73 行)。

它产出的 response 结构(75-86 行)—— **与 Headless API 接受的形状完全一致**:

```ts
const result: Record<string, any> = {}
for (const q of questions()) {
  const am = q.allow_multiple === true || q.allow_multiple === "true"
  if (am) result[q.id] = multiSelections[q.id] ?? []
  else    result[q.id] = answers[q.id] ?? (options().length > 0 ? options()[0] : "")
}
props.onRespond(result)
```

### 8.2 Web-demo —— UX 参考(**不是** Headless API 的消费者)

**路径**: `web-demo/frontend/src/`。传输: **直连 web-demo 后端的 WebSocket**,用的是 `interaction_response` 消息类型 —— 它早于 Headless API 出现,**不会**走 `POST /api/v1/tasks/{id}/respond`。**不要**照搬它的传输层,但它的 UI/UX 套路非常值得借鉴。

> ⚠️ **传输层提醒**。web-demo 发的是 `{ type: "interaction_response", interaction_id, response, metadata }`,走 WebSocket。Headless API **不接受**这个消息形状,**不接受** `metadata` 字段,也**不提供** WebSocket 接入点。如果你直接复制 web-demo 的代码片段,请把 WebSocket 那一层剥掉,换成 §4.1 描述的 `POST /api/v1/tasks/{task_id}/respond`。

可以借鉴的 UX 套路(全部在 web-demo 源码里已验证):

1. **不是弹窗,是聊天里的内嵌面板** —— web-demo 把提问直接内嵌在对话流里(`WorkingPage.tsx:407-422`),紧跟在 Agent 的"思考"片段后面。问题始终处在上下文里,像对话的自然一轮,不打断消息历史。
2. **分页式逐题推进 + 累积作答**(`useInteractionAnswer.ts:34-72`)—— 多问题批次会用 `currentQuestionIndex` 逐题展示,把答案累积到 `collectedAnswers` 里,**只在最后一题**才把全部答案一次性回传。相比一次塞 3 个问题,用户负担小得多。TUI 的逐题推进也是类似思路,只是在一个对话框内部做。
3. **选项自动编号为字母**(`useWebSocket.ts:1114`、`:1138`)—— 客户端侧给每个选项发一个字母 id(`A`、`B`、`C`…),UI 就可以渲染成 `A. Tailwind`、`B. Bootstrap`…,可读性强,也非常适合做键盘快捷键。
4. **"Other..." 自动补充**(`InteractionOptionsPanel.tsx:35-40`)—— 如果后端没提供 "Other..." 选项,web-demo 会自动补一个。选中后会在同一行展开一个内联输入框。这是把"建议答案"和"自由输入"结合起来的干净写法。
5. **Skip 按钮**(`InteractionOptionsPanel.tsx:118-125`)—— 永远可见、永远可用,按下等于把答案设为 `"skip this question"`。给用户一个退出阀门,又不破坏整个流程。
6. **Continue 按钮带校验**(`InteractionOptionsPanel.tsx:126-151`)—— 在当前问题没有有效答案之前(没选真实选项,或者选了 "Other..." 但文本为空)这个按钮是禁用的。可以避免误点导致空答案。
7. **选中态样式** —— 浅蓝底 + 蓝色描边表示选中,普通描边表示未选(`InteractionOptionsPanel.tsx:108-112`)。朴素但清晰。
8. **移动端 / 桌面端分叉** —— 同一个面板组件,不同的 `hover:` / `active:` 伪类(`InteractionOptionsPanel.tsx:51-54`)。如果你的产品两端都要出,直接抄即可。
9. **可读的 Q&A 日志** —— 提交之后 web-demo 会在对话流里本地添加一条名为 `ask_question_answers` 的类工具调用记录,让用户在回顾时看到"你当时答了 X"(`useWebSocket.ts:1449-1472`)。这完全是客户端本地渲染,Headless API 没有这一层,但在你自己的客户端里也同样记录一条,是很贴心的细节。

### 8.3 对照表

| 关注点 | TUI(Headless API) | Web-demo(WebSocket) |
|---|---|---|
| 传输 | SSE + `POST /respond` | WebSocket `interaction_response` 消息 |
| 承载方式 | 终端里的模态浮层 | 对话流里的内嵌面板 |
| 多题批次 | 单个对话框内部分步推进 | 随状态更新,一次渲染一题 |
| 选项 ID | 后端下发(或序号) | 客户端自动生成字母 |
| 自由输入 | "Type your own answer" 作为第 N+1 项,永远存在 | 没给就自动补 "Other..." |
| 多选确认 | 选好后按 `enter` | 点 Continue 按钮 |
| 关闭 / 跳过 | `esc` —— 本地清理,什么也不发 | "Skip" —— 提交 `"skip this question"` |
| 去重 | 依赖 iteration 自动清理 | 显式维护 `Set<interactionId>` 去重 |
| metadata 字段 | 不存在 | 用 `metadata.qa` 回传可读对话对,**不是 Headless API 的一部分** |

优秀的 Headless API 前端应该是: **协议层抄 TUI,UI/UX 抄 web-demo**。

---

## 9. 速查

**提问流程只涉及这两类接口:**

| 用途 | 方法 + 路径 |
|---|---|
| 接收问题(推荐) | `GET /api/v1/tasks/{task_id}/stream` —— 监听 `agent` 帧中 `data.type == "interaction_required"` 的事件 |
| 接收问题(轮询) | `GET /api/v1/tasks/{task_id}` —— 当 `status == "waiting_interaction"` 时读取 `interaction` 字段 |
| 提交答复 | `POST /api/v1/tasks/{task_id}/respond`,body 为 `{ interaction_id, response }` |

**必须守住的不变量:**

1. `interaction_id` 原样回填。
2. `response` 的 key 使用问题 `id`。
3. 单选 → 字符串;多选(`allow_multiple` 为真值,包括字符串 `"true"`)→ 字符串数组。
4. `options` 可能是逗号分隔字符串,也可能是数组,两种都要兼容。
5. 一次交互最多 3 个问题,1、2、3 三种数量都要考虑。
6. 任务在作答前是**阻塞**状态,UI 要清晰地把这个状态传达给用户。
