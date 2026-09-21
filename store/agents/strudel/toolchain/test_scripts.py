"""python3 -m unittest toolchain/test_scripts.py — setup, doctor, init and the viewer launcher.

Each test builds a package root in a temp dir with this checkout's scripts symlinked in file by file,
and runs them with PATH set to a bin dir that holds only the tools the test grants: real ones
(bash, node, python3, …) linked in, or stubs written here. So a "miss node" branch is a PATH without
node and an empty runtime dir, Harness's own node is one recorded in that dir, npm is a stub that lays
out node_modules or fails, and nothing touches the network or this checkout.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
REPL_VERSION = json.loads((PKG / "package.json").read_text())["dependencies"]["@strudel/repl"]
BASE_TOOLS = ("bash", "dirname", "mkdir", "cat")


class Sandbox:
    def __init__(self, test: unittest.TestCase, tools: tuple[str, ...] = ()) -> None:
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name).resolve()
        self.root = self.dir / "strudel"
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.runtime = self.dir / "runtime"       # runtimes.sh looks here for Harness's node, never in ~
        self.runtime.mkdir()
        (self.root / "toolchain").mkdir(parents=True)
        for tool in BASE_TOOLS + tools:
            self.grant(tool)

    def link(self, rel: str) -> None:
        (self.root / rel).symlink_to(PKG / rel)

    def grant(self, tool: str) -> None:
        found = shutil.which(tool)
        assert found, f"{tool} is needed on this machine to run the test"
        (self.bin / tool).symlink_to(found)

    def stub(self, name: str, body: str, where: Path | None = None) -> Path:
        path = (where or self.bin) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)  # a granted tool is a link to the real one: never write through it
        path.write_text("#!/bin/bash\n" + body)
        path.chmod(0o755)
        return path

    def harness_node(self) -> Path:
        """The real node, linked where Harness keeps its own and recorded in the runtime dir — not on PATH."""
        found = shutil.which("node")
        assert found, "node is needed on this machine to run the test"
        node = self.dir / "harness-node" / "bin" / "node"
        node.parent.mkdir(parents=True)
        node.symlink_to(found)
        (self.runtime / "current-node").write_text(f"{node}\n")
        return node

    def run(self, rel: str, *args: str, cwd: Path | None = None, **env: str) -> subprocess.CompletedProcess:
        clean = {k: v for k, v in os.environ.items() if not k.startswith("HARNESS_")}
        return subprocess.run([str(self.root / rel), *args], cwd=cwd or self.dir, capture_output=True, text=True,
                              env={**clean, "PATH": str(self.bin), "ADAPTER_RUNTIME_DIR": str(self.runtime), **env}, timeout=60)


def lines(done: subprocess.CompletedProcess) -> list[str]:
    return done.stdout.splitlines()


class Setup(unittest.TestCase):
    def sandbox(self, *tools: str) -> Sandbox:
        box = Sandbox(self, tools)
        box.link("toolchain/setup.sh")
        box.link("toolchain/runtimes.sh")
        box.link("package.json")
        return box

    def test_node_is_required(self) -> None:
        box = self.sandbox()
        done = box.run("toolchain/setup.sh")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done), [f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down"])

    def test_npm_is_required(self) -> None:
        box = self.sandbox("node")
        done = box.run("toolchain/setup.sh")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done), [f"miss npm beside {box.bin}/node"])

    def test_python3_is_required(self) -> None:
        box = self.sandbox("node")
        box.stub("npm", "exit 0\n")
        done = box.run("toolchain/setup.sh")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done), ["miss python3 (the verdict)"])

    def npm(self, box: Sandbox, body: str, where: Path | None = None) -> None:
        box.stub("npm", f'echo "$PWD $*" >> "{box.dir}/npm.calls"\n' + body, where=where)

    NPM_CI = f"""mkdir -p node_modules/@strudel/repl/dist
