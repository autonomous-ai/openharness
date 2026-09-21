"""setup.sh, doctor.sh, init-workspace.sh and viewer.sh, run for real against a scratch install whose
PATH holds only stub commands (and the few coreutils the scripts use), so every ok / miss line is
reached without a network, a venv or a marimo on the machine. uv is a stub too: what runtimes.sh does
when uv is not on PATH at all is store/tools/test_runtimes.py's business.

    python3 -m unittest toolchain/test_scripts.py
"""
import os, shutil, subprocess, tempfile, unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
# A bash line tracer (BASH_ENV sourcing a DEBUG trap that appends to SHCOV_OUT) is passed through when set.
TRACER = {k: os.environ[k] for k in ("BASH_ENV", "SHCOV_OUT") if k in os.environ}
BASH = "/bin/bash"
COREUTILS = ("dirname", "cat", "mkdir", "tail", "rm", "cp", "mktemp", "cut", "shasum")
VERSION = (PACKAGE / "MARIMO_VERSION").read_text().strip()

# The venv's python: its version (VENV_PY; runtimes.sh's keep-or-replace probe answers VENV_PY_OK) and
# everything else (verdict.py, viewer.py) answers PIP_EXIT.
VENV_PYTHON = """case "$1" in
  --version) echo "Python ${VENV_PY:-3.12.9}" ;;
  -c) exit "${VENV_PY_OK:-0}" ;;
  *) exit "${PIP_EXIT:-0}" ;;
esac"""


class Sandbox:
    """An install dir with the package's scripts, a bin/ of stubs as the whole PATH, and a log of
    every stub call."""

    def __init__(self, test: unittest.TestCase):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.install = self.root / "install"
        (self.install / "toolchain").mkdir(parents=True)
        for script in PACKAGE.glob("toolchain/*.sh"):
            (self.install / "toolchain" / script.name).symlink_to(script)  # linked, not copied: a line tracer maps back to the source
        (self.install / "viewer.sh").symlink_to(PACKAGE / "viewer.sh")
        shutil.copy(PACKAGE / "MARIMO_VERSION", self.install / "MARIMO_VERSION")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "calls.log"
        self.calls.touch()
        for name in COREUTILS:
            real = next(p for p in (Path("/bin") / name, Path("/usr/bin") / name) if p.exists())
            (self.bin / name).symlink_to(real)

    def stub(self, name: str, body: str = "", where: Path | None = None) -> Path:
        path = (where or self.bin) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)  # never write through a link to a real command
        path.write_text(f'#!/bin/bash\necho "{name} $*" >> "$CALLS"\n{body}\n')
        path.chmod(0o755)
        return path

    def venv(self, root: Path | None = None) -> None:
        """A .venv whose python answers the version probes and whose marimo prints a version the way
        marimo does."""
        bin_ = (root or self.install) / ".venv" / "bin"
        self.stub("python", VENV_PYTHON, where=bin_)
        self.stub("marimo", f'echo "{VERSION}"', where=bin_)

    def uv(self) -> None:
        """uv on PATH: `uv venv … DIR` makes a stub venv in DIR; `uv pip install` answers UV_PIP_EXIT."""
        self.venv(self.root / "template")
        template = self.root / "template" / ".venv" / "bin"
        self.stub("uv", f"""case "$1" in
  venv) for last in "$@"; do :; done; mkdir -p "$last/bin" && cp "{template}/python" "{template}/marimo" "$last/bin/" ;;
  pip) exit "${{UV_PIP_EXIT:-0}}" ;;
esac""")

    def run(self, script: str, cwd: Path | None = None, **env: str) -> subprocess.CompletedProcess:
        return subprocess.run([BASH, str(self.install / script)], cwd=cwd or self.install,
                              env={"PATH": str(self.bin), "CALLS": str(self.calls), **TRACER, **env},
                              capture_output=True, text=True, timeout=60)

    def logged(self) -> list[str]:
        return self.calls.read_text().splitlines()


class Doctor(unittest.TestCase):
    def test_ready(self):
        box = Sandbox(self)
        box.venv()
        r = box.run("toolchain/doctor.sh")
        self.assertEqual((r.returncode, r.stdout), (0, f"ok   marimo {VERSION}\n"), r.stderr)

    def test_no_venv_is_a_miss(self):
        r = Sandbox(self).run("toolchain/doctor.sh")
        self.assertEqual((r.returncode, r.stdout), (1, "miss .venv/bin/marimo — run toolchain/setup.sh\n"))


