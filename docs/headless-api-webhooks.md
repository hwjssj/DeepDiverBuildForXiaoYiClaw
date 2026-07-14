# Headless API — Webhook (Callback) Integration Guide

**Audience**: Backend developers integrating with the DeepDiver Headless API who cannot (or prefer not to) poll `GET /tasks/{task_id}` or hold an SSE connection open. This document covers **only** the webhook callback flow: how to register a callback URL on task submission, what payload DeepDiver POSTs when the task finishes, how to verify the signature, and how to handle retries.

For the full headless API (task submission, SSE, polling, lifecycle) see [headless-api.md](./headless-api.md). This document is scoped to the webhook surface.

---

## 1. When to use webhooks

Webhooks are **opt-in** and **additive**. They do not replace polling or SSE — they are a convenience for callers whose runtime can accept an inbound HTTP request but cannot easily poll long-running tasks.

| Access pattern | Use |
|---|---|
| Long-lived client, real-time UI | SSE (`GET /tasks/{task_id}/stream`) |
| Short-lived script, simple loop | Polling (`GET /tasks/{task_id}`) |
| Server-to-server, no long connections | **Webhook** (this doc) |

If you pass `callback_url`, DeepDiver will POST to it **exactly once** per task, after the task reaches a terminal state. If you do not pass `callback_url`, nothing additional happens — polling and SSE continue to work exactly as before.

---

## 2. Registering a callback

Pass the callback fields when submitting the task:

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

| Field | Type | Required | Description |
|---|---|---|---|
| `callback_url` | string | no | HTTPS URL we will POST to on terminal state. Omit to disable. |
| `callback_secret` | string | no | Shared secret used to HMAC-sign the body. Omit if you don't need to verify authenticity. |
| `callback_headers` | object | no | Extra headers we forward verbatim on the outbound POST (e.g. your own bearer token). Reserved `X-DeepDiver-*` and `Content-Type`/`User-Agent` keys cannot be overridden. |

**URL validation at submit time**:
- Scheme must be `https` (or `http` if `HEADLESS_WEBHOOK_ALLOW_HTTP=1` on the DeepDiver server — dev only).
- Hostname must not resolve to a private, loopback, link-local, reserved, or multicast address in production (override with `HEADLESS_WEBHOOK_ALLOW_PRIVATE=1`).
- Invalid URLs return `400 Bad Request` at submission rather than silently failing at delivery time.

---

## 3. Payload schema — owned by DeepDiver

DeepDiver defines this shape. It is versioned via the top-level `version` field and the `X-DeepDiver-Schema-Version` header. New fields may be added; existing field names and types will not change without a version bump.

**Current version**: `2026-04-23`

### 3.1 Success

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

### 3.2 Failure / cancellation

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

| Field | Type | Description |
|---|---|---|
| `version` | string | Schema version. Branch on this if you care about forward compat. |
| `event` | string | `task.success`, `task.failed`, or `task.cancelled`. |
| `task_id` | string | Task UUID as returned from `POST /tasks`. |
| `workspace_id` | string | Workspace UUID. Stable across follow-ups. |
| `status` | string | `success` \| `failed` \| `cancelled`. Redundant with `event` prefix; use whichever is easier. |
| `timestamp` | string | RFC 3339 UTC timestamp of the terminal transition. |
| `result` | object? | Present only when `status == "success"`. Same shape as the `result` block on `GET /tasks/{task_id}`. |
| `error` | string? | Present when `status != "success"`. Human-readable reason. |

---

## 4. Request headers we send

```
POST /deepdiver/hook HTTP/1.1
Content-Type: application/json
User-Agent: DeepDiver-Webhook/1.0
X-DeepDiver-Event: task.success
X-DeepDiver-Delivery-Id: 3f5a...-unique-per-attempt
X-DeepDiver-Schema-Version: 2026-04-23
X-DeepDiver-Signature: sha256=<hmac-hex>
X-Your-Auth: Bearer your-own-token     # echoed from callback_headers
```

- **`X-DeepDiver-Delivery-Id`** is a fresh UUID per delivery attempt. Persist it on your side to dedupe retries — if you see the same `delivery_id` twice, you already processed it.
- **`X-DeepDiver-Signature`** is only present when you passed `callback_secret`.

---

## 5. Signature verification

If you passed `callback_secret`, verify that the request actually came from DeepDiver. The signature is computed as:

```
signature = "sha256=" + hex( HMAC-SHA256( callback_secret, raw_request_body ) )
```

**Important**: sign and verify over the **raw bytes** of the request body, not a re-serialized JSON. JSON libraries reorder keys and whitespace; HMAC won't match.

### Example (Python / Flask)

