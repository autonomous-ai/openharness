# A refused resume is not a confirmed one: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Two tasks, one after the other: Task 1 is one
> commit (it changes no behavior), Task 2 is a red commit and then a code commit. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** `agent_resume` reports a resume as confirmed only when the engine is still the pane's engine a settle time
after it was first seen, so a resume the engine refuses ends as `RESUME_FAILED` and never as `ok: true`.

**Architecture:** The settle time becomes one constant in `cli/src/lib/paneEngineProcess.ts`. The restart
(`paneSwapDeps.waitForProcess`) reads it from there with no change in behavior, and the resume's probe loop
(`waitForResumedAgent`) confirms on it instead of on the first sighting. Every check the loop already makes on each
probe stays where it is, ahead of the confirmation.

**Tech Stack:** TypeScript, vitest 4 (injected clock in the unit, fake timers in `swap.spec.ts`), the CLI end-to-end
suite on GitHub Actions. No new dependency, no new file.

**Spec:** [docs/plans/2026-11-13-codex-resume-refused-design.md](2026-11-13-codex-resume-refused-design.md). Read it
with this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/core/AGENTS.md`. The spec is the authority.

## Global Constraints

- The settle time is `500` ms, one constant, used by the restart and the resume. Its value does not change.
- Unchanged: `RESUME_READINESS_BUDGET_MS`, the 250 ms probe period, every error code and its copy, the `resumed` flag,
  the restart's fallback to a fresh start, `ResumeReadinessDeps` and the signature of `waitForResumedAgent`.
- `cli/src/lib/hostMove/moveAgent.ts` is not touched.
- No new file, so `cli/src/architecture.coreFiles.txt` does not change (`lib/paneEngineProcess.ts`,
  `lib/resumeStoppedAgent.ts` and `lib/terminalRuntime.ts` are already lines 414, 455 and 503).
- A failing test is a product bug: fix it at the layer where the behavior lives, red then green. Never skip or loosen
  a test. If a step's expected output does not match, stop and report.
- No fixed sleeps in tests: the unit uses the injected `sleep` and `now`.
- Comments say why and name the incident (`e2e/updates.e2e.ts`, a launch the engine refuses runs for an instant).
- Platforms: macOS, Linux and Windows (the resume path is shared).
- This worktree has no `cli/node_modules`: run `npm ci --no-audit --no-fund` in `cli/` once before the first test.

## Found while reading the code

Checked at `4961894fbc`.

- **The rule lands on one line.** `cli/src/lib/resumeStoppedAgent.ts:147`, `if (process) return { ok: true, … }`. The
  row, launch-failure, unread-pane and exited-pane checks are above it (lines 115-131) and run on every probe.
- **`swap.spec.ts` names the constant** at lines 14 (import), 237, 318 and 341. Its fake of `paneEngineProcess.js`
  spreads the real module, so the real value reaches it from the new home.
- **Two more specs run the real resume wait, through a whole-module fake of `paneEngineProcess.js`** that lists its
  exports by hand, so reading a constant it does not list throws:
  - `cli/src/lib/resumeAgentService.spec.ts:35`. Real timers, and its default probe always finds the engine. About
    half of its hundred or so tests end in a confirmed resume: on the real 500 ms each would wait half a second or
    more of real time.
  - `cli/src/lib/controlResume.golden.spec.ts:20`. It freezes `Date` (`vi.useFakeTimers({ toFake: ['Date'] })`), so
    with any settle time above zero the wait never ends.

  Both fake the engine itself, one that never exits. Task 2 gives each fake the constant at `0`, which keeps them on
  what they test (the service around the wait) and unchanged otherwise. See Decisions 1.
- **`controlTranscript.spec.ts` and `ptyHostBackend.restart.spec.ts`** also build the real service. The first ends
  before the wait; the second is opt-in (`HARNESS_PTY_BIN`) with a real engine. Neither changes.
- **`cli-e2e.yml` has no input for a file or a shard.** A run from a branch is all eight Linux shards, the macOS
  full-disk job and the summary. `e2e/updates.e2e.ts` runs on Linux only: the macOS job runs
  `e2e/diskfull.e2e.ts` and `e2e/updateHostile.e2e.ts`, filtered. The file has no timing hint, so its shard moves with
  the file list (shard 6 in nightly run 43247147594).
- **Main's nightly is red on other tests too.** Run 43247147594 shows twelve `FAIL` tests in nine files, this one
  among them (`agentBrowser`, `suspend`, `swarmV4Journey`, `eagerHooks`, `harnessWatch`, `eagerIdentity`,
  `hermesAdmission`, `superTabChannel`, `updates`), and the macOS full-disk job. A run on this branch is read test by
  test.
- **Required local checks for these paths** (`python3 scripts/local-checks.py --list …`): `cli-core`
  (`npm run test:core`, for `src/core/agents/swap.ts`) and `cli-resume` (`npm run test:resume`, for
  `src/lib/resumeStoppedAgent*.ts` and `resumeAgentService*.ts`). PR CI runs neither.

## Decisions

1. The two service-level specs (`resumeAgentService.spec.ts`, `controlResume.golden.spec.ts`) set the settle time to
   `0` in their fakes of `paneEngineProcess.js`, one line each, instead of moving to the real 500 ms. That is the
   fake's value, not a looser assertion; the rule is tested in `resumeStoppedAgent.spec.ts` and end to end.
   (Orchestrator, 2026-11-13.)

## Review Focus

Each line names the test in Task 2 that pins it.

1. A hook reports the wrong conversation, or the row fails another way, between the first sighting and the
   confirmation: the row's own verdict is returned, not a confirmation
   (`reports a failure a hook puts on the row during the settle time, not a confirmation`).
2. A probe that could not read the process (a `ps` that timed out answers `null`) between two sightings of the same
   process: the first sighting stands, and the resume is confirmed 500 ms after it, not later
   (`keeps the sighting through a probe that could not find the process`).
3. A pane tmux could not read while the engine is already there: that probe is no sighting, so the settle time runs
   from the first probe whose pane read alive (`asks again when tmux could not say …`, with its new assertion).
4. An engine first seen inside the last 500 ms of the budget: `RESUME_UNCONFIRMED`, neither confirmed nor failed, and
   the next Enter checks it again (`leaves an engine first seen inside the last settle time of the budget unconfirmed`).
5. By eye: the two fakes gained one key and no assertion in `resumeAgentService.spec.ts` or
   `controlResume.golden.spec.ts` changed; `__fixtures__/control-resume.golden.json` is not re-recorded.

---

### Task 1: The settle time lives in `lib/paneEngineProcess.ts`

**Depends on:** nothing. **Effort:** medium (mechanical: a constant moves and is renamed).

**Files:**
- Modify: `cli/src/lib/paneEngineProcess.ts` (after `resolvePaneEngineProcess`, line 59)
- Modify: `cli/src/core/agents/swap.ts` (lines 20, 39-40, 159-160)
- Test: `cli/src/core/agents/swap.spec.ts` (lines 10, 14, 237, 318, 341)

No behavior changes, so no test fails first, and this is one commit. `swap.spec.ts` passes before and after.

**Interfaces:**
- Produces: `export const ENGINE_SETTLE_MS = 500` from `cli/src/lib/paneEngineProcess.ts`. Task 2 imports it.

- [ ] **Step 1: Add the constant to `cli/src/lib/paneEngineProcess.ts`**

```ts
export const ENGINE_SETTLE_MS = 500
```

Its doc comment says: how long an engine must stay the pane's engine before a launch counts it as come up; a launch
the engine refuses (`codex resume` after an update dropped it) runs for an instant; one rule for a restart
(`core/agents/swap.ts` `waitForProcess`) and a resume (`resumeStoppedAgent.ts` `waitForResumedAgent`).

- [ ] **Step 2: Use it in `cli/src/core/agents/swap.ts`**

Delete `SWAP_SETTLE_MS` and its comment (lines 39-40). Import `ENGINE_SETTLE_MS` on the existing
`../../lib/paneEngineProcess.js` import (line 20) and use it at the two places in `waitForProcess` (lines 159-160).
The comment above them stays.

- [ ] **Step 3: Follow it in `cli/src/core/agents/swap.spec.ts`**

Drop `SWAP_SETTLE_MS` from the `./swap.js` import (line 14), add `ENGINE_SETTLE_MS` to the
`../../lib/paneEngineProcess.js` import (line 10), and rename the three uses. No assertion changes.

- [ ] **Step 4: Run the checks**

From `cli/`:

```bash
npx vitest run src/core/agents/swap.spec.ts
npm run typecheck
grep -rn "SWAP_SETTLE_MS" src e2e
```

Expected: the spec file passes with the same test count as before the edit, `tsc` prints nothing, `grep` prints
nothing.

- [ ] **Step 5: Commit**

```bash
git add cli/src/lib/paneEngineProcess.ts cli/src/core/agents/swap.ts cli/src/core/agents/swap.spec.ts
git commit -m "Restart: the engine settle time lives in lib, for the resume to share"
```

---

### Task 2: A resume is confirmed only once its engine has settled

**Depends on:** Task 1 (`ENGINE_SETTLE_MS`). **Effort:** high.

**Files:**
- Modify: `cli/src/lib/resumeStoppedAgent.ts` (`waitForResumedAgent`, lines 101-151, and the imports on lines 1 and 6)
- Test (must fail before the change): `cli/src/lib/resumeStoppedAgent.spec.ts` (`exact conversation readiness`, lines
  154-251, and `handles readiness: %s`, line 310)
- Modify: `cli/src/lib/resumeAgentService.spec.ts` (the fake on line 35 only)
- Modify: `cli/src/lib/controlResume.golden.spec.ts` (the fake on lines 20-22 only)

**Interfaces:**
- Consumes: `ENGINE_SETTLE_MS` from `./paneEngineProcess.js` (Task 1); `sameProcessIdentity` from
  `./terminalRuntime.js`.
- Produces: nothing new. `waitForResumedAgent(saved: RegisteredSession, deps: ResumeReadinessDeps): Promise<RestartAgentReply>`
  keeps its signature and its replies.

- [ ] **Step 1: Write the failing tests in `cli/src/lib/resumeStoppedAgent.spec.ts`**

Change the type-only import to `import { ENGINE_SETTLE_MS, type RuntimeCheck } from './paneEngineProcess.js'`.

Add to `describe('exact conversation readiness')`, which already has `process`, `saved` and `readiness()` (its
`sleep` moves `now`, its budget is 1000 ms):

```ts
  // A launch the engine refuses (`codex resume` after an update dropped it: Codex exits 2, Claude Code 1) runs for an
  // instant. Seen in that instant, the resume was called confirmed over a dead engine (e2e/updates.e2e.ts, nightly).
  it.each(['gone' as const, { dead: true }, { dead: false, engineExit: 2 }])('fails a resume whose engine is seen on one probe and gone on the next: %s', async exited => {
    const deps = readiness()
    deps.pane.mockResolvedValueOnce({ dead: false }).mockResolvedValue(exited)
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({
      ok: false, error: 'RESUME_FAILED', detail: expect.stringContaining('exited before confirming the saved conversation'),
    })
    expect(deps.process).toHaveBeenCalledTimes(2)
  })
  it('starts the settle time again when another process is the pane\'s engine on a later probe', async () => {
    const deps = readiness()
    const replacement = { pid: 43, startMarker: 'replacement', executable: 'codex' }
    deps.process.mockResolvedValueOnce(process).mockResolvedValue(replacement)
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: true, session: { processIdentity: replacement } })
    expect(deps.now()).toBe(250 + ENGINE_SETTLE_MS)
  })
  it('keeps the sighting through a probe that could not find the process', async () => {
    const deps = readiness()
    deps.process.mockResolvedValueOnce(process).mockResolvedValueOnce(null).mockResolvedValue({ ...process })
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: true, resumed: true })
    expect(deps.now()).toBe(ENGINE_SETTLE_MS)
  })
  it('reports a failure a hook puts on the row during the settle time, not a confirmation', async () => {
    const deps = readiness()
    deps.process.mockResolvedValueOnce(process).mockImplementationOnce(async () => {
      deps.set({ launch: { state: 'failed', error: 'RESUME_SESSION_MISMATCH', detail: 'fixture' } })
      return process
    })
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: false, error: 'RESUME_SESSION_MISMATCH', detail: 'fixture' })
  })
  it('leaves an engine first seen inside the last settle time of the budget unconfirmed', async () => {
    const deps = { ...readiness(), budgetMs: ENGINE_SETTLE_MS }
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: false, error: 'RESUME_UNCONFIRMED' })
  })
