"""OAuth Runway local server.

  GET  /                     the web app
  GET  /api/guides           library + generated guides (summary fields)
  GET  /api/guides/<id>      one full guide
  POST /api/generate         {"app": "..."} -> Server-Sent Events while the agent investigates

Stdlib only, apart from the Anthropic SDK used by the investigator.
"""

import json
import os
import re
import sys
import threading
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
LIBRARY = ROOT / "data" / "guides"
GENERATED = ROOT / "data" / "generated"
WEB = ROOT / "web"
_locks = {}


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "app"


def load_all():
    guides = {}
    for folder, source in ((LIBRARY, "library"), (GENERATED, "generated")):
        for path in sorted(folder.glob("*.json")):
            try:
                g = json.loads(path.read_text())
            except json.JSONDecodeError:
                continue
            g.setdefault("meta", {})["collection"] = source
            guides.setdefault(g["id"], g)  # library wins over a generated guide with the same id
    return guides


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/status":
            return self._json({"live": bool(os.environ.get("ANTHROPIC_API_KEY"))})
        if self.path == "/api/guides":
            return self._json(list(load_all().values()))
        m = re.fullmatch(r"/api/guides/([a-z0-9-]+)", self.path)
        if m:
            g = load_all().get(m.group(1))
            return self._json(g) if g else self._json({"error": "not found"}, 404)
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/generate":
            return self._json({"error": "not found"}, 404)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            app = (json.loads(self.rfile.read(length) or b"{}").get("app") or "").strip()
        except json.JSONDecodeError:
            app = ""
        if not app or len(app) > 200:
            return self._json({"error": "Send {\"app\": \"name or website\"}"}, 400)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(event):
            try:
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

        if not os.environ.get("ANTHROPIC_API_KEY"):
            emit({"type": "error", "text": "ANTHROPIC_API_KEY is not set on the server, so live generation is off. Library guides still work."})
            return

        from agent.investigator import investigate

        slug = slugify(app)
        lock = _locks.setdefault(slug, threading.Lock())
        with lock:
            try:
                guide = investigate(app, emit)
                guide["id"] = slugify(guide.get("id") or slug)
                if guide["id"] in {p.stem for p in LIBRARY.glob("*.json")}:
                    guide["id"] += "-live"
                GENERATED.mkdir(parents=True, exist_ok=True)
                (GENERATED / f"{guide['id']}.json").write_text(json.dumps(guide, indent=2))
                emit({"type": "done", "id": guide["id"], "guide": guide})
            except Exception as e:
                traceback.print_exc()
                emit({"type": "error", "text": f"{type(e).__name__}: {e}"})


def main():
    port = int(os.environ.get("PORT", "8787"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"OAuth Runway on http://localhost:{port}  (live generation: {'on' if os.environ.get('ANTHROPIC_API_KEY') else 'off, set ANTHROPIC_API_KEY'})")
    server.serve_forever()


if __name__ == "__main__":
    main()
