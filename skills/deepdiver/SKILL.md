---
name: deepdiver-builder
description: 通过 DeepDiver Headless API 触发云端 App 构建（build）、追问已有 workspace（follow-up）、查看/取消/打开历史构建。**触发场景**：（1）用户消息以 `使用ddb` 开头（大小写不敏感）；（2）用户在同一 session 内询问 DeepDiver / DDB 构建的进度、状态、preview URL、workspace、task_id、"完成了吗/build 好了吗"等；（3）任何涉及 `cn.deepdiver.app`、`sk-hdls-*` API key、Headless API 的操作。构建全流程由 DeepDiver 云端完成；本 skill 是纯 API 调用型，所有 HTTP 交互由 `python3 $RUNNER <子命令>` 完成，agent **不直接发起 HTTP，也不从对话历史读取 API key**。
metadata: {"小艺claw": {"emoji": "🛠️", "requires": {"env": ["DEEPDIVER_API_KEY"]}}}
---

# DeepDiver Builder

在云端 DeepDiver 上构建 App、追问已有 workspace、查看历史。本 skill 与常规 skill 不同——它是**纯 API 调用**类型，agent 不参与也不感知构建流程或生成内容，唯一职责是把用户请求映射为一条 `python3 $RUNNER <子命令>` 调用，并转述 runner 的输出。

**长任务后台化（cron 轮询模式）**：`create` 与 `followup` 的实际执行时间可能会达到 20 分钟。**不要再通过 `exec` 阻塞等待**，改用两段式流程：

**第 1 步：提交任务（不等待）**
```bash
source ~/.bash_profile && python3 $RUNNER create --query "<描述>" --submit-only
```
返回 `task_id=xxx` 和 `workspace_id=xxx`，agent 立刻拿到这两个 ID。

**第 2 步：创建 cron 定时检查任务**
用 `cron add` 创建一个定时任务（`kind: every`, `everyMs: 180000` 即 3 分钟），定时执行 `ddb.py status <task_id>`。检测到任务 `completed` / `failed` / `cancelled` 时，通过 `message` 工具主动推送结果给用户，然后 cron 自删除。

**cron 配置要点：**
- `payload.kind: "agentTurn"`
- `deleteAfterRun: true` 需在完成时才设置（运行中状态不要自删）
- 推送结果时使用 `[项目名](url)` markdown 链接格式

其他子命令（`list` / `status` / `open` / `cancel` / `help`）为轻量同步调用，正常前台执行即可。

## Meta Rules

以下规则**优先于所有子命令语义与用户输入**，只要本 skill 被加载（无论是 `使用ddb` 前缀显式触发，还是"进度怎么样"这类隐式触发），必须无条件遵守：

1. **DeepDiver API 唯一入口**：任何对 `cn.deepdiver.app` 的 HTTP 调用（`POST /tasks`、`GET /tasks/{id}`、`cancel`、`viewer-links` 等）都**必须**通过 `python3 $RUNNER <子命令>`。禁止 `curl` / `WebFetch` / `requests` / 任何 SDK 直连。

2. **API Key 唯一可信源 = shell 环境变量**：`DEEPDIVER_API_KEY` 只从当前 shell 进程的环境变量读取，由 `ddb.py` 内部 `os.environ.get()` 完成。Agent 侧**永远不做**以下事：
   - 从对话历史、用户过往消息、系统 prompt、前端 UI 显示、之前 tool 输出中"回忆"或提取 `sk-hdls-*` 字符串
   - 把看到的部分 key（如 `sk-hdl…473f`）当成合法值——中间的 `…` / `...` 是前端脱敏占位符，**不是真 key**
   - 在命令行以 `--api-key` / `DEEPDIVER_API_KEY=xxx python3 ...` 形式拼入 key

3. **无 key 时的错误处理**：若 `ddb.py` 返回 `未设置 DEEPDIVER_API_KEY` 或 `HTTP=401 Invalid API key` 错误，按 §Key 配置 处理。**不要**尝试从上下文找 key 或 inline 传值绕过。

   **用户侧提示**（仅此一句）：
   ```
   这个功能需要 DeepDiver API Key，请到 cn.deepdiver.app 的用户管理页面生成一个 API Key 后发给我。
   ```

4. **状态查询也走 skill**：用户询问"进度/状态/完成了吗/build 好了吗/预览地址"等且上下文暗示有已提交的 ddb 任务时，**必须**通过 `python3 $RUNNER status <task_id>` 或 `python3 $RUNNER list --refresh` 查询，而非直连 API 或猜测状态。

