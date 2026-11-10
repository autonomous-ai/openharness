#!/bin/sh
# The folder is the person's own (a project, their Pictures): nothing is copied into it. Only the header's first
# state is seeded, once, beside Harness's other files; a verdict already there is kept.
set -u
mkdir -p .harness
[ -f .harness/verdict.json ] || cat > .harness/verdict.json <<'JSON'
{ "spec": 1, "ready": true, "summary": "Files — pick one on the left", "findings": [] }
JSON
exit 0
