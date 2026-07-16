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

  const events = [];
  const terminalTypes = new Set(['build_complete', 'complete', 'error', 'cancelled']);
  let terminalReceived = false;

  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${key}`, 'Cache-Control': 'no-cache',
                 'Accept': 'text/event-stream' },
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SSE ${res.status}: ${text.slice(0, 300)}`);
    }

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
                  terminalReceived = true;
                  done = true;
                  break;
                }
              } catch {
                events.push({ eventType: currentEvent, raw: dataStr });
                currentEvent = null;
              }
            }

            if (events.length >= maxEvents) {
              done = true;
              break;
            }
          }
        }
        if (streamDone) done = true;
      }
    } finally {
      reader.cancel();
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return { events, done: false };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return { events, done: terminalReceived };
}