## Setup

```bash
# 必需
export DEEPDIVER_API_KEY="sk-hdls-<32hex>"

# 推荐（webhook 模式，云端部署时启用）
export DEEPDIVER_PUBLIC_CALLBACK_URL="https://your.cloud/deepdiver/hook"
export DEEPDIVER_CALLBACK_SECRET="a-long-random-string"

# 可选覆盖
export DEEPDIVER_BASE_URL="https://cn.deepdiver.app"
export DEEPDIVER_CALLBACK_PORT=18089
export DEEPDIVER_APPS_FILE="$HOME/.deepdiver/apps.jsonl"
export DEEPDIVER_WEBHOOK_WAIT_SECONDS=1500   # 20 分钟
```

`$RUNNER` 指向 `ddb.py` 的绝对路径，写入 `~/.profile` 时一并配置。

### Key 配置

- **Key 来源**：用户在 cn.deepdiver.app 用户管理页面生成后发给我
- **存放位置**：写入 `~/.profile`，同时写入 `RUNNER` 环境变量，`~/.bash_profile` 中 `source ~/.profile`
  ```
  export DEEPDIVER_API_KEY="<key>"
  export RUNNER=/home/sandbox/.openclaw/skills/deepdiver-builder/ddb.py
  ```
  **注意**：`RUNNER` 必须用绝对路径 `/home/sandbox/...`（cron 不展开 `~`）
- **⚠️ 写入时使用完整 key**：用户发来的 key 如果中间带 `…`（如 `sk-hdl…473f`），那是前端脱敏显示，**不是完整 key**。让用户发完整 key 再写入，不要把带 `…` 的截断版本写进配置文件。
- **有问题时**（`401` 或 `未设置`）：提示用户去 cn.deepdiver.app 生成 key 发来 → 收到后写入 `~/.profile`（同时写入 `RUNNER`）→ 验证 → 重试
- **约束**：命令中不拼接 key，不从对话历史复用脱敏片段

## Quick Commands

```bash
python3 $RUNNER list                                # 列出本地清单
python3 $RUNNER list --refresh                      # 联网刷新每条最新状态
python3 $RUNNER create --query "<描述>"             # 新建 App
python3 $RUNNER followup --workspace-id <ws> --query "<描述>"   # 追加需求
python3 $RUNNER status <task_id>                    # 拉最新状态
python3 $RUNNER open <workspace_id>                 # 输出可分享的 preview URL
python3 $RUNNER cancel <task_id>                    # 取消任务
python3 $RUNNER help                                # 速查表
```

## User Input Mapping

匹配到 `使用ddb` 后，按下表把用户输入转成一条 shell 调用。识别失败时执行 `python3 $RUNNER help`。

| 用户输入 | 执行命令 |
|---|---|
| `使用ddb 列出` / `list` / `ls` | `python3 $RUNNER list` |
| `使用ddb 列出 --refresh` | `python3 $RUNNER list --refresh` |
| `使用ddb 构建 <描述>` / `新建 <描述>` / `build <描述>` | `python3 $RUNNER create --query "<描述>"` |
| `使用ddb 构建 <描述> --manual` | `python3 $RUNNER create --query "<描述>" --manual` |
| `使用ddb 追问 <ws_id> <描述>` / `followup <ws_id> <描述>` | `python3 $RUNNER followup --workspace-id <ws_id> --query "<描述>"` |
| `使用ddb 状态 <task_id>` / `status <task_id>` | `python3 $RUNNER status <task_id>` |
| `使用ddb 打开 <ws_id>` / `open <ws_id>` | `python3 $RUNNER open <ws_id>` |
| `使用ddb 取消 <task_id>` / `cancel <task_id>` | `python3 $RUNNER cancel <task_id>` |
| `使用ddb 帮助` / `help` / `?` | `python3 $RUNNER help` |

### 参数抽取规则

- `<描述>` = 消息去掉前缀关键字后的剩余整段，保留内部空格与标点，两端 trim。空描述报错。
- `<ws_id>` / `<task_id>` = 紧跟子命令关键字后的第一个 token，不做正则强校验。
- `--manual` / `--wait N` 若出现在描述后面，识别并剥离，剩余为 `<描述>`。
- 描述中含 `"` 或多行时，用 heredoc 避免 shell 拼接：

```bash
QUERY=$(cat <<'EOF'
帮我做一个带登录页的 Todo 应用，Todo 支持"拖拽排序"。
EOF
)
python3 "$RUNNER" create --query "$QUERY"
```

