# Headless API —— Webhook（回调）接入指南

**面向对象**：接入 DeepDiver Headless API 的后端开发者，如果你们的运行环境不方便（或不愿意）轮询 `GET /tasks/{task_id}`、也不方便保持 SSE 长连接，就可以用 webhook。本文档**只讲** webhook 回调流程：如何在提交任务时注册回调 URL、任务结束后 DeepDiver 会 POST 什么内容、如何校验签名、以及重试策略。

Headless API 的完整说明（任务提交、SSE、轮询、生命周期）见 [headless-api-zh.md](./headless-api-zh.md)。本文档只覆盖 webhook 相关的部分。

---

## 1. 什么时候该用 webhook

Webhook 是**可选**且**附加**的能力，并不替代轮询或 SSE，只是为那些可以接收入站 HTTP 请求、但不方便自己轮询长耗时任务的调用方提供便利。

| 访问模式 | 推荐方式 |
|---|---|
| 长连接客户端、实时 UI | SSE（`GET /tasks/{task_id}/stream`） |
| 短生命周期脚本、简单轮询 | Polling（`GET /tasks/{task_id}`） |
| 服务端对服务端，不方便保持长连接 | **Webhook**（本文档） |

如果你在提交任务时传了 `callback_url`，DeepDiver 会在任务到达终态（成功/失败/取消）后，**恰好 POST 一次**到该 URL。如果没传 `callback_url`，什么都不会多做，轮询和 SSE 照常可用。

---

## 2. 注册回调

在提交任务时一起带上回调字段：

