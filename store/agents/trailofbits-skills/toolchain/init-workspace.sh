#!/usr/bin/env bash
# Runs once in a workspace, after Harness copies template/ (security-audit/findings.json) into it:
# render the empty report so the pane has a page, and seed the verdict so the header has a state.
exec "$(cd "$(dirname "$0")" && pwd)/report.sh"
