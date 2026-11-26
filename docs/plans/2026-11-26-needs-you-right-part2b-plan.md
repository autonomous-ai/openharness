# Needs you, right, Part 2b: a quiet card is looked at again when its turn ends. Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A notice held quiet because the person was with its agent is asked once, and rings, when that agent's turn
ends and the person is no longer with it; the summary after it stays silent, and one count says how often.

**Architecture:** At `dispatch`'s `done` card (`services/devices.ts`), read before the turn's start time (`began`) is
dropped, the devices ask Part 2's `present(agentId)`; a pending quiet card whose agent is not present is roused once the
done is sent: `Notices.rouse` (`cable/notices.ts`) takes one of the hour's twenty (`NoticeLimits.takeHour`,
`lib/dialNotice.ts`), closes the held id and asks the card under a new id. The devices count the rouse and open the wait
a rung notice opens. One name joins the dial vocabulary (CLI and its byte-identical backend copy) and `usage:daily`'s
Dial skill section. The core does not change.

**Tech Stack:** TypeScript (Node 24). CLI: Vitest (unit; `npm run test:core` 100% per file for `src/services/`; e2e on
the real daemon with a fake dial and the in-memory backend). Backend: Fastify, Vitest.

**Spec:** `docs/plans/2026-11-26-needs-you-right-design.md`, "Part 2b. A quiet card is looked at again when its turn
ends", with what it pulls from Design, Release order and Tests (decided by the PM, 2026-11-26). Part 2b reaches that
file through another pull request (Part 6's), so this branch does not edit the design file. Part 2 (#4650) is the base:
`feat/needs-you-right-rouse` at `bc217791f2`; line numbers below are on it.

**Commit 0 (before Task 1):** this plan alone:
`git add docs/plans/2026-11-26-needs-you-right-part2b-plan.md && git commit -m "docs: needs you, right: Part 2b's plan"`.

Paths: `DC` `cli/src/lib/dialUsageContract.ts`, `BT` `backend/src/types/dialUsage.ts` (its byte copy), `LN`
`cli/src/lib/dialNotice.ts`, `NT` `cli/src/cable/notices.ts`, `DU` `cli/src/cable/dialUsage.ts`, `DV`
`cli/src/services/devices.ts`, `BR` `backend/src/analytics/dailyDialReview.ts`, `RT`
`backend/src/routes/productUsage.test.ts`, `E2E` `cli/e2e/dialUsage.e2e.ts`. A CLI spec is the file with `.spec.ts` in
place of `.ts` (`DCS`, `LNS`, `NTS`, `DUS`, `DVS`); `BRT` is `BR`'s `.test.ts`.

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | The name, CLI and backend | `DC`, `DCS`, `BT`, `RT` | none | medium | `DCS` "nineteen names…"; `RT` "takes the dial skill's names" |
| 2 | The review's row | `BR`, `BRT` | 1 | medium | `BRT` "shows quiet notices rung at their turn's end…" |
| 3 | The rouse and its hour | `LN`, `LNS`, `NT`, `NTS` | none | high | `LNS` `takeHour` cases; `NTS` "a quiet card at its turn's end" cases |
| 4 | The rouse counted | `DU`, `DUS` | 1 | medium | `DUS` "roused" case |
| 5 | Devices: the look at the turn's end | `DV`, `DVS` | 3, 4 | xhigh | `DVS` "a quiet card at its turn's end" cases and the count case |
| 6 | End to end: quiet, then rung when the person left | `E2E` | 5 | high | none: a check of Tasks 1-5, no behavior of its own; one commit |
| 7 | Docs | `cli/AGENTS.md`, `docs/cli.md`, `docs/product-measurement.md` | none | medium | none: docs, one commit |

**Shared files:** none; no two tasks touch the same file.

**Longest chain:** four tasks, 1 → 4 → 5 → 6 (also 3 → 5 → 6). Ready at once: 1, 3, 7.

## Global Constraints

- **No core change.** `git diff --stat bc217791f2 -- cli/src/core cli/src/architecture.coreFiles.txt cli/hook/notify.mjs`
  prints nothing: no file joins `architecture.coreFiles.txt`, no request joins `core/api.ts`. No new file.
- **`DV` diff small and local** (Part 7's branch `fix/needs-you-right-codex-waits`, #4627 and #4564, also edit it): the
  `done` branch of `dispatch` (`DV` 1717-1732) and one helper beside `noticeShown` (`DV` 1984-1990). Nothing else in
  `DV` moves or is renamed.
- **`DC` and `BT` are the same bytes** (`backend/src/types/dialUsage.test.ts`); `DC` still imports nothing.
- **`src/services/devices.ts` stays 100% per file** under `npm run test:core`: every new branch in `DV` is hit by a
  `DVS` case.
- **The name, verbatim:** `dial_notice_present_roused` ("a quiet notice asked at its turn's end"). Not a flag.
- **Spec values:** the hour's limit is `NOTICE_HOUR_MAX` (20) in `NOTICE_HOUR_MS`; `PRESENT_MS` is 120 000 ms as Part 2
  set it; one ring a turn holds: the summary after a rouse is silent under `rule:notice`.
- **Unchanged:** a card that rang, a restored card, `working()`, `detached()`, the restart (`dial-notices.json`'s
  shape: a roused card is stored as any card, under its new id), questions, permission asks and failed turns, the
  `present` rule itself, Part 2's two counts, the dial firmware and its frames (`question.close`, `question`).
- **Counts only.** No notice text, agent, session, folder or id in a name, `dial-usage.json`, a report, a log line or
  a test's expected log.
- **Release** (the PM's, not a task here): backend first, then the CLI, before Part 3 or with it. **Platforms:** macOS,
  Linux, Windows; no platform-specific code.
- **No fixed sleeps** (fake timers, `vi.waitFor`, `until`, the fake engine's `!until`); no full suites locally while
  building (PR CI runs them); no CPU-hog loops on this Mac. Comments say why.

## What this plan decides from the spec's words

1. **Where the look runs.** In `dispatch`'s `done` branch, before `began.delete(event.agentId)` (`DV` 1720), the devices
   read once: `!event.subagent && !failedLast.has(event.agentId) && notices.quiet(event.agentId) && !present(event.agentId)`.
   They act on it inside `finish`, right after `void cable.turnDone(event.agentId)`, so the rouse's close and ask, which
   go through the agent's order (`inOrder`), always come after the turn's done, also when the done waits up to
   `TOKENS_WAIT_MS` for its tokens. A next turn that starts meanwhile ends the card (`endNotice`), and the rouse then
   finds none.
2. **The summary is left as it is.** `toDial` reads `notices.pending` as the summary comes (`DV` 1836); a roused card is
   still pending, so the summary ends `silent` under `rule:notice` with no change in the summary path. `rule:present`
   never applies after it (the notice branch comes first).
3. **A failed turn.** A failed turn reaches the devices as an `error` card (`core/turns/funnel.ts`
   `announceTurnAborted`, an outside agent's `error` state), which rings in `dispatch`'s error branch and never reaches
   the look. A `done` that follows an `error` in the same turn finds the agent in `failedLast` (set by the error, cleared
   by the next `processing`) and rouses nothing: one ring, the failed turn's.
4. **A silent `done`** rouses nothing (`event.subagent`): a sub-agent's turn end is not its agent's, and a turn the core
   gave up waiting on (`lib/commander.ts` `abandoned`, flagged the same way) is "given up on, not done", whose beep the
   core exists to remove.
5. **A new id.** The dial mutes an id it holds: `QuestionInbox.set` returns at once for the same id and questions, and
   `ask` refuses a held entry (`cable/questionInbox.ts` `set`, `ask`), so a question under the held id would never ring. The
   rouse closes the held id and asks under `SHOWN_ONLY_PREFIX + uuid()`, the path a newer notice that replaces a quiet
   one takes today. The card keeps its place in the order, its line, keys, host and `at`.
6. **The hour.** `NoticeLimits.takeHour()` counts one entry for the hour alone, read by no agent's own checks (its agent's
   limits were taken when it was shown). With the hour spent the card stays quiet and nothing is counted.
7. **No dial at the turn's end** (`connected()` false): the card stays quiet, no hour taken, nothing counted, so a dial
   that attaches later holds it, as "Unchanged: a dial that attaches later … hold the card, as today" reads. Decided
   by the PM (1).
8. **After a rouse the card is a live card** ("it loses `quiet`"): a reask after another question of its agent closes
   asks it, a dial that attaches later asks it, `working()` leaves it, its next turn or its agent leaving ends it. Decided
   by the PM (2).
9. **The counts.** `rouse` returns the card's kind (`noticeKind` of its line, whose fixed opening survives
   `roundDrawable`). The devices then call `usage.noticeRoused()` and, unless the kind is `proceeding`,
   `usage.waitOpened(\`notice:${agentId}\`, agentId)`: the wait a rung notice opens, so `dial_wait_*` and
   `dial_value_ring_*` count it from the rouse. `dial_notice_present` and `dial_notice_present_answered_10m` stay as
   Part 2 counts them (the notice was shown quiet).
10. **The review's row**, after `Quiet, answered: the person's prompt within 10 min`, against `noticed`:
    `Quiet, rung: the person had gone by its turn's end` (`dial_notice_present_roused`).
11. **No new log line.** The count is the measure; the turn end's tally stays `[cable] notify · silent · rule:notice ·
    notice · 0ms`.
12. **Stated limits, not tests:** an outside agent whose turns a window holds (`heldOnTab`) tells no `done`, so its card
    is not looked at again; a Harness agent's card still ends at the last dial's unplug (`detached`).
13. **Docs:** `cli/AGENTS.md`'s devices row, `docs/cli.md`'s `harness device notify` row and
    `docs/product-measurement.md`'s "Do agents use the dial skill?" row, where Part 2 described the quiet card.
    `cli/evals/dial-skill/flow/metrics.md` never describes the quiet card (checked): not touched.

## Review Focus

1. **A turn longer than 120 s with the person watching throughout** rings at its end: `present` cannot see a person past
   `PRESENT_MS` from their prompt (outside) or the turn's start (Harness). This is the spec's rule ("a Harness agent past
   120 s"). Pinned in Task 5.
2. **The next turn starting while the done waits for its tokens** (a message sent while the agent worked): the card
   ends, and nothing is asked after the done. Pinned in Task 5.
3. **An `error` card followed by a `done` in one turn**: one ring, the failed turn's, and the card left. Pinned in
   Task 5.
4. **A silent `done`** (a sub-agent's, or an abandoned turn's) before its agent's own: nothing asked until the agent's
   own `done`. Pinned in Task 5.
5. **The dial's mute of a held id**: the rouse rings only under a new id. Pinned in Task 3 (the calls) and Task 6 (a
   `question` frame on the dial after the turn ends).

---

### Task 1: The name, CLI and backend

**Files:** Modify `DC`, `DCS`, `BT` (a byte copy of `DC`), `RT`.

**Interfaces (produces):** `'dial_notice_present_roused'` at the end of `DIAL_DEVICE_METRICS` (`DC` 91, after
`'dial_notice_present_answered_10m'`), so in `DIAL_FILE_METRICS` and `DIAL_USAGE_METRICS`, typed as `DialFileMetric`.

- [ ] **Step 1: Write the failing tests.**
  - `DCS` (64): rename to `'names the dial skill\'s use: nineteen names, six of them computer flags'` and add the name
    to the first list; the flag list is unchanged.
  - `RT` `'takes the dial skill\'s names'` (449-458): add the name to its counters.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/dialUsageContract.spec.ts` and
  `cd backend && npx vitest run src/routes/productUsage.test.ts`. Expected: FAIL (the name missing; the route drops it).
- [ ] **Step 3: Implement** in `DC`, then `cp cli/src/lib/dialUsageContract.ts backend/src/types/dialUsage.ts`.
- [ ] **Step 4: Run** the same two, `cd backend && npx vitest run src/types/dialUsage.test.ts`, and `npm run typecheck`
  in `cli` and `backend`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat: name the dial's quiet notices rung at their turn's end`).

### Task 2: The review's row

**Files:** Modify `BR` (the `Dial skill` section, 138-139), `BRT`.

**Interfaces:** Consumes Task 1's name in `BT` (so in `DIAL_REVIEW_METRICS`).

- [ ] **Step 1: Write the failing test** `BRT` `'shows quiet notices rung at their turn\'s end after Quiet, answered'`
  (beside Part 2's case, 228): day-1 rows `dial_notice_installation_days` 6, `dial_notice_shown` 9,
  `dial_notice_present` 5, `dial_notice_present_answered_10m` 2, `dial_notice_present_roused` 3 → in the outside team's
  `Dial skill`, `Quiet, rung: the person had gone by its turn's end` is `{ computers: { day: 6 }, events: { day: 3 } }`,
  right after `Quiet, answered: the person's prompt within 10 min`; `DIAL_REVIEW_METRICS` contains the name.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/analytics/dailyDialReview.test.ts`. Expected: FAIL (no row).
- [ ] **Step 3: Implement** the `line(…)` row of decision 10.
- [ ] **Step 4: Run** the same and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(backend): the Dial skill section shows quiet notices rung at their turn's end`).

### Task 3: The rouse and its hour

**Files:** Modify `LN` (`NoticeLimits`, 112-134), `LNS`, `NT`, `NTS`.

**Interfaces (produces):**

```ts
// LN, NoticeLimits
/** One of the hour's NOTICE_HOUR_MAX for a quiet card asked at its turn's end (Notices.rouse): true when one is left, and
 *  it is then counted for the hour alone, read by no agent's own checks. A refusal counts nothing. */
takeHour(): boolean
// NT, Notices
/** That agent's turn ended and the person is no longer with it (services/devices.ts): its quiet card is asked once, under
 *  a new id, while a dial is attached and the hour has one left. The kind of the card asked; undefined when none was. */
rouse(agentId: string): NoticeKind | undefined
```

`rouse`: no card, a card not `quiet` (rung or restored), `!deps.connected()` or `!limits.takeHour()` → `undefined`,
nothing called. Else `deps.close(agentId, card.id)`, a new id `SHOWN_ONLY_PREFIX + deps.uuid()`, `quiet` deleted,
`deps.changed()`, `send(agentId)` (asked, or held back while another question of its agent is open), and
`noticeKind(card.line)`. `takeHour`'s entry is kept an hour and never matches an agent (it names none).

- [ ] **Step 1: Write the failing tests.**
  - `LNS` `describe('NoticeLimits')`:
    - `'a rouse takes one of the hour\'s twenty'`: nineteen `take('agent-i', 'x')` → true; `takeHour()` → true;
      `take('agent-19', 'x')` → false.
    - `'with the hour spent a rouse is refused and counts nothing'`: twenty takes; `takeHour()` → false; at 3 600 000 ms
      `takeHour()` → true.
    - `'a rouse is read by no agent\'s own limits, and quiet takes leave it room'`: `takeHour()` at 0, then
      `take('a', 'x')` at 0 → true; a fresh limits: 25 quiet takes (`take('q-i', 'x', false)`), then `takeHour()` → true.
  - `NTS`, `describe('Notices: a quiet card at its turn\'s end (Part 2b)')`, the rig as Part 2's (`desk()`,
    `state.present`), `asked = [{ key: 'notice', q: VPN, options: ['In Orca'] }]`:
    - `'it is asked once, under a new id, and is no longer quiet'`: present `a1` notifies (held `shown:u1`); `calls`
      cleared; `rouse('a1')` → `'plain'`; `calls` = `[['close', 'a1', 'shown:u1'], ['ask', 'a1', 'shown:u2', asked]]`;
      `quiet('a1')` false, `pending('a1')` true, `stored()[0].id` `'shown:u2'`, `state.changes` grew; `rouse('a1')`
      again → `undefined`, no call.
    - `it.each(['waiting', 'proceeding', 'plain'])('it answers the kind of a %s card')`: `composeNotice('q', 's', …)` →
      `rouse` returns that kind.
    - `'a rung card, a restored card and no card are left'`: `a2` not present, notified (asked) → `rouse('a2')`
      `undefined`, no call; `desk({ restored: [a kept card], clock })` → `rouse` of it `undefined`, no call;
      `rouse('none')` `undefined`.
    - `'with no hour left it stays quiet'`: twenty rung notices of `a1`…`a20` 1 s apart, then present `p` (held);
      `calls` cleared; `rouse('p')` → `undefined`, no call, `quiet('p')` true; at +3 600 000 ms `rouse('p')` →
      `'plain'`.
    - `'with no dial it stays quiet'`: present `a1` held; `state.connected = false`; `rouse('a1')` → `undefined`, no
      call, `quiet('a1')` true. (Decision 7, decided by the PM.)
    - `'covered by another question of its agent, it is asked as that one closes'`: `state.held.add('a1')`, present
      notify; `rouse('a1')` → `'plain'`, `calls` = `[['close', 'a1', 'shown:u1']]`; `held.delete`, `reask('a1')` →
      `[['ask', 'a1', 'shown:u2', asked]]` added, no redraw.
    - `'from then it is any rung card'`: after a rouse, `attached()` → `ask` `'shown:u2'` again; `working('a1')` → no
      call; `ended('a1')` → `['close', 'a1', 'shown:u2']`. (Decision 8, decided by the PM.)
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/dialNotice.spec.ts src/cable/notices.spec.ts`. Expected: FAIL
  (`takeHour`, `rouse` missing).
- [ ] **Step 3: Implement** in `LN` and `NT`.
- [ ] **Step 4: Run** the same specs and `cd cli && npm run typecheck`. Expected: PASS, the existing cases unchanged.
- [ ] **Step 5: Commit** (`feat(cli): a quiet card can be asked at its turn's end, within the hour's twenty`).

### Task 4: The rouse counted

**Files:** Modify `DU`, `DUS`.

**Interfaces:**
- Consumes: Task 1's name.
- Produces, in `DialUsage` (beside `noticeShown`, `DU` 58-60):

```ts
/** A notice held quiet was asked at its turn's end, the person gone (cable/notices.ts `rouse`). */
noticeRoused(): void
```

It adds `dial_notice_present_roused` and nothing else (the wait is the devices' call, as for a shown notice).

- [ ] **Step 1: Write the failing spec case** in `DUS` `describe('held quiet')` (995):
  `'a quiet notice asked at its turn\'s end is counted as roused'`: `noticeShown('a', true)`, `noticeRoused()` →
  `dial_notice_present_roused` 1, `dial_notice_present` 1; a prompt to `a` within 10 min → `dial_notice_answered_10m` 1
  and `dial_notice_present_answered_10m` 1, as before.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/dialUsage.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `DU`.
- [ ] **Step 4: Run** the same spec and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(cli): count the quiet notices rung at their turn's end`).

