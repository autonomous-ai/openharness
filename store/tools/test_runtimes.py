"""runtimes.sh, sourced for real by bash against a sandbox whose PATH holds only stubs and the few
real commands it uses — no network, no uv, no Python download:

    python3 -m unittest store/tools/test_runtimes.py

Downloads are a `curl` stub that copies a fixture; checksums a `shasum`/`sha256sum` stub that answers
the pinned sum (or a wrong one), so the real archive handling runs on a small tarball.
"""
import os, subprocess, tarfile, tempfile, unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parent / "runtimes.sh"
TRACER = {k: os.environ[k] for k in ("BASH_ENV", "SHCOV_OUT") if k in os.environ}
REAL = ("cat", "cut", "mkdir", "rm", "mv", "chmod", "mktemp", "tar", "gzip")
UV = {
    ("Darwin", "arm64"): ("uv-aarch64-apple-darwin", "dc304b9ed1b24174572290fba60ac3f6fe63c73a671f0439e62a91375841964d"),
    ("Darwin", "x86_64"): ("uv-x86_64-apple-darwin", "e9ca61775532368fe518ab03e7a354c7ecab8ccb3c7d941c775fcc4a362b801b"),
    ("Linux", "x86_64"): ("uv-x86_64-unknown-linux-gnu", "f97935763c04be3e692460a7aaeaaab8fc3b78fcf8b389da820b38ae7423a638"),
    ("Linux", "aarch64"): ("uv-aarch64-unknown-linux-gnu", "0e9a3499b0587d449c9ff684c0160da607826e4af1cee220bc87f378702d3e08"),
}
MAMBA = {
    ("Darwin", "arm64"): ("micromamba-osx-arm64", "ec2a072f028e1a7cf20f3e2e74d5a8127cf5a5f27636375b5359811565f4e5be"),
    ("Darwin", "x86_64"): ("micromamba-osx-64", "1e71054bb3ac9a076e21f7ec48acfef536f9b3f1408f371a942784bf5ef83d8a"),
    ("Linux", "x86_64"): ("micromamba-linux-64", "366cd9cd8be14df1ab8ed50352a82111082a36686b2d389fdb79a92c3fafb3e3"),
    ("Linux", "aarch64"): ("micromamba-linux-aarch64", "9f93b974adcb4d166996af969b6cd371287d1a3e52733704727884d9b74cb7a7"),
}
UV_VERSION = "0.12.15"
MAMBA_VERSION = "2.9.0-0"

# node: `-v` prints NODE_VERSION; `-e SCRIPT MIN` is the at-least probe, answered in bash.
NODE = r'''case "$1" in
  -v) echo "v$NODE_VERSION" ;;
  -e) IFS=. read -r a b _ <<< "$3.0"; IFS=. read -r x y _ <<< "$NODE_VERSION"
      if [ "$x" -gt "$a" ] || { [ "$x" -eq "$a" ] && [ "$y" -ge "$b" ]; }; then exit 0; fi; exit 1 ;;
esac'''


