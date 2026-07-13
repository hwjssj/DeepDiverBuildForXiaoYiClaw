#!/usr/bin/env node
/**
 * DeepDiver MCP Server
 *
 * 提供 DeepDiver Build API 的 MCP 工具：
 * - ddb_login           登录并保存 token
 * - ddb_create_task     创建构建任务并返回项目信息
 * - ddb_check_progress  检查任务进度（文件、服务、构建状态）
 * - ddb_get_preview     获取预览 URL（自动启动 dev server）
 * - ddb_list_projects   查看所有项目及状态
 *
 * 环境变量:
 *   DEEPDIVER_BASE_URL  - API 地址 (默认 https://cn.deepdiver.app)
 *   DEEPDIVER_MODEL     - 模型 ID (默认 ddexp)
 *   DEEPDIVER_TOKEN_FILE - token 文件路径 (默认 .deepdiver-token)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  login,
  listProjects,
  createProject,
  getFiles,
  getDevServerStatus,
  startDevServer,
  getUserInfo,
  saveToken,
} from './lib/api.js';

/** 获取 token：优先环境变量，其次文件 */
function resolveToken() {
  if (process.env.DEEPDIVER_TOKEN) return process.env.DEEPDIVER_TOKEN;
  try {
    const f = resolve(process.env.DEEPDIVER_TOKEN_FILE || '.deepdiver-token');
    return readFileSync(f, 'utf-8').trim();
  } catch {
    return null;
  }
}

/** 检查 token，未登录时抛错 */
function requireToken() {
  const token = resolveToken();
  if (!token) throw new Error('未登录。请先使用 ddb_login 登录，或设置 DEEPDIVER_TOKEN 环境变量');
  return token;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: 'deepdiver-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'ddb_login',
    description: '登录 DeepDiver 并保存 JWT token 到文件',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: '登录邮箱' },
        password: { type: 'string', description: '登录密码' },
      },
      required: ['email', 'password'],
    },
  },
  {
    name: 'ddb_create_task',
    description: '创建 DeepDiver 构建任务（项目 + WebSocket 发送 prompt），返回项目信息和预览 URL',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '任务描述 / prompt' },
        model: { type: 'string', description: '模型 ID，默认 ddexp' },
        workspace_id: { type: 'string', description: '可选，指定已有 workspace_id（跳过项目创建）' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'ddb_check_progress',
    description: '检查任务进度：文件列表、开发服务器状态、构建队列状态',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'workspace_id（从 create_task 返回获得）' },
      },
      required: ['workspace_id'],
    },
  },
  {
    name: 'ddb_get_preview',
    description: '获取预览 URL（自动启动开发服务器并等待就绪）',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'workspace_id' },
        wait_seconds: { type: 'number', description: '等待超时秒数，默认 60', default: 60 },
      },
      required: ['workspace_id'],
    },
  },
  {
    name: 'ddb_list_projects',
    description: '列出所有项目及构建状态',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

/** ddb_login */
async function handleLogin(args) {
  const { email, password } = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }).parse(args);

  const data = await login(email, password);
  const token = data.access_token;
  if (!token) throw new Error('登录响应中未找到 access_token');

  const path = saveToken(token);
  const user = data.user || {};

  return {
    content: [{
      type: 'text',
      text: `✅ 登录成功\n用户: ${user.display_name || user.email || '?'}\n邮箱: ${user.email || '?'}\nToken 已保存到: ${path}`,
    }],
  };
}

