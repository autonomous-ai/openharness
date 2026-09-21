"""setup.sh, doctor.sh and init-workspace.sh, run for real against a scratch install whose PATH holds
only stub commands (and the few coreutils the scripts use), so every ok / miss / warn line is reached
without a network, a conda-forge environment or Manim on the machine. uv and micromamba are stubs too
(micromamba laid where runtimes.sh keeps it): what runtimes.sh does when they are not there yet is
store/tools/test_runtimes.py's business, apart from the one miss a setup with no network ends on.

    python3 -m unittest toolchain/test_scripts.py
"""
import os, shutil, subprocess, tempfile, unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
# A bash line tracer (BASH_ENV sourcing a DEBUG trap that appends to SHCOV_OUT) is passed through when set.
TRACER = {k: os.environ[k] for k in ("BASH_ENV", "SHCOV_OUT") if k in os.environ}
BASH = "/bin/bash"
COREUTILS = ("dirname", "cat", "mkdir", "cp", "rm", "head", "cut", "chmod", "mv")
VERSION = (PACKAGE / "MANIM_VERSION").read_text().strip()
MICROMAMBA = "micromamba-2.9.0-0"  # runtimes.sh's pinned release, where it keeps it

# The environment's python. What the scripts ask it: its version (VENV_PY); whether this Manim is in
# it with a pycairo that loads (the keep probe: Manim is there when uv's stub laid bin/manim for that
# version); whether pycairo loads on a new enough Python (CAIRO_EXIT); the version pip recorded.
VENV_PYTHON = """here="$(dirname "$0")"
case "$1" in
  --version) echo "Python ${VENV_PY:-3.12.14}" ;;
  -c) [ "${CAIRO_EXIT:-0}" = 0 ] || exit "$CAIRO_EXIT"
      case "$2" in
        *manim.__version__*) [ "$("$here/manim" --version 2>/dev/null)" = "Manim Community v$3" ] ;;
        *importlib.metadata*) [ -x "$here/manim" ] && "$here/manim" --version | cut -dv -f2 ;;
      esac ;;
esac"""


class Sandbox:
    """An install dir with the package's scripts, a bin/ of stubs as the whole PATH, a runtime dir
    for runtimes.sh, and a log of every stub call."""

    def __init__(self, test: unittest.TestCase):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.install = self.root / "install"
        (self.install / "toolchain").mkdir(parents=True)
        for script in PACKAGE.glob("toolchain/*.sh"):
            (self.install / "toolchain" / script.name).symlink_to(script)  # linked, not copied: a line tracer maps back to the source
        shutil.copy(PACKAGE / "MANIM_VERSION", self.install / "MANIM_VERSION")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.templates = self.root / "templates"
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

    def run(self, script: str, cwd: Path | None = None, **env: str) -> subprocess.CompletedProcess:
        return subprocess.run([BASH, str(self.install / "toolchain" / script)], cwd=cwd or self.install,
                              env={"PATH": str(self.bin), "CALLS": str(self.calls), "ADAPTER_RUNTIME_DIR": str(self.runtime), **TRACER, **env},
                              capture_output=True, text=True, timeout=60)

    def logged(self) -> list[str]:
        return self.calls.read_text().splitlines()

    # The machine's pieces, as the scripts ask about them.
    def venv(self, manim: str | None = VERSION) -> None:
        """.venv as a conda environment leaves it, with Manim `manim` in it (None: not yet)."""
        self.stub("python", VENV_PYTHON, where=self.install / ".venv" / "bin")
        (self.install / ".venv" / "conda-meta").mkdir(exist_ok=True)
        if manim:
            self.stub("manim", f'echo "Manim Community v{manim}"', where=self.install / ".venv" / "bin")

    def micromamba(self) -> None:
        """micromamba already in the runtime dir: `create --prefix DIR` makes DIR an environment with a
        python, or fails with $MAMBA_EXIT."""
        python = self.stub("python", VENV_PYTHON, where=self.templates)
        self.stub("micromamba", f"""[ "${{MAMBA_EXIT:-0}}" = 0 ] || exit "$MAMBA_EXIT"
while [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix="$2"; shift; done
mkdir -p "$prefix/conda-meta" "$prefix/bin" && cp "{python}" "$prefix/bin/python"
""", where=self.runtime / MICROMAMBA)

    def uv(self) -> None:
        """uv on PATH: `uv pip install --python PY manim==V` lays PY's bin/manim for V, or fails with $PIP_EXIT."""
        self.stub("uv", """[ "${PIP_EXIT:-0}" = 0 ] || exit "$PIP_EXIT"
for arg in "$@"; do case "$arg" in manim==*) v="${arg#manim==}" ;; esac; done
printf '#!/bin/bash\\necho "Manim Community v%s"\\n' "$v" > .venv/bin/manim && chmod +x .venv/bin/manim""")


class Doctor(unittest.TestCase):
    def test_everything_there(self):
        box = Sandbox(self)
        box.venv(); box.stub("latex")
        r = box.run("doctor.sh")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), [f"ok   manim {VERSION}", "ok   latex (Tex/MathTex available)"])

    def test_no_ffmpeg_and_no_latex_is_still_a_working_install(self):
        box = Sandbox(self)
        box.venv()
        r = box.run("doctor.sh")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), [
            f"ok   manim {VERSION}",
            "warn latex not on PATH — Tex/MathTex scenes need a TeX distribution (MacTeX, TeX Live); Text() works without",
        ])

    def test_no_environment_or_one_whose_pycairo_does_not_load_is_a_miss(self):
        for label, prepare, env in (("no .venv", lambda box: None, {}), ("no manim", lambda box: box.venv(manim=None), {}),
                                    ("pycairo broken", lambda box: box.venv(), {"CAIRO_EXIT": "1"})):
            with self.subTest(label):
                box = Sandbox(self)
                prepare(box)
                r = box.run("doctor.sh", **env)
                self.assertEqual(r.returncode, 1)
                self.assertEqual(r.stdout.splitlines()[0], "miss manim with pycairo in .venv — run toolchain/setup.sh")


