# Dial skill usage counts: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From real use and with counts only, the daily review answers, per engine, how many computers have Harness's
dial skill, how many of them have agents that ring, whether the dial shows the notice, whether agents follow the
proceed-or-wait rule, and how often the person prompts that agent within 10 minutes of a shown notice.

**Architecture:** Sixteen new names join `DIAL_DEVICE_METRICS` (and its byte-identical backend copy), so the gateway
sends them with no change. The devices count each answer at the `count` dependency of `Notices`, keep one open notice
per agent for "answered", and look for Harness's skill file in the recorded folders after each dial setup pass and at
each UTC midnight (`cable/dialUsage.ts`, fed by `services/devices.ts`, the file check in `devices/dialSkill.ts`).
`usage:daily` gains a "Dial skill" section. Desktop's and the phone's "See what's shared" name the new counts.

**Tech Stack:** TypeScript (Node 24). CLI: Vitest (unit; `npm run test:core` 100% per file for `src/services/`; e2e
on the real daemon with a fake dial and the in-memory backend). Backend: Fastify, Zod, Prisma on MongoDB, Vitest (unit
and the integration suite on a loopback Mongo). Desktop and phone: Flutter widget tests.

**Spec:** `docs/plans/2026-11-26-dial-skill-usage-design.md` (Ken approved the design, harness-pm approved the spec and
the "answered" signal, 2026-11-26). Base: `feat/dial-skill-usage` at `5f87560981`; line numbers below are on it.

Paths: `DC` `cli/src/lib/dialUsageContract.ts`, `BT` `backend/src/types/dialUsage.ts`, `SK` `cli/src/devices/dialSkill.ts`,
`DU` `cli/src/cable/dialUsage.ts`, `DV` `cli/src/services/devices.ts`, `BR` `backend/src/analytics/dailyDialReview.ts`,
`BI` `backend/integration/dialUsageReview.test.ts`, `E2E` `cli/e2e/dialUsage.e2e.ts`. A CLI spec is the file with
`.spec.ts` in place of `.ts` (`DCS`, `SKS`, `DUS`, `DVS`); a backend test is `.test.ts` (`BRT`).

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | The sixteen names, CLI and backend | `DC`, `DCS`, `BT`, `backend/src/routes/productUsage.test.ts` | none | medium | `DCS` "names the dial skill's use"; route "takes the dial skill's names" |
| 2 | Is Harness's skill there? | `SK`, `SKS` | none | high | `SKS` `installedSkills` cases (not exported) |
| 3 | What the devices count of notices and the skill | `DU`, `DUS` | 1 | high | `DUS` notice, answered and skill cases |
| 4 | Devices wiring | `DV`, `DVS` | 2, 3 | high | `DVS` "the dial skill's use" cases |
| 5 | The review's Dial skill section | `BR`, `BRT`, `BI` | 1 | high | `BRT` "Dial skill" cases; `BI` section assertions |
| 6 | End to end: a notice and the skill reach the report | `E2E` | 4 | high | none: a check of Tasks 3-4, no behavior of its own; one commit |
| 7 | Docs | `docs/product-measurement.md` | none | medium | none: docs, one commit |
| 8 | Desktop and phone copy | `desktop/lib/settings/sections/privacy_section.dart`, `desktop/test/privacy_section_test.dart`, `mobile/lib/phone/privacy_shared_fields.dart`, `mobile/test/privacy_page_test.dart` | none | medium | the two "names the dial and voice" widget tests' new expected text |

**Shared files:** none; no two tasks touch the same file.

**Longest chain:** four tasks, 1 → 3 → 4 → 6. Ready at once: 1, 2, 7, 8.

## Global Constraints

- **No core change.** `git diff --stat 5f87560981 -- cli/src/core cli/src/architecture.coreFiles.txt` prints nothing.
  No new CLI file; `DC` still imports nothing.
- **`DC` and `BT` are the same bytes** (`backend/src/types/dialUsage.test.ts`): Task 1 changes both.
- **`cli/src/services/devices.ts` is 100% per file** under `npm run test:core` (v8 counts `??`, `?.` and both sides of a
  condition): every new line and branch in `DV` is hit by a `DVS` case.
- **Counts only.** No notice text, agent, session, folder, path, id or serial in `dial-usage.json`, a report, a log line
  or a test's expected output. Agent ids live only in `DU`'s bounded maps.
- **The existing `[device] notify` tally line stays** (`cli/e2e/deviceNotify.e2e.ts` reads it); the counts are the
  measure.
- **The names, verbatim:** `dial_skill_{claude,codex}_installation_days`; `dial_notice_installation_days`;
  `dial_notice_{claude,codex,other}` and `dial_notice_{claude,codex,other}_installation_days`;
  `dial_notice_{shown,no_dial,limited}`; `dial_notice_{proceeding,waiting,plain}`; `dial_notice_answered_10m`.
