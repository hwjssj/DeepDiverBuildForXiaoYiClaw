# Headless API — `ask_question` Tool Integration Guide

**Audience**: Frontend developers and UI designers building an interface on top of the DeepDiver Headless API. This document covers **only** the `ask_question` (user question) flow — how the agent asks the user a question mid-run, how the UI should render it, and how the answer is returned to unblock the agent.

For the full headless API (task submission, SSE, polling, lifecycle) see `docs/headless-api.md`. This document is scoped to the interaction surface and is grounded in the actual code references below.

---

## 1. What `ask_question` is

`ask_question` is an agent tool on the server that lets the agent pause execution and ask the user 1–3 clarifying questions before proceeding. When the agent invokes it:

1. The tool returns an `interaction_required=True` envelope instead of a normal tool result.
2. The base agent sees that envelope, emits an `interaction_required` event, and **blocks** on a condition variable waiting for an answer.
3. The session state transitions to `waiting_interaction`.
4. The frontend receives the event via SSE (or via polling), renders the question UI, collects the answer, and `POST`s it to `/tasks/{task_id}/respond`.
5. The agent's blocked call returns with the answer; the answer becomes the tool result for that call and the agent continues.

Source-of-truth references:

| Component | File | Symbol |
|---|---|---|
| Tool definition | `deepdiver-server-nginx-preview/src/tools/mcp/interaction.py:19` | `InteractionTools.ask_question` |
| Agent interaction loop | `src/agents/base_agent.py:1128` | interaction dispatch block |
| Agent wait-for-response | `src/agents/base_agent.py:912` | `_wait_for_interaction_response` |
| Agent submit-response | `src/agents/base_agent.py:873` | `submit_interaction_response` |
| HTTP route models | `web-demo/backend/routes/headless_api.py:172` | `TaskSubmitRequest`, `InteractionResponse`, `TaskStatusResponse` |
| `POST /respond` endpoint | `web-demo/backend/routes/headless_api.py:986` | `respond_to_interaction` |
| `GET /tasks/{id}` endpoint | `web-demo/backend/routes/headless_api.py:859` | `get_task_status` |
| SSE stream endpoint | `web-demo/backend/routes/headless_api.py:889` | `task_stream` |
| Session state transitions | `web-demo/backend/sessions/session.py:108` | `set_waiting_interaction`, `clear_pending_interaction` |
| Auto-interaction callback | `web-demo/backend/routes/headless_api.py:455` | `_auto_interaction_callback` |
| TS event types | `tui/src/api/types.ts:73` | `InteractionData`, `SSEEventType` |
| TUI SSE handler | `tui/src/context/sync.tsx:383` | `interaction_required` case |
| TUI state clearing | `tui/src/context/sync.tsx:122` + `:172` | `clearInteraction`, iteration auto-clear |
| TUI respond/dismiss | `tui/src/app.tsx:255` | `handleInteractionRespond`, `handleInteractionDismiss` |
| TUI dialog component | `tui/src/component/dialog-question.tsx:12` | `QuestionPrompt` |
| TUI respond client | `tui/src/api/client.ts:34` | `respond()` |
| Web-demo WS handler | `web-demo/frontend/src/hooks/useWebSocket.ts:1104` | `interaction_required` case (WebSocket, **not** headless API) |
| Web-demo answer hook | `web-demo/frontend/src/hooks/useInteractionAnswer.ts:25` | `submitAnswer` |
| Web-demo options UI | `web-demo/frontend/src/components/shared/InteractionOptionsPanel.tsx:20` | `InteractionOptionsPanel` |

---

## 2. The question payload — exact schema

### 2.1 What the tool returns on the server

Defined verbatim in `interaction.py:47-54`:

```python
{
  "success": True,
  "interaction_required": True,
  "interaction": {
    "type": "ask_question",
    "questions": questions   # the list the agent passed in, trimmed to ≤3
  }
}
```

