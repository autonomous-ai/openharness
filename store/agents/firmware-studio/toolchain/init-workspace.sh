#!/bin/sh
set -u
mkdir -p .harness
cat > .harness/verdict.json <<'JSON'
{ "spec": 1, "ready": false, "summary": "Firmware workspace ready — describe a device to build",
  "findings": [], "artifact": null, "updatedAt": "2026-09-18T00:00:00Z" }
JSON
cat > build-status.html <<'HTML'
<!doctype html><meta charset="utf-8"><title>Firmware build</title>
<h1>Firmware Studio</h1><p>No build yet. Describe a device to get compiled, flashable firmware.</p>
HTML
printf 'Firmware workspace initialized by %s\n' "${HARNESS_DSH:-firmware-studio}" > .harness-initialized
