#!/usr/bin/env node
/**
 * DeepDiver Get Preview URL
 *
 * 获取已完成任务的预览 URL。
 * 先检查开发服务器状态，未启动则启动并等待就绪。
 *
 * 用法:
 *   node skills/scripts/get-preview.js --wsid "<workspace_id>"
 *
 *   # 从 create-task.js 输出中提取 workspace_id 后使用
 *   node skills/scripts/create-task.js -p "..." 2>&1 | tee /dev/stderr | grep WORKSPACE_ID | cut -d= -f2
 *
 * 参数:
 *   --wsid, -w  <uuid>   workspace_id (必填)
 *   --wait, -t  <秒>     等待就绪的超时时间 (默认 60)
 *
 * 环境变量:
 *   DEEPDIVER_TOKEN       - JWT token
 *   DEEPDIVER_TOKEN_FILE  - token 文件路径
 *   DEEPDIVER_BASE_URL    - API 地址 (默认 https://cn.deepdiver.app)
 */

const BASE_URL = (process.env.DEEPDIVER_BASE_URL || 'https://cn.deepdiver.app').replace(/\/+$/, '');
const fs = require('fs');
const path = require('path');

// 解析参数
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--wsid' || a === '-w') args.wsId = process.argv[++i];
  else if (a === '--wait' || a === '-t') args.wait = parseInt(process.argv[++i]) || 60;
}

if (!args.wsId) {
  console.error('错误: 请使用 --wsid 指定 workspace_id');
  console.error('');
  console.error('  node skills/scripts/get-preview.js --wsid "c261b300-..."');
  process.exit(1);
}

// 获取 Token
function getToken() {
  if (process.env.DEEPDIVER_TOKEN) return process.env.DEEPDIVER_TOKEN;
  const f = path.resolve(process.env.DEEPDIVER_TOKEN_FILE || '.deepdiver-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf-8').trim();
  return null;
}

const TOKEN = getToken();
if (!TOKEN) {
  console.error('错误: 未找到 JWT token');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkStatus() {
  const res = await fetch(`${BASE_URL}/api/dev-server-status?session_id=${args.wsId}`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`状态查询失败 (${res.status})`);
  return res.json();
}

async function startServer() {
  console.error('🚀 启动开发服务器...');
  const res = await fetch(`${BASE_URL}/api/start-dev-server?session_id=${args.wsId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Length': '0',
    },
  });
  if (!res.ok) throw new Error(`启动失败 (${res.status}): ${await res.text()}`);
  return res.json();
}

async function main() {
  console.error(`🔍 检查开发服务器状态: workspace=${args.wsId}`);

  // 先检查状态
  let status = await checkStatus();

  if (status.success && status.metadata?.running) {
    console.error('✅ 开发服务器已在运行');
    const url = status.metadata.url;
    console.error(`🌐 预览 URL: ${url}`);
    console.log(`PREVIEW_URL=${url}`);
    return;
  }

  // 未启动，尝试启动
  console.error('⏳ 开发服务器未启动，正在启动...');
  const result = await startServer();

  if (result.success && result.metadata?.running) {
    console.error('✅ 开发服务器已启动');
    const url = result.metadata.url;
    console.error(`🌐 预览 URL: ${url}`);
    console.log(`PREVIEW_URL=${url}`);
    return;
  }

  // 启动请求成功但未就绪，等待
  console.error(`⏳ 等待开发服务器就绪 (最长 ${args.wait || 60}s)...`);
  const deadline = Date.now() + (args.wait || 60) * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    status = await checkStatus();
    if (status.success && status.metadata?.running) {
      const url = status.metadata.url;
      console.error(`✅ 开发服务器就绪`);
      console.error(`🌐 预览 URL: ${url}`);
      console.log(`PREVIEW_URL=${url}`);
      return;
    }
    console.error('   ...仍在等待');
  }

  console.error('❌ 等待超时，开发服务器未就绪');
  process.exit(1);
}

main().catch(err => {
  console.error(`\n❌ 错误: ${err.message}`);
  process.exit(1);
});
