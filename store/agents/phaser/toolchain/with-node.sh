#!/usr/bin/env bash
# with-node.sh CMD [ARG…] — CMD with a node >= 18 on PATH: this machine's, else the one Harness itself
# runs on. The verdict is run with python3 from the agent's shell, which may have no node at all.
# No node anywhere is exit 127, as for a command not found, with runtimes.sh's miss line on stderr.
# shellcheck source=runtimes.sh
. "${0%/*}/runtimes.sh"
harness_node 18 >&2 || exit 127
exec "$@"
