"""The shell half of the toolchain — flow.sh, setup.sh, doctor.sh, init-workspace.sh, viewer.sh, path.sh
and run — on stub tools: `python3 -m unittest toolchain/test_scripts.py`.

Each test builds a throwaway install (the real scripts symlinked in, file by file), a workspace, a
directory of stub tools that log how they were called, and a PATH made of those stubs plus links to
the few system tools the scripts use, so a tool is missing exactly when a test leaves it out. The
scripts fall back to Homebrew's bin when yosys is not on PATH; a test that needs a tool to stay
missing after that hides it with a `command -v` wrapper exported into bash. setup.sh's OSS CAD Suite
download is a stub curl handing over a small tarball of stub tools laid out like the suite, and
runtimes.sh's fallback to Harness's own Node reads a runtime dir of the sandbox's, never ~/.harness.
One test at the end runs the real flow on the starter design, when yosys, nextpnr, icestorm and icarus
are installed.
"""
import atexit
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import unittest
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
SYSTEM = ["bash", "basename", "cat", "chmod", "cut", "date", "dirname", "du", "grep", "gzip", "head", "ln", "mkdir",
          "mktemp", "mv", "perl", "rm", "sed", "tail", "tar", "tr"]
# `command -v <tool>` fails for every tool named in $STUB_HIDE, wherever it is installed.
HIDE = '() { if [ "$1" = -v ]; then case " $STUB_HIDE " in *" $2 "*) return 1;; esac; fi; builtin command "$@"; }'
SCRUB = ("HARNESS_WORKSPACE", "HARNESS_DSH_DIR", "HARNESS_VIEWER_PORT", "YOSYS_TOP", "YOSYS_DEVICE",
         "YOSYS_PACKAGE", "YOSYS_TOOLCHAIN", "STUB_FAIL", "STUB_HIDE")

# What each stub does besides logging its argv. $STUB_FAIL names the stubs that fail instead.
STUBS = {
    "iverilog": 'case "$1" in -V) echo "Icarus Verilog version 13.0 (stable)"; exit 0;; esac\n'
                ': > out/sim.vvp\n',
    "vvp": 'echo "  ok   green LED toggled"\necho "PASS  blink: 1 check"\n'
           '[ -n "$STUB_NO_VCD" ] || printf \'$timescale 1ps $end\\n$var wire 1 ! clk $end\\n'
           '$enddefinitions $end\\n#0\\n0!\\n#5\\n1!\\n\' > out/sim.vcd\n',
    "yosys": 'case "$1" in -V) echo "Yosys 0.99 (stub)"; exit 0;; esac\n'
             'case "$*" in\n'
             '  *synth_ice40*) printf \'=== blink ===\\n\\n       77 cells\\n       32   SB_LUT4\\n\'; echo "{}" > out/blink.json;;\n'
             '  *prep*) echo "{}" > out/blink_schematic.json;;\n'
             'esac\n',
    "netlistsvg": 'echo "<svg/>" > "$3"\n',
    "nextpnr-ice40": 'case "$1" in --version) echo "nextpnr-ice40 -- Next Generation Place and Route (stub)"; exit 0;; esac\n'
                     ': > out/blink.asc\n'
                     'echo \'{"utilization": {"ICESTORM_LC": {"used": 36, "available": 5280}}, '
                     '"fmax": {"clk": {"achieved": 60.0, "constraint": 12.0}}}\' > out/blink_pnr.json\n'
                     'echo "{}" > out/blink_routed.json\n',
    "icepack": 'printf "bits" > out/blink.bin\n',
    "iceprog": "",
    "brew": "",
    "node": 'case "$1" in -v) echo v22.0.0;; -p) echo 1.0.2;; esac\n',
    "npm": 'mkdir -p node_modules/.bin && printf "#!/bin/sh\\n" > node_modules/.bin/netlistsvg && chmod +x node_modules/.bin/netlistsvg\n',
}

# The same tools as setup.sh's smoke run calls them: every output lands where its argument says.
SMOKE = {
    "iverilog": 'case "$1" in -V) echo "Icarus Verilog version 13.0 (stable)"; exit 0;; esac\n'
                'while [ $# -gt 0 ]; do [ "$1" = -o ] && : > "$2"; shift; done\n',
    "vvp": 'echo "led 1"\n',
    "yosys": 'case "$1" in -V) echo "Yosys 0.99 (stub)"; exit 0;; esac\n'
             'all="$*"; echo "{}" > "${all##*-json }"\n',
    "nextpnr-ice40": 'case "$1" in --version) echo "nextpnr-ice40 (stub)"; exit 0;; esac\n'
                     'while [ $# -gt 0 ]; do [ "$1" = --asc ] && : > "$2"; shift; done\n',
    "icepack": 'printf bits > "$2"\n',
    "node": 'case "$1" in -v) echo v22.0.0;; -p) echo 1.0.2;; esac\n',
    "npm": STUBS["npm"],
}
ALL_TOOLS_OF_THE_SUITE = ("yosys", "nextpnr-ice40", "icepack", "iceprog", "iverilog", "vvp")
SETUP_TEXT = (PKG / "toolchain" / "setup.sh").read_text()
RELEASE = re.search(r"^SUITE_RELEASE=(\S+)$", SETUP_TEXT, re.M).group(1)
PINS = {m.group(1): (int(m.group(2)), m.group(3)) for m in
        re.finditer(r"platform=(\S+) mb=(\d+) sum=([0-9a-f]{64})", SETUP_TEXT)}
SUITE_URL = "https://github.com/YosysHQ/oss-cad-suite-build/releases/download/{release}/oss-cad-suite-{platform}-{date}.tgz"


def suite_url(platform):
    return SUITE_URL.format(release=RELEASE, platform=platform, date=RELEASE.replace("-", ""))


_STUB_DIR = None


def stub_file(name, body):
    """One file per distinct stub for the whole run, hard-linked into each sandbox: macOS checks every
    new executable on its first run (most of a second each), and a link is not new."""
    global _STUB_DIR
    if _STUB_DIR is None:
        _STUB_DIR = Path(tempfile.mkdtemp(prefix="yosys-stubs-"))
        atexit.register(shutil.rmtree, _STUB_DIR, True)
    path = _STUB_DIR / hashlib.sha1(f"{name}\0{body}".encode()).hexdigest()[:16] / name
    if not path.exists():
        path.parent.mkdir()
        path.write_text(
            "#!/bin/sh\n"
            f'echo "{name} $*" >> "$STUB_CALLS"\n'
            f'case " $STUB_FAIL " in *" {name} "*) echo "{name}: stub failure"; exit 1;; esac\n' + body)
        path.chmod(0o755)
    return path


