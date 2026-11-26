# Needs you, right, Part 2: the dial knows the person is there. Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent's notice from an agent the person is already with comes as a quiet drawer row (no beep, no wake),
and an outside agent's ordinary turn end the person is watching is silent in All; everything else rings as today, and
two counts say how often notices were held quiet and answered.

**Architecture:** One rule in the devices service, `present(agentId)` (`services/devices.ts`), read from what the
devices already hold: the person's last prompt to each outside agent (new, in memory, at most 64), the app in front,
the agent the dial shows, a Harness agent's `began` and `alreadyOnScreen`. `Notices` takes it as a dependency and holds
a present caller's card the way it holds a restored one; `NoticeLimits` takes a quiet card for its agent and not for
the hour. Two names join the dial vocabulary (CLI and its byte-identical backend copy), `cable/dialUsage.ts` counts
them, and `usage:daily`'s Dial skill section shows them. The core does not change.

**Tech Stack:** TypeScript (Node 24). CLI: Vitest (unit; `npm run test:core` 100% per file for `src/services/`; e2e on
the real daemon with a fake dial and the in-memory backend). Backend: Fastify, Vitest.

**Spec:** `docs/plans/2026-11-26-needs-you-right-design.md`, "Part 2. The dial knows the person is there", with its
Design, Release order, Platforms, Tests (Part 2) and Docs sections (approved by the maintainer, 2026-11-26). Base:
`feat/needs-you-right-presence` at `225440b29e`; line numbers below are on it.

**Commit 0 (before Task 1):** the spec, unchanged, and this plan are the branch's first commit:
`git add docs/plans/2026-11-26-needs-you-right-design.md docs/plans/2026-11-26-needs-you-right-part2-plan.md && git commit -m "docs: needs you, right: the design, and Part 2's plan"`.

Paths: `DC` `cli/src/lib/dialUsageContract.ts`, `BT` `backend/src/types/dialUsage.ts` (its byte copy), `LN`
`cli/src/lib/dialNotice.ts`, `NT` `cli/src/cable/notices.ts`, `DU` `cli/src/cable/dialUsage.ts`, `DV`
`cli/src/services/devices.ts`, `BR` `backend/src/analytics/dailyDialReview.ts`, `RT`
`backend/src/routes/productUsage.test.ts`, `E2E` `cli/e2e/dialUsage.e2e.ts`. A CLI spec is the file with `.spec.ts` in
place of `.ts` (`DCS`, `LNS`, `NTS`, `DUS`, `DVS`); `BRT` is `BR`'s `.test.ts`.

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | The two names, CLI and backend | `DC`, `DCS`, `BT`, `RT` | none | medium | `DCS` "names the dial skill's use: eighteen names…"; `RT` "takes the dial skill's names" |
| 2 | The quiet card and its limits | `NT`, `NTS`, `LN`, `LNS` | none | high | `NTS` "a present caller…" cases; `LNS` quiet `take` cases |
| 3 | The quiet notice counted, and its answer | `DU`, `DUS` | 1 | high | `DUS` "held quiet" cases |
| 4 | The review's two rows | `BR`, `BRT` | 1 | medium | `BRT` "shows notices held quiet…" |
| 5 | Devices: `present`, the quiet notice, the quiet turn end | `DV`, `DVS` | 2, 3 | xhigh | `DVS` "the person is there" table and counts |
| 6 | End to end: quiet with the person there, a ring without | `E2E` | 5 | high | none: a check of Tasks 1-5, no behavior of its own; one commit |
| 7 | Docs | `cli/AGENTS.md`, `docs/cli.md`, `docs/product-measurement.md` | none | medium | none: docs, one commit |

**Shared files:** none; no two tasks touch the same file.

**Longest chain:** four tasks, 1 → 3 → 5 → 6. Ready at once: 1, 2, 7.

## Global Constraints

- **No core change.** `git diff --stat 225440b29e -- cli/src/core cli/src/architecture.coreFiles.txt cli/hook/notify.mjs`
  prints nothing: no file joins `architecture.coreFiles.txt`, no request joins `core/api.ts`. No new file.
- **`DC` and `BT` are the same bytes** (`backend/src/types/dialUsage.test.ts`); `DC` still imports nothing.
- **`src/services/devices.ts` is 100% per file** under `npm run test:core` (v8 counts `??`, `?.` and both sides of a
  condition): every new line and branch in `DV` is hit by a `DVS` case.
