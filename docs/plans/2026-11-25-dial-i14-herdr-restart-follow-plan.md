# A resumed agent keeps its multiplexer's page while its new caller is looked up (eval I14): Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent confirmed in tmux or herdr whose next hook comes from a new caller or pane in that same multiplexer
stays on the multiplexer's page, in its ring place, while the new caller's lookup runs. Tier B's iTerm2 I14
`ringHerdr.*` (minus `names`) passes every run.

**Architecture:** One clause in `ObservedSource.askOuter` (`HO/observed.ts`, devices process): when the hook is from
another caller or pane and a lookup was asked, `HostAgent.nest` stays if the hook's own hints carry that multiplexer's
variable (`TMUX_PANE` for `tmux`, `HERDR_PANE_ID` for `herdr`); the tab place (`outer`, `outerPid`, `tty`) is still
dropped at once. The lookup's answer confirms or drops `nest` through `landOuter`, unchanged. Nothing in the core.

**Tech Stack:** TypeScript (Node 24), Vitest with injected fakes and fake timers; the dial app eval (tier A spec, tier B
e2e files on this Mac).

**Spec:** `docs/plans/2026-11-25-dial-i14-herdr-restart-follow-design.md` (approved; read it with this plan). Base:
`fix/dial-i14-herdr-restart-follow` at `ca527a7dbd`. Neither the spec nor this plan is committed yet: Task 1's commit
adds both.

Paths: `HO/` is `cli/src/cable/hosts/`; `SV/` is `cli/src/services/`; `EV/` is `cli/src/testing/dialAppEval/`.
Commands run in `cli/`.

## Decisions already made (PM, 2026-11-25): not reopened

1. A hook from a new caller or a new pane whose hints still carry the variable of the multiplexer the agent was
   confirmed in (`HERDR_PANE_ID` for nest `herdr`, `TMUX_PANE` for nest `tmux`; the variable itself, not `detectHost`)
   keeps `nest` while the new lookup runs. The tab place (`outer`, `outerPid`, `tty`) is still dropped at once. With no
   lookup asked (`deps.outer` returns `undefined`) nothing is kept. The answer confirms or drops it via `landOuter`.
2. `observed.spec.ts` "another caller or pane drops nest at once; an earlier ask's late answer sets nothing" (~line
   5431) is updated as the spec says, both its cases.
3. The 30 s tick gap (`ObservedSource.tick` between herdr's end and the resume) is a known gap, said in the PR, not
   fixed.
4. The dial eval is never weakened. The only eval file this branch changes is `EV/baseline.json`, regenerated after the
   eval runs. Nobody reads the held-out scenarios (`EV/heldOut.ts`) or their results.

## What this plan decides from the spec's words

- "Confirmed in" is `entry.agent.nest` as it stands when the hook comes: set by a lookup's answer or `made`, or by the
  scan's maker read (`HostAgent.nest`'s own doc in `HO/types.ts` says both confirm it). So a scan-placed agent whose
  first hook comes from another process in the same multiplexer keeps `nest` too; its tab place still goes at once, as
  the existing test "a nested first hook from another process drops the scan's tab and client at once" (~5954) pins,
  and that test stays green unchanged.
- The variable counts when present and non-empty in the hook's own `hostHints` (after `ownHints` on macOS, which never
  strips either). Its form is not checked here: the lookup checks it, and its answer decides.
- `appPending`: an agent that keeps `nest` is placed (`ingest` already deletes `appPending` when `a.nest` is set), so
  the dial's default and the front rule count it as before the hook.
- Docs: no sentence of `cli/AGENTS.md`'s devices row (or of `docs/`) states the old drop (checked: it says where a tmux
  or herdr agent is seen, not when `nest` goes). Only `askOuter`'s own doc comment changes (Task 2). No other doc
  changes.

## Tasks at a glance

| Task | What | Files | Depends on | Effort |
|---|---|---|---|---|
| 1 | The dial keeps herdr's page and ring order across a resume (red on the base) | `SV/devices.spec.ts` (+ the spec and this plan) | none | high |
| 2 | `askOuter` keeps `nest` for the same multiplexer's new caller or pane | `HO/observed.ts`, `HO/observed.spec.ts` | 1 | xhigh |

