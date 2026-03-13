#!/usr/bin/env python3
"""
Local npm registry proxy for the GitHub Copilot Agent sandbox environment.

WHY THIS EXISTS:
The sandbox uses a MITM proxy (padawan-fw / GoProxy) that intercepts all HTTPS
traffic. This proxy corrupts Brotli-encoded responses from the npm registry
(truncates or garbles the compressed body), which causes `bun install` to fail
with "HTTPError downloading package manifest" or "Unterminated string literal"
errors.

This proxy fixes that by:
1. Accepting HTTP connections from bun on localhost:4873
2. Re-fetching from the real npm registry using gzip-only encoding (no Brotli)
3. Returning the decompressed response to bun as plain HTTP

USAGE:
    python3 scripts/sandbox-npm-proxy.py &
    BUN_CONFIG_REGISTRY="http://127.0.0.1:4873" bun install --frozen-lockfile
"""
import http.server
import socketserver
import urllib.request
import urllib.error
import gzip
import zlib
import sys

NPM_REGISTRY = "https://registry.npmjs.org"
PORT = 4873


class NpmProxyHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[npm-proxy] {self.path} -> {format % args}", file=sys.stderr, flush=True)

    def log_error(self, format, *args):
        print(f"[npm-proxy-err] {format % args}", file=sys.stderr, flush=True)

    def do_GET(self):
        self._proxy_request()

    def do_HEAD(self):
        self._proxy_request()

    def _proxy_request(self):
        target_url = NPM_REGISTRY + self.path

        # Use gzip only (NOT brotli) — the sandbox MITM proxy corrupts Brotli responses
        headers = {
            "Accept": "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
            "Accept-Encoding": "gzip, deflate",
            "User-Agent": "bun-sandbox-proxy/1.0",
            "Connection": "close",
        }
        for h in ["Authorization", "npm-auth-type"]:
            val = self.headers.get(h)
            if val:
                headers[h] = val

        try:
            req = urllib.request.Request(target_url, headers=headers, method=self.command)
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read() if self.command == "GET" else b""
                content_encoding = resp.headers.get("Content-Encoding", "")
                content_type = resp.headers.get("Content-Type", "application/json")
                status = resp.status

                # Decompress the body so bun receives plain uncompressed data
                if content_encoding == "gzip" and body:
                    body = gzip.decompress(body)
                elif content_encoding == "deflate" and body:
                    body = zlib.decompress(body)

                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                if self.command == "GET":
                    self.wfile.write(body)

        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            body = e.read() if e.fp else b"HTTP Error"
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command == "GET":
                self.wfile.write(body)
        except Exception as e:
            print(f"[npm-proxy] ERROR for {self.path}: {e}", file=sys.stderr, flush=True)
            try:
                self.send_response(500)
                body = str(e).encode()
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if self.command == "GET":
                    self.wfile.write(body)
            except Exception:
                pass


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded server to handle bun's concurrent connections."""
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    server = ThreadedHTTPServer(("127.0.0.1", PORT), NpmProxyHandler)
    server.socket.listen(64)  # Large backlog for bun's concurrent connection attempts
    print(f"npm sandbox proxy started on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
