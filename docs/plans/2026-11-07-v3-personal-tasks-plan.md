# Personal Tasks pane implementation plan

> Implement natively, task by task, with failing tests committed before production code; one independent review of the pull request.

**Goal:** Show the person's time-ordered Tasks and proposals, with backend-owned Auto approve / Review and explicit task decisions.
**Architecture:** Add the optional personalTasks envelope to the existing parts store, preserving its cursor, cache and revocation lifecycle. A new right-pane widget reads that store through the controller and sends existing authenticated commands; the shell supplies task navigation.
**Tech Stack:** Flutter/Dart; existing controller, parts transport, native controls and memory-store/fake-sign-in tests.
**Spec:** docs/specs/2026-11-07-swarm-v3.md in Fir's backend PR #3449; task #4138. Shell dependency #3445; join dependency #3448.

## Global Constraints

- Backend first. Unsupported servers show Update Harness and no approval controls.
- macOS, Linux and Windows; no process launch, login read or production writes. Phone/web stay as today.
- Newest first, then id; two quiet lines per row, no section headings; proposals and rejected tasks keep their status.
- Auto approve is default; changes apply to future work only. Review approval and suggestion never start work locally.
- Light and dark; memory store and fake sign-in; reuse existing request timeout and operation receipts.

## Review Focus

- Overlap deltas cannot resurrect an old task version; reset/removals clear revoked rows.
- Missing capability cannot present an approval choice that the server cannot keep.
- Account replacement, offline transport and double click must not send the same choice twice or attribute it to another person.
- Agent disappearance and changed roster must not silently select another worker.
- Rejection requires a reason; failures remain visible with a bounded retry and no raw server content.

## Design

- Growth: one in-memory summary per active task in the server's bounded snapshot; existing cache lifecycle deletes it. No history collection or timer.
- Concurrency: existing controller serial requests and operation ids; server is authority for audience, identity, suggestions and decisions.
- Read cost: consume existing parts/change envelopes only; merge only changed rows, lazy list rendering.
- Scale: 10x active task fixture checks delta work and ordering; no whole-state polling.
- Compatibility: optional additive envelope; hide unsupported controls; backend ships first.
- Migration/rollback: no schema migration; previous clients ignore feed; roll Desktop back independently, keep approval backend enforcement.
- Audience/identity: server-filtered personalTasks only; never infer requester from machine owner; account-bound controller.
- Failure: visible safe error and retry; no optimistic approval or mode change; command timeout is existing controller's.
- Platforms: shared Flutter pane on macOS/Linux/Windows; no native process behavior changes.

### Task 1: Feed state and transport

**Files:** Create desktop/lib/super_tabs/tasks/personal_tasks.dart; modify parts.dart and controller.dart; test desktop/test/super_tab_personal_tasks_test.dart.
**Interfaces:** Parts exposes personalTasks store; controller exposes it read-only; rows include id/version/at/project/title/agent/status/suggested/reason.
- [ ] Commit failing tests for first load, overlapping versions, removals/reset, serialization, missing capability and roster overlays.
- [ ] Run those tests and record red.
- [ ] Implement envelope merging and wire it into existing parts first load/change/cache. Feed changes notify as content changes.
- [ ] Run affected parts tests and new feed tests; commit green.

### Task 2: Tasks pane and shell

**Files:** Create desktop/lib/super_tabs/tasks/personal_tasks_pane.dart; modify view.dart's existing right-pane default; test desktop/test/super_tab_personal_tasks_pane_test.dart.
**Interfaces:** SuperTabPersonalTasksPane(controller, onOpenTask); authenticated commands member.approvalMode, task.suggest, task.approve, task.reject.
- [ ] Commit failing widget tests for newest order, quiet two-line rows, proposal/rejected marks, default/mode persistence, suggestion change, approve/reject/reason, error/retry, double click, account switch and unsupported backend.
- [ ] Run widget tests and record red.
- [ ] Implement native pane, preserving supplied rightPane override and existing task opener; safe pending/error/retry behavior.
- [ ] Run affected widget/shell tests and style/icon checks; capture and inspect light/dark panes; commit green.
- [ ] Push draft early, then mark ready with red/green evidence and request independent review and platform checks.