```

Update the existing tests to the settled rule:

- `confirms a resume off its own live engine process, hook or no hook` and
  `accepts a live process for an engine that has no startup hook to send`: replace
  `expect(deps.sleep).not.toHaveBeenCalled()` with

  ```ts
    expect(deps.process).toHaveBeenCalledTimes(3)
    expect(deps.now()).toBe(ENGINE_SETTLE_MS)
  ```

- `asks again when tmux could not say whether the pane is there, and confirms once it can`: add
  `expect(deps.now()).toBe(250 + ENGINE_SETTLE_MS)`.
- `handles readiness: %s` (line 310): `budgetMs: 250` becomes `budgetMs: 1000`, so `different start` and
  `missing launch` have room to settle. Its expectations do not change.

- [ ] **Step 2: Run the spec and see it fail**

From `cli/`: `npx vitest run src/lib/resumeStoppedAgent.spec.ts`

Expected: exactly ten tests fail, each on its own assertion (a confirmation where a failure, or a later
confirmation, was expected): the three `fails a resume whose engine is seen …` cases, the four other new tests, and
the three existing tests given new assertions. No error about a missing export. Every other test passes, the
`handles readiness` cases included.

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/src/lib/resumeStoppedAgent.spec.ts
git commit -m "Resume: tests for a resume whose engine is seen once and then gone"
```

