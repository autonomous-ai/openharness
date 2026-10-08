#!/usr/bin/env python3
"""On-demand, loopback-only Connections page for Harness OS."""
import argparse
import contextlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request

import connector
import connection_store as store

ASSETS = Path(__file__).parent / "web"


def identity_proof(key, nonce):
    return hmac.new(key.encode(), ("harness-connections-v1:" + nonce).encode(), "sha256").hexdigest()


# Read-only identity checks. API keys are not saved until the check succeeds.
# OAuth-only services stay unavailable until browser authorization and renewal
# work for a local Harness user. Intern hardware enrollment is not part of this.
MANUAL = {
    "github": ("GET", "https://api.github.com/user", [], "https://github.com/settings/tokens"),
    "notion": ("GET", "https://api.notion.com/v1/users/me", [], "https://www.notion.so/profile/integrations"),
    "linear": ("POST", "https://api.linear.app/graphql", ["--json", '{"query":"{ viewer { id name email } }"}'],
               "https://linear.app/settings/api"),
    "asana": ("GET", "https://app.asana.com/api/1.0/users/me", [], "https://app.asana.com/0/my-apps"),
    "figma": ("GET", "https://api.figma.com/v1/me", [], "https://developers.figma.com/docs/rest-api/personal-access-tokens/"),
}


def catalog(vault):
    items = []
    for code in store.SERVICES:
        if code == "figma-api" and not vault.path(code).exists():
            continue
        try:
            item = vault.status(code)
        except store.StoreError:
            item = {"connector": code, "name": store.SERVICES[code], "state": "unreadable", "scopes": []}
        item["manual"] = code in MANUAL
        item["manage_url"] = MANUAL[code][3] if code in MANUAL else None
        items.append(item)
    return items


def connect_token(vault, code, token):
    if code not in MANUAL:
        raise store.StoreError("Browser sign-in is not available for this service yet.")
    entry = store.clean_entry({"auth_type": "pat", "api_key": token, "obtained_at": int(time.time())})
    method, url, args, _ = MANUAL[code]
    output, error = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
        status = connector.cmd_call(code, method, url, args, entry_override=entry)
    if status:
        raise store.StoreError("Could not verify this token. Check its permissions and your connection, then try again.")
    try:
        result = json.loads(output.getvalue())
        if not isinstance(result, dict):
            raise ValueError()
        if code == "linear":
            if result.get("errors"):
                raise ValueError()
            account = result["data"]["viewer"]
        elif code == "asana":
            account = result["data"]
        else:
            account = result
        if not isinstance(account, dict) or not (account.get("id") or account.get("gid")):
            raise ValueError()
        identity = account.get("email") or account.get("login") or account.get("name") or account.get("handle") or ""
        if not isinstance(identity, str):
            raise ValueError()
        entry["user_email"] = identity[:512]
    except (ValueError, KeyError, TypeError):
        raise store.StoreError("The service did not confirm this account. The token was not saved.")
    vault.save(code, entry)
    return vault.status(code)


class PageServer(HTTPServer):
    allow_reuse_address = False

    def __init__(self, vault=None, port=0, idle_seconds=900):
        self.vault = vault or store.Store()
        self.key = secrets.token_urlsafe(32)
        self.idle_seconds = idle_seconds
        self.last_request = time.monotonic()
        super().__init__(("127.0.0.1", port), PageHandler)
        self.origin = "http://127.0.0.1:" + str(self.server_address[1])
        self.timeout = 1

    def serve_until_idle(self):
        while time.monotonic() - self.last_request < self.idle_seconds:
            self.handle_request()


class PageHandler(BaseHTTPRequestHandler):
    server_version = "Harness"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

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
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
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
        if self.path == "/api/connections":
            if not self.authenticated():
                self.reply(403, {"error": "Open harness connections again to continue."})
                return
            self.server.last_request = time.monotonic()
            self.reply(200, {"connections": catalog(self.server.vault)})
            return
        files = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/style.css": ("style.css", "text/css; charset=utf-8"),
                 "/page.js": ("page.js", "text/javascript; charset=utf-8")}
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
            code = store.validate_code(data.get("connector"))
            self.server.last_request = time.monotonic()
            if self.path == "/api/connect":
                result = connect_token(self.server.vault, code, data.get("token"))
            elif self.path == "/api/disconnect":
                self.server.vault.disconnect(code)
                result = self.server.vault.status(code)
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


def open_page():
    browser = shutil.which("hn-browser")
    if not browser:
        raise store.StoreError("Open this page on a Harness computer, or run 'connections.py serve' for local review.")
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
    subprocess.Popen([browser, url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("Connections opened in the browser.")


def main(argv):
    try:
        if not argv or argv == ["open"]:
            open_page()
            return 0
        if argv[0] != "serve":
            return connector.main(argv)
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
    except (store.StoreError, OSError) as error:
        print(str(error) if isinstance(error, store.StoreError) else "Could not open Connections.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
