#!/bin/sh
set -u
echo "ok   isolated-web-viewer is the runtime (no native toolchain required)"
command -v node >/dev/null 2>&1 && echo "ok   node (for the headless proof)" || echo "warn node missing — headless proof won't run (map still works)"
exit 0
