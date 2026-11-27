# Dial: a stroke on another app's agent never wakes Harness — Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** A dial stroke goes to Harness's windows (`dial_scroll`) only while the dial holds the window's tab or shows a
Harness agent; on another app's agent with no pane that takes it, or with no agent shown off the tab, it goes nowhere.

**Architecture:** One routing change in the devices process (`routeScroll`, `cli/src/services/devices.ts`): where a
stroke today falls back to `'windows'`, it now falls back to `'windows'` or a new `'nowhere'` route, chosen at the
stroke's `down` and kept to its `up`. "Another app's agent" is the test `CableHost.outsideEntry` already makes, exposed
as one public method. "Holds the window's tab" is the devices' existing `heldOnTab()`.

**Tech Stack:** TypeScript (daemon devices process), Vitest unit and e2e suites.

**Spec:** `docs/plans/2026-11-18-dial-pick-focus-back-design.md`

## Global Constraints

- Nothing in the core (`cli/src/core/`); no file added to `src/architecture.coreFiles.txt`.
- Desktop and firmware unchanged.
- Measure: none new. `[device] scroll · herdr-app · not on screen` stays as it is, once per stroke, also when the stroke
  then goes nowhere.
- The route is chosen at the stroke's `down` and kept to its `up`.
- Every platform the same rule (macOS, Linux, Windows): a stroke on an agent of another source goes nowhere.
- A replacement removes the old: the docs that say a stroke on another app's agent goes to Harness's windows change in
  the same pull request.
- Test-first; no fixed sleeps in tests.

## Decisions this plan makes (not open in the spec)

- **"The dial holds the window's tab"** is the existing `heldOnTab()` in `devices.ts`
  (`windowOpen && (cableHost.holdsTab() || !cable.wantsApps())`). It is right for both kinds of dial: a dial without
  `appFilter` holds the tab whenever a window is open; one with it holds the tab in the `tabs` view. One definition: it
  moves above `routeScroll`, no second copy.
