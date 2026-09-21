"""python3 -m unittest toolchain/test_scripts.py — setup.sh, doctor.sh, node.sh and init-workspace.sh, without cadgen.

Each test lays out a throwaway install dir with the real scripts linked in and fake uv, node and venv
interpreters on a PATH that holds nothing else, with a HOME of its own (so Harness's own Node is only
there when a test records one), runs a script, and checks the lines Harness would show and the exit
code. Nothing is installed and nothing touches the network. What runtimes.sh does when uv is not on PATH
at all is store/tools/test_runtimes.py's business.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLCHAIN = Path(__file__).resolve().parent
PACKAGE = TOOLCHAIN.parent
CADGEN_VERSION = (PACKAGE / "CADGEN_VERSION").read_text().strip()
SYSTEM_TOOLS = ("bash", "dirname", "basename", "cat", "mkdir", "cp", "rm", "mktemp", "cut", "shasum")

# uv, as far as runtimes.sh uses it: `uv venv … DIR` makes a venv holding the fake venv python below;
# `uv pip install` answers PIP_EXIT.
UV = """#!/bin/sh
echo "uv $*" >> "$LOG"
case "$1" in
  venv) for last in "$@"; do :; done; mkdir -p "$last/bin" && cp "$FAKE_VENV_PYTHON" "$last/bin/python" ;;
  pip) exit "${PIP_EXIT:-0}" ;;
esac
"""
# The venv's python: every answer is an exit code the test sets in the environment; its version is
# VENV_PY, and runtimes.sh's keep-or-replace probe answers VENV_PY_OK.
VENV_PYTHON = """#!/bin/sh
case "$1" in --version) echo "Python ${VENV_PY:-3.12.9}"; exit 0 ;; esac
case "$*" in "-c "*version_info*) exit "${VENV_PY_OK:-0}" ;; esac
echo "venv-python $*" >> "$LOG"
case "$*" in
  "-m playwright install --only-shell chromium") echo "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" >> "$LOG"; exit "${PLAYWRIGHT_INSTALL_EXIT:-0}" ;;
  "-c import build123d") exit "${BUILD123D_EXIT:-0}" ;;
  "-c import trimesh, scipy, rtree, networkx, lxml") exit "${EXTRAS_EXIT:-0}" ;;
  "-c from playwright.sync_api import sync_playwright") exit "${PLAYWRIGHT_EXIT:-0}" ;;
  *src/part.py) echo "cwd=$PWD CADGEN_NODE=$CADGEN_NODE PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" >> "$LOG"; exit "${PART_EXIT:-0}" ;;
  *toolchain/verdict.py) echo "cwd=$PWD" >> "$LOG"; exit 1 ;;
esac
exit 99
"""
CADGEN = """#!/bin/sh
echo "cadgen $*" >> "$LOG"
exit "${CADGEN_DOCTOR_EXIT:-0}"
"""
# node: its version, whether runtimes.sh's `node -e` version check passes, and what a run prints.
NODE = """#!/bin/sh
case "$1" in
  -e) exit {old} ;;
  --version) echo {version} ;;
  *) echo "{name} $*" ;;