### Task 5: Devices: the look at the turn's end

**Files:** Modify `DV`, `DVS`.

**Interfaces:** Consumes Task 3's `Notices.rouse` and Task 4's `noticeRoused`. In `DV`, decision 1's read in the `done`
branch and, beside `noticeShown`:

```ts
/** Its turn ended with the person gone: its quiet card is asked (cable/notices.ts `rouse`), counted, and from then a
 *  wait on the person as a rung notice is, unless it proceeds (docs/plans/2026-11-26-needs-you-right-design.md, Part 2b). */
const rouseNotice = (agentId: string): void => …   // part.call('notices', …); count((usage) => …)
```

- [ ] **Step 1: Write the failing spec cases.** In `'an agent\'s notice …'` (8894), after
  `'an outside agent\'s turn end, the person there'` (9433), `describe('a quiet card at its turn\'s end
  (docs/plans/2026-11-26-needs-you-right-design.md, Part 2b)')`, `vi.useFakeTimers()`,
  `readers.answer.mockResolvedValue('Built.')`, `devices({ decideTier: null, now: () => Date.now() })`, with that
  block's `stop(port)` (turn-stop, then `STOP_HOOK_GRACE_MS`), `shownAsks()` and `processing(port)` as in
  `'the person is there'` (9108, 9128). `quietly(caller)`: the notice answers `shown` and one `hold` call holds its id.
  - `'the person gone at its end: asked once, under a new id, and the summary stays silent under rule:notice'`:
    `there(port)`, `quietly`, `host().front('vscode')`, `stop(port)` → `calls('questionClose')` = `[[ID, heldId]]`;
    `shownAsks()` = `[[ID, newId, card('Orca')]]`, `newId !== heldId`; `tiers()` = `[[ID, 'silent']]`; logs hold
    `'[cable] notify · silent · rule:notice · notice · 0ms'`; the cable's calls among `turnDone`, `questionClose`,
    `question`, `summary` come in that order.
  - `'the person still there: it stays held'`: no front change → no `shown:` ask, no `questionClose`; the summary
    silent under `rule:notice`.
  - `'a Harness agent past 120 s: asked'`: `bound()`, `processing(port)`, `port.desk(['h1'], true)`, `quietly` from
    `s-h1`, advance `PRESENT_MS + 1`, a `done` card for `h1` → one `shown:` ask for `h1` under a new id.
    `'a Harness agent within 120 s, its tile in front: held'`: the `done` at `PRESENT_MS` → none.
  - `'a failed turn rings as one and leaves it'`: outside, `there`, `quietly`, front `vscode`, `hook('turn-error')` →
    `turnError` for `ID`, no `shown:` ask, no `questionClose`. Harness: past 120 s, an `error` card, then a `done` card
    → one `turnError`, no `shown:` ask (decision 3).
  - `'a silent turn end leaves it'`: Harness past 120 s, a `done` with `subagent: true` → no ask; then its own `done`
    → asked.
  - `'its next turn starting while its done waits for the turn\'s tokens leaves nothing to ask'`: the `readUsage` rig of
    `'is silent when its next turn starts while it waits behind its turn\'s done'` (9389): `turn_started`,
    `processing`, tile on screen, `quietly`, past 120 s, `done` (its read waits), `turn_started`, the read answers →
    the held id closed once, no `shown:` ask.
  - `'with no dial at its end it stays held'`: outside, `there`, `quietly`, front `vscode`,
    `(seen.cable as unknown as { connected: boolean }).connected = false`, `stop(port)` → no `shown:` ask, no
    `questionClose` (decision 7, decided by the PM).
  - In `'the dial skill\'s use …'` (16576), beside `'a notice held quiet counts as such…'` (16716):
    `'a quiet notice asked at its turn\'s end counts as roused and opens its wait'`: fake timers, `withNotices()`,
    attached; the person with `sess-1` (front `orca`, `dialShows` it, `turn-start`); `'Waiting · Connect the VPN'` →
    held; front `vscode`; turn-stop and `STOP_HOOK_GRACE_MS`; the person's next prompt (`turn-start`) →
    `dial_notice_present` 1, `dial_notice_present_roused` 1, `dial_notice_present_answered_10m` 1, and the `dial_wait_`
    names sum to 1. The same with `'Proceeding · Use Redis'` on a fresh rig → `dial_notice_present_roused` 1, no
    `dial_wait_` name. The file holds no `sess-1`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t "at its turn's end"`. Expected: FAIL
  (the quiet card stays held at every turn end).
- [ ] **Step 3: Implement** decisions 1, 3, 4 and 9 in `DV`, within the two places Global Constraints name.
- [ ] **Step 4: Run** the same, the whole `DVS` once, `npm run typecheck`, `npm run test:core` (`devices.ts` 100%) and
  `npx vitest run src/architecture.spec.ts`. Expected: PASS; the core diff of Global Constraints prints nothing.
- [ ] **Step 5: Commit** (`feat(cli): the dial asks a quiet notice again when its turn ends with the person gone`).

### Task 6: End to end: quiet, then rung when the person left

**Files:** Modify `E2E`.

No test fails first: this checks what Tasks 1-5 deliver and changes no behavior; one commit. `cli/e2e/harness/` and
`cli/ci-e2e-durations.json` are not touched (a change there runs the linux-e2e canary; the file's hint is 351.6 s and
this adds well under a minute).

- [ ] **Step 1: A third outside session.** Beside `there` and `away` (`E2E` 138-143):
  `const left = await Outside.start(d, 'PRIVATE_LEFT_CANARY', { TERM_PROGRAM: 'ghostty' })`, pushed to `outsides`,
  waited for on the dial's list. After the `away` part (196):
  - `withFront('ghostty', left)`; `left.type('!until left-turn')` (the fake engine holds the turn until
    `left-turn.release`); its `turn.started` on the dial.
  - `notify(caller(left), …, ['PRIVATE_LEFT_CANARY needs the VPN', '--waiting'])` → `{ code: 0, out: 'shown' }`; a
    `notif.replace` holds `{ agentId: left.id, question: true }`; no `question` frame for `left.id` since its turn
    started.
  - `withFront('kitty', left)` (the person went to another app); then
    `writeFileSync(join(d.engineConfig.root, 'left-turn.release'), '')`.
  - A `question` frame for `left.id` with `id` matching `/^shown:/` comes; the `summary` for `left.id` after the release
    has `tier: 'silent'`; the log holds `[cable] notify · silent · rule:notice · notice · 0ms`.
  - `await turn(left, 'connected', 2)` answers it.
- [ ] **Step 2: The counts.** `skill` becomes `dial_notice_claude: 3, dial_notice_shown: 3, dial_notice_waiting: 3,
  dial_notice_answered_10m: 3, dial_notice_present: 2, dial_notice_present_answered_10m: 2,
  dial_notice_present_roused: 1`, the rest as now; the day's `dial_wait_` names sum to 2 (the rung notice's and the
  roused one's). The header comment says the third session's part; the secret check gains `left.sessionId`.
- [ ] **Step 3: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialUsage.e2e.ts` once on the branch
  head (up to 15 minutes; one e2e run at a time). Expected: PASS; on failure the daemon log's last lines print.