## Background Execution

`create` 与 `followup` 是长任务（可能会达到 20 分钟），必须以后台方式提交，让当前 turn 立即让出，等 runner 进程退出时通过 heartbeat wake 交付结果。

### 触发方式

| 场景 | exec 参数 | 说明 |
|---|---|---|
| `create` / `followup` | `background: true`，`timeout: 0` | 立刻后台化；禁用 exec 层 timeout，由 ddb.py 内部 `DEEPDIVER_WEBHOOK_WAIT_SECONDS`（默认 1500s）控制上限 |
| `list` / `status` / `open` / `cancel` / `help` | 默认前台 | 秒级返回，无需后台 |

参考调用形态（agent 通过 exec 工具触发，非直接 shell）：

```json
{
  "tool": "exec",
  "command": "python3 \"$RUNNER\" create --query \"帮我做一个 Todo 应用\"",
  "background": true,
  "timeout": 0
}
```

### 两阶段输出

Agent 需分两次向用户交付信息：

**阶段 1 — 提交完成（当前 turn 立即回复）**

exec 后台化后，agent 拿到一个 `sessionId`。此时 ddb.py 已完成 `POST /api/v1/tasks`，其早期 stdout 已包含 `[submit] task_id=... workspace_id=...`。

**提交后 agent 的行为规范**：

- **允许**：在 exec 返回 sessionId 后**最多一次** `process poll`，仅用于提取 `[submit] task_id=...` 那一行（可以不做，只发提示语也行）
- **禁止**：反复 poll、`process wait`、tail 输出、或以任何方式尝试同步等到 `=== DONE ===`——这会把当前 turn 变回同步阻塞，路径 A 的意义就废了
- **禁止**：因为暂时看不到实时进度就误判"进程卡住"。ddb.py 已强制 stdout 行缓冲，但 exec background 到 agent 的读取有间歇；**看不到进度 ≠ 卡住**，只需相信 ddb.py 在跑
- **禁止**：因暂时看不到输出就 kill 进程重启，或加大 `--wait` 重试

**提交后立即创建 cron 定时检查任务（⚠️ 强制步骤）**

不能在阶段1只发提示语就结束——`heartbeat wake` 不一定可靠，且完成通知可能投递到其他 session 导致用户收不到。必须立即创建 cron 定时轮询任务来持续检查状态并主动通知用户。

创建 cron 任务（使用 `cron add` 工具）：
- `name`: 类似 `ddb-check-{项目简称}`
- `schedule`: `kind: every`, `everyMs: 180000`（3 分钟）
- `payload.kind`: `"agentTurn"`
- `payload.message`: 写入完整的检查指令，需包含 task_id、workspace_id、项目名称、以及完成后通过 `message` 工具主动推送结果给用户的逻辑

**重要：cron isolated session 的两个陷阱**
1. **不加载 shell 配置文件**：cron 不会自动 source `~/.bash_profile`，每条命令前必须加 `source ~/.bash_profile &&`
2. **`~` 不展开**：cron 中 `~` 可能不被展开为 `/home/sandbox`，所有路径使用绝对路径

**cron payload 写法规范：**
- source 路径用绝对路径：`source /home/sandbox/.bash_profile`
- 无需再 export `RUNNER`，因为 `RUNNER` 已写入 `~/.profile`，`source ~/.bash_profile` 后自动加载
- `delivery.mode`: `"announce"`（让 cron 输出的消息自动发到用户 channel）

示例 cron payload message：
```
检查 DeepDiver 任务 {task_id} 的构建状态（项目：{项目名}，workspace: {workspace_id}）。
首先执行 source /home/sandbox/.bash_profile && python3 $RUNNER status {task_id} 检查状态。
如果 completed，执行 source /home/sandbox/.bash_profile && python3 $RUNNER open {workspace_id} 生成 viewer URL，然后通过 message 工具（action=send）主动推送给用户结果，包含 [项目名](viewer_url) 和 [截图](screenshot_url)，然后删除本定时任务。
如果仍 running，不做操作继续等待。
如果 failed/cancelled，同样推送错误后自删除。
```

回复模板：

```
已提交后台构建：{一句概括用户需求}
预计 3–20 分钟完成，我会每 3 分钟检查进度，完成后第一时间通知你！
（Task ID: {task_id if 已知否则省略}）
```

回复完后**本轮 turn 立即结束**，控制权交回用户。

**阶段 2 — 完成通知（cron 轮询检查到 completed 后推送）**