esac
"""
HARNESS_NODE = "v22.23.2"


def write_exe(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)  # never write through a link to a real command
    path.write_text(text)
    path.chmod(0o755)
    return path


class Scripts(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = self.tmp / "text-to-cad"
        (self.root / "toolchain").mkdir(parents=True)
        for name in ("setup.sh", "doctor.sh", "node.sh", "runtimes.sh", "init-workspace.sh", "verdict.py"):
            (self.root / "toolchain" / name).symlink_to(TOOLCHAIN / name)
        shutil.copy(PACKAGE / "CADGEN_VERSION", self.root / "CADGEN_VERSION")
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for tool in SYSTEM_TOOLS:
            found = shutil.which(tool)
            self.assertIsNotNone(found, tool)
            (self.bin / tool).symlink_to(found)
        self.log = self.tmp / "log"
        self.home = self.tmp / "home"
        self.fake_venv_python = write_exe(self.tmp / "fake-venv-python", VENV_PYTHON)

    def uv(self):
        write_exe(self.bin / "uv", UV)

    def node(self, version="v22.1.0", new_enough=True):
        """node on PATH."""
        write_exe(self.bin / "node", NODE.format(old=0 if new_enough else 1, version=version, name="node"))

    def harness_node(self):
        """Harness's own Node, recorded in HOME the way the CLI records it."""
        node = write_exe(self.tmp / "harness-node" / "bin" / "node", NODE.format(old=0, version=HARNESS_NODE, name="harness-node"))
        write_exe(self.home / ".harness" / "runtime" / "current-node", f"{node}\n")

    def venv(self, cadgen=True):
        write_exe(self.root / ".venv" / "bin" / "python", VENV_PYTHON)
        if cadgen:
            write_exe(self.root / ".venv" / "bin" / "cadgen", CADGEN)

    def run_script(self, name, *args, cwd=None, **env):
        clean = {k: v for k, v in os.environ.items()
                 if not k.startswith(("HARNESS_", "CADGEN", "TEXT_TO_CAD_", "ADAPTER_", "UV_", "PLAYWRIGHT_"))}
        clean.update(PATH=str(self.bin), HOME=str(self.home), LOG=str(self.log), FAKE_VENV_PYTHON=str(self.fake_venv_python), **env)
        return subprocess.run([str(self.root / "toolchain" / name), *args], cwd=cwd or self.tmp, env=clean,
                              capture_output=True, text=True, timeout=60)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    # setup.sh

    def test_setup_makes_a_3_12_venv_and_installs_the_pinned_cadgen_and_the_snapshot_browser_into_the_package(self):
        self.uv()
        self.node()
        run = self.run_script("setup.sh")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(run.stdout.splitlines(), [
            "     python 3.12 in .venv (uv downloads it when this machine has none)",
            "ok   Python 3.12.9 in .venv",
            f"     installing cadgen {CADGEN_VERSION} and the skills' extras (OpenCascade comes with it; minutes the first time)",
            f"ok   cadgen {CADGEN_VERSION}",
            "ok   node v22.1.0 (STL, 3MF and GLB exports)",
            "     installing the browser snapshots render with",
            "ok   chromium for snapshots",
        ])
        calls = self.calls()
        self.assertIn("uv venv --quiet --seed --python 3.12 --python-preference only-managed .venv", calls)
        self.assertIn(f"uv pip install --quiet --python .venv/bin/python cadgen[snapshot]=={CADGEN_VERSION} trimesh numpy scipy rtree networkx lxml", calls)
        self.assertEqual(calls[-2:], ["venv-python -m playwright install --only-shell chromium", f"PLAYWRIGHT_BROWSERS_PATH={self.root}/.playwright"])
        self.assertTrue((self.root / ".venv" / "bin" / "python").exists())

    def test_setup_with_no_node_on_path_uses_harnesss_own(self):
        self.uv()
        self.harness_node()
        run = self.run_script("setup.sh")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn(f"ok   node {HARNESS_NODE} (STL, 3MF and GLB exports)", run.stdout.splitlines())

    def test_setup_with_no_node_at_all_says_so_and_stops(self):
        self.uv()
        run = self.run_script("setup.sh")
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout.splitlines()[-1],
                         f"miss node >= 20, and Harness's own Node is not in {self.home}/.harness/runtime — run `harness start` once to lay it down")
        self.assertNotIn("chromium", run.stdout)

    def test_setup_reuses_a_venv_on_a_python_cadgen_supports(self):
        self.uv()
        self.node()
        self.venv(cadgen=False)
        run = self.run_script("setup.sh", VENV_PY="3.13.5")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(run.stdout.splitlines()[0], "ok   Python 3.13.5 in .venv")
        self.assertFalse(any(c.startswith("uv venv") for c in self.calls()))
        self.assertIn(f"ok   cadgen {CADGEN_VERSION}", run.stdout)

    def test_setup_replaces_a_venv_on_a_python_cadgen_does_not_support(self):
        self.uv()
        self.node()
        self.venv(cadgen=False)
        run = self.run_script("setup.sh", VENV_PY_OK="1")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("uv venv --quiet --seed --python 3.12 --python-preference only-managed .venv", self.calls())

    def test_setup_without_uv_or_a_network_says_so(self):
        write_exe(self.bin / "uname", '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac\n')
        write_exe(self.bin / "curl", "#!/bin/sh\nexit 6\n")
        run = self.run_script("setup.sh")
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout.splitlines()[-1], "miss could not download https://github.com/astral-sh/uv/releases/download/"
                         "0.12.15/uv-aarch64-apple-darwin.tar.gz — check this machine's internet connection")
        self.assertFalse((self.root / ".venv").exists())

    def test_setup_stops_when_cadgen_does_not_install(self):
        self.uv()
        self.node()
        run = self.run_script("setup.sh", PIP_EXIT="1")
        self.assertNotEqual(run.returncode, 0)
        self.assertNotIn("ok   cadgen", run.stdout)
        self.assertNotIn("chromium", run.stdout)

    def test_setup_warns_when_the_snapshot_browser_does_not_install(self):
        self.uv()
        self.node()
        run = self.run_script("setup.sh", PLAYWRIGHT_INSTALL_EXIT="1")
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stdout.splitlines()[-1],
                         "warn chromium for snapshots did not install; `cadgen … snapshot` will not render until toolchain/setup.sh runs again")

    # doctor.sh

    def complete_install(self):
        self.venv()
        self.node()
        (self.root / ".playwright" / "chromium_headless_shell-1243").mkdir(parents=True)

    def test_doctor_on_a_complete_install(self):
        self.complete_install()
        run = self.run_script("doctor.sh")
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stdout.splitlines(), [
            f"ok   cadgen {CADGEN_VERSION}",
            "ok   cadgen matches the skills' pin",
            "ok   build123d + OpenCascade",
            "ok   node v22.1.0 (STL, 3MF and GLB exports)",
            "ok   dfam-check extras",
            "ok   playwright + chromium for snapshots",
        ])
        self.assertIn("cadgen doctor skills/cad", self.calls())

    def test_doctor_before_setup_misses_everything(self):
        run = self.run_script("doctor.sh")
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout.splitlines(), [
            "miss .venv/bin/cadgen — run toolchain/setup.sh",
            "miss cadgen does not match skills/cad/requirements.txt",
            "miss build123d in the venv",
            f"miss node >= 20, and Harness's own Node is not in {self.home}/.harness/runtime — run `harness start` once to lay it down",
            "warn dfam-check extras missing (trimesh, scipy, rtree, networkx, lxml)",
            "warn playwright missing; snapshots will not render",
        ])

    def test_doctor_fails_on_a_cadgen_that_does_not_match_the_pin(self):
        self.complete_install()
        run = self.run_script("doctor.sh", CADGEN_DOCTOR_EXIT="1")
        self.assertEqual(run.returncode, 1)
        self.assertIn("miss cadgen does not match skills/cad/requirements.txt", run.stdout.splitlines())

    def test_doctor_only_warns_for_the_extras_and_the_browser(self):
        self.complete_install()
        run = self.run_script("doctor.sh", EXTRAS_EXIT="1", PLAYWRIGHT_EXIT="1")
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stdout.splitlines()[4:], [
            "warn dfam-check extras missing (trimesh, scipy, rtree, networkx, lxml)",
            "warn playwright missing; snapshots will not render",
        ])
        shutil.rmtree(self.root / ".playwright")
        run = self.run_script("doctor.sh")
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stdout.splitlines()[-1], "warn chromium for snapshots missing; snapshots will not render until toolchain/setup.sh runs again")

    # node.sh — what CADGEN_NODE names

    def test_node_is_this_machines_when_it_is_new_enough(self):
        self.node()
        run = self.run_script("node.sh", "builder.mjs", "--format", "stl")
        self.assertEqual((run.returncode, run.stdout, run.stderr), (0, "node builder.mjs --format stl\n", ""))

    def test_node_is_harnesss_own_when_this_machines_is_too_old(self):
        self.node("v18.20.0", new_enough=False)
        self.harness_node()
        run = self.run_script("node.sh", "builder.mjs")
        self.assertEqual((run.returncode, run.stdout, run.stderr), (0, "harness-node builder.mjs\n", ""))

    def test_no_node_at_all_is_a_miss_on_stderr(self):
        run = self.run_script("node.sh", "builder.mjs")
        self.assertEqual((run.returncode, run.stdout), (1, ""))
        self.assertEqual(run.stderr, f"miss node >= 20, and Harness's own Node is not in {self.home}/.harness/runtime — run `harness start` once to lay it down\n")

    # init-workspace.sh

    def workspace(self):
        ws = self.tmp / "ws"
        shutil.copytree(PACKAGE / "template", ws)
        return ws

    def test_init_needs_the_install_dir(self):
        ws = self.workspace()
        run = self.run_script("init-workspace.sh", cwd=ws)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("HARNESS_DSH_DIR is required", run.stderr)
        self.assertFalse((ws / ".harness").exists())

    def test_init_builds_the_starter_and_seeds_the_verdict_even_when_both_fail(self):
        ws = self.workspace()
        self.venv()
        run = self.run_script("init-workspace.sh", cwd=ws, HARNESS_DSH_DIR=str(self.root), PART_EXIT="1")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout, "")
        for made in (".harness", "STEP", "tmp"):
            self.assertTrue((ws / made).is_dir(), made)
        self.assertEqual(self.calls(), [
            # the daemon this build starts serves the agent's later builds: it needs the agent's Node and browser
            "venv-python src/part.py", f"cwd={ws.resolve()} CADGEN_NODE={self.root}/toolchain/node.sh PLAYWRIGHT_BROWSERS_PATH={self.root}/.playwright",
            f"venv-python {self.root}/toolchain/verdict.py", f"cwd={ws.resolve()}",
        ])

    def test_init_seeds_a_real_verdict_the_header_can_show(self):
        ws = self.workspace()
        # The venv python is this python for the verdict (no cadgen: no STEP is judged) and fails the build.
        write_exe(self.root / ".venv" / "bin" / "python",
                  f'#!/bin/sh\ncase "$1" in *verdict.py) exec "{sys.executable}" "$@" ;; esac\nexit 1\n')
        run = self.run_script("init-workspace.sh", cwd=ws, HARNESS_DSH_DIR=str(self.root))
        self.assertEqual(run.returncode, 0, run.stderr)
        verdict = json.loads((ws / ".harness" / "verdict.json").read_text())
        self.assertEqual((verdict["ready"], verdict["summary"]), (False, "no STEP yet"))
        self.assertEqual([p["state"] for p in verdict["phases"]], ["done", "active", "pending"])


if __name__ == "__main__":
    unittest.main()