class Box:
    def __init__(self, test: unittest.TestCase, real=REAL):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.home = self.root / "home"
        self.home.mkdir()
        self.runtime = self.home / ".harness" / "runtime"
        self.calls = self.root / "calls.log"
        self.calls.touch()
        self.fixtures = self.root / "fixtures"
        self.fixtures.mkdir()
        for name in real:
            found = next(p for p in (Path("/bin") / name, Path("/usr/bin") / name) if p.exists())
            (self.bin / name).symlink_to(found)
        self.platform("Darwin", "arm64")

    def stub(self, name: str, body: str = "", where: Path | None = None) -> Path:
        path = (where or self.bin) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)  # never write through a link to a real command
        path.write_text(f'#!/bin/bash\necho "{name} $*" >> "$CALLS"\n{body}\n')
        path.chmod(0o755)
        return path

    def platform(self, system: str, machine: str):
        self.stub("uname", f'case "$1" in -s) echo {system} ;; -m) echo {machine} ;; esac')

    def serve(self, body: bytes, name: str = "download"):
        """curl hands back this file for any URL (a `-o DEST URL` call)."""
        fixture = self.fixtures / name
        fixture.write_bytes(body)
        self.stub("curl", f'for a in "$@"; do if [ "$prev" = -o ]; then out="$a"; fi; prev="$a"; done; cp "{fixture}" "$out"')
        (self.bin / "cp").unlink(missing_ok=True)
        (self.bin / "cp").symlink_to("/bin/cp")

    def checksum(self, value: str, tool: str = "shasum"):
        self.stub(tool, f'for last in "$@"; do :; done; echo "{value}  $last"')

    def uv_tarball(self, asset: str, with_uv: bool = True) -> bytes:
        src = self.fixtures / "tar-src" / asset
        src.mkdir(parents=True)
        if with_uv:
            (src / "uv").write_text('#!/bin/bash\necho "uv $*" >> "$CALLS"\n')
        (src / "uvx").write_text("#!/bin/bash\n")
        archive = self.fixtures / f"{asset}.tar.gz"
        with tarfile.open(archive, "w:gz") as t:
            t.add(src, arcname=asset)
        return archive.read_bytes()

    def run(self, snippet: str, home: bool = True, **env: str) -> subprocess.CompletedProcess:
        base = {"PATH": str(self.bin), "CALLS": str(self.calls), **TRACER}
        if home:
            base["HOME"] = str(self.home)
        script = f'set -euo pipefail\n. "{HELPER}"\n{snippet}\n'
        return subprocess.run(["/bin/bash", "-c", script], cwd=self.root, env={**base, **env},
                              capture_output=True, text=True, timeout=60)

    def logged(self) -> list[str]:
        return self.calls.read_text().splitlines()


def lines(r: subprocess.CompletedProcess) -> list[str]:
    return r.stdout.splitlines()


class Platform(unittest.TestCase):
    def test_each_machine_and_the_rest(self):
        box = Box(self)
        for (system, machine), want in [(("Darwin", "arm64"), "darwin-arm64"), (("Darwin", "x86_64"), "darwin-x64"),
                                         (("Linux", "x86_64"), "linux-x64"), (("Linux", "aarch64"), "linux-arm64"),
                                         (("Linux", "arm64"), "linux-arm64")]:
            with self.subTest(system=system, machine=machine):
                box.platform(system, machine)
                r = box.run("_harness_platform")
                self.assertEqual((r.returncode, r.stdout.strip()), (0, want), r.stderr)
        box.platform("FreeBSD", "amd64")
        r = box.run('_harness_platform || echo "rc=$?"')
        self.assertEqual(r.stdout.strip(), "rc=1")


class Checksum(unittest.TestCase):
    def test_shasum_first_then_sha256sum(self):
        box = Box(self)
        (box.root / "f").write_text("x")
        box.checksum("aaa")
        self.assertEqual(box.run('_harness_sha256 f').stdout.strip(), "aaa")
        (box.bin / "shasum").unlink()
        box.checksum("bbb", tool="sha256sum")
        self.assertEqual(box.run('_harness_sha256 f').stdout.strip(), "bbb")
        self.assertIn("sha256sum f", box.logged())


class Fetch(unittest.TestCase):
    def test_a_download_that_fails_leaves_nothing(self):
        box = Box(self)
        box.stub("curl", 'for a in "$@"; do if [ "$prev" = -o ]; then echo partial > "$a"; fi; prev="$a"; done; exit 22')
        r = box.run('_harness_fetch https://example.com/x "$PWD/x" abc || echo "rc=$?"')
        self.assertEqual(lines(r), ["miss could not download https://example.com/x — check this machine's internet connection", "rc=1"])
        self.assertEqual(sorted(p.name for p in box.root.iterdir() if p.name.startswith("x")), [])

    def test_a_checksum_that_differs_leaves_nothing(self):
        box = Box(self)
        box.serve(b"payload")
        box.checksum("not-the-pin")
        r = box.run('_harness_fetch https://example.com/x "$PWD/x" abc || echo "rc=$?"')
        self.assertEqual(lines(r), ["miss https://example.com/x did not match its pinned checksum; nothing was installed", "rc=1"])
        self.assertFalse(any(p.name.startswith("x") for p in box.root.iterdir()))

    def test_a_matching_download_lands(self):
        box = Box(self)
        box.serve(b"payload")
        box.checksum("abc")
        r = box.run('_harness_fetch https://example.com/x "$PWD/x" abc')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((box.root / "x").read_bytes(), b"payload")
        self.assertIn("curl -fsSL --retry 3 --connect-timeout 20 --max-time 900 -o", box.logged()[0])


