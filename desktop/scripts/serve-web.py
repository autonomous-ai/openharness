#!/usr/bin/env python3
"""Preview build/web on loopback, including the OAuth callback route."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


class WebPreview(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path in {"/callback", "/auth/callback"} or path.startswith("/s/"):
            self.path = "/index.html"
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_request(self, code="-", size="-"):
        # Authorization codes and state must not appear in the preview log.
        self.log_message('"%s %s" %s %s', self.command,
                         urlsplit(self.path).path, code, size)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3000)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1] / "build" / "web"
    if not (root / "index.html").is_file():
        parser.error("Build the app first with flutter build web")
    handler = partial(WebPreview, directory=str(root))
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        print(f"Harness preview: http://127.0.0.1:{args.port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
