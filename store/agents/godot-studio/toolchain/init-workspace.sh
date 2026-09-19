#!/bin/sh
set -u
mkdir -p .harness
cat > .harness/verdict.json <<'JSON'
{ "spec": 1, "ready": false, "summary": "Godot workspace ready — describe a game to make",
  "findings": [], "artifact": null, "updatedAt": "2026-09-18T00:00:00Z" }
JSON
cat > build-status.html <<'HTML'
<!doctype html><meta charset="utf-8"><title>Godot build</title>
<h1>Godot Studio</h1><p>No export yet. Describe a game — a playable build will appear here.</p>
HTML
printf 'Godot workspace initialized by %s\n' "${HARNESS_DSH:-godot-studio}" > .harness-initialized