class Node(unittest.TestCase):
    def runtime_node(self, box: Box, version: str) -> Path:
        node = box.stub("node", NODE.replace("$NODE_VERSION", version), where=box.root / "harness-node" / "bin")
        box.runtime.mkdir(parents=True, exist_ok=True)
        (box.runtime / "current-node").write_text(f"{node}\n")
        return node

    def test_the_machines_own_node_when_new_enough(self):
        box = Box(self)
        box.stub("node", NODE)
        box.stub("npm")
        self.runtime_node(box, "22.23.2")
        r = box.run('harness_node 18 && command -v node', NODE_VERSION="20.1.0")
        self.assertEqual((r.returncode, r.stdout.strip()), (0, str(box.bin / "node")), r.stderr)

    def test_a_node_without_npm_borrows_harness_node_and_its_npm(self):
        box = Box(self)
        box.stub("node", NODE)
        node = self.runtime_node(box, "22.23.2")
        box.stub("npm", where=node.parent)
        r = box.run('harness_node 18 && command -v node && command -v npm', NODE_VERSION="20.1.0")
        self.assertEqual(lines(r), [str(node), str(node.parent / "npm")], r.stderr)

    def test_asking_twice_adds_harness_node_to_path_once(self):
        box = Box(self)
        self.runtime_node(box, "22.23.2")  # no npm beside it, as in a sandbox
        r = box.run('harness_node 18 && harness_node 18 && harness_node 20 && echo "$PATH"')
        self.assertEqual(lines(r), [f"{box.root}/harness-node/bin:{box.bin}"], r.stderr)

    def test_a_node_without_npm_is_kept_when_harness_node_is_older(self):
        box = Box(self)
        box.stub("node", NODE)
        self.runtime_node(box, "18.0.0")
        r = box.run('harness_node 20 && command -v node && echo "$PATH"', NODE_VERSION="22.1.0")
        self.assertEqual(lines(r), [str(box.bin / "node"), str(box.bin)], r.stderr)

    def test_a_node_without_npm_and_no_harness_node_still_serves(self):
        box = Box(self)
        box.stub("node", NODE)
        r = box.run('harness_node 18 && command -v node', NODE_VERSION="20.1.0")
        self.assertEqual((r.returncode, r.stdout.strip()), (0, str(box.bin / "node")), r.stderr)

    def test_minor_versions_count(self):
        box = Box(self)
        box.stub("node", NODE)
        self.assertEqual(box.run('harness_node 22.12', NODE_VERSION="22.12.0").returncode, 0)
        self.assertEqual(box.run('harness_node || echo "rc=$?"', NODE_VERSION="17.9.0").stdout.splitlines()[-1], "rc=1")

    def test_harness_node_when_the_machine_has_none(self):
        box = Box(self)
        node = self.runtime_node(box, "22.23.2")
        r = box.run('harness_node 18 && command -v node && echo "$PATH"')
        self.assertEqual(lines(r), [str(node), f"{node.parent}:{box.bin}"], r.stderr)

    def test_harness_node_when_the_machines_is_too_old(self):
        box = Box(self)
        box.stub("node", NODE)
        node = self.runtime_node(box, "22.23.2")
        r = box.run('harness_node 22.12 && command -v node', NODE_VERSION="20.0.0")
        self.assertEqual((r.returncode, r.stdout.strip()), (0, str(node)), r.stderr)

    def test_harness_node_too_old_as_well(self):
        box = Box(self)
        self.runtime_node(box, "22.23.2")
        r = box.run('harness_node 24 || echo "rc=$?"')
        self.assertEqual(lines(r), ["miss node >= 24 — this machine's newest is v22.23.2, Harness's own; update Harness", "rc=1"])

    def test_no_node_anywhere(self):
        box = Box(self)
        r = box.run('harness_node 18 || echo "rc=$?"')
        self.assertEqual(lines(r), [f"miss node >= 18, and Harness's own Node is not in {box.runtime} — run `harness start` once to lay it down", "rc=1"])

    def test_a_current_node_naming_nothing_is_no_node(self):
        box = Box(self)
        box.runtime.mkdir(parents=True)
        (box.runtime / "current-node").write_text(str(box.root / "gone" / "node"))
        r = box.run('harness_node 18 || echo "rc=$?"', ADAPTER_RUNTIME_DIR=str(box.runtime))
        self.assertEqual(lines(r)[-1], "rc=1")
        self.assertIn("Harness's own Node is not in", r.stdout)

    @unittest.skipUnless(Path.home().joinpath(".harness/runtime/current-node").exists(), "no real Harness node to run the probe on")
    def test_the_probe_itself_on_a_real_node(self):
        real = Path(Path.home().joinpath(".harness/runtime/current-node").read_text().strip())
        box = Box(self)
        (box.bin / "node").symlink_to(real)
        major = int(subprocess.run([str(real), "-p", "process.versions.node.split('.')[0]"], capture_output=True, text=True).stdout)
        self.assertEqual(box.run(f"_harness_node_at_least {major}").returncode, 0)
        self.assertEqual(box.run(f"_harness_node_at_least {major}.0").returncode, 0)
        self.assertEqual(box.run(f'_harness_node_at_least {major + 1} || echo "rc=$?"').stdout.strip(), "rc=1")
        self.assertEqual(box.run(f'_harness_node_at_least {major}.999 || echo "rc=$?"').stdout.strip(), "rc=1")
        self.assertEqual(box.run(f"_harness_node_at_least {major - 1}.999").returncode, 0)


