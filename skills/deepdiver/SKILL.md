---
name: deepdiver-builder
description: 借助 DeepDiver 云端平台生成精美网站、Web 应用、竞品调研、演示文稿等。
when_to_use: 用户想生成网站/Web 应用、做竞品调研、制作演示文稿，或查看已有构建的进度和结果时。用户消息以 `使用ddb` 开头时自动触发。
---

# DeepDiver Builder

## §1 概述

DeepDiver 是一个云端 App 构建平台，可以用来生成精美的网站、Web 应用、
以及做竞品调研等。本 skill 通过 DeepDiver Headless API 在云端完成构建，
agent 负责传递用户意图并转述结果。

**脚本**：`scripts/ddb.py`（相对于本 SKILL.md），执行 `python3 $RUNNER --help` 查看所有子命令。

## §2 执行流程

### 2.1 鉴权

首次使用时，引导用户获取 API Key：

1. 打开 https://cn.deepdiver.app 并登录
2. 点击「我的」→「账号设置」→ 页面底部「生成 API 密钥」
3. 将生成的 `sk-hdls-xxx` 格式密钥发给我
4. 执行 `python3 $RUNNER config --key <key>` 保存
5. 执行 `python3 $RUNNER list` 验证通过即可

> 若用户发来的 key 含 `…`（如 `sk-hdl…473f`），说明被前端脱敏截断，
> 让用户去 DeepDiver 页面重新复制完整 key。

Key 保存在 `~/.deepdiver/auth.json`（权限 600），后续 session 自动读取，
无需每次配置。不依赖环境变量（难以跨 session 持久化）。

### 2.2 描述需求

引导用户以 `使用ddb` 开头描述想要的东西，例如：

- **精美网站**：`使用ddb 帮我做一个带登录页的 Todo 应用`
- **竞品调研**：`使用ddb 帮我调研一下市场上主流 CRM 系统的功能差异`
- **演示文稿**：`使用ddb 帮我做一份关于 Q2 业务增长的 PPT`
- **追问迭代**：`使用ddb 追问 <workspace_id> 在上一个版本基础上加个暗色模式`
- **查看进度**：`使用ddb 状态 <task_id>`
- **查看清单**：`使用ddb 列出`
- **导出清单**：`使用ddb 导出 [--刷新]` — 将所有项目导出为 Markdown 文档，可选 `--刷新` 从 API 拉取最新数据

### 2.3 等待与交付

- **简单操作**（列出、查状态、打开、取消、帮助）：即时返回结果。
- **构建/追问**（长任务，默认最长 20 分钟）：提交任务后创建一个定时任务持续轮询，
  每 3 分钟自动检查一次，直到任务完成、失败或超时为止（不是执行一次就停止）。
  轮询在后台进行，不阻塞当前会话——用户可以继续其他对话。任务完成后主动推送结果链接
  （含预览地址和截图，通过 `announce` 推送）。

用户只需发出指令和等待通知，无需关心后台轮询细节。

## §3 行为准则

- **统一入口**：所有 DDB 操作通过 `python3 $RUNNER <子命令>` 完成，由 `ddb.py` 处理鉴权、HTTP、轮询等全部细节。
- **长任务用定时轮询**：`create` / `followup` 提交后创建定时任务，完成后通过推送通知用户；不做同步阻塞等待。
- **执行时长属正常现象**：构建涉及云端环境初始化、依赖安装、代码生成等步骤，耗时合理，不要因为等待就 kill 重试。
- **用 viewer link 分享**：构建完成后优先使用 `?viewer=` 链接（任何人可访问），owner link（`?token=`）仅登录后可开，不应直接发给用户。
- **链接用 markdown 格式**：输出结果时使用 `[标题](url)` 格式，方便用户直接点击跳转。不要把脚本原始输出直接丢给用户。
- **Key 持久化**：用户提供 key 后通过 `python3 $RUNNER config --key <key>` 保存，后续 session 自动读取。

## §4 禁止事项

