#!/usr/bin/env node
/**
 * DeepDiver Auth Script
 *
 * 从环境变量读取 DEEPDIVER_EMAIL 和 DEEPDIVER_PASSWORD，
 * 发送登录请求获取 JWT token 和过期时间。
 *
 * 用法:
 *   export DEEPDIVER_EMAIL="user@example.com"
 *   export DEEPDIVER_PASSWORD="your_password"
 *   node scripts/auth.js
 *
 * 可选环境变量:
 *   DEEPDIVER_BASE_URL  - API 地址 (默认 https://cn.deepdiver.app)
 *   DEEPDIVER_TOKEN_SAVE - 非空时将 token 写入此路径 (默认: .deepdiver-token)
 *
 * 输出 (stdout):
 *   TOKEN=<jwt>
 *   EXPIRES_AT=<ISO datetime>
 */

const DEEPDIVER_EMAIL = process.env.DEEPDIVER_EMAIL;
const DEEPDIVER_PASSWORD = process.env.DEEPDIVER_PASSWORD;
const BASE_URL = (process.env.DEEPDIVER_BASE_URL || 'https://cn.deepdiver.app').replace(/\/+$/, '');
const TOKEN_SAVE_PATH = process.env.DEEPDIVER_TOKEN_SAVE === '' ? null
  : (process.env.DEEPDIVER_TOKEN_SAVE || '.deepdiver-token');

if (!DEEPDIVER_EMAIL || !DEEPDIVER_PASSWORD) {
  console.error('错误: 请设置环境变量 DEEPDIVER_EMAIL 和 DEEPDIVER_PASSWORD');
  console.error('');
  console.error('  export DEEPDIVER_EMAIL="user@example.com"');
  console.error('  export DEEPDIVER_PASSWORD="your_password"');
  console.error('  node scripts/auth.js');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// JWT 解码 (只解析 payload, 不验证签名)
// ---------------------------------------------------------------------------
function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload, 'base64url').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------
async function login() {
  const url = `${BASE_URL}/api/users/login`;

  console.error(`🔐 正在登录 ${BASE_URL}...`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DEEPDIVER_EMAIL, password: DEEPDIVER_PASSWORD }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`❌ 登录失败 (${res.status}): ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  const token = data.access_token;

  if (!token) {
    console.error('❌ 响应中未找到 access_token');
    process.exit(1);
  }

  // 解码获取过期时间
  const payload = decodeJwtPayload(token);
  let expiresAt = 'unknown';
  if (payload && payload.exp) {
    expiresAt = new Date(payload.exp * 1000).toISOString();
    const remaining = payload.exp * 1000 - Date.now();
    const hours = Math.round(remaining / 3600000 * 10) / 10;
    console.error(`✅ 登录成功 — 用户: ${data.user?.display_name || data.user?.email || '?'}`);
    console.error(`⏳ Token 过期时间: ${expiresAt} (剩余 ${hours} 小时)`);
  } else {
    console.error('✅ 登录成功 (无法解析 token 过期时间)');
  }

  // 输出到 stdout (供其他脚本消费)
  console.log(`TOKEN=${token}`);
  console.log(`EXPIRES_AT=${expiresAt}`);

  // 写入 token 文件
  if (TOKEN_SAVE_PATH) {
    try {
      const fs = require('fs');
      fs.writeFileSync(TOKEN_SAVE_PATH, token, 'utf-8');
      console.error(`💾 Token 已保存到 ${TOKEN_SAVE_PATH}`);
    } catch (err) {
      console.error(`⚠️  无法写入 token 文件: ${err.message}`);
    }
  }
}

login().catch(err => {
  console.error(`❌ 错误: ${err.message}`);
  process.exit(1);
});
