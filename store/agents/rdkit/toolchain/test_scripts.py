"""python3 -m unittest toolchain/test_scripts.py — setup, doctor, workspace init and the viewer launcher.

Each test builds a package root in a temp dir with this checkout's scripts symlinked in file by file and
runs them with PATH set to a bin dir holding only what the test grants: a few system tools linked in, and
stubs written here for uv, the venv's python, node and npm. HOME is the sandbox's own, so "miss node" is a
PATH without node and no Harness Node recorded in it; uv, pip and npm never run, and nothing is written
into this checkout. What runtimes.sh does when uv is not on PATH at all is store/tools/test_runtimes.py's
business.

With RDKIT_PYTHON pointing at a Python that has RDKit, two more tests run the real chemistry: setup's
own check against this checkout's harness_rdkit.py, and init on the template (the starter molecule and
its verdict). pip still never runs; that Python is only read.
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
VERSIONS = dict(line.split("=", 1) for line in (PKG / "VERSIONS").read_text().split() if "=" in line)
REAL_PYTHON = os.environ.get("RDKIT_PYTHON", "")
HAS_REAL_PYTHON = bool(REAL_PYTHON) and os.access(REAL_PYTHON, os.X_OK)
TOOLS = ("bash", "cat", "dirname", "ln", "mkdir", "rm", "mktemp", "cut", "shasum")

# The venv's python: its version (STUB_VENV_PY; runtimes.sh's keep-or-replace probe answers
# STUB_VENV_PY_OK); the import probes answer from STUB_* variables; the chemistry check (a script on
# stdin) and file runs are logged, or handed to STUB_REAL_PYTHON.
VENV_PYTHON = r"""#!/bin/bash
log() { printf '%s\n' "$*" >> "$STUB_LOG"; }
if [ -n "${STUB_REAL_PYTHON:-}" ]; then exec "$STUB_REAL_PYTHON" "$@"; fi
case "$1:$2" in
  --version:) echo "Python ${STUB_VENV_PY:-3.12.10}" ;;
  -c:*version_info*) exit "${STUB_VENV_PY_OK:-0}" ;;
  "-c:import rdkit") exit "${STUB_RDKIT_EXIT:-0}" ;;
  "-c:import pandas") exit "${STUB_PANDAS_EXIT:-0}" ;;
  "-c:import rdkit; print(rdkit.__version__)") echo 2026.03.6 ;;
  "-c:import numpy; print(numpy.__version__)") echo 2.5.3 ;;
  "-c:import pandas; print(pandas.__version__)") echo 3.0.5 ;;
  -:*) script="$(cat)"; log "python - PYTHONPATH=$PYTHONPATH"
       case "$script" in *"from harness_rdkit import design"*) ;; *) exit 3 ;; esac
       [ "${STUB_CHEM_EXIT:-0}" = 0 ] || { echo "AssertionError" >&2; exit "$STUB_CHEM_EXIT"; }
       echo "ok   chemistry (stub)" ;;
  *) log "python $* PYTHONPATH=$PYTHONPATH cwd=$PWD"; exit "${STUB_RUN_EXIT:-0}" ;;
esac
"""

# node: VERSION and whether it passes runtimes.sh's `node -e` version check are baked in per stub, so
# the machine's node and Harness's own can differ.
NODE = r"""#!/bin/bash
case "$1" in
  --version) echo VERSION ;;
  -e) exit OLD ;;
  -p) case "$2" in *"dependencies['3dmol']"*|*"3dmol/package.json"*) echo 2.5.5 ;; *) exit 9 ;; esac ;;
  *) printf 'node %s cwd=%s port=%s workspace=%s\n' "$*" "$PWD" "$HARNESS_VIEWER_PORT" "$HARNESS_WORKSPACE" ;;
esac
"""


def node(version: str = "v22.1.0", new_enough: bool = True) -> str:
    return NODE.replace("VERSION", version).replace("OLD", "0" if new_enough else "1")


# uv, as far as runtimes.sh uses it: `uv venv … DIR` lays out the stub venv, `uv pip install` answers
# STUB_PIP_EXIT.
UV = r"""#!/bin/bash
printf 'uv %s\n' "$*" >> "$STUB_LOG"
case "$1" in
  venv) for last in "$@"; do :; done; mkdir -p "$last/bin"; ln -s "$STUB_VENV_PYTHON" "$last/bin/python" ;;
  pip) exit "${STUB_PIP_EXIT:-0}" ;;
