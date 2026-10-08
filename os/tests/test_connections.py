"""Connections lifecycle and loopback boundary checks; no provider accounts."""
import contextlib
import http.client
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "connectors"
sys.path.insert(0, str(SOURCE))
import connection_store as store
import connections
import connector

TOKEN = "fixture-access-token-not-real"


class Response:
    status = 200

    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def read(self, limit=-1):
        return self.body[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Credentials(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name) / "connections"
        self.vault = store.Store(self.root)
        self.entry = {"auth_type": "oauth", "access_token": TOKEN, "refresh_token": "fixture-refresh",
                      "refresh": True, "expires_at": int(time.time()) + 3600, "scopes": ["read"]}

    def test_private_atomic_storage_shared_across_agent_processes_and_disconnect(self):
        self.vault.save("github", self.entry)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.vault.path("github").stat().st_mode), 0o600)
        for engine in ("codex", "claude", "opencode"):
            result = subprocess.run([sys.executable, str(SOURCE / "connections.py"), "list", "--json"],
                                    env={**os.environ, "CONNECTOR_CONFIGS_DIR": str(self.root), "HARNESS_ENGINE": engine},
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)[0]["connector"], "github")
            self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.vault.disconnect("github")
        with self.assertRaisesRegex(store.StoreError, "Not connected"):
            store.Store(self.root).ready("github")
        self.assertFalse(list(self.root.glob(".incoming-*")))

    def test_symlinks_broad_permissions_and_path_traversal_cannot_read_credentials(self):
        self.vault.save("github", self.entry)
        path = self.vault.path("github")
        path.chmod(0o644)
        with self.assertRaises(store.StoreError):
            self.vault.load("github")
        path.chmod(0o600)
        alias = self.root / "notion_access_tokens.json"
        alias.symlink_to(path)
        with self.assertRaises(store.StoreError):
            self.vault.load("notion")
        for code in ("../github", "/etc/passwd", "new"):
            with self.assertRaises(store.StoreError):
                self.vault.path(code)
        symlink = self.root.parent / "alias"
        symlink.symlink_to(self.root)
        with self.assertRaises(store.StoreError):
            store.Store(symlink).save("github", self.entry)

    def test_expired_tokens_stop_without_contacting_a_device_backend(self):
        self.vault.save("github", dict(self.entry, expires_at=1))
        # A leftover development config must not turn on Intern device renewal.
        store.write_private(self.root / "backend.json", {
            "base_url": "https://backend.invalid/api/v1/ai/v1",
            "api_key": "fixture-device", "device_id": "fixture-device-id",
        })
        old = self.vault.path("github").read_bytes()
        self.assertEqual(self.vault.status("github")["state"], "expired")
        self.assertFalse(self.vault.status("github")["auto_refresh"])
        with patch("urllib.request.OpenerDirector.open") as request:
            with self.assertRaisesRegex(store.StoreError, "expired"):
                self.vault.ready("github")
            request.assert_not_called()
        self.assertEqual(self.vault.path("github").read_bytes(), old)

    def test_valid_tokens_need_no_backend_or_device_registration(self):
        self.vault.save("github", self.entry)
        self.assertFalse((self.root / "backend.json").exists())
        self.assertEqual(self.vault.ready("github")["access_token"], TOKEN)
        # Even an unreadable old backend config cannot affect local connections.
        (self.root / "backend.json").symlink_to(self.root / "missing-config")
        self.assertEqual(self.vault.status("github")["state"], "connected")
        self.assertFalse(self.vault.status("github")["auto_refresh"])
        self.assertEqual(self.vault.ready("github")["access_token"], TOKEN)

    def test_provider_headers_and_failed_identity_do_not_save_token(self):
        cases = [
            ("github", {"id": 42, "login": "fixture"}, "Authorization", "Bearer " + TOKEN),
            ("notion", {"id": "bot"}, "Authorization", "Bearer " + TOKEN),
            ("linear", {"data": {"viewer": {"id": "user", "email": "fixture@example.invalid"}}}, "Authorization", TOKEN),
            ("asana", {"data": {"gid": "user", "name": "Fixture"}}, "Authorization", "Bearer " + TOKEN),
            ("figma", {"id": "user", "email": "fixture@example.invalid"}, "X-figma-token", TOKEN),
        ]
        for code, body, header, value in cases:
            seen = []
            def respond(req, timeout):
                seen.append(req)
                return Response(body)
            with patch.object(connector._OPENER, "open", side_effect=respond):
                connections.connect_token(self.vault, code, TOKEN)
            self.assertEqual(seen[0].get_header(header), value)
            self.assertIsNone(seen[0].get_header("X-device-id"))
            self.assertEqual(self.vault.status(code)["state"], "connected")
        self.vault.disconnect("linear")
        with patch.object(connector._OPENER, "open", return_value=Response({"errors": [{"message": "bad key"}]})):
            with self.assertRaises(store.StoreError):
                connections.connect_token(self.vault, "linear", TOKEN)
        self.assertIsNone(self.vault.load("linear"))

    def test_cli_rejects_oversized_response_and_redacts_both_credentials(self):
        self.vault.save("github", self.entry)
        for body, expected in [("x" * 128, 1), (TOKEN + " fixture-refresh", 0)]:
            output, error = io.StringIO(), io.StringIO()
            with patch.object(connector, "CONFIGS_DIR", self.root), patch.object(connector, "MAX_RESPONSE_BYTES", 100), \
                    patch.object(connector._OPENER, "open", return_value=Response(body)), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
                status = connector.main(["call", "github", "GET", "https://api.github.com/user"])
            self.assertEqual(status, expected)
            self.assertNotIn(TOKEN, output.getvalue() + error.getvalue())
            self.assertNotIn("fixture-refresh", output.getvalue() + error.getvalue())


