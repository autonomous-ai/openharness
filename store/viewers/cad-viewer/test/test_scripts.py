"""setup.sh, doctor.sh and viewer.sh, run against a scratch copy of this package in a temp directory
(its name has a space, as a home directory may) with every command they call stubbed: uv (which makes
a venv of stubs and "installs" cadgen), the venv's python (which runs the real pane_client.py against
test/fake_cadgen.py), and cadgen. PATH holds only the stubs and the few system tools the scripts use, so
nothing on this machine — no real Python, no network, no uv — is touched. What runtimes.sh does beyond
that is store/tools' business.

    python3 -m unittest discover -s test
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent
sys.path.insert(0, str(HERE))

import fake_cadgen  # noqa: E402

# A bash line tracer (BASH_ENV sourcing a DEBUG trap that appends to SHCOV_OUT) is passed through when set.
TRACER = {k: os.environ[k] for k in ("BASH_ENV", "SHCOV_OUT") if k in os.environ}
# Real commands linked into bin/: a stub is never written over one of these (it would go through the link).
LINKED = ("bash", "dirname", "basename", "cat", "head", "mkdir", "mktemp", "rm")

# The venv's python: its version and runtimes.sh's keep-or-replace probe (STUB_VENV_OUT_OF_RANGE), the
# build123d import (STUB_NO_BUILD123D); anything else is the real Python, for pane_client.py.
VENV_PYTHON = """#!/bin/sh
case "$1" in
  --version) echo "Python ${STUB_VENV_PY:-3.12.11}"; exit 0 ;;
  -c)
    case "$2" in
      *version_info*) printf 'python version probe %s %s\\n' "$3" "$4" >> "$STUB_LOG"; [ -z "$STUB_VENV_OUT_OF_RANGE" ] || exit 1; exit 0 ;;
    esac
    printf 'python %s\\n' "$*" >> "$STUB_LOG"
    [ -z "$STUB_NO_BUILD123D" ] || exit 1; exit 0 ;;
esac
printf 'python %s\\n' "$*" >> "$STUB_LOG"
exec "$REAL_PYTHON" "$@"
"""

CADGEN = """#!/bin/sh
printf 'cadgen %s\\n' "$*" >> "$STUB_LOG"
case "$1" in
  --version|doctor)
    [ -z "$STUB_CADGEN_BROKEN" ] || exit 1
    echo "cadgen 0.5.1"
    [ "$1" = doctor ] && echo "  pin      none found (no requirements.txt to check)"
    exit 0 ;;
  viewer)
    printf 'cwd %s\\n' "$(pwd)"
    for arg in "$@"; do printf 'arg %s\\n' "$arg"; done ;;
esac
"""

# uv on PATH: `uv venv … DIR` makes a venv of the stubs above; `uv pip install` succeeds unless told not to.
UV = """#!/bin/sh
printf 'uv %s\\n' "$*" >> "$STUB_LOG"
case "$1" in
  venv)
    for last in "$@"; do :; done
    /bin/mkdir -p "$last/bin"
    /bin/cp "$STUBS/venv-python" "$last/bin/python"
    /bin/cp "$STUBS/venv-cadgen" "$last/bin/cadgen" ;;
  pip) [ -z "$STUB_PIP_INSTALL_FAIL" ] || { echo "error: No solution found when resolving dependencies: cadgen" >&2; exit 1; } ;;