Each question object (`interaction.py:28-33`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Unique per question. Used as the key when returning answers. |
| `prompt` | string | yes | The question text to display. |
| `options` | string \| string[] | no | Multiple-choice options. Server-side the tool contract says "comma-separated string", but the TUI accepts **both** comma-separated strings and arrays (`tui/src/component/dialog-question.tsx:36-42`). Frontends should accept both shapes. |
| `allow_multiple` | boolean \| `"true"` \| `"false"` | no | If truthy the user may pick more than one option. Both the boolean and the string `"true"` must be treated as enabled (`dialog-question.tsx:31-34`). |

Notes:
- The agent may call `ask_question` with **1 to 3** questions. Four or more are silently trimmed to the first three on the server (`interaction.py:41-43`).
- If an empty/invalid list is passed, the tool returns `{"success": False, "error": "..."}` and the interaction flow is **not** triggered — you will not receive an `interaction_required` event in that case.

### 2.2 What the frontend actually receives

Before the event leaves the agent, the base agent enriches the payload with two fields (`base_agent.py:1131-1133`):

```python
interaction_id = interaction_payload.get("interaction_id") or f"interaction-{uuid.uuid4()}"
interaction_payload["interaction_id"] = interaction_id
interaction_payload["tool"] = tool_name
```

So the event `data` object you receive on the wire always has this shape:

```json
{
  "interaction_id": "interaction-9f5e3b2a-...",
  "type": "ask_question",
  "tool": "ask_question",
  "questions": [
    {
      "id": "q1",
      "prompt": "Which CSS framework would you like?",
      "options": ["Tailwind", "Bootstrap", "None"],
      "allow_multiple": false
    },
    {
      "id": "q2",
      "prompt": "Which pages do you need?",
      "options": "Home,About,Contact",
      "allow_multiple": true
    }
  ]
}
```

The matching TypeScript type (`tui/src/api/types.ts:73-82`):

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

Treat `interaction_id` as an **opaque string** — always echo it back unchanged in the response.

---

## 3. How the question reaches the frontend

There are two delivery channels. A frontend should pick **one** — mixing them is unnecessary.

### 3.1 SSE stream (recommended)

Endpoint: `GET /api/v1/tasks/{task_id}/stream`
Auth: `Authorization: Bearer <api_key>`

Server-Sent Events are framed per `headless_api.py:895`:

```
event: <event_name>
data: <json>
\n
```

Three `event:` names you will see:

| `event:` name | Meaning |
|---|---|
| `status` | First frame. Initial task state snapshot. |
| `agent` | Every agent event (start, iteration, tool_call, **interaction_required**, complete, etc.). |
| `done` | Terminal frame. Stream closes immediately after. |
| `ping` | Keep-alive every ~15s while idle. Ignore. |

Every `agent` frame has this JSON shape (see `headless_api.py:922-928`):

```json
{
  "seq": 42,
  "type": "interaction_required",
  "data": { /* the InteractionData blob from §2.2 */ },
  "timestamp": 1744300000.123
}
```

So the full frame on the wire for a question looks like:

```
event: agent
data: {"seq":42,"type":"interaction_required","data":{"interaction_id":"interaction-9f5e...","type":"ask_question","tool":"ask_question","questions":[{"id":"q1","prompt":"Which CSS framework would you like?","options":["Tailwind","Bootstrap","None"],"allow_multiple":false}]},"timestamp":1744300000.123}

```

The full set of SSE `type` values is enumerated in `tui/src/api/types.ts:25-39`. For the question flow you only need to care about:

- `interaction_required` — a question arrived; render the UI, pause further "agent is working" affordances.
- `iteration` / `tool_call` / `thinking` / `streaming` / `complete` / `cancelled` / `error` — resume normal rendering once a response has been submitted.

**Late-join / replay.** If the client connects to the stream *after* the question was emitted, the stream first replays `session.events_history` (`headless_api.py:919-932`) and the `interaction_required` event will be replayed verbatim. The frontend does not need extra logic — just handle the event when it arrives.

### 3.2 Polling (fallback)

Endpoint: `GET /api/v1/tasks/{task_id}`

Response shape (`headless_api.py:877-885`):

```json
{
  "task_id": "...",
  "workspace_id": "...",
  "status": "waiting_interaction",
  "current_iteration": 7,
  "events": [ /* full history with seq/type/data/timestamp */ ],
  "result": null,
  "interaction": {
    "interaction_id": "interaction-9f5e...",
    "type": "ask_question",
    "tool": "ask_question",
    "questions": [ /* ... */ ]
  }
}
```

- `status == "waiting_interaction"` **is** the signal that a question is pending (`headless_api.py:875`).
- While the task is in any other state, `interaction` is `null`.
- The list of possible `status` values returned by the headless API: `running`, `waiting_interaction`, `completed`, `failed`, `cancelled`.

---

## 4. Answering the question

Endpoint: `POST /api/v1/tasks/{task_id}/respond`
Auth: `Authorization: Bearer <api_key>`
Content-Type: `application/json`

### 4.1 Request body

Pydantic model (`headless_api.py:194-196`):

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

Rules for building `response`:

1. Keys **must** be the `id` of each question from the original payload.
2. For a single-select question (`allow_multiple` falsy), the value is a **string** — the chosen option, or free-form text if the user declined the preset options.
3. For a multi-select question (`allow_multiple` truthy), the value is an **array of strings**. Empty arrays are allowed by the API but not meaningful; the TUI requires at least one selection before it will submit (`dialog-question.tsx:102-106`).
4. Every question shown in the payload should have a key in `response`. The reference TUI auto-fills any unanswered single-select question with its first option (`dialog-question.tsx:82`) — frontends are free to do the same or require explicit answers.
5. The shape of `response` is not validated by the server — it's a free-form `Dict[str, Any]` that the agent receives as the tool result verbatim (`base_agent.py:1141-1143`). Stick to the keyed-by-`id` convention so the agent can make sense of the answers.

### 4.2 Successful response

```
200 OK
{ "status": "running" }
```

After this call, the agent's blocked `_wait_for_interaction_response` returns, `tool_result` is replaced with the `response` dict (`base_agent.py:1143`), the task state transitions back to `running`, and new `agent` events (`iteration`, `tool_call`, ...) will start arriving on the SSE stream again.

### 4.3 Error responses

From `headless_api.py:986-995`:

| Status | When | Body |
|---|---|---|
| `401` | Missing/invalid `Authorization` header | `{"detail": "..."}` |
| `404` | `task_id` not found | `{"detail": "Task not found"}` |
| `409` | Task is not currently waiting (e.g. already answered, cancelled, completed) | `{"detail": "Task is not waiting for interaction (status: <state>)"}` |
| `409` | No active agent on the session | `{"detail": "No active agent to respond to"}` |

Important: there is **no strict check that the submitted `interaction_id` matches the pending one**. The agent itself ignores responses whose `interaction_id` does not match (`base_agent.py:876`) and will keep waiting. If the UI POSTs an `interaction_id` from a stale/previous question, the API returns `200` but the agent never unblocks. **Always echo the `interaction_id` from the latest `interaction_required` event.**

---

## 5. UI behaviour checklist

This is what a correct frontend implementation should do. Pulled from the reference TUI (`tui/src/component/dialog-question.tsx`) and the backend contract.

### State machine

```
          ┌──────────┐   interaction_required event
          │ running  │ ───────────────────────────┐
          └──────────┘                            ▼
                ▲                        ┌─────────────────────┐
                │  POST /respond 200 OK  │ waiting_interaction │
                └────────────────────────│  (render modal)     │
                                         └─────────────────────┘
```

- On `interaction_required`: capture the `data.interaction_id` and `data.questions`, render the question UI, and freeze any "agent is thinking" animations.
- **Dismiss optimistically — before waiting for the POST to resolve.** The reference TUI clears local dialog state *before* firing `client.respond()` (`tui/src/app.tsx:260-264`). The user sees the modal close immediately; the network round-trip happens in the background. Don't wait for `200` before closing.
- **Silently ignore 409 on `/respond`.** If `/respond` returns `409`, the task state has already moved on (agent was cancelled, auto-answered, or the response arrived after another client already answered). The reference TUI treats 409 as non-fatal and swallows it without surfacing an error (`tui/src/app.tsx:265-275`). For other failures (500, network error, etc.), surface the error back to the user.
- **Dedupe by `interaction_id`.** If your client may see the same `interaction_required` event twice (SSE reconnect + history replay, or multiple tabs on the same task), track a set of already-answered `interaction_id`s and drop repeats. The web-demo does this at `useWebSocket.ts:1106-1108`:
  ```ts
  if (interactionId && answeredInteractionsRef.current.has(interactionId)) break;
  ```
- **Auto-clear when the agent resumes.** If a pending-interaction dialog is still on screen and an `iteration` (or any post-question agent event) arrives, it means the agent has moved past the question — close the modal. The TUI clears `pendingInteraction` inside its `iteration` case (`tui/src/context/sync.tsx:172-176`). This is a robust safety net for crash-recovery and multi-tab scenarios.
- If the user cancels the task (via `POST /tasks/{task_id}/cancel`) while a question is on screen: dismiss the UI; the agent will observe cancellation inside its wait loop and exit (`base_agent.py:921-923`).
- If the SSE connection drops while a question is on screen: reconnect to the stream. The `interaction_required` event will be replayed from history, or the new state will arrive via the next `agent` frame. Dedupe-by-id prevents the replay from re-opening the dialog after it's been answered.
- **Dismiss without answering is a valid path.** The TUI's Esc handler simply clears local state without sending anything (`tui/src/app.tsx:278-281`). The agent stays blocked in its wait loop. This is useful as "I changed my mind, let me cancel the whole task" — pair the dismiss action with `POST /tasks/{task_id}/cancel` for cleanliness, since the agent will otherwise wait indefinitely.

### Rendering questions

- **Number of questions**: between 1 and 3. Design for all three cases.
- **Single question**: render the prompt + options inline. The TUI does not show pagination for a single question.
- **Multiple questions**: the TUI walks through them one at a time with a `current index / total` indicator. A stepper or accordion are both reasonable alternatives.
- **Options parsing**:
  ```ts
  const options =
    typeof raw === "string"
      ? raw.split(",").map(s => s.trim()).filter(Boolean)
      : Array.isArray(raw) ? raw.map(String) : []
  ```
  (matches `dialog-question.tsx:36-42`). The web-demo additionally tolerates an object form `{ id?, label? }` inside the array (`useWebSocket.ts:1143-1168`) — accepting this form is optional but makes your client forward-compatible if the tool ever emits richer options.
- **No options provided**: treat the question as free-form text input. The reference TUI shows a text area in this case.
- **Options + free-form (recommended)**: always add a "Type your own answer" affordance, **even when options are present**. The TUI renders it unconditionally as option N+1 after the listed options (`dialog-question.tsx:217-253`), and the web-demo auto-injects an "Other..." option if the backend didn't include one (`InteractionOptionsPanel.tsx:35-40`). Agents often list the most likely answers but the user may want to override.
- **Multi-select**: checkbox-style UI. `allow_multiple` may arrive as a boolean `true` **or** as the string `"true"` — normalize with `raw === true || raw === 'true'` (`useWebSocket.ts:1126-1129`, `dialog-question.tsx:31-34`).
- **Submission**: build `response` as `Record<questionId, string | string[]>` per §4.1.
- **Empty-answer behaviour**: the web-demo's Skip button submits the literal string `"skip this question"` as the value for that question (`InteractionOptionsPanel.tsx:121`, `useInteractionAnswer.ts:65`). This gives the agent a clear "user declined" signal that's more informative than an empty string. Recommended pattern for any "skip" affordance.

### Accessibility / UX notes

- The agent is **blocked** on this answer. Make it obvious that the task is paused and waiting on the user — do not let the UI imply work is still happening in the background.
- Avoid auto-dismissing the modal on a timer; there is no server-side timeout on the wait (the agent will wait until cancelled or answered, see `_wait_for_interaction_response` loop with 0.2s condition polling, `base_agent.py:912-937`).
- The question order is meaningful to the agent (questions have semantic ids). Do not reorder them before sending answers.
- The agent expects the answer to preserve the `id` → answer mapping. Never key the response by prompt text or array index.

---

## 6. Auto-interaction mode (no UI)

When the task is submitted with `interaction_mode: "auto"` (`headless_api.py:500`), a server-side callback short-circuits the flow (`headless_api.py:455-479` and registered at `:501`):

- On every `interaction_required` event, a 300 ms timer fires and auto-submits the response:
  ```json
  { "auto": true, "message": "Proceed with your best judgment" }
  ```
- The UI still **receives** the `interaction_required` event for visibility, but should not render a blocking modal. A toast/banner ("agent is auto-answering its own question") is appropriate.
- In this mode, `POST /respond` from the UI is unnecessary (and will almost always race with the auto-responder and return `409`).

`interaction_mode` defaults to `"manual"`, so no behaviour change is needed unless the client explicitly opts into auto.

---

## 7. End-to-end worked example

### 7.1 Submit a task

```http
POST /api/v1/tasks HTTP/1.1
Authorization: Bearer sk-hdls-...
Content-Type: application/json

{
  "query": "Create a React counter app",
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

### 7.2 Subscribe to the SSE stream

```http
GET /api/v1/tasks/t_abc123/stream HTTP/1.1
Authorization: Bearer sk-hdls-...
Accept: text/event-stream
```

Frames arrive. Eventually:

```
event: agent
data: {"seq":17,"type":"interaction_required","data":{"interaction_id":"interaction-9f5e3b2a","type":"ask_question","tool":"ask_question","questions":[{"id":"framework","prompt":"Which CSS framework?","options":["Tailwind","Bootstrap","None"],"allow_multiple":false},{"id":"pages","prompt":"Which pages do you need?","options":"Home,About,Contact","allow_multiple":"true"}]},"timestamp":1744300123.456}
```

UI action: render the two-question modal. Wait for the user.

### 7.3 User answers, POST to `/respond`

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

### 7.4 Stream resumes

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

## 8. Reference implementations in this repo

Two first-party clients handle `ask_question`. They are useful in very different ways:

### 8.1 TUI — canonical headless-API consumer

**Path**: `tui/src/`. Transport: SSE + `POST /respond` (i.e. the headless API this doc describes). **Use this as the reference for protocol/wire-level correctness.**

Key files and what to learn from each:

| File | What to copy |
|---|---|
| `tui/src/api/client.ts:34-44` | Minimal `respond()` implementation — the exact HTTP shape. |
| `tui/src/api/sse.ts` | Parses the raw SSE frames (`event:` / `data:` / `\n\n`), handles `agent` / `done` / `ping`. |
| `tui/src/context/sync.tsx:383-387` | One-line handler: stash the payload and flip status to `waiting_interaction`. |
| `tui/src/context/sync.tsx:172-176` | The auto-clear-on-iteration safety net. |
| `tui/src/app.tsx:255-281` | The full respond/dismiss lifecycle, including the optimistic clear-before-POST pattern and the "swallow 409" rule. |
| `tui/src/component/dialog-question.tsx` | The actual question UI — option rendering, multi-select, free-text fallback, keyboard nav. |

Feature inventory (from `dialog-question.tsx`):

- **Options rendering**: numbered `1.` / `2.` / `3.` … for single-select, `[ ] / [✓]` checkboxes for multi-select.
- **Free-text always available**: renders "Type your own answer" as option N+1 unconditionally (lines 217-253). Selecting it opens an inline textarea.
- **Keyboard shortcuts** (lines 115-163):
  - `↑` / `k` — previous option
  - `↓` / `j` — next option
  - `1`–`9` — jump-select by index
  - `space` — toggle (multi-select only)
  - `enter` — confirm current option (single) or confirm entire multi-select batch
  - `esc` — dismiss without answering
- **Multi-select hint**: shows `(space to toggle, enter to confirm)` helper text above the options (lines 183-187).
- **Multi-select validation**: at least one option must be picked before `enter` submits (lines 102-106).
- **Single-select fallback**: if the user submits without picking, the first option is sent automatically (line 82). If you want strict validation instead, don't copy this fallback.
- **Multi-question batching**: if `questions.length > 1`, the dialog walks forward one question at a time and only fires `onRespond` on the final question (lines 67-73).

Response shape produced (lines 75-86) — **identical to what the headless API expects**:

```ts
const result: Record<string, any> = {}
for (const q of questions()) {
  const am = q.allow_multiple === true || q.allow_multiple === "true"
  if (am) result[q.id] = multiSelections[q.id] ?? []
  else    result[q.id] = answers[q.id] ?? (options().length > 0 ? options()[0] : "")
}
props.onRespond(result)
```

### 8.2 Web-demo — UX reference (**not** a headless-API consumer)

**Path**: `web-demo/frontend/src/`. Transport: **WebSocket directly to the web-demo backend**, using a message type `interaction_response` — this pre-dates the headless API and does **not** call `POST /api/v1/tasks/{id}/respond`. Do **not** copy its transport layer. Its UI/UX patterns are worth borrowing.

> ⚠️ **Transport caveat.** The web-demo sends `{ type: "interaction_response", interaction_id, response, metadata }` over a WebSocket connection. The headless API does **not** accept this message shape, does **not** accept the `metadata` field, and is not reachable over WebSocket. If you copy a web-demo snippet, strip the WebSocket plumbing and replace it with a `POST /api/v1/tasks/{task_id}/respond` call using the body from §4.1.

Borrow-able UX patterns (all verified in the web-demo source):

1. **Inline chat panel, not a modal** — the web-demo renders the question inline in the conversation thread (`WorkingPage.tsx:407-422`), so the question sits in-context with the agent's preceding thinking. This preserves the chat history and makes the question feel like a natural turn in the dialogue.
2. **Pagination with accumulation** (`useInteractionAnswer.ts:34-72`) — for multi-question batches, the web-demo advances through questions one at a time using `currentQuestionIndex` and a `collectedAnswers` map, only sending the full response on the final question. This avoids overwhelming the user with three questions at once. The TUI uses a similar per-question walk inside a single dialog render.
3. **Auto-generated option letters** (`useWebSocket.ts:1114`, `:1138`) — each option gets a letter id `A`, `B`, `C`, … client-side. Lets the UI render `A. Tailwind`, `B. Bootstrap`, …, which reads nicely and works well with keyboard shortcuts.
4. **"Other..." auto-injection** (`InteractionOptionsPanel.tsx:35-40`) — the web-demo adds an "Other..." option to every question if the backend didn't include one. When selected, it reveals an inline `<input>` that the user types into. Clean way to combine "suggested answers" + "free-form".
5. **Skip button** (`InteractionOptionsPanel.tsx:118-125`) — always visible, always enabled, submits `"skip this question"` as the answer. Gives the user an escape hatch without letting them bypass the flow entirely.
6. **Continue button with validation** (`InteractionOptionsPanel.tsx:126-151`) — disabled until the current question has a valid answer (either a real option selected, or "Other..." with non-empty text). Prevents accidental empty submissions.
7. **Selected-state styling** — light blue background + blue border on the selected option, plain border on unselected. Simple and legible (`InteractionOptionsPanel.tsx:108-112`).
8. **Mobile/desktop fork** — same panel component, different hover/active pseudo-classes (`InteractionOptionsPanel.tsx:51-54`). Worth copying if your product has both form factors.
9. **Human-readable Q&A log** — on submit, the web-demo also records a `tool_call`-like entry named `ask_question_answers` in the conversation transcript so the user sees "you answered: X" alongside the rest of the agent's work (`useWebSocket.ts:1449-1472`). The log entry is local UI only — the headless API doesn't render it — but mirroring this locally in your own client is a nice touch for transcript continuity.

### 8.3 Side-by-side

| Concern | TUI (headless API) | Web-demo (WebSocket) |
|---|---|---|
| Transport | SSE + `POST /respond` | WebSocket `interaction_response` message |
| Where to render | Modal overlay (terminal) | Inline in chat panel |
| Question batching | Walks inside one dialog render | Walks with state updates, one question per render |
| Option IDs | Backend-provided (or numeric) | Letters auto-generated client-side |
| Free-form input | "Type your own answer" as option N+1, always present | "Other..." auto-injected if missing |
| Multi-select confirm | `enter` key after selection | Continue button |
| Dismiss | `esc` — local clear, no call | "Skip" — submits `"skip this question"` |
| Dedupe | Relies on auto-clear-on-iteration | Explicit `Set<interactionId>` check on receive |
| Metadata field | N/A | Sends `metadata.qa` for transcript rendering — **not part of headless API** |

A good headless-API frontend takes the **TUI's protocol handling** and the **web-demo's chat-inline UI patterns**.

---

## 9. Quick reference

**The only two endpoints you need for the question flow:**

| Purpose | Method + Path |
|---|---|
| Receive the question (recommended) | `GET /api/v1/tasks/{task_id}/stream` — watch for `agent` frames with `data.type == "interaction_required"` |
| Receive the question (polling) | `GET /api/v1/tasks/{task_id}` — check `status == "waiting_interaction"` and read `interaction` |
| Submit the answer | `POST /api/v1/tasks/{task_id}/respond` with `{ interaction_id, response }` |

**The only invariants you must preserve:**

1. Echo `interaction_id` unchanged.
2. Key `response` by question `id`.
3. Single-select → string value. Multi-select (`allow_multiple` truthy, including string `"true"`) → string array.
4. `options` may be a comma-separated string or an array — accept both.
5. Up to 3 questions per interaction. Design for 1, 2, and 3.
6. The task is **blocked** until you respond or cancel. Show that state clearly.
