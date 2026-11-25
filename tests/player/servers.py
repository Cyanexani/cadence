"""Servers for the player tests: the harness pages (8001), mock audio on another origin with Range and
CORS like the app's audio server (8002), and the real public/ folder (8003)."""
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "..", "..", "public")
LOG = []
SONGS = {"AAAAAAAAAAA": "a.wav", "BBBBBBBBBBB": "b.wav"}
PAGES = {
    "/harness.html": ("harness.html", "text/html"),
    "/harness-native.html": ("harness-native.html", "text/html"),
    "/harness-hybrid.html": ("harness-hybrid.html", "text/html"),
    "/engine.js": (os.path.join("..", "..", "public", "engine.js"), "text/javascript"),
}


class Page(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/__log":
            body = json.dumps(LOG).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path not in PAGES:
            self.send_response(404)
            self.end_headers()
            return
        name, content_type = PAGES[path]
        with open(os.path.join(HERE, name), "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Audio(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        match = re.match(r"^/secret/([A-Za-z0-9_-]{11})$", self.path.split("?")[0])
        if not match or match.group(1) not in SONGS:
            self.send_response(404)
            self.cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        with open(os.path.join(HERE, SONGS[match.group(1)]), "rb") as f:
            data = f.read()
        size = len(data)
        wanted = self.headers.get("Range")
        LOG.append({"id": match.group(1), "range": wanted, "origin": self.headers.get("Origin")})
        start, end, status = 0, size - 1, 200
        parsed = re.match(r"bytes=(\d*)-(\d*)$", wanted or "")
        if parsed:
            first, last = parsed.groups()
            start = int(first) if first else max(0, size - int(last))
            end = min(int(last), size - 1) if (first and last) else size - 1
            status = 206
        body = data[start:end + 1]
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(len(body)))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


class Public(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    servers = [
        (8001, Page),
        (8002, Audio),
        (8003, partial(Public, directory=PUBLIC)),
    ]
    for port, handler in servers:
        server = ThreadingHTTPServer(("127.0.0.1", port), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    print("ready", flush=True)
    threading.Event().wait()