- **`PRESENT_MS` is 120 000 ms** (the usage counts' own edge, `WAIT_EDGES` and `VALUE_SHORT_MS` in `DU`); "at most
  `PRESENT_MS` ago" is `0 <= now - at <= PRESENT_MS`. The prompt times: at most 64 (`PROMPTED_MAX`), oldest first.
- **The names, verbatim:** `dial_notice_present`, `dial_notice_present_answered_10m`. Neither is a flag.
- **Counts only.** No notice text, agent, session, folder or id in a name, `dial-usage.json`, a report, a log line or
  a test's expected log. Agent ids live only in `DV`'s and `DU`'s bounded maps.
- **Unknown is not present, and rings as today:** no front report, `none` in front, a pending or unknown app, another
  machine's agent, an engine with no prompt event, a turn started by another session, a prompt the devices did not hear.
- **Unchanged:** questions, permission asks and failed turns ring each time; a Harness agent's turn-end rule
  (`onScreen`); `dial_wait_*` and `dial_value_ring_*` (a quiet notice opens no wait); the dial firmware and its frames
  (a quiet card uses the `hold` and drawer replace a restored card uses); `dial-notices.json`'s shape.
- **Release order** (not part of these tasks): backend first, then the CLI, as soon as this part is done (no batch, no
  date). **Platforms:** macOS, Linux, Windows; no
  platform-specific code.
- **No fixed sleeps** (fake timers, `vi.waitFor`, `until`); no full suites locally while building (PR CI runs them); no
  CPU-hog loops on this Mac. Comments say why.

## What this plan decides from the spec's words

**Builder calls the spec leaves to the builder:**

1. **The tally line says "held quiet" as its last word.** `Notices`' `count` dependency gains a fourth argument,
   `present: boolean`; the devices pass `present ? \`${kind} · present\` : kind` as the tally's reason, so a quiet
   notice logs `[device] notify · claude · shown · waiting · present`. Every line that is not quiet keeps its exact
   text, and the day line (`… · day <d> · claude shown N no dial N limited N · …`) is unchanged. The end-to-end checks
   that read the line match `includes('[device] notify · claude · shown')` (`cli/e2e/deviceNotify.e2e.ts` 163, 219,
   245, 334), which still holds. The turn end logs `[cable] notify · silent · rule:present · present · 0ms` through the
   existing `tally`.
2. **The limits.** `NoticeLimits.take(agent: string, line: string, hour = true): boolean` (`LN` 114-131). With
   `hour: false` (a quiet card) the entry is kept with `hour: false` for `NOTICE_SAME_MS` (10 min), is read by the
   agent's own two checks (one a minute, the same line within 10 min), and is neither counted toward nor refused by
   `NOTICE_HOUR_MAX`: the hour bounds beeps, and a quiet card makes none. Entries with `hour: true` behave as today.
   `Notices.notify` reads `present` after `connected()` and `resolve`, and before `take`. Bound: a quiet entry needs
   its agent present (one outside agent at a time, the one a dial shows, or Harness tiles on the window in front), and
   each agent takes at most one a minute, so at most 10 quiet entries an agent are ever kept.
3. **Several dials.** `cableHost.shownAgentId()` as it is: the agent of the dial that moved last, the one record the
   cable host keeps for every dial (`cable/cableHost.ts` 873-888), which the scroll and Orca's `dial` stream read too.
   A dial that moved last and shows none clears it; another dial's none does not. No per-dial set: two dials on one
   computer is rare, and an agent on the other dial reads not present and rings, the safe side.

**Other readings, fixed here:**

- **Who is outside:** `outside(agentId)` (`DV` 1227). An agent with a row there takes the outside rule; any other id
  takes the Harness rule, so a caller no list holds (no `began`, no tile) is never present, and a Harness agent whose
  session an outside hook also reports takes the Harness rule, as `noticeCaller` resolves it (`DV` 1886-1889).
- **The outside rule:** `prompted.get(agentId)` within `PRESENT_MS` on the `monotonic` clock (`DV` 390), the row's
  `app` not `UNKNOWN_APP` and `!appPending`, `cableHost.latestFront()` equal to that app (as `usageAway`, `DV` 542-546,
  reads the front: the last report, before a settle), and `cableHost.shownAgentId() === agentId`.
- **The prompt times:** at each `turn-start` hook (`DV` 3387), `byPerson = source === 'person' || source === 'dial'`
  (one constant, also passed to `usage.turnStarted`): a person's or the dial's sets the time; any other start
  (another session's message, an engine with no prompt event, a session the source does not list) deletes it, as the
  turn under way is not the person's. Deleted in `outsideTurn`'s gone loop (`DV` 1987-1991, beside `endNotice(id,
  'gone')`). Set after a delete, so the map stays oldest first; past 64 the oldest goes.
- **The Harness rule:** `began.get(agentId)` (`DV` 1630, wall clock, set at the turn's first `processing` card) within
  `PRESENT_MS` of `Date.now()`, and `alreadyOnScreen(agentId)` (`DV` 429).
- **The turn end:** in `dispatch`'s summary path, right after the `notice` branch (`DV` 1702) and before the mode and
  tier: `event.failed !== true`, an `outside(agentId)` row, and the outside rule → `noted('silent', 'present')` and a
  silent summary, nothing announced. After the notice branch so a pending notice keeps `rule:notice`
  (`cli/e2e/deviceNotify.e2e.ts` 192 reads it). It applies in Needs you too; only the rule name differs there.
- **The counts:** `Notices.quiet(agentId): boolean` says whether that agent's pending card is quiet. The devices'
  `noticeShown` (`DV` 1933-1938) reads it once the notice is `shown`: `usage.noticeShown(agentId, quiet)`, and a quiet
  notice opens no wait (a `proceeding` one still ends an earlier wait as today). `DU` counts `dial_notice_present` in
  `noticeShown`, keeps the flag beside the shown time, and counts `dial_notice_present_answered_10m` beside
  `dial_notice_answered_10m` when the same answer comes. `noticed` (`dial_notice_shown` and the rest) is unchanged.
- **The review's rows**, after `Answered: the person's prompt within 10 min`, each against `noticed`:
  `Quiet: the person was with that agent` (`dial_notice_present`) and
  `Quiet, answered: the person's prompt within 10 min` (`dial_notice_present_answered_10m`). No new limit line.
- **The end-to-end case uses a second outside session for the ring:** a second notice of one agent within its minute
  is `limited` (`NOTICE_AGENT_MS`), and waiting the minute out on a real clock is a fixed sleep. The second session
  differs from the first only in the app in front.
- **Docs:** beside the spec's two (`cli/AGENTS.md`, the dial doc of what rings: `docs/cli.md`'s `harness device
  notify` row), `docs/product-measurement.md`'s "Do agents use the dial skill?" row names the two new counts, as it
  names the rest.

## Review Focus

1. **The front moves after the person's prompt** (a Cmd-Tab to a browser within 120 s; Harness Device saying `none`):
   the notice rings. Pinned in Task 5 (`another app in front`, `none in front`).
2. **The dial no longer shows the agent** (the dial that moved last turned to none, or to another agent of the same
   app; a second dial's none): rings, and a second dial's none does not clear the record. Pinned in Task 5.
3. **One agent known by two ids** (a Harness agent whose Claude Code session an outside hook also reports): it takes
   the Harness rule, and the hook's prompt makes it present only with its turn begun and its tile in front. Pinned in
   Task 5.
4. **Clock edges:** a prompt exactly 120 000 ms old is present, 120 001 is not; a wall clock set back since a Harness
   turn began reads not present. Pinned in Task 5.
5. **A quiet card meeting the card machinery** (held back by another open question of its agent, a dial attaching, a
   newer loud notice replacing it, the last dial going): held and redrawn, never asked; replaced by an ask; a Harness
   card ends at the unplug as a live one does. Pinned in Task 2.

---

### Task 1: The two names, CLI and backend

**Files:** Modify `DC`, `DCS`, `BT` (a byte copy of `DC`), `RT`.

**Interfaces (produces):** `'dial_notice_present', 'dial_notice_present_answered_10m'` at the end of
`DIAL_DEVICE_METRICS` (`DC` 62-92, after `'dial_notice_answered_10m'`), so in `DIAL_FILE_METRICS` and
`DIAL_USAGE_METRICS`, typed as `DialFileMetric`.

- [ ] **Step 1: Write the failing tests.**
  - `DCS` (63-76): rename to `'names the dial skill\'s use: eighteen names, six of them computer flags'` and add the two
    names to the first list; the flag list is unchanged.
  - `RT` `'takes the dial skill\'s names'` (449-456): add the two names to its counters.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/dialUsageContract.spec.ts` and
  `cd backend && npx vitest run src/routes/productUsage.test.ts`. Expected: FAIL (names missing; the route drops them
  and adds `health_cli_report_unknown_metric`).
- [ ] **Step 3: Implement** in `DC`, then `cp cli/src/lib/dialUsageContract.ts backend/src/types/dialUsage.ts`.
- [ ] **Step 4: Run** the same two, `cd backend && npx vitest run src/types/dialUsage.test.ts`, and `npm run typecheck`
  in `cli` and `backend`. Expected: PASS (the 8 KiB report case still passes).
- [ ] **Step 5: Commit** (`feat: name the dial's notices held quiet`).

### Task 2: The quiet card and its limits

**Files:** Modify `NT`, `NTS`, `LN`, `LNS`.

**Interfaces (produces):**

```ts
// LN, NoticeLimits
take(agent: string, line: string, hour = true): boolean
// NT, NoticesDeps
/** Whether the person is with that agent now (services/devices.ts `present`): read once the notice is its agent's,
 *  before the limits are taken. */
present(agentId: string): boolean
count(engine: 'claude' | 'codex' | 'agent', result: NoticeResult, kind: NoticeKind, present: boolean): void
// NT, Notices
/** Whether that agent's pending card is held quiet. */
quiet(agentId: string): boolean
```

`Pending` gains `quiet?: true`, apart from `restored`. `notify`: `present` read as Builder call 2 says, `take(…,
!present)`, the card set with `quiet` when present, `answer('shown', present)`; `send` holds a card that is `restored`
or `quiet` (then `reask` redraws); `working()` still ends only a restored card; `stored()` is unchanged (after a
restart every card is quiet already). `count` gets `false` for `no dial` and `limited`.

- [ ] **Step 1: Write the failing tests.**
  - `LNS` `describe('NoticeLimits')`:
    - `'a quiet take counts for its agent and never for the hour'`: twenty `take('agent-i', 'x')` → true; then
      `take('q', 'x', false)` → true (the hour is full); `take('agent-20', 'x')` → false; at +59 999 ms
      `take('q', 'y', false)` → false and `take('q', 'y')` → false; at +60 000 `take('q', 'y')` → false (hour full).
    - `'quiet takes leave the hour\'s twenty for rings'`: 25 agents' quiet takes, then twenty other agents' takes →
      each true; the twenty-first false.
    - `'a quiet take holds its line for ten minutes'`: `take('a', 'L', false)`; at 599 999 `take('a', 'L')` → false;
      at 600 000 → true.
  - `NTS`: the rig gains `present: new Set<string>()` in `state` and `present: (agentId) => state.present.has(agentId)`,
    and records `count` as `present ? [engine, result, kind, 'present'] : [engine, result, kind]` (existing cases keep
    their expectations).
    - `'a present caller\'s card is held, never asked, and still shown'`: `state.present.add('a1')`; `notify` →
      `'shown'`; `calls` = `[['hold', 'a1', /^shown:/, [{ key: 'notice', q: VPN, options: ['In Orca'] }]]]`;
      `state.redraws` = `[['a1']]`; `counted` = `[['claude', 'shown', 'plain', 'present']]`; `quiet('a1')` true.
    - `'a waiting, a proceeding and a plain notice alike'`: `it.each` over `composeNotice('q', 's', kind)` for each
      kind → held, `counted` ending in `[kind, 'present']`.
    - `'it stays pending, a drawer row, until its next turn; working() leaves it'`: `pending('a1')`, `rows('m')` holds
      it; `working('a1')` → no close; `ended('a1')` → `[['close', 'a1', id]]`, `quiet('a1')` false.
    - `'it leaves the hour\'s count alone and still takes its agent\'s minute'`: 20 present agents' notices at 1 s
      apart → each `'shown'` held; `a21`, not present → `'shown'` asked; `a1` again at +30 s, present → `'limited'`;
      present ones never answered `'limited'` for the hour.
    - `'presence is read before the limits'`: twenty loud notices in the hour, then a present `p1` → `'shown'`, held.
    - `'with no dial presence is not read'`: `connected: false` → `'no dial'`, the `present` dependency not called.
    - `'covered by another question of its agent, it is held and redrawn as that one closes'`: `state.held.add('a1')`,
      present → no call; `held.delete`, `reask('a1')` → one `hold`, one redraw.
    - `'a dial that attaches holds it again, with no redraw'`: `attached()` → `hold` again, redraws unchanged.
    - `'a newer notice replaces it: rung when the person has gone, held when still there'`: present notice; at
      +61 s, `present` cleared → the quiet card closed and the new one asked, `quiet('a1')` false; the reverse order
      → close, then hold.
    - `'the last dial going ends a quiet Harness card, as a live one'`: host `harness`, present → `detached()` →
      closed.
    - `'a quiet card is stored as any card'`: `stored()` has no flag beyond today's fields.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/dialNotice.spec.ts src/cable/notices.spec.ts`. Expected: FAIL
  (`take` ignores its third argument; no `present`, `quiet`).
- [ ] **Step 3: Implement** in `LN` (the `Counted` entry gains `hour: boolean`; the filter keeps an hour entry an hour
  and a quiet one `NOTICE_SAME_MS`; the hour check counts hour entries only and applies only to `hour` takes) and in
  `NT`. `DV` is not touched: its `Notices` lacks `present` until Task 5, which depends on this task.
- [ ] **Step 4: Run** the same specs and `cd cli && npm run typecheck`. Expected: the specs PASS, the existing cases
  unchanged; typecheck's only errors are in `src/services/devices.ts` (Tasks 2 and 3 change what it calls; Task 5
  makes it whole).
- [ ] **Step 5: Commit** (`feat(cli): a notice from an agent the person is with is a quiet card`).

### Task 3: The quiet notice counted, and its answer

**Files:** Modify `DU`, `DUS`.

**Interfaces:**
- Consumes: Task 1's names.
- Produces: `noticeShown(agentId: string, present: boolean): void` in `DialUsage` (replacing the one-argument form):
  counts `dial_notice_present` when `present`; the map `notices` (`DU` 199) holds `{ at, present }`; the `unwaited`
  entry's `notice?` (196) holds the same; `noticeAnswered` (200-202) adds `dial_notice_present_answered_10m` beside
  `dial_notice_answered_10m` for a quiet one.

- [ ] **Step 1: Write the failing spec cases** in `DUS` (existing `noticeShown(x)` calls become `noticeShown(x, false)`):
  - `'a notice held quiet is counted, and so is its answer, apart'`: `noticeShown('a', true)`, 599 999 ms,
    `turnStarted('a', true)` → `dial_notice_present` 1, `dial_notice_answered_10m` 1,
    `dial_notice_present_answered_10m` 1.
  - `'a rung notice counts neither'`: `noticeShown('b', false)`, a prompt → `answered_10m` 1, neither new name.
  - `'the dial\'s voice answers a quiet notice in either order'`: as the existing voice cases, with
    `noticeShown('a', true)` → `dial_notice_present_answered_10m` 1 each way, once.
  - `'a newer rung notice replaces a quiet one'`: `noticeShown('a', true)`, `noticeShown('a', false)`, a prompt →
    `present` 1, `present_answered_10m` 0, `answered_10m` 1.
  - `'past 10 minutes a quiet notice is not answered'`: 600 000 ms → no `_answered_10m` name.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/dialUsage.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `DU`.
- [ ] **Step 4: Run** the same spec and `npm run typecheck`. Expected: the spec PASSES; typecheck's only errors are in
  `src/services/devices.ts`, whose call is Task 5's.
- [ ] **Step 5: Commit** (`feat(cli): count the dial's notices held quiet and their answers`).

### Task 4: The review's two rows

**Files:** Modify `BR` (the `Dial skill` section, 128-138), `BRT`.

**Interfaces:** Consumes Task 1's names in `BT` (so in `DIAL_REVIEW_METRICS`).

- [ ] **Step 1: Write the failing test** `BRT` `'shows notices held quiet and their answers after Answered'`: day-1 rows
  `dial_notice_installation_days` 6, `dial_notice_shown` 9, `dial_notice_answered_10m` 4, `dial_notice_present` 5,
  `dial_notice_present_answered_10m` 2 → in the outside team's `Dial skill`, `Quiet: the person was with that agent`
  `{ computers: { day: 6 }, events: { day: 5 } }` and `Quiet, answered: the person's prompt within 10 min`
  `{ computers: { day: 6 }, events: { day: 2 } }`, right after the `Answered…` row; and `DIAL_REVIEW_METRICS` contains
  both names.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/analytics/dailyDialReview.test.ts`. Expected: FAIL (no rows).
- [ ] **Step 3: Implement** the two `line(…)` rows of "What this plan decides".
- [ ] **Step 4: Run** the same and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(backend): the Dial skill section shows notices held quiet`).

### Task 5: Devices: `present`, the quiet notice, the quiet turn end

**Files:** Modify `DV`, `DVS`.

**Interfaces:** Consumes Task 2's `present` dependency, `count`'s fourth argument and `Notices.quiet`, and Task 3's
`noticeShown(agentId, present)`. In `DV`:

```ts
/** The person's own prompt to an agent came within it (docs/plans/2026-11-26-needs-you-right-design.md, Part 2). */
const PRESENT_MS = 120_000
const PROMPTED_MAX = 64
const prompted = new Map<string, number>()     // outside agent → its person's or dial's last prompt, monotonic ms
const outsidePresent = (entry: HostEntry): boolean
const harnessPresent = (agentId: string): boolean
const present = (agentId: string): boolean      // outside(agentId) ? outsidePresent : harnessPresent
```

Wired: `Notices`' `present: present` and `count` as Builder call 1 (the tally's reason; `usage.noticed` unchanged);
`noticeShown` as "What this plan decides" (no wait for a quiet one); the prompt times at the `turn-start` hook and the
gone loop; the summary path's `rule:present`.

