#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Two halves:
#
#   1. The open-source FPGA flow — yosys, nextpnr-ice40, icepack (IceStorm), iverilog (Icarus). A
#      machine that already has all four (Homebrew's, a distro's) keeps them. Otherwise YosysHQ's own
#      OSS CAD Suite build is fetched into oss-cad-suite/ here: one dated release, pinned and
#      checksummed per platform, relocatable, the same four tools on macOS and Linux, arm64 and x64.
#      No Homebrew, no sudo, nothing outside this folder. It unpacks to ~2 GB of every open-source EDA
#      tool there is; only the four tools and what they load are kept (~720 MB on macOS).
#   2. netlistsvg (and its elkjs layout engine) into this directory's node_modules, from the lockfile.
#
# Then a smoke run of the whole flow on a two-bit counter, so a tool that cannot run here is a miss at
# install rather than a failed step in the first workspace — and macOS's once-per-binary check of a new
# executable (most of a minute, for nextpnr's libraries) is paid here too, not in the user's first run.
#
# Why a dated suite release and not YoWASP wheels or conda-forge: YoWASP has no Icarus Verilog, and
# conda-forge has no nextpnr or IceStorm at all and no arm64 macOS build of yosys or iverilog. The
# suite's dated releases stay downloadable (2021's still are), so the pin does not rot.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh

SUITE_RELEASE=2026-09-16
TOOLS=(yosys nextpnr-ice40 icepack iverilog)
# What the flow runs, what those load, and the chip databases the pane's pin maps read. Relative to
# the suite's root; a path one platform's build does not have (Frameworks/ on Linux) is skipped.
KEEP=(VERSION license etc lib Frameworks share/yosys share/icebox \
      bin/yosys bin/yosys-abc bin/nextpnr-ice40 bin/icepack bin/iceprog bin/iverilog bin/vvp \
      libexec/realpath libexec/yosys libexec/yosys-abc libexec/nextpnr-ice40 libexec/icepack \
      libexec/iceprog libexec/iverilog libexec/vvp libexec/ivl libexec/ivlpp)
# Inside lib/: Python's own tests and packages (nextpnr embeds the interpreter, not its packages), and
# GHDL, Python 2, LLVM and Mesa, which none of the four load.
DROP=(lib/python3*/test lib/python3*/site-packages lib/python2* lib/ghdl lib/libghdl* lib/libLLVM* lib/libgallium* lib/dri)

have() { command -v "$1" >/dev/null 2>&1; }
suite_tmp=""; work=""
trap 'rm -rf ${suite_tmp:+"$suite_tmp"} ${work:+"$work"}' EXIT
sha256() { if have shasum; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }

harness_node 18 || exit 1
have npm || { echo "miss npm on PATH"; exit 1; }
have python3 || { echo "miss python3 (the VCD reader and the verdict)"; exit 1; }

# fetch_suite — oss-cad-suite/ at SUITE_RELEASE, or a miss line and nothing changed.
fetch_suite() {
  local platform sum mb asset url p
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=darwin-arm64 mb=521 sum=827b4d55246eab8146d5d508b9dd6c50924388516e961c92a01fe4cafe22edfb ;;
    Darwin-x86_64) platform=darwin-x64 mb=504 sum=d6c52a4cf8c051223e00e386a377b95353bf50622427f19e3feca088e010724f ;;
    Linux-x86_64) platform=linux-x64 mb=742 sum=88b3d97cffabe85c9491625318f86797f35573904df276a505ebd6963b0f75b3 ;;
    Linux-aarch64 | Linux-arm64) platform=linux-arm64 mb=680 sum=20e8d8058d62d829d71acc67540a2b1ad7b3acef2097f0f717e0be4fd4c82d17 ;;
    *) echo "miss ${missing[*]} — and the OSS CAD Suite has no build for $(uname -s) $(uname -m)"; return 1 ;;
  esac
  asset="oss-cad-suite-$platform-${SUITE_RELEASE//-/}.tgz"
  url="https://github.com/YosysHQ/oss-cad-suite-build/releases/download/$SUITE_RELEASE/$asset"
  echo "     fetching the OSS CAD Suite $SUITE_RELEASE for $platform (${mb} MB, a few minutes the first time)"
  # Unpacked beside the install, not in TMPDIR: the final move is then a rename, not a 2 GB copy. An
  # interrupted run's leftovers go first; the EXIT trap removes this run's, whatever happens.
  rm -rf .oss-cad-suite.*
  suite_tmp="$(mktemp -d "$PWD/.oss-cad-suite.XXXXXX")"
  if ! curl -fsSL --retry 3 --connect-timeout 20 --max-time 3600 -o "$suite_tmp/$asset" "$url"; then
    echo "miss could not download $url — check this machine's internet connection"; return 1
  fi
  if [ "$(sha256 "$suite_tmp/$asset")" != "$sum" ]; then
    echo "miss $url did not match its pinned checksum; nothing was installed"; return 1
  fi
  tar -xzf "$suite_tmp/$asset" -C "$suite_tmp" || { echo "miss the OSS CAD Suite archive would not unpack (is the disk full?)"; return 1; }
  mkdir "$suite_tmp/keep"
  for p in "${KEEP[@]}"; do
    [ -e "$suite_tmp/oss-cad-suite/$p" ] || continue
    mkdir -p "$suite_tmp/keep/$(dirname "$p")"
    mv "$suite_tmp/oss-cad-suite/$p" "$suite_tmp/keep/$p"
  done
  for p in "${DROP[@]}"; do rm -rf "$suite_tmp/keep/"$p; done
  echo "$SUITE_RELEASE" > "$suite_tmp/keep/.release"
  rm -rf oss-cad-suite
  mv "$suite_tmp/keep" oss-cad-suite
  echo "ok   OSS CAD Suite $SUITE_RELEASE in oss-cad-suite/ ($(du -sh oss-cad-suite | cut -f1 | tr -d ' '))"
}

