"""Vercel serverless entry point: every /api/* request is rewritten here (see vercel.json)."""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import CACHEABLE, dispatch, is_personal, read_secrets  # noqa: E402  (path set up above)

EDGE_CACHE = "public, s-maxage=600, stale-while-revalidate=3600"
MAX_BODY_BYTES = 64 * 1024


class handler(BaseHTTPRequestHandler):  # Vercel's Python runtime looks for this exact name
    def run(self, body=None):
        url = urlparse(self.path)
        params = {k: v[0] for k, v in parse_qs(url.query).items()}
        route = params.pop("route", None)
        path = f"/api/{route.strip('/')}" if route else url.path
        secrets = read_secrets(self.headers)
        status, payload = dispatch(path, params, secrets, body)
        shareable = status == 200 and body is None and path in CACHEABLE and not is_personal(path, secrets)
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        # Anything answered for a signed-in listener is theirs alone: never let the edge keep it.
        self.send_header("Cache-Control", EDGE_CACHE if shareable else "private, no-store")
        self.send_header("Vary", "X-Cadence-Token")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.run()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(min(length, MAX_BODY_BYTES)) or b"{}")
        except json.JSONDecodeError:
            body = {}
        self.run(body if isinstance(body, dict) else {})
