# Dial: a tap on an agent in tmux or herdr opens the tab its client is in now Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** A tap, and a rest, on an agent nested in tmux, herdr or Zellij read where its client is now before they act, so
eval I13 (detach, attach from iTerm2's tab 2, no turn, tap) opens tab 2 in tier A and tier B.

**Architecture:** Devices process only. `OuterLookup` and `NestedLookup` take `{ fresh?: true }`; `heldAnswers` serves a
fresh ask from an answer in flight or settled within `FRESH_WITHIN_MS` (1 s), else asks anew. `ObservedSource.focus()`
and `showPane()` ask afresh (a hooked agent through its current `outerAsk`, a scan-placed one through a fresh process
table and its kept `Nested` facts), wait at most `OUTER_FRESH_WAIT_MS` (700 ms) for the answer to land, then act;
the last tap, and the last tap or rest, wins.

**Tech Stack:** TypeScript (Node 24), Vitest with fake timers, `npm run test:core`, the dial app eval (tier A on fakes,
tier B on this Mac).

**Spec:** `docs/plans/2026-11-24-dial-iterm2-tab-and-restart-design.md` (read it with this plan). PM decisions of
2026-11-24 are final: approach A; wait at most 700 ms; last action wins; the core is not touched; Task 1 measures the
fresh lookup on macOS and confirms or changes 700 ms. This plan is group 1 (I13) only; group 2 (herdr rows, I14, I15)
is `fix/dial-herdr-rows-merge`, later.

## Global Constraints

- Files: `cli/src/cable/hosts/{outer,tmux,herdrOuter,zellij,observed,types}.ts` and their specs,
  `cli/src/cable/{cableHost,cableSession}.ts` and their specs (Task 8, per Open question 1), `cli/src/services/devices.ts`
  and `devices.spec.ts`, `cli/AGENTS.md`, this plan. Nothing in `cli/src/core/`, `cli/hook/`,
  `cli/src/architecture.coreFiles.txt` or `devices/`.
- Never open `cli/src/testing/dialAppEval/heldOut.ts` or `cli/e2e/dialAppEvalHeldOut.e2e.ts`. No task edits
  `cli/src/testing/dialAppEval/*` or `cli/e2e/dialAppEval*.e2e.ts`; `baseline.json` changes only from the eval run in
  Verification 3.
- The pane-focus follow (eval I10, I11) is not touched: `focusPoll.ts`, `herdrSource.ts`'s follow, and the tab and
  prompt follows in `devices.ts` stay as they are.
- Names, used exactly: `Fresh` (`{ fresh?: true }`), `FRESH_WITHIN_MS = 1_000` (both `outer.ts`),
  `OUTER_FRESH_WAIT_MS = 700` (`observed.ts`, unless Task 1 changes it), `Entry.fresh`, `Entry.scanNested`,
  `ObservedSource.landNested`, the answer `'superseded'` (Open question 1).
- New log lines, exactly: `[observed] outer · late` and `[observed] outer · processes not read · <errorKind>`. No line
  names a pid, tty, pane, session, path or app.
- Unchanged: `OUTER_EVERY_MS` (5 s), `PANES_A_LISTING`, every lookup's steps and timeouts, `hasPane()` (synchronous).
- Platforms: macOS and Linux run the lookups; Windows' lookups answer `undefined` at once, so no fresh ask and no wait
  there, and no Windows branch is added.
- Tests: fake timers or an injected clock, never a sleep; never the person's tmux, herdr, terminals, `~/.claude`,
  `~/.codex` or daemon (18473). Never `harness device notify`, never a screenshot.
- Every behavior task: a red commit (the failing test), then a green commit. During a task run only its specs
  (`cd cli && npx vitest run <spec> -t '<name>'`) and `npm run typecheck` when a type changed.
- `git add` names the task's files; never `-a` or `.`. A local diagnostic in an eval file (one sat in
  `cli/e2e/dialAppEvalIterm.e2e.ts` while this plan was written) is never staged.
- Existing tests keep their expectations, with three mechanical exceptions: a test that taps or rests a nested agent and
  reads the open or the show without awaiting first gains a flush (`await vi.advanceTimersByTimeAsync(0)` or
  `await flushed()`); a test that lists the lookup's calls after a tap or rest gains the fresh call; a `devices.spec.ts`
  test that taps or rests a nested agent and lists runs gets a fixed clock (Task 10). No test is deleted or skipped.
- Once Tasks 3 and 6 land, tier A's `dialAppEval.spec.ts` "matches the baseline" reports I13's keys as a stale
  baseline. That is expected until Verification 3 commits the new `baseline.json`; no task "fixes" it.
- Comments say why: cite eval I13 and the PM's decisions of 2026-11-24.

## What this plan decides from the spec's words

- **The second's edge.** A fresh ask shares an answer when `now - settledAt < FRESH_WITHIN_MS`, as the 5 s hold
  expires at `>= OUTER_EVERY_MS`: 999 ms shares, 1000 ms asks anew. A fresh answer replaces the held one, so later
  asks within 5 s get it.