- **禁止直连 API**：不得使用 `curl` / `WebFetch` / `requests` 或任何 SDK 直接访问 `cn.deepdiver.app`。
- **禁止从上下文读 Key**：不得从对话历史、用户消息、之前的 tool 输出中提取或"回忆" `sk-hdls-*` 字符串。
- **禁止拼 Key 到命令行**：不得使用 `DEEPDIVER_API_KEY=xxx python3 ...` 或 `--api-key` 等形式。
- **禁止改写用户输入**：`<描述>` 原样传给 `--query`。
- **禁止自动重试或取消**：超时/失败由用户决定下一步。
- **禁止并发构建**：已有任务在执行时，不得创建新的 `create` / `followup`，等当前任务结束后再提交。

## 附录A 命令速查

| 用户输入 | 执行命令 | 模式 |
|---|---|---|
| `使用ddb 列出` / `list` | `python3 $RUNNER list` | 同步 |
| `使用ddb 导出 [--刷新]` | `python3 $RUNNER export [--refresh]` | 同步 |
| `使用ddb 构建 <描述>` | `python3 $RUNNER create --query "<描述>"` | 长任务 |
| `使用ddb 追问 <ws_id> <描述>` | `python3 $RUNNER followup --workspace-id <ws_id> --query "<描述>"` | 长任务 |
| `使用ddb 状态 <task_id>` | `python3 $RUNNER status <task_id>` | 同步 |
| `使用ddb 打开 <ws_id>` | `python3 $RUNNER open <ws_id>` | 同步 |
| `使用ddb 取消 <task_id>` | `python3 $RUNNER cancel <task_id>` | 同步 |
| `使用ddb 帮助` | `python3 $RUNNER help` | 同步 |

**参数抽取**：`<描述>` = 去掉前缀关键字后的剩余整段，保留内部空格与标点。
含 `"` 或多行时用 heredoc 避免转义。

## 附录B 输出规范

### URL 展示

- 优先展示 viewer link（`?viewer=`，任何人可访问）
- owner link（`?token=`）仅登录后可开，不应直接发给用户
- 使用 `[标题](url)` markdown 链接格式

### 构建成功

```
✅ 构建完成：[{project_name}]({share_url})
[查看截图]({screenshot_url})
```

### 构建失败

展示 `status`、`error`、`task_id`，由用户决定重试或排查。

### status 子命令特殊处理

`status` 返回的 preview URL 为 owner URL（含 `?token=...`），
需额外执行 `python3 $RUNNER open <workspace_id>` 生成 viewer link 后再发给用户。

### list 展示

每项用 `[project_name](url)` 格式，后接状态行，条目之间空一行分隔。
空清单时展示"暂无已构建 app"并建议 `使用ddb 构建 <描述>`。

## 附录C 定时任务配置

`create` / `followup` 提交后必须立即创建一个定时任务来轮询状态。
不同平台实现方式不同，例如 OpenClaw 使用 `cron` 命令，其他平台可用类似的定时调度机制。

核心参数：
- 间隔：每 3 分钟检查一次
- 最长执行：20 分钟（默认超时）
- 模式：agent 自动执行，结果推送（announce）到用户会话

**OpenClaw 提示**：`cron` 命令默认 `deleteAfterRun: true`（执行一次即删除），
必须设为 `deleteAfterRun: false` 才能持续轮询直到任务完成。

**⚠️ 定时任务环境注意事项**：
- 通常不加载 shell 配置文件，所有命令前加 `source /home/sandbox/.bash_profile &&`（按实际平台调整）
- `~` 可能不展开，路径尽量使用绝对形式

**检查逻辑**：
1. `source /home/sandbox/.bash_profile && python3 $RUNNER status <task_id>`
2. `completed` → 调 `open <workspace_id>` 生成 viewer URL → 推送结果给用户 → 删除定时任务
3. `failed` / `cancelled` → 推送错误信息 → 删除定时任务
4. `running` → 不做操作，下次继续
