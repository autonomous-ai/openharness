"""python3 -m unittest toolchain/test_scripts.py — setup, doctor, init-workspace and viewer.sh.

Each test builds a throwaway package root: the real scripts linked in file by file, fixtures beside
them, and a PATH that holds only the tools the case allows (a stub npm, a node that can pretend to
be old, python3 or not), and a runtime dir where runtimes.sh looks for the node Harness runs on.
Nothing is installed and nothing touches the network or this folder.
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
PYTHON = shutil.which("python3")
BASE_TOOLS = ("bash", "dirname", "find", "wc", "tr", "mkdir", "ln", "chmod", "cat")

VERSIONS = "PHASER=9.9.9\nVITE=7.7.7\nTERSER=5.0.0\nSKILLS_COMMIT=abcdef1234567890\n"

# Stands in for `npm ci` / `npm install`: logs its argv, then lays out what $NPM_INSTALLS names.
NPM = """#!/bin/bash
echo "$*" >> "$NPM_LOG"
[ -n "${NPM_FAIL:-}" ] && { echo "npm ERR! network" >&2; exit 1; }
for pkg in $NPM_INSTALLS; do
  mkdir -p "node_modules/$pkg"
  echo "{\\"version\\": \\"$(eval echo \\$VERSION_$pkg)\\"}" > "node_modules/$pkg/package.json"
  if [ "$pkg" = vite ]; then mkdir -p node_modules/.bin; printf '#!/bin/bash\\n' > node_modules/.bin/vite; chmod +x node_modules/.bin/vite; fi
