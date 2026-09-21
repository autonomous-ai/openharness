"""python3 -m unittest toolchain/test_scripts.py — setup, doctor, init and the viewer launcher.

Each test builds a package root in a temp dir with this checkout's scripts (and VERSIONS) symlinked in
file by file, and runs them with PATH set to a bin dir holding only the tools the test grants: real
ones (bash, node, python3, tar, …) linked in, or stubs. `curl` is always a stub that serves a local
stand-in for the pinned source tarball and the project's CI build, so setup.sh runs end to end with
no network, and a "miss node" branch is simply a PATH without node. Harness's own Node (runtimes.sh's
fallback) is looked for in a runtime dir of the sandbox's, never the real ~/.harness.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
PINS = dict(re.findall(r"^(\w+)=(\S+)$", (PKG / "VERSIONS").read_text(), re.M))
COMMIT = PINS["CIRCUITJS1_COMMIT"]
TARBALL_URL = PINS["CIRCUITJS1_TARBALL"].replace("${CIRCUITJS1_COMMIT}", COMMIT)
BUILD_URL = PINS["CIRCUITJS1_BUILD"]
PERMS = ["0123456789ABCDEF0123456789ABCDEF", "FEDCBA9876543210FEDCBA9876543210"]
BASE_TOOLS = ("bash", "cat", "dirname", "mkdir", "rm", "mktemp", "find", "head", "cp", "ls", "wc", "tr",
              "xargs", "shasum", "sort", "date", "du", "cut", "sed", "mv")

CURL = """#!/bin/bash
# curl -fsSL … -o DEST URL, served from $CURL_FIXTURES/<host>/<path>; a missing fixture is curl -f's 22.
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --retry|--connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >> "$CURL_FIXTURES/../curl.log"
src="$CURL_FIXTURES/${url#https://}"
[ -f "$src" ] || exit 22
/bin/cp "$src" "$out"
"""


class Sandbox:
    def __init__(self, test: unittest.TestCase, tools: tuple[str, ...] = ()) -> None:
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name).resolve()
        self.root = self.dir / "circuitjs"
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.runtime = self.dir / "runtime"
        (self.root / "toolchain").mkdir(parents=True)
        (self.root / "toolchain" / "runtimes.sh").symlink_to(PKG / "toolchain" / "runtimes.sh")
        for tool in BASE_TOOLS + tools:
            self.grant(tool)

    def link(self, rel: str) -> None:
        (self.root / rel).symlink_to(PKG / rel)

    def grant(self, tool: str) -> None:
        found = shutil.which(tool)
        assert found, f"{tool} is needed on this machine to run the test"
        (self.bin / tool).symlink_to(found)

    def stub(self, name: str, body: str) -> None:
        path = self.bin / name
        path.unlink(missing_ok=True)  # never write through a link to a real command
        path.write_text(body)
        path.chmod(0o755)

    def harness_node(self) -> None:
        """Harness's own Node, recorded where runtimes.sh looks when node is not on PATH."""
        found = shutil.which("node")
        assert found, "node is needed on this machine to run the test"
        (self.dir / "harness-node").mkdir()
        (self.dir / "harness-node" / "node").symlink_to(found)
        self.runtime.mkdir()
        (self.runtime / "current-node").write_text(f"{self.dir}/harness-node/node\n")

    def run(self, rel: str, cwd: Path | None = None, **env: str) -> subprocess.CompletedProcess:
        clean = {k: v for k, v in os.environ.items() if not k.startswith("HARNESS_")}
        return subprocess.run([str(self.root / rel)], cwd=cwd or self.dir, capture_output=True, text=True,
                              env={**clean, "PATH": str(self.bin), "ADAPTER_RUNTIME_DIR": str(self.runtime), **env},
                              timeout=120)


def no_node(box: Sandbox) -> str:
    return f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down"


def lines(done: subprocess.CompletedProcess) -> list[str]:
    return done.stdout.splitlines()


