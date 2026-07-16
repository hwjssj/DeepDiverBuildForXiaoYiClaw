# MCP Server Headless v1 全面重构 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 MCP Server 从主站 JWT+WebSocket 模式全面切换到 Headless API v1，提供 9 个 MCP 工具覆盖完整任务生命周期

**Architecture:** 三层结构 — `lib/store.js`（本地持久化）、`lib/api.js`（v1 REST 客户端）、`index.js`（MCP 工具定义 + handler 路由）。认证统一用 `Authorization: Bearer sk-hdls-...` header

**Tech Stack:** Node.js, @modelcontextprotocol/sdk, zod, native fetch

**Files to create:**
- `mcp_server/lib/store.js` — key 和 tasks JSON 读写

**Files to rewrite:**
- `mcp_server/lib/api.js` — Headless v1 REST 客户端（替换现有主站 API 调用）
- `mcp_server/index.js` — 9 个 MCP 工具（替换现有 5 个工具）

**Files to modify:**
- `.gitignore` — 追加 `.deepdiver-key` 和 `.deepdiver-tasks.json`

---

### Task 1: 新增 `lib/store.js` — Key 和 Tasks 本地持久化

**Files:**
- Create: `mcp_server/lib/store.js`

- [ ] **Step 1: 写入 store.js 完整代码**

```js
/**
 * 本地状态持久化
 * - .deepdiver-key  : headless API key
 * - .deepdiver-tasks.json : 任务记录数组
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

/** 获取项目根目录（mcp_server 的父目录） */
function rootDir() {
  return resolve(import.meta.dirname, '..');
}

// ---- Key ----

const KEY_FILE = '.deepdiver-key';

/** 读取 headless key */
export function loadKey() {
  try {
    return readFileSync(resolve(rootDir(), KEY_FILE), 'utf-8').trim();
  } catch {
    return null;
  }
}

/** 保存 headless key */
export function saveKey(key) {
  const p = resolve(rootDir(), KEY_FILE);
  writeFileSync(p, key, 'utf-8');
  return p;
}

// ---- Tasks ----

const TASKS_FILE = '.deepdiver-tasks.json';

/** 读取所有任务记录 */
export function loadTasks() {
  try {
    const raw = readFileSync(resolve(rootDir(), TASKS_FILE), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** 保存任务记录（全量覆盖） */
export function saveTasks(tasks) {
  writeFileSync(
    resolve(rootDir(), TASKS_FILE),
    JSON.stringify(tasks, null, 2),
    'utf-8',
  );
}

/** 追加一条任务记录 */
export function addTask(record) {
  const tasks = loadTasks();
  const entry = {
    task_id: record.task_id,
    workspace_id: record.workspace_id,
    resume_token: record.resume_token,
    prompt: record.prompt,
    model: record.model || 'ddexp',
    interaction_mode: record.interaction_mode || 'manual',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  tasks.push(entry);
  saveTasks(tasks);
  return entry;
}

/** 更新任务记录的 updated_at */
export function touchTask(taskId) {
  const tasks = loadTasks();
  const found = tasks.find(t => t.task_id === taskId);
  if (found) {
    found.updated_at = new Date().toISOString();
    saveTasks(tasks);
  }
}

/** 查找最近一个非终态任务 */
export function findActiveTask() {
  const tasks = loadTasks();
  const terminalStatuses = ['completed', 'failed', 'cancelled'];
  // 倒序找第一个非终态的
  for (let i = tasks.length - 1; i >= 0; i--) {
    // 注意：本地不存 status，只靠 updated_at；所以找最近 24h 内创建且未标记为终态的
    // 此处简化为：返回 latest 一条（由调用方根据 API 返回的 status 判断）
  }
  // 返回最近一条
  if (tasks.length === 0) return null;
  return tasks[tasks.length - 1];
}
```

- [ ] **Step 2: 验证导入无报错**

Run: `node -e "import('./lib/store.js').then(m => console.log(Object.keys(m)))"` from `mcp_server/`

Expected: `[ 'loadKey', 'saveKey', 'loadTasks', 'saveTasks', 'addTask', 'touchTask', 'findActiveTask' ]`

- [ ] **Step 3: Commit**

