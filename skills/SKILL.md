# DeepDiver Task Manager

创建 DeepDiver 构建任务，并通过 REST API 轮询进度，每 ~5 分钟用自然语言汇报进展。

## 前置条件

```bash
export DEEPDIVER_EMAIL="your@email.com"
export DEEPDIVER_PASSWORD="your_password"
# 或直接提供 token
export DEEPDIVER_TOKEN="<jwt>"
```

## 流程

### 1. 认证 & 创建任务

```bash
node skills/scripts/create-task.js -p "<任务描述>"
```

输出中提取关键字段：
- `WORKSPACE_ID` — 后续轮询用
- `SESSION_ID` — 服务端 session
- `PROJECT_ID` — 项目 ID

### 2. 轮询进度（每 ~5 分钟）

不使用 WebSocket 实时监听，改为 REST API 定时检查：

```bash
# ① 检查文件是否开始生成
curl -s -H "Authorization: Bearer $DEEPDIVER_TOKEN" \
  "https://cn.deepdiver.app/api/files/${WORKSPACE_ID}?path=&max_depth=3"

# ② 检查开发服务器是否就绪
curl -s -H "Authorization: Bearer $DEEPDIVER_TOKEN" \
  "https://cn.deepdiver.app/api/dev-server-status?session_id=${WORKSPACE_ID}"

# ③ 检查项目是否在构建队列
curl -s -H "Authorization: Bearer $DEEPDIVER_TOKEN" \
  "https://cn.deepdiver.app/api/projects" | jq '.building_workspace_ids'
```

或直接使用脚本（依赖已有 token）：

```bash
node skills/scripts/list-projects.js       # 看项目列表 + 构建状态
```

### 3. 进度状态解读

| 现象 | 进展 |
|------|------|
| `building_workspace_ids` 包含该 ID | AI 正在构建中 |
| 文件列表开始出现 | AI 已开始生成代码 |
| 开发服务器 `running: true` | 代码已生成，预览就绪 |
| `building_workspace_ids` 不再包含 | 构建完成 |
| 项目 `name_source` 从 `default` 变更为其他 | AI 已自动重命名（接近完成） |

### 4. 汇报格式

每次轮询后，用自然语言总结，格式参考：

> **任务进度更新** (已进行 X 分钟)
> - 状态: 🏗️ 构建中 / ✅ 已完成 / ⏳ 排队中
> - 已生成 X 个文件 (总大小 Y KB)
> - 最近文件: ...
> - 开发服务器: 已就绪 / 未启动
> - 下一步: ...

## 注意事项

- Token 有效期 24 小时，过期需重新登录
- 构建完成后文件列表不会再变化，开发服务器 URL 可用于预览
- 无需保持 WebSocket 长连接，REST 轮询足够获取进度
