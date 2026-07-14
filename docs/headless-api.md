# DeepDiver Headless API

Stateless REST + SSE interface for programmatic interaction with the DeepDiver agent pipeline. Designed for batch processing, automation, CLI/TUI clients, and third-party integrations.

**Base path**: `/api/v1`

---

## Authentication

All endpoints require a Bearer token in the `Authorization` header:

```
Authorization: Bearer sk-hdls-<32-hex-chars>
```

### Key format

`sk-hdls-{32 hex chars}` (e.g. `sk-hdls-a1b2c3d4e5f6...`). Plaintext is shown **once** at generation time; only the SHA-256 hash is stored.

### Validation order

1. **Environment variable fallback** — `HEADLESS_API_KEYS` (comma-separated plaintext keys). Fast path for dev/testing.
2. **In-memory TTL cache** — validated key hashes are cached for 5 minutes to avoid DB hits.
3. **Database lookup** — query `headless_api_keys` table for active keys. Updates `last_used_at` on success.

### Error codes

| Status | Meaning |
|--------|---------|
| 401 | Missing or invalid API key |
| 503 | Database unavailable and no env-var keys configured |

### Key management

**Via CLI tool** (`web-demo/manage_headless_keys.py`):

```bash
python manage_headless_keys.py generate --name "acme-corp" --user-email ops@acme.com   # create key
python manage_headless_keys.py list                           # list all keys
python manage_headless_keys.py revoke --name "acme-corp"      # revoke by name
python manage_headless_keys.py revoke --id "550e8400-..."     # revoke by ID
```

**Via Web UI** (Account Settings > TUI API Key):

