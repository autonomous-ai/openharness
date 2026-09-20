#!/bin/sh
# Install/verify PlatformIO for this harness. cwd = the package install dir.
set -u
dsh="${HARNESS_DSH_DIR:-$PWD}"
if [ -n "${PIO_BIN:-}" ]; then
  [ -x "$PIO_BIN" ] || { echo "miss PIO_BIN is not executable"; exit 1; }
  echo "ok   pio at $PIO_BIN"; exit 0
fi
if command -v pio >/dev/null 2>&1; then
  echo "ok   pio on PATH ($(command -v pio))"; exit 0
fi
if [ -x "$dsh/.venv/bin/pio" ]; then
  echo "ok   pio vendored at $dsh/.venv/bin/pio"; exit 0
fi
echo "miss pio — vendoring PlatformIO into .venv (first run downloads it)..."
bash -c '. "$1"; harness_venv "$2" 3.12 3.10 || exit 1; "$2/bin/python" -m pip install "platformio==6.1.18"' _ "$dsh/toolchain/runtimes.sh" "$dsh/.venv" || { echo "miss managed PlatformIO setup failed — check network"; exit 1; }
[ -x "$dsh/.venv/bin/pio" ] || { echo "miss pio still missing after install"; exit 1; }
echo "ok   pio vendored at $dsh/.venv/bin/pio"
