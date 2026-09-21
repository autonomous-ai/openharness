"""setup.sh, doctor.sh, init-workspace.sh and viewer.sh, run for real against a scratch install whose
PATH holds only stub commands (and the few coreutils the scripts use), so every ok / miss line and
exit path is reached without npm, a network or the installed node_modules. Node is found the way
runtimes.sh finds it on a new machine too: not on PATH, but recorded in the runtime dir Harness keeps.

    python3 -m unittest toolchain/test_scripts.py
"""
import os, shutil, subprocess, tempfile, unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
# A bash line tracer (BASH_ENV sourcing a DEBUG trap that appends to SHCOV_OUT) is passed through when set.
TRACER = {k: os.environ[k] for k in ("BASH_ENV", "SHCOV_OUT") if k in os.environ}
BASH = "/bin/bash"
COREUTILS = ("dirname", "mkdir", "cat")
BUNDLE = "node_modules/@excalidraw/excalidraw/dist/excalidraw.production.min.js"
# node: runtimes.sh's version probe (`node -e … 18`, answered by $NODE_OLD and never logged), its
# version, and `node -p "require(...)"` for the versions the scripts print.
NODE = """case "$1" in
  -e) exit "${NODE_OLD:-0}" ;;
  -v|--version) echo v22.23.2 ;;
  -p) case "$2" in *react/package.json*) echo 18.3.1 ;; *) echo 0.17.6 ;; esac ;;
esac"""


class Sandbox:
    """An install dir with the package's scripts, a bin/ of stubs as the whole PATH, an empty runtime
    dir for runtimes.sh, and a log of every stub call."""

    def __init__(self, test: unittest.TestCase):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.install = self.root / "install"
        (self.install / "toolchain").mkdir(parents=True)
        for script in PACKAGE.glob("toolchain/*.sh"):
            (self.install / "toolchain" / script.name).symlink_to(script)  # linked, not copied: a line tracer maps back to the source
        (self.install / "viewer.sh").symlink_to(PACKAGE / "viewer.sh")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.calls = self.root / "calls.log"
        self.calls.touch()
        for name in COREUTILS:
            real = next(p for p in (Path("/bin") / name, Path("/usr/bin") / name) if p.exists())
            (self.bin / name).symlink_to(real)

    def stub(self, name: str, body: str = "", where: Path | None = None) -> Path:
        path = (where or self.bin) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)  # never write through a link to a real command
        # runtimes.sh's `node -e` probe is not a call the scripts make: it stays out of the log.
        probe = '[ "$1" = -e ] || ' if name == "node" else ""
        path.write_text(f'#!/bin/bash\n{probe}echo "{name} $*" >> "$CALLS"\n{body}\n')
        path.chmod(0o755)
        return path

    def harness_node(self, npm: str | None = None) -> Path:
        """No node on PATH; Harness's own recorded in the runtime dir, npm beside it when given."""
        node = self.stub("node", NODE, where=self.root / "harness-node" / "bin")
        if npm is not None:
            self.stub("npm", npm, where=node.parent)
        (self.runtime / "current-node").write_text(f"{node}\n")
        return node

    def file(self, rel: str) -> None:
        path = self.install / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")

    def run(self, script: str, cwd: Path | None = None, **env: str) -> subprocess.CompletedProcess:
        return subprocess.run([BASH, str(self.install / script)], cwd=cwd or self.install,
                              env={"PATH": str(self.bin), "CALLS": str(self.calls), "ADAPTER_RUNTIME_DIR": str(self.runtime), **TRACER, **env},
                              capture_output=True, text=True, timeout=60)

    def logged(self) -> list[str]:
        return self.calls.read_text().splitlines()


class Doctor(unittest.TestCase):
    def test_ready(self):
        box = Sandbox(self)
        box.stub("node", NODE)
        box.stub("python3", 'echo "Python 3.12.1"')
        for rel in (BUNDLE, "viewer.mjs", "viewer/index.html", "viewer/app.js"):
            box.file(rel)
        r = box.run("toolchain/doctor.sh")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["ok   node v22.23.2 (the pane server)", "ok   excalidraw 0.17.6",
                                                 "ok   pane (viewer.mjs, viewer/)", "ok   Python 3.12.1"])

    def test_harness_node_serves_when_path_has_none(self):
        box = Sandbox(self)
        box.harness_node()
        box.stub("python3", 'echo "Python 3.9.6"')
        for rel in (BUNDLE, "viewer.mjs", "viewer/index.html", "viewer/app.js"):
            box.file(rel)
        r = box.run("toolchain/doctor.sh")
        self.assertEqual((r.returncode, r.stdout.splitlines()[:2]), (0, ["ok   node v22.23.2 (the pane server)", "ok   excalidraw 0.17.6"]), r.stderr)

    def test_every_miss_is_reported_not_just_the_first(self):
        box = Sandbox(self)
        r = box.run("toolchain/doctor.sh")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.splitlines(), [f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down",
                                                 "miss node_modules — run toolchain/setup.sh",
                                                 "miss viewer.mjs or viewer/ — the checkout is incomplete",
                                                 "miss python3"])

    def test_a_pane_missing_one_file_is_incomplete(self):
        box = Sandbox(self)
        box.stub("node", NODE)
        box.stub("python3", 'echo "Python 3.12.1"')
        for rel in (BUNDLE, "viewer.mjs", "viewer/index.html"):
            box.file(rel)
        r = box.run("toolchain/doctor.sh")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.splitlines()[2], "miss viewer.mjs or viewer/ — the checkout is incomplete")


