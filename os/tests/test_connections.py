"""Connections: local MCP OAuth sign-in, the connector gateway, the bridge,
agent configs and the page — against fake services, never a real provider."""
import base64
import contextlib
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "connectors"
sys.path.insert(0, str(SOURCE))
import agents
import bridge
import connection_store as store
import connections
import gateway
import oauth
import renew


class Service(ThreadingHTTPServer):
    """An MCP server with its own OAuth server: MCP auth, RFC 7591, PKCE, rotation."""
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), ServiceHandler)
        self.base = f"http://127.0.0.1:{self.server_port}"
        self.access, self.refresh = None, None
        self.registered, self.challenge, self.seen, self.revoked = [], {}, [], False
        threading.Thread(target=self.serve_forever, kwargs={"poll_interval": .02}, daemon=True).start()


class ServiceHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, body=None, headers=None):
        raw = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def form(self):
        return dict(urllib.parse.parse_qsl(self.rfile.read(int(self.headers["Content-Length"])).decode()))

    def do_GET(self):
        s, url = self.server, urllib.parse.urlsplit(self.path)
        if url.path == "/.well-known/oauth-protected-resource/mcp":
            self.send(200, {"resource": s.base + "/mcp", "authorization_servers": [s.base], "scopes_supported": ["read"]})
        elif url.path == "/.well-known/oauth-authorization-server":
            self.send(200, {"issuer": s.base, "authorization_endpoint": s.base + "/authorize",
                            "token_endpoint": s.base + "/token", "registration_endpoint": s.base + "/register",
                            "code_challenge_methods_supported": ["S256"]})
        elif url.path == "/authorize":
            query = dict(urllib.parse.parse_qsl(url.query))
            assert query["code_challenge_method"] == "S256" and query["resource"] == s.base + "/mcp", query
            s.challenge["code-1"] = query["code_challenge"]
            target = query["redirect_uri"] + "?" + urllib.parse.urlencode({"code": "code-1", "state": query["state"]})
            self.send(302, headers={"Location": target})
        else:
            self.send(404, {})

    def do_POST(self):
        s, url = self.server, urllib.parse.urlsplit(self.path)
        if url.path == "/register":
            data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            s.registered.append(data)
            self.send(201, {"client_id": "client-1", "redirect_uris": data["redirect_uris"]})
        elif url.path == "/token":
            form = self.form()
            if form["grant_type"] == "authorization_code":
                verifier = base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"].encode()).digest()).rstrip(b"=").decode()
                if s.challenge.get(form["code"]) != verifier or form["client_id"] != "client-1":
                    self.send(400, {"error": "invalid_grant"})
                    return
                s.access, s.refresh = "access-1", "refresh-1"
            elif form.get("refresh_token") != s.refresh or s.revoked:
                self.send(400, {"error": "invalid_grant"})
                return
            else:
                n = int(s.access.split("-")[1]) + 1
                s.access, s.refresh = f"access-{n}", f"refresh-{n}"
            self.send(200, {"access_token": s.access, "token_type": "bearer", "expires_in": 3600,
                            "refresh_token": s.refresh, "scope": "read"})
        elif url.path == "/mcp":
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            s.seen.append({"auth": self.headers.get("Authorization"), "session": self.headers.get("Mcp-Session-Id"),
                           "body": body})
            if self.headers.get("Authorization") != f"Bearer {s.access}":
                self.send(401, {"error": "invalid_token"}, {
                    "WWW-Authenticate": f'Bearer resource_metadata="{s.base}/.well-known/oauth-protected-resource/mcp"'})
                return
            if "stream=1" in url.query:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Mcp-Session-Id", "session-1")
                self.end_headers()
                for n in range(3):
                    self.wfile.write(f'data: {{"n": {n}}}\n\n'.encode())
                    self.wfile.flush()
                self.close_connection = True
                return
            self.send(200, {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}, {"Mcp-Session-Id": "session-1"})
        else:
            self.send(404, {})


class Gateway(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), GatewayHandler)
        self.polls, self.calls = 0, []
        threading.Thread(target=self.serve_forever, kwargs={"poll_interval": .02}, daemon=True).start()


class GatewayHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer grid-session":
            self.send(401, {})
        else:
            self.send(200, {"connectors": [{"code": "github", "label": "GitHub", "auth_type": "app"}]})

    def do_POST(self):
        if self.headers.get("Authorization") != "Bearer grid-session":
            self.send(401, {})
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        path = self.path.removeprefix("/v1/grid/")
        self.server.calls.append((path, body))
        token = {"access_token": "gho-fixture", "expires_at": int(time.time()) + 3600, "refresh": True,
                 "account_name": "octo", "mcp_entry": {"url": "https://api.githubcopilot.com/mcp/",
                                                       "headers": {"Authorization": "Bearer gho-fixture"}}}
        if path == "connectors/start":
            self.send(200, {"authorize_url": "https://github.com/login/oauth/authorize?state=grid_x",
                            "pickup_code": "pickup-1", "poll_interval": 1, "expires_in": 60})
        elif path == "connectors/poll":
            self.server.polls += 1
            self.send(200, {"status": "pending"} if self.server.polls < 2 else dict(token, status="ready", connector="github"))
        elif path == "connectors/refresh":
            self.send(200, dict(token, access_token="gho-renewed"))
        else:
            self.send(200, {"disconnected": True})


class Case(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.home = Path(folder.name)
        self.vault = store.Store(self.home / "connections")
        env = patch.dict(os.environ, {"HOME": str(self.home), "XDG_CONFIG_HOME": str(self.home / ".config"),
                                      "GRID_HOME": str(self.home / ".grid"), "CODEX_HOME": str(self.home / ".codex")})
        env.start()
        self.addCleanup(env.stop)

    def service(self):
        service = Service()
        self.addCleanup(service.server_close)
        self.addCleanup(service.shutdown)
        return service

    def sign_in(self, service, browse=True):
        sign_in = oauth.SignIn(self.vault, service.base + "/mcp")
        url = sign_in.prepare()
        if browse:
            # The browser: the service redirects it to this computer's 127.0.0.1 callback.
            threading.Thread(target=lambda: urllib.request.urlopen(url, timeout=5).read(), daemon=True).start()
        return sign_in.wait()


class LocalSignIn(Case):
    def test_mcp_oauth_registers_this_computer_once_with_pkce_and_saves_a_renewable_token(self):
        service = self.service()
        token = self.sign_in(service)
        connections.finish(self.vault, "linear", token)
        saved = self.vault.token("linear")
        self.assertEqual(saved["source"], "dcr")
        self.assertEqual(saved["refresh_token"], "refresh-1")
        self.assertEqual(saved["mcp_entry"], {"url": service.base + "/mcp", "headers": {"Authorization": "Bearer access-1"}})
        self.assertTrue(store.refreshable(saved))
        registration = service.registered[0]
        self.assertEqual(registration["token_endpoint_auth_method"], "none")
        self.assertTrue(registration["redirect_uris"][0].startswith("http://127.0.0.1:"))
        for name in ("tokens.json", "clients.json"):
            self.assertEqual((self.vault.root / name).stat().st_mode & 0o777, 0o600)
        # A second sign-in reuses this computer's client instead of registering again.
        self.sign_in(service)
        self.assertEqual(len(service.registered), 1)

    def test_a_callback_for_another_sign_in_is_refused(self):
        service = self.service()
        sign_in = oauth.SignIn(self.vault, service.base + "/mcp")
        url = sign_in.prepare()
        forged = url.replace("state=", "state=forged")
        threading.Thread(target=lambda: urllib.request.urlopen(forged, timeout=5).read(), daemon=True).start()
        with self.assertRaisesRegex(store.StoreError, "could not be confirmed"):
            sign_in.wait()
        self.assertEqual(self.vault.tokens(), {})

    def test_a_server_without_sign_in_is_saved_as_it_is(self):
        with patch.object(oauth, "probe", return_value={"kind": "open"}):
            sign_in = oauth.SignIn(self.vault, "https://open.example/mcp")
            self.assertIsNone(sign_in.prepare())
            token = sign_in.wait()
        self.assertEqual(token["mcp_entry"], {"url": "https://open.example/mcp", "headers": {}})


class Bridge(Case):
    def setUp(self):
        super().setUp()
        self.service_ = self.service()
        connections.finish(self.vault, "linear", self.sign_in(self.service_))
        self.key = agents.bridge_key(self.vault)
        self.bridge = bridge.Bridge(self.vault)
        threading.Thread(target=self.bridge.serve_forever, kwargs={"poll_interval": .02}, daemon=True).start()
        self.addCleanup(self.bridge.server_close)
        self.addCleanup(self.bridge.shutdown)

    def call(self, path, headers=None, query=""):
        client = http.client.HTTPConnection("127.0.0.1", self.bridge.server_port, timeout=5)
        try:
            body = b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
            client.request("POST", path + query, body=body, headers={"Content-Type": "application/json",
                                                                     "Accept": "application/json, text/event-stream",
                                                                     "Authorization": "Bearer agent-supplied", **(headers or {})})
            response = client.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            client.close()

    def test_the_agent_gets_the_service_without_ever_holding_its_token(self):
        status, headers, raw = self.call(f"/{self.key}/linear/mcp")
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(raw)["result"], {"ok": True})
        self.assertEqual(headers["Mcp-Session-Id"], "session-1")
        self.assertEqual(self.service_.seen[-1]["auth"], "Bearer access-1", "the bridge's credential, not the agent's")
        status, headers, raw = self.call(f"/{self.key}/linear/mcp", query="?stream=1")
        self.assertEqual(status, 200)
        self.assertEqual(raw.count(b"data:"), 3)

    def test_strangers_and_web_pages_are_refused(self):
        before = len(self.service_.seen)
        self.assertEqual(self.call("/wrong-key/linear/mcp")[0], 404)
        self.assertEqual(self.call(f"/{self.key}/linear/mcp", {"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.call(f"/{self.key}/notion/mcp")[0], 404)
        self.assertEqual(len(self.service_.seen), before)

    def test_a_token_about_to_expire_is_renewed_before_the_request(self):
        token = self.vault.token("linear")
        token["expires_at"] = int(time.time()) + 60
        self.vault.save("linear", token)
        self.assertEqual(self.call(f"/{self.key}/linear/mcp")[0], 200)
        self.assertEqual(self.service_.seen[-1]["auth"], "Bearer access-2")
        saved = self.vault.token("linear")
        self.assertEqual((saved["access_token"], saved["refresh_token"]), ("access-2", "refresh-2"))
        self.assertGreater(saved["expires_at"], time.time() + 3000)

    def test_a_token_the_service_revoked_early_is_renewed_once(self):
        self.service_.access = "rotated-by-the-service"
        self.service_.refresh = "refresh-1"
        self.service_.access = "access-7"
        self.assertEqual(self.call(f"/{self.key}/linear/mcp")[0], 200)
        self.assertEqual(self.vault.token("linear")["access_token"], "access-8")

    def test_a_revoked_grant_asks_for_reconnecting_instead_of_a_sign_in_challenge(self):
        token = self.vault.token("linear")
        token["expires_at"] = int(time.time()) + 60
        self.vault.save("linear", token)
        self.service_.revoked = True
        status, headers, raw = self.call(f"/{self.key}/linear/mcp")
        self.assertEqual(status, 401)
        self.assertNotIn("WWW-Authenticate", headers)
        self.assertIn("connected again", json.loads(raw)["error"]["message"])
        self.assertEqual(self.vault.status("linear")["state"], "reconnect")


class AgentConfigs(Case):
    def test_each_agent_gets_bridge_addresses_and_keeps_its_own_servers(self):
        claude = self.home / ".claude.json"
        claude.write_text(json.dumps({"numStartups": 3, "mcpServers": {"notion": {"command": "my-notion"}}}))
        codex = self.home / ".codex/config.toml"
        codex.parent.mkdir()
        codex.write_text('model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "mine"\n')
        opencode = self.home / ".config/opencode/opencode.json"
        opencode.parent.mkdir(parents=True)
        opencode.write_text(json.dumps({"model": "opencode/muse"}))
        for code in ("linear", "notion"):
            self.vault.save(code, {"access_token": "secret-" + code, "source": "dcr",
                                   "mcp_entry": {"url": f"https://mcp.{code}.example/mcp",
                                                 "headers": {"Authorization": "Bearer secret-" + code}}})
        self.vault.save("github", {"access_token": "secret-github", "source": "gateway"})  # REST only: no tools
        changed = agents.sync(self.vault)
        key = agents.bridge_key(self.vault)
        self.assertEqual(changed, {"claude": ["linear"], "codex": ["linear", "notion"], "opencode": ["linear", "notion"]})
        data = json.loads(claude.read_text())
        self.assertEqual(data["numStartups"], 3)
        self.assertEqual(data["mcpServers"]["notion"], {"command": "my-notion"}, "the user's own server")
        self.assertEqual(data["mcpServers"]["linear"], {"type": "http", "url": f"http://127.0.0.1:51793/{key}/linear/mcp"})
        text = codex.read_text()
        self.assertTrue(text.startswith('model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "mine"\n'), text)
        self.assertIn(f'[mcp_servers.notion]\nurl = "http://127.0.0.1:51793/{key}/notion/mcp"', text)
        self.assertEqual(json.loads(opencode.read_text())["mcp"]["linear"]["type"], "remote")
        for path in (claude, codex, opencode):
            self.assertNotIn("secret-", path.read_text())

        self.vault.disconnect("linear")
        self.vault.disconnect("notion")
        agents.sync(self.vault)
        self.assertEqual(json.loads(claude.read_text())["mcpServers"], {"notion": {"command": "my-notion"}})
        self.assertEqual(codex.read_text(), 'model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "mine"\n')
        self.assertEqual(json.loads(opencode.read_text()), {"model": "opencode/muse"})

    def test_a_config_it_cannot_read_safely_is_left_alone(self):
        opencode = self.home / ".config/opencode/opencode.json"
        opencode.parent.mkdir(parents=True)
        opencode.write_text('{ // a comment\n "model": "x" }')
        self.vault.save("linear", {"access_token": "a", "mcp_entry": {"url": "https://mcp.example/mcp"}})
        agents.sync(self.vault)
        self.assertEqual(opencode.read_text(), '{ // a comment\n "model": "x" }')


class ConnectorGateway(Case):
    def gateway(self, signed_in=True):
        server = Gateway()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        if signed_in:
            grid = self.home / ".grid"
            grid.mkdir()
            (grid / "credentials.toml").write_text(
                f'session_token = "grid-session"\napi_url = "http://127.0.0.1:{server.server_port}"\n\n[device]\nid = "x"\n')
        return server

    def test_a_service_without_self_registration_signs_in_through_the_gateway(self):
        server = self.gateway()
        self.assertIn("github", gateway.available())
        sign_in = connections.sign_in_for(self.vault, "github")
        self.assertTrue(sign_in.prepare().startswith("https://github.com/"))
        connections.finish(self.vault, "github", sign_in.wait())
        saved = self.vault.token("github")
        self.assertEqual((saved["source"], saved["account_name"], saved["access_token"]), ("gateway", "octo", "gho-fixture"))
        renew.refresh(self.vault, "github", force=True)
        self.assertEqual(self.vault.token("github")["access_token"], "gho-renewed")
        self.assertEqual(self.vault.token("github")["account_name"], "octo")
        connections.disconnect(self.vault, "github")
        self.assertIsNone(self.vault.token("github"))
        self.assertEqual(server.calls[-1], ("connectors/disconnect", {"connector": "github"}))

    def test_signed_out_the_page_says_how_to_connect_these_services(self):
        self.gateway(signed_in=False)
        cards = {c["connector"]: c for c in connections.catalog(self.vault)["connections"]}
        self.assertIn("harness login", cards["github"]["reason"])
        self.assertEqual(cards["linear"]["reason"], "")
        with self.assertRaisesRegex(store.StoreError, "harness login"):
            connections.sign_in_for(self.vault, "slack").prepare()


class Storage(Case):
    def test_private_storage_shared_by_separate_agent_processes(self):
        self.vault.save("linear", {"access_token": "fixture-secret", "refresh_token": "fixture-refresh",
                                   "mcp_entry": {"url": "https://mcp.linear.app/mcp"}, "account_name": "me"})
        env = dict(os.environ, CONNECTOR_CONFIGS_DIR=str(self.vault.root))
        for _ in range(2):
            result = subprocess.run([sys.executable, str(SOURCE / "connections.py"), "list", "--json"],
                                    env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)[0]["connector"], "linear")
            self.assertNotIn("fixture-", result.stdout + result.stderr)

    def test_symlinks_and_broad_permissions_cannot_read_credentials(self):
        self.vault.save("linear", {"access_token": "a", "mcp_entry": {"url": "https://mcp.linear.app/mcp"}})
        path = self.vault.root / "tokens.json"
        path.chmod(0o644)
        with self.assertRaises(store.StoreError):
            self.vault.tokens()
        path.chmod(0o600)
        link = self.home / "link"
        link.symlink_to(self.vault.root)
        with self.assertRaises(store.StoreError):
            store.Store(link).tokens()
        for code in ("../outside", "UPPER", ""):
            with self.assertRaises(store.StoreError):
                self.vault.save(code, {"access_token": "a"})


class Page(Case):
    def setUp(self):
        super().setUp()
        self.server = connections.PageServer(self.vault)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02}, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, path, method="GET", body=None, headers=None):
        client = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            client.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers or {})
            response = client.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            client.close()

    def auth(self):
        return {"X-Harness-Connections": self.server.key, "Origin": self.server.origin, "Content-Type": "application/json"}

    def test_no_cross_site_or_unauthenticated_access_even_on_loopback(self):
        for headers in ({}, {**self.auth(), "Host": "evil.invalid"}, {**self.auth(), "Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("/api/connections", headers=headers)[0], 403)
        headers = {**self.auth(), "Origin": "https://evil.invalid"}
        self.assertEqual(self.request("/api/connect", "POST", {"connector": "linear"}, headers)[0], 403)
        self.assertEqual(self.request("/api/flows/x")[0], 403)
        self.assertEqual(self.request("/../connection_store.py")[0], 404)

    def test_reuse_requires_server_proof_without_sending_the_capability(self):
        identity = {"port": self.server.server_port, "key": self.server.key}
        store.write_private(self.vault.root / "page.json", identity)
        self.assertEqual(connections.running_page(self.vault), self.server.origin + "/#" + self.server.key)
        identity["key"] = "fixture-secret-not-known-to-this-server"
        store.write_private(self.vault.root / "page.json", identity)
        self.assertIsNone(connections.running_page(self.vault))

    def test_page_cleanup_preserves_a_newer_server(self):
        identity = {"port": self.server.server_port, "key": self.server.key}
        path = self.vault.root / "page.json"
        store.write_private(path, identity)
        connections.forget_page(self.vault, dict(identity, key="older-server"))
        self.assertEqual(store.read_private(path), identity)
        connections.forget_page(self.vault, identity)
        self.assertFalse(path.exists())

    def test_connect_in_the_browser_then_list_and_disconnect_without_any_token_in_responses(self):
        service = self.service()
        with patch.dict(store.CATALOG["linear"], {"mcp_url": service.base + "/mcp"}):
            status, _, raw = self.request("/api/connect", "POST", {"connector": "linear"}, self.auth())
            self.assertEqual(status, 200, raw)
            started = json.loads(raw)
            urllib.request.urlopen(started["authorize_url"], timeout=5).read()
            for _ in range(100):
                flow = json.loads(self.request("/api/flows/" + started["flow"], headers=self.auth())[2])
                if flow["state"] != "pending":
                    break
                time.sleep(.05)
        self.assertEqual(flow["state"], "connected", flow)
        status, headers, raw = self.request("/api/connections", headers=self.auth())
        self.assertEqual(headers["Cache-Control"], "no-store")
        cards = {c["connector"]: c for c in json.loads(raw)["connections"]}
        self.assertEqual(cards["linear"]["state"], "connected")
        self.assertTrue(cards["linear"]["tools"])
        self.assertNotIn(b"access-1", raw)
        self.assertNotIn(b"refresh-1", raw)
        status, _, raw = self.request("/api/disconnect", "POST", {"connector": "linear"}, self.auth())
        self.assertEqual(json.loads(raw)["state"], "not_connected")
        self.assertIsNone(self.vault.token("linear"))

    def test_every_service_has_a_bundled_icon_and_only_those_are_served(self):
        self.assertEqual(set(store.CATALOG) - set(connections.ICONS), set())
        cards = json.loads(self.request("/api/connections", headers=self.auth())[2])["connections"]
        status, headers, raw = self.request(cards[0]["icon"])
        self.assertEqual(status, 200)
        self.assertIn(headers["Content-Type"], ("image/png", "image/svg+xml"))
        self.assertTrue(raw)
        for path in ("/icons/../connection_store.py", "/icons/x.png", "/icons/"):
            self.assertEqual(self.request(path)[0], 404, path)

    def test_add_custom_with_headers_and_bad_requests(self):
        body = {"name": "My Tools", "url": "https://tools.example/mcp", "headers": {"Authorization": "Bearer pat-fixture"}}
        status, _, raw = self.request("/api/custom", "POST", body, self.auth())
        self.assertEqual(status, 200, raw)
        code = json.loads(raw)["connector"]
        self.assertEqual(code, "my-tools")
        card = [c for c in json.loads(self.request("/api/connections", headers=self.auth())[2])["connections"]
                if c["connector"] == code][0]
        self.assertEqual((card["name"], card["custom"], card["state"]), ("My Tools", True, "connected"))
        for bad in ({"name": "x", "url": "http://tools.example/mcp"}, {"name": "", "url": "https://t.example"},
                    {"name": "x", "url": "https://t.example", "headers": {"Bad Header": "v"}}):
            self.assertEqual(self.request("/api/custom", "POST", bad, self.auth())[0], 400, bad)
        self.assertEqual(self.request("/api/connect", "POST", {"connector": "../x"}, self.auth())[0], 400)


if __name__ == "__main__":
    unittest.main()