class Setup(unittest.TestCase):
    MAMBA_CREATE = "micromamba create --yes --quiet --prefix {install}/.venv --override-channels --channel conda-forge python=3.12 pycairo manimpango pip"
    PIP = f"uv pip install --quiet --python .venv/bin/python manim=={VERSION}"

    def sandbox(self) -> Sandbox:
        box = Sandbox(self)
        box.micromamba()
        box.uv()
        return box

    def test_a_new_machine_gets_a_conda_forge_python_with_pycairo_then_manim(self):
        box = self.sandbox()
        r = box.run("setup.sh")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), [
            "     python 3.12, pycairo and manimpango from conda-forge into .venv (a few minutes the first time)",
            "ok   Python 3.12.14 with pycairo in .venv",
            f"     installing manim {VERSION} (a couple of minutes the first time)",
            f"ok   manim Manim Community v{VERSION}",
        ])
        log = box.logged()
        self.assertIn(self.MAMBA_CREATE.format(install=box.install), log)
        self.assertIn(self.PIP, log)

    def test_an_environment_that_already_has_this_manim_is_kept_without_a_download(self):
        box = self.sandbox()
        box.venv()
        (box.install / ".venv" / "conda-meta").rmdir()   # a pip venv on Homebrew's cairo, as older installs made
        r = box.run("setup.sh")
        self.assertEqual((r.returncode, r.stdout.splitlines()), (0, [f"ok   manim {VERSION} already in .venv"]), r.stderr)
        self.assertFalse(any(line.startswith(("micromamba", "uv")) for line in box.logged()))

    def test_a_new_pin_goes_into_the_environment_there(self):
        box = self.sandbox()
        box.venv(manim="0.18.1")
        r = box.run("setup.sh", VENV_PY="3.11.9")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines()[0], "ok   Python 3.11.9 with pycairo in .venv")
        self.assertEqual(r.stdout.splitlines()[-1], f"ok   manim Manim Community v{VERSION}")
        self.assertIn(self.PIP, box.logged())
        self.assertFalse(any(line.startswith("micromamba") for line in box.logged()))

    def test_an_environment_whose_pycairo_does_not_load_is_made_again(self):
        box = self.sandbox()
        box.venv()
        (box.install / ".venv" / "stale").write_text("from the old environment")
        # Only the first two probes fail (the old .venv); the conda-forge one answers as a working one.
        box.stub("python", 'exit 1', where=box.install / ".venv" / "bin")
        r = box.run("setup.sh")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines()[0], "     python 3.12, pycairo and manimpango from conda-forge into .venv (a few minutes the first time)")
        self.assertIn(self.MAMBA_CREATE.format(install=box.install), box.logged())
        self.assertFalse((box.install / ".venv" / "stale").exists())

    def test_no_network_for_micromamba_is_a_miss(self):
        box = Sandbox(self)
        box.uv()
        box.stub("uname", 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac')
        box.stub("curl", "exit 6")
        r = box.run("setup.sh")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.splitlines()[-1], "miss could not download https://github.com/mamba-org/micromamba-releases/releases/download/"
                         "2.9.0-0/micromamba-osx-arm64 — check this machine's internet connection")

    def test_an_environment_conda_forge_will_not_make_is_a_miss(self):
        box = self.sandbox()
        r = box.run("setup.sh", MAMBA_EXIT="1")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.splitlines()[-1], f"miss could not make the conda-forge environment in {box.install}/.venv (python=3.12 pycairo manimpango pip)")
        self.assertFalse(any(line.startswith("uv") for line in box.logged()))

    def test_a_failed_install_fails_setup(self):
        box = self.sandbox()
        r = box.run("setup.sh", PIP_EXIT="1")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.splitlines()[-1], f"miss manim {VERSION} would not install into .venv")
        self.assertFalse(any(line.startswith("ok   manim") for line in r.stdout.splitlines()))


class InitWorkspace(unittest.TestCase):
    def init(self, render_exit: int, verdict_exit: int):
        box = Sandbox(self)
        ws = box.root / "ws"
        ws.mkdir()
        box.stub("python", f'case "$1" in\n  */render.py) echo "HARNESS_WORKSPACE=$HARNESS_WORKSPACE" >> "$CALLS"; exit {render_exit} ;;\n  *) exit {verdict_exit} ;;\nesac',
                 where=box.install / ".venv" / "bin")
        r = box.run("init-workspace.sh", cwd=ws, HARNESS_DSH_DIR=str(box.install))
        return box, ws, r

    def test_renders_the_template_scene_for_the_pane(self):
        box, ws, r = self.init(0, 0)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((ws / ".harness").is_dir() and (ws / "out").is_dir())
        self.assertEqual(box.logged(), [f"python {box.install}/toolchain/render.py -ql --disable_caching scenes/intro.py Intro",
                                        f"HARNESS_WORKSPACE={ws.resolve()}"])

    def test_a_failed_render_still_seeds_the_verdict_and_init_never_fails(self):
        for verdict_exit in (0, 1):
            with self.subTest(verdict_exit=verdict_exit):
                box, _, r = self.init(1, verdict_exit)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(box.logged()[-1], f"python {box.install}/toolchain/verdict.py")

    def test_needs_the_install_dir(self):
        box = Sandbox(self)
        r = box.run("init-workspace.sh", cwd=box.root)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("HARNESS_DSH_DIR", r.stderr)


if __name__ == "__main__":
    unittest.main()
