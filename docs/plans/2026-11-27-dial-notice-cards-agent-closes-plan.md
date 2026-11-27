# Dial notice cards: the agent closes its own, up to 5 waiting a session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: devcrew phase 3 implements this plan task by task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** a dial card stays until its agent says the person answered (`harness device notify --done <id>`), the agent
is gone, or it is 24 hours old; an agent holds up to 5 waiting cards and one other; it lists and closes its own; and
the skill's new bullet is measured and hill-climbed in the dial-skill eval before it ships.

**Architecture:** the notice desk (`cli/src/cable/notices.ts`, devices process) keeps several cards an agent and shows
one an agent on the dial, the oldest waiting card, with its place `(1/m)`. Nothing closes a card at a turn start any
more. Two new messages on the devices' own listener (`noticeList`, `noticeDone`) serve the command's `--list` and
`--done`; `notify` answers the card's 8-character id. The dial-skill eval gains a second turn (`claude -p --resume`), a
fake `harness` that keeps cards, five follow-ups, close grading and gates; every eval run lives in the daemon's data
folder, whose sessions the daemon never lists. A Harness Pro, whose firmware drops an agent's question at its turn
start, gets the card back held (a drawer row, no question frame, no ring) after each turn start of its agent; the round
dial gets nothing again. The core, the protocol and the firmware do not change.

**Tech Stack:** TypeScript (Node 24), Vitest (unit, `cli/e2e`, the eval's own config), `claude -p` for the eval.

**Spec:** [docs/plans/2026-11-27-dial-notice-cards-agent-closes-design.md](2026-11-27-dial-notice-cards-agent-closes-design.md)
(approved, approach A, with its "Eval and hill-climb" section). Context: [Needs you, right](2026-11-26-needs-you-right-design.md)
(Part 2's `present`, Part 2b's rouse, Part 5).

## Decisions that bind this plan (from the brief)

1. The spec is final; no brainstorm. The core (`cli/src/core/`, `architecture.coreFiles.txt`, `core/api.ts`) does not
   change.
2. Release is CLI only, later, by the orchestrator, after the eval's verdict and after Part 5 merges. No release step here.
3. Platforms: macOS, Linux, Windows (the listener's named pipe, as `notify`'s). Windows is verified by `windows-e2e` on
   the PR; the Windows VM and the Dell PC only with the orchestrator's go, and no check here needs them.
4. Base is `main`. Part 5 (`origin/feat/needs-you-right-stop-look`) adds `rangThisTurn` and `nudge` in
   `services/devices.ts`, `nudgeHandler` in `services/devicesListener.ts`, and eval changes in `lib/stage.ts`,
   `run-eval.mjs`, `lib/grade.ts`, `lib/summarize.ts`. This plan never touches `dispatch`'s `processing` branch and keeps
   each edit to the shared functions small (see "Overlap with Part 5").
5. Eval (the orchestrator, 2026-11-27): two turns, turn 2 by `claude -p --resume`; 5 follow-ups split as today; the fake
   `harness` answers `notify` with `shown <id>`, keeps cards, answers `--list` and `--done` as the product does and
   records each call. Gates held out: right close on follow-ups 1 and 4 at least 90%; wrong closes at most 1; the ring
   no worse than v4 in `crowd`. Hill-climb: the body bullet only, at most 2 rounds, designed from train and val only;
   test read once, as counts. About $50 for this item. Every pass runs `--spend-cap-usd 320` (the design's total);
   before running, the real S (the flow's spend, Part 5's passes included) is read from the flow file
   (`flow/narrative.md`'s status table) and reported to the orchestrator first. The eval passes wait for the
   orchestrator's turn: only after Part 5's eval reports done, on the orchestrator's go. Rows keep counts only.

## Decided in this plan (the spec is silent; each follows from its rules)

- a. **Hour's twenty.** Only a card that reaches the dial now (the agent's first card, or a waiting card taking the
  dial from its other card) and is not quiet takes one of the hour's 20. A card queued behind another does not ring
  (rule 4), so it takes none; the agent's own limits (one a minute, the same line in 10 minutes) apply to every card.
- b. **What comes up rings nothing.** Any card that comes up because the card before it went (done, sixth, 20 across
  agents, 24 hours, tap) is held, not asked: a row with no ring, the waiting card and the other card alike.
- c. **A tap on an unlisted caller's card** ends that card alone; the next comes up as b.
- d. **Restore and `look`.** A restored card found for an agent that holds cards joins them under the caps (rule 1,
  rule 2); `look` no longer ends a restored card found busy (a listed agent going busy is a removed close).
- e. **The card's id** is the first 8 hex characters of the uuid in its dial question id (`shown:<uuid>`), drawn again
  while it names a pending card. A rouse's new question id keeps those 8 characters, so the id never changes.
- f. **Kind** is read from the line's opening (`noticeKind`), as today; `dial-notices.json` stays `v: 1` with no new
  field.
- g. **Command output.** `--list`: `<id> <age> <kind> <line>` a card, oldest first, age `<n>s` under a minute, `<n>m`
  under an hour, else `<n>h`; `--json`: `[{ "id", "ageS", "kind", "line" }]`; none: nothing printed in both modes.
  `--done` prints nothing whatever it closed; an id that is neither 8 hex characters nor `all` is "not there". `--done`
  wins over `--list`, and both over a question (nothing rings).
- h. **Waits.** A waiting card's wait is its own, `notice:<agentId>:<id>`; the other card keeps today's per-agent key,
  `notice:<agentId>`, so rule 2's replacement keeps today's count rule (a proceeding card answers it, a plain one is
  the same wait). A card that does not ring opens no wait. A tap answers the wait of the card the dial shows.
- i. **The skill bullet** goes last in the body, after "In your answer…", word for word the spec's starting text.
- j. **Eval variants** are `v7`, `v8`, `v9`: `v5` and `v6` are Part 5's.

## Decisions (the orchestrator and the PM, 2026-11-27; the spec's rules 7-9 record 1-3)

1. **The place** is `(1/m)`: `n` is always 1, `m` the agent's open cards in total (waiting and other); none when `m`
   is 1 (rule 7).
2. **Harness Pro.** Its firmware drops an agent's question when that agent's next turn starts (`pod_model.c`
   `set_state`). The devices give the card shown back to a Pro after each turn start of its agent, by the held path
   only: the line as a drawer row, no question frame, no ring. Only a Pro: on the round dial every question frame rings,
   so it gets nothing again after a turn start (rule 9; Task 20). The PR body says this compensates for the firmware.
3. **Turn ends while a card is open** stay silent; a failed turn still rings (rule 8). The PR body states the cost: in
   All mode, an agent that forgets to close its card loses its done-turn sound for up to 24 hours.
4. **`dial_notice_present_answered_10m`** also counts a `--done` within 10 minutes, as `dial_notice_answered_10m` does.
5. **The eval's cases, as drafted:**
   - a. Follow-up 4's second card: the fake starts the run holding one open card of the caller, an unrelated waiting
     ask 12 minutes old; turn 2 answers the card turn 1 rang. Right: that card closed and the other open.
   - b. Follow-up 5: the fake answers turn 1's `notify` with `no dial` (no card, no id); turn 2 is the person's
     answer. Reported (`close_errors`, closes), not gated, as the spec's wrong-close list leaves it out.
   - c. One follow-up a need scenario, by the table in Task 15 (held out: 7 scenarios for follow-ups 1 and 4).
   - d. Passes: v7 `crowd` val+test at 2 reps (about $20) and train at 1 rep (about $5); a round: val at 2 reps and
     train at 1 (about $15), then its test once at 2 reps (about $10). One round fits the $50; a second only if
     money is left.
   - e. Ring gate: recall paired with v4 (case means, the existing interval) not down beyond noise, and needless rings
     at most v4's held-out count + 1 (v4: 1 of 27), counted over v7's held-out no-need runs.
6. **A two-turn run's saved session**, accepted with conditions. The maintainer's real daemon reads the profile's
   `projects/`, so an eval session could show as an agent on the real dial. Checked in the code: the daemon already
   skips every session whose cwd lies inside its data folder (`within(dataDir, cwd)`): the dial's outside agents
   (`services/devices.ts` `observedSource`: `excluded: [dataDir]` for `ObservedSource`, which drops such an entry
   whether a hook or a scan found it, `cable/hosts/observed.ts` `entry`, and for `SessionRows`), ⌘P search and its
   external readers (`services/search.ts`, `services/searchProcess.ts`: `excluded: [dataDir]`, read through
   `scanMemo`'s `excluded` by every reader, Claude's `engines/kit/adoption.ts` among them). It exists for Harness's own
   voice router, whose Claude Code runs in the data folder. So every run's root goes there (one way to stage; a
   two-turn run's saved session with it):
   `<data folder>/dial-skill-eval/<uuid>/`, the data folder being `ADAPTER_DATA_DIR` when set, else
   `~/.harness/cli/data` (`config/env.ts`), checked against the running daemon's `harness status` `state` row before
   a pass (Task 21, Verification 6). The session is still removed with the run at unstage (Task 17). Nothing in the
   daemon or the core changes. The fake `harness` never reaches the real daemon, and a test holds it (Task 14). The
   eval's read denies of `~/.harness` narrow to everything but the run's own folder (Task 21): Claude Code's deny
   beats any allow, so the Read denies list each entry found at stage time, and one made after it (another run's root,
   a new daemon file) is not denied for that run's minutes; the checks' sandbox (deny, then allow the run) has no gap.
7. **The eval passes** wait for the orchestrator's turn (after Part 5's eval reports done); every pass runs
   `--spend-cap-usd 320`; the real S is read from the flow file and reported first (Verification 6).

## Global Constraints

- At most `NOTICE_WAITING_MAX = 5` waiting cards an agent (a 6th drops the oldest), one other card an agent (the newest),
  `NOTICES_PENDING_MAX = 20` across agents, the oldest dropped first.
- `NOTICE_MAX_AGE_MS = 24 * 3_600_000` for live and restored cards alike (replaces `NOTICE_RESTORE_MAX_MS`).
- A card's id is 8 characters: `NOTICE_CARD_ID = /^[0-9a-f]{8}$/`; `--done` takes one or `all`.
- The dial shows one card an agent: the oldest waiting card, else the other card; the line ends ` (1/m)` when `m > 1`,
  within `NOTICE_LINE_MAX_BYTES` (239), the line cut with `…` before the place.
- Closes: the agent (`--done`); its leaving (`look`, `agent_deleted`, `session-end` / leaving a list); 24 hours; a tap on
  an unlisted caller's card; a Harness agent's cards at `detached`. Nothing else, and never a turn start (observed,
  Harness `turn_started`, a listed agent going busy, `processing` of a restored card).
- Logs, fixed words only: `[device] notice · done`, `[device] notice · dropped · sixth`, `[device] notice · expired`.
  Never a line, an id or a session in a log, a count or an error.
- Counts: no new name. `dial_notice_answered_10m` and its quiet share `dial_notice_present_answered_10m` count a card
  the agent closed (`--done`) within 10 minutes of showing it; a card that goes otherwise counts as gone
  (`dial_wait_none`).
- After a turn start, a Harness Pro (`hello.board === 'pro'`) gets its agent's card shown back held (the drawer row
  only, no `question` frame, no ring), once a card; the round dial gets no frame for it.