- **Answered** is the person's prompt only: the signal `prompted` uses (`DU` 183-185, 285-291, 312-333):
  `turnStarted(agentId, byPerson)` with `byPerson`, a voice waiting as the turn starts, or the `unwaited` match in
  `voiceEnded`. Never a relayed prompt, a Harness `turn_started`, a listing's busy, another machine's turn, a resume.
- **Release order:** backend first, then CLI; the PR body says so. Desktop and the phone carry Task 8's copy in their
  own next release; the counts do not wait for it. **Platforms:** macOS, Linux, Windows (CLI, Desktop), iOS and
  Android (the phone's copy); no platform-specific code. Comments say why.
- **No fixed sleeps** (fake timers, `vi.waitFor`, `until`); no full suites locally while building (PR CI runs them);
  no CPU-hog loops on this Mac.

## What this plan decides from the spec's words

- **The vocabulary's lists** (in `DC`, exported, used by `DU` and `BR`): `DIAL_SKILL_ENGINES = ['claude', 'codex']`,
  `DIAL_NOTICE_ENGINES = ['claude', 'codex', 'other']`, `DIAL_NOTICE_RESULTS = ['shown', 'no_dial', 'limited']`,
  `DIAL_NOTICE_KINDS = ['proceeding', 'waiting', 'plain']`; type `DialSkillEngine`. The sixteen names go at the end of
  `DIAL_DEVICE_METRICS`, in the spec's table order.
- **The folders read** are the ones a `disable` removes from (`foldersOf`, `cable/dialHomeSetup.ts` 268-270), in the
  spec's order: `readSetup(dataDir).homes[engine]`, then `readWritten(dataDir)[engine]`, as recorded; then the default
  home's, through `skillsFolderOf(home, false, uid, windowsRoots)` (its link followed, this user's folder by the
  platform rule: Design 10), resolved only when no recorded folder held the skill. A folder holds Harness's skill when
  `held()` says `same` or `ours`. Default homes: `dirname(env.CLAUDE_PROJECTS_DIR)` and `env.CODEX_HOME`, the dial
  setup's own (`DV` 842-843).
- **When the check runs:** as each start pass settles (`skillPass`, `DV` 865-867: the devices' start, and the same pass
  run again when Orca's homes change) and as each attach pass settles (`DV` 1415), fulfilled or rejected; and at each
  UTC midnight from the first such pass, by one timer of `DU`'s own `after` (`timerIn('dialUsage')`, so the devices'
  stop clears it). Only where `skill` exists (a devices listener). After `DU.stop()` no pass arms anything.
- **Answered:** `DU` keeps `agentId → shown at` (wall-clock ms at the devices' `shown` answer, the tick the card's `at`
  is taken), oldest first, at most `NOTICES_PENDING_MAX` (20, imported from `cable/notices.ts`). A newer notice of the
  agent replaces its older one. The agent's next `turnStarted` spends it: counted when `byPerson` or a voice waits;
  otherwise it rides in that start's `unwaited` entry (as `announced` does) and counts if `voiceEnded` matches it.
  Counted when the start is less than 600 000 ms after the shown time (`VALUE_MS`, as `prompted`). An unplug keeps the
  map; `stop()` clears it. Every kind counts.
- **The review** (Task 5): one section, `Dial skill`, after `Value from the dial`; labels and limit lines below.
- **The end-to-end check** extends `E2E`, not `deviceNotify.e2e.ts`: the devices count only signed in, and only
  `E2E` signs its isolated daemon in (to the in-memory `FakeBackend`). Signing `deviceNotify.e2e.ts` in would change
  every one of its cases.
- **A correction for the PR body:** an older backend does not refuse a whole report for an unknown name; it drops each
  unknown name, keeps the rest and counts `health_cli_report_unknown_metric`, and refuses only a report left with no
  known name (`backend/src/routes/productUsage.ts` 84-100, test "drops a dial name it does not know and keeps the
  rest"). Backend first still, or the new names are lost.
- **"See what's shared"** (Task 8; spec "What the person is told is shared", harness-pm 2026-11-26, as #4561): the
  words `agents' notices to the dial and whether the dial skill is installed` go into Desktop's "Dial use: …" bullet
  and the phone's "Dial and voice" line, in each line's `;` list, after `how long agents wait for you` and before
  `seconds of voice turned into text` (beside the other agent counts). The apostrophe is ASCII, escaped in the files'
  single-quoted strings (`agents\'`, as the phone's `this phone\'s`).

## Review Focus

1. **A turn start that is not the person's prompt right after a shown notice** (another session's message, a Harness
   agent's own `turn_started`, a listing's busy, an agy or Command Code tool call): not answered, and the notice is
   spent, so the prompt after it does not count it; a resumed session's `session-start` spends nothing. Pinned in
   Task 3 (any start not the person's) and Task 4 (a relayed prompt, a Harness `turn_started`, a listing's busy, a
   resume, each through the devices).
2. **The dial's voice racing its turn** (the turn starts before the send returns; the hook says `dial` and the send
   returns after; Codex words steered into a running turn start none): answered once, never twice, never for a voice
   whose turn never starts. Pinned in Task 3.
3. **A skill file that is not Harness's, or not there** (the person's own `dial/SKILL.md`, a CRLF copy, a link at
   `dial` or `SKILL.md`, a file past 4 KiB, one deleted by hand, records that cannot be read) and an Orca home whose
   `skills/` is a link: installed only for Harness's marker file; nothing written. Pinned in Task 2.