class PythonInstallDir(unittest.TestCase):
    def test_uv_pythons_live_in_the_harness_runtime(self):
        box = Box(self)
        (box.bin / "sh").symlink_to("/bin/sh")
        self.assertEqual(box.run('echo "$UV_PYTHON_INSTALL_DIR"; sh -c \'echo "$UV_PYTHON_INSTALL_DIR"\'').stdout.splitlines(),
                         [f"{box.runtime}/python"] * 2, "exported, so uv and upstream setups see it")

    def test_a_dir_the_person_chose_is_kept(self):
        box = Box(self)
        self.assertEqual(box.run('echo "$UV_PYTHON_INSTALL_DIR"', UV_PYTHON_INSTALL_DIR="/opt/pythons").stdout.strip(), "/opt/pythons")


class Uv(unittest.TestCase):
    def test_uv_on_path_is_used_as_it_is(self):
        box = Box(self)
        box.stub("uv")
        r = box.run('harness_uv && echo "$PATH"')
        self.assertEqual((r.returncode, r.stdout.strip()), (0, str(box.bin)))

    def test_the_installers_places_are_looked_in(self):
        for where in (".local/bin", ".cargo/bin"):
            with self.subTest(where=where):
                box = Box(self)
                uv = box.stub("uv", where=box.home / where)
                r = box.run('harness_uv && command -v uv')
                self.assertEqual((r.returncode, r.stdout.strip()), (0, str(uv)))

    def test_without_home_the_runtime_copy_is_used(self):
        box = Box(self)
        uv = box.stub("uv", where=box.root / "rt" / f"uv-{UV_VERSION}")
        r = box.run('harness_uv && command -v uv', home=False, ADAPTER_RUNTIME_DIR=str(box.root / "rt"))
        self.assertEqual((r.returncode, r.stdout.strip()), (0, str(uv)), r.stderr)
        self.assertNotIn("curl", " ".join(box.logged()))

    def test_fetches_the_pinned_release_for_each_machine(self):
        for (system, machine), (asset, pin) in UV.items():
            with self.subTest(asset=asset):
                box = Box(self)
                box.platform(system, machine)
                box.serve(box.uv_tarball(asset))
                box.checksum(pin)
                r = box.run('harness_uv && command -v uv && uv --version')
                dest = box.runtime / f"uv-{UV_VERSION}"
                self.assertEqual(lines(r), [f"     fetching uv {UV_VERSION} into {box.runtime} (it brings Python and the packages)",
                                            str(dest / "uv")], r.stderr)
                self.assertIn(f"https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{asset}.tar.gz", box.logged()[-3])
                self.assertEqual(sorted(p.name for p in box.runtime.iterdir()), [f"uv-{UV_VERSION}"], "the temp dir is gone")
                self.assertTrue(os.access(dest / "uvx", os.X_OK))

    def test_no_release_for_this_machine(self):
        box = Box(self)
        box.platform("SunOS", "sparc")
        r = box.run('harness_uv || echo "rc=$?"')
        self.assertEqual(lines(r), ["miss uv — there is no uv release for SunOS sparc; install it from https://docs.astral.sh/uv/", "rc=1"])

    def test_a_runtime_dir_that_cannot_be_made(self):
        box = Box(self)
        (box.root / "file").write_text("")
        rt = box.root / "file" / "runtime"
        r = box.run('harness_uv || echo "rc=$?"', ADAPTER_RUNTIME_DIR=str(rt))
        self.assertEqual(lines(r)[-2:], [f"miss cannot write {rt}", "rc=1"])

    def test_a_runtime_dir_that_cannot_be_written(self):
        box = Box(self)
        rt = box.root / "rt"
        rt.mkdir()
        rt.chmod(0o555)
        self.addCleanup(rt.chmod, 0o755)
        r = box.run('harness_uv || echo "rc=$?"', ADAPTER_RUNTIME_DIR=str(rt))
        self.assertEqual(lines(r)[-2:], [f"miss cannot write {rt}", "rc=1"])

    def test_a_failed_download_leaves_no_temp_dir(self):
        box = Box(self)
        box.stub("curl", "exit 7")
        r = box.run('harness_uv || echo "rc=$?"')
        self.assertEqual(lines(r)[-1], "rc=1")
        self.assertEqual(list(box.runtime.iterdir()), [])

    def test_an_archive_that_will_not_unpack(self):
        box = Box(self)
        box.serve(b"not a tarball")
        box.checksum(UV[("Darwin", "arm64")][1])
        r = box.run('harness_uv || echo "rc=$?"')
        self.assertEqual(lines(r)[-2:], ["miss the uv archive would not unpack", "rc=1"])
        self.assertEqual(list(box.runtime.iterdir()), [])

    def test_another_install_that_got_there_first_wins(self):
        box = Box(self)
        asset, pin = UV[("Darwin", "arm64")]
        box.serve(box.uv_tarball(asset))
        box.checksum(pin)
        dest = box.runtime / f"uv-{UV_VERSION}"
        # The other install lands its copy while this one downloads: curl makes the directory.
        box.stub("curl", f'mkdir -p "{dest}" && printf "#!/bin/bash\\n" > "{dest}/uv" && chmod +x "{dest}/uv"; '
                         f'for a in "$@"; do if [ "$prev" = -o ]; then out="$a"; fi; prev="$a"; done; cp "{box.fixtures / "download"}" "$out"')
        r = box.run('harness_uv && command -v uv')
        self.assertEqual((r.returncode, lines(r)[-1]), (0, str(dest / "uv")), r.stderr)
        self.assertEqual(sorted(p.name for p in dest.iterdir()), ["uv"], "not nested inside the winner's copy")

    def test_a_copy_that_never_lands(self):
        box = Box(self, real=tuple(n for n in REAL if n != "mv"))
        asset, pin = UV[("Darwin", "arm64")]
        box.serve(box.uv_tarball(asset))
        box.checksum(pin)
        box.stub("mv", 'case "$1" in -f) exec /bin/mv "$@" ;; esac; exit 1')
        r = box.run('harness_uv || echo "rc=$?"')
        self.assertEqual(lines(r)[-2:], [f"miss uv did not land in {box.runtime}/uv-{UV_VERSION}", "rc=1"])


