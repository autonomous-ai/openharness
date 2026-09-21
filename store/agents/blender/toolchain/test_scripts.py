"""setup.sh, doctor.sh and init-workspace.sh, run for real against a scratch install whose PATH holds
only stub commands (and the few coreutils the scripts use), so every ok / warn / miss line is reached
without a network, a Python 3.11 or a 300 MB bpy wheel. uv is a stub too: what runtimes.sh does when
uv is not on PATH at all is store/tools/test_runtimes.py's business.

    python3 -m unittest toolchain/test_scripts.py
"""
import os, shutil, subprocess, tempfile, unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
# A bash line tracer (BASH_ENV sourcing a DEBUG trap that appends to SHCOV_OUT) is passed through when set.
TRACER = {k: os.environ[k] for k in ("BASH_ENV", "SHCOV_OUT") if k in os.environ}
BASH = "/bin/bash"
COREUTILS = ("dirname", "cat", "mkdir", "cp", "rm", "chmod", "grep", "mktemp", "cut", "shasum")
VERSION = (PACKAGE / "BPY_VERSION").read_text().strip()

# The venv's python: its version (VENV_PY — what runtimes.sh's keep-or-replace probe answers is
# VENV_PY_OK), the bpy import (IMPORT_BPY), bpy's version string and the heredoc render check (RENDER_EXIT).
VENV_PYTHON = """case "$1" in
  --version) echo "Python ${VENV_PY:-3.11.9}" ;;
  -c) case "$2" in *version_string*) echo "%s" ;; *version_info*) exit "${VENV_PY_OK:-0}" ;; *) exit "${IMPORT_BPY:-0}" ;; esac ;;
  -) cat >/dev/null; [ "${RENDER_EXIT:-0}" = 0 ] || exit "$RENDER_EXIT"; echo "ok   headless rendering works" ;;
esac""" % VERSION


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
        shutil.copy(PACKAGE / "BPY_VERSION", self.install / "BPY_VERSION")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "calls.log"
        self.calls.touch()
        for name in COREUTILS:
            real = next(p for p in (Path("/bin") / name, Path("/usr/bin") / name) if p.exists())
            (self.bin / name).symlink_to(real)
        self.platform("Darwin", "arm64")

    def stub(self, name: str, body: str = "", where: Path | None = None) -> Path:
        path = (where or self.bin) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)  # never write through a link to a real command
        path.write_text(f'#!/bin/bash\necho "{name} $*" >> "$CALLS"\n{body}\n')
        path.chmod(0o755)
        return path

    def platform(self, system: str, machine: str) -> None:
        """uname, unlogged: which machine setup believes it is on."""
        path = self.bin / "uname"
        path.unlink(missing_ok=True)
        path.write_text(f'#!/bin/bash\ncase "$1" in -s) echo {system} ;; -m) echo {machine} ;; esac\n')
        path.chmod(0o755)

    def uv(self) -> Path:
        """uv on PATH: `uv venv … DIR` makes a venv of stubs; `uv pip install` answers PIP_EXIT."""
        venv_python = self.stub("python", VENV_PYTHON, where=self.root / "templates")
        return self.stub("uv", f"""case "$1" in
  venv) for last in "$@"; do :; done; mkdir -p "$last/bin" && cp "{venv_python}" "$last/bin/python" ;;
  pip) exit "${{PIP_EXIT:-0}}" ;;
esac""")

    def venv(self) -> Path:
        return self.stub("python", VENV_PYTHON, where=self.install / ".venv" / "bin")

    def run(self, script: str, cwd: Path | None = None, **env: str) -> subprocess.CompletedProcess:
        return subprocess.run([BASH, str(self.install / "toolchain" / script)], cwd=cwd or self.install,
                              env={"PATH": str(self.bin), "CALLS": str(self.calls), **TRACER, **env},
                              capture_output=True, text=True, timeout=60)

    def logged(self) -> list[str]:
        return self.calls.read_text().splitlines()


class Doctor(unittest.TestCase):
    def test_ready_with_ffmpeg(self):
        box = Sandbox(self)
        box.venv()
        box.stub("ffmpeg")
        r = box.run("doctor.sh")
        self.assertEqual((r.returncode, r.stdout.splitlines()), (0, [f"ok   blender {VERSION}", "ok   ffmpeg (turntables)"]), r.stderr)

    def test_the_venvs_own_ffmpeg_serves(self):
        box = Sandbox(self)
        box.venv()
        r = box.run("doctor.sh")
        self.assertEqual((r.returncode, r.stdout.splitlines()), (0, [f"ok   blender {VERSION}", "ok   ffmpeg (turntables)"]), r.stderr)

    def test_no_ffmpeg_is_only_a_warning(self):
        box = Sandbox(self)
        box.stub("python", 'case "$2" in *imageio_ffmpeg*) exit 1 ;; *version_string*) echo "%s" ;; esac' % VERSION,
                 where=box.install / ".venv" / "bin")
        r = box.run("doctor.sh")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.splitlines()[-1], "warn no ffmpeg — turntables stay as frames until toolchain/setup.sh runs again")

    def test_no_venv_is_a_miss_and_stops(self):
        box = Sandbox(self)
        box.stub("ffmpeg")
        r = box.run("doctor.sh")
        self.assertEqual((r.returncode, r.stdout.splitlines()), (1, ["miss .venv with bpy — run toolchain/setup.sh"]))

    def test_a_venv_without_bpy_is_a_miss(self):
        box = Sandbox(self)
        box.venv()
        r = box.run("doctor.sh", IMPORT_BPY="1")
        self.assertEqual((r.returncode, r.stdout.splitlines()), (1, ["miss .venv with bpy — run toolchain/setup.sh"]))


