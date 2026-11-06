# PM account rotation: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PM moves by itself between the Claude accounts its machine's owner ticked, before its account runs out,
keeping the same conversation; works from the command line on a machine with no screen.

**Architecture:** The core's `agent_restart` learns to relaunch an agent's same session under another Claude profile,
carrying the transcript across. A `PmRotation` in the Super Tab host, which already sees the PM's roster row, its turn
and the accounts' quota, decides when and where to move and asks the local daemon to restart. The pool of ticked
accounts is a private file on the machine, read and written through owner-only requests used by a new
`harness pm accounts` command and by Desktop.

**Tech Stack:** TypeScript (CLI and daemon, vitest), Flutter/Dart (Desktop).

**Spec:** `docs/specs/2026-11-06-pm-account-rotation.md`

## Global Constraints

- Thresholds, exact: low = under **5%** left in the 5-hour or the weekly window; a move waits for a turn end for at most
  **10 minutes**; no new move within **2 minutes** of the last; a resume counts as failed when the process exits or a
  limit or error line shows within **30 s**.
- Pick rule: among ticked, signed-in accounts with over 5% in both windows, the most left in the tighter window; tie →
  the weekly window that resets soonest.
- Files in `env.ADAPTER_DATA_DIR`, written with the private-state helpers (`lib/secureState.ts`, atomic rename) as
  `accountOffers.ts` does: `pm-account-pool.json` (at most 32 profile ids) and `pm-account-moves.jsonl` (last 200 lines).
- Copy, exact (`{…}` filled in):
  - move: `{pm} moved to {to}: {from} had {n}% of its {window} left. Same conversation.` (`{window}` is `5-hour window`
    or `week`; when out: `{from} was out of quota.`)
  - all out: `{pm} is paused: every Claude account it may use is out. The earliest resets at {time} ({label}).`
  - failed: `{pm} could not move to {to} and is back on {from}.`
  - typed after an "out" move or a reset: `Continue`
- Only the machine's owner may call the pool and history requests (the same check `claude_profiles_list` uses in
  `services/models.ts`). A restart's `claudeHome` must be one of `listClaudeProfiles(...)`'s paths on this machine.
- Claude only. Codex and other engines are untouched.
- No change under `cli/src/core` beyond Task 1; Task 1 needs the separate architecture review `cli/AGENTS.md` rule 1
  asks for. `src/core` and `src/services` stay at 100% coverage (`npm run test:core`); superTabs files listed in
  `vitest.super-tabs.config.ts` keep their thresholds.
- Never test against the developer's real `~/.claude`, Keychain or daemon (`cli/AGENTS.md` rule 6): throwaway homes only.
- Commit or push only when Diego asks.

## Review Focus

- The PM's own account is ticked off while the PM runs on it: it stays until it runs low, then moves to a ticked one
  (Task 3 test `an unticked current account is left at the next move, not at once`).
- Two PMs on one machine share the pool: both may pick the same account; each moves independently, and the second
  pick reads quota after the first move (Task 3 test `two PMs pick independently`).
- The target profile's `projects/` is a symlink to the source's (Orca style): no copy is made and the transcript path
  stays the same (Task 1 test `same projects folder copies nothing`).
- The resumed process fails (exit, or a limit line, within 30 s): the PM goes back to its previous account once and the
  owner is told; no loop (Task 3 test `a failed resume falls back once`).
- The daemon restarts while a PM is out and waiting for a reset: the reset still wakes it, because the wait is derived
  from the readings, not held only in memory (Task 3 test `a reset after a daemon restart still continues the PM`).

---

### Task 1: Restart an agent's same session under another Claude profile (core)

**Files:**
- Create: `cli/src/lib/claudeTranscriptCarry.ts`, `cli/src/lib/claudeTranscriptCarry.spec.ts`
- Modify: `cli/src/lib/registry.ts` (a setter beside the fill-only rule at ~:1626), `cli/src/core/agents/restart.ts`
  (`createAgentRestarter`), `cli/src/backendSocket.ts:1361` (`agent_restart` passes `claudeHome`)
- Test: `cli/src/core/agents/restart.spec.ts`

