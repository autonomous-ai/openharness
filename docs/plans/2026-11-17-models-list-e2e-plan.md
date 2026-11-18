# Claude Code's model list fails the whole picker when Claude Code answers slowly: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **devcrew phase 3**. Both tasks are test-first: a red commit (the
> test alone), then the code commit. Task 1's red is a unit spec; Task 2's red is one e2e assertion (no
> `engine-claude` restart), then the fake engine's branch. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `models_list` for a Claude Code agent answers within the engine worker's deadline whatever Claude Code's
own list read does, and the e2e fake engine answers that read as Claude Code 2.1.x does.

**Architecture:** In the `engine-claude` worker, `models()` starts `listClaudeModels` beside the `availableModels`
read and waits for it at most 1 s; past that it answers the aliases, and the read goes on in the background to fill
`lists.ts`'s cache for the next ask. The fake engine gets a `claude -p … --input-format stream-json` branch that
answers the `initialize` control request and starts no session.

**Tech Stack:** TypeScript, Vitest (fake timers), Node, the e2e harness (`cli/e2e/harness/fakeEngine.mjs`). No new
dependency.

**Spec:** [docs/plans/2026-11-17-models-list-e2e-design.md](2026-11-17-models-list-e2e-design.md). Read it with this
plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority. Branch `fix/models-list-e2e`, on `main` at
`7a24e46a42`.

## Decided

By the orchestrator, 2026-11-17. Not reopened:

