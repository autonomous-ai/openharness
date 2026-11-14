# The round dial's swipe order, a fixed ring: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. Tasks 1 and 2 are test-first: a red commit
> (the tests alone), then the code commit. Task 3 changes a document and is one commit. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** With no Harness window, a swipe on the round dial always lands on the same neighbour: this computer's agents
sit in a fixed ring of at most 16, and a state change moves nobody.

**Architecture:** `selectForDial` (a sort on every read) becomes `DialRing`, a small class with memory in
`cli/src/cable/hosts/select.ts`: the ordered ids in the ring and the ids it saw on its last pass. `DaemonCableHost`
holds one ring and reads it in `machineSnapshot`, where `selectForDial` is called today. Nothing else changes: the
session still pushes the list only when its rows differ (`agentsKey`), so a fixed order pushes only when an agent
enters or leaves. No firmware change, nothing stored, nothing in the daemon core.

**Tech Stack:** TypeScript, Vitest 4, Node (v22.21.1 on this Mac). No new dependency.

**Spec:** [docs/plans/2026-11-14-dial-swipe-order-design.md](2026-11-14-dial-swipe-order-design.md). Read it with this
plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority. It updates
[docs/specs/2026-11-13-device-without-the-app.md](../specs/2026-11-13-device-without-the-app.md).

## Start gate: pull request #4296

Nothing in this plan starts before pull request #4296 (`feat/device-claude-orca`) is merged. The orchestrator then
rebases `fix/dial-swipe-order` on the `main` that holds it, and phase 3 starts from that base.

- At its head `9eed162bbb` (2026-11-14) #4296 changes `cableHost.ts` (+53 −6), `cableHost.spec.ts` (+167 −1),
  `services/devices.ts` (+99 −11), `services/devices.spec.ts` (+275 −3) and `e2e/deviceWithoutApp.e2e.ts` (+1 −5).
  It does not change `hosts/select.ts` or `hosts/select.spec.ts`. The gate still covers all of them, as decided.
- In `cableHost.ts` it adds `outsideEntry`, `machineView`, `setApprovals` and the paths that let an agent outside
  Harness take voice, a tap and an approval. It does not touch `machineSnapshot`, the `selectForDial` import or its
  call. None of the tests it adds asserts the machine list's order (one reads a row with `.find`).
- So this plan names functions and test names, never line numbers: every file is read again at the rebased base. If
  #4296 lands with a change to `machineSnapshot` or to a test this plan edits, the task follows the merged code: the
  ring takes exactly the list `selectForDial` took.
- **#4296's scope changed** (the PM, 2026-11-14): the dial no longer gets an "Allow Bash?" card. An agent waiting for
  a permission has only the activity line "<command> · answer in {Host}", and it needs the person: for the ring it is
  `needs-you` as any other, and nothing in this plan behaves differently for it. At `9eed162bbb` the pull request
  still carries the card and has no such line, so this is written as the PM states it. **Before Task 1's first
  commit, its implementer checks it against the merged code** at the rebased base:

  ```bash
  grep -rn "answer in" cli/src/cable cli/src/services --include='*.ts' | grep -v "did not answer"
  ```

  To find: the line an agent waiting for a permission shows, and that such an agent's `HostAgent.state` is
  `'needs-you'`. If its state is another one, or a field the ring does not read, stop and report before any commit:
  rule 4 turns on it. If only the words differ, the merged words stand wherever this plan quotes the line (Global
  Constraints, Verification check 4), and the task's report says so.

## Global Constraints

- The ring is the machine list only (no Harness window). With a window the dial holds the active tab's panes in tile
  order, as today, and the ring is not read.
- 16 places: the firmware's `CABLE_MAX_AGENTS` (`devices/harness-device/firmware/main/cable_client.h`). No
  parameter, option or setting for it.
- The rules, from the spec, by their numbers there: (1) an agent keeps its place from when it enters, a new agent
  enters at the end, a leaving agent closes up; (3) an agent stays until its source stops listing it; (4) full ring:
  an outside agent enters only if new (never seen) or it needs the person, it takes the place of the ring agent idle
  the longest (the oldest `lastActivityAt` among the ring agents that are idle), and goes to the end; an agent that
  works or needs the person is never replaced; no ring agent idle: the newcomer waits outside; (5) a free place goes
  to needs-you first, then the most recent activity, at the end; (7) the first ring is the registry's order, cut at
  16 by rule 5; (8) several in one pass enter needs-you first, then by most recent activity; an agent that entered in
  this pass is not replaced in the same pass, so at most 16 enter; those entering together go to the end in the
  registry's order; one that found no place counts as seen, and enters later only through a free place or when it
  needs the person.