esac
"""

NPM = r"""#!/bin/bash
printf 'npm %s\n' "$*" >> "$STUB_LOG"
[ -n "${STUB_NPM_NO_BUNDLE:-}" ] || { mkdir -p node_modules/3dmol/build; : > node_modules/3dmol/build/3Dmol-min.js; }
"""


class Sandbox:
    def __init__(self, test: unittest.TestCase) -> None:
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name).resolve()
        self.root = self.dir / "rdkit"
        self.bin = self.dir / "bin"
        self.stubs = self.dir / "stubs"
        self.home = self.dir / "home"
        self.log = self.dir / "log"
        for folder in (self.root / "toolchain", self.bin, self.stubs):
            folder.mkdir(parents=True)
        self.log.write_text("")
        for tool in TOOLS:
            self.grant(tool)
        self.venv_python = self.write(self.stubs / "venv-python", VENV_PYTHON)
        self.machine("Darwin", "arm64")

    def machine(self, system: str, arch: str) -> None:
        """What `uname -s` and `uname -m` answer."""
        self.stub("uname", f'#!/bin/bash\ncase "$1" in -s) echo {system} ;; -m) echo {arch} ;; esac\n')

    @staticmethod
    def write(path: Path, text: str) -> Path:
        # Never through a link: a granted tool or a linked package file is the real one, not the sandbox's.
        path.unlink(missing_ok=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(0o755)
        return path

    def link(self, *rels: str) -> None:
        for rel in rels:
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.root / rel).symlink_to(PKG / rel)

    def grant(self, tool: str) -> None:
        found = shutil.which(tool)
        assert found, f"{tool} is needed on this machine to run the test"
        (self.bin / tool).symlink_to(found)

    def stub(self, name: str, text: str) -> None:
        self.write(self.bin / name, text)

    def harness_node(self, version: str = "v22.23.2", new_enough: bool = True, npm: bool = True) -> Path:
        """Harness's own Node, recorded in the sandbox HOME the way the CLI records it."""
        path = self.write(self.dir / "harness-node" / "bin" / "node", node(version, new_enough))
        if npm:
            self.write(path.parent / "npm", NPM)
        self.write(self.home / ".harness" / "runtime" / "current-node", f"{path}\n")
        return path

    def venv(self) -> None:
        (self.root / ".venv" / "bin").mkdir(parents=True)
        (self.root / ".venv" / "bin" / "python").symlink_to(self.venv_python)

    def touch(self, *rels: str) -> None:
        for rel in rels:
            self.write(self.root / rel, "")

    def run(self, rel: str, cwd: Path | None = None, **env: str) -> subprocess.CompletedProcess:
        clean = {k: v for k, v in os.environ.items() if not k.startswith(("HARNESS_", "RDKIT_", "PYTHON", "ADAPTER_", "UV_"))}
        return subprocess.run([str(self.root / rel)], cwd=cwd or self.dir, capture_output=True, text=True, timeout=120,
                              env={**clean, "PATH": str(self.bin), "HOME": str(self.home), "STUB_LOG": str(self.log),
                                   "STUB_VENV_PYTHON": str(self.venv_python), **env})

    def logged(self) -> list[str]:
        return self.log.read_text().splitlines()


def lines(done: subprocess.CompletedProcess) -> list[str]:
    return done.stdout.splitlines()