class Venv(unittest.TestCase):
    def uv(self, box: Box, venv_exit: int = 0):
        template = box.stub("python", 'case "$1" in --version) echo "Python 3.12.7" ;; esac', where=box.fixtures)
        box.stub("uv", f'''case "$1" in
  venv) [ {venv_exit} = 0 ] || exit {venv_exit}; for last in "$@"; do :; done; mkdir -p "$last/bin" && cp "{template}" "$last/bin/python" ;;
esac''')
        (box.bin / "cp").unlink(missing_ok=True)
        (box.bin / "cp").symlink_to("/bin/cp")

    def system_python(self, box: Box):
        """A venv whose python is Apple's 3.9 — a wrapper, since /usr/bin/python3 picks its tool by the name it is run as."""
        py = box.root / ".venv" / "bin" / "python"
        py.parent.mkdir(parents=True)
        py.write_text('#!/bin/bash\nexec /usr/bin/python3 "$@"\n')
        py.chmod(0o755)

    def test_a_venv_in_range_is_kept(self):
        box = Box(self)
        self.uv(box)
        self.system_python(box)
        r = box.run('harness_venv .venv 3.12 3.9 3.10')
        self.assertEqual((r.returncode, lines(r)), (0, [f"ok   {subprocess.run(['/usr/bin/python3', '--version'], capture_output=True, text=True).stdout.strip()} in .venv"]), r.stderr)
        self.assertEqual(box.logged(), [])

    def test_a_venv_out_of_range_is_replaced(self):
        for low, below in (("3.10", ""), ("3.8", "3.9")):
            with self.subTest(low=low, below=below):
                box = Box(self)
                self.uv(box)
                self.system_python(box)
                r = box.run(f'harness_venv .venv 3.12 {low} {below}')
                self.assertEqual(lines(r), ["     python 3.12 in .venv (uv downloads it when this machine has none)",
                                            "ok   Python 3.12.7 in .venv"], r.stderr)
                self.assertEqual(box.logged(), ["uv venv --quiet --seed --python 3.12 --python-preference only-managed .venv", "python --version"])
                self.assertNotIn("exec /usr/bin/python3", (box.root / ".venv" / "bin" / "python").read_text(), "the old venv went first")

    def test_no_venv_makes_one_at_the_version_asked(self):
        box = Box(self)
        self.uv(box)
        r = box.run('harness_venv .venv 3.11')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("uv venv --quiet --seed --python 3.11 --python-preference only-managed .venv", box.logged())

    def test_no_uv_to_be_had(self):
        box = Box(self)
        box.stub("curl", "exit 6")
        r = box.run('harness_venv .venv 3.12 || echo "rc=$?"')
        self.assertEqual(lines(r)[-1], "rc=1")
        self.assertIn("miss could not download", r.stdout)

    def test_uv_that_cannot_make_it(self):
        box = Box(self)
        self.uv(box, venv_exit=2)
        r = box.run('harness_venv .venv 3.12 || echo "rc=$?"')
        self.assertEqual(lines(r)[-2:], ["miss could not make a Python 3.12 environment in .venv", "rc=1"])