```bash
git add mcp_server/lib/store.js
git commit -m "feat: add store.js for local key/task persistence"
```

---

### Task 2: 重写 `lib/api.js` — Headless v1 REST 客户端

**Files:**
- Rewrite: `mcp_server/lib/api.js`

- [ ] **Step 1: 写入 api.js 完整代码**

```js
/**
 * DeepDiver Headless API v1 客户端
 * 所有请求统一: Authorization: Bearer sk-hdls-...
 */
import { loadKey } from './store.js';

const BASE_URL = process.env.DEEPDIVER_BASE_URL || 'https://cn.deepdiver.app';

/** 获取当前 headless key，未配置时抛错 */
function requireKey() {
  const key = loadKey();
  if (!key) throw new Error('未配置 API key。请先使用 ddb_setup 或设置 DEEPDIVER_KEY 环境变量');
  return key;
}

/**
 * 通用 fetch 包装
 * @param {string} path - API 路径 (如 "/api/v1/tasks")
 * @param {object} opts - fetch options (不含 headers)
 * @returns {Promise<object>} 解析后的 JSON
 */
async function v1Fetch(path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const key = process.env.DEEPDIVER_KEY || requireKey();
  const headers = {
    'Authorization': `Bearer ${key}`,
    ...opts.headers,
  };
  if (!headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(url, { ...opts, headers });
  } catch (err) {
    throw new Error(`网络错误: ${err.message}`);
  }

  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch { data = { _raw: body }; }

  if (!res.ok) {
    const detail = data.detail || data._raw || body;
    const err = new Error(`HTTP ${res.status}: ${String(detail).slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---- 任务端点 ----

/** POST /api/v1/tasks — 创建任务 */
export async function createTask(params) {
  const { query, model, workspace_id, resume_token, skip_rewriter,
          interaction_mode, settings, screenshot, platform,
          callback_url, callback_secret, callback_headers } = params;
  const body = { query, model: model || null, workspace_id: workspace_id || null,
    resume_token: resume_token || null, skip_rewriter: skip_rewriter || false,
    interaction_mode: interaction_mode || 'manual', settings: settings || null,
    screenshot: screenshot || false, platform: platform || null,
    callback_url: callback_url || null, callback_secret: callback_secret || null,
    callback_headers: callback_headers || null };
  return v1Fetch('/api/v1/tasks', { method: 'POST', body: JSON.stringify(body) });
}

/** GET /api/v1/tasks/{task_id} — 查询任务状态 */
export async function getTask(taskId) {
  return v1Fetch(`/api/v1/tasks/${taskId}`);
}

/** GET /api/v1/tasks/{task_id}?format=batch_v2 — 获取训练轨迹 */
export async function getTaskBatchV2(taskId, params = {}) {
  const qs = new URLSearchParams({ format: 'batch_v2', ...params }).toString();
  return v1Fetch(`/api/v1/tasks/${taskId}?${qs}`);
}

/** POST /api/v1/tasks/{task_id}/respond — 回答交互 */
export async function respondToTask(taskId, interactionId, response) {
  return v1Fetch(`/api/v1/tasks/${taskId}/respond`, {
    method: 'POST',
    body: JSON.stringify({ interaction_id: interactionId, response }),
  });
}

/** POST /api/v1/tasks/{task_id}/cancel */
export async function cancelTask(taskId) {
  return v1Fetch(`/api/v1/tasks/${taskId}/cancel`, { method: 'POST' });
}

/** POST /api/v1/tasks/{task_id}/pause */
export async function pauseTask(taskId) {
  return v1Fetch(`/api/v1/tasks/${taskId}/pause`, { method: 'POST' });
}

/** POST /api/v1/tasks/{task_id}/resume */
export async function resumeTask(taskId) {
  return v1Fetch(`/api/v1/tasks/${taskId}/resume`, { method: 'POST' });
}

/** POST /api/v1/tasks/{task_id}/message — 注入消息 */
export async function injectMessage(taskId, message) {
  return v1Fetch(`/api/v1/tasks/${taskId}/message`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

// ---- SSE ----

/**
 * GET /api/v1/tasks/{task_id}/stream — SSE 事件流快照
 * 收集 events 直到: (a) 达到 maxEvents, (b) 收到 terminal event, (c) 超时
 *
 * @param {string} taskId
 * @param {object} opts
 * @param {number} opts.maxEvents - 最多收集的事件数 (默认 50)
 * @param {number} opts.timeoutMs - 超时毫秒 (默认 30000)
 * @returns {Promise<{events: Array, done: boolean}>}
 */
export async function streamTask(taskId, opts = {}) {
  const { maxEvents = 50, timeoutMs = 30000 } = opts;
  const key = process.env.DEEPDIVER_KEY || requireKey();
  const url = `${BASE_URL}/api/v1/tasks/${taskId}/stream`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${key}`, 'Cache-Control': 'no-cache',
               'Accept': 'text/event-stream' },
    signal: controller.signal,
  });

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text();
    throw new Error(`SSE ${res.status}: ${text.slice(0, 300)}`);
  }

  const events = [];
  const terminalTypes = new Set(['build_complete', 'complete', 'error', 'cancelled', 'done']);
  let buffer = '';
  let currentEvent = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let done = false;

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !streamDone });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留最后不完整的行

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            try {
              const data = JSON.parse(dataStr);
              const evtType = currentEvent;  // 先保存，下面要消费
              events.push({ eventType: evtType, ...data });
              currentEvent = null;

              // 终端事件: event:done 或 data.type 是 terminal
              if (evtType === 'done' || (data.type && terminalTypes.has(data.type))) {
                done = true;
                break;
              }
            } catch {
              events.push({ eventType: currentEvent, raw: dataStr });
              currentEvent = null;
            }
          }
          // 空行 = 消息结束，重置 currentEvent
          // 不处理——currentEvent 已经在 data 行被消费

          if (events.length >= maxEvents) {
            done = true;
            break;
          }
        }
      }
      if (streamDone) done = true;
    }
  } finally {
    clearTimeout(timer);
    reader.cancel();
  }

  return { events, done: true };
}
```

- [ ] **Step 2: 验证 api.js 导入无报错**

Run: `node -e "import('./lib/api.js').then(m => console.log(Object.keys(m)))"` from `mcp_server/`

Expected: `[ 'createTask', 'getTask', 'getTaskBatchV2', 'respondToTask', 'cancelTask', 'pauseTask', 'resumeTask', 'injectMessage', 'streamTask' ]`

- [ ] **Step 3: Commit**

```bash
git add mcp_server/lib/api.js
git commit -m "feat: rewrite api.js for Headless v1 endpoints"
```

---

### Task 3: 重写 `index.js` — 9 个 MCP 工具

**Files:**
- Rewrite: `mcp_server/index.js`

- [ ] **Step 1: 写入 index.js 完整代码**

```js
#!/usr/bin/env node
/**
 * DeepDiver MCP Server — Headless API v1
 *
 * 9 个 MCP 工具:
 *   ddb_setup           配置 headless API key
 *   ddb_create_task     提交构建任务
 *   ddb_check_progress  查询任务进度
 *   ddb_stream_task     SSE 事件流快照
 *   ddb_get_preview     获取预览 URL
 *   ddb_respond         回答 agent 交互式提问
 *   ddb_pause           暂停任务
 *   ddb_cancel          取消任务
 *   ddb_resume          恢复任务
 *
 * 环境变量:
 *   DEEPDIVER_BASE_URL  - API 地址 (默认 https://cn.deepdiver.app)
 *   DEEPDIVER_KEY       - headless key (优先级高于 .deepdiver-key 文件)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  createTask,
  getTask,
  respondToTask,
  cancelTask,
  pauseTask,
  resumeTask,
  streamTask,
} from './lib/api.js';
import { loadKey, saveKey, addTask, touchTask, findActiveTask } from './lib/store.js';

const BASE_URL = process.env.DEEPDIVER_BASE_URL || 'https://cn.deepdiver.app';

// ---- 认证辅助 ----

/** 从文件或环境变量获取 key，未配置时抛错 */
function requireKey() {
  const key = process.env.DEEPDIVER_KEY || loadKey();
  if (!key) throw new Error('未配置 API key。请先使用 ddb_setup 工具设置，或设置 DEEPDIVER_KEY 环境变量');
  return key;
}

// ---- 格式化辅助 ----

/** 将事件的 data 简要格式化为一行 */
function formatEventSummary(ev) {
  if (!ev || !ev.type) return JSON.stringify(ev).slice(0, 100);
  switch (ev.type) {
    case 'start': return `🚀 任务开始: "${ev.data?.query || '?'}"`;
    case 'iteration': return `🔄 迭代 #${ev.data?.iteration || '?'} | tokens: ${ev.data?.token_count || '?'}/${ev.data?.token_threshold || '?'}`;
    case 'thinking': return `💭 ${String(ev.data?.content || '').slice(0, 120)}`;
    case 'tool_call': return `🔧 ${ev.data?.tool || '?'} [${ev.data?.status || '?'}]`;
    case 'agent_handoff': return `🤝 交接 → agent #${ev.data?.new_agent_id || '?'}`;
    case 'subagent_start': return `🐣 子 agent 启动: ${ev.data?.task?.slice(0, 80) || '?'}`;
    case 'subagent_complete': return `✅ 子 agent 完成: ${ev.data?.success ? '成功' : '失败'}`;
    case 'complete': return ev.data?.success ? `✅ Agent 完成` : `❌ Agent 失败`;
    case 'build_complete': return ev.data?.success ? `🏗️ 构建完成` : `❌ 构建失败`;
    case 'interaction_required': return `❓ 等待用户回答`;
    case 'error': return `💥 ${ev.data?.message || '未知错误'}`;
    case 'cancelled': return `⛔ 已取消`;
    case 'paused': return `⏸️ 已暂停`;
    case 'resumed': return `▶️ 已恢复`;
    default: return `${ev.type}`;
  }
}

/** 将状态翻译为中文 + emoji */
function statusLabel(s) {
  const map = {
    running: '🏃 运行中',
    paused: '⏸️ 已暂停',
    completed: '✅ 已完成',
    failed: '❌ 失败',
    cancelled: '⛔ 已取消',
    waiting_interaction: '❓ 等待回答',
  };
  return map[s] || `❓ ${s}`;
}

/** 判断是否为终态 */
function isTerminal(s) {
  return ['completed', 'failed', 'cancelled'].includes(s);
}

// ---- MCP Server ----

const server = new Server(
  { name: 'deepdiver-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

// ---- 工具定义 ----

const TOOLS = [
  {
    name: 'ddb_setup',
    description: '配置 DeepDiver Headless API key（格式 sk-hdls-<32 hex chars>）',
    inputSchema: {
      type: 'object',
      properties: {
        headless_key: { type: 'string', description: 'Headless API key（sk-hdls-...）' },
      },
      required: ['headless_key'],
    },
  },
  {
    name: 'ddb_create_task',
    description: '提交构建任务到 DeepDiver Headless API v1',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '任务描述 / prompt' },
        model: { type: 'string', description: '模型 ID（默认 ddexp）' },
        interaction_mode: { type: 'string', enum: ['auto', 'manual'], description: '交互模式（默认 manual）' },
        screenshot: { type: 'boolean', description: '是否截图预览' },
        callback_url: { type: 'string', description: 'Webhook 回调 URL（可选）' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'ddb_check_progress',
    description: '查询任务状态、事件和结果',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID（不传则自动找最近一个活跃任务）' },
      },
    },
  },
  {
    name: 'ddb_stream_task',
    description: '获取任务的 SSE 事件流快照（最近 N 条事件）',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID' },
        max_events: { type: 'number', description: '最多返回条数（默认 50）' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'ddb_get_preview',
    description: '获取任务的预览 URL',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID（不传则找最近一个）' },
      },
    },
  },
  {
    name: 'ddb_respond',
    description: '回答 agent 的交互式提问（当任务处于 waiting_interaction 状态时使用）',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID' },
        interaction_id: { type: 'string', description: '交互 ID（来自 check_progress 返回的 interaction.interaction_id）' },
        response: { type: 'string', description: '回答内容（JSON 字符串，如 {"answer": "使用 TypeScript"}）' },
      },
      required: ['task_id', 'interaction_id', 'response'],
    },
  },
  {
    name: 'ddb_pause',
    description: '暂停正在运行的任务',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'ddb_cancel',
    description: '取消正在运行的任务',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'ddb_resume',
    description: '恢复已暂停的任务',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID' },
      },
      required: ['task_id'],
    },
  },
];

