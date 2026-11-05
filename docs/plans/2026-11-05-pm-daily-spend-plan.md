# A PM's account keeps what its PM will spend until the reset: plan

> Written by the task's Engineer (Linden) and implemented by it, task by task, test first. Task #3222, follow-up to #3134.

**Goal:** Replace #3134's fixed 20% with what each PM actually needs: the days left until its account's weekly reset ×
the share of the week its PM spends a day. Until 3 days are measured, it stays 20%.

**Architecture:** (1) The Mac's usage reader never opened a transcript past 128 MB; a PM's one long session (823 MB after
10 days) was never in `harnessTokens`. It now reads a slice per refresh from its checkpoint. (2) Each machine reading adds
to a small daily spend ledger on its machine part, as the Lent ledger is kept (`leaderboard/lent.ts addLent`): per engine
and UTC day, the weekly quota's used share at the day's first and last reading, its reset, and each running session's
price-weighted cost (`costs/prices.ts`) at both. No new collection and no extra write: every reading already rewrites its
machine part. (3) `pmAccounts` (#3134) gives each PM account its PM's daily share: per day, the account's used share of its
week × the PM's part of the day's price-weighted cost on that account (the Mac and its Harness Team account together),
averaged over the last 7 complete days, needing at least 3. (4) The route's PM note names the share to keep:
max(5%, days to reset × daily share), or 20% without the history; the PM guide and the Routing template say "the share the
route notes".

**Tech Stack:** TypeScript (CLI daemon, backend), Vitest.

**Spec:** Task #3222 (Ken, 11-05; River: split by price-weighted token share, 20% until 3 days, formula and one worked day of
real numbers in the PR body).

## Global Constraints

- No new settings. Builds on #3134 (merged into this branch until it lands on main).
- The ledger is bounded (8 days per engine, the sessions a reading reports) and never sent to hosts: it moves with every
  reading, like Lent, so it is left out of what a reading tells hosts and of a machine's content change.
- A day whose weekly window reset is not measured (its share is unknown, not zero). A session that restarted counts from zero.

## Review Focus

- A partial transcript count is never published (the attempt and the ledger would take it as the session's total).
- The share is computed from what the readings say; nothing is guessed when a day lacks data.
- Hosts and clients see no new churn from the ledger.

## Task 1: The usage reader counts a transcript past 128 MB

**Files:** `cli/src/lib/agentTokenUsage.ts`, `cli/src/lib/agentTokenUsage.spec.ts`

- [x] Failing tests: a transcript larger than one refresh reads is counted a slice at a time with no partial count; one
  past 128 MB is counted.
- [x] Code: a 64 MB slice per refresh from the checkpoint, the next slice a second later, counts published once caught up.

## Task 2: Each reading adds to the machine's daily spend ledger

**Files:** `backend/src/superTabs/pmSpend.ts` (new), `backend/src/superTabs/pmSpend.test.ts`, `backend/src/superTabs/store.ts`
(both reading paths), `backend/src/superTabs/model.ts` (the ledger's type), `backend/src/superTabs/parts/commit.ts`

**Interfaces:** `addSpend(pool, observation, now)`; `ContributedMachine.spendDays?: SpendDay[]`.

- [ ] Failing tests: a day's first and last weekly share and each session's cost are kept; a reset marks the day; 8 days kept.
- [ ] Failing test: a reading that changes only the ledger tells no host.
- [ ] Code.

## Task 3: Each PM account carries its PM's daily share and its reset

**Files:** `backend/src/superTabs/pmSpend.ts`, `backend/src/superTabs/model.ts` (`pmAccounts`), tests

- [ ] Failing tests: the share is the account's daily used share × the PM's cost share, over the Mac and its Team account;
  none with fewer than 3 measured days; a reset day is skipped.

## Task 4: The route notes the share to keep

**Files:** `cli/src/superTabs/pmAccounts.ts`, `cli/src/superTabs/pmAccounts.spec.ts`, `cli/src/lib/swarmSkills.ts`,
`backend/src/superTabs/instructionsTemplate.ts` and their tests

- [ ] Failing tests: with history the note says max(5%, days × share) and the numbers; without, 20%.
- [ ] Code, and the guide and template lines.

## Task 5: Evidence

- [ ] Red/green per task in a PR comment; the formula and one worked day of real numbers in the PR body.
