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
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
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
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
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
    model: record.model,
    interaction_mode: record.interaction_mode,
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

/** 查找最近一个活跃任务 */
export function findActiveTask() {
  const tasks = loadTasks();
  if (tasks.length === 0) return null;
  return tasks[tasks.length - 1];
}