class Pip(unittest.TestCase):
    def test_installs_into_the_venv_through_uv(self):
        box = Box(self)
        box.stub("uv", 'exit "${PIP_EXIT:-0}"')
        r = box.run('harness_pip .venv "rdkit==2025.3.1" numpy')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(box.logged(), ["uv pip install --quiet --python .venv/bin/python rdkit==2025.3.1 numpy"])
        self.assertEqual(lines(box.run('harness_pip .venv x y || echo "rc=$?"', PIP_EXIT="4")),
                         ["miss could not install x y into .venv", "rc=1"])

    def test_no_uv_to_be_had(self):
        box = Box(self)
        box.stub("curl", "exit 6")
        self.assertEqual(lines(box.run('harness_pip .venv x || echo "rc=$?"'))[-1], "rc=1")


class Micromamba(unittest.TestCase):
    def test_an_installed_copy_is_used(self):
        box = Box(self)
        mm = box.stub("micromamba", where=box.runtime / f"micromamba-{MAMBA_VERSION}")
        r = box.run('harness_micromamba && echo "$HARNESS_MICROMAMBA"')
        self.assertEqual((r.returncode, r.stdout.strip()), (0, str(mm)))
        self.assertEqual(box.logged(), [])

    def test_fetches_the_pinned_binary_for_each_machine(self):
        for (system, machine), (asset, pin) in MAMBA.items():
            with self.subTest(asset=asset):
                box = Box(self)
                box.platform(system, machine)
                box.serve(b"#!/bin/bash\necho micromamba\n")
                box.checksum(pin)
                r = box.run('harness_micromamba && "$HARNESS_MICROMAMBA"')
                self.assertEqual(lines(r), [f"     fetching micromamba {MAMBA_VERSION} into {box.runtime} (native libraries PyPI has no wheel for)",
                                            "micromamba"], r.stderr)
                self.assertIn(f"https://github.com/mamba-org/micromamba-releases/releases/download/{MAMBA_VERSION}/{asset}", box.logged()[-2])
                self.assertEqual([p.name for p in (box.runtime / f"micromamba-{MAMBA_VERSION}").iterdir()], ["micromamba"])

    def test_no_release_for_this_machine(self):
        box = Box(self)
        box.platform("Plan9", "mips")
        r = box.run('harness_micromamba || echo "rc=$?"')
        self.assertEqual(lines(r), ["miss micromamba — there is no release for Plan9 mips", "rc=1"])

    def test_a_dir_that_cannot_be_made(self):
        box = Box(self)
        (box.root / "file").write_text("")
        r = box.run('harness_micromamba || echo "rc=$?"', ADAPTER_RUNTIME_DIR=str(box.root / "file" / "rt"))
        self.assertEqual(lines(r)[-2:], [f"miss cannot write {box.root}/file/rt/micromamba-{MAMBA_VERSION}", "rc=1"])

    def test_a_failed_download(self):
        box = Box(self)
        box.stub("curl", "exit 6")
        self.assertEqual(lines(box.run('harness_micromamba || echo "rc=$?"'))[-1], "rc=1")

    def test_a_binary_that_will_not_move_into_place(self):
        box = Box(self, real=tuple(n for n in REAL if n != "mv"))
        box.serve(b"#!/bin/bash\n")
        box.checksum(MAMBA[("Darwin", "arm64")][1])
        box.stub("mv", 'case "$2" in *.part.*) exec /bin/mv "$@" ;; esac; exit 1')
        r = box.run('harness_micromamba || echo "rc=$?"')
        dest = box.runtime / f"micromamba-{MAMBA_VERSION}"
        self.assertEqual(lines(r)[-2:], [f"miss micromamba would not install into {dest}", "rc=1"])
        self.assertEqual(list(dest.iterdir()), [])


