# Needs you, right, Part 5: a second look when a turn stops

> **For agentic workers:** REQUIRED SUB-SKILL: devcrew phase 3 implements this plan task by task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** a Claude Code or Codex turn that ends on a question to the person, while a dial is attached, the person is
away from that agent and the agent rang nothing, is stopped once and asked to decide: ring the dial with `harness device
notify`, or end. The turn's first end is never announced as done. Nothing else about how a turn ends changes.

**Architecture:** the Harness Device plugin gains a `Stop` hook for Claude Code (`hooks/hooks.json`) and for Codex
(`hooks/codex.json`). It runs `harness device claude stop` or `harness device codex stop`
(`cli/src/deviceClaude/stop.ts`). That command reads the hook's input in its own process. It ends and tells the
devices nothing for a headless run (`claude -p`, `codex exec`), a session in Harness's data folder, or the skill not
on. Otherwise it reports every stop to the devices' listener with one new message, `nudge` (engine, session id and
`ask`), and waits at most 300 ms. `ask` is true when `stop_hook_active` is not set and the last 400 characters of
`last_assistant_message` hold `?` or `？`. On `{ "nudge": true }` to an ask it prints Claude Code's and Codex's block
(`{"decision":"block","reason":…}`). With `ask` false the devices only take the report. With `ask` true they answer
yes only when a dial is attached, that agent rang no notice in this turn (a card left from an earlier turn does not
count), the person is not present (Part 2's `present`), and the agent was not nudged already. A turn started by
another session's message (a `relayed` prompt) is no prompt of the person's: it neither starts a new turn for that
check nor ends the once rule. The observed source (`cable/hosts/observed.ts`) remembers the sessions that reported (at
most 64), and holds such a session's native turn-stop until its report arrives, or 6 s, so a late report on a slow
machine still comes before the turn is told done (decision 18). A yes tells the source that this outside agent's stop
goes on. The source then holds that agent's turn end until its next stop, or until the session has been quiet for
10 s since its last activity, and at most 120 s from the yes; when the hold expires, the turn end is announced. A
Harness agent's first end is already left unannounced by its reader (`stopHookContinuation`, and for Codex a turn
that stays open) and `DONE_QUIET_MS`. The eval measures the hook first, as two variants the fake `harness` answers,
each against the same text without it: v6 (v1 and the hook) against v1, then v5 (v4 and the hook) against v4. (b), v6
against v1, is reported, not a gate; the product is built only if (a), v5 against v4, shows no harm (decision 10). Its
gain is read in the field: four fixed names in the dial's usage counts, `dial_nudge_<claude|codex>` (a yes) and
`dial_nudge_<claude|codex>_rang` (a notice rung in the held continuation after that yes), which the backend takes
first (decision 7). The core, `cli/hook/notify.mjs`, `core/observedHook.ts`, the engine readers and the firmware do
not change; the backend gains only those four names and their review lines.

