# -*- coding: utf-8 -*-
"""HTTP 服务：/api/* -> app.dispatch；其余 -> static/。仅标准库。"""
import json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import app, store

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")

class Handler(BaseHTTPRequestHandler):
    def _send(self, status, obj, ctype="application/json; charset=utf-8"):
        data = obj if isinstance(obj, bytes) else json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode() or "{}")
        except json.JSONDecodeError:
            return {}

    def _route(self, method):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/"):
            status, obj = app.dispatch(method, path, self._body() if method == "POST" else None)
            self._send(status, obj)
            return
        if path in ("/", "/index.html"):
            with open(os.path.join(STATIC, "index.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
            return
        self._send(404, {"error": {"code": "NOT_FOUND", "message": path}})

    def do_GET(self):  self._route("GET")
    def do_POST(self): self._route("POST")
    def log_message(self, *a): pass

def main():
    store.init()
    port = int(os.environ.get("PORT", "8000"))
    print(f"木作定制站已启动: http://127.0.0.1:{port}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

if __name__ == "__main__":
    main()