class CondaEnv(unittest.TestCase):
    def micromamba(self, box: Box, body: str) -> Path:
        return box.stub("micromamba", f'echo "MAMBA_ROOT_PREFIX=$MAMBA_ROOT_PREFIX" >> "$CALLS"\n{body}',
                        where=box.runtime / f"micromamba-{MAMBA_VERSION}")

    def test_a_relative_dir_is_made_absolute(self):
        box = Box(self)
        self.micromamba(box, 'for a in "$@"; do if [ "$prev" = --prefix ]; then mkdir -p "$a/conda-meta"; fi; prev="$a"; done')
        r = box.run('harness_conda_env .venv python=3.12 pycairo pip')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(box.logged(), [
            f"micromamba create --yes --quiet --prefix {box.root}/.venv --override-channels --channel conda-forge python=3.12 pycairo pip",
            f"MAMBA_ROOT_PREFIX={box.runtime}/mamba",
        ])
        self.assertTrue((box.root / ".venv" / "conda-meta").is_dir())

    def test_an_absolute_dir_is_kept(self):
        box = Box(self)
        self.micromamba(box, f'mkdir -p "{box.root}/env/conda-meta"')
        r = box.run(f'harness_conda_env "{box.root}/env" python=3.12')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"--prefix {box.root}/env ", box.logged()[0])

    def test_a_create_that_fails(self):
        box = Box(self)
        self.micromamba(box, "exit 1")
        r = box.run('harness_conda_env .venv python=3.12 || echo "rc=$?"')
        self.assertEqual(lines(r), [f"miss could not make the conda-forge environment in {box.root}/.venv (python=3.12)", "rc=1"])

    def test_a_create_that_succeeds_somewhere_else(self):
        box = Box(self)
        self.micromamba(box, "exit 0")
        r = box.run('harness_conda_env .venv python=3.12 || echo "rc=$?"')
        self.assertEqual(lines(r)[-1], "rc=1")

    def test_no_micromamba_to_be_had(self):
        box = Box(self)
        box.stub("curl", "exit 6")
        self.assertEqual(lines(box.run('harness_conda_env .venv python=3.12 || echo "rc=$?"'))[-1], "rc=1")


if __name__ == "__main__":
    unittest.main()