TDD order: Task 1 writes the end-to-end-in-process regression test and commits it red against the unchanged base
(`ca527a7dbd`'s `observed.ts`), so its red is seen at the layer where the person sees the failure. Task 2 writes the
unit tests red, then the fix, and its green run includes Task 1's test turning green. Task 2 depends on Task 1 only for
that evidence; they share no file. Longest chain: 2.

## Global Constraints

- Devices process only (`HO/`, `SV/devices.spec.ts`); nothing under `cli/src/core/` (AGENTS.md "The daemon core").
- No new option, setting, list or record; no new log line (the behavior is a kept field, seen in the ring).
- No fixed sleeps in tests: deferred promises and `vi.waitFor`, as the spec files already do.
- Platforms: macOS and Linux (tmux's and herdr's lookups run there); Windows has no tmux or herdr lookup: unchanged.
- Zellij has no `nest`, and an agent in Orca is on Orca's page whatever its `nest`: neither changes.
- Comments say why; names and copy follow `docs/naming-system.md`.
- The uncommitted `I14_DUMP` diagnostic in `cli/e2e/dialAppEvalIterm.e2e.ts` is never staged by any task (Open
  question 1).

## Review Focus

1. **A terminal started from a multiplexer pane** (VS Code started from tmux, `TMUX_PANE` inherited): the resumed agent
   sits on tmux's page until its lookup answers no nest, then moves to its app's page, with no tab used meanwhile.
   Pinned by Task 2's "an answer with no nest drops it" branch.
2. **A tap or rest during the lookup:** no tab of the old client is selected or raised: `paneOf(id, 'tabs')` is
   `undefined` while the ask runs (Task 2, every case).
3. **Moved into the other multiplexer** (confirmed in tmux, resumed in a herdr pane whose hints carry only
   `HERDR_PANE_ID`, or the reverse): `nest` drops at once, as before (Task 2, "drops at once" test).
4. **tmux inside herdr** (hints carry both variables, `detectHost` says herdr): a tmux-confirmed agent keeps `tmux`, and
   its host stays `tmux` while asked (Task 2).
5. **Several asks in flight:** the kept `nest` survives an older ask's late answer; only the latest ask's answer lands
   (Task 2, updated pinned test); and the ring keeps both rows in order while two agents' lookups are held (Task 1).

---

### Task 1: The dial keeps herdr's page and ring order across a resume (red on the base)

**Files:**
- Test: `cli/src/services/devices.spec.ts` (one new `it` in the `describe('herdr', …)` of the pane-follow block, after
  the herdr focus tests, ~line 16020; reuse `herdrWith`, `hook`, `agent`, `shown`, `IN_TERMINAL`)
- Also committed: `docs/plans/2026-11-25-dial-i14-herdr-restart-follow-design.md` and this plan

**Interfaces:** none produced. Task 2 makes this test green.

- [ ] **Step 1: Write the test** `herdr's page picked, two herdr agents resumed from new callers whose lookups are held:
  the dial keeps herdr's page and both rows in their order across the reads`

  Scene (each value fixed here; the I14 shape: herdr's server started in the app in front, so its panes' hints name it):
  - `RESUMED`: `IN_TERMINAL` with the callers 4242 and 4243 replaced by 4252 (ppid 4000, `ttys030`) and 4253 (ppid
    4001, `ttys031`), both `claude`.
  - `herdrWith({ hooks: [hook(1, IN_PANE('w1:p1')), hook(2, IN_PANE('w1:p2')), hook(3, { TERM_PROGRAM: 'Apple_Terminal' })] })`
    where `IN_PANE = (pane) => ({ HERDR_PANE_ID: pane, TERM_PROGRAM: 'Apple_Terminal' })`; sess-3 is a plain Terminal
    tab's agent, so Terminal's page is not empty.
  - `await settle('terminal-app')`, then `expect(host().pickApp('herdr')).toBe('switched')`.
  - `ring()` reads `host().listAgentSnapshot({ apps: true })` and returns `[apps?.shown, agents.map(({ id }) => id)]`.
    `const before = await ring()`; `expect(before).toEqual(['herdr', expect.arrayContaining([agent(1), agent(2)])])`,
    length 2.
  - Hold the lookups: `readers.processes.mockImplementation(() => new Promise((resolve) => held.push(() => resolve(RESUMED))))`.
  - `port.observed(hook(1, IN_PANE('w1:p1'), { callerPid: 4252 }))`; `await settled()`; `expect(await ring()).toEqual(before)`.
  - `port.observed(hook(2, IN_PANE('w1:p2'), { callerPid: 4253 }))`; `await settled()`; `expect(await ring()).toEqual(before)`.
  - Release: `readers.processes.mockResolvedValue(RESUMED)`, run every `held` resolver, then
    `await vi.waitFor(() => expect(logs.filter((l) => l.startsWith('[device] herdr client ·'))).toHaveLength(4))`;
    `await settled()`; `expect(await ring()).toEqual(before)`; `expect(await shown()).toBe('herdr')`.
  - While held, assert the lookups really wait: the `[device] herdr client ·` lines are still 2 before the release. If
    the herdr lookup reads no `readers.processes` on this path, hold whatever read it waits on first (`herdrRun`'s
    `/usr/sbin/lsof`) instead, and say so in the report.

- [ ] **Step 2: Run it red on the base**

  Run: `npx vitest run src/services/devices.spec.ts -t "resumed from new callers"`
  Expected: FAIL at the first `ring()` after sess-1's resume: herdr's ring lost agent 1 (`[ 'herdr', [agent(2)] ]` or
  Terminal's page shown). A failure anywhere else (the scene's setup) is not the red: fix the scene.

- [ ] **Step 3: Commit (red)**

```bash
git add cli/src/services/devices.spec.ts docs/plans/2026-11-25-dial-i14-herdr-restart-follow-design.md docs/plans/2026-11-25-dial-i14-herdr-restart-follow-plan.md
git commit -m "Dial: a herdr agent resumed from a new caller keeps herdr's page and its ring place (test, red; eval I14)"
```

---

### Task 2: `askOuter` keeps `nest` for the same multiplexer's new caller or pane

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts:902-944` (`askOuter` and its doc comment)
- Test: `cli/src/cable/hosts/observed.spec.ts` (`describe('ObservedSource outer place')`: replace the test at ~5431-5450,
  add three tests beside it; use its `nested()`, `inTmux()`, `CLIENT`, `pageOf`)

**Interfaces:**
- Consumes: Task 1's test (must turn green here).
- Produces: no new export. A module constant `NEST_VARIABLE: Readonly<Record<Nest, string>> = { tmux: 'TMUX_PANE',
  herdr: 'HERDR_PANE_ID' }` in `observed.ts`.

Shared hints for the new tests (each a fresh record):
`TMUX_HINTS(more) = inTmux({ __CFBundleIdentifier: 'com.googlecode.iterm2', ...more })` and
`HERDR_HINTS(more) = { hostHints: { HERDR_PANE_ID: 'w1:p2', TERM_PROGRAM: 'iTerm.app', ...more } }`: each names iTerm2,
so an agent that loses `nest` lands on iTerm2's page and the page check can fail.

- [ ] **Step 1: Write the failing tests**

  a. Replace the pinned test with `it.each` over four cases, `[name, hints, moved, nest]`:
     `tmux · another caller` (`TMUX_HINTS()`, `{ callerPid: 101 }`, `'tmux'`), `tmux · another pane`
     (`TMUX_HINTS()`, `TMUX_HINTS({ TMUX_PANE: '%4' })`, `'tmux'`), `herdr · another caller` (`HERDR_HINTS()`,
     `{ callerPid: 101 }`, `'herdr'`), `herdr · another pane` (`HERDR_HINTS()`, `HERDR_HINTS({ HERDR_PANE_ID: 'w1:p3' })`,
     `'herdr'`).
     Title: `'%s: the multiplexer it was confirmed in stays while the new ask runs, its tab goes at once; that ask\'s answer decides'`.
     For each answer in `[{ ...CLIENT, nest }, {}]`, a fresh `nested()`:
     ```ts
     t.src.ingest(t.ev('session-start', hints))
     await t.asks[0].answer({ ...CLIENT, nest })
     t.src.ingest(t.ev('needs-input', { ...hints, ...moved }))
     expect(t.asks).toHaveLength(2)
     expect(t.agent()).toMatchObject({ nest, host: nest })
     expect(t.agent()).not.toHaveProperty('appPending')
     expect(pageOf(t.agent())).toBe(nest)
     expect(t.src.paneOf(t.agent().id, 'tabs')).toBeUndefined()
     await t.asks[1].answer(answer)
     // confirmed: nest, host nest, paneOf tabs 'terminal-app:/dev/ttys004'
     // {} : no nest, pageOf 'iterm'
     ```
  b. `'an earlier ask\'s late answer sets nothing, the multiplexer kept or not'`, both for tmux:
     - never confirmed (the old test's `late` half, kept as is): session-start, moved before `asks[0]` answers, so no
       `nest`; `asks[0].answer({ ...CLIENT, nest: 'tmux' })` → no `nest`; `asks[1]`'s → `'tmux'`.
     - kept: confirmed by `asks[0]`; moved (`callerPid: 101`) → `asks[1]`; moved again (`callerPid: 102`) → `asks[2]`;
       `asks[1].answer({})` → still `nest: 'tmux'`, `pageOf` `'tmux'`; `asks[2].answer({ ...CLIENT, nest: 'tmux' })` →
       `paneOf(id, 'tabs')` `'terminal-app:/dev/ttys004'`.
  c. `'tmux inside herdr: hints with both variables keep the multiplexer it was confirmed in'`: hints
     `TMUX_HINTS({ HERDR_PANE_ID: 'w1:p1' })`; confirmed `nest: 'tmux'`; another caller (101) with the same hints →
     `{ nest: 'tmux', host: 'tmux' }`, `pageOf` `'tmux'`. The same with `nest: 'herdr'` confirmed → `herdr` kept.
  d. `'it drops at once for hints with no variable of its multiplexer, or with no lookup asked'`, each from a confirmed
     `nest` and another caller (101):
     - tmux confirmed, moved hints `{ TERM_PROGRAM: 'iTerm.app' }` with `t.outer.mockImplementationOnce(() => new Promise(() => {}))`
       (a lookup is asked): no `nest`, `pageOf` `'iterm'`.
     - tmux confirmed, moved hints `HERDR_HINTS()` (the other multiplexer's variable only): `t.asks` grows, no `nest`.
     - herdr confirmed, moved hints `HERDR_HINTS()` with `t.outer.mockReturnValueOnce(undefined)` (no lookup): no `nest`.

- [ ] **Step 2: Run them red**

  Run: `npx vitest run src/cable/hosts/observed.spec.ts -t "outer place"`
  Expected: (a) all four cases and (b)'s kept half and (c) FAIL on `nest` (`undefined`, expected the multiplexer);
  (b)'s first half and (d) pass already (they pin what stays).

- [ ] **Step 3: Commit (red)**

```bash
git add cli/src/cable/hosts/observed.spec.ts
git commit -m "Dial: a hook from a new caller or pane in the same multiplexer keeps nest until its ask answers (tests, red)"
```

- [ ] **Step 4: Implement in `askOuter`**

  In the existing `if (!same && !(scanned && answer && e.callerPid === entry.pid))` block, `outer` and `outerPid` go as
  now; `delete entry.agent.nest` only when not `stays`, where
  `stays = answer !== undefined && entry.agent.nest !== undefined && Boolean(e.hostHints[NEST_VARIABLE[entry.agent.nest]])`.
  `landOuter` is unchanged (its early return when `made` repeats the kept `nest` with no `appPending` is right: nothing
  new to tell). Update the doc comment above `askOuter`: replace "Another caller or pane drops the place at once" with
  why the multiplexer now stays (I14: a resume's new caller left herdr's ring for a lookup's length, came back at its
  end, and emptied herdr's page when two ran at once, 2026-11-25), and that its tab place still goes at once and that
  another multiplexer's or no variable, or no lookup, drops it at once.

- [ ] **Step 5: Run green, with Task 1's test**

  Run: `npx vitest run src/cable/hosts/observed.spec.ts src/services/devices.spec.ts`
  Expected: PASS, the whole of both files, Task 1's test among them. Any other existing test that fails is a finding
  for the main session, never an edit to that test.

- [ ] **Step 6: Commit**

```bash
git add cli/src/cable/hosts/observed.ts
git commit -m "Dial: a resumed agent keeps its multiplexer's page while its new caller is looked up (eval I14)"
```

---

## Verification

Every check runs on the final head, after the final review's fixes, on a clean tree. Isolation is the harness's own
(cli/AGENTS.md rules 5 and 6): each tier B case's `IsolatedDaemon` has a throwaway home, data folder and port; herdr is
`PrivateHerdr` with `ownHerdrsOnly`, tmux the daemon's private server; iTerm2 is the harness's fake app; the dial is a
file on the desk; `FakeBackend`'s made-up machine and test accounts only. No real backend, no production. The Mac is
shared: the eval, `test:core` and `local-checks` never run at the same time as another session's eval or e2e; the
tester asks the main session (PM) for the turn before checks 2, 3 and 4.

1. **Unit, on this Mac.** `npm run typecheck`; `npx vitest run src/cable/hosts src/services/devices.spec.ts`;
   tier A: `npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts`. Seen: all green, `matches the baseline` among
   them (tier A's I14 stays all 1; a changed tier A score is a finding).
2. **Local gates PR CI does not run, on this Mac, on the PM's turn.** `npm run test:core` (`SV/devices.spec.ts` is in
   its area; per-file 100%); then from the repo root `python3 scripts/local-checks.py --run` on a clean tree, its output
   in the PR body before the push. Seen: green.
3. **Tier B iTerm2, three runs, on this Mac, on the PM's turn** (needs herdr, tmux and `cc`; a skipped case fails):
   `TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialAppEvalIterm.e2e.ts`, three times
   in a row. Seen each run: the file passes, and I14's `ringHerdr.recall`, `precision`, `order`, `cap`, `archived` and
   `apart` are 1. (`ringHerdr.names` and `ringKeptHerdr` are 0 in the baseline and out of this change: reported as
   seen.) No repo workflow runs this macOS-only file.
4. **Both tiers once and the baseline, on this Mac, on the PM's turn, one eval at a time:**
   `OUT=$(mktemp -d); DIAL_EVAL_OUT="$OUT" TMPDIR=/tmp caffeinate -i npm run eval:dial-apps -- --update-baseline`
   (tier A's spec, then tier B's seven files, the held-out one among them: the command needs it to write a baseline;
   nobody opens that file or its results). The gate, from `$OUT/report.md` and `report.json`:
   - `Gate: passed`, 0 wrong-session sends (one: stop, ask the PM, write no baseline);
   - I14's six `ringHerdr` keys above are 1 in `b/darwin`;
   - iTerm2's `b/darwin` score is at least `baseline.json`'s on the base (99.30); no app's score is below its baseline
     value but by timed checks (latency, `cost.cpu`, `cost.loopP99`, `ring.change`, `wait`) or `grade.ts RACED_B`'s four
     keys, which are the runner's noise; a pass/fail check that was 1 and is below 1 is a drop;
   - `git diff cli/src/testing/dialAppEval/baseline.json` touches `b/darwin` keys and `apps["b/darwin"]` only.
   The tester reports the score table and that diff. An implementer commits the file as `Dial eval: tier B's baseline
   with I14's herdr ring kept`; if any line fails, it is thrown away (`git checkout --
   cli/src/testing/dialAppEval/baseline.json`) and the failure is a finding. If another eval change merged first:
   rebase onto `main`, review the combined change, and run this check again.
5. **PR CI, on its own, nothing started by hand:** `cli-typecheck`, `cli-tests` (tier A on Linux against the
   macOS-written baseline), `dial-hosts` (`HO/` changed: real herdr, WezTerm, Zellij and kitty on Ubuntu), `linux-e2e`
   (the dial app eval's six Linux files, as `HO/` changed), `windows-e2e` x64 (`cli/src/cable/` changed; nothing changes
   there). Seen: each green. Tier B's iTerm2 file has no workflow: checks 3 and 4 run locally. Proposal (not in this
   branch): a by-hand macOS job for the dial's macOS-only e2e files, so later PRs run checks 3 and 4 on GitHub.
6. **Needs Diego himself, after the release, not a merge gate:** with his own dial on herdr's page and iTerm2 in front,
   he restarts his herdr and resumes two agents (`claude --resume`). He should see both rows stay on herdr's page, in
   their order, through the resume. No agent runs this or reads his terminals.
7. **Production:** none.

## What the pull request says

- Platforms: macOS and Linux; Windows has no tmux or herdr lookup, unchanged.
- The known gap, not fixed: the devices' 30 s look (`ObservedSource.tick`) landing between herdr's end and the resume
  removes the ended agent, and the resume is then a new entry, pending until its lookup answers (a few runs in a
  hundred).
- `ringHerdr.names` and `ringKeptHerdr` (0 in the baseline before this change) are out of it.
- The red-then-green tests (Task 1's devices test red on the base), the three tier B runs' I14 lines, the eval's score
  table and `baseline.json`'s diff, `test:core`'s and `local-checks`' receipts.

## Open questions

1. The working tree carries an uncommitted diagnostic in `cli/e2e/dialAppEvalIterm.e2e.ts` (`I14_DUMP`, "local only,
   never committed"). `local-checks.py --run` needs a clean tree, and the tester should run the file as `main` has it.
   Throw it away (`git checkout -- cli/e2e/dialAppEvalIterm.e2e.ts`) before Task 1 starts? Recommended: yes; if the PM
   wants I14 dumps from checks 3's runs, keep it until check 3 ends and throw it away before checks 2 and 4.
