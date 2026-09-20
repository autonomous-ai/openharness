#!/bin/sh
# Exit 0 when this machine can run the harness.
set -u
dsh="${HARNESS_DSH_DIR:-$PWD}"
fail=0
if [ -n "${PIO_BIN:-}" ] && [ -x "$PIO_BIN" ]; then
  echo "ok   pio at $PIO_BIN"
elif command -v pio >/dev/null 2>&1; then
  echo "ok   pio on PATH ($(command -v pio))"
elif [ -x "$dsh/.venv/bin/pio" ]; then
  echo "ok   pio vendored at $dsh/.venv/bin/pio"
else
  echo "miss pio — run toolchain/setup.sh (vendors PlatformIO)"
  fail=1
fi
[ -d "$dsh/skills/firmware" ] && echo "ok   firmware skill" || echo "warn firmware skill missing"
exit $fail