echo 'export {{}}' > node_modules/@strudel/repl/dist/index.js
echo '{{"name": "@strudel/repl", "version": "{REPL_VERSION}"}}' > node_modules/@strudel/repl/package.json
"""

    def test_a_machine_without_node_uses_harnesss_own_and_the_npm_beside_it(self) -> None:
        box = self.sandbox("python3")
        node = box.harness_node()
        self.npm(box, self.NPM_CI, where=node.parent)
        done = box.run("toolchain/setup.sh")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(lines(done)[-1], f"ok   strudel {REPL_VERSION} · AGPL-3.0-or-later, from npm, unmodified")
        self.assertEqual((box.dir / "npm.calls").read_text(), f"{box.root} ci --silent --no-audit --no-fund\n")

    def test_npm_ci_lays_out_the_repl(self) -> None:
        box = self.sandbox("node", "python3")
        self.npm(box, self.NPM_CI)
        done = box.run("toolchain/setup.sh")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(lines(done), [
            f"     npm ci (@strudel/repl {REPL_VERSION})",
            f"ok   strudel {REPL_VERSION} · AGPL-3.0-or-later, from npm, unmodified",
        ])
        # From the package dir, whatever the caller's cwd, and from the lockfile.
        self.assertEqual((box.dir / "npm.calls").read_text(), f"{box.root} ci --silent --no-audit --no-fund\n")

    def test_npm_ci_that_leaves_no_bundle(self) -> None:
        box = self.sandbox("node", "python3")
        self.npm(box, "exit 0\n")
        done = box.run("toolchain/setup.sh")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done)[-1], "miss the Strudel REPL bundle after npm ci")

    def test_a_failing_npm_ci_stops_setup(self) -> None:
        box = self.sandbox("node", "python3")
        self.npm(box, "echo 'npm ERR! network' >&2; exit 1\n")
        done = box.run("toolchain/setup.sh")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done), [f"     npm ci (@strudel/repl {REPL_VERSION})"])


class Doctor(unittest.TestCase):
    def test_a_ready_machine(self) -> None:
        box = Sandbox(self, ("node", "python3"))
        box.link("toolchain/doctor.sh")
        box.link("toolchain/runtimes.sh")
        repl = box.root / "node_modules" / "@strudel" / "repl"
        (repl / "dist").mkdir(parents=True)
        (repl / "dist" / "index.js").write_text("export {}\n")
        (repl / "package.json").write_text('{"name": "@strudel/repl", "version": "9.9.9"}\n')
        done = box.run("toolchain/doctor.sh")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        out = lines(done)
        self.assertRegex(out[0], r"^ok   node v\d+\.\d+\.\d+ \(the pane server and the syntax check\)$")
        self.assertEqual(out[1], "ok   strudel 9.9.9 (the pane's REPL)")
        self.assertRegex(out[2], r"^ok   Python 3\.\d+\.\d+ \(the verdict\)$")
        self.assertTrue(out[3].startswith("note the pane needs a click to start audio"))
        self.assertEqual(len(out), 4)

    def test_harness_node_serves_when_path_has_none(self) -> None:
        box = Sandbox(self, ("python3",))
        box.link("toolchain/doctor.sh")
        box.link("toolchain/runtimes.sh")
        box.harness_node()
        done = box.run("toolchain/doctor.sh")
        self.assertRegex(lines(done)[0], r"^ok   node v\d+\.\d+\.\d+ \(the pane server and the syntax check\)$")

    def test_an_empty_machine(self) -> None:
        box = Sandbox(self)
        box.link("toolchain/doctor.sh")
        box.link("toolchain/runtimes.sh")
        done = box.run("toolchain/doctor.sh")
        self.assertEqual(done.returncode, 1)
        out = lines(done)
        self.assertEqual(out[:3], [f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down",
                                   "miss node_modules — run toolchain/setup.sh", "miss python3"])
        self.assertTrue(out[3].startswith("note "))


class InitWorkspace(unittest.TestCase):
    def sandbox(self, *tools: str) -> tuple[Sandbox, Path]:
        box = Sandbox(self, tools)
        box.link("toolchain/init-workspace.sh")
        box.link("toolchain/verdict.py")
        ws = box.dir / "ws"
        ws.mkdir()
        shutil.copy(PKG / "template" / "track.strudel", ws / "track.strudel")
        return box, ws

    def test_it_needs_the_install_dir(self) -> None:
        box, ws = self.sandbox("python3")
        done = box.run("toolchain/init-workspace.sh", cwd=ws)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("HARNESS_DSH_DIR", done.stderr)
        self.assertFalse((ws / ".harness").exists())

    def test_it_seeds_the_verdict_for_the_starter_track(self) -> None:
        box, ws = self.sandbox("python3", "node")
        done = box.run("toolchain/init-workspace.sh", cwd=ws, HARNESS_DSH_DIR=str(box.root))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, "")
        verdict = json.loads((ws / ".harness" / "verdict.json").read_text())
        self.assertTrue(verdict["ready"])
        self.assertEqual(verdict["artifact"], "track.strudel")

    def test_a_verdict_that_cannot_run_does_not_fail_the_init(self) -> None:
        box, ws = self.sandbox()                                    # no python3 on PATH
        done = box.run("toolchain/init-workspace.sh", cwd=ws, HARNESS_DSH_DIR=str(box.root))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue((ws / ".harness").is_dir())
        self.assertFalse((ws / ".harness" / "verdict.json").exists())


class ViewerLauncher(unittest.TestCase):
    def sandbox(self, node: bool = True) -> Sandbox:
        box = Sandbox(self, ("pwd",))
        box.link("viewer.sh")
        box.link("toolchain/runtimes.sh")
        if node:
            box.stub("node", 'echo "node $* in $PWD port=$HARNESS_VIEWER_PORT ws=$HARNESS_WORKSPACE"\n')
        return box

    def test_it_needs_a_port_and_a_workspace(self) -> None:
        box = self.sandbox()
        no_port = box.run("viewer.sh", HARNESS_WORKSPACE=str(box.dir))
        self.assertNotEqual(no_port.returncode, 0)
        self.assertIn("HARNESS_VIEWER_PORT", no_port.stderr)
        no_ws = box.run("viewer.sh", HARNESS_VIEWER_PORT="4100")
        self.assertNotEqual(no_ws.returncode, 0)
        self.assertIn("HARNESS_WORKSPACE", no_ws.stderr)
        self.assertEqual(no_port.stdout + no_ws.stdout, "")

    def test_it_runs_the_viewer_beside_it(self) -> None:
        box = self.sandbox()
        done = box.run("viewer.sh", HARNESS_VIEWER_PORT="4100", HARNESS_WORKSPACE="/Users/example/track")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, f"node {box.root}/viewer.mjs in {box.dir} port=4100 ws=/Users/example/track\n")

    def test_a_login_shell_without_node_runs_harnesss_own(self) -> None:
        box = self.sandbox(node=False)
        node = box.stub("node", 'echo "harness node $*"\n', where=box.dir / "harness-node" / "bin")
        (box.runtime / "current-node").write_text(f"{node}\n")
        done = box.run("viewer.sh", HARNESS_VIEWER_PORT="4100", HARNESS_WORKSPACE="/Users/example/track")
        self.assertEqual((done.returncode, done.stdout), (0, f"harness node {box.root}/viewer.mjs\n"), done.stderr)

    def test_no_node_anywhere_never_starts(self) -> None:
        box = self.sandbox(node=False)
        done = box.run("viewer.sh", HARNESS_VIEWER_PORT="4100", HARNESS_WORKSPACE="/Users/example/track")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done), [f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down"])


class WithNode(unittest.TestCase):
    """toolchain/with-node.sh, which the verdict runs `node --check` through."""

    def sandbox(self, *tools: str) -> Sandbox:
        box = Sandbox(self, tools)
        box.link("toolchain/with-node.sh")
        box.link("toolchain/runtimes.sh")
        return box

    def test_node_on_path_runs_the_command(self) -> None:
        box = self.sandbox("node")
        done = box.run("toolchain/with-node.sh", "node", "-e", "console.log('ran')")
        self.assertEqual((done.returncode, done.stdout), (0, "ran\n"), done.stderr)

    def test_harnesss_node_is_put_on_path_when_there_is_none(self) -> None:
        box = self.sandbox()
        node = box.harness_node()
        done = box.run("toolchain/with-node.sh", "bash", "-c", 'command -v node')
        self.assertEqual((done.returncode, done.stdout), (0, f"{node}\n"), done.stderr)

    def test_no_node_is_127_with_the_miss_on_stderr(self) -> None:
        box = self.sandbox()
        done = box.run("toolchain/with-node.sh", "node", "--check")
        self.assertEqual((done.returncode, done.stdout), (127, ""))
        self.assertEqual(done.stderr, f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down\n")


if __name__ == "__main__":
    unittest.main()
