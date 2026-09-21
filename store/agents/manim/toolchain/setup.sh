#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. One environment in .venv with the pinned Manim Community
# release. pycairo has no wheel on PyPI for macOS or Linux, and manimpango none for Linux: both build
# from source against a cairo and a pango this machine may not have. So the environment is conda-forge's
# Python with its pycairo and manimpango (the libraries inside it), and Manim goes in on top from PyPI,
# which leaves those two as they are. No ffmpeg binary is needed: PyAV carries its own FFmpeg libraries.
# LaTeX is optional (only for Tex/MathTex).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
VERSION="$(cat MANIM_VERSION)"
# An environment that already has this Manim and a pycairo that loads is kept, however it was made
# (a venv on Homebrew's cairo included): nothing to fetch.
if .venv/bin/python -c 'import sys, cairo, manim; sys.exit(manim.__version__ != sys.argv[1])' "$VERSION" >/dev/null 2>&1; then
  echo "ok   manim ${VERSION} already in .venv"
  exit 0
fi
# Manim needs Python 3.11+. A .venv on an older one, or whose pycairo no longer loads (its
# cairo uninstalled), is made again.
if ! .venv/bin/python -c 'import sys, cairo; sys.exit(sys.version_info < (3, 11))' >/dev/null 2>&1; then
  echo "     python 3.12, pycairo and manimpango from conda-forge into .venv (a few minutes the first time)"
  rm -rf .venv
  harness_conda_env .venv python=3.12 pycairo manimpango pip || exit 1
fi
echo "ok   $(.venv/bin/python --version) with pycairo in .venv"
echo "     installing manim ${VERSION} (a couple of minutes the first time)"
harness_pip .venv "manim==${VERSION}" || { echo "miss manim ${VERSION} would not install into .venv"; exit 1; }
echo "ok   manim $(.venv/bin/manim --version 2>/dev/null | head -1)"
