#!/usr/bin/env bash
# Run in a fresh installed VM's hn pane after installing gcc/make on demand.
set -euo pipefail
REPORT_DIR="$HOME/.local/state/harness-os/development-check"
mkdir -p "$REPORT_DIR" "$HOME/projects/os-validation"
trap 'printf "%s\n" "$?" > "$REPORT_DIR/status"' EXIT
cd "$HOME/projects/os-validation"
git init -q
cat > main.c <<'C'
#include <stdio.h>
int main(void) { puts("harness-compiled-ok"); return 0; }
C
printf 'hello: main.c\n\t$(CC) -Wall -Wextra -Werror -O2 main.c -o hello\n' > Makefile
make
test "$(./hello)" = harness-compiled-ok
git add main.c Makefile
git diff --cached --check
cat > server.mjs <<'JS'
import http from 'node:http';
http.createServer((request, response) => {
  response.writeHead(200, {'content-type': 'text/html'});
  response.end('<!doctype html><title>Harness preview</title><h1>Local development works.</h1><p>Served by Node from an hn terminal pane.</p>');
}).listen(18781, '127.0.0.1');
JS
printf '%s\n' 'Compiled and ran C, checked a Git diff, and prepared a local Node preview.'
