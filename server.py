#!/usr/bin/env python3
"""Serve Life Atlas with privacy headers and an optional access-code gate."""
from __future__ import annotations

import hashlib
import hmac
import http.cookies
import http.server
import os
import socketserver
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "4173"))
HOST = os.environ.get("HOST", "127.0.0.1")
ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN", "")
SESSION_COOKIE = "life_atlas_session"
SESSION_VALUE = hashlib.sha256(f"life-atlas-session:{ACCESS_TOKEN}".encode()).hexdigest() if ACCESS_TOKEN else ""


def login_page(error: bool = False) -> bytes:
    error_html = '<p class="login-error" role="alert">アクセスコードが違います。</p>' if error else ""
    return f"""<!doctype html>
<html lang="ja" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="robots" content="noindex,nofollow,noarchive" />
  <meta name="color-scheme" content="dark" />
  <title>Life Atlas Access</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body class="login-body">
  <main class="login-shell">
    <div class="login-brand">Life Atlas</div>
    <h1>位置履歴ダッシュボード</h1>
    <p>この画面は非公開です。アクセスコードを入力してください。</p>
    {error_html}
    <form class="login-form" method="post" action="/login">
      <label for="access-code">アクセスコード</label>
      <input id="access-code" name="access_code" type="password" required autocomplete="current-password" autofocus />
      <button type="submit">開く</button>
    </form>
    <small>軌跡はブラウザ内で描画します。背景地図のみOpenStreetMap/CARTOから取得します。</small>
  </main>
</body>
</html>
""".encode("utf-8")


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "LifeAtlas"
    sys_version = ""
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _authorized(self) -> bool:
        if not ACCESS_TOKEN:
            return True
        raw_cookie = self.headers.get("Cookie", "")
        try:
            cookies = http.cookies.SimpleCookie(raw_cookie)
            value = cookies.get(SESSION_COOKIE)
            return bool(value and hmac.compare_digest(value.value, SESSION_VALUE))
        except http.cookies.CookieError:
            return False

    def _send_login(self, *, error: bool = False, status: int = 200) -> None:
        body = login_page(error)
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location: str) -> None:
        self.send_response(303)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/healthz":
            body = b'{"ok":true,"service":"life-atlas"}\n'
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/styles.css":
            super().do_GET()
            return
        if path == "/logout" and ACCESS_TOKEN:
            self.send_response(303)
            self.send_header("Location", "/")
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
            )
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not self._authorized():
            if path == "/":
                self._send_login()
            else:
                self._redirect("/")
            return
        super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path != "/login" or not ACCESS_TOKEN:
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 4096:
            self._send_login(error=True, status=400)
            return
        body = self.rfile.read(length).decode("utf-8", errors="replace")
        submitted = urllib.parse.parse_qs(body, keep_blank_values=True).get("access_code", [""])[0]
        if not hmac.compare_digest(submitted, ACCESS_TOKEN):
            self._send_login(error=True, status=401)
            return
        self.send_response(303)
        self.send_header("Location", "/")
        self.send_header(
            "Set-Cookie",
            f"{SESSION_COOKIE}={SESSION_VALUE}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict",
        )
        self.send_header("Content-Length", "0")
        self.end_headers()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")
        self.send_header("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data: https://*.basemaps.cartocdn.com; "
            "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; "
            "frame-ancestors 'none'; form-action 'self'",
        )
        super().end_headers()

    def log_request(self, code="-", size="-"):
        path = urllib.parse.urlsplit(self.path).path
        print(f"[life-atlas] {self.command} {path} {code} {size}", flush=True)

    def log_message(self, fmt, *args):
        pass


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    os.chdir(ROOT)
    gate = "enabled" if ACCESS_TOKEN else "disabled"
    with ReusableTCPServer((HOST, PORT), Handler) as server:
        print(f"Life Atlas listening on http://{HOST}:{PORT} (access gate {gate})", flush=True)
        server.serve_forever()
