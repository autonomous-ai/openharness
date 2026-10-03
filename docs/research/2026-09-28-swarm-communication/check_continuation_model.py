#!/usr/bin/env python3
"""Explore a proposed idle-resume contract without running agents or production code.

This checks an abstract protocol, not autonomous necessity, adapter behavior, or
token savings. Mutants deliberately remove guarantees to produce counterexamples.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from itertools import permutations
import json
from pathlib import Path


@dataclass(frozen=True)
class Grant:
    serial: int
    input_generation: int
    session_generation: int
    membership_generation: int


@dataclass
class Model:
    mutant: str = "none"
    input_generation: int = 0
    session_generation: int = 0
    membership_generation: int = 0
    enabled: bool = True
    member: bool = True
    draft: bool = False
    approval: bool = False
    busy: bool = False
    expired: bool = False
    needed: bool = True
    result: bool = False
    task_complete: bool = False
    grant: Grant | None = None
    staged: Grant | None = None
    spent: set[int] = field(default_factory=set)
    revoked: set[int] = field(default_factory=set)
    attempted: dict[int, int] = field(default_factory=dict)
    unknown: Grant | None = None
    serial: int = 0
    violations: list[str] = field(default_factory=list)
    trace: list[str] = field(default_factory=list)
    writes: int = 0

    def revoke(self) -> None:
        if self.grant:
            self.revoked.add(self.grant.serial)
        self.grant = None

    def valid(self, grant: Grant) -> bool:
        return (
            self.enabled and self.member and not self.expired
            and self.needed and not self.task_complete and self.result
            and not self.draft and not self.approval and not self.busy
            and self.grant == grant and grant.serial not in self.spent
            and grant.input_generation == self.input_generation
            and grant.session_generation == self.session_generation
            and grant.membership_generation == self.membership_generation
        )

    def dispatch(self, grant: Grant, uncertain: bool = False) -> None:
        # The monitor observes actual dispatch attempts separately from the
        # admission decision. These properties define the proposed contract.
        if grant.input_generation != self.input_generation:
            self.violations.append("resume_after_new_human_input")
        if grant.session_generation != self.session_generation:
            self.violations.append("resume_into_replacement_session")
        if not self.member or grant.membership_generation != self.membership_generation:
            self.violations.append("resume_after_membership_changed")
        if not self.enabled:
            self.violations.append("resume_while_disabled")
        if not self.needed or self.task_complete or self.expired:
            self.violations.append("resume_without_live_dependency")
        if self.grant != grant:
            self.violations.append("resume_without_current_grant")
        if grant.serial in self.revoked:
            self.violations.append("resume_with_revoked_grant")
        if self.draft or self.approval or self.busy:
            self.violations.append("resume_at_unsafe_input_boundary")
        if not self.result:
            self.violations.append("resume_without_result")
        self.attempted[grant.serial] = self.attempted.get(grant.serial, 0) + 1
        if self.attempted[grant.serial] > 1:
            self.violations.append("repeated_dispatch_of_one_grant")
        self.writes += 1
        self.unknown = grant if uncertain else None

    def step(self, event: str) -> None:
        self.trace.append(event)
        if event == "wait":
            # Explicit waiting grants a future resume. If the result already
            # exists, return it to this caller instead of scheduling a wake.
            if self.result:
                self.needed = False
                self.revoke()
            elif self.enabled and self.member and not self.expired and not self.task_complete:
                self.serial += 1
                self.grant = Grant(self.serial, self.input_generation,
                                   self.session_generation, self.membership_generation)
        elif event == "result":
            self.result = True
        elif event == "stage":
            if self.grant and self.valid(self.grant):
                self.staged = self.grant
        elif event in ("write", "write_uncertain"):
            grant = self.staged
            if grant and (self.valid(grant) or self.mutant == "admission_only"):
                # Reservation is durable before crossing the side-effect boundary.
                if grant.serial in self.spent and self.mutant != "admission_only":
                    return
                self.spent.add(grant.serial)
                self.dispatch(grant, uncertain=event == "write_uncertain")
                self.staged = None
        elif event == "human":
            self.input_generation += 1
            self.revoke()
        elif event == "complete":
            self.task_complete = True
            self.revoke()
        elif event == "read":
            if self.result:
                self.needed = False
                self.revoke()
        elif event == "expire":
            self.expired = True
            self.revoke()
        elif event == "off":
            self.enabled = False
            self.revoke()
        elif event == "on":
            self.enabled = True
            if self.mutant == "rearm_on_enable" and self.staged:
                self.grant = self.staged
        elif event == "leave":
            self.member = False
            self.membership_generation += 1
            self.revoke()
        elif event == "join":
            self.member = True
        elif event == "replace_session":
            self.session_generation += 1
            self.revoke()
        elif event == "daemon_restart":
            self.revoke()
            # Preserve spent reservations and unknown outcomes across restarts.
        elif event == "retry_unknown":
            if self.mutant == "retry_unknown" and self.unknown:
                self.dispatch(self.unknown, uncertain=True)
        elif event == "draft":
            self.draft = True
        elif event == "clear_draft":
            self.draft = False
        elif event == "approval":
            self.approval = True
        elif event == "clear_approval":
            self.approval = False
        elif event == "busy":
            self.busy = True
        elif event == "idle":
            self.busy = False
        else:
            raise ValueError(event)


def trace_families() -> dict[str, list[tuple[str, ...]]]:
    # Each family exhausts the unique permutations of its events after an
    # explicit pending wait. Invalid actions are harmless no-ops. Repeated
    # stage/write operations exercise retries, including after a condition clears.
    events = {
        "new_input": ("result", "stage", "human", "write", "stage", "write"),
        "finished_task": ("result", "stage", "complete", "write", "stage", "write"),
        "read_before_wake": ("result", "stage", "read", "write", "stage", "write"),
        "deadline": ("result", "stage", "expire", "write", "stage", "write"),
        "disable_enable": ("result", "stage", "off", "on", "write", "stage", "write"),
        "leave_rejoin": ("result", "stage", "leave", "join", "write", "stage", "write"),
        "session_replacement": ("result", "stage", "replace_session", "write", "stage", "write"),
        "daemon_restart": ("result", "stage", "daemon_restart", "write", "stage", "write"),
        "draft_boundary": ("result", "stage", "draft", "clear_draft", "write", "stage", "write"),
        "approval_boundary": ("result", "stage", "approval", "clear_approval", "write", "stage", "write"),
        "busy_boundary": ("result", "stage", "busy", "idle", "write", "stage", "write"),
        "duplicate_delivery": ("result", "stage", "write", "stage", "write"),
        "uncertain_retry": ("result", "stage", "write_uncertain", "daemon_restart", "retry_unknown", "write"),
        "wait_after_result": ("result", "wait", "stage", "write", "read"),
    }
    return {name: sorted(set(permutations(items))) for name, items in events.items()}


def run_trace(events: tuple[str, ...], mutant: str = "none") -> Model:
    model = Model(mutant=mutant)
    model.step("wait")
    for event in events:
        model.step(event)
    return model


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    families = trace_families()
    report: dict = {
        "scope": "Abstract idle-resume contract; not production or model-behavior validation",
        "method": "Exhaustive unique event permutations within 14 bounded scenario families",
        "assumptions": [
            "One already-admitted dependency and one matching result; content, routing, and permission judgments are outside this model",
            "External state changes and actual dispatch share a serialized destination boundary",
            "A new explicit wait after human input also represents authorized adoption of the existing dependency",
            "A dispatch attempt may have reached the engine; uncertainty never proves safe replay",
        ],
        "families": {}, "counterexamples": {},
    }
    for name, traces in families.items():
        failures = []
        writes = 0
        for trace in traces:
            result = run_trace(trace)
            writes += result.writes
            if result.violations:
                failures.append({"events": result.trace, "violations": result.violations})
        report["families"][name] = {"traces": len(traces), "failures": len(failures), "dispatches": writes}
        if failures:
            raise AssertionError(json.dumps(failures[0]))

    # Explicit success paths ensure the gate has not achieved safety merely by
    # forbidding every wake. Also verify wait-after-result returns inline.
    for trace in [
        ("result", "stage", "write"),
        ("result", "draft", "stage", "clear_draft", "stage", "write"),
        ("human", "wait", "result", "stage", "write"),
    ]:
        result = run_trace(trace)
        assert result.writes == 1 and not result.violations, (trace, result)
    result = run_trace(("result", "wait", "stage", "write"))
    assert result.writes == 0 and not result.needed
    report["positive_paths"] = 4

    for mutant in ["admission_only", "rearm_on_enable", "retry_unknown"]:
        for name, traces in families.items():
            example = next((m for t in traces if (m := run_trace(t, mutant)).violations), None)
            if example:
                report["counterexamples"][mutant] = {
                    "family": name, "events": example.trace,
                    "violations": sorted(set(example.violations)),
                }
                break
        assert mutant in report["counterexamples"], f"Undetected mutant: {mutant}"
    report["total_traces"] = sum(v["traces"] for v in report["families"].values())
    report["failures"] = 0
    output = json.dumps(report, indent=2) + "\n"
    if args.out:
        args.out.write_text(output)
    print(output)


if __name__ == "__main__":
    main()