4. **Where the setup does not run, or stops mid-pass** (no listener; a `claude` run still going as the devices stop):
   no check and no midnight timer, nothing armed after stop. Pinned in Task 3 (`setupPassed` after `stop`) and Task 4
   (no listener).
5. **Many agents ringing, an unplug, a restart:** at most 20 open notices, the oldest dropped; an unplug keeps them; a
   stop clears them. Pinned in Task 3, and Task 4 (unplug).

---

### Task 1: The sixteen names, CLI and backend

**Files:** Modify `DC`, `DCS`, `BT` (a byte copy of `DC`), `backend/src/routes/productUsage.test.ts`.

**Interfaces (produces):** the four lists and `DialSkillEngine` of "What this plan decides", and the sixteen names in
`DIAL_DEVICE_METRICS` (so in `DIAL_FILE_METRICS`, `DIAL_USAGE_METRICS` and, by their `_installation_days` ending, six
of them in `DIAL_FLAG_METRICS`).

- [ ] **Step 1: Write the failing tests.**
  - `DCS` `'names the dial skill\'s use: sixteen names, six of them computer flags'`: the `DIAL_DEVICE_METRICS` names
    matching `/^dial_(skill|notice)_/`, sorted, equal the sixteen of Global Constraints; those in `DIAL_FLAG_METRICS`
    are exactly `dial_skill_claude_installation_days`, `dial_skill_codex_installation_days`,
    `dial_notice_installation_days` and `dial_notice_{claude,codex,other}_installation_days`.
  - `DCS` `'names a notice\'s answers and kinds as lib/dialNotice.ts does'`: each `DIAL_NOTICE_RESULTS` entry with `_`
    read as a space passes `isNoticeResult`; for each kind `k`, `noticeKind(composeNotice('q', 's', k === 'plain' ?
    undefined : k)) === k`; three of each.
  - Route test `'takes the dial skill\'s names'`: a cli report whose counters are the sixteen names at 1 → 200,
    `ingestProductUsage` called with exactly those counters.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/dialUsageContract.spec.ts` and
  `cd backend && npx vitest run src/routes/productUsage.test.ts`. Expected: FAIL (lists missing; the route drops the
  names and adds `health_cli_report_unknown_metric`).
- [ ] **Step 3: Implement** in `DC` (lists `as const`, names built with `map`/`flatMap` as the file does), then
  `cp cli/src/lib/dialUsageContract.ts backend/src/types/dialUsage.ts`.
- [ ] **Step 4: Run** the same two commands plus `cd backend && npx vitest run src/types/dialUsage.test.ts` and
  `npm run typecheck` in `cli` and in `backend`. Expected: PASS (the 8 KiB report case still passes).
- [ ] **Step 5: Commit** (`feat: the dial skill's usage names`).

### Task 2: Is Harness's skill there?

**Files:** Modify `SK`, `SKS`.

**Interfaces (produces):**

```ts
/** The engines whose skill Harness's own file is in now: per engine, dial-setup.json's folders, dial-skill.json's,
 *  then the default home's skills/ (only when none of those held it); stops at the first. Reads only. */
export function installedSkills(dataDir: string, homes: Record<DialEngine, string>, uid = ownUid(),
  windowsRoots: readonly string[] | undefined = platformRoots()): DialEngine[]   // ['claude', 'codex'] order
```

