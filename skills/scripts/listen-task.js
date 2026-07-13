#!/usr/bin/env node
/**
 * DeepDiver Task Listener
 *
 * 连接到已有任务的 WebSocket session，监听实时进度。
 * 不发送新 query，只接收服务端推送的事件。
 * 自动检测空闲状态并切换为 REST 轮询模式。
 *
 * 用法:
 *   export DEEPDIVER_TOKEN="<jwt>"
 *   node skills/scripts/listen-task.js --wsid "<workspace_id>"
 *
 *   # 始终启用 REST 轮询（WebSocket 空闲后自动检查文件/服务状态）
 *   node skills/scripts/listen-task.js --wsid "<id>" --poll
 *
 *   # 原始 JSON 输出，不解析
 *   node skills/scripts/listen-task.js --wsid "<id>" --raw
 *
 * 参数:
 *   --wsid, -w  <uuid>   要监听的 workspace_id
 *   --raw                 原始 JSON 输出
 *   --poll                空闲后自动轮询文件/开发服务器
 *
 * 环境变量:
 *   DEEPDIVER_TOKEN       - JWT token
 *   DEEPDIVER_TOKEN_FILE  - token 文件路径 (默认 .deepdiver-token)
 *   DEEPDIVER_BASE_URL    - API 地址 (默认 https://cn.deepdiver.app)
 */

const BASE_URL = (process.env.DEEPDIVER_BASE_URL || 'https://cn.deepdiver.app').replace(/\/+$/, '');
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws/agent';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 解析参数
// ---------------------------------------------------------------------------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--wsid' || a === '-w') args.wsId = process.argv[++i];
  else if (a === '--raw') args.raw = true;
  else if (a === '--poll') args.poll = true;
}

if (!args.wsId) {
  console.error('错误: 请使用 --wsid 指定 workspace_id');
  console.error('');
  console.error('  node skills/scripts/list-projects.js   # 查看所有项目');
  console.error('  node skills/scripts/listen-task.js --wsid "<uuid>"');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 获取 Token
// ---------------------------------------------------------------------------
function getToken() {
  if (process.env.DEEPDIVER_TOKEN) return process.env.DEEPDIVER_TOKEN;
  const tokenFile = path.resolve(process.env.DEEPDIVER_TOKEN_FILE || '.deepdiver-token');
  if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf-8').trim();
  return null;
}

const TOKEN = getToken();
if (!TOKEN) {
  console.error('错误: 未找到 JWT token');
  console.error('请设置 DEEPDIVER_TOKEN 环境变量或先运行 auth.js');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollFiles(sessionId) {
  try {
    const res = await fetch(`${BASE_URL}/api/files/${sessionId}?path=&max_depth=5`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.files?.length > 0) {
        const totalSize = data.files.reduce((s, f) => s + (f.size || 0), 0);
        const fileCount = data.files.filter(f => f.type === 'file').length;
        const dirCount = data.files.filter(f => f.type === 'dir').length;
        console.error(`📁 ${fileCount} 文件 ${dirCount} 目录  (总计 ${(totalSize / 1024).toFixed(0)} KB)`);
        // 显示最新的几个文件
        const sorted = [...data.files].sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
        sorted.slice(0, 5).forEach(f => console.error(`   ${f.type === 'dir' ? '📁' : '📄'} ${f.path}`));
        return data;
      } else {
        console.error(`📁 暂无文件`);
      }
    }
  } catch {}
  return null;
}

async function pollDevServer(sessionId) {
  try {
    const res = await fetch(`${BASE_URL}/api/dev-server-status?session_id=${sessionId}`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.metadata?.running) {
        console.error(`🌐 开发服务器已启动: ${data.metadata.url}`);
        return data.metadata;
      }
    }
  } catch {}
  return null;
}

