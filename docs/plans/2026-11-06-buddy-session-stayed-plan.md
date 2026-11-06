# A Buddy thread session that stayed put is recorded where it runs: Implementation Plan

> Written by the project's Engineer by the writing-plans skill; implemented test first. The review step on the pull request
> is its one independent review.

**Goal:** During a Buddy model switch, a thread session the daemon refuses to move is recorded where it still runs, and one
left on a member's shared model after a send-home is sent home again (Diego, 11-06, task #3810).

**Architecture:**
- CLI (`cli/src/superTabs/buddyModel.ts`): reports the sessions that stayed as `stayed: [harnessId]` next to the words. On a
  send-home (`reason` set), it waits for a busy session's turn to end within the request's lease, remembering what already
  moved so the main Buddy is never moved twice. A `sessionsOnly` request moves the sessions alone.
- Backend (`backend/src/superTabs/buddyModel.ts`): `buddyModelResult` records the model only on sessions that moved. A session
  left on a shared model by a move home is marked `homeOwed` ({reason, tries}). The liveness sweep (`unservedBuddyModels`)
  asks the Buddy's machine for a sessions-only move home, at most three tries, then tells the owner to end that session.
  `commands.ts` accepts `stayed` on `buddy.modelResult`.

**Tech Stack:** TypeScript, zod, vitest.

## Global Constraints
- The main Buddy's behaviour is unchanged.
- No secret in any report or log: harness ids and the existing fixed words only.

## Design
- growth: `homeOwed` lives on a session agent and goes when it moves, or after three tries.
- concurrency: one request per Buddy, as before (`modelRequest`); a follow-up is asked only when none is pending.
- read cost: none new. The sweep already walks the agents.
- scale: per Buddy, so N/A.
- compatibility: `stayed` and `sessionsOnly` are optional. An older host reports no `stayed`, so every session reads as moved, as
  today, and it moves the main Buddy again on a sessions-only request, which is harmless. An older backend never sends
  `sessionsOnly`.
- migration and rollback: none.
- audience and identity: unchanged (only the Buddy's own machine reports).
- failure: a session that never moves is named to its owner after three tries.
- platforms: CLI on every platform, and the backend.

## Review Focus
- A send-home whose busy session outlasts the lease: reported in `stayed`, never left waiting for good.
- The main Buddy moved once across retries.
- A switch out with a session in `stayed`: left on its owner's subscription, nothing owed.
