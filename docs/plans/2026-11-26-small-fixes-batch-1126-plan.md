# Small fixes batch 2026-11-26 Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Eleven fixes in one pull request: nightly "CLI end to end" green, the last recorded flaky PTY test gone, and
eight correctness gaps closed (a rebind's first turn, a dead hook handler, Windows CI coverage, the Windows PTY driver,
a refused client's reset, Hermes's and Copilot's approvals, legacy held rows, Claude Code's Windows process record),
plus a PR check for `store/tools/`.

**Architecture:** Each cause is fixed where it lives. The PTY host's instance tag becomes a pure function. The iTerm2
eval's herdr cases skip one by one. A rebind replays live only when the engine's own hook says "new conversation"
(declared in its `HookContract`, read at the hook door, passed to the bind as `newConversationSince`) and the new
transcript was born after the binding it replaced (`lib/firstTurnReplay.ts`). The hook client stops sending prompt
text, and the handler nobody wired goes. `rejectUpgrade` owns its socket's errors. `isApprovalDialog` knows Hermes's
and Copilot's boxes. The restore marks a legacy held row whose pane it cannot read with the guard's hold, so
`core/agents/heldLaunches.ts` retries and bounds it. Claude's session store contract names the Windows start field.
`scripts/ci-plan.py` gets a `store` suite with a `store-checks` job.

**Tech Stack:** TypeScript (Node 24), Vitest 4, `node:test` (the PTY driver and `store/tools`), Rust (`pty/`), Python 3
`unittest` (planner, `test_runtimes.py`), GitHub Actions YAML. `npx`/`npm` commands run in `cli/`; `cargo`, `python3`
and `node store/...` commands from the repository root unless a step says otherwise.

**Spec:** `docs/plans/2026-11-26-small-fixes-batch-1126-design.md` (read it with this plan). The orchestrator's eleven
decisions in the brief are final and are restated in each task.

## Global Constraints

- **One pull request**, red-then-green per behavior change: the failing test is committed first, then the change.
  Tests at the layer where the behavior lives; run only the tests the task names; no full suites locally (PR CI runs
  them); no fixed sleeps (fake timers, `vi.waitFor`, `until`).
- **`cli/src/core/**` and `cli/src/services/**` are 100% per file** (`npm run test:core`, `cli/vitest.core.config.ts`,
  `core/main.ts` excluded). v8 counts `??` and `?.` as branches: cover both sides. The receipt goes in the PR. Of this
  plan's files only `cli/src/core/agents/bind.ts` is under that gate (Task 12).
- **The daemon core grows no rule for an experiment** (AGENTS.md). Nothing here is an experiment; the only core file
  touched is `bind.ts`, which gains one optional field read, no list or record.
- **No prompt text, path or personal content** in logs, tests' fixtures beyond the repo's own, commit messages or the
  PR. Log lines name fixed words, counts and short ids.
