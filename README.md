# DeepDiver Build — XiaoYi Claw 工具集

构建和预览 DeepDiver 应用的 CLI 工具和 Agent Skill。

## 项目结构

```
.
├── skills/deepdiver/      # Agent Skill
│   ├── SKILL.md           # Skill 定义（Headless API 驱动）
│   ├── assets/            # 截图等静态资源
│   └── scripts/
│       └── ddb.py         # CLI 工具（鉴权、HTTP、轮询等）
│
└── docs/                  # DeepDiver API 文档
    ├── deepdiver-api.md
    ├── deepdiver-auth.md
    ├── headless-api*.md   # Headless API 文档
    └── superpowers/
```

## 安装与配置

无需额外安装依赖。Skill 通过 `skills/deepdiver/scripts/ddb.py` 驱动，使用 Python 标准库。

### 配置 API Key

首次使用时，引导用户获取 API Key：

1. 打开 https://cn.deepdiver.app 并登录
2. 点击「我的」→「账号设置」→ 页面底部「生成 API 密钥」
3. 复制生成的 `sk-hdls-xxx` 格式密钥
4. 执行 `python3 skills/deepdiver/scripts/ddb.py config --key <key>` 保存

Key 保存在 `~/.deepdiver/auth.json`（权限 600），后续 session 自动读取，无需每次配置。

## Skill 使用

详见 [`skills/deepdiver/SKILL.md`](skills/deepdiver/SKILL.md)。

核心流程通过 `ddb.py` CLI 工具完成：

1. **鉴权** — `python3 ddb.py config --key <key>`（首次）
2. **创建任务** — `python3 ddb.py create --query "<描述>"`
3. **查看进度** — `python3 ddb.py status <task_id>`
4. **获取预览** — `python3 ddb.py open <workspace_id>`
5. **列出项目** — `python3 ddb.py list`

所有操作通过 Headless API 完成，`ddb.py` 负责鉴权、HTTP 请求、状态轮询等全部细节。

## 文档

参见 [`docs/`](docs/) 目录了解 DeepDiver API 详情和认证机制。
