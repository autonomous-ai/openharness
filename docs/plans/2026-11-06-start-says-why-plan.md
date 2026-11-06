# A start that can't launch says why, and the PM sees it — Plan

**Goal:** A start stuck on a machine fault shows the fault's reason (the daemon's code and, for a permissions problem, the folder and the fix) to the PM and the route, and fails within 5 minutes so the PM can route elsewhere.

**Architecture:** The daemon's `agent_create_status` answers `{ error: 'CREATION_STORAGE_FAILED' }` without the creationId when its receipts folder cannot be used; the host's start turned that into `START_UNCERTAIN` ("did not confirm the receipt"), which machines.ts never fails. (1) The receipt error carries a `detail` for a permissions problem: the folder (home shown as `~`) and what its owner does, never an automatic chmod or sudo. (2) The daemon replies with it, the host's start returns `START_MACHINE_FAULT` with the code and detail. (3) machines.ts reports the reason to the server (`agent.startWaiting`) and fails a start that is not dispatched after 5 minutes of the same fault. (4) The backend stores the reason on the start, shows it in status and the route, clears it when the start settles or fails, and a failed start counts as one.

**Tech Stack:** TypeScript, vitest (cli/src, backend/src).

**Spec:** task #3861.

## Global Constraints
- No secret in a reason: the folder name, the daemon's code, the fix in words. Never fix permissions automatically or with sudo.
- A start already dispatched (a launch may have happened) is never failed from here.
- Placement (a Team-only entry never lands on the own-account entry) waits for the concrete case from the PM; backend `ownAccountTeamEntry` (#3060) already refuses the named case.

## Review Focus
- No secret or path beyond the creation folder in a reason; the failure cannot be triggered by another account.
- `START_MACHINE_FAULT` is not in `NOT_REFUSED` semantics by accident: only an undispatched start is failed.

## Task 1: the receipt error says which folder and why (cli/src/lib/agentCreationReceipt.ts, core/agents/launches.ts)
- [ ] Failing tests: a folder the account cannot open throws `CREATION_STORAGE_FAILED` with a detail naming the folder and permissions, no sudo; the status reply carries the detail.
- [ ] Implement.

## Task 2: the start returns the fault (cli/src/superTabs/start.ts)
- [ ] Failing test: a status answer with an error code and detail returns `START_MACHINE_FAULT` with both, not `START_UNCERTAIN`.
- [ ] Implement.

## Task 3: the host reports it and fails after 5 minutes (cli/src/superTabs/machines.ts)
- [ ] Failing tests: the first pass sends `agent.startWaiting` once per reason; 5 minutes on, an undispatched start gets `agent.startFailed` with the reason; a dispatched one does not.
- [ ] Implement.

## Task 4: the backend stores and shows it (backend/src/superTabs)
- [ ] Failing tests: `agent.startWaiting` sets `waiting` on the start; status and the route show it; settling or failing clears it; the failed start counts like any other.
- [ ] Implement.
