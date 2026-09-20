"""`.harness/verdict.json` — the pane's header, written at every phase change and every check.

It is a feed, not a gate. The header has to move while the work happens, so every command that
changes anything writes one of these before it returns.
"""
from __future__ import annotations

import json
from pathlib import Path

from .project import Project, utcnow

SPEC = 1


def _finding(raw: dict) -> dict:
    out = {
        "severity": raw.get("severity", "info"),
        "kind": raw.get("kind", "note"),
        "message": str(raw.get("message", ""))[:400],
    }
    if raw.get("ref"):
        out["ref"] = str(raw["ref"])[:200]
    return out


def write(project: Project, *, summary: str, findings: list[dict] | None = None,
          ready: bool = False, artifact: str | None = None, done: bool = False,
          failed: bool = False, progress: dict | None = None,
          evaluation: list[dict] | None = None) -> dict:
    from . import checks

    findings = list(findings or [])
    payload = {
        "spec": SPEC,
        "ready": bool(ready),
        "summary": summary[:200],
        "findings": [_finding(f) for f in findings[:40]],
        "phases": project.phase_states(done=done, failed=failed),
        "evaluation": evaluation if evaluation is not None else checks.evaluation(project, findings),
        "updatedAt": utcnow(),
    }
    if artifact:
        payload["artifact"] = artifact
    if progress:
        payload["progress"] = progress
    out = Path(project.root) / ".harness"
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "verdict.json.part"
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(out / "verdict.json")
    return payload


def counts(findings: list[dict]) -> tuple[int, int]:
    errors = sum(1 for f in findings if f.get("severity") == "error")
    warnings = sum(1 for f in findings if f.get("severity") == "warning")
    return errors, warnings