- [ ] **Step 1: Write the failing spec cases.**
  - In `'an agent\'s notice …'` (8421), `describe('the person is there (docs/plans/2026-11-26-needs-you-right-design.md,
    Part 2)')`, `vi.useFakeTimers()` and `devices({ now: () => Date.now() })`. `there(port)`: `host().front('orca')`,
    `host().dialShows({}, { name: 'api', app: 'Orca' }, ID)`, `port.observed(hook('turn-start'))`. `quiet()` asserts
    the notice answers `{ result: 'shown' }`, `calls('question')` holds no `shown:` ask for the agent, `calls('hold')`
    holds `[ID, /^shown:/, card('Orca')]`, the last `replaceNotifications` holds its row, and the log holds
    `'[device] notify · claude · shown · plain · present'`. `rings()` asserts one `shown:` ask and no `hold`.
    `it.each` over (each row its own devices):
    - quiet: `'the person\'s prompt within 120 s, its app in front, the dial on it'`; `'a prompt exactly 120 000 ms
      old'`.
    - rings: `'a prompt 120 001 ms old'`; `'another session\'s message started its turn after the person\'s prompt'`
      (`hook('turn-start', { relayed: true })`); `'another app in front'` (`front('vscode')` after `there`); `'none
      in front'` (`front('none')`); `'nothing in front reported'`; `'the dial on another agent of the same app'`
      (`sess-2` hooked, `dialShows` it); `'the dial that moved last shows none'` (`dialShows(DIAL, null, null)`);
      `'a second dial\'s none leaves it quiet'` (two dial objects; the one that did not move last shows none →
      quiet); `'its app not known, though the front reads the same'` (a Zed session, hints `{ __CFBundleIdentifier:
      'dev.zed.Zed' }`, whose row app is `UNKNOWN_APP`, with `front(UNKNOWN_APP)` and the dial on it);
      `'its time gone as it left'` (`session-end`, 11 s, `session-start` again, no
      prompt); `'64 other agents prompted since'` (`sess-x0` … `sess-x63` turn-starts after it).
    - Harness (`bound()` core, `h1`): quiet `'its turn began within 120 s, its tile on the window in front'`
      (`processing` card, `port.desk(['h1'], true)`); rings `'its window behind'` (`desk(['h1'], false)`), `'its tile
      not on the tab'`, `'its turn began 120 001 ms ago'`, `'its turn over'` (a `done` card), `'the wall clock set
      back since its turn began'` (`vi.setSystemTime` an hour back); `'an outside hook\'s prompt for the session h1
      holds makes it no more present'` (front `orca`, `dialShows h1`, `hook('turn-start', { sessionId: 's-h1' })`,
      no `processing` card → rings).
  - In `'its agent\'s turn end …'` (8701) or beside it, `describe('an outside agent\'s turn end, the person there')`
    (`readers.answer.mockResolvedValue('Built.')`, `decideTier: null`):
    - `'is silent in All, logged rule:present'`: `there(port)`, `hook('turn-stop')`, `STOP_HOOK_GRACE_MS` →
      `calls('summary')` `[[ID, …, 'silent', …]]`; the log holds `'[cable] notify · silent · rule:present · present ·
      0ms'` and no `ID`; and the turn is not counted as announced: after the person's next prompt to `ID`, the day
      holds no `dial_value_done_away_prompted_10m` (the orchestrator, 2026-11-26).
    - `'rings with another app in front'` → tier `'alert'`.
    - `'is silent in Needs you, under rule:present'`.
    - `'a pending notice keeps rule:notice'`: `there(port)`, a notice (quiet), then the turn's stop → silent,
      logged `rule:notice`, never `rule:present`.
    - `'a failed turn still rings'`: `hook('turn-error')` → `turnError`; and a summary card with `failed: true` for
      `ID` → `'alert'`.
  - In `'the dial skill\'s use …'` (15826): `'a notice held quiet counts as such, opens no wait, and its answer
    counts'`: outside agent `there`, a `Waiting · …` notice → `dial_notice_present` 1, `dial_notice_shown` 1, no
    `dial_wait_` name after the person's next prompt, `dial_notice_present_answered_10m` 1, `dial_notice_answered_10m`
    1; a second agent's rung notice opens its wait as today. The file's text holds no session id.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t "the person is there"` and
  `-t "turn end, the person there"` and `-t "held quiet"`. Expected: FAIL (every notice asked; the turn end rings).
- [ ] **Step 3: Implement** the interfaces and wiring above in `DV`.
- [ ] **Step 4: Run** the same, the whole `DVS` once, `npm run typecheck`, `npm run test:core` (`devices.ts` 100%:
  lines, branches, functions, statements) and `npx vitest run src/architecture.spec.ts`. Expected: PASS; `git diff
  --stat 225440b29e -- src/core src/architecture.coreFiles.txt hook/notify.mjs` prints nothing.
- [ ] **Step 5: Commit** (`feat(cli): the dial holds an agent's ask quiet while the person is with it`).

