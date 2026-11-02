# Device Notifications Without Jev: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A harness agent's finished turn alerts the devices and a Swarm agent's is silent, decided by fixed rules with no Jev call.

**Architecture:** `createTierDecider` drops the Jev step and ends with two rules (Swarm -> silent, else alert). `TierInput` gains `swarm`. One shared check decides whether an agent is a Swarm agent, used by the recaps service and by the devices service.

**Tech Stack:** TypeScript, vitest (cli/).

**Spec:** `docs/superpowers/specs/2026-11-02-device-notify-no-jev-design.md`

## Global Constraints

- Rule order: `failed` -> alert (`rule:failed`); `subagent` -> silent; `onScreen` -> silent; empty recap -> silent (`rule:empty`); `swarm` -> silent (`rule:swarm`); otherwise -> alert (`rule:turn`).
- No Jev client is created, passed or called for this decision; `HARNESS_NOTIFY_SMART` is removed.
- `fallbackTier` stays exported (used by `lib/commander.ts`).
- A Swarm agent: its registry row has `swarmSkill` (any role), or it runs on a Harness Team account machine.
- Log lines keep their shape: `notify · <agent> · <tier> · rule:<name> · <detail> · <ms>ms` and the day's counts.
- `src/services` stays at 100% per-file coverage (`npm run test:core`). Do not edit `cli/src/lib/e2ee/core.ts`.

## Review Focus

- An agent whose row has `swarmSkill` with role `buddy` or `lead` (not only `agent`) is silent. Test in Task 2.
- A remote agent's card that arrives without a tier (older machine) still gets a decision and never throws. Test in Task 2.
- A failed Swarm turn: the existing `rule:swarm-worker` path for `turn.error` is unchanged. Test in Task 2.
- A Jev decision model installed locally (`jev:` engine ids in `lib/localModels.ts`) is not touched by this change.
- `commander.ts` still settles a superseded turn with `fallbackTier`. Test in Task 1 (existing commander spec stays green).

---

### Task 1: Rules-only tier decider

**Files:**
- Modify: `cli/src/lib/notifyTier.ts`
- Test: `cli/src/lib/notifyTier.spec.ts`

**Interfaces:**
- Produces: `TierInput` with `swarm: boolean`; `createTierDecider(opts: { now?: () => number; log: (line: string) => void; tally?: ReturnType<typeof createTally> }): (input: TierInput) => Promise<TierDecision>`; `fallbackTier`, `isTier`, `createTally` unchanged.

- [ ] **Step 1: Write the failing tests** in `notifyTier.spec.ts` (replace the Jev cases):
  - `a harness agent's finished turn alerts` -> `{ tier: 'alert', by: 'rule:turn' }`.
  - `a Swarm agent's finished turn is silent` (`swarm: true`) -> `{ tier: 'silent', by: 'rule:swarm' }`.
  - `the fixed rules come first`: `failed` + `swarm` -> alert `rule:failed`; `subagent`, `onScreen`, empty recap -> silent with their rule.
  - `takes no Jev`: `createTierDecider` called with only `{ log }` decides; the module no longer exports `tierState`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/notifyTier.spec.ts`. Expected: FAIL (`rule:turn` / `rule:swarm` missing).
- [ ] **Step 3: Implement**: remove the Jev import, `QUESTIONS`, `tierState`, `WINDOW_MS`/`recent`, `RECAP_MAX`, budget and timeout; after the fixed rules return `rule('silent', 'swarm')` for `input.swarm`, else `rule('alert', 'turn')`. Update the file's header comment.
- [ ] **Step 4: Run** the same spec and `npx vitest run src/lib/commander.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(cli): device notifications follow fixed rules, not Jev: a harness turn alerts, a Swarm turn is silent`.

### Task 2: Tell Swarm agents in both deciders

**Files:**
- Modify: `cli/src/services/recaps.ts:35,52-64,105-111`, `cli/src/services/devices.ts:62,100,378-401,420-427`
- Test: `cli/src/services/recaps.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: Task 1's `createTierDecider({ log })` and `TierInput.swarm`.
- Produces: in `devices.ts`, `swarmAgent(event: DialEvent): boolean` (any `swarmSkill` role, or a Team machine) beside the existing `swarmWorker` (unchanged, still `role === 'agent'` for the `turn.error` rule); in `recaps.ts`, the session's row read through `core.agents` to set `swarm`.

- [ ] **Step 1: Write the failing tests:**
  - recaps.spec: `decides a Swarm agent's turn silent` for rows with `swarmSkill.role` `lead`, `buddy`, `agent`; `decides a harness agent's turn alert`; remove the `HARNESS_NOTIFY_SMART` cases and assert no Jev client is built.
  - devices.spec: a card without an upstream tier for a local Swarm agent (any role) and for an agent on a Team machine -> `summary` sent with tier `silent`; for a harness agent -> `alert`; a remote agent's card without a tier still gets a tier; `turn.error` for a Swarm worker still logs `rule:swarm-worker`. Remove the `HARNESS_NOTIFY_SMART` case.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/recaps.spec.ts src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**: build the decider with `createTierDecider({ log })` in both services (drop `createJevDecide` and the env check; fix the two doc comments); pass `swarm` from the row (`swarmSkill` present) or a Team machine.
- [ ] **Step 4: Run** the same specs, then `npm run test:core` and `npx tsc --noEmit`. Expected: PASS, 100% coverage.
- [ ] **Step 5: Commit** `fix(cli): Swarm agents' finished turns are silent on devices; drop the Jev decider`.
