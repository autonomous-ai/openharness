# Dial eval: a stable tier B baseline: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two full `npm run eval:dial-apps -- --update-baseline` runs on the same commit write the same `baseline.json`.

**Architecture:** The grader (`grade.ts`) keeps tier B's timed results (`CheckResult.timed === true` and `tier === 'b'`:
latencies, `ring.change`, `cost.cpu`, `cost.loopP99`, `wait.<i>`) out of what is held: `updateBaseline`'s checks, the
baseline's `b/<platform>` app scores (`subsetScores`), the report's delta (`delta.checks`, `delta.apps` of `b/` subsets,
`heldOutChanged`), and `droppedKeys` no longer names one. The headline (`report.apps`, `byTier`, `byPlatform`), the
failing list and the groups keep them. Tier A is untouched. I14's pass/fail flake is diagnosed on a PM Mac turn first;
its fix, if it is the eval's, is a conditional task.

**Tech Stack:** TypeScript (Node 24), Vitest unit specs; the dial app eval (tier A spec, tier B e2e files on the Mac).

**Spec:** `docs/plans/2026-11-25-eval-tierb-stable-design.md` (approved; read it with this plan). Base:
`fix/eval-tierb-stable` at `9cb4126b04`. Neither the spec nor this plan is committed yet: Task 1's commit adds both.

Paths: `EV/` is `cli/src/testing/dialAppEval/`. Commands run in `cli/`.

## Decisions already made (PM, 2026-11-25): not reopened

