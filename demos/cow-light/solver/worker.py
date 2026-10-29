#!/usr/bin/env python3
"""Restart-safe adapter for the CoW Light UI queue.

The UI deliberately only authenticates and queues signed orders.  This small
service is the missing live boundary: it serializes route execution through
the generic catalog-token adapter and keeps the process alive across failures.
"""
import json, os, sys, subprocess, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from network_config import load_config
from settlement_state import is_active
from solver.retry_policy import due
CFG = load_config()
QUEUE = CFG['ORDER_QUEUE']
SCRIPT = Path(os.getenv("SETTLE_SCRIPT", Path(__file__).with_name("settle_order.py")))
LOCK = threading.Lock()
INTERVAL = float(os.getenv("POLL_SECONDS", "5"))
last = {"status": "starting"}
LOG = CFG['SOLVER_LOG']

def log(event, **fields):
    rec = {"ts": int(time.time()), "event": event, **fields}
    line = json.dumps(rec, sort_keys=True)
    print(line, flush=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(line + "\n")

def queued():
    if not QUEUE.exists(): return False
    for line in QUEUE.read_text().splitlines():
        try:
            if is_active(json.loads(line)): return True
        except Exception:
            continue
    return False

def run_once():
    global last
    with LOCK:
        rows = [json.loads(x) for x in QUEUE.read_text().splitlines() if x.strip()] if QUEUE.exists() else []
        item = min((row for row in rows if is_active(row) and due(row)),
                   key=lambda row: row.get('solver', {}).get('checkedAt', 0), default=None)
        if not item:
            last = {"status": "idle", "checkedAt": int(time.time())}
            return
        log("order_pickup", orderId=item.get("id"), validTo=item.get("order", {}).get("validTo"), buyToken=item.get("order", {}).get("buyToken"))
        try:
            p = subprocess.run([sys.executable, str(SCRIPT)], cwd=str(BASE),
                               env={**os.environ, 'RETRY_ORDER_ID': item['id']},
                               text=True, capture_output=True, timeout=1100)
            last = {"status": "processed", "exitCode": p.returncode,
                    "stdout": p.stdout[-4000:], "stderr": p.stderr[-2000:],
                    "checkedAt": int(time.time())}
            log("order_worker_exit", orderId=item.get("id"), exitCode=p.returncode,
                stdout=p.stdout[-1500:], stderr=p.stderr[-1500:])
        except Exception as exc:
            last = {"status": "error", "error": str(exc), "checkedAt": int(time.time())}
            log("order_worker_exception", orderId=item.get("id"), error=str(exc))

def loop():
    while True:
        try: run_once()
        except Exception as exc: last.update(status="error", error=str(exc))
        time.sleep(INTERVAL)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health": self.send_response(404); self.end_headers(); return
        body = json.dumps(last).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        if self.path != "/solve": self.send_response(404); self.end_headers(); return
        # The UI has already validated the signed order. Trigger an immediate
        # serialized pass; the queue remains the durable source of truth.
        threading.Thread(target=run_once, daemon=True).start()
        body = b'{"status":"accepted"}'
        self.send_response(202); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_): pass

if __name__ == "__main__":
    threading.Thread(target=loop, daemon=True).start()
    port = int(os.getenv("PORT", "8791"))
    log("worker_start", port=port, queue=str(QUEUE), script=str(SCRIPT))
    ThreadingHTTPServer((os.getenv("HOST", "127.0.0.1"), port), Handler).serve_forever()