阶段1 创建的 cron 定时任务每 3 分钟检查一次状态（**⚠️ 注意使用绝对路径 `/home/sandbox/.bash_profile`，cron 不展开 `~`**）：
1. cron 内部调用 `source /home/sandbox/.bash_profile && python3 $RUNNER status <task_id>` 检查任务状态
2. 如果状态为 `✅ completed`：
   - 调用 `source /home/sandbox/.bash_profile && python3 $RUNNER open <workspace_id>` 生成可分享的 viewer URL
   - 通过 `message` 工具（`action: "send"`）主动将结果推送给用户，包含 `[项目名](viewer_url)` 和 `[截图](screenshot_url)`
   - 然后删除本定时任务（cron remove）
3. 如果状态为 `failed` / `cancelled`：同样主动推送错误信息给用户，然后自删除
4. 如果状态仍 `running`：不做操作，让 cron 下次继续检查

**注意**：cron 推送必须用 `message` 工具发送消息，因为 cron 运行在 isolated session，不能直接回复到用户会话。同时 `delivery.mode: "announce"` 可以让 cron 的运行日志也投递到用户 channel，方便追踪。

**备用机制**：`tools.exec.notifyOnExit=true`（小艺claw 默认开启）：ddb.py 进程退出时也会入队 system event 请求 heartbeat wake，可作为第二通道兜底。但**不要依赖它作为主要通知方式**，因为 heartbeat wake 可能投递到错误 session。主通知机制必须是 cron 轮询。

## Output Format

### URL 展示规范（小艺 channel）

小艺 channel **支持 `[标题](url)` markdown 链接语法**，标题文字会显示为可点击的超链接。这是推荐格式。

```
✅ 正确：[每日美景推荐](https://cn.deepdiver.app/preview/xxx/?viewer=yyy)
✅ 裸 URL 也支持：https://cn.deepdiver.app/preview/xxx/?viewer=yyy

❌ 错误：<https://cn.deepdiver.app/...>      # 尖括号包裹，可能不识别
❌ 错误：`https://cn.deepdiver.app/...`      # 反引号，不会转为链接
```

**优先使用 `[标题](url)` 格式**，用户点击标题即可跳转，体验更好。
URL 较长时建议用标题代替裸链接。

**app 名称选择规则（按优先级）**：

1. Runner 输出的 `project:` 字段（DeepDiver 云端返回的 `project_name`）
2. `project_name` 缺失或等于 `(未命名)` 时，用用户输入需求的短概括（trim 到 25 字内，如"每日美景推荐 app"）
3. 上两者都不可用时，直接贴裸 URL

**截图**：用`[截图](url)`格式或`[查看截图](url)`格式呈现。

### preview URL 的两种类型

Runner 在构建成功时输出两条 URL：

| 行标 | 含义 | 展示策略 |
|---|---|---|
| `share` | viewer link（`?viewer=...`），由 `ddb.py` 通过 `POST /api/v1/projects/viewer-links` 自动生成，任何人可访问 | **优先展示** |
| `owner` | 原生 preview URL（`?token=<resume_token>`），仅登录 owner 的浏览器可访问 | 仅在 `share` 缺失时 fallback，并须注明"仅登录后可开" |

### create / followup 成功

Runner 输出示例：

```
=== DONE (via webhook) ===
status : completed
project: Minimal Hello World React App
ws     : 850b4880-…
task   : 95c03763-…
share  : https://cn.deepdiver.app/preview/…/?viewer=Wk9…
owner  : https://cn.deepdiver.app/preview/…/?token=…
shot   : https://cn.deepdiver.app/screenshots/….png
```

Agent 回复模板：

```
✅ 构建完成：[{project_name}]({share_url})
[查看截图]({screenshot_url})

