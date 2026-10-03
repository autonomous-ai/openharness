"""Exercise the real HTTP/download/hash contract, including deadlines and concurrency."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "verify-desktop-release.py"
spec = importlib.util.spec_from_file_location("verify_desktop", SCRIPT)
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class DesktopVerificationTests(unittest.TestCase):
    def setUp(self):
        self.payload = b"release artifact fixture\0" * 100
        self.requests = []
        self.active = 0
        self.peak = 0
        self.delay = 0.03
        self.lock = threading.Lock()
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                test.requests.append((self.path, self.headers.get("User-Agent")))
                if self.path == "/metadata.json":
                    payload = json.dumps(test.manifest).encode()
                elif self.path == "/missing":
                    self.send_error(404)
                    return
                else:
                    with test.lock:
                        test.active += 1
                        test.peak = max(test.peak, test.active)
                    time.sleep(test.delay)
                    with test.lock:
                        test.active -= 1
                    payload = test.payload
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.manifest = {
            key: dict(version="1.2.3", url=f"{self.base}/{key}",
                      size=len(self.payload), sha256=hashlib.sha256(self.payload).hexdigest())
            for key in verify.KEYS
        }

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def run_verification(self, **kwargs):
        return verify.verify("1.2.3", self.base + "/metadata.json", **kwargs)

    def test_all_six_full_downloads_with_updater_agent_and_bounded_parallelism(self):
        receipt = self.run_verification(jobs=2)
        self.assertEqual(receipt["status"], "passed", receipt)
        self.assertEqual(len(receipt["artifacts"]), 6)
        self.assertEqual(self.peak, 2)
        self.assertEqual(len(self.requests), 7)
        self.assertTrue(all(agent == verify.USER_AGENT for _, agent in self.requests))
        self.assertTrue(all(item["actual_size"] == len(self.payload) for item in receipt["artifacts"]))

    def test_missing_or_mixed_version_fails_before_artifact_downloads(self):
        for change in ("missing", "version"):
            with self.subTest(change=change):
                original = self.manifest.pop(verify.KEYS[0])
                if change == "version":
                    self.manifest[verify.KEYS[0]] = dict(original, version="1.2.2")
                self.requests.clear()
                self.assertEqual(self.run_verification()["status"], "failed")
                self.assertEqual(len(self.requests), 1)
                self.manifest[verify.KEYS[0]] = original

    def test_bad_schema_fails_before_artifact_downloads(self):
        for patch in ({"size": True}, {"size": 0}, {"sha256": "bad"}, {"url": "file:///etc/passwd"}, {"url": "http://example.com/download"}):
            with self.subTest(patch=patch):
                original = self.manifest[verify.KEYS[0]]
                self.manifest[verify.KEYS[0]] = dict(original, **patch)
                self.requests.clear()
                self.assertEqual(self.run_verification()["status"], "failed")
                self.assertEqual(len(self.requests), 1)
                self.manifest[verify.KEYS[0]] = original

    def test_hash_size_and_http_failures_are_not_reported_as_passed(self):
        for patch in ({"sha256": "0" * 64}, {"size": len(self.payload) + 1}, {"size": len(self.payload) - 1}, {"url": self.base + "/missing"}):
            with self.subTest(patch=patch):
                original = self.manifest[verify.KEYS[0]]
                self.manifest[verify.KEYS[0]] = dict(original, **patch)
                receipt = self.run_verification()
                self.assertEqual(receipt["status"], "failed")
                self.assertEqual(receipt["artifacts"][0]["status"], "failed")
                self.assertEqual(sum(item["status"] == "passed" for item in receipt["artifacts"]), 5)
                self.manifest[verify.KEYS[0]] = original

    def test_transfer_deadline_fails_in_bounded_time(self):
        self.delay = 1.5
        start = time.monotonic()
        receipt = self.run_verification(timeout=0.1, jobs=6)
        self.assertEqual(receipt["status"], "failed")
        self.assertLess(time.monotonic() - start, 1.3)

    def test_cli_preserves_failed_receipt_and_exit_status(self):
        self.manifest.pop(verify.KEYS[0])
        with tempfile.TemporaryDirectory() as folder:
            receipt = Path(folder) / "receipt.json"
            code = verify.main(["1.2.3", "--manifest-url", self.base + "/metadata.json", "--receipt", str(receipt)])
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(receipt.read_text())["status"], "failed")

    def test_internal_macos_scope_keeps_all_four_and_release_still_requires_six(self):
        macos = tuple(key for key in verify.KEYS if key.startswith("desktop-macos"))
        manifest = {key: self.manifest[key] for key in macos}
        self.assertEqual(len(verify.entries_for_version(manifest, "1.2.3", keys=macos)), 4)
        with self.assertRaises(ValueError):
            verify.entries_for_version(manifest, "1.2.3")
        manifest.pop(macos[-1])
        with self.assertRaises(ValueError):
            verify.entries_for_version(manifest, "1.2.3", keys=macos)


if __name__ == "__main__":
    unittest.main()