- [ ] **Step 4: Confirm on the settled process in `waitForResumedAgent`**

Import `sameProcessIdentity` beside `terminalRouteKey` (line 1) and `ENGINE_SETTLE_MS` beside `RuntimeCheck` (line 6).
Keep one sighting across the loop and replace the line-147 return. Nothing above it moves:

```ts
  let seen: { process: ProcessIdentity; at: number } | undefined   // before the loop
  // …
    if (process) {
      if (!seen || !sameProcessIdentity(seen.process, process)) seen = { process, at: now() }
      if (now() - seen.at >= ENGINE_SETTLE_MS) return { ok: true, session: { ...row, processIdentity: process }, resumed: resumesConversation(saved.engine, saved.sessionId) }
    }
    await deps.sleep(250)
```

The two `if`s are separate on purpose: the comparison also runs on the probe that records the sighting, which is
what a settle time of zero in the two fakes of Step 5 relies on. A probe with no process, or one that `continue`s on
an unread pane, leaves `seen` as it is.

Comments, in plain sentences: at the check, why up means still up a settle time later (the refused `codex resume`
seen in its one instant, `e2e/updates.e2e.ts`; the restart already holds this rule in `swap.ts`). In the function's
doc comment, the proof is now the engine process still in the pane a settle time later, and the budget is reached
when no engine was seen or none stayed.

