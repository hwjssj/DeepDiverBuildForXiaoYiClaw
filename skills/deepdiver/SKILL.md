# DeepDiver Task Manager

通过 DeepDiver MCP 工具创建构建任务、轮询进度、获取预览 URL，每 ~5 分钟用自然语言汇报进展。

## 前置条件

DeepDiver MCP Server 已配置到 AI 客户端。详见根目录 [README.md](../../README.md)。

首次使用需登录：

> 调用 `ddb_login`，传入 `email` 和 `password`

Token 会自动保存到 `.deepdiver-token` 文件，后续调用无需重复登录。

## 流程

### 1. 创建任务

> 调用 `ddb_create_task`，传入 `prompt`（任务描述）

从返回结果中提取：
- `workspace_id` — 后续轮询的核心标识
- `preview_url` — 预览地址（构建完成后可用）

### 2. 轮询进度（每 ~5 分钟）

> 调用 `ddb_check_progress`，传入 `workspace_id`

该工具一次性返回三类信息：

| 信息 | 说明 |
|------|------|
| 构建状态 | `🏗️ 正在构建` / `✅ 已完成` / `⏳ 执行中` |
| 文件列表 | 已生成的文件数和最近文件 |
| 开发服务器 | 是否就绪、URL 地址 |

同时可辅助查看全局视角：

> 调用 `ddb_list_projects`（无需参数）

返回所有项目列表和正在构建的 `building_workspace_ids`。

### 3. 获取预览

构建完成后获取可访问的预览 URL：

> 调用 `ddb_get_preview`，传入 `workspace_id`

自动启动开发服务器并等待就绪，返回可访问的预览地址。

### 4. 进度状态解读

| 现象 | 进展 |
|------|------|
| `building_workspace_ids` 包含该 ID | AI 正在构建中 |
| 文件列表开始出现 | AI 已开始生成代码 |
| 开发服务器已就绪 | 代码已生成，预览可用 |
| `building_workspace_ids` 不再包含 | 构建完成 |

### 5. 汇报格式

每次轮询后，用自然语言总结，格式参考：

> **任务进度更新** (已进行 X 分钟)
> - 状态: 🏗️ 构建中 / ✅ 已完成 / ⏳ 排队中
> - 已生成 X 个文件 (总大小 Y KB)
> - 最近文件: ...
> - 开发服务器: 已就绪 / 未启动
> - 下一步: ...

## 注意事项

- Token 有效期 24 小时，过期后需重新调用 `ddb_login`
- 构建完成后文件列表不再变化，开发服务器 URL 可用于预览
- 所有操作通过 MCP 工具完成，无需手动执行 curl 或脚本
