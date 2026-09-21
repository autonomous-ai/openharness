#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. One node_modules here — Phaser, Vite, terser — that
# every workspace links to, so a new game is instant and there is one copy of Phaser on the machine.
# Phaser's own agent skills are vendored in skills/ (MIT, see PROVENANCE.md), so nothing is fetched.
# Node is this machine's, or the one Harness itself runs on (npm comes beside it).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. ./VERSIONS
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
harness_node 18 || exit 1
command -v npm >/dev/null 2>&1 || { echo "miss npm beside $(command -v node)"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "miss python3 (the verdict)"; exit 1; }
echo "     npm ci (phaser ${PHASER} + vite ${VITE}, about a minute the first time)"
if [ -f package-lock.json ]; then npm ci --silent --no-audit --no-fund; else npm install --silent --no-audit --no-fund; fi
# Before any ok: npm succeeds without Vite when dev dependencies are omitted (NODE_ENV=production).
[ -x node_modules/.bin/vite ] || { echo "miss node_modules/.bin/vite"; exit 1; }
echo "ok   phaser $(node -p "require('./node_modules/phaser/package.json').version")"
echo "ok   vite $(node -p "require('./node_modules/vite/package.json').version")"
[ -f skills/scenes/SKILL.md ] || { echo "miss skills/ — the checkout is incomplete"; exit 1; }
echo "ok   skills: $(find skills -name SKILL.md | wc -l | tr -d ' ') ($(find skills -mindepth 1 -maxdepth 1 -type d ! -name harness-phaser | wc -l | tr -d ' ') from phaserjs/phaser @ ${SKILLS_COMMIT:0:7}, plus harness-phaser)"
