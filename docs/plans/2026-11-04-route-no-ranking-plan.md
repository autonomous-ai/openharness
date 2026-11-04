# The route stops ranking candidates; the project's Routing instructions choose (task #2901) Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** `harness super-tab route` keeps leaving out what cannot run and keeps every fact per candidate. It stops
ranking by strength or price and names no pick. Candidates come in a neutral, stable order (machine name, then engine).
The coordinator chooses by the project's Routing instructions, and the start or assignment records which candidate it
chose and why (Ken, 2026-11-04). Until now PMs took the route's top line, which was nearly always Opus or Astra, against
the instructions' Order and quota.

**Architecture:**

- CLI `cli/src/superTabs/route.ts`. `compare` no longer orders by strength, effective cost or quota fit. It orders by
  machine name, then engine, then a member in another repository after the others on that machine, then title.
  Plug-ins' `strength`/`cost` adjustments become notes and no longer change the order; a plug-in's `refuse` still leaves
  a candidate out. `decide` names no pick: its verdict is `via: 'instructions'` (`'only'` for a single candidate) with a
  why that sends the reader to the Routing instructions. `short` ("the first candidate's quota…") goes, because nothing
  is first; when no candidate fits, the route still warns.
- CLI `routeCommand.ts`. The answer has `candidates` (one row per machine, engine and kind, in that order) and no
  `pick`/`alternatives`/`p`. `next` explains how to start or assign the chosen candidate with the `routeDecisionId` and
  an `overrideReason` naming the Routing rule followed. The record has no `pick` and `via: 'instructions'`. An older
  backend refuses that record; the CLI then records the old shape, with `c0` as a placeholder pick, so its decision log
  keeps working.
- CLI `service.ts` routeHistory reads the candidate that ran from `final.candidateId` (new), then the person's
  override, then the old pick.
- Backend `routeRecord.ts`. `pick` is optional, and `via` also takes `'instructions'`. A record without a pick is stored
  with every candidate's slim quota fit (`account`, `spend`): routeHistory needs the account and spend of whichever
  candidate runs, and nobody knows which one that is until the start. `RouteFinal` takes an optional `candidateId`.
- Backend `commands.ts`:
  - `route.record` without a pick posts no chat row.
  - `linkDecision` (start and assign) on a decision with no pick, no person's choice and no final yet requires
    `overrideReason`. It records the candidate the start or assignment matches as `final.candidateId` and posts the
    `route` row naming it ("Routed to X — by the project's Routing instructions · reason"). Released Desktop and phone
    apps draw that row, because its source still carries a `pick`. A start that matches no candidate records an
    override with the reason, as today.
  - `route.override` with no earlier choice says "chose X".
- Desktop and mobile `route_row`: the selection line for `via: 'instructions'`.
- Backend `instructionsTemplate.ts` Routing: there is no order in the route to pick against. The reason goes with the
  start.

**Tech Stack:** TypeScript (CLI: vitest; backend: vitest + zod), Flutter (one `switch` case each in Desktop and mobile).

**Spec:** task #2901's brief, and Ken's facts in its thread (11-04): clients need `pick` on a route row, the backend
override path, the instructions text, and that a neutral first row is still a first row.

## Global Constraints

- Red first: no candidate comes first for being stronger or cheaper. Filters still leave out what cannot run. Each
  candidate carries quota % left and reset time. A start with any candidate's id is recorded.
- Swarm code stays out of `cli/src/core`.
- Older clients keep working: an old CLI's record with a pick is taken and linked as before. Released apps draw the
  route row.
- Never run a test that signs the Mac out of the real CLI.

## Design

- growth: route decisions are deleted as before, and nothing is added per route except the slim fit on pick-less
  records: about 130 bytes a candidate (14.6 KB for 42 candidates against 9.2 KB), measured in `routeRecord.test.ts`.
- concurrency: unchanged. A decision is written inside the Swarm's store write, as before.
- read cost: unchanged. routeHistory reads the same 50 decisions.
- scale: 10x the machines means 64 candidates at most (`RECORD_MAX`). The stored size is the first metric to warn.
- compatibility: an old CLI sends a pick, and its record is handled as before. The new CLI on an old backend falls back
  to the old shape. Old apps draw the route row from the start's `pick`.
- migration + rollback: no migration. Rolling back the backend refuses new pick-less records, and the CLI's old-shape
  fallback covers that.
- audience: the server enforces who may start, assign and override, as before. The reason requirement is server-side.
- identity: N/A because nothing here reads or uses a person's login.
- failure: a start without a reason on a pick-less decision is refused with what to send. A start that matches no
  candidate is recorded and said in the chat.
- platforms: CLI on every OS. Desktop and mobile change one label.

## Review Focus

- That the order no longer depends on strength, cost, fit or plug-in adjustments.
- `linkDecision`'s three cases: a pick (old CLI), a person's choice, and the coordinator's own choice.
- Released apps keep the route card.

## Tasks

### Task 1: neutral order and no pick (CLI route.ts)

Files: `cli/src/superTabs/route.ts`, `route.spec.ts`, `__snapshots__/route.answers.json`, `routePlugins.spec.ts`.

- [ ] Failing tests: a weaker, cheaper candidate on machine "a" comes before a stronger one on machine "b". A plug-in's
      strength/cost adjustment adds its note and leaves the order alone. `decide` names no pick, and its why names the
      Routing instructions. Refusals still leave candidates out. Each shown label still carries weekly % left and reset.
- [ ] Code: `compare`, `pluginAdjustments` use, `decide`, `recordOf`, and `short` removed.
- [ ] Snapshots updated.

### Task 2: the route's answer and record (CLI routeCommand.ts, service.ts, help)

Files: `routeCommand.ts`, `routeCommand.spec.ts`, `service.ts` (routeHistory, HELP.route), `service.spec.ts`,
`cli/src/lib/swarmTools.ts`, `routeCheapFirst.ts` (help text), `docs/swarms.md`.

- [ ] Failing tests: the answer has `candidates` and no `pick`. The record has no pick and `via: 'instructions'`, and
      falls back to the old shape on VALIDATION_ERROR. routeHistory takes the account from `final.candidateId`.
- [ ] Code and help text.

### Task 3: backend record and link (backend)

Files: `backend/src/superTabs/routeRecord.ts`, `routeRecord.test.ts`, `commands.ts`, its route tests,
`parts/touches.ts`, `instructionsTemplate.ts`.

- [ ] Failing tests: a pick-less record is accepted and stored with slim fits. A start matching any candidate records
      its id and posts the route row with that pick. A start without a reason is refused. A start matching none
      records an override. A person's override with no earlier choice says "chose". An old record with a pick links as
      before.
- [ ] Code.

### Task 4: apps' selection line (Desktop, mobile)

Files: `desktop/lib/super_tabs/route_row.dart`, `mobile/lib/swarm/...` route row, their route tests.

- [ ] Failing test: `via: 'instructions'` reads "Chosen by the project's Routing instructions".
- [ ] Code.
