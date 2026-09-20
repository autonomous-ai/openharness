#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. toolchain/node.sh
exec "$LOCAL_AI_NODE" src/server.mjs
