# Dial skill usage counts

2026-11-26. Ken approved the design (2026-11-26); this spec writes it down with its Design section.

## Intent

Ken wants to know whether agents actually use the dial skill. Harness writes the skill
(`cli/src/devices/dialSkill.ts`) into each Claude Code and Codex home once a dial has attached on a computer. It tells
an agent to run `harness device notify "<line>" --suggest "<recommendation>" --proceeding|--waiting` when the task stops
on a step only the person can take. Today nothing says whether agents run it, whether the dial shows it, whether they
follow the skill's rules, or whether the person acts on it. The devices only write a log tally
(`createEngineTally('[device] notify', …)` in `cli/src/services/devices.ts`), which nobody collects.

The answer has to come from real use, with counts only. It rides on the dial usage counts pipeline (#4561, #4609,
`docs/plans/2026-11-23-dial-usage-counts-design.md`): the devices write fixed names to `dial-usage.json`, the gateway
sends them in its signed-in daily report, and the backend stores daily totals and reviews them in `usage:daily`.

## Questions and measures

All names are new entries in `cli/src/lib/dialUsageContract.ts`, in `DIAL_DEVICE_METRICS`, so the gateway sends them
as they come with no change of its own. A name ending in `_installation_days` is a computer flag (at most 1 a computer
a UTC day); any other name is an event count, capped at `DIAL_USAGE_MAX_COUNT` a day like every dial count.

| Question | Name | Counted when |
|---|---|---|
| Denominator: could an agent use it? | `dial_skill_claude_installation_days`, `dial_skill_codex_installation_days` | A check that UTC day finds Harness's own skill file in at least one skills folder of that engine (Source of the denominator, below) |
| Use: do agents ring? | `dial_notice_installation_days` | Any notice reached the devices that day |
| | `dial_notice_claude`, `dial_notice_codex`, `dial_notice_other` | Each notice, by the engine the command named (`NoticeAsk.engine`); a notice naming none is `other` |
| | `dial_notice_claude_installation_days`, `dial_notice_codex_installation_days`, `dial_notice_other_installation_days` | The same, as the day's computer flag |
| Reach: did the dial show it? | `dial_notice_shown`, `dial_notice_no_dial`, `dial_notice_limited` | Each notice, by the devices' answer (`NoticeResult`) |
| Rule-following: proceed or wait? | `dial_notice_proceeding`, `dial_notice_waiting`, `dial_notice_plain` | Each notice, by its kind: `noticeKind(text)`, read from the fixed opening the CLI writes (`plain`: neither flag) |
| Answer: did the person act? | `dial_notice_answered_10m` | A shown notice whose agent's next turn is the person's prompt, within 10 min of it being shown; once per notice |

Sixteen names in all. Engines are the three the notice carries (`claude`, `codex`, `other`), a fixed list.

### What reaches the counts, and what does not

Counts are taken where the devices answer a notice, at the one place every answer passes: the `count` dependency of
`Notices` (`cli/src/cable/notices.ts`), which already receives the engine, the result and the kind of each answer.

Not counted, and the review says so:
- **The devices not running, or their listener not reachable.** The command (`cli/src/devices/notice.ts`) cannot reach
  them and prints `no dial`, so `dial_notice_no_dial` counts only the `no dial` the devices themselves answer (no dial
  attached).
- **The listener's own per-second rate.** A notice refused with 429 never reaches the devices; the command prints
  `limited`, uncounted. `dial_notice_limited` is the devices' own limits (`NoticeLimits`).
- **A malformed notice** the listener refuses (`REFUSED`), and a command with no question (`--help`, flags alone), which
  sends nothing.
- **A computer where the devices have no listener** (`HARNESSD_SERVICES=none`): no notice can reach it, and no skill
  is set up there either.

### Answered within 10 minutes

The next turn start of the notice's agent must be **the person's prompt**, never the agent's own continuation or a
resume replay (harness-pm, 2026-11-26). The signal is the one #4609 already uses for
`dial_value_done_away_prompted_10m` (`cable/dialUsage.ts` `turnStarted(agentId, byPerson)` and its `prompted`):

