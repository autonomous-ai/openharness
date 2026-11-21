# A ring that replaces a full one reaches the dial whole — Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing
> tests have been run and seen to fail, then the task's own message. A task with no red test is one commit.

**Goal:** A ring pushed over a dial whose carousel it would overflow (more than 16 agents counting the old and the new)
reaches the dial whole, with an agent on its face, instead of leaving it on "Choose a pane".

**Architecture:** `CableSession.syncAgentsNow` (`cli/src/cable/cableSession.ts`, in the devices process) splits such a
push in two: step 1 is the new ring's agents the dial already holds, step 2 the full ring, held for
`AGENTS_PUSH_GAP_MS` after step 1 (and while the dial's voice is open, and 1 s after it closes) and sent by the
session's 1 s tick. The cable host tells one new optional wiring member the outcome of a dial pick that switched
nothing, and the devices log it in fixed words. Nothing in `cli/src/core/`, nothing in the firmware.

**Tech Stack:** TypeScript (`cli/`), vitest (unit, fake `Date`/`performance`), the CLI's end-to-end harness
(`cli/e2e/`, real daemon, fake dial on a pseudo-terminal, fake `orca`).

**Spec:** `docs/plans/2026-11-20-dial-orca-pick-choose-pane-design.md`. Read it with this plan, the root `AGENTS.md`,
`cli/AGENTS.md` (Protect the core; Rules 4-7) and `cli/src/services/AGENTS.md`.

## Base

- Branch `fix/dial-orca-pick-choose-pane` at `a59ba98a15`, in this worktree. The spec and this plan are untracked: the
  main session commits them; no task does.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` if `cli/node_modules` is missing. One
  install at a time, never inside two tasks at once.
- Names at the base. `cableSession.ts`: `AGENTS_PUSH_GAP_MS` (line ~121), `lastAgentsKey`, `lastRing`, `lastAppsKey`,
  `agentsPushedAt`, `desiredFocus`/`focusRecord`, `reportShown`, `appFocusUnsent`, `voice` (the turn, line ~951),
  `voiceGeneration`, `tick`, `tryOpen` (resets at ~1216), `onClosed` (~1240), the `agents.list` case (~1544), the
  `app.pick` case (~1674), `syncAgents`, `syncAgentsNow` (~2818), `pushAgents`, `viewChanged`, `followApp`;
  `cable/hosts/select.ts` `RING_PLACES`; `cable/hosts/types.ts` `AppPick`; `cableHost.ts` `CableHostWiring`
  (`appPicked` ~170), `pickApp` (~753); `services/devices.ts` the wiring object (`appPicked:` ~1114). Specs:
  `cableSession.spec.ts` `makeHost`, `connect`, `tmpLog`, `settle`, `NEXT_TICKS`, `LoopbackPort`, `row`, `appHost`, the
  describe `a machine list lands a dial that holds no agent` (`landed`, `greet`, `replugging`, `focuses`);
  `cableHost.spec.ts` `setup`, `five`, `viewed`; `devices.spec.ts` `start`, `twoApps`, `host()`, `logs`. e2e:
  `harness/fakeDial.ts` `FakeDial`, `harness/desk.ts` `Desk`, `harness/fakeOrca.ts` `FakeOrca`, `harness/inOrca.ts`
  `InOrca`, `harness/daemon.ts` `IsolatedDaemon`, `until`, `CLI_ROOT`. If a name differs, follow the code and say so in
  the report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 Two-step push and its hold | `cli/src/cable/cableSession.ts`, `cli/src/cable/cableSession.spec.ts` | none | xhigh | `cableSession.spec.ts` describe `a ring that would overflow the dial goes in two steps` |
| 2 A pick that switches nothing says why | `cli/src/cable/cableHost.ts`, `cli/src/cable/cableHost.spec.ts`, `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts` | none | high | `cableHost.spec.ts` `appPickKept is told …`; `devices.spec.ts` `a pick that switches nothing says why …` |
| 3 The fake dial's carousel | `cli/e2e/harness/fakeDial.ts` | none | high | none: test harness only, it sends nothing new (one commit) |
| 4 End to end: Orca's ring over a full dial | `cli/e2e/dialOrcaFullRing.e2e.ts` (new) | 1, 2, 3 | high | none of its own: a test only, one commit; Step 2 shows it fails on the base session |

Longest chain: 1 → 4 (two tasks). Tasks 1, 2 and 3 start at once; they share no file.

## Global Constraints

- **Core and firmware untouched:** nothing under `cli/src/core/`, no line of `cli/src/architecture.coreFiles.txt`,
  nothing under `devices/`. The change lives in the devices process (`cable/`, `services/devices.ts`).
- **Platforms:** the new code is TypeScript shared by macOS, Linux and Windows (Windows reaches the dial through
  `harness-serial.exe`; the session code is the same). No platform branch. Harness Pro gets the same two steps.
- **Values:** `RING_PLACES` (16) imported from `cable/hosts/select.ts`, never a new 16; `AGENTS_PUSH_GAP_MS` (1 000 ms)
  for the hold and for the 1 s after voice closes. **No new timer:** the session's existing 1 s tick sends step 2.
- **Exact log lines, counts only, never an id, name, app or handle:**
  - dial log (`this.log`), once per split, before step 1's `cable: agents → <kept> of <total>`:
    `cable: agents split · <kept> kept · <n> in ring` (`<kept>` = step 1's count, `<n>` = the full ring's).
  - devices log: `[device] app filter: pick · same`, `[device] app filter: pick · ignored`. A pick that answers
    `switched` or `tabs`, and any notice's pick, logs nothing new. `[device] app filter: picker` keeps its place, before.
- **Coverage:** `src/services/devices.ts` stays at 100% per file (`npm run test:core`).
- **No fixed sleeps in tests:** unit tests use `vi.useFakeTimers({ toFake: ['Date', 'performance'] })` and
  `vi.advanceTimersByTime`; e2e waits poll (`until`, `FakeDial.next`). The fake dial's refresh interval is the model of
  the firmware's refresh task, never something a test waits out.
- **Comments say why** and name the incident: Diego, 2026-11-20 17:32:40, the 16 stale tiles removed, "Choose a pane"
  (the spec's table), and the firmware's add-before-remove (`app_main.c` `refresh_projects`).
- **Known gap, not fixed:** a daemon restart where the dial's session did not go down. It goes in the PR body.

## Decisions made in this plan (the spec left them to the builder)

- **Field names:** `private splitAt: number | null = null` (by `performance.now()`, the spec's name) and
  `private voiceClosedAt = -Infinity`. `private holdsStep2(now: number): boolean` is
  `splitAt !== null && (now - splitAt < AGENTS_PUSH_GAP_MS || this.voice !== null || now - voiceClosedAt < AGENTS_PUSH_GAP_MS)`.
- **One place sees voice close:** `voice` becomes a private accessor pair over a backing field (`voiceTurn`), as
  `desiredFocus` is over `focusRecord`. The setter stamps `voiceClosedAt = performance.now()` when a turn is replaced
  by `null`, and, when a turn opens, first clears a `splitAt` whose hold is already over (so a voice that opens later
  holds nothing). Every existing `this.voice = …` site (begin, abort, end via `answerVoice`, `carry.cancel`, the
  over-cap drop, `onClosed`) goes through it unchanged.
- **When `splitAt` ends:** set by each step 1; set to `null` by a port open (`tryOpen`), a port close (`onClosed`), the
  dial's `agents.list`, the voice setter above, and at the top of `syncAgentsNow` when `holdsStep2(now)` is false.
- **Order inside `syncAgentsNow`:** the snapshot and keys as today → the split, computed against `lastRing` (the list
  to send is step 1 or the full ring) → the hold, on the list to send: a ring push (`sendRing` true) whose list to send
  names an agent outside `lastRing` while `holdsStep2(now)` returns, sending nothing, not even `apps` → the existing
  machine gap → the rest as today. So another split's step 1 (it names only held agents) goes at once and restarts
  `splitAt`, as the spec says, while the full ring waits. A `ring: false` push (the apps-only answer to an ignored
  pick) names no list and is never held.
- **Overflow** is `lastRing.length > 0 && |ids(lastRing) ∪ ids(agents.slice(0, RING_PLACES))| > RING_PLACES` —
  pending open question 1: the firmware keeps only the first 16 rows of a list (`cable_client.c` `handle_agent`),
  and a window's tab is not bounded at 16, so counting the whole list would split a 20-agent tab again at every
  step 2, forever.
- **Step 1** is `agents.filter((a) => held.has(a.id))` (the new ring's order); from the split on, everything after it in
  `syncAgentsNow` (key, `agents →` line, frames, `lastRing`, `reportShown`, the re-assert, the landing) reads step 1.
  **Except** the "back on the window's tab" record move (`this.appFilter && tab && lastAgentsKey.startsWith('machine|')`):
  it reads the full ring, since step 2's key no longer starts with `machine|` and would skip it (Review Focus 2).
- **The existing landing comment** ("the firmware adds a list's agents before it removes the old ones, so only a ring
  that replaces none leaves its face empty") is rewritten: an empty step 1 is now the other way the dial holds none.
- **Wiring member:** `CableHostWiring.appPickKept?: (answer: 'same' | 'ignored') => void`, called in `pickApp` after the
  answer, for `cause === 'pick'` only.
- **End-to-end route:** the simpler one. The dial holds WezTerm's full ring of 16 (sessions whose hook names
  `WEZTERM_PANE`, as `dialStream.e2e.ts` makes one); Orca comes to the front with two agents, which the dial does not
  hold: `|16 ∪ 2| = 18 > 16`, the cause in the spec. The worktree scope through the Orca plugin's listener stream is
  not needed to reproduce it (the spec: "that difference is by design and is not this bug") and is already covered by
  `dialStream.e2e.ts`; leaving the plugin's loop out drops a process, a launcher shim and a socket from the test. The
  fake `orca` stays installed without `watch-focus`, as Diego's Orca 1.4.256 (`orca watch · unsupported`).

## Review Focus

Inputs the spec implies and its test list does not name. Each has its test in the task that owns the code.

1. **A window's tab of more than 16 agents** (the tab list is not bounded by the ring). Expected: over a dial holding
   none it goes in one push; over a full dial of other agents in two; never a third. Task 1 `a tab of more than sixteen
   agents …` (pending open question 1).
2. **Back on the window's tab from a full app ring** (the record still names the agent the dial left the tab on).
   Expected: the record moves to the window's agent as today; no `focus` names the agent left on the tab, at either
   step. Task 1 `back on the window's tab from a full app ring …`.
3. **A follow in flight during the hold** (`followApp` wrote its record before its push, which is now held). Expected:
   no landing on the ring's first agent; the follow's own `focus` (held by the firmware until the tile exists), then
   the re-assert after step 2. Task 1 `a follow in flight during the hold …`.
4. **A second overflowing ring inside the hold** (Orca's front flips twice fast). Expected: its step 1 names only held
   agents and goes at once; the hold counts again from it; step 2 is the latest ring. Task 1 `a second split inside the
   hold …`.
5. **A voice opened after the hold ended** (a stale `splitAt`). Expected: lists are not held during it. Task 1 `a voice
   that opens after the hold ended holds nothing`.

---

### Task 1: Two-step push and its hold

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (`syncAgentsNow`, the `voice` field, `tryOpen`, `onClosed`, the
  `agents.list` case; import `RING_PLACES` from `./hosts/select.js`)
- Test: `cli/src/cable/cableSession.spec.ts` (one new describe after `a machine list lands a dial that holds no agent`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the dial-log line `cable: agents split · <kept> kept · <n> in ring` (Task 4 reads it in the daemon log);
  the frames a split sends: step 1 `agents.begin`, its `agent` rows, `agents.end`, then, a tick at least 1 s later,
  step 2's list and its `focus`.

Shared fixtures in the new describe: `vi.useFakeTimers({ toFake: ['Date', 'performance'] })` in each test (restored in
`finally`); `SIXTEEN = Array.from({ length: 16 }, (_, i) => row(`f${i}`, 'ghostty'))`; `ORCA = [row('o1', 'orca'),
row('o2', 'orca')]`; `machine(agents)` and `tabOf(agents, tab)` snapshots (`{ agents, tab, total: agents.length }`);
the `landed`/`greet`/`replugging` pattern of the describe above; `lists(port)` = each `agents.begin…agents.end` after a
mark, as id arrays; `splitLines(host)` = `host.log` calls that contain `agents split`. "The tick" in a test is an
explicit `await session.syncAgents()` after advancing the fake clock: the real interval sees the frozen
`performance.now()` and sends nothing early.

- [ ] **Step 1: Write the failing tests** (describe `a ring that would overflow the dial goes in two steps
  (docs/plans/2026-11-20-dial-orca-pick-choose-pane-design.md)`):
  1. `a full dial pushed a ring it holds none of gets an empty list, then the ring and a focus on its first agent a second later`
     — landed on `SIXTEEN` (focus `f0`); +1 100 ms, rows = `ORCA`, sync → `lists` = `[[]]`, no `focus`, the host's last
     `dialShows` is `(session, null, null)`; sync again at once → nothing sent; +1 000 ms, sync → `lists` = `[[], ['o1','o2']]`
     and `focuses` = `[{ t: 'focus', agentId: 'o1' }]`, after the second `agents.end`; `dialShows` last names `o1`.
  2. `a ring that keeps some of a full dial's agents sends those first, in the new order, and re-asserts the record after each step`
     — landed on `SIXTEEN`, +751 ms the dial says `focus f3`; +1 100, rows = `[n1, f5, n2, f3]` (union 18); sync →
     step 1 ids `['f5','f3']`, then `focus f3`; +1 000, sync → `['n1','f5','n2','f3']`, then `focus f3`; no `focus` on
     `n1`.
  3. `a forced push that splits (a pick's switched) holds its second step a second, its apps frame going once with the first`
     — `appHost` with `state.rings.ghostty` = `SIXTEEN`, greeted with `{ appFilter: 'v1' }`; the dial says
     `app.pick vscode` → one `apps` (shown `vscode`) before an empty list; `await session.syncAgents(true)` at once →
     nothing; +1 000, `syncAgents()` → the list `['v1','v2']` and `focus v1`; still exactly one `apps` frame since the pick.
  4. `a window tab's list that splits waits the hold too, and a list naming only held agents goes at once`
     — greeted on `tabOf(SIXTEEN, 't1')`; rows → `tabOf(ORCA, 't2')`, sync → `[[]]`; +500, sync → nothing; +500, sync
     → `['o1','o2']`, and no `focus` (a tab never lands). Second part: greeted on `tabOf(SIXTEEN, 't1')`, rows →
     `tabOf([n1, f5, n2, f3], 't2')` → step 1 `['f5','f3']`; +300, rows → `tabOf([f5], 't2')`, sync → `['f5']` at once.
  5. `the hold lasts while the dial's voice is open and a second after it closes`
     — after a split at t0: +100 the dial says `voice.begin` (`uploadId: 'u1'`, no `agentId`); +2 000, sync → nothing;
     the dial says `voice.abort` (`uploadId: 'u1'`); +900, sync → nothing; +200, sync → the full ring.
  6. `a port open and the dial's agents.list end the hold`
     — (a) `replugging`: split, unplug, replug and greet → the full ring and `focus o1` at once, no split line for that
     push; (b) split, then the dial says `agents.list` → the full ring and `focus o1` at once.
  7. `a ring that fits with the old one in sixteen goes in one step` — landed on ten agents; +1 100, rows = six others
     (union 16) → one list of six, no split line, no focus (a ring that replaces agents does not land, as today).
  8. `the split line is said once a split, with counts only` — over tests 1-2's flows: `splitLines` equal exactly
     `['cable: agents split · 0 kept · 2 in ring']` and `['cable: agents split · 2 kept · 4 in ring']`, each before
     the `cable: agents → 0 of 2` / `→ 2 of 4` line; a held push and step 2 log no split line.
  Review Focus tests, same describe:
  9. `a tab of more than sixteen agents after an empty dial goes in one push, and over a full dial in two, never three`
     — greeted on an empty tab, rows → a tab of 20 (`t0`…`t19`) → one list of 20, no split line. Then a full
     `SIXTEEN` tab, +1 100, rows → the 20 others → `[[], 20 ids]` over the hold, and two further syncs a second apart
     send nothing.
  10. `back on the window's tab from a full app ring, the record moves to the window's agent and no focus names the agent left on the tab`
     — `appHost` with a window, `state.appView` on and `state.rings.ghostty` = `SIXTEEN`; the dial turned to `a1` on
     the tab first, then shown the ring; the view goes back to the tab with `state.focus` on `a2` → step 1 empty, step 2
     `['a1','a2']`; every `focus` after the view change names `a2`, never `a1`.
  11. `a follow in flight during the hold lands nothing first: its own focus, then the re-assert after the ring`
     — a dial greeted without `appFilter` (with it and no window, `followApp` ignores an agent outside `lastRing`,
     as for any agent off the ring: the spec, §2); split from `SIXTEEN` to `ORCA`; within the hold
     `await session.followApp('', 'o2')` (as the tests near `cableSession.spec.ts` line 1445 call it) → its own list push is held, a
     `focus o2` goes with no list before it; +1 000, sync → `['o1','o2']`, then `focus o2`; no `focus o1` anywhere.
  12. `a second split inside the hold sends its first step at once and holds a second from it`
     — landed on `SIXTEEN`, the dial on `f3`; split to `[n1, f5, n2, f3]` at t0 (step 1 `['f5','f3']`); +400, rows →
     `[f3, m1 … m15]` (union with step 1: 17) and `await session.syncAgents(true)` (forced past the machine gap) →
     step 1' `['f3']` at once, split line `cable: agents split · 1 kept · 16 in ring`; +800 (t0+1 200, 800 ms after
     step 1') sync → nothing; +200 → the full new ring.
  13. `a voice that opens after the hold ended holds nothing` — split at t0 and no sync after it; +5 000 the dial says
     `voice.begin` (`uploadId: 'u2'`); sync → step 2 goes at once; +1 100, rows → a ring of new agents that fits with
     it, sync → it goes too, the voice still open.
- [ ] **Step 2: Run them to see them fail.** `cd cli && npx vitest run src/cable/cableSession.spec.ts -t "goes in two steps"`
  → tests 1-6, 8, 9, 11 and 12 FAIL (one push of the full ring, no hold, no split line); 7, 10 and 13 guard what
  holds today and pass already (they must still pass after Step 3). Commit
  `test(cli): a ring that would overflow the dial goes in two steps (red)`.
- [ ] **Step 3: Implement in `cableSession.ts`** per "Decisions made in this plan": the `splitAt`/`voiceClosedAt`
  fields and `holdsStep2(now)`; the `voice` accessor pair; `splitAt = null` in `tryOpen`, `onClosed` and the
  `agents.list` case beside `lastRing = []`; in `syncAgentsNow` the stale-hold clear, the hold, the overflow, step 1,
  `splitAt = performance.now()` once step 1's `agents.end` went, the split line just before the `agents →` line, the
  tab record move reading the full ring, and the rewritten landing comment. Each comment says why (the firmware's
  refresh order and buffer, the incident).
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts` → all PASS (the old tests too), and
  `npm run typecheck` → clean.
- [ ] **Step 5: Commit** `fix(cli): a ring that would overflow the dial goes in two steps`.

---

### Task 2: A pick that switches nothing says why

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (`CableHostWiring`, `pickApp`)
- Modify: `cli/src/services/devices.ts` (the wiring object, beside `appPicked`)
- Test: `cli/src/cable/cableHost.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `AppPick` (`cable/hosts/types.ts`), unchanged.
- Produces: `CableHostWiring.appPickKept?: (answer: 'same' | 'ignored') => void`, doc comment: a pick on the dial that
  switched nothing, and why; never a notice. The devices log line `[device] app filter: pick · <answer>` (Task 4).

- [ ] **Step 1: Write the failing tests.**
  - `cableHost.spec.ts`, beside `appPicked is told once for each pick, and not for a notice`:
    `appPickKept is told same or ignored for a pick that switches nothing, and nothing for a switch, tabs or a notice`
    — one `told: string[]` fed by `appPicked: () => told.push('picker')` and `appPickKept: (a) => told.push(a)`;
    `setup(five(), …)`, picks `vscode`, `vscode`, `cursor` → `told` = `['picker', 'picker', 'same', 'picker', 'ignored']`;
    `pickApp('ghostty', 'notice')` adds nothing. With a window (`viewed(five(), …)`): on the tab, a pick of `harness`
    → `'ignored'` told; on an app's ring, a pick of `harness` (`tabs`) → nothing told.
  - `devices.spec.ts`, beside `the picker's use is one log line with no app in it`:
    `a pick that switches nothing says why in fixed words` — `twoApps(port)`, picks `ghostty` (same), `vscode`
    (switched), `cursor` (ignored) → the log lines that contain `app filter: pick` equal
    `['[device] app filter: picker', '[device] app filter: pick · same', '[device] app filter: picker',
    '[device] app filter: picker', '[device] app filter: pick · ignored']`; a notice's pick adds none.
- [ ] **Step 2: Run them to see them fail.** `cd cli && npx vitest run src/cable/cableHost.spec.ts
  src/services/devices.spec.ts -t "switches nothing"` → both FAIL (`appPickKept` never called; no `pick ·` lines).
  Commit `test(cli): a pick that switches nothing says why (red)`.
- [ ] **Step 3: Implement.** `cableHost.ts`: the member in `CableHostWiring` after `appPicked`; in `pickApp`, after
  `answerPick`, `if (cause === 'pick' && (answer === 'same' || answer === 'ignored')) this.wiring.appPickKept?.(answer)`.
  `devices.ts`: `appPickKept: (answer) => log(`[device] app filter: pick · ${answer}`)`, with a one-line why (the PM's
  ask, 2026-11-20: a fixed-word reason when a pick yields no ring; the answer only, never the app).
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts src/services/devices.spec.ts` → PASS;
  `npm run test:core` → PASS with `src/services/devices.ts` at 100%; `npm run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(cli): a dial pick that switches nothing says why in the devices log`.

---

### Task 3: The fake dial's carousel

**Files:**
- Modify: `cli/e2e/harness/fakeDial.ts`

**Interfaces:**
- Produces, on `FakeDial`:
  - `carousel(): { tiles: string[]; active: string | null; refused: number }` — the tiles in order, the agent on the
    face (`null` is the firmware's `s.active = -1`, drawn as "Choose a pane"), and how many agents `ensure` refused
    since the dial opened.
  - `pick(app: string): void` — sends `{ t: 'app.pick', app }` and, as the firmware's `app_pick`, arms the landing
    when `app` is not the shown app.
  - `const CAROUSEL_REFRESH_MS = 50` (module-private): the model's refresh task.

- [ ] **Step 1: Model the firmware, from its sources, in the message handler and one interval** (started in the
  constructor, cleared in `close()`). Each rule names its source in a comment:
  - **Buffer** (`cable_client.c` `handle_agents_begin`, `handle_agent`, `handle_agents_end`): `agents.begin` empties
    the buffer and marks it building; `agent` appends while building, skipping a repeated id, at most 16; `agents.end`
    ends building and requests a reload.
  - **Applied a moment later** (`app_main.c` `refresh_task`, `cable_agent_snapshot` returns -1 while building): every
    `CAROUSEL_REFRESH_MS` the interval applies a requested reload whose buffer is not building, reading the buffer as
    it is then (a later `agents.begin` has replaced it).
  - **Add before remove, 16 tiles** (`refresh_projects`; `ui_habitat.c` `ensure`): add each buffered id not held while
    fewer than 16 tiles, else `refused += 1`; then walk the tiles from the end and remove each the buffer does not
    name, moving the face as `ui_project_remove` does (`if (active > i) active--; else if (active >= count) active =
    count - 1`, -1 when empty); then the buffer's order (`ui_project_apply_order`), the face kept by id.
  - **The pick landing** (`ui_apps_replace`, `ui_land_after_reload`): an `apps` frame sets the shown app and drops the
    landing when it names another; after an apply, a landing on the shown app puts the face on tile 0 (none when
    empty) and is used up.
  - **The held focus** (`ui_focus_project`, `ui_apply_pending_focus`): a `focus` for a held tile moves the face at once
    and clears the pending one; for a tile not held it is kept pending, and applied after the next apply that holds it.
  - Not modelled (none of the e2e needs it): voice's gate on the refresh, the session-down clear.
- [ ] **Step 2: Check nothing else changed.** It sends no new frame, so the files that use `FakeDial` behave as
  before: `cd cli && TMPDIR=/tmp npm run test:e2e -- e2e/dialOrcaFocus.e2e.ts e2e/dialAppFilterOnDial.e2e.ts` → PASS;
  `npm run typecheck` → clean.
- [ ] **Step 3: Commit** `test(cli): the fake dial models the firmware's carousel`.

---

### Task 4: End to end: Orca's ring over a full dial

**Files:**
- Create: `cli/e2e/dialOrcaFullRing.e2e.ts`

**Interfaces:**
- Consumes: Task 3's `FakeDial.carousel()` and `pick()`; Task 1's split line; Task 2's `pick · same` line;
  `IsolatedDaemon`, `until`, `CLI_ROOT`, `Desk`, `FakeOrca.install(d, { watchFocus: false })` and `layout`, `InOrca`;
  the `fresh` daemon of `dialOrcaFocus.e2e.ts` (`CABLE_DISABLE: 'false'`, `HARNESSD_TEST_DIAL_PORT` on a desk file,
  the dial plugged with `{ appFilter: 'v1' }`) and the one long-lived front watch of `dialStream.e2e.ts`
  (`harness hardware watch --json`, its stdin written one `{"front":…}` line at a time, `CLI_ENTRY` for the bundle).

- [ ] **Step 1: Write the test** (file comment: the spec, the incident, the route chosen and why — "Decisions made in
  this plan") `Orca's ring over a full ring of another app reaches the dial whole, with its first agent on the face`:
  1. The daemon, the fake `orca` without `watch-focus`, the dial plugged and its first list.
  2. The front watch says `com.github.wez.wezterm`. Sixteen sessions `new InOrca(d, `w${i}`, children, { WEZTERM_PANE:
     String(i + 1) })`, each `SessionStart` and listed.
  3. `until` the last `apps` says `shown: 'wezterm'` and `carousel()` holds those 16 ids; `refused` is 0.
  4. `orca.layout([[[o1.handle], [o2.handle]]])`; two Orca sessions (`ORCA_TERMINAL_HANDLE`, `__CFBundleIdentifier:
     'com.stablyai.orca'`), each `SessionStart`; `until` an `apps` frame counts `orca` 2 (they are not on the dial).
  5. `since = dial.messages.length`; the front watch says `com.stablyai.orca`.
  6. `until` (45 s, 50 ms) `carousel()` is `{ tiles: [o1.id, o2.id], active: o1.id, refused: 0 }`. The lists after
     `since` are `[[], [o1.id, o2.id]]`; a `focus` on `o1` comes after the second `agents.end`; the daemon log has
     `cable: agents split · 0 kept · 2 in ring` exactly once.
  7. `dial.pick('orca')` → `until` `[device] app filter: pick · same` is in the log; `carousel()` is unchanged.
  8. Privacy: every `agents split` line matches `/cable: agents split · \d+ kept · \d+ in ring$/`, every `pick ·` line
     `/\[device\] app filter: pick · (same|ignored)$/`; the log holds no session handle and no session id.
- [ ] **Step 2: Check it can fail** on the base session: `git checkout a59ba98a15 -- cli/src/cable/cableSession.ts`,
  run the file → it FAILS at step 6 (the carousel ends `{ tiles: [], active: null, refused: 2 }`, "Choose a pane");
  restore with `git checkout HEAD -- cli/src/cable/cableSession.ts` and check `git status` shows it clean.
- [ ] **Step 3: Run** `cd cli && TMPDIR=/tmp npm run test:e2e -- e2e/dialOrcaFullRing.e2e.ts` → PASS.
- [ ] **Step 4: Commit** `test(cli): Orca's ring over a full dial end to end`.

---

## Pull request

Besides the evidence `AGENTS.md` asks for (each task's red-then-green, the gates below), the body says:

- **Platforms:** macOS, Linux and Windows run the same `CableSession` and devices code; no platform branch. Tested on
  macOS locally and on Linux in the CLI end-to-end run. Harness Pro gets the same two steps (about a second on its rare
  large switch).
- **Known gap:** a dial whose session did not go down across a daemon restart can hold tiles the daemon does not know;
  not seen, left as it is (the spec).
- **Beyond the bug:** the `[device] app filter: pick · same|ignored` line (the PM's ask, 2026-11-20).
- **Out of scope:** `prompt · skipped · no tile` (a backlog item).

## Verification

1. **End to end, on this Mac** (macOS, Node 24 as `cli/` pins, Python 3 for the pseudo-terminal bridge):
   `cd cli && TMPDIR=/tmp npm run test:e2e -- e2e/dialOrcaFullRing.e2e.ts`, then the files whose session or fake dial
   changed under them: `e2e/dialOrcaFocus.e2e.ts e2e/dialStream.e2e.ts e2e/dialAppFilter.e2e.ts
   e2e/dialAppFilterOnDial.e2e.ts`, the same way. Isolation is the harness's own: each `IsolatedDaemon` has a
   throwaway root holding its home, data folder and a port of its own (never 18473); the dial is a fake on a
   pseudo-terminal found through `HARNESSD_TEST_DIAL_PORT`; `orca` is the fake first on the daemon's PATH; the
   sessions are hooks run under the daemon's environment; the front app is the real watch's stdin. No backend, no
   real Orca, WezTerm, dial, `~/.claude` or tmux server. A person sees the files pass.
2. **On GitHub, once, on the final head:** **Actions → CLI end to end → Run workflow** on
   `fix/dial-orca-pick-choose-pane` (`gh workflow run cli-e2e.yml --ref fix/dial-orca-pick-choose-pane`, no input
   ticked): the eight Linux shards run every e2e file, the new one included (it is not a dial-host file, so it is not
   excluded). `docs/validation-and-release.md` asks one run for a user-facing CLI flow; link it in the PR. No
   temporary workflow is needed.
3. **Local gates PR CI does not run:** `python3 scripts/local-checks.py --run` from a clean tree at the final commit
   (for these paths it runs `npm run test:core` in `cli/`: `src/services/devices.ts` at 100%); paste its fence into
   the PR body before the push. Also `cd cli && npm run typecheck` and `npx vitest run src/cable/cableSession.spec.ts
   src/cable/cableHost.spec.ts src/services/devices.spec.ts`.
4. **By hand after release, on Diego's own desk** (the user himself: his dial, his Orca, his login; optional, the PM
   asks him): with the released CLI, show a ring of 16 agents of one app on the round dial, bring Orca to the front with
   a worktree whose agents are not on the dial → the dial shows Orca's agent within about a second, never "Choose a
   pane"; the dial log has one `agents split` line. Nothing here touches production.

## The PM's answers (2026-11-20)

1. **A list longer than 16:** keep this plan's rule. Only the first `RING_PLACES` rows of a list count, and a dial that
   holds no tile never splits.
2. **Two ring changes inside one voice turn, with no split:** left as a known gap, named in the PR body.
3. **A voice the daemon refuses or drops** (`this.voice` clears while the dial still records, so the hold can end
   early): a known gap, named in the PR body.
4. `cli-e2e.yml` runs once, on the final head; its run link goes to the PM.