class Sandbox:
    """An install, a workspace, stub tools and a PATH, all under one temp dir."""

    def __init__(self, test: unittest.TestCase, stubs=(), system=SYSTEM, python=True):
        self.root = Path(tempfile.mkdtemp(prefix="yosys-sh-"))
        test.addCleanup(shutil.rmtree, self.root, True)
        self.pkg = self.root / "install"
        self.ws = self.root / "ws"
        self.bin = self.root / "stubs"
        self.sys = self.root / "system"
        self.calls = self.root / "calls.log"
        self.runtime = self.root / "runtime"
        for d in (self.pkg / "toolchain", self.ws, self.bin, self.sys):
            d.mkdir(parents=True)
        for name in ("flow.sh", "setup.sh", "doctor.sh", "init-workspace.sh", "verdict.py", "vcd2json.py",
                     "path.sh", "runtimes.sh", "run"):
            (self.pkg / "toolchain" / name).symlink_to(PKG / "toolchain" / name)
        (self.pkg / "viewer.sh").symlink_to(PKG / "viewer.sh")
        for name in system:
            found = shutil.which(name, path="/usr/bin:/bin:/usr/sbin:/sbin")
            if found:
                (self.sys / name).symlink_to(found)
        if python:
            (self.sys / "python3").symlink_to(os.path.realpath(shutil.which("python3")))
        for name in stubs:
            self.stub(name)

    def stub(self, name, body=None, where=None):
        path = (where or self.bin) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
        os.link(stub_file(name, STUBS.get(name, "") if body is None else body), path)
        return path

    def run(self, argv, cwd=None, hide=(), **env):
        full = {k: v for k, v in os.environ.items() if k not in SCRUB}
        full.update(PATH=f"{self.bin}:{self.sys}", STUB_CALLS=str(self.calls), STUB_BIN=str(self.bin), LC_ALL="C",
                    ADAPTER_RUNTIME_DIR=str(self.runtime))
        if hide:
            full["BASH_FUNC_command%%"] = HIDE
            full["STUB_HIDE"] = " ".join(hide)
        full.update({k: str(v) for k, v in env.items()})
        return subprocess.run([str(a) for a in argv], cwd=cwd or self.ws, env=full,
                              capture_output=True, text=True, timeout=120)

    def called(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def tools(self):
        """The calls, minus runtimes.sh's `node -e` version probe (whose script spans several lines)."""
        return [c for c in self.called() if re.match(r"(iverilog|vvp|yosys|nextpnr-ice40|icepack|iceprog|netlistsvg|npm|curl|suite-\S+) |node /", c)]

    def harness_node(self, body=None):
        """No node on PATH, but Harness's own recorded where the CLI lays it down."""
        node = self.stub("node", body, where=self.root / "harness-node")
        self.runtime.mkdir(exist_ok=True)
        (self.runtime / "current-node").write_text(f"{node}\n")
        return node

    def no_node(self):
        return f"miss node >= 18, and Harness's own Node is not in {self.runtime} — run `harness start` once to lay it down"

    def suite(self, release=None, tools=ALL_TOOLS_OF_THE_SUITE, chipdb=False):
        """oss-cad-suite/ in the install, as setup.sh leaves it: stub tools that log as suite-<tool>."""
        for name in tools:
            self.stub(name, body=f'echo "suite-{name} $*" >> "$STUB_CALLS"\n' + SMOKE.get(name, STUBS.get(name, "")),
                      where=self.pkg / "oss-cad-suite" / "bin")
        if release:
            (self.pkg / "oss-cad-suite" / ".release").write_text(release + "\n")
        if chipdb:
            (self.pkg / "oss-cad-suite" / "share" / "icebox").mkdir(parents=True)
            (self.pkg / "oss-cad-suite" / "share" / "icebox" / "chipdb-5k.txt").write_text(".device 5k\n")

    def design(self, rtl=True, tb=True, pcf=True, top="blink"):
        for sub, name, ok in (("rtl", f"{top}.v", rtl), ("tb", f"{top}_tb.v", tb), ("constraints", f"{top}.pcf", pcf)):
            if ok:
                (self.ws / sub).mkdir(exist_ok=True)
                (self.ws / sub / name).write_text("// stub\n")

    def log(self, step):
        return (self.ws / "out" / "logs" / f"{step}.log").read_text()

    def exit_of(self, step):
        f = self.ws / "out" / "logs" / f"{step}.exit"
        return f.read_text().strip() if f.exists() else None


ALL_FLOW = ("iverilog", "vvp", "yosys", "nextpnr-ice40", "icepack")


class Flow(unittest.TestCase):
    def flow(self, sb, *args, **env):
        return sb.run([sb.pkg / "toolchain" / "flow.sh", *args], **env)

    def with_netlistsvg(self, sb):
        sb.stub("netlistsvg", where=sb.pkg / "node_modules" / ".bin")

    def test_a_whole_run_on_stub_tools_is_ready(self):
        sb = Sandbox(self, stubs=ALL_FLOW)
        sb.design()
        self.with_netlistsvg(sb)
        r = self.flow(sb)  # the top comes from tb/blink_tb.v
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("flow: blink  (--up5k --package sg48, 1 RTL file(s))", r.stdout)
        self.assertIn("→ sim", r.stdout)
        self.assertIn("  PASS  blink: 1 check", r.stdout)  # a passing step shows its log's tail
        self.assertTrue(r.stdout.rstrip().splitlines()[-1].startswith("ready · blink · sim passes · 77 cells"), r.stdout)
        self.assertEqual([c.split()[0] for c in sb.called()],
                         ["iverilog", "vvp", "yosys", "yosys", "netlistsvg", "nextpnr-ice40", "icepack"])
        calls = sb.called()
        self.assertEqual(calls[0], "iverilog -g2012 -Wall -o out/sim.vvp rtl/blink.v tb/blink_tb.v")
        self.assertIn("read_verilog rtl/blink.v; synth_ice40 -top blink -json out/blink.json; stat", calls[2])
        self.assertIn("read_verilog rtl/blink.v; prep -top blink; write_json out/blink_schematic.json", calls[3])
        self.assertEqual(calls[4], "netlistsvg out/blink_schematic.json -o out/blink.svg")
        self.assertEqual(calls[5], "nextpnr-ice40 --up5k --package sg48 --json out/blink.json --pcf constraints/blink.pcf "
                                   "--asc out/blink.asc --report out/blink_pnr.json --write out/blink_routed.json")
        self.assertEqual(calls[6], "icepack out/blink.asc out/blink.bin")
        for step in ("sim", "waves", "synth", "schematic", "svg", "pnr", "pack"):
            self.assertEqual(sb.exit_of(step), "0", step)
            start, end = (sb.ws / "out" / "logs" / f"{step}.time").read_text().split()
            self.assertLessEqual(int(start), int(end))
            self.assertEqual((sb.ws / "out" / "logs" / f"{step}.start").read_text().strip(), start)
        run = json.loads((sb.ws / "out" / "logs" / "run.json").read_text())
        self.assertEqual((run["top"], run["device"], run["package"]), ("blink", "--up5k", "sg48"))
        self.assertGreaterEqual(run["finishedAt"], run["startedAt"])
        self.assertEqual((sb.ws / "out" / ".top").read_text(), "blink\n")
        self.assertEqual(json.loads((sb.ws / "out" / "waves.json").read_text())["signals"][0]["name"], "clk")
        verdict = json.loads((sb.ws / ".harness" / "verdict.json").read_text())
        self.assertTrue(verdict["ready"])

    def test_a_new_run_clears_the_last_runs_step_files(self):
        sb = Sandbox(self, stubs=ALL_FLOW)
        sb.design()
        logs = sb.ws / "out" / "logs"
        logs.mkdir(parents=True)
        for ext in ("log", "exit", "start", "time"):
            (logs / f"old.{ext}").write_text("1\n")
        self.flow(sb, "blink")
        self.assertEqual(sorted(p.name for p in logs.glob("old.*")), [])

    def test_the_argument_then_YOSYS_TOP_name_the_top_and_the_board_comes_from_the_environment(self):
        sb = Sandbox(self, stubs=ALL_FLOW)
        sb.design(top="uart")
        r = self.flow(sb, YOSYS_TOP="uart", YOSYS_DEVICE="--hx8k", YOSYS_PACKAGE="ct256")
        self.assertIn("flow: uart  (--hx8k --package ct256, 1 RTL file(s))", r.stdout)
        self.assertIn("nextpnr-ice40 --hx8k --package ct256 --json out/uart.json", "\n".join(sb.called()))
        run = json.loads((sb.ws / "out" / "logs" / "run.json").read_text())
        self.assertEqual((run["device"], run["package"]), ("--hx8k", "ct256"))
        r = self.flow(sb, "other", YOSYS_TOP="uart")
        self.assertIn("flow: other ", r.stdout)

    def test_no_top_module_is_an_error_before_anything_runs(self):
        sb = Sandbox(self, stubs=ALL_FLOW)
        (sb.ws / "tb").mkdir()
        r = self.flow(sb)
        self.assertEqual(r.returncode, 2)
        self.assertIn("flow.sh: no top module — pass one, or put tb/<top>_tb.v in the workspace", r.stderr)
        self.assertFalse((sb.ws / "out").exists())

    def test_a_missing_workspace_is_an_error(self):
        sb = Sandbox(self, stubs=ALL_FLOW)
        r = self.flow(sb, "blink", HARNESS_WORKSPACE=sb.root / "nowhere")
        self.assertEqual(r.returncode, 2)
        self.assertIn(f"no workspace at {sb.root / 'nowhere'}", r.stderr)

    def test_no_rtl_fails_sim_and_synth_and_skips_the_rest(self):
        # yosys is not on PATH either: flow.sh adds Homebrew's bin, and nothing here reaches a tool.
        sb = Sandbox(self)
        sb.design(rtl=False)
        r = self.flow(sb, HARNESS_WORKSPACE=sb.ws)
        self.assertEqual(r.returncode, 1)
        self.assertIn("flow: blink  (--up5k --package sg48, 0 RTL file(s))", r.stdout)
        self.assertIn("  failed (exit 1) — out/logs/sim.log\n  no rtl/*.v to simulate", r.stdout)
        self.assertEqual(sb.log("synth"), "no rtl/*.v to synthesise\n")
        self.assertEqual([sb.exit_of(s) for s in ("sim", "waves", "synth", "schematic", "svg", "pnr", "pack")],
                         ["1", None, "1", None, None, None, None])
        self.assertEqual(sb.called(), [])
        verdict = json.loads((sb.ws / ".harness" / "verdict.json").read_text())
        self.assertFalse(verdict["ready"])

    def test_no_testbench(self):
        sb = Sandbox(self, stubs=ALL_FLOW)
        sb.design(tb=False)
        self.flow(sb, "blink")
        self.assertEqual(sb.log("sim"), "no testbench at tb/blink_tb.v\n")
        self.assertEqual(sb.exit_of("sim"), "1")

    def test_a_compile_error_or_a_crashed_simulation_fails_sim_only(self):
        for tool in ("iverilog", "vvp"):
            with self.subTest(tool):
                sb = Sandbox(self, stubs=ALL_FLOW)
                sb.design()
                r = self.flow(sb, "blink", STUB_FAIL=tool)
                self.assertIn(f"{tool}: stub failure", sb.log("sim"))
                self.assertEqual((sb.exit_of("sim"), sb.exit_of("waves"), sb.exit_of("synth")), ("1", None, "0"))
                self.assertEqual(r.returncode, 1)

    def test_a_testbench_that_dumps_nothing_fails_even_over_an_old_vcd(self):
        sb = Sandbox(self, stubs=ALL_FLOW)
        sb.design()
        (sb.ws / "out").mkdir()
        (sb.ws / "out" / "sim.vcd").write_text("$enddefinitions $end\n")  # from an earlier run
        self.flow(sb, "blink", STUB_NO_VCD=1)
        self.assertEqual(sb.exit_of("sim"), "1")
        self.assertIn('no out/sim.vcd — the testbench needs $dumpfile("out/sim.vcd") and $dumpvars', sb.log("sim"))
        self.assertIsNone(sb.exit_of("waves"))

    def test_a_synthesis_error_skips_schematic_and_place_and_route(self):
        sb = Sandbox(self, stubs=ALL_FLOW)
        sb.design()
        r = self.flow(sb, "blink", STUB_FAIL="yosys")
        self.assertEqual([sb.exit_of(s) for s in ("synth", "schematic", "svg", "pnr", "pack")], ["1", None, None, None, None])
        self.assertIn("  failed (exit 1) — out/logs/synth.log\n  yosys: stub failure", r.stdout)

    def test_the_schematic_is_optional_for_the_bitstream(self):
        sb = Sandbox(self, stubs=ALL_FLOW)
        sb.design()
        self.flow(sb, "blink")  # no netlistsvg in the install
        self.assertEqual(sb.log("svg"), f"no netlistsvg at {sb.pkg}/node_modules/.bin/netlistsvg — run toolchain/setup.sh\n")
        self.assertEqual([sb.exit_of(s) for s in ("svg", "pnr", "pack")], ["1", "0", "0"])
        # HARNESS_DSH_DIR, when set, is where netlistsvg is looked for
        other = sb.root / "other-install"
        sb.stub("netlistsvg", where=other / "node_modules" / ".bin")
        self.flow(sb, "blink", HARNESS_DSH_DIR=other)
        self.assertEqual(sb.exit_of("svg"), "0")
        self.assertEqual((sb.ws / "out" / "blink.svg").read_text(), "<svg/>\n")
        # a schematic netlist that yosys could not write is not drawn, and does not stop the bitstream
        sb.stub("yosys", body='case "$*" in *prep*) exit 1;; *) printf "=== blink ===\\n" ;; esac\n')
        self.flow(sb, "blink", HARNESS_DSH_DIR=other)
        self.assertEqual([sb.exit_of(s) for s in ("synth", "schematic", "svg", "pnr", "pack")], ["0", "1", None, "0", "0"])

    def test_place_and_route_needs_nextpnr_and_the_pin_constraints(self):
        sb = Sandbox(self, stubs=("iverilog", "vvp", "yosys", "icepack"))
        sb.design()
        r = self.flow(sb, "blink")
        self.assertEqual(sb.log("pnr"), "nextpnr-ice40 is not installed — run toolchain/setup.sh\n")
        self.assertEqual((sb.exit_of("pnr"), sb.exit_of("pack")), ("127", None))
        self.assertIn("failed (exit 127) — out/logs/pnr.log", r.stdout)
        sb = Sandbox(self, stubs=ALL_FLOW)
        sb.design(pcf=False)
        self.flow(sb, "blink")
        self.assertEqual(sb.log("pnr"), "no pin constraints at constraints/blink.pcf — every port needs a set_io line\n")
        self.assertEqual(sb.exit_of("pnr"), "1")

    def test_the_bitstream_needs_icepack(self):
        sb = Sandbox(self, stubs=("iverilog", "vvp", "yosys", "nextpnr-ice40"))
        sb.design()
        self.flow(sb, "blink")
        self.assertEqual(sb.log("pack"), "icepack is not installed — run toolchain/setup.sh\n")
        self.assertEqual(sb.exit_of("pack"), "127")

    def test_without_perl_the_clock_is_whole_seconds(self):
        sb = Sandbox(self, stubs=ALL_FLOW, system=[s for s in SYSTEM if s != "perl"])
        sb.design()
        before = int(time.time())
        self.flow(sb, "blink")
        start = (sb.ws / "out" / "logs" / "sim.start").read_text().strip()
        self.assertTrue(start.endswith("000"), start)
        self.assertGreaterEqual(int(start) // 1000, before)


class Setup(unittest.TestCase):
    TOOLS = ("yosys", "nextpnr-ice40", "icepack", "iverilog")
    HIDDEN = TOOLS + ("brew",)  # wherever they are installed, so a machine with Homebrew's answers the same

    def sandbox(self, machine_tools=True, **kw):
        sb = Sandbox(self, **kw)
        for name in ("node", "npm", "vvp") + (self.TOOLS if machine_tools else ()):
            sb.stub(name, body=SMOKE[name])
        sb.stub("uname", body='case "$1" in -s) echo Darwin;; -m) echo arm64;; esac\n')
        return sb

    def setup_sh(self, sb, **kw):
        return sb.run([sb.pkg / "toolchain" / "setup.sh"], cwd=sb.root, **kw)

    def serve(self, sb, archive=None, sha=None):
        """curl hands over `archive` (a tarball of the suite's layout by default) whatever the URL; shasum
        answers the pinned checksum of the platform uname names, unless `sha` says otherwise."""
        tgz = sb.root / "suite.tgz"
        tgz.write_bytes(archive if archive is not None else suite_tarball())
        sb.stub("curl", body='for a in "$@"; do case "$prev" in -o) out="$a";; esac; prev="$a"; done\n'
                             f'[ -n "$CURL_FAIL" ] && exit 22\n/bin/cp "{tgz}" "$out"\n')
        sb.stub("shasum", body=f'echo "{sha or PINS["darwin-arm64"][1]}  $3"\n')

    def assert_smoke_and_versions(self, lines, node="v22.0.0"):
        self.assertEqual(lines[-4:], [
            "     smoke run: a counter simulated, synthesised, placed, routed and packed (slow only the first time)",
            "ok   Yosys 0.99 (stub)",
            "ok   nextpnr-ice40 · icepack · Icarus Verilog version 13.0 (stable)",
            f"ok   netlistsvg 1.0.2 · node {node}",
        ])

    def test_the_machines_own_tools_are_kept_and_smoke_tested(self):
        sb = self.sandbox()
        r = self.setup_sh(sb)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        lines = r.stdout.splitlines()
        self.assertEqual(lines[:2], ["ok   yosys, nextpnr-ice40, icepack, iverilog already on this machine",
                                     "     npm ci (netlistsvg 1.0.2, for the schematic)"])
        self.assert_smoke_and_versions(lines)
        self.assertEqual(len(lines), 6)
        tools = [c.split()[0] for c in sb.tools()]
        self.assertEqual(tools[:6], ["npm", "iverilog", "vvp", "yosys", "nextpnr-ice40", "icepack"])
        self.assertIn("npm ci --silent --no-audit --no-fund", sb.called())
        self.assertNotIn("curl", tools)
        self.assertTrue((sb.pkg / "node_modules" / ".bin" / "netlistsvg").exists())  # in the install, not the cwd
        self.assertFalse((sb.pkg / "oss-cad-suite").exists())
        self.assertEqual(list(Path(sb.root).glob("tmp/yosys-smoke.*")), [])

    def test_a_machine_without_the_tools_gets_the_oss_cad_suite(self):
        sb = self.sandbox(machine_tools=False)
        self.serve(sb)
        (sb.pkg / ".oss-cad-suite.interrupted").mkdir()  # a run killed mid-download left this
        tmp = sb.root / "tmp"
        tmp.mkdir()
        r = self.setup_sh(sb, hide=self.HIDDEN, TMPDIR=tmp)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        lines = r.stdout.splitlines()
        self.assertEqual(lines[:2], ["     this machine has no yosys nextpnr-ice40 icepack iverilog",
                                     f"     fetching the OSS CAD Suite {RELEASE} for darwin-arm64 ({PINS['darwin-arm64'][0]} MB, a few minutes the first time)"])
        self.assertRegex(lines[2], rf"^ok   OSS CAD Suite {RELEASE} in oss-cad-suite/ \(\d+(\.\d+)?[BKMG]\)$")
        self.assert_smoke_and_versions(lines)
        self.assertIn(f"curl -fsSL --retry 3 --connect-timeout 20 --max-time 3600 -o {sb.pkg}/.oss-cad-suite.", "\n".join(sb.called()))
        self.assertIn(suite_url("darwin-arm64"), "\n".join(sb.called()))
        # the smoke run and the version lines ran the suite's tools, not anything else on PATH
        self.assertEqual([c.split()[0] for c in sb.called() if c.startswith("suite-")],
                         ["suite-iverilog", "suite-vvp", "suite-yosys", "suite-nextpnr-ice40", "suite-icepack",
                          "suite-yosys", "suite-iverilog"])
        suite = sb.pkg / "oss-cad-suite"
        kept = sorted(str(f.relative_to(suite)) for f in suite.rglob("*") if f.is_file())
        self.assertEqual(kept, sorted([
            ".release", "VERSION", "license/COPYING", "etc/cacert.pem", "Frameworks/QtCore.framework/QtCore",
            "bin/yosys", "bin/yosys-abc", "bin/nextpnr-ice40", "bin/icepack", "bin/iceprog", "bin/iverilog", "bin/vvp",
            "libexec/yosys", "libexec/nextpnr-ice40", "libexec/ivl",
            "lib/libz.1.dylib", "lib/ivl/system.vpi", "lib/python3.11/os.py", "lib/python3.11/lib-dynload/_json.so",
            "share/yosys/ice40/cells_sim.v", "share/icebox/chipdb-5k.txt",
        ]))
        self.assertEqual((suite / ".release").read_text(), f"{RELEASE}\n")
        self.assertEqual(sorted(p.name for p in sb.pkg.iterdir() if p.name.startswith(".oss-cad-suite")), [])
        self.assertEqual(list(tmp.iterdir()), [], "the smoke run's scratch dir is removed")

    def test_a_suite_at_the_pinned_release_is_used_as_it_is(self):
        sb = self.sandbox(machine_tools=False)
        sb.suite(release=RELEASE)
        r = self.setup_sh(sb, hide=self.HIDDEN)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(r.stdout.splitlines()[0], f"ok   OSS CAD Suite {RELEASE} already in oss-cad-suite/")
        self.assertFalse(any(c.startswith("curl") for c in sb.called()))
        self.assertIn("suite-nextpnr-ice40", "\n".join(sb.called()))

    def test_a_suite_from_another_release_is_replaced_even_on_a_machine_with_the_tools(self):
        # flow.sh would prefer the stale suite over the machine's tools, so it cannot be left there.
        sb = self.sandbox()
        sb.suite(release="2020-01-01")
        (sb.pkg / "oss-cad-suite" / "bin" / "stale").write_text("")
        self.serve(sb)
        r = self.setup_sh(sb)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(r.stdout.splitlines()[0].startswith(f"     fetching the OSS CAD Suite {RELEASE} for darwin-arm64"))
        self.assertFalse((sb.pkg / "oss-cad-suite" / "bin" / "stale").exists())
        self.assertEqual((sb.pkg / "oss-cad-suite" / ".release").read_text(), f"{RELEASE}\n")

    def test_each_platform_fetches_its_own_build(self):
        for system, machine, platform in (("Darwin", "x86_64", "darwin-x64"), ("Linux", "x86_64", "linux-x64"),
                                          ("Linux", "aarch64", "linux-arm64"), ("Linux", "arm64", "linux-arm64")):
            with self.subTest(platform=platform, machine=machine):
                sb = self.sandbox(machine_tools=False)
                sb.stub("uname", body=f'case "$1" in -s) echo {system};; -m) echo {machine};; esac\n')
                self.serve(sb, sha=PINS[platform][1])
                r = self.setup_sh(sb, hide=self.HIDDEN)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertIn(f"     fetching the OSS CAD Suite {RELEASE} for {platform} ({PINS[platform][0]} MB, a few minutes the first time)",
                              r.stdout.splitlines())
                self.assertIn(suite_url(platform), "\n".join(sb.called()))

    def test_a_platform_the_suite_is_not_built_for(self):
        sb = self.sandbox(machine_tools=False)
        sb.stub("uname", body='case "$1" in -s) echo FreeBSD;; -m) echo amd64;; esac\n')
        r = self.setup_sh(sb, hide=self.HIDDEN)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.splitlines()[-1],
                         "miss yosys nextpnr-ice40 icepack iverilog — and the OSS CAD Suite has no build for FreeBSD amd64")
        self.assertFalse(any(c.startswith(("curl", "npm")) for c in sb.called()))

    def test_a_download_that_fails_or_does_not_match_changes_nothing(self):
        for case in ("offline", "checksum", "sha256sum", "not a tarball"):
            with self.subTest(case):
                sb = self.sandbox(machine_tools=False)
                sb.suite(release="2020-01-01")
                if case == "sha256sum":  # no shasum on this machine (a Linux without perl's): coreutils' answers
                    self.serve(sb)
                    (sb.bin / "shasum").unlink()
                    sb.stub("sha256sum", body='echo "0000  $1"\n')
                else:
                    self.serve(sb, archive=b"<html>rate limited</html>" if case == "not a tarball" else None,
                               sha="f" * 64 if case == "checksum" else None)
                r = self.setup_sh(sb, hide=self.HIDDEN, CURL_FAIL="1" if case == "offline" else "")
                self.assertEqual(r.returncode, 1)
                last = r.stdout.splitlines()[-1]
                if case == "offline":
                    self.assertEqual(last, f"miss could not download {suite_url('darwin-arm64')} — check this machine's internet connection")
                elif case == "not a tarball":
                    self.assertEqual(last, "miss the OSS CAD Suite archive would not unpack (is the disk full?)")
                else:
                    self.assertEqual(last, f"miss {suite_url('darwin-arm64')} did not match its pinned checksum; nothing was installed")
                self.assertEqual((sb.pkg / "oss-cad-suite" / ".release").read_text(), "2020-01-01\n")
                self.assertEqual(sorted(p.name for p in sb.pkg.iterdir() if p.name.startswith(".oss-cad-suite")), [])

    def test_node_npm_and_python_come_before_any_download(self):
        for missing in ("node", "npm", "python3"):
            with self.subTest(missing):
                sb = self.sandbox(machine_tools=False, python=missing != "python3")
                if missing != "python3":
                    (sb.bin / missing).unlink()
                self.serve(sb)
                r = self.setup_sh(sb, hide=self.HIDDEN)
                self.assertEqual(r.returncode, 1)
                self.assertEqual(r.stdout.splitlines(), [{"node": sb.no_node(), "npm": "miss npm on PATH",
                                                          "python3": "miss python3 (the VCD reader and the verdict)"}[missing]])
                self.assertFalse(any(c.startswith("curl") for c in sb.called()))

    def test_without_node_on_path_harnesss_own_runs_npm_and_netlistsvg(self):
        sb = self.sandbox()
        (sb.bin / "node").unlink()
        (sb.bin / "npm").unlink()
        sb.harness_node(SMOKE["node"])
        sb.stub("npm", body=SMOKE["npm"], where=sb.root / "harness-node")
        r = self.setup_sh(sb)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assert_smoke_and_versions(r.stdout.splitlines())

    def test_npm_ci_that_leaves_no_netlistsvg(self):
        sb = self.sandbox()
        sb.stub("npm", body="")
        r = self.setup_sh(sb)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.splitlines()[-1], "miss node_modules/.bin/netlistsvg after npm ci")
        self.assertFalse(any(c.startswith("iverilog") for c in sb.called()))

    def test_a_tool_that_does_not_run_is_named(self):
        for tool in ("iverilog", "vvp", "yosys", "nextpnr-ice40", "icepack"):
            with self.subTest(tool):
                sb = self.sandbox()
                r = self.setup_sh(sb, STUB_FAIL=tool)
                self.assertEqual(r.returncode, 1)
                self.assertEqual(r.stdout.splitlines()[-1], f"miss {tool} does not run on this machine: {tool}: stub failure")
        sb = self.sandbox()
        sb.stub("icepack", body="")  # exits 0 and packs nothing
        r = self.setup_sh(sb)
        self.assertEqual((r.returncode, r.stdout.splitlines()[-1]), (1, "miss icepack does not run on this machine: led 1"))

    def test_without_yosys_on_path_it_looks_in_homebrew_too(self):
        # after the rest of PATH, so Homebrew's node never replaces the one runtimes.sh chose
        sb = self.sandbox(machine_tools=False)
        sb.stub("curl", body='echo "PATH=$PATH" >> "$STUB_CALLS"; exit 22\n')
        r = self.setup_sh(sb, hide=self.HIDDEN)
        self.assertEqual(r.returncode, 1)
        [path] = [c for c in sb.called() if c.startswith("PATH=")]
        self.assertTrue(path.endswith(":/opt/homebrew/bin:/usr/local/bin"), path)


