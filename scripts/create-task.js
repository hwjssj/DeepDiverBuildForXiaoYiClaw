#!/usr/bin/env node
/**
 * DeepDiver Task Creation Script
 *
 * 创建 DeepDiver 任务并通过 WebSocket 实时跟踪完成。
 *
 * 用法:
 *   # 完整流程：登录 → 创建项目 → 发送 prompt → 实时跟踪
 *   export DEEPDIVER_EMAIL="user@example.com"
 *   export DEEPDIVER_PASSWORD="your_password"
 *   node skills/scripts/create-task.js -p "帮我做一个计数器页面"
 *
 *   # 使用已有 token 和已有 workspace_id（不创建新项目）
 *   export DEEPDIVER_TOKEN="<jwt>"
 *   node skills/scripts/create-task.js -p "帮我做一个计数器页面" --wsid "<workspace_id>"
 *
 * 环境变量:
 *   DEEPDIVER_EMAIL / DEEPDIVER_PASSWORD  - 登录凭据（会自动调用 auth）
 *   DEEPDIVER_TOKEN                        - JWT token（优先于登录）
 *   DEEPDIVER_BASE_URL                     - API 地址 (默认 https://cn.deepdiver.app)
 *   DEEPDIVER_MODEL                        - 模型 ID (默认 ddexp)
 *   DEEPDIVER_TOKEN_FILE                   - token 文件路径 (默认 .deepdiver-token)
 *
 * 参数:
 *   --prompt, -p  <text>   任务描述 (必填)
 *   --wsid, -w    <uuid>   已有 workspace_id（跳过项目创建）
 *   --poll                  启用文件/服务轮询
 */

const BASE_URL = (process.env.DEEPDIVER_BASE_URL || 'https://cn.deepdiver.app').replace(/\/+$/, '');
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws/agent';
const MODEL = process.env.DEEPDIVER_MODEL || 'ddexp';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 解析参数
// ---------------------------------------------------------------------------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--prompt' || a === '-p') args.prompt = process.argv[++i];
  else if (a === '--wsid' || a === '-w') args.wsId = process.argv[++i];
  else if (a === '--poll') args.poll = true;
}

