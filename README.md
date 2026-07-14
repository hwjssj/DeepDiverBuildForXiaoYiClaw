# DeepDiver Build — XiaoYi Claw 工具集

构建和预览 DeepDiver 应用的 CLI 工具、MCP 服务器和 Claude Skill。

## 项目结构

```
.
├── mcp_server/          # MCP (Model Context Protocol) 服务器
│   ├── index.js         # 入口：MCP 工具定义、路由、启动
│   ├── lib/api.js       # DeepDiver REST API 客户端
│   └── package.json
│
├── skills/              # Claude Code Skills
│   ├── SKILL.md         # DeepDiver Task Manager Skill
│   └── scripts/         # Skill 配套脚本
│       └── create-task.js
│
└── docs/                # DeepDiver API 文档
    ├── deepdiver-api.md
    └── deepdiver-auth.md
```

## MCP 服务器

[MCP](https://modelcontextprotocol.io) 服务器将 DeepDiver Build API 封装为 AI 客户端（Claude Code、OpenClaw、Cursor 等）可直接调用的工具。

### 提供工具

| 工具 | 说明 |
|------|------|
| `ddb_login` | 登录并保存 JWT token |
| `ddb_create_task` | 创建构建任务（创建项目 + WebSocket 发送 prompt） |
| `ddb_check_progress` | 检查任务进度（文件、服务、构建状态） |
| `ddb_get_preview` | 获取预览 URL（自动启动 dev server） |
| `ddb_list_projects` | 列出所有项目及构建状态 |

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEEPDIVER_BASE_URL` | API 地址 | `https://cn.deepdiver.app` |
| `DEEPDIVER_MODEL` | 构建用模型 ID | `ddexp` |
| `DEEPDIVER_TOKEN` | JWT token（最高优先级） | — |
| `DEEPDIVER_TOKEN_FILE` | token 文件路径 | `.deepdiver-token` |

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

需要一个 Skill 来管理构建任务并轮询进度。

### 前置条件

```bash
export DEEPDIVER_EMAIL="your@email.com"
export DEEPDIVER_PASSWORD="your_password"
# 或直接提供 token
export DEEPDIVER_TOKEN="<jwt>"
```

### 创建任务

```bash
node skills/scripts/create-task.js -p "<任务描述>"
```

输出中包含 `WORKSPACE_ID`，后续轮询进度使用。

### 轮询进度

按以下顺序检查：

1. **文件生成** — `GET /api/files/${WORKSPACE_ID}?path=&max_depth=3`
2. **开发服务器** — `GET /api/dev-server-status?session_id=${WORKSPACE_ID}`
3. **构建队列** — `GET /api/projects` → `building_workspace_ids`

或使用脚本：

```bash
node skills/scripts/list-projects.js
```

### 状态解读

| 现象 | 进展 |
|------|------|
| `building_workspace_ids` 包含该 ID | AI 正在构建中 |
| 文件列表开始出现 | AI 已开始生成代码 |
| 开发服务器 `running: true` | 代码已生成，预览就绪 |
| `building_workspace_ids` 不再包含 | 构建完成 |

## 文档

参见 [`docs/`](docs/) 目录了解 DeepDiver API 详情和认证机制。