- **An outside hooked agent's prompt hook**: the `turn-start` the hook sends for a prompt the person submitted
  (Claude Code's `UserPromptSubmit`, Cursor's `beforeSubmitPrompt`, Copilot's `userPromptSubmitted`, and the engines
  that copy Claude Code's names), whose source the observed source tells as `person` or `dial`
  (`cable/hosts/observed.ts` `promptSource`). Not `relayed` (another session's message, `cli/hook/notify.mjs`
  `relayedPrompt`), and never agy or Command Code, whose `turn-start` is a model or tool call. A resume replays no
  prompt hook, and an agent continuing on its own submits no prompt.
- **The dial's own voice delivered to that agent**: a voice waiting as the turn starts, or a turn the words started
  before their send returned (the existing `unwaited` match in `voiceEnded`).

Any other turn start (a Harness agent's `turn_started` frame, an outside agent seen busy in a listing, a relayed or
unknown prompt) spends the notice without counting it, as it spends an announced turn end today. So a Harness agent,
or an agent seen only through a listing, counts only through the dial's voice; a prompt typed in the Harness app is
not told apart from the agent's own turns, and is not counted (a limit the review states).

- The count is taken when that prompt comes within 10 minutes of the notice being shown (the devices' `shown` answer,
  the moment the desk keeps as the card's `at`, even when the card waits behind another open question of its agent).
- Every kind counts: `proceeding`, `waiting` and `plain`. Ken's measure is "the person sends that agent a prompt within
  10 minutes of a shown notice", whatever the notice said.
- Once per notice: the agent's first turn start after it spends it, counted or not. A newer notice of the same agent
  replaces the older one (the dial keeps one card an agent); the older one ends uncounted.
- Not counted (limits the review states): a tap on the dial, which opens the agent's app (the prompt after it counts
  when its hook tells it); a caller with no session (no turn of it is heard); Codex words steered into a running turn,
  which start no turn; a card restored after a devices restart (the shown time is held in memory only).
- A dial unplugged does not drop the open notices: the person's prompt is told by its hook with or without a dial.
- Bounded: one open notice an agent, at most `NOTICES_PENDING_MAX` (20), the oldest dropped first; cleared on stop.

### Source of the denominator

The skill file is Harness's own: `<home>/skills/dial/SKILL.md`, a regular file whose front matter holds Harness's
marker line (`held()` in `dialSkill.ts`, any release's text). The folders Harness may have written it in are already
recorded, so no home is scanned:
- the dial setup's record, `dial-setup.json` `homes.claude` / `homes.codex` (default, adopted and Orca homes;
  `cable/dialHomeSetup.ts`);
- the command's record, `dial-skill.json`'s written homes (`readWritten`, `harness device claude|codex enable`);
- the engine's default home's `skills/` folder.

The check reads those folders for one engine at a time and stops at the first that holds Harness's file: one `lstat`,
one `open` and at most 4 KiB read a folder; at most 2 × 64 + 1 folders an engine by the records' own bound
(`MAX_HOMES`), one to three on a usual computer. It writes nothing and follows no link (the existing `held()` rules).

It runs, wherever the dial setup runs (a devices listener):
- after the dial setup's start pass at the devices' start, and after the pass each attach runs: the moments the setup
  writes or removes the skill;
- at each UTC day's turn, by one timer armed for the next midnight (not a poll), so a computer whose devices run for
  days still gets its flag each day.

Installed means "Harness's skill was there at a check that day". A person who deletes the skill by hand between checks
is seen at the next check. Claude Code's plugin carries no skill of its own (`plugins/harness-device`), so the files are
the whole answer.

### The review

`usage:daily` gains a **Dial skill** section in `backend/src/analytics/dailyDialReview.ts`, outside-team and team apart
as the other sections, with the day, 7-day and 28-day columns and the "<5" rule:
- per engine (claude, codex): computers with the skill installed, beside computers whose agents rang (with notices as
  the event count), so the share reads off adjacent rows; `other` rang, without a denominator;
- any notice (computer-days);
- reach: shown, no dial, limited (events), against computers with a notice;
- rule-following: proceeding, waiting, plain (events), against computers with a notice;
- answered within 10 min (events), against computers with a notice; the reader compares it with `shown`.

Two limit lines join the review's `limits`: notices count only what reached the devices (with them not running the
command prints `no dial` and nothing is counted); answered is the person's prompt within 10 minutes where its source
can be told (a prompt hook, or the dial's voice), so a prompt typed in the Harness app is not counted.

### What the person is told is shared

"See what's shared" lists the dial's count families by name, so it gains the new ones in the same few words on both
screens (harness-pm, 2026-11-26, the #4561 precedent): Desktop's "Dial use: …" line
(`desktop/lib/settings/sections/privacy_section.dart`) and the phone's "Dial and voice" entry
(`mobile/lib/phone/privacy_shared_fields.dart`) add "agents' notices to the dial and whether the dial skill is
installed", with their existing widget tests (`desktop/test/privacy_section_test.dart`,
`mobile/test/privacy_page_test.dart`). Desktop and the phone carry the copy in their own next release; the counts do not
wait for it. `docs/product-measurement.md` gains the family in its dial table.

## Goals, non-goals, anti-goals

- Goal: from daily totals, tell per engine how many computers with the skill have agents that ring, whether the dial
  shows the notice, whether agents follow the proceed-or-wait rule, and how often the person acts within 10 minutes.
- Non-goals: what the agent asked (no text), which agent or session, which folder or project, any id or serial; why an
  agent did not ring; engines other than the three a notice names; computers that are signed out; a new sender,
  endpoint or file.
- Anti-goals: a count that identifies a person or reveals their work; any change to the daemon core
  (`cli/src/core/`); a scan of homes on a hot path; a second way of counting notices beside the new counts.

## Constraints

- The core is not touched: the devices component, the gateway and the backend only. The vocabulary file stays out of
  the core's imports (`cli/src/architecture.coreFiles.txt` gains no line).
- `cli/src/lib/dialUsageContract.ts` and `backend/src/types/dialUsage.ts` stay byte-identical (the existing test checks
  it).
- `npm run test:core`: 100% per file for touched `src/services/` files. Backend tests for the vocabulary and the review.
- Release order: backend first, then CLI. An older backend drops each name it does not know from a report, keeps the
  rest and counts `health_cli_report_unknown_metric` (`backend/src/routes/productUsage.ts` `withoutUnknownCounters`);
  it refuses only a report left with no known name. The new names sent to an older backend are lost, so the backend
  that knows them ships first. The PR body says so.
- Platforms: macOS, Linux, Windows, with no platform-specific code.

## Approaches

The measures are Ken's; the open choice was the denominator's source.

1. **The recorded folders, read at the setup's passes and each UTC midnight** (chosen). Cheap (a few small reads a
   few times a day), reliable (it reads the file, so a skill the person deleted is not counted), and it covers both
   writers (the devices' setup and the `enable` command).
2. **The dial setup's record alone** (`dial-setup.json` homes non-empty). No file read, but a folder stays recorded
   after the person deletes the skill (`left removed`), and the command's homes are missed. Rejected: not reliable.
3. **The setup passes' own results** (written / same / updated). No extra read, but passes run only at the devices'
   start, an Orca homes change and an attach, so a computer whose devices run for days without an attach gets no flag
   on those days. Rejected: misses days.

## Decided

- Ken (2026-11-26): the sixteen names and their meanings above; the review's Dial skill part; backend first, then CLI.
- Builder's calls (this spec), each reversible:
  - The denominator reads the recorded folders, as above, at the setup's start and attach passes and each UTC
    midnight.
  - Answered counts every kind of shown notice; a tap is not a prompt; the 10 minutes run from the devices' `shown`
    answer.
- harness-pm (2026-11-26): answered counts only the person's prompt (the prompt hook's `person` or `dial`, or the
  dial's delivered voice), never an agent's own continuation or a resume replay; tested at the usage layer and in the
  devices service. With that signal an open notice no longer drops at the last detach.
  - The sink counts nothing while signed out (existing rule): a computer that signs in after the day's check, with no
    attach later that day, gets its skill flag at the next midnight's check. Rare; accepted.
  - The existing `[device] notify` log line stays as the per-notice debug line (the end-to-end test
    `cli/e2e/deviceNotify.e2e.ts` reads it); the counts are the measure.

## Design (docs/feature-design-rules.md)

Reviewed revision: this spec. Each line: answered / N/A because …

1. **Growth.** Backend: daily totals in `product_usage_totals`, one row a UTC day and name (and its `staff:` and
   `testing:` copies): at most 16 × 3 = 48 new rows a day whatever the number of computers, deleted by the existing
   TTL after 396 days. Computer: up to 16 more names a day in `dial-usage.json`, which keeps 35 days and drops its
   oldest days past `DIAL_USAGE_FILE_MAX_BYTES`; the gateway's sent-record follows the file's days. Memory: the open
   notices for "answered" (at most 20, cleared on stop) and one midnight timer. Lifecycle: a count is created at its
   event, raised to its cap, sent, and removed with its day; nothing is updated after its day closes; no other state.
2. **Concurrency.** The devices process is the file's one writer (the existing sink, batched writes); the gateway its
   one reader at its report tick; the backend's existing totals path (`$inc` per day and name, its busy/retry
   handling). Nothing new locks.
