#!/usr/bin/env python3
"""Presses and photographs a native integration test's window from OUTSIDE it.

AppKit draws the tab row in the title bar, so a Flutter test cannot see or
press it. A test that wants the real controls (`integration_test/
sign_in_native_test.dart`) asks this driver, which runs beside it in the
terminal: macOS then counts accessibility and screen capture against the
terminal, which a developer has usually allowed, not against a debug build
nobody has.

    python3 tool/native_driver.py <request-dir> <shots-dir> &
    FLUTTER_TEST=1 HARNESS_NATIVE_DRIVER_DIR=<request-dir> \\
      HARNESS_NATIVE_SHOTS_DIR=<shots-dir> \\
      flutter test -d macos --no-pub integration_test/sign_in_native_test.dart

(`--no-enable-impeller` on an Intel Mac.) The test writes <request-dir>/pid,
then req-NNN.json {"cmd", "arg"}; this answers in res-NNN.json and ends when
<request-dir>/done appears. Commands: shot <name>, list, find <label>,
press <label>, tree, locked.

Every action names the test app by its pid: no other window or app is read,
pressed or photographed. With the screen locked macOS shows a driver neither
the controls nor the window; `locked` says so, and the test then sends the
row's actions through its channel instead.
"""
import glob
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def build_helper():
    """native_ax.swift, compiled once per source into the temp folder."""
    source = os.path.join(HERE, "native_ax.swift")
    stamp = str(int(os.path.getmtime(source)))
    binary = os.path.join(tempfile.gettempdir(), f"harness-native-ax-{stamp}")
    if not os.path.exists(binary):
        subprocess.run(["xcrun", "swiftc", "-O", source, "-o", binary], check=True)
    return binary


def screen_locked():
    done = subprocess.run(["ioreg", "-n", "Root", "-d1"], capture_output=True, text=True)
    return '"CGSSessionScreenIsLocked"=Yes' in done.stdout


def main():
    requests, shots = sys.argv[1:3]
    helper = sys.argv[3] if len(sys.argv) > 3 else build_helper()
    os.makedirs(requests, exist_ok=True)
    os.makedirs(shots, exist_ok=True)

    def ax(*argv):
        done = subprocess.run([helper, *argv], capture_output=True, text=True, timeout=90)
        try:
            return json.loads(done.stdout)
        except ValueError:
            return {"error": done.stderr.strip() or done.stdout.strip() or "no answer"}

    seen = set()
    deadline = time.time() + 1800
    while time.time() < deadline and not os.path.exists(os.path.join(requests, "done")):
        for path in sorted(glob.glob(os.path.join(requests, "req-*.json"))):
            if path in seen:
                continue
            try:
                with open(path) as file:
                    request = json.load(file)
            except ValueError:
                continue  # still being written
            seen.add(path)
            with open(os.path.join(requests, "pid")) as file:
                pid = file.read().strip()
            command, argument = request["cmd"], request.get("arg", "")
            if command == "locked":
                answer = {"locked": screen_locked()}
            elif command == "shot":
                window = ax("windowid", pid)
                target = os.path.join(shots, argument + ".png")
                if window.get("id") and not screen_locked():
                    subprocess.run(
                        ["screencapture", "-x", "-o", "-l", str(window["id"]), target],
                        timeout=60,
                    )
                answer = {"ok": os.path.exists(target), "bounds": window.get("bounds")}
            else:
                answer = ax(command, pid, *([argument] if argument else []))
            print(command, argument, "->", json.dumps(answer)[:240], flush=True)
            temporary = path.replace("req-", "tmp-")
            with open(temporary, "w") as file:
                json.dump(answer, file)
            os.rename(temporary, path.replace("req-", "res-"))
        time.sleep(0.05)
    print("native driver: finished", flush=True)


if __name__ == "__main__":
    main()