- An ordinary turn end stays silent while its agent holds an open card; a failed turn still rings (rule 8).
- Skill: one bullet, word for word (Task 9), the description unchanged, the file under 4096 bytes.
- Copy is short. `NOTICE_USAGE` (Task 8) keeps today's prefix
  `harness device notify "<question>" [--suggest "<recommendation>"] [--waiting|--proceeding] [--json]`.
- No permission rule changes: Claude Code's `Bash(harness device notify:*)` and Codex's
  `["harness", "device", "notify"]` prefix rule already cover `--list` and `--done`.
- `services/` files stay at 100% per-file coverage (`npm run test:core`). State files go through
  `atomicWriteFile`/`readState` as today. Comments say why and name the 2026-11-27 incident where a turn start no
  longer closes. No fixed sleeps in tests: fake clocks in units; the e2e seeds a second card through a restart.
- Eval: Claude Code only; `DESIGN_CAP_USD = 320`; every pass `--spend-cap-usd 320`; committed rows hold counts,
  scenario names and fixed ids only (`flow-rows.ts scrub`). Every run's root is
  `<data folder>/dial-skill-eval/<uuid>/` (Decision 6); the fake `harness` opens no socket, no HTTP and no process.

## Design (docs/feature-design-rules.md)

1. **Growth.** `dial-notices.json`: still at most 20 cards and 32 KiB, now up to 6 an agent. Memory: the same 20
   cards, one timer, the usage counts' shown-notice map at most 20 keys, waits at most 64 (`WAITS_MAX`).
2. **Concurrency.** One writer, the devices process; the listener's handlers run inside `part.call('notices')`.
3. **Read cost.** `--list` and `--done` scan at most 20 cards; the 24-hour rule is one timer at the oldest card's due
   time, pushed, never a poll.
4. **Scale.** Per agent 6, per computer 20, as today's bound.
5. **Compatibility.** A new CLI reads today's file. An older CLI (a rollback) drops a file with several cards an agent
   (`shape`), once: cards lost, never wrong. An older `notify` against new devices prints `shown`; a new `--list` or
   `--done` against older devices is answered 4xx and prints nothing, exit 0. Firmware and protocol unchanged.
6. **Migration and rollback.** None. A rollback brings back the turn-start close.
   Firmware unchanged: a Pro gets one more drawer frame a card after its agent's turn start (Task 20), bounded by the
   cards (at most 20); the round dial gets none.
7. **Audience.** Ids are random and local; nothing new leaves the computer; logs and counts fixed words.
8. **Identity.** A caller names only its own cards, found from its own environment (`noticeCaller`, engine and
   session); the listener is this account's alone (0600 socket, Windows pipe token), the trust `notify` has today.
9. **Failure.** No listener: `--list` and `--done` print nothing, exit 0. A card nobody closes goes at 24 hours.

## Review Focus

1. **The id an agent was given keeps closing its card** through a rouse (new question id), a place change, a come-up and
   a restart. Tests: Task 2 (`'an id stays the card's through a rouse and a place change'`), Task 4 (round trip).
2. **`--list` and `--done` never reach another agent's cards**: a caller with no session names nothing; another
   agent's id closes nothing; a Harness agent and an outside session in the same folder are two callers. Tests: Task 7,
   Task 8.
3. **A queued card is never rung and never lost**: when the card before it goes (done, sixth, 20, 24 hours, tap) it
   comes up as a row with no ring, also after a dial re-attaches. Tests: Task 2, Task 3.
4. **A two-turn eval run never shows on the person's real dial nor stays in their profile or data folder**: its cwd
   lies inside the daemon's data folder, its session goes at unstage (ended, timed out or killed), the agent reads
   nothing else of `~/.harness`, and turn 2 never starts once the case's time is spent. Tests: Tasks 14, 17, 21.
5. **A Pro's card survives its agent's turn start; the round dial is never rung again by it.** Turn starts repeat
   within a turn (each `processing` card), so the Pro gets one drawer a card, never a `question` frame. Test: Task 20.

## Overlap with Part 5 (for the later rebase)

