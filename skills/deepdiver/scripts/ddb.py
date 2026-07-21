#!/usr/bin/env python3
"""ddb.py — DeepDiver Builder skill runner.

处理子命令：create / followup / status / list / open / cancel / help。
采用 webhook 优先、轮询降级的等待策略；负责本地 JSONL 清单读写。
Agent 按 SKILL.md 的映射表将用户输入转为一条 `python3 ddb.py <cmd>` 调用。
"""

import argparse
import hashlib
import hmac
import http.server
import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


# ------------------------------- config ---------------------------------

AUTH_FILE = Path.home() / ".deepdiver" / "auth.json"


def read_auth():
    """读取本地持久化的认证信息；不存在或损坏时返回空 dict。"""
    if not AUTH_FILE.exists():
        return {}
    try:
        with AUTH_FILE.open("r", encoding="utf-8") as f:
            return json.loads(f.read())
    except Exception:
        eprint(f"[auth] 读取 {AUTH_FILE} 失败，忽略已保存的 key")
        return {}


def write_auth(data):
    """原子写入认证信息，权限 600。"""
    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = AUTH_FILE.with_suffix(AUTH_FILE.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    tmp.replace(AUTH_FILE)
    try:
        os.chmod(AUTH_FILE, 0o600)
    except OSError:
        pass


def load_cfg():
    # 优先从本地 auth 文件读取，fallback 到环境变量
    auth = read_auth()
    key = auth.get("api_key", "").strip() or os.environ.get("DEEPDIVER_API_KEY", "").strip()
    if not key:
        die("未设置 API key，请执行 ddb config --key <key> 或设置 DEEPDIVER_API_KEY 环境变量")
    return {
        "key": key,
        "base": os.environ.get("DEEPDIVER_BASE_URL", "https://deepdiver.app").rstrip("/"),
        "public_cb": os.environ.get("DEEPDIVER_PUBLIC_CALLBACK_URL", "").strip(),
        "cb_port": int(os.environ.get("DEEPDIVER_CALLBACK_PORT", "18089")),
        "cb_secret": os.environ.get("DEEPDIVER_CALLBACK_SECRET", ""),
        "apps_file": Path(os.environ.get(
            "DEEPDIVER_APPS_FILE",
            str(Path.home() / ".deepdiver/apps.jsonl"),
        )),
        "wait_max": int(os.environ.get("DEEPDIVER_WEBHOOK_WAIT_SECONDS", "1500")),
    }


# ---------------------------- http helpers ------------------------------

def api(cfg, method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{cfg['base']}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {cfg['key']}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as f:
            raw = f.read()
            return f.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw.decode(errors="replace")}


def screenshot_full(cfg, url):
    if not url:
        return None
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return cfg["base"] + "/" + url.lstrip("/")


# ---------------------------- viewer link -------------------------------
#
# POST /tasks 与 webhook payload 返回的 `preview_url` 是 owner-only URL
# （携带 `?token=<resume_token>`），仅登录 DeepDiver 的浏览器可访问。
# 若需生成任意人可访问的分享链接，须调用
# POST /api/v1/projects/viewer-links 铸造 viewer link。
# 每个 workspace 最多 15 条 active viewer-link；同一 workspace 复用一条。

def mint_viewer_link(cfg, workspace_id, label=None):
    body = {"workspace_id": workspace_id}
    if label:
        body["label"] = label
    code, resp = api(cfg, "POST", "/api/v1/projects/viewer-links", body)
    if code != 201:
        raw = json.dumps(resp, ensure_ascii=False)[:240]
        eprint(f"[viewer-link] 铸造失败 HTTP={code}: {raw}")
        if code == 400 and "env" in raw.lower():
            eprint("[viewer-link] 当前 API key 为 env-var-only 类型，"
                   "无法调用 viewer-link 接口；需切换至 DB-backed key。"
                   "owner preview URL 仅在已登录 DeepDiver 的浏览器可访问。")
        return None
    rel = resp.get("preview_url") or ""
    if not rel:
        return None
    full = cfg["base"] + rel if rel.startswith("/") else rel
    return {
        "viewer_url": full,
        "viewer_id": resp.get("viewer_id"),
        "viewer_label": resp.get("label"),
    }


def get_or_mint_viewer_link(cfg, workspace_id, label=None):
    """同一 workspace 只铸造一次 viewer_url；followup 复用清单记录。"""
    for r in read_manifest(cfg["apps_file"]):
        if r.get("workspace_id") == workspace_id and r.get("viewer_url"):
            return {
                "viewer_url": r["viewer_url"],
                "viewer_id": r.get("viewer_id"),
                "reused": True,
            }
    return mint_viewer_link(cfg, workspace_id, label=label)


# ---------------------------- manifest ----------------------------------

def read_manifest(path):
    if not path.exists():
        return []
    rows, bad = [], []
    with path.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                bad.append(i)
    if bad:
        eprint(f"[manifest] 跳过损坏行: {bad}（未修改文件，请手工修复 {path}）")
    return rows


def write_manifest(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    tmp.replace(path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def append_manifest(path, row):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def update_row(path, key, val, patch):
    rows = read_manifest(path)
    for r in rows:
        if r.get(key) == val:
            r.update(patch)
            write_manifest(path, rows)
            return True
    return False


# ---------------------- webhook receiver (in-process) --------------------

class ReceiverBox:
    def __init__(self):
        self.payload = None
        self.error = None


def start_receiver(port, secret, delivery_key):
    box = ReceiverBox()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            qs = urllib.parse.urlparse(self.path).query
            key = urllib.parse.parse_qs(qs).get("key", [""])[0]
            if key != delivery_key:
                self.send_response(404); self.end_headers(); return
            if secret:
                sig = self.headers.get("X-DeepDiver-Signature", "")
                expected = "sha256=" + hmac.new(
                    secret.encode(), raw, hashlib.sha256,
                ).hexdigest()
                if not hmac.compare_digest(sig, expected):
                    self.send_response(401); self.end_headers(); return
            try:
                box.payload = json.loads(raw)
            except Exception as e:
                box.error = f"payload not json: {e}"
                box.payload = {"raw": raw.decode(errors="replace")}
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok")

        def log_message(self, *a, **k):
            pass

    srv = http.server.HTTPServer(("0.0.0.0", port), Handler)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    return srv, box


# ------------------------ payload normalization -------------------------
#
# Webhook payload:
#   { version, event, task_id, workspace_id, status, timestamp, result, error }
# GET /tasks/{id} response:
#   { task_id, workspace_id, status, current_iteration, events, result, interaction }
#
# 两者顶层均含 `status`，成功时嵌套 `result`。`error` 字段仅在 webhook 中出现；
# GET 响应的错误信息位于 events[].data，此处不再解析。

def extract_terminal(cfg, payload):
    status = payload.get("status")
    inner = payload.get("result") or {}
    return {
        "status": status,
        "error": payload.get("error"),
        "preview_url": inner.get("preview_url"),
        "project_name": inner.get("project_name") or "(未命名)",
        "screenshot_url": screenshot_full(cfg, inner.get("screenshot_url")),
        "final_answer": inner.get("final_answer") or "",
        "iterations": inner.get("iterations"),
        "execution_time": inner.get("execution_time"),
    }


# ------------------------- concurrency guard ---------------------------
#
# SKILL.md 规定最大并发数为 1：已有非终态任务时，禁止 create / followup。
# 本函数检查本地清单；清单中每条非终态记录都通过 API 二次确认后硬性拦截。

def check_no_running_task(cfg):
    """清单中存在非终态任务时 die，终态自动回写以保持清单清洁。"""
    rows = read_manifest(cfg["apps_file"])
    terminals = {"completed", "failed", "cancelled", "success"}

    for r in rows:
        status = r.get("status", "")
        tid = r.get("task_id")
        if not tid:
            continue
        if status in terminals:
            continue

        # 非终态 / unknown — 调用 API 确认
        code, st = api(cfg, "GET", f"/api/v1/tasks/{tid}", timeout=10)
        current = st.get("status", "") if code == 200 else ""

        if code == 200 and current in terminals:
            # 之前在跑但现在已结束 → 回写清单
            update_row(cfg["apps_file"], "task_id", tid, {"status": current})
            continue

        # 确认仍在运行 / API 不通 → 拦截
        display = current or status or "unknown"
        die(f"已有任务在运行中 (task_id={tid}, status={display})，"
            f"请等待其完成后再创建新任务")


# ------------------------------ commands --------------------------------

def cmd_create(args):
    cfg = load_cfg()
    if not args.query.strip():
        die("query 不能为空")
    check_no_running_task(cfg)
    run_task(cfg, args.query, workspace_id=None, resume_token=None,
             manual=args.manual, wait_secs=args.wait or cfg["wait_max"])


def cmd_followup(args):
    cfg = load_cfg()
    rt = args.resume_token
    if not rt:
        for r in read_manifest(cfg["apps_file"]):
            if r.get("workspace_id") == args.workspace_id and r.get("resume_token"):
                rt = r["resume_token"]
                break
    if not rt:
        die(f"清单里找不到 workspace_id={args.workspace_id} 的 resume_token；"
            f"请手工传 --resume-token")
    check_no_running_task(cfg)
    run_task(cfg, args.query, workspace_id=args.workspace_id, resume_token=rt,
             manual=args.manual, wait_secs=args.wait or cfg["wait_max"])


def run_task(cfg, query, workspace_id, resume_token, manual, wait_secs):
    # auto 模式启用 webhook（若已配置）；manual 模式强制轮询，因 webhook 仅在终态触发。
    use_webhook = bool(cfg["public_cb"]) and not manual
    interaction_mode = "manual" if manual else "auto"

    delivery_key = None
    srv, box = None, None
    if use_webhook:
        delivery_key = secrets.token_hex(16)
        try:
            srv, box = start_receiver(cfg["cb_port"], cfg["cb_secret"], delivery_key)
        except OSError as e:
            eprint(f"[webhook] 端口 {cfg['cb_port']} 绑定失败（{e}），降级为轮询")
            use_webhook = False
            srv, box = None, None
        else:
            eprint(f"[webhook] 监听 :{cfg['cb_port']}  key={delivery_key[:8]}…")

    body = {
        "query": query,
        "model": "ddexp",
        "interaction_mode": interaction_mode,
        "screenshot": True,
    }
    if workspace_id:
        body["workspace_id"] = workspace_id
        body["resume_token"] = resume_token
    if use_webhook:
        sep = "&" if "?" in cfg["public_cb"] else "?"
        body["callback_url"] = f"{cfg['public_cb']}{sep}key={delivery_key}"
        if cfg["cb_secret"]:
            body["callback_secret"] = cfg["cb_secret"]

    code, resp = api(cfg, "POST", "/api/v1/tasks", body)
    if code != 202:
        if srv:
            srv.shutdown()
        die(f"提交失败 HTTP={code}: {json.dumps(resp, ensure_ascii=False)}")

    task_id = resp["task_id"]
    ws_id = resp["workspace_id"]
    rt_new = resp.get("resume_token") or resume_token
    print(f"[submit] task_id={task_id}  workspace_id={ws_id}")

    # 立即写入占位行到清单，阻塞后续 create/followup（最大并发=1）
    append_manifest(cfg["apps_file"], {
        "created_at": _now_iso(),
        "task_id": task_id,
        "workspace_id": ws_id,
        "resume_token": rt_new,
        "query": query,
        "status": "submitted",
    })

    try:
        if use_webhook:
            src, payload = _wait_via_webhook(cfg, task_id, box, wait_secs)
        else:
            src, payload = _wait_via_poll(cfg, task_id, wait_secs)
    finally:
        if srv:
            srv.shutdown()

    if payload is None:
        eprint(f"[timeout] {wait_secs}s 内未见终态；任务继续运行。"
               f"可稍后执行『使用ddb 状态 {task_id}』查询。")
        # 标记为 unknown，后续 check_no_running_task 会通过 API 二次确认
        update_row(cfg["apps_file"], "task_id", task_id, {"status": "unknown"})
        return

    fields = extract_terminal(cfg, payload)

    # 终态成功时铸造 viewer link；owner preview_url 仅登录 owner 可访问。
    viewer_info = None
    if fields["preview_url"] and fields["status"] in ("success", "completed"):
        viewer_info = get_or_mint_viewer_link(cfg, ws_id, label=f"ddb-{fields['project_name'][:40]}")

    patch = {
        "status": fields["status"],
        "project_name": fields["project_name"],
        "preview_url": fields["preview_url"],
        "screenshot_url": fields["screenshot_url"],
        "final_answer": _clip(fields["final_answer"], 1024),
        "source": src,
    }
    if viewer_info:
        patch["viewer_url"] = viewer_info["viewer_url"]
        if viewer_info.get("viewer_id"):
            patch["viewer_id"] = viewer_info["viewer_id"]

    update_row(cfg["apps_file"], "task_id", task_id, patch)

    print()
    print(f"=== DONE (via {src}) ===")
    print(f"status : {fields['status']}")
    if fields["error"]:
        print(f"error  : {fields['error']}")
    print(f"project: {fields['project_name']}")
    print(f"ws     : {ws_id}")
    print(f"task   : {task_id}")
    if patch.get("viewer_url"):
        print(f"share  : {patch['viewer_url']}")
    if fields["preview_url"]:
        print(f"owner  : {fields['preview_url']}")
    if fields["screenshot_url"]:
        print(f"shot   : {fields['screenshot_url']}")
    if fields["iterations"] is not None:
        print(f"stats  : iterations={fields['iterations']}  "
              f"exec={fields['execution_time']:.1f}s"
              if fields["execution_time"] else
              f"stats  : iterations={fields['iterations']}")


def _wait_via_webhook(cfg, task_id, box, wait_secs):
    """等待 webhook 到达；每 15s 心跳 GET 一次；超时兜底轮询终态。"""
    started = time.time()
    next_beat = started
    last = (None, None)
    while time.time() - started < wait_secs:
        if box.payload is not None:
            return "webhook", box.payload
        now = time.time()
        if now >= next_beat:
            code, st = api(cfg, "GET", f"/api/v1/tasks/{task_id}", timeout=15)
            if code == 200:
                cur = (st.get("status"), st.get("current_iteration"))
                if cur != last:
                    print(f"  [{int(now - started):>3}s] status={cur[0]} iter={cur[1]}")
                    last = cur
                if cur[0] in ("completed", "failed", "cancelled"):
                    # 终态已达但 webhook 尚未抵达，直接采用 GET 响应
                    eprint("[fallthrough] 终态先于 webhook 抵达，采用 GET 响应")
                    return "poll-fallthrough", st
            next_beat = now + 15
        time.sleep(1)
    # 超时兜底 GET 一次
    eprint(f"[timeout] webhook 未在 {wait_secs}s 内抵达，执行兜底 GET")
    _, st = api(cfg, "GET", f"/api/v1/tasks/{task_id}", timeout=30)
    return "poll-timeout", st


def _wait_via_poll(cfg, task_id, wait_secs):
    started = time.time()
    last = (None, None)
    last_seq = 0
    while time.time() - started < wait_secs:
        code, st = api(cfg, "GET", f"/api/v1/tasks/{task_id}", timeout=15)
        if code != 200:
            eprint(f"[poll] HTTP={code} body={json.dumps(st)[:200]}")
            time.sleep(4)
            continue
        cur = (st.get("status"), st.get("current_iteration"))
        if cur != last:
            print(f"  [{int(time.time()-started):>3}s] status={cur[0]} iter={cur[1]}")
            last = cur
        for e in st.get("events", []) or []:
            seq = e.get("seq", 0)
            if seq > last_seq:
                last_seq = seq
                brief = _brief_event(e)
                if brief:
                    print(f"    evt#{seq:>3} {e.get('type')} {brief}")
        if cur[0] in ("completed", "failed", "cancelled"):
            return "poll", st
        # manual 模式进入 waiting_interaction 时上抛；本 skill 不自动应答
        # ask_question（需用户交互），由 agent 决定后续处理。
        if cur[0] == "waiting_interaction":
            eprint(f"[interaction] 任务进入 waiting_interaction；"
                   f"请调用 POST /api/v1/tasks/{task_id}/respond 应答后重试。")
            return "waiting", st
        time.sleep(4)
    return "timeout", None


def _brief_event(e):
    t = e.get("type", "?")
    d = e.get("data", {}) or {}
    if t == "tool_call":
        return f"tool={d.get('tool')} status={d.get('status')}"
    if t == "iteration":
        return f"iter={d.get('iteration')} tokens={d.get('token_count')}"
    if t in ("subagent_start", "subagent_complete"):
        return f"agent={d.get('agent_id')}"
    return ""


def cmd_status(args):
    cfg = load_cfg()
    code, st = api(cfg, "GET", f"/api/v1/tasks/{args.task_id}", timeout=30)
    if code != 200:
        die(f"HTTP={code}: {json.dumps(st, ensure_ascii=False)}")
    print(json.dumps({
        "status": st.get("status"),
        "current_iteration": st.get("current_iteration"),
        "result": st.get("result"),
    }, ensure_ascii=False, indent=2))
    if st.get("status") == "completed" and st.get("result"):
        inner = st["result"]
        patch = {
            "status": "completed",
            "preview_url": inner.get("preview_url"),
            "project_name": inner.get("project_name"),
            "screenshot_url": screenshot_full(cfg, inner.get("screenshot_url")),
        }
        patch = {k: v for k, v in patch.items() if v is not None}
        if update_row(cfg["apps_file"], "task_id", args.task_id, patch):
            eprint(f"[manifest] 更新 task_id={args.task_id}")


def cmd_list(args):
    cfg = load_cfg()
    rows = read_manifest(cfg["apps_file"])
    if not rows:
        print("暂无已构建 app。可执行：使用ddb 构建 <描述>")
        return
    if args.refresh:
        for r in rows:
            tid = r.get("task_id")
            if not tid:
                continue
            code, st = api(cfg, "GET", f"/api/v1/tasks/{tid}", timeout=15)
            if code != 200:
                continue
            inner = st.get("result") or {}
            r["status"] = st.get("status") or r.get("status")
            if inner.get("preview_url"):
                r["preview_url"] = inner["preview_url"]
            if inner.get("project_name"):
                r["project_name"] = inner["project_name"]
            shot = screenshot_full(cfg, inner.get("screenshot_url"))
            if shot:
                r["screenshot_url"] = shot
        write_manifest(cfg["apps_file"], rows)

    rows.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    sym = {"completed": "✅", "failed": "❌", "cancelled": "⛔",
           "running": "⏳", "waiting_interaction": "❓"}
    for i, r in enumerate(rows, 1):
        s = r.get("status") or "?"
        name = r.get("project_name") or "(未命名)"
        ws = r.get("workspace_id", "?")
        # 优先展示 viewer_url（任意访问者可开），fallback 至 preview_url（仅 owner 可开）
        url = r.get("viewer_url") or r.get("preview_url") or "(no preview)"
        ts = (r.get("created_at") or "?").replace("T", " ").rstrip("Z")
        q = (r.get("query") or "").strip().replace("\n", " ")
        q = q[:60] + ("…" if len(q) > 60 else "")
        print(f"{i}. [{name}]  ws={ws}")
        print(f"   {ts}  {sym.get(s, '?')} {s}  「{q}」")
        print(f"   {url}")


def cmd_open(args):
    cfg = load_cfg()
    rows = [r for r in read_manifest(cfg["apps_file"])
            if r.get("workspace_id") == args.workspace_id]
    if not rows:
        die(f"清单里没有 workspace_id={args.workspace_id}")
    r = rows[-1]
    # 已有 viewer_url 直接输出；无则铸造一条并回写清单
    if r.get("viewer_url"):
        print(r["viewer_url"])
    elif r.get("preview_url"):
        vl = mint_viewer_link(cfg, args.workspace_id, label="ddb-open")
        if vl:
            update_row(cfg["apps_file"], "workspace_id", args.workspace_id,
                       {"viewer_url": vl["viewer_url"],
                        "viewer_id": vl.get("viewer_id")})
            print(vl["viewer_url"])
        else:
            eprint("[viewer-link] 铸造失败，回退至 owner URL（需 DeepDiver 登录才能访问）")
            print(r["preview_url"])
    else:
        print("(no preview URL recorded)")
    if r.get("screenshot_url"):
        print(r["screenshot_url"])


def cmd_cancel(args):
    cfg = load_cfg()
    code, r = api(cfg, "POST", f"/api/v1/tasks/{args.task_id}/cancel", body={})
    print(f"HTTP={code} {json.dumps(r, ensure_ascii=False)}")


def cmd_config(args):
    """保存 API key 到本地 auth 文件，跨会话持久化。"""
    data = {}
    if AUTH_FILE.exists():
        try:
            with AUTH_FILE.open("r", encoding="utf-8") as f:
                data = json.loads(f.read())
        except Exception:
            pass
    data["api_key"] = args.key
    write_auth(data)
    print(f"API key 已保存至 {AUTH_FILE}")


DESC = {
    "list": {
        "help": "ddb list [--refresh]\n         列出本地清单\n         示例: ddb list",
    },
    "create": {
        "help": "ddb create --query <描述> [--manual] [--wait <秒>]\n         新建 app（webhook 优先，轮询降级）\n         示例: ddb create --query \"帮我做一个 Todo 应用\"",
    },
    "followup": {
        "help": "ddb followup --workspace-id <id> --query <描述>\n         对已有 workspace 追加需求\n         示例: ddb followup --workspace-id xxx --query \"添加暗黑模式\"",
    },
    "status": {
        "help": "ddb status <task_id>\n         查询最新状态并回写清单\n         示例: ddb status 95c03763-xxx",
    },
    "open": {
        "help": "ddb open <workspace_id>\n         输出可分享的 preview URL\n         示例: ddb open 850b4880-xxx",
    },
    "cancel": {
        "help": "ddb cancel <task_id>\n         取消运行中任务\n         示例: ddb cancel 95c03763-xxx",
    },
    "config": {
        "help": "ddb config --key <api_key>\n         保存 API key 至本地 ~/.deepdiver/auth.json（跨会话持久化）\n         示例: ddb config --key sk-hdls-abc123",
    },
}

# ------------------------------ utils -----------------------------------

def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(s, n):
    return (s[:n] + "…") if s and len(s) > n else s


def die(msg, code=1):
    eprint(f"[ERROR] {msg}")
    sys.exit(code)


def eprint(*a, **k):
    print(*a, file=sys.stderr, **k)


# ------------------------------- main -----------------------------------

def build_parser():
    p = argparse.ArgumentParser(
        prog="ddb",
        formatter_class=argparse.RawTextHelpFormatter,
        description="DeepDiver Builder — 通过 Headless API 在云端构建 App",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    pc = sub.add_parser("create", help=DESC["create"]["help"])
    pc.add_argument("--query", required=True)
    pc.add_argument("--manual", action="store_true")
    pc.add_argument("--wait", type=int, default=0)
    pc.set_defaults(func=cmd_create)

    pf = sub.add_parser("followup", help=DESC["followup"]["help"])
    pf.add_argument("--workspace-id", required=True)
    pf.add_argument("--resume-token")
    pf.add_argument("--query", required=True)
    pf.add_argument("--manual", action="store_true")
    pf.add_argument("--wait", type=int, default=0)
    pf.set_defaults(func=cmd_followup)

    ps = sub.add_parser("status", help=DESC["status"]["help"])
    ps.add_argument("task_id")
    ps.set_defaults(func=cmd_status)

    pl = sub.add_parser("list", help=DESC["list"]["help"])
    pl.add_argument("--refresh", action="store_true")
    pl.set_defaults(func=cmd_list)

    po = sub.add_parser("open", help=DESC["open"]["help"])
    po.add_argument("workspace_id")
    po.set_defaults(func=cmd_open)

    px = sub.add_parser("cancel", help=DESC["cancel"]["help"])
    px.add_argument("task_id")
    px.set_defaults(func=cmd_cancel)

    pcfg = sub.add_parser("config", help=DESC["config"]["help"])
    pcfg.add_argument("--key", required=True, help="DeepDiver API key（格式 sk-hdls-<32hex>）")
    pcfg.set_defaults(func=cmd_config)

    return p


def main():
    # 强制 stdout/stderr 行缓冲：exec background 模式下管道输出默认块缓冲，
    # 会导致 agent 中途读不到任何进度。Python 3.7+ 支持 reconfigure。
    try:
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except AttributeError:
        pass
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