class Setup(unittest.TestCase):
    def test_makes_a_3_11_venv_installs_bpy_and_checks_rendering(self):
        box = Sandbox(self)
        box.uv()
        r = box.run("setup.sh")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), [
            "     python 3.11 in .venv (uv downloads it when this machine has none)",
            "ok   Python 3.11.9 in .venv",
            f"     installing bpy {VERSION} (Blender as a module, ~300 MB, a few minutes the first time)",
            f"ok   blender {VERSION}",
            "     render check (Workbench, headless)",
            "ok   headless rendering works",
        ])
        log = box.logged()
        self.assertIn("uv venv --quiet --seed --python 3.11 --python-preference only-managed .venv", log)
        self.assertIn(f"uv pip install --quiet --python .venv/bin/python bpy=={VERSION} numpy imageio-ffmpeg", log)
        self.assertEqual(log[-1], "python -")

    def test_an_existing_3_11_venv_is_reused(self):
        box = Sandbox(self)
        box.uv()
        box.venv()
        r = box.run("setup.sh")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines()[0], "ok   Python 3.11.9 in .venv")
        self.assertFalse(any(line.startswith("uv venv") for line in box.logged()))

    def test_a_venv_on_another_python_is_replaced(self):
        box = Sandbox(self)
        box.uv()
        box.venv()
        r = box.run("setup.sh", VENV_PY_OK="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("uv venv --quiet --seed --python 3.11 --python-preference only-managed .venv", box.logged())

    def test_no_uv_and_no_network_is_a_miss(self):
        box = Sandbox(self)
        box.stub("curl", "exit 6")
        r = box.run("setup.sh", ADAPTER_RUNTIME_DIR=str(box.root / "runtime"))
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.splitlines()[-1], "miss could not download https://github.com/astral-sh/uv/releases/download/"
                         "0.12.15/uv-aarch64-apple-darwin.tar.gz — check this machine's internet connection")

    def test_an_intel_mac_gets_the_lts_that_still_builds_for_it(self):
        box = Sandbox(self)
        shutil.copy(PACKAGE / "BPY_VERSION_INTEL_MAC", box.install / "BPY_VERSION_INTEL_MAC")
        intel = (PACKAGE / "BPY_VERSION_INTEL_MAC").read_text().strip()
        box.platform("Darwin", "x86_64")
        box.uv()
        r = box.run("setup.sh")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines()[0], f"     an Intel Mac: bpy {intel} LTS, the newest Blender built for one")
        self.assertIn(f"uv pip install --quiet --python .venv/bin/python bpy=={intel} numpy imageio-ffmpeg", box.logged())

    def test_linux_on_arm_is_a_miss_before_anything_downloads(self):
        for machine in ("aarch64", "arm64"):
            with self.subTest(machine=machine):
                box = Sandbox(self)
                box.platform("Linux", machine)
                box.uv()
                r = box.run("setup.sh")
                self.assertEqual((r.returncode, r.stdout.splitlines()), (1, [
                    "miss Blender publishes no bpy for Linux on ARM — this harness runs on a Mac or on x86-64 Linux"]))
                self.assertEqual(box.logged(), [])

    def test_a_failed_install_stops_setup(self):
        box = Sandbox(self)
        box.uv()
        r = box.run("setup.sh", PIP_EXIT="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn(f"ok   blender {VERSION}", r.stdout)

    def test_a_render_check_that_fails_fails_setup(self):
        box = Sandbox(self)
        box.uv()
        r = box.run("setup.sh", RENDER_EXIT="3")
        self.assertEqual(r.returncode, 3)
        self.assertEqual(r.stdout.splitlines()[-1], "     render check (Workbench, headless)")


class InitWorkspace(unittest.TestCase):
    def test_builds_the_starter_and_seeds_the_verdict(self):
        box = Sandbox(self)
        ws = box.root / "ws"
        ws.mkdir()
        # Both fail: a starter that cannot build (no bpy yet) must not stop the workspace being made.
        box.stub("python", 'echo "PYTHONPATH=${PYTHONPATH:-}" >> "$CALLS"; exit 1', where=box.install / ".venv" / "bin")
        r = box.run("init-workspace.sh", cwd=ws, HARNESS_DSH_DIR=str(box.install))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((ws / ".harness").is_dir() and (ws / "out").is_dir())
        self.assertEqual(box.logged(), ["python scenes/hello.py", f"PYTHONPATH={box.install}/toolchain",
                                        f"python {box.install}/toolchain/verdict.py", "PYTHONPATH="])

    def test_needs_the_install_dir(self):
        box = Sandbox(self)
        r = box.run("init-workspace.sh", cwd=box.root)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("HARNESS_DSH_DIR", r.stderr)


if __name__ == "__main__":
    unittest.main()