class BrowserBoundary(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.vault = store.Store(Path(folder.name) / "connections")
        self.server = connections.PageServer(self.vault)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()

    def request(self, path, method="GET", body=None, headers=None):
        client = http.client.HTTPConnection(*self.server.server_address, timeout=3)
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
        self.assertEqual(self.request("/api/disconnect", "POST", {"connector": "github"}, headers)[0], 403)
        self.assertEqual(self.request("/api/disconnect?connector=github", headers=self.auth())[0], 404)
        self.assertEqual(self.request("/../connection_store.py")[0], 404)

    def test_reuse_requires_server_proof_without_sending_the_capability(self):
        identity = {"port": self.server.server_port, "key": self.server.key}
        store.write_private(self.vault.root / "page.json", identity)
        self.assertEqual(connections.running_page(self.vault), self.server.origin + "/#" + self.server.key)
        # An impostor on this port knows the request but not the saved secret.
        identity["key"] = "fixture-secret-not-known-to-this-server"
        store.write_private(self.vault.root / "page.json", identity)
        self.assertIsNone(connections.running_page(self.vault))
        with patch("urllib.request.OpenerDirector.open", return_value=Response({"connections": []})) as request:
            self.assertIsNone(connections.running_page(self.vault))
            probe = request.call_args.args[0]
            self.assertIsNone(probe.get_header("X-harness-connections"))
            self.assertNotIn(identity["key"], probe.full_url + repr(probe.headers))
        with patch("urllib.request.OpenerDirector.open", return_value=Response({"proof": connections.identity_proof(identity["key"], "0" * 64)})):
            self.assertIsNone(connections.running_page(self.vault), "An old proof cannot answer a new challenge")

    def test_identity_probe_cannot_keep_an_unused_page_alive(self):
        before = self.server.last_request
        self.assertEqual(self.request("/api/identity", headers={"X-Harness-Probe": "0" * 64})[0], 200)
        self.assertEqual(self.server.last_request, before)
        self.assertEqual(self.request("/api/identity", headers={"X-Harness-Probe": "bad"})[0], 400)

    def test_page_cleanup_preserves_a_newer_server(self):
        identity = {"port": self.server.server_port, "key": self.server.key}
        path = self.vault.root / "page.json"
        store.write_private(path, identity)
        connections.forget_page(self.vault, dict(identity, key="older-server"))
        self.assertEqual(store.read_private(path), identity)
        connections.forget_page(self.vault, identity)
        self.assertFalse(path.exists())

    def test_real_http_connect_list_disconnect_without_token_response_or_static_leak(self):
        with patch.object(connector._OPENER, "open", return_value=Response({"id": 1, "login": "fixture"})):
            status, _, raw = self.request("/api/connect", "POST", {"connector": "github", "token": TOKEN}, self.auth())
        self.assertEqual(status, 200, raw)
        self.assertNotIn(TOKEN.encode(), raw)
        status, headers, raw = self.request("/api/connections", headers=self.auth())
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn(TOKEN.encode(), raw)
        status, headers, _ = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        status, _, raw = self.request("/api/disconnect", "POST", {"connector": "github"}, self.auth())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["state"], "not_connected")
        self.assertIsNone(self.vault.load("github"))

    def test_bad_request_and_unverified_services_do_not_create_accounts(self):
        for body in ({"connector": "../outside", "token": TOKEN}, {"connector": "gmail", "token": TOKEN},
                     {"connector": "github", "token": ["bad"]}):
            status, _, raw = self.request("/api/connect", "POST", body, self.auth())
            self.assertEqual(status, 400, raw)
        self.assertFalse(self.root_exists())

    def root_exists(self):
        return self.vault.root.exists()


if __name__ == "__main__":
    unittest.main()
