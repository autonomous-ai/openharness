"""python3 -m unittest discover -s toolchain — the wrapper's scripts, against a stand-in for the upstream repository.

A bare git repository in a temp dir plays autonomous-ai/autonomous-circuit: two commits of a small tree with
the folders the sparse patterns keep and the ones they leave behind, and stub `harness/toolchain/*.sh`
scripts that print what they were handed. Each test lays out a throwaway install dir with the real
scripts linked in and a VERSIONS that keeps the real sparse patterns but pins the stand-in. Git runs with
GIT_ALLOW_PROTOCOL=file and no user or system config, so nothing here can reach the network, and the
stand-in is checked byte for byte afterwards: the wrapper only ever reads upstream.

The scripts run on a PATH of their own, as on a new Mac: git and the few coreutils they use, linked in,
and stubs for what runtimes.sh provides — `node` (on PATH, as Harness's own through current-node, or
nowhere) and `uv`, whose `uv venv` makes a venv holding a stub python. HOME is a temp dir. What
runtimes.sh does with no uv at all is store/tools/test_runtimes.py's business.
"""
import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

TOOLCHAIN = Path(__file__).resolve().parent
PACKAGE = TOOLCHAIN.parent
NAME = "autonomous-circuit"
SCRIPTS = ("fetch-upstream.sh", "setup.sh", "doctor.sh", "init-workspace.sh", "viewer.sh", "python", "runtimes.sh")
PROJECT_SCRIPTS = ("setup.sh", "doctor.sh", "init-workspace.sh", "viewer.sh")
# A project script that says which one ran, with what, where; exits with $STUB_EXIT.
STUB = ('#!/bin/sh\necho "{name} dsh=$HARNESS_DSH_DIR toolchain=${{CIRCUIT_TOOLCHAIN:-}} python=${{CIRCUIT_PYTHON:-}} '
        'node=$(command -v node) pwd=$(pwd -P)"\nexit "${{STUB_EXIT:-0}}"\n')
# Real commands the scripts use, linked into the sandbox's bin/. Never stub one of these names: a stub
# written over the link would be written through it, onto the real command.
LINKED = ("bash", "cat", "cp", "cut", "dirname", "du", "git", "mkdir", "mv", "rm")
# node: `-v` prints NODE_VERSION; `-e SCRIPT MIN` is runtimes.sh's at-least probe, answered in bash.
NODE = r'''case "$1" in
  -v) echo "v$NODE_VERSION" ;;
  -e) IFS=. read -r a b _ <<< "$3.0"; IFS=. read -r x y _ <<< "$NODE_VERSION"
      if [ "$x" -gt "$a" ] || { [ "$x" -eq "$a" ] && [ "$y" -ge "$b" ]; }; then exit 0; fi; exit 1 ;;
esac'''
# The venv's python: its version (VENV_PY_OK answers runtimes.sh's keep-or-replace probe), numpy's
# version and import (IMPORT_NUMPY); any other run echoes its arguments and the node it would find.
VENV_PYTHON = r'''case "$1" in
  --version) echo "Python 3.12.11" ;;
  -c) case "$2" in *numpy.__version__*) echo "2.3.4" ;; *version_info*) exit "${VENV_PY_OK:-0}" ;; *) exit "${IMPORT_NUMPY:-0}" ;; esac ;;
  *) echo "python $* node=$(command -v node)" ;;
esac'''
# A bash line tracer (BASH_ENV sourcing a DEBUG trap that appends to SHCOV_OUT) rides along when set.
TRACER = ("BASH_ENV", "SHCOV_OUT")


def versions_value(key: str) -> str:
    match = re.search(rf'^{key}="([^"]*)"$', (PACKAGE / "VERSIONS").read_text(), re.M)
    assert match, key
    return match.group(1)


def snapshot(root: Path) -> dict:
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob("*")) if p.is_file()}


