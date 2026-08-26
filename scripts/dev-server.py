# Dev-only static server: disables caching so module edits show on reload,
# and accepts frame dumps at POST /__frame/<name>.png (base64 body) into
# .frames/ for assembling the README demo GIF. Never deployed; Pages is static.
import base64
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8642
FRAMES_DIR = ".frames"


class DevHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path.startswith("/__frame/"):
            name = os.path.basename(self.path)
            n = int(self.headers.get("Content-Length", 0))
            data = self.rfile.read(n)
            os.makedirs(FRAMES_DIR, exist_ok=True)
            with open(os.path.join(FRAMES_DIR, name), "wb") as f:
                f.write(base64.b64decode(data))
            self.send_response(204)
        else:
            self.send_response(404)
        self.end_headers()


http.server.ThreadingHTTPServer(("", PORT), DevHandler).serve_forever()