1. This branch fixes only Claude Code's `models_list` failure from #4413 (the spec's Design items 1 and 2).
   `eagerOpenCode.e2e.ts` (`RESUME_UNCONFIRMED`, #4356) belongs to `fix/main-e2e-regressions`: no task here.
2. `models()` waits at most 1 s for `listClaudeModels`, started beside `claudeAvailableModels`. On timeout it answers
   the aliases; the read continues in the background with `.catch(() => null)` and fills the cache. One timer,
   cleared when the list (or `vitest.setup.ts`'s immediate `null`) wins. Red test in
   `cli/src/lib/runtimeProfile.spec.ts`, fake timers, `vi.mocked(listClaudeModels)`.
3. The fake engine's branch sits next to `claude plugin`, before the `launch-argv` append, answers `request_id:
   'harness-lists'` with `{ models, commands }`, bare aliases `default`/`opus`/`sonnet`/`haiku` (Haiku takes no
   effort), exits when stdin ends, and writes no `launch-argv` line, session, transcript or hook. Its red is the e2e
   assertion of decided 5.
4. No change to the core, the worker protocol, `RUNTIME_WAIT_MS`, `lists.ts`'s 15 s read or its cache, or
   `listClaudeCommands`.
5. The spec's "the daemon log shows no `engine-claude` restart during a `models_list`" becomes one assertion in
   `cli/e2e/engineModelControl.e2e.ts`'s Claude switch test (`inline=false`): the daemon log has no line matching
   `/service engine-claude started \(pid \d+\) · restart/`. The wording is
   `cli/src/harnessd/serviceSupervisor.ts:137`'s: `[harnessd] service <name> started (pid N) · restart K`, with
   the middle dot U+00B7. It is Task 2's red commit (it fails on main, where the worker exits at its 5 s deadline
   and is restarted), and that file joins Task 2.

The plan's own, from the code:

6. A rejection of `listClaudeModels` before the second is past also answers the aliases: the `.catch(() => null)`
   sits on the read itself, not only on the background tail. `models()` never rejects because of the list.
7. The timer and the read start synchronously at `models()`'s entry, before its first `await`. Otherwise the second
   would count from after the settings files are read, and the fake-timer test could not fire it.
8. The fake's `default`, `opus` and `sonnet` take `low`, `medium`, `high`, `xhigh`, `max`: the efforts the alias path
   offers them today (`BASIC_EFFORTS`, `runtimeProfile.ts:9`). So a test sees the same choices whichever path the
   first ask takes (an ask past 1 s under load answers the aliases), and `agent_update`'s check
   (`runtimeControl.ts:147`) accepts `sonnet@high`, `sonnet@low`, `sonnet@auto` either way.

## Open questions

None.

## Global Constraints

- Platforms, from the spec: macOS, Linux, Windows; the same code everywhere. Not in the core.
- Files touched: `cli/src/engines/claude/runtimeProfile.ts`, `cli/src/lib/runtimeProfile.spec.ts`,
  `cli/e2e/engineModelControl.e2e.ts`, `cli/e2e/harness/fakeEngine.mjs`. Nothing else.
- The bound is **1 s** (`1_000` ms). `lists.ts` keeps its 15 s read and 30 min cache; `RUNTIME_WAIT_MS` stays 5 s.
- No spec runs a real `claude`: `listClaudeModels` stays mocked (`cli/vitest.setup.ts:105-116`).
- e2e: only `IsolatedDaemon` daemons (throwaway home and data folder, private tmux server, fake engines). Never the
  developer's daemon (port 18473), tmux server, `~/.claude` or `~/.codex` (`cli/AGENTS.md`, rule 6).
- No fixed sleeps. Comments say why, in plain sentences, naming #4413 and the 5 s worker deadline.

## File map

| File | Task | Change |
|---|---|---|
| `cli/src/engines/claude/runtimeProfile.ts` | 1 | `models()` waits for the list at most 1 s |
| `cli/src/lib/runtimeProfile.spec.ts` | 1 | three cases on the bound |
| `cli/e2e/engineModelControl.e2e.ts` | 2 | the Claude switch test: no `engine-claude` restart in the log |
| `cli/e2e/harness/fakeEngine.mjs` | 2 | answers Claude Code's `initialize` read |

Task 1 and Task 2 share no file and depend on nothing. **Longest chain: one task.** Task 2's red must run on main's
`runtimeProfile.ts` (its Step 2 says how when Task 1 is already in); that is not a dependency.

## Review Focus

1. **A Claude Code that never answers.** Each ask costs at most 1 s of the engine's queue and answers the aliases;
   the worker never misses its 5 s deadline, so it is not restarted. Task 1, case A; in a real daemon, Task 2's
   restart assertion.
2. **A list read that rejects after the answer was sent.** It must not become an unhandled rejection: the worker has
   no `unhandledRejection` guard and would die. Task 1, case C (1 500 ms).
3. **The common fast path leaves no timer.** `vitest.setup.ts`'s immediate `null`, and a real list that arrives in
   time, clear the one timer; a lingering 1 s timer per ask would hold the event loop. Task 1, case B
   (`vi.getTimerCount()`).
4. **The first ask answered from the aliases, the second from the list.** The values must agree for what a test or a
   person picks (`sonnet@high`), or `agent_update` refuses what the picker offered. Decided 8; the e2e checks run
   both paths depending on load.
5. **Inline mode (`HARNESSD_SERVICES=none`).** Nothing cuts the wait short there; with the bound it is 1 s, not 15 s.
   Verification 2, `engineModelControl.e2e.ts` `inline=true` and `engineReaders.e2e.ts`' inline test.

Known edge, not fixed here (spec, Design 1): a value Claude Code lists only by its full id, offered as an alias on a
first ask, can be refused by an `agent_update` checked after the list fills the cache.

---

### Task 1: `models()` waits for Claude Code's list at most 1 s

**Depends on:** nothing. **Effort:** high (one function; a timer raced against a read that outlives it, and that
read's rejection must stay handled).

**Files:**
- Modify: `cli/src/engines/claude/runtimeProfile.ts:5` (import the `ClaudeListedModel` type), `:196-221` (`models`)
- Test: `cli/src/lib/runtimeProfile.spec.ts` (a new `describe` after `RuntimeProfileManager`'s, which ends at `:623`)

**The tests that fail before the change:** case A and C's 1 500 ms row, by timing out (the unbounded `await` never
settles while fake time stands still); C's 100 ms row, with `claude exited` (the rejection reaches `models()`).
Case B passes before and after: it guards the timer.

**Interfaces:**
- Consumes: `listClaudeModels(session): Promise<ClaudeListedModel[] | null>` (`lists.ts`), unchanged.
- Produces: `runtime.models` keeps its signature `(session, state) => Promise<RuntimeModelOption[]>`; it now
  settles at most 1 s after it is called plus the settings-file reads, and never rejects because of the list.

- [ ] **Step 1: Write the failing tests**

In `cli/src/lib/runtimeProfile.spec.ts`, a new `describe('Claude Code\'s own model list, waited for at most 1 s')`
with `afterEach(() => { vi.useRealTimers() })`. Each case: `vi.useFakeTimers()`, a `RuntimeProfileManager`, the
file's `session('claude')` (cliVersion `2.1.212`, so `fable` is among the aliases), and
`const pending = manager.modelsForSession(value)` called **after** `useFakeTimers`. Each case passes
`{ timeout: 5_000 }` so the red fails in 5 s, not the config's 30 s. `models` below means
`[...new Set(options.map((o) => parseRuntimeProfile(o.id)?.model))]`.

- **A** `'answers the aliases when Claude Code has not listed its models within the second'`:
  `vi.mocked(listClaudeModels).mockReturnValueOnce(new Promise(() => {}))`;
  `await vi.advanceTimersByTimeAsync(1_000)`; `const options = await pending`;
  `expect(models).toEqual(['default', 'opus', 'fable', 'sonnet', 'haiku'])`.
- **B** `'offers Claude Code\'s own list when it answers within the second, and leaves no timer'`:
  `mockReturnValueOnce(new Promise((resolve) => setTimeout(() => resolve([opusRow, haikuRow]), 999)))` with
  `opusRow = { value: 'opus', displayName: 'Opus 5.5', description: 'For complex work', efforts: ['low', 'high'] }`,
  `haikuRow = { value: 'haiku', displayName: 'Haiku 4.5', description: 'Fastest', efforts: [] }`;
  `await vi.advanceTimersByTimeAsync(999)`; `const options = await pending`;
  `expect(models).toEqual(['opus', 'haiku'])`; `expect(vi.getTimerCount()).toBe(0)`.
- **C** `it.each([100, 1_500])('answers the aliases when the list read fails after %i ms, and the failure stays
  handled')`: `mockReturnValueOnce(new Promise((_, reject) => setTimeout(() => reject(new Error('claude exited')),
  ms)))`; `await vi.advanceTimersByTimeAsync(1_000)`; `const options = await pending`; aliases as in A; then
  `await vi.advanceTimersByTimeAsync(1_000)` so the late rejection lands inside the test (Vitest fails the run on an
  unhandled rejection).

- [ ] **Step 2: Run them to see them fail**

Run (in `cli/`): `npx vitest run src/lib/runtimeProfile.spec.ts -t "waited for at most 1 s"`
Expected: A and C (1 500 ms) FAIL with `Test timed out in 5000ms`, C (100 ms) FAILS with `claude exited`; B passes.

- [ ] **Step 3: Commit the red**

```bash
git add cli/src/lib/runtimeProfile.spec.ts
git commit -m "Claude Code models: tests for the 1 s bound on its own list (red)"
```

- [ ] **Step 4: Bound the wait in `cli/src/engines/claude/runtimeProfile.ts`**

- `const LISTED_WAIT_MS = 1_000`, its comment saying why: #4413 made `models()` wait up to 15 s for Claude Code's
  `initialize` answer, under the worker's 5 s deadline (`RUNTIME_WAIT_MS`); a miss failed `models_list` and
  restarted `engine-claude`, which killed the read; the engine's reads queue one at a time
  (`core/engines/runtimeSessions.ts`), so the wait must be short; a fresh list is cached 30 min, so only a first ask
  waits.
- `function listedWithin(session: RuntimeSession, ms: number): Promise<ClaudeListedModel[] | null>`: starts
  `listClaudeModels(session).catch(() => null)` and one `setTimeout(ms)` that resolves `null`; the read's settling
  clears the timer. Nothing else holds the read: it runs on to its own 15 s and fills `lists.ts`'s cache.
- In `models()`: `const listing = listedWithin(session, LISTED_WAIT_MS)` as its **first** statement, before
  `await claudeAvailableModels(session)`; then `const listed = await listing`. The rest of `models()` is unchanged.
  Update the comment at `:200` to say the aliases also answer when Claude Code has not listed within the second.

- [ ] **Step 5: Run the tests to see them pass**

Run (in `cli/`): `npx vitest run src/lib/runtimeProfile.spec.ts src/engines/claude/lists.spec.ts && npm run typecheck`
Expected: both files pass, no unhandled error reported, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add cli/src/engines/claude/runtimeProfile.ts
git commit -m "Claude Code models: wait for its own list at most 1 s, then the aliases"
```

