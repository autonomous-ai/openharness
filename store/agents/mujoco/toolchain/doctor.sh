#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."; bad=0
# shellcheck disable=SC1091
. ./VERSIONS
if [ "$(uname -s)-$(uname -m)" = Darwin-x86_64 ]; then echo "miss mujoco ${MUJOCO} has no Intel Mac build — this harness needs an Apple Silicon Mac, or Linux"; exit 1; fi
if [ -x .venv/bin/python ] && .venv/bin/python -c 'import mujoco' 2>/dev/null; then echo "ok   mujoco $(.venv/bin/python -c 'import mujoco; print(mujoco.__version__)')"; else echo "miss .venv with mujoco — run toolchain/setup.sh"; bad=1; fi
if [ -f menagerie/unitree_go2/scene.xml ]; then echo "ok   menagerie @ $(cat menagerie/.harness-commit 2>/dev/null)"; else echo "miss menagerie — run toolchain/setup.sh"; bad=1; fi
if .venv/bin/python -c 'import jax, mujoco_playground' 2>/dev/null; then echo "ok   training extras (jax, mjx, playground)"; else echo "warn training extras not installed — toolchain/install-training.sh when a policy is wanted"; fi
exit $bad
