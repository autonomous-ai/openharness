#!/usr/bin/env bash
# Optional, minutes: MJX (MuJoCo on JAX), MuJoCo Playground (environments, PPO baselines for the
# Menagerie robots) and JAX for the CPU. On a Mac JAX runs on the CPU — fine for a smoke test, hours
# for a real policy; a GPU machine in Harness's Machines menu is where a run belongs.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. ./VERSIONS
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
[ -x .venv/bin/python ] || { echo "miss .venv — run toolchain/setup.sh first"; exit 1; }
# MJX releases with MuJoCo, version for version: pinned both, so the extras never move the MuJoCo
# setup.sh installed (an unpinned mujoco-mjx pulls the newest mujoco along with it).
harness_pip .venv "jax" "mujoco==${MUJOCO}" "mujoco-mjx==${MUJOCO}" "playground"
# mujoco_playground has no __version__: the version is the distribution's.
.venv/bin/python -c 'import jax; from mujoco import mjx; import mujoco_playground; from importlib.metadata import version; print("ok   jax", jax.__version__, "· mjx · playground", version("playground"), "· devices", jax.devices())'
