#!/usr/bin/env python3
"""On-demand, loopback-only Connectors page and commands for Harness OS.

harness connections                 open the Connectors page
harness connections connect CODE    sign in from the terminal
harness connections disconnect CODE
harness connections refresh [CODE]  renew tokens that are due (or CODE now)
harness connections sync            give agents their connections again
harness connections list|info|call  see connector.py
"""
import argparse
import contextlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import agents
import connection_store as store
import connector
import gateway
import oauth
import renew

ASSETS = Path(__file__).parent / "web"
# Bundled service icons: Autonomous's connector icons, Simple Icons (CC0) and
# the services' own favicons, so the page loads nothing from the network.
ICONS = {path.stem: path.name for path in (ASSETS / "icons").iterdir() if path.suffix in (".png", ".svg")}
ICON_TYPES = {".png": "image/png", ".svg": "image/svg+xml"}
GATEWAY_CACHE_SECONDS = 60


def identity_proof(key, nonce):
    return hmac.new(key.encode(), ("harness-connections-v1:" + nonce).encode(), "sha256").hexdigest()


def custom_code(name, taken):
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "server"
    code = base if base not in store.CATALOG else "custom-" + base
    n = 2
    while code in taken:
        code, n = f"{base}-{n}", n + 1
    return store.validate_code(code)


def sign_in_for(vault, code):
    """The sign-in that connects CODE: the gateway's or this computer's own."""
    item = store.CATALOG.get(code)
    if item is None:
        raise store.StoreError("Unknown connection.")
    if item["auth"] == "app":
        return gateway.SignIn(code)
    return oauth.SignIn(vault, item["mcp_url"])


def finish(vault, code, token, label=None):
    if label:
        token["label"] = label
        token["source"] = "custom"
    vault.save(code, token)
    with contextlib.suppress(store.StoreError, OSError):
        agents.sync(vault)


def disconnect(vault, code):
    token = vault.token(code)
    if token and token.get("source") == "gateway":
        gateway.disconnect(code)
    vault.disconnect(code)
    with contextlib.suppress(store.StoreError, OSError):
        agents.sync(vault)


class Flows:
    """Browser sign-ins in progress, each finishing on its own thread."""

    def __init__(self, vault):
        self.vault, self.items, self.lock = vault, {}, threading.Lock()

    def start(self, code, sign_in, label=None):
        authorize = sign_in.prepare()
        flow = secrets.token_urlsafe(12)
        record = {"connector": code, "state": "pending", "error": "", "cancel": False}
        with self.lock:
            # One sign-in per service: a newer one replaces a forgotten tab.
            for other in self.items.values():
                if other["connector"] == code and other["state"] == "pending":
                    other["cancel"] = True
            self.items[flow] = record

        def run():
            try:
                token = sign_in.wait(lambda: record["cancel"])
                finish(self.vault, code, token, label)
                record["state"] = "connected"
            except (store.StoreError, OSError) as error:
                record.update(state="failed", error=str(error) if isinstance(error, store.StoreError)
                              else "The sign-in did not finish. Try again.")
        threading.Thread(target=run, daemon=True).start()
        return {"flow": flow, "authorize_url": authorize}

    def get(self, flow):
        with self.lock:
            record = self.items.get(flow)
        if not record:
            raise store.StoreError("This sign-in has ended. Try again.")
        return {"connector": record["connector"], "state": record["state"], "error": record["error"]}


def catalog(vault, offered=None):
    """The page's cards: every service, connected first, then custom servers."""
    tokens = vault.tokens()
    signed_in = gateway.session() is not None
    offered = offered or {}
    items = []
    for code, item in store.CATALOG.items():
        card = vault.status(code, tokens.get(code) or {})
        card.update(description=item["description"], color=item["color"], auth=item["auth"], custom=False, reason="",
                    icon="/icons/" + ICONS[code] if code in ICONS else "")
        if item["auth"] == "app" and card["state"] == "not_connected":
            if not signed_in:
                card["reason"] = "Needs harness login"
            elif offered and code not in offered:
                card["reason"] = "Not available yet."
        items.append(card)
    for code, token in tokens.items():
        if code in store.CATALOG:
            continue
        card = vault.status(code, token)
        card.update(description=token.get("mcp_entry", {}).get("url", ""), color="#59634b", auth="custom", custom=True,
                    reason="", icon="")
        items.append(card)
    return {"connections": items, "signed_in": signed_in}


class PageServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True

    def __init__(self, vault=None, port=0, idle_seconds=900):
        self.vault = vault or store.Store()
        self.flows = Flows(self.vault)
        self.key = secrets.token_urlsafe(32)
        self.idle_seconds = idle_seconds
        self.last_request = time.monotonic()
        self.offered, self.offered_at = {}, 0.0
        super().__init__(("127.0.0.1", port), PageHandler)
        self.origin = "http://127.0.0.1:" + str(self.server_address[1])
        self.timeout = 1

    def gateway_offers(self):
        if time.monotonic() - self.offered_at > GATEWAY_CACHE_SECONDS:
            self.offered, self.offered_at = gateway.available(), time.monotonic()
        return self.offered

    def busy(self):
        return any(f["state"] == "pending" for f in self.flows.items.values())

    def serve_until_idle(self):
        while self.busy() or time.monotonic() - self.last_request < self.idle_seconds:
            self.handle_request()


class PageHandler(BaseHTTPRequestHandler):
    server_version = "Harness"

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_args):
        pass  # Do not log account names, request bodies or session credentials.

    def reply(self, status, body, content_type="application/json"):
        raw = json.dumps(body).encode() if content_type == "application/json" else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(raw)

    def local(self):
        return (self.headers.get("Host") == self.server.origin.removeprefix("http://") and
                self.headers.get("Sec-Fetch-Site", "none") in ("none", "same-origin"))

    def authenticated(self):
        key = self.headers.get("X-Harness-Connections", "")
        return self.local() and hmac.compare_digest(key.encode(), self.server.key.encode())

    def do_GET(self):
        if not self.local():
            self.reply(403, {"error": "Open Connections from this computer."})
            return
        if self.path == "/api/identity":
            nonce = self.headers.get("X-Harness-Probe", "")
            if not re.fullmatch(r"[0-9a-f]{64}", nonce):
                self.reply(400, {"error": "Invalid identity challenge."})
                return
            self.reply(200, {"proof": identity_proof(self.server.key, nonce)})
            return
        if self.path == "/api/connections" or self.path.startswith("/api/flows/"):
            if not self.authenticated():
                self.reply(403, {"error": "Open harness connections again to continue."})
                return
            self.server.last_request = time.monotonic()
            try:
                if self.path == "/api/connections":
                    offered = self.server.gateway_offers()
                    self.reply(200, catalog(self.server.vault, offered))
                else:
                    self.reply(200, self.server.flows.get(self.path.removeprefix("/api/flows/")))
            except store.StoreError as error:
                self.reply(400, {"error": str(error)})
            return
        files = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/style.css": ("style.css", "text/css; charset=utf-8"),
                 "/page.js": ("page.js", "text/javascript; charset=utf-8")}
        # Only the names listed at start-up: never a path from the request.
        icon = self.path.removeprefix("/icons/")
        if icon in ICONS.values():
            files[self.path] = ("icons/" + icon, ICON_TYPES[Path(icon).suffix])
        if self.path not in files:
            self.reply(404, {"error": "Not found."})
            return
        name, kind = files[self.path]
        self.reply(200, (ASSETS / name).read_bytes(), kind)

    def do_POST(self):
        if (not self.authenticated() or self.headers.get("Origin") != self.server.origin or
                self.headers.get("Content-Type") != "application/json" or self.headers.get("Transfer-Encoding")):
            self.reply(403, {"error": "Open Connections from this computer."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 16384:
                self.reply(413, {"error": "Request is too large."})
                return
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError()
            self.server.last_request = time.monotonic()
            vault = self.server.vault
            if self.path == "/api/connect":
                code = store.validate_code(data.get("connector"))
                result = self.server.flows.start(code, sign_in_for(vault, code))
            elif self.path == "/api/custom":
                result = self.custom(data)
            elif self.path == "/api/disconnect":
                code = store.validate_code(data.get("connector"))
                disconnect(vault, code)
                result = {"connector": code, "state": "not_connected"}
            else:
                self.reply(404, {"error": "Not found."})
                return
            self.reply(200, result)
        except (store.StoreError, connector.Failure) as error:
            self.reply(400, {"error": str(error)})
        except (ValueError, TypeError):
            self.reply(400, {"error": "Invalid request."})
        except (OSError, TimeoutError):
            self.reply(503, {"error": "Connection unavailable. Try again."})

    def custom(self, data):
        """Add custom: a remote MCP server, signed in like any other when it asks."""
        name = store.text(data.get("name"), 64).strip()
        url = store.clean_url((data.get("url") or "").strip())
        headers = store.clean_headers(data.get("headers") or {})
        if not name:
            raise store.StoreError("Give the server a name.")
        vault = self.server.vault
        code = custom_code(name, set(vault.tokens()) | set(store.CATALOG))
        if headers:
            finish(vault, code, {"mcp_entry": {"url": url, "headers": headers}, "obtained_at": int(time.time())}, label=name)
            return {"connector": code, "state": "connected"}
        return self.server.flows.start(code, oauth.SignIn(vault, url), label=name)


def running_page(vault):
    data = store.read_private(vault.root / "page.json")
    if not data or type(data.get("port")) is not int or not 1024 <= data["port"] <= 65535 or not isinstance(data.get("key"), str):
        return None
    origin = "http://127.0.0.1:" + str(data["port"])
    # An unrelated local process can reclaim an expired server's port. Never
    # disclose the capability while checking whether that server is still ours.
    nonce = secrets.token_hex(32)
    req = urllib.request.Request(origin + "/api/identity", headers={"X-Harness-Probe": nonce})
    try:
        with urllib.request.build_opener(store.NoRedirect, urllib.request.ProxyHandler({})).open(req, timeout=1) as response:
            raw = response.read(1025)
            result = json.loads(raw) if len(raw) <= 1024 else None
            proof = result.get("proof") if isinstance(result, dict) else None
            if (response.status == 200 and isinstance(proof, str) and re.fullmatch(r"[0-9a-f]{64}", proof) and
                    hmac.compare_digest(proof, identity_proof(data["key"], nonce))):
                return origin + "/#" + data["key"]
    except (OSError, ValueError):
        pass
    return None


def forget_page(vault, identity):
    # A newer launcher may already own page.json. Remove only this instance.
    with store.locked(vault.root):
        path = vault.root / "page.json"
        if store.read_private(path) == identity:
            path.unlink(missing_ok=True)


def browse(url):
    browser = shutil.which("hn-browser") or shutil.which("xdg-open")
    if not browser:
        return False
    subprocess.Popen([browser, url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


def page_url():
    """Start or authenticate this user's on-demand page without opening a tab."""
    vault = store.Store()
    with store.locked(vault.root):
        url = running_page(vault)
        if not url:
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "serve", "--background"],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, start_new_session=True)
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline and child.poll() is None:
                url = running_page(vault)
                if url:
                    break
                time.sleep(0.1)
            if not url:
                raise store.StoreError("Could not open Connections.")
    return url


def open_page():
    if not shutil.which("hn-browser"):
        raise store.StoreError("Open this page on a Harness computer, or run 'connections.py serve' for local review.")
    url = page_url()
    browse(url)
    print("Connections opened in the browser.")


def connect_here(code):
    """Sign in from the terminal: the same flow as the page, waited for here."""
    vault = store.Store()
    sign_in = sign_in_for(vault, store.validate_code(code))
    url = sign_in.prepare()
    if url:
        print("Opening the sign-in page. If it does not open, visit:\n" + url, flush=True)
        browse(url)
    finish(vault, code, sign_in.wait())
    print(f"{store.SERVICES[code]} connected. Agents can use it now.")
    return 0


def serve(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("serve")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--background", action="store_true")
    args = parser.parse_args(argv)
    with PageServer(port=args.port) as server:
        identity = {"port": server.server_address[1], "key": server.key}
        store.write_private(server.vault.root / "page.json", identity)
        try:
            if not args.background:
                print(server.origin + "/#" + server.key, flush=True)
            server.serve_until_idle()
        finally:
            with contextlib.suppress(store.StoreError, OSError):
                forget_page(server.vault, identity)
    return 0


def main(argv):
    try:
        if not argv or argv == ["open"]:
            open_page()
            return 0
        command = argv[0]
        if command == "serve":
            return serve(argv)
        if command == "connect" and len(argv) == 2:
            return connect_here(argv[1])
        if command == "disconnect" and len(argv) == 2:
            disconnect(store.Store(), store.validate_code(argv[1]))
            print("Disconnected on this computer. Revoke access at the provider to remove it elsewhere.")
            return 0
        if command == "sync" and len(argv) == 1:
            changed = agents.sync(store.Store())
            print("Agents updated: " + (", ".join(sorted(changed)) or "none installed"))
            return 0
        if command == "refresh" and len(argv) <= 2:
            vault = store.Store()
            if len(argv) == 2:
                renew.refresh(vault, store.validate_code(argv[1]), force=True)
                return 0
            failed = renew.refresh_due(vault)
            for code, error in failed.items():
                print(f"{code}: {error}", file=sys.stderr)
            return 3 if failed else 0
        if command == "bridge":
            import bridge
            return bridge.main(argv[1:])
        return connector.main(argv)
    except (store.StoreError, OSError) as error:
        print(str(error) if isinstance(error, store.StoreError) else "Could not open Connections.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