```
POST /api/v1/tasks
Authorization: Bearer sk-hdls-...
Content-Type: application/json

{
  "query": "Create a React counter app",
  "callback_url": "https://your.server.example.com/deepdiver/hook",
  "callback_secret": "a-long-random-string-you-generated",
  "callback_headers": {
    "X-Your-Auth": "Bearer your-own-token"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `callback_url` | string | 否 | 任务终态时我们会 POST 的 HTTPS URL，不传即关闭 webhook。 |
| `callback_secret` | string | 否 | 用于对 body 做 HMAC 签名的共享密钥。如果你不需要验证来源真实性可以不传。 |
| `callback_headers` | object | 否 | 附加的请求头，我们会原样转发到出站 POST（例如你们自己的 bearer token）。`X-DeepDiver-*`、`Content-Type`、`User-Agent` 这些保留头不允许被覆盖。 |

**提交时的 URL 校验**：
- Scheme 必须是 `https`（或在 DeepDiver 服务端设了 `HEADLESS_WEBHOOK_ALLOW_HTTP=1` 时允许 `http`，仅限开发环境）。
- 生产环境下，主机名不能解析到私有 IP、loopback、link-local、保留或组播地址（可用 `HEADLESS_WEBHOOK_ALLOW_PRIVATE=1` 开发环境豁免）。
- 不合法的 URL 会在提交时直接返回 `400 Bad Request`，而不是等到后面静默投递失败。

---

## 3. Payload 结构 —— 由 DeepDiver 定义

payload 的结构由 DeepDiver 定义，不会按各接入方的诉求来改。通过顶层 `version` 字段和 `X-DeepDiver-Schema-Version` 请求头做版本管理。新字段可能会增加，但**已有字段的名称和类型**不会在不升版本号的情况下改动。

**当前版本**：`2026-04-23`

### 3.1 成功

```json
{
  "version": "2026-04-23",
  "event": "task.success",
  "task_id": "b2c3d4e5-...",
  "workspace_id": "ws-a1b2c3...",
  "status": "success",
  "timestamp": "2026-04-23T10:30:00Z",
  "result": {
    "success": true,
    "iterations": 5,
    "execution_time": 42.3,
    "final_answer": "...",
    "key_files": ["src/App.tsx", "src/index.css"],
    "preview_url": "https://deepdiver.app/preview/ws-a1b2c3.../?token=...",
    "project_name": "Counter App",
    "screenshot_url": "https://deepdiver.app/screenshots/abc123.png"
  },
  "error": null
}
```

### 3.2 失败 / 取消

```json
{
  "version": "2026-04-23",
  "event": "task.failed",
  "task_id": "b2c3d4e5-...",
  "workspace_id": "ws-a1b2c3...",
  "status": "failed",
  "timestamp": "2026-04-23T10:30:00Z",
  "result": null,
  "error": "Agent exceeded max iterations"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | string | payload schema 版本。需要兼容新旧版本时用它做分支。 |
| `event` | string | `task.success`、`task.failed` 或 `task.cancelled`。 |
| `task_id` | string | 任务 UUID，与 `POST /tasks` 返回的一致。 |
| `workspace_id` | string | 工作区 UUID，在 follow-up 之间保持不变。 |
| `status` | string | `success` \| `failed` \| `cancelled`。跟 `event` 前缀信息冗余，用哪个方便用哪个。 |
| `timestamp` | string | 终态发生时刻的 RFC 3339 UTC 时间戳。 |
| `result` | object? | 仅当 `status == "success"` 时存在。结构与 `GET /tasks/{task_id}` 的 `result` 相同。 |
| `error` | string? | 仅当 `status != "success"` 时存在，人类可读的失败原因。 |

---

## 4. 我们发送的请求头

```
POST /deepdiver/hook HTTP/1.1
Content-Type: application/json
User-Agent: DeepDiver-Webhook/1.0
X-DeepDiver-Event: task.success
X-DeepDiver-Delivery-Id: 3f5a...-每次投递唯一
X-DeepDiver-Schema-Version: 2026-04-23
X-DeepDiver-Signature: sha256=<hmac-hex>
X-Your-Auth: Bearer your-own-token     # 来自 callback_headers 的透传
```

- **`X-DeepDiver-Delivery-Id`**：每一次投递尝试都会生成新的 UUID。接入方建议持久化它用于去重 —— 如果同一个 `delivery_id` 你之前处理过了，就直接跳过。
- **`X-DeepDiver-Signature`**：仅当你传了 `callback_secret` 时才会出现。

---

## 5. 签名校验

如果你传了 `callback_secret`，请验证请求确实来自 DeepDiver。签名算法为：

```
signature = "sha256=" + hex( HMAC-SHA256( callback_secret, 原始请求体字节 ) )
```

**重点**：签名和校验都必须基于**原始请求体字节**，而不是重新序列化后的 JSON。JSON 库会重排键顺序和空白字符，导致 HMAC 不一致。

### 示例（Python / Flask）

```python
import hmac, hashlib

SECRET = b"a-long-random-string-you-generated"

@app.post("/deepdiver/hook")
def hook():
    raw = request.get_data()  # 原始字节 —— 不要用 request.json
    sig = request.headers.get("X-DeepDiver-Signature", "")
    expected = "sha256=" + hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return "bad signature", 401

    payload = json.loads(raw)
    # ... 处理 payload
    return "ok", 200
```

### 示例（Node / Express）

```js
import crypto from "node:crypto";

const SECRET = "a-long-random-string-you-generated";

// 注意：为这条路由挂 express.raw()，让 req.body 是 Buffer
app.post("/deepdiver/hook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.header("X-DeepDiver-Signature") ?? "";
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(req.body).digest("hex");
  const ok = sig.length === expected.length &&
             crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return res.status(401).send("bad signature");

  const payload = JSON.parse(req.body.toString("utf8"));
  // ... 处理 payload
  res.status(200).send("ok");
});
```

务必使用常量时间比较（`hmac.compare_digest` / `crypto.timingSafeEqual`），不要用 `==` / `===`，避免时序攻击。

---

## 6. 如何响应 webhook

- **返回 `2xx`** 的时机：只要你已经可靠地接收了 payload（例如写进队列或数据库），就可以返回成功；不需要等后续处理完。
- **必须在 10 秒内响应**。DeepDiver 默认每次尝试 HTTP 超时是 10s。
- **任何非 2xx 响应或超时都会触发重试。**

### 重试策略

DeepDiver 最多重试 **4 次**，指数退避：第 1/2/3 次重试前分别等待 1s / 2s / 4s（服务端可通过 `HEADLESS_WEBHOOK_MAX_ATTEMPTS` 和 `HEADLESS_WEBHOOK_BACKOFF_BASE` 配置）。

最后一次还失败的话，DeepDiver 会**放弃**并记录日志。**没有跨进程重启的持久重试队列**，这也是为什么我们把轮询作为兜底 —— 如果你们的 webhook 接收端宕机时间超过了重试窗口，请改用 `GET /tasks/{task_id}` 把结果补回。

### 幂等性

重试使用相同的 `task_id`，payload 字节完全一致，**只有 `X-DeepDiver-Delivery-Id` 每次重新生成**。推荐用下面任一方式去重：

- 按 `task_id` + `event` 去重（最简单，每个任务事件至多处理一次）。
- 按 `X-DeepDiver-Delivery-Id` 去重（更严格，每次投递尝试至多处理一次）。

---

## 7. 顺序保证

- 每个任务（成功 / 失败 / 取消）webhook 都恰好触发一次。
- Webhook 触发时刻在**终态事件已写入 SSE 流之后**，也在**内存任务注册表更新之后** —— 所以你的 webhook handler 里立刻回调 `GET /tasks/{task_id}` 也能看到完整的 `result`。
- SSE 的 `done` 事件和 webhook 投递之间**没有顺序保证**，请当作两个独立通道处理。

---

## 8. 端到端示例

```bash
# 1. 带着回调提交一个任务
curl -X POST https://deepdiver.app/api/v1/tasks \
  -H "Authorization: Bearer sk-hdls-..." \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Build a weather dashboard",
    "callback_url": "https://your.server.example.com/hook",
    "callback_secret": "shhh-its-a-secret"
  }'
# => 202 { "task_id": "...", "workspace_id": "...", "resume_token": "..." }

# 2. Agent 在后台执行。60–120s 后你的 /hook 接口会收到：
# POST https://your.server.example.com/hook
# Headers:
#   X-DeepDiver-Event: task.success
#   X-DeepDiver-Delivery-Id: <uuid>
#   X-DeepDiver-Schema-Version: 2026-04-23
#   X-DeepDiver-Signature: sha256=...
# Body:
#   { "version": "2026-04-23", "event": "task.success", "task_id": "...",
#     "status": "success", "result": { "preview_url": "...", ... }, "error": null }

# 3. 校验签名、处理 payload，并在 10s 内返回 200。
```

---

## 9. 代码参考位置

| 组件 | 文件 | 符号 |
|---|---|---|
| Webhook 实现 | `web-demo/backend/utils/webhook.py` | `build_payload`、`deliver`、`validate_callback_url` |
| 请求模型 | `web-demo/backend/routes/headless_api.py` | `TaskSubmitRequest`（`callback_url`、`callback_secret`、`callback_headers`） |
| 派发位置 | `web-demo/backend/routes/headless_api.py` | `_schedule_webhook`（在 `_run_task_in_background` 的 `finally` 块中调用） |

### 服务端环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `HEADLESS_WEBHOOK_TIMEOUT` | `10` | 单次尝试 HTTP 超时（秒）。 |
| `HEADLESS_WEBHOOK_MAX_ATTEMPTS` | `4` | 总尝试次数（含首次）。 |
| `HEADLESS_WEBHOOK_BACKOFF_BASE` | `2` | 退避底数：等待时长 = `base^(attempt-1)` 秒。 |
| `HEADLESS_WEBHOOK_ALLOW_HTTP` | 未设 | 为真时允许 `http://` 回调 URL（仅限开发环境）。 |
| `HEADLESS_WEBHOOK_ALLOW_PRIVATE` | 未设 | 为真时允许解析到私有 / loopback IP 的回调 URL（仅限开发环境）。 |