**Interfaces:**
- Produces: `carryClaudeTranscript(from: string | undefined, to: string | undefined, cwd: string, sessionId: string): { transcriptPath: string; copied: boolean }`
  (`undefined` = the default account's `~/.claude`; locates `<home>/projects/<encoded cwd>/<sessionId>.jsonl` with the
  same encoding `engines/claude/sessionStore.ts` uses; copies only when the two `projects` folders' real paths differ;
  never deletes the source).
- Produces: `Registry.setClaudeHome(agentId: string, claudeHome: string | undefined): void` and the `agent_restart`
  request field `claudeHome?: string | null` (`null` = the default account). The restart keeps `sessionId`, resumes,
  sets `CLAUDE_CONFIG_DIR` from the new home (or clears it for the default), and updates `transcriptPath`.

- [ ] **Step 1: Write the failing tests**
  - `claudeTranscriptCarry.spec.ts`: `copies the session file into the other account's projects` (two temp homes →
    file exists under the target, source kept, `copied: true`); `same projects folder copies nothing` (target
    `projects` is a symlink to the source's → `copied: false`, same path); `a missing session file throws NOT_FOUND`.
  - `restart.spec.ts`: `a restart with claudeHome resumes the same session under that home` (relaunch env has
    `CLAUDE_CONFIG_DIR=<to>`, argv resumes `<sessionId>`, registry `claudeHome` and `transcriptPath` updated);
    `claudeHome null restarts on the default account` (no `CLAUDE_CONFIG_DIR`); `a claudeHome that is not a profile
    of this machine is refused` (error `INVALID_PROFILE`, nothing killed); `a restart without claudeHome is unchanged`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/claudeTranscriptCarry.spec.ts src/core/agents/restart.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces. Validate `claudeHome` against `listClaudeProfiles` paths before any kill.
- [ ] **Step 4: Run** the same tests, then `npm run typecheck` and `npm run test:core`. Expected: PASS, 100% on touched core files.
- [ ] **Step 5: Commit** (when Diego asks): `feat(cli): restart an agent's session under another Claude account`

### Task 2: The PM's account pool and its owner-only requests

**Files:**
- Create: `cli/src/lib/pmAccountPool.ts`, `cli/src/lib/pmAccountPool.spec.ts`
- Modify: `cli/src/superTabs/service.ts` (request handlers), `cli/src/core/api.ts` (`SUPER_TABS_REQUESTS` or the
  request list the superTabs service declares)
- Test: `cli/src/superTabs/pmAccountsRequests.spec.ts`

**Interfaces:**
- Produces: `readPmPool(): string[]`, `setPmPool(ids: string[]): void` (dedupe, at most 32, unknown ids kept until
  unticked), `appendPmMove(move: PmMove): void`, `readPmMoves(limit?: number): PmMove[]` where
  `PmMove = { at: number; pm: string; from: string; to: string; why: 'low' | 'out' | 'reset' | 'fallback'; window?: '5-hour' | 'weekly'; leftPercent?: number; awayMs?: number; ok: boolean }`.
- Produces requests (owner only): `pm_accounts_list` → `{ accounts: Array<{ id, label, email?, default?: true, pmMayUse: boolean, pmHere: string[] /* PM names on it */, signedIn: boolean, windows: Array<{ name: '5-hour' | 'weekly'; leftPercent: number; resetsAt?: string }> }> }`
  (quota from `ContributedMachines.profileAllowance`/`allowance`, no new reads); `pm_accounts_use { ids: string[], on: boolean }`
  → `{ pool: string[] }`; `pm_accounts_history { limit?: number }` → `{ moves: PmMove[] }`.

- [ ] **Step 1: Write the failing tests**: pool round-trip and cap 32; history keeps the last 200 and survives a
  damaged line; `pm_accounts_list` marks ticked and current accounts and returns both windows; a non-owner gets
  `FORBIDDEN` on all three; `pm_accounts_use` with an id that is not a profile here is refused `NOT_FOUND`.
- [ ] **Step 2: Run** `npx vitest run src/lib/pmAccountPool.spec.ts src/superTabs/pmAccountsRequests.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the same tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** (when Diego asks): `feat(cli): a machine's owner chooses the Claude accounts its PM may use`

### Task 3: PmRotation in the Super Tab host

**Files:**
- Create: `cli/src/superTabs/pmRotation.ts`, `cli/src/superTabs/pmRotation.spec.ts`
- Modify: `cli/src/superTabs/host.ts` (roster tick at ~:1287, beside `leadSwitches.serve(row)`),
  `cli/vitest.super-tabs.config.ts` (add the new file to FILES)

**Interfaces:**
- Consumes: Task 1's `agent_restart { agentId, claudeHome }` (sent the way host.ts:686 sends `agent_restart` over the
  local daemon socket); Task 2's `readPmPool`, `appendPmMove`; `ContributedMachines.profileAllowance`/`allowance`;
  `limitOf` (terminal.ts:140) for the PM's screen; `leadTurn(harnessId)` for idle; `LimitResume`'s typing guard for
  `Continue`; `person.tell` posted as the PM to the machine owner's person id (the account the host is signed in as).
