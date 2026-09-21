#!/usr/bin/env python
"""Judge the workspace's notebook and write .harness/verdict.json (spec 1).

    python toolchain/verdict.py                 # notebook.py
    python toolchain/verdict.py analysis.py

Phases: Write (cells exist), Check (`marimo check` finds no errors — unused names, cycles, multiple
definitions), Run (the notebook runs top to bottom as a script without an exception). Ready = it
runs. The notebook is the artifact; the pane is marimo's editor on it.
"""
from __future__ import annotations
import ast, json, os, re, subprocess, sys, time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
PY = sys.executable
MARIMO = os.environ.get("MARIMO") or str(Path(PY).parent / "marimo")
# `marimo check` prints each issue as `critical[multiple-definitions]: message`, then ` --> file:line:col`
# and a code excerpt; critical (breaking) and error (runtime) are errors, warning is formatting.
DIAGNOSTIC = re.compile(r"^(critical|error|warning|info)\[([^\]]+)\]:\s*(.+)$")
WHERE = re.compile(r"^-->\s*.+:(\d+):(\d+)$")
EXCERPT = re.compile(r"^(\d+\s*)?\||^\.\.\.$|^hint:|^Found \d+ issues?\.$|^Updated \d+ files?\.$")


def count_cells(source: str) -> int:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return -1
    n = 0
    for node in ast.walk(tree):
        # Cells may be async; @app.class_definition decorates a class.
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for d in node.decorator_list:
                name = d.func if isinstance(d, ast.Call) else d
                if isinstance(name, ast.Attribute) and name.attr in ("cell", "function", "class_definition"):
                    n += 1
    return n


def judge(cells: int, check_out: str, check_code: int | None, run_err: str | None, run_code: int | None, rel: str) -> dict:
    findings: list[dict] = []
    if cells < 0:
        findings.append({"severity": "error", "kind": "syntax", "message": f"{rel} does not parse"})
    lines = [line.strip() for line in check_out.splitlines() if line.strip()]
    other = []  # what check printed besides issues: why it failed when there is no issue to show
    for i, line in enumerate(lines):
        issue = DIAGNOSTIC.match(line)
        if issue:
            sev = "error" if issue[1] in ("critical", "error") else issue[1]
            where = WHERE.match(lines[i + 1]) if i + 1 < len(lines) else None
            findings.append({"severity": sev, "kind": "check", "message": f"{issue[3]} ({issue[2]})"[:300], **({"ref": f"{rel}:{where[1]}:{where[2]}"} if where else {})})
        elif not WHERE.match(line) and not EXCERPT.match(line):
            other.append(line)
    if check_code not in (None, 0) and not any(f["severity"] == "error" and f["kind"] == "check" for f in findings):
        findings.append({"severity": "error", "kind": "check", "message": (other[-1] if other else f"marimo check exited {check_code}")[:300]})
    if run_code not in (None, 0):
        tail = (run_err or "").strip().splitlines()
        findings.append({"severity": "error", "kind": "run", "message": (tail[-1] if tail else f"the notebook exited {run_code}")[:300]})
    written = cells > 0
    errors = [f for f in findings if f["severity"] == "error"]
    checked = written and check_code == 0 and not any(f["kind"] in ("check", "syntax") for f in errors)
    ran = checked and run_code == 0
    phases = [
        {"id": "write", "name": "Write", "state": "done" if written else "active"},
        {"id": "check", "name": "Check", "state": ("done" if checked else "failed") if written else "pending"},
        {"id": "run", "name": "Run", "state": ("done" if ran else "failed") if checked else "pending"},
    ]
    bits = [Path(rel).name]
    if written:
        bits.append(f"{cells} cell{'s' if cells != 1 else ''}")
    bits.append("runs" if ran else (f"{len(errors)} error{'s' if len(errors) != 1 else ''}" if errors else ("no cells yet" if not written else "not run")))
    return {"spec": 1, "ready": bool(ran), "summary": " · ".join(bits), "findings": findings, "artifact": rel if written else None,
            "phases": phases, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def main(argv: list[str]) -> int:
    target = Path(argv[1]) if len(argv) > 1 else WS / "notebook.py"
    target = target if target.is_absolute() else WS / target
    rel = os.path.relpath(target, WS)
    source = target.read_text() if target.exists() else ""
    cells = count_cells(source) if source else 0
    check_out, check_code, run_err, run_code = "", None, None, None
    if cells > 0:
        try:
            r = subprocess.run([MARIMO, "check", str(target)], capture_output=True, text=True, cwd=WS, timeout=120)
            check_out, check_code = (r.stdout + r.stderr), r.returncode
        except (OSError, subprocess.TimeoutExpired) as error:
            check_out, check_code = f"error: marimo check could not run ({error})", 1
        if check_code == 0:
            try:
                r = subprocess.run([PY, str(target)], capture_output=True, text=True, cwd=WS, timeout=300)
                run_err, run_code = r.stderr, r.returncode
            except subprocess.TimeoutExpired:
                run_err, run_code = "the notebook did not finish within 5 minutes", 1
    verdict = judge(cells, check_out, check_code, run_err, run_code, rel)
    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for f in verdict["findings"]:
        print(f"  {f['severity']:<7} {f['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