class Upstream:
    """The stand-in repository, built once per test class."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        (tmp / "gitconfig").write_text("")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "HARNESS_", "CIRCUIT_"))}
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=str(tmp / "gitconfig"), GIT_ALLOW_PROTOCOL="file",
                        GIT_AUTHOR_NAME="Example", GIT_AUTHOR_EMAIL="dev@example.com",
                        GIT_COMMITTER_NAME="Example", GIT_COMMITTER_EMAIL="dev@example.com")
        work = tmp / "work"
        files = {
            "README.md": "Autonomous Circuit\n",
            "harness/AGENTS.md": "# Circuit\n",
            "harness/template/product.json": "{}\n",
            "skills/pcb/SKILL.md": "# pcb\n",
            "toolchain/README.md": "tools\n",
            "products/big/board.json": "{\"big\": true}\n",
            "examples/demo/board.json": "{\"demo\": true}\n",
        }
        for rel, text in files.items():
            (work / rel).parent.mkdir(parents=True, exist_ok=True)
            (work / rel).write_text(text)
        for name in PROJECT_SCRIPTS:
            path = work / "harness" / "toolchain" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(STUB.format(name=name[:-3]))
            path.chmod(0o755)
        self.git("init", "-q", "-b", "main", str(work))
        self.git("-C", str(work), "add", "-A")
        self.git("-C", str(work), "commit", "-q", "-m", "first")
        self.first = self.git("-C", str(work), "rev-parse", "HEAD").strip()
        (work / "harness" / "NEW.md").write_text("second\n")
        self.git("-C", str(work), "add", "-A")
        self.git("-C", str(work), "commit", "-q", "-m", "second")
        self.second = self.git("-C", str(work), "rev-parse", "HEAD").strip()
        self.bare = tmp / f"{NAME}.git"
        self.git("clone", "-q", "--bare", str(work), str(self.bare))
        # What GitHub allows: partial clones, and fetching a commit by its id.
        self.git("-C", str(self.bare), "config", "uploadpack.allowFilter", "true")
        self.git("-C", str(self.bare), "config", "uploadpack.allowAnySHA1InWant", "true")
        self.url = self.bare.as_uri()

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], env=self.env, check=True, capture_output=True, text=True).stdout


class Wrapper(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.class_tmp = Path(tempfile.mkdtemp())
        cls.upstream = Upstream(cls.class_tmp)
        cls.pristine = snapshot(cls.upstream.bare)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.class_tmp)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.pkg = self.tmp / NAME
        (self.pkg / "toolchain").mkdir(parents=True)
        for name in SCRIPTS:
            # linked, not copied: a line tracer maps back to the source
            (self.pkg / "toolchain" / name).symlink_to(TOOLCHAIN / name)
        self.pin(self.upstream.first)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.calls = self.tmp / "calls.log"
        self.calls.touch()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for tool in LINKED:
            (self.bin / tool).symlink_to(shutil.which(tool))

    def tearDown(self):
        self.assertEqual(snapshot(self.upstream.bare), self.pristine, "the upstream repository was written to")

    def pin(self, commit: str):
        text = (PACKAGE / "VERSIONS").read_text()
        text = re.sub(r'^UPSTREAM_REPO=.*$', f'UPSTREAM_REPO="{self.upstream.url}"', text, flags=re.M)
        text = re.sub(r'^UPSTREAM_COMMIT=.*$', f'UPSTREAM_COMMIT="{commit}"', text, flags=re.M)
        (self.pkg / "VERSIONS").write_text(text)

    # the sandbox's commands

    def stub(self, name: str, body: str = "", where: Path | None = None) -> Path:
        assert where is not None or name not in LINKED, name
        path = (where or self.bin) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)  # never write through a link to a real command
        path.write_text(f'#!/bin/bash\necho "{name} $*" >> "$CALLS"\n{body}\n')
        path.chmod(0o755)
        return path

    def node(self, version: str = "22.23.2") -> Path:
        """node on PATH."""
        return self.stub("node", f'NODE_VERSION={version}\n{NODE}')

    def harness_node(self, version: str = "22.23.2") -> Path:
        """No node on PATH; Harness's own, named by ~/.harness/runtime/current-node."""
        node = self.stub("node", f'NODE_VERSION={version}\n{NODE}', where=self.tmp / "harness-node" / "bin")
        runtime = self.home / ".harness" / "runtime"
        runtime.mkdir(parents=True)
        (runtime / "current-node").write_text(f"{node}\n")
        return node

    def uv(self) -> Path:
        """uv on PATH: `uv venv … DIR` makes a venv of a stub python (UV_VENV_EXIT fails it); `uv pip` exits PIP_EXIT."""
        python = self.stub("python", VENV_PYTHON, where=self.tmp / "templates")
        return self.stub("uv", f'''case "$1" in
  venv) [ "${{UV_VENV_EXIT:-0}}" = 0 ] || exit "$UV_VENV_EXIT"; for last in "$@"; do :; done; mkdir -p "$last/bin" && cp "{python}" "$last/bin/python" ;;
  pip) exit "${{PIP_EXIT:-0}}" ;;
esac''')

    def venv(self) -> Path:
        """The .venv setup leaves."""
        return self.stub("python", VENV_PYTHON, where=self.pkg / ".venv" / "bin")

    def logged(self) -> list:
        return self.calls.read_text().splitlines()

    def run_script(self, name: str, cwd: Path | None = None, path: str | None = None, args=(), **env: str):
        full = {k: v for k, v in self.upstream.env.items() if k not in ("PATH", "HOME") and (k in TRACER or not k.startswith("BASH_"))}
        full.update(PATH=path or str(self.bin), HOME=str(self.home), CALLS=str(self.calls), **env)
        return subprocess.run([str(self.pkg / "toolchain" / name), *args], cwd=cwd or self.pkg, env=full,
                              capture_output=True, text=True, timeout=120)

    def fake_fetched(self, commit: str, scripts=PROJECT_SCRIPTS):
        """An upstream/ as a fetch leaves it, without git: the commit file and the project's scripts."""
        (self.pkg / "upstream" / "harness" / "toolchain").mkdir(parents=True)
        (self.pkg / "upstream" / ".harness-commit").write_text(commit + "\n")
        for name in scripts:
            path = self.pkg / "upstream" / "harness" / "toolchain" / name
            path.write_text(STUB.format(name=name[:-3]))
            path.chmod(0o755)

    def committed(self) -> str:
        return (self.pkg / "upstream" / ".harness-commit").read_text().strip()

    def real(self, path: Path) -> str:
        return os.path.realpath(path)

    def field(self, line: str, key: str) -> str:
        return re.search(rf"{key}=(\S*)", line).group(1)

    # VERSIONS

    def test_versions_pins_a_full_commit_of_the_projects_public_repository(self):
        self.assertEqual(versions_value("UPSTREAM_NAME"), NAME)
        self.assertEqual(versions_value("UPSTREAM_REPO"), f"https://github.com/autonomous-ai/{NAME}.git")
        self.assertRegex(versions_value("UPSTREAM_COMMIT"), r"^[0-9a-f]{40}$")

    def test_the_agent_runs_the_pipeline_on_the_wrappers_python(self):
        import json
        env = json.loads((PACKAGE / "harness.json").read_text())["agent"]["env"]
        self.assertEqual(env["CIRCUIT_PYTHON"], "${dsh}/toolchain/python")
        self.assertIn(".venv/", (PACKAGE / ".gitignore").read_text().splitlines())

    # fetch-upstream.sh

    def test_fetch_checks_out_the_pinned_commit_sparse_shallow_and_blobless(self):
        run = self.run_script("fetch-upstream.sh")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        first = self.upstream.first
        lines = run.stdout.splitlines()
        self.assertEqual(lines[0], f"     fetching {self.upstream.url} @ {first[:12]} "
                                   f"({versions_value('UPSTREAM_SPARSE_MODE')} sparse: {versions_value('UPSTREAM_SPARSE')})")
        self.assertRegex(lines[1], rf"^ok   {NAME} @ {first[:12]} fetched \(\S+\)$")
        self.assertEqual(len(lines), 2)
        up = self.pkg / "upstream"
        self.assertEqual(self.committed(), first)
        self.assertEqual(self.upstream.git("-C", str(up), "rev-parse", "HEAD").strip(), first)
        self.assertTrue((up / "harness" / "AGENTS.md").is_file())
        self.assertTrue((up / "skills" / "pcb" / "SKILL.md").is_file())
        self.assertTrue(os.access(up / "harness" / "toolchain" / "setup.sh", os.X_OK))
        # The product library and the examples stay behind; so does the second commit.
        self.assertFalse((up / "products").exists())
        self.assertFalse((up / "examples").exists())
        self.assertFalse((up / "harness" / "NEW.md").exists())
        self.assertTrue((up / ".git" / "shallow").is_file())
        self.assertEqual(self.upstream.git("-C", str(up), "config", "remote.origin.partialclonefilter").strip(), "blob:none")
        self.assertFalse((self.pkg / "upstream.partial").exists())

    def test_fetch_is_a_no_op_when_the_pin_is_already_there(self):
        self.assertEqual(self.run_script("fetch-upstream.sh").returncode, 0)
        (self.pkg / "upstream" / "kept").write_text("")
        run = self.run_script("fetch-upstream.sh")
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stdout, f"ok   {NAME} @ {self.upstream.first[:12]} already fetched\n")
        self.assertTrue((self.pkg / "upstream" / "kept").exists())

    def test_a_new_pin_replaces_the_copy(self):
        self.assertEqual(self.run_script("fetch-upstream.sh").returncode, 0)
        (self.pkg / "upstream" / "stale").write_text("")
        self.pin(self.upstream.second)
        run = self.run_script("fetch-upstream.sh")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn(f"ok   {NAME} @ {self.upstream.second[:12]} fetched", run.stdout)
        self.assertEqual(self.committed(), self.upstream.second)
        self.assertTrue((self.pkg / "upstream" / "harness" / "NEW.md").is_file())
        self.assertFalse((self.pkg / "upstream" / "stale").exists())

    def test_a_failed_fetch_keeps_the_copy_that_works(self):
        self.assertEqual(self.run_script("fetch-upstream.sh").returncode, 0)
        self.pin("0123456789abcdef0123456789abcdef01234567")  # not in the repository: a bad bump, or offline
        run = self.run_script("fetch-upstream.sh")
        self.assertNotEqual(run.returncode, 0)
        self.assertNotIn("ok   ", run.stdout)
        self.assertEqual(self.committed(), self.upstream.first)
        self.assertTrue((self.pkg / "upstream" / "harness" / "toolchain" / "doctor.sh").is_file())
        # and the next attempt starts clean
        self.pin(self.upstream.second)
        self.assertEqual(self.run_script("fetch-upstream.sh").returncode, 0)
        self.assertEqual(self.committed(), self.upstream.second)
        self.assertFalse((self.pkg / "upstream.partial").exists())

    def test_fetch_without_git_says_so(self):
        bin_ = self.tmp / "bin-no-git"
        bin_.mkdir()
        for tool in ("bash", "cat"):
            (bin_ / tool).symlink_to(shutil.which(tool))
        run = self.run_script("fetch-upstream.sh", path=str(bin_))
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout, "miss git on PATH\n")
        self.assertFalse((self.pkg / "upstream").exists())

    # setup.sh

    def test_setup_provides_node_and_python_then_runs_the_projects_own_setup_in_its_checkout(self):
        node = self.node()
        self.uv()
        run = self.run_script("setup.sh", cwd=self.tmp)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        lines = run.stdout.splitlines()
        self.assertEqual(lines[:3], [
            "     python 3.12 in .venv (uv downloads it when this machine has none)",
            "ok   Python 3.12.11 in .venv",
            "ok   numpy 2.3.4 (the board pipeline's gates)",
        ])
        self.assertIn(f"ok   {NAME} @ {self.upstream.first[:12]} fetched", lines[4])
        self.assertEqual(len(lines), 6, lines)
        self.assertTrue(lines[5].startswith("setup "), lines)
        self.assertEqual(self.real(Path(self.field(lines[5], "dsh"))), self.real(self.pkg / "upstream"))
        self.assertEqual(self.field(lines[5], "node"), str(node))
        self.assertTrue(lines[5].endswith(f" pwd={self.real(self.pkg)}"), lines)
        log = self.logged()
        self.assertIn("uv venv --quiet --seed --python 3.12 --python-preference only-managed .venv", log)
        self.assertIn("uv pip install --quiet --python .venv/bin/python numpy", log)

    def test_setup_on_a_machine_without_node_hands_the_project_harnesss_own(self):
        node = self.harness_node()
        self.uv()
        run = self.run_script("setup.sh")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(self.field(run.stdout.splitlines()[-1], "node"), str(node))

    def test_setup_without_a_new_enough_node_is_a_miss_before_anything_else(self):
        self.uv()
        run = self.run_script("setup.sh")
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout, f"miss node >= 22.12, and Harness's own Node is not in {self.home}/.harness/runtime"
                                     " — run `harness start` once to lay it down\n")
        self.harness_node("22.11.0")
        run = self.run_script("setup.sh")
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout, "miss node >= 22.12 — this machine's newest is v22.11.0, Harness's own; update Harness\n")
        self.assertEqual([line for line in self.logged() if line.startswith("uv ")], [])
        self.assertFalse((self.pkg / "upstream").exists())

    def test_setup_stops_when_no_python_can_be_made(self):
        self.node()
        self.uv()
        run = self.run_script("setup.sh", UV_VENV_EXIT="1")
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout.splitlines()[-1], "miss could not make a Python 3.12 environment in .venv")
        self.assertFalse((self.pkg / "upstream").exists())

    def test_setup_stops_when_numpy_does_not_install(self):
        self.node()
        self.uv()
        run = self.run_script("setup.sh", PIP_EXIT="2")
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout.splitlines()[-1], "miss could not install numpy into .venv")
        self.assertNotIn("ok   numpy", run.stdout)
        self.assertFalse((self.pkg / "upstream").exists())

    def test_setup_fails_with_the_projects_setup(self):
        self.node()
        self.uv()
        run = self.run_script("setup.sh", STUB_EXIT="3")
        self.assertEqual(run.returncode, 3)

    def test_setup_stops_when_the_fetch_fails(self):
        self.node()
        self.uv()
        self.pin("0123456789abcdef0123456789abcdef01234567")
        run = self.run_script("setup.sh")
        self.assertNotEqual(run.returncode, 0)
        self.assertNotIn("setup dsh=", run.stdout)

    def test_setup_says_when_the_project_has_no_setup(self):
        self.node()
        self.uv()
        self.venv()
        self.fake_fetched(versions_value_for(self.pkg), scripts=("doctor.sh",))
        run = self.run_script("setup.sh")
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout.splitlines(), [
            "ok   Python 3.12.11 in .venv",
            "ok   numpy 2.3.4 (the board pipeline's gates)",
            f"ok   {NAME} @ {self.upstream.first[:12]} already fetched",
            "miss upstream/harness/toolchain/setup.sh",
        ])

    # doctor.sh

    def test_doctor_before_setup(self):
        run = self.run_script("doctor.sh", cwd=self.tmp)
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout, f"miss {NAME} is not fetched — run toolchain/setup.sh\n")

    def test_doctor_at_the_pin_hands_over_to_the_projects_doctor_with_node_and_the_pipelines_python(self):
        self.fake_fetched(self.upstream.first)
        self.venv()
        node = self.harness_node()
        run = self.run_script("doctor.sh", cwd=self.tmp)
        self.assertEqual(run.returncode, 0, run.stderr)
        ok, project = run.stdout.splitlines()
        self.assertEqual(ok, f"ok   {NAME} @ {self.upstream.first[:12]}")
        self.assertTrue(project.startswith("doctor "), project)
        self.assertEqual(self.real(Path(self.field(project, "dsh"))), self.real(self.pkg / "upstream"))
        self.assertEqual(self.real(Path(self.field(project, "toolchain"))), self.real(self.pkg / "upstream" / "toolchain"))
        self.assertEqual(self.field(project, "python"), str(self.pkg / "toolchain" / "python"))
        self.assertEqual(self.field(project, "node"), str(node))
        self.assertTrue(project.endswith(f"pwd={self.real(self.pkg)}"), project)
        self.assertEqual(self.run_script("doctor.sh", STUB_EXIT="4").returncode, 4)

    def test_doctor_keeps_a_toolchain_and_a_python_the_environment_names(self):
        self.fake_fetched(self.upstream.first)
        self.venv()
        run = self.run_script("doctor.sh", CIRCUIT_TOOLCHAIN="/Users/example/circuit/toolchain",
                              CIRCUIT_PYTHON="/Users/example/python3.12")
        self.assertIn("toolchain=/Users/example/circuit/toolchain python=/Users/example/python3.12 node= ", run.stdout)

    def test_doctor_without_the_pipelines_python_is_a_miss_and_still_asks_the_project(self):
        self.fake_fetched(self.upstream.first)
        run = self.run_script("doctor.sh")
        self.assertEqual(run.returncode, 1)
        lines = run.stdout.splitlines()
        self.assertEqual(lines[1], "miss .venv with numpy (the board pipeline's Python) — run toolchain/setup.sh")
        self.assertTrue(lines[2].startswith("doctor "), lines)
        self.venv()
        self.assertEqual(self.run_script("doctor.sh", IMPORT_NUMPY="1").returncode, 1)
        # the project's own failure wins: its code is the one Harness reports
        self.assertEqual(self.run_script("doctor.sh", IMPORT_NUMPY="1", STUB_EXIT="4").returncode, 4)

    def test_doctor_warns_when_the_copy_is_behind_the_pin(self):
        self.fake_fetched(self.upstream.first)
        self.venv()
        self.pin(self.upstream.second)
        run = self.run_script("doctor.sh")
        self.assertEqual(run.returncode, 0)
        lines = run.stdout.splitlines()
        self.assertEqual(lines[0], f"warn {NAME} @ {self.upstream.first[:12]}, VERSIONS pins {self.upstream.second[:12]} — run toolchain/setup.sh")
        self.assertTrue(lines[1].startswith("doctor "), lines)

    def test_doctor_fails_when_the_project_has_no_doctor(self):
        self.fake_fetched(self.upstream.first, scripts=())
        self.venv()
        run = self.run_script("doctor.sh")
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(run.stdout, f"ok   {NAME} @ {self.upstream.first[:12]}\n")

    # init-workspace.sh, viewer.sh

    def test_init_runs_the_projects_own_in_the_workspace(self):
        self.fake_fetched(self.upstream.first)
        ws = self.tmp / "workspace"
        ws.mkdir()
        run = self.run_script("init-workspace.sh", cwd=ws)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(run.stdout.startswith("init-workspace "), run.stdout)
        self.assertEqual(self.real(Path(self.field(run.stdout, "dsh"))), self.real(self.pkg / "upstream"))
        self.assertTrue(run.stdout.rstrip().endswith(f"pwd={self.real(ws)}"), run.stdout)
        self.assertEqual(self.run_script("init-workspace.sh", cwd=ws, STUB_EXIT="5").returncode, 5)

    def test_viewer_runs_the_projects_own_in_the_workspace_on_harnesss_node(self):
        self.fake_fetched(self.upstream.first)
        node = self.harness_node()
        ws = self.tmp / "workspace"
        ws.mkdir()
        run = self.run_script("viewer.sh", cwd=ws)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(run.stdout.startswith("viewer "), run.stdout)
        self.assertEqual(self.real(Path(self.field(run.stdout, "dsh"))), self.real(self.pkg / "upstream"))
        self.assertEqual(self.field(run.stdout, "node"), str(node))
        self.assertEqual(self.field(run.stdout, "python"), str(self.pkg / "toolchain" / "python"))
        self.assertTrue(run.stdout.rstrip().endswith(f"pwd={self.real(ws)}"), run.stdout)
        self.assertEqual(self.run_script("viewer.sh", cwd=ws, STUB_EXIT="5").returncode, 5)
        run = self.run_script("viewer.sh", cwd=ws, CIRCUIT_PYTHON="/Users/example/python3.12")
        self.assertEqual(self.field(run.stdout, "python"), "/Users/example/python3.12")

    def test_viewer_without_any_node_is_a_miss(self):
        self.fake_fetched(self.upstream.first)
        run = self.run_script("viewer.sh", cwd=self.tmp)
        self.assertEqual(run.returncode, 1)
        self.assertRegex(run.stdout, r"^miss node >= 22\.12, and Harness's own Node is not in ")
        self.assertNotIn("viewer ", run.stdout)

    # python (CIRCUIT_PYTHON)

    def test_python_is_the_venv_with_node_on_path(self):
        self.venv()
        node = self.harness_node()
        run = self.run_script("python", cwd=self.tmp, args=("scripts/circuit", "boards/main.tsx"))
        self.assertEqual((run.returncode, run.stderr), (0, ""))
        self.assertEqual(run.stdout, f"python scripts/circuit boards/main.tsx node={node}\n")
        version = self.run_script("python", args=("-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"))
        self.assertEqual(version.returncode, 0)

    def test_python_without_node_still_runs_and_says_why_on_stderr(self):
        self.venv()
        run = self.run_script("python", args=("-m", "circuit"))
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stdout, "python -m circuit node=\n")  # stdout stays the tool's own
        self.assertRegex(run.stderr, r"^miss node >= 22\.12")


def versions_value_for(pkg: Path) -> str:
    return re.search(r'^UPSTREAM_COMMIT="([^"]*)"$', (pkg / "VERSIONS").read_text(), re.M).group(1)


if __name__ == "__main__":
    unittest.main()