- **Where `Fresh` and `FRESH_WITHIN_MS` live:** `outer.ts`, the module every multiplexer lookup and `observed.ts`
  already import from; `observed.ts` imports nothing from `tmux.ts`.
- **One fresh ask an agent, at the source too.** `Entry.fresh` keeps the landing in flight and for `FRESH_WITHIN_MS` after
  it settled (`deps.now()`); a tap or rest then shares it. Without it a scan-placed agent would read the whole process
  table at each tap of a burst, and each shared answer would land, and emit, once per tap. Each tap or rest still has its
  own 700 ms timer.
- **One sequence number, two marks.** `acted` is bumped at each `focus()` and `showPane()`; `tapped` holds the `acted` of
  the latest `focus()`. A tap acts only while `tapped` is its own; a rest only while `acted` is its own. So a rest after a
  tap does not drop the tap, as the spec's rule says.
- **The scan's facts.** `Entry.scanNested` (`Omit<Nested, 'rows'>`) is set at the start of `placeNested` while the entry
  is unhooked, whatever the scan's lookup answers ("placed or not"), and cleared with `scanPlaced` in `askOuter`.
- **A fresh table that cannot be read** changes nothing and is said once a tap or rest:
  `[observed] outer · processes not read · <errorKind>`, as the scan says its own (AGENTS.md: failures are seen).
- **The docs.** The spec's line goes on each rate the fresh ask changes: tmux's and herdr's "at most one lookup a pane
  and agent process every 5 s", Zellij's "a session and agent process every 5 s", and the scan's "one listing every 5 s";
  and the scan's table, read "once a look", is read once more at a tap or rest on an agent it placed.

## Review Focus

1. **An agent in a plain tab, or on Windows** (no `outerAsk`, no `scanNested`): a tap and a rest ask no lookup and wait
   for nothing. Test in Task 6.
2. **Detached and not attached again:** the fresh answer has no app and no client (`{ nest: 'tmux' }`, `{}`): the row
   keeps its page and tab, nothing is emitted, and the tap opens the old app. Tests in Tasks 6 and 7.
3. **The session ends during the wait:** the tap opens nothing (`false`) and the rest shows nothing (`'failed'`). Test in
   Task 6.
4. **A lookup that hangs** (tmux stuck to its 10 s timeout): a tap and a rest during it share one lookup, each acts at its
   own 700 ms and says `late` once; the late answer lands after. Test in Task 6.
5. **Two agents of one tmux session, both placed by the scan, tapped within the second:** one `list-panes` and one
   `list-clients`. Test in Task 3.

## Measured (Task 1)

To be filled by Task 1: machine, load (`uptime`), runs, p50, p95, max of one cold tmux lookup to `found`, and the
`OUTER_FRESH_WAIT_MS` it confirms.

---

## Task graph

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | Measure the fresh tmux lookup on macOS; confirm or change 700 ms | high | - |
| 2 | A lookup can be asked fresh (`outer.ts`) | medium | - |
| 3 | tmux's holds serve a fresh ask | high | 2 |
| 4 | herdr's holds serve a fresh ask | medium | 2, 3 |
| 5 | Zellij's hold serves a fresh ask | medium | 2, 3 |
| 6 | A tap or rest on a hooked nested agent reads its client afresh | xhigh | 1, 2 |
| 7 | A tap or rest on a scan-placed nested agent reads its client afresh | xhigh | 6 |
| 8 | A tap or rest a later one replaced ends quietly at the dial (Open question 1, answer C) | high | - |
| 9 | Last action wins | xhigh | 6, 8 |
| 10 | The devices pass the flag to the nested lookups; I13 on the devices' wiring | high | 3, 4, 6, 7 |
| 11 | The devices row in `cli/AGENTS.md` | medium | - |

Longest chain: four tasks (1 → 6 → 7 → 10; 2 → 3 → 4 → 10 is as long). Tasks 6, 7 and 9 share `observed.ts` and its spec,
so they run one after another whatever their order. Files:

- 1: this plan (the script stays outside the repo). 2: `outer.ts`, `outer.spec.ts`. 3: `tmux.ts`, `tmux.spec.ts`.
  4: `herdrOuter.ts`, `herdrOuter.spec.ts`. 5: `zellij.ts`, `zellij.spec.ts`. 6, 7, 9: `observed.ts`, `observed.spec.ts`.
  8: `types.ts`, `cableHost.ts`, `cableHost.spec.ts`, `cableSession.ts`, `cableSession.spec.ts`. 10: `devices.ts`,
  `devices.spec.ts`. 11: `cli/AGENTS.md`. (`cable/hosts/` and `cable/` under `cli/src/`; `services/` likewise.)

---

### Task 1: Measure the fresh tmux lookup on macOS; confirm or change 700 ms