```python
import hmac, hashlib

SECRET = b"a-long-random-string-you-generated"

@app.post("/deepdiver/hook")
def hook():
    raw = request.get_data()  # raw bytes — DO NOT use request.json here
    sig = request.headers.get("X-DeepDiver-Signature", "")
    expected = "sha256=" + hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return "bad signature", 401

    payload = json.loads(raw)
    # ... handle payload
    return "ok", 200
```

### Example (Node / Express)

```js
import crypto from "node:crypto";

const SECRET = "a-long-random-string-you-generated";

// NOTE: mount express.raw() for this route so req.body is a Buffer
app.post("/deepdiver/hook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.header("X-DeepDiver-Signature") ?? "";
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(req.body).digest("hex");
  const ok = sig.length === expected.length &&
             crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return res.status(401).send("bad signature");

  const payload = JSON.parse(req.body.toString("utf8"));
  // ... handle payload
  res.status(200).send("ok");
});
```

Use a constant-time comparison (`hmac.compare_digest` / `crypto.timingSafeEqual`) — not `==` / `===` — to avoid timing attacks.

---

## 6. Responding to the webhook

- **Respond with `2xx`** as soon as you've durably accepted the payload (e.g. written to a queue or DB). You do not need to finish processing before responding.
- **Respond within 10 seconds.** DeepDiver's default HTTP timeout per attempt is 10s.
- **Any non-2xx or timeout triggers a retry.**

### Retry policy

DeepDiver retries up to **4 attempts** with exponential backoff: 1s, 2s, 4s between attempts (configurable on the server via `HEADLESS_WEBHOOK_MAX_ATTEMPTS` and `HEADLESS_WEBHOOK_BACKOFF_BASE`).

After the final failed attempt, DeepDiver **gives up** and logs the failure. There is no persistent retry queue across server restarts. **This is why polling remains available** — if your webhook endpoint is down for longer than the retry window, fall back to `GET /tasks/{task_id}` to recover the result.

### Idempotency

Retries reuse the same `task_id` and the payload is byte-identical except for `X-DeepDiver-Delivery-Id`, which is regenerated per attempt. Use one of:

- Dedupe on `task_id` + `event` (simplest; receive-at-most-once per task-event).
- Dedupe on `X-DeepDiver-Delivery-Id` (receive-at-most-once per delivery attempt; more strict).

---

## 7. Ordering guarantees

- Webhook fires exactly once per task (success, failure, or cancellation).
- Webhook fires **after** the terminal event is published to the SSE stream and **after** the in-memory task registry is updated — so if your webhook handler immediately calls back to `GET /tasks/{task_id}`, you will see the fully-populated `result`.
- No ordering is guaranteed between the SSE `done` event and the webhook delivery. Treat them as independent.

---

## 8. End-to-end example

```bash
# 1. Submit a task with a callback
curl -X POST https://deepdiver.app/api/v1/tasks \
  -H "Authorization: Bearer sk-hdls-..." \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Build a weather dashboard",
    "callback_url": "https://your.server.example.com/hook",
    "callback_secret": "shhh-its-a-secret"
  }'
# => 202 { "task_id": "...", "workspace_id": "...", "resume_token": "..." }

# 2. Agent runs in background. 60-120s later your /hook endpoint receives:
# POST https://your.server.example.com/hook
# Headers:
#   X-DeepDiver-Event: task.success
#   X-DeepDiver-Delivery-Id: <uuid>
#   X-DeepDiver-Schema-Version: 2026-04-23
#   X-DeepDiver-Signature: sha256=...
# Body:
#   { "version": "2026-04-23", "event": "task.success", "task_id": "...",
#     "status": "success", "result": { "preview_url": "...", ... }, "error": null }

# 3. Verify signature, process payload, return 200 within 10s.
```

---

## 9. Source-of-truth references

| Component | File | Symbol |
|---|---|---|
| Webhook helper | `web-demo/backend/utils/webhook.py` | `build_payload`, `deliver`, `validate_callback_url` |
| Request model | `web-demo/backend/routes/headless_api.py` | `TaskSubmitRequest` (`callback_url`, `callback_secret`, `callback_headers`) |
| Dispatch site | `web-demo/backend/routes/headless_api.py` | `_schedule_webhook` (called from `_run_task_in_background` `finally` block) |

### Server-side env knobs

| Variable | Default | Purpose |
|---|---|---|
| `HEADLESS_WEBHOOK_TIMEOUT` | `10` | Per-attempt HTTP timeout (seconds). |
| `HEADLESS_WEBHOOK_MAX_ATTEMPTS` | `4` | Total attempts including the first. |
| `HEADLESS_WEBHOOK_BACKOFF_BASE` | `2` | Backoff base: delay = `base^(attempt-1)` seconds. |
| `HEADLESS_WEBHOOK_ALLOW_HTTP` | unset | If truthy, allow `http://` callback URLs (dev only). |
| `HEADLESS_WEBHOOK_ALLOW_PRIVATE` | unset | If truthy, allow callback URLs resolving to private/loopback IPs (dev only). |
