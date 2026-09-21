#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."; bad=0
# The version pip recorded, and a pycairo that loads: quick, without importing Manim itself.
v="$(.venv/bin/python -c 'import cairo, importlib.metadata as m; print(m.version("manim"))' 2>/dev/null)"
if [ -n "$v" ]; then echo "ok   manim $v"; else echo "miss manim with pycairo in .venv — run toolchain/setup.sh"; bad=1; fi
if command -v latex >/dev/null 2>&1; then echo "ok   latex (Tex/MathTex available)"; else echo "warn latex not on PATH — Tex/MathTex scenes need a TeX distribution (MacTeX, TeX Live); Text() works without"; fi
exit $bad