`SK` imports `readSetup`, `readWritten` and `type DialEngine` from `./dialSkillFiles.js` (no cycle: that file imports
only Node's modules and `lib/secureState.ts`); its header comment says so. Each record is read once a call.

- [ ] **Step 1: Write the failing spec cases** in `SKS`, `describe('installedSkills')`, on throwaway data folders and
  homes (the file's `cleanup` list):
  - `'finds Harness\'s skill in a folder dial-setup.json records'` (`writeSetup` + `writeSkill` → `['codex']`);
  - `'in a folder the command recorded in dial-skill.json'` (`writeRemoved(dataDir, 'claude', false, [skills])`);
  - `'in the default home\'s skills, through its link'` (`home/skills` a link to a folder holding it);
  - `'not the person\'s file, a CRLF copy, a link at dial or at SKILL.md, nor a file past 4 KiB'` → `[]`;
  - `'not a skill deleted by hand from a recorded folder'` → `[]`;
  - `'a record that cannot be read reads as none, and the default home is still read'` (chmod 000 on
    `dial-setup.json`; POSIX only, as the file's unreadable cases are);
  - `'a default home not this user\'s is not read'` (`uid + 1`; and with Windows roots that exclude it);
  - `'stops at the first folder that holds it'`: add `lstatSync` to the file's hooked `node:fs` calls and count the
    calls on paths ending in `/dial`: skill in the first recorded folder of three → one;
  - `'writes nothing'`: no `dial/` made in a default home without one, records' bytes unchanged.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/dialSkill.spec.ts`. Expected: FAIL, not exported.
- [ ] **Step 3: Implement `installedSkills`** beside `held()`.
- [ ] **Step 4: Run** the same spec (its `'it loads only node modules'` case included). Expected: PASS.
- [ ] **Step 5: Commit** (`feat(cli): tell whether Harness's dial skill is installed`).

### Task 3: What the devices count of notices and the skill

**Files:** Modify `DU`, `DUS`.

**Interfaces:**
- Consumes: Task 1's lists and names; `NOTICES_PENDING_MAX` from `./notices.js`; `type NoticeKind, type NoticeResult`
  from `../lib/dialNotice.js`.
- Produces (`DialUsageDeps` and `DialUsage` gain):

```ts
/** The engines whose skill Harness's file is in now (devices/dialSkill.ts installedSkills). */
skills(): readonly DialSkillEngine[]
/** Each notice the devices answer (cable/notices.ts `count`): `agent` is a notice naming no engine, counted `other`. */
noticed(engine: 'claude' | 'codex' | 'agent', result: NoticeResult, kind: NoticeKind): void
/** That agent's notice was shown now: its person's next prompt within 10 min answers it. */
noticeShown(agentId: string): void
/** A dial setup pass ended: the skill is looked for now, and at each UTC midnight from the first; nothing after stop(). */
setupPassed(): void
```

`noticed` adds `dial_notice_installation_days`, `dial_notice_<e>`, `dial_notice_<e>_installation_days`,
`dial_notice_<result, space as _>`, `dial_notice_<kind>`, attached or not. `setupPassed` adds
`dial_skill_<e>_installation_days` for each engine `skills()` names. Answered as "What this plan decides" says: the
`unwaited` entry gains `notice?: number`, set only when the start was not the person's (as `announced` is).

- [ ] **Step 1: Write the failing spec cases** in `DUS` (the rig gains `skills: () => [...installed]` with an
  `installed` set the test fills):
  - `'counts each notice by the engine it names, its answer and its kind, with the day\'s flags, dial or no dial'`:
    `noticed('claude','shown','waiting')`, `('claude','limited','waiting')`, `('codex','shown','proceeding')`,
    `('agent','no dial','plain')` → `dial_notice_claude` 2, `_codex` 1, `_other` 1, `_shown` 2, `_limited` 1,
    `_no_dial` 1, `_waiting` 2, `_proceeding` 1, `_plain` 1; each flag added, held at 1 by the sink.
  - `'a person\'s prompt within 10 min of a shown notice answers it, once'`: `noticeShown('a')`, 599 999 ms,
    `turnStarted('a', true)` → `dial_notice_answered_10m` 1; another `turnStarted('a', true)` → still 1; a new notice,
    600 000 ms, a prompt → still 1.
  - `'a start whose source cannot be told spends it uncounted'`: `noticeShown('a')`, `turnStarted('a')` (a Harness
    turn, a listing's busy, a relayed prompt, a replayed or continued turn all arrive so), `turnStarted('a', true)` → 0.
  - `'the dial\'s voice answers it: waiting as the turn starts, or begun before a turn it started; a hook that says
    dial counts once'`: as the existing `'the dial\'s voice is the person\'s prompt…'` case, with `noticeShown` in place
    of `announce`, each → +1; the `turnStarted('a', true)` then `voiceEnded` sequence → +1 only.
  - `'a voice whose turn never starts answers nothing'` (sent, 10 s, no start → 0).
  - `'a newer notice of the agent replaces the older, which ends uncounted'`: shown at t, again at t+9 min, prompt at
    t+18 min → 1.
  - `'at most 20 open, the oldest dropped first; an unplug keeps them; a stop drops them'`: 21 agents' notices;
    `d0` prompted → 0, `d1` → 1; `attached(true)`, `attached(false)`; `d2` prompted → 2; `stop()`; `d3` → 2.
  - `'the skill counts after each setup pass and at each UTC midnight from the first, by one timer'`: no pass, two days
    → no `dial_skill_` add; `installed = {codex}`, `setupPassed()` twice → `vi.getTimerCount()` 1 and the codex flag
    added; `installed = {claude, codex}`, advance to the next UTC midnight → both added; one more day → both again.
  - `'nothing is armed after stop'`: `setupPassed()`, `stop()`, `setupPassed()`, two days → only the first pass's add,
    timer count 0.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/dialUsage.spec.ts`. Expected: FAIL (no such members).
- [ ] **Step 3: Implement** in `DU`.
- [ ] **Step 4: Run** the same spec and `npm run typecheck`. Expected: PASS, the existing cases unchanged.
- [ ] **Step 5: Commit** (`feat(cli): count the dial skill's notices, their answer and the skill`).

### Task 4: Devices wiring

**Files:** Modify `DV`, `DVS`.

**Interfaces:** Consumes `installedSkills` (Task 2) and Task 3's members. In `DV`:
- one `skillHomes = { claude: dirname(env.CLAUDE_PROJECTS_DIR), codex: env.CODEX_HOME }`, made before
  `createDialUsage` (`DV` 544) and given to `createDialSetup` (842-843) and to `skills: () =>
  installedSkills(core.dataDir, skillHomes)`;
- `Notices`' `count` (1900): the existing `createEngineTally('[device] notify', …)` kept as `noticeTally`, and
  `(engine, result, kind) => { noticeTally(engine, result, kind); count((usage) => usage.noticed(engine, result, kind)) }`;
- `noticeShown` (1920-1924) also calls `usage.noticeShown(agentId)`;
- `skillPass` (866) and the attach (1415) run `skill.started()` / `skill.attached()` then `.finally(() =>
  count((usage) => usage.setupPassed()))`.

- [ ] **Step 1: Write the failing spec cases** in `DVS`, a `describe('the dial skill\'s use')` inside
  `'the dial\'s usage counts, in dial-usage.json'` (its `counted`, `attach`, `hook`; lift `withNotices`/`notice` from
  `'the waits on the person and the interrupt'` to the parent describe to share them):
  - `'counts each notice the devices answer, by engine, answer and kind, beside the [device] notify line'`: shown
    (claude, waiting), the same again (limited), one naming no engine with no dial attached (no dial) → the expected
    `dial_notice_*` values; the log still holds `'[device] notify · claude · shown · waiting'`; the file's text holds
    neither the line, the session id nor the folder.
  - `'an outside agent\'s person prompt answers its notice, once'`: `hook('session-start')`, attach, notice for
    `sess-1` shown, `hook('turn-start')` → `dial_notice_answered_10m: 1`; another prompt → still 1.
  - `'another session\'s message spends it uncounted'`: `hook('turn-start', { relayed: true })`, then
    `hook('turn-start')` → 0.
  - `'a resumed session\'s session-start neither answers nor spends it'`: `hook('session-start')` again, then
    `hook('turn-start')` → 1.
  - `'a Harness agent\'s own turn_started spends it; the dial\'s voice to it answers it'`: `withNotices`, its notices a
    minute apart (`NOTICE_AGENT_MS`); notice for `h1`, `turn_started` card → 0; a notice,
    `seen.host.voiceEnded!({ outcome: 'sent', agentId: 'h1', since })`, then `turn_started` → 1; a notice,
    `turn_started`, then `voiceEnded` with `since` before it → 2.
  - `'an agent a listing shows busy spends it uncounted'`: the herdr-listed agent of `DVS` 8382-8412 (`agent_status`
    working after idle) with a notice for `sess-h` → 0.
  - `'a dial unplugged keeps it: the prompt hook answers it'`: outside agent, notice shown, `seen.host.watching!(false)`,
    `hook('turn-start')` → 1.
  - In `'the dial setup, from the devices\' own process (cable/dialSetup.ts)'` (its throwaway homes):
    `'the skill counts after the start pass, after an attach\'s pass, and at each UTC midnight'`: fake timers at
    `2026-11-26T23:59:00Z`; a computer that never had a dial: start, `orcaHomes.landed()` → no `dial_skill_` that day;
    attach → `dial_skill_codex_installation_days: 1` (the attach's pass wrote it); a minute on → the 27th has it too;
    the person deletes `CODEX_HOME/skills/dial/SKILL.md`; a day on → the 28th has none. And `'once a dial attached,
    the start pass counts the skill'` (`dialOnce()`, start → the flag). And `'with no listener, no skill is looked
    for'`: the skill file present, `start` without `listen`, attach, a day on → no `dial_skill_` name.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t "dial skill"` and
  `-t "the dial setup"`. Expected: FAIL (no `dial_notice_` or `dial_skill_` names).
- [ ] **Step 3: Implement** the four wirings above.
- [ ] **Step 4: Run** the same, then `npm run test:core` (devices.ts 100%: lines, branches, functions, statements) and
  `npx vitest run src/architecture.spec.ts`. Expected: PASS; `git diff --stat 5f87560981 --
  src/architecture.coreFiles.txt` prints nothing.
- [ ] **Step 5: Commit** (`feat(cli): the devices count the dial skill's notices and look for the skill`).

### Task 5: The review's Dial skill section

**Files:** Modify `BR`, `BRT`, `BI`.

**Interfaces:** Consumes `DIAL_SKILL_ENGINES`, `DIAL_NOTICE_ENGINES`, `DIAL_NOTICE_RESULTS`, `DIAL_NOTICE_KINDS` from
`BT`. `DIAL_REVIEW_METRICS` and `readDialRows` take the new names through `DIAL_USAGE_METRICS` with no change; the
query's shape is the same plain `$match`, its `$in` 48 names longer.

The section, after `Value from the dial`, built with the file's `line`, `computerDays` and `sum`; `noticed` is
`computerDays('dial_notice_installation_days')`:
- for `claude`, `codex`: `<e>: skill installed (computer-days)` (`dial_skill_<e>_installation_days`), then
  `<e>: agents rang (computer-days; notices)` (`dial_notice_<e>_installation_days`, events `dial_notice_<e>`);
- `other: agents rang (computer-days; notices)`; `Any notice (computer-days)` (`noticed`);
- `Reach: shown`, `Reach: no dial`, `Reach: limited`, `Rule: proceeding`, `Rule: waiting`, `Rule: plain`,
  `Answered: the person's prompt within 10 min`: each `noticed` with its events.

Two lines appended to `limits` (the first two stay first):
- `"Dial skill notices count only what reached the devices: with them not running the command prints no dial and nothing is counted, nor what the listener's own rate refuses."`
- `"Answered is the person's prompt to that agent within 10 min of a shown notice where its source can be told (a prompt hook, or the dial's voice): a prompt typed in the Harness app, a tap, Codex words steered into a running turn, a caller with no session and a card restored after a restart are not counted."`

- [ ] **Step 1: Write the failing tests.**
  - `BRT` `'shows the dial skill per engine, installed beside rang, other without a denominator'`: day-1 rows
    `dial_skill_claude_installation_days` 6, `dial_notice_claude_installation_days` 5, `dial_notice_claude` 12,
    `dial_notice_other_installation_days` 5, `dial_notice_other` 7 → `rowOf(outsideTeam, 'Dial skill', …)`:
    installed `computers.day` 6; rang `{ computers.day: 5, events.day: 12 }`; `other: agents rang` present; no
    `other: skill installed` row; the installed row comes right before the rang row.
  - `'reach, rules and answered are events against computers with a notice, under five hidden'`: notice computers 4,
    `dial_notice_shown` 9 → `Reach: shown` `{ computers.day: '<5', events.day: '<5' }`; at 6 → 6 and 9.
  - `'keeps the team\'s dial skill apart'`: `staff:dial_skill_codex_installation_days` 7 → team 7, outside absent.
  - `'states the notice and answered limits'`: `limits` contains both lines above.
  - `BI`: the report's counters gain `dial_skill_claude_installation_days: 1, dial_notice_installation_days: 1,
    dial_notice_claude_installation_days: 1, dial_notice_claude: 2, dial_notice_shown: 2, dial_notice_answered_10m: 1`;
    after the existing plan checks (unchanged: two reads, `IXSCAN { dayUtc: 1, metric: 1`, examined = returned), the
    outside `Dial skill` section's `claude: skill installed` day is 5 and `Reach: shown` events 10, `Answered…` events 5; the team's `'<5'`.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/analytics/dailyDialReview.test.ts`. Expected: FAIL (no
  section). `BI` needs the suite's loopback Mongo: `npx vitest run --config vitest.integration.config.ts
  integration/dialUsageReview.test.ts` where it runs; else `backend-integration` on PR CI is its run.
- [ ] **Step 3: Implement** the section and the two limit lines in `BR`.
- [ ] **Step 4: Run** the unit test, `npm run typecheck`, and `BI` where it runs. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(backend): a Dial skill section in usage:daily`).

### Task 6: End to end: a notice and the skill reach the report

**Files:** Modify `E2E`.

No test fails first: this adds a check of what Tasks 3 and 4 deliver, and changes no behavior; one commit. It must pass
on the branch with Task 4 in.

- [ ] **Step 1: Extend the one case.** After the first `plugTurnTap(window)`: start an outside Claude Code session,
  `Outside.start(d, 'PRIVATE_NOTICE_CANARY', { TERM_PROGRAM: 'ghostty' })` (closed in `afterAll`), wait for it on the
  dial's list; run the real command as its shell would (the `notify` helper of `cli/e2e/deviceNotify.e2e.ts` 110-121,
  copied: `cli/e2e/harness/` is not touched, as a change there runs the linux-e2e canary) with
  `{ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }` and the words
  `['PRIVATE_LINE_CANARY needs the VPN', '--suggest', 'connect it', '--waiting']` → `{ code: 0, out: 'shown' }`; then
  `engine.type('connected')`. Add to `expected`: `dial_notice_installation_days`, `dial_notice_claude_installation_days`,
  `dial_skill_claude_installation_days`, `dial_skill_codex_installation_days` (Claude Code's is written there because
  the case's Harness Claude agent is listed: `cable/dialHomeSetup.ts` header), `dial_notice_claude`,
  `dial_notice_shown`, `dial_notice_waiting`, `dial_notice_answered_10m`, each 1.
- [ ] **Step 2: After the restart,** each of those flags and events sums to 1 across the reports; the existing secret
  check covers the canaries (`'PRIVATE_'`) and gains `engine.sessionId`.
- [ ] **Step 3: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialUsage.e2e.ts` once on the
  branch head (up to 15 minutes; one e2e run at a time). Expected: PASS; on failure the daemon log's last lines print.
- [ ] **Step 4: Commit** (`test(cli): a notice and the dial skill reach the usage report`).

### Task 7: Docs

**Files:** Modify `docs/product-measurement.md` ("The dial's counts" table, after the `Did the dial give value?` row).

- [ ] **Step 1:** A row `Do agents use the dial skill?` naming the sixteen names (in the table's `<a\|b>` style) and
  saying, from the spec: installed is Harness's skill file found that day in a recorded folder or the default home,
  read after the setup's passes and at UTC midnight, where the devices have a listener; notices count only what reached
  the devices, by the engine the command named; reach is the devices' answer; rule-following is the line's kind;
  answered is the person's prompt to that agent within 10 min of a shown notice (a prompt hook or the dial's voice), so
  Harness's panes and listing-only agents count only through voice; the `[device] notify` log line stays a debug line.
- [ ] **Step 2: Commit** (`docs: the dial skill's usage counts`).

### Task 8: Desktop and phone copy

**Files:** Modify `desktop/lib/settings/sections/privacy_section.dart` (the "Shared fields" text, the `• Dial use:`
bullet at 211), `desktop/test/privacy_section_test.dart` (`'See what’s shared names the dial and voice'`, 145-164),
`mobile/lib/phone/privacy_shared_fields.dart` (`_sent`, the `Dial and voice` entry at 57-62),
`mobile/test/privacy_page_test.dart` (`'See what’s shared names the dial and voice'`, 79-104). Depends on nothing.
Effort medium: a few words in one existing line on each screen.

**No design doc or gallery change, and why:** the root rule ("the doc and its gallery change in the same pull request")
is for a new or changed element (`desktop/design/desktop-design-system.md` "Elements gallery": "A new or changed
element updates this document and the gallery"). This task adds words inside an existing text of an existing element:
the doc names neither the privacy section nor its copy, the gallery (`desktop/test/elements_gallery_test.dart`) has no
privacy section and leaves words out of its image comparison, and #4561 changed the same two lines with no doc change.
The copy follows the doc's "All copy is sharp" rules (a few words, in the line's own `;` list). `mobile/` has no
AGENTS.md and no design doc of its own; `desktop/AGENTS.md` adds nothing for copy.

**A person's click-through already exists:** both widget tests pump the real widget (`ProductUsagePreference`;
`PrivacyPage`), tap `See what’s shared` as a person does and read the opened list; the task adds one expectation to
each, no new test.

- [ ] **Step 1: Write the failing expectations.** In each of the two tests, after the existing ones:

```dart
expect(
  find.textContaining(
    'how long agents wait for you; agents\' notices to the dial and whether '
    'the dial skill is installed; seconds of voice turned into text',
  ),
  findsOneWidget,
);
```

- [ ] **Step 2: Run** `cd desktop && flutter test test/privacy_section_test.dart` and
  `cd mobile && flutter test test/privacy_page_test.dart`. Expected: FAIL, each on the new expectation only.
- [ ] **Step 3: Implement** the words of "What this plan decides" in the two lines: Desktop's bullet stays one string
  literal ending `\n`; the phone's entry keeps its adjacent literals and its final `.`.
- [ ] **Step 4: Run** the same two commands and `flutter analyze` on the two changed files in each app. Expected: PASS,
  no new issue.
- [ ] **Step 5: Commit** (`feat(desktop, mobile): See what's shared names the dial skill's counts`).

## Verification

**Local gates PR CI does not run** (the tester, from a clean tree at the final head, on the Mac; receipts in the PR
body before it is marked ready):
- `python3 scripts/local-checks.py --run`: it runs `npm run test:core` in `cli` (`src/services/devices.ts` changed) and
  prints the receipt fence.
- `cd cli && npm run typecheck && npx vitest run src/lib/dialUsageContract.spec.ts src/devices/dialSkill.spec.ts
  src/cable/dialUsage.spec.ts src/services/devices.spec.ts src/architecture.spec.ts`.
- `cd backend && npm run typecheck && npx vitest run src/types/dialUsage.test.ts src/routes/productUsage.test.ts
  src/analytics/dailyDialReview.test.ts`.
- `cmp cli/src/lib/dialUsageContract.ts backend/src/types/dialUsage.ts` and `git diff --stat 5f87560981 -- cli/src/core
  cli/src/architecture.coreFiles.txt` print nothing.
- `cd desktop && flutter test test/privacy_section_test.dart` and `cd mobile && flutter test
  test/privacy_page_test.dart` (Task 8). The Flutter files add no local gate: `python3 scripts/local-checks.py --list`
  on Task 8's four paths names none (the `desktop-macos` receipt is only for macOS-specific Desktop paths), so no
  Desktop or phone receipt goes in the PR body.

**PR CI, selected by the paths:** `cli-typecheck`, `cli-tests`, `backend-desk`, `backend-integration` (with `BI`),
`linux-e2e` (it runs `E2E`, modified), `windows-e2e` x64 (`cli/src/cable/` changed: the devices inside the core's
process on Windows, existing cases), `desktop-tests` (six Linux shards; `desktop/` changed), `mobile-checks`
(`mobile/` changed), `cross-read-scan`, `process-checks`. `scripts/ci-plan.py`'s `select` on Task 8's four paths gives
`desktop`, `mobile` and `cross-read-scan`. Nothing dispatched by hand.

**End-to-end checks:**
1. **A notice, its answer and the skill reach the signed-in report as counts only** (`E2E`, Task 6). Runs on Linux in
   PR CI's `linux-e2e`, and by hand from the branch with Actions → "CLI end to end" (`.github/workflows/cli-e2e.yml`)
   when a rerun is wanted; on the Mac with `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialUsage.e2e.ts`.
   Isolation is the suite's own (`cli/e2e/harness/daemon.ts` `IsolatedDaemon`): a throwaway home, data folder, Claude
   and Codex homes, port and tmux server, never the everyday daemon on 18473; the in-memory `FakeBackend` with a
   made-up machine and token (no account, no production); a fake dial on a pseudo-terminal; fake Claude Code engines.
   A person sees the case pass; the file and every report hold the names and numbers only.
2. **Ingest to review on a real Mongo** (`BI`, Task 5): `backend-integration` on PR CI, on a fresh loopback replica set
   with made-up accounts; the longer `$in` still reads by the (day, name) index, and the section reads the new rows.
3. **"See what's shared" names the new counts on Desktop and the phone** (Task 8): the two widget tests, in PR CI's
   `desktop-tests` and `mobile-checks` (Linux) and locally with the commands above. Each pumps the real widget with a
   made-up preference request (no backend, no account), taps `See what’s shared` as a person does and finds the new
   words in the opened list. No device run: the change is words in an existing text, with no platform code.
4. **A real dial (optional, not needed for the merge; needs harness-pm's approval and the user's own dial and eye).**
   On the Mac, a second daemon with its own `ADAPTER_DATA_DIR`, `HARNESS_AUTH_DIR`, `ADAPTER_COMPUTER_ID_FILE` and port,
   signed in with a test account to the disposable stack of `make terminal-local-manual`; an agent runs
   `harness device notify … --waiting`, the person sees the card and prompts the agent; `cd backend && npm run
   usage:daily -- 28` with `DATABASE_URL` set to that local database shows the Dial skill section as `"<5"`.

**Numbers for the PR:** none on a hot path: the check reads two small JSON files and one to three skill files a pass
and a midnight; the notice counts are a few adds per notice.

**PR-body notes:**
- Release order: backend, then CLI. An older backend drops each new name and counts
  `health_cli_report_unknown_metric`; the rest of the report is kept, and a report holding only new names is refused.
- Backend rule 3: no new query; `readDialRows`'s `$in` grows by 48 names, and `BI` reads both plans with it.
- Backend rule 5 (as #4561): growth from the vocabulary, no production read: at most 16 names × 3 prefixes = 48 new
  `product_usage_totals` rows a day, kept 396 days by the existing TTL (at most 19,008 rows), whatever the number of
  computers.
- Desktop and the phone carry the "See what's shared" words in their own next release; the counts do not wait for it.
  No design doc or gallery change: words in an existing text, not a new or changed element (Task 8).
- Platforms: macOS, Linux, Windows (CLI and Desktop), iOS and Android (the phone's copy); no platform-specific code
  (the skill check uses `dialSkill.ts`'s own ownership rule: the uid, or the Windows profile root). The copy is tested
  by the two widget tests on Linux CI.

**Production:** no check runs against it.