### Task 2: The fake engine answers Claude Code's list read, and no `engine-claude` restart

**Depends on:** nothing. **Effort:** high (an e2e red whose failure must be read correctly, then the fake's branch).

**Files:**
- Test: `cli/e2e/engineModelControl.e2e.ts`: the `switches Claude Code model and effort with inline=%s` test
  (`:38-52`), one assertion after its last `expect` (`:51`)
- Modify: `cli/e2e/harness/fakeEngine.mjs`: the header's list (`:3-18`), the imports (`:81-86`, `createInterface`
  from `node:readline`), a branch after `claude plugin`'s (`:345-349`) and before the `launch-argv` append (`:351`)

**The test that fails before the change:** the `inline=false` row of that test (decided 5). The red commit is the
e2e assertion alone; the fake's branch is the code commit.

**Interfaces:**
- Consumes: what `lists.ts` `readOnce` sends and reads: argv `-p --settings {"disableAllHooks":true}
  --strict-mcp-config --no-session-persistence --input-format stream-json --output-format stream-json --verbose`;
  one stdin line `{ type: 'control_request', request_id: 'harness-lists', request: { subtype: 'initialize' } }`;
  it reads the stdout line whose `type` is `control_response` and `response.request_id` is `harness-lists`.
  The master's restart line (`cli/src/harnessd/serviceSupervisor.ts:137`):
  `[harnessd] service engine-claude started (pid N) · restart K`, `·` being U+00B7.