class Setup(unittest.TestCase):
    def sandbox(self, *tools: str) -> Sandbox:
        box = Sandbox(self, tools)
        box.link("toolchain/setup.sh")
        box.link("VERSIONS")
        box.stub("curl", CURL)
        self.fixtures = box.dir / "fixtures"
        self.tmp = box.dir / "tmp"
        self.tmp.mkdir()
        return box

    def serve(self, url: str, data: bytes) -> None:
        path = self.fixtures / url.removeprefix("https://")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def upstream(self, *, war: bool = True, lz: bool = True, perms: list[str] = PERMS) -> None:
        """The source tarball at the pinned commit, and the CI build it is paired with."""
        files = {
            "COPYING.txt": "GNU GENERAL PUBLIC LICENSE\n",
            "src/com/lushprojects/circuitjs1/public/setuplist.txt": "+Basics\nrc.txt RC\n",
            "src/com/lushprojects/circuitjs1/public/circuits/rc.txt": "$ 1 0.000005 10 50 5 43\n",
            "src/com/lushprojects/circuitjs1/public/circuits/lrc.txt": "$ 1 0.000005 10 50 5 43\n",
        }
        if war:
            files.update({
                "war/circuitjs.html": "<html>app</html>\n",
                "war/canvas2svg.js": "// canvas2svg\n",
                "war/WEB-INF/web.xml": "<web-app/>\n",
                "war/service-worker.js": "self.addEventListener('fetch', () => {})\n",
                "war/relay.php": "<?php ?>\n",
            })
            if lz:
                files["war/lz-string.min.js"] = "var LZString = {}\n"
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for rel, text in files.items():
                data = text.encode()
                info = tarfile.TarInfo(f"circuitjs1-{COMMIT}/{rel}")
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        self.serve(TARBALL_URL, buf.getvalue())
        build = f"{BUILD_URL}/circuitjs1"
        self.serve(f"{build}/circuitjs1.nocache.js",
                   ("function circuitjs1(){var s=" + ",".join(f"'{p}'" for p in perms + perms) + "}\n").encode())
        self.serve(f"{build}/clear.cache.gif", b"GIF89a")
        for p in perms:
            self.serve(f"{build}/{p}.cache.js", f"// permutation {p}\n".encode())
        self.serve(f"{build}/gwt/clean/clean.css",
                   b".a{background:url(images/corner.png)}\n.b{background:url( \"images/hborder.png\" )}\n"
                   b".c{background:url('images/corner.png')}\n")
        self.serve(f"{build}/gwt/clean/images/corner.png", b"png1")
        self.serve(f"{build}/gwt/clean/images/hborder.png", b"png2")

    def setup(self, box: Sandbox) -> subprocess.CompletedProcess:
        return box.run("toolchain/setup.sh", CURL_FIXTURES=str(self.fixtures), TMPDIR=str(self.tmp))

    def test_each_tool_it_needs_is_named_when_missing(self) -> None:
        for curl, have, missing in ((False, ("node", "python3", "tar"), "miss curl on PATH"),
                                    (True, ("python3", "tar"), None),
                                    (True, ("node", "tar"), "miss python3 (the verdict)"),
                                    (True, ("node", "python3"), "miss tar on PATH")):
            with self.subTest(missing=missing or "node"):
                box = Sandbox(self, have)
                box.link("toolchain/setup.sh")
                box.link("VERSIONS")
                if curl:
                    box.stub("curl", CURL)
                done = box.run("toolchain/setup.sh")
                self.assertEqual(done.returncode, 1)
                self.assertEqual(lines(done), [missing or no_node(box)])

    def test_without_node_on_path_it_runs_on_harnesss_own(self) -> None:
        box = self.sandbox("python3", "tar")
        box.harness_node()
        self.upstream()
        done = self.setup(box)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(lines(done)[1], "     2 compiled permutation(s), 2 theme images, 2 example circuits")
        self.assertRegex(lines(done)[-1], r"^ok   node v\d+\S* · Python 3\.\d+\.\d+$")

    def test_it_installs_the_static_half_and_the_compiled_module(self) -> None:
        box = self.sandbox("node", "python3", "tar")
        self.upstream()
        (box.root / "upstream" / "war").mkdir(parents=True)
        (box.root / "upstream" / "war" / "stale.js").write_text("from an older install\n")
        done = self.setup(box)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        out = lines(done)
        self.assertEqual(out[0], f"     circuitjs1 {COMMIT[:12]} (source) + the project's CI build (compiled)")
        self.assertEqual(out[1], "     2 compiled permutation(s), 2 theme images, 2 example circuits")
        # One space before the size: BSD du pads it, and the line used to show "·  64K".
        self.assertRegex(out[2], rf"^ok   circuitjs1 {COMMIT[:12]} · \d+(\.\d+)?[BKMG] in upstream/ · GPL-2.0 \(LICENSE-circuitjs1\)$")
        self.assertRegex(out[3], r"^ok   node v\d+\S* · Python 3\.\d+\.\d+$")
        self.assertEqual(len(out), 4)

        up = box.root / "upstream"
        war = up / "war"
        for rel in ("circuitjs.html", "lz-string.min.js", "canvas2svg.js", "circuitjs1/setuplist.txt",
                    "circuitjs1/circuits/rc.txt", "circuitjs1/circuitjs1.nocache.js", "circuitjs1/clear.cache.gif",
                    f"circuitjs1/{PERMS[0]}.cache.js", f"circuitjs1/{PERMS[1]}.cache.js",
                    "circuitjs1/gwt/clean/clean.css", "circuitjs1/gwt/clean/images/corner.png",
                    "circuitjs1/gwt/clean/images/hborder.png"):
            self.assertTrue((war / rel).is_file(), rel)
        # No servlet plumbing, no PHP relay, no service worker, nothing left from before.
        for rel in ("WEB-INF", "service-worker.js", "relay.php", "stale.js"):
            self.assertFalse((war / rel).exists(), rel)
        self.assertEqual((up / "COPYING.txt").read_text(), "GNU GENERAL PUBLIC LICENSE\n")
        installed = dict(line.split("=", 1) for line in (up / "INSTALLED").read_text().splitlines())
        self.assertEqual(installed["commit"], COMMIT)
        self.assertEqual(installed["build"], BUILD_URL)
        self.assertEqual(installed["permutations"], "2")
        self.assertRegex(installed["fetchedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        manifest = dict(reversed(line.split("  ", 1)) for line in (up / "MANIFEST").read_text().splitlines())
        self.assertEqual(manifest["./war/circuitjs.html"], hashlib.sha256(b"<html>app</html>\n").hexdigest())
        self.assertEqual(sorted(manifest), sorted(manifest))                 # sorted by path, LC_ALL=C
        self.assertEqual(list(manifest), sorted(manifest))
        self.assertFalse((box.root / "upstream.partial").exists())
        self.assertEqual(list(self.tmp.iterdir()), [], "the download dir is removed on exit")
        fetched = (box.dir / "curl.log").read_text().splitlines()
        self.assertEqual(fetched[0], TARBALL_URL)
        self.assertEqual(len(fetched), 1 + 2 + 2 + 1 + 2)       # tarball, nocache+gif, perms, css, images

    def test_a_download_that_fails(self) -> None:
        box = self.sandbox("node", "python3", "tar")
        done = self.setup(box)                                      # no fixtures at all
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done)[-1], f"miss could not fetch {TARBALL_URL}")
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_a_tarball_without_war(self) -> None:
        box = self.sandbox("node", "python3", "tar")
        self.upstream(war=False)
        done = self.setup(box)
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done)[-1], "miss war/ in the circuitjs1 tarball")

    def test_a_build_that_names_no_permutations(self) -> None:
        box = self.sandbox("node", "python3", "tar")
        self.upstream(perms=[])
        done = self.setup(box)
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done)[-1], "miss no permutations named in circuitjs1.nocache.js")

    def test_a_required_file_missing_after_the_fetch(self) -> None:
        box = self.sandbox("node", "python3", "tar")
        self.upstream(lz=False)
        done = self.setup(box)
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done)[-1], "miss upstream/war/lz-string.min.js after fetch")
        self.assertFalse((box.root / "upstream").exists(), "an incomplete fetch is never installed")

    def test_a_failed_rerun_keeps_the_working_install(self) -> None:
        # Before the fix setup.sh deleted upstream/ before step 2 downloaded anything, so a re-run
        # that lost the network halfway (an upgrade, a repair) left a pane with no compiled app.
        box = self.sandbox("node", "python3", "tar")
        self.upstream()
        self.assertEqual(self.setup(box).returncode, 0)
        before = (box.root / "upstream" / "MANIFEST").read_text()
        (self.fixtures / f"{BUILD_URL.removeprefix('https://')}/circuitjs1/gwt/clean/clean.css").unlink()
        done = self.setup(box)
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done)[-1], f"miss could not fetch {BUILD_URL}/circuitjs1/gwt/clean/clean.css")
        self.assertEqual((box.root / "upstream" / "MANIFEST").read_text(), before)
        self.assertTrue((box.root / "upstream" / "war" / "circuitjs1" / "circuitjs1.nocache.js").is_file())
        self.assertFalse((box.root / "upstream.partial").exists())