3. **Read cost.** The review reads 28 days of 48 more names at most (≤ 1,344 more rows) with the existing plain
   `$match` on the (day, name) index; its integration plan test covers the longer `$in`. The gateway's tick reads the
   file it already reads (≤ 128 KiB). The skill check reads at most 129 small files an engine a few times a day, one
   to three usually. A report adds at most 16 counters a computer a day.
4. **Scale.** At 10× computers the backend rows stay 48 a day (totals, not per computer) and each report grows by ≤ 16
   counters. At 10× notices a counter stops at `DIAL_USAGE_MAX_COUNT` (100,000 a day), far above the skill's own limit
   (20 an hour). The first warning: `dial_file_unreadable_installation_days` (a file past its bound) and
   `health_cli_report_unknown_metric` (names a backend did not know).
5. **Compatibility.** Older CLIs send none of the names: their rows read 0 and the review hides empty rows. An older
   backend drops the new names from a report and keeps the rest (counting `health_cli_report_unknown_metric`): the
   backend that knows the names ships first, or those days' new counts are lost. Every reader of the vocabulary (from a search of the code): `cli/src/cable/dialUsageFile.ts`
   (keeps file names only), `cli/src/cable/dialUsage.ts` (writes them), `cli/src/gateway/dialUsage.ts` and
   `cli/src/gateway/productUsage.ts` (send device names as they come, flags told by name),
   `backend/src/routes/productUsage.ts` (accepts the copy's names), `backend/src/lib/productUsage.ts` (the report's
   type), `backend/src/analytics/dailyDialReview.ts` (reviews them). None needs more than the new names, but the review.