class Setup(unittest.TestCase):
    def test_makes_a_3_12_venv_and_installs_marimo_into_it(self):
        box = Sandbox(self)
        box.uv()
        r = box.run("toolchain/setup.sh")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["     python 3.12 in .venv (uv downloads it when this machine has none)",
                                                 "ok   Python 3.12.9 in .venv",
                                                 f"     installing marimo {VERSION} and the usual libraries (a minute or two)",
                                                 f"ok   marimo {VERSION}"])
        self.assertIn("uv venv --quiet --seed --python 3.12 --python-preference only-managed .venv", box.logged())
        self.assertIn(f"uv pip install --quiet --python .venv/bin/python marimo=={VERSION} numpy pandas polars altair matplotlib duckdb pyarrow",
                      box.logged())

    def test_an_existing_venv_in_range_is_reused(self):
        box = Sandbox(self)
        box.uv()
        box.venv()
        r = box.run("toolchain/setup.sh", VENV_PY="3.13.1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines()[0], "ok   Python 3.13.1 in .venv")
        self.assertFalse(any(c.startswith("uv venv") for c in box.logged()))
        self.assertIn("python -c", "\n".join(box.logged()), "the venv's python was asked its version")

    def test_a_venv_on_a_python_out_of_range_is_replaced(self):
        box = Sandbox(self)
        box.uv()
        box.venv()
        r = box.run("toolchain/setup.sh", VENV_PY_OK="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("uv venv --quiet --seed --python 3.12 --python-preference only-managed .venv", box.logged())

    def test_no_uv_and_no_network_is_a_miss(self):
        box = Sandbox(self)
        box.stub("uname", 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac')
        box.stub("curl", "exit 6")
        r = box.run("toolchain/setup.sh", ADAPTER_RUNTIME_DIR=str(box.root / "runtime"))
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.splitlines()[-1], "miss could not download https://github.com/astral-sh/uv/releases/download/"
                         "0.12.15/uv-aarch64-apple-darwin.tar.gz — check this machine's internet connection")
        self.assertFalse((box.install / ".venv").exists())

    def test_a_failed_install_fails_setup(self):
        box = Sandbox(self)
        box.uv()
        r = box.run("toolchain/setup.sh", UV_PIP_EXIT="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("ok   marimo", r.stdout)


class InitWorkspace(unittest.TestCase):
    def test_seeds_the_verdict_with_the_venv_python(self):
        box = Sandbox(self)
        box.venv()
        ws = box.root / "ws"
        ws.mkdir()
        r = box.run("toolchain/init-workspace.sh", cwd=ws, HARNESS_DSH_DIR=str(box.install), PIP_EXIT="1")  # a failing verdict does not stop init
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((ws / ".harness").is_dir())
        self.assertEqual(box.logged(), [f"python {box.install}/toolchain/verdict.py"])

    def test_needs_the_install_dir(self):
        box = Sandbox(self)
        r = box.run("toolchain/init-workspace.sh", cwd=box.root)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("HARNESS_DSH_DIR", r.stderr)


class Viewer(unittest.TestCase):
    def test_runs_viewer_py_with_the_venv_python(self):
        box = Sandbox(self)
        box.stub("python", 'echo "port=$HARNESS_VIEWER_PORT workspace=$HARNESS_WORKSPACE"', where=box.install / ".venv" / "bin")
        r = box.run("viewer.sh", cwd=box.root, HARNESS_VIEWER_PORT="4123", HARNESS_WORKSPACE="/Users/example/ws")
        self.assertEqual((r.returncode, r.stdout), (0, "port=4123 workspace=/Users/example/ws\n"), r.stderr)
        self.assertEqual(box.logged(), [f"python {box.install}/viewer.py"])

    def test_needs_a_port_and_a_workspace(self):
        box = Sandbox(self)
        for env, missing in (({"HARNESS_WORKSPACE": "/Users/example/ws"}, "HARNESS_VIEWER_PORT"), ({"HARNESS_VIEWER_PORT": "4123"}, "HARNESS_WORKSPACE")):
            with self.subTest(missing=missing):
                r = box.run("viewer.sh", **env)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn(missing, r.stderr)
                self.assertEqual(box.logged(), [])


if __name__ == "__main__":
    unittest.main()