- **"The agent it shows is Harness's"** is `shownAgentId()` defined and `!cableHost.isOutside(agentId)`.
- **Windows or nowhere** = `heldOnTab() || (shown !== undefined && !isOutside(shown))`. With no window open and no agent
  shown this is nowhere (the spec's literal reading; see open question 1).
- While the devices stop, the same rule (the spec lists "the devices stopping" under "nowhere").

## Review Focus

1. A stroke that began going nowhere keeps that route to its `up`, even when Herdr or VS Code comes in front or the dial
   moves to a Harness agent mid-stroke; the next `move` after its `up` chooses again. (Task 1: the updated "route holds"
   cases.)
2. A Herdr stroke held for `status` whose answer is "not on screen" on another app's agent: the line is said once,
   nothing is sent, and a frame after a held `up` begins a stroke of its own. (Task 1: the updated held-answer cases.)
3. A session that moved into a Harness pane while the dial still holds its outside id is Harness's: its stroke goes to
   the windows. (Task 1: the `isOutside` case in `cableHost.spec.ts`.)
4. A dial without `appFilter` beside an open window holds the tab even with another app in front: no agent shown, its
   stroke still goes to the windows. (Task 1: the "no agent shown" cases.)
5. The `'nowhere'` route is a string: every `'held' in route` check must first rule out both strings, or it throws a
   `TypeError` on the scroll path (the part's guard would log `dial failed` on every stroke). (Task 1: the "nowhere"
   strokes with `move` frames.)

---

### Task 1: Route a stroke on another app's agent nowhere

**Effort:** high · **Depends on:** none

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (one public method beside `outsideEntry`, ~line 720)
- Modify: `cli/src/services/devices.ts` (`heldOnTab`/`windowOpen` moved above `scrollTarget`; `stroke`, `decided`,
  `routeScroll`, ~lines 690-805 and 1136-1141)
- Test: `cli/src/cable/cableHost.spec.ts`, `cli/src/services/devices.spec.ts`
- Docs: `cli/AGENTS.md` (devices row, line 81), `docs/plans/2026-11-17-dial-herdr-scroll-design.md`,
  `docs/plans/2026-11-17-dial-vscode-extension-design.md` (§4, line 188)

**Interfaces:**
- Produces: `DaemonCableHost.isOutside(agentId: string): boolean` — `this.outsideEntry(agentId) !== undefined`, with a
  one-line comment that it is the test `focus`, a tap and a swipe already make.
- Produces (devices.ts, internal): `type OffPane = 'windows' | 'nowhere'`;
  `const offPane = (): OffPane => heldOnTab() || (shown !== undefined && !cableHost.isOutside(shown)) ? 'windows' : 'nowhere'`
  where `shown = cableHost.shownAgentId()`.

- [ ] **Step 1: Write the failing tests**

`cli/src/cable/cableHost.spec.ts`, in `describe('an agent outside Harness takes its voice, its answer and its tap from its own source')`,
using its `setup()` and `onTab` as the case "on the tab, where no machine list is read, a session that moved into a
Harness pane takes no words as outside" does:

```ts
it('isOutside: an agent of another source is, a Harness agent, an unknown id and a session moved into a Harness pane are not', () => {
  const { host, w } = setup()
  expect(host.isOutside('o1')).toBe(true)
  expect(host.isOutside('h-unknown')).toBe(false)
  const advertised = w.sessions
  w.sessions = () => [...advertised(), { agentId: 'r1', sessionId: 's-o1' } as unknown as RegisteredSession]
  expect(host.isOutside('o1')).toBe(false)
})
```

(Add a Harness-source agent assertion if `setup()` lists one; the implementer checks its registry.)

`cli/src/services/devices.spec.ts`, inside `describe('with a window open (docs/specs/2026-11-15-dial-follow-front-with-window.md)')`,
a local `DIAL = {}`, `shows(agentId)` (`host().dialShows(DIAL, agentId ? { name: 'api', app: 'ghostty' } : null, agentId)`),
`touch()` (`host().scrolled('down', 0, 0); host().scrolled('move', 8, 0); host().scrolled('up', 0, 0)`) and
`dialScrolls(core)` as the VS Code block defines it. Cases (the first two are red today):

| Case | Setup | Expect `dialScrolls(core)` |
|---|---|---|
| another app's agent with no pane that scrolls | `windowed('ghostty')`, `shows(G1)` | `[]` |
| no agent shown on another app's ring | `windowed('ghostty')`, nothing shown | `[]` |
| a Harness agent shown, another app in front | `windowed('ghostty')`, `shows('h1')` | down, move 8, up |
| no agent shown on the tab | `windowed()` | down, move 8, up |
| no agent shown, a dial without appFilter, another app in front | `windowed('ghostty', false)` | down, move 8, up |

Name the first case after the bug: `'a touch on another app\'s agent sends Harness\'s windows nothing, so Harness is not brought forward'`.

Update the existing cases that expected the windows (find by name; line numbers drift). Each now expects
`dialScrolls(core)` to be `[]`, and keeps every other assertion (`not on screen` lines, `orcaRuns`, `hc.pressed`):
- VS Code block (`~3489`): the `it.each` rows `'another app in front'`, `'an agent with no terminal'` and
  `'no agent shown'` (no window open) move to a new `it.each` "…the stroke goes nowhere"; `'a Harness agent'` stays
  in the windows one.
- VS Code `'a stroke keeps the route its down chose…'`: its second half (`front('ghostty')` at the down) sends nothing;
  the last `move` after the `up` still chooses VS Code.
- Herdr block (`describe('a stroke on the dial scrolls Herdr …')`): every `it.each` row of "…goes to the windows as
  before…" but `'a Harness agent shown'` moves to "…goes nowhere, and herdr-app is not asked"; `'the route holds from
  down to up'` second half sends nothing and its final `toHaveLength(3)` becomes `0`; `'status names another tab…'`,
  `'a terminal hc tells %s is not on screen'`, `'a status that fails is not on screen'`, the `'not on screen'` rows of
  `'an answer after the up decides the whole stroke'` and `'a newer down before the answer drops the stale one'`,
  `'%s'` (the two replay rows), `'the held move carries the last move\'s velocity…'`, `'a Claude Code terminal that
  asks…'` and `'a stroke begun while the devices stop…'`: nothing sent, `NOT_ON_SCREEN` still said where it was.
  Rename the cases whose name says "the windows" (e.g. "…the stroke goes nowhere, and the line is said once").
- `'a stroke the windows took before the stop keeps its route to its up'`: shows `'h1'` at the `down` (a Harness agent,
  so the windows take it), then `shows(id)`; frames unchanged.
- `'tells the windows on this computer what a hand at this desk did…'` (`~line 900`): before `w.scrolled!`, show a
  Harness agent (`host.dialShows({}, { name: 'api', app: 'harness' }, 'a1')`), so its `dial_scroll` frame stays.

- [ ] **Step 2: Run them to verify they fail**

Run (in `cli/`): `npx vitest run src/cable/cableHost.spec.ts src/services/devices.spec.ts`
Expected: FAIL — `host.isOutside is not a function`; the two red window-open cases and the updated cases receive
`dial_scroll` frames. The three windows cases pass. Commit the red tests:
`git commit -m "Dial: a stroke on another app's agent goes nowhere (red)"` with only the two spec files.

- [ ] **Step 3: Implement**

- `cableHost.ts`: `isOutside` as in Interfaces.
- `devices.ts`:
  - Move `windowOpen` and `heldOnTab` (with their comments) above `scrollTarget`; nothing else uses a second copy.
  - `stroke` becomes `ToPane | { deciding: ScrollTarget; held: Held; otherwise: OffPane } | OffPane | undefined`.
    Replace each `route !== 'windows' && 'held' in route` with `typeof route === 'object' && 'held' in route`.
  - `routeScroll` at a new stroke: no target → `route = stroke = offPane()`; a target `routeOf` asks →
    `otherwise: offPane()` in the record, read at the `down`.
  - `decided` with `'windows'`: keep the `not on screen` log line; when `asked.otherwise === 'nowhere'`, set
    `stroke = held.up === undefined ? 'nowhere' : undefined` and send nothing; otherwise replay to the windows as today.
  - The tail: `'windows'` sends, `'nowhere'` sends nothing, `phase === 'up'` still clears `stroke`.
  - Update the comments that say "Harness's windows otherwise" (the `stroke` doc comment, `decided`, `routeOf`) to say
    why: Harness's windows do not show another app's agent, and Desktop raises its window on a stroke's `down`.
- Docs (same cause, PM 2026-11-18):
  - `cli/AGENTS.md` line 81: "and goes to Harness's windows otherwise" → "and goes nowhere otherwise: Harness's windows
    take a stroke only while the dial holds the window's tab or shows a Harness agent".
  - `docs/plans/2026-11-17-dial-herdr-scroll-design.md`: lines 55, 154, 196-200, 224, 227, 229, 230, 233, 236, 239, 248
    and 284 — each place a stroke on a Herdr agent goes to Harness's windows now goes nowhere; the `'windows'` replay
    text (196, 284) says it applies only to a stroke whose fallback is the windows. Add one line pointing to
    `2026-11-18-dial-pick-focus-back-design.md`.
  - `docs/plans/2026-11-17-dial-vscode-extension-design.md` line 188: "Otherwise it goes as today." → "Otherwise it goes
    nowhere, unless the dial holds the window's tab or shows a Harness agent
    (`2026-11-18-dial-pick-focus-back-design.md`)."

- [ ] **Step 4: Run to verify they pass**

Run (in `cli/`): `npx vitest run src/cable/cableHost.spec.ts src/services/devices.spec.ts && npm run typecheck`
Expected: PASS, no type errors.
Then `npm run test:core` — PASS with 100% per file for `src/services/devices.ts`.

- [ ] **Step 5: Commit**

```bash
git add cli/src/cable/cableHost.ts cli/src/services/devices.ts cli/AGENTS.md \
  docs/plans/2026-11-17-dial-herdr-scroll-design.md docs/plans/2026-11-17-dial-vscode-extension-design.md
git commit -m "Dial: a stroke on another app's agent never wakes Harness"
```

---

### Task 2: E2E strokes on another app's agent end on another signal

**Effort:** high · **Depends on:** Task 1 (its new assertions pass only on Task 1's routing)

**Files:**
- Modify: `cli/e2e/dialVscode.e2e.ts` (step 3 of "a stroke scrolls the shown agent's terminal…", ~lines 365-378; header
  comment if it says the windows)
- Modify: `cli/e2e/deviceHerdrApp.e2e.ts` (header line 9; steps 4-6 of "a stroke with Herdr in front scrolls…",
  ~lines 416-444)

**Interfaces:**
- Consumes: Task 1's behavior only. End of stroke = the `cable: scroll ↑` log line (both files' `stroke()` already wait
  for it). Absence of `dial_scroll` is proven by an ordered marker on the same devices → core → window path, never a
  sleep: the window client sends `app_swarms` with tab `t1`
  (`{ active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] }`), then
  `until('the marker', () => { dial.send({ t: 'swarm.select', swarmId: 't1' }); return client.frames.some((f) => f.type === 'dial_swarm') }, 30_000, 200)`
  (resent until the devices have the tab), then the `dial_scroll` assertions.

- [ ] **Step 1: The failing test**

On Task 1's head, run as they stand (in `cli/`, macOS):
`npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts e2e/deviceHerdrApp.e2e.ts`
Expected: FAIL — dialVscode times out on "the stroke's up in Harness's window"; deviceHerdrApp on "stroke 2's up in
Harness's window" (skipped where Herdr Core is not installed: say so in the evidence).

- [ ] **Step 2: Rewrite the steps**

- `dialVscode.e2e.ts` step 3 ("Ghostty in front"): the stroke goes nowhere. After `await stroke()`, the marker on
  `harness`, then `expect(harness.frames.filter((f) => f.type === 'dial_scroll')).toEqual([])`; `window.scrolls` and
  `window.shows` assertions unchanged. Rename the step comment.
- `deviceHerdrApp.e2e.ts`: step 4 keeps `said(d, '[device] scroll · herdr-app · not on screen')` and drops the
  `dial_scroll` wait; step 5 (Orca in front) waits on `stroke()` alone; step 6 runs the marker on `window`, then
  `expect(dialScrolls()).toEqual([])`, and keeps `scrolls()` = first runs, `statuses()` = 2, the tallies, the single
  `not on screen` line, no failure lines and no terminal address in the log. Header line 9: "it goes to Harness's
  windows otherwise" → "it goes nowhere otherwise".

- [ ] **Step 3: Run to verify they pass**

Same command as Step 1. Expected: PASS (deviceHerdrApp PASS on a Mac with Herdr Core, skipped elsewhere).

- [ ] **Step 4: Commit**

```bash
git add cli/e2e/dialVscode.e2e.ts cli/e2e/deviceHerdrApp.e2e.ts
git commit -m "Dial e2e: a stroke on another app's agent reaches no window"
```

---

## Verification

All checks use the e2e harness's isolated daemons (`cli/e2e/harness/daemon.ts` `IsolatedDaemon`: throwaway home, data
folder, port and tmux server; fake engines, fake dials, fake `open`). None reach the developer's everyday daemon, a
real account or production.

