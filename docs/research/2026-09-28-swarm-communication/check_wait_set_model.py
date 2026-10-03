#!/usr/bin/env python3
"""Check one proposed owner wait cycle over several necessary dependencies.

Finite abstract events, no providers. Registration includes an authorized yield;
native scheduling, remote propagation, arbitrary task graphs, and semantic
necessity are not modeled. A wait cycle permits one owner continuation.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from itertools import permutations
import json
from pathlib import Path


@dataclass(frozen=True)
class Outcome:
    kind: str = "pending"
    version: int = 0


@dataclass(frozen=True)
class Spec:
    awaited: tuple[str, ...]
    mode: str = "all"
    held: tuple[tuple[str, int], ...] = ()


@dataclass(frozen=True)
class Grant:
    serial: int
    cycle: int
    epoch: int
    spec: Spec


ANY = Spec(("a", "b"), "any")
ALL = Spec(("a", "b"), "all")
B_ONLY = Spec(("b",), "all")
B_WITH_CURRENT_A = Spec(("b",), "all", (("a", 1),))
ACTIONABLE = {"needs_parameter", "declined", "invalidated"}


@dataclass
class Owner:
    mutant: str = "none"
    epoch: int = 0
    active: bool = True
    native_idle: bool = True
    cycle: int = 0
    serial: int = 0
    outcomes: dict[str, Outcome] = field(default_factory=lambda: {"a": Outcome(), "b": Outcome()})
    grants: list[Grant] = field(default_factory=list)
    specs: dict[int, Spec] = field(default_factory=dict)
    ended: set[int] = field(default_factory=set)
    staged: tuple[Grant, dict[str, tuple[str, int]]] | None = None
    seen: set[tuple[str, int]] = field(default_factory=set)
    clarification_used: bool = False
    wakes: list[dict] = field(default_factory=list)
    inline: list[dict] = field(default_factory=list)
    conflicts: int = 0
    violations: list[str] = field(default_factory=list)
    trace: list[str] = field(default_factory=list)

    def needs_attention(self, spec: Spec) -> bool:
        return (
            any(self.outcomes[key].kind in ACTIONABLE for key in spec.awaited)
            or any(self.outcomes[key] != Outcome("answer", version) for key, version in spec.held)
        )

    def ready(self, spec: Spec) -> bool:
        if self.mutant != "ignore_attention" and self.needs_attention(spec):
            return True
        answered = [self.outcomes[key].kind == "answer" for key in spec.awaited]
        mode = "any" if self.mutant == "wake_all_on_first" else spec.mode
        return bool(answered) and (all(answered) if mode == "all" else any(answered))

    def payload(self, spec: Spec) -> dict[str, tuple[str, int]]:
        result = {
            key: (self.outcomes[key].kind, self.outcomes[key].version)
            for key in spec.awaited if self.outcomes[key].kind != "pending"
        }
        for key, version in spec.held:
            if self.outcomes[key] != Outcome("answer", version):
                result[key] = (self.outcomes[key].kind, self.outcomes[key].version)
        return result

    def observe(self, payload: dict[str, tuple[str, int]]) -> None:
        self.seen.update((key, version) for key, (_, version) in payload.items())

    def retire(self) -> None:
        self.ended.update(grant.cycle for grant in self.grants)
        self.grants.clear()

    def wait(self, spec: Spec) -> None:
        if not self.active:
            return
        current = self.grants[0] if self.grants else None
        if current and self.specs[current.cycle] != spec:
            # Do not guess whether different parallel calls mean any or all.
            self.conflicts += 1
            return
        if self.ready(spec):
            value = self.payload(spec)
            self.observe(value)
            self.inline.append(value)
            self.retire()
            self.native_idle = False
            return
        if current:
            return
        self.cycle += 1
        self.specs[self.cycle] = spec
        pieces = [spec]
        if self.mutant == "grant_per_dependency" and spec.mode == "any" and len(spec.awaited) > 1:
            pieces = [Spec((key,), "any") for key in spec.awaited]
        for piece in pieces:
            self.serial += 1
            self.grants.append(Grant(self.serial, self.cycle, self.epoch, piece))
        # Abstract supported register-and-yield, not a claim about native CLIs.
        self.native_idle = True

    def current(self, grant: Grant) -> bool:
        epoch_ok = grant.epoch == self.epoch or self.mutant == "retain_old_input"
        cycle_ok = grant.cycle not in self.ended or self.mutant == "grant_per_dependency"
        return self.active and epoch_ok and cycle_ok and grant in self.grants

    def stage(self) -> None:
        if not self.native_idle:
            return
        for grant in self.grants:
            if self.current(grant) and self.ready(grant.spec):
                self.staged = grant, self.payload(grant.spec)
                return

    def write(self) -> None:
        if self.staged is None or not self.native_idle:
            return
        grant, old_payload = self.staged
        if not self.current(grant) or not self.ready(grant.spec):
            return
        value = old_payload if self.mutant == "freeze_payload" else self.payload(grant.spec)
        original = self.specs[grant.cycle]
        if grant.epoch != self.epoch:
            self.violations.append("owner_resumed_after_input_changed")
        if grant.cycle in self.ended:
            self.violations.append("owner_wait_cycle_woke_twice")
        if value != self.payload(grant.spec):
            self.violations.append("outdated_outcome_at_write_boundary")
        if original.mode == "all" and not self.needs_attention(original):
            if any(self.outcomes[key].kind != "answer" for key in original.awaited):
                self.violations.append("all_wait_resumed_before_required_answers")
        self.observe(value)
        self.wakes.append({"cycle": grant.cycle, "epoch": grant.epoch, "outcomes": value})
        self.ended.add(grant.cycle)
        if self.mutant == "grant_per_dependency":
            self.grants.remove(grant)
        else:
            self.grants = [item for item in self.grants if item.cycle != grant.cycle]
        self.staged = None
        self.native_idle = False

    def step(self, event: str) -> None:
        self.trace.append(event)
        if event in {"wait_any", "wait_all", "wait_b", "wait_b_watch_a"}:
            self.wait({"wait_any": ANY, "wait_all": ALL, "wait_b": B_ONLY, "wait_b_watch_a": B_WITH_CURRENT_A}[event])
        elif event in {"answer_a", "answer_b"}:
            key = event[-1]
            before = self.outcomes[key]
            if before.kind in {"pending", "invalidated"}:
                self.outcomes[key] = Outcome("answer", before.version + 1)
        elif event == "clarify_a":
            before = self.outcomes["a"]
            if before.kind == "pending" and not self.clarification_used:
                self.clarification_used = True
                self.outcomes["a"] = Outcome("needs_parameter", before.version + 1)
        elif event == "parameter_a":
            before = self.outcomes["a"]
            if self.active and before.kind == "needs_parameter" and ("a", before.version) in self.seen:
                self.outcomes["a"] = Outcome("pending", before.version + 1)
        elif event in {"decline_a", "invalidate_a"}:
            before = self.outcomes["a"]
            expected = "pending" if event == "decline_a" else "answer"
            if before.kind == expected:
                self.outcomes["a"] = Outcome("declined" if event == "decline_a" else "invalidated", before.version + 1)
        elif event == "stage":
            self.stage()
        elif event == "write":
            self.write()
        elif event == "human":
            self.epoch += 1
            if self.mutant != "retain_old_input":
                self.retire()
        elif event == "owner_progress":
            self.retire()
            self.native_idle = False
        elif event == "owner_idle":
            self.native_idle = True
        elif event == "owner_done":
            self.active = False
            self.retire()
        elif event in {"inspect", "heartbeat", "peer_contribution"}:
            # Human inspection, liveness, and a completed unrelated contribution
            # neither deliver an awaited owner result nor create owner permission.
            pass
        else:
            raise ValueError(event)


def run(trace: tuple[str, ...], mutant: str = "none") -> Owner:
    owner = Owner(mutant=mutant)
    for event in trace:
        owner.step(event)
    return owner


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    families = {
        "any_coalesces_owner_resume": (("wait_any",), ("answer_a", "answer_b", "stage", "write", "owner_idle", "stage", "write")),
        "all_waits_for_both": (("wait_all",), ("answer_a", "answer_b", "stage", "write", "owner_idle", "stage", "write")),
        "failure_breaks_all_wait": (("wait_all",), ("decline_a", "answer_b", "stage", "write", "owner_idle", "stage", "write")),
        "clarification_breaks_all_wait": (("wait_all",), ("clarify_a", "answer_b", "stage", "write", "parameter_a", "wait_all", "stage", "write")),
        "current_fact_changes_while_waiting": (("answer_a", "wait_b_watch_a"), ("invalidate_a", "answer_b", "heartbeat", "inspect", "stage", "write")),
        "outcome_changes_after_staging": (("wait_all", "answer_a", "answer_b", "stage"), ("invalidate_a", "write", "heartbeat", "inspect")),
        "new_human_input": (("wait_any",), ("answer_a", "answer_b", "stage", "human", "write", "owner_idle", "stage", "write")),
        "owner_progress_ends_wait": (("wait_any",), ("answer_a", "answer_b", "stage", "owner_progress", "write", "owner_idle", "stage", "write")),
        "same_wait_is_idempotent": (("wait_all",), ("wait_all", "wait_all", "answer_a", "answer_b", "stage", "write")),
        "observation_is_not_owner_progress": (("answer_a", "wait_b_watch_a"), ("heartbeat", "inspect", "peer_contribution", "stage", "write")),
        "finished_owner_is_not_restarted": (("wait_all",), ("answer_a", "answer_b", "owner_done", "stage", "write")),
    }
    report = {
        "scope": "Finite abstract owner wait sets, not native adapter or policy-quality validation",
        "assumptions": [
            "Two already necessary admitted dependencies; their outcomes and context provenance are trusted abstract events",
            "A new wait cites dependencies already adopted under current authority; adoption and old tool-invocation authentication are outside this model",
            "Supported registration and authorized yield; native goal scheduling and arbitrary existing-terminal attachment are not exercised",
            "Current input, outcome, and wait state is visible at the serialized effect boundary",
            "Owner progress is distinguishable from a peer contribution; human inspection is not agent result delivery",
            "No remote propagation, crash recovery, real handle encoding, arbitrary dependency graph, or token cost is modeled",
        ],
        "families": {}, "positive_paths": {}, "counterexamples": {},
    }
    traces = []
    for name, (prefix, events) in families.items():
        variants = [prefix + seq for seq in sorted(set(permutations(events)))]
        for trace in variants:
            state = run(trace)
            assert not state.violations, (name, trace, state.violations)
            assert len(state.grants) <= 1, (name, trace, state.grants)
        report["families"][name] = {"traces": len(variants), "violations": 0}
        traces.extend((name, trace) for trace in variants)

    positives = {
        "any_batches_ready_results": (("wait_any", "answer_a", "answer_b", "stage", "write"), 1, 0),
        "any_does_not_leave_second_wake": (("wait_any", "answer_a", "stage", "write", "answer_b", "owner_idle", "stage", "write"), 1, 0),
        "remaining_dependency_needs_new_wait": (("wait_any", "answer_a", "stage", "write", "wait_b", "answer_b", "stage", "write"), 2, 0),
        "all_waits_for_complete_step": (("wait_all", "answer_a", "stage", "write", "answer_b", "stage", "write"), 1, 0),
        "all_returns_failure_promptly": (("wait_all", "decline_a", "stage", "write"), 1, 0),
        "all_returns_clarification_promptly": (("wait_all", "clarify_a", "stage", "write", "parameter_a", "answer_b", "wait_all", "answer_a", "stage", "write"), 2, 0),
        "tracked_mutable_fact_can_invalidate_wait": (("answer_a", "wait_b_watch_a", "invalidate_a", "stage", "write"), 1, 0),
        "untracked_change_does_not_create_a_wake": (("answer_a", "wait_b", "invalidate_a", "stage", "write"), 0, 0),
        "different_parallel_wait_is_explicit_conflict": (("wait_all", "wait_b"), 0, 0),
        "ready_set_returns_inline": (("answer_a", "answer_b", "wait_all", "stage", "write"), 0, 1),
        "owner_progress_retires_future_wake": (("wait_any", "owner_progress", "answer_a", "owner_idle", "stage", "write"), 0, 0),
        "inspection_and_peer_help_preserve_wait": (("wait_all", "inspect", "heartbeat", "peer_contribution", "answer_a", "answer_b", "stage", "write"), 1, 0),
        "write_uses_current_outcomes": (("wait_all", "answer_a", "answer_b", "stage", "invalidate_a", "write"), 1, 0),
    }
    for name, (trace, wakes, inline) in positives.items():
        state = run(trace)
        assert not state.violations and (len(state.wakes), len(state.inline)) == (wakes, inline), (name, state)
        if name == "any_batches_ready_results":
            assert set(state.wakes[0]["outcomes"]) == {"a", "b"}
        if name == "write_uses_current_outcomes":
            assert state.wakes[0]["outcomes"]["a"] == ("invalidated", 2)
        if name == "different_parallel_wait_is_explicit_conflict":
            assert state.conflicts == 1 and len(state.grants) == 1 and state.grants[0].spec == ALL
        report["positive_paths"][name] = {"events": list(trace), "owner_wakes": wakes, "inline_returns": inline, "wake_outcomes": state.wakes}

    wanted = {
        "grant_per_dependency": "owner_wait_cycle_woke_twice",
        "wake_all_on_first": "all_wait_resumed_before_required_answers",
        "freeze_payload": "outdated_outcome_at_write_boundary",
        "retain_old_input": "owner_resumed_after_input_changed",
    }
    for mutant, violation in wanted.items():
        for name, trace in traces:
            state = run(trace, mutant)
            if violation in state.violations:
                report["counterexamples"][mutant] = {"family": name, "events": state.trace, "violations": sorted(set(state.violations)), "owner_wakes": state.wakes}
                break
        assert mutant in report["counterexamples"], f"Missing counterexample for {mutant}"
    for positive in ("all_returns_failure_promptly", "all_returns_clarification_promptly", "tracked_mutable_fact_can_invalidate_wait"):
        trace = positives[positive][0]
        state = run(trace, "ignore_attention")
        assert len(state.wakes) == 0, (positive, state.wakes)
        report["counterexamples"][f"ignore_attention:{positive}"] = {
            "events": list(trace), "owner_wakes": 0,
            "kind": "liveness contrast; a necessary intervention remains hidden behind the all-results barrier",
        }
    report["total_traces"] = len(traces)
    report["violations"] = 0
    output = json.dumps(report, indent=2) + "\n"
    if args.out:
        args.out.write_text(output)
    print(output)


if __name__ == "__main__":
    main()
