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
