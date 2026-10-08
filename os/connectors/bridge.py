"""The local MCP bridge: agents call http://127.0.0.1:PORT/<key>/<code>/mcp and
the bridge forwards to the service's MCP server with the stored credential,
renewing it first when it is about to expire.

systemd starts it on the first connection (harness-connections.socket) and it
exits after a quiet spell, so it costs nothing while no agent uses a service.
"""
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import socket
import sys
import threading
import time
import urllib.parse

import connection_store as store
import renew

IDLE_SECONDS = 600
# Headers an MCP client sends that the service must see. Authorization never
# comes from the agent: the bridge sets it.
FORWARD = ("accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id")
RETURN = ("content-type", "mcp-session-id", "mcp-protocol-version", "cache-control")
MAX_BODY = 16 * 1024 * 1024


class Bridge(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, vault, listener=None, port=0):
        self.vault = vault
        self.active = 0
        self.lock = threading.Lock()
        self.last = time.monotonic()
        if listener is None:
            super().__init__(("127.0.0.1", port), Handler)
        else:
            super().__init__(listener.getsockname()[:2], Handler, bind_and_activate=False)
            self.socket = listener
        self.timeout = 5

    def key(self):
        return self.vault.file("bridge.json").get("key", "")

    def busy(self, delta):
        with self.lock:
            self.active += delta
            self.last = time.monotonic()

    def serve_until_idle(self, idle=IDLE_SECONDS):
        while self.active or time.monotonic() - self.last < idle:
            self.handle_request()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Harness"

    def log_message(self, *_args):
        pass  # Never log request bodies, accounts or bridge addresses.

    def fail(self, status, message):
        # A JSON-RPC shaped error, so the agent shows the reason to the user.
        raw = json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32001, "message": message}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        # A refused request's body may be unread: never parse it as the next request.
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(raw)

    def target(self):
        parts = urllib.parse.urlsplit(self.path).path.strip("/").split("/")
        if len(parts) != 3 or parts[2] != "mcp":
            return None
        key = self.server.key()
        if not key or not hmac.compare_digest(parts[0].encode(), key.encode()):
            return None
        return parts[1]

    def handle_one(self):
        self.server.busy(1)
        try:
            self.relay()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.server.busy(-1)

    do_GET = do_POST = do_DELETE = handle_one

    def relay(self):
        # Only a process on this computer that knows this user's key gets through.
        if self.headers.get("Origin") or self.client_address[0] not in ("127.0.0.1", "::1"):
            self.fail(403, "Forbidden.")
            return
        code = self.target()
        if code is None:
            self.fail(404, "Unknown connection address. Run harness connections sync.")
            return
        if self.headers.get("Transfer-Encoding"):
            self.fail(411, "Send the request with a Content-Length.")
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > MAX_BODY:
            self.fail(413, "Request is too large.")
            return
        body = self.rfile.read(length) if length else None
        name = store.SERVICES.get(code, code)
        try:
            token = self.server.vault.token(code)
            if not token or not token.get("mcp_entry"):
                self.fail(404, f"{name} is not connected. Open harness connections to connect it.")
                return
            if store.needs_refresh(token):
                token = renew.refresh(self.server.vault, code)
        except store.StoreError as error:
            self.fail(401, f"{name}: {error}")
            return
        response, connection = self.forward(token, body)
        if response.status == 401 and store.refreshable(token):
            # A token the service revoked early: renew once and try again.
            connection.close()
            try:
                token = renew.refresh(self.server.vault, code, force=True)
            except store.StoreError as error:
                self.fail(401, f"{name}: {error}")
                return
            response, connection = self.forward(token, body)
        try:
            if response.status == 401:
                # Never pass the service's own sign-in challenge to the agent:
                # signing in happens in Harness, not in each agent.
                self.fail(401, f"{name} needs to be connected again. Open harness connections.")
                return
            self.stream(response)
        finally:
            connection.close()

    def forward(self, token, body):
        entry = token["mcp_entry"]
        upstream = urllib.parse.urlsplit(entry["url"])
        query = urllib.parse.urlsplit(self.path).query
        path = (upstream.path or "/") + ("?" + upstream.query if upstream.query else "") + \
            (("&" if upstream.query else "?") + query if query else "")
        headers = {k: v for k, v in self.headers.items() if k.lower() in FORWARD}
        headers.update(entry.get("headers") or {})
        headers["User-Agent"] = "Harness-Connections"
        if body is not None:
            headers["Content-Length"] = str(len(body))
        if upstream.scheme == "https":
            connection = http.client.HTTPSConnection(upstream.hostname, upstream.port or 443, timeout=300)
        else:
            connection = http.client.HTTPConnection(upstream.hostname, upstream.port or 80, timeout=300)
        connection.request(self.command, path, body=body, headers=headers)
        return connection.getresponse(), connection

    def stream(self, response):
        """The service's answer as it arrives: MCP replies may be an event stream."""
        self.send_response(response.status)
        for name, value in response.getheaders():
            if name.lower() in RETURN:
                self.send_header(name, value)
        length = response.getheader("Content-Length")
        if length is not None:
            self.send_header("Content-Length", length)
            self.end_headers()
            self.wfile.write(response.read())
            return
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        while True:
            chunk = response.read1(65536) if hasattr(response, "read1") else response.read(65536)
            if not chunk:
                break
            self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
            self.wfile.flush()
        self.wfile.write(b"0\r\n\r\n")


def systemd_listener():
    """The socket systemd passed (LISTEN_FDS), or None when run by hand."""
    if os.environ.get("LISTEN_PID") != str(os.getpid()) or os.environ.get("LISTEN_FDS") != "1":
        return None
    return socket.socket(fileno=3)


def main(argv):
    vault = store.Store()
    listener = systemd_listener()
    port = int(argv[0]) if argv else 0
    with Bridge(vault, listener, port) as server:
        if listener is None:
            print(f"Bridge on 127.0.0.1:{server.server_address[1]}", flush=True)
        server.serve_until_idle()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