**Files:** Modify: this plan's "Measured (Task 1)" section. The script lives outside the repo (the session's scratchpad)
and is never committed. No product code changes, so no failing test.

**Interfaces:** Produces: the value of `OUTER_FRESH_WAIT_MS` Task 6 uses.

- [ ] **Step 1: Write a throwaway script** that times one cold `createTmuxOuter` lookup (`tmux.ts`), built as
  `devices.ts` builds it (`readProcessNames`, `readTtyName`, `readBundleId`, `appRoots(<home>)`, `platform: 'darwin'`,
  `now: () => performance.now()`), against tier B's shape: a private tmux server (`src/testing/isolatedTmux.ts`, `TMUX`
  and `TMUX_PANE` unset, every run under its `TMUX_TMPDIR`), a pane running a long-lived process standing in for the
  agent, and one client attached from a shell under a fake iTerm2 server at
  `<throwaway home>/Library/Application Support/iTerm2/iTermServer-3.6.6`, as `e2e/harness/appEvalIterm.ts` attaches
  one. Each run uses a new lookup instance, so no hold answers: that is the cost of a fresh ask past the second. A run
  counts only when it answers `{ app: 'iterm', tty, pid, nest: 'tmux' }`.
- [ ] **Step 2: Run it 50 times on this Mac**, not during an eval run, and note `uptime` before. Compute p50, p95, max.
- [ ] **Step 3: Decide.** p95 ≤ 700 ms: 700 ms stays. p95 above 700 ms: stop and report the numbers to the PM (the
  wait could not cover the lookup and still leave the open its 300 ms of the eval's 1 s); Task 6 waits for the answer.
- [ ] **Step 4: Record** machine, load, runs, p50, p95, max and the decision in "Measured (Task 1)". Commit this plan
  alone: `Dial: the fresh tmux lookup measured on macOS (plan)`. Tear down the private server and throwaway home.

### Task 2: A lookup can be asked fresh

**Files:** Modify `cli/src/cable/hosts/outer.ts`; Test `cli/src/cable/hosts/outer.spec.ts`.

**Interfaces:**
- Produces: `export interface Fresh { fresh?: true }`; `export const FRESH_WITHIN_MS = 1_000`;
  `OuterLookup = (hints, pid, made?: (nest: Nest) => void, opts?: Fresh) => Promise<…> | undefined`;
  `NestedLookup = (found: Nested, opts?: Fresh) => Promise<NestedPlace> | undefined`; `firstOuter` unchanged in
  signature, passing `opts` to both lookups it chains.

- [ ] **Step 1: Write the failing test.** The file's `lookup` helper also records each call's fourth argument in `asked`.

```ts
it('a fresh ask goes to both lookups it chains; a hook\'s own ask passes none', async () => {
  const first = lookup(() => Promise.resolve({}))
  const second = lookup(() => Promise.resolve({ app: 'iterm', tty: '/dev/ttys005' }))
  const both = firstOuter(first, second)
  expect(await both(hints, 42, undefined, { fresh: true })).toEqual({ app: 'iterm', tty: '/dev/ttys005' })
  expect(await both(hints, 42)).toEqual({ app: 'iterm', tty: '/dev/ttys005' })
  expect([first.asked, second.asked]).toEqual([[{ fresh: true }, undefined], [{ fresh: true }, undefined]])
  // Not nested in the first: the second alone, still fresh.
  const alone = lookup(() => Promise.resolve({ app: 'ghostty' }))
  await firstOuter(lookup(() => undefined), alone)(hints, 42, undefined, { fresh: true })
  expect(alone.asked).toEqual([{ fresh: true }])
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/outer.spec.ts` → FAIL (`asked` holds `undefined`), and
  `npm run typecheck` fails on the fourth argument. Commit red: `Dial: a lookup can be asked fresh (red)`.
- [ ] **Step 3: Implement** the Interfaces in `outer.ts`, each documented: a fresh ask is a tap's or a rest's, which reads
  where the client is now (eval I13, PM 2026-11-24); `FRESH_WITHIN_MS` is how long an answer still counts as fresh, so a
  burst of taps and rests runs one lookup an agent.
- [ ] **Step 4: Run** the spec and `npm run typecheck` → PASS. Commit green: `Dial: a lookup can be asked fresh`.

### Task 3: tmux's holds serve a fresh ask

**Files:** Modify `cli/src/cable/hosts/tmux.ts`; Test `cli/src/cable/hosts/tmux.spec.ts`.

**Interfaces:**
- Consumes: `Fresh`, `FRESH_WITHIN_MS` (Task 2).
- Produces: `heldAnswers<T, Asked>(now): (key: string, ask: () => Asked, opts?: Fresh) => Asked`; `createTmuxOuter`
  passes its lookup's `opts` to `asked`; `createTmuxNested(deps): (found, opts?: Fresh) => Promise<NestedPlace> | undefined`,
  passing `opts` to `asked`, `listings` and `clients`.

- [ ] **Step 1: Write the failing tests.**
  - `heldAnswers`: `'a fresh ask shares one in flight or settled less than FRESH_WITHIN_MS ago, and asks anew after; the
    new answer is held'`. With a clock: ask settles at 0 → fresh at 999 gives the same answer, the ask not run again →
    fresh at 1000 runs it again → a plain ask at 4000 gets the new answer → at 7000 a plain ask runs it a third time
    and, while that one is in flight, a fresh ask shares it: `toHaveBeenCalledTimes(3)`.
  - `createTmuxOuter`: `'a fresh ask past the second reads the session\'s clients again inside the 5 s hold: tab 1, then
    tab 2'`. `list-clients` answers `/dev/ttys004`, then `/dev/ttys005`; `outer(NESTED, 100)` → tty `/dev/ttys004`;
    `clock.t += 999`, fresh → `/dev/ttys004`; `clock.t += 1`, fresh → `/dev/ttys005`; plain → `/dev/ttys005`;
    `display-message` and `list-clients` each ran twice.
  - `createTmuxNested`: `'a fresh ask past the second lists the panes and the session\'s clients again; two agents of one
    session asked fresh within it run one listing and one list-clients'` (Review Focus 5).
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/tmux.spec.ts` → FAIL (the held answer is reused). Commit red:
  `Dial: tmux's lookups read the client again when asked fresh (red)`.
- [ ] **Step 3: Implement** the Interfaces. `heldAnswers`'s doc says why the fresh rule is 1 s and the hold 5 s: a hook's
  turn-start comes at every tool call, a tap or rest is a person's and must see a re-attach (I13).
- [ ] **Step 4: Run** the spec and `npm run typecheck` → PASS. Commit green:
  `Dial: tmux's lookups read the client again when asked fresh`.

### Task 4: herdr's holds serve a fresh ask

**Files:** Modify `cli/src/cable/hosts/herdrOuter.ts`; Test `cli/src/cable/hosts/herdrOuter.spec.ts`.

**Interfaces:**
- Consumes: `Fresh` (Task 2), `heldAnswers`' `opts` (Task 3).
- Produces: `createHerdrOuter` passes `opts` to `held`; `saidAnswers` returns `(key, place, opts?: Fresh)`;
  `createHerdrNested(deps): (found, opts?: Fresh) => Promise<ClientPlace> | undefined`, passing `opts` to its hold.

- [ ] **Step 1: Write the failing tests:** `'a fresh ask past the second reads herdr\'s client again inside the 5 s hold'`
  for `createHerdrOuter` on macOS (`lsof` run twice, the second answer's tty) and on Linux (`ss` run twice), and the
  same for `createHerdrNested`; within 999 ms a fresh ask runs nothing new.
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/herdrOuter.spec.ts` → FAIL. Commit red:
  `Dial: herdr's lookups read the client again when asked fresh (red)`.
- [ ] **Step 3: Implement** the Interfaces.
- [ ] **Step 4: Run** the spec and `npm run typecheck` → PASS. Commit green:
  `Dial: herdr's lookups read the client again when asked fresh`.

### Task 5: Zellij's hold serves a fresh ask

**Files:** Modify `cli/src/cable/hosts/zellij.ts`; Test `cli/src/cable/hosts/zellij.spec.ts`.

**Interfaces:** Consumes `Fresh` (Task 2), `heldAnswers`' `opts` (Task 3). Produces: `createZellijOuter`'s lookup passes
`opts` to `asked`. Zellij has no nested lookup.

- [ ] **Step 1: Write the failing test:** `'a fresh ask past the second reads the session\'s client again inside the 5 s
  hold'`: `list-clients` and the table read twice, the second answer's app; within 999 ms nothing new runs.
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/zellij.spec.ts` → FAIL. Commit red:
  `Dial: Zellij's lookup reads the client again when asked fresh (red)`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec → PASS. Commit green: `Dial: Zellij's lookup reads the client again when asked fresh`.

### Task 6: A tap or rest on a hooked nested agent reads its client afresh

**Files:** Modify `cli/src/cable/hosts/observed.ts`; Test `cli/src/cable/hosts/observed.spec.ts`.

**Interfaces:**
- Consumes: `Fresh`, `FRESH_WITHIN_MS`, `OuterLookup`'s `opts` (Task 2); the value from Task 1.
- Produces: `export const OUTER_FRESH_WAIT_MS = 700`; `Entry.fresh?: { landing: Promise<void>; settledAt?: number }`;
  private `askAfresh(entry: Entry): Promise<void> | undefined` (the landing, shared per "What this plan decides";
  `undefined` when there is nothing to ask); private `waitFresh(entry: Entry): Promise<void>` (races the landing with
  `OUTER_FRESH_WAIT_MS`, says `[observed] outer · late` when the timer wins, clears the timer otherwise). Task 7 adds the
  scan-placed branch to `askAfresh`; Task 9 adds the sequence to `focus()` and `showPane()`.

- [ ] **Step 1: Write the failing tests** in `describe('ObservedSource outer place')` (fake timers on). The `nested()`
  helper gains a last parameter `{ freshByHand?: true }`: a call with `opts?.fresh` resolves `{}` at once, which changes
  nothing, or, by hand, goes to `t.freshAsks` (answered as `t.asks` are). `CLIENT` is tab 1 (`/dev/ttys004`); tab 2 is
  `{ ...CLIENT, tty: '/dev/ttys005' }`.

```ts
it('I13: a tap opens the tab its client is in now, read afresh with no hook since', async () => {
  const t = nested({}, undefined, {}, { freshByHand: true })
  t.src.ingest(t.ev('session-start', inTmux()))
  await t.asks[0].answer(CLIENT)
  const tapping = t.src.focus(t.agent())
  expect(t.outer.mock.calls.at(-1)).toEqual([inTmux().hostHints, 100, undefined, { fresh: true }])
  expect(t.actions.open).not.toHaveBeenCalled()
  await t.freshAsks[0]({ ...CLIENT, tty: '/dev/ttys005' })
  expect(await tapping).toBe(true)
  expect(t.src.paneOf(t.agent().id, 'tabs')).toBe('terminal-app:/dev/ttys005')
  expect(t.actions.tabSelect.mock.calls.at(-1)).toEqual(['terminal-app', '/dev/ttys005', true])
})
```

  And, each with its assertions:
  - `'I13: a rest selects the tab its client is in now'`: `showPane` → `'ok'`, `tabSelect` `['terminal-app',
    '/dev/ttys005', false]` before the tmux pane's select.
  - `'a lookup slower than the wait: the tap acts on the old tab at OUTER_FRESH_WAIT_MS, says late once, and the late
    answer lands'`: no open at `OUTER_FRESH_WAIT_MS - 1`; at `OUTER_FRESH_WAIT_MS` the open and `tabSelect` of
    `/dev/ttys004`; `t.logs` holds `'[observed] outer · late'` once; after `freshAsks[0]` answers tab 2, `paneOf` tabs is
    tab 2. The same for a rest.
  - `'a fresh answer with no app and no client\'s process changes nothing'` (Review Focus 2): for `{}`,
    `{ nest: 'tmux' }`, `{ pid: 0 }`: the tap opens tab 1, `app` stays `terminal-app`, `t.changes` not called again.
  - `'a fresh answer with only its client\'s process lands: the raise gets that process (Linux)'`: first answer
    `{ pid: 4300 }`, fresh `{ pid: 4500 }` → `windowOf(id)` `{ pid: 4500, app: 'tmux' }`.
  - `'a hook\'s ask during a fresh one wins'`: tap, then a `turn-start` whose ask answers `/dev/ttys006`, then the fresh
    answer `/dev/ttys005` → tab is `/dev/ttys006`.
  - `'a tap or rest on an agent in no multiplexer asks no lookup and waits for nothing'` (Review Focus 1): an agent in a
    plain Terminal tab; `expect(await t.src.focus(a)).toBe(true)` with no timer advanced, `t.outer` not called again;
    the same for `showPane`.
  - `'a session that ends during the wait opens and shows nothing'` (Review Focus 3): `session-end` while the fresh ask
    runs → `focus` `false`, `open` not called; `showPane` `'failed'`.
  - `'a tap and a rest within the second run one fresh lookup an agent'` (Review Focus 4): tap and rest during one
    unanswered fresh ask → one fresh call; both act at `OUTER_FRESH_WAIT_MS`, `late` said twice; after it lands,
    `t.clock.t += FRESH_WITHIN_MS - 1` → a tap asks nothing new; `+= 1` → one more fresh call.
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/observed.spec.ts -t 'outer place'` → FAIL (no fresh call; the tap
  opens tab 1). Commit red: `Dial: a tap on an agent in tmux reads its client afresh (red)`.
- [ ] **Step 3: Implement.** `focus()` awaits `waitFresh(e)` after its first checks and before `target()` and
  `canOpen()`, then checks `live(e)` again; `showPane()` awaits it before `shown()`. `askAfresh`, hooked branch: with
  `entry.outerAsk` and `deps.outer`, `deps.outer(ask.hints, ask.pid, undefined, { fresh: true })` on that same `ask`
  object (no new ask, no `made`); its answer goes to `landOuter(entry, ask, place.nest, place)` only when `place.app` or
  a pid that `landOuter` would keep; `undefined` from the lookup means nothing to wait for. Adjust existing tests per
  Global Constraints only.
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/observed.spec.ts` and `npm run typecheck` → PASS. Commit green:
  `Dial: a tap on an agent in tmux reads its client afresh`.

### Task 7: A tap or rest on a scan-placed nested agent reads its client afresh

**Files:** Modify `cli/src/cable/hosts/observed.ts`; Test `cli/src/cable/hosts/observed.spec.ts`.

**Interfaces:**
- Consumes: `askAfresh`, `waitFresh`, `Entry.fresh` (Task 6); `NestedLookup`'s `opts` (Task 2).
- Produces: `Entry.scanNested?: Omit<Nested, 'rows'>`; private `landNested(entry: Entry, place: NestedPlace): void` (what
  `placeNested` does with an answer that names an app, now used by both); `askAfresh`'s scan-placed branch.

- [ ] **Step 1: Write the failing tests** in `describe('its placed tmux pane, and its first hook')`. The `scan()` helper
  gains a last parameter `{ freshByHand?: true }`, and `placed()` a third that it hands on: its `nested` answers a call
  with `opts?.fresh` with `{}` at once, or, by hand, into `t.freshAsks`.

```ts
it('I13 for an agent the scan placed: re-attached in tab 2 with no hook, a tap reads a fresh table and opens tab 2', async () => {
  const t = await placed({}, undefined, { freshByHand: true })
  const tapping = t.src.focus(t.a())
  await vi.waitFor(() => expect(t.freshAsks).toHaveLength(1))
  expect(t.table).toHaveBeenCalledTimes(2)
  expect(t.nested.mock.calls.at(-1)).toEqual([{ ...IN_TMUX, pid: 100, rows: ROWS }, { fresh: true }])
  t.freshAsks[0]({ ...ITERM, tty: '/dev/ttys005', pane: PANE })
  expect(await tapping).toBe(true)
  expect(t.actions.tabSelect.mock.calls.at(-1)).toEqual(['iterm', '/dev/ttys005', true])
})
```

  And: `'… a rest selects tab 2'`; `'placed by its maker alone (the scan\'s lookup named no app), a fresh answer that
  names iTerm2 places it there'` (app `iterm`, `shownAt(id, 'tmux')` the answer's pane); `'a fresh table that cannot be
  read changes nothing, said once'` (`t.logs` holds one line matching `/^\[observed\] outer · processes not read · /`,
  the tap opens tab 1); `'a fresh answer with no app changes nothing'`; `'a hook during the fresh ask wins'` (a nested
  `session-start` from pid 100, then the fresh answer: the hook's place stands, `scanNested` gone so a later tap asks the
  hooked way).
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/observed.spec.ts -t 'placed tmux pane'` → FAIL. Commit red:
  `Dial: a tap on an agent the scan placed reads its client afresh (red)`.
- [ ] **Step 3: Implement.** `placeNested` sets `scanNested` before its lookup while unhooked; `askOuter` clears it with
  `scanPlaced`. `askAfresh`, scan-placed branch (no `outerAsk`, `scanPlaced`, `scanNested`, unhooked, `deps.table` and
  `deps.nested` there): `deps.table()`, then `deps.nested({ ...entry.scanNested, rows }, { fresh: true })`, then
  `landNested` when the answer names an app and the entry is still unhooked.
- [ ] **Step 4: Run** the spec and `npm run typecheck` → PASS. Commit green:
  `Dial: a tap on an agent the scan placed reads its client afresh`.

### Task 8: A tap or rest a later one replaced ends quietly at the dial (Open question 1, answer C)

Dropped if the PM picks A or B in Open question 1.

**Files:** Modify `cli/src/cable/hosts/types.ts`, `cli/src/cable/cableHost.ts`, `cli/src/cable/cableSession.ts`; Test
`cli/src/cable/cableHost.spec.ts`, `cli/src/cable/cableSession.spec.ts`.

**Interfaces:**
- Produces: `HostSource.focus?(agent): Promise<boolean | 'superseded'>`;
  `HostSource.showPane?(agent): Promise<PaneSwitch | 'superseded'>`;
  `openAgent(agentId, reason?)`: `void | Promise<void | 'superseded' | { ok: false; error: string }>` (cableHost and
  cableSession's host type). A `'superseded'` tap counts no open end (`openEnded` not called: the later tap's end is
  counted) and answers `'superseded'`; `agent.open` then toasts nothing and focuses nothing. A `'superseded'` rest reaches
  `swiped('superseded')`, which the wiring already logs.

- [ ] **Step 1: Write the failing tests:** `cableHost.spec.ts` `'a tap its source answers superseded counts no open end and
  answers superseded'` and `'a rest its source answers superseded is told as superseded'`; `cableSession.spec.ts`
  `'an open the host answers superseded shows no toast and moves no face'`.
- [ ] **Step 2: Run** `npx vitest run src/cable/cableHost.spec.ts src/cable/cableSession.spec.ts` and
  `npm run typecheck` → FAIL. Commit red: `Dial: a tap a later one replaced ends quietly (red)`.
- [ ] **Step 3: Implement** the Interfaces.
- [ ] **Step 4: Run** both specs and `npm run typecheck` → PASS. Commit green:
  `Dial: a tap a later one replaced ends quietly`.

### Task 9: Last action wins

**Files:** Modify `cli/src/cable/hosts/observed.ts`; Test `cli/src/cable/hosts/observed.spec.ts`.

**Interfaces:**
- Consumes: `waitFresh` (Task 6); `'superseded'` (Task 8).
- Produces: private `acted` and `tapped` counters; `focus(agent): Promise<boolean | 'superseded'>`,
  `showPane(agent): Promise<PaneSwitch | 'superseded'>`. With Open question 1 answered A: `true` and `'ok'` in place of
  `'superseded'`; answered B: `false` and `'failed'`.

- [ ] **Step 1: Write the failing tests** in `describe('ObservedSource outer place')`, fresh asks by hand:
  - `'two taps during one wait: only the later opens'`: both answer after one fresh answer lands; `open` called once;
    the first answers `'superseded'`, the second `true`.
  - `'a tap on a, then on b during a\'s wait: b opens, a does not'`.
  - `'a rest that a later rest or tap replaced shows nothing'`: `'superseded'`, no `tabSelect` for it.
  - `'a rest after a tap does not drop the tap'`: the tap opens, the rest shows.
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/observed.spec.ts -t 'outer place'` → FAIL (both taps open).
  Commit red: `Dial: the last tap or rest wins (red)`.
- [ ] **Step 3: Implement:** `focus()` sets `mine = ++this.acted; this.tapped = mine` before the wait and answers
  `'superseded'` after it when `tapped !== mine`; `showPane()` sets `mine = ++this.acted` and answers `'superseded'` when
  `acted !== mine`. Checked before the `live` check.
- [ ] **Step 4: Run** the spec and `npm run typecheck` → PASS. Commit green: `Dial: the last tap or rest wins`.

### Task 10: The devices pass the flag to the nested lookups; I13 on the devices' wiring

**Files:** Modify `cli/src/services/devices.ts`; Test `cli/src/services/devices.spec.ts`.

**Interfaces:** Consumes `createTmuxNested`'s and `createHerdrNested`'s `opts` (Tasks 3, 4), the fresh paths (Tasks 6,
7). Produces: `nesting()`'s `nested: (found, opts) => lookups[found.host](found, opts)`.

- [ ] **Step 1: Write the failing test** in `describe('an agent the attach scan found in the person\'s tmux or herdr')`:
  `'I13 for an agent the attach scan found: re-attached in another iTerm2 tab with no hook, a rest past the second
  selects the new tab and a tap raises it'`. Start with `now: () => clock`; `tmuxRun`'s `list-clients` answers
  `/dev/ttys004` for the scan, `/dev/ttys005` after; `clock += FRESH_WITHIN_MS`; `swipeEnded(ID, 'rest')` →
  `stream.lines.at(-1)` `{ app: 'iterm', tty: '/dev/ttys005' }`; `openAgent(ID)` → `{ app: 'iterm', tty:
  '/dev/ttys005', raise: true }`. Beside it, the hooked case (passes once Tasks 3 and 6 are in; the wiring's proof of
  I13 itself): `'I13: a hooked agent in tmux, re-attached in another tab with no hook since, a tap past the second
  raises the new tab'`.
- [ ] **Step 2: Run** `npx vitest run src/services/devices.spec.ts -t 'I13'` → the scan-found case FAILS (the held answer
  from the scan). Commit red: `Dial: the devices ask the scan's lookups afresh at a tap (red)`.
- [ ] **Step 3: Implement** the one line. Then give every `devices.spec.ts` test that taps or rests an agent nested in
  tmux, herdr or Zellij and lists runs a fixed clock (`now: () => clock`), so a fresh ask shares the hook's or the scan's
  answer and the runs stay as listed; with the real clock they depend on whether a second passed.
- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts`, `npm run typecheck` and `npm run test:core`
  (`devices.ts` at 100%) → PASS. Commit green: `Dial: the devices ask the scan's lookups afresh at a tap`.

### Task 11: The devices row in `cli/AGENTS.md`

**Files:** Modify `cli/AGENTS.md`. Docs only: no failing test, one commit.

- [ ] **Step 1: Edit the devices row.** tmux's and herdr's "at most one lookup a pane and agent process every 5 s" and
  Zellij's "at most one lookup a session and agent process every 5 s" each gain "and one more at a tap or rest, at most
  one a second"; the scan's "one listing every 5 s" gains "and one more at a tap or rest on an agent it placed, at most
  one a second"; "the scan reads the process table once a look" gains "and once more at a tap or rest on an agent it
  placed that no hook has told of". Nothing else changes.
- [ ] **Step 2: Commit:** `git add cli/AGENTS.md`, `Docs: the devices read a nested agent's client afresh at a tap or
  rest`.

---

## Verification

Isolation: unit specs run on fakes and injected clocks. The e2e files and tier B follow the repo's e2e rules
(`cli/AGENTS.md` rules 5 and 6, `cli/e2e/harness/daemon.ts`): each `IsolatedDaemon` has a throwaway root, home, data
folder, socket and port (never 18473), the in-memory fake backend with a made-up machine and token (no person's
account), the recording `open`, the daemon's private tmux server (`TMUX`, `TMUX_PANE` unset, `TMUX_TMPDIR` in the
root), `PrivateHerdr` with `ownHerdrsOnly`, fake Terminal and iTerm2 apps under the throwaway home and a fake dial. Nothing
reaches the person's terminals, tmux, herdr, `~/.claude`, `~/.codex`, daemon or dial. No check uses production.

1. **Local gates, the tester on this Mac, final head, clean tree:** `cd cli && npm run typecheck`; `npx vitest run
   src/cable/hosts/outer.spec.ts src/cable/hosts/tmux.spec.ts src/cable/hosts/herdrOuter.spec.ts
   src/cable/hosts/zellij.spec.ts src/cable/hosts/observed.spec.ts src/cable/cableHost.spec.ts
   src/cable/cableSession.spec.ts src/services/devices.spec.ts`; `npm run test:core` (`devices.ts` changed: 100% per
   file); then `python3 scripts/local-checks.py --run` from the repo root, its output pasted into the PR body. Seen: all
   green. These unit specs carry the platforms: macOS and Linux behaviors (Linux tty forms in Tasks 3 and 4, the raise by
   client process in Task 6), Windows unchanged (Task 6: no lookup, no wait, as Windows' lookups answer `undefined`).
2. **macOS e2e, the tester on this Mac** (needs `tmux` and herdr 0.9.5 or later; a skipped file fails the check):
   `cd cli && TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts
   e2e/dialHerdrTerminal.e2e.ts`. Seen: all pass; taps and rests on the tmux and herdr agents select their tab and pane.
   macOS-only files: no workflow runs them, so they run here.
3. **The dial eval, both tiers, on this Mac, only when the PM gives the Mac turn (one eval run at a time):**
   `cd cli && TMPDIR=/tmp caffeinate -i npm run eval:dial-apps -- --update-baseline`, once. Seen: exit 0; `Gate: passed`
   with 0 wrong-session sends; `baseline written`; in `git diff cli/src/testing/dialAppEval/baseline.json`,
   `a/darwin/I13/open.tab`, `a/darwin/I13/open.latency`, `b/darwin/I13/open.tab` and `b/darwin/I13/open.latency` rise to
   1; no other `a/` key changes (tier A is deterministic); no `b/darwin` pass/fail key that is 1 on `main` is below 1 but
   `RACED_B`'s four (a timed part that moves within the documented thresholds is not a drop: `grade.ts` holds pass/fail
   checks only); no app's score below `main`'s. The tester reports the report and that diff; an implementer commits
   `baseline.json` alone from that run: `Dial eval: I13's tap opens the tab tmux's client is in now (baseline)`. If any
   of this fails, the file is thrown away (`git checkout -- cli/src/testing/dialAppEval/baseline.json`) and the failure is
   a finding. The PR records the numbers before (`main` 26405993f3: I13 open.tab and open.latency 0 in both tiers) and
   after. No workflow is needed: the eval runs locally.
4. **PR CI jobs that start on their own:** `cli-typecheck`; `cli-tests` (tier A against the committed baseline, on
   Linux); `dial-hosts` (`cli/src/cable/hosts/` changed: herdr in kitty, WezTerm and X11, Zellij, sway, on Ubuntu: the
   Linux lookups end to end); `linux-e2e` (the dial app eval's six files, as `cli/src/cable/hosts/` changed);
   `windows-e2e` on x64 (`cli/src/cable/` changed: nothing changes on Windows). Seen: each green.
5. **Needs Diego himself, optional, not a merge gate:** after the release, on his own Mac, a Claude Code in tmux in
   iTerm2's tab 1; detach, attach from tab 2, type nothing, tap its row: iTerm2 comes forward on tab 2. No agent runs
   this check.

Proposal for the maintainers (not part of this branch, as in the 2026-11-23 plan): no workflow runs the dial's macOS-only
e2e files (`dialTmuxTerminal`, `dialHerdrTerminal`); a by-hand macOS job for them would let later pull requests run
check 2 on GitHub.

Not planned: the full CLI end-to-end suite by hand. `linux-e2e`'s six dial app eval files and `dial-hosts` already drive
taps and rests through `ObservedSource` for every app; the PM may still ask for one run.

## Open questions

1. **What does a tap, or a rest, that a later one replaced answer?** The spec says it does not act, not what it tells
   the dial. (A) `true` / `'ok'`: no file beyond `observed.ts`, but the dial counts an open that did not happen, and its
   face turns to the replaced tap's agent, then back once the later tap answers. (B) `false` / `'failed'`: the dial toasts
   "iTerm2 did not open it." for a tap the person replaced. (C) `'superseded'`: no toast, no face move, no open end
   counted, the rest logged `swipe · superseded` (which the wiring already knows); adds Task 8 (`types.ts`,
   `cableHost.ts`, `cableSession.ts` and two specs, all in the devices process). Recommended: C. This draft is written
   for C; with A or B, Task 8 goes and Task 9's answers change as it says.
