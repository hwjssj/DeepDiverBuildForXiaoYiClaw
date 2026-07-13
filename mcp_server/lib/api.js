/**
 * DeepDiver REST API 客户端
 * 所有与 DeepDiver 后端的 HTTP 通信
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const BASE_URL = process.env.DEEPDIVER_BASE_URL || 'https://cn.deepdiver.app';

/** 从 .deepdiver-token 文件读取 token */
function getSavedToken() {
  try {
    const f = resolve(process.env.DEEPDIVER_TOKEN_FILE || '.deepdiver-token');
    return readFileSync(f, 'utf-8').trim();
  } catch {
    return null;
  }
}

/** 通用 fetch 包装 */
async function apiFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = { ...options.headers };
  // token: 传 null 表示跳过 auth，传 false 不传，传字符串就用它，不传则从文件读
  if (options.token !== null) {
    const token = options.token || getSavedToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  // 没有 body 时自动设 Content-Length: 0
  if (!options.body && !headers['Content-Length']) {
    headers['Content-Length'] = '0';
  }

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** 登录，返回 { access_token, user } */
export async function login(email, password) {
  return apiFetch('/api/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    token: null, // 不传 auth header
  });
}

/** 获取项目列表，返回 { projects, total, building_workspace_ids } */
export async function listProjects(token) {
  return apiFetch('/api/projects', { token });
}

/** 创建项目，返回 project 对象 */
export async function createProject(token, { workspaceId, name, resumeToken, model }) {
  return apiFetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      workspace_id: workspaceId,
      resume_token: resumeToken,
      settings: { model: model || process.env.DEEPDIVER_MODEL || 'ddexp' },
    }),
    token,
  });
}

/** 获取文件列表，返回 { files, session_id } */
export async function getFiles(token, sessionId) {
  return apiFetch(`/api/files/${sessionId}?path=&max_depth=5`, { token });
}

/** 检查开发服务器状态 */
export async function getDevServerStatus(token, sessionId) {
  return apiFetch(`/api/dev-server-status?session_id=${sessionId}`, { token });
}

/** 启动开发服务器，返回 { success, metadata: { url, running, port, server_type } } */
export async function startDevServer(token, sessionId) {
  return apiFetch(`/api/start-dev-server?session_id=${sessionId}`, {
    method: 'POST',
    token,
  });
}

/** 获取当前用户信息 */
export async function getUserInfo(token) {
  return apiFetch('/api/users/me', { token });
}

/** 保存 token 到文件 */
export function saveToken(token) {
  const f = resolve(process.env.DEEPDIVER_TOKEN_FILE || '.deepdiver-token');
  writeFileSync(f, token, 'utf-8');
  return f;
}
