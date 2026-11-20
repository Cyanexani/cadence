"""Run Cadence on this computer: serves the web app and its music API on localhost."""

import argparse
import json
import os
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from core import dispatch, read_secrets

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DEFAULT_PORT = 5288
MAX_BODY_BYTES = 64 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def answer(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def api(self, body=None):
        url = urlparse(self.path)
        params = {k: v[0] for k, v in parse_qs(url.query).items()}
        status, payload = dispatch(url.path, params, read_secrets(self.headers), body)
        if status >= HTTPStatus.INTERNAL_SERVER_ERROR:
            self.log_error("%s failed: %s", url.path, payload.get("error"))
        self.answer(status, payload)

    def do_GET(self):
        if not self.path.startswith("/api/"):
            return super().do_GET()
        self.api()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            return self.answer(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "That request is too large."})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self.answer(HTTPStatus.BAD_REQUEST, {"error": "The request body must be JSON."})
        self.api(body if isinstance(body, dict) else {})


def main():
    parser = argparse.ArgumentParser(description="Run the Cadence music player.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", DEFAULT_PORT)))
    parser.add_argument("--open", action="store_true", help="open the player in your browser")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Cadence is running at {url}  (Ctrl+C to stop)", flush=True)
    if args.open:
        threading.Timer(0.6, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
