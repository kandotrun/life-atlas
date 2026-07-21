#!/usr/bin/env python3
from __future__ import annotations

import http.client
import json
import os
import socket
import subprocess
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEST_TOKEN = "test-only-access-code-42"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(port: int, method: str, path: str, body: str | None = None, headers: dict[str, str] | None = None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    payload = body.encode() if body is not None else None
    merged = dict(headers or {})
    if payload is not None:
        merged.setdefault("Content-Type", "application/x-www-form-urlencoded")
        merged.setdefault("Content-Length", str(len(payload)))
    connection.request(method, path, body=payload, headers=merged)
    response = connection.getresponse()
    data = response.read()
    result = response.status, dict(response.getheaders()), data
    connection.close()
    return result


def main() -> None:
    expected_record_count = json.loads(
        (ROOT / "data" / "location-data.json").read_text(encoding="utf-8")
    )["source"]["recordCount"]
    port = free_port()
    env = os.environ.copy()
    env.update({"HOST": "127.0.0.1", "PORT": str(port), "ACCESS_TOKEN": TEST_TOKEN})
    process = subprocess.Popen(
        ["python3", "server.py"],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        for _ in range(50):
            try:
                status, _, _ = request(port, "GET", "/healthz")
                if status == 200:
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise AssertionError("Server did not become ready")

        status, headers, body = request(port, "GET", "/")
        assert status == 200
        assert b'type="password"' in body
        assert b'id="real-map"' not in body
        assert "noindex" in headers["X-Robots-Tag"]
        csp = headers["Content-Security-Policy"]
        assert "https://*.basemaps.cartocdn.com" in csp
        assert "connect-src 'self'" in csp

        status, headers, _ = request(port, "GET", "/data/location-data.json")
        assert status == 303
        assert headers["Location"] == "/"

        wrong = urllib.parse.urlencode({"access_code": "wrong"})
        status, _, body = request(port, "POST", "/login", wrong)
        assert status == 401
        assert "アクセスコードが違います" in body.decode()

        correct = urllib.parse.urlencode({"access_code": TEST_TOKEN})
        status, headers, _ = request(port, "POST", "/login", correct)
        assert status == 303
        cookie = headers["Set-Cookie"]
        assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=Strict" in cookie
        cookie_pair = cookie.split(";", 1)[0]

        status, _, body = request(port, "GET", "/", headers={"Cookie": cookie_pair})
        assert status == 200
        assert b'id="real-map"' in body

        status, _, body = request(port, "GET", "/data/location-data.json", headers={"Cookie": cookie_pair})
        assert status == 200
        assert f'"recordCount":{expected_record_count}'.encode() in body

        output = ""
        if process.stdout:
            time.sleep(0.05)
            process.terminate()
            output = process.stdout.read()
        assert TEST_TOKEN not in output
        print("server auth test: ok")
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    main()