1. Tier B's timed results stay in the headline score (`report.apps`, `byTier`, `byPlatform`). Only the baseline (its
   checks and its `b/<platform>` app scores) and the report's delta (`delta.checks`, `delta.apps` of `b/` subsets,
   `heldOutChanged`) leave them out. Tier A keeps everything. `droppedKeys` lets go of tier B timed keys an update no
   longer writes (e.g. `b/darwin/I17/needsYou.latency`, `b/darwin/IH4/wait.4` in today's `baseline.json`).
2. No held-out work here: no task reads or touches `EV/heldOut.ts` or `cli/e2e/dialAppEvalHeldOut.e2e.ts`, or reads IH*
   evidence. Tests use made-up held-out ids (`CH1`, `XH1`) as `grade.spec.ts` already does, and `MAIN` only, never
   `HELD_OUT`, in new tests.
3. Part 2 (I14's flake) waits for the PM's Mac turn (about 23:35 local): Step D below is the main session's, and Task 3
   is blocked on it. The grader tasks go ahead before it.

## Global Constraints

- `EV/baseline.json` is never edited by hand, in any task. Its tier B timed keys (415 `b/darwin/...` keys of latency,
  `wait.`, `cost.cpu`, `cost.loopP99`, `.change` today) disappear only through the proof run's `--update-baseline`
  (Verification). No task commits a baseline.
- One rule, no new knob: no threshold, retry, switch, or clock of the eval's own; no new `RACED_B` key.
- Tier A behaviour (its checks, app scores, delta, `tierAVerdict`) is byte-for-byte unchanged.
- Comments say why; names follow `docs/naming-system.md`. No dead code: the comment on `scoring` in `grade.ts` that says a
  held wait is kept "so the baseline sees one that stops holding" is corrected to say tier A's.
- Local gates for this area (cli/AGENTS.md): `npm run typecheck` and the touched specs. `npm run test:core` covers
  `src/core` and `src/services` only, which no task touches: not run. No big suite while a dial eval or e2e runs on the
  Mac (PM rule): unit specs only, and only off the PM's eval turn.

## What reads the committed baseline's tier B timed keys (checked: nothing breaks)

- `tierBVerdict` (`grade.ts`), called by the ratchet case of each tier B e2e file (`cli/e2e/dialAppEval{Claude,Chatgpt,
  Vscode,Cursor,Orca,Iterm}.e2e.ts`; the held-out file calls the same function, not opened here): it reads
  `baseline.checks` only for untimed results (`!r.timed`), and its "no tier B baseline" test (`some key starts with
  b/<platform>/`) still holds, as darwin's untimed keys stay. Not affected.
- `EV/dialAppEval.spec.ts` "matches the baseline": `tierAVerdict`, `a/` keys only. Not affected.
- `EV/run.spec.ts`: its own temp baseline, untimed fixtures only. Not affected.
- `EV/report.ts`: reads the report's `delta`, never the baseline. Not affected (its delta simply has fewer lines).
- `EV/grade.spec.ts`: inline baselines only; the `tierBVerdict` case holding `b/darwin/C1/open.latency: 1` stays valid.
- `catalog.spec.ts`, `runner.spec.ts`, the scenario files: comments only.

## Review Focus

1. The first run after this change, against today's baseline that still holds tier B timed keys: the delta must not list
   each of them as `1 → —`. Pinned in Task 1 (`the delta leaves out a tier B timed key the old baseline holds`).
2. A missed tier B wait (`wait.4` at 0) counts in today's `b/darwin` app score through `scoring`: after the change it must
   move neither the baseline's app score nor `delta.apps`, but still the headline. Pinned in Task 1's red test.
3. A held-out tier B timed result that changed must not count in `heldOutChanged`. Pinned in Task 1.
4. `droppedKeys` deciding "timed" for a key the run did not give, from the catalog: a check kind whose parts it cannot
   grade on nothing seen would throw or misname. Pinned in Task 2 over every `MAIN` tier B darwin scenario. A part
   missing from that empty grading fails loud (the update is refused, naming it), never silently.
5. A tier A timed result (`a/.../open.latency`, `a/.../wait.1`) is still written and still in `delta`. Pinned in
   Task 1's red test and kept by the existing `a wait that held scores nothing` case.

---

### Task 1: Tier B's timed results leave the baseline and its delta

**Effort:** high. **Depends on:** none.

**Files:**
- Modify: `cli/src/testing/dialAppEval/grade.ts` (`scoring` comment, `subsetScores`, `grade`'s `changed`, `updateBaseline`)
- Test: `cli/src/testing/dialAppEval/grade.spec.ts`
- Modify: `docs/plans/2026-11-21-dial-app-eval-design.md` (the **Baseline** bullet under "Grader and report": tier B
  entries hold its untimed results only, and its app scores are made of those; the report's delta the same; the
  headline keeps them)
- Add to the commit: `docs/plans/2026-11-25-eval-tierb-stable-design.md`, `docs/plans/2026-11-25-eval-tierb-stable-plan.md`

**Interfaces:**
- Produces (internal to `grade.ts`, not exported): `const runnerTimed = (r: Pick<CheckResult, 'tier' | 'timed'>): boolean
  => r.tier === 'b' && r.timed` with a why-comment (its score is the host's wall clock, so nothing held or committed is
  made of it). Task 2 reuses this name.
- `subsetScores`, `updateBaseline`, `grade` keep their signatures.

- [ ] **Step 1: Write the failing tests** in `grade.spec.ts`, a new `describe('tier B timed results', ...)`:

```ts
// Two runs that differ only in tier B timed results: I17's needs-you latency and its step-4 wait.
const tierB = (check: string, score: number, timed: boolean): CheckResult =>
  result({ tier: 'b', app: 'iterm', scenario: 'I17', check, dim: 'D4', score, timed })
const runOf = (latency: number, wait: number): RunResults => run([
  result({ check: 'open.latency', dim: 'D3', score: 0.5, timed: true }),   // tier A timed: still written
  tierB('needsYou.shown', 1, false),
  tierB('needsYou.latency', latency, true),
  tierB('wait.4', wait, true),
])

it('two runs that differ only in a tier B timed result give the same baseline, checks and app scores, and no delta for them', () => {
  const fast = updateBaseline(null, runOf(1, 1), ['a', 'b'])
  const slow = updateBaseline(null, runOf(0.5, 0), ['a', 'b'])
  expect(slow).toEqual(fast)
  expect(fast.checks).toEqual({ 'a/darwin/C1/open.latency': 0.5, 'b/darwin/I17/needsYou.shown': 1 })
  expect(fast.apps['b/darwin']!.iterm).toBe(100)
  const report = grade(runOf(0.5, 0), fast)
  expect(report.delta.checks).toEqual([])
  expect(report.delta.apps['b/darwin']!.iterm).toEqual({ before: 100, after: 100 })
})

it('the headline, byTier and byPlatform still count a tier B timed result', () => {
  const fast = grade(runOf(1, 1), null)
  const slow = grade(runOf(0.5, 0), null)
  expect(slow.apps.iterm.score).toBeLessThan(fast.apps.iterm.score!)
  expect(slow.byTier.b.iterm.score).toBeLessThan(fast.byTier.b.iterm.score!)
  expect(slow.byPlatform['b/darwin']!.iterm.score).toBeLessThan(fast.byPlatform['b/darwin']!.iterm.score!)
  expect(slow.failing.map((r) => r.check)).toEqual(expect.arrayContaining(['needsYou.latency', 'wait.4']))
})

it('the delta leaves out a tier B timed key the old baseline holds, and counts no held-out one', () => {
  const old = baseline({ 'b/darwin/I17/needsYou.shown': 1, 'b/darwin/I17/needsYou.latency': 1, 'b/darwin/I17/wait.4': 1,
    'b/darwin/XH1/open.latency': 1 })
  const held = result({ tier: 'b', app: 'iterm', scenario: 'XH1', heldOut: true, check: 'open.latency', dim: 'D3', score: 0, timed: true })
  const report = grade(run([...runOf(0.5, 0).results, held]), old)
  expect(report.delta.checks.filter((c) => c.key.startsWith('b/'))).toEqual([])
  expect(report.delta.heldOutChanged).toBe(0)
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/testing/dialAppEval/grade.spec.ts -t "tier B timed"`
Expected: the first and third FAIL (the baseline holds `b/darwin/I17/needsYou.latency` and `wait.4`, its iTerm2 score
differs, the delta lists them, `heldOutChanged` is 1); the second PASSES today and guards decision 1.

- [ ] **Step 3: Implement in `grade.ts`**

- `runnerTimed` as in Interfaces.
- `subsetScores`: its `main` also drops `runnerTimed` results (this covers the baseline's app scores and `delta.apps`).
- `grade`: the keys the run marks `runnerTimed` (from `scored`) are left out of `changed`, on both sides (so an old
  baseline's entry is no line either); `delta.checks` and `heldOutChanged` follow from `changed`. `apps`, `byTier`,
  `byPlatform`, `failing`, `groups` unchanged.
- `updateBaseline`: `fresh` drops `runnerTimed` results.
- Correct the `scoring` comment: a held wait is kept so tier A's exact baseline sees one that stops holding.

- [ ] **Step 4: Update the design doc's Baseline bullet** (one or two sentences, as in Files).

- [ ] **Step 5: Run the specs and the typecheck**

Run: `npx vitest run src/testing/dialAppEval/grade.spec.ts src/testing/dialAppEval/run.spec.ts && npm run typecheck`
Expected: all PASS, no type error; no existing case changed.

- [ ] **Step 6: Commit** (red test first as its own commit if devcrew asks for red then green)

```bash
git add cli/src/testing/dialAppEval/grade.ts cli/src/testing/dialAppEval/grade.spec.ts \
  docs/plans/2026-11-21-dial-app-eval-design.md docs/plans/2026-11-25-eval-tierb-stable-design.md \
  docs/plans/2026-11-25-eval-tierb-stable-plan.md
git commit -m "Dial eval: tier B's timed results are measures, kept out of the baseline and its delta"
```

### Task 2: `droppedKeys` lets go of a tier B timed key

**Effort:** high. **Depends on:** none (shares `grade.ts` and `grade.spec.ts` with Task 1, so devcrew runs them one
after the other; if Task 1 landed first, reuse its `runnerTimed`, else define it as Task 1's Interfaces say and Task 1
reuses it).

**Files:**
- Modify: `cli/src/testing/dialAppEval/grade.ts` (`droppedKeys`, its doc comment)
- Test: `cli/src/testing/dialAppEval/grade.spec.ts` (`describe('droppedKeys')`), `cli/src/testing/dialAppEval/run.spec.ts`

**Interfaces:**
- `droppedKeys(baseline, results, tiers, catalog)` keeps its signature. A tier B key is never "asked" when it is timed:
  a `wait.<i>` (every wait is timed, `runner.ts`), or a check whose result `evaluate` (`checks.js`) marks `timed` when it
  grades the scenario's checks on nothing seen (`{ frames: [], faces: [], commands: [], deliveries: [], steps: [] }`) for
  tier `'b'` and the key's platform. `checks.ts` stays the one place that decides which part is timed; graded only for a
  key the run did not give, once per run key.

- [ ] **Step 1: Write the failing tests**

In `grade.spec.ts`, `describe('droppedKeys')`:

```ts
it('lets go of a tier B timed key the run did not give: an update no longer writes one', () => {
  // C1 in tier B: its cost check's cpu and loopP99 are timed, and its step-1 condition wait.
  const b1 = { ...c1, tiers: ['b' as const], checks: [...c1.checks, { id: 'cost', kind: 'cost' as const, dim: 'D8' as const }] }
  const was = baseline({ 'b/darwin/C1/ring.recall': 1, 'b/darwin/C1/ring.order': 1, 'b/darwin/C1/wait.1': 1,
    'b/darwin/C1/cost.cpu': 1, 'b/darwin/C1/cost.loopP99': 1 })
  const ranB = run([result({ tier: 'b', check: 'ring.recall', dim: 'D1', score: 1 })])
  expect(droppedKeys(was, ranB, ['b'], new Map([['b/darwin/C1', b1]]))).toEqual(['b/darwin/C1/ring.order'])
})

it('grades every main tier B scenario on nothing seen to tell its timed keys, without throwing', () => {
  const on = MAIN.filter((s) => s.tiers.includes('b') && s.platforms.includes('darwin'))
  const was = baseline(Object.fromEntries(on.map((s) => [`b/darwin/${s.id}/cost.cpu`, 1])))
  // A gap of a scenario outside the catalog given: tier B on darwin was driven, so its subset is replaced.
  const driven = run([], { gaps: [{ tier: 'b', platform: 'darwin', scenario: 'Z1', app: 'claude', heldOut: false, reason: 'none' }] })
  expect(droppedKeys(was, driven, ['b'], new Map(on.map((s) => [`b/darwin/${s.id}`, s])))).toEqual([])
})
```

In `run.spec.ts`, after `and refuses to drop a check of a scenario the catalog still runs, ...`:

```ts
it('--update-baseline lets go of the tier B timed keys a baseline holds, writing none', async () => {
  // The real catalog: C1 measures its cost in tier B, C2 waits at step 1.
  writeBaseline({ schema: 1, checks: { 'b/darwin/C1/ring.recall': 0.5, 'b/darwin/C1/cost.cpu': 1, 'b/darwin/C2/wait.1': 1 }, apps: {} })
  const h = harness({ b: results('b', 1) })
  expect(await main(['--tier', 'b', '--update-baseline'], h.deps)).toBe(0)
  expect(readBaseline().checks).toEqual({ 'b/darwin/C1/ring.recall': 1 })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/testing/dialAppEval/grade.spec.ts src/testing/dialAppEval/run.spec.ts -t "timed"`
Expected: the `droppedKeys` case FAILS naming `b/darwin/C1/wait.1`, `cost.cpu`, `cost.loopP99`; the catalog case FAILS
naming each `cost.cpu`; the `run.spec` case exits 1 with `no baseline written: ... b/darwin/C1/cost.cpu, b/darwin/C2/wait.1`.

- [ ] **Step 3: Implement in `droppedKeys`** as the Interfaces say; its doc comment adds: a tier B timed key goes, as
  an update writes none.

- [ ] **Step 4: Run the specs and the typecheck**

Run: `npx vitest run src/testing/dialAppEval/grade.spec.ts src/testing/dialAppEval/run.spec.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/testing/dialAppEval/grade.ts cli/src/testing/dialAppEval/grade.spec.ts cli/src/testing/dialAppEval/run.spec.ts
git commit -m "Dial eval: an update lets go of the tier B timed keys it no longer writes"
```

### Step D (main session, not an implementer task): diagnose I14's herdr ring flake

**When:** the PM's Mac turn (about 23:35 local), before or after the proof run, never beside another eval or big suite.
No process listing (`pgrep -f`, `ps aux`): only the run's own files are read.

1. Note first: #4599 (`eb4be60b21`, 2026-11-25 12:48 +0700, already on this base) fixed one I14 `ringHerdr` race
   (a new caller's lookup dropping `nest`) and named a known gap it left: the devices' 30 s look
   (`ObservedSource.tick`) landing between herdr's end and the resume. Check which commit the spec's failing full run
   was on; if it predates `eb4be60b21`, say so in the report.
2. Three runs of the iTerm2 file on the branch head, one at a time (`N` = 1, 2, 3):

   ```bash
   cd cli && TMPDIR=/tmp E2E_ARTIFACTS_DIR=/tmp/dial-eval-i14-diag-N/artifacts DIAL_EVAL_OUT=/tmp/dial-eval-i14-diag-N \
     caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialAppEvalIterm.e2e.ts
   ```

   Confirm I14 ran (it is skipped without herdr). `DIAL_EVAL_OUT` keeps `results-b-iterm.json`, whose I14 results carry
   the evidence lines (`apps at <t> on iterm`, the ring's rows). `E2E_ARTIFACTS_DIR` keeps a daemon's log only for a
   test that failed (`e2e/harness/artifacts.ts`): see Open question 1.
3. Read I14's `ringHerdr.*` and `ringKeptHerdr` scores and evidence in each results file and, where kept, the devices
   log lines around the page change (`[cable] cable: agents`, `[device]`, the pick). Decide the cause:
   - **eval leftover** (devices state from an earlier scenario on the shared daemon: a reset empties files, never the
     devices process) → Task 3;
   - **product race** (a page change or list tick the run's timing decides, e.g. #4599's known gap) → no task here: a
     proposal to the PM for a product pull request of its own, with the evidence lines and counts;
   - **no failure in three runs** → no task; report the count (0 of 3) and keep counting in the proof runs.
4. IH4's ring flake is not diagnosed here: report its key names and count from the proof runs to the PM.

### Task 3 (conditional, BLOCKED on Step D): the reset gives each scenario a fresh devices process

**Only if Step D finds an eval leftover.** Its exact content is set by Step D's evidence; the shape decided now:

**Effort:** xhigh (process lifecycle on a shared daemon). **Depends on:** Step D (not on Tasks 1-2).

**Files:**
- Modify: `cli/e2e/harness/appEvalDriver.ts` (`TierBDriver.reset`, reusing the restart `World.restartDevices` does:
  kill, wait for the dial's welcome and a new pid, `guardLoaded` on it)
- Test: `cli/e2e/dialAppEvalIterm.e2e.ts` (the red check at the leftover's layer, e.g. I14's devices pid differs from
  the scenario before it, or the leftover state Step D names is absent at I14's start)

- [ ] **Step 1: Measure first:** the per-scenario cost of a devices restart, from the file's `[dial eval] <id>: <ms>`
  lines, summed over the iTerm2 file, before the change (from Step D's runs).
- [ ] **Step 2: Write the red check** named by Step D's evidence; run the iTerm2 file (Step D's command) on a PM turn and
  see it fail.
- [ ] **Step 3: Implement** the restart in `reset`. If the measured cost is not acceptable to the PM, stop and ask; a
  fresh daemon per scenario only if a fresh devices process does not end the leftover (spec).
- [ ] **Step 4: Run the iTerm2 file three times** on a PM turn: the red check passes, I14's `ringHerdr.*` 1 in each,
  and the file's total time before and after goes in the pull request.
- [ ] **Step 5: Commit** `cli/e2e/harness/appEvalDriver.ts` and `cli/e2e/dialAppEvalIterm.e2e.ts`.

## Verification

All checks run locally on the PM's Mac (darwin, the only platform tier B's baseline holds), by the main session, on a
PM-granted turn. No GitHub workflow runs them and none is added: the full eval takes about 50 minutes and needs herdr,
iTerm2's fakes and the Mac. Isolation is the eval's own (`appEvalDriver.ts`): each daemon has its own root, home, ports,
fake backend and test accounts, and the network guard refuses anything past the machine. Nobody's own login or data is
used; no production backend.

1. **Local gates** (any time off an eval turn): `cd cli && npm run typecheck && npx vitest run
   src/testing/dialAppEval/grade.spec.ts src/testing/dialAppEval/run.spec.ts`. `test:core` not run: `src/core` and
   `src/services` untouched.
2. **Proof** (spec "Proof"), on the branch head with Tasks 1-2 (and Task 3 if it exists):

   ```bash
   cd cli && TMPDIR=/tmp DIAL_EVAL_OUT=/tmp/dial-eval-tierb-proof-1 caffeinate -i npm run eval:dial-apps -- --update-baseline
   ```

   Expect exit 0 and `baseline written`. `git diff -U0 src/testing/dialAppEval/baseline.json`: the tier B timed keys are
   removed (415 today), the `b/darwin` app scores change, and no `a/` line changes; any other moved key is listed by
   name. Commit that `baseline.json` (the command wrote it; never edited by hand). Then:

   ```bash
   cd cli && TMPDIR=/tmp DIAL_EVAL_OUT=/tmp/dial-eval-tierb-proof-2 caffeinate -i npm run eval:dial-apps -- --update-baseline
   git diff --exit-code src/testing/dialAppEval/baseline.json
   ```

   Expect exit 0 from both. A diff where only IH4's ring keys move is reported to the PM as that, by key name, and not
   counted against this fix (spec). Any other moved key fails the proof: report it with its run folders.
3. Step D's three iTerm2 runs (above) are the diagnosis' evidence, on the same kind of turn.

## Open questions

1. `E2E_ARTIFACTS_DIR` keeps a daemon's log only for a failing test, and I14's flake fails no I14 test (its ring is
   scored, not asserted; only the file's ratchet case fails, whose folder holds none of I14's log). So Step D gets I14's
   results and evidence lines, but likely not its devices log lines. Is the results' evidence enough, or may the main
   session add a local, never-committed assertion to `ALSO` in `e2e/dialAppEvalIterm.e2e.ts` (I14's `ringHerdr.*` all 1)
   for the three diagnostic runs, so a flake fails I14's own test and its log is kept? Recommended: the local assertion,
   reverted after the runs.