class Doctor(unittest.TestCase):
    def sandbox(self, *tools: str) -> Sandbox:
        box = Sandbox(self, tools)
        box.link("toolchain/doctor.sh")
        return box

    def install(self, box: Sandbox, *, perms: bool = True, circuits: bool = True) -> None:
        mod = box.root / "upstream" / "war" / "circuitjs1"
        mod.mkdir(parents=True)
        (mod.parent / "circuitjs.html").write_text("<html/>\n")
        (mod / "circuitjs1.nocache.js").write_text("x\n")
        if perms:
            for p in PERMS:
                (mod / f"{p}.cache.js").write_text("x\n")
        if circuits:
            (mod / "circuits").mkdir()
            for name in ("rc.txt", "lrc.txt", "555.txt"):
                (mod / "circuits" / name).write_text("$\n")
        (box.root / "upstream" / "INSTALLED").write_text(f"commit={COMMIT}\nbuild={BUILD_URL}\npermutations=2\n")

    def test_a_ready_machine(self) -> None:
        box = self.sandbox("node", "python3")
        self.install(box)
        done = box.run("toolchain/doctor.sh")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        out = lines(done)
        self.assertEqual(out[:2], [f"ok   circuitjs1 {COMMIT[:12]} · 2 compiled permutation(s) in upstream/",
                                   "ok   3 example circuits in the Circuits menu"])
        self.assertRegex(out[2], r"^ok   node v\d+\S* \(the pane\)$")
        self.assertRegex(out[3], r"^ok   Python 3\.\d+\.\d+ \(the verdict\)$")
        self.assertEqual(len(out), 4)

    def test_an_empty_machine(self) -> None:
        box = self.sandbox()
        done = box.run("toolchain/doctor.sh")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done), [
            "miss upstream/ — run toolchain/setup.sh (it downloads CircuitJS1)",
            "miss upstream/war/circuitjs1/circuits — run toolchain/setup.sh",
            no_node(box),
            "miss python3 (the verdict)",
        ])

    def test_harnesss_own_node_serves_the_pane(self) -> None:
        box = self.sandbox("python3")
        box.harness_node()
        self.install(box)
        done = box.run("toolchain/doctor.sh")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertRegex(lines(done)[2], r"^ok   node v\d+\S* \(the pane\)$")

    def test_a_static_half_without_the_compiled_module(self) -> None:
        box = self.sandbox("node", "python3")
        self.install(box, perms=False)
        done = box.run("toolchain/doctor.sh")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done)[:2], ["miss upstream/ — run toolchain/setup.sh (it downloads CircuitJS1)",
                                           "ok   3 example circuits in the Circuits menu"])