- **Comments say why** (cli/AGENTS.md rule 7) and copy follows [the Naming System](../naming-system.md).
- **A change to `scripts/ci-plan.py` needs two independent security reviews before it merges**
  ([validation and release](../validation-and-release.md#reuse-after-update-branch)): Tasks 4 and 14.
- **Windows** ([docs/windows-rules.md](../windows-rules.md)): Windows clients reach the daemon through its pipe
  (`openLocalWs`), never the loopback port.
- **No production backend and no real accounts** anywhere; the Windows VM only in Verification, after harness-pm hands
  it out.
- Platforms: macOS, Linux, Windows. The PR names them and says that item 10 affects every Windows Claude Code user today.

## What this plan decides from the spec's words

- **Item 1, the pure function.** `fn instance_for(tag: Option<&str>) -> String` in `pty/src/instance.rs`: this build's
  instance (`instance_name(PROTOCOL, VERSION)`), with `-<tag>` when the tag is usable (`[A-Za-z0-9-]{1,16}`).
  `current()` is `instance_for(std::env::var(INSTANCE_TAG_VAR).ok().as_deref())`, read once at each call as now.
  `instance_tag()` and `ENV_LOCK` go. A guard test reads `pty/src/` and `pty/tests/` and fails on a line that writes
  the tag variable (`set_var`/`remove_var` beside `INSTANCE_TAG_VAR` or `HARNESS_PTY_INSTANCE_TAG`).
- **Item 2, the red evidence.** Vitest reports a case inside a skipped `describe.skipIf` nested in another skipped
  `describe.skipIf` as `pending` (reproduced in a scratch folder at 41b55c1a34: `pending`; with `describe` +
  `it.skipIf` it is `skipped`). No other e2e file nests a conditional `describe` inside a skipped one (checked:
  `dialPaneFocusFollow.e2e.ts:299`'s `describe.runIf` sits in a plain `describe`, which reports `skipped`). The red is
  the verifier run on nightly 45663585025's own shard reports (artifacts kept until 2026-12-02); the green is the
  manual CLI end-to-end run (Verification 1). PR CI's `linux-e2e` never runs this file (`LINUX_E2E_NEVER`).
- **Item 3, the signal.** The new-conversation signal is declared per engine in its hook contract, as data:
  `HookContract.newConversation?: { event: string; sources: readonly string[] }`. Claude Code:
  `{ event: 'SessionStart', sources: ['clear'] }` (its `/clear`; the decision names only this). Codex:
  `{ event: 'SessionStart', sources: ['startup', 'clear'] }`: codex-rs picks a SessionStart source from the history a
  thread starts with (`core/src/session/session.rs`: `InitialHistory::New` → `startup`, `Cleared` → `clear`,
  `Resumed` → `resume`, `Forked` with a parent → `fork`), so `startup` and `clear` are exactly the threads that start
  with no history: `/new` and `/clear` (whichever of the two `/new` reports; see "Decided after planning"), and #4622's resumed
  agent that starts one (`e2e/resumeRotation.e2e.ts`). Codex sends it lazily, inside the new thread's first turn, which
  is why its first turn is in the file by the time the rebind lands. `engines/hooks.ts`
  `startsNewConversation(engine, hookEvent, source)` reads it, from the hook body's own `source` (the row's `source`
  carries an older hook's forward: `registry.ts:2408`). A `resume`, `compact` or `fork` source, a hook with no source,
  every discovery rotation (Hermes's terminal record, OpenClaw's footer, Copilot's resume, Claude's continuation) and
  every engine with no `newConversation` stays folded, as today. Harness's Codex matcher
  (`startup|resume|clear|compact`) does not even run SessionStart for `fork`.
- **Item 3, the window.** On a rebind, live only when `newConversationSince` is set and the transcript was born at or
  after it, and within the existing `FIRST_TURN_WINDOW_MS` (10 minutes from birth; its reason is the 346 MB
  replay of #374, stated in `firstTurnReplay.ts`). `newConversationSince` is when the replaced binding began: the
  replaced row's `boundAt`, or, for a resumed row no hook had bound yet (`boundAt: null`, #4622's case), the start of
  its engine process (`startMarkerMs(processIdentity.startMarker)`). Neither readable: not set, so folded. Harness's
  Codex retarget fork (`continueInFork`) comes back as `codex resume <fork id>`, so `SessionStart` `resume`: folded;
  its fallback `codex fork <id>` reports `fork`, which Harness's matcher does not run, so its first hook is a
  `UserPromptSubmit` with no source: folded.
- **Item 3, engines that cannot hit the path** (this text goes into the PR body): see Task 11's table.
- **Item 4, the wire.** `cli/hook/notify.mjs` stops putting `prompt` in the session-start body (Claude Code, Codex and
  Grok) and `boundedPrompt` goes. The hook server's only other uses of `body.prompt` are its bound check
  (`hookServer.ts:222`) and the wait route's refusal of a body that carries one (`:453`); both stay, so a hook client
  of an older install that still sends `prompt` during an update is not refused, and nothing reads the text.
- **Item 5, the cost.** `WINDOWS_SPEC_MODULES` maps each listed spec to the module beside it, so after this change a
  change to `cli/src/hookServer.ts` or `cli/src/core/engines/sessionHookWait.ts` selects `windows-e2e` (x64) too, as
  the decision intends.
- **Item 6, the driver's way in.** `Client.connect(via?)` opens `openLocalWs(dataDir, port, (url, headers) => new
  WebSocket(url, { headers }), via.platform, via.pipe)`: on Windows the daemon's pipe, on macOS and Linux its socket.
  The URL parameter goes. The existing test `the local E2E socket presents this user's daemon credential` already
  fails at 41b55c1a34 (`ws error`, run with `npx tsx --test`); it is replaced, not repaired.
- **Item 8, the words** (from `cli/src/lib/__fixtures__/permission-hermes.txt` and `permission-copilot.txt`): Hermes's
  box title `Dangerous Command`; Copilot's `<Copilot> is attempting to <…>:` line. Each counts only after
  `offersApproval(view.rows)`, as the `$ ` and "would you like to" rules do, so a Yes/No question stays a question.
- **Item 9, the hand-over.** The restore marks a legacy row (`legacyNativeHold`) whose pane it cannot read with the
  guard's hold (`guardHold`, `deps.startAgain`), the same mark a readable one gets, and still reports it
  `unsurveyed`. From then on `heldLaunches.ts` owns it unchanged: first try 2 s after the mark, backing off to 30 s,
  `DID_NOT_START` (`NATIVE_EVIDENCE_UNSETTLED`) 15 minutes after. `heldLaunches.ts` and `restart.ts` do not change.
- **Item 10, the rule.** The contract's `live.record` gains `startFiletime?: string`; Claude's names `procStartFt`.
  A record's start is its `startFiletime` field when that field is a string (decimal FILETIME, `^\d{1,20}$`, read as
  `startMarkerMs(\`w:${value}\`)`, the daemon's own reading of a Windows process start, to the millisecond), else its
  `start` field (text, as today). A start that does not read holds the identity, as today. No platform branch.
- **Item 11, the suite.** `store` joins `EXTRA` (so `JOBS["store"] = {"store-checks"}` and a `store` manual scope),
  owns `store/tools/` through `ALSO`, skips (`NOT_READ`) the files its job does not run, and declares the one folder its
  tests read, `store/agents/` (`DEPENDS` and `PR_READS`): with those, the repository-wide cross-read scan finds no
  undeclared read (simulated in memory at 41b55c1a34). Its job runs `python3 -m unittest store/tools/test_runtimes.py`,
  `node store/tools/sync-runtimes.mjs --check`, `node --test` on the five offline top-level tests and
  `npm --prefix store/tools/local-ai test` (packaging included). `windows-pipe.test.mjs` stays with windows-e2e.
  `test_runtimes.py`'s two venv-range tests assume `/usr/bin/python3` is Apple's 3.9 and would fail on Ubuntu: Task 13
  derives their range from the Python they run.

## Review Focus

1. **A fork or a resume that rotates the row inside the replay window** (Codex retarget's fork, Claude `/resume` of a
   conversation started after the agent, a Codex `/resume` in its TUI): folded, never replayed. Task 10 pins the rule
   (rebound with no `newConversationSince`, and a birth before it), Task 11 pins `resume`, `compact`, `fork`, Claude's
   `startup` and a sourceless hook at the door, Task 12 pins the bind with a fresh transcript and no signal.
2. **A `/clear` whose hook lands late** (a held admission, hours later): its transcript is older than 10 minutes and
   stays folded; one of a few seconds replays once. Task 10 pins both edges of the window.
3. **A legacy held row whose pane stays unreadable for good**: tried again on the guard's schedule and failed with
   `DID_NOT_START` at 15 minutes, once, announced once, never relaunched into an unread pane. Task 8 pins it with fake
   timers through the real `createHeldLaunches` and `restoreAgents`.
4. **A Claude Code record with `procStartFt` for another process** (a recycled pid, a start one millisecond off, a
   non-numeric or overlong value, both fields present): never a wrong bind. Task 9 pins match, miss and hold.
5. **An approval whose marker line scrolls out of the dialog** (a long boxed command pushing `Dangerous Command` more
   than 12 lines above the first row): read as a question, as today, never the reverse. Task 7 adds a case that pins
   today's reading, so a later change to `dialogAbove` is seen.

---

## Tasks at a glance

| Task | Item | Depends on | Effort |
|---|---|---|---|
| 1. The PTY instance tag is a pure function | 1 | none | medium |
| 2. The iTerm2 eval's herdr cases skip one by one | 2 | none | medium |
| 3. The hook client sends no prompt text; the dead handler goes | 4 | none | high |
| 4. Windows CI runs the two hook-wait specs | 5 | none | medium |
| 5. The Windows PTY driver goes through the pipe | 6 | none | high |
| 6. A refused upgrade owns its socket's errors | 7 | none | high |
| 7. Hermes's and Copilot's approvals read as approvals | 8 | none | high |
| 8. A legacy held row whose pane cannot be read joins the guard's retry | 9 | none | xhigh |
| 9. Claude Code's Windows record (`procStartFt`) | 10 | none | xhigh |
| 10. The first-turn rule for a rebind | 3 | none | high |
| 11. The hook door names a new conversation | 3 | 3 | xhigh |
| 12. The bind replays a new conversation's first turn | 3 | 10 | xhigh |
| 13. `test_runtimes.py` runs under any Python 3.10+ | 11 | none | medium |
| 14. A `store-checks` job for `store/tools/` | 11 | 1, 4, 13 | xhigh |

Shared files, which the dependencies order: `cli/src/hookServer.ts` and `cli/src/lib/registry.admission.spec.ts`
(Tasks 3, 11), `scripts/ci-plan.py` and `scripts/tests/test_ci_plan.py` (Tasks 4, 14),
`docs/validation-and-release.md` (Tasks 1, 14). Longest chain: two tasks (3 → 11, 10 → 12, or 1/4/13 → 14).

---

### Task 1: The PTY instance tag is a pure function

**Depends on:** none. **Effort:** medium.

Item 1. Decision 1: a test bug; no test mutates the environment; the record goes from the flaky table.

**Files:**
- Modify: `pty/src/instance.rs` (the tag rule and its tests, lines 41-58 and 100-126)
- Modify: `docs/validation-and-release.md` (the `host_lock::tests::one_holder_at_a_time` row of "Recorded flaky
  tests", line 253)

**Interfaces:**
- Produces: `fn instance_for(tag: Option<&str>) -> String` (module-private); `pub fn current() -> String` unchanged
  for every caller (`host_lock`, `pane_ids`, `discovery`, `logfile`, `transport/*`, `cli`, `tests/`).

The race cannot be made to fail on demand (spec); the red is the guard test below, which fails on today's file.

- [ ] **Step 1: Write the failing guard test** in `instance.rs`'s `tests`: `no_test_writes_the_tag_variable` walks
  every `.rs` file under `concat!(env!("CARGO_MANIFEST_DIR"), "/src")` and `/tests`, and asserts no line holds both a
  write (`set_var(` or `remove_var(`) and the tag's name (`INSTANCE_TAG_VAR` or `HARNESS_PTY_INSTANCE_TAG`). Build the
  needles with `concat!("set_", "var(")` and the like so the test's own lines never match. The failure message names
  the file and line. Its comment says why: the tag is process-global, every test thread reads it through `current()`,
  and a writer renamed another test's lock file mid-run (run 45666492430).
- [ ] **Step 2: Run it and see it fail** on today's `a_tag_names_a_guest_hosts_instance_apart_…`:
  `cargo test --locked --manifest-path pty/Cargo.toml --lib instance::tests::no_test_writes_the_tag_variable`
  Expected: FAIL naming `src/instance.rs` and the `set_var` line.
- [ ] **Step 3: Commit the red test** (`test(pty): no test writes the instance tag variable`).
- [ ] **Step 4: Implement `instance_for`**, make `current()` call it with the variable's value, delete `instance_tag`
  and `ENV_LOCK`. Rewrite `a_tag_names_a_guest_hosts_instance_apart_and_an_unusable_one_is_ignored` on `instance_for`:
  `instance_for(Some("gu0123456789ab")) == format!("{base}-gu0123456789ab")`; each of `"bad tag"`,
  `"gu_0123456789ab"`, `""` and 17 `x` gives `base`; `instance_for(None) == base`. `current_is_this_builds_instance`
  stays, without the lock.
- [ ] **Step 5: Remove the row** `host_lock::tests::one_holder_at_a_time` from the table in
  `docs/validation-and-release.md` (the other two rows stay).
- [ ] **Step 6: Run the crate's tests**: `cargo test --locked --manifest-path pty/Cargo.toml` and
  `grep -rnE '(set|remove)_var\(.*(INSTANCE_TAG_VAR|HARNESS_PTY_INSTANCE_TAG)' pty/src pty/tests` (expected: no
  output; quote it in the PR). Expected: all pass.
- [ ] **Step 7: Commit** (`fix(pty): the instance tag is read by a pure function; no test writes it`).

### Task 2: The iTerm2 eval's herdr cases skip one by one

**Depends on:** none. **Effort:** medium.

Item 2. Decision 2: `it.skipIf` per case; `scripts/verify-cli-test-shards.py` unchanged.

**Files:**
- Modify: `cli/e2e/dialAppEvalIterm.e2e.ts` (line 137 and the four `it(` inside that block)

**Interfaces:** none.

- [ ] **Step 1: Show the red on the nightly's own reports.** In a scratch folder:
  `gh run download 45663585025 --pattern 'cli-e2e-shard-*' -D <scratch>/shards` then
  `python3 scripts/verify-cli-test-shards.py <scratch>/shards --suite e2e --root /home/runner/work/openharness/openharness/cli --shards 8 --tests-result success --output <scratch>/summary.json`.
  Expected: `ValueError: shard N: failed or unfinished case in e2e/dialAppEvalIterm.e2e.ts`. Keep the line for the PR.
- [ ] **Step 2: Change the block**: `describe.skipIf(!herdrBinary)('herdr', …)` becomes `describe('herdr', …)`, and
  each of its four cases is `it.skipIf(!herdrBinary)(…)`. The helpers inside (`started`, `herdrIn`, `agentPid`) stay.
  Its comment says why: a skipped `describe` inside the skipped macOS block reports its cases `pending`, which the
  shard verifier refuses as unfinished (nightlies 45453447269, 45663585025).
- [ ] **Step 3: Show the green on the smallest reproduction.** In a scratch folder outside the repository, one
  `x.test.ts` with the file's shape (`describe.skipIf(true)` holding a plain `describe` whose `it.skipIf(true)` cases
  run), run with `cli/node_modules/.bin/vitest run --root <scratch> --reporter=json --outputFile=<scratch>/out.json`.
  Expected: every case `skipped`, none `pending`. Delete the scratch folder.
- [ ] **Step 4: Collect the file** (the CLI's `tsc` covers `src/` only): `npx vitest list --config vitest.e2e.config.ts
  e2e/dialAppEvalIterm.e2e.ts` in `cli/`. Expected: the four herdr cases listed under `herdr`, no collection error.
- [ ] **Step 5: Commit** (`test(e2e): the iTerm2 eval's herdr cases skip one by one, so the nightly summary takes
  them`). The real proof is Verification 1.

### Task 3: The hook client sends no prompt text; the dead handler goes

**Depends on:** none. **Effort:** high.

Item 4. Decision 4. Checked at 41b55c1a34: nothing in `cli/src` reads `body.prompt` but the bound check
(`hookServer.ts:222`), the wait route's refusal (`:453`) and the dead call (`:988`).

**Files:**
- Modify: `cli/hook/notify.mjs` (`boundedPrompt` at 306-310 and its two uses at 2633 and 2799-2800)
- Modify: `cli/src/hookNotify.spec.ts` (the cases at 427-436, 465-487)
- Modify: `cli/src/hookServer.ts` (the `onPromptSubmitted` member at 120 and its call at 987-988)
- Modify: `cli/src/hookServer.spec.ts` (69-82)
- Modify: `cli/src/hookAdmission.golden.spec.ts` (92, 121) and `cli/src/__fixtures__/hook-admission.golden.json`
  (re-recorded: the `prompts` lists go)
- Modify: `cli/src/lib/registry.hookPersistence.spec.ts` (25-136) and `cli/src/lib/registry.admission.spec.ts`
  (412-463)

**Interfaces:**
- Produces: `HookServerHandlers` without `onPromptSubmitted`. Task 11 edits the same `notify()` in `hookServer.ts`.

- [ ] **Step 1: Write the failing test** in `hookNotify.spec.ts`: rename `forwards the actual %s accepted prompt …`
  to `announces a %s prompt without its text` and assert, for `claude`, `codex` and `grok`, a request to
  `/api/hook/session-start` with `hookEvent: 'UserPromptSubmit'` and `engine`, and
  `expect(request.body).not.toHaveProperty('prompt')`. In `still announces an oversized %s prompt …` keep the two
  requests and assert the same absence; in `does not inject companion context …` replace
  `expect(requests[0]?.body.prompt).toBe(input.prompt)` with the absence.
- [ ] **Step 2: Run it and see it fail**: `npx vitest run src/hookNotify.spec.ts -t 'prompt'`. Expected: FAIL, the
  body has `prompt`.
- [ ] **Step 3: Commit the red test.**
- [ ] **Step 4: Stop sending it**: drop the `prompt` spread from both bodies in `notify.mjs` and delete
  `boundedPrompt`. Remove `onPromptSubmitted` from `HookServerHandlers` and the `optional(() =>
  handlers.onPromptSubmitted?.(…))` call; `onPromptHook` stays. Next to the bound check at `hookServer.ts:222`, one
  comment line: no hook of this build sends `prompt`; an older install's hook may during an update, and is not refused
  for it; nothing reads it.
- [ ] **Step 5: Move the specs off the handler.** `hookServer.spec.ts`: drop the `onPromptSubmitted` mock; the case
  keeps `expect(handlers.onRegistered).not.toHaveBeenCalled()`. `registry.hookPersistence.spec.ts` and
  `registry.admission.spec.ts`: each `prompts` assertion becomes the same assertion on the `registered`
  (`onRegistered`) mock, by count and by the delivery's session id where it named a delivery (each committed
  `UserPromptSubmit` calls `onRegistered` once, in commit order): for example
  `expect(registered.mock.calls.map(([entry]) => entry.sessionId))`. Where a case posted two prompts to tell them
  apart, post them under two delivery ids or two session ids. `hookAdmission.golden.spec.ts`: drop `prompts` from the
  handlers and from `check('callbacks', …)`, then re-record with `RECORD_HOOK_ADMISSION_GOLDEN=1 npx vitest run
  src/hookAdmission.golden.spec.ts` and check the diff removes only the `prompts` lists.
- [ ] **Step 6: Run**: `npx vitest run src/hookNotify.spec.ts src/hookServer.spec.ts src/hookAdmission.golden.spec.ts
  src/lib/registry.hookPersistence.spec.ts src/lib/registry.admission.spec.ts` and `npm run typecheck`, then
  `git grep -n 'onPromptSubmitted\|boundedPrompt' cli` (expected: no output). Expected: all pass.
- [ ] **Step 7: Commit** (`fix(hooks): the hook client sends no prompt text, and the handler nothing wired goes`).

### Task 4: Windows CI runs the two hook-wait specs

**Depends on:** none. **Effort:** medium.

Item 5. Decision 5.

**Files:**
- Modify: `.github/workflows/windows.yml` (the first `$paths` list, line 217: add `'src/hookServer.wait.spec.ts'`
  and `'src/core/engines/sessionHookWait.spec.ts'`)
- Modify: `scripts/ci-plan.py` (`WINDOWS_SPECS`, lines 101-120: add `"cli/src/hookServer.wait.spec.ts"` and
  `"cli/src/core/engines/sessionHookWait.spec.ts"`)
- Modify: `scripts/tests/test_ci_plan.py` (one new test)

**Interfaces:** none. Task 14 edits the same two Python files after this one.

- [ ] **Step 1: Write the failing test** `test_the_hook_wait_specs_run_on_windows` in `SelectionTests`: for each of
  `cli/src/hookServer.wait.spec.ts`, `cli/src/core/engines/sessionHookWait.spec.ts`, `cli/src/hookServer.ts` and
  `cli/src/core/engines/sessionHookWait.ts`, `assertIn("windows-e2e", planner.select([path])[0])` and
  `assertTrue(planner.windows_e2e(path))`.
- [ ] **Step 2: Run it and see it fail**: `cd scripts/tests && python3 -m unittest
  test_ci_plan.SelectionTests.test_the_hook_wait_specs_run_on_windows`. Expected: FAIL, `windows-e2e` not selected.
- [ ] **Step 3: Commit the red test.**
- [ ] **Step 4: Add both specs to both lists** (the first `$paths` line only; the second is the real builds').
- [ ] **Step 5: Run**: the new test, `test_the_windows_spec_list_is_windows_ymls` and
  `test_every_spec_windows_yml_runs_selects_windows_end_to_end`, then `cd scripts/tests && python3 -m unittest
  test_ci_plan` (the planner's whole file is fast; the full-checkout tests skip outside CI's scan job). Expected: pass.
- [ ] **Step 6: Commit** (`ci(windows): the hook-wait specs of #4622 run on Windows`).

### Task 5: The Windows PTY driver goes through the pipe

**Depends on:** none. **Effort:** high.

Item 6. Decision 6.

**Files:**
- Modify: `cli/scripts/windows-pty-e2e/driver.mts` (the header comment, imports, `Client.connect`, lines 1-10, 59-62)
- Modify: `cli/scripts/windows-pty-e2e/driver.test.mts` (replace `the local E2E socket presents this user's daemon
  credential`, lines 58-100)
- Modify: `docs/testing/windows-pty-e2e.md` (the daemon's log is `C:\work\e2e\data\harness.log`; the driver reaches
  the daemon over its pipe, lines 10-14 and 86-91)

**Interfaces:**
- Consumes: `openLocalWs(dataDir, port, connect, platform?, pipe?)` and `PipeTarget` (`cli/src/lib/localTransport.ts`,
  `cli/src/lib/windows/pipeClient.ts`), `NOT_RUNNING` (`cli/src/lib/unreachable.ts`).
- Produces: `Client.connect(via?: { platform?: NodeJS.Platform; pipe?: (dataDir: string, port: number) =>
  PipeTarget | null }): Promise<this>`; the port is `E2E_PORT` or 18473, the data folder `ADAPTER_DATA_DIR` or
  `~/.harness/cli/data`, as today. `e2e.mts` calls `connect()` unchanged.

- [ ] **Step 1: Write the failing tests** in `driver.test.mts`:
  `a Windows driver opens no loopback port: with no pipe it says Harness is not running` (`connect({ platform:
  'win32', pipe: () => null })` rejects with `NOT_RUNNING`, and a loopback test server on `E2E_PORT` sees no
  connection); and `a macOS or Linux driver reaches the daemon over its socket` (a short data folder made with
  `mkdtempSync('/tmp/hpd-')`, a server from `listenLocalSocket(handler, unixSocketPath(dataDir, port))`
  (`cli/src/lib/localSocket.ts`, as `localWsServer.spec.ts` uses it) whose upgrades go to a `WebSocketServer`
  answering `machine_select` with `connected`; `connect()` gets `connected`). Skip the second on `win32`.
- [ ] **Step 2: Run them and see them fail**: `npx tsx --test scripts/windows-pty-e2e/driver.test.mts`. Expected:
  both FAIL (the driver dials `ws://127.0.0.1:…`).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** `connect(via)` on `openLocalWs`; `localCredentialHeaders` leaves the imports when nothing
  else uses it. The header comment says the driver reaches the daemon as every other client does: its pipe on Windows,
  its socket elsewhere, still with no account.
- [ ] **Step 5: Fix the doc**: the daemon's log path becomes `C:\work\e2e\data\harness.log`, and the "loopback
  WebSocket" lines say the pipe.
- [ ] **Step 6: Run**: `npx tsx --test scripts/windows-pty-e2e/driver.test.mts` and
  `cli/scripts/windows-pty-e2e/build.sh <scratch>` (the bundle still builds). Expected: all pass. The run on Windows
  is Verification 2.
- [ ] **Step 7: Commit** (`fix(windows-pty-e2e): the driver reaches the daemon over its pipe`).

### Task 6: A refused upgrade owns its socket's errors

**Depends on:** none. **Effort:** high.

Item 7. Decision 7.

**Files:**
- Modify: `cli/src/localWsServer.ts` (`rejectUpgrade`, lines 138-147; export it)
- Modify: `cli/src/localWsServer.spec.ts`

**Interfaces:**
- Produces: `export function rejectUpgrade(socket: Socket, status: number, reason: string, retryAfter?: number): void`
  (exported for its test only; its seven callers at 275-310 are unchanged).

- [ ] **Step 1: Write the failing tests**: `a refused upgrade's client that resets raises nothing` calls
  `rejectUpgrade` on a stand-in socket (`Object.assign(new EventEmitter(), { destroyed: false, end: vi.fn() })`) and
  asserts `end` was called and `expect(() => socket.emit('error', Object.assign(new Error('read ECONNRESET'),
  { code: 'ECONNRESET' }))).not.toThrow()`; and `the caller lookup's refusal keeps a listener on the socket` through
  the real server, as `survives a client that resets while the lookup …` (line 324) does, with `peerAccount` resolving
  `false`: after the client sees 401, `expect(held!.listenerCount('error')).toBeGreaterThan(0)`.
- [ ] **Step 2: Run them and see them fail**: `npx vitest run src/localWsServer.spec.ts -t 'refused upgrade|refusal keeps'`.
  Expected: FAIL (the emit throws; no listener after the lookup removed its own).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement**: before `socket.end(…)`, `socket.on('error', () => {})`, with a comment: a refused
  client that resets before the reply is flushed raised an uncaught `ECONNRESET` on Windows (`[fatal-guard]`); the
  refusal is the whole exchange, so its reset is no failure of ours. A destroyed socket still returns first.
- [ ] **Step 5: Run**: `npx vitest run src/localWsServer.spec.ts`. Expected: pass.
- [ ] **Step 6: Commit** (`fix(local-ws): a refused upgrade's client reset is no uncaught error`).

### Task 7: Hermes's and Copilot's approvals read as approvals

**Depends on:** none. **Effort:** high.

Item 8. Decision 8: one rule in `isApprovalDialog`, so the screen's `permission_open` hold and the question's
`permission` flag both see them; `keepsIdByWords` keeps #4626's `offersApproval` catch-all.

**Files:**
- Modify: `cli/src/engines/kit/questionPane.ts` (`isApprovalDialog`, 379-392, and its doc comment)
- Modify: `cli/src/lib/questionController.ts` (the comment at 907-913 only)
- Modify: `cli/src/lib/messageHold.spec.ts` (37-42)
- Modify: `cli/src/lib/askQuestion.more.spec.ts` (169-188, and a watcher case after 694-715)
- Modify: `cli/src/lib/askQuestion.spec.ts` (the comment at 1167-1170 only)
- Modify: `cli/src/engines/__fixtures__/other-screens.golden.json` (re-recorded)

**Interfaces:**
- Produces: `isApprovalDialog(view: QuestionView): boolean`, signature unchanged.

- [ ] **Step 1: Write the failing tests.** `messageHold.spec.ts`: add `['hermes', 'permission-hermes.txt']` and
  `['copilot', 'permission-copilot.txt']` to the `permission_open` list. `askQuestion.more.spec.ts`:
  `isApprovalDialog` is true for the views `parseEngineQuestionPane('hermes', …)` and `('copilot', …)` read from those
  fixtures, false for `question-hermes.txt`, `question-hermes-lock.txt` and `question-copilot.txt`, and still false
  for `view({ question: 'Which colour?' })` (line 184); a hand-built Yes/No view whose dialog says `Do you want to
  allow this?` with no marker stays false. A `QuestionWatcher` case (as at 694-715) announces Copilot's fixture with
  `detail.permission === true`. And Review Focus 5: a Hermes fixture whose boxed command is padded so `Dangerous
  Command` is more than 12 lines above the first row reads as a question.
- [ ] **Step 2: Run them and see them fail**: `npx vitest run src/lib/messageHold.spec.ts src/lib/askQuestion.more.spec.ts`.
  Expected: the Hermes and Copilot cases FAIL (`question_open`, `false`).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement**: after the `offersApproval` check, `isApprovalDialog` also returns true for
  `/(^|\n)\W*Dangerous Command\b/` (Hermes) or `/\bis attempting to [^:\n]{0,60}:/i` (Copilot) in `view.dialog ??
  view.question`. Its doc comment names both fixtures and says the words were read from them. Update the two stale
  comments (`questionController.ts:907-913`, `askQuestion.spec.ts:1167-1170`).
- [ ] **Step 5: Re-record the golden**: `RECORD_OTHER_ENGINES_GOLDEN=1 npx vitest run src/engines/otherScreens.golden.spec.ts`,
  then check the diff: only the Hermes and Copilot approval readings move from `question_open` to `permission_open`.
- [ ] **Step 6: Run**: `npx vitest run src/lib/messageHold.spec.ts src/lib/askQuestion.more.spec.ts src/lib/askQuestion.spec.ts
  src/lib/askQuestion.scrollback.spec.ts src/engines/otherScreens.golden.spec.ts src/engines/copilot src/lib/questionController`
  (the last two as path filters). Expected: pass.
- [ ] **Step 7: Commit** (`fix(questions): Hermes's and Copilot's approvals hold as permission asks`).

### Task 8: A legacy held row whose pane cannot be read joins the guard's retry

**Depends on:** none. **Effort:** xhigh.

Item 9. Decision 9: the bounded retry of #4604/#4626 (2 s → 30 s, `DID_NOT_START` after 15 minutes).

**Files:**
- Modify: `cli/src/lib/restoreAgents.ts` (`heldByGuard` at 478-489, the unreadable branch at 535-537, the
  `Unsurveyed` catch at 665-669)
- Modify: `cli/src/lib/restoreAgents.spec.ts` (`one whose pane cannot be read waits for the next pass`, 2228-2240, and
  one new case in that describe)

**Interfaces:**
- Consumes: `guardHold`, `legacyNativeHold`, `deps.startAgain` (this file); `createHeldLaunches`, `heldRetryMs`
  (`core/agents/heldLaunches.ts`, unchanged).
- Produces: inside `restoreAgents`, `markGuarded(entry: RegisteredSession, nativeToken: string): RegisteredSession |
  null` (sets `guardHold`, calls `deps.startAgain`; on a `failed` hold pushes to `summary.failed`, logs, returns null).
  `heldByGuard` becomes `markGuarded` then its `missing.push`.

- [ ] **Step 1: Write the failing tests.** Rewrite 2228-2240 as `one whose pane cannot be read gets the guard's hold
  and waits for its next attempt`: for both old details and both unreadable ways (`livePane`, `waitingPane` answering
  `'unknown'`), the summary is still `{ …, unsurveyed: ['agent-a'] }`, the row's launch is now
  `{ state: 'held', service: 'native', nativeToken: 'original', startsAgain: true, detail: STARTING_AGAIN }`,
  `startAgain` was called once with `'agent-a'`, and nothing launched. Add `one whose pane stays unreadable fails
  DID_NOT_START 15 minutes after its mark` with `vi.useFakeTimers()`: a real `createHeldLaunches({ registry:
  h.deps.registry, restore: only => restoreAgents({ ...h.deps, only }), announce, log })` (as at line 81), `boot`
  around the first `restoreAgents(h.deps)` with `startAgain` wired to `held.startAgain`, the pane unreadable
  throughout; after `vi.advanceTimersByTimeAsync(15 * 60_000 - 1)` the row is still guard-held and nothing was
  announced, after 1 ms more the launch is `{ state: 'failed', ...DID_NOT_START }`, `announce` was called once, the
  log has `NATIVE_EVIDENCE_UNSETTLED`, and the restores after the mark ran at 2 s, 6 s, 14 s, 30 s, then every 30 s
  (`heldRetryMs`). Close the held launches and restore real timers after.
- [ ] **Step 2: Run them and see them fail**: `npx vitest run src/lib/restoreAgents.spec.ts -t 'held row 0.6.86'`.
  Expected: FAIL (the row keeps its old words; `startAgain` never called; no retry, no `DID_NOT_START`).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** `markGuarded`; in the unreadable branch and in the `Unsurveyed` catch, a row that
  `legacyNativeHold(entry)` and is still the pass's (the row's `current()`, defined before the `try`, line 497) is
  marked before it is pushed to `unsurveyed`; a mark that failed pushes to `failed` instead. Update the
  comment at 516-520: the legacy row gets the guard's hold whether or not its pane can be read, so #4604's bounds
  apply to it from its first pass.
- [ ] **Step 5: Run**: `npx vitest run src/lib/restoreAgents.spec.ts src/lib/restoreAgents.settle.spec.ts
  src/core/agents/heldLaunches.spec.ts src/core/agents/restart.spec.ts`. Expected: pass. `heldLaunches.ts` and
  `restart.ts` did not change; `npm run test:core` runs once at the end (Verification 4).
- [ ] **Step 6: Commit** (`fix(restore): a 0.6.86 held row whose pane cannot be read is retried and bounded`).

### Task 9: Claude Code's Windows record (`procStartFt`)

**Depends on:** none. **Effort:** xhigh.

Item 10. Decision 10. The PR says this affects every Windows Claude Code user today: every record is "incomplete or
invalid", the identity read throws, and the identity stays held (`bind.ts` `hold`).

**Files:**
- Modify: `cli/src/engines/facets/sessionStore.ts` (`live.record`, line 63, and its comment 56-62)
- Modify: `cli/src/engines/claude/sessionStore.ts` (line 32 and its comment 27-31)
- Modify: `cli/src/lib/sessionRepair.ts` (`processRecord`, 762-790)
- Modify: `cli/src/lib/sessionRepair.spec.ts` (beside 854-882)
- Modify: `cli/src/engines/sessionStore.golden.spec.ts` (331-361) and `cli/src/engines/__fixtures__/session-store.golden.json`
  (re-recorded)

**Interfaces:**
- Consumes: `startMarkerMs(marker: string): number | null` (`cli/src/lib/processProof.ts`).
- Produces: `live: { record: { folder: string; suffix: string; pid: string; start: string; startFiletime?: string;
  cwd: string; id: string } } | { open: … }`; Claude's `startFiletime: 'procStartFt'`.

- [ ] **Step 1: Write the failing tests** in `sessionRepair.spec.ts` (`STARTED_AT` is a whole millisecond):
  `FT = String((BigInt(STARTED_AT) + 11_644_473_600_000n) * 10_000n + 4_321n)`. A record `{ pid: 77, cwd, sessionId,
  procStartFt: FT }` (no `procStart`) is found by `findLiveSession('claude', CWD, STARTED_AT, { pid: 77, bornOnly:
  true })`; the same with `STARTED_AT + 1` resolves `null`; another pid resolves `null`; `procStartFt: '12x'`,
  `procStartFt: '1'.repeat(21)` and `procStartFt: 7` (no `procStart`) reject with `Conversation identity is held`;
  a record with both fields, `procStartFt` of another start and `procStart` of this one, resolves `null` (the
  FILETIME is the start when there is one); a `procStart`-only record matches as before (the existing cases stay
  unedited). In the golden spec add records `111` (`procStart: undefined`, `procStartFt` of `utcMs`) and `112`
  (`procStart: undefined`, `procStartFt: '12x'`), and cases `filetime start` (111 at `utcMs`), `filetime, another
  start` (111 at `utcMs + 1`) and `filetime, bad value` (112) for both homes.
- [ ] **Step 2: Run them and see them fail**: `npx vitest run src/lib/sessionRepair.spec.ts -t procStartFt`.
  Expected: FAIL (held: incomplete or invalid).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** the contract field and the rule (see "What this plan decides"), the comments citing
  Claude Code 2.1.332's bundle (`procStartFt` on Windows, `procStart` elsewhere). The pid, folder and id checks are
  unchanged and come after the start, as now.
- [ ] **Step 5: Re-record the golden**: `RECORD_SESSION_STORE_GOLDEN=1 npx vitest run src/engines/sessionStore.golden.spec.ts`;
  the diff adds only the new cases.
- [ ] **Step 6: Run**: `npx vitest run src/lib/sessionRepair.spec.ts src/lib/sessionRepair.bounds.spec.ts
  src/engines/sessionStore.golden.spec.ts src/engines/claude src/lib/captureResumeIdentity.spec.ts
  src/lib/handoffDiscovery` and `npm run typecheck`. Expected: pass. `npm run test:resume` runs once at the end
  (Verification 4).
- [ ] **Step 7: Commit** (`fix(claude): Claude Code's Windows process record (procStartFt) identifies its session`).

### Task 10: The first-turn rule for a rebind

**Depends on:** none. **Effort:** high.

Item 3, the rule. Decision 3.

**Files:**
- Modify: `cli/src/lib/firstTurnReplay.ts`
- Modify: `cli/src/lib/firstTurnReplay.spec.ts`

**Interfaces:**
- Produces: `transcriptIsFirstTurn(entry: FirstTurnCandidate, birthMs: number, options: { rebound: boolean;
  newConversationSince?: number; now: number }): boolean`. Task 12 passes `newConversationSince`.

- [ ] **Step 1: Write the failing tests** in a `describe('on a rebind')`, with a row as a rotation leaves it
  (`rotated = { registeredAt, boundAt: registeredAt + 600_000, transcriptPath }`), the replaced binding begun at
  `since = registeredAt + 20_000` and the new transcript born at `born = registeredAt + 590_000` (Codex's `/new`, its
  hook landing 10 s later with the first turn): live with `{ rebound: true, newConversationSince: since, now: born +
  12_000 }` (red today); also live at `born = since`; folded at `born = since - 1` (a fork's rollout, written before),
  at `now = born + FIRST_TURN_WINDOW_MS`, with birth `0`, with `transcriptPath: null` or `boundAt: null`. A rebound with
  no `newConversationSince` is folded whatever the birth (keep that line of `folds when the session was rebound, …`).
- [ ] **Step 2: Run them and see them fail**: `npx vitest run src/lib/firstTurnReplay.spec.ts`. Expected: the live
  rebound case FAILS.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement**: on a rebound, live only when `newConversationSince` is a number, `birthMs >=
  newConversationSince`, and the common checks and the window hold; without a rebound, unchanged. The module comment
  gains a paragraph: a rebind replays live only on the engine's own "new conversation" signal, born after the binding
  it replaced (a fork or a resume is a rebind to a transcript born late too, and would send its whole history), within
  the same window.
- [ ] **Step 5: Run**: `npx vitest run src/lib/firstTurnReplay.spec.ts`. Expected: pass.
- [ ] **Step 6: Commit** (`fix(replay): a new conversation's first turn on a rebind is live`).

### Task 11: The hook door names a new conversation

**Depends on:** Task 3 (same `hookServer.ts` and `registry.admission.spec.ts`). **Effort:** xhigh.

Item 3, the signal. Decision 3.

**Files:**
- Modify: `cli/src/engines/facets/hooks.ts` (`HookContract`, line 186)
- Modify: `cli/src/engines/claude/hookContract.ts`, `cli/src/engines/codex/hookContract.ts`
- Modify: `cli/src/engines/hooks.ts` (one export)
- Modify: `cli/src/engines/hooks.spec.ts`
- Modify: `cli/src/hookServer.ts` (`HookServerHandlers.onRegistered`'s meta, lines 79-88; `commit` and `notify`,
  926-992)
- Modify: `cli/src/lib/registry.admission.spec.ts` (two cases beside the HTTP fixture)

**Interfaces:**
- Consumes: `startMarkerMs` (`cli/src/lib/processProof.ts`).
- Produces: `HookContract.newConversation?: { event: string; sources: readonly string[] }`;
  `export function startsNewConversation(engine: string, hookEvent: string | undefined, source: string | null |
  undefined): boolean` in `engines/hooks.ts`; `onRegistered`'s meta gains `newConversationSince?: number`, present
  only when this registration rotated the row (`rebound`) on its engine's signal and the replaced binding's start
  reads. Task 12 reads `meta.newConversationSince`.

- [ ] **Step 1: Write the failing tests.** `engines/hooks.spec.ts`: `startsNewConversation` is true for
  (`claude`, `SessionStart`, `clear`), (`codex`, `SessionStart`, `startup`) and (`codex`, `SessionStart`, `clear`);
  false for Claude's `startup`, for `resume`, `compact`, `fork` and `undefined` on both, for `UserPromptSubmit` with
  `clear`, and for every other engine name (`hermes`, `copilot`, `opencode`, `future`, `__proto__`) with
  `SessionStart`/`clear`. The existing `keeps every contract plain data` case still passes. `registry.admission.spec.ts`,
  through `httpFixture`: Codex `SessionStart` `startup` binds session A; `SessionStart` `clear` for session B with B's
  transcript calls `onRegistered` with `rebound: A` and `newConversationSince` equal to A's row's `boundAt`; the same
  with `resume` (the retarget fork's) and with a sourceless `UserPromptSubmit` carries no `newConversationSince`; a
  Claude Code row (`registry.openProcessAgent`, as at line 466) the same way with `clear` and `resume`. And #4622's
  case: a resumed row with `boundAt: null` and a process identity whose `startMarker` reads (`w:<digits>`) gets
  `newConversationSince === startMarkerMs(startMarker)`.
- [ ] **Step 2: Run them and see them fail**: `npx vitest run src/engines/hooks.spec.ts
  src/lib/registry.admission.spec.ts -t 'new conversation'`. Expected: FAIL (no export; no field).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The contract field with a comment per engine (Claude Code's `/clear`; Codex's threads
  that start with no history, `startup` and `clear`, sent inside the new thread's first turn, codex-rs
  `core/src/session/session.rs` and `hook_runtime.rs`); `startsNewConversation` reading
  `hookContracts[engine]?.newConversation` with `Object.hasOwn`. In `commit`, keep the replaced row's start where
  `notify` can read it: when `committed.rebound === prior?.sessionId`, `prior.boundAt ?? startMarkerMs(prior.
  processIdentity?.startMarker ?? '')`. In `notify`, spread `{ newConversationSince }` into the meta only when it is a
  finite number and `startsNewConversation(engine, body.hookEvent, body.source)`; so the golden of Task 3 does not
  move (check: `npx vitest run src/hookAdmission.golden.spec.ts` passes unrecorded).
- [ ] **Step 5: Write the PR's engine table** (the decision's "which engines cannot hit it and why") into the PR
  draft notes, from the table below.
- [ ] **Step 6: Run**: `npx vitest run src/engines/hooks.spec.ts src/lib/registry.admission.spec.ts src/hookServer.spec.ts
  src/hookServer.wait.spec.ts src/hookAdmission.golden.spec.ts src/hookServer.hermes.spec.ts` and `npm run typecheck`.
  Expected: pass.
- [ ] **Step 7: Commit** (`fix(hooks): a rebind on the engine's own new-conversation hook says so`).

**The PR body's engine table** (surveyed at 41b55c1a34; a rebind is `registry.register` returning `rebound`, and the
replay can matter only where the row has a transcript file the attach folds):

| Engine | Rebinds one running process | The first-turn replay can matter | Its new-conversation signal | In this PR |
|---|---|---|---|---|
| Claude Code | `/clear`, `/resume`, `--fork-session`, a continuation | yes | `SessionStart` `clear` | replayed; `resume`, `compact` and continuation folded |
| Codex | `/new`, `/clear`, `/resume`, the retarget's fork | yes | `SessionStart` `startup` or `clear` (lazy, in the first turn) | replayed; `resume` and `fork` folded |
| Copilot | its hooks, and `/resume` through its lock file | yes (its event file) | none: its hooks send no source, the lock says only that it moved | folded, as today |
| Command Code, Grok, agy | a hook naming another id could; no in-process switch is known | yes | none: Grok and agy send no source, Command Code none known | folded, as today |
| Pi | only between its first announce and its first post with a file | yes | none | folded, as today |
| Cursor | possible | no: every Cursor attach already replays live (`replayCursorFromStart`) | not needed | unchanged |
| OpenCode, Kilo, Hermes, Devin, OpenClaw | yes (plugins, terminal record, footer) | no: no transcript path, and the attach's store branch replays nothing live | not needed | cannot hit it |
| Amp | no: its plugin keeps its first thread | no | none | cannot hit it |
| Muse, OMP | no hooks, no rebind | no | none | cannot hit it |

### Task 12: The bind replays a new conversation's first turn

**Depends on:** Task 10 (the rule's new option). **Effort:** xhigh.

Item 3, the bind. Decision 3. `bind.ts` is a core file: 100% in `npm run test:core`.

**Files:**
- Modify: `cli/src/core/agents/bind.ts` (`RegisteredMeta`, 113-121; the `transcriptIsFirstTurn` call, 419-423, and its
  comment 393-418)
- Modify: `cli/src/core/agents/bind.spec.ts` (beside 378-408)

**Interfaces:**
- Consumes: Task 10's `transcriptIsFirstTurn` options; Task 11's meta field name `newConversationSince`.
- Produces: `RegisteredMeta.newConversationSince?: number`.

- [ ] **Step 1: Write the failing tests** in `bind.spec.ts`, as `replays a transcript born after its agent …` does
  (a real file in a temp folder, its birth now): a row `{ sessionId: 's2', registeredAt: Date.now() - 60_000,
  boundAt: Date.now(), transcriptPath: <the file> }` with
  `meta({ rebound: 's1', isNew: true, hookEvent: 'SessionStart', newConversationSince: Date.now() - 30_000 })` is
  attached with `replayFromStart === true` (red today); the same with no `newConversationSince` (a fork, a resume) is
  `false`; with `newConversationSince: Date.now() + 60_000` (born before the binding it replaced) is `false`; and a
  resumed conversation (`resumeOnly`, `stoppedAgents.get` naming the same session) stays `false` even with the field.
- [ ] **Step 2: Run them and see them fail**: `npx vitest run src/core/agents/bind.spec.ts -t 'new conversation'`.
  Expected: the first case FAILS (`false`).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement**: add the optional field to `RegisteredMeta` (its doc: set by the hook door only, on the
  engine's own new-conversation hook); pass `newConversationSince: meta.newConversationSince` to
  `transcriptIsFirstTurn`. Replace the comment's "never on a rebound" reasoning with the rule's one line and a
  pointer to `firstTurnReplay.ts`.
- [ ] **Step 5: Run**: `npx vitest run --config vitest.core.config.ts src/core/agents/bind.spec.ts
  --coverage.include=src/core/agents/bind.ts` (the file's own coverage; the whole gate runs once at the end,
  Verification 4). Expected: pass, `bind.ts` at 100% statements, branches, functions and lines.
- [ ] **Step 6: Commit** (`fix(bind): a new conversation's first turn reaches the apps live after a rebind`).

### Task 13: `test_runtimes.py` runs under any Python 3.10+

**Depends on:** none. **Effort:** medium.

Item 11, groundwork. `test_a_venv_in_range_is_kept` and `test_a_venv_out_of_range_is_replaced` (`low="3.10"`) assume
`/usr/bin/python3` is Apple's 3.9 (`store/tools/test_runtimes.py:478-504`); on Ubuntu 24.04 it is 3.12, so the
`store-checks` job would fail on them.

**Files:**
- Modify: `store/tools/test_runtimes.py` (`system_python`, the two tests)

**Interfaces:** none. Task 14's job runs this file on `ubuntu-latest`.

- [ ] **Step 1: See it fail on Linux**: in a disposable container (Podman on the Mac), `podman run --rm -v
  "$PWD/store/tools:/w:ro" -w /w docker.io/library/ubuntu:24.04 bash -c 'apt-get update -qq && apt-get install -y
  -qq python3 >/dev/null && python3 -m unittest test_runtimes.Venv'`. Expected: the two tests FAIL (Ubuntu 24.04's
  `/usr/bin/python3` is 3.12). Keep the lines for the PR. No red commit: the red is the existing tests on Linux.
- [ ] **Step 2: Implement**: the wrapper runs the Python of `/usr/bin/python3` as today, and both tests read its
  version first (`major.minor`) and build the range from it: kept for `harness_venv .venv 3.12 <v> <v+1 minor>`;
  replaced for low `<v+1 minor>` with no ceiling, and for low `3.8` with ceiling `<v>`. The docstring says why: the
  range check must run on the machine's own Python, whichever it is.
- [ ] **Step 3: Run**: `python3 -m unittest store/tools/test_runtimes.py` on the Mac (Python 3.10 or newer on PATH)
  and Step 1's container command. Expected: pass in both.
- [ ] **Step 4: Commit** (`test(store): the runtime venv tests read the machine's own Python`).

### Task 14: A `store-checks` job for `store/tools/`

**Depends on:** Tasks 1 (same doc), 4 (same planner files) and 13 (its job runs that file on Ubuntu). **Effort:** xhigh.

Item 11. Decision 11: path-filtered by the planner, `permissions: contents: read`, no secrets, fast offline checks
only; browser and network suites stay with `authoring-browser-checks.yml`.

**Files:**
- Modify: `scripts/ci-plan.py` (`EXTRA`, `ALSO`, `DEPENDS`, `PR_READS`, `NOT_READ`, the comment at 60-61)
- Modify: `scripts/tests/test_ci_plan.py` (new tests; line 788's expectation)
- Modify: `.github/workflows/ci.yml` (scope options at line 22, the plan output, the job, `required`'s `needs`)
- Modify: `docs/validation-and-release.md` (the component table at 74-85 and the reads sentence at 70-72)

**Interfaces:**
- Produces: suite `store`, job `store-checks`, plan output `store`, manual scope `store`.

- [ ] **Step 1: Write the failing tests**: `test_store_tools_select_their_own_checks`: `planner.select(["store/tools/
  runtimes.sh"])[0]` and `["store/tools/local-ai/test/packaging.test.mjs"]` contain `store` and `cross-read-scan`;
  `["store/agents/ollama/toolchain/node.sh"]` contains `store`; `["store/catalog.json"]`,
  `["cli/src/lib/engineLaunch.ts"]` and `["docs/plans/x.md"]` do not; `planner.JOBS["store"] == {"store-checks"}`;
  `planner.shared_input("store/tools/runtimes.sh") is None`; and `planner.reads("store", "store/tools/browser/x.test.mjs")`
  is false. Change line 788 to expect `{"cli", "desktop", "store"}` for `store/agents/blender/store.json`.
- [ ] **Step 2: Run them and see them fail**: `cd scripts/tests && python3 -m unittest test_ci_plan -k store`.
  Expected: FAIL (`store` unknown).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement the planner**: `"store"` in `EXTRA`; `ALSO["store/tools/"] = "store"`;
  `DEPENDS["store"] = PR_READS["store"] = ("store/agents/",)` with a comment (the local AI packages' packaging test
  compares their `toolchain/node.sh` copies, and `port-holder.test.mjs` imports four agents' libs);
  `NOT_READ["store"]` = every top-level entry of `store/tools/` the job does not run (`README.md`, `REAL-WORKFLOWS.md`,
  `browser/`, `build-experience-branding.mjs`, `build-experiences.mjs`, `catalog.mjs`, `dsh-delete.mjs`,
  `dsh-discover.mjs`, `dsh-e2e.mjs`, `experience-tests/`, `experiences/`, `hands-on.mjs`, `listing.mjs`,
  `presentation.mjs`, `showcase.mjs`, `studio_fetch.py`, `studio_runtime.py`, `sync-studios.mjs`,
  `test_studio_fetch.py`, `try-hands-on.mjs`, `windows-ci/`, `windows-pipe.test.mjs`), commented: browser and
  network suites are `authoring-browser-checks.yml`'s and `experience-checks.yml`'s, the pipe test windows-e2e's.
  The comment at 60-61 says `store/tools/` has its own suite now.
- [ ] **Step 5: Implement the job** in `ci.yml`, after `daemons-checks` and in its shape: `store-checks`, `needs: plan`,
  `if: needs.plan.outputs.ready == 'true' && needs.plan.outputs.store == 'true'`, `runs-on: ubuntu-latest`,
  `timeout-minutes: 10`, `permissions: contents: read`, no `secrets` or `env` from secrets; checkout at
  `${{ env.CI_SOURCE_SHA }}`, `actions/setup-node@v7` with `${{ env.CLI_NODE_VERSION }}`; steps
  `python3 -m unittest store/tools/test_runtimes.py`, `node store/tools/sync-runtimes.mjs --check`,
  `node --test store/tools/local-credential.test.mjs store/tools/local-daemon.test.mjs store/tools/port-holder.test.mjs
  store/tools/sync-runtimes.test.mjs store/tools/test-folders.test.mjs`, `npm --prefix store/tools/local-ai test`.
  Add `store` to the scope options, `store: ${{ steps.select.outputs.store }}` to the plan's outputs, and
  `store-checks` to `required`'s `needs`.
- [ ] **Step 6: Run the job's commands locally** from the repository root, in the order above. Expected: all pass,
  under 3 minutes together. Note the time for the doc row.
- [ ] **Step 7: Run the planner's tests and the scan**: `cd scripts/tests && python3 -m unittest test_ci_plan`, then
  the full-checkout tests as CI's `cross-read-scan` job runs them: `cd scripts/tests && CROSS_READ_SCAN_REQUIRED=1
  python3 -c 'import unittest, test_ci_plan; unittest.main(module="test_ci_plan", argv=["x", "-v",
  *test_ci_plan.FullCheckoutTests.NAMES])'`, and `actionlint .github/workflows/ci.yml` if installed (the plan job
  runs it on the PR). Expected: pass, no undeclared read.
- [ ] **Step 8: Update the doc**: a row `store/tools/` | `store-checks` (the runtime helpers' tests, the copies'
  check, the tools' offline Node tests, the local AI packages' tests) | the measured time; and the reads sentence
  says `store-checks` also reads `store/agents/`.
- [ ] **Step 9: Commit** (`ci: a store-checks job runs store/tools' offline checks`).

---

## Verification

Each check runs once, on the final head, after the final review. None needs an account or the production backend.

1. **CLI end to end, by hand, on the branch (item 2; also every e2e file against items 3, 4, 7, 9).** Workflow
   `.github/workflows/cli-e2e.yml` ("CLI end to end"), `workflow_dispatch` on `fix/small-fixes-batch-1126` with both
   inputs left false (`agent_browser_podman: false`, `dial_hosts: false`), so the eight Linux shards, the macOS
   full-disk job, the dial hosts and `e2e-summary` run:
   `gh workflow run cli-e2e.yml --ref fix/small-fixes-batch-1126`. Isolation is the suite's own (throwaway homes and
   data folders, private tmux, fake engines, the in-memory and real test backends the setup action starts).
   Passing: every shard green and `e2e-summary`'s step "Require every discovered file exactly once and every shard
   passing" green (it failed on nightlies 45453447269 and 45663585025), the `cli-e2e-summary` artifact's
   `skipped_by_file` listing `e2e/dialAppEvalIterm.e2e.ts`'s cases. harness-pm starts it (its turn); report the run
   link. About 35 minutes.
2. **The Windows PTY driver on the Windows VM (item 6).** After harness-pm hands out the VM (`ssh
   admin@192.168.64.7`; suspend the Ubuntu VM first). Build on the Mac: the CLI bundle (`cd cli && . scripts/lib/
   build-label.sh && ADAPTER_VERSION="$(harness_build_label "$PWD")" npm run bundle`) and the driver
   (`cli/scripts/windows-pty-e2e/build.sh <scratch>`); use the released terminal host for the VM's arch. Follow
   `docs/testing/windows-pty-e2e.md` steps 3-8 with its isolation (`env.cmd`: every Harness folder under
   `C:\work\e2e`, `DISABLE_GRID_INSTALL=true`; back up and restore the engine homes' hook files with their sha256 as
   its step 7 says), signed out. Run `C:\work\e2e\run.cmd list` and `run.cmd s1`. For item 7, also open 20 raw TCP
   connections to the daemon's loopback port that send a WebSocket upgrade with no credential and are destroyed at
   once (a few lines of `node -e` with `net.connect`). Passing: the driver connects (`machine_select` answered
   `connected`) with no `401`, `s1` passes as in the doc, and `C:\work\e2e\data\harness.log` holds no
   `[fatal-guard] uncaughtException`. No account and nobody's eye needed. Leave `C:\work\e2e` as the doc says, and
   restore the engine homes' hook files.
3. **Windows CI, by path, on the PR.** The PR changes `pty/` (Windows-only code: `windows-e2e` on x64 and arm64),
   `.github/workflows/windows.yml`, `cli/hook/` and `cli/src/hookServer.ts` (now a `WINDOWS_SPECS` module), so
   `ci/required` includes `windows-e2e`. Passing: `windows-e2e / windows-pty` (x64 and arm64) green, which runs
   `cargo test` for `pty/` (Task 1) and the Windows CLI specs with `hookServer.wait.spec.ts` and
   `sessionHookWait.spec.ts` among them (Task 4). A failure of `pause_holds_output_until_resume` or
   `hosts_started_together_serve_once` is a recorded flake (one rerun); `one_holder_at_a_time` no longer is.
4. **The local gates PR CI does not run**, from a clean tree at the final commit on the Mac:
   `python3 scripts/local-checks.py --run`. For this branch's paths it selects `cli-core` (`npm run test:core`,
   `bind.ts`), `cli-resume` (`npm run test:resume`, `sessionRepair.ts`) and `cli-pty` (`npm run
   test:terminal-contract`, `pty/`, macOS). Passing: all three `passed` with a positive count, `cli-core` at 100%
   statements, branches, functions and lines per file. Paste the printed `harness-local-checks` fence into the PR body
   before pushing the head it names.
5. **`store-checks` on the PR.** Selected by Tasks 13-14's `store/tools/` change. Passing: green on `ubuntu-latest`
   in a few minutes, which is also the Linux proof of Task 13.
6. **Proposal, not in this PR:** the windows-pty-e2e driver has no workflow, so a break in it (as the loopback 401
   was) shows only at the next VM run. A step in `windows.yml`'s x64 leg running the driver's `list` and `s1` against
   the daemon it already starts would catch it on the PR that causes it. For the maintainers to decide.

## Decided after planning

1. **Codex's `/new` source** (main session's call, reported to harness-pm): keep both `startup` and `clear` for Codex.
   In codex-rs both mean a thread that starts with no history; a resume and a fork send their own sources, so taking
   both can never replay a fork or a resume. No real-Codex probe on the VM for it.