1. **Local gates (any Mac, at the final commit, clean tree):** `python3 scripts/local-checks.py --run` from the repo
   root. It runs `npm run test:core` (this change touches `cli/src/services/`) and prints receipts for the PR body.
   `npm run test:core` must stay at 100% per file. The core is not touched: `npx vitest run src/architecture.spec.ts`
   in `cli/` passes with `src/architecture.coreFiles.txt` unchanged.
2. **E2E on a Mac (local):** in `cli/`,
   `npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts e2e/deviceHerdrApp.e2e.ts e2e/dialAppFilter.e2e.ts`.
   `deviceHerdrApp` needs Herdr Core installed (it runs a private core of its own; skipped on GitHub runners), so it
   runs only here. Expected: all pass; `dialAppFilter` unchanged (it sends no strokes).
3. **E2E on GitHub, by hand, once:** Actions → **CLI end to end** → Run workflow on `fix/dial-pick-focus-back-to-harness`
   (`.github/workflows/cli-e2e.yml`, Linux shards). Covers `dialVscode`, `dialAppFilter` and `deviceCompat` (a Harness
   agent's stroke still reaches the window). Report the run link in the PR. No temporary workflow is needed.
4. **`cli/e2e/dialAppFilterOnDial.e2e.ts` (needs the user: their dial and their eye; optional):** the opt-in rig,
   `ON_DIAL_PORT=/dev/cu.usbmodem… ON_DIAL_OUT=<folder> npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilterOnDial.e2e.ts`
   in `cli/`, on the Mac the dial is plugged into, with its own isolated daemon. It does not touch the glass for a
   scroll; run it only to confirm the filter walk is unchanged.
5. **The bug itself (needs the user: their Mac, Harness Desktop, the round dial, their eye; test account):** with this
   branch's daemon running and Desktop open, pick Ghostty (or another app with agents) on the dial, then touch the glass
   a few times. Expected: the app stays in front; the daemon log shows `cable: scroll ↓` / `cable: scroll ↑` with no
   `app filter: switched · front / view tabs · front` after them. Then on the window's tab, a stroke still scrolls
   Desktop's terminal. Uses the user's own Desktop and daemon, so it is theirs to run; open question 2.

## Decisions (PM, 2026-11-18)

1. No window open and no agent shown: nowhere, as the spec reads. Desktop raises itself on a stroke's `down` whatever
   the dial holds.
2. Check 5 (the bug on the user's own Desktop and dial) does not hold the merge: the PR merges on green CI; Diego
   confirms it on the release.
