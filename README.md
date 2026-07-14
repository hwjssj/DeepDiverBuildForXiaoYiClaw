# DeepDiver Build — XiaoYi Claw 工具集

构建和预览 DeepDiver 应用的 CLI 工具、MCP 服务器和  Skill。

## 项目结构

```
.
├── mcp_server/          # MCP (Model Context Protocol) 服务器
│   ├── index.js         # 入口：MCP 工具定义、路由、启动
│   ├── lib/api.js       # DeepDiver REST API 客户端
│   └── package.json
│
├── skills/              # Agent Skills
│   └── deepdiver/
│       └── SKILL.md     # DeepDiver Task Manager Skill（MCP 驱动）
│
├── scripts/             # CLI 工具脚本
│   ├── auth.js
│   ├── create-task.js
│   ├── list-projects.js
│   ├── get-preview.js
│   └── listen-task.js
│
└── docs/                # DeepDiver API 文档
    ├── deepdiver-api.md
    └── deepdiver-auth.md
```

## MCP 服务器

[MCP](https://modelcontextprotocol.io) 服务器将 DeepDiver Build API 封装为 AI 客户端（Claude Code、OpenClaw、Cursor 等）可直接调用的工具。

### 提供工具


| 工具                   | 说明                                 |
| -------------------- | ---------------------------------- |
| `ddb_login`          | 登录并保存 JWT token                    |
| `ddb_create_task`    | 创建构建任务（创建项目 + WebSocket 发送 prompt） |
| `ddb_check_progress` | 检查任务进度（文件、服务、构建状态）                 |
| `ddb_get_preview`    | 获取预览 URL（自动启动 dev server）          |
| `ddb_list_projects`  | 列出所有项目及构建状态                        |


### 环境变量


| 变量                     | 说明               | 默认值                        |
| ---------------------- | ---------------- | -------------------------- |
| `DEEPDIVER_BASE_URL`   | API 地址           | `https://cn.deepdiver.app` |
| `DEEPDIVER_MODEL`      | 构建用模型 ID         | `ddexp`                    |
| `DEEPDIVER_TOKEN`      | JWT token（最高优先级） | —                          |
| `DEEPDIVER_TOKEN_FILE` | token 文件路径       | `.deepdiver-token`         |


### 配置到 AI 客户端

**Claude Code** — 项目级 `.claude/settings.json` 或全局 `~/.claude/settings.json`：

```json
{
  "mcpServers": {
    "deepdiver": {
      "command": "node",
      "args": ["/path/to/mcp_server/index.js"]
    }
  }
}
```

**OpenClaw**：

```bash
openclaw mcp add deepdiver \
  --command node \
  --arg /path/to/mcp_server/index.js
```

**其他客户端** (Cursor、Windsurf 等) — 项目根目录 `.mcp.json`：

```json
{
  "mcpServers": {
    "deepdiver": {
      "command": "node",
      "args": ["/path/to/mcp_server/index.js"]
    }
  }
}
```

### 本地启动

```bash
cd mcp_server
npm install
npm run start          # stdio 模式启动
npm run inspect        # MCP Inspector 调试界面
```

## Skill 使用

详见 [`skills/deepdiver/SKILL.md`](skills/deepdiver/SKILL.md)。

核心流程通过 MCP 工具完成，无需手动执行脚本：

1. **登录** — 调用 `ddb_login`（首次）
2. **创建任务** — 调用 `ddb_create_task`，传入 `prompt`
3. **轮询进度** — 调用 `ddb_check_progress`，传入 `workspace_id`
4. **获取预览** — 调用 `ddb_get_preview`，传入 `workspace_id`

根目录 `scripts/` 下的 CLI 脚本为降级备用方案，日常使用推荐走 MCP。

## 文档

参见 [`docs/`](docs/) 目录了解 DeepDiver API 详情和认证机制。