missing=()
if [ -x oss-cad-suite/bin/yosys ] && [ "$(cat oss-cad-suite/.release 2>/dev/null)" = "$SUITE_RELEASE" ]; then
  echo "ok   OSS CAD Suite $SUITE_RELEASE already in oss-cad-suite/"
else
  # Homebrew's bin is not always on the PATH of a process the daemon spawned.
  have yosys || export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
  for t in "${TOOLS[@]}"; do have "$t" || missing+=("$t"); done
  if [ ${#missing[@]} -eq 0 ] && [ ! -d oss-cad-suite ]; then
    echo "ok   yosys, nextpnr-ice40, icepack, iverilog already on this machine"
  else
    # flow.sh prefers oss-cad-suite/ whenever it is there, so a stale one is replaced, not kept.
    [ ${#missing[@]} -eq 0 ] || echo "     this machine has no ${missing[*]}"
    fetch_suite || exit 1
  fi
fi
[ -x oss-cad-suite/bin/yosys ] && export PATH="$PWD/oss-cad-suite/bin:$PATH"

echo "     npm ci (netlistsvg $(node -p "require('./package.json').dependencies.netlistsvg"), for the schematic)"
npm ci --silent --no-audit --no-fund
[ -x node_modules/.bin/netlistsvg ] || { echo "miss node_modules/.bin/netlistsvg after npm ci"; exit 1; }

# smoke — simulate, synthesise, place and route, and pack a counter too small to take a second. Prints
# the tool that failed, if one did; its output is in $1/log.
smoke() {
  local d="$1"
  cat > "$d/c.v" <<'EOF'
module c(input clk, output led);
  reg [1:0] n = 0;
  always @(posedge clk) n <= n + 1;
  assign led = n[1];
endmodule
EOF
  cat > "$d/tb.v" <<'EOF'
module tb;
  reg clk = 0;
  wire led;
  c dut(.clk(clk), .led(led));
  initial begin repeat (8) #1 clk = !clk; $display("led %b", led); $finish; end
endmodule
EOF
  printf 'set_io clk 35\nset_io led 39\n' > "$d/c.pcf"
  iverilog -g2012 -o "$d/sim.vvp" "$d/c.v" "$d/tb.v" >"$d/log" 2>&1 || { echo iverilog; return 1; }
  vvp -n "$d/sim.vvp" >>"$d/log" 2>&1 || { echo vvp; return 1; }
  yosys -q -p "read_verilog $d/c.v; synth_ice40 -top c -json $d/c.json" >>"$d/log" 2>&1 || { echo yosys; return 1; }
  nextpnr-ice40 -q --up5k --package sg48 --json "$d/c.json" --pcf "$d/c.pcf" --asc "$d/c.asc" >>"$d/log" 2>&1 || { echo nextpnr-ice40; return 1; }
  icepack "$d/c.asc" "$d/c.bin" >>"$d/log" 2>&1 && [ -s "$d/c.bin" ] || { echo icepack; return 1; }
}

echo "     smoke run: a counter simulated, synthesised, placed, routed and packed (slow only the first time)"
work="$(mktemp -d "${TMPDIR:-/tmp}/yosys-smoke.XXXXXX")"
if ! failed="$(smoke "$work")"; then
  echo "miss $failed does not run on this machine: $(grep -v '^[[:space:]]*$' "$work/log" | tail -1)"
  exit 1
fi

echo "ok   $(yosys -V 2>&1 | head -1)"
echo "ok   nextpnr-ice40 · icepack · $(iverilog -V 2>&1 | head -1)"
echo "ok   netlistsvg $(node -p "require('netlistsvg/package.json').version") · node $(node -v)"
