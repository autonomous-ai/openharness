#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."; bad=0
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
harness_node 18 >/dev/null; node_ok=$?  # PATH now names Harness's own Node when this machine has none
if [ -x node_modules/.bin/remotion ]; then echo "ok   remotion $(node -p "require('remotion/package.json').version")"; else echo "miss node_modules — run toolchain/setup.sh"; bad=1; fi
if [ -f upstream/skills/remotion-best-practices/SKILL.md ]; then echo "ok   skills @ $(cat upstream/.harness-commit 2>/dev/null)"; else echo "miss upstream skills — run toolchain/setup.sh"; bad=1; fi
if [ "$node_ok" != 0 ]; then harness_node 18; bad=1
elif [ -x toolchain/remotion ]; then echo "ok   \$REMOTION (render progress for the pane) · node $(node -v)"; else echo "miss an executable toolchain/remotion"; bad=1; fi
command -v python3 >/dev/null 2>&1 && echo "ok   $(python3 --version)" || { echo "miss python3"; bad=1; }
exit $bad