class Setup(unittest.TestCase):
    def sandbox(self, uv: bool = True, node_on_path: bool = True, npm: bool = True) -> Sandbox:
        box = Sandbox(self)
        box.link("toolchain/setup.sh", "toolchain/runtimes.sh", "VERSIONS", "package.json")
        box.touch("pane/index.html", "pane/app.js")
        if uv:
            box.stub("uv", UV)
        if node_on_path:
            box.stub("node", node())
        if npm:
            box.stub("npm", NPM)
        return box

    def test_everything_installs_into_the_package_and_is_checked(self) -> None:
        box = self.sandbox()
        done = box.run("toolchain/setup.sh")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(lines(done), [
            "     python 3.12 in .venv (uv downloads it when this machine has none)",
            "ok   Python 3.12.10 in .venv",
            f"     installing rdkit {VERSIONS['RDKIT']}",
            "ok   rdkit 2026.03.6 · numpy 2.5.3 · pandas 3.0.5",
            "     chemistry check (build, conformers, depict, describe, series)",
            "ok   chemistry (stub)",
            "     npm ci (3Dmol.js 2.5.5)",
            "ok   3dmol 2.5.5",
        ])
        self.assertEqual(box.logged(), [
            "uv venv --quiet --seed --python 3.12 --python-preference only-managed .venv",
            f"uv pip install --quiet --python .venv/bin/python rdkit=={VERSIONS['RDKIT']} numpy=={VERSIONS['NUMPY']} pandas=={VERSIONS['PANDAS']}",
            f"python - PYTHONPATH={box.root}/toolchain",
            "npm ci --silent --no-audit --no-fund",
        ])

    def test_an_existing_venv_on_3_12_or_later_is_kept(self) -> None:
        box = self.sandbox()
        box.venv()
        done = box.run("toolchain/setup.sh", STUB_VENV_PY="3.13.2")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(lines(done)[0], "ok   Python 3.13.2 in .venv")
        self.assertFalse(any(c.startswith("uv venv") for c in box.logged()))

    def test_a_venv_on_a_python_the_pins_do_not_support_is_replaced(self) -> None:
        box = self.sandbox()
        box.venv()
        done = box.run("toolchain/setup.sh", STUB_VENV_PY_OK="1")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("uv venv --quiet --seed --python 3.12 --python-preference only-managed .venv", box.logged())

    def test_no_uv_and_no_network_is_a_miss(self) -> None:
        box = self.sandbox(uv=False)
        box.stub("curl", "#!/bin/bash\nexit 6\n")
        done = box.run("toolchain/setup.sh")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(lines(done)[-1], "miss could not download https://github.com/astral-sh/uv/releases/download/"
                                          "0.12.15/uv-aarch64-apple-darwin.tar.gz — check this machine's internet connection")
        self.assertFalse((box.root / ".venv").exists())

    def test_an_intel_mac_stops_before_downloading_anything(self) -> None:
        box = self.sandbox()
        box.machine("Darwin", "x86_64")
        done = box.run("toolchain/setup.sh")
        self.assertEqual((done.returncode, lines(done)), (1, [f"miss rdkit {VERSIONS['RDKIT']} has no Intel Mac build — this harness needs an Apple Silicon Mac, or Linux"]))
        self.assertEqual(box.logged(), [])

    def test_linux_on_either_architecture_installs(self) -> None:
        for arch in ("x86_64", "aarch64"):
            with self.subTest(arch=arch):
                box = self.sandbox()
                box.machine("Linux", arch)
                done = box.run("toolchain/setup.sh")
                self.assertEqual((done.returncode, lines(done)[-1]), (0, "ok   3dmol 2.5.5"), done.stderr)

    def test_a_failed_install_or_chemistry_check_stops_setup(self) -> None:
        done = self.sandbox().run("toolchain/setup.sh", STUB_PIP_EXIT="1")
        self.assertNotEqual(done.returncode, 0)
        self.assertEqual(lines(done)[-2:], [f"     installing rdkit {VERSIONS['RDKIT']}",
                                            f"miss could not install rdkit=={VERSIONS['RDKIT']} numpy=={VERSIONS['NUMPY']} pandas=={VERSIONS['PANDAS']} into .venv"])
        done = self.sandbox().run("toolchain/setup.sh", STUB_CHEM_EXIT="1")
        self.assertNotEqual(done.returncode, 0)
        self.assertEqual(lines(done)[-1], "     chemistry check (build, conformers, depict, describe, series)")

    def test_with_no_node_on_path_the_pane_is_built_with_harnesss_own(self) -> None:
        box = self.sandbox(node_on_path=False, npm=False)
        harness_node = box.harness_node()
        done = box.run("toolchain/setup.sh")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(lines(done)[-2:], ["     npm ci (3Dmol.js 2.5.5)", "ok   3dmol 2.5.5"])
        self.assertTrue((box.root / "node_modules/3dmol/build/3Dmol-min.js").is_file(), f"the npm beside {harness_node} ran")

    def test_the_pane_needs_node_npm_the_bundle_and_its_files(self) -> None:
        box = self.sandbox(node_on_path=False)
        done = box.run("toolchain/setup.sh")
        self.assertEqual((done.returncode, lines(done)[-1]),
                         (1, f"miss node >= 18, and Harness's own Node is not in {box.home}/.harness/runtime — run `harness start` once to lay it down"))
        box = self.sandbox(npm=False)
        done = box.run("toolchain/setup.sh")
        self.assertEqual((done.returncode, lines(done)[-1]), (1, f"miss npm beside {box.bin}/node (the pane)"))
        done = self.sandbox().run("toolchain/setup.sh", STUB_NPM_NO_BUNDLE="1")
        self.assertEqual((done.returncode, lines(done)[-1]), (1, "miss the 3Dmol.js bundle after npm ci"))
        box = self.sandbox()
        (box.root / "pane" / "app.js").unlink()
        done = box.run("toolchain/setup.sh")
        self.assertEqual((done.returncode, lines(done)[-1]), (1, "miss the pane (pane/index.html, pane/app.js)"))

    @unittest.skipUnless(HAS_REAL_PYTHON, "RDKIT_PYTHON is not set to a Python with RDKit")
    def test_the_chemistry_check_passes_on_this_checkouts_helper(self) -> None:
        box = self.sandbox()
        box.link("toolchain/harness_rdkit.py")
        done = box.run("toolchain/setup.sh", STUB_REAL_PYTHON=REAL_PYTHON)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("ok   conformer search, MMFF minimisation, Gasteiger charges, 2D depiction and the series work", lines(done))


