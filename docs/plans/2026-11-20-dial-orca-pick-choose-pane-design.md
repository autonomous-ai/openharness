# A ring that replaces a full one reaches the dial whole

## The report

Diego, 2026-11-20 about 17:32 (UTC+7), CLI 0.6.78, round dial firmware 0.1.4, Harness Device 0.1.11: the dial shows
the Orca app with 11 agents, and tapping it in APPS opens "Choose a pane" instead of Orca's agents.

## What happened (logs, fixed words and counts only)

| Time (UTC+7) | Daemon (`harness.log`, dial log) | Dial (its own log lines) |
|---|---|---|
| 17:31:53 | `app filter: switched · front`, `cable: agents → 16 of 16` | `agents: 16` |
| 17:32:14 | `agents → 16 of 16` | `agents: 16` |
| 17:32:40 | `app filter: switched · front` (to Orca), `orca watch · unsupported`, `agents → 1 of 1` | `agents: 1`, then 16 × `reconcile: removing stale tile` |
| 17:32:46 | `app filter: picker`, no `switched · pick` | nothing |
| 17:32:47, 17:33:02 | `prompt · skipped · no tile` | |
| 17:33:10 | `app filter: picker`, no switch | nothing |
| 17:34:23 | `agents → 11 of 11` | `agents: 11` |

Orca's ring at 17:32:40 is the agents of the worktree on Orca's screen (`orca front · set · 4 terminals`, the scope of
docs/plans/2026-11-18-dial-orca-tab-scope-design.md): one agent. The APPS row counts every Orca agent: 11. That
difference is by design and is not this bug.

## Cause: the dial's carousel holds 16 and adds before it removes

