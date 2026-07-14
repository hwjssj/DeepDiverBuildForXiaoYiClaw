#!/usr/bin/env node
/**
 * DeepDiver List Projects
 *
 * 获取项目列表，显示 id 和 workspace_id（可用作 --wsid）。
 *
 * 用法:
 *   node skills/scripts/list-projects.js
 *
 * 环境变量:
 *   DEEPDIVER_TOKEN       - JWT token
 *   DEEPDIVER_TOKEN_FILE  - token 文件路径 (默认 .deepdiver-token)
 *   DEEPDIVER_BASE_URL    - API 地址 (默认 https://cn.deepdiver.app)
 */

const BASE_URL = (process.env.DEEPDIVER_BASE_URL || 'https://cn.deepdiver.app').replace(/\/+$/, '');
const fs = require('fs');
const path = require('path');

function getToken() {
  if (process.env.DEEPDIVER_TOKEN) return process.env.DEEPDIVER_TOKEN;
  const f = path.resolve(process.env.DEEPDIVER_TOKEN_FILE || '.deepdiver-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf-8').trim();
  return null;
}

const TOKEN = getToken();
if (!TOKEN) {
  console.error('错误: 未找到 JWT token');
  console.error('请设置 DEEPDIVER_TOKEN 环境变量或先运行 auth.js');
  process.exit(1);
}

async function main() {
  const res = await fetch(`${BASE_URL}/api/projects`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  });

  if (!res.ok) {
    console.error(`请求失败 (${res.status}): ${await res.text()}`);
    process.exit(1);
  }

  const data = await res.json();

  if (!data.projects || data.projects.length === 0) {
    console.error('没有找到项目');
    return;
  }

  console.log(`总计: ${data.total} 个项目\n`);

  data.projects.forEach((p, i) => {
    const created = p.created_at ? new Date(p.created_at).toLocaleString('zh-CN') : '?';
    const updated = p.updated_at ? new Date(p.updated_at).toLocaleString('zh-CN') : '?';
    console.log(`${i + 1}. ${p.name}`);
    console.log(`   ID:           ${p.id}`);
    console.log(`   workspace_id: ${p.workspace_id}`);
    console.log(`   创建时间:     ${created}`);
    console.log(`   更新时间:     ${updated}`);
    console.log(`   模型:         ${p.settings?.model || '?'}`);
    console.log(`   描述:         ${p.description || '(无)'}`);
    console.log('');
  });

  // stdout 输出便于脚本消费
  console.log(`TOTAL=${data.total}`);
  data.projects.forEach((p, i) => {
    console.log(`PROJECT_${i}_ID=${p.id}`);
    console.log(`PROJECT_${i}_WSID=${p.workspace_id}`);
    console.log(`PROJECT_${i}_NAME=${p.name}`);
  });
}

main().catch(err => {
  console.error(`\n❌ 错误: ${err.message}`);
  process.exit(1);
});