class InitWorkspace(unittest.TestCase):
    def sandbox(self, *tools: str) -> tuple[Sandbox, Path]:
        box = Sandbox(self, tools)
        box.link("toolchain/init-workspace.sh")
        box.link("toolchain/verdict.py")
        ws = box.dir / "ws"
        ws.mkdir()
        shutil.copy(PKG / "template" / "circuit.txt", ws / "circuit.txt")
        return box, ws

    def test_it_needs_the_install_dir(self) -> None:
        box, ws = self.sandbox("python3")
        done = box.run("toolchain/init-workspace.sh", cwd=ws)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("HARNESS_DSH_DIR", done.stderr)
        self.assertFalse((ws / ".harness").exists())

    def test_it_seeds_the_verdict_for_the_starter_circuit(self) -> None:
        box, ws = self.sandbox("python3")
        done = box.run("toolchain/init-workspace.sh", cwd=ws, HARNESS_DSH_DIR=str(box.root))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, "")
        verdict = json.loads((ws / ".harness" / "verdict.json").read_text())
        self.assertTrue(verdict["ready"])
        self.assertEqual(verdict["artifact"], "circuit.txt")

    def test_a_verdict_that_cannot_run_does_not_fail_the_init(self) -> None:
        box, ws = self.sandbox()                                    # no python3 on PATH
        done = box.run("toolchain/init-workspace.sh", cwd=ws, HARNESS_DSH_DIR=str(box.root))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue((ws / ".harness").is_dir())
        self.assertFalse((ws / ".harness" / "verdict.json").exists())


class ViewerLauncher(unittest.TestCase):
    def sandbox(self) -> Sandbox:
        box = Sandbox(self, ("pwd",))
        box.link("viewer.sh")
        box.stub("node", '#!/bin/bash\necho "node $* in $PWD port=$HARNESS_VIEWER_PORT ws=$HARNESS_WORKSPACE"\n')
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
        done = box.run("viewer.sh", HARNESS_VIEWER_PORT="4100", HARNESS_WORKSPACE="/Users/example/circuit")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, f"node {box.root}/viewer.mjs in {box.dir} port=4100 ws=/Users/example/circuit\n")

    def test_no_node_anywhere_is_a_miss_not_a_crash(self) -> None:
        box = Sandbox(self, ("pwd",))
        box.link("viewer.sh")
        done = box.run("viewer.sh", HARNESS_VIEWER_PORT="4100", HARNESS_WORKSPACE="/Users/example/circuit")
        self.assertEqual((done.returncode, done.stdout), (1, no_node(box) + "\n"))


if __name__ == "__main__":
    unittest.main()