def suite_tarball():
    """The OSS CAD Suite's layout in miniature: the tools setup.sh keeps (as smoke-run stubs), and some of
    what it leaves behind — other tools, Python's tests and packages, GHDL, LLVM."""
    files = {
        "VERSION": "20260916\n", "README": "", "license/COPYING": "", "etc/cacert.pem": "",
        "Frameworks/QtCore.framework/QtCore": "", "examples/ice40/blink.v": "",
        "libexec/yosys": "", "libexec/nextpnr-ice40": "", "libexec/ivl": "", "libexec/ghdl": "", "libexec/nextpnr-ecp5": "",
        "lib/libz.1.dylib": "", "lib/ivl/system.vpi": "", "lib/python3.11/os.py": "", "lib/python3.11/lib-dynload/_json.so": "",
        "lib/python3.11/test/test_os.py": "", "lib/python3.11/site-packages/pip/__init__.py": "", "lib/python2.7/os.py": "",
        "lib/ghdl/std.cf": "", "lib/libghdl-5.dylib": "", "lib/libLLVM.so.21": "", "lib/libgallium-26.so": "", "lib/dri/swrast.so": "",
        "share/yosys/ice40/cells_sim.v": "", "share/icebox/chipdb-5k.txt": "", "share/trellis/database.json": "",
        "bin/ghdl": "",
    }
    for name in ("yosys", "yosys-abc", "nextpnr-ice40", "icepack", "iceprog", "iverilog", "vvp"):
        files[f"bin/{name}"] = ("#!/bin/sh\n" f'echo "suite-{name} $*" >> "$STUB_CALLS"\n'
                                f'case " $STUB_FAIL " in *" {name} "*) echo "{name}: stub failure"; exit 1;; esac\n'
                                + SMOKE.get(name, ""))
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(f"oss-cad-suite/{rel}")
            info.size, info.mode = len(data), 0o755
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class Doctor(unittest.TestCase):
    def doctor(self, sb, **kw):
        return sb.run([sb.pkg / "toolchain" / "doctor.sh"], **kw)

    def test_a_ready_machine(self):
        sb = Sandbox(self, stubs=("yosys", "nextpnr-ice40", "iverilog", "iceprog", "node"))
        prefix = sb.root / "icestorm"
        sb.stub("icepack", where=prefix / "bin")
        (sb.bin / "icepack").symlink_to(prefix / "bin" / "icepack")  # as Homebrew links it
        (prefix / "share" / "icestorm" / "chipdb").mkdir(parents=True)
        (prefix / "share" / "icestorm" / "chipdb" / "chipdb-5k.txt").write_text(".device 5k\n")
        sb.stub("netlistsvg", where=sb.pkg / "node_modules" / ".bin")
        r = self.doctor(sb)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(r.stdout.splitlines()[:8], [
            "ok   yosys, the synthesiser — Yosys 0.99 (stub)",
            "ok   nextpnr-ice40, place and route — nextpnr-ice40 -- Next Generation Place and Route (stub)",
            "ok   icepack, the bitstream packer (icestorm)",
            "ok   iverilog, the simulator — Icarus Verilog version 13.0 (stable)",
            "ok   iceprog, to flash a board over USB",
            "ok   netlistsvg 1.0.2, the schematic",
            "ok   node v22.0.0 for the viewer",
            "ok   IceStorm chipdb, for the pane's pin maps",
        ])
        self.assertTrue(r.stdout.splitlines()[8].startswith("ok   Python 3."))

    def test_the_oss_cad_suite_setup_fetched_comes_first(self):
        sb = Sandbox(self, stubs=("yosys", "nextpnr-ice40", "icepack", "iverilog", "node"))  # the machine's too
        sb.suite(release=RELEASE, chipdb=True)
        sb.stub("netlistsvg", where=sb.pkg / "node_modules" / ".bin")
        r = self.doctor(sb)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(r.stdout.splitlines()[:8], [
            "ok   yosys, the synthesiser — Yosys 0.99 (stub)",
            "ok   nextpnr-ice40, place and route — nextpnr-ice40 (stub)",
            "ok   icepack, the bitstream packer (icestorm)",
            "ok   iverilog, the simulator — Icarus Verilog version 13.0 (stable)",
            "ok   iceprog, to flash a board over USB",
            "ok   netlistsvg 1.0.2, the schematic",
            "ok   node v22.0.0 for the viewer",
            "ok   IceStorm chipdb, for the pane's pin maps",
        ])
        self.assertEqual([c.split()[0] for c in sb.called() if c.startswith("suite-")],
                         ["suite-yosys", "suite-nextpnr-ice40", "suite-iverilog"])

    def test_harnesss_own_node_serves_the_viewer(self):
        sb = Sandbox(self, stubs=("yosys", "nextpnr-ice40", "icepack", "iverilog"))
        sb.harness_node(SMOKE["node"])
        r = self.doctor(sb, hide=("iceprog",))
        self.assertIn("ok   node v22.0.0 for the viewer", r.stdout.splitlines())

    def test_a_bare_machine(self):
        sb = Sandbox(self)
        r = self.doctor(sb, hide=("yosys", "nextpnr-ice40", "icepack", "iverilog", "iceprog", "node", "python3"))
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.splitlines(), [
            "miss yosys — run toolchain/setup.sh",
            "miss nextpnr-ice40 — run toolchain/setup.sh",
            "miss icepack — run toolchain/setup.sh",
            "miss iverilog — run toolchain/setup.sh",
            "info iceprog not found — synthesis works, flashing a real board does not",
            "miss node_modules — run toolchain/setup.sh",
            sb.no_node(),
            "info IceStorm chipdb not found — the pane falls back to its built-in iCE40UP5K-SG48 pin table",
            "miss python3",
        ])

    def test_a_tool_that_is_installed_but_does_not_run_is_missing(self):
        sb = Sandbox(self, stubs=("nextpnr-ice40", "icepack"))
        sb.stub("yosys", body="")  # runs, prints nothing
        sb.stub("iverilog", body='echo "dyld[1]: Library not loaded: libexample.dylib"; exit 134\n')
        sb.stub("node", body='echo "node: Permission denied" >&2; exit 126\n')
        r = self.doctor(sb)
        self.assertEqual(r.returncode, 1)
        lines = r.stdout.splitlines()
        self.assertIn("miss yosys, the synthesiser", lines)
        self.assertIn("miss iverilog, the simulator", lines)
        self.assertIn(sb.no_node(), lines)
        self.assertIn("info IceStorm chipdb not found — the pane falls back to its built-in iCE40UP5K-SG48 pin table", lines)