- The round dial holds at most 16 tiles (`CABLE_MAX_AGENTS`, `cable_client.h`; the daemon's `RING_PLACES`).
- On each list, `refresh_projects` (`devices/harness-device/firmware/main/app_main.c`) first adds every agent of the
  list (`ui_project_set_name` → `ensure`), then removes the tiles the list no longer names. `ensure` refuses a new
  agent once 16 tiles are there (`s.count >= MAX_PROJECTS` returns -1).
- So a list pushed over a full carousel loses each agent the carousel does not already hold. At 17:32:40 the one Orca
  agent was refused, the 16 old tiles were removed, and the carousel was empty: `s.active = -1`, which the face draws as
  "Choose a pane" (`ui_habitat.c`, `caption`).
- The daemon does not know. Its `lastRing` is the list it sent (1 agent), so:
  - the #4452 landing does not run: it lands only when the ring before the push was empty (`heldNone`), and the daemon
    believed the dial held 16;
  - the next pushes of the same ring are skipped (`lastAgentsKey` unchanged), so the dial stays empty until the ring
    changes (17:34:23);
  - a pick of Orca, already shown, answers `same` and sends nothing (`app.pick`), by design (#4452, D2).
- The same loss happens on any push whose agents, together with the ones the dial holds, are more than 16: a switch
  from a full ring to any app, a window's tab, an app's ring growing past an old one. Only the new agents are lost;
  the face keeps an agent when some of the old ones stay.
- docs/plans/2026-11-18-dial-chatgpt-pick-and-voice-design.md says "a ring that replaces a non-empty one always leaves
  some agent on the face". That holds only while the old ring and the new one together fit in 16.

## The fix (PM, 2026-11-20: direction A, the daemon only)

Nothing in the core, nothing in the firmware: the change is in `CableSession` (`cli/src/cable/cableSession.ts`), in the
devices process. It reaches every dial already shipped (firmware 0.1.x) with a CLI update.

### 1. A push that would overflow the dial goes in two steps

In `syncAgentsNow`, before the ring goes down the cable:

- **Overflow** is when the agents of the new ring together with those of `lastRing` (the ring the dial holds) are more
  than `RING_PLACES`, counted by id: `|lastRing ∪ agents| > RING_PLACES`. It is checked on every ring push: a machine
  list or a window's tab, forced or not.
- Then the push sends **step 1**: the new ring's agents that `lastRing` already holds, in the new ring's order (none
  when they share no agent). Every agent it names is already a tile, so the firmware adds nothing and removes the
  others: the carousel ends holding exactly step 1. `lastRing` and `lastAgentsKey` become step 1's, so the next read
  sees the full ring as a change. The session notes when step 1 went (`splitAt`, a new field, by `performance.now()`).
- **Step 2** is the full ring, sent by the next push that reads it, under one hold: **for `AGENTS_PUSH_GAP_MS` (1 s)
  after step 1, a list that names an agent outside `lastRing` is held**, forced or not, machine list or tab. A held
  push returns as the existing gap does, sending nothing (not even its `apps` frame), and the session's 1 s tick sends
  it once the hold is over: no new timer. A list that names only agents the dial holds (a shrink, another split's
  step 1) is never held. Why the hold: the firmware applies a list on its refresh task, woken by the list's
  `agents.end` (`app_main.c` `refresh_task`), and `agents.begin` empties the cable client's buffer
  (`cable_client.c` `handle_agents_begin`), so a full ring that arrives before step 1 is applied replaces it there and
  the carousel would see the full ring over the old one and lose it again.
- **Voice.** The firmware applies no list while its voice upload runs (`app_main.c`, `audio_client_active()`), so the
  hold also lasts while the dial's voice is open (`this.voice` set, `voice.begin` to its end or abort) and for 1 s after
  it closes.
- **The hold ends early** when the dial is known to hold none: a port open or close (which empties `lastRing`, as
  today) and the dial's own `agents.list` clear `splitAt`.
- Step 2 never overflows: the dial then holds only agents of the new ring, and the ring is at most `RING_PLACES`.
- A pick (`app.pick` → `switched`) whose forced push splits sends step 1 at once and step 2 on the tick: the force is
  not kept, and none is needed, since the full ring's key differs from step 1's.

### 2. The face lands on an agent after the two steps

- Step 1 not empty: the face keeps its agent if it stayed, or the firmware moves it to a neighbour, as with any ring
  today. After a pick, the firmware's own landing (`app_landing`, `ui_land_after_reload`) runs on step 1, the list that
  follows the `apps` frame naming the picked app, so the face ends on step 1's first agent: an agent of the new ring.
  The re-assert of the focus record after `agents.end` runs as today, for a record in step 1.
- Step 1 empty: the dial holds none, so step 2 is a push after an empty ring (`heldNone`) and the #4452 landing puts
  the ring's first agent on the face, or re-asserts the record when the ring holds it. A follow in flight
  (`appFocusUnsent`) still lands nothing first, as today.
- Between the steps (about 1 s) the dial shows step 1's tiles, or its empty page when step 1 is empty, and the host is
  told the shown agent step 1 leaves the dial on (`reportShown`), "none" when it holds none.
- A follow in that second still lands: `follow` sends its `focus` after its push, the firmware holds a focus for a tile
  it does not have yet and applies it after the next list (`app_main.c`, `ui_apply_pending_focus`), and step 2
  re-asserts the record. Only `followApp` with no window tab reads `lastRing` for a tile, and finds none for an agent
  outside step 1, as for any agent off the ring.

### 3. Fixed-word lines

- The dial log (`this.log`), once per split, before step 1's usual `cable: agents → <kept> of <total>`:
  `cable: agents split · <kept> kept · <n> in ring`, where `<kept>` is step 1's count and `<n>` the full ring's. Counts
  only, never an id or a name.
- The devices log, for a pick on the dial that switches nothing (the PM's ask, 2026-11-20: a fixed-word reason when a
  pick yields no ring): `[device] app filter: pick · same` when the app is already shown, `[device] app filter: pick ·
  ignored` when the host did not take it (no agents for that app, or on the window's tab a pick of Harness or one the
  filter cannot hold). `appPicked` keeps its place before the pick, so `picker` still comes before `switched · pick`;
  the outcome comes through one new optional wiring member called after the pick only for those two answers
  (`CableHostWiring`, `cableHost.ts` `pickApp`), logged in `services/devices.ts`. A pick that answers `switched` or
  `tabs` logs nothing new. This line is beyond the bug itself; the PR says so.

### Known gap

The daemon takes the dial's list as empty after a port open and after `agents.list`, as today. A dial whose session did
not go down across a daemon restart (the firmware forgets its agents on `session_down`, and asks `agents.list` at each
session up) could hold tiles the daemon does not know; that case was not seen and is left as it is. Two more gaps,
named in the PR body (PM, 2026-11-20): two ring changes inside one voice turn with no split (the firmware applies
neither until the voice ends, so the second can overflow the carousel against the ring before the first), and a voice
the daemon refuses or drops, which clears `this.voice` while the dial still records and can end the hold early.

Overflow counts only the first `RING_PLACES` rows of a list, all the firmware's buffer keeps, and a dial that holds no
tile never splits (PM, 2026-11-20): a window's tab of 20 agents would otherwise split again at every step 2.

## Platforms

`CableSession` runs the same on macOS, Linux and Windows (Windows reaches the dial through `harness-serial.exe`, the
session code is shared). No platform branch.

Harness Pro speaks the same session and holds up to 32 agents (`POD_AGENTS_MAX`); its ring is bounded at 16 by the
daemon, so its own carousel never overflows. It gets the same two steps when the union passes 16: one way for every
dial, at the cost of about a second on a Pro's rare large switch.

## Tests

- **Unit, red first** (`cli/src/cable/cableSession.spec.ts`):
  - a dial holding 16 agents is pushed a ring that shares none: step 1 is an empty ring, step 2 (after the gap) the full
    ring, followed by a `focus` for its first agent;
  - a ring that shares some agents with a full one: step 1 is the shared agents in the new order; step 2 the full ring;
    the record, in step 1, is re-asserted after step 1;
  - a forced push (a pick's `switched`) and a window tab's list that overflow still wait the hold for step 2; a list
    that names only held agents is not held;
  - the hold lasts while voice is open and 1 s after it closes; a port open and `agents.list` end it;
  - a push whose union fits in 16 goes in one step, as today;
  - the split line is logged once, with counts only.
- **Unit** (`cli/src/services/devices.spec.ts` or the host's spec): a pick of the shown app logs `pick · same`; a pick of
  an app with no agents logs `pick · ignored`.
- **End to end** (`cli/e2e/`, the `dialOrca*` style): a fake dial whose carousel behaves as the firmware's (the list
  buffered from `agents.begin` to `agents.end`, applied a moment later, 16 tiles, adds before it removes, the face index
  as `ui_project_remove` moves it, the pick landing and the held focus) and a fake Orca. The dial holds a
  full ring of another app; Orca comes to the front with one agent in the worktree on its screen; the fake dial ends
  holding that agent with it on the face. `FakeDial` (`cli/e2e/harness/fakeDial.ts`) is extended faithfully to model
  the carousel; never Diego's Orca, never the developer's daemon. Waits poll as the harness's `next()` does, never
  sleep.

## Out of scope

- The firmware's own order (remove, then add): direction B, not taken (PM).
- `prompt · skipped · no tile` at 17:32:47 and 17:33:02 (an agent typed into on Orca's screen not in the scoped ring):
  a separate backlog item (PM).
