#!/usr/bin/env python3
"""Run the complete native TUI fixture set, two isolated fixtures at a time."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path, help="the already built TUI binary to test")
    args = parser.parse_args()
    binary = args.binary.resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error(f"not an executable TUI binary: {binary}")

    def fixture(name, variable, port_variable, port):
        return {
            "name": name,
            "cwd": "tui",
            "argv": ["env", f"{variable}={binary}", f"{port_variable}={port}",
                     sys.executable, "-u", f"tests/{name}.py"],
            "timeout_seconds": 120,
        }

    # The native checks from CI and the welcome journey, with the longest first. Each fixture uses
    # its own HOME, socket prefix, mock port(s), and cleanup. Two workers leave
    # capacity for their PTY children; deadlines and assertions are unchanged.
    checks = [
        fixture("reconnect", "HN_RECONNECT_TEST_BINARY", "HN_RECONNECT_TEST_PORT", 19781),
        fixture("layout-sync", "HN_LAYOUT_TEST_BINARY", "HN_LAYOUT_TEST_PORT", 19801),
        fixture("new-harness", "HN_NEW_UI_BINARY", "HN_NEW_UI_PORT", 19786),
        fixture("welcome", "HN_WELCOME_TEST_BINARY", "HN_WELCOME_TEST_PORT", 19787),
        fixture("local-shells", "HN_LOCAL_TEST_BINARY", "HN_LOCAL_TEST_PORT", 19441),
        fixture("native-terminal", "HN_NATIVE_TEST_BINARY", "HN_NATIVE_TEST_PORT", 19433),
        fixture("pane-ui", "HN_PANE_UI_BINARY", "HN_PANE_UI_PORT", 19783),
        fixture("viewer", "HN_VIEWER_TEST_BINARY", "HN_VIEWER_TEST_PORT", 19671),
        fixture("repaint", "HARNESS_TUI_BIN", "HN_REPAINT_TEST_PORT", 19794),
        {"name": "e2e", "cwd": "tui", "timeout_seconds": 120,
         "argv": ["env", f"HARNESS_TUI_BIN={binary}", "E2E_PORT=19297",
                  "HN_SOCKET_NAME=hn-ci-e2e", "bash", "tests/e2e.sh"]},
        {"name": "terminal-attributes", "cwd": "tui", "timeout_seconds": 120,
         "argv": ["env", "HN_ATTR_TEST_PORT=19412", sys.executable, "-u",
                  "tests/terminal-attributes.py", str(binary)]},
    ]
    folder = ROOT / ".harness"
    folder.mkdir(exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=folder, prefix="tui-native-", suffix=".json") as plan:
        json.dump({"reason": "Complete native TUI CI coverage with isolated fixtures", "checks": checks}, plan)
        plan.flush()
        return subprocess.call([sys.executable, str(ROOT / "scripts/validate-change.py"),
                                plan.name, "--jobs", "2"], cwd=ROOT)


if __name__ == "__main__":
    sys.exit(main())