- [ ] **Step 4: Commit** (`test(cli): a quiet notice rings at its turn's end once the person left, end to end`).

### Task 7: Docs

**Files:** Modify `cli/AGENTS.md` (the devices row's notice clause: "… a notice from an agent the person is with held as
such a row from the start, never asked (no beep, no wake), counted for its agent's own limits and not the computer's 20
an hour, …"), `docs/cli.md` (the `harness device notify` row, 33), `docs/product-measurement.md` (the "Do agents use the
dial skill?" row).

- [ ] **Step 1:** `cli/AGENTS.md`: such a quiet card is asked once when its agent's turn ends and the person is no
  longer with it (a failed turn rings as one and leaves it), taking one of the hour's 20 then; with none left, or no
  dial attached, it stays a quiet row.
- [ ] **Step 2:** `docs/cli.md`, after "the card comes as a row in the dial's list with no sound, and the command still
  prints `shown`": if the person has left by the end of that agent's turn, the card rings then, once, and the turn's end
  makes no second sound.
- [ ] **Step 3:** `docs/product-measurement.md`: the metric column gains `dial_notice_present_roused`; the notes: present
  roused is a quiet notice asked at its turn's end because the person had gone; from then it is a ring and opens a wait
  (none for a proceeding one), so the waits and the ring values count it. "A quiet notice … opens no wait" becomes
  "until it is roused".
- [ ] **Step 4: Commit** (`docs: a quiet notice rings at its turn's end once the person has gone`).

## Verification

**Local gates PR CI does not run** (the tester, from a clean tree at the final head, on the Mac; receipts in the PR
body before it is marked ready):
- `python3 scripts/local-checks.py --run`: `--list` on this plan's paths names one gate, `cli-core` (`npm run
  test:core` in `cli`, for `src/services/devices.ts`); it prints the receipt fence.
- `cd cli && npm run typecheck && npx vitest run src/lib/dialUsageContract.spec.ts src/lib/dialNotice.spec.ts
  src/cable/notices.spec.ts src/cable/dialUsage.spec.ts src/services/devices.spec.ts src/architecture.spec.ts`.
- `cd backend && npm run typecheck && npx vitest run src/types/dialUsage.test.ts src/routes/productUsage.test.ts
  src/analytics/dailyDialReview.test.ts`.
- `cmp cli/src/lib/dialUsageContract.ts backend/src/types/dialUsage.ts` and `git diff --stat bc217791f2 -- cli/src/core
  cli/src/architecture.coreFiles.txt cli/hook/notify.mjs` print nothing.

**PR CI, selected by the paths** (`scripts/ci-plan.py`; the same files as Part 2, so the same suites): `cli`,
`backend`, `windows-e2e` x64 (`cli/src/cable/` changed), `linux-e2e` (`E2E`, modified, and, as `services/devices.ts`
changed, the dial app eval's six files), and what else the planner names. Nothing dispatched by hand.

**End-to-end checks:**
1. **Quiet with the person there, rung at the turn's end once they left, and counted** (`E2E`, Task 6). Linux: PR CI's
   `linux-e2e` on `ubuntu-24.04`. Mac: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialUsage.e2e.ts`.
   By hand, only when a rerun is needed and never beside the automatic run: Actions → CI → Run workflow, `scope`
   `linux-e2e`, `e2e_files` `cli/e2e/dialUsage.e2e.ts`. Isolation is the suite's own (`cli/e2e/harness/daemon.ts`
   `IsolatedDaemon`): a throwaway home, data folder (the devices' listener socket in it), Claude and Codex homes, port
   and tmux server, never the everyday daemon on 18473; the in-memory `FakeBackend` with a made-up machine and token
   (no account, no production); a fake dial on a pseudo-terminal; fake Claude Code engines. A person sees the case
   pass: the third session's notice a drawer row with no question frame, then a question frame once the turn ends with
   kitty in front, the turn's summary silent, the report naming `dial_notice_present_roused` with a number only.
2. **The notice flows that must not change** (`cli/e2e/deviceNotify.e2e.ts`, unmodified, so PR CI does not run it): on
   the Mac, once, `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceNotify.e2e.ts`. Isolated as above.
   A rung notice's turn still ends silent under `rule:notice` and its card is never asked again.
3. **Windows:** `windows-e2e` x64 on PR CI (`windows-latest`): the dial end to end on a stand-in dial. No
   Windows-specific code changes.
4. **A real dial (optional, not needed for the merge; needs the user themselves: their dial, their eye, and their go
   to stop the everyday daemon for the check).** On the Mac with Harness Device running: the branch's daemon started
   with a data folder, Claude Code home and port of its own; Claude Code in Ghostty, prompted with a long task, the dial
   turned to it; a `harness device notify … --waiting` from that session within 2 minutes adds a drawer row with no
   beep; the person switches to another app; when the turn ends the dial beeps once and pins the ask. The everyday
   daemon started again after.

**Numbers for the PR:** none on a hot path: at each turn's end, one map read (`quiet`) and, only with a quiet card,
Part 2's `present` read; a rouse is a close and an ask.

**PR-body notes:**
- Release order: backend, then CLI, before Part 3 or with it (the PM releases). An older backend drops the new name and
  counts `health_cli_report_unknown_metric`, keeping the rest of the report.
- Backend rule 3: no new query; `readDialRows`'s `$in` grows by three names (with `staff:` and `testing:`), read by the
  same index. Rule 5: growth from the vocabulary, no production read: at most 1 name × 3 prefixes = 3 rows a UTC day,
  removed by the existing TTL. In memory nothing new: the hour's entry is in `NoticeLimits`' list, at most 20 hour
  entries.
- Platforms: macOS, Linux, Windows; no platform-specific code.

**Production:** no check runs against it.

## Decided by the PM (2026-11-26)

1. **No dial attached at the turn's end** (decision 7): the card stays quiet, takes none of the hour's twenty and is not
   counted; a dial that attaches later holds it, as today.
2. **A roused card afterwards** (decision 8): it is a rung card from then, as the spec's "it loses `quiet`" reads: a dial
   that attaches after the rouse, or the close of another question of its agent, asks it and rings.