NPM_CI = f"mkdir -p node_modules/@excalidraw/excalidraw/dist && : > {BUNDLE}"


class Setup(unittest.TestCase):
    def sandbox(self, *missing: str, npm: str = NPM_CI) -> Sandbox:
        box = Sandbox(self)
        for name, body in (("node", NODE), ("npm", npm), ("python3", "")):
            if name not in missing:
                box.stub(name, body)
        return box

    def test_installs_from_the_lockfile(self):
        box = self.sandbox()
        r = box.run("toolchain/setup.sh")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["     npm ci (Excalidraw 0.17.6)", "ok   excalidraw 0.17.6 · react 18.3.1"])
        self.assertIn("npm ci --silent --no-audit --no-fund", box.logged())

    def test_a_machine_without_node_uses_harnesss_own_and_the_npm_beside_it(self):
        box = self.sandbox("node", "npm")
        node = box.harness_node(npm=NPM_CI)
        r = box.run("toolchain/setup.sh")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["     npm ci (Excalidraw 0.17.6)", "ok   excalidraw 0.17.6 · react 18.3.1"])
        self.assertIn("npm ci --silent --no-audit --no-fund", box.logged())
        self.assertTrue((box.install / BUNDLE).is_file())
        self.assertTrue(node.is_file())

    def test_an_old_node_on_path_is_passed_over_for_harnesss(self):
        box = self.sandbox("node", "npm")
        box.stub("node", 'exit 1')                           # a Node 16: the >= 18 probe fails
        box.harness_node(npm=NPM_CI)
        r = box.run("toolchain/setup.sh")
        self.assertEqual((r.returncode, r.stdout.splitlines()[-1]), (0, "ok   excalidraw 0.17.6 · react 18.3.1"), r.stderr)

    def test_each_missing_tool_is_a_miss(self):
        for tool, line in (("node", None), ("npm", None), ("python3", "miss python3 (the scene helper and the verdict)")):
            with self.subTest(tool=tool):
                box = self.sandbox(tool)
                line = line or {"node": f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down",
                                "npm": f"miss npm beside {box.bin}/node"}[tool]
                r = box.run("toolchain/setup.sh")
                self.assertEqual((r.returncode, r.stdout.strip()), (1, line))
                self.assertNotIn("npm ci --silent --no-audit --no-fund", box.logged())

    def test_a_failed_npm_ci_fails_setup(self):
        r = self.sandbox(npm="exit 1").run("toolchain/setup.sh")
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("ok", r.stdout)

    def test_no_bundle_after_npm_ci_is_a_miss(self):
        r = self.sandbox(npm="true").run("toolchain/setup.sh")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.splitlines()[-1], "miss the Excalidraw bundle after npm ci")


class InitWorkspace(unittest.TestCase):
    def test_seeds_the_verdict_and_survives_a_failing_one(self):
        box = Sandbox(self)
        ws = box.root / "ws"
        ws.mkdir()
        box.stub("python3", "exit 1")
        r = box.run("toolchain/init-workspace.sh", cwd=ws, HARNESS_DSH_DIR=str(box.install))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((ws / ".harness").is_dir())
        self.assertEqual(box.logged(), [f"python3 {box.install}/toolchain/verdict.py"])

    def test_needs_the_install_dir(self):
        r = Sandbox(self).run("toolchain/init-workspace.sh")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("HARNESS_DSH_DIR", r.stderr)


class Viewer(unittest.TestCase):
    def test_runs_the_server_beside_it(self):
        box = Sandbox(self)
        box.stub("node", 'echo "port $HARNESS_VIEWER_PORT"')
        r = box.run("viewer.sh", cwd=box.root, HARNESS_VIEWER_PORT="4123", HARNESS_WORKSPACE=str(box.root))
        self.assertEqual((r.returncode, r.stdout), (0, "port 4123\n"), r.stderr)
        self.assertEqual(box.logged(), [f"node {box.install}/viewer.mjs"])

    def test_a_login_shell_without_node_runs_harnesss_own(self):
        box = Sandbox(self)
        node = box.harness_node()
        r = box.run("viewer.sh", cwd=box.root, HARNESS_VIEWER_PORT="4123", HARNESS_WORKSPACE=str(box.root))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(box.logged(), [f"node {box.install}/viewer.mjs"])
        self.assertTrue(node.is_file())

    def test_no_node_anywhere_never_starts(self):
        box = Sandbox(self)
        r = box.run("viewer.sh", cwd=box.root, HARNESS_VIEWER_PORT="4123", HARNESS_WORKSPACE=str(box.root))
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.strip(), f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down")

    def test_needs_a_port_and_a_workspace(self):
        box = Sandbox(self)
        box.stub("node")
        for env, missing in (({"HARNESS_WORKSPACE": "/tmp"}, "HARNESS_VIEWER_PORT"), ({"HARNESS_VIEWER_PORT": "4123"}, "HARNESS_WORKSPACE")):
            with self.subTest(missing=missing):
                r = box.run("viewer.sh", **env)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn(missing, r.stderr)
        self.assertEqual(box.logged(), [], "node never starts")


if __name__ == "__main__":
    unittest.main()