6. **Migration and rollback.** No migration and no new field or index. Order: backend release, then CLI release. Rolling
   the CLI back stops the counts; rolling the backend back while new CLIs run makes it drop the new names from their
   reports, keeping every other count, until the backend is back. No production data to check
   against: the growth estimate above comes from the vocabulary, no production read (backend rule 5, as #4561).
7. **Audience.** Written by signed-in clients, read only by the team's `usage:daily` review. Every value is a fixed name
   and a number: no notice text, agent, session, folder, path, id or serial reaches the file, the report, a log line or
   the backend. Agent ids live only in the devices' bounded in-memory map. Cells under 5 computers show "<5".
8. **Identity.** The existing signed-in report's account link only; the opt-out is the account's existing "Share
   product usage data".
9. **Failure.** A folder the check cannot read reads as not holding the skill, and the next check reads it again. A
   devices restart loses the open notices (answered is then not counted for them; a limit the review states). A report
   refused is the gateway's existing retry and drop; an unreadable file is the existing
   `dial_file_unreadable_installation_days`. A computer off all day sends nothing for that day, like every dial name.
10. **Platforms.** macOS, Linux, Windows, the same names and code. On Windows the devices run inside the core's
    process (#4513): the counts add no core rule, only names in the devices' own file. The skill check uses
    `dialSkill.ts`'s existing per-platform ownership rules (uid, or the Windows profile root).

## Left to the builder

The exact functions and their places (the skill check beside `held()` in `devices/dialSkill.ts` or in
`devices/dialSkillFiles.ts`; the notice counts and the answered map in `cable/dialUsage.ts`); how the midnight timer is
armed (the devices' `timerIn`); the review's row labels and order; tests at each layer: the vocabulary (names, flags,
byte-identical copy), the devices' counts and the answered window, the skill check against real temp folders, the
devices service wiring at 100%, and the backend review.
