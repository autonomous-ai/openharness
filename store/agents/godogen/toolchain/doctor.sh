#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. ./VERSIONS
. toolchain/runtimes.sh
harness_node 22.12 || exit 1
[ "$(git -C upstream rev-parse HEAD)" = "$GODOGEN_COMMIT" ]
[ -f runtime/babylon.md ] && [ -f runtime/.claude/skills/asset-gen/SKILL.md ]
node --input-type=module -e 'await import("vite"); await import("@babylonjs/core/Engines/engine.js"); console.log("ok   Babylon.js and Vite")'
[ -x node_modules/.bin/tsc ]
echo 'ok   Godogen workflow, asset skill, TypeScript, and playable starter'
echo 'info Generated assets are optional; provider keys and budget are needed only when you request them.'