class InitWorkspace(unittest.TestCase):
    def test_needs_the_install_dir(self):
        sb = Sandbox(self, stubs=ALL_FLOW)
        r = sb.run([sb.pkg / "toolchain" / "init-workspace.sh"])
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("HARNESS_DSH_DIR", r.stderr)

    def test_runs_the_flow_on_the_starter_and_keeps_its_log(self):
        sb = Sandbox(self, stubs=ALL_FLOW)
        sb.design()
        sb.stub("netlistsvg", where=sb.pkg / "node_modules" / ".bin")
        r = sb.run([sb.pkg / "toolchain" / "init-workspace.sh"], HARNESS_DSH_DIR=sb.pkg)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(r.stdout, "")
        self.assertIn("flow: blink  (--up5k --package sg48, 1 RTL file(s))", (sb.ws / "out" / "logs-init.txt").read_text())
        self.assertEqual(sb.exit_of("pack"), "0")
        verdict = json.loads((sb.ws / ".harness" / "verdict.json").read_text())
        self.assertTrue(verdict["ready"], (verdict, (sb.ws / "out" / "logs-init.txt").read_text()))

    def test_a_flow_that_cannot_run_still_seeds_a_verdict(self):
        sb = Sandbox(self)  # no tools at all, and an install with no flow.sh
        (sb.pkg / "toolchain" / "flow.sh").unlink()
        r = sb.run([sb.pkg / "toolchain" / "init-workspace.sh"], HARNESS_DSH_DIR=sb.pkg)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("flow.sh", (sb.ws / "out" / "logs-init.txt").read_text())
        verdict = json.loads((sb.ws / ".harness" / "verdict.json").read_text())
        self.assertEqual((verdict["ready"], verdict["artifact"]), (False, "out/blink.report.json"))