Users can generate/revoke their own headless key from the frontend. Each user is limited to 1 active key. Endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users/me/headless-key` | Get current user's key info |
| POST | `/api/users/me/headless-key` | Generate key (returns raw key once) |
| DELETE | `/api/users/me/headless-key` | Revoke key |

---

## Endpoints

### POST `/api/v1/tasks` — Submit task

Submit a new task or follow-up query. Returns immediately with `202 Accepted`; the agent runs in the background.

**Request body**:

```json
{
  "query": "Create a React counter app",
  "model": null,
  "workspace_id": null,
  "resume_token": null,
  "skip_rewriter": false,
  "interaction_mode": "manual",
  "settings": null
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | *required* | The user query / prompt |
| `model` | string? | `null` | Override model name (uses server config default if null) |
| `workspace_id` | string? | `null` | For follow-ups: links to an existing workspace |
| `resume_token` | string? | `null` | **Required** when `workspace_id` is provided |
| `skip_rewriter` | bool | `false` | Skip the rewriter preprocessing step |
| `interaction_mode` | `"auto"` \| `"manual"` | `"manual"` | How `ask_question` interactions are handled |
| `settings` | object? | `null` | Per-session LLM settings override |
| `screenshot` | bool | `false` | Capture a screenshot of the built preview; the URL is attached as `screenshot_url` on the `build_complete` event and the task `result` |
| `platform` | string? | `null` | Target platform for the generated app (e.g. `"web"`, `"harmonyos"`) |
| `callback_url` | string? | `null` | Webhook URL we POST to on task completion. See [headless-api-webhooks.md](./headless-api-webhooks.md). |
| `callback_secret` | string? | `null` | Shared secret used to HMAC-sign the webhook body. |
| `callback_headers` | object? | `null` | Extra headers we forward on the outbound webhook POST. |

**Response** (`202`):

```json
{
  "task_id": "uuid",
  "workspace_id": "uuid",
  "resume_token": "string or null",
  "status": "running"
}
```

- `resume_token` is returned only for **new** sessions (not follow-ups). Save it for follow-up queries.

**Errors**:

| Status | Condition |
|--------|-----------|
| 400 | `workspace_id` provided without `resume_token`, or `callback_url` failed validation |
| 409 | Workspace already has an active (incomplete) task |
| 502 | MCP connection / session creation failure |

---

### GET `/api/v1/tasks/{task_id}` — Poll status

Returns current task state, all events, and result (if completed).

**Response**:

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

**Status values**: `running`, `paused`, `waiting_interaction`, `completed`, `failed`, `cancelled`

**`result`** (only when `status == "completed"`):

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

- `screenshot_url` (string?) is only present when the task was submitted with `screenshot: true` and the capture succeeded.

**`interaction`** (only when `status == "waiting_interaction"`): contains the pending `ask_question` payload.

---

### GET `/api/v1/tasks/{task_id}?format=batch_v2` — Full-fidelity trajectory (batch_runner format)

Returns the task's **complete, untruncated** trajectory as v2.0.0 training records — byte-for-byte the same envelope `cli/batch_runner.py` writes to `batch_results/`. Use this to collect SFT / analysis data from headless runs.

This is a different response body from the default poll (which returns the truncated event stream). The records are sourced from the persisted execution trace (`execution_traces` table), **not** the in-memory event history, so:

- **No truncation.** The event stream caps tool results at 5,000 chars and tool arguments at 500 chars for display; `batch_v2` returns the full content the agent actually produced.
- **Bounded memory.** The heavy trajectory is streamed from Postgres per request and released after; it is never pinned in RAM (the in-memory copy is freed once the task completes).

**Availability**: only after the task reaches a terminal state (`completed` / `failed` / `cancelled`) *and* the database is enabled. A `409` is returned while the task is still running.

**Query parameters** — all optional; they stamp `meta_info` and default to `cli/batch_runner.py`'s values so output is indistinguishable from a batch run:

| Param | Default | Description |
|-------|---------|-------------|
| `format` | — | Must be `batch_v2` to select this response. Any other value → `400`. |
| `owner` | `00971756` | `meta_info.owner` |
| `query_source` | `synthesized` | `meta_info.query_source` |
| `category` | `deep_diver` | `meta_info.category` |
| `language` | `English` | `meta_info.language` (see caveat below) |

**Response** (`200`):

```json
{
  "task_id": "uuid",
  "workspace_id": "uuid",
  "session_id": "uuid",
  "turns": [1],
  "counts": {"rewriter": 1, "ddt_agents": 1, "subagents": 3},
  "rewriter":   [ /* v2.0.0 record */ ],
  "ddt_agents": [ /* one v2.0.0 record per DDT + handoff agent */ ],
  "subagents":  [ /* one v2.0.0 record per sub-agent */ ]
}
```

The three arrays map exactly onto the per-query files a batch run writes — append each array element as one line (`json.dumps(rec, ensure_ascii=False)`):

| Array | batch_runner file | Contents |
|-------|-------------------|----------|
| `rewriter` | `query_NNN_rewriter.jsonl` | The rewriter turn (present unless `skip_rewriter: true`) |
| `ddt_agents` | `query_NNN_ddt_agents.jsonl` | The main DDT agent, then any handoff-chain agents |
| `subagents` | `query_NNN_subagents.jsonl` | Every `delegate_task` sub-agent |

Each element is a **v2.0.0 record**:

```json
{
  "version": "2.0.0",
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "", "reasoning_content": "...",
     "tool_calls": [{"id": "...", "type": "function", "function": {"name": "...", "arguments": "..."}}]},
    {"role": "tool", "tool_call_id": "...", "content": "..."}
  ],
  "tools": [ /* OpenAI tool schemas */ ],
  "meta_info": {
    "teacher": "92B-B007-stage2-12000-ddexp",
    "response_generate_time": "2026-07-06",
    "response_update_time": "2026-07-06",
    "query_source": "synthesized",
    "owner": "00971756",
    "language": "English",
    "category": "deep_diver",
    "rounds": 53,
    "unique_info": {}
  }
}
```

- `messages` is OpenAI-shaped with `reasoning_content` preserved on assistant turns. Provider-only bookkeeping is stripped identically to batch_runner (`name` on `tool` messages, `_thinking_blocks` on assistant messages, `extra_content` on tool_calls).
- `teacher` is derived from the run's model; `rounds` is the assistant-turn count.

**Errors**:

| Status | Condition |
|--------|-----------|
| 400 | `format` is present but not `batch_v2` |
| 404 | Task unknown/expired, or no execution trace was saved for it |
| 409 | Task has not finished yet — retry after it reaches a terminal state |
| 503 | Database unavailable (the trace store is required for this format) |

> **Language caveat.** `execution_traces` does not persist the per-turn detected language, so `meta_info.language` is stamped from the `language` query param (default `English`) rather than reconstructed. For non-English runs, pass `?language=…` to match. Every other field reconstructs exactly.

---

### GET `/api/v1/tasks/{task_id}/stream` — SSE event stream

Real-time Server-Sent Events stream. Supports late-connecting clients by replaying all historical events before switching to live streaming.

**SSE event format**:

```
event: agent
data: {"seq": 1, "type": "thinking", "data": {...}, "timestamp": 1234567890.123}

event: done
data: {"success": true, ...}

event: ping
data: {}
```

**SSE event types**: `status`, `agent`, `done`, `ping`

**Agent event types** (within `event: agent`):

| Type | Description |
|------|-------------|
| `start` | Task started |
| `iteration` | Loop iteration with token counts (`iteration`, `token_count`, `token_threshold`) |
| `thinking` | Reasoning/thinking output |
| `tool_call` | Tool execution (with `tool`, `arguments`, `result`, `status`) |
| `error` | Execution error |
| `complete` | Agent finished (`success: bool`). Terminal if `success == false` |
| `build_complete` | Static preview build finished. Terminal event for successful tasks |
| `agent_handoff` | Pipeline handoff between agents |
| `paused` / `resumed` | Execution control state changes |
| `interaction_required` | Waiting for user response to `ask_question` |
| `cancelled` | Task cancelled by user |
| `subagent_start` / `subagent_complete` / `subagent_event` | Sub-agent lifecycle events |
| `streaming` | Incremental reasoning/content tokens (`text`, `type`, `done`) |

**Terminal events** (stream closes after these):
- `build_complete` — successful completion with build status
- `error` — fatal error
- `cancelled` — user-initiated cancellation
- `complete` with `success == false` — failed completion (no build follows)

**Keep-alive**: `ping` events every 15 seconds when no other events are flowing.

**Event metadata**: All agent events include `source_agent_name` and `source_agent_type` (`"rewriter"`, `"ddt_agent"`, `"subagent"`, `"unknown"`).

---

### POST `/api/v1/tasks/{task_id}/respond` — Answer interaction

Unblocks the agent when it's waiting for a response to `ask_question`.

**Request body**:

```json
{
  "interaction_id": "uuid",
  "response": {"answer": "Yes, proceed with TypeScript"}
}
```

**Response**: `{"status": "running"}`

**Errors**: `409` if task is not in `waiting_interaction` state.

---

### POST `/api/v1/tasks/{task_id}/cancel` — Cancel task

**Response**: `{"status": "cancelling"}`

**Errors**: `409` if task is not currently running.

---

### POST `/api/v1/tasks/{task_id}/pause` — Pause task

Pauses execution at the next iteration boundary.

**Response**: `{"status": "paused"}`

While paused, `GET /api/v1/tasks/{task_id}` reports `status: "paused"` until the task is resumed.

**Errors**: `409` if task is not currently running.

---

### POST `/api/v1/tasks/{task_id}/resume` — Resume task

Resumes a paused task.

**Response**: `{"status": "running"}`

**Errors**: `409` if task is not currently running.

---

### POST `/api/v1/tasks/{task_id}/message` — Inject a user message

Appends a user message to the running task's conversation. It is picked up at the next iteration boundary; if the task is paused, this also resumes it.

**Request**:
| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | string | yes | Text to inject into the conversation |

**Response**: `{"status": "message_queued"}`

**Errors**: `409` if task is not currently running.

---

## Sharing the app with other users

Once a project's app is built and reachable at `/preview/{workspace_id}/`, the headless API can mint up to **15 viewer links** per project so other people can use the app without a DeepDiver account. Each viewer gets a stable identity (`vwr_<hex>`) that the workspace's RLS policies see as `auth.uid()` — so an owner-scoped app (e.g. private cloud drive) gives each viewer their own isolated data, while a shared-read app (e.g. team chat) shares state across all viewers.

Viewer links are distinct from **share links** (`db.share.create()`), which are minted *inside* the running app to hand out one specific resource (a single file download, etc.). Share links are not exposed via the headless API — the agent's app code calls them directly via the SDK.

> **DB-backed key required.** All three endpoints below reject env-var-only API keys (`HEADLESS_API_KEYS=...`) with `400` — those keys are anonymous and have no `user_id` to attribute the link to.

### POST `/api/v1/projects/viewer-links` — Mint a link

```bash
curl -X POST https://api.example.com/api/v1/projects/viewer-links \
  -H "Authorization: Bearer sk-hdls-..." \
  -H "Content-Type: application/json" \
  -d '{"workspace_id": "ws_abc123", "label": "alice@example.com"}'
```

**Request**:
| Field | Type | Required | Notes |
|---|---|---|---|
| `workspace_id` | string | yes | From the project-creation response |
| `label` | string | no | Free-form, ≤100 chars. For your own bookkeeping (the API doesn't dedupe on it) |

**Response `201`**:
```json
{
  "viewer_id":     "vwr_a1b2c3d4e5f6",
  "viewer_token":  "Wk9...long_random_string...",
  "preview_url":   "/preview/ws_abc123/?viewer=Wk9...",
  "label":         "alice@example.com"
}
```

The plaintext `viewer_token` is **only ever returned by this call** (GitHub-PAT semantics) — store it now or you can't retrieve it later. Prepend your deployment origin to `preview_url` and hand it to the recipient. No idempotency: every call mints a fresh token; deduplicate on your side via `label`.

**Errors**:
| Code | When |
|---|---|
| `400` | env-var-only key, or project already has 15 active links |
| `404` | `workspace_id` doesn't match any project owned by this key |

### GET `/api/v1/projects/viewer-links?workspace_id=...` — List links

```bash
curl "https://api.example.com/api/v1/projects/viewer-links?workspace_id=ws_abc123" \
  -H "Authorization: Bearer sk-hdls-..."
```

**Response `200`** (token-redacted, safe to log):
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

Returns active **and** revoked links (sorted newest first). `active_count` only counts `is_active: true`. The `viewer_token` is never re-exposed — if a recipient loses their URL, revoke and re-create.

### DELETE `/api/v1/projects/viewer-links/{link_id}?workspace_id=...` — Revoke

```bash
curl -X DELETE \
  "https://api.example.com/api/v1/projects/viewer-links/f1e2d3c4-...?workspace_id=ws_abc123" \
  -H "Authorization: Bearer sk-hdls-..."
```

**Response `204`** (no body). Soft-revoke: sets `is_active = false`, preserves analytics. Idempotent — revoking an already-revoked link still returns `204`. Frees a slot against the 15-link cap immediately. The `viewer_token` is rejected at preview time from this point on.

**Errors**:
| Code | When |
|---|---|
| `400` | `link_id` is not a UUID, or env-var-only key |
| `404` | no link with that ID under the given workspace, or workspace not owned by this key |

---

## Interaction modes

### Manual (default)

The agent blocks on `ask_question` calls. The task enters `waiting_interaction` status. Clients must call `POST /tasks/{task_id}/respond` to unblock.

### Auto

Responses are sent automatically: `{"auto": true, "message": "Proceed with your best judgment"}`. A 300ms delay is applied after the `interaction_required` event to allow the agent to reach its wait loop.

---

## Follow-up queries

To continue a conversation in an existing workspace:

1. Submit a new task with the same `workspace_id` + `resume_token` from the original response.
2. The API checks for concurrent tasks on the workspace (returns `409` if one is active).
3. If the session is still in memory, it's reused directly. Otherwise, it's resumed via MCP using the resume token.
4. Before executing, the static preview marker is cleared (`POST /api/preview/clear-static`) to transition back from nginx static serving to Vite dev server.

---

## Build status tracking

After successful task completion, the API polls the MCP server to check if the static build has finished:

1. Polls `GET /api/preview/status` up to **45 times** with **2-second intervals** (~90s max wait).
2. Waits until `mode == "static"` (nginx serving the built `dist/` directory).
3. Fetches `TODO_AGENT_1.md` to extract the project name.
4. Emits `build_complete` event with build status, preview URL, and project name.

The `_is_executing` flag remains `true` until `build_complete` is emitted, so SSE streams and polling don't see `"completed"` prematurely.

### Project-name extraction spec

The project name is derived from the **first line** of `TODO_AGENT_1.md`. This is the
single source of truth for two parsers that must stay in lockstep:

- Backend: `_extract_project_name` in `web-demo/backend/routes/headless_api.py`
- Frontend: `extractProjectName` in `web-demo/frontend/src/hooks/useWorkspaceSync.ts`

Rules (applied to the trimmed first line only):

1. If it does not start with `#`, there is no name (`null`).
2. **Old format** — `# TODO: <name> - Agent 1 (Content)`: matches `^#\s*TODO:`
   (case-insensitive); the name is everything after `TODO:`, trimmed.
3. **New format** — `# <Project Title>`: starts with `# ` and is **not** a
   `# TODO_AGENT...` track header (`^#\s*TODO_AGENT`, case-insensitive); the name is
   the text after `# `, trimmed.
4. An empty result in any case yields `null`.

If the agent's `TODO_AGENT_1.md` format changes, update this spec **and** both parsers.

---

## Task lifecycle

```
submit → running → [waiting_interaction → respond → running] → completed
                 → [paused → resumed → running]
                 → cancelled
                 → failed
```

### In-memory tracking

| Registry | Key → Value | Purpose |
|----------|-------------|---------|
| `_task_registry` | `task_id → {workspace_id, resume_token, created_at, completed_at, query, is_followup, screenshot, callback_url, callback_secret, callback_headers}` | Task metadata |
| `_workspace_active_task` | `workspace_id → task_id` | Prevents concurrent tasks |
| `_task_to_session` | `task_id → session_id` | Task → session lookup |

### Cleanup

A background loop runs every **5 minutes**, removing completed tasks older than `COMPLETED_TASK_TTL` (default: 30 min, configurable via env var `HEADLESS_COMPLETED_TASK_TTL`).

---

## Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `HEADLESS_API_KEYS` | `""` | Comma-separated plaintext API keys (dev/testing fallback) |
| `HEADLESS_COMPLETED_TASK_TTL` | `1800` | Seconds to keep completed tasks in memory |
| `HEADLESS_MAX_WORKERS` | `10` | Thread pool size for agent execution |

---

## CLI binary distribution

Pre-built binaries are served from `/cli/` via nginx:

| Binary | Platform |
|--------|----------|
| `deepdiver-linux-x64` | Linux x86_64 |
| `deepdiver-darwin-x64` | macOS Intel |
| `deepdiver-darwin-arm64` | macOS Apple Silicon |

### Install

```bash
curl -fsSL https://deepdiver.app/install.sh | bash
```

The installer auto-detects platform/architecture, downloads the correct binary to `~/.local/bin/deepdiver`, and suggests PATH configuration if needed.

### Usage

```bash
export DEEPDIVER_API_KEY=sk-hdls-...
deepdiver
```

---

## Database schema

### `headless_api_keys`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `name` | VARCHAR(100) | Descriptive name |
| `key_hash` | VARCHAR(64) | SHA-256 hash, unique index |
| `key_prefix` | VARCHAR(20) | First 12 chars + `"..."` for display |
| `is_active` | BOOLEAN | Soft-revoke without deletion |
| `user_id` | UUID? | FK → `users.id` (ON DELETE SET NULL). Nullable for admin-created keys |
| `created_at` | DATETIME | Indexed |
| `last_used_at` | DATETIME? | Updated on each successful auth |

---

## Consuming the SSE stream (client implementation guide)

This section describes how to correctly parse and process events from the `/tasks/{task_id}/stream` endpoint. The reference implementation is the DeepDiver TUI (`tui/src/`).

### Connecting to the stream

```
GET /api/v1/tasks/{task_id}/stream
Authorization: Bearer sk-hdls-...
Accept: text/event-stream
Cache-Control: no-cache
```

The response is a standard SSE stream. Parse it line by line:

```
event: <event_type>     ← "agent", "done", "ping", or "status"
data: <json_payload>    ← JSON object
                        ← empty line marks end of message
```

Only process `event: agent` and `event: done`. Ignore `event: ping` (keep-alive) and `event: status` (initial handshake).

When `event: done` is received, close the stream — the task is finished.

### Event envelope

Every `event: agent` payload has a uniform envelope:

```json
{
  "seq": 1,
  "type": "thinking",
  "data": { ... },
  "timestamp": 1711411200.123
}
```

| Field | Type | Description |
|-------|------|-------------|
| `seq` | int | Monotonically increasing sequence number |
| `type` | string | One of the event types below |
| `data` | object | Event-specific payload (varies by type) |
| `timestamp` | float | Unix timestamp in seconds |

### Event type reference

Below is the full schema for each event type's `data` payload, along with processing guidance.

---

#### `start`

Emitted once at the beginning.

```json
{
  "query": "Create a React counter app",
  "is_followup": false,
  "session_id": "ws-456",
  "run_id": "run-789",
  "task_id": "abc-123"
}
```

Use this to confirm the task has been accepted and to record the `run_id`.

---

#### `iteration`

Emitted at each agent loop iteration. Use to track progress.

```json
{
  "iteration": 3,
  "token_count": 45000,
  "token_threshold": 200000,
  "source_agent_name": "DDT Agent",
  "source_agent_type": "ddt_agent"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `iteration` | int | Current iteration number (may be 0; auto-increment if so) |
| `token_count` | int | Tokens consumed so far |
| `token_threshold` | int | Token budget limit |
| `source_agent_name` | string | Name of the active agent |
| `source_agent_type` | string | `"rewriter"`, `"ddt_agent"`, `"subagent"`, or `"unknown"` |

**Fallback field names**: The backend may use alternative names — accept `iter` / `iteration_number` for iteration, `tokens` / `token_usage` / `tokenCount` for token_count, `token_limit` / `max_tokens` for token_threshold.

**Processing tip**: If you receive an `iteration` event while in `waiting_interaction` state, it means the agent has resumed — clear the pending interaction.

---

#### `thinking`

Reasoning/chain-of-thought output from the agent.

```json
{
  "content": "Let me analyze the requirements...",
  "source_agent_name": "DDT Agent",
  "source_agent_type": "ddt_agent"
}
```

**Deduplication**: The same reasoning text may appear in both `thinking` events and `streaming` events. Check for duplicates before displaying.

---

#### `streaming`

Real-time LLM token output (incremental text chunks).

```json
{
  "text": "I'll create a ",
  "type": "content"
}
```

| `type` value | Meaning |
|-------------|---------|
| `"content"` | Regular output text — append to content buffer |
| `"reasoning"` | Reasoning text — append to reasoning buffer |
| `"done"` | Stream flush signal — finalize both buffers as message parts |

**Processing**: Accumulate text in a buffer. Flush the buffer when you receive `type: "done"`, or when a `tool_call` (pending) event arrives. Deduplicate against existing message content when flushing.

---

#### `tool_call`

Tool execution events. Sent **twice** per tool: once with `status: "pending"` (before execution) and once with a completion status (after execution).

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

**After execution**:

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

| Field | Type | Description |
|-------|------|-------------|
| `tool` | string | Tool name (see tool list below) |
| `status` | string | `"pending"`, `"Success"`, `"Failure"`, or other |
| `arguments` | object | Tool input parameters (values truncated to 500 chars, except `final_answer`) |
| `result` | string? | Tool output (truncated to 5000 chars) |
| `source_agent_type` | string | Which agent called the tool |

**Processing**:
1. On `status: "pending"`: flush any streaming buffer, then add a "pending" tool entry.
2. On completion: find the matching pending entry (by tool name) and update it in place. If no pending entry exists, add as new.

**Special tools**:

- **`think` / `reflect`**: Internal reasoning — treat as a `thinking` event instead. Extract `arguments.thought`.
- **`task_done`**: The agent's final answer. Only process when `status !== "pending"` (avoids duplicate). Check `source_agent_type`:
  - `"rewriter"` → rewriter finished. `arguments.final_answer` contains the refined query.
  - `"ddt_agent"` → main agent completed. `arguments.final_answer` is the answer to display.
- **`delegate_task`** (with `arguments.mode === "subtask"`): The agent is spawning sub-agents. `arguments.what_needs_to_be_done` contains the task list (array, JSON string, or plain string). `arguments.run_async` indicates parallel execution. Create placeholder UI groups for the sub-agents.
- **`ask_question`**: The agent is asking the user a question. `arguments` contains the questions. (This is the tool call itself; the `interaction_required` event is what signals the agent is blocked.)

**File operation metadata** (for `file_edit`, `file_write`, `file_insert`, `file_delete`):

The `data` may include a `file_operation` object:

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

**Common tool names**: `plan_next_steps`, `bash` / `shell_exec` / `shell_exec_background`, `file_read`, `file_write` / `create_file`, `file_edit`, `file_insert`, `file_delete`, `glob` / `file_find_by_name`, `grep`, `list_directory` / `list_workspace`, `batch_web_search` / `web_search`, `web_fetch` / `extract_content`, `vite_init`, `start_dev_server`, `dev_server_status`, `delegate_task`, `ask_question`, `subagent_done`, `task_done`.

---

#### `interaction_required`

The agent is blocked waiting for user input.

```json
{
  "interaction_id": "int-001",
  "type": "ask_question",
  "questions": [
    {
      "id": "q1",
      "prompt": "Which CSS framework would you like?",
      "options": ["Tailwind", "Bootstrap", "None"],
      "allow_multiple": false
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `interaction_id` | string | Required when calling `/respond` |
| `type` | string | Interaction type (e.g. `"ask_question"`) |
| `questions` | array | List of questions with `id`, `prompt`, optional `options` and `allow_multiple` |

**Processing**: Set task status to `waiting_interaction`. Display the questions to the user. After they answer, call `POST /tasks/{task_id}/respond` with `interaction_id` and the response object.

---

#### `agent_handoff`

The pipeline is handing off from one agent to another (e.g. rewriter → main agent).

```json
{
  "previous_iterations": 3,
  "new_agent_id": "ddt-agent-001"
}
```

---

#### `subagent_start`

A sub-agent has been spawned (from `delegate_task`).

```json
{
  "agent_id": "sub-001",
  "is_async": true,
  "task": "Implement the API endpoints",
  "description": "Implement the API endpoints"
}
```

**Processing**: If you pre-created placeholder groups from `delegate_task`, claim the first unclaimed placeholder by updating its `agent_id`. Otherwise, create a new sub-agent group.

---

#### `subagent_complete`

A sub-agent has finished.

```json
{
  "agent_id": "sub-001",
  "success": true,
  "iterations_used": 4,
  "result_length": 1523
}
```

**Processing**: Find the sub-agent group by `agent_id` and update its status to `"done"` or `"failed"`.

---

#### `subagent_event`

A tool call event from within a sub-agent.

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

**Processing**: Find the sub-agent group by `agent_id` and append the tool to its tools list. Deduplicate: if a pending tool with the same name exists, update it in place instead of adding a new entry.

---

#### `complete`

The agent pipeline has finished. This is **not** a terminal event for successful tasks — `build_complete` follows.

```json
{
  "success": true,
  "iterations": 8,
  "execution_time": 65.2,
  "final_answer": "I've created a React counter app with...",
  "key_files": [
    {"file_path": "src/App.tsx", "desc": "Main component", "is_final_output_file": true}
  ],
  "preview_url": "https://deepdiver.app/preview/ws-456/?token=rt-789",
  "session_id": "ws-456",
  "run_id": "run-789"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `success` | bool | Whether the agent succeeded |
| `iterations` | int | Total iterations used |
| `execution_time` | float | Seconds elapsed |
| `final_answer` | string? | The agent's answer (may be absent if `task_done` tool already provided it) |
| `key_files` | array? | Important files with paths, descriptions, and output flags |
| `preview_url` | string? | Durable preview URL |
| `error` | string? | Error message (when `success == false`) |

**Processing**:
- If `success == false`: this is a terminal event. Set status to `"failed"`.
- If `success == true`: set status to `"completed"` but keep listening — `build_complete` will follow.
- If `task_done` tool already provided the final answer, skip `final_answer` from this event to avoid duplicate display.
- Clear any streaming buffer (the `final_answer` is the authoritative version).

---

#### `build_complete`

Static preview build has finished. **Terminal event** for successful tasks.

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

| Field | Type | Description |
|-------|------|-------------|
| `success` | bool | Whether the build succeeded |
| `mode` | string | `"static"` if build succeeded |
| `preview_url` | string | Durable preview URL |
| `project_name` | string? | Extracted from `TODO_AGENT_1.md` |
| `screenshot_url` | string? | Preview screenshot URL (only when the task was submitted with `screenshot: true` and capture succeeded) |
| `error` | string? | Build error message (when `success == false`) |

**Processing**: Store `preview_url` and `project_name`. Close the stream.

---

#### `error`

Fatal execution error.

```json
{
  "message": "MCP connection lost",
  "session_id": "ws-456"
}
```

**Processing**: Set status to `"failed"`. Display the error message.

---

#### `cancelled`

Task was cancelled by user.

```json
{}
```

**Processing**: Set status to `"cancelled"`.

---

#### `paused` / `resumed`

Execution state change.

```json
{}
```

**Processing**: Toggle paused flag.

---

### Typical event sequence

A successful task produces events in this order:

```
start
  → iteration (rewriter)
  → thinking (rewriter reasoning)
  → tool_call (rewriter tools)
  → tool_call: task_done (source_agent_type: "rewriter")
  → agent_handoff
  → iteration (DDT agent)
  → thinking (DDT agent reasoning)
  → tool_call (file_write, bash, etc.)
  → ...
  → [delegate_task → subagent_start × N → subagent_event × M → subagent_complete × N]
  → tool_call: task_done (source_agent_type: "ddt_agent")
  → complete (success: true)
  → build_complete ← terminal, close stream
```

A failed task:

```
start → iteration → ... → complete (success: false) ← terminal
```

Or:

```
start → iteration → ... → error ← terminal
```

### Key implementation patterns

**1. Deduplication**: The same content can arrive via `thinking`, `streaming`, and `tool_call` (task_done). Always check for duplicates before rendering.

**2. Pending → completed tool transition**: Tool calls arrive twice (pending, then completed). Match by tool name and update in place.

**3. task_done vs complete**: The `task_done` tool call contains the `final_answer` before the `complete` event. If you already rendered `task_done`, skip the `final_answer` from `complete` to avoid showing it twice.

**4. Sub-agent placeholder claiming**: `delegate_task` pre-announces sub-agents before they actually start. Create placeholder groups, then when `subagent_start` arrives, claim the first unclaimed placeholder.

**5. Stream buffer management**: Accumulate `streaming` text in a buffer. Flush when: a pending `tool_call` arrives, a `streaming` `"done"` event arrives, or a `complete` event arrives.

---

## Usage examples

### New task with auto-interaction

```bash
# Submit
curl -s -X POST https://deepdiver.app/api/v1/tasks \
  -H "Authorization: Bearer sk-hdls-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "Create a React counter app", "interaction_mode": "auto"}' \
  | jq .

# Response:
# {"task_id": "abc-123", "workspace_id": "ws-456", "resume_token": "rt-789", "status": "running"}
```

### Stream events

```bash
curl -N https://deepdiver.app/api/v1/tasks/abc-123/stream \
  -H "Authorization: Bearer sk-hdls-YOUR_KEY"
```

### Poll status

```bash
curl -s https://deepdiver.app/api/v1/tasks/abc-123 \
  -H "Authorization: Bearer sk-hdls-YOUR_KEY" | jq .status
```

### Follow-up query

```bash
curl -s -X POST https://deepdiver.app/api/v1/tasks \
  -H "Authorization: Bearer sk-hdls-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Add a reset button",
    "workspace_id": "ws-456",
    "resume_token": "rt-789"
  }'
```

### Respond to interaction (manual mode)

```bash
curl -s -X POST https://deepdiver.app/api/v1/tasks/abc-123/respond \
  -H "Authorization: Bearer sk-hdls-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"interaction_id": "int-001", "response": {"answer": "Use TypeScript"}}'
```

### Cancel a running task

```bash
curl -s -X POST https://deepdiver.app/api/v1/tasks/abc-123/cancel \
  -H "Authorization: Bearer sk-hdls-YOUR_KEY"
```
