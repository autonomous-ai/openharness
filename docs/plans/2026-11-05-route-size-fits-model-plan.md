# The route offers the model the task's size calls for, and records each candidate's quota (task #3163) Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** within each slot (a machine's engine, as a new agent or an idle member) the route offers the model the
project's Routing rules call for: Claude Sonnet high or Codex GPT-6.1 Sol high for small, low or medium work; Claude
Opus high or Codex GPT-6 Astra xhigh for big, hard, risky, security or review work. Until now the slot kept whichever
candidate's title sorted first, so Opus and Astra were offered for small work (Ken, 2026-11-05, production: Astra xhigh
offered 2,010 times for small work against Sol high 67; Opus high 2,356 against Sonnet high 127). The route decision
also stores each candidate's quota fit again (status, weekly % left, reset), which the record without a pick
(#3010/#3045) had cut to account and spend: 3,905 of 3,915 Codex candidates have no `fit.status`.

**Architecture:**

- CLI `cli/src/superTabs/route.ts`.
  - `tierOf(assessment)`: `strong` when the size is large, the difficulty or risk high, or the kind names security or
    review; otherwise `standard`; `null` when the assessment gave no size (an older agent) and nothing makes it strong.
    `parseAssessment` marks a missing size `unsized: true`; it is never sent to the backend.
  - `TIER_MODELS`: the Routing rules' four rows, `standard` Claude sonnet high and Codex gpt-6.1-sol high, `strong`
    Claude opus high and Codex gpt-6-astra xhigh. A candidate ranks 0 when it runs its tier's row, 2 when it runs the
    other tier's model at any effort, else 1. A member's reported model is read through the catalog (`catalogRow`), so
    `claude-opus-4-7` counts as opus.
  - `withEveryAccount` keeps, per slot, the candidate of lowest rank, ties by the neutral order (machine, engine, title),
    up to `RECORD_MAX`. The fill up to `MAX_SHOWN` adds no rank-2 row. With no tier, a slot keeps its first row of each
    tier (both models), within the same caps. The rows still come out in the neutral order; nothing else is ranked.
  - `recordOf` adds `left` and `resetsAt` to each candidate's fit: the weekly window's percent left and reset (the
    tightest reading's when no weekly window is read), as `quotaBrief` shows them. A new shape `unquoted` leaves them out
    for a backend from before this change; `picked`, `unkinded` and `v1` leave them out too.
- CLI `routeCommand.ts`: a record refused as invalid is tried as `unquoted` before `picked`.
- Backend `backend/src/superTabs/routeRecord.ts`: the fit schema takes optional `left` (0–100, nullable) and `resetsAt`
  (epoch ms, nullable). `storedRecord`, for a record without a pick, keeps each candidate's `status`, `left` and
  `resetsAt` beside `account` and `spend`. `KeptFit` gains them as optional, since rows written before lack them.

**Tech Stack:** TypeScript, vitest (CLI specs, backend unit tests), zod.

**Spec:** task #3163's brief (conversation e690160e2ccbc0a06052f89c); the project instructions' Routing, Models.

## Global Constraints

- No new settings. The tier rows mirror the Routing rules as constants in `route.ts`; a catalog without them leaves the
  slot to its neutral first row, as before.
- Swarm code stays out of `cli/src/core`. CLI specs run with a scratchpad `TMPDIR` (mktemp -d).
- Backend: run the backend unit suite (`npm test` in `backend/`) since `routeRecord.ts` changes; the Super Tab
  integration suite runs in PR CI.
- Owned files: `cli/src/superTabs/route.ts`, `cli/src/superTabs/routeCommand.ts`, `backend/src/superTabs/routeRecord.ts`
  and their specs.

## Design

- growth: no new collection or row. Each stored candidate gains `status`, `left` and `resetsAt`, about 50 bytes; a
  64-candidate decision grows by about 3 KB. `SuperTabRouteDecision` keeps its existing removal (unchanged here).
- concurrency: N/A because the record is written once per route, as before.
- read cost: N/A because no reader or query changes; readers read the same row.
- scale: at 10x routes the decision rows grow linearly; the collection's data size is the metric that warns first, as
  for #2769.
- compatibility: a backend from before this refuses `left`/`resetsAt` (strict schema); the CLI then records the
  `unquoted` shape, which it accepts. Old rows lack the fields; `KeptFit` marks them optional and no reader requires
  them.
- migration + rollback: none; rolling back the CLI stops sending the fields, rolling back the backend refuses them and
  the CLI falls back.
- audience: unchanged; the route log's readers are as before.
- identity: N/A because no login is used.
- failure: a refused record falls back shape by shape as before and the route still answers.
- platforms: CLI on macOS, Linux and Windows; the change is pure TypeScript.

## Review Focus

- The tier rule matches the Routing rules: small/low/medium vs big/hard/risky/security/review.
- No slot loses its only row: a slot with no tier row keeps its neutral first row.
- The record shape fallback order and that an older backend still records a decision.

## Tasks

### Task 1: each slot offers the model the task's size calls for

**Files:** `cli/src/superTabs/route.ts`, `cli/src/superTabs/route.spec.ts`

**Interfaces:** `Assessment.unsized?: true`; `choose` unchanged in signature.

- [ ] Red: a small task over machines offering Opus high, Opus xhigh, Sonnet high, Astra xhigh and Sol high shows
      Sonnet high and Sol high on every machine, never Opus or Astra.
- [ ] Red: a large task, a high-risk task and a security/review kind show Opus high and Astra xhigh.
- [ ] Red: an unsized task keeps both models of each slot.
- [ ] Red: a real-shaped list (production machine names, members on Opus and Sonnet, grid rows, 20+ machines) gives the
      counts per model the rules call for.
- [ ] Commit the red tests; watch them fail.
- [ ] Green: `tierOf`, `TIER_MODELS`, rank in `withEveryAccount`, `unsized` in `parseAssessment`. Run route specs.

### Task 2: each candidate's quota fit is stored in the route decision

**Files:** `cli/src/superTabs/route.ts`, `cli/src/superTabs/routeCommand.ts`, `cli/src/superTabs/route.spec.ts`,
`cli/src/superTabs/routeCommand.spec.ts`, `backend/src/superTabs/routeRecord.ts`, `backend/src/superTabs/routeRecord.test.ts`

**Interfaces:** record fit `left: number | null`, `resetsAt: number | null`; `RecordShape` adds `unquoted`.

- [ ] Red: `recordOf` carries each candidate's status, weekly % left and reset; `unquoted` and older shapes do not.
- [ ] Red: the backend schema accepts them and `storedRecord` keeps status, left and reset of every candidate of a
      record without a pick.
- [ ] Red: routeCommand retries a refused record as `unquoted` before `picked`.
- [ ] Commit the red tests; watch them fail.
- [ ] Green: schema, `storedRecord`, `KeptFit`, `recordOf`, the fallback. Run route, routeCommand and routeRecord tests,
      then the backend unit suite.