done
"""


class Sandbox:
    def __init__(self, test: unittest.TestCase):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.pkg = self.root / "pkg"
        self.bin = self.root / "bin"
        self.ws = self.root / "ws"
        self.runtime = self.root / "runtime"     # never ~/.harness/runtime: that node would answer every miss
        for d in (self.pkg, self.bin, self.ws, self.runtime):
            d.mkdir()
        self.tools(*BASE_TOOLS)

    def link(self, rel: str) -> Path:
        path = self.pkg / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(PKG / rel)
        return path

    def file(self, rel: str, text: str = "", base: Path | None = None, mode: int = 0o644) -> Path:
        path = (base or self.pkg) / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)  # a tool is a link to the real one: never write through it
        path.write_text(text)
        path.chmod(mode)
        return path

    def tools(self, *names: str) -> None:
        for name in names:
            found = shutil.which(name)
            if found is None:
                raise unittest.SkipTest(f"{name} is not on PATH")
            (self.bin / name).symlink_to(found)

    def stub(self, name: str, body: str) -> None:
        self.file(name, body if body.startswith("#!") else "#!/bin/bash\n" + body, base=self.bin, mode=0o755)

    def old_node(self) -> None:
        """A node whose version check fails, as a Node 16 would; everything else is the real node."""
        if NODE is None:
            raise unittest.SkipTest("node is not on PATH")
        self.stub("node", f'[ "$1" = -e ] && exit 1\nexec "{NODE}" "$@"\n')

    def harness_node(self, npm: str | None = None) -> Path:
        """The real node where Harness keeps its own, recorded in the runtime dir and not on PATH; a stub
        npm beside it when given."""
        if NODE is None:
            raise unittest.SkipTest("node is not on PATH")
        node = self.root / "harness-node" / "bin" / "node"
        node.parent.mkdir(parents=True)
        node.symlink_to(NODE)
        if npm is not None:
            self.file("npm", npm, base=node.parent, mode=0o755)
        (self.runtime / "current-node").write_text(f"{node}\n")
        return node

    def run(self, rel: str, *args: str, cwd: Path | None = None, **env: str) -> subprocess.CompletedProcess:
        full = dict((k, v) for k, v in os.environ.items() if not k.startswith(("HARNESS_", "VITE", "NPM_")))
        full.update(PATH=str(self.bin), ADAPTER_RUNTIME_DIR=str(self.runtime), **env)
        return subprocess.run([str(self.pkg / rel), *args], cwd=cwd or self.root, env=full,
                              capture_output=True, text=True, timeout=60)


def lines(result: subprocess.CompletedProcess) -> list[str]:
    return result.stdout.splitlines()


class Doctor(unittest.TestCase):
    def test_a_complete_install_is_ready(self):
        box = Sandbox(self)
        box.link("toolchain/doctor.sh")
        box.link("toolchain/runtimes.sh")
        box.tools("node", "python3")
        box.file("node_modules/.bin/vite", "#!/bin/sh\n", mode=0o755)
        box.file("node_modules/phaser/package.json", '{"version": "4.2.1"}')
        box.file("node_modules/vite/package.json", '{"version": "6.4.3"}')
        for rel in ("viewer.mjs", "viewer/frame.js", "viewer/probe.js", "viewer/guard.js",
                    "skills/scenes/SKILL.md", "skills/tweens/SKILL.md", "skills/harness-phaser/SKILL.md"):
            box.file(rel)
        r = box.run("toolchain/doctor.sh")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        out = lines(r)
        self.assertRegex(out[0], r"^ok   node v\d+\.\d+\.\d+ \(vite and the pane\)$")
        self.assertEqual(out[1:4], ["ok   phaser 4.2.1 · vite 6.4.3",
                                    "ok   pane: the game frame around vite (viewer.mjs, viewer/)",
                                    "ok   skills: 3"])
        self.assertRegex(out[4], r"^ok   Python 3\.\d+")
        self.assertEqual(len(out), 5)

    def test_harness_node_serves_when_path_has_none(self):
        box = Sandbox(self)
        box.link("toolchain/doctor.sh")
        box.link("toolchain/runtimes.sh")
        box.harness_node()
        box.file("node_modules/.bin/vite", "#!/bin/sh\n", mode=0o755)
        box.file("node_modules/phaser/package.json", '{"version": "4.2.1"}')
        box.file("node_modules/vite/package.json", '{"version": "6.4.3"}')
        r = box.run("toolchain/doctor.sh")
        self.assertRegex(lines(r)[0], r"^ok   node v\d+\.\d+\.\d+ \(vite and the pane\)$")
        self.assertEqual(lines(r)[1], "ok   phaser 4.2.1 · vite 6.4.3")

    def test_an_empty_install_without_python_says_what_is_missing(self):
        box = Sandbox(self)
        box.link("toolchain/doctor.sh")
        box.link("toolchain/runtimes.sh")
        box.file("viewer.mjs")  # the frame's files are not all there
        box.file("skills/scenes/SKILL.md")  # nor is the harness skill
        r = box.run("toolchain/doctor.sh")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(lines(r), [f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down",
                                    "miss node_modules — run toolchain/setup.sh",
                                    "miss viewer.mjs or viewer/ — the checkout is incomplete",
                                    "miss skills/ — the checkout is incomplete",
                                    "miss python3 (the verdict)"])


class Setup(unittest.TestCase):
    def box(self, *, node: str = "real", npm: bool = True, python: bool = True, lock: bool = True,
            skills: bool = True) -> Sandbox:
        box = Sandbox(self)
        box.link("toolchain/setup.sh")
        box.link("toolchain/runtimes.sh")
        box.file("VERSIONS", VERSIONS)
        if node == "real":
            box.tools("node")
        elif node == "old":
            box.old_node()
        if npm:
            box.stub("npm", NPM)
        if python:
            box.tools("python3")
        if lock:
            box.file("package-lock.json", "{}")
        if skills:
            for rel in ("skills/scenes/SKILL.md", "skills/tweens/SKILL.md", "skills/harness-phaser/SKILL.md"):
                box.file(rel)
        self.log = box.root / "npm.log"
        return box

    def run_setup(self, box: Sandbox, installs: str = "phaser vite", **env: str) -> subprocess.CompletedProcess:
        return box.run("toolchain/setup.sh", NPM_LOG=str(self.log), NPM_INSTALLS=installs,
                       VERSION_phaser="9.9.9", VERSION_vite="7.7.7", **env)

    def npm_calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_installs_from_the_lockfile_and_reports_what_it_got(self):
        box = self.box()
        r = self.run_setup(box)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(lines(r), [
            "     npm ci (phaser 9.9.9 + vite 7.7.7, about a minute the first time)",
            "ok   phaser 9.9.9",
            "ok   vite 7.7.7",
            "ok   skills: 3 (2 from phaserjs/phaser @ abcdef1, plus harness-phaser)",
        ])
        self.assertEqual(self.npm_calls(), ["ci --silent --no-audit --no-fund"])
        self.assertTrue((box.pkg / "node_modules" / ".bin" / "vite").exists())

    def test_without_a_lockfile_it_installs(self):
        box = self.box(lock=False)
        r = self.run_setup(box)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.npm_calls(), ["install --silent --no-audit --no-fund"])

    def test_no_node_or_an_old_node_stops_before_npm(self):
        for node in ("none", "old"):
            with self.subTest(node=node):
                box = self.box(node=node)
                r = self.run_setup(box)
                self.assertEqual((r.returncode, lines(r)), (1, [f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down"]))
                self.assertEqual(self.npm_calls(), [])

    def test_a_machine_without_node_or_with_an_old_one_uses_harnesss_and_the_npm_beside_it(self):
        for node in ("none", "old"):
            with self.subTest(node=node):
                box = self.box(node=node, npm=False)
                box.harness_node(npm=NPM)
                r = self.run_setup(box)
                self.assertEqual((r.returncode, lines(r)[-1]), (0, "ok   skills: 3 (2 from phaserjs/phaser @ abcdef1, plus harness-phaser)"), r.stdout + r.stderr)
                self.assertEqual(self.npm_calls()[-1], "ci --silent --no-audit --no-fund")

    def test_no_npm(self):
        box = self.box(npm=False)
        r = self.run_setup(box)
        self.assertEqual((r.returncode, lines(r)), (1, [f"miss npm beside {box.bin}/node"]))

    def test_no_python(self):
        box = self.box(python=False)
        r = self.run_setup(box)
        self.assertEqual((r.returncode, lines(r)), (1, ["miss python3 (the verdict)"]))
        self.assertEqual(self.npm_calls(), [])

    def test_a_failed_npm_stops_the_setup(self):
        r = self.run_setup(self.box(), NPM_FAIL="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(lines(r), ["     npm ci (phaser 9.9.9 + vite 7.7.7, about a minute the first time)"])
        self.assertIn("npm ERR! network", r.stderr)

    def test_an_install_without_vite_is_a_miss_and_never_an_ok(self):
        # `npm ci` with dev dependencies omitted (NODE_ENV=production, omit=dev) succeeds without Vite.
        r = self.run_setup(self.box(), installs="phaser")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(lines(r), ["     npm ci (phaser 9.9.9 + vite 7.7.7, about a minute the first time)",
                                    "miss node_modules/.bin/vite"])

    def test_an_incomplete_checkout_without_skills(self):
        r = self.run_setup(self.box(skills=False))
        self.assertEqual(r.returncode, 1)
        self.assertEqual(lines(r)[-1], "miss skills/ — the checkout is incomplete")


class InitWorkspace(unittest.TestCase):
    def box(self) -> Sandbox:
        box = Sandbox(self)
        box.link("toolchain/init-workspace.sh")
        box.link("toolchain/verdict.py")
        (box.pkg / "node_modules").mkdir()
        return box

    def test_requires_the_install_dir(self):
        box = self.box()
        r = box.run("toolchain/init-workspace.sh", cwd=box.ws)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("HARNESS_DSH_DIR", r.stderr)
        self.assertEqual(list(box.ws.iterdir()), [])

    def test_lays_out_the_workspace_links_the_shared_modules_and_seeds_the_verdict(self):
        box = self.box()
        box.tools("python3")
        r = box.run("toolchain/init-workspace.sh", cwd=box.ws, HARNESS_DSH_DIR=str(box.pkg))
        self.assertEqual((r.returncode, r.stdout), (0, ""), r.stderr)
        for d in (".harness", "out", "public", "src/scenes"):
            self.assertTrue((box.ws / d).is_dir(), d)
        self.assertEqual(os.readlink(box.ws / "node_modules"), str(box.pkg / "node_modules"))
        verdict = json.loads((box.ws / ".harness" / "verdict.json").read_text())
        self.assertEqual((verdict["ready"], verdict["summary"]), (False, "no game yet"))

    def test_keeps_a_workspaces_own_modules_and_survives_a_missing_python(self):
        box = self.box()
        (box.ws / "node_modules").mkdir()
        r = box.run("toolchain/init-workspace.sh", cwd=box.ws, HARNESS_DSH_DIR=str(box.pkg))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse((box.ws / "node_modules").is_symlink())
        self.assertFalse((box.ws / ".harness" / "verdict.json").exists())


class ViewerScript(unittest.TestCase):
    def box(self, node: bool = True) -> Sandbox:
        box = Sandbox(self)
        box.link("viewer.sh")
        box.link("toolchain/runtimes.sh")
        if node:
            box.stub("node", '[ "$1" = -e ] && exit 0\necho "cwd=$PWD"\necho "args=$*"\n')
        return box

    def test_needs_the_port_and_the_workspace(self):
        box = self.box()
        r = box.run("viewer.sh", HARNESS_WORKSPACE=str(box.ws))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("HARNESS_VIEWER_PORT", r.stderr)
        r = box.run("viewer.sh", HARNESS_VIEWER_PORT="4173")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("HARNESS_WORKSPACE", r.stderr)

    def test_runs_the_frame_server_in_the_workspace_linked_to_the_shared_install(self):
        box = self.box()
        r = box.run("viewer.sh", HARNESS_VIEWER_PORT="4173", HARNESS_WORKSPACE=str(box.ws))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(lines(r), [f"cwd={box.ws}", f"args={box.pkg / 'viewer.mjs'}"])
        self.assertEqual(os.readlink(box.ws / "node_modules"), str(box.pkg / "node_modules"))

    def test_a_login_shell_without_node_runs_harnesss_own(self):
        box = self.box(node=False)
        node = box.file("harness-node/bin/node", '#!/bin/bash\n[ "$1" = -e ] && exit 0\necho "harness node $*"\n', base=box.root, mode=0o755)
        (box.runtime / "current-node").write_text(f"{node}\n")
        r = box.run("viewer.sh", HARNESS_VIEWER_PORT="4173", HARNESS_WORKSPACE=str(box.ws))
        self.assertEqual((r.returncode, lines(r)), (0, [f"harness node {box.pkg / 'viewer.mjs'}"]), r.stderr)

    def test_no_node_anywhere_never_starts(self):
        box = self.box(node=False)
        r = box.run("viewer.sh", HARNESS_VIEWER_PORT="4173", HARNESS_WORKSPACE=str(box.ws))
        self.assertEqual((r.returncode, lines(r)), (1, [f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down"]))
        self.assertFalse((box.ws / "node_modules").exists())

    def test_leaves_an_existing_node_modules_alone(self):
        box = self.box()
        (box.ws / "node_modules").mkdir()
        r = box.run("viewer.sh", HARNESS_VIEWER_PORT="4173", HARNESS_WORKSPACE=str(box.ws))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse((box.ws / "node_modules").is_symlink())


class WithNode(unittest.TestCase):
    """toolchain/with-node.sh, which the verdict runs vite through."""

    def box(self) -> Sandbox:
        box = Sandbox(self)
        box.link("toolchain/with-node.sh")
        box.link("toolchain/runtimes.sh")
        return box

    def test_node_on_path_runs_the_command(self):
        box = self.box()
        box.tools("node")
        r = box.run("toolchain/with-node.sh", "node", "-e", "console.log('ran')")
        self.assertEqual((r.returncode, r.stdout), (0, "ran\n"), r.stderr)

    def test_harnesss_node_is_put_on_path_when_there_is_none(self):
        box = self.box()
        node = box.harness_node()
        r = box.run("toolchain/with-node.sh", "bash", "-c", "command -v node")
        self.assertEqual((r.returncode, r.stdout), (0, f"{node}\n"), r.stderr)

    def test_no_node_is_127_with_the_miss_on_stderr(self):
        box = self.box()
        r = box.run("toolchain/with-node.sh", "vite", "build")
        self.assertEqual((r.returncode, r.stdout), (127, ""))
        self.assertEqual(r.stderr, f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down\n")


if __name__ == "__main__":
    unittest.main()
