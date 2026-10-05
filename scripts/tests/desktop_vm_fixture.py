"""Synthetic Flutter JSON reporter/executable for process failure tests."""
import json
from pathlib import Path
import sys
import time

LOADER = "Unable to connect to flutter_tester process: WebSocketException: Invalid WebSocket upgrade request"


def suite(path, number=0, behavior="pass"):
    events = [{"type": "suite", "suite": {"id": number, "platform": "vm", "path": path}}]

    def start(tid, name, groups):
        return {"type": "testStart", "test": {"id": tid, "suiteID": number, "name": name, "groupIDs": groups}}

    def end(tid, result="success", hidden=False, skipped=False):
        return {"type": "testDone", "testID": tid, "result": result, "hidden": hidden, "skipped": skipped}

    load_id = number + 1
    events.append(start(load_id, f"loading {path}", []))
    if behavior == "loader":
        events.extend([{"type": "error", "testID": load_id, "error": f'Failed to load "{path}": {LOADER}', "isFailure": False},
                       end(load_id, "error")])
        return events
    events.extend([end(load_id, hidden=True),
                   {"type": "group", "group": {"id": number + 2, "suiteID": number, "parentID": None, "testCount": 2}}])
    for offset in [3, 4]:
        tid = number + offset
        events.append(start(tid, f"case {offset}", [number + 2]))
        if behavior == "incomplete" and offset == 4:
            return events
        if behavior == "assertion" and offset == 3:
            events.append({"type": "error", "testID": tid, "error": f'Failed to load "{path}": {LOADER}', "isFailure": True})
            events.append(end(tid, "failure"))
        else:
            events.append(end(tid, skipped=offset == 4))
    return events


def main():
    if "--version" in sys.argv:
        print('{"frameworkVersion":"fixture"}')
        return 0
    root = Path.cwd().parent
    state = root / ".harness"
    scenario = (state / "scenario").read_text()
    calls = state / "calls.jsonl"
    prior = calls.read_text().splitlines() if calls.exists() else []
    with calls.open("a") as stream:
        stream.write(json.dumps(sys.argv[1:]) + "\n")
    files = [arg for arg in sys.argv if arg.endswith("_test.dart")]
    if scenario == "timeout":
        time.sleep(30)
    successful = True
    for index, path in enumerate(files):
        behavior = "pass"
        if index == 0 and ((scenario in {"once", "edit", "budget"} and not prior) or scenario == "always"):
            behavior = "loader"
        if scenario == "assertion":
            behavior = "assertion"
        if scenario == "incomplete":
            behavior = "incomplete"
        for event in suite(path, index * 10, behavior):
            print(json.dumps(event), flush=True)
        successful &= behavior == "pass"
    if scenario == "edit":
        Path(files[0]).write_text("changed while running\n")
    if scenario == "budget":
        time.sleep(30)
    if scenario != "truncated":
        print(json.dumps({"type": "done", "success": successful}))
    return 0 if successful else 1


if __name__ == "__main__":
    sys.exit(main())
