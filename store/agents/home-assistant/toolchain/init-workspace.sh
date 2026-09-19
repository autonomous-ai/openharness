#!/bin/sh
# Runs once in a fresh workspace (cwd = the workspace) after the template copy.
# Seeds the first verdict and a placeholder dashboard so the pane has something to show.
set -u
mkdir -p .harness
cat > .harness/verdict.json <<'JSON'
{ "spec": 1, "ready": false, "summary": "Home Assistant workspace ready — describe an automation to write",
  "findings": [], "artifact": null, "updatedAt": "2026-09-18T00:00:00Z" }
JSON
cat > dashboard.html <<'HTML'
<!doctype html><meta charset="utf-8"><title>Automations</title>
<h1>Home Assistant</h1><p>No automations built yet. Describe one — each rule will appear here.</p>
HTML
printf 'Home Assistant workspace initialized by %s\n' "${HARNESS_DSH:-home-assistant}" > .harness-initialized