esac
"""


class ScriptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="cad-viewer scripts "))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.pkg = self.root / "cad viewer"
        self.pkg.mkdir()
        # The scripts are linked, not copied, so a line tracer maps back to the source; pane_client.py is
        # copied, since it writes its client next to itself.
        for name in ("setup.sh", "doctor.sh", "viewer.sh", "runtimes.sh"):
            (self.pkg / name).symlink_to(PACKAGE / name)
        for name in ("pane_client.py", "CADGEN_VERSION"):
            shutil.copy2(PACKAGE / name, self.pkg / name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for tool in LINKED:
            found = shutil.which(tool)
            assert found, f"{tool} is needed to run the scripts"
            (self.bin / tool).symlink_to(found)
        self.stubs = self.root / "stubs"
        self.stub("venv-python", VENV_PYTHON, self.stubs)
        self.stub("venv-cadgen", CADGEN, self.stubs)
        self.log = self.root / "calls.log"
        self.log.touch()
        self.site = fake_cadgen.make_site()
        self.addCleanup(shutil.rmtree, self.site, True)
        self.workspace = self.root / "my workspace"
        self.workspace.mkdir()

    def stub(self, name: str, text: str, where: Path | None = None) -> Path:
        where = where or self.bin
        assert not (where == self.bin and name in LINKED), f"{name} is a link to the real command"
        where.mkdir(parents=True, exist_ok=True)
        path = where / name
        path.unlink(missing_ok=True)  # never write through a link to a real command
        path.write_text(text, encoding="utf-8")
        path.chmod(0o755)
        return path

    def uv(self) -> None:
        self.stub("uv", UV)

    def venv(self) -> None:
        """A venv as setup.sh leaves it."""
        self.stub("python", VENV_PYTHON, self.pkg / ".venv" / "bin")
        self.stub("cadgen", CADGEN, self.pkg / ".venv" / "bin")

    def run_script(self, script: str, *, cadgen_importable: bool = True, **env: str) -> subprocess.CompletedProcess[str]:
        base = {
            "PATH": str(self.bin), "HOME": str(self.root), "STUB_LOG": str(self.log), "STUBS": str(self.stubs),
            "REAL_PYTHON": sys.executable, "PYTHONDONTWRITEBYTECODE": "1", **TRACER,
        }
        if cadgen_importable:
            base["PYTHONPATH"] = str(self.site)
        return subprocess.run([str(self.pkg / script)], cwd=self.root, env={**base, **env}, capture_output=True, text=True, timeout=60)

    def calls(self) -> list[str]:
        return self.log.read_text(encoding="utf-8").splitlines()


class SetupTest(ScriptTest):
    def test_a_fresh_install_makes_a_3_12_venv_through_uv_pins_cadgen_and_makes_the_client(self) -> None:
        self.uv()
        result = self.run_script("setup.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            "     python 3.12 in .venv (uv downloads it when this machine has none)",
            "ok   Python 3.12.11 in .venv",
            "     installing cadgen 0.5.1 (this pulls OpenCascade; a few minutes the first time)",
            "ok   cadgen 0.5.1",
            "     loading OpenCascade once",
            "ok   build123d + OpenCascade",
            "ok   pane client",
        ])
        self.assertEqual([c for c in self.calls() if c.startswith("uv ")], [
            "uv venv --quiet --seed --python 3.12 --python-preference only-managed .venv",
            "uv pip install --quiet --python .venv/bin/python cadgen==0.5.1",
        ])
        self.assertTrue((self.pkg / ".pane-client-0.5.1" / ".harness-pane").is_file())

    def test_an_existing_venv_on_3_11_to_3_14_is_kept_and_a_missing_client_is_a_warning(self) -> None:
        self.uv()
        self.venv()
        result = self.run_script("setup.sh", cadgen_importable=False, STUB_VENV_PY="3.13.7", STUB_CADGEN_BROKEN="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            "ok   Python 3.13.7 in .venv",
            "     installing cadgen 0.5.1 (this pulls OpenCascade; a few minutes the first time)",
            "ok   cadgen 0.5.1",
            "     loading OpenCascade once",
            "ok   build123d + OpenCascade",
            "warn pane client not made — the pane serves the bundled client",
        ])
        self.assertIn("python version probe 3.11 3.15", self.calls())
        self.assertFalse(any(c.startswith("uv venv") for c in self.calls()))
        self.assertFalse(any(p.name.startswith(".pane-client") for p in self.pkg.iterdir()))

    def test_a_venv_on_a_python_cadquery_ocp_has_no_wheel_for_is_replaced(self) -> None:
        self.uv()
        self.venv()
        result = self.run_script("setup.sh", STUB_VENV_OUT_OF_RANGE="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("uv venv --quiet --seed --python 3.12 --python-preference only-managed .venv", self.calls())

    def test_a_failed_cadgen_install_fails_setup(self) -> None:
        self.uv()
        result = self.run_script("setup.sh", STUB_PIP_INSTALL_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No solution found when resolving dependencies: cadgen", result.stderr)
        self.assertNotIn("ok   cadgen", result.stdout)

    def test_an_opencascade_that_does_not_load_fails_setup(self) -> None:
        self.uv()
        result = self.run_script("setup.sh", STUB_NO_BUILD123D="1")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines()[-2:], ["     loading OpenCascade once", "miss build123d (OpenCascade) does not load in .venv"])
        self.assertIn("python -c import build123d", self.calls())

    def test_no_uv_and_no_network_is_a_miss_and_no_venv(self) -> None:
        self.stub("uname", '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac\n')
        self.stub("curl", "#!/bin/sh\nexit 6\n")
        result = self.run_script("setup.sh", ADAPTER_RUNTIME_DIR=str(self.root / "runtime"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines()[-1], "miss could not download https://github.com/astral-sh/uv/releases/download/"
                         "0.12.15/uv-aarch64-apple-darwin.tar.gz — check this machine's internet connection")
        self.assertFalse((self.pkg / ".venv").exists())
        self.assertNotIn("installing cadgen", result.stdout)


class DoctorTest(ScriptTest):
    def test_before_setup_both_checks_miss(self) -> None:
        result = self.run_script("doctor.sh")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines(), ["miss .venv/bin/cadgen — run setup.sh", "miss build123d (OpenCascade) in the venv"])

    def test_after_setup_it_names_the_installed_cadgen_and_opencascade(self) -> None:
        self.venv()
        result = self.run_script("doctor.sh")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.splitlines(), ["ok   cadgen 0.5.1", "ok   build123d + OpenCascade"])
        self.assertIn("cadgen doctor .", self.calls())

    def test_a_cadgen_that_cannot_answer_falls_back_to_the_pinned_version_and_a_venv_without_build123d_misses(self) -> None:
        self.venv()
        result = self.run_script("doctor.sh", STUB_CADGEN_BROKEN="1", STUB_NO_BUILD123D="1")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines(), ["ok   cadgen 0.5.1", "miss build123d (OpenCascade) in the venv"])


class ViewerTest(ScriptTest):
    def viewer_args(self, result: subprocess.CompletedProcess[str]) -> tuple[Path, list[str]]:
        lines = result.stdout.splitlines()
        cwd = Path(next(line[4:] for line in lines if line.startswith("cwd ")))
        return cwd, [line[4:] for line in lines if line.startswith("arg ")]

    def test_it_needs_the_port_and_the_workspace(self) -> None:
        self.venv()
        missing_port = self.run_script("viewer.sh", HARNESS_WORKSPACE=str(self.workspace))
        self.assertNotEqual(missing_port.returncode, 0)
        self.assertIn("HARNESS_VIEWER_PORT is required", missing_port.stderr)
        missing_workspace = self.run_script("viewer.sh", HARNESS_VIEWER_PORT="4321")
        self.assertNotEqual(missing_workspace.returncode, 0)
        self.assertIn("HARNESS_WORKSPACE is required", missing_workspace.stderr)
        self.assertFalse(any(call.startswith("cadgen") for call in self.calls()))

    def test_it_serves_the_workspace_on_loopback_as_a_private_instance_with_the_pane_client(self) -> None:
        self.venv()
        result = self.run_script("viewer.sh", HARNESS_VIEWER_PORT="4321", HARNESS_WORKSPACE=str(self.workspace))
        self.assertEqual(result.returncode, 0, result.stderr)
        cwd, args = self.viewer_args(result)
        self.assertEqual(cwd.resolve(), self.workspace.resolve())
        self.assertEqual(args[:7], ["viewer", "--host", "127.0.0.1", "--port", "4321", "--new", "--no-registry"])
        self.assertEqual(args[7], "--dist")
        self.assertEqual(Path(args[8]).resolve(), (self.pkg / ".pane-client-0.5.1").resolve(), "one argument, spaces and all")
        self.assertEqual(len(args), 9)

    def test_without_a_pane_client_it_serves_the_bundled_one(self) -> None:
        self.venv()
        result = self.run_script("viewer.sh", cadgen_importable=False, HARNESS_VIEWER_PORT="4321", HARNESS_WORKSPACE=str(self.workspace))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.viewer_args(result)[1], ["viewer", "--host", "127.0.0.1", "--port", "4321", "--new", "--no-registry"])
        self.assertEqual(result.stderr, "", "pane_client.py's complaint stays out of the pane's log")

    def test_a_workspace_that_is_not_there_stops_it_before_cadgen_starts(self) -> None:
        self.venv()
        result = self.run_script("viewer.sh", HARNESS_VIEWER_PORT="4321", HARNESS_WORKSPACE=str(self.root / "gone"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call.startswith("cadgen") for call in self.calls()))


if __name__ == "__main__":
    unittest.main()