**Tech Stack:** TypeScript (Node 24), Vitest (unit, `cli/e2e`, the eval's own config), POSIX sh and Windows PowerShell
for the hooks, Claude Code 2.1.332 and Codex 0.172.0 for the spike and the hand checks, `claude -p` for the eval.

**Spec:** [docs/plans/2026-11-26-needs-you-right-design.md](2026-11-26-needs-you-right-design.md), section "Part 5. A
second look when a turn stops", with Part 1 ("Hooks in a variant", "Targets and gates", "Cost"), Part 2 (`present`),
Part 4 ("Round 2", the gate), Part 7 (the Codex manifest and its trust write), "Design", "Release order", "Platforms",
"Tests (red first)", "Docs in the same pull requests" and "Decided by the maintainer". The approved text is `main`'s
spec after Part 4's pull request (#4672) merges, plus this branch's first commit, which the main session makes after
the rebase (G1): Part 5's status (opened by a miss in use), the hold rule, the two-pair ship rule and the $270 cap;
then 8d3141a0f7: the hook's steps 1-3 (a report at every stop, `ask`) and "Turn ends" ("Its report comes late");
then 0ac8d38707 (replacing d6c6f67a0d): Part 5's "Measured" (the PM, 2026-11-27: (b) run and failed as a gate, so
reported, not a gate; (a) the gate; the gain read in the field by four counts; kept or removed after 7 days) and
"Design", "Part 5's counts".
References: [Part 4's plan](2026-11-27-needs-you-right-part4-plan.md) (on `main` after #4672; the eval's mechanics,
the `recall vs best` pair and the session-start command this plan reuses) and
[Part 7's plan](2026-11-26-needs-you-right-part7-plan.md) (the Codex plugin, its trust, the spike recipe).

## Decisions that bind this plan

1. **Gates.** **G0 is open** (the PM and the spec's author, 2026-11-27), by a miss in use, not by the eval. Part 4
   shipped v4 (#4672: v1's skill text and a SessionStart line, `harness device claude start`). v4's held-out recall was
   48 of 48 in `crowd`, 32 of 32 in `clean` and 16 of 16 in `name-only`, so the eval alone kept Part 5 shut. Then a
   Claude Code session days long, with the skill and v1's text, ended a turn on a decision only the maintainer could
   make and rang nothing. v4's line comes back only at start, resume, clear and compaction, so in a long session it
   sits far back in the context. That is the case this part catches.
   **G1** means #4672 is merged into `main`, this branch is rebased onto it, and the spec's Part 5 edits are committed
   as the branch's first commit after the rebase. The main session makes that commit; it is not a task. G1 comes first
   because Part 4 edited the same plugin files, `command.ts`, the eval's harness and the spec.
   **GO** means the PM approves this plan and says go for Task 4's spend. No eval runs before. The maintainer raised the
   design's cap to $270 for Part 5 (2026-11-27). The flow has spent S = $197.01 (Part 4 round 2's status row), so the
   headroom is $72.99, and Task 4's plan needs about $70 ($25 for (b), $45 for (a)), the flow then at about $268.
   **V** means Task 4's verdict is that the hook ships (decision 10: (a) passes).
2. **Eval first, then the product** (spec, Part 1: "Parts 4 and 5 are measured this way before any product code"; the
   PM's decision, 2026-11-27). Tasks 2-5 measure the hook through the fake `harness`. Tasks 6-17 start only after V. If
   the hook does not ship, the pull request carries Tasks 2-5 alone (only the eval lands). No product code exists then,
   so nothing has to be cut.
3. **The core does not change.** No file joins `architecture.coreFiles.txt`. No request joins `core/api.ts`.
   `cli/hook/notify.mjs` and `core/observedHook.ts` stay as they are. `nudge` reaches only the devices' own listener.
   The hold lives in the devices process (`cable/hosts/observed.ts`, `services/devices.ts`). No engine reader changes:
   Task 1's F5 found that Codex's reader (`engines/codex/normalizer.ts`) makes no event of the hook's prompt and keeps
   the turn open, so Task 13 is dropped.
4. **"The skill is on" is read in the hook's own process.** It uses the `acts` that `command.ts` passes to `runStart`
   on `main` after #4672: Claude Code `pluginActs(deps.dataDir) && ownSkillIn(claudeHome())`; Codex
   `readRemoved(deps.dataDir).codex !== true && codexPluginState(deps.codexHome) === 'on' && ownSkillIn(deps.codexHome)`
   (`ownSkillIn` from `deviceClaude/start.ts`). Only the hook knows its session's home, so the devices check the other
   conditions.
5. **Once.** Claude Code's `stop_hook_active` ends the second look. The devices also refuse a second yes for an agent
   they nudged until the person's next prompt to it (an outside `turn-start` whose source is `person` or `dial`; a
   `relayed` one does not count), the agent leaving, or 10 minutes (Task 9). This holds even for an
   engine or version that does not set `stop_hook_active` on the continuation.
6. **Harness's own one-shots get no look.** The rule is Part 4's decision 13: a hook input whose `cwd` is the data
   folder or inside it (`within`).
7. **The gain is measured in use, by four counts** (the PM, 2026-11-27; the spec's Part 5, "The gain, in the field",
   and "Design", "Part 5's counts"). In the dial's usage counts, for `DIAL_SKILL_ENGINES` (`claude`, `codex`), fixed
   names and numbers, no id or text, added as #4650's and #4653's were:
   - `dial_nudge_<engine>`: a stop the devices said yes to (Task 8's `yes` answer), counted at that answer;
   - `dial_nudge_<engine>_rang`: a notice of that agent rung (shown, not held quiet) in the continuation after that
     yes, before its next stop or the hold's end, at most once a yes. For an outside agent the window is Task 7's hold
     (`entry.secondLook.continuing`, `'heard'` or `'awaited'`), and the mark that the yes may still count lives on that hold and
     goes with it (the spec's "one mark on a held stop"). For a Harness agent, which has no observed hold, the window is
     Task 9's `'asked'` or `'continuing'` phase (until its continuation's `done`), and the mark lives on Task 9's entry
     (open question 1).
   Neither is a computer flag (no `_installation_days`). The backend takes the names first (Task 16), released first;
   then the CLI counts them (Task 17). The `[device] nudge` engine tally stays the log's debug line. The PM reads the
   counts for 7 days after the release (Pull request notes).
8. **Platforms:** macOS, Linux, Windows. The hooks use the plugin's two-shell form (POSIX sh, Git Bash, PowerShell).

The PM's decisions on the draft's open questions (2026-11-27):

9. **Two variants, each paired with the same text without the hook** (Task 3). **v5** is v4's `SKILL.md`, v4's
   `hooks.json` (its `SessionStart`) and the Stop hook, paired with v4. **v6** is v1's `SKILL.md` and the Stop hook
   alone (no `SessionStart`), paired with v1's committed `crowd` held-out rows (41 of 48). v1 is v4 without its line:
   it stands for a long session whose line is far back. v1's and v4's `SKILL.md` are the same bytes.
10. **Part 5's ship rule** (the PM, 2026-11-27; the spec's Part 5, "Measured", as 0ac8d38707 states it). Two pairs,
    held out (val and test pooled), with the extra rounds per run reported. v4 already rang every held-out ask, so a
    gain over it cannot be measured. **(a) is the only gate: the hook ships if (a) passes; if (a) fails, only the eval
    lands.** (b) was run first as a gate and failed; the PM then ruled that short `claude -p` runs cannot make the
    hook's case, so (b) is reported, not a gate (a gate moved after its run, stated as such), and the gain is read in
    the field (decision 7). The trigger stays the `?`: a look at every stop that rang nothing would cost a model round
    at almost every turn.
    - **(a) No harm, the gate:** v5 against v4, val and test in every condition (`crowd` 3 reps, `clean` 2, `name-only` 1).
      Recall down beyond noise in none. At most 2 needless rings in the 54 pooled held-out no-need runs (27 + 18 + 9).
      `harmed` and `went_on` at most v4's in each condition, one run either way being noise (the PM, 2026-11-27):
      v5's `harmed` count at most v4's + 1, and its `went_on` count at least v4's - 1. `nudged` and the cost
      per run are reported, not gated. Against v4 the need runs already ring, and the fake blocks only before a ring,
      so it blocks almost nothing there: this pair measures harm, not gain.
    - **(b) The case it is for, reported, not a gate:** v6 against v1's committed `crowd` held-out rows (41 of 48),
      `crowd` val and test at **3 reps** (75 runs, 48 of them need runs), read **at run level**: Fisher's exact test,
      one-sided, on v6's held-out need hits against v1's 41 of 48 (it would have passed at p < 0.05, 47 of 48 or more).
      Counted by run, as the spec says: v1's 7 misses sit in 4 of the 16 cases (`retry-policy-rollout` 0 of 3,
      `tax-rate-unknown` 1 of 3, `security-key-touch` 2 of 3, `xcode-license-sudo` 2 of 3), where a paired case
      interval is no test of (b); that interval is reported too. **Run 2026-11-27:** v6 44 of 48, p = 0.262, and the
      hook blocked none of the 75 runs: the 4 misses went on without a `?`, and the 6 runs that ended on one had
      already rung.
    - **"Beyond noise"** for (a)'s recall is Part 4's (its decision 9; `lib/summarize.ts` `pairOf`, the held-out
      table's `recall vs best` column, `recall vs base` after Task 2). Per case, take the mean `hit` over that variant's
      own reps; pair the variant's case means with its base's over the held-out need cases both scored; take the 95% t
      interval of the differences (`interval`, t at n - 1 df). Down beyond noise: the high end below 0. Task 2 makes
      `summarize` pair v6 with v1 and v5 with v4 (`_state.json` `bases`), since the best round is v4, and gives (b)'s
      Fisher p beside it.
11. **Order:** eval first, product only after the verdict (decision 2). In Task 4, pair (b) ran first and failed; per
    the PM (2026-11-27) (a) runs anyway, as the verdict rests on it alone. (a) runs only when S + $46 <= $270; over it,
    Task 4 stops and reports to the PM, who asks the maintainer. The cap is never raised by the flow. If (a) fails, no
    product is built (Tasks 6-17 do not run), and the branch carries the eval and its rows alone (Tasks 2-5).
12. **The hold, as the spec states it** (the PM's rule, 2026-11-27). After a yes, the devices hold the outside agent's
    turn end until its next stop, or 10 s of silence after the session's last activity, at most 120 s from the yes:
    `CONTINUE_QUIET_MS = 10_000`, `CONTINUE_MAX_MS = 120_000`. When the hold expires, the held turn end is announced
    (Task 7). **Activity** is what the observed source already sees of a session, and nothing new:
    - any hook event `ObservedSource.ingest` takes for that entry (it sets `agent.lastActivityAt`; outside a pane these
      are the native hook's events, such as `subagent-start` and `subagent-stop`, since no tool events reach Harness);
    - the session's transcript growing: `deps.fileStamp(entry.transcriptPath).mtime` (`lib/sessionSearch/externals/support.ts`
      `fileStamp`, which `checkWorking` already reads), later than the last activity counted. That is Claude Code's
      transcript, or Codex's rollout.
    The last activity starts at the yes. A transcript that cannot be read (`fileStamp` null) shows no activity.
13. **A Harness agent reads "not present"** from the yes until its continuation ends (Task 9).
14. **No second look, and no report, for headless runs** (`claude -p`, `codex exec`; Task 10). Claude Code:
    `CLAUDE_CODE_ENTRYPOINT` starts `sdk-` (`sdk-cli` under `-p`, `cli` in the TUI; F1). Codex: only the rollout says
    it (F8), on the first line of `transcript_path`, `{"type":"session_meta","payload":{…,"source":"exec",…}}`, or
    `"mcp"` (Codex run as another agent's MCP tool).
15. **Windows by hand:** one hand check on the Dell x64 Windows test PC with throwaway profile folders, under the Dell
    rules: the testers act on their own, no reboot, no change to Smart App Control, no real accounts, and everything
    restored afterwards (Verification 5).
16. **The cap is $270** (the maintainer, 2026-11-27). Every Task 4 invocation passes `--spend-cap-usd 270`, never more.
    The runner refuses a cap above its `DESIGN_CAP_USD`, which is 250 on `main`, so Task 2 raises it to 270.
17. **No scenario for the miss in use** (the PM, 2026-11-27). A new scenario would change the splits. Pair (b) stood
    in for the long session by leaving the line out, and did not reproduce it (0 of 75 runs blocked); the field counts
    (decision 7) read it instead.
18. **A report at every stop; the turn-stop waits for it** (the PM, 2026-11-27; the spec's Part 5, steps 1-3 and "Its
    report comes late"). F9's margin is about 140 ms on this Mac, and Windows PowerShell hooks take 1.5 s to 7 s, so a
    nudge would often come after `ANSWER_GRACE_MS`. The hold must not rest on the grace.
    - The command reports every stop that passes step 1 (input parsed, session id valid, `cwd` outside the data folder,
      not headless, the skill on), with `ask`. `stop_hook_active` set, or no message, is `ask: false`, still reported.
      Step 1's failures tell the devices nothing.
    - `ask: false` is answered `{ nudge: false }` at once. The devices check nothing and change nothing but the held
      turn-stop's release: no presence read, no once rule, no "rang in this turn" change. It is tallied by its word
      alone (`no ask`). It gives away one bit, the one a nudge's existence gave away before.
    - The observed source remembers the sessions that reported: a mark on the session's entry (`entry.secondLook.reported`), in
      memory only. It goes with its entry, so at most the source's 50 sessions (`MAX_SESSIONS`) are marked, within the
      spec's 64, the least recently active out first as the source drops entries today; no second list is kept. Any
      report sets it.
    - A marked session's native `turn-stop` is held from its arrival until its report, or at most
      `REPORT_WAIT_MS = 6_000` (the hook's 5 s timeout and 1 s). A report `no` (or `ask: false`) releases it: it is
      told done at the grace's end (`ANSWER_GRACE_MS` after the turn-stop), or at once when the grace has passed. The
      grace stays the floor because it guards the transcript's lag behind the Stop (`ANSWER_GRACE_MS`'s comment). A
      yes starts Task 7's hold. At `REPORT_WAIT_MS` with no report, the turn end is told done, the mark is cleared,
      and `[observed] stop report missed` is logged: a plugin turned off mid-session stops delaying it.
    - A report before its turn-stop (either order is possible) is matched: a no is kept on the entry as
      `secondLook.earlyReport` (the time it came) and consumed by the next `turn-stop` within `REPORT_WAIT_MS`, which then takes
      the grace as today; a yes is Task 7's `'awaited'` hold. A `turn-start`, `needs-input`, `turn-error`,
      `turn-aborted` or `session-end` drops an early report, as each drops a held stop. A report while the lead's
      subagents run is kept only as the mark: its own stop is not held (as today), so its report is not kept for the
      next one.
    - A session not marked (its first stop, or one listed again after the source dropped it) rests on the grace as
      today: a report inside the grace marks it and, if a yes, holds the stop; a yes after its end was told starts no
      hold. A stated limit.
    - No `SessionStart` registration.

## Facts settled by the spike (Task 1, 2026-11-27)

Task 1 ran Claude Code 2.1.332 and Codex 0.172.0 against local stubs on this Mac. Every fact held and no stop
condition was hit. The records stay in the main session's scratchpad (`spike/`), never committed.

- **F1, Claude Code.** A plugin `Stop` hook's input keys: `session_id`, `transcript_path`, `cwd`, `prompt_id`,
  `permission_mode`, `effort`, `hook_event_name`, `stop_hook_active`, `last_assistant_message`, `background_tasks`,
  `session_crons`. The block on stdout, exit 0, continues the same turn (12 of 12) with no `UserPromptSubmit` between.
  The block reaches the model as a hook's meta line, not as a prompt of the person's: after `end_turn` the transcript
  has an `isMeta` user line from the hook, a `hook_blocking_error` attachment (`hookEvent` `Stop`, which
  `stopHookContinuation` reads), a `stop_hook_summary` system line, then the continuation. The attachment comes
  334-388 ms after `end_turn` warm and 1,165 ms at a session's first Stop, inside `DONE_QUIET_MS`. The second Stop has
  `stop_hook_active: true`. `claude -p` honors the block, from project settings and from the default sources.
  `CLAUDE_CODE_ENTRYPOINT` is `cli` in the TUI and `sdk-cli` under `-p`. Task 10 reads only the fields it names.
- **F2, Codex.** Stop input keys: `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
  `permission_mode`, `stop_hook_active`, `last_assistant_message`. The same block JSON is honored. Both engines get one
  block.
- **F3, Codex's continuation** goes on in the same turn (the same `turn_id`), with no `task_complete` between the two
  Stops.
- **F4.** No `UserPromptSubmit` fires for Codex's hook prompt (21 of 21, and under `exec`). No `turn-start` reaches
  the devices for it, so no prompt source is added and the person's-prompt path is unchanged.
- **F5.** The rollout writes the hook prompt as a `response_item` `message`, role `user`, `input_text`
  `<hook_prompt hook_run_id="stop:…">…</hook_prompt>`, provenance `{ type: "harness", hook: true }`, then an
  `event_msg` `item_completed` of type `HookPrompt`. `engines/codex/normalizer.ts`, replayed live, makes no event for
  either; the turn stays open, with one `turn_ended` at `task_complete`. Task 13 is dropped.
- **F6.** Codex's continuation Stop has `stop_hook_active: true` (21 of 21, and under `exec`).
- **F7.** `hooks/list` shows the key `harness-device@openharness:hooks/codex.json:stop:0:0`, matcher null, `trusted`;
  the hash is the same with or without a matcher.
- **F8.** No input field or environment variable tells `codex exec` reliably (`permission_mode` is `bypass` under
  `exec`, and likely under a `--yolo` TUI too). The rollout at `transcript_path` does: its first line is `session_meta`
  with `payload.source` `"exec"` (the TUI: `"vscode"`) and `payload.originator` `"codex_exec"` (`"codex-tui"`). That
  line is about 22 KB (21,922 and 21,923 bytes), most of it `base_instructions`. Task 10 reads `source`.
- **F9, timing on this Mac.** The native `notify.mjs` turn-stop reached the daemon first in every run. The nudge (the
  plugin hook's CLI exit) came after the native hook's exit: Claude Code median 248 ms, maximum 1,060 ms (a cold first
  Stop); Codex median about 250 ms, maximum 954 ms (cold). From the answer's end: the native hook exits at 68-152 ms,
  the nudge at 307-605 ms warm and 1,139 ms cold. With the full 300 ms nudge bound the cold worst case is about
  1.36 s after the turn-stop: inside `ANSWER_GRACE_MS` with about 140 ms to spare. Today the dial gets one `turn.done`
  at about 1.57 s for the blocked stop's first end, which Tasks 7 and 8 fix. Decision 18 removes the dependence on the
  margin for every session that has reported once.
- **F10, activity in a continuation.** The longest quiet gap from the block to the next Stop: Claude Code at most
  1,994 ms, Codex at most 2,045 ms, both the stub's 2 s tool run; none past 10 s. Decision 12's 10 s and 120 s stand.

## Context: what the code does today (read for this plan)

- **A Harness agent's blocked stop (Claude Code).** The live reader closes the turn at `end_turn`. Then a
  `hook_blocking_error` attachment for `Stop` opens it again as `turn_started { userMessage: 'Continuing: <reason's
  first line>' }` (`lineToEvents`). `CommanderMirror.ingest` (`lib/commander.ts`) calls `notifications.started()`, which
  tells the pending decision null with `next-turn` inside `DONE_QUIET_MS` (1.5 s, `lib/agentNotifications.ts`). It also
  aborts a recap still being made. So the first end is never news, as long as the attachment is written within 1.5 s of
  `end_turn`. That covers the plugin hook's run plus the nudge. The `/goal` loop already relies on this
  (`e2e/harness/fakeEngine.mjs` `goalloop`). The devices still see the continuation's `processing`, which sets a new
  `began` (`services/devices.ts` `dispatch`). For a Harness agent, Part 2's `harnessPresent` reads that `began`.
- **An outside agent's stop.** `notify.mjs` posts `turn-stop`. The observed source holds it for `ANSWER_GRACE_MS`
  (1.5 s, `entry.heldStop`) and then calls `finish`, which sets `done`, reads the answer and lets the dial hear it. A
  `turn-start`, `needs-input`, `turn-error`, `turn-aborted` or `session-end` drops the held stop (`dropStop`). Outside a
  pane, Harness hears no tool events. So a Claude Code turn continued by a blocked stop is told done 1.5 s after its
  first Stop, and again at its next Stop. `checkWorking` leaves an entry with a `heldStop` alone.
- **Prompt sources.** `ObservedSource.ingest` returns `'person' | 'relayed' | 'dial'` for a `turn-start`.
  `services/devices.ts` `port.observed` counts `person` and `dial` as the person's prompt: it sets `prompted` (Part 2's
  outside presence), follows the dial (`followPrompt`), counts `usage.turnStarted(…, true)` and ends the agent's notice.
- **The notice path.** `noticeCaller` resolves engine and session id to an agent: a Harness agent by
  `core.agents.advertised()`, else an outside row, else `observedAgentId`. The listener's `notice` handler calls
  `notices.notify(ask)` and counts a `shown` one. `Notices.pending(agentId)` says whether a card is pending, which may
  be one left from an earlier turn. `present(agentId)` is Part 2's rule. `cable.isConnected` says whether a dial is
  attached.
- **Turn marks.** `began` (`Map<agentId, Date.now()>`) is set by `dispatch` at a turn's first `processing` card and
  deleted at its `done`. For a Harness agent it is the only turn mark; who started that turn only the core knows. For
  an outside agent it restarts with any turn, a `relayed` one too. `prompted` (`Map<agentId, monotonic>`, at most
  `PROMPTED_MAX`) holds an outside agent's last `person` or `dial` prompt, and is deleted at any other turn-start, so
  neither can say "this turn" as the spec means it (Task 8 keeps one set for it).
- **The listener.** `services/devicesListener.ts` handlers are typed `ListenerHandler { maxBytes, perSecond, handle }`.
  `noticeHandler` is the model: it validates, hands on typed fields, keeps nothing and logs nothing.
  `devices/listenerClient.ts` `askDevices` returns the answer's object, a status number, or null.
- **The eval.** `cli/evals/dial-skill/lib/stage.ts` `fakeHarness` answers a call whose argv matches exactly, with fixed
  output, and records every call in `rec/calls.jsonl`. A variant's `hooks.json` and `harness-answers.json` are staged
  as the repo's `.claude/settings.json` and are refused unless `_state.json` `harness_paths` lists them
  (`run-eval.mjs` `variantHooks`). The fake cannot yet answer by its input. `summarize` pairs each round's held-out
  recall with `_state.json`'s best round (`recall vs best`), which is round 4 (v4). `run-eval.mjs` refuses a
  `--spend-cap-usd` above `DESIGN_CAP_USD = 250`.

## Global Constraints

- **The reason** is one line of printable ASCII, used word for word. The eval measures it in Task 4:
  `Your answer asks the person something, and they are not at this session. If the task cannot go on without them, run harness device notify now, as the dial skill says, and end your turn. If nothing is needed from them, end your turn.`
- **The block:** exactly `JSON.stringify({ decision: 'block', reason: DIAL_STOP_REASON })` and a newline, or nothing.
  Both engines get the same block (F2).
- **The ask:** `stop_hook_active` is not `true`, and the last 400 characters, counted by code point, of a string
  `last_assistant_message` hold `?` (U+003F) or `？` (U+FF1F).
- **The command** (`harness device claude stop`, `harness device codex stop`) reads stdin whole with `hookInput`
  (asked.ts, at most 256 KiB). It takes `stop_hook_active`, `last_assistant_message`, `session_id` (held to
  `NOTICE_SESSION`) and `cwd`, and for Codex `transcript_path`, whose first line alone it reads (decision 14), and
  nothing else. Nothing of the message or of that file leaves its process: it is not sent, logged, printed or kept. It
  prints only the block and always exits 0. It stays out of `DEVICE_USAGE`.
- **The order of checks** (the spec's steps 1-3): the input parsed and its session id valid; `cwd` (decision 6); a
  headless run (decision 14: Claude Code's environment, Codex's rollout head); "the skill is on" (decision 4, which
  reads files); then the tail check, which sets `ask`; then the report. A failure before the tail check ends the
  command with nothing asked. Nothing is read from a file before the session id and `cwd` pass.
- **`nudge`:** `{ type: 'nudge', engine: 'claude' | 'codex', sessionId, ask: boolean }`, answered
  `{ nudge: boolean }`, sent at every stop that passes step 1 (decision 18). `NUDGE_ANSWER_MS = 300` bounds the request
  and its answer (`askDevices` `timeoutMs`). No answer, any status, or any other body means no, and a yes to an
  `ask: false` prints nothing. `NUDGE_MAX_BYTES = 256` and `NUDGE_PER_SECOND = 1` (per connection; each hook is one).
  The handler keeps nothing and logs nothing.
- **The report wait:** `REPORT_WAIT_MS = 6_000` (decision 18). A marked session's turn-stop is told at the later of
  its report and the grace's end, or at `REPORT_WAIT_MS` with no report.
- **Rang in this turn:** the agent ran `harness device notify` since its turn's mark: for an outside agent, its last
  `turn-start` from `person` or `dial`; for a Harness agent, its last new `began`. A card left from an earlier turn does
  not count, and a `relayed` turn-start is no mark.
- **The hold:** until the next stop, or `CONTINUE_QUIET_MS = 10_000` with no activity (decision 12), and at most
  `CONTINUE_MAX_MS = 120_000` from the yes. The held turn end is announced when the hold expires with no next stop.
- **The hook:** event `Stop`, no matcher, `timeout: 5`, `onFailure: 'continue'`, in the plugin's two-shell form. stdin
  reaches the launcher as the engine wrote it. The PowerShell form never reads stdin before the launcher or pipes it
  in; it reads the rest to its end after (`[Console]::In.ReadToEnd()`), as the sh script does. stdout passes only
  when it starts with `{"decision":"block","reason":`. stderr is dropped and the exit is always 0.
- **Codex trust:** key `harness-device@openharness:hooks/codex.json:stop:0:0`, written by Part 7's unchanged
  `pluginTrustRecords` (`REVIEWED.events` labels `Stop` `stop`, and its matcher is not hashed).
- **Logs:** fixed words only (`src/architecture.failureLogs.spec.ts`):
  `[device] nudge · <engine> · yes|no ask|no dial|notice|present|nudged`, `[observed] stop report missed` and
  `[observed] held stop · quiet|cap|unheard`.
  Never a session, a path, an answer or a reason.
- **Unchanged:** `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, `core/api.ts`, `cli/hook/notify.mjs`,
  `lib/agentNotifications.ts`, `engines/claude/normalize.ts`, `engines/codex/normalizer.ts`,
  `devices/codexPluginTrust.ts`, `DIAL_SKILL` and `DIAL_SKILL_DESCRIPTION`, the firmware, Desktop, the phone. The
  backend changes only by Task 16's four names and review lines.
- **The counts** (decision 7), verbatim: `dial_nudge_claude`, `dial_nudge_codex`, `dial_nudge_claude_rang`,
  `dial_nudge_codex_rang`. `cli/src/lib/dialUsageContract.ts` and `backend/src/types/dialUsage.ts` stay the same bytes
  (`backend/src/types/dialUsage.test.ts`). No session, agent, path or text reaches `dial-usage.json`, a report or a
  log line. "See what's shared" on Desktop and the phone is unchanged, as #4650 and #4653 left it: its "agents'
  notices to the dial" covers a notice's counts.
- **Eval:** every invocation of Task 4 passes `--spend-cap-usd 270`, `--concurrency 3` at most and `--timeout-s 900`
  (decision 16). On exit 3 or 4, stop and report the spend. Never pass a higher cap, switch accounts or work around a
  limit.
  `CLAUDE_CONFIG_DIR` is the session's profile, never `~/.claude`. No transcript text, judge reason, path or user name
  goes into any commit, `change.md`, narrative, README or pull request. Nothing CPU-heavy runs on the Mac.
- **Red, then green:** a behavior task commits its failing test first, then the change. Run only the named specs (the
  suites run on CI). No fixed sleeps: absence is shown against a later positive anchor. Commit only the files a task
  names. Comments say why. Docs are in English. Names follow `docs/naming-system.md`. One pull request.

## Design (docs/feature-design-rules.md)

A new local message is exposed, and four count names are stored and synced (decision 7), so here are their nine lines.

1. **Growth.** In memory: one hold per observed entry: a timer, a word, two times (the yes, the last activity) and
   the mark that its yes may still count a ring, one report mark and one early report time, within the source's 50
   sessions (decision 18: at most 50 marked, within the spec's 64; a mark goes with its entry or at a missed report).
   At most 64 nudged agents (Task 9), each with its engine and the same mark for a Harness agent, dropped at the
   person's next prompt, when the agent leaves, or after 10 minutes. At most 64 Harness agents' last turn starts
   (`lastBegan`, Task 9), each dropped at its next turn's first card or when the agent leaves. At most 64 agent ids that rang a notice in their
   turn (Task 8), each dropped at its next turn mark or when the agent leaves. On a computer, four more names a UTC day
   in `dial-usage.json`, within its 35 days and 128 KiB. In the backend, at most 12 more `product_usage_totals` rows a
   UTC day (four names, with their `staff:` and `testing:` copies), deleted by the existing TTL, whatever the number
   of computers.
2. **Concurrency.** One Stop event runs Harness's native hook and the plugin's hook side by side, so the native
   `turn-stop` and the report can reach the devices in either order. Task 1 saw the turn-stop first in every run; Task 7
   handles both orders. The devices process is single-threaded, and `nudge` is answered inside `part.call`.
3. **Read cost.** The hook spawns the CLI at every turn end where the plugin is on. The CLI reports to the listener at
   every stop that passes step 1, and for Codex reads at most 128 KiB of the rollout's head first. The devices answer
   from what they hold, with no read. Verification 3 gives the hook's time. A hold reads its transcript's `fileStamp`
   (one `stat`) only when it would go quiet, so at most once per 10 s per held session, and never past 120 s. A count
   is one add per yes and per rung notice in a held continuation. The review's query is the same plain `$match`, its
   `$in` four names longer, read by the existing (day, name) index; no new query.
4. **Scale.** One report per turn end of a session with the plugin on. `NUDGE_PER_SECOND` per connection and the
   listener's 16 connections bound a loop. At 10× computers the rows stay 12 a day; at 10× yeses a counter stops at
   `DIAL_USAGE_MAX_COUNT`.
5. **Compatibility.** A devices process older than the CLI answers `nudge` with a status, which reads as no; it never
   holds a turn-stop, so its turn ends are told as today. An older CLI under the new plugin prints its usage, which the
   hook's prefix check drops, and never reports, so its sessions are never listed. An engine whose Stop input has no
   `last_assistant_message` is reported with `ask: false` and never stopped. **An older backend** receiving the new
   names does not refuse the report: `withoutUnknownCounters` (`backend/src/routes/productUsage.ts`) drops each name
   its contract lacks, never stores or echoes it, keeps the rest and counts `health_cli_report_unknown_metric`; only a
   report left with no known name is refused (test `'drops a dial name it does not know and keeps the rest'`). So the
   backend ships first, or the counts are lost. An older CLI sends none of the names, and the review hides empty rows.
6. **Migration and rollback.** None. Rolling the CLI back removes the hook with the carried plugin at the next setup
   pass, and the counts stop; the backend's names stay, harmless, and the review hides their empty rows.
7. **Audience.** The answer's last 400 characters, and the Codex rollout's first line, are read in the hook's process
   alone. `nudge` carries an engine, a session id and one bit (`ask`, whether the tail asks) over this account's own
   socket or proven pipe. Its yes or no tells a local process of this account whether a dial would ring for that agent.
   The four counts are fixed names and numbers in the product usage report a signed-in computer already sends, which
   only the maintainers' `usage:daily` review reads (under five computers shown as `<5`); no session, agent or text.
8. **Identity.** The counts go with the signed-in computer's usage report, as every dial count does; everything else
   is local, this account.
9. **Failure.** No answer within 300 ms is a no. Any failure prints nothing, and the turn ends as it would without
   Harness. A report that never comes (the hook timed out, the plugin was turned off, an old CLI) leaves the turn-stop
   held at most `REPORT_WAIT_MS`: then it is told done, the session's mark is cleared, and `[observed] stop report
   missed` says so. A block that never takes effect leaves a held turn end, announced once the session has been quiet
   for 10 s, or at 120 s from the yes. A transcript that cannot be read shows no activity, so the hold goes quiet. A
   rollout head that cannot be read reads as not headless. A count that throws is the devices' own part's
   (`part.call('dialUsage')`) and changes no ring; a count lost (signed out, a file that cannot be written, an older
   backend) changes nothing else.

## Open questions (for the main session)

The PM answered the draft's seven on 2026-11-27 (decisions 9-15), then set the two-pair ship rule (decision 10) with
its run-level test for (b) and the one-run reading of `harmed` and `went_on` for (a), the spec's hold rule (decision
12), the $270 cap (decision 16), no new scenario (decision 17) and the report at every stop (decision 18); then, after
(b) failed, (a) as the only gate and the four field counts (decisions 7 and 10). Open, from the counts:

1. **A Harness agent's `_rang` window.** The spec places the count's mark "on a held stop", which only an outside
   agent has (Task 7's hold). A Harness agent's continuation is its reader's, not held by the devices. The plan reads
   its window as Task 9's `'asked'` or `'continuing'` phase (from the yes until its continuation's `done`, or the
   once rule's end), with the mark on Task 9's entry. Confirm, or count `_rang` for outside agents alone.
2. **`_rang` at most once a yes.** The plan counts the first rung notice of a held continuation and no more, so
   `_rang` never exceeds the yeses and the 7-day read ("at least a quarter of the yeses") is a share. Confirm.

## Review Focus

1. **The report comes late, or before its turn-stop** (the two Stop hooks run side by side; Windows PowerShell takes
   seconds). Expected: for a session that has reported before, the stop's end is never told before its report, in
   both orders and up to 6 s late; with no report it is told at 6 s and the session is no longer waited for; a report
   with `ask: false` only releases it. Task 1 saw the turn-stop first in every run on this Mac. Pinned in Task 7 (`'a
   marked session's stop waits for its report'`, `'no report: told at 6 s, and the session is no longer marked'`, `'a
   report before its turn-stop'`, `'the yes after the blocked stop'`, `'the yes before the blocked stop'`), Task 8
   (`'ask false changes nothing but the release'`) and Task 14 (cases 7, 10 and 11).
2. **A `?` the person would not call a question:** code in the answer's tail (`a?.b`, a URL query, a regex). Expected:
   at most one extra round, after which the agent ends, and never a second block. Pinned in Task 10 (a tail of
   `user?.name` asks, which states the bound), Task 9 (a second nudge is no) and Task 4 (`nudged` on the no-need runs).
3. **An answer in a non-Latin script on Windows PowerShell:** a re-encoded stdin would turn letters into `?`. Expected:
   PowerShell never reads stdin before the launcher, and the launcher reads the engine's bytes. Pinned in Tasks 11 and
   12 (the Windows form reads `[Console]::In` only after the launcher and has no pipe into it, and a win32 runner with a Vietnamese answer and no `?` prints
   nothing) and Task 10 (`Đã xong, không cần gì thêm.` does not ask; `要用哪个数据库？` asks).
4. **An older or foreign launcher under the new plugin**, printing its usage or another hook's JSON on stdout.
   Expected: Claude Code and Codex read nothing, because stdout passes only with the block's prefix. Pinned in Tasks 11
   and 12 (`'prints nothing but the block'`).
5. **The block never takes effect** (the hook timed out, or the engine dropped its output). The devices said yes and
   hold the end, but no next stop comes. Expected: the turn end is told once, when the hold expires (10 s of quiet, or
   120 s from the yes). Pinned in Task 7 (`'no next stop, quiet: told once 10 s after the last activity'`, `'the 120 s
   cap'`) and Task 14 (case 6).

Stated limits for the pull request:
- On Windows, Claude Code without Git Bash runs the hook in PowerShell, which takes 1.5-7 s. A Harness agent's first
  end can then be told before its continuation, past `DONE_QUIET_MS`. An outside agent's turn end waits for the report
  (decision 18), so it is told up to the hook's run time later, at most 6 s; a hook slower than 5 s times out, and that
  stop is told done at 6 s as it would be without the plugin.
- A session's first stop, before any report (and one the source dropped and listed again), rests on the grace as
  today. On this Mac a
  cold first Stop's report has about 140 ms to spare (F9); a slower machine may miss it, and that first end is then
  told done as today, and the continuation's end again.
- The hook spawns the CLI and reports to the devices at every turn end (Verification 3 gives the numbers).
- A `?` inside code in the tail costs one round.
- A continuation that writes nothing to its transcript for 10 s (one long model call with no tool) is announced done
  before its next stop, and one that runs past 120 s is announced at 120 s. Task 1 measured the longest quiet gap at
  about 2 s in both engines (F10: Claude Code 1,994 ms, Codex 2,045 ms, the stub's 2 s tool run).
- The eval runs Claude Code alone. Codex is judged by the field counts.
- The eval could not show the gain ((b): 0 of 75 runs blocked); the gain is read in the field by the four counts, and
  the hook is kept or removed on that read (Pull request notes).
- A yes whose hold could not start (a session's first stop, told done at the grace's end before its late report) is
  counted as a yes, and its ring can never count as `_rang`: on a slow machine this reads the gain low. The counts are
  only those of signed-in computers, as every dial count.
- A Harness agent's turn started by another session's message restarts its mark for "rang in this turn": the devices
  cannot tell who started a Harness agent's turn (only the core knows, and the core does not change). Such a turn that
  ends on a question with no notice of its own may get one look.
- No scenario is built for the miss in use: a turn in a long session that ends a long report with the ask only in its
  last lines. The nearest are the long multi-step need cases (`logger-migration-publish`, `retry-policy-rollout`,
  `security-key-touch`), whose last answer may be a long report, but none is built for it, and each run is one short
  `claude -p` session. No scenario is added, since it would change the splits (decision 17). Pair (b) stood in for
  the long session by leaving the line out, and did not reproduce it.

---

## Before V (G0 is open; Tasks 2-5 after G1)

### Task 1: the spike, both engines' blocked stop against a local stub (done, 2026-11-27)

**Effort:** high. **Depends on:** G0 (open). **Test that must fail first:** none (it measures and changes no
repository file).

**Results** (Claude Code 2.1.332, Codex 0.172.0, local stubs, this Mac; the facts above):
- F1-F10 all yes; no stop condition hit. 108 raw Stop inputs recorded.
- Claude Code: block continues the same turn 12 of 12; attachment 334-388 ms after `end_turn` warm, 1,165 ms cold.
- Codex: no `UserPromptSubmit` for the hook prompt 21 of 21; continuation `stop_hook_active` true 21 of 21; one
  `turn_ended` per turn in the reader's replay.
- F9: turn-stop first in every run; nudge after the native hook: Claude median 248 ms, max 1,060 ms; Codex median
  about 250 ms, max 954 ms; cold worst case about 1.36 s after the turn-stop, about 140 ms inside the 1.5 s grace.
- F10: longest quiet gap Claude 1,994 ms, Codex 2,045 ms; none past 10 s.
- Rollout head: `session_meta`, 21,922 bytes (TUI, `source` `vscode`) and 21,923 bytes (`exec`, `source` `exec`).

**Files:** none in the repository. Scratch only, in the session's scratchpad: the stubs, a throwaway hook script that
logs its stdin (keys and lengths only; message text is written only to the scratch record), the records, and the
report.

- [x] **Step 1: Isolate.** Use one scratch root with its own `HOME`, `CLAUDE_CONFIG_DIR=$HOME/.claude` and
  `CODEX_HOME=$HOME/.codex`. Use a dummy `ANTHROPIC_API_KEY` and `STUB_KEY`, and `DISABLE_AUTOUPDATER=1` and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Run everything under `env -i` with a curated `PATH` (Node, `claude`,
  `codex`, `/usr/bin`, `/bin`). Never use the tester's `~/.claude`, `~/.codex`, `~/.harness`, everyday daemon (port
  18473), login, or any backend.
  - The Anthropic stub answers `/v1/messages` streamed on `127.0.0.1`, as Part 4's Verification 1 does. The first
    answer ends `Which database should the export use?`. Once the request holds the hook's reason, it answers `Done
    deciding.`.
  - The Codex stub is Part 7's (`[model_providers.stub]`, `wire_api = "responses"`), with the same two answers.
  - Each stub records every request body.
- [x] **Step 2: Claude Code (F1, F9).** Load a plugin folder holding a `Stop` hook that runs the throwaway script, with
  `claude --plugin-dir <folder>`, in a private `tmux -L <unique>` server. The script prints the block of the reason the
  first time and nothing after. Record:
  - the Stop input's keys;
  - whether the stub's second request holds the reason;
  - the transcript lines after the first `end_turn`;
  - whether any `UserPromptSubmit` ran between the two Stops;
  - the second Stop's `stop_hook_active`;
  - `CLAUDE_CODE_ENTRYPOINT` in the hook, under the TUI and under `claude -p`.
  Then `claude -p` with the hook in a scratch repo's `.claude/settings.json` and `--setting-sources project`: is the
  block honored? Repeat with Harness's native hooks installed by an isolated daemon (Part 6's Verification recipe).
  Record F9 over 10 runs: which of the two Stop hooks reaches the daemon first, the gap between them, and the times
  from the answer's end to each hook's exit. The stamps are taken by wrappers in the spike's scratch settings only. Over the same runs, record the transcript's mtime at each write from the block to the next Stop, and
  report the longest gap (F10).
- [x] **Step 3: Codex (F2-F8).** In the isolated `CODEX_HOME`, use a scratch copy of `plugins/harness-device` whose
  `codex.json` gains the same `Stop` hook. Install it through `codex plugin` and trust it as Part 7's spike did. Run the
  TUI in the private tmux server. Record:
  - the Stop input's keys;
  - the block form Codex honors;
  - the rollout lines after the first answer (whether a `task_complete` comes between, and the hook prompt's record);
  - whether `UserPromptSubmit` ran for the hook prompt;
  - the second Stop's `stop_hook_active`;
  - `hooks/list` for the Stop hook's trust state and hash;
  - what a `codex exec` run gives a Stop hook that says it is headless;
  - over 10 runs, F9 as in Step 2, and the longest gap between rollout writes from the block to the next Stop (F10).
  Then replay the recorded rollout through `engines/codex/normalizer.ts` (`npx tsx` from `cli/`, a scratch script) and
  record the live events it makes (F5).
- [x] **Step 4: Report** F1-F10 to the main session, each yes or no with its evidence: counts, keys, record types and
  times, with no answer text. Keep the scratch records. Task 10 copies its rollout-head fixtures from them (records
  Codex wrote against the stub, nothing of a person). None of the stop conditions was hit: Claude Code honors the block
  from a plugin, Codex has `last_assistant_message`, F8 found the rollout's sign, and every nudge came within
  `ANSWER_GRACE_MS` of its `turn-stop`.

### Task 2: the eval answers a Stop hook by its input, counts the nudges, and pairs a round with its base

**Effort:** high. **Depends on:** G1. It changes `run-eval.mjs` and files under `_state.json` `harness_paths`, so Task
4's first pass asks for `--approve-harness`.

**Files:**
- Modify: `cli/evals/dial-skill/lib/stage.ts` (`HarnessAnswer.stop`, `fakeHarness`, `Ring.blocked`, `readRings`)
- Modify: `cli/evals/dial-skill/run-eval.mjs` (`isAnswer` takes `stop: true`; `DESIGN_CAP_USD = 270`)
- Modify: `cli/evals/dial-skill/lib/grade.ts` (`nudged`)
- Modify: `cli/evals/dial-skill/lib/summarize.ts` (the aggregate and held-out tables gain `nudged`; `held_out_recall`
  pairs a round with its base; the column `recall vs best` becomes `recall vs base`; `fisherOneSided` and
  `held_out_recall_p`, the column `recall p vs base`)
- Modify: `cli/evals/dial-skill/README.md` ("Hooks in a variant": the Stop answer; the held-out table's paragraph:
  `recall vs base`; Cost: the runner refuses a cap above 270)
- Modify: `cli/evals/dial-skill/flow/metrics.md` (the `nudged` row; the tables by `summarize`)
- Create: `cli/evals/dial-skill/test-data/stop-inputs.json`
- Test: `cli/evals/dial-skill/stage.spec.ts`, `run-eval.spec.ts`, `grade.spec.ts`, `summarize.spec.ts`

**Interfaces:**
- Produces: `HarnessAnswer.stop?: true`. An answer with `stop` is given only when the Stop rules say block: the fake
  reads its stdin, and the input has no `stop_hook_active: true`, the last 400 code points of a string
  `last_assistant_message` hold `?` or `？`, and the record holds no `device notify` call yet. It then writes the
  answer's `stdout`; otherwise nothing, exit 0. It records `{ argv, blocked: true | false }`. `Ring.blocked?: true`.
  `gradeRun` adds `nudged: 0 | 1` to every scored row, outside `score`. `summarize` reports `nudged` as "k of n" per
  variant and condition.
- `_state.json` may hold `bases: Record<string, number>`, variant → the round its held-out recall is paired with.
  `Summary.held_out_recall[v][c]` pairs v with `bases[v]`'s round when listed, else with the best round, by the
  existing `pairOf` over the held-out need cases. A variant that is its own base gets no entry. The held-out table's
  last column is `recall vs base`. Task 3 writes `bases: { "v5": 4, "v6": 1 }`; the best round stays 4 until Task 4's
  verdict, and may then be 5, so the pairs must not follow it.
- `export function fisherOneSided(baseHit: number, baseN: number, hit: number, n: number): number`: Fisher's exact
  test, one-sided, the chance of `hit` or more of `n` going to the variant when the `baseHit + hit` hits of the
  `baseN + n` runs are dealt at random (the hypergeometric upper tail). Exact, computed in log space or by running
  products, with no library.
- `Summary.held_out_recall_p: Record<string, Record<string, number>>`, variant → condition: `fisherOneSided` of the
  base's and the variant's held-out need counts (`held_out.hit` of `held_out.need`), with the same base as
  `held_out_recall`. The held-out table gains `recall p vs base` after `recall vs base`, `p` to 3 places, blank where
  `recall vs base` is blank. Task 4 reads (b) from it.
- `run-eval.mjs`: `DESIGN_CAP_USD = 270` (decision 16).
- `stop-inputs.json`: `[{ "name": string, "input": object, "asks": boolean }]`. The cases: `stop_hook_active` true; no
  message; an empty one; a number; `?` last; `?` exactly 400 code points from the end; at 401; `？` last; an emoji pair
  in the tail counted as one; a tail with `user?.name`; `Đã xong, không cần gì thêm.`; `要用哪个数据库？`. Task 10's
  spec reads the same file.

- [ ] **Step 1: Write the failing tests.**
  - `stage.spec.ts` `describe('the fake harness answers a Stop hook')`. The fake is staged with a `stop` answer and run
    over every case of `stop-inputs.json` on stdin. It writes the answer's stdout exactly when `asks` is true, exits 0,
    and records `blocked` to match. With a `device notify` call recorded first, an asking input blocks nothing. A stdin
    that is not JSON blocks nothing and exits 0. `readRings` gives `blocked: true` only on the answer that blocked.
  - `run-eval.spec.ts`: a variant answer `{ argv, stdout, stop: true }` is taken; `stop: 'yes'` is refused with the
    shape message.
  - `grade.spec.ts`: a need row and a no-need row with a blocked ring have `nudged: 1`, and without one `nudged: 0`.
    `score` is the same with and without it.
  - `summarize.spec.ts`: the held-out table's header gains `nudged` after `loaded`, its cells are "k of n" over the
    scored runs, and the aggregate table gains the rate.
  - `summarize.spec.ts` `'pairs a round's held-out recall with the base _state.json names for it'`: a flow whose best
    round is 2 and whose `bases` is `{ v3: 1 }`; `held_out_recall.v3` equals the pair of v3 with v1 (mean, `ci_lo`,
    `ci_hi`, n), not with v2. A v1 at 3 reps and a v3 at 2 pair by case means, n the need cases both scored.
    `'without a base, the best round'`: v2 has no entry (the best), the baseline is paired with v2. The header ends
    `| loaded | nudged | score vs baseline | recall vs base | recall p vs base |`.
  - `summarize.spec.ts` `describe('fisherOneSided')`, on fixed counts: `(41, 48, 48, 48)` is 0.00618, `(41, 48, 47, 48)`
    0.02950, `(41, 48, 46, 48)` 0.07932 and `(41, 48, 32, 32)` 0.02318, each `toBeCloseTo(…, 5)`; `(5, 10, 5, 10)` is
    above 0.5; `(0, 10, 0, 10)` and `(10, 10, 10, 10)` are 1. `'gives each round's recall p against its base'`: in the
    `bases` flow above, `held_out_recall_p.v3.crowd` equals `fisherOneSided` of v1's and v3's held-out counts.
  - `run-eval.spec.ts` `"refuses a --spend-cap-usd above the design's $270"` (replaces the $250 case): 270.01 exits 2
    with `--spend-cap-usd is at most 270: the design's cap is $270`; 270 is taken.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts
  evals/dial-skill/stage.spec.ts evals/dial-skill/run-eval.spec.ts evals/dial-skill/grade.spec.ts
  evals/dial-skill/summarize.spec.ts`. Expected: FAIL (no `stop` answer, no `nudged`, no `bases`, no
  `fisherOneSided`, 270 refused).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.**
  - The fake runs under plain node and cannot load the CLI's code, so it applies the rules itself. Its comment says why
    and names the shared table that holds it to the product (Task 10).
  - The fake reads its stdin only for a `stop` answer.
  - README: one paragraph under "Hooks in a variant". It covers the `stop` answer, the eval's world (a dial is always
    attached, the person is always away, the skill is on, "rang in this turn" means a ring already recorded in the run),
    and `nudged`, the one extra model round a block costs.
  - `summarize`'s comment on `held_out_recall` says why a round may name its base: Part 5's two pairs compare with v4
    and with v1, while the best round is v4 and may change at the verdict.
  - README: one sentence each on `recall vs base` and `recall p vs base`, and the Cost paragraph's "refuses a cap above 250" becomes 270, with the
    maintainer's raise for Part 5.
  - metrics.md: the `nudged` row, then `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow`.
- [ ] **Step 5: Run the eval's whole suite.** `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts`.
  Expected: PASS. `git diff --stat -- evals/dial-skill/flow` lists `metrics.md` and `narrative.md` alone, and only for
  the new columns and the renamed one; every `recall vs base` cell equals its old `recall vs best` cell, as no
  `bases` exist yet.
- [ ] **Step 6: Commit.**

### Task 3: the variants, `flow/v5` and `flow/v6`

**Effort:** medium. **Depends on:** Task 2.

**Files:**
- Create: `cli/evals/dial-skill/flow/v5/SKILL.before.md` and `SKILL.md` (both `flow/v4/SKILL.md` byte for byte)
- Create: `cli/evals/dial-skill/flow/v5/hooks.json`: `flow/v4/hooks.json`'s `SessionStart` entry unchanged, plus
  `"Stop": [{ "hooks": [{ "type": "command", "command": "harness device claude stop", "timeout": 5 }] }]`.
- Create: `cli/evals/dial-skill/flow/v5/harness-answers.json`: `flow/v4/harness-answers.json`'s `start` answer
  unchanged, plus `{ "argv": ["device", "claude", "stop"], "stdout": <the block of the reason> + "\n", "stop": true }`.
- Create: `cli/evals/dial-skill/flow/v6/SKILL.before.md` and `SKILL.md` (both `flow/v1/SKILL.md` byte for byte)
- Create: `cli/evals/dial-skill/flow/v6/hooks.json`: the `Stop` entry alone, no `SessionStart`.
- Create: `cli/evals/dial-skill/flow/v6/harness-answers.json`: the `stop` answer alone.
- Modify: `cli/evals/dial-skill/flow/_state.json` (`harness_paths` gains the four files; `bases: { "v5": 4, "v6": 1 }`)
- Test: `cli/evals/dial-skill/state.spec.ts`

Both `stop` answers' stdout is written with `npx tsx -e` from the Global Constraints' reason, never typed by hand.

- [ ] **Step 1: Write the failing tests.**
  - `'flow/v5 is v4 with the Stop hook'`: `variantHooks` of `flow/v5` gives v4's `SessionStart` hook and answer
    unchanged, and a `Stop` hook running `harness device claude stop`, with timeout 5 and no matcher, and exactly one
    `stop` answer. v5's `SKILL.md` equals v4's.
  - `'flow/v6 is v1 with the Stop hook alone'`: `variantHooks` of `flow/v6` gives the `Stop` hook and its `stop` answer
    and nothing else (no `SessionStart`). v6's `SKILL.md` equals v1's.
  - For both: the `stop` answer's stdout parses to `{ decision: 'block', reason }`, the same in both. The reason is one
    line of printable ASCII, has no `<` or `>`, and contains `harness device notify`.
  - `'pairs v5 with v4 and v6 with v1'`: `_state.json` `bases` is `{ v5: 4, v6: 1 }`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts
  evals/dial-skill/state.spec.ts`. Expected: FAIL (`ENOENT`).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Write the files**, list the four in `harness_paths`, and add `bases`.
- [ ] **Step 5: Run.** The same command; then the existing `'lists every variant's hooks.json and harness-answers.json'`.
  Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 4: the eval passes, (b) v6 against v1, then (a) v5 against v4 (NOT run before GO)

**Effort:** high. **Depends on:** Task 1 (done; F1: `claude -p` honors the block), Task 3, and **GO**: the PM approves this
plan and says go. **Test that must fail first:** none (it measures). Its checks are
the exit codes, the probes, `nudged`, `scrub` and the eval's suite. **Needs the user's own Claude Code sign-in**
through the session's profile in `CLAUDE_CONFIG_DIR`, as Parts 3 and 4 did. Machine: this Mac.

**Files:**
- Create: `cli/evals/dial-skill/flow/v6/{change.md,results.jsonl,errors.jsonl,probes.jsonl,summary.json,table.md}`
  and the same in `flow/v5/` (`errors.jsonl` only if written)
- Modify: `cli/evals/dial-skill/flow/narrative.md` (`## Part 5`), `flow/metrics.md` (by `summarize`),
  `flow/_state.json`: `harness_sha` by `--approve-harness`; `current_round` 6 (the newest round run); `best` becomes `{ round: 5, val_score, test_score }` only if the verdict ships, since v5 is what the
  product carries, and otherwise stays round 4. v6 is never best: it lacks v4's line and stands in for a long session.
- Git-ignored, kept on this Mac: `flow/v5/traces/`, `flow/v6/traces/`, `flow/v5/private.jsonl`, `flow/v6/private.jsonl`

**Spend plan** (per-run costs from Part 4's passes: `crowd` $0.30, `clean` $0.23, `name-only` $0.29, a probe about
$0.2). A nudged run adds one model round, about a fifth of a run:

| Step | Runs | About |
|---|---|---|
| Spent before Part 5 (Parts 1 and 3, Part 4's two rounds) | | S = $197.01 (Part 4 round 2's status row) |
| (b) v6 `crowd` val and test, 3 reps | 75 + 1 probe | $25 |
| (a) v5 `crowd` val and test, 3 reps | 75 + 1 probe | $24.5 |
| (a) v5 `clean` val and test, 2 reps | 50 + 1 probe | $12.5 |
| (a) v5 `name-only` val and test, 1 rep | 25 + 1 probe | $8 |
| Part 5 | 225 + 4 probes | about $70 ((a) runs whatever (b) gave, decision 11) |
| Flow after the passes | | about $268 of the $270 cap |

- [ ] **Step 1: Check the start.** From `cli/`:
  - `CLAUDE_CONFIG_DIR` is set and is not `~/.claude`;
  - `diff <(npx tsx -e 'import { DIAL_SKILL } from "./src/devices/dialSkill.ts"; process.stdout.write(DIAL_SKILL)') evals/dial-skill/flow/v5/SKILL.md`
    prints nothing, and the same for `flow/v6/SKILL.md`;
  - `git status --short` prints nothing;
  - `_state.json` `best.round` is 4, `current_round` 4, and `bases` is `{ v5: 4, v6: 1 }`.
  Read the status table's last `spend` as S. If S + $27 > 270, stop and report S to the PM. `marker=$(mktemp)`.
- [ ] **Step 2: (b), v6 `crowd` at 3 reps.**
  `npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v6 --condition crowd --split val,test --reps 3 --concurrency 3 --timeout-s 900 --spend-cap-usd 270`
  - Exit 2, "harness changed": review `git diff <harness_sha> -- run-eval.mjs <harness_paths>`. Expect only Task 2's
    `run-eval.mjs`, `lib/stage.ts` and `lib/grade.ts`, and Task 3's four `hooks.json` and `harness-answers.json`. If
    so, rerun with `--approve-harness`. For anything else, stop and report.
  - Exit 2 on a probe failure: stop and report the probe row.
  - Exit 1: rerun the same command, which runs only the failed cases.
  - Exit 3 or 4: stop and report the spend.
  - Expected: 75 rows, about $25. **Ran 2026-11-27:** 75 rows and no row with `nudged` 1 (the hook never blocked
    under `claude -p`). That was this step's stop; the PM ruled on it (decision 10), and the task goes on.
- [ ] **Step 3: Read (b), reported, not a gate.** `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow`. From
  the held-out table's `crowd` rows of v1 and v6: recall (k of n), v6's `recall p vs base` (`summary.json`
  `held_out_recall_p.v6.crowd`) and its `recall vs base` interval; needless rings; `nudged` over need and no-need runs;
  need misses by scenario with each one's `nudged`. **Read 2026-11-27:** v6 44 of 48 against v1's 41, p = 0.262, 0 of
  75 nudged: the 4 misses went on without a `?`, and the 6 runs that ended on one had already rung. (b) failed as the
  gate it was; per the PM it is reported, not a gate, and (a) runs anyway: the verdict is (a)'s (decisions 10, 11).
- [ ] **Step 4: (a), v5 `crowd` at 3 reps.** Read S again. If S + $46 > 270, STOP and report S and (b)'s result to
  the PM, who asks the maintainer for more; never raise the cap. Otherwise the command of Step 2 with `--variant v5`,
  its exits handled the same way. Expected: 75 rows, about $24.5. Against v4 the
  need runs already ring, so few or no rows have `nudged` 1; that is expected here.
- [ ] **Step 5: (a), `clean` and `name-only`:** the same command with `--condition clean --reps 2`, then
  `--condition name-only --reps 1`. Expected: 50 and 25 rows, about $20.5 together.
- [ ] **Step 6: Read (a).** `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow`. From the held-out table, v4's
  and v5's rows in each condition: recall, needless rings, `line_ok`, `ask_ok`, harmed, `went_on`, `one_step`,
  `loaded`, `nudged` over need and no-need runs, v5's `recall vs base` with its interval, truncated counts (a block's
  extra round can reach `--max-turns`), the mean cost and latency per run against v4's, and needless rings and need
  misses by scenario, with each one's `nudged`.
- [ ] **Step 7:** `find -H "$CLAUDE_CONFIG_DIR"/ "$CLAUDE_CONFIG_DIR"/*/ -newer "$marker" | sort -u` lists only the
  startup files the README names.
- [ ] **Step 8: The verdict**, by decision 10: the hook ships when (a) passes, and only the eval lands when it fails.
  State what it rests on: v5's `recall vs base` interval against v4 in each condition, the 54 pooled no-need runs, and
  `harmed` and `went_on` against v4's counts, with the one-run margin. Report (b) beside it, as not a gate: v6's and
  v1's `crowd` held-out counts, the Fisher p and the case interval, and that the hook blocked no run. Report the extra
  rounds per run (`nudged` rate, and cost per run against the base's).
- [ ] **Step 9: Write** `flow/v6/change.md` (`# Part 5 (b): v1 and a second look when a turn stops`) and
  `flow/v5/change.md` (`# Part 5 (a): v4 and a second look when a turn stops`), each with Evidence, Change and Result,
  numbers only. Write the narrative's `## Part 5`, with `### (b) The case it is for: v6 against v1` (failed as a gate,
  reported, the PM's ruling in one line) and `### (a) No harm: v5 against v4` and the verdict, with the same numbers.
  Set `_state.json` as in Files, then run summarize again.
- [ ] **Step 10: Make the rows fit to commit.** `npx tsx evals/dial-skill/flow-rows.ts scrub evals/dial-skill/flow`
  exits 0. Run `node evals/dial-skill/build-report-lite.mjs evals/dial-skill/flow`. `git status --short --
  evals/dial-skill/flow` shows only the files above. `grep -nE '^>|/Users/|~/|'"$(whoami)"` on both `change.md` files
  and `narrative.md` prints nothing.
- [ ] **Step 11:** `npx vitest run --config evals/dial-skill/vitest.config.ts`. Expected: PASS.
- [ ] **Step 12: Commit** (`Dial skill eval: Part 5, a second look when a turn stops, against v1 and against v4`).
  The measurement is committed whatever the verdict.

**Report** (numbers only): the held-out rows of v1 and v6 in `crowd`, and of v4 and v5 in each condition; the verdict
and what it rests on ((a)); (b) as reported; the extra rounds per run; the spend per pass and in the flow; Claude
Code's version. Then: Tasks 6-17 if the hook ships; Task 5 and the pull request of the eval alone if not.

### Task 5: results and the spec

**Effort:** medium. **Depends on:** Task 4. **Test that must fail first:** none (docs); one commit.

**Files:**
- Modify: `cli/evals/dial-skill/README.md`. Results gains a Part 5 block above Part 4's: the held-out counts of v4 and
  v5 per condition with (a)'s intervals, the verdict on (a), then (b) as reported, not a gate (v1 and v6 in `crowd`,
  its Fisher p, no run blocked), `nudged`, and the spend. The Cost paragraph states the $270 cap and what the flow
  spent.
- Modify: `cli/evals/dial-skill/flow/narrative.md`. The headline gives Part 5's result.
- Modify: `docs/plans/2026-11-26-needs-you-right-design.md`. Only a "Measured (<date>)" paragraph under Part 5's
  "Measured" bullet: (a)'s held-out numbers against v4 and its intervals, the pooled specificity, the extra rounds,
  the verdict and the spend. (b)'s numbers are already in the bullet (0ac8d38707) and are not repeated.

- [ ] **Step 1:** Write them, numbers only.
- [ ] **Step 2:** `grep -nE '^>|/Users/|~/|'"$(whoami)"` on the three files finds nothing new, and
  `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow` leaves the narrative's tables unchanged.
- [ ] **Step 3: Commit** (`Dial skill eval: Part 5's results`, or with `; the hook does not ship` when (a) failed).

## Gate V: Task 4's verdict ships

V is (a) passing (decision 10). Tasks 6 to 17 run only after V. If V fails, they do not run. The pull request then
carries Tasks 2-5, the eval alone.

## After V

### Task 6: `nudge` on the devices' listener

**Effort:** high (a local message any process of this account can send). **Depends on:** V.

**Files:**
- Modify: `cli/src/services/devicesListener.ts` (`nudgeHandler` and its bounds; the header comment's list of messages)
- Test: `cli/src/services/devicesListener.spec.ts`

**Interfaces:**
- Produces: `export const NUDGE_PER_SECOND = 1`; `export const NUDGE_MAX_BYTES = 256`;
  `export interface NudgeAsk { engine: 'claude' | 'codex'; sessionId: string; ask: boolean }`;
  `export function nudgeHandler(nudge: (ask: NudgeAsk) => boolean): ListenerHandler`. It answers `{ nudge: <boolean> }`
  and refuses anything else. `ask` must be a boolean (decision 18).

- [ ] **Step 1: Write the failing tests** in `describe('nudge')`.
  - Refused: no engine, `engine: 'cursor'`, a number engine, no `sessionId`, one with `/`, 129 characters, an empty
    one, no `ask`, `ask: 'true'`, `ask: 1` and `ask: null`.
  - Answered: `{ type: 'nudge', engine: 'codex', sessionId: 's-1', ask: true }` hands on exactly `{ engine: 'codex',
    sessionId: 's-1', ask: true }` (`toStrictEqual`; an extra field of the message is not handed on), and the same with
    `ask: false`. The answer is `{ nudge: true }` or `{ nudge: false }` as the function says.
  - The bounds are `[NUDGE_MAX_BYTES, NUDGE_PER_SECOND]` = `[256, 1]`.
  - Over a real socket listener, as the spec's `'who may connect'` cases open one: `askDevices` with a nudge (`ask:
    true`) gets `{ nudge: true }`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/services/devicesListener.spec.ts`.
  Expected: FAIL (no export).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** as `noticeHandler` is built, with its validation (`NOTICE_SESSION`, the two engines). The
  comment says it keeps nothing and logs nothing, since the id names a person's session.
- [ ] **Step 5: Run them and see them pass.** The same command. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 7: the observed source waits for the report and holds a stop that goes on

**Effort:** xhigh (two hooks of one event arrive in either order; timers). **Depends on:** V (Task 1 is done: F3,
F4, F9 and F10 hold).

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`CONTINUE_QUIET_MS`, `CONTINUE_MAX_MS`, `REPORT_WAIT_MS`,
  `ObservedSource.stopReported`, `Entry.secondLook` (`reported`, `stopWait`, `earlyReport`, `continuing`), the
  hold's timer, the `turn-stop` case, the turn events that drop a held stop, `dropStop`)
- Test: `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Produces: `export const CONTINUE_QUIET_MS = 10_000`, `export const CONTINUE_MAX_MS = 120_000`,
  `export const REPORT_WAIT_MS = 6_000`, and `stopReported(agentId: string, goesOn: boolean): boolean`, which Task 8
  calls for every `nudge` (`goesOn` is the yes). It returns false and changes nothing when the agent is not listed, not
  live, or not of engine `claude` or `codex`. Otherwise:
  - **The mark:** `entry.secondLook.reported = true`. The spec's "at most 64" holds: the mark lives on the entry, so it goes with
    the entry, within the source's 50 sessions (`MAX_SESSIONS`), and no second list is kept.
  - **`goesOn` false** (a no, or `ask: false`):
    - a stop waiting for its report (`entry.secondLook.stopWait = { at }`) is released: `finish` at `at + ANSWER_GRACE_MS`, or at
      once when that has passed;
    - a stop in its grace (a session not yet marked at its turn-stop) is left to the grace;
    - with no turn-stop in its grace or its report wait, and no subagent running, `entry.secondLook.earlyReport = now` (a hold,
      if any, is left as it is).
  - **`goesOn` true:** a stop held (in its grace or waiting for its report) is cleared and the hold starts `'heard'`;
    with none held and the entry `working` with no subagent running, it starts `'awaited'`; else (its end already told,
    or the lead's subagents run) it returns false and starts no hold. The hold is `entry.secondLook.continuing = { phase:
    'heard' | 'awaited', since: <now>, lastActive: <now> }`.
  - **The turn-stop** of an entry:
    - in a hold: `'awaited'` becomes `'heard'` and keeps the hold (the blocked stop's own); `'heard'` ends the hold, and
      the stop goes on as below (the continuation's own stop);
    - with subagents running: not held, as today;
    - with an `earlyReport` younger than `REPORT_WAIT_MS`: the report is used up and the stop takes the grace;
    - marked (`secondLook.reported`): `secondLook.stopWait = { at: now }`, held until its report, at most
      `REPORT_WAIT_MS`. At `REPORT_WAIT_MS` it is told done (`finish`), `secondLook.reported` is cleared, and `[observed] stop report missed` is
      logged;
    - else: the grace, as today.
  - A `turn-start`, `needs-input`, `turn-error`, `turn-aborted` or `session-end` drops a held stop as today, and with it
    `stopWait`, `earlyReport` and the hold. `finish` clears `stopWait`.
  - **The hold** (decision 12): `entry.heldStop` becomes its one timer, due at
    `min(lastActive + CONTINUE_QUIET_MS, since + CONTINUE_MAX_MS)`. It stays set for the hold's whole life, the stamp
    read included, so `checkWorking`'s `ownerEnds` and every turn event see a held stop as today. The report wait uses
    `heldStop` the same way.
  - **Activity** is decision 12's: `entry.agent.lastActivityAt` (set by every hook `ingest` takes for the entry) and
    `deps.fileStamp(entry.transcriptPath)?.mtime`. A null stamp, or no transcript, is no activity.
  - When the hold's timer fires before `since + CONTINUE_MAX_MS`, it reads the stamp once. `lastActive` becomes the
    latest of itself, `agent.lastActivityAt` and the mtime. If that is under `CONTINUE_QUIET_MS` ago, the timer is set
    again for the new due time; else the hold expires. At `since + CONTINUE_MAX_MS` it expires with no read. After the
    read's `await`, a hold that is no longer the entry's (a stop, an event, a removal) changes nothing.
  - Expiry while `'heard'`: `finish` runs, so the held turn end is announced, with its answer. Expiry while
    `'awaited'`: the hold ends and nothing is told. Each expiry logs `[observed] held stop · quiet|cap|unheard`
    (`unheard` for `'awaited'`).
  - A second yes while one holds changes nothing: neither `since` nor `lastActive` moves.

- [ ] **Step 1: Write the failing tests.** Use a fake clock (`vi.useFakeTimers()`, `deps.now` read from it), the spec's
  fake `fileStamp`, whose mtime the test moves, and a listed Claude Code session with a transcript (as the spec's other
  turn tests set one up). "Marked" means one `stopReported(id, false)` in an earlier turn. In the hold's cases each next
  stop's own report (`false`) comes 0.3 s after it, as the continuation's hook sends it. No fixed sleeps: each check
  advances the fake clock and flushes the stamp read.
  - `describe('the stop waits for its report (decision 18)')`:
    - `'a marked session's stop waits for its report'` (the PM's case 1): a turn-stop, the report (`false`) at 3 s.
      Nothing told at 2.9 s; told done once at 3 s, with its answer.
    - `'a report inside the grace is told at the grace's end'`: the report at 0.3 s; nothing at 1.4 s; told at 1.5 s.
    - `'no report: told at 6 s, and the session is no longer marked'` (the PM's case 2): nothing at 5.9 s; told once
      at 6 s; `[observed] stop report missed` logged once. Its next turn (a `turn-start`, a `turn-stop`, no report) is
      told at 1.5 s.
    - `'a session that never reported: the grace, as today'` (the PM's case 3): told at 1.5 s. A report (`false`) at
      2 s tells nothing more; a yes at 2 s returns false and holds nothing: its next stop is told 1.5 s after it.
    - `'a report before its turn-stop'`: the report (`false`) 0.2 s before the stop; told 1.5 s after the stop, not at
      6 s. The report is used once: the next turn's stop with no report waits until 6 s.
    - `'an early report is dropped by a turn-start'`, and `'an early report older than 6 s is not used'`: in both, the
      next stop waits for its own report.
    - `'a report while the lead's subagents run is not kept for its own stop'`: `subagent-start`, a stop (not held, as
      today), the report, `subagent-stop`, the lead's own stop: it waits for its own report.
    - `'a stop waiting for its report: a prompt, needs-input, turn-error, turn-aborted or session-end tells nothing
      for it'`.
    - `'a removed session forgets its mark'`: removed and listed again, its stop takes the grace.
  - `describe('a stop that goes on (Part 5)')`:
    - `'the yes after the blocked stop: nothing told at 1.5 s or 9.9 s; the next stop is told done once, 1.5 s after
      it, with its answer'`: the order Task 1 saw in every run (F9), once for a marked session (the yes at 1.3 s) and
      once for an unmarked one inside the grace (at 1.2 s).
    - `'the yes before the blocked stop: that stop is held; the next one is told done once'` (`'awaited'`): the other
      order, not seen in Task 1, kept because it costs one case.
    - `'a continuation longer than 10 s that keeps showing activity is still held, and is announced at its next stop'`.
      The transcript's mtime moves at 6 s, 14 s, 22 s and 30 s after the yes. Nothing is told at 10 s, 20 s, 30 s or
      38 s. The next stop comes at 38 s and is told done once, 1.5 s after it, with its answer. A flat 10 s hold from
      the yes would fail it.
    - `'a hook for the session counts as activity'`: a `subagent-start` and its `subagent-stop` at 8 s, the transcript
      untouched. Nothing told at 17.9 s; told once at 18 s.
    - `'no next stop, quiet: told once 10 s after the last activity'`: the mtime moves at 4 s, then never. Nothing at
      13.9 s; told once at 14 s, with its answer; nothing more at 30 s.
    - `'the 120 s cap'`: the mtime moves every 5 s and no next stop comes. Nothing at 119.9 s; told once at 120 s from
      the yes. The mtime moving after that tells nothing more.
    - `'an unreadable transcript shows no activity'`: `fileStamp` gives null; told once at 10 s.
    - `'a stop while the stamp is being read'`: the stamp's promise is held open at 10 s, the next `turn-stop` comes,
      then the promise resolves with an old mtime. Told once, 1.5 s after the stop, never at the read.
    - The `'awaited'` twin: `'no stop at all, quiet for 10 s: nothing told, and the turn still works'`; and with the
      mtime moving every 5 s, nothing told at 120 s either.
    - `'a prompt during the hold: nothing told for the held stop; the turn works'`. The same for `needs-input`,
      `turn-error` (told as an error), `session-end` (idle) and `turn-aborted`.
    - `'stopReported for an agent no hook listed, an ended session, or another engine is false and changes nothing'`.
    - `'a second yes keeps the first deadline'`: a second yes at 100 s; told at 120 s from the first.
    - `'checkWorking leaves a held turn alone'`: the owner reads idle inside the hold, and inside a report wait, the
      stamp read pending included, and nothing is told before either ends.
    - `'a lead with subagents running: the stop is not held by the yes, as today'`.
  - For each case, `this.deps.log` holds no line with the session id.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected:
  FAIL (`stopReported` is not a function).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment on `stopReported` says why the turn-stop waits for the report: the engine
  runs Harness's native hook and the plugin's together, so their requests race, and on Windows the plugin's PowerShell
  hook takes seconds, past the grace (decision 18); why the grace stays the floor (the transcript's lag); and why a
  session's first stop cannot wait (nothing says yet that its hook reports). It also says why the hold reuses
  `heldStop`: `checkWorking` and every turn event already treat a held stop as the turn going on. The comment on the
  hold says why activity is the transcript and the hooks: outside a pane Harness hears no tool events, and the
  transcript grows with every step of a continuation (F10: at most about 2 s quiet). It also says why it is capped at
  120 s: a continuation's turn end is told even when the transcript keeps growing with no stop.
- [ ] **Step 5: Run them and see them pass.** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts && npm run
  typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 8: the devices answer `nudge` and hold the turn end

**Effort:** xhigh (presence, notices and turn ends meet here). **Depends on:** Tasks 6 and 7.

**Files:**
- Modify: `cli/src/services/devices.ts` (the `nudge` handler in `listen`, `nudged`, the `[device] nudge` tally;
  `RANG_MAX`, `rangThisTurn`, set in the `notice` handler and cleared in `dispatch`'s `processing`, `port.observed`'s
  `turn-start`, `session-end` and `agent_deleted`)
- Test: `cli/src/services/devices.spec.ts` (`fakeListener` gains `nudge`)

**Interfaces:**
- Consumes: Task 6's `nudgeHandler` and `NudgeAsk`; Task 7's `stopReported`; `noticeCaller`, `present`,
  `cable.isConnected`, `observedAgentId`, `began`, `outside`.
- Produces, inside `startDevices`: `nudge: nudgeHandler((ask) => { let yes = false; part.call('notices', () => { yes =
  nudged(ask) }); return yes })`. `nudged` answers in this order and tallies each answer by its word:
  - `no ask` when `!ask.ask`: `observed?.stopReported(observedAgentId(engine, sessionId), false)` and nothing else
    (decision 18: no presence read, no once rule, no `rangThisTurn` change, no `noticeCaller`);
  - `no dial` when `!cable.isConnected`;
  - `notice` when `rangThisTurn.has(agentId)`;
  - `present` when `presentAtStop(agentId)` (Task 9);
  - else `yes`.
  Each answer after `no ask` then calls `observed?.stopReported(observedAgentId(engine, sessionId), yes)`, so a no
  releases the held turn-stop and a yes holds it. `agentId` is `noticeCaller({ text: '', engine, sessionId }).agentId`.
  Task 9 adds `nudged` (the word) before `yes`. The tally is `createEngineTally('[device] nudge', ['claude', 'codex'],
  ['yes', 'no ask', 'no dial', 'notice', 'present', 'nudged'], log)`.
- `const RANG_MAX = 64`; `const rangThisTurn = new Set<string>()`: the agents that rang a notice in their turn, oldest
  first out past `RANG_MAX`. One id an agent, no time, no text.
  - Added: in the `notice` handler, `noticeCaller(ask).agentId`, whatever `notices.notify` answers (`shown`, `limited`
    or `no dial`): the agent rang.
  - Cleared for an agent at its turn's mark: in `dispatch`'s `processing` where a new `began` is set, for an agent no
    outside row holds (a Harness agent); in `port.observed`'s `turn-start` when `byPerson` (`person` or `dial`), never
    for `relayed`; and when the agent leaves (`session-end`, `agent_deleted`).

- [ ] **Step 1: Write the failing tests.**
  - The listener test's key list gains `'nudge'` after `'notice'`, with
    `expect(handlers.nudge).toMatchObject({ maxBytes: NUDGE_MAX_BYTES, perSecond: NUDGE_PER_SECOND })`.
  - In `describe('a second look when a turn stops (Part 5)')`, with the Part 2 helpers (`there`, `host().front`). In
    these cases the outside agent has reported once in an earlier turn (an `ask: false` nudge), so its stops wait for
    their reports:
    - `'yes for an outside agent the person left: its blocked stop is told nothing, its notice rings, and its next stop
      ends silent under rule:notice'`. The agent was prompted 130 s ago. `port.observed(hook('turn-stop'))`, then 3 s
      later (past the grace, as on Windows) `listener.nudge({ …, ask: true })` is `{ nudge: true }`. Then 2 s, the
      notice (`shownAsks()` has it), the next `turn-stop`, its report (`ask: false`) and 1.5 s. Expect one `summary`
      call, silent, and `[cable] notify · silent · rule:notice` in the logs.
    - `'ask false changes nothing but the release'` (the PM's case 4): the person away, a dial attached, no notice
      rung. A `turn-stop`, then `{ ask: false }` at 3 s answers `{ nudge: false }`; the turn end is told at 3 s, not
      before. The log has `[device] nudge · claude · no ask` and no `· present`. Then in the same turn: a notice, an
      `ask: false`, and an `ask: true` answers no as `· notice` (the mark is kept). And with no notice: an `ask: false`
      then an `ask: true` answers yes (no once rule was set, and Task 9's `nudged` never follows an `ask: false`).
    - `'a stop with no report is told at 6 s'`: the e2e case's unit twin, through `port.observed` and the listener.
    - `it.each` no: no dial (`{ nudge: false }`, `[device] nudge · claude · no dial`); a notice rung in this turn,
      shown and quiet (`· notice`); the person there (`there(port)`, `· present`); a Harness agent whose turn began 30 s
      ago with its tile on screen (`· present`). For the outside cases, the held turn-stop is told at the grace's end.
    - `'a notice rung earlier in this turn and since answered is still no'`: an outside agent's notice is shown, then
      ended (`notices.ended`, as an answer from the dial ends it) with no `turn-start`; the nudge answers no (`·
      notice`). The same for a Harness agent within one `began`.
    - `'a card from an earlier turn does not count'`: an outside agent rang in a turn; then a `turn-start` from
      `person`; a nudge in the new turn is yes, with the old card still pending (red against `notices.pending`). For a
      Harness agent: rang, `done`, a new `processing`, then yes.
    - `'a relayed turn is no new turn for the notice check'`: an outside agent rang after the person's prompt; then a
      `turn-start` with `relayed: true`; the nudge answers no (`· notice`).
    - `'the 65th agent that rang pushes out the first'`.
    - `it.each` yes: a Harness agent past 120 s; an unknown session (not present by Part 2's rule); a Codex session.
    - `'the tally names no session'`: no log line holds `sess-1`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL
  (no `nudge` handler).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment beside the handler names the spec's four conditions, says why "the skill is
  on" is the hook's to read (decision 4), and why `ask: false` only releases the stop: it is the report every stop
  sends, so the turn-stop need not wait out the grace (decision 18). The comment on `rangThisTurn` says why neither
  `began` nor `prompted` serves: an outside agent's `began` restarts on a relayed turn, and `prompted` is deleted by
  one; and why a pending card is not asked: it may be left from an earlier turn.
- [ ] **Step 5: Run them and see them pass.** `cd cli && npx vitest run src/services/devices.spec.ts && npm run
  typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 9: once an agent, and a Harness agent's presence through its continuation

**Effort:** xhigh. **Depends on:** Task 8.

**Files:**
- Modify: `cli/src/services/devices.ts` (`NUDGED_MAX = 64`, `NUDGE_ONCE_MS = 600_000`, the `nudged` map,
  `lastBegan`, `harnessPresent`, `presentAtStop`, `dispatch`'s `processing` and `done`, `port.observed`'s
  `turn-start`, the agent leaving)
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Produces:
  - `const nudgedAgents = new Map<string, { at: number; phase: 'asked' | 'continuing' | 'over'; heard: number }>()`,
    at most `NUDGED_MAX` entries, the oldest first out. A yes sets `{ at: monotonic(), phase: 'asked', heard: at }`.
  - A nudge with `ask` true for an agent in the map, younger than `NUDGE_ONCE_MS`, answers no as `nudged` (and, as
    every no, releases the held turn-stop). An `ask: false` never reads or changes the map (decision 18).
  - An entry goes on: an outside agent's `turn-start` whose source is `person` or `dial`; the agent leaving; or age
    past `NUDGE_ONCE_MS`.
  - For a Harness agent (no outside row), a `processing` card while `'asked'` makes it `'continuing'`. Its `done`
    while `'continuing'` makes it `'over'`, after `rouse` is read; a `done` while `'asked'` sets `heard`.
  - The phase is bounded as the outside hold is: `'asked'` is `'over'` with no card `CONTINUE_QUIET_MS` after `heard`
    (a block the engine never took starts no continuation), and any phase is `'over'` `CONTINUE_MAX_MS` after the yes.
  - `harnessPresent(agentId)` is false while the phase is `'asked'` or `'continuing'` (decision 13).
  - `lastBegan`: each Harness agent's last ended turn's start, at most `NUDGED_MAX`, dropped at its next turn's first
    card or when it leaves. `presentAtStop(agentId)` reads a Harness agent's presence from its turn under way, else from
    that one: Claude Code's reader ends the turn at `end_turn`, before its Stop hook reports.

- [ ] **Step 1: Write the failing tests.**
  - `'a second nudge before the person's next prompt is no, as nudged; after their prompt, yes again'`.
  - `'a relayed turn-start does not end the once rule'`: after a yes, a `turn-start` with `relayed: true`; a second
    nudge is no, as `nudged`.
  - `'after 10 minutes a nudge is yes again'`.
  - `'the continuation's ask false is no ask, not nudged'`: after a yes, the continuation's report (`ask: false`) logs
    `· no ask`, and the map's entry is unchanged.
  - `'a Harness agent nudged with its tile on screen: its continuation's notice rings, not quiet, and its turn end
    leaves no quiet card'`. h1's turn began 130 s ago, with its tile on screen. Yes, then `done`, `processing`, the
    notice: asked (`shownAsks`), no `hold`. Red today: held quiet.
  - `'the continuation over, the person there again: a notice in the next live exchange is quiet'`.
  - `'the 65th nudged agent pushes out the first'`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment says why `began` alone cannot tell: the continuation's first card starts a
  new one, and the devices cannot tell who started a Harness agent's turn.
- [ ] **Step 5: Run them and see them pass.** The same command, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 10: `harness device claude stop` and `harness device codex stop`

**Effort:** xhigh (reads the person's answer and a rollout's head; decides a block). **Depends on:** Task 3 (the guard
reads `flow/v5` and `flow/v6`), Task 2 (`stop-inputs.json`), V. Task 1 (done) settled F1, F2 and F8.

**Files:**
- Create: `cli/src/deviceClaude/stop.ts`
- Create: `cli/src/deviceClaude/stop.spec.ts`
- Create: `cli/src/deviceClaude/__fixtures__/codex-rollout-head-tui.jsonl` and `codex-rollout-head-exec.jsonl`: the
  first line of Task 1's two recorded rollouts (Codex 0.172.0 against the stub: the TUI's of 14-25-44 and `exec`'s of
  14-30-38, in the main session's `spike/copied/codex-sessions/2026/11/27/`), each followed by a newline. `cwd` and
  `runtime_workspace_roots` are set to `/home/person/project`; every other field stays as Codex wrote it, its own
  `base_instructions` too, so the line keeps its real size (about 22 KB). The main session hands the files to the
  task, since the scratchpad is its own.
- Modify: `cli/src/deviceClaude/command.ts` (`case 'stop'` for `claude` and `codex`; `DeviceDeps.ask?`; the header
  comment's list of the plugin's own words)
- Test: `cli/src/deviceClaude/command.spec.ts`

**Interfaces:**
- Consumes, all on `main` after #4672: `hookInput` (`deviceClaude/asked.ts`), `ownSkillIn` (`deviceClaude/start.ts`),
  `within` (`lib/sessionSearch/externals/support.ts`), `NOTICE_SESSION`, `askDevices`, and in `command.ts`
  `pluginActs`, `claudeHome()`, `readRemoved`, `codexPluginState`.
- Produces:
  - `export const DIAL_STOP_REASON` (the Global Constraints' text) and `export function stopOutput(): string` (one line,
    no newline).
  - `export const ASK_TAIL_CHARS = 400`, `export function endsOnAsk(message: string): boolean`, and
    `export function asksOf(input: Record<string, unknown>): boolean`: `input.stop_hook_active !== true`, a string
    `last_assistant_message`, and `endsOnAsk` of it (the Global Constraints' ask).
  - `export const NUDGE_ANSWER_MS = 300`.
  - `const ROLLOUT_HEAD_MAX_BYTES = 128 * 1024` and
    `export function codexHeadless(transcriptPath: unknown, codexHome: string): boolean` (decision 14, F8). False
    unless `transcriptPath` is a string that `openRollout` (`codexTurn.ts`, as `codex asked` opens one) opens: a
    regular file inside the Codex home, never a link, a FIFO or a folder. It reads from the start in chunks with
    `readSync` (closed in a `finally`) until the first `\n` or `ROLLOUT_HEAD_MAX_BYTES`; with no newline by then,
    false. It parses that line and is true only when the line is an object with `type === 'session_meta'` and
    `payload.source` `'exec'` or `'mcp'`. Any throw is false.
    It logs nothing and returns nothing of the line; the line is dropped.
  - `export interface StopDeps { stdin: AsyncIterable<Buffer | string>; dataDir: string; engine: 'claude' | 'codex';
    headless(input: Record<string, unknown>): boolean; acts(): boolean; ask(message: { type: 'nudge'; engine: 'claude'
    | 'codex'; sessionId: string; ask: boolean }): Promise<Record<string, unknown> | number | null>; out(line: string):
    void }`.
  - `export async function runStop(deps: StopDeps): Promise<0>`, in the Global Constraints' order: the input (not
    JSON, not an object, or over 256 KiB: nothing asked); `session_id` held to `NOTICE_SESSION`; `cwd` not `within`
    the data folder; `!headless(input)`; `acts()`; then `ask({ type: 'nudge', engine, sessionId, ask: asksOf(input) })`
    at every stop that got this far (decision 18). It prints `stopOutput()` only when it asked with `ask` true and the
    answer is exactly `{ nudge: true }`.
  - In `command.ts`, Claude:
    `case 'stop': return runStop({ stdin, dataDir, engine: 'claude', headless: () => /^sdk-/.test(deps.env.CLAUDE_CODE_ENTRYPOINT ?? ''), acts: () => pluginActs(deps.dataDir) && ownSkillIn(claudeHome()), ask: deps.ask ?? ((m) => askDevices(deps.dataDir, m, { timeoutMs: NUDGE_ANSWER_MS })), out })`.
    F1 found `sdk-cli` under `-p` and `cli` in the TUI. Codex: the same, with the `acts` `codex start` passes (decision
    4) and `headless: (input) => codexHeadless(input.transcript_path, deps.codexHome)`.

- [ ] **Step 1: Write the failing tests.**
  - `stop.spec.ts`:
    - `'the reason is the plan's, word for word, one line of printable ASCII with no < or >, naming harness device
      notify'`.
    - `'stopOutput is the block on one line'`: `JSON.parse` gives `{ decision: 'block', reason: DIAL_STOP_REASON }`.
    - `asksOf` over every case of `cli/evals/dial-skill/test-data/stop-inputs.json` equals `asks` (the eval's fake
      reads the same file).
    - `runStop` prints `stopOutput()` once on `{ nudge: true }`, and the ask it sent is exactly `{ type: 'nudge',
      engine, sessionId, ask: true }`. The message's words are absent from `JSON.stringify` of every ask.
    - `'reports every stop past step 1, with ask false and nothing printed'`: for `stop_hook_active` true; no, empty
      or non-string message; no question mark in the tail. Each sends exactly one ask with `ask: false`, and prints
      nothing even when the injected answer is `{ nudge: true }`.
    - `'tells the devices nothing'` (step 1), prints nothing and returns 0, for: a `cwd` that is the data folder or
      `voice-route-scratch` inside it; a session id with `/`; `headless` true; `acts` false; `acts` throwing; input
      that is not JSON, an array, or over 256 KiB.
    - `'the order of checks'`: spies show `headless` is not called for a bad session id or a `cwd` in the data folder,
      and `acts` is not called when `headless` is true.
    - It prints nothing for answers `{ nudge: false }`, `{}`, `{ nudge: 'yes' }`, `429` and `null`.
    - `describe('codexHeadless')`, over the two fixtures copied to a temporary folder: the TUI's head is false; `exec`'s
      is true; `exec`'s head with more rollout lines after it is true; `exec`'s `source` padded so the line passes
      `ROLLOUT_HEAD_MAX_BYTES` before its newline is false; a missing file, a folder, an empty file, a first line that
      is not JSON, and `{"type":"event_msg","payload":{"source":"exec"}}` are false; `undefined`, `''` and `42` are
      false. On POSIX, a FIFO at the path is false and returns at once (no open).
    - `'an ask that never answers: done within NUDGE_ANSWER_MS, nothing printed'` (fake timers; the injected `ask`
      honors its abort as `askDevices` does).
    - `out` throwing still returns 0.
    - The guard: `'the eval's Part 5 variants answer exactly what this command prints'`, for `flow/v5` and `flow/v6`
      each. The `stop` answer in `harness-answers.json` has stdout `stopOutput() + '\n'`, and the `Stop` hook in
      `hooks.json` runs `harness device claude stop` with timeout 5.
  - `command.spec.ts`, using the spec's throwaway homes and data folder and an injected `ask`:
    - `'claude stop prints the block with the plugin on and Harness's skill in the session's home, and exits 0'`.
    - `it.each` `'claude stop prints nothing and exits 0: %s'`: plugin off, removed, no skill, `CLAUDE_CODE_ENTRYPOINT`
      `sdk-cli` (these four ask nothing), and a no from the devices.
    - The same two for `codex stop`: the input's `transcript_path` names a copy of the TUI's fixture (asks), and of
      `exec`'s fixture in place of `sdk-cli` (asks nothing).
    - `'stop is not in DEVICE_USAGE'`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/deviceClaude/stop.spec.ts
  src/deviceClaude/command.spec.ts`. Expected: FAIL (`stop.ts` not found; `claude stop` prints the usage, exit 1).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** `stop.ts`'s header comment says:
  - what the look is for;
  - which fields it reads, and that the answer and the rollout's head never leave its process;
  - why `cwd` in the data folder, headless runs and the skill off tell the devices nothing, while every other stop is
    reported (the devices hold its turn-stop for the report, decision 18);
  - why the cheap checks come before any file read and the ask, and why Codex's headless sign is the rollout's head
    (F8: nothing in the input or the environment says it);
  - why any failure prints nothing: what it prints, the engine reads as a block.
  One `try` wraps the whole of `runStop`.
- [ ] **Step 5: Run them and see them pass.** `cd cli && npx vitest run src/deviceClaude/stop.spec.ts
  src/deviceClaude/command.spec.ts src/deviceClaude/asked.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 11: Claude Code's Stop hook in the plugin

**Effort:** high. **Depends on:** V. Its tests use a stand-in launcher that prints a literal block, so they do not need
Task 10.

**Files:**
- Modify: `plugins/harness-device/hooks/hooks.json` (the `Stop` key, appended)
- Create: `plugins/harness-device/hooks/stop` (mode 755)
- Modify: `cli/scripts/lib/claudePluginBundle.mjs` (`EXECUTABLE` gains `plugins/harness-device/hooks/stop`)
- Modify: `.gitattributes` (`plugins/harness-device/hooks/stop text eol=lf`, beside `hooks/start`'s line)
- Test: `cli/src/harnessDevicePlugin.spec.ts`, `cli/src/devices/claudePluginBundle.spec.ts`

**Interfaces:**
- Produces: `hooks.json` keys are main's plus `'Stop'`, last. Its value is
  `[{ hooks: [{ type: 'command', command, onFailure: 'continue', timeout: 5 }] }]`, with no matcher.
  - POSIX first line: ``echo `# <#` >/dev/null; exec "${CLAUDE_PLUGIN_ROOT}/hooks/stop"``.
  - After `#>` comes the PermissionRequest form's lookup without its `HARNESS_DEVICE_MOD_ASKS` check, ending
    `if ($h) { $o = & $h device claude stop 2> $null; if ("$o".StartsWith('{"decision":"block","reason":')) { [Console]::Out.Write("$o") } }; $null = [Console]::In.ReadToEnd(); exit 0`.
  - `hooks/stop` is `hooks/start`'s shape (Part 4): the lookup, `device claude stop` with the hook's stdin, stderr to
    `/dev/null`, stdout captured and printed with a newline only under the prefix; `cat >/dev/null` after the
    launcher, or with none; `exit 0`.

- [ ] **Step 1: Write the failing tests**, as Part 4's Task 2 wrote the SessionStart ones. Use `STOP_INPUT`
  (`session_id`, `transcript_path`, `cwd`, `hook_event_name: 'Stop'`, `stop_hook_active: false`,
  `last_assistant_message`) and `BLOCK = '{"decision":"block","reason":"r"}'`.
  - The `hooks.json` keys test.
  - `posix.each(SHELLS)` from a folder with a space: the launcher's argv is `device\nclaude\nstop\n`, its stdin is
    `STOP_INPUT` byte for byte, and the result is `{ status: 0, stdout: BLOCK + '\n', stderr: '' }`.
  - `'prints nothing but the block'` over usage text, `ALLOW`, `''`, exits 0, 1 and 2, and stderr.
  - With no launcher: nothing, exit 0. The executable check and `#!/bin/sh`.
  - The Windows form: `device claude stop 2> $null` once, the guard, no `HARNESS_DEVICE_MOD_ASKS`, `[Console]::In`
    only after the launcher and no `|` into `$h`, ending `; $null = [Console]::In.ReadToEnd(); exit 0`.
  - In the win32 block, for PowerShell and Git Bash: the block passes (`stdout.trim()`); `ALLOW` prints nothing; no
    launcher prints nothing; a `last_assistant_message` of `Đã xong, không cần gì thêm.` reaches the stand-in byte
    for byte.
  - `'the Windows forms' time to the report'` (win32 only; decision 18's measure for `windows-e2e`): 10 runs of each
    form, timed with `process.hrtime.bigint()` from spawn to the moment the stand-in launcher starts (it writes the
    time to a file first, before it reads stdin), which is when the real command would report. The test prints one
    line per form, `[measure] stop report · <form> · median <ms> · max <ms> · past 6 s <n>`, and asserts only that every
    run finished. The stand-in starts at once, so the number is the shell's share; Verification 5 gives the real CLI's.
  - `claudePluginBundle.spec.ts`: the executable list gains `hooks/stop`. Its existing `'the device plugin's hook
    scripts are checked out with LF line ends on every platform'` then needs the `.gitattributes` line.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts
  src/devices/claudePluginBundle.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** the four files. `hooks/stop`'s comment says that Claude Code reads a Stop hook's stdout as
  its decision, so only the block the launcher shapes passes.
- [ ] **Step 5: Run them and see them pass.** The same command. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 12: Codex's Stop hook in the plugin, trusted as the others

**Effort:** high. **Depends on:** Task 11 (the same spec, bundle list and form). Task 1 (done) settled F2 and F7.

**Files:**
- Modify: `plugins/harness-device/hooks/codex.json` (the `Stop` key, appended)
- Create: `plugins/harness-device/hooks/codex-stop` (mode 755)
- Modify: `cli/scripts/lib/claudePluginBundle.mjs` (`EXECUTABLE` gains `plugins/harness-device/hooks/codex-stop`)
- Modify: `.gitattributes` (`plugins/harness-device/hooks/codex-stop text eol=lf`)
- Test: `cli/src/harnessDevicePlugin.spec.ts`, `cli/src/devices/claudePluginBundle.spec.ts`,
  `cli/src/devices/codexPluginTrust.spec.ts`

**Interfaces:**
- Produces: `codex.json` keys are main's plus `'Stop'`, last, with no matcher.
  - POSIX: ``echo `# <#` >/dev/null; exec "$PLUGIN_ROOT/hooks/codex-stop"``.
  - Then the Codex lookup, with Task 11's guarded write for `device codex stop`.
  - `hooks/codex-stop` is `hooks/codex-asked`'s lookup with Task 11's capture and prefix check.
  - The trust record `…:stop:0:0` comes from the unchanged `pluginTrustRecords`.

- [ ] **Step 1: Write the failing tests:**
  - the Codex counterparts of Task 11's cases, the time to the report included, run the `runCodexHook` way (`<shell>
    -c`, `PLUGIN_ROOT` set; argv `device\ncodex\nstop\n`; the win32 block through `powershell.exe -NoProfile
    -Command`);
  - the executable list (and with it the LF check);
  - `codexPluginTrust.spec.ts`: `'the repository's plugin gets a stop record, its matcher not hashed'`. Its key is
    `harness-device@openharness:hooks/codex.json:stop:0:0` and its `trustedHash` equals `reviewHash({
    ...hooks.settings.reviewed!, matcherEvents: [...] }, 'Stop', undefined, { command, timeout: 5 })`, and every record
    shares one `contentHash`. F7 found that key `trusted` in `hooks/list`, its hash the same with or without a matcher.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts
  src/devices/claudePluginBundle.spec.ts src/devices/codexPluginTrust.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** the four files. `codexPluginTrust.ts` does not change.
- [ ] **Step 5: Run them and see them pass.** The same command. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 13: dropped (F5)

Task 13 would have taught Harness's Codex reader to label a Stop hook's prompt. Task 1's F5 found it needs nothing:
`engines/codex/normalizer.ts`, replaying the recorded rollout live, makes no event for the hook prompt (its
`response_item` user message and its `item_completed` `HookPrompt`), and the turn stays open until the one
`turn_ended` at `task_complete`. So a Harness Codex agent's blocked stop is never a new turn and its first end is never
told. No file changes, and the pull request says so.

### Task 14: end to end, on the real daemon with the carried hooks

**Effort:** high. **Depends on:** Tasks 9, 10, 11 and 12.

**Files:**
- Create: `cli/e2e/deviceStopLook.e2e.ts` (no change to `cli/e2e/harness/`)

**Interfaces:**
- Consumes:
  - `IsolatedDaemon`, `Desk`, `FakeDial`, `fileBundle()`, `harnessPath('claude-marketplace', HOME)`, `tellDevices`;
  - `InOrca` (Claude Code in an Orca terminal, its hooks run by the test with `hook('Stop')`) and `CodexOutside`;
  - Task 10's `stopOutput`;
  - the `launcher(d)` pattern of `cli/e2e/deviceStartLine.e2e.ts` (a local function there, written again here) for
    `<HOME>/.local/bin/harness`.

- [ ] **Step 1: Write the test.** Run the carried `hooks/stop` and `hooks/codex-stop` command lines through
  `/bin/sh -c`, with `d.env`, `${CLAUDE_PLUGIN_ROOT}` or `PLUGIN_ROOT` set to the carried folder, and the Stop input on
  stdin. Absence is shown against an anchor: a second session B, with no question, stops at the same moment, and its
  told summary is the barrier. Unless a case says otherwise, A has reported once in an earlier turn (one stop with no
  question, its hook run), so its stops wait for their reports; each of A's native Stops is followed by its hook, as
  the engine runs them.
  1. `'Claude Code, the person away: one block, the first end not told, the notice rings once, the next stop ends
     silent'`. The front is `vscode` and the dial is on another agent. A's native Stop runs, then the hook gives
     `stopOutput()`. B's summary arrives while A has none. A's `harness device notify` gives one `question` frame.
     A's next Stop (`stop_hook_active: true`) prints nothing and reports `· no ask`. Then one `summary`, `tier:
     'silent'`, and the log has `rule:notice`.
  2. `'no question: nothing printed, reported with ask false'` (the PM's case 4): the person away and the dial on
     another agent. `[device] nudge · claude · no ask` once and no other `[device] nudge` word; A is told done once,
     after its report.
  3. `'the person there: no block'` (`[device] nudge · claude · present`).
  4. `'a notice rung in this turn: no block'` (`· notice`), and `'a card from an earlier turn: one block'`: A rang in
     a turn, the person's next prompt started another, and A's question-ending stop in it is blocked once.
  5. `'no dial: no block'` (`· no dial`).
  6. `'the block lost: told once when the hold goes quiet'`. The hook says yes, no next Stop is run and the transcript
     is left untouched: one summary, 10 s or more after the yes and before 120 s, waited for as an event with a bound,
     never a fixed sleep.
  7. `'the yes before the blocked stop'`: case 1 with the hook run before the native Stop (the order Task 1 never saw;
     kept as cheap).
  8. `'a second look before the person's next prompt: no block'` (`· nudged`).
  9. `'Codex, the person away'`: case 1 with `CodexOutside` and `device codex stop`. No turn-start comes for the hook's
     prompt (F4).
  10. `'a late report, as on Windows: the turn end waits for it'` (the PM's case 1). A's native Stop and B's native
      Stop and hook run together; A's hook is held back until B's summary has arrived (past the grace). A has no
      summary then; after A's hook reports (`ask: false`), one summary for A. The same with a question and a yes: after
      B's summary, A's hook blocks; no summary for A, and its notice gives one `question` frame.
  11. `'no report: told at 6 s, and the session no longer waited for'` (the PM's case 2). A's native Stop with no hook
      run: one summary for A, at 6 s or later from the Stop and within a 10 s bound, and `[observed] stop report
      missed` once. A's next turn, its Stop again with no hook: its summary comes with B's (B stopping at the same
      moment), well before 6 s.
  12. `'a session that never reported: the grace, as today'` (the PM's case 3): A with no earlier report, its native
      Stop alone; its summary comes with B's.
  Every case: no daemon log line holds the answer's words or the session id.
- [ ] **Step 2: Run it.** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceStopLook.e2e.ts`.
  Expected: PASS on top of Tasks 9-12. Its red is theirs.
- [ ] **Step 3: Commit.** One commit.

### Task 15: docs

**Effort:** medium. **Depends on:** Tasks 9, 10, 11 and 12. **Test that must fail first:** none (docs); one commit.

**Files:**
- Modify: `plugins/harness-device/README.md`. A "When a turn stops" section:
  - the `Stop` hook in both engines and what it reads (for Codex, the rollout's first line, to know an `exec` run);
  - that it reports every turn end to the devices (the engine, the session id and whether the answer asks), and that
    the devices wait for that report, at most 6 s, before the dial hears the turn is done;
  - the 400 characters and the two question marks;
  - the four conditions for a yes (a notice counts only when rung in this turn; another session's message starts no
    new turn for it);
  - the reason, word for word;
  - once a turn, and never for a headless run or Harness's own one-shots;
  - the 300 ms bound;
  - what the person sees (one more round of the agent, and Claude Code's "Stop hook feedback");
  - how to take it away (`harness device claude|codex disable`).
  "What it never does" gains: it never logs, keeps or sends the answer.
- Modify: `cli/AGENTS.md`. The devices row gains: the `nudge` message on the devices' listener (engine, session id and
  `ask`, sent at every turn end the plugin sees, answered within 300 ms; `ask: false` only releases the turn end), the
  four conditions (a notice rung in this turn, not a card left from an earlier one), the observed source holding a
  reported session's turn-stop until its report or 6 s (a session's first stop rests on the grace), and its holding a
  nudged agent's turn end until its next stop, or 10 s with no activity (a hook, or its transcript growing), at most
  120 s. The plugin clause gains its `Stop` hooks running `harness device claude|codex stop` (`deviceClaude/stop.ts`).
- Modify: `docs/cli.md`. The `harness device claude` and `harness device codex` rows get one sentence each: the plugin
  stops a turn that ends on a question once, while the person is away and the dial would ring, so the agent decides
  whether to ring.

- [ ] **Step 1:** Write them, short. No UI element changes, so the design doc does not.
- [ ] **Step 2:** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts` (its README test). Expected: PASS.
- [ ] **Step 3: Commit.**

### Task 16: the backend takes the four names, and the review shows them

**Effort:** high (names the backend stores and the review reads). **Depends on:** V. Nothing in it needs the hook's
code, and the names cost nothing unless a CLI sends them.

**Files:**
- Modify: `cli/src/lib/dialUsageContract.ts` and `backend/src/types/dialUsage.ts` (its byte copy)
- Modify: `backend/src/analytics/dailyDialReview.ts` (the `Dial skill` section's rows, one limit line)
- Test: `cli/src/lib/dialUsageContract.spec.ts`, `backend/src/routes/productUsage.test.ts`,
  `backend/src/analytics/dailyDialReview.test.ts` (`backend/src/types/dialUsage.test.ts` holds the copy, unchanged)

**Interfaces:**
- Produces: at the end of `DIAL_DEVICE_METRICS`, after `'dial_notice_present_roused'`,
  ``...DIAL_SKILL_ENGINES.flatMap(e => [`dial_nudge_${e}`, `dial_nudge_${e}_rang`] as const)``, so they are in
  `DIAL_FILE_METRICS` and `DIAL_USAGE_METRICS` and none in `DIAL_FLAG_METRICS`. The comment above them says what each
  counts (decision 7) and names the spec's Part 5. Task 17 adds them by these names.
- The review's `Dial skill` section gains, after the `Quiet, rung: …` row, for `claude` then `codex`:
  `<e>: second looks, yes (skill computer-days; yeses)`, computers `dial_skill_<e>_installation_days` and events
  `dial_nudge_<e>`, then `<e>: second looks, rang after (skill computer-days; rings)`, the same computers and events
  `dial_nudge_<e>_rang`. The computers are the skill's: the hook asks only where Harness's skill is on.
- `limits` gains, last: `"Second looks count only yeses the devices gave a stop that ended on a question, and a notice rung while that stop was held, once a yes: a yes on a session's first stop, told done before its report came, can never count as rang."`

- [ ] **Step 1: Write the failing tests.**
  - `dialUsageContract.spec.ts` `'names the second look\'s counts: four, none a computer flag'`: the
    `DIAL_DEVICE_METRICS` names matching `/^dial_nudge_/`, sorted, equal the four of the Global Constraints, each in
    `DIAL_USAGE_METRICS`, none in `DIAL_FLAG_METRICS`.
  - `productUsage.test.ts` `'takes the second look\'s names'` (beside `'takes the dial skill\'s names'`): a CLI report
    whose counters are the four at 1 is 200, and `ingestProductUsage` gets exactly those counters, with no
    `health_cli_report_unknown_metric`.
  - `dailyDialReview.test.ts` `'shows the second look per engine against the computers with the skill'`: day-1 rows
    `dial_skill_claude_installation_days` 6, `dial_nudge_claude` 9, `dial_nudge_claude_rang` 4 → the yes row
    `{ computers: { day: 6 }, events: { day: 9 } }` and the rang row `{ computers: { day: 6 }, events: { day: 4 } }`,
    the yes row right after `Quiet, rung: …` and the rang row right after it; no `codex: second looks` row (empty
    rows hidden); `DIAL_REVIEW_METRICS` contains the four. `'states the second look\'s limit'`: `limits` ends with
    the line above.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/lib/dialUsageContract.spec.ts` and
  `cd backend && npx vitest run src/routes/productUsage.test.ts src/analytics/dailyDialReview.test.ts`. Expected:
  FAIL (no `dial_nudge_` name; the route drops them and counts `health_cli_report_unknown_metric`; no rows).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** in `cli/src/lib/dialUsageContract.ts`, then
  `cp cli/src/lib/dialUsageContract.ts backend/src/types/dialUsage.ts`; then the rows and the limit in
  `dailyDialReview.ts`, built with the file's `line`, `computerDays` and `sum`.
- [ ] **Step 5: Run them and see them pass.** The same commands, plus `cd backend && npx vitest run
  src/types/dialUsage.test.ts` and `npm run typecheck` in `cli` and in `backend`. Expected: PASS (the report size
  cases still pass).
- [ ] **Step 6: Commit** (`feat: the second look's usage names, and the review's rows`).

### Task 17: the devices count a yes and a ring after it

**Effort:** xhigh (counts synced to the backend, read on the hold's timing). **Depends on:** Task 16 (the names),
Task 7 (the hold), Task 8 (the yes, in `devices.ts`) and Task 9 (a Harness agent's phases, in `devices.ts`).

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`Entry.secondLook.continuing.counts`, `ObservedSource.rangInHold`)
- Modify: `cli/src/cable/dialUsage.ts` (`nudgeYes`, `nudgeRang`)
- Modify: `cli/src/services/devices.ts` (the `yes` answer counts; `noticeShown` counts a ring in the window; Task 9's
  entry gains `engine` and `counts`)
- Modify: `cli/e2e/dialUsage.e2e.ts` (one more outside session in its one case)
- Modify: `docs/product-measurement.md` ("The dial's counts" table, a row after `Do agents use the dial skill?`)
- Test: `cli/src/cable/hosts/observed.spec.ts`, `cli/src/cable/dialUsage.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: Task 16's names; Task 7's hold (`entry.secondLook.continuing`, `stopReported`); Task 8's `nudged` and its `yes`;
  Task 9's `nudgedAgents` and its phases; `count`, `noticeShown` and `noticeCaller` in `devices.ts`.
- Produces:
  - `DialUsage.nudgeYes(engine: DialSkillEngine): void` adds `dial_nudge_<engine>`;
    `DialUsage.nudgeRang(engine: DialSkillEngine): void` adds `dial_nudge_<engine>_rang`. Neither keeps anything.
  - Task 7's hold gains `counts: boolean`, true when `stopReported(agentId, true)` starts the hold (a second yes
    while it holds does not set it again). `ObservedSource.rangInHold(agentId: string): 'claude' | 'codex' | null`:
    for an entry whose hold (`'heard'` or `'awaited'`) has `counts`, clears it and returns `entry.agent.engine`;
    else null. The mark goes with the hold, so after the hold's end (its next stop, its expiry, a turn event, the
    entry's removal) the answer is null.
  - Task 9's entry becomes `{ at, phase, heard, engine: 'claude' | 'codex', counts: boolean }`, `counts` true at the
    yes.
  - In `devices.ts`: at the `yes` answer, `count((usage) => usage.nudgeYes(ask.engine))`. In `noticeShown`, for a
    notice not held quiet: `observed?.rangInHold(agentId)`; when null and no outside row holds the agent (a Harness
    agent), its Task 9 entry in phase `'asked'` or `'continuing'` with `counts` gives its `engine` and clears
    `counts`. An engine so found is counted with `usage.nudgeRang(engine)`.

- [ ] **Step 1: Write the failing tests.**
  - `observed.spec.ts` `describe('the ring after a yes (Part 5\'s counts)')`, with Task 7's rig:
    - `'the yes\'s hold answers its engine once'`: a yes after the blocked stop; `rangInHold` is `'claude'`, then null.
      The same for `'awaited'` (the yes before the blocked stop), and for a Codex session (`'codex'`).
    - `'null once the hold ends'`: after the next stop; after the hold expires (10 s quiet, and the 120 s cap); after
      a prompt; after `session-end`.
    - `'null with no hold, a no, a second yes, or a yes that started none'`: no report; a report `false`; a second yes
      after the first's mark was read; a yes on an unmarked session past its grace (`stopReported` false).
  - `dialUsage.spec.ts` `'counts a second look\'s yes and its ring by engine'`: `nudgeYes('claude')` twice,
    `nudgeYes('codex')`, `nudgeRang('claude')` → `dial_nudge_claude` 2, `dial_nudge_codex` 1,
    `dial_nudge_claude_rang` 1, and no other name added.
  - `devices.spec.ts` `describe('the second look\'s counts')`, inside `'the dial\'s usage counts, in dial-usage.json'`
    (its `counted`, `attach`, `hook`), with Task 8's setup (the outside agent reported once, the person away):
    - `'a yes counts dial_nudge_claude; a no of every word counts nothing'` (`no ask`, `no dial`, `notice`,
      `present`, `nudged`), and a Codex session's yes counts `dial_nudge_codex`.
    - `'an outside agent\'s notice in its held continuation counts rang, once a yes'`: the turn-stop, the yes, the
      notice shown → `dial_nudge_claude_rang: 1`; a second notice in the same hold → still 1.
    - `'a notice after the hold counts no rang'`: the next stop and its report, then a notice → 0; and after the hold
      expired at 10 s quiet → 0.
    - `'a yes no hold took counts the yes and never rang'`: an unmarked session whose stop was told at the grace's
      end, a yes, a notice → `dial_nudge_claude: 1`, no `_rang`.
    - `'a Harness agent\'s notice in its continuation counts rang; after its done, none'`: yes, `processing`, the
      notice → 1; then `done`, `processing`, a notice → still 1.
    - The file's text holds no session id, agent id or notice text.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts
  src/cable/dialUsage.spec.ts src/services/devices.spec.ts -t "second look|ring after a yes"`. Expected: FAIL
  (`rangInHold`, `nudgeYes` and `nudgeRang` do not exist; no `dial_nudge_` name).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment on `rangInHold` says why the mark lives on the hold: the ring counts only in
  the continuation the yes started, and goes when it ends (the spec's "Part 5's counts"). The comment in `noticeShown`
  says why a Harness agent's window is Task 9's phase: the devices hold no stop of its; its reader continues the turn.
- [ ] **Step 5: Extend the end-to-end case** in `cli/e2e/dialUsage.e2e.ts`, which signs its isolated daemon in to the
  in-memory `FakeBackend` (the devices count only signed in; Task 14's daemon is signed out, so its file holds no
  counts). One more outside session, `Outside.start(d, 'PRIVATE_LOOK_CANARY', { TERM_PROGRAM: 'ghostty' })`, the
  person away as for `away`. Its first turn ends and its report (`askDevices(d.dataDir, { type: 'nudge', engine:
  'claude', sessionId, ask: false })`, from `../src/devices/listenerClient.js`) marks it; the person's next prompt,
  its turn ends, `ask: true` answers `{ nudge: true }`; `notify` (the case's helper) with `--waiting` answers `shown`;
  its next turn end and its `ask: false` report. `skill` gains `dial_nudge_claude: 1, dial_nudge_claude_rang: 1`;
  the existing secret check covers the canary and the session id.
- [ ] **Step 6: Docs.** `docs/product-measurement.md`, a row `Does the second look ring?` naming
  `dial_nudge_<claude\|codex>` and `dial_nudge_<claude\|codex>_rang`: a yes is a stop that ended on a question which
  the devices answered yes (a dial attached, no notice rung in that turn, the person away, not nudged already); rang is
  a notice of that agent rung while that stop was held after the yes (an outside agent's hold; a Harness agent's
  continuation until its turn end), at most once a yes; a yes on a session's first stop told done before its report
  can never ring; the `[device] nudge` log line stays a debug line.
- [ ] **Step 7: Run them and see them pass.** The Step 2 command without `-t`, `npm run typecheck`, then
  `npx vitest run --config vitest.e2e.config.ts e2e/dialUsage.e2e.ts` once (up to 15 minutes; one e2e run at a time).
  Expected: PASS.
- [ ] **Step 8: Commit** (`feat(cli): count the second look's yes and the ring after it`).

---

## Task graph

| Task | Depends on | Effort |
|---|---|---|
| 1 spike, both engines (no repository file) | G0 (open) | done |
| 2 the eval answers a Stop hook, `nudged`, `bases`, the $270 cap | G1 | high |
| 3 the variants `flow/v5` and `flow/v6` | 2 | medium |
| 4 the eval passes, (b) then (a) (not before GO) | 3, GO (1 done) | high |
| 5 results and the spec | 4 | medium |
| V Task 4's verdict ships | 4 | gate |
| 6 `nudge` (with `ask`) on the listener | V | high |
| 7 the observed source waits for the report and holds a stop that goes on | V | xhigh |
| 8 the devices answer `nudge` | 6, 7 | xhigh |
| 9 once; a Harness agent's presence | 8 | xhigh |
| 10 `device claude|codex stop` | 2, 3, V | xhigh |
| 11 Claude Code's Stop hook | V | high |
| 12 Codex's Stop hook and its trust | 11 | high |
| 13 dropped (F5) | none | none |
| 14 end to end | 9, 10, 11, 12 | high |
| 15 docs | 9, 10, 11, 12 | medium |
| 16 the backend takes the four names; the review's rows | V | high |
| 17 the devices count a yes and a ring after it | 7, 8, 9, 16 | xhigh |

Longest chain: 2 → 3 → 4 → (V) → 6 → 8 → 9 → 14, and 2 → 3 → 4 → (V) → 6 → 8 → 9 → 17, seven tasks after G1. GO
joins them at Task 4; Task 7 joins at Task 8 (and at 17), Task 16 at 17. Tasks 6, 7, 10, 11 and 16 start together at
V. Tasks 8, 9 and 17 share `devices.ts`, Tasks 7 and 17 share `observed.ts`, and Tasks 11 and 12 share the plugin
spec, the bundle list and `.gitattributes`, so each runs in order. Task 4 runs now (GO given); (b) is done.

## Pull request notes

- One pull request, released by the PM, **the backend first, then the CLI** (which carries the plugin), after Part 4's
  eval (Release order 8). The backend release takes the four names (Task 16); the CLI that sends them (Task 17)
  follows it, since an older backend drops each unknown name (and counts `health_cli_report_unknown_metric`) and
  keeps the rest, so a CLI first would lose the counts and nothing else. If V fails, the eval alone (Tasks 2-5), no
  backend change.
- The verdict rests on (a), the only gate. (b) is reported, not a gate: it failed as one (v6 44 of 48 against v1's
  41, p = 0.262, no run blocked), and the PM ruled that short `claude -p` runs cannot make the hook's case (the spec,
  0ac8d38707). The pull request says so in those words: a gate moved after its run.
- **Follow-up, the PM's read, nothing to build now:** 7 days after the CLI release, in `usage:daily`'s `Dial skill`
  section, both engines summed: the hook is kept when `dial_nudge_claude_rang + dial_nudge_codex_rang` is above 0
  and at least a quarter of `dial_nudge_claude + dial_nudge_codex`; else it is removed by a CLI release that takes
  out the plugin's Stop hook alone (the `Stop` entries of `hooks.json` and `codex.json` and their scripts). The
  trigger does not change before that read.
- Codex's side ships only on Verification 2's proof (the spec). If it fails, the main session takes Task 12 and Task
  10's `codex stop` case out before the merge, and Claude Code's side ships alone.
- Task 13 was dropped: Task 1's F5 found that Harness's Codex reader makes no event of a Stop hook's prompt and keeps
  the turn open, so no reader changes.
- Evidence:
  - the red-then-green commits;
  - Task 4's held-out rows for both pairs ((a) v5 against v4 with its intervals, the gate; (b) v6 against v1 with
    its Fisher p, reported), the verdict, the extra rounds and the spend (numbers only);
  - Task 16's and 17's red-then-green tests, and the e2e's usage file with the two `dial_nudge_claude` names at 1;
  - backend rule 5, as #4650: growth from the vocabulary, no production read: four names × 3 prefixes = at most 12
    new `product_usage_totals` rows a day, kept by the existing TTL; no new query, `readDialRows`'s `$in` four names
    longer;
  - Task 1's facts;
  - Verification 1-3's results, and Verification 3's hook times (median and maximum);
  - the Windows numbers (decision 18): `windows-e2e`'s `[measure] stop report` lines and Verification 5's time from
    the native turn-stop to the hook's report, with whether a done was told before it;
  - `local-checks.py`'s receipts;
  - the stated limits under Review Focus, among them that no scenario is built for the miss in use (a long session's
    turn ending a long report with the ask only in its last lines); pair (b) stands in for it by leaving the line out;
  - the platforms (macOS, Linux, Windows) and how each was tested.

## Verification

**On GitHub, automatic on the pull request** ([validation and release](../validation-and-release.md)):
- `cli-typecheck` and `cli-tests`: every spec above, `architecture.spec.ts` and `architecture.failureLogs.spec.ts`
  among them.
- `linux-e2e`: the new `deviceStopLook.e2e.ts` and the extended `dialUsage.e2e.ts` (Task 17), plus the dial app
  eval's six, as `services/devices.ts` and `cable/hosts/observed.ts` change.
- `backend-desk` (and what `scripts/ci-plan.py` selects for `backend/src/`): Task 16's `dialUsage.test.ts`,
  `productUsage.test.ts` and `dailyDialReview.test.ts`, on made-up rows, no account, no production.
- `windows-e2e` x64, selected by path for `plugins/harness-device*/` and `cli/src/devices/`. There
  `harnessDevicePlugin.spec.ts` runs both Stop forms under Windows PowerShell and Git Bash, and Codex's under
  PowerShell, and prints the forms' time to the report (`[measure] stop report`, Tasks 11 and 12), which the pull
  request carries.
- The other jobs `scripts/ci-plan.py` selects for these paths.

Picked up front, by hand: one run of `cli-e2e.yml` from the branch at the final head (Actions → CLI end to end → Run
workflow). The observed source's turn ends feed every outside-agent e2e file, and PR CI runs only the pull request's
own. No other workflow is started by hand.

**Local gates PR CI does not run:** at the final commit, from a clean tree, `python3 scripts/local-checks.py --run`. It
selects `npm run test:core`, as `services/devices.ts` and `cable/` change, with every file at 100%. Paste its receipts
in the pull request. Also run the eval's own specs: `cd cli && npx vitest run --config
evals/dial-skill/vitest.config.ts`; `cd backend && npm run typecheck && npx vitest run src/types/dialUsage.test.ts
src/routes/productUsage.test.ts src/analytics/dailyDialReview.test.ts`; and `cmp cli/src/lib/dialUsageContract.ts
backend/src/types/dialUsage.ts` prints nothing.

**Isolation for 1-3.** Use a scratch root in the session's scratchpad, from a stable folder outside any worktree that
will be deleted. A scratch driver runs with `npx tsx` from `cli/`, with `E2E_BUNDLE_PATH` set to the branch's bundle
(`cd cli && npm ci && npm run bundle`). The driver starts an `IsolatedDaemon` and a `Desk` with one `FakeDial`, as
`deviceNotify.e2e.ts` does. The daemon has its own `HOME`, data folder, free port other than 18473, private tmux server,
hook routes and Codex home. It is signed out, and its backend is `ws://127.0.0.1:9`.
- `<HOME>/.local/bin/harness` is a wrapper, `exec node <bundle> "$@"`.
- `harness device claude enable` and `harness device codex enable` install the carried plugin and its trust.
- The model stubs are Task 1's, on `127.0.0.1`, with dummy keys.
- Never the tester's `~/.claude`, `~/.codex`, `~/.harness`, everyday daemon, login, or any production backend. A real
  sign-in is never copied. Clean up only what the check made.

1. **The real Claude Code (2.1.332 or later), on this Mac, before the merge** (a tester; macOS). The stub's script:
   - the first answer ends `Which database should the export use?`;
   - a request holding the reason gets a Bash tool call
     `harness device notify "Pick the export's database" --suggest "Postgres" --waiting`;
   - after its result, `Waiting on your pick of database.`
   Claude Code runs with `--allowedTools 'Bash(harness device notify:*)'`, so no permission ask rings instead.
   - **Outside a pane** (the private tmux server, `TERM_PROGRAM=ghostty`, the front `kitty` by `tellDevices`, the dial
     on another agent). Seen:
     - the stub gets the reason exactly once;
     - the fake dial gets one `question` frame for the agent and no `summary` before it;
     - the daemon log has `[device] nudge · claude · yes` once and then `[cable] notify · silent · rule:notice`;
     - the second Stop does not block (`stop_hook_active`).
   - The same session after the person's prompt within 120 s, with `ghostty` in front and the dial on the agent: the
     stub gets one request, and the log says `· present`.
   - With the dial unplugged, `· no dial`. An answer with no question mark gives `· no ask` and its turn end is told
     after it. A turn that rang first gives `· notice`, also after the card was answered on the dial within that turn.
     A card left from the previous turn does not stop the block.
   - **In a Harness pane** (`agent_create` with the real `claude` as `CLAUDE_PATH`). Seen: the reader's
     `Continuing: Your answer asks…` turn, the first end told nothing (its recap's trace says `not news · next-turn`),
     one `question` frame, and a silent end. If the daemon does not pass the stub's address to the pane, report it.
     That pane case then rests on the reader's existing `/goal` e2e.
   - `claude -p` under the same homes: no block (decision 14).
   - From the data folder's `voice-route-scratch`: no block.
2. **The real Codex (0.172.0 or later), on this Mac, before the merge** (a tester; macOS). The same script through the
   Codex stub. `rules/harness.rules`, written by the isolated daemon, lets `harness device notify` run outside the
   sandbox.
   - `codex app-server` `hooks/list` shows every one of the plugin's hooks `trusted`, `stop` among them.
   - Outside a pane, in the TUI: the same signs as 1. No `[device] prompt` line comes for the hook's prompt (F4).
   - In a Harness pane: the turn left open through the continuation (F5), the first end told nothing.
   - `codex exec`: no block and no `[device] nudge` line (F8, the rollout's head).
   - Harness's own one-shot flags from the data folder: no block and no `[device] nudge` line.
3. **The hook's time at a turn end, on this Mac** (a tester; macOS; code standard 4). The hook now reports at every
   turn end, so every input below reaches the devices. Run the installed `hooks/stop` and `hooks/codex-stop` with the
   wrapper 20 times for each of four inputs, one after another, timed from spawn to exit with `process.hrtime.bigint()`:
   - an answer with no question mark, the devices answering (`ask: false`);
   - one with a question mark and the devices answering no;
   - one with a question mark and no devices listening;
   - for Codex, the same first input with `transcript_path` naming a 22 KB rollout head (the TUI's fixture).
   Report the median and maximum of each; each maximum must be under 1 s. Also report, from the isolated daemon over 20
   turn ends of a marked session, the time from the native turn-stop to its report and from the turn-stop to the
   `summary` frame, against today's 1.5 s. Before Part 5, a turn end ran no such hook.
4. **Linux:** `linux-e2e` above. The hooks are the same POSIX scripts as on macOS, so no real-CLI run is needed there.
5. **Windows:** `windows-e2e` x64 above, plus **one hand check on the Dell x64 Windows test PC** (decision 15; a
   tester; Windows 11 x64; before the merge, on the final head's bundle). The tester follows the repo's guide,
   `cli/scripts/windows-dial-e2e/README.md`: the desk and CLI built on the Mac with
   `node scripts/windows-dial-e2e/bundle.mjs <out>`, a stand-in dial, and Harness's folders in a check folder of the
   profile. The Dell rules hold:
   - the testers act on their own, and any temporary change they make (remote desktop and the like) is theirs to undo;
   - throwaway profile folders: Claude Code and Codex homes, Harness's data folder and its own port, all inside the
     check folder, never the PC's everyday ones;
   - the stub on `127.0.0.1` with dummy keys; no real account, no sign-in, no backend;
   - no reboot and no change to Smart App Control;
   - everything restored afterwards: the check folder removed, every process it started stopped, every setting put
     back.
   Seen:
   - Claude Code in Git Bash, and Claude Code with no Git Bash (the PowerShell form): one block and one `question`
     frame, no `summary` before it, with the hook's time and the nudge's round trip over the pipe recorded;
   - Codex through PowerShell: the same, with its time;
   - for each, `[device] nudge · <engine> · yes` once in the isolated daemon's log, and the second Stop not blocked;
   - decision 18's measure, for each form over 10 turn ends of a marked session with no question: the time from the
     native turn-stop to the hook's report, and whether a `summary` was told before the report. The times come from
     wrappers in the check folder's scratch settings that stamp each hook's arrival, as Task 1 did; the `summary`
     frames from the stand-in dial. Also the session's first stop: whether its report beat the grace.
   The record gives the times and counts, no answer text and no user or machine name.

6. **The eval** (Task 4) is Claude Code's end-to-end measurement: (b) v6 against v1 (run; reported, not a gate), then
   (a) v5 against v4, the gate. It runs
   locally on this Mac, with no workflow, and **needs the user's own Claude Code sign-in** through the session profile.
   It does not run before GO, and passes `--spend-cap-usd 270`. Its isolation
   is the eval's own (its README): a temporary repo per run, the fake `harness`, the curated `PATH`,
   `--setting-sources project`, Claude's sandbox, and no backend.
7. **The person's own eye, after the release** (needs the user: their own login, their dial). In a fresh session, a
   long turn ends on a question while the person is in another app: one extra round, one ring, and no done ring before
   it. A question asked back in a live exchange gives no block and no ring.
8. **The counts reach the report** (Task 17's `dialUsage.e2e.ts` case, on `linux-e2e`; by hand from the branch with
   Actions → "CLI end to end" when a rerun is wanted, or on the Mac with `cd cli && npx vitest run --config
   vitest.e2e.config.ts e2e/dialUsage.e2e.ts`). Isolation is the suite's own: `IsolatedDaemon`'s throwaway home, data
   folder, homes, port and tmux server, never the everyday daemon on 18473; the in-memory `FakeBackend` with a
   made-up machine and token (no account, no production); a fake dial and fake Claude Code. A person sees the case
   pass, and the usage file and every report hold `dial_nudge_claude` and `dial_nudge_claude_rang` at 1, names and
   numbers only. Ingest to review is Task 16's unit tests on CI; no production read. Task 14's daemon is signed out, so
   its file holds no counts and it gains no assertion.

**Proposal, not built here:** Part 7's proposed scheduled check of the newest Codex release, and a Claude Code
counterpart, against the stub. Both would confirm that a plugin `Stop` hook still gets `last_assistant_message` and
`stop_hook_active`, and that the block still goes on as F1 and F3 found. Then a CLI release that changes either is seen
before a turn is stopped twice or never. No such workflow exists.
