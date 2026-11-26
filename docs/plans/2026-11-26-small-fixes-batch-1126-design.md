# Small fixes, batch 4 (2026-11-26)

One pull request, eleven fixes found in CI runs, Windows logs and reviews. Each item was checked on `main` at
41b55c1a34 and is still open there. Each item that changes behavior gets a test that fails first.

Platforms: macOS, Linux, Windows. Windows CI runs by path; the Windows VM (ssh admin@192.168.64.7) is used only after
harness-pm hands it out. No real accounts; a local model stub exists if a check needs one.

## Intent

Make nightly CI green, take the last recorded flaky PTY test off the table, and close eight small correctness gaps
found since #4604, #4622 and #4626, so the daemon on Windows and every engine's rebind behave as the code already says
they should.

Non-goals: the "after a daemon restart the scan doesn't find the Claude agent in VS Code again" bug (fixed on its own
branch, #4634). No new feature, setting or screen.

Anti-goals: weakening `scripts/verify-cli-test-shards.py` for real failures; replaying a whole conversation live on a
fork or a resume; any new rule, list or record in the daemon core for an experiment.

## Items

### 1. Flaky `host_lock::tests::one_holder_at_a_time` (Rust, `pty/`)

Failed on `windows-e2e / windows-pty` (x64), run 45666492430; recorded in `docs/validation-and-release.md` →
"Recorded flaky tests".

Cause (a test bug): `instance::tests::a_tag_names_a_guest_hosts_instance_apart_and_an_unusable_one_is_ignored`
(`pty/src/instance.rs`) sets and removes `HARNESS_PTY_INSTANCE_TAG` in the process environment. Its `ENV_LOCK` only
orders the tests in `instance.rs`; every other test that calls `instance::current()` (through `host_lock::file_path`,
`pane_ids`, `discovery`, `logfile`, `transport/windows.rs`) runs on another thread at the same time. Two `take()`s in
`one_holder_at_a_time` then name two different lock files, so the second take succeeds.

Fix: split the tag rule into a pure function of the variable's value (for example `instance_for(tag: Option<&str>)`
or `tag_from(value)`), test that function directly, and have no test mutate the environment. `current()` keeps reading
the variable once at its call, as now. Remove the test's row from the flaky table in the same pull request.

Red test: hard to make the race fail on demand; the evidence is the removed `set_var`/`remove_var` (no test in `pty/`
writes `HARNESS_PTY_INSTANCE_TAG`, checked by a grep in the PR) plus the pure function's own test. The builder may add a
guard test if a cheap one exists.

### 2. Nightly "CLI end to end" e2e-summary is red (runs 45663585025, 45453447269)

`scripts/verify-cli-test-shards.py` rejects Vitest's `pending` status. In `cli/e2e/dialAppEvalIterm.e2e.ts` a nested
`describe.skipIf(!herdrBinary)('herdr', ...)` (line 137) inside `describe.skipIf(!MAC)` leaves its 4 cases `pending`,
though every shard passes.

Fix: drop the nested `describe.skipIf`; each herdr case uses `it.skipIf(!herdrBinary)` (the file stays macOS only),
so those cases report `skipped`, which the verifier accepts and lists. The verifier is not changed.