- [ ] **Step 5: Give the two fakes of `paneEngineProcess.js` the constant**

In `cli/src/lib/resumeAgentService.spec.ts` (line 35) and `cli/src/lib/controlResume.golden.spec.ts` (lines 20-22),
add `ENGINE_SETTLE_MS: 0` to the object the `vi.mock('./paneEngineProcess.js', …)` factory returns, with one comment
line: the engine these fakes stand for never exits, so there is no settle time to wait out, and the rule is tested in
`resumeStoppedAgent.spec.ts`. Change nothing else in either file.

- [ ] **Step 6: Run the specs and see them pass**

From `cli/`:

```bash
npx vitest run src/lib/resumeStoppedAgent.spec.ts src/lib/resumeAgentService.spec.ts src/lib/controlResume.golden.spec.ts
npm run typecheck
git status --short src/lib/__fixtures__
```

Expected: three files pass with no failed and no newly skipped test, `tsc` prints nothing, and `git status` prints
nothing (the golden is not re-recorded).

- [ ] **Step 7: Commit the code**

```bash
git add cli/src/lib/resumeStoppedAgent.ts cli/src/lib/resumeAgentService.spec.ts cli/src/lib/controlResume.golden.spec.ts
git commit -m "Resume: an engine counts as back only when it is still the pane's engine a settle time later"
```