class ViewerSh(unittest.TestCase):
    def test_needs_a_port_and_a_workspace(self):
        sb = Sandbox(self, stubs=("node",))
        r = sb.run([sb.pkg / "viewer.sh"], HARNESS_WORKSPACE=sb.ws)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("HARNESS_VIEWER_PORT", r.stderr)
        r = sb.run([sb.pkg / "viewer.sh"], HARNESS_VIEWER_PORT=4100)
        self.assertIn("HARNESS_WORKSPACE", r.stderr)
        self.assertEqual(sb.called(), [])

    def test_runs_the_server_beside_it_from_anywhere(self):
        sb = Sandbox(self, stubs=("node", "yosys"))  # yosys visible: path.sh leaves Homebrew's bin out
        r = sb.run(["../install/viewer.sh"], HARNESS_VIEWER_PORT=4100, HARNESS_WORKSPACE=sb.ws)
        self.assertEqual(r.returncode, 0, r.stderr)
        [call] = sb.tools()
        node, server = call.split(" ", 1)
        self.assertEqual((node, os.path.realpath(server)), ("node", os.path.realpath(sb.pkg / "viewer.mjs")))
        self.assertTrue(os.path.isabs(server))

    def test_the_server_runs_with_the_suite_and_harnesss_own_node_on_path(self):
        sb = Sandbox(self)
        sb.harness_node('echo "PATH=$PATH" >> "$STUB_CALLS"\n')
        sb.suite(release=RELEASE, tools=("yosys", "icepack"))
        r = sb.run([sb.pkg / "viewer.sh"], HARNESS_VIEWER_PORT=4100, HARNESS_WORKSPACE=sb.ws)
        self.assertEqual(r.returncode, 0, r.stderr)
        path = sb.called()[-1].removeprefix("PATH=").split(":")
        # (runtimes.sh may put Harness's node dir in front more than once: once is what matters)
        self.assertEqual(list(dict.fromkeys(path)), [str(sb.root / "harness-node"), str(sb.pkg / "oss-cad-suite" / "bin"), str(sb.bin), str(sb.sys)])

    def test_no_node_anywhere_is_a_miss(self):
        sb = Sandbox(self)
        r = sb.run([sb.pkg / "viewer.sh"], HARNESS_VIEWER_PORT=4100, HARNESS_WORKSPACE=sb.ws, hide=("node",))
        self.assertEqual((r.returncode, r.stdout), (1, sb.no_node() + "\n"))