class Doctor(unittest.TestCase):
    def sandbox(self) -> Sandbox:
        box = Sandbox(self)
        box.link("toolchain/doctor.sh", "toolchain/runtimes.sh", "VERSIONS")
        return box

    def test_an_intel_mac_is_told_it_cannot_run_this_harness(self) -> None:
        box = self.sandbox()
        box.machine("Darwin", "x86_64")
        done = box.run("toolchain/doctor.sh")
        self.assertEqual((done.returncode, lines(done)), (1, [f"miss rdkit {VERSIONS['RDKIT']} has no Intel Mac build — this harness needs an Apple Silicon Mac, or Linux"]))

    def test_a_complete_install_is_ready(self) -> None:
        box = self.sandbox()
        box.venv()
        box.stub("node", node())
        box.touch("node_modules/3dmol/build/3Dmol-min.js", "pane/index.html", "pane/app.js")
        done = box.run("toolchain/doctor.sh")
        self.assertEqual((done.returncode, lines(done)), (0, [
            "ok   rdkit 2026.03.6",
            "ok   pandas 3.0.5 · numpy 2.5.3",
            "ok   node v22.1.0 (the pane's server)",
            "ok   3dmol 2.5.5 (the pane)",
            "ok   pane (3D, 2D, properties, conformers, series)",
        ]))

    def test_harnesss_own_node_serves_when_this_machines_is_missing_or_too_old(self) -> None:
        for on_path in (False, True):
            with self.subTest(machine_node=on_path):
                box = self.sandbox()
                box.venv()
                if on_path:
                    box.stub("node", node("v16.20.2", new_enough=False))
                box.harness_node()
                box.touch("node_modules/3dmol/build/3Dmol-min.js", "pane/index.html", "pane/app.js")
                done = box.run("toolchain/doctor.sh")
                self.assertEqual(done.returncode, 0, done.stdout)
                self.assertIn("ok   node v22.23.2 (the pane's server)", lines(done))

    def test_an_empty_install_says_what_is_missing(self) -> None:
        box = self.sandbox()
        done = box.run("toolchain/doctor.sh")
        self.assertEqual((done.returncode, lines(done)), (1, [
            "miss .venv with rdkit — run toolchain/setup.sh",
            "warn pandas/numpy missing — tables and enumerations need them",
            f"miss node >= 18, and Harness's own Node is not in {box.home}/.harness/runtime — run `harness start` once to lay it down",
            "miss node_modules — run toolchain/setup.sh",
            "miss pane/ — reinstall the package",
        ]))

    def test_a_venv_without_rdkit_or_pandas(self) -> None:
        box = self.sandbox()
        box.venv()
        done = box.run("toolchain/doctor.sh", STUB_RDKIT_EXIT="1", STUB_PANDAS_EXIT="1")
        self.assertEqual(lines(done)[:2], ["miss .venv with rdkit — run toolchain/setup.sh",
                                           "warn pandas/numpy missing — tables and enumerations need them"])
        self.assertEqual(done.returncode, 1)