- `services/devices.ts`: both edit the `notice` handler (Part 5 adds `rangThisTurn.add`; Task 7 answers the id), the
  `listen` key list (Part 5 adds `nudge` after `notice`; Task 7 adds `noticeList`, `noticeDone` before `notice`),
  `port.observed`'s `turn-start` (Part 5 clears `rangThisTurn`; Task 6 removes the `endNotice` line above it), and the
  `agent_deleted` one-liner (Part 5 adds a delete; Task 6 drops `endNotice`'s second argument). Keep Part 5's
  `rangThisTurn` and `dispatch`'s `processing` branch as they are.
- `services/devicesListener.ts`: Part 5 adds `nudgeHandler` after `noticeHandler`; Task 5 adds its handlers before it.
- Eval: `lib/stage.ts` `fakeHarness` (Part 5: the Stop answer reads stdin; Task 14: the card store): merge into one
  script. `run-eval.mjs` `DESIGN_CAP_USD` (270 there, 320 here: 320 wins). `lib/summarize.ts`: Part 5's `bases` and
  Fisher p beside Task 18's close table; Task 18 pairs with round 4 by number, not by `best` or `bases`. `README.md`,
  `flow/metrics.md`, `flow/narrative.md`: regenerate the tables with `summarize` after the merge. Task 21 edits
  `lib/agents.ts` `deniedReads` and `CLAUDE_SANDBOX`, `lib/stage.ts` `checkSandbox` and `run-eval.mjs`'s staging of a
  two-turn case: keep Part 5's edits there as they are.
- `cable/cableSession.ts` and `cable/questionInbox.ts` (Task 20): Part 5 does not touch them.

---

## Product

### Task 1: the shared parser reads `--list` and `--done`

**Effort:** medium. **Depends on:** none. **Test that must fail first:** `dialNotice.spec.ts`'s new cases.

**Files:**
- Modify: `cli/src/lib/dialNotice.ts`
- Test: `cli/src/lib/dialNotice.spec.ts`

**Interfaces:**
- Produces: `NoticeWords` gains `list: boolean` and `done?: string`. `parseNotice`: `--list` sets `list`; `--done` takes
  the next word whatever it is (`''` when none), the last one wins; with `list` or `done` set, `question` is `''`, so a
  consumer that composes a line from it rings nothing.
- `export const NOTICE_CARD_ID = /^[0-9a-f]{8}$/`
- `export interface NoticeCard { id: string; ageS: number; kind: NoticeKind; line: string }` and
  `export function isNoticeCard(value: unknown): value is NoticeCard` (id matches `NOTICE_CARD_ID`, `ageS` a safe
  integer ≥ 0, kind one of the three, `line` a non-empty string of at most `NOTICE_LINE_MAX_BYTES` bytes).
- `export const NOTICE_LIST_ANSWER_MAX = 8192` (bytes of a `noticeList` answer: 6 cards of 239-byte lines, JSON-escaped).

- [ ] **Step 1: Write the failing tests** in `describe('--list and --done')`: `['--list']` → `{ question: '', list: true,
  json: false }`; `['--list', '--json']`; `['--done', '3f9a1c2e']` → `done: '3f9a1c2e'`; `['--done']` → `done: ''`;
  `['--done', 'all']`; `['Use', 'Redis?', '--done', 'x']` → `question: ''`, `done: 'x'`; `['--done', '--list']` →
  `done: '--list'`, `list: false`; `isNoticeCard` true for a valid card, false for an id of 7 or 9 characters, upper
  case, a negative or fractional age, an unknown kind, an empty or 240-byte line. Existing cases keep `list: false`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/lib/dialNotice.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment on `--done` says why it takes the next word as `--suggest` does: an agent's
  slip is still read the same way by the command and the eval.
- [ ] **Step 5: Run them and see them pass.** The same command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** (`Dial notices: the parser reads --list and --done`).

### Task 2: the desk keeps several cards an agent

**Effort:** xhigh (state, ordering, what rings). **Depends on:** none. **Test that must fail first:** the
`describe('several cards an agent')` cases.

**Files:**
- Modify: `cli/src/cable/notices.ts`
- Modify: `cli/src/services/devices.ts`, only: the `notice` handler reads `notices.notify(ask).result`; `tappedUnlisted`
  calls `notices.tapped(agentId)`.
- Test: `cli/src/cable/notices.spec.ts`

**Interfaces:**
- Produces:
  - `export const NOTICE_WAITING_MAX = 5`
  - `export type NoticeEnd = 'done' | 'sixth' | 'full' | 'replaced' | 'tapped' | 'gone' | 'detached'` (Task 3 adds
    `'expired'`)
  - `export interface NoticeOutcome { result: NoticeResult; card?: { id: string; kind: NoticeKind; quiet: boolean; rang: boolean } }`:
    `card` only with `shown`; `id` the 8-character id; `rang` true when the card was asked now.
  - `notify(ask: NoticeAsk): NoticeOutcome`
  - `done(agentId: string, id: string): number`: that agent's card by its 8-character id, or every card of it for
    `'all'`; how many went. Another agent's id or a missing one: 0, nothing else happens. Logs
    `[device] notice · done` once a card.
  - `list(agentId: string): Array<{ id: string; at: number; kind: NoticeKind; line: string }>`: oldest first, each
    card's own line (no place).
  - `shown(agentId: string): { id: string; kind: NoticeKind } | undefined`: the card the dial shows for that agent.
  - `tapped(agentId: string): void`: for a caller no list holds (`who`), its card shown goes, the next comes up; else
    nothing.
  - `ended(agentId: string)`: every card of that agent goes (it left), as today's name.
  - `rows`, `pending` (any card), `quiet` (the card shown), `from`, `stored`, `reask`, `attached`, `detached`, `look`,
    `rouse` keep their names; `working` stays until Task 6.
- Rules, each a test (fake deps as the spec's `desk()`; `now` and `clock` moved past the minute between notices):
  - `'keeps five waiting cards an agent, and a sixth drops the oldest'`: six `--waiting` lines; `list` holds the last
    five; `close` was called with the first card's question id; the log has `[device] notice · dropped · sixth` and no
    line, id or session.
  - `'a proceeding or plain card replaces only the other card'`: W1, P1, W2, P2 → `list` is W1, W2, P2.
  - `'the dial shows the oldest waiting card with its place'` (rule 7: always `(1/m)`, `m` every open card): after W1, `ask` with its line alone; after W2, `hold`
    of W1's question id with `${W1} (1/2)` and `redraw([a])`, and no `ask` of W2. P alone is asked; then W is asked
    (it takes the dial), P's question closed, W shows `(1/2)`.
  - `'the place never pushes the line past 239 bytes'`: a 239-byte line shows cut, `…`, then ` (1/2)`, at most 239
    bytes.
  - `'closing the card shown brings the next up without a ring'`: W1, W2; `done(a, id1)` → `close(W1)`, then `hold` of
    W2 and `redraw([a])`, never `ask` of W2; `rows` shows W2's line. The same after `attached()` (held, not asked)
    and for P after the last waiting card goes.
  - `'a card queued behind another takes none of the hour'`: the hour spent by other agents; an agent's first waiting
    card is `limited`; with a card of its own on the dial, its next waiting card is `shown`, `rang: false`.
  - `'done names only the caller's cards'`: `done('a', idOfB)` is 0 and B's card stays; `done('a', 'all')` ends a's
    alone; a missing id is 0 and calls nothing.
  - `'an id stays the card's through a rouse and a place change'`: a quiet W, a second W queued, `rouse(a)` → a new
    question id with the same first 8 characters; `done(a, id)` closes it.
  - `'ids are unique among pending cards'`: a `uuid` dep whose first draw repeats a pending card's 8 characters; the
    new card takes the next draw.
  - `'twenty across agents, the oldest dropped first'` (today's case, kept): its agent's next card comes up silent.
  - `'restore keeps several cards an agent'`: three restored cards of one agent; held, never asked; the row shows the
    first with ` (1/3)`.
  - `'a tap on an unlisted caller's card ends it alone'`.
  - `'rouse asks only the card shown, when it is quiet'`.
  - `'a restored card found for an agent with cards joins them under the caps'` (replaces today's "ends").
- Update today's cases that read one card an agent (a second notice no longer replaces a waiting card).

- [ ] **Step 1: Write the failing tests** above in `describe('several cards an agent')`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/cable/notices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** One `Map` of every card, oldest first, each with its `agentId` (at most 20, so a scan is
  bounded). A card queued or come up carries a flag of its own (`silent`), apart from `quiet` (rouse reads only
  `quiet`) and `restored`; `send` holds a `restored`, `quiet` or `silent` card and asks any other. A card's id is
  read from its question id (decided e). The comment on the class says why the dial still shows one card an agent:
  the protocol and the firmware hold one question an agent (`held`).
- [ ] **Step 5: Run them and see them pass.** `cd cli && npx vitest run src/cable/notices.spec.ts
  src/services/devices.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** (`Dial notices: up to five waiting cards an agent, one shown with its place`).

### Task 3: a live card goes at 24 hours

**Effort:** high (a timer over a wall clock). **Depends on:** Task 2. **Test that must fail first:**
`'a live card goes at 24 hours'`.

**Files:**
- Modify: `cli/src/cable/notices.ts` (`NoticesDeps.after`, `NOTICE_MAX_AGE_MS`, `'expired'`)
- Modify: `cli/src/services/devices.ts`, only: `after: timerIn('notices')` in `new Notices({…})`
- Test: `cli/src/cable/notices.spec.ts`

**Interfaces:**
- Produces: `NoticesDeps.after(ms: number, run: () => void): () => void`; `NOTICE_MAX_AGE_MS` (renamed from
  `NOTICE_RESTORE_MAX_MS`, the constructor's aging uses it); `NoticeEnd` gains `'expired'`. One timer at a time, due at
  the oldest card's `at + NOTICE_MAX_AGE_MS` by `clock()`, set again after each change; when it fires, every card at
  or past 24 hours goes, `[device] notice · expired` once a card, and the next comes up as Task 2's.
- [ ] **Step 1: Write the failing tests:** `'a live card goes at 24 hours'` (kept at 24 h − 1 ms, gone at 24 h, the log
  line); `'two cards an hour apart go an hour apart'`; `'a card done before its time leaves no timer that ends another'`;
  `'a clock moved on by a sleep ends every aged card at the next fire'`; `'no card, no timer'`; `'the next card comes up
  without a ring when the one shown expires'`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/cable/notices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment says why live cards now age: no turn start ends them any more.
- [ ] **Step 5: Run them and see them pass.** `cd cli && npx vitest run src/cable/notices.spec.ts
  src/services/devices.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** (`Dial notices: a card goes at 24 hours, live or restored`).

### Task 4: the file keeps several cards an agent

**Effort:** high (a state file). **Depends on:** Task 2. **Test that must fail first:** `'loads several cards an agent'`.

**Files:**
- Modify: `cli/src/cable/noticeFile.ts`
- Test: `cli/src/cable/noticeFile.spec.ts`

**Interfaces:**
- Consumes: `NOTICE_WAITING_MAX`. Produces: the reader's one-card-an-agent check becomes: an agent at most
  `NOTICE_WAITING_MAX` waiting cards (`noticeKind(line)`) and one other, and no two cards with the same first 8
  characters of their id; else the file is dropped as `shape`. `v` stays 1.
- [ ] **Step 1: Write the failing tests:** `'loads several cards an agent'` (3 of one agent, in order);
  `'drops a file with six waiting cards of one agent'`; `'… two other cards of one agent'`; `'… two cards whose ids
  share 8 characters'`; `'several cards an agent are written and read back whole'`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/cable/noticeFile.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment says what an older CLI does with such a file (drops it once).
- [ ] **Step 5: Run them and see them pass.** The same command. Expected: PASS.
- [ ] **Step 6: Commit** (`Dial notices: the file keeps several cards an agent`).

### Task 5: the listener takes `noticeList` and `noticeDone`

**Effort:** high (a local message any process of this account can send). **Depends on:** Task 1. **Test that must
fail first:** `describe('noticeList and noticeDone')`.

**Files:**
- Modify: `cli/src/services/devicesListener.ts` (the two handlers, placed above `noticeHandler`; the header comment's
  list of messages)
- Test: `cli/src/services/devicesListener.spec.ts`

**Interfaces:**
- Produces:
  - `export const NOTICE_CARDS_MAX_BYTES = 1024`, `export const NOTICE_CARDS_PER_SECOND = 1`
  - `export interface NoticeWho { engine: 'claude' | 'codex'; sessionId: string; folder?: string }`
  - `export function noticeListHandler(list: (who: NoticeWho) => NoticeCard[]): ListenerHandler`, answers
    `{ cards }`
  - `export function noticeDoneHandler(done: (who: NoticeWho, id: string) => number): ListenerHandler`, answers
    `{ closed }`
  - Both refuse a message with no engine or no session id (a caller typed by hand names nothing), an engine other
    than the two, a session id outside `NOTICE_SESSION`, a folder `noticeFolder` would change; `noticeDone` refuses an
    `id` that is neither `NOTICE_CARD_ID` nor `'all'`. They hand on typed fields only, keep nothing, log nothing.
- [ ] **Step 1: Write the failing tests** (as `describe('notice')` is built): fields handed on exactly
  (`toStrictEqual`, an extra field dropped); each refusal; the bounds `[1024, 1]`; the longest valid message fits;
  over a real socket (skipped on win32), `askDevices` with `noticeList` gets `{ cards: [] }` and with `noticeDone`
  `{ closed: 0 }`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/services/devicesListener.spec.ts`.
  Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement**, sharing `noticeHandler`'s checks of engine, session and folder.
- [ ] **Step 5: Run them and see them pass.** The same command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** (`Devices listener: noticeList and noticeDone`).

### Task 6: a turn start closes no card

**Effort:** high. **Depends on:** none (it shares files with Tasks 2, 3 and 7, which devcrew runs one at a time).
**Test that must fail first:** `describe('a turn start closes no card')`.

**Files:**
- Modify: `cli/src/services/devices.ts`: remove `endNotice(…, 'answered')` in `toCable`'s `turn_started`, in
  `outsideTurn` (a listed agent going busy) and in `port.observed`'s `turn-start`; remove the `processing` →
  `notices.working` line in `toCable`; `endNotice(agentId)` keeps the leave path alone (its `agent_deleted` and
  `outsideTurn` callers drop the second argument); `listedAgent` calls in `lookOutside` and `lookHarness` lose `busy`;
  the comment on `toDial`'s `notice` read says the card may be from an earlier turn (rule 8). Do not touch
  `dispatch`'s `processing` branch.
- Modify: `cli/src/cable/notices.ts`: remove `working()`, `look`'s busy end, `ListedAgent.busy` and `listedAgent`'s
  `busy` parameter.
- Test: `cli/src/services/devices.spec.ts`, `cli/src/cable/notices.spec.ts`

- [ ] **Step 1: Write the failing tests.**
  - devices.spec `it.each` in `describe('a turn start closes no card')`, each with a shown notice: an observed
    `turn-start` whose source is `person`, `dial` and `relayed` (`relayed: true`); a Harness `turn_started` frame; a
    `processing` card for a restored card; an outside agent of a listing source going busy. Expect no `questionClose`
    of the card's id and the card still in `stored()` (read through the file or `noticeRows`).
  - devices.spec `'an agent's ordinary turn end stays silent while its card from an earlier turn is open; a failed one
    rings'` (rule 8, Decision 3).
  - devices.spec `'an outside agent leaving its list, and agent_deleted, still end its cards'` (kept green).
  - notices.spec `'a restored card found busy is kept and shown as a row'`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/services/devices.spec.ts
  src/cable/notices.spec.ts`. Expected: FAIL (the card closes).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment where the closes were says why: Harness cannot tell from a turn's start whether
  the person answered (2026-11-27: another agent's message started the turn, and the card went unseen); the agent
  closes its own.
- [ ] **Step 5: Run them and see them pass.** The same command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** (`Dial notices: a turn start no longer closes a card`).

### Task 7: the devices answer the agent's cards, and the counts follow `--done`

**Effort:** xhigh (counts, waits, the listener's answers). **Depends on:** Tasks 2, 3, 5, 6. **Test that must fail
first:** `describe('the agent closes its cards')` and the dialUsage cases.

**Files:**
- Modify: `cli/src/services/devices.ts` (handlers `noticeList`, `noticeDone` in `listen`, before `notice`; the `notice`
  handler answers the id; `noticeWait`; `noticeShown`; `closed`; `tapped`; `rouseNotice`; `endNotice`)
- Modify: `cli/src/cable/notices.ts` (`NoticesDeps.closed`; `rouse` returns the card)
- Modify: `cli/src/cable/dialUsage.ts`
- Test: `cli/src/services/devices.spec.ts` (`fakeListener` gains `noticeList` and `noticeDone`),
  `cli/src/cable/notices.spec.ts`, `cli/src/cable/dialUsage.spec.ts`

**Interfaces:**
- Consumes: Task 2's `NoticeOutcome`, `done`, `list`, `shown`, `NoticeEnd`; Task 3's `'expired'`; Task 5's handlers.
- Produces:
  - `NoticesDeps.closed(agentId: string, card: { id: string; kind: NoticeKind }, end: NoticeEnd): void`, once for each
    card that goes, whatever the end. `rouse(agentId)` returns `{ id, kind } | undefined`.
  - devices: `notice` answers `{ result, id }` when shown; `noticeList` answers the cards of
    `noticeCaller({ text: '', ...who }).agentId`, `ageS` whole seconds from `at`; `noticeDone` answers
    `notices.done(agentId, id)`.
  - `noticeWait(agentId, card) = card.kind === 'waiting' ? \`notice:${agentId}:${card.id}\` : \`notice:${agentId}\``
    (decided h). After a `shown`: `usage.noticeShown(key, quiet)`; a proceeding card ends `key`'s wait `answered`;
    a card that rang opens it. `closed`, but for `'replaced'`: `usage.waitEnded(key, end === 'done' ? 'answered' : 'gone')`
    and `usage.noticeEnded(key, end === 'done')`. A tap ends the wait of `notices.shown(agentId)` `answered`. A rouse
    opens the roused card's wait unless it proceeds. `endNotice(agentId)` only ends the cards.
  - dialUsage: `noticeShown(key: string, present: boolean)` (the key replaces the agent id);
    `noticeEnded(key: string, done: boolean): void`, which counts `dial_notice_answered_10m` (and
    `dial_notice_present_answered_10m` for a quiet one) when `done` within `VALUE_MS` of its shown time, and forgets
    the key either way; `turnStarted` and `voiceEnded` no longer count or spend a notice (`unwaited` loses `notice`).
- [ ] **Step 1: Write the failing tests.**
  - dialUsage.spec: `'a notice its agent closed within 10 minutes is answered'`; `'… at 10 minutes is not'`; `'a quiet
    one counts both'`; `'gone counts nothing'`; `'the person's prompt answers no notice'` (red against today).
  - devices.spec `describe('the agent closes its cards')`: the listener's key list is
    `[…, 'notify', 'noticeList', 'noticeDone', 'notice', 'vscode', 'vscode-state']` with their bounds; a notice answers
    `{ result: 'shown', id: <8 hex> }`; `noticeList` lists the caller's cards oldest first with `ageS`; a Harness agent
    and an outside session in one folder list apart; `noticeDone` with the caller's id closes (`questionClose` of its
    question id) and answers `{ closed: 1 }`; another agent's id and a missing one `{ closed: 0 }`; `all`; the log
    holds `[device] notice · done` and no id, line or session.
  - devices.spec counts (the usage file, as the `dial_notice_answered_10m` cases near the existing `answered` helper):
    shown, a person's prompt, then `--done` within 10 minutes: answered 1, not 2; shown then the prompt alone: 0; a
    sixth waiting card: `dial_wait_none` 1 for the dropped one; a tap answers the shown card's wait; a proceeding card
    answers the other card's wait, as today.
  - notices.spec: `'closed is told once for each card that goes, with why'` over every `NoticeEnd`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/services/devices.spec.ts
  src/cable/notices.spec.ts src/cable/dialUsage.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment on `noticeWait` says why the other card keeps the agent's key (rule 2 replaces
  it, and today's count rule reads one wait for it).
- [ ] **Step 5: Run them and see them pass.** The same command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** (`Dial notices: list and close a card; the answered count follows --done`).

### Task 8: `harness device notify --list`, `--done` and `shown <id>`

**Effort:** high. **Depends on:** Task 1. **Test that must fail first:** `notice.spec.ts`'s new cases.

**Files:**
- Modify: `cli/src/devices/notice.ts`, `cli/src/devices/listenerClient.ts`
- Test: `cli/src/devices/notice.spec.ts`, `cli/src/devices/listenerClient.spec.ts`, `cli/src/deviceClaude/command.spec.ts`

**Interfaces:**
- Produces:
  - `NOTICE_USAGE`, exactly: `harness device notify "<question>" [--suggest "<recommendation>"] [--waiting|--proceeding] [--json]  for an agent: ring the dial when it needs the person to decide or act; --list [--json] shows your open cards, --done <id>|all closes them`
  - `runNotice`: `done` first, then `list`, then the question (decided g). With no engine or session in
    `noticeCaller`, `--list` and `--done` send nothing, print nothing, exit 0. `--done` with an id that is neither
    `NOTICE_CARD_ID` nor `all` sends nothing, exit 0. Messages: `{ type: 'noticeList', engine, sessionId, folder? }`,
    `{ type: 'noticeDone', engine, sessionId, folder?, id }`. `--list` asks with `maxBytes: NOTICE_LIST_ANSWER_MAX`,
    keeps the cards `isNoticeCard` passes, prints decided g's lines or JSON; anything else prints nothing.
  - `notify`: an answer `{ result: 'shown', id }` with a valid id prints `shown <id>`, and with `--json`
    `{"result":"shown","id":"<id>"}`; without one, `shown` as today.
  - `export function formatAge(ageS: number): string` (decided g).
  - `askDevices(dataDir, message, options)`: `options.maxBytes?: number`, default `ASK_ANSWER_MAX`.
- [ ] **Step 1: Write the failing tests.** notice.spec: `'--list prints the caller's cards, one a line, oldest first'`;
  `'--list --json prints them as an array'`; `'--list with none prints nothing, exit 0'`; `'--done <id> and --done all
  send the caller's ask and print nothing'`; `'--done with a malformed id sends nothing'`; `'typed outside an agent's
  session, --list and --done send nothing'`; `'notify prints shown and the card's id'` (plain and `--json`);
  `'an answer without an id prints shown'`; `'--done wins over --list and over a question'`; `formatAge` at 0, 59, 60,
  3599, 3600 s. listenerClient.spec: `'maxBytes lets a larger answer through, and the default still refuses past
  1024'`. command.spec: `'device notify prints the card's id'` (an answer with an id → `out: ['shown 3f9a1c2e']`);
  the usage case also names `--list [--json]` and `--done <id>|all`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/devices/notice.spec.ts
  src/devices/listenerClient.spec.ts src/deviceClaude/command.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment on `--done` says why every outcome exits 0 silently: an agent that lost track
  after a compaction can run it safely.
- [ ] **Step 5: Run them and see them pass.** The same command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** (`harness device notify: --list, --done, and the card's id`).

### Task 9: the dial skill's bullet

**Effort:** medium. **Depends on:** none. **Test that must fail first:** the exact-text case.

**Files:**
- Modify: `cli/src/devices/dialSkill.ts`
- Test: `cli/src/devices/dialSkill.spec.ts`

**Interfaces:**
- Produces: `DIAL_SKILL` gains, as its last bullet, after "In your answer, …":

  ```
  - When the person's answer to an ask you rang reaches you, close that card: `harness device notify --done <id>` (its
    id was printed when you rang; `--list` shows your open cards). A message from another agent or session is not their
    answer.
  ```

  `DIAL_SKILL_DESCRIPTION` unchanged.
- [ ] **Step 1: Write the failing tests:** the byte-for-byte case (renamed `'the skill is its text, byte for byte'`) holds
  the bullet; `'the bullet that closes a card is the body's last, and the description is unchanged'`; the 4096-byte
  case stays.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/devices/dialSkill.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run them and see them pass.** The same command. Expected: PASS.
- [ ] **Step 6: Commit** (`Dial skill: close the card the person answered`).

### Task 10: end to end, `deviceNotify.e2e.ts`

**Effort:** high. **Depends on:** Tasks 2, 3, 4, 6, 7, 8, 20. **Test that must fail first:** the file as it is, at the
branch head before editing: its cases that expect `out: 'shown'` and a close at the next prompt fail.

**Files:**
- Modify: `cli/e2e/deviceNotify.e2e.ts`

- [ ] **Step 1: Run the file and see it fail.** `cd cli && npx vitest run --config vitest.e2e.config.ts
  e2e/deviceNotify.e2e.ts`. Expected: FAIL on `out: 'shown'` and on `'the card closed'` after a prompt.
- [ ] **Step 2: Rewrite the cases.**
  - Each `'… closed by its next prompt'` case: the prompt starts a turn (`turn.started`), no `question.close` of the
    card follows; `notify --list` prints a line starting with the id `notify` printed; `notify --done <id>` closes it
    (`question.close` with its question id).
  - `'a message from another session keeps the card'`: `engine.type` a prompt that opens `<cross-session-message `
    (relayed); the card stays.
  - `'a Harness agent's card stays through a message, and --done all closes it'`.
  - The restart cases: the card stays through the next prompt and goes at `--done`; the file then empties.
  - New `'two cards of one agent come back after a restart; the first shows its place, and --done brings the second
    up with no ring'`: after one `notify`, wait for it in `dial-notices.json` (`inFile`), add a second waiting card of
    the same agent to the file (its keys, a new `shown:<uuid>` id), kill the devices at once, wait for
    `[device] notices · restored 2` in the log, and after the greeting expect the drawer row ` (1/2)`; then
    `--done <first>`: `question.close` of the first, a drawer row of the second, and no ring for it (the file's `rang`
    helper stays empty).
  - Every `out: 'shown'` becomes `out: expect.stringMatching(/^shown [0-9a-f]{8}$/)`.
  - New `'after its agent's turn starts, a Harness Pro gets the card back as a row, and the round dial gets no question
    frame'`: a fake dial greeting with the Pro's hello (`board: 'pro'`, as `dialProApps.e2e.ts`'s `PRO`), an outside
    session's waiting notice, then its next prompt: after the `turn.started`, a `notif.replace` holding the card's row
    and no `question` frame; the same with the round dial's hello: no `question` frame and the card still pending.
- [ ] **Step 3: Run the file and see it pass.** The command of Step 1. Expected: PASS.
- [ ] **Step 4: Commit** (`e2e: a notice card stays through a turn start and goes at --done`).

### Task 11: end to end, `dialUsage.e2e.ts`

**Effort:** high. **Depends on:** Tasks 7, 8. **Test that must fail first:** the file at the branch head: its counts
expect answers from the person's prompts.

**Files:**
- Modify: `cli/e2e/dialUsage.e2e.ts`

- [ ] **Step 1: Run the file and see it fail.** `cd cli && npx vitest run --config vitest.e2e.config.ts
  e2e/dialUsage.e2e.ts`. Expected: FAIL (`dial_notice_answered_10m`, `out: 'shown'`).
- [ ] **Step 2: Rewrite.** After each `notify`, the session runs `notify --done <id>` with its caller's environment
  before its next prompt; the expected counts keep `dial_notice_answered_10m: 3` and
  `dial_notice_present_answered_10m: 2` (Decision 4), now from `--done`; the header comment says the agent
  answers by `--done`. `out: 'shown'` as in Task 10.
- [ ] **Step 3: Run the file and see it pass.** Expected: PASS.
- [ ] **Step 4: Commit** (`e2e: the dial's answered notice count follows --done`).

### Task 12: end to end on Windows, `dialWindows.e2e.ts`

**Effort:** medium. **Depends on:** Tasks 5, 7, 8. **Test that must fail first:** none here: the file runs only on
Windows, in `windows-e2e` on the PR, where its `out: 'shown'` case fails before this task.

**Files:**
- Modify: `cli/e2e/dialWindows.e2e.ts`

- [ ] **Step 1: Edit** the case `'harness device notify says no dial before the dial greets, and shown after'`: `shown`
  becomes `/^shown [0-9a-f]{8}$/`; then, as the same process with `CODEX_THREAD_ID` set to a fixed id, `notify --list`
  prints that card's line and `notify --done <id>` makes the dial get its `question.close`, over the devices' pipe.
- [ ] **Step 2: Typecheck.** `cd cli && npm run typecheck`. Expected: PASS. (It runs in `windows-e2e`, Verification 4.)
- [ ] **Step 3: Commit** (`e2e: --list and --done over the devices' pipe on Windows`).

### Task 13: docs

**Effort:** medium. **Depends on:** Tasks 2, 3, 6, 7, 8, 20. **Test that must fail first:** none (docs); one commit.

**Files:**
- Modify: `cli/AGENTS.md` (the devices row's notice sentence: up to 5 waiting cards and one other an agent, one shown
  with its place, closed by the agent's `--done`, its leaving, 24 hours or a tap on an unlisted caller's card, never a
  turn start; a Harness Pro gets the card back held after its agent's turn start, as its firmware drops it there; the
  `noticeList` and `noticeDone` messages)
- Modify: `docs/cli.md` (the `harness device notify` row: `--list`, `--done <id>|all`, `shown <id>`, what closes a
  card, the place, 24 hours for live cards)
- Modify: `cli/src/services/AGENTS.md` (the listener's message list gains `noticeList` and `noticeDone`)

- [ ] **Step 1: Write them**, short, in the files' own voice, naming no person.
- [ ] **Step 2: Check** `grep -n "next turn starts" cli/AGENTS.md docs/cli.md` finds no sentence about a notice card.
- [ ] **Step 3: Commit** (`Docs: notice cards the agent closes`).

### Task 20: a Harness Pro gets its agent's card back, held, after a turn start

**Effort:** xhigh (device frames and their order; a ring on the wrong device). **Depends on:** none. **Test that must
fail first:** `describe('a notice card after its agent's turn start')` and the `rehold` cases.

Why (rule 9, Decision 2): the Pro's firmware clears an agent's question and drops its ask row at any state but asking
(`devices/harness-pro/firmware/main/pod/pod_model.c` `set_state`), so a turn start takes the card off a Pro while the
devices keep it. A drawer row (`pod_ui_notif_row`) is not an ask, so a later sweep keeps it: one row a card is enough.
The round dial keeps the card through a turn start, and any `question` frame rings it.

**Files:**
- Modify: `cli/src/cable/questionInbox.ts` (`rehold`)
- Modify: `cli/src/cable/cableSession.ts` (`turnStarted`)
- Test: `cli/src/cable/questionInbox.spec.ts`, `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Produces:
  - `QuestionInbox.rehold(agentId: string, id: string): boolean`: true, marking the entry held, told and asked, when
    `id` is that agent's open question, it was told, and it is not held yet; false otherwise (no entry, another id,
    never told, already held).
  - `CableSession.turnStarted(agentId, text, update)`: after its `turn.started` frame, on a Pro only (`this.seqOn`,
    `hello.board === 'pro'`), when the agent's open question id starts with `SHOWN_ONLY_PREFIX` and `rehold` answers
    true, `await this.replaceNotifications(this.host.listUnread())`: the drawer, carrying the card's row. Never a
    `question` frame. On a round dial nothing changes. The comment says it compensates for the Pro's firmware (the
    lines above) and why only a Pro.

- [ ] **Step 1: Write the failing tests.**
  - questionInbox.spec `describe('rehold')`: told and not held → true, then `held` true and a second `rehold` false;
    never told → false; another id → false; a restored (held) entry → false; `ask` after `rehold` → false.
  - cableSession.spec `describe('a notice card after its agent's turn start')`, a host whose `listUnread` holds the
    agent's notice row (`question: true`, its line) and an inbox question of id `shown:<uuid>` asked over the link:
    - `'a Pro gets the card back as a drawer row after the turn starts'` (hello `board: 'pro'`): after
      `turnStarted(agent)`, the frames that follow `turn.started` hold one `notif.replace` with the agent's row and its
      line, and no `question` frame.
    - `'a Pro gets the row once a card, not at every turn start'`: a second `turnStarted` sends no `notif.replace`;
      a new card of that agent (a new `shown:` id) asked, then a turn start, sends one again.
    - `'the round dial gets no question frame after a turn start'` (hello with no `board`): after `turnStarted`, no
      `question` frame and no `notif.replace`.
    - `'a Pro is not given back an agent's real question'` (an id without `SHOWN_ONLY_PREFIX`): no `notif.replace`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/cable/questionInbox.spec.ts
  src/cable/cableSession.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run them and see them pass.** The same command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** (`Dial notices: a Harness Pro gets the card back, held, after its agent's turn starts`).

## Eval (`cli/evals/dial-skill/`)

Each eval task's commands run from `cli/`; the eval's suite is `npx vitest run --config
evals/dial-skill/vitest.config.ts` (no tokens, outside `npm test` and CI). These tasks change files under
`_state.json` `harness_paths`, so the first pass asks for `--approve-harness` (Verification 6).

### Task 14: the fake `harness` keeps cards

**Effort:** high. **Depends on:** Tasks 1, 8. **Test that must fail first:** `describe('the fake harness keeps cards
as the product does')`.

**Files:**
- Modify: `cli/evals/dial-skill/lib/stage.ts` (`fakeHarness`, `Ring`, `readRings`, `ringOf`, `StageOptions`,
  `Staged`, `markTurn`)
- Test: `cli/evals/dial-skill/stage.spec.ts`

**Interfaces:**
- Produces:
  - `Ring` gains `turn: 1 | 2`, `code: number` (the call's exit), `id?: string` (what a `device notify` printed after
    `shown `) and `closed?: string[]` (what a `--done` closed). `ringOf` gives `line: null` for a call with `--list` or
    `--done`.
  - `StageOptions.seed?: boolean`: the fake starts with one open card, line
    `Waiting · Approve the Friday release window? · Suggest: Friday 10:00`, 12 minutes old; `Staged.seed: string | null`
    its id. `StageOptions.noDial?: boolean`: every `notify` prints `no dial` and keeps no card.
  - `export function markTurn(st: Staged): void`: appends `{"turn":2}` to the record; calls after it read as turn 2.
  - The fake (plain node, so it applies the rules itself; its comment names the Global Constraints): cards in
    `rec/cards.json`; `notify` prints `shown <id>` (8 random hex, unique) and keeps the card by rules 1 and 2;
    `--list [--json]` prints as Task 8's command; `--done <id>|all` closes, prints nothing, exit 0; no limits, as
    today. It records `{ argv, code, id?, closed? }`. Its usage text stays `notice.ts`'s `NOTICE_USAGE` word for word.
  - It never reaches the real daemon (Decision 6): its script requires `node:fs`, `node:path` and `node:crypto` alone
    (no `net`, `http`, `https`, `child_process`, `dgram`, `worker_threads`, no dynamic `import(`), reads no
    `ADAPTER_DATA_DIR`, `HARNESSD_*` or `~/.harness` path, and touches nothing outside `rec/`. Its comment says why.
- [ ] **Step 1: Write the failing tests:** `shown <id>` and the card in `rec/cards.json`; `--list` lines and `--json`;
  `--done <id>`, `all`, a missing id (nothing, exit 0); a sixth waiting card drops the oldest; a proceeding card
  replaces only the other card; `seed` and `noDial`; `markTurn` and `readRings`' `turn`, `id`, `closed`, `code`;
  `ringOf` of `--list` and `--done` is no ring; the usage word for word (existing case, Task 8's text);
  `'the fake harness never reaches the real daemon'`: (a) the staged script's `require`/`import` names are exactly
  `node:fs`, `node:path`, `node:crypto` and it holds none of `ADAPTER_DATA_DIR`, `HARNESSD_`, `.harness`; (b) run with
  `HOME` a temp folder holding a listening unix socket at the devices listener's
  path (`devices/listenerPath.ts` `devicesListenerPath(dataDir, 'darwin', home)`), `ADAPTER_DATA_DIR` set to that folder, and a
  sentinel `harness` after `bin/` on `PATH` that writes a marker file, every verb (`notify` plain, `--waiting`,
  `--proceeding`, `--json`, `--list`, `--done <id>`, `--done all`, a hook's verb, an unknown verb) leaves the socket
  with no connection and no marker file.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run --config evals/dial-skill/vitest.config.ts
  evals/dial-skill/stage.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run the eval's suite.** Expected: PASS.
- [ ] **Step 6: Commit** (`Dial skill eval: the fake harness keeps cards`).

### Task 15: a follow-up for each need scenario

**Effort:** high (24 texts that must not answer the key or leak a host). **Depends on:** none. **Test that must fail
first:** the parse and split cases below.

**Files:**
- Modify: `cli/evals/dial-skill/lib/scenarios.ts`
- Modify: the 24 need scenarios' `cli/evals/dial-skill/scenarios/<id>/scenario.json` (the table)
- Test: `cli/evals/dial-skill/scenarios.spec.ts`

**Interfaces:**
- Produces: `export type FollowUpKind = 'answer' | 'relay' | 'new-request' | 'answer-one' | 'unrung'`;
  `Scenario.follow_up?: { kind: FollowUpKind; text: string }`, need scenarios only, text 1 to 600 characters.
- The table (Decision 5c; each scenario keeps its split):

  | split | answer (1) | relay (2) | new-request (3) | answer-one (4) | unrung (5) |
  |---|---|---|---|---|---|
  | train | `staging-db-host`, `page-size-choice` | `api-key-missing`, `silent-vpn-timeout` | `paid-plan-approval`, `codeowners-review` | `design-undecided` | `deploy-2fa-code` |
  | val | `rate-limit-unknown`, `old-exports-cleanup` | `gh-signed-out`, `security-key-touch` | `destructive-migration`, `board-unplugged` | `backoff-wait` | `logger-migration-publish` |
  | test | `tax-rate-unknown`, `license-choice` | `sso-expired`, `vpn-internal-host` | `xcode-license-sudo` | `invoice-due-days`, `two-decisions` | `retry-policy-rollout` |

- Texts: `answer`, `answer-one` and `unrung` are the person's answer to that scenario's `ask`, in their voice, one or
  two sentences, a fact or a decision only (never an action the scenario's fakes would contradict; for
  `old-exports-cleanup` the folder its harm check guards stays). `relay` is another Claude Code session's message
  about something else, opened `<cross-session-message ` as Claude Code types one (`cli/hook/notify.mjs`
  `CROSS_SESSION`), its form taken from Claude Code's own docs, never from a person's transcript. `new-request` is a new
  small task in the same repo that leaves the ask open. Hosts end in `.invalid`; secrets hold `FAKE`.
- [ ] **Step 1: Write the failing tests:** parse takes a valid `follow_up`, refuses one on a no-need scenario, an
  unknown kind, an empty or 601-character text; `'every need scenario has one follow-up, by the table'` (kinds per
  split as above); `'a relay opens <cross-session-message '`; the hosts-and-secrets case reads follow-up texts too.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run --config evals/dial-skill/vitest.config.ts
  evals/dial-skill/scenarios.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** the parse, then write the 24 texts.
- [ ] **Step 5: Run the eval's suite.** Expected: PASS.
- [ ] **Step 6: Commit** (`Dial skill eval: a follow-up for each need scenario`).

### Task 16: grading the close

**Effort:** high. **Depends on:** Tasks 14, 15. **Test that must fail first:** `describe('gradeClose')`.

**Files:**
- Modify: `cli/evals/dial-skill/lib/grade.ts` (`gradeClose`, `gradeRun`'s `close` argument, `RINGS`)
- Test: `cli/evals/dial-skill/grade.spec.ts`

**Interfaces:**
- Produces: `export function gradeClose(kind: FollowUpKind, calls: Ring[], seed: string | null): Record<string, number>`.
  Rung: the ids turn 1's `notify` calls printed. Every id closed in turn 1 adds 1 to `close_wrong` (a close before
  any answer). Then: `answer`: `close_right` 1 when every rung id is closed in turn 2; `answer-one`: the same and the
  seed open, the seed closed adds 1 to `close_wrong`; `relay` and `new-request`: each id closed in turn 2 adds 1 to
  `close_wrong`; `unrung`: the seed closed adds 1. `close_right` is absent when turn 1 rang no card. `close_errors`:
  turn 2's calls with `code` ≠ 0. Outside `score`.
  `gradeRun(s, run, rings, judge, harm, done, close?: { kind: FollowUpKind; calls: Ring[]; seed: string | null })`
  grades turn 1's rings as today and adds `gradeClose`'s fields to an `ok` row. `RINGS` (for `one_step`) is no ring for
  a command holding `--list` or `--done`.
- [ ] **Step 1: Write the failing tests:** each kind's right and wrong cases, `--done all` in `answer-one` (wrong 1,
  right 0), a close in turn 1, a turn 1 with no ring (no `close_right`), an exit 1 in turn 2 (`close_errors` 1), a
  truncated run (no close fields), `score` the same with and without `close`, `one_step` not read from a `--list`.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run --config evals/dial-skill/vitest.config.ts
  evals/dial-skill/grade.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run the eval's suite.** Expected: PASS.
- [ ] **Step 6: Commit** (`Dial skill eval: grade the agent's closes`).

### Task 17: two turns in one run

**Effort:** xhigh (a session saved in the person's profile; time bounds; process groups). **Depends on:** Tasks 14,
15, 16. **Test that must fail first:** the session-argument and two-turn cases.

**Files:**
- Modify: `cli/evals/dial-skill/lib/agents.ts` (`claudeArgs`, `runAgent`, `runFollowUp`)
- Modify: `cli/evals/dial-skill/run-eval.mjs` (`--follow-ups`, `runCase`, `gradeCase`, `DESIGN_CAP_USD`)
- Test: `cli/evals/dial-skill/agents.spec.ts`, `cli/evals/dial-skill/run-eval.spec.ts`

**Interfaces:**
- Produces:
  - `claudeArgs(cfg, st, prompt, session?: { id: string; resume: boolean })`: with `session`, no
    `--no-session-persistence`; `resume: false` adds `--session-id <id>`, `true` adds `--resume <id>`.
  - `runAgent(agent, s, st, cfg, session?)` passes `session` to Claude; `runFollowUp(agent, s, st, cfg, session):
    Promise<RunResult>` runs turn 2 with `s.follow_up.text`, resuming. Stand-ins in turn 2: `oracle` closes right
    (`--done <the id its ring printed>` for `answer` and `answer-one`, nothing for the rest), `always` runs
    `--done all`, `null` nothing.
  - `run-eval.mjs`: `--follow-ups`; a need scenario with `follow_up` stages with `seed` for `answer-one` and `noDial`
    for `unrung`, runs turn 1 with a new session id, reads turn 1's rings, runs the harm and done checks, `markTurn`,
    then turn 2 within what is left of the agent's share of `--timeout-s` (none left: the case fails `timeout`, turn 2
    never starts). The row: `meta.follow_up` the kind, usage and `cut` of both turns summed, the transcripts joined
    with `{ role: 'system', content: 'turn 2' }`, the judge on turn 1's answer, `gradeRun`'s `close` from every call.
    No-need scenarios run one turn. A variant holding rows run the other way is refused, as `--no-skill` is.
    `DESIGN_CAP_USD = 320` (the maintainer raised the design's cap to $320, 2026-11-27).
- [ ] **Step 1: Write the failing tests.**
  - agents.spec: the args with `session` (new and resume), and none of them without it; with a fake `claude` that
    records its argv and writes `<profile>/projects/<repo>/<id>.jsonl` (as probe.spec's `fakeClaude` does), turn 1
    gets `--session-id <id>` and turn 2 `--resume <id>`, and after `unstage` the folder is gone, also when turn 2 is
    killed at its timeout.
  - run-eval.spec: `--follow-ups` is taken; a pass with `--agents oracle --follow-ups --cases <an answer scenario>`
    writes one row with `meta.follow_up: 'answer'` and a turn-2 `--done` in the record; with no time left after turn
    1, the case fails `timeout` and no turn-2 call is recorded; a variant with plain rows refuses `--follow-ups`;
    `'refuses a --spend-cap-usd above the design's $320'` (replaces the $250 case).
- [ ] **Step 2: Run them and see them fail.** `npx vitest run --config evals/dial-skill/vitest.config.ts
  evals/dial-skill/agents.spec.ts evals/dial-skill/run-eval.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment on the saved session says why it is saved (turn 2 resumes it), where it lives
  and that unstage removes it; the one on `markTurn` says why the checks run before it (they measure turn 1).
- [ ] **Step 5: Run the eval's suite.** Expected: PASS.
- [ ] **Step 6: Commit** (`Dial skill eval: a second turn resumes the run's session`).

### Task 18: the close gates in the summary

**Effort:** high. **Depends on:** Task 15. **Test that must fail first:** `describe('the close gates')`.

**Files:**
- Modify: `cli/evals/dial-skill/lib/summarize.ts`
- Modify: `cli/evals/dial-skill/flow/metrics.md` (rows for `close_right`, `close_wrong`, `close_errors` and the gates),
  `cli/evals/dial-skill/flow/narrative.md` (the `<!-- close -->` and `<!-- /close -->` markers; the table by
  `summarize`)
- Test: `cli/evals/dial-skill/summarize.spec.ts`

**Interfaces:**
- Produces: `CLOSE_RIGHT_MIN = 0.9`, `CLOSE_WRONG_MAX = 1`, `CLOSE_BASE_ROUND = 4`, `NEEDLESS_OVER_BASE_MAX = 1`;
  `interface CloseStats { right: number; right_n: number; wrong: number; errors: number; unrung: number; by_kind:
  Record<FollowUpKind, { runs: number; right?: number; wrong: number }> }` over a variant's held-out (val and test)
  scored rows with `meta.follow_up`; `Summary.close: Record<string, Record<string, CloseStats>>`;
  `closeGate(s: Summary, v: string): { right: boolean; wrong: boolean; ring: boolean; pass: boolean }` in `crowd`:
  right when `right / right_n ≥ 0.9` over `answer` and `answer-one`; wrong when `wrong ≤ 1`; ring when the held-out
  recall paired with round 4 (`pairOf` over case means) has `ci_hi ≥ 0` and the variant's held-out needless rings are
  at most round 4's + 1. `closeTable(s): string` (variant, condition, right k of n, wrong, errors, by kind, the three
  gates).
- [ ] **Step 1: Write the failing tests** on a synthetic flow: counts by kind; train rows left out; a 13-of-14 right
  passes, 12 of 14 fails; 2 wrong fails; recall down beyond noise against v4 fails ring; needless v4 + 2 fails ring;
  the narrative block is written between its markers.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run --config evals/dial-skill/vitest.config.ts
  evals/dial-skill/summarize.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement**, then `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow`; `git diff --stat --
  evals/dial-skill/flow` shows `metrics.md` and `narrative.md` only, the close block empty (no follow-up rows yet).
- [ ] **Step 5: Run the eval's suite.** Expected: PASS.
- [ ] **Step 6: Commit** (`Dial skill eval: the close gates`).

### Task 19: variant v7 and the README

**Effort:** high. **Depends on:** Tasks 9, 14, 15, 16, 17, 18. **Test that must fail first:** the state and oracle cases.

**Files:**
- Create: `cli/evals/dial-skill/flow/v7/SKILL.before.md` (`flow/v4/SKILL.md` byte for byte), `flow/v7/SKILL.md`
  (Task 9's `DIAL_SKILL`), `flow/v7/hooks.json` and `flow/v7/harness-answers.json` (v4's byte for byte),
  `flow/v7/change.md` (the starting bullet, numbers to come)
- Modify: `cli/evals/dial-skill/flow/_state.json` (`harness_paths` gains v7's `hooks.json` and `harness-answers.json`)
- Modify: `cli/evals/dial-skill/README.md` (a "Follow-ups: the agent closes its cards" section: the five follow-ups,
  the table, the seeded card, `no dial`, the grading, the gates, the run commands; Cost: the design's cap is $320 and
  this item's about $50, every pass `--spend-cap-usd 320`, S read and reported first, one pass at a time on the
  account, after Part 5's eval is done, on the orchestrator's go. The Isolation section is Task 21's)
- Test: `cli/evals/dial-skill/state.spec.ts`, `cli/evals/dial-skill/run-eval.spec.ts`

- [ ] **Step 1: Write the failing tests:** state.spec `'flow/v7 is v4 with the closing bullet'` (v7's `SKILL.md` equals
  `DIAL_SKILL`, its `SKILL.before.md` v4's, its hooks and answers v4's, both listed in `harness_paths`); run-eval.spec
  `'an oracle pass with follow-ups closes right, and a stand-in that closes all is counted wrong'`: over one scenario
  of each kind, `oracle` rows have `close_right` 1 where defined and `close_wrong` 0; `always` rows have
  `close_wrong` ≥ 1 for `relay`, `new-request` and `answer-one`.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run --config evals/dial-skill/vitest.config.ts
  evals/dial-skill/state.spec.ts evals/dial-skill/run-eval.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Write the files and the README.**
- [ ] **Step 5: Run the eval's suite.** Expected: PASS.
- [ ] **Step 6: Commit** (`Dial skill eval: v7, the closing bullet`).

### Task 21: every run lives in the daemon's data folder, whose sessions the daemon never lists

**Effort:** xhigh (what an eval agent may read of the person's `~/.harness`; the person's live daemon). **Depends on:**
Task 17 (a two-turn run saves its session; this task places it). **Test that must fail first:** `describe('the run's
folder')` and the narrowed-deny cases.

Why (Decision 6): turn 2 resumes a session saved in the profile's `projects/`, which the maintainer's live daemon reads.
The daemon already skips every session whose cwd lies inside its data folder (`services/devices.ts` `observedSource`
`excluded: [dataDir]`; `services/search.ts`, `services/searchProcess.ts`), so a run there never shows on the real dial
or in ⌘P. Nothing in the daemon or the core changes. Every run moves, two-turn or not, so staging has one way.

**Files:**
- Modify: `cli/evals/dial-skill/lib/stage.ts` (`daemonDataDir`, `stage`'s default `base`, `checkSandbox`, `unstage`)
- Modify: `cli/evals/dial-skill/lib/agents.ts` (`deniedReads`, `settingsFor`, `claudeArgs`' `--settings`)
- Modify: `cli/evals/dial-skill/README.md` (Isolation: where a run lives and why, the session saved for a two-turn run
  and removed at unstage, the narrowed denies and their limit, the `harness status` check)
- Test: `cli/evals/dial-skill/stage.spec.ts`, `cli/evals/dial-skill/agents.spec.ts`

**Interfaces:**
- Produces:
  - `export function daemonDataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string`:
    `ADAPTER_DATA_DIR` when set (a leading `~/` read as `home`), else `join(home, '.harness', 'cli', 'data')`, the
    daemon's own rule (`config/env.ts`; not imported, as its load moves folders). macOS only, as the eval is.
  - `stage`: `base` defaults to `daemonDataDir()`; the run's root stays `<base>/dial-skill-eval/<uuid>/`, the
    `dial-skill-eval` folder made 0700. A missing data folder is refused (`no Harness data folder at <path>`), never a
    fall back to the temp folder. Tests keep passing their own `base`.
  - `unstage` also removes `<base>/dial-skill-eval` once it is empty, so a pass leaves nothing in the data folder.
  - `deniedReads(keep?: string): string[]`: without `keep`, today's two folders. With `keep` inside `~/.harness`:
    `~/.config/gh` and, at each folder from `~/.harness` down to `keep`'s parent, every entry (links included, read with
    `readdirSync` at stage time) that is not on the way to `keep`; other runs' roots under `dial-skill-eval/` are among
    them. `keep` outside `~/.harness`: today's two.
  - `settingsFor(condition, root)` builds `permissions.deny` from `deniedReads(root)`; `claudeArgs` passes `st.root`.
  - `checkSandbox(root)`: `(deny file-read* (subpath ~/.harness) (subpath ~/.config/gh))`, then
    `(allow file-read* (subpath root))` after it (the later rule wins in a sandbox profile), real paths as today.
  - The README names the limit: an entry made in those folders after the run was staged (another run's root, a new
    daemon file) is not in the run's Read denies for that run's minutes; the shell's check sandbox has no such gap.

- [ ] **Step 1: Write the failing tests.**
  - stage.spec `describe('the run's folder')`: `daemonDataDir` with `ADAPTER_DATA_DIR` absolute, with `~/…`, and unset
    (`<home>/.harness/cli/data`); `stage` with no `base` and a temp `HOME` holding `.harness/cli/data` puts `repo` inside
    it (`within(daemonDataDir(), st.repo)`, the daemon's own `lib/pathContainment.ts` `within`); a missing data folder
    is refused; after `unstage` of the last run, `dial-skill-eval` is gone and the data folder's other entries are
    untouched; `checkSandbox(root)` lets a check read a file in `repo` and refuses one in `~/.harness/auth` (run under
    `sandbox-exec`, skipped off macOS).
  - stage.spec `'a run's session would be skipped by the daemon'`: the daemon's test, `excluded.some((dir) =>
    within(dir, cwd))` with `excluded = [daemonDataDir()]` (as `services/devices.ts` and `services/search.ts` build
    it), is true for `st.repo` and false for a folder of `tmpdir()`.
  - agents.spec: `deniedReads(root)` for a root at `<home>/.harness/cli/data/dial-skill-eval/<uuid>` lists every
    sibling at each level (`auth`, `logs`, `cli/cli.js`, `cli/data/dial-notices.json`, another run's `<uuid2>`) and
    none of `.harness`, `.harness/cli`, `.harness/cli/data`, `dial-skill-eval` or the root; `settingsFor` holds a
    `Read(//…)` deny for each and none for `~/.harness` whole; `deniedReads()` with no `keep` is today's.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run --config evals/dial-skill/vitest.config.ts
  evals/dial-skill/stage.spec.ts evals/dial-skill/agents.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** and write the README's Isolation section.
- [ ] **Step 5: Run the eval's suite.** Expected: PASS.
- [ ] **Step 6: Commit** (`Dial skill eval: a run lives in the daemon's data folder, which the daemon never lists`).

## Task graph

| Task | Title | Depends on | Effort |
|---|---|---|---|
| 1 | parser reads `--list`, `--done` | none | medium |
| 2 | several cards an agent | none | xhigh |
| 3 | 24 hours for a live card | 2 | high |
| 4 | the file keeps several | 2 | high |
| 5 | listener `noticeList`, `noticeDone` | 1 | high |
| 6 | a turn start closes nothing | none | high |
| 7 | devices answer cards; counts follow `--done` | 2, 3, 5, 6 | xhigh |
| 8 | the command's `--list`, `--done`, `shown <id>` | 1 | high |
| 9 | the skill's bullet | none | medium |
| 10 | e2e `deviceNotify` | 2, 3, 4, 6, 7, 8, 20 | high |
| 11 | e2e `dialUsage` | 7, 8 | high |
| 12 | e2e `dialWindows` | 5, 7, 8 | medium |
| 13 | docs | 2, 3, 6, 7, 8, 20 | medium |
| 14 | eval: fake keeps cards | 1, 8 | high |
| 15 | eval: follow-ups | none | high |
| 16 | eval: grade the close | 14, 15 | high |
| 17 | eval: two turns | 14, 15, 16 | xhigh |
| 18 | eval: close gates | 15 | high |
| 19 | eval: v7 and README | 9, 14, 15, 16, 17, 18 | high |
| 20 | a Pro gets the card back, held, after a turn start | none | xhigh |
| 21 | eval: every run in the daemon's data folder | 17 | xhigh |

Shared files run one at a time: Tasks 2, 3, 6 and 7 (`notices.ts`, `devices.ts`) and their specs; Tasks 14, 17 and 21
(`stage.ts`, `agents.ts`, `stage.spec.ts`, `agents.spec.ts`); Tasks 19 and 21 (`README.md`). Longest chain:
1 → 8 → 14 → 16 → 17 → 19 and 1 → 8 → 14 → 16 → 17 → 21 (6 tasks each); the product's longest is 2 → 3 → 7 → 10 (4).
Then Verification 6, after Tasks 9, 14-19 and 21 land.

## Pull request notes

One pull request. Its body names the platforms (macOS, Linux, Windows), the red-then-green commits, the local gates'
receipts (Verification 2), the e2e runs, and the eval's verdict with its held-out numbers and spend (counts only). It
also states, each in a line:

- Harness Pro: the devices give a Pro its agent's card back after each turn start, held (a drawer row, no ring), to
  compensate for the Pro's firmware, which drops an agent's question when its next turn starts (`pod_model.c`
  `set_state`); the round dial gets nothing again (Task 20).
- The cost of silent turn ends (rule 8): in All mode, an agent that forgets to close its card loses its done-turn sound
  for up to 24 hours; a failed turn still rings.
- The eval: every run, and a two-turn run's saved Claude session, lives in the Harness data folder for the run's
  minutes, which the live daemon never lists as an agent (its existing data-folder rule), and is removed at unstage; the
  fake `harness` never reaches the daemon (Tasks 14, 21).
Before review, rebase on Part 5 when it has merged (see "Overlap with Part 5") and regenerate the eval's tables.

## Verification

1. **Units and types** (each task's own; once at the end on this Mac): `cd cli && npm run typecheck && npx vitest run
   src/lib/dialNotice.spec.ts src/cable/notices.spec.ts src/cable/noticeFile.spec.ts src/cable/dialUsage.spec.ts
   src/services/devices.spec.ts src/services/devicesListener.spec.ts src/devices/notice.spec.ts
   src/devices/listenerClient.spec.ts src/devices/dialSkill.spec.ts src/deviceClaude/command.spec.ts
   src/cable/questionInbox.spec.ts src/cable/cableSession.spec.ts`. PR CI runs the
   CLI's unit suite on Linux.
2. **Local gates PR CI does not run:** from a clean tree at the final commit, `python3 scripts/local-checks.py --run`.
   It selects `npm run test:core` (`src/services/devices.ts` and `devicesListener.ts` at 100% per file); paste its
   receipts into the PR body before marking it ready.
3. **End to end on macOS and Linux:** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceNotify.e2e.ts
   e2e/dialUsage.e2e.ts` on this Mac; PR CI's `linux-e2e` runs both (modified files) on Ubuntu 24.04. Isolation: the
   e2e harness's `IsolatedDaemon` (a throwaway HOME and data folder, its own port, a private tmux server, fake Claude
   Code and Codex engines, the in-memory backend for `dialUsage`) and a fake dial (`Desk`/`FakeDial` through
   `HARNESSD_TEST_DIAL_PORT`); never this Mac's own daemon (port 18473), its dial, `~/.claude` or `~/.harness`. What
   a person would see, asserted: `notify` prints `shown <id>`; the card stays through the person's next prompt, a
   cross-session message and a Harness message; `--list` shows it; `--done` takes it off the dial; after a restart
   two cards of one agent show the first with ` (1/2)`, and `--done` brings the second up as a row with no ring; the
   answered count comes from `--done`; after a turn start a fake Pro gets the card back as a drawer row and the fake
   round dial gets no question frame. A real Harness Pro is not needed: the fake greets with the Pro's own hello.
4. **Windows:** `windows-e2e` (x64) on the PR, selected by `cli/src/devices/` and `cli/src/cable/`: `dialWindows.e2e.ts`
   on a stand-in dial over the devices' named pipe (`shown <id>`, `--list`, `--done`). No VM or Dell PC.
5. **The full CLI end to end** (Actions → CLI end to end): none; the e2e flows that read notices are the three files
   this PR changes, which `linux-e2e` and `windows-e2e` run.
6. **The eval passes and the hill-climb** (spends money; needs the user's own Claude Code sign-in through the session
   profile in `CLAUDE_CONFIG_DIR`, never `~/.claude`; runs only after Part 5's eval reports done, on the orchestrator's
   go, never beside any other pass on the same account; on this Mac, from `cli/`, after Tasks 9, 14-19 and 21 land). The
   agent the orchestrator names runs it; a round's text change is an edit and a commit.
   - **Start.** The branch holds Part 5's eval rows (rebased on Part 5, or on `main` after it merges), so the runner's
     flow spend counts them; `git status --short` is empty; `diff <(npx tsx -e 'import { DIAL_SKILL } from "./src/devices/dialSkill.ts"; process.stdout.write(DIAL_SKILL)') evals/dial-skill/flow/v7/SKILL.md`
     prints nothing. Read the real S, the last `spend` of the status table in `evals/dial-skill/flow/narrative.md`
     after `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow`, and report it to the orchestrator. If the
     flow holds no Part 5 rows, stop and report. Wait for the go. This item's budget is about $50 from S, inside the
     design's $320; every pass below runs `--spend-cap-usd 320`. The run folder: the `state` row of `harness status`
     (the real daemon, read only; the home written `~`) is the folder `npx tsx -e 'import { daemonDataDir } from
     "./evals/dial-skill/lib/stage.ts"; console.log(daemonDataDir())'` prints; if not, stop and report (a run outside
     the daemon's data folder could show on the real dial). `marker=$(mktemp)`.
   - **Pass 1, v7** (about $25): `npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v7
     --follow-ups --condition crowd --split val,test --reps 2 --concurrency 3 --timeout-s 1500 --spend-cap-usd 320`,
     then the same with `--split train --reps 1`. Exit 2 "harness changed": review `git diff <harness_sha> --
     run-eval.mjs <harness_paths>`, expect only Tasks 14-19 and 21's files and the scenario files of Task 15, then rerun with
     `--approve-harness`; anything else, stop and report. Exit 1: rerun the same command. Exit 3, 4 or 5, or a probe
     failure: stop and report. After pass 1, report the mean cost of a two-turn run from its rows.
   - **Read.** `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow`; the close table gives v7's held-out right
     (follow-ups 1 and 4), wrong, errors, by kind, and the three gates.
   - **Rounds** only when a gate fails and this item has spent at most $25 since S (a round and its test about $25
     more): write `flow/v8/` (`SKILL.before.md` v7's, `SKILL.md` with
     a new body bullet only, the description unchanged, `change.md`, hooks and answers v7's, listed in
     `harness_paths`), designed from v7's train and val traces and `private.jsonl` only, never a test row's reason or
     trace; set `dialSkill.ts` and its spec's exact text to it; run `--variant v8 … --split val --reps 2` and
     `--split train --reps 1` (about $15); then its test once, `--split test --reps 2` (about $10). A second round
     (`v9`) only if the money is left.
   - **Verdict.** The first text whose held-out gates all pass ships; if none, v7 ships only if it meets the
     wrong-close gate; otherwise stop and bring the numbers to the PM, and nothing ships. `dialSkill.ts` and its spec
     then hold the verdict's text.
   - **Close.** `find -H "$CLAUDE_CONFIG_DIR"/ "$CLAUDE_CONFIG_DIR"/*/ -newer "$marker" | sort -u` lists only the
     startup files the README names (no `projects/` folder left); `<data folder>/dial-skill-eval` does not exist; while
     the passes ran, the real dial showed no eval agent (the person's eye, optional: Desktop's Devices tab or the dial's
     list holds no row named after a temp repo); `npx tsx evals/dial-skill/flow-rows.ts scrub
     evals/dial-skill/flow` exits 0; `node evals/dial-skill/build-report-lite.mjs evals/dial-skill/flow`; each
     variant's `change.md` and the narrative's section hold numbers only (`grep -nE '^>|/Users/|~/|'"$(whoami)"` finds
     nothing); the eval's suite passes; commit the rows, tables and text (`Dial skill eval: closing cards, v7…`).
   - **Report** (numbers only): each text's held-out close counts and gates, its ring counts against v4's, the
     verdict, the spend per pass and in the flow, Claude Code's version.
   There is no GitHub workflow for the eval (it needs the user's sign-in and spends their money), and none is proposed.