- Produces (pure, exported for tests): `pmNeedsMove(windows, now): { why: 'low' | 'out'; window: '5-hour' | 'weekly'; leftPercent: number } | null`;
  `pickPmAccount(candidates: Array<{ id; signedIn; windows }>, currentId: string): string | null`;
  `class PmRotation { constructor(deps); serve(row: SwitchRow, now: number): Promise<void> }`.

- [ ] **Step 1: Write the failing tests** (fake deps, fixed clock):
  - `pmNeedsMove`: 4% weekly → low/weekly/4; 5-hour at 3% with weekly 60% → low/5-hour; limit line on screen → out.
  - `pickPmAccount`: picks the most left in the tighter window; tie → soonest weekly reset; skips signed-out, ≤5% and
    the current; returns null when none.
  - `moves between turns when low`: PM working → no restart; turn ends → one `agent_restart` with the picked home.
  - `moves after 10 minutes without a pause`: never idle → restart at the first turn end after 10 min.
  - `an out PM moves at once and types Continue`.
  - `fewer than two ticked accounts never moves`.
  - `a second move waits 2 minutes`.
  - `the owner is told each move` (exact move copy, `person.tell`); `appendPmMove` written with `awayMs`.
  - `every account out tells the owner once and waits for the earliest reset` (exact all-out copy, one tell per reset window).
  - Review Focus tests: `an unticked current account is left at the next move, not at once`; `two PMs pick
    independently`; `a failed resume falls back once` (exact failed copy, `why: 'fallback'`, no second attempt);
    `a reset after a daemon restart still continues the PM`.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/pmRotation.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `PmRotation` and call `serve(row, now)` from the roster tick for rows with `lead === true`
  running on this machine and engine `claude`.
- [ ] **Step 4: Run** the spec, `npx vitest run src/superTabs/host*.spec.ts`, `npm run typecheck`, and the super-tabs
  config's coverage run. Expected: PASS.
- [ ] **Step 5: Commit** (when Diego asks): `feat(cli): a PM moves to another of its Claude accounts before its own runs out`

### Task 4: `harness pm accounts` for machines with no screen

**Files:**
- Create: `cli/src/pmAccountsCommand.ts`, `cli/src/pmAccountsCommand.spec.ts`
- Modify: `cli/src/cli.ts` (register the command beside the other daemon-backed commands)

**Interfaces:**
- Consumes: Task 2's three requests over the local daemon connection; `linkClaudeProfile`.
- Produces: `harness pm accounts` (table: label, email, 5-hour left, week left, PM may use, PM here),
  `harness pm accounts add [--no-use]` (creates `~/.harness/claude-profiles/<uuid>`, runs `claude auth login` with
  `CLAUDE_CONFIG_DIR` set and the terminal attached, checks `claude auth status`, links it, ticks it unless `--no-use`),
  `harness pm accounts use [--off] <account>…` (by label, email or id), `harness pm accounts history`.

- [ ] **Step 1: Write the failing tests** with a fake daemon and a fake `claude` binary on PATH: list prints both
  windows; `add` creates the folder, runs `claude auth login` with `CLAUDE_CONFIG_DIR` set, then ticks; a failed login
  leaves no linked profile and exits non-zero; `use` resolves an email to its id; `history` prints newest first.