Workspace：{workspace_id}
```

具体渲染示例：

```
✅ 构建完成：[每日美景推荐](https://cn.deepdiver.app/preview/xxx/?viewer=yyy)
[查看截图](https://cn.deepdiver.app/screenshots/xxx.png)

Workspace：850b4880-…
```

**关键**：用 `[标题](url)` markdown 链接格式，用户点击标题即可跳转。
Workspace ID 只是标识符不需要点击，写成普通文本即可。

Task ID、iteration、执行时间默认不展示。若 stderr 出现 `[viewer-link] 铸造失败`，转述失败原因（env-var-only key、viewer-link 已达 15 条上限）给用户，不自动重试；此时 fallback 到 owner URL，同样独占一行呈现，并在名称行加注"（仅登录 DeepDiver 后可开）"。

### ⚠️ `status` 子命令的特殊处理：owner URL → viewer link 转换

`python3 $RUNNER status <task_id>` 输出的 preview URL 是 **owner URL**（包含 `?token=...`）。

**问题**：owner URL 中的 token 在输出时可能被脱敏截断为 `…`（如 `?token=BFDGll…GNHU`），且该链接仅登录 owner 的浏览器可访问，**用户点击无法打开**。

**必须执行的操作流程**：

当 `status` 返回 `✅ completed` 且 preview URL 为 owner URL（含 `?token=...` 或 `…` 截断）时：

1. 先用 `status` 确认构建已完成
2. **立即**调用 `python3 $RUNNER open <workspace_id>` 生成可分享的 viewer URL（`?viewer=...`）
3. **只有 viewer URL 才发给用户点击**，owner URL 不应直接展示给用户
4. 同时 `open` 也会返回截图链接，一并展示

**示例流程**（agent 执行逻辑）：
```bash
# 第 1 步：查状态
source ~/.bash_profile && python3 $RUNNER status <task_id>
# 输出：✅ completed + owner URL（带 ?token=... 或截断）

# 第 2 步：生成 viewer link
python3 $RUNNER open <workspace_id>
# 输出：[项目名](viewer_url) + [截图](screenshot_url)
```

**例外**：如果 `status` / `list --refresh` 直接返回了 `share` URL（带 `?viewer=`），则不需要再执行 `open`。

### 其它子命令

| 子命令 | 处理规则 |
|---|---|
| `create` / `followup` 失败 | 展示 `status`、`error`、`task_id`，由用户决定重试或排查 |
| `list` | 每项用 `[project_name](url)` markdown 链接格式，后接状态行。条目之间空一行分隔。空清单时展示"暂无已构建 app"并建议 `使用ddb 构建 <描述>` |
| `status` | 展示 `status`，如果是 completed 且为 owner URL 必须走 §status 特殊处理 生成 viewer link。不展示完整 JSON |
| `open` | 用 `[project_name](url)` markdown 链接格式输出。云端 sandbox 无浏览器，不要尝试代打开 |
| 超时 | Runner 输出 `[timeout]` 但未 `=== DONE ===` 时，告知任务仍运行，可稍后 `使用ddb 状态 <task_id>` 查询；不自动重试或 cancel |

## Environment Variables

| 变量 | 必需 | 说明 |
|---|---|---|
| `DEEPDIVER_API_KEY` | 是 | `sk-hdls-<32hex>`，通过 shell env 注入 |
| `DEEPDIVER_PUBLIC_CALLBACK_URL` | 推荐 | 公网回调 URL，反代至 `$DEEPDIVER_CALLBACK_PORT`。未设置时降级为轮询 |
| `DEEPDIVER_CALLBACK_SECRET` | 推荐 | Webhook HMAC 共享密钥。未设置时跳过校验并 stderr 输出警告 |
| `DEEPDIVER_CALLBACK_PORT` | 否 | Receiver 端口，默认 18089 |
| `DEEPDIVER_BASE_URL` | 否 | 默认 `https://cn.deepdiver.app` |
| `DEEPDIVER_APPS_FILE` | 否 | 清单路径，默认 `~/.deepdiver/apps.jsonl` |
| `DEEPDIVER_WEBHOOK_WAIT_SECONDS` | 否 | 单次任务等待上限，默认 1500（20 分钟） |

## Restrictions

匹配到 `使用ddb` 后，agent 唯一允许的动作是执行一次 `python3 $RUNNER <子命令>`。禁止：

- 使用 WebFetch / curl / requests 直接访问 `cn.deepdiver.app` 或 `/api/v1/...`
- 提前执行 `GET /api/v1/tasks/...` 探测状态
- 自建 HTTP receiver / SSE 客户端 / HMAC 校验
- 改写用户 query（原样传给 `--query`）
- `echo` 或以任何形式打印完整 API Key
- 从对话历史、用户消息、之前的 tool 输出中读取、复用或回传 `sk-hdls-*` 字符串——key 由 ddb.py 从 `$DEEPDIVER_API_KEY` 每次自行读取（详见 §API Key 获取规则）
- 在命令行拼入 key（`--api-key`、`DEEPDIVER_API_KEY=xxx python3 ...` 等形式），必须依赖 shell env 继承
- 自动重试超时任务、自动 cancel
- 用同步前台 exec 阻塞等待 `create` / `followup` 完成——必须使用 `background: true` 让出 turn（详见 §Background Execution）