/** ddb_list_projects */
async function handleListProjects() {
  const data = await listProjects();
  const projects = data.projects || [];
  const building = data.building_workspace_ids || [];

  if (projects.length === 0) {
    return { content: [{ type: 'text', text: '暂无项目' }] };
  }

  const lines = [`共 ${data.total || projects.length} 个项目，${building.length} 个正在构建`, ''];
  for (const p of projects) {
    const isBuilding = building.includes(p.workspace_id);
    lines.push(`${isBuilding ? '🏗️' : '✅'} ${p.name}`);
    lines.push(`   ID: ${p.id}`);
    lines.push(`   workspace_id: ${p.workspace_id}`);
    lines.push(`   模型: ${p.settings?.model || '?'}`);
    lines.push(`   创建: ${p.created_at ? new Date(p.created_at).toLocaleString() : '?'}`);
    lines.push('');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/** ddb_create_task */
async function handleCreateTask(args) {
  const schema = z.object({
    prompt: z.string().min(1),
    model: z.string().optional().default('ddexp'),
    workspace_id: z.string().optional(),
  });
  const { prompt, model, workspace_id: existingWsId } = schema.parse(args);

  const token = requireToken();
  const workspaceId = existingWsId || crypto.randomUUID();
  const resumeToken = existingWsId ? '(existing)' : crypto.randomBytes(32).toString('base64url');
  const projectName = `Project ${workspaceId.slice(0, 8)}`;

  // 创建项目
  let project;
  if (!existingWsId) {
    project = await createProject(token, {
      workspaceId,
      name: projectName,
      resumeToken,
      model,
    });
  }

  // 通过 WebSocket 发送 prompt
  const wsUrl = `wss://cn.deepdiver.app/ws/agent?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.close(); reject(new Error('WS 连接超时')); }, 15000);
    ws.addEventListener('open', () => {
      clearTimeout(t);
      ws.send(JSON.stringify({ session_id: workspaceId }));
      setTimeout(() => {
        ws.send(JSON.stringify({
          model,
          settings: { model_temperature: 0.7, model_max_tokens: 64000 },
        }));
      }, 200);
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'query', query: prompt, is_followup: false,
        }));
      }, 400);
      setTimeout(() => { ws.close(); resolve(); }, 1000);
    }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WS 连接失败')); }, { once: true });
  });

  const previewUrl = existingWsId
    ? `https://deepdiver.app/preview/${workspaceId}/?token=${resumeToken}`
    : `https://deepdiver.app/preview/${workspaceId}/?token=${resumeToken}`;

  const lines = [
    `✅ 任务已创建`,
    `   项目 ID: ${project?.id || '(existing)'}`,
    `   Workspace ID: ${workspaceId}`,
    `   模型: ${model}`,
    `   Prompt: ${prompt}`,
    `   预览 URL: ${previewUrl}`,
    ``,
    `💡 使用 ddb_check_progress --workspace_id "${workspaceId}" 检查进度`,
    `💡 使用 ddb_get_preview --workspace_id "${workspaceId}" 获取预览`,
  ];

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    _meta: { workspace_id: workspaceId, preview_url: previewUrl },
  };
}

/** ddb_check_progress */
async function handleCheckProgress(args) {
  const { workspace_id } = z.object({ workspace_id: z.string().min(1) }).parse(args);
  const token = requireToken();

  let files = null, dev = null, proj = null;
  try { files = await getFiles(token, workspace_id); } catch {}
  try { dev = await getDevServerStatus(token, workspace_id); } catch {}
  try { proj = await listProjects(token); } catch {}

  const building = proj?.building_workspace_ids?.includes(workspace_id);
  const fileList = files?.files || [];
  const devRunning = dev?.success && dev?.metadata?.running;

  const parts = [];
  if (building) parts.push('🏗️ 任务正在构建中');
  else if (devRunning) parts.push('✅ 任务已完成');
  else parts.push('⏳ 任务执行中');

  const totalSize = fileList.reduce((s, f) => s + (f.size || 0), 0);
  const sorted = [...fileList].filter(f => f.type === 'file')
    .sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));

  parts.push('');
  parts.push(`📁 文件: ${fileList.length} 个 (${(totalSize/1024).toFixed(0)} KB)`);
  sorted.slice(0, 5).forEach(f => parts.push(`   · ${f.path}`));
  parts.push('');

  if (devRunning) {
    parts.push(`🌐 开发服务器: 已就绪 ${dev.metadata.url}`);
  } else if (dev?.metadata) {
    parts.push('🌐 开发服务器: 未启动');
  } else {
    parts.push('🌐 开发服务器: 查询失败');
  }
  parts.push('');

  if (proj) {
    parts.push(`📋 总项目: ${proj.total || '?'} | 构建中: ${proj.building_workspace_ids?.length || 0}`);
  }

  return { content: [{ type: 'text', text: parts.join('\n') }] };
}

/** ddb_get_preview */
async function handleGetPreview(args) {
  const { workspace_id, wait_seconds } = z.object({
    workspace_id: z.string().min(1),
    wait_seconds: z.number().optional().default(60),
  }).parse(args);

  const token = requireToken();

  // 先检查是否已运行
  const status = await getDevServerStatus(token, workspace_id);
  if (status.success && status.metadata?.running) {
    return {
      content: [{
        type: 'text',
        text: `🌐 预览已就绪\nURL: ${status.metadata.url}`,
      }],
    };
  }

  // 未运行则启动
  const result = await startDevServer(token, workspace_id);
  if (result.success && result.metadata?.running) {
    return {
      content: [{
        type: 'text',
        text: `🌐 预览已就绪\nURL: ${result.metadata.url}`,
      }],
    };
  }

  // 等待就绪
  const deadline = Date.now() + wait_seconds * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const s = await getDevServerStatus(token, workspace_id);
    if (s.success && s.metadata?.running) {
      return {
        content: [{
          type: 'text',
          text: `🌐 预览已就绪\nURL: ${s.metadata.url}`,
        }],
      };
    }
  }

  throw new Error('等待开发服务器就绪超时');
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  let result;
  try {
    switch (name) {
      case 'ddb_login':
        result = await handleLogin(args);
        break;
      case 'ddb_create_task':
        result = await handleCreateTask(args);
        break;
      case 'ddb_check_progress':
        result = await handleCheckProgress(args);
        break;
      case 'ddb_get_preview':
        result = await handleGetPreview(args);
        break;
      case 'ddb_list_projects':
        result = await handleListProjects(args);
        break;
      default:
        throw new Error(`未知工具: ${name}`);
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

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('✅ DeepDiver MCP Server 已启动 (stdio)');
}

main().catch(err => {
  console.error('❌ MCP Server 启动失败:', err.message);
  process.exit(1);
});