- [ ] **Step 2: Run** `npx vitest run src/pmAccountsCommand.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec and `npm run typecheck`. Expected: PASS. By hand on a Linux box (or a throwaway home):
  `harness pm accounts add` prints Claude's login link.
- [ ] **Step 5: Commit** (when Diego asks): `feat(cli): harness pm accounts, to sign in and choose the PM's accounts from a terminal`

### Task 5: Desktop: "PM may use" on the machine's Claude accounts

**Files:**
- Modify: `desktop/lib/state/app_state.dart` (beside `listClaudeProfiles` ~:16301), `desktop/lib/super_tabs/swarm_accounts.dart`
- Test: `desktop/test/swarm_accounts_pm_test.dart` (create)

**Interfaces:**
- Consumes: Task 2's requests.
- Produces: `AppNotifier.pmAccounts(machineId)`, `setPmAccountUse(machineId, ids, on)`, `pmAccountMoves(machineId)`;
  in the accounts dialog a "PM may use" checkbox per account, 5-hour and week meters, a state chip (`PM is here`,
  `Ready`, `Out until {time}`, `Sign in again`) and a "Moves" list; the rule line from the mockup.

- [ ] **Step 1: Write the failing widget tests**: ticks call `setPmAccountUse`; meters show both windows; chips per
  state; an older CLI (request unknown) hides the column without an error; history lists moves newest first.
- [ ] **Step 2: Run** `cd desktop && flutter test test/swarm_accounts_pm_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement**, following `desktop/design/desktop-design-system.md` and the mockup.
- [ ] **Step 4: Run** the test, `flutter analyze` on touched files, and
  `python3 scripts/check-ui-style.py --only desktop/lib/super_tabs` from the repo root. Expected: PASS.
- [ ] **Step 5: Commit** (when Diego asks): `feat(desktop): choose the Claude accounts a PM may use`

## Review repairs (#4089)

The takeover keeps the existing feature and fixes the architecture and security findings test first. Each repair commits
its failing regression before its implementation. The transcript and command repairs have independent files and interfaces
and may run in parallel. The hold label stays; both live PM-machine tests and all three reviewers must pass before merge.

### Repair 1: Transcript isolation

**Files:** `cli/src/lib/claudeTranscriptCarry.ts` and its spec.
**Interface:** Keep `carryClaudeTranscript` unchanged; reject non-regular session files and unsafe project children while
preserving supported shared `projects` roots. Publish through a private random temporary file without following links.

- [ ] Add and run regressions for symlinked session files, project children and temporary destinations; commit red evidence.
- [ ] Implement safe copying without copying account settings or tokens; run the focused spec and commit green.

### Repair 2: Honest command failures

**Files:** `cli/src/pmAccountsCommand.ts` and its spec.
**Interface:** Every daemon refusal produces a nonzero command result; no success or empty-account message on a refusal.

- [ ] Add refusal cases for list, use/untick, add/tick and history using real response envelopes; run and commit red.
- [ ] Check replies at the command boundary; retain successful behavior; run focused tests and commit green.

### Repair 3: PM authority, account preservation and recovery

**Files:** `cli/src/core/api.ts`, `cli/src/core/agents/restart.ts`, their specs, `cli/src/superTabs/pmRotation.ts` and its
spec, and the matching CLI/backend `productUsageContract.ts` launch-error lists.
**Interfaces:** The account-changing API only admits retained Leads. Ordinary restarts keep a launch-supplied account.
An account move must resume the existing conversation, with no fresh-session fallback. A late failure attempts one
recovery and the owner learns its actual outcome, including a failed recovery.

- [ ] Reproduce the launch-error contract failure; test non-Lead refusal, shell account preservation, no fresh fallback,
  post-stop failure and failed rollback; commit each failing regression before the corresponding fix.
- [ ] Implement the smallest fixes and run affected specs/typecheck. Run required core coverage and reuse only evidence
  whose sources remain unchanged; record CI and red/green receipts accurately.
- [ ] Return the fixed revision to the same architecture and security reviewers, then prepare the two live tests for
  Diego's explicitly selected PM and accounts. Merge only after the required receipts and green CI.
