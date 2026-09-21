#!/usr/bin/env bash
# The node cadgen runs its STL/3MF/GLB exporter and DXF snapshots under: harness.json points CADGEN_NODE
# here, because the agent's shell may have no node on PATH at all. This machine's Node 20+, else the
# Node Harness itself runs on. A miss goes to stderr, which cadgen puts in its error.
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=runtimes.sh
. "$DIR/runtimes.sh"
harness_node 20 >&2 || exit 1
exec node "$@"
