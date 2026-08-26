# Dev-only static server that disables caching so module edits show on reload.
# Run: python3 scripts/dev-server.py [port]
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8642


class NoStoreHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


http.server.ThreadingHTTPServer(("", PORT), NoStoreHandler).serve_forever()