- **Idle** (Diego's "nghỉ") is a `HostAgent.state` that is neither `'working'` nor `'needs-you'`: `'idle'`, `'done'`
  (its answer seen or not) and `'error'`.
- Ties, which the spec does not name and this plan fixes: equal `lastActivityAt` among ring agents, the place
  nearest the front goes; equal standing among outside agents, the registry's order decides.
- The Buddy filter and the wait for the Swarm cards stay in `machineSnapshot`, before the ring: an agent they hide
  is, for the ring, not listed. It leaves, and joins again at the end. (Superseded: main removed both with the Swarm,
  #4303, 2026-11-14; on rebase the ring takes the registry's list unfiltered, and the "until the cards come" test
  goes with them.)
- `total` stays the count of the list the ring is given (every agent on this computer).
- In memory only, one ring per `DaemonCableHost`. No file, no setting, no timer, no I/O in `select.ts`.
- Not touched: the firmware (`devices/harness-device/**`), `devices/harness-pro/**` (never), `cableSession.ts` (the
  1 s coalescing and `agentsKey` stay), anything under `cli/src/core/`, `cli/src/architecture.coreFiles.txt`
  (`select.ts` loads in the devices process only). No app filter (hold to pick an app): a separate work item.
- No new copy, no new UI. Needs-you still reaches the dial as the activity line ("Waiting for you · {Host}"; for an
  agent waiting for a permission, after #4296, "<command> · answer in {Host}"), the notification and the bell.
- `selectForDial` leaves in the same pull request as its replacement (Task 2), with its tests and the two comments
  that say ten.
- Tests never use the developer's daemon (port 18473), `~/.harness`, `~/.claude`, `~/.codex` or tmux server
  (`cli/AGENTS.md` rule 6). No fixed sleeps in a test.
- Comments say why, in plain sentences. A commit adds its files by name. The two documents under `docs/plans/` are
  untracked here and are no task's.
- This checkout has `cli/node_modules`. A task run in another checkout installs once first:
  `cd cli && npm ci --no-audit --no-fund`.
- Platforms: the daemon on macOS, Linux and Windows (plain TypeScript, no platform branch); the round dial. One pull
  request; its body names them and carries each task's red and green output, the push numbers before and after, and
  the Verification results. No dial serial number or MAC address in it.

## Found while reading the code

Checked at `92aa7660f4` and against #4296's diff at `9eed162bbb`.

- **One caller.** `selectForDial` is called once, in `DaemonCableHost.machineSnapshot`, on the registry's agents
  after the Buddy filter and the cards wait (both gone with the Swarm, #4303). Its default `max` is 10.
- **Read several times a second.** `listAgentSnapshot()` is read by each dial session's tick (every second), by
  `listAgents()` (a name lookup, voice routing, the next-agent walk) and by `devices.ts` `remind`. So
  `DialRing.select` runs often and must change nothing on a list that did not change.
- **The rows carry no state.** `CableSession.agentsKey` reads id, name, engine, model, effort, machineId, machine,
  host and caps. Equal rows in equal order are not pushed. A new name, host or caps still pushes, as today.
- **The rows must be the objects the ring was given.** `machineSnapshot` looks up each row's source in a map keyed
  by the agent object (`sourceOf.get(a)!`). Task 1 pins it.
- **Tests that pin the old order or the ten:** `select.spec.ts` (all of it); `cableHost.spec.ts` "no window and a
  registry: the selected rows…" (expects `o1, h2, h1`) and "…until the cards a dial asked for come…" (expects
  `h1, h2, o1` after the wait; deleted with the Swarm, #4303); `devices.spec.ts` "reminds only the observed agents
  the dial lists, never all fifty" (expects 10 of 12). `cableSession.spec.ts` has its own fake host and does not
  change. No end-to-end test asserts the order or the ten.
- **Comments that say ten:** the doc comment above `listAgents` in `cableHost.ts` ("at most ten, the ones that need
  the person first") and `remind` in `devices.ts` ("ten at most of the fifty").
- **The firmware holds 16.** `#define CABLE_MAX_AGENTS 16`; its arrays are allocated at that size at start; a row
  past 16 is dropped in `handle_agent`.
- **Today's push rate, measured** with the Verification script (check 4) and the suite's fake dial, this Mac at load
  33, `92aa7660f4`: the list is `10 of 16`, and it was pushed 41 times in 3.2 minutes, 769 an hour. With the ring the
  script moves nobody in or out: 0 is expected, and 0 is what the rehearsal below counted.
- **A real dial on an isolated daemon** (how #4290's dial check ran): `HARNESSD_TEST_DIAL_PORT=<port path>` makes
  that path the only port the daemon looks at (`cableFleet.ts` `testDialDiscovery`), under the id `E2E-DIAL`. A port
  another program holds is left alone (`portInUse`, and the open takes an exclusive lock). The suite's daemon never
  offers firmware (`CABLE_FW_DISABLE=true`), is signed out and reaches no backend. Its scan of open sessions listed
  only its own 16 on this Mac, with other Claude Code sessions running here.
- **What holds the dial, and what starts Diego's daemon again** (check 4a). His everyday daemon holds the dial's
  port while it runs. `harness stop` stops it (through launchd when he opted in with `harness service install`:
  `cli/src/lib/platformDaemon.ts`). On macOS a stop is not remembered, and two apps start the daemon again: the
  desktop app's supervisor, and, when the desktop app is not running, the Harness Device app's keep-alive, within
  about a minute (`device-app/src-tauri/src/keepalive.rs`: two looks that find it down, then `harness start --if-down`
  in seconds :10 to :20). Their bundle ids are `ai.autonomous.harness` and `ai.autonomous.harness.device`. So both
  are quit, by Diego, before the stop.
- **Pets** (check 4a). A daemon keeps them in `<home>/.harness/devices/pets` (`HARNESS_DEVICES_DIR`'s default,
  `cli/src/config/env.ts`; `PetStore`): the packs, their sources and `pets.json`. The isolated daemon's home is
  inside its throwaway root, so a copy there is what it reads. With the same folder `planPetSync` sends and drops
  nothing; a pack sent to the dial logs `cable: offering pet`.
- **Rehearsed**, then removed each time: a throwaway `DialRing` written from Task 1's seven steps and wired as Task 2
  says. With the answers folded in (2026-11-14, `92aa7660f4`): Task 1's 17 cases fail first and pass with the ring;
  with the earlier rule (a working agent may be replaced) the two cases that pin Diego's answer fail;
  `npx vitest run src/cable src/services/devices.spec.ts src/services/devicesProcess.spec.ts` passes (42 files, Task
  2's cases among them); the workload script, with the fake dial and a stand-in pet folder, lists `16 of 16` and
  counts `list pushes: 0` in 1.2 minutes. Before the answers, with the earlier ring: `e2e/deviceWithoutApp.e2e.ts`
  passed 9 of 9, the new case four times in a row (it holds three agents and never a full ring, so the answers do
  not reach it). Without a ring, every test this plan adds or changes fails as the tasks say.
- **Local gate.** `scripts/local-checks.py` maps `cli/src/services/*` to `cli-core` (`npm run test:core`), and
  `process-checks` refuses the pull request without its receipt. Nothing here matches `cli-serial` or `cli-pty`.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/src/cable/hosts/select.ts` | new: `RING_PLACES`, `DialRing` | 1 |
| `cli/src/cable/hosts/select.spec.ts` | new `describe('DialRing')` | 1 |
| `cli/src/cable/cableHost.ts` | the `ring` field; `machineSnapshot` reads it; two comments | 2 |
| `cli/src/cable/hosts/select.ts` | `selectForDial` and `group` deleted | 2 |
| `cli/src/cable/hosts/select.spec.ts` | `describe('selectForDial')` deleted | 2 |
| `cli/src/cable/cableHost.spec.ts` | one case's expectation; three new cases | 2 |
| `cli/src/services/devices.ts` | one comment in `remind` | 2 |
| `cli/src/services/devices.spec.ts` | "reminds only the observed agents…": 18 sessions, 16 listed | 2 |
| `cli/e2e/deviceWithoutApp.e2e.ts` | one new case | 2 |
| `docs/specs/2026-11-13-device-without-the-app.md` | the Order and How many bullets; three more lines that state the old rule | 3 |

## Review Focus

Each line is pinned by a test in the task named.

- **A burst from outside in one pass** (the attach scan, up to 50 sessions with one timestamp): the ring changes
  once, one that needs the person gets in first, every ring agent that needs the person stays, and the next pass
  moves nobody. Task 1, "more new agents than places in one pass".
- **A long silent turn** (a ring agent mid-turn whose last activity is the oldest of all): it keeps its place; the
  one idle the longest goes. Task 1, "a working ring agent is never replaced…".
- **Everyone busy** (all 16 work or wait on the person, and another agent starts): it waits outside, the ring does
  not move, and it pushes nobody out a second later when one of them goes idle. Task 1, "no ring agent is idle…".
- **The same list read again and again** (each dial's tick, the reminders, voice routing): a pass over an unchanged
  list changes nothing. Task 1, "more new agents than places in one pass"; Task 2, "a state change moves no agent".
- **A window opened and shut.** The ring is not read while the tab is held: it comes back as it was, what started
  meanwhile last. Task 2, "a window opened and shut leaves the ring as it was".
- **No filter before the ring.** Main removed the Buddy filter and the cards wait with the Swarm (#4303): the ring
  takes every agent the registry lists, in its order. Task 2, "no window and a registry: the rows of the ring…".
- **Equal activity times** (the scan stamps every session it finds with one time): which agent goes and which
  enters is the same on every run. Task 1, "equal activity".
- **An id that goes and comes back** (a resumed session): it is new again and enters at the end, and the set of seen
  ids holds only what the last pass listed. Task 1, "an id is forgotten once its source stops listing it".

---

### Task 1: `DialRing`

**Depends on:** nothing (the start gate above). **Effort:** high.

**Files:**
- Modify: `cli/src/cable/hosts/select.ts`
- Test: `cli/src/cable/hosts/select.spec.ts`

**The test that fails before the change:** every case of `describe('DialRing')` in
`cli/src/cable/hosts/select.spec.ts`: `select.ts` exports no `DialRing`.

**Interfaces:**
- Produces, from `cli/src/cable/hosts/select.ts`:
  - `export const RING_PLACES = 16`
  - `export class DialRing { select(agents: HostAgent[]): { rows: HostAgent[]; total: number } }`, with no
    constructor argument. `rows` are the ring's agents in ring order, each the very object `agents` held; `total` is
    `agents.length`.
- `selectForDial` and its tests stay in this task: `cableHost.ts` still calls it. Task 2 removes them.

- [ ] **Step 1: The ring's tests**

Add to `select.spec.ts`: `DialRing` and `RING_PLACES` to the import, and below the `selectForDial` block:

```ts
/** `a1`…`an` (or from another number): each one's last activity is its number, so a1 is idle the longest. */
const row = (n: number, prefix = 'a', from = 1): HostAgent[] =>
  Array.from({ length: n }, (_, i) => agent(`${prefix}${from + i}`, { lastActivityAt: from + i }))
const needs = (a: HostAgent): HostAgent => ({ ...a, state: 'needs-you' })
const working = (a: HostAgent): HostAgent => ({ ...a, state: 'working' })

describe('DialRing', () => {
  it('an agent keeps its place whatever its state and activity do', () => {
    const ring = new DialRing()
    const [a, b, c, d] = row(4)
    expect(ids(ring.select([a, b, c, d]).rows)).toEqual(['a1', 'a2', 'a3', 'a4'])
    // What used to move an agent: a question, a turn, an answer not yet seen, fresh activity. And the registry's order.
    const moved: HostAgent[] = [{ ...working(d), lastActivityAt: 99 }, { ...c, state: 'done', unseenDone: true }, needs(b), a]
    const again = ring.select(moved)
    expect(ids(again.rows)).toEqual(['a1', 'a2', 'a3', 'a4'])
    // The rows are this pass's own objects: the host reads each one's source by it.
    expect(again.rows[1]).toBe(moved[2])
  })

  it('a new agent enters at the end', () => {
    const ring = new DialRing()
    ring.select(row(2))
    expect(ids(ring.select([agent('n', { lastActivityAt: 99 }), ...row(2)]).rows)).toEqual(['a1', 'a2', 'n'])
  })

  it('an agent that ends leaves and the others close up; under a new id it is a new agent', () => {
    const ring = new DialRing()
    const [a, b, c, d] = row(4)
    ring.select([a, b, c, d])
    expect(ids(ring.select([a, c, d]).rows)).toEqual(['a1', 'a3', 'a4'])
    expect(ids(ring.select([a, agent('a3b'), d]).rows)).toEqual(['a1', 'a4', 'a3b'])
  })

  it('sixteen places, the firmware\'s; total is every agent', () => {
    expect(RING_PLACES).toBe(16)
    const first = new DialRing().select(row(20))
    expect(first.rows).toHaveLength(16)
    expect(first.total).toBe(20)
  })

  it('the first ring: the registry\'s order, cut to those that need the person, then the most recent activity', () => {
    const list = row(18)
    list[0] = needs(list[0])
    // a1 is idle the longest and waits on the person: it stays. a2 and a3 are cut.
    expect(ids(new DialRing().select(list).rows)).toEqual(['a1', ...ids(row(15, 'a', 4))])
  })

  it('a full ring: a new agent takes the place of the one idle the longest, and goes to the end', () => {
    const ring = new DialRing()
    const held = row(16)
    ring.select(held)
    const next = ring.select([...held, agent('n')])
    expect(ids(next.rows)).toEqual([...ids(row(15, 'a', 2)), 'n'])
    expect(next.total).toBe(17)
  })

  it('a full ring: an agent seen before stays outside until it needs the person', () => {
    const ring = new DialRing()
    const list = row(17)
    ring.select(list)
    const inRing = ids(row(16, 'a', 2))
    const withFirst = (a1: HostAgent): HostAgent[] => [a1, ...list.slice(1)]
    expect(ids(ring.select(withFirst({ ...working(list[0]), lastActivityAt: 999 })).rows)).toEqual(inRing)
    expect(ids(ring.select(withFirst({ ...list[0], state: 'done', unseenDone: true, lastActivityAt: 999 })).rows)).toEqual(inRing)
    expect(ids(ring.select(withFirst(needs(list[0]))).rows)).toEqual([...ids(row(15, 'a', 3)), 'a1'])
  })

  it('a ring agent that needs the person is never replaced', () => {
    const ring = new DialRing()
    const held = row(16)
    held[0] = needs(held[0])
    ring.select(held)
    expect(ids(ring.select([...held, agent('n')]).rows)).toEqual(['a1', ...ids(row(14, 'a', 3)), 'n'])
  })

  it('a working ring agent is never replaced, however long it has been silent; an answer not yet seen is idle', () => {
    const ring = new DialRing()
    const held = row(16)
    held[0] = working(held[0])
    held[1] = { ...held[1], state: 'done', unseenDone: true }
    ring.select(held)
    // a1 has the oldest activity of all and is mid-turn: it stays. a2, done, is the one idle the longest.
    expect(ids(ring.select([...held, agent('n')]).rows)).toEqual(['a1', ...ids(row(14, 'a', 3)), 'n'])
  })

  it('no ring agent is idle: a newcomer waits outside, and is no longer new', () => {
    const ring = new DialRing()
    const held = row(16).map((a, i) => (i % 2 ? needs(a) : working(a)))
    ring.select(held)
    const n = agent('n', { lastActivityAt: 99 })
    expect(ids(ring.select([...held, n]).rows)).toEqual(ids(held))
    // One that needs the person waits too: nobody in the ring may go.
    expect(ids(ring.select([...held, needs(n)]).rows)).toEqual(ids(held))
    // a5's turn ended. The newcomer has been seen: being there takes no place.
    const rested = held.map((a): HostAgent => (a.id === 'a5' ? { ...a, state: 'done' } : a))
    expect(ids(ring.select([...rested, n]).rows)).toEqual(ids(held))
    // Once it needs the person it takes the one place that may go.
    expect(ids(ring.select([...rested, needs(n)]).rows)).toEqual([...ids(held).filter((id) => id !== 'a5'), 'n'])
  })

  it('a free place goes to one that needs the person, before the most recent activity', () => {
    const ring = new DialRing()
    const list = row(19)
    ring.select(list)
    // a1, a2 and a3 were cut. a16 ends as a1 starts to wait: a1 takes its place, and nobody is replaced for it.
    const next = list.filter((a) => a.id !== 'a16').map((a) => (a.id === 'a1' ? needs(a) : a))
    expect(ids(ring.select(next).rows)).toEqual([...ids(row(12, 'a', 4)), 'a17', 'a18', 'a19', 'a1'])
  })

  it('with nobody waiting, a free place goes to the most recent activity', () => {
    const ring = new DialRing()
    const list = row(19)
    ring.select(list)
    expect(ids(ring.select(list.filter((a) => a.id !== 'a16')).rows)).toEqual([...ids(row(12, 'a', 4)), 'a17', 'a18', 'a19', 'a3'])
  })

  it('an id is forgotten once its source stops listing it: back again, it is new', () => {
    const ring = new DialRing()
    const list = row(17)
    ring.select(list)
    ring.select(list.slice(1))
    expect(ids(ring.select(list).rows)).toEqual([...ids(row(15, 'a', 3)), 'a1'])
  })

  it('several enter in one pass: they go to the end in the registry\'s order', () => {
    const ring = new DialRing()
    const [a, b] = row(2)
    ring.select([a, b])
    const pass = [agent('x', { lastActivityAt: 1 }), a, needs(agent('y')), b, agent('z', { lastActivityAt: 9 })]
    expect(ids(ring.select(pass).rows)).toEqual(['a1', 'a2', 'x', 'y', 'z'])
  })

  it('more new agents than places in one pass: the ring changes once, and no further on the next pass', () => {
    const ring = new DialRing()
    const held = row(16)
    held[0] = needs(held[0])
    ring.select(held)
    // Twenty sessions a scan found together. Fifteen places may go: the one that needs the person takes the first,
    // old as its activity is, and the fourteen most recent the rest. Nobody that entered is replaced; a1 still waits.
    const scan = row(20, 's', 101)
    scan[0] = needs(scan[0])
    const after = ['a1', 's101', ...ids(row(14, 's', 107))]
    expect(ids(ring.select([...held, ...scan]).rows)).toEqual(after)
    // s102 to s106 found no place and are no longer new: the same list again moves nobody.
    expect(ids(ring.select([...held, ...scan]).rows)).toEqual(after)
  })

  it('equal activity: the place nearest the front goes, and the registry\'s order says who enters', () => {
    const level = (list: HostAgent[]): HostAgent[] => list.map((a) => ({ ...a, lastActivityAt: 5 }))
    const ring = new DialRing()
    const held = level(row(16))
    ring.select(held)
    expect(ids(ring.select([...held, agent('n')]).rows)).toEqual([...ids(held).slice(1), 'n'])
    expect(ids(new DialRing().select(level(row(18))).rows)).toEqual(ids(row(16)))
  })

  it('an empty list, and an input left as it was', () => {
    expect(new DialRing().select([])).toEqual({ rows: [], total: 0 })
    const input = [agent('b', { lastActivityAt: 1 }), agent('a', { lastActivityAt: 2 })]
    new DialRing().select(input)
    expect(ids(input)).toEqual(['b', 'a'])
  })
})
```

- [ ] **Step 2: See them fail**

Run: `cd cli && npx vitest run src/cable/hosts/select.spec.ts`
Expected, as seen at `92aa7660f4` (2026-11-14): `Tests 17 failed | 6 passed (23)`. Every `DialRing` case fails with
`TypeError: DialRing is not a constructor` (the sixteen-places case on `RING_PLACES`); the six `selectForDial` cases
pass.

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/src/cable/hosts/select.spec.ts
git commit -m "devices: the dial's ring keeps every agent's place (tests)"
```

- [ ] **Step 4: `DialRing` in `select.ts`**

Add `RING_PLACES` and `DialRing` with the signature above. Two private fields: the ring's ids in order (at most 16),
and the set of ids the last pass listed. One pass of `select(agents)`:

1. **Leave.** A ring id that `agents` does not hold leaves; the rest keep their order. Call what is left `before`.
2. **Outside.** The agents not in the ring, ordered by need: `needs-you` first, then `lastActivityAt` descending,
   then their order in `agents`.
3. **Free places.** While the ring holds fewer than 16, the next of them enters.
4. **Full ring.** Each one left that is new (its id is not in the seen set) or needs the person takes the place of
   the idle agent of `before` still in the ring with the oldest `lastActivityAt`; equal, the one nearest the front.
   Idle: its state is neither `working` nor `needs-you`. That agent leaves. An agent that entered in this pass is
   not of `before`, so it is never the one to go. When no agent of `before` still in the ring is idle, the rest wait
   outside.
5. **At the end.** The agents that entered in this pass are appended in the order `agents` lists them.
6. **Seen.** The seen set becomes the ids of `agents`: one that found no place is no longer new, and an id its
   source no longer lists is forgotten.
7. `rows` are the ring's agents, each the object from `agents`; `total` is `agents.length`. `agents` is not changed.

The comment above the class says why in plain sentences: the old list was sorted again on every change (65 pushes in
one hour of Diego's log, 2026-11-14), so the agent a swipe landed on changed under the finger; the firmware keeps the
agent on screen by its id and walks the list it holds, so a fixed list is a fixed ring. Only an idle agent gives up
its place (Diego, 2026-11-14): one that works or waits on the person is one the person is following. `RING_PLACES`
names the firmware's `CABLE_MAX_AGENTS`.

- [ ] **Step 5: Run the checks**

```bash
cd cli
npx vitest run src/cable/hosts/select.spec.ts    # every case passes, selectForDial's six among them
npm run typecheck                                # no error, about a minute
```

- [ ] **Step 6: Commit**

```bash
git add cli/src/cable/hosts/select.ts
git commit -m "devices: the dial's ring, sixteen fixed places for this computer's agents"
```

---

### Task 2: The machine list reads the ring

**Depends on:** Task 1. **Effort:** high.

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (the import of `select.js`; a `ring` field beside `registry`;
  `machineSnapshot`; the doc comment above `listAgents`; the comment above `machineSnapshot`)
- Modify: `cli/src/cable/hosts/select.ts` (delete `selectForDial` and `group`)
- Modify: `cli/src/services/devices.ts` (the comment above `remind`)
- Test: `cli/src/cable/cableHost.spec.ts`, `cli/src/cable/hosts/select.spec.ts` (delete the `selectForDial` block),
  `cli/src/services/devices.spec.ts`, `cli/e2e/deviceWithoutApp.e2e.ts`

**The tests that fail before the change:** in `cli/src/cable/cableHost.spec.ts`, inside
`describe('the dial with no window: this computer's agents')`: the changed case and the three new ones below;
in `cli/src/services/devices.spec.ts`, "reminds only the observed agents the dial lists, never all fifty"; in
`cli/e2e/deviceWithoutApp.e2e.ts`, "the machine list keeps its order while an agent works, and a new agent comes
last".

**Interfaces:**
- Consumes: `DialRing` from Task 1.
- Produces: `listAgentSnapshot()` with no window and a registry returns the ring's rows (at most 16) with `host`,
  `caps`, `view: 'machine'` and `total`, in the same shape as today. With a window: unchanged.

- [ ] **Step 1: `cableHost.spec.ts`**

One case changes its expectation. "no window and a registry: the selected rows with host and caps, and view
machine" is renamed "no window and a registry: the rows of the ring with host and caps, and view machine", and
expects:

```ts
    // In the registry's order: o1 waits on the person and h2 is mid-turn, and neither moves ahead.
    expect(await host.listAgentSnapshot()).toEqual({ tab: '', total: 3, view: 'machine', agents: [
      { id: 'h1', name: 'h1', engine: 'claude', ...local, host: 'harness', caps: 'sva' },
      { id: 'h2', name: 'h2', engine: 'codex', ...local, host: 'harness', caps: 'sva' },
      { id: 'o1', name: 'scratch', engine: 'claude', ...local, host: 'ghostty', caps: 's' },
    ] })
```

(A second case, "no window: until the cards a dial asked for come…", changed here before the rebase. Main deleted
it with the Swarm, #4303, and nothing replaces it.)

Three new cases, in the same `describe`:

```ts
  it('no window: a state change moves no agent, so the list the dial holds is not sent again', async () => {
    const host = new DaemonCableHost(wiring({ sessions }), fleetOf([]))
    const o1 = observedAgent({ id: 'o1', lastActivityAt: 10 })
    host.setRegistry(new HostRegistry([host.harness, observed([o1])]))
    host.setSwarms(null)
    const before = await host.listAgentSnapshot()
    expect(before.agents.map((a) => a.id)).toEqual(['h1', 'h2', 'o1'])
    // Each of these moved its agent under the old order: a question, a turn, an answer not yet seen.
    Object.assign(o1, { state: 'needs-you', lastActivityAt: 99 })
    host.harness.noteCard('h2', 'processing')
    // The session sends a list only when these rows differ from the last it sent (CableSession.agentsKey).
    expect(await host.listAgentSnapshot()).toEqual(before)
    host.harness.noteCard('h2', 'done')
    Object.assign(o1, { state: 'working' })
    expect(await host.listAgentSnapshot()).toEqual(before)
  })

  it('no window: seventeen agents: sixteen rows, and total says seventeen', async () => {
    const host = new DaemonCableHost(wiring({ sessions }), fleetOf([]))
    host.setRegistry(new HostRegistry([host.harness, observed(
      Array.from({ length: 15 }, (_, i) => observedAgent({ id: `o${i + 1}`, lastActivityAt: i + 1 })))]))
    host.setSwarms(null)
    const first = await host.listAgentSnapshot()
    expect(first.agents).toHaveLength(16)
    expect(first.total).toBe(17)
  })

  it('a window opened and shut leaves the ring as it was: what started meanwhile comes last', async () => {
    const host = new DaemonCableHost(wiring({ sessions }), fleetOf([]))
    const outside = [observedAgent({ id: 'o1' })]
    host.setRegistry(new HostRegistry([host.harness, observed(outside)]))
    host.setSwarms(null)
    const listed = async () => (await host.listAgentSnapshot()).agents.map((a) => a.id)
    expect(await listed()).toEqual(['h1', 'h2', 'o1'])
    onTab(host, ['h2'])
    // Started while the tab was held, and already waiting on the person: the registry lists it before o1.
    outside.unshift(observedAgent({ id: 'o0', state: 'needs-you', lastActivityAt: 99 }))
    expect(await listed()).toEqual(['h2'])
    host.setSwarms(null)
    expect(await listed()).toEqual(['h1', 'h2', 'o1', 'o0'])
  })
```

- [ ] **Step 2: `devices.spec.ts`**

"reminds only the observed agents the dial lists, never all fifty" takes 18 sessions and expects 16 listed:

```ts
    for (let i = 0; i < 18; i++) port.observed(hook('turn-start', { sessionId: `many-${i}` }))
    expect(calls('turnStarted')).toHaveLength(18)
    seen.host.watching!(true)
    const listed = (await machineList(port)).agents.map((a) => a.id)
    expect(listed).toHaveLength(16)
    await vi.waitFor(() => expect(calls('turnStarted').slice(18).map(([id]) => id).sort()).toEqual([...listed].sort()))
```

- [ ] **Step 3: The end-to-end case**

Kept by the PM (2026-11-14): `cli/AGENTS.md` rule 5 asks one for every user-facing flow, and it is the only test that
reads the wire. In `cli/e2e/deviceWithoutApp.e2e.ts`, after "a Notification makes it needs-you". Add its line to the
file's header comment: "the machine list keeps its order while an agent works, and a new agent comes last".

```ts
  it('the machine list keeps its order while an agent works, and a new agent comes last', async () => {
    const { d, desk } = await fresh()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, (m) => m.t === 'agents.end', 'the first list')
    // Listed with the app its hook named: a row the open scan found first is sent again once that hook comes.
    const settled = (id: string) => (r: Roster) => r.rows.find((row) => row.id === id)?.host === 'ghostty'
    const first = await startOutside(d, 'ring-a', { TERM_PROGRAM: 'ghostty' })
    await showing(dial, 'the first agent listed', settled(first.id))
    const second = await startOutside(d, 'ring-b', { TERM_PROGRAM: 'ghostty' })
    const two = await showing(dial, 'both agents listed', settled(second.id))
    expect(ids(two)).toEqual([first.id, second.id])
    const lists = rosters(dial).length
    const since = dial.messages.length
    // A whole turn: working, then done and not yet seen. Each used to move it and send the list again.
    first.type('hello from the ring')
    await heard(dial, (m) => m.t === 'turn.done' && m.agentId === first.id, 'its turn done', since)
    const third = await startOutside(d, 'ring-c', { TERM_PROGRAM: 'ghostty' })
    await showing(dial, 'the new agent listed', (r) => ids(r).includes(third.id))
    // Every list sent since the turn began holds all three, in the order they came: none was sent for the turn itself.
    const sent = rosters(dial).slice(lists).map(ids)
    expect(sent.length).toBeGreaterThan(0)
    for (const order of sent) expect(order).toEqual([first.id, second.id, third.id])
  })
```

- [ ] **Step 4: See them fail**

```bash
cd cli
npx vitest run src/cable/cableHost.spec.ts -t "the dial with no window"
npx vitest run src/services/devices.spec.ts -t "reminds only the observed agents"
TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts -t "keeps its order"
```

Expected, as seen at `92aa7660f4` (the counts of passed and skipped cases differ at the rebased base):

- `cableHost.spec.ts`, five failed:
  - the rows of the ring: the snapshot lists `o1` first;
  - until the cards come: `expected [ 'h1', 'h2', 'o1' ] to deeply equal [ 'o1', 'h1', 'h2' ]` (a case gone with
    the Swarm, #4303: four fail at the rebased base);
  - a state change: `expected [ 'o1', 'h1', 'h2' ] to deeply equal [ 'h1', 'h2', 'o1' ]`;
  - seventeen agents: `to have a length of 16 but got 10`;
  - a window opened and shut: `expected [ 'o0', 'h1', 'h2', 'o1' ] to deeply equal [ 'h1', 'h2', 'o1', 'o0' ]`.
- `devices.spec.ts`, one failed: `expected [ …(10) ] to have a length of 16 but got 10`.
- The end-to-end case fails at `expect(ids(two)).toEqual([first.id, second.id])`: the second agent is listed first.
  It takes about 15 s.

- [ ] **Step 5: Commit the red tests**

```bash
git add cli/src/cable/cableHost.spec.ts cli/src/services/devices.spec.ts cli/e2e/deviceWithoutApp.e2e.ts
git commit -m "dial: with no window the machine list is the ring (tests)"
```

- [ ] **Step 6: `machineSnapshot` reads the ring**

In `cableHost.ts`:
- the import becomes `import { DialRing } from './hosts/select.js'`;
- beside `registry`, a field:

```ts
  /** The machine list's ring: one for this host, so every dial here swipes through the same agents in the same order.
   *  In memory only: a restart of the devices process builds it again from the registry. */
  private readonly ring = new DialRing()
```

- in `machineSnapshot`, `selectForDial(…)` becomes `this.ring.select(…)` on the same list, the registry's agents
  (main has no filter before it since #4303). Nothing else in the function changes, and `total` is what `select`
  returns;
- the comment above `machineSnapshot` says the ring bounds the list (the 78-agent reconnect is still not repeated);
- in the doc comment above `listAgents`, the first of the four answers becomes:

```ts
   *   - no window, and the devices have a registry → this computer's agents (Harness and any other app or
   *                                          terminal) in a fixed ring of at most sixteen (hosts/select.ts): an
   *                                          agent keeps its place whatever its state does, with
   *                                          `host`, `caps` and `view: 'machine'`; `total` is every agent here.
```

- [ ] **Step 7: The old selection goes**

Delete `selectForDial` and `group` from `select.ts`, and `describe('selectForDial', …)` with its import from
`select.spec.ts`. In `devices.ts`, the comment above `remind` says "sixteen at most of the fifty" where it says "ten
at most of the fifty".

- [ ] **Step 8: Run the checks**

```bash
cd cli
grep -rn "selectForDial" src e2e                                   # nothing
npx vitest run src/cable src/services/devices.spec.ts src/services/devicesProcess.spec.ts   # all pass
TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts        # every case passes
npm run typecheck                                                  # no error
```

A case of `src/cable` or of the end-to-end file that fails here and passed at the base is this change's: fix the
cause. `npm run test:core` runs once, on the final head (Verification check 2).

- [ ] **Step 9: Commit**

```bash
git add cli/src/cable/cableHost.ts cli/src/cable/hosts/select.ts cli/src/cable/hosts/select.spec.ts cli/src/services/devices.ts
git commit -m "dial: with no window a swipe lands on the same neighbour, whatever the agents do"
```

---

### Task 3: The older spec says the ring

**Depends on:** nothing (the start gate above). **Effort:** medium.

**Files:**
- Modify: `docs/specs/2026-11-13-device-without-the-app.md` (the Order and How many bullets under "What the dial
  gets with no window"; one bullet under "Decided"; one line under "Done when", Tests; one under "On a dial")
- Test: none: no behavior.

The four places are named by their text, as read at `92aa7660f4` (lines 20, 163 to 166, 229 and 244 there). #4296
does not change this file at `9eed162bbb`.

- [ ] **Step 1: Replace the Order and How many bullets**

The two bullets `- **Order.** …` and `- **How many.** …` become the two below. **Which**, **When**, **With a
window** and **Mid-turn reminders** stay as they are.

```markdown
- **Order.** A fixed ring ([the swipe order](../plans/2026-11-14-dial-swipe-order-design.md), Diego, 2026-11-14): an
  agent keeps its place from the moment it enters, whatever its state does. A new agent enters at the end. When one
  ends, the others close up. Needs-you is not an order: the dial learns it from the activity line, the notification
  and the bell.
- **How many.** At most 16 places, the firmware's `CABLE_MAX_AGENTS`. An agent in the ring stays until its source
  stops listing it. With the ring full, an agent outside it enters only when it is new or needs the person: it takes
  the place of the ring agent idle the longest, and goes to the end. Idle is neither working nor needing the person:
  an agent that works or needs the person is never replaced, and when no ring agent is idle the newcomer waits
  outside. A free place goes to an agent that needs the person first, then to the most recent activity. When several
  arrive together they enter in that same order, at most 16 in one pass, and one that found no place is no longer
  new. `total` is every agent on this computer. The bound is in the selection, not in name lengths: the 78-agent
  reconnect (`listAgentSnapshot`'s comment) is not repeated.
```

- [ ] **Step 2: The three other lines that state the old rule**

Under "Decided (Diego, 2026-11-13)", the bullet's first line

```markdown
- **With no window, the dial shows this computer's agents, the ones that need the person first** (option A).
```

becomes (its second line, "With a window, nothing changes: …", stays):

```markdown
- **With no window, the dial shows this computer's agents** (option A), in a fixed ring (Diego, 2026-11-14:
  [the swipe order](../plans/2026-11-14-dial-swipe-order-design.md)).
```

Under "Done when", Tests:

```markdown
- Selection: order, the 10-row bound, `total`, the 1 s coalescing, dedupe precedence.
```

becomes:

```markdown
- Selection: the ring's fixed order, its 16 places, `total`, the 1 s coalescing, dedupe precedence.
```

Under "On a dial", in check 5, `the dial gets 10` becomes `the dial gets 16`. The rest of that line stays.

- [ ] **Step 3: Check and commit**

```bash
grep -n "At most 10 rows\|needs-you, then working\|ones that need the person first\|10-row bound\|dial gets 10" \
  docs/specs/2026-11-13-device-without-the-app.md      # nothing
grep -c "swipe order" docs/specs/2026-11-13-device-without-the-app.md      # 2
ls docs/plans/2026-11-14-dial-swipe-order-design.md    # the links' target
git add docs/specs/2026-11-13-device-without-the-app.md
git commit -m "docs: the device-without-the-app spec says the dial's ring"
```

The links' target is the design document, which lands in the same pull request as its siblings under `docs/plans/`.

---

## Verification

On the final head, after the review. Checks 1 to 3 and 4b use nothing of Diego's: not his daemon (port 18473), his
agents, `~/.harness`, `~/.claude`, `~/.codex`, his tmux server or an account. Check 4a touches two things of his, each
as he and the PM answered (2026-11-14): his daemon is stopped with `harness stop` and started again by Diego
opening the desktop app (step 4), its environment and settings never changed; and his pet folder is read once, to be copied. Nothing
runs against production.

**How check 4 is isolated** (the repo's guide: `docs/development.md` "Isolated end-to-end testing", `cli/AGENTS.md`
rule 6; the same way #4290's dial check ran). The daemon is the end-to-end suite's `IsolatedDaemon`
(`cli/e2e/harness/daemon.ts`): a throwaway root with its own home, data, auth and computer-id folders, a free port of
its own, a private tmux server, signed out (`BACKEND_WS_URL=ws://127.0.0.1:9`), no update, no analytics, no firmware
offer (`CABLE_FW_DISABLE=true`), and fake engines (`cli/e2e/harness/fakeEngine.mjs`) whose hooks reach that daemon
alone. The root is removed when the run ends, the copied pets with it. The 16 agents are 16 fake Claude Code sessions
outside a pane, each on a pseudo-terminal of its own, listed through their own hooks as `ring-01` to `ring-16`. The
dial attaches because the daemon is started with `HARNESSD_TEST_DIAL_PORT=<the dial's port>`: that path is then the
only port it looks at. The script sets that variable, and every other of the isolated daemon's, in the daemon's own
process only: the tester's shell, where `harness stop` runs, never has them.

1. **The specs and the typecheck.** This Mac, a minute or two.

   ```bash
   cd cli
   npx vitest run src/cable/hosts/select.spec.ts src/cable/cableHost.spec.ts src/cable/cableSession.spec.ts src/services/devices.spec.ts
   npm run typecheck
   ```

   To see: four files pass with no failed case; the typecheck prints no error.

2. **The gate PR CI does not run.** This Mac, a few minutes.

   ```bash
   python3 scripts/local-checks.py --run
   ```

   From a clean tree at the final commit. To see: `cli-core` (`npm run test:core`) passed, 100% per file; paste the
   fence it prints into the pull request body. It is required because `cli/src/services/devices.ts` and its spec
   change. `test:harnessd`, `cli-serial` and `cli-pty` do not apply.

3. **CLI end to end, on GitHub, by hand, once.** The repo's workflow (`.github/workflows/cli-e2e.yml`, "CLI end to
   end"), default inputs. **Ask the orchestrator for its go for the runner before starting it**: the run takes the
   Linux shards and a macOS job. With no go it is not started, and the report says so.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/dial-swipe-order
   ```

   To see, in that run: every case of `deviceWithoutApp` passes, the new one among them, and `deviceClaudeOrca`,
   `devicesProcess` and `devicesOnDemand` pass (`dialBuddyChat` went with the Swarm, #4303). Report the run's link.
   A file that fails there and on `main`'s last nightly is named as that, never as a pass. No second run.

4. **The ring on a dial, and the push numbers.** This Mac (Diego's). Two runs of one script, the base build then
   this branch.

   **Before anything, ask the orchestrator, in one message, for the dial slot and for Diego's time, and wait for the
   answer.** What it asks of Diego: about 40 minutes at his Mac. He quits the Harness desktop app (and the Harness
   Device app if it runs), swipes twice in each of two ten-minute runs, and opens his apps again. His daemon is down
   for that time: his dial, his phone and the Swarm do not reach his agents until it is back.

   - A go: **4a**.
   - No go: **4b**, and the report says "check 4, on glass: not verified". Never "passed".

   **Prepare, for both.** Save the script at the end of this section as `ring-workload.mts` in your scratchpad. It was
   run as it stands on 2026-11-14, with the fake dial and a stand-in pet folder. Run with no port, it opens no device
   at all. In bash, with `S` your scratchpad and `W` this worktree:

   ```bash
   BASE=$(git -C "$W" merge-base HEAD origin/main)
   git -C "$W" worktree add --detach "$S/base" "$BASE" && (cd "$S/base/cli" && npm ci --no-audit --no-fund)
   ```

   **4a. With the go: Diego's round dial.** As wave 0's dial proof did (Task 10 of
   `docs/plans/2026-11-13-device-without-the-app-plan.md`): his apps quit, his daemon stopped, the dial held by the
   isolated daemon, his daemon started again. In this order.

   1. **Look. Nothing is stopped and nothing is opened here.**

      ```bash
      harness status                                    # his daemon: does it run?
      lsappinfo list | grep -E 'bundleID="ai\.autonomous\.harness(\.device)?"'
      pgrep -lf '/Harness( Device)?[.]app/Contents/MacOS/'
      ls /dev/cu.usbmodem*                              # the dial's port: a listing
      ls "$HOME/.harness/devices/pets"                  # his pets: a listing
      env | grep -E '^(PORT|ADAPTER_|HARNESS_AUTH_DIR|HARNESS_ENV_FILE|HARNESS_DIAL_SERIALS|HARNESSD_TEST_|CABLE_|BACKEND_WS_URL)='
      ```

      Report to the orchestrator what each printed, before the next step:
      - `ai.autonomous.harness` or `/Harness.app/`: the desktop app is open. Its supervisor starts the daemon again
        after a stop.
      - `ai.autonomous.harness.device` or `/Harness Device.app/`: **the Harness Device app runs.** With the desktop
        app quit it starts the daemon again within about a minute of a stop, and the dial would go back to Diego's
        daemon between the two runs. Say so by name.
      - The `env` line must print nothing: `harness stop` then reaches his daemon exactly as his
        own shell would. If it prints a line, stop and report.
      - No pet folder: leave the script's last argument out. His daemon keeps none either.

      The tester quits neither app: Diego does. Run the two listing lines again until both print nothing.

   2. **Stop his daemon.** Only if step 1's `harness status` said it runs, and with nothing set on the line:

      ```bash
      harness stop
      harness status        # not running
      ```

      Look again 90 seconds later: `harness status` still says not running. If it runs again, something started it:
      stop here, go to step 4, and report what step 1 listed.

   3. **The two runs**, with `/dev/cu.usbmodemNNNN` the port step 1 listed:

      ```bash
      (cd "$S/base/cli" && TMPDIR=/tmp npx tsx "$S/ring-workload.mts" "$PWD" 10 "$S/before" /dev/cu.usbmodemNNNN "$HOME/.harness/devices/pets")
      (cd "$W/cli"      && TMPDIR=/tmp npx tsx "$S/ring-workload.mts" "$PWD" 10 "$S/after"  /dev/cu.usbmodemNNNN "$HOME/.harness/devices/pets")
      for run in before after; do
        f=$(ls "$S/$run"/logs/usb-E2E-DIAL/dial-*.log)
        echo "== $run"; grep -c 'reset reason' "$f"
        grep -E 'TASK WATCHDOG|PANIC|Guru Meditation|no dial heartbeat' "$f" | head
        grep -o 'alive up=[0-9]*s heap=[0-9]*/[0-9]* psram=[0-9]*' "$f"
        grep -o 'psram_fail=[0-9]*/[0-9]*B' "$f" | sort -u
        grep -c 'cable: offering pet\|cable: pet sync failed' "$S/$run/daemon.log"
      done
      ```

      If the script stops with `nothing was opened: … is in use by another program`, the dial is still held: go to
      step 4 and report it. If its `greeted:` line says `board pro`, the port is a Harness Pro's: the same.

      **What Diego does, in each run,** from the script's `swipe now` line: with his apps closed, swipe forward
      through the whole list and back, at minute 2 and again at minute 8, while the faces change.

   4. **Give the dial back. Always, whatever happened after step 2**, a failed or interrupted run included:

      ```bash
      ls "<the root the script printed>"     # No such file or directory: the root went, the copied pets with it
      git -C "$W" worktree remove --force "$S/base"
      ```

      A root still there (the script was killed) is removed by hand: it is the tester's own, under `/tmp`.

      **His daemon is started again by Diego, never from the tester's shell by default.** A daemon started from a
      terminal inside Orca inherits every `ORCA_*` variable of that terminal, secrets included; the fix ships with
      #4296 and only in an installed CLI that carries it (PM, 2026-11-14). So the tester tells the orchestrator the
      dial is free, and Diego opens the Harness desktop app, which starts his daemon itself. The tester may run
      `harness start` (nothing set on the line) only if `harness version` first shows an installed CLI that carries
      #4296's `ORCA_*` fix, and the PM agrees; then `harness status` must say running. To see on the dial: his own
      agents.

   **To see on the dial, in the second run (this branch):**
   - 16 agents, `ring-01` to `ring-16`, each with "Ghostty" under its name.
   - One swipe forward goes from `ring-NN` to the next number, and from `ring-16` to `ring-01`. Sixteen swipes
     forward come back to where they began. Back is the same in reverse. Never a skipped or repeated agent.
   - That holds while agents change: a running timer, a chime and an answer, and a line that says the agent waits
     ("Waiting for you · Ghostty", or after #4296 "printf hi · answer in Ghostty" for the script's permission
     request: the wording is the merged code's, start gate).
   - His own pets, as before the check.
   - No boot screen, no frozen face.

   In the first run (the base build) the dial lists 10 of the 16 and the neighbours change under the finger: that is
   the bug, and it is expected there.

   **To see in the output:**
   - `pets: N files copied into the throwaway home` at the start of each run, and `0` for the pet lines of each
     `daemon.log`: no pack was written to the dial. A count above 0 is reported with its lines.
   - `listed:` says `10 of 16` in the first run and `16 of 16` in the second.
   - The last line of each run. As measured at `92aa7660f4` with the fake dial, the base build pushes about 700 to
     770 lists an hour on this script. This branch: `list pushes: 0`, since the script moves nobody in or out of the
     ring. Both lines go in the pull request body.
   - In each dial log, from `swipe now` on: no `reset reason` line, no `TASK WATCHDOG`, `PANIC` or `Guru Meditation`,
     no `no dial heartbeat` line, and `alive up=` growing by about 60 from one line to the next.
   - Heap as before: `psram_fail=0/0B` in both runs, and in the second run the lowest `heap=` free value and the
     lowest `psram=` no more than 5% below the first run's lowest. The four numbers go in the pull request body.

   **4b. With no go: the push numbers alone.** The suite's fake dial, nothing of Diego's, unattended, about ten
   minutes:

   ```bash
   (cd "$S/base/cli" && TMPDIR=/tmp npx tsx "$S/ring-workload.mts" "$PWD" 3 "$S/before")
   (cd "$W/cli"      && TMPDIR=/tmp npx tsx "$S/ring-workload.mts" "$PWD" 3 "$S/after")
   git -C "$W" worktree remove --force "$S/base"
   ```

   To see: `listed:` says `10 of 16`, then `16 of 16`; the last line of the first run is some hundreds of pushes an
   hour, of the second `list pushes: 0`. Both lines go in the pull request body, with "on glass: not verified".

On GitHub nothing else is started by hand. PR CI runs by itself what a `cli/` and `docs/` change selects:
`cli-typecheck`, `cli-tests`, `companions`, `pty-checks` and `process-checks`.

**Temporary workflow:** none. Check 4a needs the dial on USB and a person; check 4b is ten minutes on this Mac; the
end-to-end file has the repo's own workflow (check 3), whose nightly keeps running the new case afterwards.

**Checks PR CI does not run:** `cli-core` (check 2), the CLI end to end workflow (check 3) and the dial (check 4).

**The workload script (check 4).** Copy it whole: its Python lines keep their own indentation.

```ts
// The dial-swipe-order workload: an isolated daemon (throwaway home, data folder and port, signed out, fake engines),
// 16 fake Claude Code sessions outside a pane, a fixed script of state changes, and a count of the list pushes.
//   cd <checkout>/cli && TMPDIR=/tmp npx tsx <this file> <checkout>/cli <minutes> <out folder> [<the dial's port> [<pet folder>]]
// With no port it plugs the suite's fake dial (a pseudo-terminal). Never Diego's daemon (port 18473) or his agents.
// A pet folder is copied into the throwaway home before the daemon starts, so the daemon tells a real dial to keep the
// packs it holds. The original is only read; the copy goes with the root.
// The out folder gets daemon.log and the dial's own log (the firmware's lines beside the daemon's), kept after the
// throwaway root is removed.
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [cliRoot, minutes, out, port, pets] = process.argv.slice(2)
if (!cliRoot || !Number(minutes) || !out) throw new Error('usage: ring-workload.mts <cli root> <minutes> <out folder> [<dial port> [<pet folder>]]')
if (pets && !existsSync(pets)) throw new Error(`no pet folder at ${pets}: nothing was started`)
const { IsolatedDaemon, until } = await import(join(cliRoot, 'e2e/harness/daemon.ts'))
const { Desk } = await import(join(cliRoot, 'e2e/harness/desk.ts'))

// A terminal app's tab: the engine on a pseudo-terminal of its own (cli/e2e/deviceWithoutApp.e2e.ts).
const PTY = `
import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
inputs = [fd, sys.stdin.fileno()]
while True:
    ready, _, _ = select.select(inputs, [], [])
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
    if sys.stdin.fileno() in ready:
        data = os.read(sys.stdin.fileno(), 65536)
        if data:
            os.write(fd, data)
        else:
            inputs = [fd]
`
const AGENTS = 16
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
let desk: InstanceType<typeof Desk> | undefined
if (port) d.env.HARNESSD_TEST_DIAL_PORT = port
else {
  const file = join(d.root, 'dials.json')
  writeFileSync(file, '[]')
  d.env.HARNESSD_TEST_DIAL_PORT = file
  desk = new Desk(file)
}
if (pets) {
  // Where the daemon under this home keeps its pets (HARNESS_DEVICES_DIR's default, cli/src/config/env.ts).
  cpSync(pets, join(d.env.HOME!, '.harness', 'devices', 'pets'), { recursive: true })
  console.log(`pets: ${readdirSync(pets).length} files copied into the throwaway home`)
}
const tabs: ChildProcess[] = []
const close = async (): Promise<void> => {
  for (const tab of tabs) tab.kill('SIGKILL')
  await desk?.close()
  // Before the root goes: what the daemon said, and the dial's log (HARNESS_LOGS_DIR, under the throwaway home).
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'daemon.log'), d.log())
  const logs = join(d.env.HOME!, '.harness', 'logs')
  if (existsSync(logs)) cpSync(logs, join(out, 'logs'), { recursive: true })
  await d.close()
}
process.once('SIGINT', () => { void close().finally(() => process.exit(130)) })
try {
  await d.start()
  console.log(`daemon up: port ${d.env.PORT}, root ${d.root}, dial ${port || 'fake'}`)
  if (desk) await desk.plug('RING', 'e2:e0:00:00:00:10')
  // A port another program holds (the everyday daemon, a monitor) is left alone, and this run stops there.
  const greeting: string = await until('the dial to greet, or its port to be found held', () => {
    const lines: string[] = d.log().split('\n')
    return lines.find((line) => /is in use by another program/.test(line)) ?? lines.find((line) => /cable: dial \S+ (back )?on fw/.test(line))
  }, 60_000, 200)
  if (/in use by another program/.test(greeting)) throw new Error(`nothing was opened: ${greeting}`)
  console.log(`greeted: ${greeting.replace(/dial \S+/, 'dial <mac>')}`)
  const started = (): number => d.hookLog().split('\n').filter((line: string) => /SessionStart\(startup\) session=\S+ ran/.test(line)).length
  for (let i = 0; i < AGENTS; i++) {
    const cwd = join(d.projectsDir, `ring-${String(i + 1).padStart(2, '0')}`)
    mkdirSync(cwd, { recursive: true })
    const env: NodeJS.ProcessEnv = { ...d.env, TERM: 'xterm-256color' }
    for (const name of ['TMUX', 'TMUX_PANE', 'HARNESS_PANE', '__CFBundleIdentifier', 'HERDR_PANE_ID', 'REX_BLOCK', 'ZELLIJ',
      'KITTY_WINDOW_ID', 'WEZTERM_PANE', 'ORCA_AGENT_SESSION_ID', 'ORCA_PAIRING_CODE', 'ORCA_AGENT_SESSION_SPAWN_TOKEN']) delete env[name]
    env.TERM_PROGRAM = 'ghostty'
    const tab = spawn('python3', ['-c', PTY, d.env.CLAUDE_PATH!], { cwd, env, stdio: ['pipe', 'ignore', 'ignore'] })
    tabs.push(tab)
    await until(`session ${i + 1} to start`, () => started() > i, 60_000, 100)
  }
  const type = (i: number, text: string): void => { tabs[i].stdin!.write(text); tabs[i].stdin!.write('\r') }
  const pushes = (): string[] => d.log().split('\n').filter((line: string) => /cable: agents → \d+ of \d+/.test(line))
  await until('all sixteen counted', () => pushes().some((line: string) => / of 16/.test(line)), 60_000, 200)
  console.log(`listed: ${pushes().at(-1)}`)
  console.log(`the script runs until ${new Date(Date.now() + Number(minutes) * 60_000).toLocaleTimeString()}: swipe now`)
  // The script: every 5 s the next agent starts an 8 s turn; every fourth asks permission and is allowed 10 s later.
  const from = pushes().length
  const beganAt = Date.now()
  const end = beganAt + Number(minutes) * 60_000
  for (let step = 0; Date.now() < end; step++) {
    const i = step % AGENTS
    if (step % 4 === 3) { type(i, '!permit printf hi'); setTimeout(() => type(i, ''), 10_000) }
    else type(i, `!slow 8000 step ${step}`)
    await sleep(5_000)
  }
  await sleep(12_000)
  const during = pushes().slice(from)
  const unasked = during.filter((line: string) => !line.includes('(requested)'))
  const hours = (Date.now() - beganAt) / 3_600_000
  console.log(during.slice(0, 12).join('\n'))
  console.log(`list pushes: ${unasked.length} in ${(hours * 60).toFixed(1)} min = ${Math.round(unasked.length / hours)} an hour (${during.length - unasked.length} more were asked for by the dial)`)
} finally {
  await close()
}
```