class InitWorkspace(unittest.TestCase):
    def test_it_needs_the_install_dir(self) -> None:
        box = Sandbox(self)
        box.link("toolchain/init-workspace.sh")
        done = box.run("toolchain/init-workspace.sh")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("HARNESS_DSH_DIR", done.stderr)

    def test_it_builds_the_starter_and_seeds_the_verdict_and_never_fails_on_them(self) -> None:
        box = Sandbox(self)
        box.link("toolchain/init-workspace.sh")
        box.venv()
        workspace = box.dir / "workspace"
        workspace.mkdir()
        done = box.run("toolchain/init-workspace.sh", cwd=workspace, HARNESS_DSH_DIR=str(box.root), STUB_RUN_EXIT="1")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue((workspace / ".harness").is_dir() and (workspace / "out").is_dir())
        path = f"PYTHONPATH={box.root}/toolchain cwd={workspace}"
        self.assertEqual(box.logged(), [f"python molecules/hello.py {path}", f"python {box.root}/toolchain/verdict.py {path}"])

    @unittest.skipUnless(HAS_REAL_PYTHON, "RDKIT_PYTHON is not set to a Python with RDKit")
    def test_the_template_starter_designs_ibuprofen_and_the_verdict_is_ready(self) -> None:
        box = Sandbox(self)
        box.link("toolchain/init-workspace.sh", "toolchain/harness_rdkit.py", "toolchain/verdict.py")
        box.venv()
        workspace = box.dir / "workspace"
        shutil.copytree(PKG / "template", workspace)
        done = box.run("toolchain/init-workspace.sh", cwd=workspace, HARNESS_DSH_DIR=str(box.root), STUB_REAL_PYTHON=REAL_PYTHON)
        self.assertEqual(done.returncode, 0, done.stderr)
        verdict = json.loads((workspace / ".harness" / "verdict.json").read_text())
        self.assertTrue(verdict["ready"], verdict)
        self.assertEqual(verdict["artifact"], "out/ibuprofen.sdf")
        self.assertTrue((workspace / "out" / "ibuprofen.conformers.sdf").is_file())


class Viewer(unittest.TestCase):
    def sandbox(self) -> Sandbox:
        box = Sandbox(self)
        box.link("viewer.sh", "toolchain/runtimes.sh")
        return box

    def test_it_needs_the_port_and_the_workspace(self) -> None:
        box = self.sandbox()
        done = box.run("viewer.sh", HARNESS_WORKSPACE=str(box.dir))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("HARNESS_VIEWER_PORT", done.stderr)
        done = box.run("viewer.sh", HARNESS_VIEWER_PORT="4100")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("HARNESS_WORKSPACE", done.stderr)

    def test_it_runs_the_server_beside_it(self) -> None:
        box = self.sandbox()
        box.stub("node", node())
        done = box.run("viewer.sh", HARNESS_VIEWER_PORT="4100", HARNESS_WORKSPACE=str(box.dir))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(lines(done), [f"node {box.root}/viewer.mjs cwd={box.dir} port=4100 workspace={box.dir}"])

    def test_a_login_shell_with_no_node_runs_it_on_harnesss_own(self) -> None:
        box = self.sandbox()
        harness_node = box.harness_node()
        box.write(harness_node, node().replace("printf 'node ", "printf 'harness-node "))
        done = box.run("viewer.sh", HARNESS_VIEWER_PORT="4100", HARNESS_WORKSPACE=str(box.dir))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(lines(done), [f"harness-node {box.root}/viewer.mjs cwd={box.dir} port=4100 workspace={box.dir}"])

    def test_no_node_at_all_is_a_miss_and_nothing_starts(self) -> None:
        box = self.sandbox()
        done = box.run("viewer.sh", HARNESS_VIEWER_PORT="4100", HARNESS_WORKSPACE=str(box.dir))
        self.assertEqual((done.returncode, lines(done)), (1, [
            f"miss node >= 18, and Harness's own Node is not in {box.home}/.harness/runtime — run `harness start` once to lay it down"]))


if __name__ == "__main__":
    unittest.main()