class Run(unittest.TestCase):
    """toolchain/run and path.sh, which flow.sh and doctor.sh share: the order the tools are found in."""

    def run_(self, sb, *argv, **kw):
        return sb.run([sb.pkg / "toolchain" / "run", *argv], **kw)

    def test_a_tool_with_its_arguments_and_exit_code(self):
        sb = Sandbox(self, stubs=("yosys",))
        sb.stub("iverilog", body='exit 3\n')
        r = self.run_(sb, "yosys", "-p", "read_verilog rtl/*.v; stat")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.run_(sb, "iverilog", "-o", "out/sim.vvp").returncode, 3)
        self.assertEqual(sb.tools(), ["yosys -p read_verilog rtl/*.v; stat", "iverilog -o out/sim.vvp"])

    def test_the_suite_first_then_the_machines_then_homebrews(self):
        sb = Sandbox(self, stubs=("yosys",))
        sb.suite(release=RELEASE, tools=("yosys",))
        self.run_(sb, "yosys", "-V")
        self.assertEqual(sb.called()[:2], ["yosys -V", "suite-yosys -V"])
        shutil.rmtree(sb.pkg / "oss-cad-suite")
        sb.stub("show-path", body='echo "PATH=$PATH" >> "$STUB_CALLS"\n')
        self.run_(sb, "show-path")
        self.assertEqual(sb.called()[-1], f"PATH={sb.bin}:{sb.sys}", "yosys is visible: PATH is left alone")
        self.run_(sb, "show-path", hide=("yosys",))
        self.assertEqual(sb.called()[-1], f"PATH={sb.bin}:{sb.sys}:/opt/homebrew/bin:/usr/local/bin", "after, so it shadows no node")

    def test_a_tool_that_is_not_there_or_no_tool_at_all(self):
        sb = Sandbox(self)
        r = self.run_(sb, "iceprog", "out/blink.bin", hide=("iceprog",))
        self.assertEqual((r.returncode, r.stdout), (127, "miss iceprog — run toolchain/setup.sh\n"))
        r = self.run_(sb)
        self.assertEqual(r.returncode, 2)
        self.assertIn('usage: "$YOSYS_TOOLCHAIN/run" <tool> [arguments…]', r.stderr)

    def test_the_flow_draws_with_harnesss_own_node_when_path_has_none(self):
        sb = Sandbox(self, stubs=ALL_FLOW)
        sb.design()
        sb.harness_node()
        sb.stub("netlistsvg", body='echo "node=$(command -v node)" >> "$STUB_CALLS"\necho "<svg/>" > "$3"\n',
                where=sb.pkg / "node_modules" / ".bin")
        sb.run([sb.pkg / "toolchain" / "flow.sh", "blink"])
        self.assertIn(f"node={sb.root / 'harness-node' / 'node'}", sb.called())