Report both commits, and the Step 2 (red) and Step 6 (green) outputs with the commit each ran on.

---

## Verification

All on the final head. No check needs an account, a sign-in, a device or Ken himself, and none touches production:
every daemon under test is the end-to-end harness's own (`e2e/harness/daemon.ts`: a throwaway home and data folder,
its own port, a private tmux server, fake Claude Code and Codex engines, signed out), as `cli/AGENTS.md` rules 5 and 6
require. The default unit suite, with the four specs above, runs by itself in PR CI on Linux: start no run for it.

1. **The CLI end-to-end suite on Linux, on GitHub** (where the failure was seen). After the branch is pushed, start
   one run of the repo's own workflow, `.github/workflows/cli-e2e.yml`, with `agent_browser_podman` left off:

   ```bash
   gh workflow run cli-e2e.yml --ref fix/codex-resume-refused
   gh run list --workflow cli-e2e.yml --branch fix/codex-resume-refused --event workflow_dispatch --limit 1 --json databaseId,url,headSha
   gh run watch <id>
   gh run view <id> --log | grep -E "e2e/updates\.e2e\.ts"
   ```

   It runs on GitHub's `ubuntu-latest` runners, eight shards (45 minutes each at most), plus the macOS full-disk job
   and the summary; the workflow cannot run one file or one shard. A person sees a `✓ e2e/updates.e2e.ts` line and no
   `FAIL  e2e/updates.e2e.ts` line: `codex: an update drops resume: a restart comes back on a new conversation and
   says so, the one it left is kept, and a resume says why it cannot` passes. The run as a whole may still end red on
   tests main fails too: list this run's failures (`gh run view <id> --log-failed | grep " FAIL "`) and the latest
   nightly's (`gh run list --workflow cli-e2e.yml --event schedule --limit 1`, then the same command). The check
   passes when `updates.e2e.ts` has no failure and every failing test here also fails in that nightly. A failure that
   is not in the nightly is this branch's to explain, first of all one in a test that resumes or restarts an agent
   (every resume now takes about 500 ms longer). One run only, and not beside another heavy workflow. Report the run
   link. The failure was a race, so this run shows the flow holds; the red-then-green unit test in Task 2 is what
   proves the rule. Red evidence: nightly run 43247147594 on main, `e2e (6)`.
2. **The same test on macOS, on the developer Mac.** The workflow runs this file on Linux only, and the spec names
   macOS. From `cli/` in this worktree, with tmux installed and after `npm ci --no-audit --no-fund`:

   ```bash
   npx vitest run --config vitest.e2e.config.ts e2e/updates.e2e.ts -t 'an update drops resume'
   ```

   A person sees `1 passed` and the file's other tests skipped, in a minute or two. The harness isolates it; nothing
   is set up or cleaned by hand. Local because it needs a Mac and is too short for a temporary workflow.
3. **The local gates PR CI does not run.** From the repository root, on a clean tree at the final commit:

   ```bash
   python3 scripts/local-checks.py --run
   ```

   It runs `npm run test:core` (for `src/core/agents/swap.ts`) and `npm run test:resume` (for
   `src/lib/resumeStoppedAgent.ts`) in `cli/`. A person sees one `harness-local-checks` fence with `cli-core` and
   `cli-resume`, both `"status": "passed"`, which means 100% coverage in every file of each gate. Paste the fence into
   the pull request body.

Windows gets no end-to-end check: the change is in the loop shared by every platform, it reads only the injected
probes, and the unit tests cover it; no workflow runs the CLI end-to-end suite on Windows.
