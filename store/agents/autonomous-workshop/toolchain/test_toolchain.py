"""python3 -m unittest discover -s toolchain — the wrapper's scripts, against a stand-in for the upstream repository.

A bare git repository in a temp dir plays autonomous-ai/autonomous-workshop: two commits of a small tree with
the folders the sparse patterns keep and the ones they leave behind, and stub `harness/toolchain/*.sh`
scripts that print what they were handed. Each test lays out a throwaway install dir with the real
scripts linked in and a VERSIONS that keeps the real sparse patterns but pins the stand-in. Git runs with
GIT_ALLOW_PROTOCOL=file and no user or system config, so nothing here can reach the network, and the
stand-in is checked byte for byte afterwards: the wrapper only ever reads upstream.

The scripts run on a PATH of their own, as on a new Mac: git and the few coreutils they use, linked in,
and stubs for what runtimes.sh provides — `uv` (on PATH, as the pinned one a setup fetched into
~/.harness/runtime, or nowhere, with no curl to fetch it) and `node` (on PATH, as Harness's own through
current-node, or nowhere). HOME is a temp dir. What runtimes.sh does when it does download uv is
store/tools/test_runtimes.py's business.
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
NAME = "autonomous-workshop"
SCRIPTS = ("fetch-upstream.sh", "setup.sh", "doctor.sh", "init-workspace.sh", "runtimes.sh")
PROJECT_SCRIPTS = ("setup.sh", "doctor.sh", "init-workspace.sh")
# A project script that says which one ran, with what, where; exits with $STUB_EXIT.
STUB = '#!/bin/sh\necho "{name} dsh=$HARNESS_DSH_DIR uv=$(command -v uv) node=$(command -v node) pwd=$(pwd -P)"\nexit "${{STUB_EXIT:-0}}"\n'
# Real commands the scripts use, linked into the sandbox's bin/ — curl is not one, so nothing here can
# download. Never stub one of these names: a stub written over the link would be written through it,
# onto the real command.
LINKED = ("bash", "cat", "cut", "dirname", "du", "git", "mkdir", "mktemp", "mv", "rm", "uname")
# node: `-v` prints NODE_VERSION; `-e SCRIPT MIN` is runtimes.sh's at-least probe, answered in bash.
NODE = r'''case "$1" in
  -v) echo "v$NODE_VERSION" ;;
  -e) IFS=. read -r a b _ <<< "$3.0"; IFS=. read -r x y _ <<< "$NODE_VERSION"
      if [ "$x" -gt "$a" ] || { [ "$x" -eq "$a" ] && [ "$y" -ge "$b" ]; }; then exit 0; fi; exit 1 ;;
esac'''
UV_VERSION = re.search(r"^HARNESS_UV_VERSION=(\S+)$", (TOOLCHAIN / "runtimes.sh").read_text(), re.M).group(1)
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
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "HARNESS_", "WORKSHOP_", "CAD_"))}
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=str(tmp / "gitconfig"), GIT_ALLOW_PROTOCOL="file",
                        GIT_AUTHOR_NAME="Example", GIT_AUTHOR_EMAIL="dev@example.com",
                        GIT_COMMITTER_NAME="Example", GIT_COMMITTER_EMAIL="dev@example.com")
        work = tmp / "work"
        files = {
            "README.md": "Autonomous Workshop\n",
            "pyproject.toml": "[project]\nname = \"workshop\"\n",
            "uv.lock": "version = 1\n",
            "harness/AGENTS.md": "# Workshop\n",
            "harness/template/model.step.py": "\n",
            "src/workshop/make/skills/cad/SKILL.md": "# cad\n",
            "toys/robot/model.step": "ISO-10303-21;\n",
            "docs/guide.md": "guide\n",
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
        self.runtime = self.home / ".harness" / "runtime"
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
        path.write_text(f"#!/bin/bash\n{body}\n")
        path.chmod(0o755)
        return path

    def uv(self) -> Path:
        """uv on PATH."""
        return self.stub("uv", 'echo "uv $UV_VERSION"')

    def fetched_uv(self) -> Path:
        """No uv on PATH; the pinned one a setup fetched into ~/.harness/runtime."""
        return self.stub("uv", 'echo "uv $UV_VERSION"', where=self.runtime / f"uv-{UV_VERSION}")

    def harness_node(self, version: str = "22.23.2") -> Path:
        """No node on PATH; Harness's own, named by ~/.harness/runtime/current-node."""
        node = self.stub("node", f"NODE_VERSION={version}\n{NODE}", where=self.tmp / "harness-node" / "bin")
        self.runtime.mkdir(parents=True, exist_ok=True)
        (self.runtime / "current-node").write_text(f"{node}\n")
        return node

    def run_script(self, name: str, cwd: Path | None = None, path: str | None = None, **env: str):
        full = {k: v for k, v in self.upstream.env.items() if k not in ("PATH", "HOME") and (k in TRACER or not k.startswith("BASH_"))}
        full.update(PATH=path or str(self.bin), HOME=str(self.home), UV_VERSION=UV_VERSION, **env)
        return subprocess.run([str(self.pkg / "toolchain" / name)], cwd=cwd or self.pkg, env=full,
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
        self.assertTrue((up / "src" / "workshop" / "make" / "skills" / "cad" / "SKILL.md").is_file())
        self.assertTrue((up / "pyproject.toml").is_file())  # cone mode keeps the root files uv needs
        self.assertTrue((up / "uv.lock").is_file())
        self.assertTrue(os.access(up / "harness" / "toolchain" / "setup.sh", os.X_OK))
        # The toys and everything else outside harness/ and src/ stay behind; so does the second commit.
        self.assertFalse((up / "toys").exists())
        self.assertFalse((up / "docs").exists())
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

    def test_setup_fetches_then_runs_the_projects_own_setup_in_its_checkout_with_uv_on_path(self):
        uv = self.uv()
        run = self.run_script("setup.sh", cwd=self.tmp)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        lines = run.stdout.splitlines()
        self.assertEqual(len(lines), 4, lines)
        self.assertIn(f"ok   {NAME} @ {self.upstream.first[:12]} fetched", lines[1])
        self.assertTrue(lines[2].startswith("setup "), lines)
        self.assertEqual(lines[3], "     loading cadgen and OpenCascade once (the first load is slow, the rest are not)")
        self.assertEqual(self.real(Path(self.field(lines[2], "dsh"))), self.real(self.pkg / "upstream"))
        self.assertEqual(self.field(lines[2], "uv"), str(uv))
        self.assertTrue(lines[2].endswith(f" pwd={self.real(self.pkg)}"), lines)

    def test_setup_on_a_machine_without_uv_hands_the_project_the_pinned_one(self):
        uv = self.fetched_uv()
        run = self.run_script("setup.sh")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(self.field(run.stdout.splitlines()[-2], "uv"), str(uv))

    def test_setup_loads_the_projects_cad_stack_once_so_the_doctor_does_not_pay_for_it(self):
        self.uv()
        self.fake_fetched(versions_value_for(self.pkg))
        calls = self.tmp / "python.log"
        self.stub("python", f'echo "$*" >> "{calls}"; exit "${{IMPORT_EXIT:-0}}"', where=self.pkg / "upstream" / ".venv" / "bin")
        run = self.run_script("setup.sh")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(calls.read_text(), "-c import cadgen, build123d\n")
        # an import that fails is the doctor's to report, not a failed install
        self.assertEqual(self.run_script("setup.sh", IMPORT_EXIT="1").returncode, 0)

    def test_setup_without_uv_and_no_way_to_fetch_it_is_a_miss_before_the_fetch(self):
        run = self.run_script("setup.sh")
        self.assertEqual(run.returncode, 1)
        self.assertRegex(run.stdout.splitlines()[-1], rf"^miss could not download https://github\.com/astral-sh/uv/releases/download/{re.escape(UV_VERSION)}/")
        self.assertFalse((self.pkg / "upstream").exists())

    def test_setup_fails_with_the_projects_setup(self):
        self.uv()
        run = self.run_script("setup.sh", STUB_EXIT="3")
        self.assertEqual(run.returncode, 3)

    def test_setup_stops_when_the_fetch_fails(self):
        self.uv()
        self.pin("0123456789abcdef0123456789abcdef01234567")
        run = self.run_script("setup.sh")
        self.assertNotEqual(run.returncode, 0)
        self.assertNotIn("setup dsh=", run.stdout)

    def test_setup_says_when_the_project_has_no_setup(self):
        self.uv()
        self.fake_fetched(versions_value_for(self.pkg), scripts=("doctor.sh",))
        run = self.run_script("setup.sh")
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout.splitlines(), [
            f"ok   {NAME} @ {self.upstream.first[:12]} already fetched",
            "miss upstream/harness/toolchain/setup.sh",
        ])

    # doctor.sh

    def test_doctor_before_setup(self):
        run = self.run_script("doctor.sh", cwd=self.tmp)
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout, f"miss {NAME} is not fetched — run toolchain/setup.sh\n")

    def test_doctor_at_the_pin_hands_over_to_the_projects_doctor_with_the_uv_and_node_setup_used(self):
        self.fake_fetched(self.upstream.first)
        uv = self.fetched_uv()
        node = self.harness_node()
        run = self.run_script("doctor.sh", cwd=self.tmp)
        self.assertEqual(run.returncode, 0, run.stderr)
        ok, project = run.stdout.splitlines()
        self.assertEqual(ok, f"ok   {NAME} @ {self.upstream.first[:12]}")
        self.assertTrue(project.startswith("doctor "), project)
        self.assertEqual(self.real(Path(self.field(project, "dsh"))), self.real(self.pkg / "upstream"))
        self.assertEqual((self.field(project, "uv"), self.field(project, "node")), (str(uv), str(node)))
        self.assertTrue(project.endswith(f"pwd={self.real(self.pkg)}"), project)
        self.assertEqual(self.run_script("doctor.sh", STUB_EXIT="4").returncode, 4)

    def test_doctor_on_a_machine_with_neither_leaves_saying_so_to_the_project(self):
        self.fake_fetched(self.upstream.first)
        run = self.run_script("doctor.sh")
        self.assertEqual(run.returncode, 0, run.stderr)
        ok, project = run.stdout.splitlines()  # nothing from runtimes.sh: the project's own lines say it
        self.assertEqual((self.field(project, "uv"), self.field(project, "node")), ("", ""))

    def test_doctor_warns_when_the_copy_is_behind_the_pin(self):
        self.fake_fetched(self.upstream.first)
        self.pin(self.upstream.second)
        run = self.run_script("doctor.sh")
        self.assertEqual(run.returncode, 0)
        lines = run.stdout.splitlines()
        self.assertEqual(lines[0], f"warn {NAME} @ {self.upstream.first[:12]}, VERSIONS pins {self.upstream.second[:12]} — run toolchain/setup.sh")
        self.assertTrue(lines[1].startswith("doctor "), lines)

    def test_doctor_fails_when_the_project_has_no_doctor(self):
        self.fake_fetched(self.upstream.first, scripts=())
        run = self.run_script("doctor.sh")
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(run.stdout, f"ok   {NAME} @ {self.upstream.first[:12]}\n")

    # init-workspace.sh (the pane is the store's CAD Viewer: no viewer.sh here)

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


def versions_value_for(pkg: Path) -> str:
    return re.search(r'^UPSTREAM_COMMIT="([^"]*)"$', (pkg / "VERSIONS").read_text(), re.M).group(1)


if __name__ == "__main__":
    unittest.main()