Red test: the verifier run on the shard reports of that file fails before (a `pending` case) and passes after; a local
run of the file's report through `verify-cli-test-shards.py`, or the smallest reproduction the builder finds, is the
evidence. Phase 4: one manual "CLI end to end" run on the branch (harness-pm's turn).

### 3. A rebind folds the new conversation's first turns away as history (`cli/src/lib/firstTurnReplay.ts:37`)

`transcriptIsFirstTurn` returns false whenever `options.rebound` is set (since #374), and
`cli/src/core/agents/bind.ts:419-423` passes `rebound: !!meta.rebound`. So when an agent starts a new conversation in
the same pane (Claude `/clear`, Codex `/new`, the engines #4622 rebinds when a resumed agent follows a new
conversation), the new transcript's first turn is folded as history and never reaches web or device.

Fix: on a rebind, replay live only on a real "new conversation" signal, per engine:
- Claude: `SessionStart` with `source: 'clear'`.
- Codex: `/new`, and #4622's resumed-agent-follows-new-conversation path: `SessionStart` with `source` `startup` or
  `clear`, the two sources codex-rs gives a thread that starts with no history (main session's call after planning).
- Every other engine #4622 rebinds: its own signal, or the PR says which engines cannot hit this path and why.

And only when the new transcript was born after the replaced binding, within a window derived from something real
(for example the replaced binding's replaced-at time), or a number whose reason the code comment states. Birth time
alone is not enough: a fork (including Harness's own Codex fork retarget) is also a rebind to a transcript born late,
and replaying it would send the whole history live.

Red test: one per engine that can hit it, at the layer the behavior lives (`firstTurnReplay.spec.ts` for the rule,
plus the bind path where the signal is read). A fork and a resume stay folded (tests that pass before and after).

`bind.ts` is a daemon core file: `npm run test:core` at 100%.

### 4. `onPromptSubmitted` is a dead handler

`cli/src/hookServer.ts:120` declares it and line 988 calls it, but no production code supplies it (its wiring was lost
in #1165; only specs pass one). Fix: remove the handler, its call and the specs' uses; `cli/hook/notify.mjs` stops
sending the prompt text that nothing reads (`boundedPrompt`), unless the builder finds a reader the grep missed, in
which case it says so and keeps the field.

No behavior change for users; tests that asserted the handler go with it.

### 5. Two #4622 specs never run on Windows CI

`cli/src/hookServer.wait.spec.ts` and `cli/src/core/engines/sessionHookWait.spec.ts` are on neither
`.github/workflows/windows.yml`'s `$paths` lists nor `WINDOWS_SPECS` (`scripts/ci-plan.py:101`). Fix: add both to
both, keeping `test_the_windows_spec_list_is_windows_ymls` green.

### 6. The `windows-pty-e2e` driver calls the daemon's loopback port and gets 401

Windows clients now reach the daemon through its named pipe. `cli/scripts/windows-pty-e2e/driver.mts` still opens the
loopback port. Fix: the driver uses `openLocalWs` (the pipe), as every other Windows client does. Its doc names the
wrong log folder: it becomes `C:\work\e2e\data\harness.log`.

Red test: `driver.test.mts` (or the nearest test of the driver's connection) fails while it builds a loopback URL.
Phase 4: the driver run once on the Windows VM, after harness-pm hands it out (no account needed).

### 7. `[fatal-guard] uncaughtException: ECONNRESET` on Windows when a refused client disconnects

`rejectUpgrade` (`cli/src/localWsServer.ts:138`) ends the socket with no `'error'` listener; a client that resets
before the end flushes raises an unhandled `ECONNRESET`. All seven refusals (lines 275-310) go through it. Fix:
`rejectUpgrade` attaches an `'error'` handler before it writes and ends.

Red test: a refused upgrade whose client resets raises no unhandled error (the socket's `'error'` has a listener).

### 8. `isApprovalDialog` misses Hermes and Copilot permission asks

`cli/src/engines/kit/questionPane.ts:387` misses approvals that box their command with neither `$ ` nor "would you
like to run"; #4626 covered only `offersApproval` in `keepsIdByWords`. So the screen's `permission_open` hold
(`engines/kit/screen.ts:12`) and the question's `permission` flag (`lib/questionController.ts:868`) read Hermes's and
Copilot's asks as questions.

Fix: one rule. `isApprovalDialog` recognizes Hermes's and Copilot's approval dialogs (from their real pane fixtures), so
the hold and the flag both see them. The id-keeping rule keeps #4626's `offersApproval` catch-all.

Red test: Hermes and Copilot approval fixtures read as `permission_open` and carry `permission: true`.

### 9. A legacy held restore row whose pane cannot be read waits with no timer

A row saved by 0.6.86 or older (`legacyNativeHold`, `cli/src/lib/restoreAgents.ts:121`) whose pane is alive but
cannot be read (`waiting` undefined) is pushed to `unsurveyed` (line 532) and waits for the next held pass, with no
timer of its own. Fix: it shares #4604/#4626's bounded retry: first try after 2 s, backing off to 30 s, and
`DID_NOT_START` after 15 minutes, as `core/agents/heldLaunches.ts` does for a guard-held row.

Red test: a legacy row with an unreadable pane is tried again on the retry schedule and fails with `DID_NOT_START`
after the bound. `heldLaunches.ts` and `restart.ts` are core files: `test:core` at 100%.

### 10. Claude Code on Windows: the process record has `procStartFt` and no `procStart`

Found in Claude Code 2.1.332's own bundle: on Windows it writes `{ procStart: undefined, procStartFt: <decimal string,
FILETIME> }`; elsewhere `{ procStart: <ps lstart text> }`. `processRecord` in `cli/src/lib/sessionRepair.ts:762-777`
requires `record[rule.start]` to be a string, so on Windows every Claude record is "incomplete or invalid", the
identity read throws, and the identity stays held. This affects every Windows Claude Code user today, worse than a
missed match.

Fix: Claude's live record accepts `procStartFt` (FILETIME, 100 ns ticks since 1601-01-01 UTC, compared at the daemon's
own precision for the process start on Windows) or `procStart` (text, to the second, as now). The comparison is
tolerant the way other platforms are: never a wrong bind (pid, cwd and id still checked), a miss at most. The rule
lives in Claude's session store contract (`cli/src/engines/claude/sessionStore.ts:32`), not as a Windows branch in
the generic reader, if the contract can carry it.

Red test: a record with only `procStartFt` for the right pid and start matches; one with the wrong start does not;
`procStart` records still match as before (`sessionStore.golden.spec.ts`, `sessionRepair` specs).

### 11. No PR check runs `store/tools/` tests

`store/tools/` has `test_runtimes.py`, `sync-runtimes --check`, `*.test.mjs` and the local-ai packaging check, and no
PR check runs them; `scripts/ci-plan.py` says store is covered by actionlint and process checks only. Fix: a `store`
component in `scripts/ci-plan.py` that selects a `store-checks` job in `.github/workflows/ci.yml` for `store/tools/`
changes: path-filtered by the planner, `permissions: contents: read`, no secrets, running only the fast, offline
checks (no browser or network suites, which `authoring-browser-checks.yml` owns).

Red test: `scripts/` planner tests: a `store/tools/` change selects `store-checks`; a change elsewhere does not.

## Approaches

The approaches for items 1, 2, 3, 4, 7, 8, 9, 10 and 11 were settled by harness-pm in the first run's approved spec
(restart note, 2026-11-26), recorded above. The alternatives it turned down:
- 1: a wider env lock across every test that reads the tag (turned down: every new test must remember it).
- 2: teach the verifier `pending` (turned down: it would also pass a real hang).
- 3: replay any rebind born after the binding (turned down: a fork replays its whole history).
- 4: wire the handler (turned down: nothing needs the prompt text).

## Constraints

- One pull request, red-then-green per behavior change, tests at the layer the behavior lives.
- Core files (`cli/src/core/`): `npm run test:core` at 100%, receipts in the PR.
- No fixed sleeps in tests; the retry tests use fake timers.
- No secrets or prompt text in logs.
- Receipts pasted before pushing.

## Left to the builder

- The exact name and shape of item 1's pure function.
- Item 3's window and how each engine's signal reaches `transcriptIsFirstTurn`; the engines that cannot hit the path.
- Item 8's matching words, from the engines' real fixtures.
- Item 10's tolerance, from how the daemon reads a process's start on Windows.
- Item 11's exact command list for `store-checks`, limited to what runs offline in under a few minutes.