REAL = ("iverilog", "vvp", "yosys", "nextpnr-ice40", "icepack")
REAL_PATH = f"{os.environ.get('PATH', '')}:/opt/homebrew/bin:/usr/local/bin"


@unittest.skipUnless(all(shutil.which(t, path=REAL_PATH) for t in REAL), "the FPGA flow is not installed")
class RealFlow(unittest.TestCase):
    def test_the_starter_design_goes_all_the_way_to_a_bitstream(self):
        root = Path(tempfile.mkdtemp(prefix="yosys-flow-"))
        self.addCleanup(shutil.rmtree, root, True)
        ws = root / "ws"
        shutil.copytree(PKG / "template", ws)
        env = {k: v for k, v in os.environ.items() if k not in SCRUB}
        env.update(PATH=REAL_PATH)
        r = subprocess.run([str(PKG / "toolchain" / "flow.sh"), "blink"], cwd=ws, env=env,
                           capture_output=True, text=True, timeout=600)
        report = json.loads((ws / "out" / "blink.report.json").read_text())
        states = {s["id"]: s["state"] for s in report["steps"]}
        self.assertEqual({k: states[k] for k in ("sim", "waves", "synth", "schematic", "pnr", "pack")},
                         dict.fromkeys(("sim", "waves", "synth", "schematic", "pnr", "pack"), "done"), r.stdout[-3000:])
        self.assertTrue(report["simulation"]["passed"])
        self.assertGreater(report["synthesis"]["cells"], 0)
        self.assertEqual(report["pnr"]["utilization"][0]["id"], "ICESTORM_LC")
        self.assertGreater(report["bitstream"]["bytes"], 0)
        if (PKG / "node_modules" / ".bin" / "netlistsvg").exists():
            self.assertEqual(states["svg"], "done")
            self.assertTrue((ws / "out" / "blink.svg").read_text().lstrip().startswith("<svg"))
            self.assertTrue(report["ready"], report["findings"])
            self.assertEqual(r.returncode, 0)
        else:  # setup.sh has not been run in this checkout: the drawing is the one thing missing
            self.assertEqual([f["kind"] for f in report["findings"]], ["svg"])
            self.assertEqual(r.returncode, 1)


if __name__ == "__main__":
    unittest.main()