- Produces: for `engine === 'claude' && args[0] === '-p'` with `stream-json` after `--input-format`: for each
  `initialize` control request on stdin, one stdout line
  `{ type: 'control_response', response: { subtype: 'success', request_id, response: { models, commands } } }`;
  `process.exit(0)` on stdin's end; nothing else.

- [ ] **Step 1: Write the failing assertion**

In `cli/e2e/engineModelControl.e2e.ts`, at the end of `switches Claude Code model and effort with inline=%s`:
`expect(d.log()).not.toMatch(/service engine-claude started \(pid \d+\) · restart/)`, with the same middle dot as
the log line. One unconditional line: in the `inline=true` row there is no `engine-claude` service, so it can only
match in the `inline=false` row. Its comment says why: since #4413 a Claude Code list read slower than the worker's
5 s deadline made `engine-claude` exit and be restarted on every `models_list`.

- [ ] **Step 2: Run it to see it fail**

Run on main's `cli/src/engines/claude/runtimeProfile.ts` (`7a24e46a42`) and main's fake: with Task 1's code commit in
the tree, `models()` answers the aliases within 1 s, nothing restarts, and the row passes without the fake's branch.
If Task 1's code commit is already in your tree, run it in a disposable worktree instead
(`git worktree add <scratchpad>/red-4413 7a24e46a42`, cherry-pick the red commit of Step 3, `npm ci` in its `cli/`,
then `git worktree remove` it).

Run (in `cli/`): `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/engineModelControl.e2e.ts -t "inline=false"`

Expected: the `inline=false` row FAILS, inside `fresh()`, before the new assertion is reached: `models_list` answers
an error (the worker missed its 5 s deadline), so `offered.models.some` throws `TypeError: Cannot read properties of
undefined (reading 'some')`, and the daemon log the test prints shows `dispatch models_list failed` and
`[harnessd] service engine-claude exited (1, …) — restarting in 1000 ms` (the `· restart 1` line follows 1 s later
and may not be in the print yet). **That failure counts as red:** it is the restart the assertion forbids, by the
same cause. Any other failure (no bound engine, a tmux error, no `exited … restarting` line) is not the red: find
why before going on. Record both lines for the pull request.

- [ ] **Step 3: Commit the red**

```bash
git add cli/e2e/engineModelControl.e2e.ts
git commit -m "e2e: no engine-claude restart while Claude Code's models are listed (red)"
```

- [ ] **Step 4: Add the fake's branch**

