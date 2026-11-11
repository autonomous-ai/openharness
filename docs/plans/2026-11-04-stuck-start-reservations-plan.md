# Stuck start reservations Implementation Plan

**Goal:** A machine stops counting memory and disk for Swarm starts that failed, timed out or never got an agent, so
trunghieu's Team account ("8 GiB more is set aside for agents still starting", issue #2989) admits starts again without
anyone touching it.

**Architecture:** The machine's capacity ledger (`cli/src/superTabs/reservations.ts`, `<dataDir>/super-tabs/capacity.sqlite`)
keeps one row per start. A row with no agent holds its whole budget while it is "starting". Today only a creation the
machine reports as `missing` is given back at the start deadline (15 minutes); one it reports `pending`, `unconfirmed` or
cannot read is held forever, and a restart does not clear it. The backend fails every dispatched start that has no agent
by its own start deadline (backend `liveness.ts`: 3 minutes, 15 while its machine reports it preparing), and only a
dispatched start has a native creation. So past that deadline plus a margin, an agentless row belongs to a start the
Swarm already failed: reconcile gives it back, logs it, and the next reserve (the first start after the update) clears
every old stuck row. A creation that reads `created` keeps its row and identity as today.

**Tech Stack:** TypeScript, node:sqlite ledger, vitest.

**Spec:** Task #2890 / issue #2989 (Ken's evidence: four dispatched 2 GiB starts with no harness, each failed by the
server "did not start it within 3 minutes").

## Global Constraints

- CLI only; Swarm code stays out of `cli/src/core`. No ledger schema change (no migration, old/new CLIs read the same file).
- Tests never touch the real `~/.harness`: the spec's fixture ledger lives in a `mkdtemp` folder.
- The memory refusal keeps its `Not enough free memory: X GiB free, Y GiB needed.` prefix: the backend reads only that
  prefix for members (backend `startFailure.ts`); the rest goes only to the start's Lead and the machine owner.

## Design

- growth: a give-back DELETEs the agentless row; rows with an agent are unchanged (released when it stops).
- concurrency: the delete runs in the ledger's existing `BEGIN IMMEDIATE` transaction and re-checks `harness_id IS NULL`
  and `created_at` on the row as it is then, so a run that confirmed it meanwhile keeps it.
- read cost: reconcile already reads every active row's creation status on reserve; nothing new is read.
- scale: at most 256 active rows (MAX_ACTIVE); stuck rows no longer accumulate toward it.
- compatibility: same file and schema; an older CLI reading the ledger after this one sees fewer rows.
- migration + rollback: none; rolling back restores the old hold-forever behavior for new rows only.
- audience: the extra refusal text (receipt ids, age) reaches only the start's Lead and the machine owner.
- identity: N/A because no account or login is involved.
- failure: each give-back is logged on the machine; the refusal names the starts still holding memory.
- platforms: all (the ledger is platform-neutral).

## Review Focus

- That no row whose creation is `created` (an agent that runs) is given back.
- That the bound (START_DEADLINE_MS + START_WINDOW_MS = 20 minutes after the reservation's last confirmation) is never
  shorter than the backend's own wait for a dispatched start.

## Task 1: Give back agentless rows past the launch deadline

**Files:** `cli/src/superTabs/reservations.ts`, `cli/src/superTabs/reservations.spec.ts`

**Interfaces:** new exported `LAUNCH_DEADLINE_MS`; optional `log` dependency on `CapacityReservations`.

- [ ] Failing tests: a dispatched start reading `pending`, `unconfirmed` or unreadable past the launch deadline is given
  back and the next start is admitted; one still inside it keeps holding; a ledger reopened (restart) with four stuck
  2 GiB rows admits a start on its first reserve; a `created` row past the deadline keeps its identity; a real shortage
  is still refused.
- [ ] Code: reconcile expires agentless rows that are not `created`, `failed` or `cancelled` past `LAUNCH_DEADLINE_MS`
  (missing ones keep the existing 15-minute deadline), and logs each give-back.

## Task 2: The refusal names the starts holding memory

**Files:** same.

- [ ] Failing test: a memory refusal with memory set aside names how many starts hold it, their receipts and the oldest
  one's age, after the unchanged prefix.
- [ ] Code: build that text from the rows counted in `held`.