### Task 6: End to end: quiet with the person there, a ring without

**Files:** Modify `E2E`.

No test fails first: this checks what Tasks 1-5 deliver and changes no behavior; one commit. It must pass with Task 5
in. Copy helpers into the file; `cli/e2e/harness/` is not touched (a change there runs the linux-e2e canary).

- [ ] **Step 1: Replace the notice part** (`E2E` 129-141) with two outside sessions, both
  `Outside.start(d, …, { TERM_PROGRAM: 'ghostty' })` (closed in `afterAll`), each waited for on the dial's list:
  - **A, the person there:** `tellDevices(d.dataDir, { type: 'front', app: 'ghostty' })` → true (the listener's own
    message, as `harness hardware watch` sends it; `src/devices/listenerClient.ts`); `dial.send({ t: 'focus', agentId:
    A.id })`, then `agents.list` → `agents.end` as the barrier; `A.type('first')`, its `turn.started` on the dial, its
    `Stop` ran, `A.idle(d)`; its `summary` on the dial has `tier: 'silent'` and the log holds `rule:present`. Then the
    real `notify` (the file's helper) with `CLAUDE_CODE_SESSION_ID: A.sessionId` and `['PRIVATE_LINE_CANARY needs the
    VPN', '--suggest', 'connect it', '--waiting']` → `{ code: 0, out: 'shown' }`; a `notif.replace` since then holds
    `{ agentId: A.id, question: true }` with the line; no `question` frame for `A.id` since; `question.read` on it
    answers `question.state` with the line (it opens to its line); the log holds `· shown · waiting · present`. Then
    `A.type('connected')`.
  - **B, another app in front:** `tellDevices(… { type: 'front', app: 'kitty' })` → true; focus B with the same
    barrier; `B.type('first')`, its turn started and over; `notify` for B with `'PRIVATE_RING_CANARY needs a key'` →
    `'shown'`, and a `question` frame for `B.id` comes (a ring). Then `B.type('connected')`.
  - `skill` becomes `{ dial_notice_installation_days: 1, dial_notice_claude_installation_days: 1,
    dial_skill_claude_installation_days: 1, dial_skill_codex_installation_days: 1, dial_notice_claude: 2,
    dial_notice_shown: 2, dial_notice_waiting: 2, dial_notice_answered_10m: 2, dial_notice_present: 1,
    dial_notice_present_answered_10m: 1 }`; the day in `dial-usage.json` also holds exactly one wait (the `dial_wait_`
    names sum to 1: B's).
- [ ] **Step 2: After the restart,** each of `skill`'s names sums to its value across the reports (not 1); the secret
  check gains `B.sessionId` (the `'PRIVATE_'` canaries cover both lines).
- [ ] **Step 3: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialUsage.e2e.ts` once on the branch
  head (up to 15 minutes; one e2e run at a time). Expected: PASS; on failure the daemon log's last lines print.
- [ ] **Step 4: Commit** (`test(cli): a notice is quiet with the person there and rings without, end to end`).

### Task 7: Docs

**Files:** Modify `cli/AGENTS.md` (the devices row, the notice clause: "an agent's notice (`harness device notify`)…"),
`docs/cli.md` (the `harness device notify` row, 33), `docs/product-measurement.md` (the "Do agents use the dial
skill?" row, 155).

- [ ] **Step 1:** `cli/AGENTS.md`: a notice from an agent the person is with is held as a drawer row, never asked (no
  beep, no wake), counted for its agent's limits and not the hour's 20; `present`: for an agent outside a pane, the
  person's or the dial's prompt to it within 120 s, its known app in front and the agent the dial that moved last
  shows; for a Harness agent, its turn begun within 120 s with its tile on the window in front; the time of the
  person's last prompt to each outside agent, at most 64, in memory, gone when the agent leaves; an outside agent's
  ordinary turn end while the person is with it is silent (`rule:present`).
- [ ] **Step 2:** `docs/cli.md`: when the person is already with that agent (the same rule, in plain words), the card
  comes as a row in the dial's list with no sound and the command still prints `shown`; with the Notifications setting
  on All, an outside agent's ordinary finished turn the person is watching draws its tile alone.
- [ ] **Step 3:** `docs/product-measurement.md`: the row names `dial_notice_present` (a shown notice held quiet because
  the person was with that agent) and `dial_notice_present_answered_10m` (such a notice answered by the person's prompt
  within 10 min); a quiet notice counts as `shown` and opens no wait, so the waits and ring values stay rings.
- [ ] **Step 4: Commit** (`docs: the dial holds an ask quiet while the person is with its agent`).

## Verification

**Local gates PR CI does not run** (the tester, from a clean tree at the final head, on the Mac; receipts in the PR
body before it is marked ready):
- `python3 scripts/local-checks.py --run`: `--list` on this plan's paths names one gate, `cli-core` (`npm run
  test:core` in `cli`, for `src/services/devices.ts`); it prints the receipt fence.
- `cd cli && npm run typecheck && npx vitest run src/lib/dialUsageContract.spec.ts src/lib/dialNotice.spec.ts
  src/cable/notices.spec.ts src/cable/dialUsage.spec.ts src/services/devices.spec.ts src/architecture.spec.ts`.
- `cd backend && npm run typecheck && npx vitest run src/types/dialUsage.test.ts src/routes/productUsage.test.ts
  src/analytics/dailyDialReview.test.ts`.
- `cmp cli/src/lib/dialUsageContract.ts backend/src/types/dialUsage.ts` and `git diff --stat 225440b29e -- cli/src/core
  cli/src/architecture.coreFiles.txt cli/hook/notify.mjs` print nothing.

**PR CI, selected by the paths** (`scripts/ci-plan.py` `select` on them): `cli` (typecheck and tests), `backend`,
`pty`, `firmware`, `companions`, `cross-read-scan`, `windows-e2e` x64 (`cli/src/cable/` changed: the devices inside
the core's process on Windows, `dialWindows.e2e.ts` among its cases), `linux-e2e` (`E2E`, modified, and, as
`services/devices.ts` changed, the dial app eval's six files). Nothing dispatched by hand.

**End-to-end checks:**
1. **Quiet with the person there, a ring without, and both counted** (`E2E`, Task 6). Linux: PR CI's `linux-e2e` on
   `ubuntu-24.04`. Mac: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialUsage.e2e.ts`. By hand, only
   when a rerun is needed and never beside the automatic run: Actions → CI → Run workflow, `scope` `linux-e2e`,
   `e2e_files` `cli/e2e/dialUsage.e2e.ts`. Isolation is the suite's own (`cli/e2e/harness/daemon.ts` `IsolatedDaemon`):
   a throwaway home, data folder (the devices' listener socket in it), Claude and Codex homes, port and tmux server,
   never the everyday daemon on 18473; the in-memory `FakeBackend` with a made-up machine and token (no account, no
   production); a fake dial on a pseudo-terminal; fake Claude Code engines. A person sees the case pass: A's notice a
   drawer row with no question frame, B's a question frame, the report two new names with numbers only.
2. **The notice flows the tally line must not break** (`cli/e2e/deviceNotify.e2e.ts`, unmodified, so PR CI does not
   run it): on the Mac, once, `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceNotify.e2e.ts`.
   Isolated as above. Its `[device] notify · … · shown` and `rule:notice` reads still pass (Builder call 1).
3. **Windows:** `windows-e2e` x64 on PR CI (`windows-latest`): the dial end to end on a stand-in dial, where
   `harness device notify` with no session rings as before. No Windows-specific code changes.
4. **A real dial (optional, not needed for the merge; needs the user themselves: their dial, their eye, and their go
   to stop the everyday daemon for the check).** On the Mac with Harness Device running: the branch's daemon started
   with a data folder, Claude Code home and port of its own; Claude Code in Ghostty, prompted, and the dial turned to
   it; a `harness device notify … --waiting` from that session within 2 minutes adds a drawer row with no beep; with
   another app in front, a second session's notice beeps. The everyday daemon started again after.

**Numbers for the PR:** none on a hot path: `present` is a few map reads and one registry read per notice and per
outside turn end; the prompt hook adds one map write.

**PR-body notes:**
- Release order: backend, then CLI, as soon as the PR is merged (the spec: each part ships when done). An older backend drops each new name and counts `health_cli_report_unknown_metric`,
  keeping the rest of the report.
- Backend rule 3: no new query; `readDialRows`'s `$in` grows by six names (with `staff:` and `testing:`), read by the
  same index. Rule 5: growth from the vocabulary, no production read: at most 2 names × 3 prefixes = 6 rows a UTC day,
  removed by the existing TTL.
- "See what's shared" on Desktop and the phone already names agents' notices to the dial: no copy change.
- Platforms: macOS, Linux, Windows; presence needs a front report (Harness Device) or a Harness window, and without
  either a notice rings as today.

**Production:** no check runs against it.