The rows (`parseClaudeModelList`'s fields), as Claude Code 2.1.x lists them on a subscription:

| `value` | `displayName` | `description` | `supportsEffort` / `supportedEffortLevels` |
|---|---|---|---|
| `default` | `Default (recommended)` | `Opus for complex work` | `true` / `['low','medium','high','xhigh','max']` |
| `opus` | `Opus` | `For complex work and everyday tasks` | `true` / same |
| `sonnet` | `Sonnet` | `For everyday tasks` | `true` / same |
| `haiku` | `Haiku` | `Fastest for quick answers` | none |

`commands`: `{ name: 'compact', description: 'Clear history but keep a summary', argumentHint: '[instructions]' }`,
`{ name: 'review', description: 'Review a pull request', argumentHint: '' }`. The comment says why the branch
exists: since #4413 the daemon asks Claude Code its `/model` list this way, and Claude Code started so runs no hook
and keeps no session; the fake used to take it for a launch (a `launch-argv` line, a session, hooks) and never
answered. The header gets one bullet for it beside `claude plugin`'s.

- [ ] **Step 5: Run the e2e to see it pass**

Run (in `cli/`): `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/engineModelControl.e2e.ts -t "switches Claude Code model and effort"`
Expected: both rows (`inline=false`, `inline=true`) pass, the restart assertion included. With or without Task 1:
the fake now answers within the worker's deadline.

- [ ] **Step 6: Commit**

```bash
git add cli/e2e/harness/fakeEngine.mjs
git commit -m "e2e fake engine: answer Claude Code's initialize list read as 2.1.x does"
```

---

## Left out

- `eagerOpenCode.e2e.ts` and the other main failures (#4356, #4390): other branches (decided 1).
- Remembering a failed list read so a Claude Code that never answers is not started on every ask: the final report
  proposes it (spec, Out of scope).
- A `CHANGED` entry for `compat.e2e.ts`: the release's check; the pull request notes it (spec, Verification).
- A fake option to answer slowly: the slow path is Task 1's unit test (spec, Design 2).

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): every e2e file
boots its own `IsolatedDaemon` under a throwaway root, with a private tmux server and the fake engines, signed out.
No real account, no production, nothing of the developer's daemon. No temporary workflow: the long run has the
repo's own workflow (check 3).

On this Mac (macOS, arm64), in `cli/`, after `npm ci`:

1. **The unit specs and the typecheck.**

   ```bash
   npx vitest run src/lib/runtimeProfile.spec.ts src/engines/claude/lists.spec.ts
   npm run typecheck
   ```

   To see: both files pass, no unhandled error, typecheck clean. `npm run test:core` is not affected
   (`src/engines/` and `e2e/` are outside it). The red is Task 1's first commit: three cases failed.

2. **The Claude e2e tests that failed on main, and the files that ask a Claude agent's models.**

   ```bash
   TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/engineModelControl.e2e.ts e2e/engineReaders.e2e.ts \
     e2e/enginehomes.e2e.ts e2e/models.e2e.ts e2e/modelSwitch.e2e.ts
   ```

   To see, passing: `engineModelControl.e2e.ts` (`switches Claude Code model and effort` both rows, `a Claude Code
   typed in with an OpenRouter endpoint …`), `engineReaders.e2e.ts` (`claude keeps native runtime profiles in
   explicit inline mode`, `claude retains its accepted profile while its worker is frozen …`), `enginehomes.e2e.ts`
   (`claude model picker follows the login shell home`), `models.e2e.ts`, `modelSwitch.e2e.ts`. No
   `dispatch models_list failed` in a printed log; the `inline=false` row's assertion holds: no
   `service engine-claude started (pid N) · restart` line (the spec's "no `engine-claude` restart").
   Known on this Mac under parallel load, on main too and not on CI: the `revokes an interrupted … model change`
   tests and several Codex `enginehomes.e2e.ts` tests time out. If one does, rerun that test alone
   (`-t "<name>"`); it is this change's only if it also fails alone, or on CI.

On GitHub, by hand:

3. **CLI end to end, once, on the pushed head** (heavy: needs the PM's go). Actions, "CLI end to end"
   (`.github/workflows/cli-e2e.yml`), Run workflow, branch `fix/models-list-e2e`, `agent_browser_podman` unticked.
   To see: every shard and `e2e-summary` green, or every red file also red on last night's run and outside this
   change (`eagerOpenCode.e2e.ts` is expected red until `fix/main-e2e-regressions` lands). The run's link goes in the
   pull request.

Windows: none beyond CI's unit suite. The change is platform-free TypeScript, and no e2e suite runs there.

**The pull request names:** the platforms (macOS, Linux, Windows: the same code); Task 1's and Task 2's red and
green runs (Task 2's red: the `TypeError` in `fresh()` and the `engine-claude exited … restarting` line);
check 2's result; check 3's link; and the note for the release that listed rows carry `description` and Claude
Code's names since #4413 (`compat.e2e.ts`, `COMPAT_FROM`).