if (!args.prompt) {
  console.error('错误: 请使用 --prompt 指定任务描述');
  console.error('');
  console.error('  node skills/scripts/create-task.js --prompt "帮我做一个计数器页面"');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 获取 Token
// ---------------------------------------------------------------------------
async function ensureToken() {
  if (process.env.DEEPDIVER_TOKEN) return process.env.DEEPDIVER_TOKEN;
  const tokenFile = path.resolve(process.env.DEEPDIVER_TOKEN_FILE || '.deepdiver-token');
  if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf-8').trim();
  if (process.env.DEEPDIVER_EMAIL && process.env.DEEPDIVER_PASSWORD) {
    console.error('🔐 自动登录...');
    const res = await fetch(`${BASE_URL}/api/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.DEEPDIVER_EMAIL,
        password: process.env.DEEPDIVER_PASSWORD,
      }),
    });
    if (!res.ok) throw new Error(`登录失败: ${await res.text()}`);
    const data = await res.json();
    if (!data.access_token) throw new Error('登录响应中未找到 access_token');
    console.error(`✅ 登录成功 — ${data.user?.display_name || data.user?.email || ''}`);
    // 保存 token 文件，方便后续脚本使用
    try { fs.writeFileSync(tokenFile, data.access_token, 'utf-8'); } catch {}
    return data.access_token;
  }
  throw new Error('未找到 JWT token。请设置 DEEPDIVER_TOKEN 或 DEEPDIVER_EMAIL + DEEPDIVER_PASSWORD');
}

function uuidv4() { return crypto.randomUUID(); }
function generateResumeToken() { return crypto.randomBytes(32).toString('base64url'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// 1. 创建项目（REST API）
// ---------------------------------------------------------------------------
async function createProject(token) {
  const workspaceId = args.wsId || uuidv4();
  const resumeToken = generateResumeToken();
  const projectName = `Project ${workspaceId.slice(0, 8)}`;

  console.error(`📦 创建项目: ${projectName}`);
  console.error(`   workspace_id: ${workspaceId}`);

  const res = await fetch(`${BASE_URL}/api/projects`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: projectName,
      workspace_id: workspaceId,
      resume_token: resumeToken,
      settings: { model: MODEL },
    }),
  });

  if (!res.ok) throw new Error(`创建项目失败 (${res.status}): ${await res.text()}`);
  const project = await res.json();
  console.error(`✅ 项目创建成功 — ID: ${project.id}`);
  console.error(`   预览 URL: https://deepdiver.app/preview/${workspaceId}/?token=${resumeToken}`);

  return { project, workspaceId, resumeToken };
}

// ---------------------------------------------------------------------------
// 2. WebSocket 连接
// ---------------------------------------------------------------------------
function connectWebSocket(token) {
  return new Promise((resolve, reject) => {
    const url = `${WS_URL}?token=${encodeURIComponent(token)}`;
    console.error(`🔌 连接 WebSocket: ${WS_URL}`);

    const ws = new WebSocket(url);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('WebSocket 连接超时')); }, 15000);

    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      console.error('✅ WebSocket 已连接');
      resolve(ws);
    }, { once: true });

    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket 连接失败'));
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// 3. 轮询
// ---------------------------------------------------------------------------
async function pollFiles(token, sessionId) {
  const res = await fetch(`${BASE_URL}/api/files/${sessionId}?path=&max_depth=5`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.ok) {
    const data = await res.json();
    if (data.files?.length > 0) {
      console.error(`\n📄 文件列表 (${data.files.length} 个文件):`);
      data.files.forEach(f => console.error(`   ${f.type === 'dir' ? '📁' : '📄'} ${f.path}`));
    }
    return data;
  }
  return null;
}

async function pollDevServer(token, sessionId) {
  const res = await fetch(`${BASE_URL}/api/dev-server-status?session_id=${sessionId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.ok) {
    const data = await res.json();
    if (data.success && data.metadata?.running) {
      console.error(`\n🌐 开发服务器已启动: ${data.metadata.url}`);
      return data.metadata;
    }
  }
  return null;
}

// ===================================================================
// Main
// ===================================================================
async function main() {
  const token = await ensureToken();

  // ---- 1. 创建项目 ----
  let workspaceId, project, resumeToken;
  if (args.wsId) {
    workspaceId = args.wsId;
    project = { id: '(existing)' };
    resumeToken = '(existing)';
    console.error(`📋 使用已有 workspace_id: ${workspaceId}`);
  } else {
    ({ project, workspaceId, resumeToken } = await createProject(token));
  }

  // ---- 2. 连接 WebSocket ----
  const ws = await connectWebSocket(token);

  // ---- 3. 发送消息 ----
  console.error('📤 发送 session 绑定 + 模型配置 + 查询...');
  ws.send(JSON.stringify({ session_id: workspaceId }));
  await sleep(200);
  ws.send(JSON.stringify({
    model: MODEL,
    settings: { model_temperature: 0.7, model_max_tokens: 64000 },
  }));
  await sleep(200);
  ws.send(JSON.stringify({
    type: 'query',
    query: args.prompt,
    is_followup: false,
  }));

  // ---- 4. 实时解析事件 ----
  console.error('⏳ 等待 AI 响应...\n');

  let currentIteration = 0;
  let toolCallCount = 0;
  let serverSessionId = null;
  let startTime = Date.now();
  let lastStreamingOutput = 0;

  await new Promise((resolve) => {
    ws.addEventListener('message', (msg) => {
      try {
        const evt = JSON.parse(msg.data);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        switch (evt.type) {

          case 'start': {
            const d = evt.data || {};
            serverSessionId = d.session_id || serverSessionId;
            console.error(`[${elapsed}s] 🚀 开始执行`);
            console.error(`   query: ${(d.query || '').slice(0, 80)}`);
            console.error(`   session: ${serverSessionId}`);
            break;
          }

          case 'info': {
            const d = evt.data || {};
            if (d.debug_type !== 'agent_phase') break;
            const phase = d.phase || '';
            const msgs = {
              run_start: '📋 任务已接收',
              rewriter_start: '🔄 优化查询语句...',
              rewriter_complete: '✅ 查询重写完成',
              ddt_start: '🧠 DDT 执行开始',
              ddt_complete: '✅ DDT 执行完成',
            };
            if (msgs[phase]) console.error(`[${elapsed}s] ${msgs[phase]}`);
            break;
          }

          case 'streaming': {
            const d = evt.data || {};
            const text = (d.text || '').trim();
            if (!text || d.type !== 'reasoning') break;
            if (Date.now() - lastStreamingOutput > 5000) {
              console.error(`[${elapsed}s] 🤔 ${text.length > 120 ? text.slice(0, 120) + '...' : text}`);
              lastStreamingOutput = Date.now();
            }
            break;
          }

          case 'tool_call': {
            toolCallCount++;
            const d = evt.data || evt;
            const toolName = d.tool || evt.tool || 'tool';
            const toolStatus = d.status || 'Running';
            const icon = toolStatus === 'Success' ? '✅' : toolStatus === 'Error' ? '❌' : '🔄';
            let toolArgs = {};
            try { toolArgs = JSON.parse(d.arguments || evt.arguments || '{}'); } catch {}

            console.error(`[${elapsed}s] ${icon} [iter ${d.iteration || currentIteration}] ${toolName}`);
            if (toolArgs.path) console.error(`   📄 ${toolArgs.path}`);
            if (toolArgs.query) console.error(`   🔍 ${(toolArgs.query || '').slice(0, 80)}`);
            if (toolArgs.content && typeof toolArgs.content === 'string') {
              console.error(`   📝 ${toolArgs.content.replace(/\n/g, ' ').slice(0, 100)}`);
            }
            break;
          }

          case 'checkpoint_complete': {
            const d = evt.data || evt;
            console.error(`[${elapsed}s] 🏁 检查点完成 (${d.thinking_duration || '?'}s)`);
            break;
          }

          case 'subagent_start':
            console.error(`[${elapsed}s] 👤 子 Agent ${evt.agent_id || ''} 启动`);
            break;
          case 'subagent_complete':
            console.error(`[${elapsed}s] ✅ 子 Agent ${evt.agent_id || ''} 完成`);
            break;

          case 'session_created':
            serverSessionId = evt.session_id || serverSessionId;
            break;

          case 'error':
            console.error(`[${elapsed}s] ❌ ${evt.content || evt.error || ''}`);
            break;

          // 安静的
          case 'iteration':
          case 'context_length':
          case 'agent_handoff':
          case 'session_not_found':
          case 'session_expired':
            break;

          default:
            console.error(`[${elapsed}s] 📨 ${evt.type}`);
            break;
        }
      } catch { /* 解析失败忽略 */ }
    });

    ws.addEventListener('close', () => {
      console.error(`\n🔌 WebSocket 已断开 (${((Date.now() - startTime) / 1000).toFixed(0)}s)`);
      resolve();
    });
    ws.addEventListener('error', () => resolve());

    setTimeout(() => { console.error('\n⏰ 超时'); ws.close(); resolve(); }, 600000);
  });

  // ---- 5. 轮询 ----
  if (args.poll && serverSessionId) {
    console.error('\n📡 轮询文件 + 开发服务器...');
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      await pollFiles(token, serverSessionId);
      if (await pollDevServer(token, serverSessionId)) break;
    }
  }

  // ---- 摘要 ----
  console.error('\n' + '='.repeat(50));
  console.error('📋 任务摘要');
  console.error('='.repeat(50));
  console.error(`   提示词:       ${args.prompt}`);
  console.error(`   迭代轮次:     ${currentIteration}`);
  console.error(`   工具调用:     ${toolCallCount}`);
  console.error(`   服务器 Session: ${serverSessionId || 'N/A'}`);
  console.error(`   耗时:         ${((Date.now() - startTime) / 1000).toFixed(0)}s`);

  console.log(`SESSION_ID=${serverSessionId || ''}`);
  console.log(`WORKSPACE_ID=${workspaceId}`);
  console.log(`ITERATIONS=${currentIteration}`);
  console.log(`TOOL_CALLS=${toolCallCount}`);
}

main().catch(err => {
  console.error(`\n❌ 失败: ${err.message}`);
  process.exit(1);
});
