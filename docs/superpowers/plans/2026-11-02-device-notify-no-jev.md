# Device Notifications Without Jev: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A harness agent's finished turn alerts the devices, decided by fixed rules with no Jev call.

**Architecture:** `createTierDecider` drops the Jev step and ends with one rule: alert. The recaps service and the devices service both use it.

**Tech Stack:** TypeScript, vitest (cli/).

**Spec:** `docs/superpowers/specs/2026-11-02-device-notify-no-jev-design.md`

## Global Constraints

- Rule order: `failed` -> alert (`rule:failed`); `subagent` -> silent; `onScreen` -> silent; empty recap -> silent (`rule:empty`); otherwise -> alert (`rule:turn`).
- No Jev client is created, passed or called for this decision; `HARNESS_NOTIFY_SMART` is removed.
- `fallbackTier` stays exported (used by `lib/commander.ts`).
- Log lines keep their shape: `notify · <agent> · <tier> · rule:<name> · <detail> · <ms>ms` and the day's counts.
- `src/services` stays at 100% per-file coverage (`npm run test:core`). Do not edit `cli/src/lib/e2ee/core.ts`.

## Review Focus

- A remote agent's card that arrives without a tier (older machine) still gets a decision and never throws. Test in Task 2.
- A Jev decision model installed locally (`jev:` engine ids in `lib/localModels.ts`) is not touched by this change.
- `commander.ts` still settles a superseded turn with `fallbackTier`. Test in Task 1 (existing commander spec stays green).

---

### Task 1: Rules-only tier decider

**Files:**
- Modify: `cli/src/lib/notifyTier.ts`
- Test: `cli/src/lib/notifyTier.spec.ts`

**Interfaces:**
- Produces: `createTierDecider(opts: { now?: () => number; log: (line: string) => void; tally?: ReturnType<typeof createTally> }): (input: TierInput) => Promise<TierDecision>`; `fallbackTier`, `isTier`, `createTally` unchanged.

- [ ] **Step 1: Write the failing tests** in `notifyTier.spec.ts` (replace the Jev cases):
  - `a harness agent's finished turn alerts` -> `{ tier: 'alert', by: 'rule:turn' }`.
  - `the fixed rules come first`: `failed` -> alert `rule:failed`; `subagent`, `onScreen`, empty recap -> silent with their rule.
  - `takes no Jev`: `createTierDecider` called with only `{ log }` decides; the module no longer exports `tierState`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/notifyTier.spec.ts`. Expected: FAIL (`rule:turn` missing).
- [ ] **Step 3: Implement**: remove the Jev import, `QUESTIONS`, `tierState`, `WINDOW_MS`/`recent`, `RECAP_MAX`, budget and timeout; after the fixed rules return `rule('alert', 'turn')`. Update the file's header comment.
- [ ] **Step 4: Run** the same spec and `npx vitest run src/lib/commander.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(cli): device notifications follow fixed rules, not Jev: a harness turn alerts`.

### Task 2: The rules-only decider in both services

**Files:**
- Modify: `cli/src/services/recaps.ts:35,52-64,105-111`, `cli/src/services/devices.ts:62,100,378-401`
- Test: `cli/src/services/recaps.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: Task 1's `createTierDecider({ log })`.

- [ ] **Step 1: Write the failing tests:**
  - recaps.spec: `decides a harness agent's turn alert`; remove the `HARNESS_NOTIFY_SMART` cases and assert no Jev client is built.
  - devices.spec: a card without an upstream tier for a harness agent -> `summary` sent with tier `alert`; a remote agent's card without a tier still gets a tier. Remove the `HARNESS_NOTIFY_SMART` case.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/recaps.spec.ts src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**: build the decider with `createTierDecider({ log })` in both services (drop `createJevDecide` and the env check; fix the two doc comments).
- [ ] **Step 4: Run** the same specs, then `npm run test:core` and `npx tsc --noEmit`. Expected: PASS, 100% coverage.
- [ ] **Step 5: Commit** `fix(cli): drop the Jev decider from recaps and devices`.
