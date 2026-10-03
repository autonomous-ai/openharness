#!/usr/bin/env python3
"""Check a proposed two-sided brief-ask lifecycle without running providers.

One necessary, admitted ask, one optional clarification, serialized current
state at delivery boundaries. Semantics, remote propagation, native adapters,
rerouting, accepted work, and total usage remain outside this finite model.
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
    epoch: int
    after: int


@dataclass
class Exchange:
    mutant: str = "none"
    phase: str = "queued"
    source_epoch: int = 0
    source_scope: str = "A"
    bound_epoch: int = 0
    active_need: bool = True
    live: bool = True
    recipient_epoch: int = 0
    recipient_owner_scope: str = "B"
    recipient_busy: bool = False
    contribution_epoch: int | None = None
    initial_receipt: str = "none"
    initial_stage: tuple[int, int] | None = None
    initial_attempts: int = 0
    clarification_count: int = 0
    parameter_ready: bool = False
    recipient_saw_parameter: bool = False
    outcome_version: int = 0
    outcomes: dict[int, str] = field(default_factory=dict)
    source_seen: int = 0
    source_serial: int = 0
    recipient_serial: int = 0
    source_grant: Grant | None = None
    recipient_grant: Grant | None = None
    source_stage: tuple[Grant, int] | None = None
    recipient_stage: tuple[Grant, int] | None = None
    source_writes: list[tuple[int, int]] = field(default_factory=list)
    recipient_writes: list[int] = field(default_factory=list)
    violations: list[str] = field(default_factory=list)
    trace: list[str] = field(default_factory=list)

    def source_current(self) -> bool:
        return self.live and self.active_need and self.source_scope == "A" and self.bound_epoch == self.source_epoch

    def recipient_current(self) -> bool:
        return not self.recipient_busy and self.contribution_epoch == self.recipient_epoch

    def ready_for_source(self) -> bool:
        if self.mutant == "ignore_outcome_stage":
            return self.outcome_version > 0
        return self.phase in {"needs_parameter", "answered"}

    def observe_source(self, version: int) -> None:
        kind = self.outcomes.get(version)
        if kind == "clarification" and self.phase != "needs_parameter":
            self.violations.append("obsolete_clarification_returned_after_parameter")
        if kind == "answer" and self.phase != "answered":
            self.violations.append("answer_returned_in_wrong_stage")
        self.source_seen = max(self.source_seen, version)

    def wait_source(self) -> None:
        if not self.source_current():
            return
        if self.ready_for_source():
            self.observe_source(self.outcome_version)
            self.source_grant = None
            return
        after = self.outcome_version
        old = self.source_grant
        same = old is not None and old.epoch == self.source_epoch and old.after == after
        if same and self.mutant != "renew_pending_wait":
            return
        self.source_serial += 1
        self.source_grant = Grant(self.source_serial, self.source_epoch, after)
        if same:
            self.violations.append("identical_pending_wait_reissued_grant")

    def wait_recipient(self) -> None:
        if not self.source_current() or not self.recipient_current() or self.phase not in {"needs_parameter", "awaiting_answer"}:
            return
        if self.parameter_ready:
            self.recipient_saw_parameter = True
            self.recipient_grant = None
            return
        if self.recipient_grant and self.recipient_grant.epoch == self.recipient_epoch:
            return
        self.recipient_serial += 1
        self.recipient_grant = Grant(self.recipient_serial, self.recipient_epoch, 0)

    def initial_write(self, uncertain: bool = False) -> None:
        envelope = self.initial_stage
        if envelope is None:
            return
        source_epoch, recipient_epoch = envelope
        source_ok = self.source_current() and source_epoch == self.source_epoch
        recipient_ok = not self.recipient_busy and recipient_epoch == self.recipient_epoch
        allowed = (
            self.phase == "queued" and self.initial_receipt == "none"
            and recipient_ok
            and (source_ok or self.mutant == "omit_source_revalidation")
        )
        if not allowed:
            # Known pre-write rejection can be staged again; no effect occurred.
            self.initial_stage = None
            return
        # Effect monitor is separate from the admission decision.
        if not source_ok:
            self.violations.append("initial_contact_after_source_authority_changed")
        if not recipient_ok:
            self.violations.append("initial_contact_at_stale_recipient_boundary")
        if self.initial_attempts:
            self.violations.append("initial_contact_replayed")
        self.initial_attempts += 1
        self.initial_receipt = "uncertain" if uncertain else "consumed"
        self.phase = "uncertain" if uncertain else "serving"
        self.contribution_epoch = recipient_epoch
        self.initial_stage = None
        if self.mutant == "overwrite_owner_scope":
            self.recipient_owner_scope = "A"

    def source_write(self) -> None:
        if self.source_stage is None:
            return
        grant, version = self.source_stage
        generation_ok = self.source_current() and grant.epoch == self.source_epoch
        grant_ok = self.source_grant == grant
        stage_ok = self.ready_for_source() and version == self.outcome_version and version > grant.after
        if self.mutant == "ignore_outcome_stage":
            stage_ok = version in self.outcomes
        if not (generation_ok and grant_ok and stage_ok):
            return
        if version <= grant.after:
            self.violations.append("source_wake_replayed_handled_outcome")
        if any(old_version == version for _, old_version in self.source_writes):
            self.violations.append("source_outcome_woke_twice")
        self.observe_source(version)
        self.source_writes.append((grant.serial, version))
        self.source_grant = None
        self.source_stage = None

    def recipient_write(self) -> None:
        if self.recipient_stage is None:
            return
        grant, staged_source_epoch = self.recipient_stage
        recipient_ok = self.recipient_current() and grant.epoch == self.recipient_epoch
        allowed = (
            self.source_current() and staged_source_epoch == self.source_epoch
            and self.parameter_ready and self.phase == "awaiting_answer"
            and self.recipient_grant == grant
            and (recipient_ok or self.mutant == "omit_recipient_revalidation")
        )
        if not allowed:
            return
        if not recipient_ok:
            self.violations.append("parameter_wake_after_recipient_input_changed")
        if self.recipient_writes:
            self.violations.append("parameter_woke_recipient_twice")
        self.recipient_writes.append(grant.serial)
        self.recipient_saw_parameter = True
        self.recipient_grant = None
        self.recipient_stage = None

    def step(self, event: str) -> None:
        self.trace.append(event)
        if event == "source_wait":
            self.wait_source()
        elif event == "source_read":
            # A result delivered to this harness during its own active work.
            # Human history inspection is a separate event below.
            if self.source_scope == "A" and self.ready_for_source():
                self.observe_source(self.outcome_version)
                self.source_grant = None
        elif event == "inspect_history":
            before = (self.source_grant, self.source_seen)
            if self.mutant == "inspection_consumes_resume" and self.ready_for_source():
                self.observe_source(self.outcome_version)
                self.source_grant = None
            if (self.source_grant, self.source_seen) != before:
                self.violations.append("human_inspection_changed_agent_delivery_state")
        elif event == "reserve_initial":
            if self.source_current() and not self.recipient_busy and self.phase == "queued" and self.initial_receipt == "none":
                self.initial_stage = (self.source_epoch, self.recipient_epoch)
        elif event in {"write_initial", "write_initial_uncertain"}:
            self.initial_write(uncertain=event.endswith("uncertain"))
        elif event == "retry_initial":
            if self.mutant == "replay_uncertain_initial" and self.initial_receipt == "uncertain":
                self.phase, self.initial_receipt = "queued", "none"
        elif event in {"source_human", "source_other_swarm"}:
            self.source_epoch += 1
            if event == "source_other_swarm":
                self.source_scope = "B"
            self.active_need = False
            self.source_grant = None
        elif event in {"adopt", "old_adopt"}:
            invocation_epoch = 0 if event == "old_adopt" else self.source_epoch
            if self.live and self.source_scope == "A" and invocation_epoch == self.source_epoch:
                self.active_need = True
                self.bound_epoch = self.source_epoch
        elif event == "recipient_human":
            self.recipient_epoch += 1
            self.recipient_busy = True
            if self.mutant != "omit_recipient_revalidation":
                self.recipient_grant = None
            if self.mutant == "drop_queued_on_recipient_input" and self.phase == "queued":
                self.phase = "dropped"
        elif event == "recipient_idle":
            self.recipient_busy = False
        elif event == "recipient_adopt":
            if self.source_current() and self.initial_receipt == "consumed" and not self.recipient_busy:
                self.contribution_epoch = self.recipient_epoch
        elif event in {"clarify", "clarify_wait"}:
            if self.phase == "serving" and self.recipient_current() and not self.clarification_count:
                self.clarification_count = 1
                self.outcome_version += 1
                self.outcomes[self.outcome_version] = "clarification"
                self.phase = "needs_parameter"
                if event == "clarify_wait":
                    self.wait_recipient()
        elif event == "parameter":
            if self.source_current() and self.phase == "needs_parameter" and self.source_seen == self.outcome_version:
                self.parameter_ready = True
                self.phase = "awaiting_answer"
                # A response to this clarification retires any queued wake for it.
                self.source_grant = None
        elif event == "recipient_wait":
            self.wait_recipient()
        elif event == "source_stage":
            grant = self.source_grant
            if grant and self.source_current() and self.ready_for_source():
                if self.outcome_version > grant.after or self.mutant == "ignore_outcome_stage":
                    self.source_stage = (grant, self.outcome_version)
        elif event == "source_write":
            self.source_write()
        elif event == "recipient_stage":
            if self.recipient_grant and self.source_current() and self.recipient_current() and self.parameter_ready:
                self.recipient_stage = (self.recipient_grant, self.source_epoch)
        elif event == "recipient_write":
            self.recipient_write()
        elif event == "answer":
            if self.recipient_current() and (self.phase == "serving" or (self.phase == "awaiting_answer" and self.recipient_saw_parameter)):
                self.outcome_version += 1
                self.outcomes[self.outcome_version] = "answer"
                self.phase = "answered"
                self.recipient_grant = None
        elif event == "cancel":
            self.live = False
            self.source_grant = self.recipient_grant = None
        else:
            raise ValueError(event)
        if self.recipient_owner_scope != "B":
            self.violations.append("peer_contribution_overwrote_owner_scope")


INITIAL = ("reserve_initial", "write_initial")
CLARIFICATION = INITIAL + ("clarify_wait", "source_read", "parameter")


def families() -> dict[str, tuple[tuple[str, ...], tuple[str, ...]]]:
    return {
        "source_steering_before_initial": ((), ("reserve_initial", "source_human", "write_initial", "adopt", "reserve_initial", "write_initial")),
        "recipient_steering_before_initial": ((), ("reserve_initial", "recipient_human", "recipient_idle", "write_initial", "reserve_initial", "write_initial")),
        "source_changes_swarm": ((), ("reserve_initial", "source_other_swarm", "adopt", "write_initial", "reserve_initial", "write_initial")),
        "old_tool_cannot_adopt": ((), ("reserve_initial", "source_human", "old_adopt", "write_initial")),
        "consumed_request_not_initial_again": (INITIAL, ("recipient_human", "recipient_idle", "reserve_initial", "write_initial", "source_human", "adopt")),
        "source_changes_during_clarification": (("source_wait",) + INITIAL + ("clarify_wait",), ("source_stage", "source_human", "adopt", "source_write", "source_wait", "parameter")),
        "recipient_changes_before_parameter": (CLARIFICATION, ("recipient_stage", "recipient_human", "recipient_idle", "recipient_write", "recipient_adopt", "recipient_wait")),
        "outcome_stages_are_distinct": (("source_wait",) + INITIAL + ("clarify_wait", "source_stage", "source_write", "parameter", "source_wait"), ("source_stage", "source_write", "answer", "recipient_stage", "recipient_write", "source_wait")),
        "repeated_pending_wait": (("source_wait",), ("source_wait", "source_wait", "reserve_initial", "write_initial", "answer", "source_stage", "source_write")),
        "uncertain_initial_is_not_replayed": (("reserve_initial", "write_initial_uncertain"), ("retry_initial", "reserve_initial", "write_initial", "recipient_human", "recipient_idle")),
        "cancel_before_parameter": (CLARIFICATION, ("recipient_stage", "cancel", "recipient_write", "recipient_wait", "answer", "source_wait")),
        "inspection_is_not_agent_delivery": (("source_wait",) + INITIAL + ("answer", "source_stage"), ("inspect_history", "source_write", "inspect_history")),
    }


def run(trace: tuple[str, ...], mutant: str = "none") -> Exchange:
    state = Exchange(mutant=mutant)
    for event in trace:
        state.step(event)
    return state


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    report = {
        "scope": "Finite abstract two-sided brief-ask lifecycle, not production or autonomous-quality validation",
        "assumptions": [
            "One already-necessary, admitted dependency, two participants, one optional indispensable clarification",
            "Explicit adoption is independently authorized; old tool invocations cannot acquire a new input generation",
            "Current source and destination state is visible at serialized effect boundaries; remote revocation propagation is not modeled",
            "Clarify-and-wait explicitly registers one parameter continuation; clarification alone does not",
            "A source read means an outcome delivered to that harness during current work; human history inspection never acknowledges it",
            "No native engine, side-effecting work, recipient rerouting, monetary cost, or semantic judgment is exercised",
        ],
        "families": {}, "positive_paths": {}, "counterexamples": {},
    }
    traces = []
    for name, (prefix, events) in families().items():
        variants = [prefix + sequence for sequence in sorted(set(permutations(events)))]
        initial_writes = source_writes = recipient_writes = 0
        for trace in variants:
            state = run(trace)
            assert not state.violations, (name, state.trace, state.violations)
            initial_writes += state.initial_attempts
            source_writes += len(state.source_writes)
            recipient_writes += len(state.recipient_writes)
        report["families"][name] = {
            "traces": len(variants), "violations": 0,
            "initial_attempts": initial_writes, "source_wakes": source_writes,
            "parameter_wakes": recipient_writes,
        }
        traces.extend((name, trace) for trace in variants)

    positives = {
        "direct_answer": (("source_wait",) + INITIAL + ("answer", "source_stage", "source_write"), (1, 1, 0, "answered", 1)),
        "ready_answer_returns_inline": (INITIAL + ("answer", "source_wait", "source_stage", "source_write"), (1, 0, 0, "answered", 1)),
        "active_result_read_retires_queued_wake": (("source_wait",) + INITIAL + ("answer", "source_stage", "source_read", "source_write"), (1, 0, 0, "answered", 1)),
        "inspection_preserves_queued_wake": (("source_wait",) + INITIAL + ("answer", "source_stage", "inspect_history", "source_write"), (1, 1, 0, "answered", 1)),
        "one_clarification": (("source_wait",) + INITIAL + ("clarify_wait", "source_stage", "source_write", "parameter", "source_wait", "recipient_stage", "recipient_write", "answer", "source_stage", "source_write"), (1, 2, 1, "answered", 2)),
        "recipient_new_work_preserves_queued_question": (("recipient_human", "recipient_idle") + INITIAL, (1, 0, 0, "serving", 0)),
        "source_steering_adopts_existing_question": (("source_human", "adopt") + INITIAL, (1, 0, 0, "serving", 0)),
        "recipient_can_read_parameter_during_current_work": (CLARIFICATION + ("recipient_human", "recipient_idle", "recipient_adopt", "recipient_wait", "answer", "source_wait"), (1, 0, 0, "answered", 2)),
        "clarification_without_wait_does_not_resume_recipient": (INITIAL + ("clarify", "source_read", "parameter", "recipient_stage", "recipient_write"), (1, 0, 0, "awaiting_answer", 1)),
    }
    for name, (trace, expected) in positives.items():
        state = run(trace)
        observed = (state.initial_attempts, len(state.source_writes), len(state.recipient_writes), state.phase, state.source_seen)
        assert observed == expected and not state.violations, (name, observed, expected, state.violations)
        report["positive_paths"][name] = {
            "events": list(trace),
            "initial_attempts_source_wakes_parameter_wakes": list(observed[:3]),
            "final_phase": state.phase, "source_observed_outcome_version": state.source_seen,
        }

    for mutant in (
        "omit_source_revalidation", "omit_recipient_revalidation", "ignore_outcome_stage",
        "renew_pending_wait", "replay_uncertain_initial", "overwrite_owner_scope",
        "inspection_consumes_resume",
    ):
        for name, trace in traces:
            state = run(trace, mutant)
            if state.violations:
                report["counterexamples"][mutant] = {"family": name, "events": state.trace, "violations": sorted(set(state.violations))}
                break
        assert mutant in report["counterexamples"], f"Missing counterexample for {mutant}"
    lost_trace = positives["recipient_new_work_preserves_queued_question"][0]
    lost = run(lost_trace, "drop_queued_on_recipient_input")
    assert lost.initial_attempts == 0
    report["counterexamples"]["drop_queued_on_recipient_input"] = {
        "events": lost.trace, "violations": ["eligible_initial_contact_dropped_after_recipient_work_changed"],
        "kind": "liveness contrast with the corresponding positive path",
    }
    report["total_traces"] = len(traces)
    report["violations"] = 0
    output = json.dumps(report, indent=2) + "\n"
    if args.out:
        args.out.write_text(output)
    print(output)


if __name__ == "__main__":
    main()