async function pollProjectInfo(projectId) {
  // 从 project 列表中找到这个项目
  try {
    const res = await fetch(`${BASE_URL}/api/projects`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    if (res.ok) {
      const data = await res.json();
      const project = data.projects?.find(p => p.workspace_id === args.wsId || p.id === projectId);
      if (project) {
        if (project.name_source !== 'default') {
          console.error(`📋 项目名: ${project.name}`);
        }
        const building = data.building_workspace_ids || [];
        if (building.includes(args.wsId)) {
          console.error(`🏗️  正在构建中...`);
        } else {
          console.error(`✅ 构建状态: 完成或空闲`);
        }
        return project;
      }
    }
  } catch {}
  return null;
}

// ===================================================================
// Main
// ===================================================================
async function main() {
  console.error(`🔌 连接 WebSocket: ${WS_URL}`);
  console.error(`📋 监听 workspace: ${args.wsId}`);
  if (args.poll) console.error(`📡 空闲后自动轮询 REST API`);

  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(TOKEN)}`);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(new Error('连接超时')); }, 15000);

    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      console.error('✅ WebSocket 已连接');

      // 绑定 session
      console.error(`📤 发送 session 绑定: ${args.wsId}`);
      ws.send(JSON.stringify({ session_id: args.wsId }));

      const startTime = Date.now();
      let eventCount = 0;
      let lastEventTime = Date.now();
      let pollingStarted = false;
      let hasRealEvents = false; // 是否有有意义的事件

      // ---- WebSocket 消息处理 ----
      ws.addEventListener('message', (msg) => {
        try {
          const evt = JSON.parse(msg.data);
          eventCount++;
          lastEventTime = Date.now();
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

          // 安静事件不计数
          if (['session_not_found', 'session_expired', 'context_length'].includes(evt.type)) {
            if (args.raw) console.log(JSON.stringify(evt));
            return;
          }
          hasRealEvents = true;

          if (args.raw) {
            console.log(JSON.stringify(evt));
            return;
          }

          switch (evt.type) {

            case 'start': {
              const d = evt.data || {};
              console.error(`\n[${elapsed}s] ── 🚀 开始执行 ──`);
              if (d.query) console.error(`   query:      ${d.query.slice(0, 80)}`);
              if (d.session_id) console.error(`   session_id: ${d.session_id}`);
              if (d.run_id) console.error(`   run_id:     ${d.run_id}`);
              break;
            }

            case 'info': {
              const d = evt.data || {};
              if (d.debug_type === 'agent_phase') {
                const icons = {
                  run_start: '📋',
                  rewriter_start: '🔄',
                  rewriter_complete: '✅',
                  ddt_start: '🧠',
                  ddt_complete: '✅',
                };
                console.error(`[${elapsed}s] ${icons[d.phase] || 'ℹ️'} ${d.message || d.phase}`);
              } else if (d.message) {
                console.error(`[${elapsed}s] ℹ️  ${d.message}`);
              }
              break;
            }

            case 'streaming': {
              const d = evt.data || {};
              const text = (d.text || '').trim();
              if (!text) break;
              if (d.type === 'reasoning') {
                const preview = text.length > 150 ? text.slice(0, 150) + '...' : text;
                console.error(`[${elapsed}s] 🤔 ${preview}`);
              } else if (d.type === 'done') {
                console.error(`[${elapsed}s] ✅ 推理完成`);
              }
              break;
            }

            case 'tool_call': {
              const d = evt.data || evt;
              const tool = d.tool || evt.tool || '?';
              const status = d.status || 'Running';
              const icon = status === 'Success' ? '✅' : status === 'Error' ? '❌' : '🔄';
              let toolArgs = {};
              try { toolArgs = JSON.parse(d.arguments || evt.arguments || '{}'); } catch {}

              console.error(`[${elapsed}s] ${icon} ${tool}`);
              if (toolArgs.path) console.error(`   📄 ${toolArgs.path}`);
              if (toolArgs.query) console.error(`   🔍 ${toolArgs.query.slice(0, 80)}`);
              if (toolArgs.content && typeof toolArgs.content === 'string') {
                console.error(`   📝 ${toolArgs.content.replace(/\n/g, ' ').slice(0, 120)}`);
              }
              break;
            }

            case 'checkpoint_complete': {
              const d = evt.data || evt;
              console.error(`[${elapsed}s] 🏁 检查点完成`);
              if (d.final_answer) console.error(`   ${d.final_answer}`);
              if (d.key_files) d.key_files.forEach(f => console.error(`   📄 ${f}`));
              console.error(`   耗时: ${d.thinking_duration || '?'}s`);
              break;
            }

            case 'session_created':
              console.error(`[${elapsed}s] ✅ Session 已创建: ${evt.session_id || ''}`);
              break;

            case 'session_resumed':
              console.error(`[${elapsed}s] 🔄 Session 已恢复: ${evt.session_id || ''}`);

            case 'iteration':
              console.error(`[${elapsed}s] 🔢 迭代: ${evt.iteration}`);
              break;

            case 'agent_handoff':
              console.error(`[${elapsed}s] 🔄 Agent 切换 → ${evt.new_agent_id || '?'}`);
              break;

            case 'subagent_start':
              console.error(`[${elapsed}s] 👤 Agent ${evt.agent_id || ''} 启动: ${evt.summary || evt.task || ''}`);
              break;

            case 'subagent_complete':
              console.error(`[${elapsed}s] ✅ Agent ${evt.agent_id || ''} 完成 (${evt.iterations_used || '?'} iter)`);
              break;

            case 'interaction_required':
              console.error(`[${elapsed}s] ❓ AI 需要交互:`);
              (evt.questions || []).forEach(q => {
                console.error(`   ${q.question}`);
                (q.options || []).forEach((o, i) => console.error(`     ${i + 1}. ${o}`));
              });
              break;

            case 'error':
              console.error(`[${elapsed}s] ❌ ${evt.content || evt.error || ''}`);
              break;

            default:
              console.error(`[${elapsed}s] 📨 ${evt.type}`);
              break;
          }
        } catch { /* 解析错误忽略 */ }
      });

      // ---- WebSocket 关闭/错误 ----
      ws.addEventListener('close', () => {
        const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.error(`\n🔌 WebSocket 已断开`);
        console.error(`   事件: ${eventCount} | 耗时: ${totalElapsed}s`);
        resolve();
      });
      ws.addEventListener('error', () => resolve());

      // ---- 空闲检测 + 心跳 + 自动轮询 ----
      (async () => {
        while (true) {
          await sleep(15000); // 每 15 秒检查一次
          if (ws.readyState !== WebSocket.OPEN) break;

          const idleSeconds = (Date.now() - lastEventTime) / 1000;
          const totalSeconds = (Date.now() - startTime) / 1000;

          if (idleSeconds > 120) {
            // 空闲超过 2 分钟，退出
            console.error(`\n⏹️  已空闲 ${idleSeconds.toFixed(0)}s，自动退出`);
            ws.close();
            break;
          }

          if (idleSeconds > 30 && !pollingStarted) {
            // 空闲超过 30 秒，显示心跳
            console.error(`[${totalSeconds.toFixed(0)}s] 💤 等待中... (已空闲 ${idleSeconds.toFixed(0)}s)`);

            // 如果启用了 poll，开始 REST 轮询
            if (args.poll) {
              pollingStarted = true;
              console.error(`📡 切换到 REST 轮询模式...`);

              (async () => {
                for (let i = 0; i < 20; i++) {
                  if (ws.readyState !== WebSocket.OPEN) break;
                  await sleep(5000);
                  if (ws.readyState !== WebSocket.OPEN) break;
                  console.error(`\n[${((Date.now() - startTime) / 1000).toFixed(0)}s] 📡 轮询检查:`);
                  await pollProjectInfo();
                  await pollFiles(args.wsId);
                  const ds = await pollDevServer(args.wsId);
                  if (ds) break;
                }
              })();
            }
          }
        }
      })();

      // 超时保护 5 分钟
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.error('\n⏰ 监听超时');
          ws.close();
          resolve();
        }
      }, 300000);
    });

    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket 连接失败'));
    }, { once: true });
  });
}

main().catch(err => {
  console.error(`\n❌ 失败: ${err.message}`);
  process.exit(1);
});