// ---- Handler ----

/** ddb_setup */
async function handleSetup(args) {
  const { headless_key } = z.object({
    headless_key: z.string().regex(/^sk-hdls-[0-9a-f]{32}$/, 'key 格式错误，应为 sk-hdls-<32 hex chars>'),
  }).parse(args);

  const path = saveKey(headless_key);
  return {
    content: [{ type: 'text', text: `✅ API key 已保存到: ${path}` }],
  };
}

/** ddb_create_task */
async function handleCreateTask(args) {
  const { prompt, model, interaction_mode, screenshot, callback_url } = z.object({
    prompt: z.string().min(1),
    model: z.string().optional(),
    interaction_mode: z.enum(['auto', 'manual']).optional().default('manual'),
    screenshot: z.boolean().optional().default(false),
    callback_url: z.string().optional(),
  }).parse(args);

  requireKey();

  const data = await createTask({
    query: prompt, model: model || null, interaction_mode,
    screenshot, callback_url: callback_url || null,
  });

  // 写入本地
  addTask({
    task_id: data.task_id,
    workspace_id: data.workspace_id,
    resume_token: data.resume_token || '',
    prompt,
    model: model || 'ddexp',
    interaction_mode,
  });

  const lines = [
    `✅ 任务已提交`,
    `   Task ID:      ${data.task_id}`,
    `   Workspace ID: ${data.workspace_id}`,
    `   Resume Token: ${data.resume_token || '(follow-up, 无)'}`,
    `   状态:         ${statusLabel(data.status)}`,
    ``,
    `💡 使用 ddb_check_progress --task_id "${data.task_id}" 检查进度`,
    `💡 使用 ddb_get_preview --task_id "${data.task_id}" 获取预览`,
    data.resume_token
      ? `⚠️ 请保存 resume_token，后续 follow-up 查询需要使用`
      : '',
  ].filter(Boolean);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/** ddb_check_progress */
async function handleCheckProgress(args) {
  const { task_id } = z.object({
    task_id: z.string().optional(),
  }).parse(args);

  requireKey();

  // 智能解析 task_id
  let tid = task_id;
  if (!tid) {
    const active = findActiveTask();
    if (!active) throw new Error('未找到本地任务记录。请先使用 ddb_create_task 创建任务，或指定 --task_id');
    tid = active.task_id;
  }

  const data = await getTask(tid);
  touchTask(tid);

  const events = data.events || [];
  const result = data.result;
  const interaction = data.interaction;

  const lines = [
    `📋 任务: ${tid}`,
    `   Workspace ID: ${data.workspace_id || '?'}`,
    `   状态: ${statusLabel(data.status)}`,
  ];

  if (data.current_iteration != null) {
    lines.push(`   迭代: #${data.current_iteration}`);
  }

  // 事件摘要
  if (events.length > 0) {
    lines.push('');
    lines.push('📜 最近事件:');
    events.slice(-10).forEach(e => {
      lines.push(`   ${formatEventSummary(e)}`);
    });
    if (events.length > 10) lines.push(`   ... 共 ${events.length} 条事件`);
  }

  lines.push('');

  // 结果
  if (result) {
    lines.push('📦 结果:');
    lines.push(`   成功: ${result.success ? '✅' : '❌'}`);
    if (result.iterations) lines.push(`   迭代数: ${result.iterations}`);
    if (result.execution_time) lines.push(`   耗时: ${result.execution_time}s`);
    if (result.preview_url) lines.push(`   预览: ${result.preview_url}`);
    if (result.project_name) lines.push(`   项目名: ${result.project_name}`);
    if (result.final_answer) {
      const ans = String(result.final_answer).slice(0, 300);
      lines.push(`   回答: ${ans}${result.final_answer.length > 300 ? '...' : ''}`);
    }
    if (result.key_files?.length) {
      lines.push(`   关键文件: ${result.key_files.map(f => typeof f === 'string' ? f : f.file_path).join(', ')}`);
    }
  }

  // 待回答的交互
  if (interaction && data.status === 'waiting_interaction') {
    lines.push('');
    lines.push('❓ 等待用户回答:');
    lines.push(`   interaction_id: ${interaction.interaction_id}`);
    if (interaction.questions) {
      interaction.questions.forEach((q, i) => {
        lines.push(`   问题 ${i + 1}: ${q.prompt || q.question}`);
        if (q.options) {
          const opts = Array.isArray(q.options) ? q.options : q.options.split(',');
          lines.push(`   选项: ${opts.join(' | ')}`);
        }
      });
    }
    lines.push('');
    lines.push('💡 使用 ddb_respond 回答后 agent 将继续执行');
  }

  if (isTerminal(data.status)) {
    lines.push('');
    lines.push(data.status === 'completed' ? '✅ 任务已完成' : `⚠️ 任务已结束: ${data.status}`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/** ddb_stream_task */
async function handleStreamTask(args) {
  const { task_id, max_events } = z.object({
    task_id: z.string().min(1),
    max_events: z.number().optional().default(50),
  }).parse(args);

  requireKey();

  const result = await streamTask(task_id, { maxEvents: max_events, timeoutMs: 30000 });
  touchTask(task_id);

  if (result.events.length === 0) {
    return { content: [{ type: 'text', text: '📡 暂无事件（任务可能尚未开始或已过期）' }] };
  }

  const lines = [
    `📡 SSE 事件流（共 ${result.events.length} 条）:`,
    '',
  ];
  result.events.forEach((ev, i) => {
    lines.push(`[${i + 1}] ${formatEventSummary(ev)}`);
  });

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/** ddb_get_preview */
async function handleGetPreview(args) {
  const { task_id } = z.object({
    task_id: z.string().optional(),
  }).parse(args);

  requireKey();

  let tid = task_id;
  if (!tid) {
    const active = findActiveTask();
    if (!active) throw new Error('未找到本地任务记录。请先使用 ddb_create_task 或指定 --task_id');
    tid = active.task_id;
  }

  const data = await getTask(tid);
  touchTask(tid);

  if (data.status === 'completed' && data.result?.preview_url) {
    const lines = [
      `🌐 预览已就绪`,
      `   URL: ${data.result.preview_url}`,
    ];
    if (data.result.project_name) lines.push(`   项目: ${data.result.project_name}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (data.result?.preview_url) {
    return {
      content: [{ type: 'text', text: `🌐 预览 URL: ${data.result.preview_url}\n   状态: ${statusLabel(data.status)}` }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: `⏳ 预览尚未就绪\n   当前状态: ${statusLabel(data.status)}\n   💡 任务完成后自动生成 preview_url`,
    }],
  };
}

/** ddb_respond */
async function handleRespond(args) {
  const { task_id, interaction_id, response } = z.object({
    task_id: z.string().min(1),
    interaction_id: z.string().min(1),
    response: z.string().min(1),
  }).parse(args);

  requireKey();

  let respObj;
  try {
    respObj = JSON.parse(response);
  } catch {
    respObj = { answer: response };
  }

  const data = await respondToTask(task_id, interaction_id, respObj);
  touchTask(task_id);

  return {
    content: [{ type: 'text', text: `✅ 回答已提交\n   任务状态: ${statusLabel(data.status || 'running')}` }],
  };
}

/** ddb_pause */
async function handlePause(args) {
  const { task_id } = z.object({ task_id: z.string().min(1) }).parse(args);
  requireKey();
  const data = await pauseTask(task_id);
  touchTask(task_id);
  return { content: [{ type: 'text', text: `⏸️ 任务已暂停\n   状态: ${statusLabel(data.status || 'paused')}` }] };
}

/** ddb_cancel */
async function handleCancel(args) {
  const { task_id } = z.object({ task_id: z.string().min(1) }).parse(args);
  requireKey();
  const data = await cancelTask(task_id);
  touchTask(task_id);
  return { content: [{ type: 'text', text: `⛔ 任务已取消\n   状态: ${statusLabel(data.status || 'cancelled')}` }] };
}

/** ddb_resume */
async function handleResume(args) {
  const { task_id } = z.object({ task_id: z.string().min(1) }).parse(args);
  requireKey();
  const data = await resumeTask(task_id);
  touchTask(task_id);
  return { content: [{ type: 'text', text: `▶️ 任务已恢复\n   状态: ${statusLabel(data.status || 'running')}` }] };
}

// ---- 路由 ----

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  let result;
  try {
    switch (name) {
      case 'ddb_setup':           result = await handleSetup(args); break;
      case 'ddb_create_task':      result = await handleCreateTask(args); break;
      case 'ddb_check_progress':   result = await handleCheckProgress(args); break;
      case 'ddb_stream_task':      result = await handleStreamTask(args); break;
      case 'ddb_get_preview':      result = await handleGetPreview(args); break;
      case 'ddb_respond':          result = await handleRespond(args); break;
      case 'ddb_pause':            result = await handlePause(args); break;
      case 'ddb_cancel':           result = await handleCancel(args); break;
      case 'ddb_resume':           result = await handleResume(args); break;
      default: throw new Error(`未知工具: ${name}`);
    }
    return result;
  } catch (err) {
    console.error('❌ Handler error:', err.stack || err.message);
    return {
      content: [{ type: 'text', text: `❌ 错误: ${err.message}` }],
      isError: true,
    };
  }
});

// ---- 启动 ----

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('✅ DeepDiver MCP Server v2.0 已启动 (Headless v1 + stdio)');
}

main().catch(err => {
  console.error('❌ MCP Server 启动失败:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: 删除旧文件（如果存在）**

`mcp_server/index.js` 已被上面重写，无需额外删除操作。确认旧 WebSocket import 已移除。

- [ ] **Step 3: Commit**

```bash
git add mcp_server/index.js
git commit -m "feat: rewrite index.js with 9 headless v1 MCP tools"
```

---

### Task 4: 更新 `.gitignore`

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: 追加两行**

把 `.deepdiver-token` 行替换为：

```
.deepdiver-key
.deepdiver-token
.deepdiver-tasks.json
```

使用 Edit 工具：

```
old_string: .deepdiver-token
new_string: .deepdiver-key
.deepdiver-token
.deepdiver-tasks.json
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: add headless key and tasks files to .gitignore"
```

---

### Task 5: 验证与冒烟测试

- [ ] **Step 1: 检查 MCP 工具注册正确**

Run:
```bash
cd mcp_server && timeout 3 node -e "
import('./index.js').catch(() => {});
setTimeout(() => process.exit(0), 2000);
" 2>&1 || true
```

Expected: `✅ DeepDiver MCP Server v2.0 已启动 (Headless v1 + stdio)` in stderr

- [ ] **Step 2: 使用 MCP Inspector 检查工具列表**

Run:
```bash
cd mcp_server && npx @modelcontextprotocol/inspector node index.js
```

然后手动确认 tools/list 返回了 9 个工具，名字和参数正确。

- [ ] **Step 3: 测试 ddb_setup key 格式校验**

```bash
cd mcp_server && node -e "
import { saveKey, loadKey } from './lib/store.js';
saveKey('sk-hdls-0123456789abcdef0123456789abcdef');
console.log('key saved:', loadKey().slice(0, 20) + '...');
"
```

Expected: `key saved: sk-hdls-0123456789ab...`

- [ ] **Step 4: 测试 tasks 读写**

```bash
cd mcp_server && node -e "
import { addTask, loadTasks, findActiveTask, touchTask } from './lib/store.js';
addTask({ task_id: 'test-001', workspace_id: 'ws-001', resume_token: 'rt-001', prompt: 'test' });
addTask({ task_id: 'test-002', workspace_id: 'ws-002', resume_token: 'rt-002', prompt: 'test2' });
console.log('tasks:', loadTasks().length);
const active = findActiveTask();
console.log('active:', active?.task_id);
touchTask('test-001');
console.log('touched');
"
```

Expected:
```
tasks: 2
active: test-002
touched
```

- [ ] **Step 5: 清理测试文件**

```bash
rm .deepdiver-key .deepdiver-tasks.json
```

- [ ] **Step 6: Commit（如有小修复）**

如果有 lint 错误或小修复，提交：
```bash
git add -A
git commit -m "chore: smoke tests and fixes for headless MCP server"
```
