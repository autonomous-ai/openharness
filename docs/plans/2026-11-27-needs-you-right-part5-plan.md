# Needs you, right, Part 5: a second look when a turn stops

> **For agentic workers:** REQUIRED SUB-SKILL: devcrew phase 3 implements this plan task by task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** a Claude Code or Codex turn that ends on a question to the person, while a dial is attached, the person is
away from that agent and the agent rang nothing, is stopped once and asked to decide: ring the dial with `harness device
notify`, or end. The turn's first end is never announced as done. Nothing else about how a turn ends changes.

**Architecture:** the Harness Device plugin gains a `Stop` hook for Claude Code (`hooks/hooks.json`) and for Codex
(`hooks/codex.json`). It runs `harness device claude stop` or `harness device codex stop` (`cli/src/deviceClaude/stop.ts`).
That command reads the hook's input in its own process. It ends at once when `stop_hook_active` is set, when there is no
`last_assistant_message`, or when that message's last 400 characters hold no `?` or `？`. Otherwise it asks the devices'
listener one new message, `nudge` (engine and session id), and waits at most 300 ms. On `{ "nudge": true }` it prints
Claude Code's and Codex's block (`{"decision":"block","reason":…}`). The devices answer yes only when a dial is attached,
no notice of that agent is pending, the person is not present (Part 2's `present`), and the agent was not nudged
already. A yes also tells the observed source (`cable/hosts/observed.ts`) that this outside agent's stop goes on. The
source then holds that agent's turn end until its next stop, or until the session has been quiet for 10 s since its last
activity, and at most 120 s from the yes; when the hold expires, the turn end is announced. A Harness agent's first end is already left
unannounced by its reader (`stopHookContinuation`) and `DONE_QUIET_MS`. The eval measures the hook first, as a variant
the fake `harness` answers, against the same text without it. The product is built only if the variant ships. The core,
`cli/hook/notify.mjs`, `core/observedHook.ts`, the backend and the firmware do not change.

**Tech Stack:** TypeScript (Node 24), Vitest (unit, `cli/e2e`, the eval's own config), POSIX sh and Windows PowerShell
for the hooks, Claude Code 2.1.332 and Codex 0.172.0 for the spike and the hand checks, `claude -p` for the eval.

**Spec:** [docs/plans/2026-11-26-needs-you-right-design.md](2026-11-26-needs-you-right-design.md), section "Part 5. A
second look when a turn stops", with Part 1 ("Hooks in a variant", "Targets and gates", "Cost"), Part 2 (`present`),
Part 4 ("Round 2", the gate), Part 7 (the Codex manifest and its trust write), "Design", "Release order", "Platforms",
"Tests (red first)", "Docs in the same pull requests" and "Decided by the maintainer". The approved text is the copy Part
4's branch (`feat/needs-you-right-start-line`) carries. Its Part 5 section is byte-identical to the approved spec the
orchestrator holds. References: [Part 4's plan](2026-11-27-needs-you-right-part4-plan.md) (on that branch; the eval's
mechanics and the session-start command this plan reuses) and [Part 7's plan](2026-11-26-needs-you-right-part7-plan.md)
(the Codex plugin, its trust, the spike recipe).

## Decisions that bind this plan

1. **Gates.** Nothing is built or measured before **G0**. G0 means Part 4's round 2 is read and the PM opens Part 5: the
   held-out `crowd` recall of the text that ships is under 90%, or no line ships and v1's 41 of 48 stands (the spec). If
   Part 4 ships with held-out `crowd` recall at 90% or more, Part 5 stops and this plan is not run.
   **G1** means Part 4's pull request is merged into `main` and this branch is rebased onto it. Part 4's PR merges with
   or without its product part. G1 comes first because Part 4 edits the same plugin files, `command.ts`, the eval's
   harness and the spec. **GO** means the PM says go for Task 4's spend. **V** means Task 4's verdict is that the hook
   ships.
   **G0 is not open yet** (2026-11-27). If it opens, Part 5's eval would pass the $250 spend cap by about $40. The PM
   then asks the maintainer to raise the cap, with the numbers, before GO. GO is not given until the maintainer has set
   a cap that covers Task 4's spend plan.
2. **Eval first, then the product** (spec, Part 1: "Parts 4 and 5 are measured this way before any product code"; the
   PM's decision, 2026-11-27). Tasks 2-5 measure the hook through the fake `harness`. Tasks 6-15 start only after V. If
   the variant does not ship, the pull request carries Tasks 2-5 alone. No product code exists then, so nothing has to
   be cut.
3. **The core does not change.** No file joins `architecture.coreFiles.txt`. No request joins `core/api.ts`.
   `cli/hook/notify.mjs` and `core/observedHook.ts` stay as they are. `nudge` reaches only the devices' own listener.
   The hold lives in the devices process (`cable/hosts/observed.ts`, `services/devices.ts`). The one engine reader that
   may change is Codex's (`engines/codex/normalizer.ts`, Task 13). It runs in the engine-codex process and is not one of
   the core's files.
4. **"The skill is on" is read in the hook's own process.** It uses the rule Part 4's `start` uses: Claude Code needs
   `pluginActs(dataDir) && ownSkillIn(claudeHome())`; Codex needs not removed, `codexPluginState(codexHome) === 'on'`
   and `ownSkillIn(codexHome)`. Only the hook knows its session's home, so the devices check the other four conditions.
5. **Once.** Claude Code's `stop_hook_active` ends the second look. The devices also refuse a second yes for an agent
   they nudged until the person's next prompt to it, the agent leaving, or 10 minutes (Task 9). This holds even for an
   engine or version that does not set `stop_hook_active` on the continuation.
6. **Harness's own one-shots get no look.** The rule is Part 4's decision 13: a hook input whose `cwd` is the data
   folder or inside it (`within`).
7. **No new count, file or backend change.** The spec's Design says "Nothing else is stored, synced or exposed". A
   `[device] nudge` engine tally in the log, in fixed words, is the local measure. The field effect is read from #4642's
   notice counts per engine.
8. **Platforms:** macOS, Linux, Windows. The hooks use the plugin's two-shell form (POSIX sh, Git Bash, PowerShell).

The PM's decisions on the draft's open questions (2026-11-27):

9. **What the variant is paired with.** The variant is the text that would ship plus the Stop hook, paired against that
   same text without it: v1 if Part 4's line does not ship, v4 if it does (Tasks 3 and 4). Part 5's gate is read on
   that pair.
10. **Part 5's ship rule is Part 4's** (its decisions 9 and 10), paired against decision 9's base. Held-out recall must
    rise beyond noise in `crowd` or `name-only` and fall beyond noise in no condition. The 54 pooled held-out no-need
    runs (`crowd` 3 reps, `clean` 2, `name-only` 1) may hold at most 2 needless rings. `harmed` and `went_on` may be no
    worse beyond noise. The extra rounds (`nudged`) and the cost per run are reported, not gated (Task 4).
11. **Order:** eval first, product only after the verdict (decision 2).
12. **The hold, changed from the spec.** After a yes, the devices hold the outside agent's turn end until its next
    stop, or until the session has been quiet for `CONTINUE_QUIET_MS = 10_000` since its last activity, and at most
    `CONTINUE_MAX_MS = 120_000` from the yes. When the hold expires, the held turn end is announced (Task 7). The spec's
    flat 10 s from the yes is not built. **Activity** is what the observed source already sees of a session, and
    nothing new:
    - any hook event `ObservedSource.ingest` takes for that entry (it sets `agent.lastActivityAt`; outside a pane these
      are the native hook's events, such as `subagent-start` and `subagent-stop`, since no tool events reach Harness);
    - the session's transcript growing: `deps.fileStamp(entry.transcriptPath).mtime` (`lib/sessionSearch/externals/support.ts`
      `fileStamp`, which `checkWorking` already reads), later than the last activity counted. That is Claude Code's
      transcript, or Codex's rollout.
    The last activity starts at the yes. A transcript that cannot be read (`fileStamp` null) shows no activity.
13. **A Harness agent reads "not present"** from the yes until its continuation ends (Task 9).
14. **No second look for headless runs** (`claude -p`, `codex exec`; Task 10). If Task 1 finds no sign of `codex exec`
    (F8), Task 1 stops and reports, and Codex's side waits for the main session.
15. **Windows by hand:** one hand check on the Dell x64 Windows test PC with throwaway profile folders, under the Dell
    rules: the testers act on their own, no reboot, no change to Smart App Control, no real accounts, and everything
    restored afterwards (Verification 5).

## Facts the spike must settle (Task 1)

These come from a read of the code and of the two installed binaries (`strings`, nothing run). Task 1 confirms each one
with the real CLI and reports yes or no with the evidence. Then the main session has this plan updated before Tasks 7,
10, 12 and 13 start.

- **F1, Claude Code 2.1.332.** A plugin `Stop` hook's input holds `stop_hook_active` and `last_assistant_message`; the
  binary's schema says "Text content of the last assistant message before stopping". `{"decision":"block","reason":…}`
  on stdout, exit 0, continues the same turn with no `UserPromptSubmit`. The transcript gets an `isMeta` user line and a
  `hook_blocking_error` attachment (`engines/claude/normalize.ts` `stopHookContinuation` reads it). The continuation's
  Stop has `stop_hook_active: true`. `claude -p` honors the block when the hook comes from project settings (the eval's
  case). The record also states the value of `CLAUDE_CODE_ENTRYPOINT` in a hook under the TUI and under `-p`.
- **F2, Codex 0.172.0.** A plugin `Stop` hook's input holds `stop_hook_active` and `last_assistant_message`; the binary
  has both strings. The record states which stdout blocks (the same JSON is expected).
- **F3, Codex's continuation.** Does it go on in the same turn, with no `task_complete` between, or start a new turn? The
  binary has a `hook_prompt` item type (`HookPromptItem`, `HookPromptXml`).
- **F4.** Does `UserPromptSubmit` fire for Codex's hook prompt? If it does, Harness's native hook tells the devices of a
  `turn-start` that reads as the person's prompt.
- **F5.** What the rollout records for the hook prompt (record type and shape), and what Harness's Codex reader
  (`engines/codex/normalizer.ts`) makes of it in a pane. It might open a turn whose `userMessage` is the reason, or
  ignore it while the turn stays open.
- **F6.** Does the continuation's Stop in Codex have `stop_hook_active: true`?
- **F7.** `codex app-server` `hooks/list` shows the plugin's `Stop` hook `trusted` once Part 7's trust write ran. Its key
  is `harness-device@openharness:hooks/codex.json:stop:0:0`, hashed with no matcher.
- **F8.** How `codex exec` shows itself to a Stop hook: an input field, an environment variable, or the rollout's
  `session_meta` `source`.
- **F9, timing on this Mac.** For each engine: from the end of the answer to the plugin hook's exit, the native
  `notify.mjs` Stop and the plugin's hook run side by side. The record gives which one reaches the daemon first, over 10
  runs.
- **F10, activity in a continuation (decision 12).** For each engine, the longest gap between two writes to the
  transcript (Claude Code) or rollout (Codex) from the block to the next Stop, over the same 10 runs. The stub's second
  answer runs one Bash tool call, so the gap includes a tool's run. It says how often a real continuation would sit
  quiet past 10 s.

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
  `core.agents.advertised()`, else an outside row, else `observedAgentId`. `Notices.pending(agentId)` says whether a
  card is pending. `present(agentId)` is Part 2's rule. `cable.isConnected` says whether a dial is attached.
- **The listener.** `services/devicesListener.ts` handlers are typed `ListenerHandler { maxBytes, perSecond, handle }`.
  `noticeHandler` is the model: it validates, hands on typed fields, keeps nothing and logs nothing.
  `devices/listenerClient.ts` `askDevices` returns the answer's object, a status number, or null.
- **The eval.** `cli/evals/dial-skill/lib/stage.ts` `fakeHarness` answers a call whose argv matches exactly, with fixed
  output, and records every call in `rec/calls.jsonl`. A variant's `hooks.json` and `harness-answers.json` are staged
  as the repo's `.claude/settings.json` and are refused unless `_state.json` `harness_paths` lists them
  (`run-eval.mjs` `variantHooks`). The fake cannot yet answer by its input.

## Global Constraints

- **The reason** is one line of printable ASCII, used word for word. The eval measures it in Task 4:
  `Your answer asks the person something, and they are not at this session. If the task cannot go on without them, run harness device notify now, as the dial skill says, and end your turn. If nothing is needed from them, end your turn.`
- **The block:** exactly `JSON.stringify({ decision: 'block', reason: DIAL_STOP_REASON })` and a newline, or nothing.
  Both engines get the same block unless F2 says otherwise.
- **The ask:** the last 400 characters, counted by code point, of `last_assistant_message` hold `?` (U+003F) or `？`
  (U+FF1F).
- **The command** (`harness device claude stop`, `harness device codex stop`) reads stdin whole with `hookInput`
  (asked.ts, at most 256 KiB). It takes `stop_hook_active`, `last_assistant_message`, `session_id` (held to
  `NOTICE_SESSION`) and `cwd`, and nothing else. Nothing of the message leaves its process: it is not sent, logged,
  printed or kept. It prints only the block and always exits 0. It stays out of `DEVICE_USAGE`.
- **The order of checks:** first the input's fields (`stop_hook_active`, the message, the session id), then the
  question mark in the tail, `cwd` (decision 6) and a headless session (decision 14). Then "the skill is on"
  (decision 4), which reads files, and last the nudge. The command reads no file and asks nothing before the cheap
  checks pass.
- **`nudge`:** `{ type: 'nudge', engine: 'claude' | 'codex', sessionId }`, answered `{ nudge: boolean }`.
  `NUDGE_ANSWER_MS = 300` bounds the request and its answer (`askDevices` `timeoutMs`). No answer, any status, or any
  other body means no. `NUDGE_MAX_BYTES = 256` and `NUDGE_PER_SECOND = 1`. The handler keeps nothing and logs nothing.
- **The hold:** until the next stop, or `CONTINUE_QUIET_MS = 10_000` with no activity (decision 12), and at most
  `CONTINUE_MAX_MS = 120_000` from the yes. The held turn end is announced when the hold expires with no next stop.
- **The hook:** event `Stop`, no matcher, `timeout: 5`, `onFailure: 'continue'`, in the plugin's two-shell form. stdin
  reaches the launcher as the engine wrote it. The PowerShell form never reads or re-pipes stdin. stdout passes only
  when it starts with `{"decision":"block","reason":`. stderr is dropped and the exit is always 0.
- **Codex trust:** key `harness-device@openharness:hooks/codex.json:stop:0:0`, written by Part 7's unchanged
  `pluginTrustRecords` (`REVIEWED.events` labels `Stop` `stop`, and its matcher is not hashed).
- **Logs:** fixed words only (`src/architecture.failureLogs.spec.ts`): `[device] nudge · <engine> · yes|no dial|notice|present|nudged`.
  Never a session, a path, an answer or a reason.
- **Unchanged:** `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, `core/api.ts`, `cli/hook/notify.mjs`,
  `lib/agentNotifications.ts`, `engines/claude/normalize.ts`, `devices/codexPluginTrust.ts`, `DIAL_SKILL` and
  `DIAL_SKILL_DESCRIPTION`, the backend, the firmware, Desktop.
- **Eval:** every invocation of Task 4 passes `--spend-cap-usd <cap>`, `--concurrency 3` at most and `--timeout-s 900`.
  The cap is 250 today; only the maintainer raises it (decision 1), and Task 4 uses the cap the maintainer set. On exit 3
  or 4, stop and report the spend. Never raise the cap yourself, switch accounts or work around a limit.
  `CLAUDE_CONFIG_DIR` is the session's profile, never `~/.claude`. No transcript text, judge reason, path or user name
  goes into any commit, `change.md`, narrative, README or pull request. Nothing CPU-heavy runs on the Mac.
- **Red, then green:** a behavior task commits its failing test first, then the change. Run only the named specs (the
  suites run on CI). No fixed sleeps: absence is shown against a later positive anchor. Commit only the files a task
  names. Comments say why. Docs are in English. Names follow `docs/naming-system.md`. One pull request.

## Design (docs/feature-design-rules.md)

Nothing is stored or synced. A new local message is exposed, so here are its nine lines.

1. **Growth.** In memory only. One hold per observed entry: a timer, a word and two times (the yes, the last activity), within the source's 50
   sessions. At
   most 64 nudged agents (Task 9), dropped at the person's next prompt, when the agent leaves, or after 10 minutes. No
   file, row or count.
2. **Concurrency.** One Stop event runs Harness's native hook and the plugin's hook side by side, so the blocked stop's
   `turn-stop` and the nudge can reach the devices in either order. Task 7 handles both orders. The devices process is
   single-threaded, and `nudge` is answered inside `part.call`.
3. **Read cost.** The hook spawns the CLI at every turn end where the plugin is on. The CLI asks the listener only when
   the tail holds a question mark. The devices answer from what they hold, with no read. Verification 3 gives the
   hook's time. A hold reads its transcript's `fileStamp` (one `stat`) only when it would go quiet, so at most once
   per 10 s per held session, and never past 120 s.
4. **Scale.** One nudge per question-ending turn. `NUDGE_PER_SECOND` per connection and the listener's 16 connections
   bound a loop.
5. **Compatibility.** A devices process older than the CLI answers `nudge` with a status, which reads as no. An older
   CLI under the new plugin prints its usage, which the hook's prefix check drops. An engine whose Stop input has no
   `last_assistant_message` is never stopped.
6. **Migration and rollback.** None. Rolling the CLI back removes the hook with the carried plugin at the next setup
   pass.
7. **Audience.** The answer's last 400 characters are read in the hook's process alone. `nudge` carries an engine and a
   session id over this account's own socket or proven pipe. Its yes or no tells a local process of this account
   whether a dial would ring for that agent.
8. **Identity.** N/A. Local only, this account.
9. **Failure.** No answer within 300 ms is a no. Any failure prints nothing, and the turn ends as it would without
   Harness. A block that never takes effect (the hook timed out) leaves a held turn end, announced once the session has been
   quiet for 10 s, or at 120 s from the yes. A transcript that cannot be read shows no activity, so the hold goes quiet.

## Open questions (for the main session)

None open. The PM answered the draft's seven on 2026-11-27 (decisions 9-15).

## Review Focus

1. **The blocked stop's `turn-stop` and the nudge arrive in either order** (the two Stop hooks run side by side).
   Expected: the blocked stop's end is never told before the notice, in both orders. Pinned in Task 7 (`'the yes before
   the blocked stop'`, `'the yes after it, inside the grace'`) and Task 14 (case 7).
2. **A `?` the person would not call a question:** code in the answer's tail (`a?.b`, a URL query, a regex). Expected:
   at most one extra round, after which the agent ends, and never a second block. Pinned in Task 10 (a tail of
   `user?.name` asks, which states the bound), Task 9 (a second nudge is no) and Task 4 (`nudged` on the no-need runs).
3. **An answer in a non-Latin script on Windows PowerShell:** a re-encoded stdin would turn letters into `?`. Expected:
   PowerShell never reads stdin, and the launcher reads the engine's bytes. Pinned in Tasks 11 and 12 (the Windows form
   has no `[Console]::In` and no pipe into the launcher, and a win32 runner with a Vietnamese answer and no `?` prints
   nothing) and Task 10 (`Đã xong, không cần gì thêm.` does not ask; `要用哪个数据库？` asks).
4. **An older or foreign launcher under the new plugin**, printing its usage or another hook's JSON on stdout.
   Expected: Claude Code and Codex read nothing, because stdout passes only with the block's prefix. Pinned in Tasks 11
   and 12 (`'prints nothing but the block'`).
5. **The block never takes effect** (the hook timed out, or the engine dropped its output). The devices said yes and
   hold the end, but no next stop comes. Expected: the turn end is told once, when the hold expires (10 s of quiet, or
   120 s from the yes). Pinned in Task 7 (`'no next stop, quiet: told once 10 s after the last activity'`, `'the 120 s
   cap'`) and Task 14 (case 6).

Stated limits for the pull request:
- On Windows, Claude Code without Git Bash runs the hook in PowerShell, which takes 2-3.5 s. A Harness agent's first
  end can then be told before its continuation, past `DONE_QUIET_MS`, and an outside agent's nudge can come after its
  grace.
- The hook spawns the CLI at every turn end (Verification 3 gives the numbers).
- A `?` inside code in the tail costs one round.
- A continuation that writes nothing to its transcript for 10 s (one long model call with no tool) is announced done
  before its next stop, and one that runs past 120 s is announced at 120 s. Task 1's F10 gives the gaps measured.
- The eval runs Claude Code alone. Codex is judged by the field counts.

---

## Before V (after G0; Tasks 2-5 after G1)

### Task 1: the spike, both engines' blocked stop against a local stub

**Effort:** high. **Depends on:** G0. **Test that must fail first:** none (it measures and changes no repository file).

**Files:** none in the repository. Scratch only, in the session's scratchpad: the stubs, a throwaway hook script that
logs its stdin (keys and lengths only; message text is written only to the scratch record), the records, and the
report.

- [ ] **Step 1: Isolate.** Use one scratch root with its own `HOME`, `CLAUDE_CONFIG_DIR=$HOME/.claude` and
  `CODEX_HOME=$HOME/.codex`. Use a dummy `ANTHROPIC_API_KEY` and `STUB_KEY`, and `DISABLE_AUTOUPDATER=1` and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Run everything under `env -i` with a curated `PATH` (Node, `claude`,
  `codex`, `/usr/bin`, `/bin`). Never use the tester's `~/.claude`, `~/.codex`, `~/.harness`, everyday daemon (port
  18473), login, or any backend.
  - The Anthropic stub answers `/v1/messages` streamed on `127.0.0.1`, as Part 4's Verification 1 does. The first
    answer ends `Which database should the export use?`. Once the request holds the hook's reason, it answers `Done
    deciding.`.
  - The Codex stub is Part 7's (`[model_providers.stub]`, `wire_api = "responses"`), with the same two answers.
  - Each stub records every request body.
- [ ] **Step 2: Claude Code (F1, F9).** Load a plugin folder holding a `Stop` hook that runs the throwaway script, with
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
  Record which of the two Stop hooks reaches the daemon first, and the times from the answer's end to each hook's exit,
  over 10 runs. Over the same runs, record the transcript's mtime at each write from the block to the next Stop, and
  report the longest gap (F10).
- [ ] **Step 3: Codex (F2-F8).** In the isolated `CODEX_HOME`, use a scratch copy of `plugins/harness-device` whose
  `codex.json` gains the same `Stop` hook. Install it through `codex plugin` and trust it as Part 7's spike did. Run the
  TUI in the private tmux server. Record:
  - the Stop input's keys;
  - the block form Codex honors;
  - the rollout lines after the first answer (whether a `task_complete` comes between, and the hook prompt's record);
  - whether `UserPromptSubmit` ran for the hook prompt;
  - the second Stop's `stop_hook_active`;
  - `hooks/list` for the Stop hook's trust state and hash;
  - what a `codex exec` run gives a Stop hook that says it is headless;
  - over 10 runs, the longest gap between rollout writes from the block to the next Stop (F10).
  Then replay the recorded rollout through `engines/codex/normalizer.ts` (`npx tsx` from `cli/`, a scratch script) and
  record the live events it makes (F5).
- [ ] **Step 4: Report** F1-F10 to the main session, each yes or no with its evidence: counts, keys, record types and
  times, with no answer text. Keep the scratch records. Tasks 10 and 13 copy their fixtures from them (records Codex
  and Claude Code wrote against the stub, nothing of a person). If Claude Code does not honor the block from a plugin,
  or Codex has no `last_assistant_message`, stop. That engine's side is then not built, and the main session decides.
  The same holds when F8 finds no sign of `codex exec` (decision 14).

### Task 2: the eval answers a Stop hook by its input, and counts the nudges

**Effort:** high. **Depends on:** G1. It changes files under `_state.json` `harness_paths`, so Task 4's first pass
asks for `--approve-harness`.

**Files:**
- Modify: `cli/evals/dial-skill/lib/stage.ts` (`HarnessAnswer.stop`, `fakeHarness`, `Ring.blocked`, `readRings`)
- Modify: `cli/evals/dial-skill/run-eval.mjs` (`isAnswer` takes `stop: true`)
- Modify: `cli/evals/dial-skill/lib/grade.ts` (`nudged`)
- Modify: `cli/evals/dial-skill/lib/summarize.ts` (the aggregate and held-out tables gain `nudged`)
- Modify: `cli/evals/dial-skill/README.md` ("Hooks in a variant": the Stop answer)
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
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts
  evals/dial-skill/stage.spec.ts evals/dial-skill/run-eval.spec.ts evals/dial-skill/grade.spec.ts
  evals/dial-skill/summarize.spec.ts`. Expected: FAIL (no `stop` answer, no `nudged`).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.**
  - The fake runs under plain node and cannot load the CLI's code, so it applies the rules itself. Its comment says why
    and names the shared table that holds it to the product (Task 10).
  - The fake reads its stdin only for a `stop` answer.
  - README: one paragraph under "Hooks in a variant". It covers the `stop` answer, the eval's world (a dial is always
    attached, the person is always away, the skill is on, "a notice pending" means a ring already recorded in the run),
    and `nudged`, the one extra model round a block costs.
  - metrics.md: the `nudged` row, then `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow`.
- [ ] **Step 5: Run the eval's whole suite.** `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts`.
  Expected: PASS. `git diff --stat -- evals/dial-skill/flow` lists `metrics.md` and `narrative.md` alone, and only for
  the new column.
- [ ] **Step 6: Commit.**

### Task 3: the variant, `flow/v5`

**Effort:** medium. **Depends on:** Task 2.

**Files:**
- Create: `cli/evals/dial-skill/flow/v5/SKILL.before.md` and `SKILL.md` (both the base round's `SKILL.md` byte for
  byte; decision 9: `flow/v1/` if Part 4's line did not ship, `flow/v4/` if it did)
- Create: `cli/evals/dial-skill/flow/v5/hooks.json`. It holds the base round's `hooks.json` when it has one (v4's
  `SessionStart`), plus
  `"Stop": [{ "hooks": [{ "type": "command", "command": "harness device claude stop", "timeout": 5 }] }]`.
- Create: `cli/evals/dial-skill/flow/v5/harness-answers.json`. It holds the base's answers, plus
  `{ "argv": ["device", "claude", "stop"], "stdout": <the block of the reason> + "\n", "stop": true }`, written with
  `npx tsx -e` from the Global Constraints' reason, never typed by hand.
- Modify: `cli/evals/dial-skill/flow/_state.json` (`harness_paths` gains the two files)
- Test: `cli/evals/dial-skill/state.spec.ts`

- [ ] **Step 1: Write the failing test** `'flow/v5 stages the Stop hook and answers it with the block of the plan's
  reason'`.
  - `variantHooks` of `flow/v5` gives a `Stop` hook running `harness device claude stop`, with timeout 5 and no
    matcher, and exactly one `stop` answer.
  - That answer's stdout parses to `{ decision: 'block', reason }`. The reason is one line of printable ASCII, has no
    `<` or `>`, and contains `harness device notify`.
  - v5's `SKILL.md` equals the base round's.
- [ ] **Step 2: Run it and see it fail.** `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts
  evals/dial-skill/state.spec.ts`. Expected: FAIL (`ENOENT`).
- [ ] **Step 3: Commit the red test.**
- [ ] **Step 4: Write the files** and list the two in `harness_paths`.
- [ ] **Step 5: Run.** The same command; then the existing `'lists every variant's hooks.json and harness-answers.json'`.
  Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 4: the eval pass, v5 against its base, val and test in every condition (NOT run before GO)

**Effort:** high. **Depends on:** Task 1 (F1: `claude -p` honors the block), Task 3, and **GO**, the PM's word to spend.
**Test that must fail first:** none (it measures). Its checks are the exit codes, the probes, `nudged`, `scrub` and the
eval's suite. **Needs the user's own Claude Code sign-in** through the session's profile in `CLAUDE_CONFIG_DIR`, as
Parts 3 and 4 did. Machine: this Mac.

**Files:**
- Create: `cli/evals/dial-skill/flow/v5/{change.md,results.jsonl,errors.jsonl,probes.jsonl,summary.json,table.md}`
  (`errors.jsonl` only if written)
- Modify: `cli/evals/dial-skill/flow/narrative.md` (`## Part 5`), `flow/metrics.md` (by `summarize`),
  `flow/_state.json`: `harness_sha` by `--approve-harness`, `current_round` 5, and `best` `{ round: 5, … }` only if the
  verdict ships.
- Git-ignored, kept on this Mac: `flow/v5/traces/`, `flow/v5/private.jsonl`

**Spend plan** (per-run costs from Part 4's passes: `crowd` $0.30, `clean` $0.23, `name-only` $0.29, a probe about
$0.2). A nudged run adds one model round, about a fifth of a run:

| Step | Runs | About |
|---|---|---|
| Spent before Part 5 (Parts 1 and 3, Part 4's two rounds) | | read from the status table at G0 |
| `crowd` val and test, 3 reps | 75 + 1 probe | $24.5 |
| `clean` val and test, 2 reps | 50 + 1 probe | $12.5 |
| `name-only` val and test, 1 rep | 25 + 1 probe | $8 |
| Part 5 | 150 + 3 probes | about $45 |
| Flow after the pass | | about $40 over the $250 cap by the PM's estimate (2026-11-27); GO waits for the maintainer's raise (decision 1) |

- [ ] **Step 1: Check the start.** From `cli/`:
  - `CLAUDE_CONFIG_DIR` is set and is not `~/.claude`;
  - `diff <(npx tsx -e 'import { DIAL_SKILL } from "./src/devices/dialSkill.ts"; process.stdout.write(DIAL_SKILL)') evals/dial-skill/flow/v5/SKILL.md`
    prints nothing;
  - `git status --short` prints nothing;
  - `_state.json` `best.round` is the base round (decision 9).
  Read the status table's last `spend` as S, and the cap the maintainer set as C (decision 1). If S + $46 > C, stop
  and report S and C; the PM then asks the maintainer again, with the numbers. `marker=$(mktemp)`.
- [ ] **Step 2: `crowd` at 3 reps.**
  `npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v5 --condition crowd --split val,test --reps 3 --concurrency 3 --timeout-s 900 --spend-cap-usd <C>`
  - Exit 2, "harness changed": review `git diff <harness_sha> -- <harness_paths>`. Expect only Task 2's `lib/stage.ts`,
    `lib/grade.ts`, `lib/summarize.ts` and `run-eval.mjs`, and Task 3's two files. If so, rerun with
    `--approve-harness`. For anything else, stop and report.
  - Exit 2 on a probe failure: stop and report the probe row.
  - Exit 1: rerun the same command, which runs only the failed cases.
  - Exit 3 or 4: stop and report the spend.
  - Expected: 75 rows, at least one with `nudged` 1, about $24.5. With no `nudged` row, stop: the hook never blocked
    under `claude -p`.
- [ ] **Step 3: `clean` and `name-only`:** the same command with `--condition clean --reps 2`, then
  `--condition name-only --reps 1`. Handle the exits as in Step 2. Expected: 50 and 25 rows, about $20.5 together.
- [ ] **Step 4:** `find -H "$CLAUDE_CONFIG_DIR"/ "$CLAUDE_CONFIG_DIR"/*/ -newer "$marker" | sort -u` lists only the
  startup files the README names. Then run `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow`.
- [ ] **Step 5: Read the numbers**, counts and scenario names only, from the held-out table for the base's rows and
  v5's in each condition:
  - recall, needless rings, `line_ok`, `ask_ok`, harmed, `went_on`, `one_step`, `loaded`;
  - `nudged` over need runs and over no-need runs;
  - v5's `recall vs best`;
  - truncated counts (a block's extra round can reach `--max-turns`);
  - the mean cost and latency per run against the base's;
  - needless rings and need misses by scenario, with each one's `nudged`.
- [ ] **Step 6: The verdict**, by decision 10's rule. v5 ships only when the gain, the specificity and the
  guardrails all hold. State each interval and the pooled count it rests on, and the extra rounds per run (`nudged`
  rate, and cost per run against the base's).
- [ ] **Step 7: Write** `flow/v5/change.md` (`# Part 5: <base> and a second look when a turn stops`; Evidence, Change,
  Result, numbers only) and the narrative's `## Part 5` with the same numbers. Set `_state.json` as in Files, then run
  summarize again.
- [ ] **Step 8: Make the rows fit to commit.** `npx tsx evals/dial-skill/flow-rows.ts scrub evals/dial-skill/flow`
  exits 0. Run `node evals/dial-skill/build-report-lite.mjs evals/dial-skill/flow`. `git status --short --
  evals/dial-skill/flow` shows only the files above. `grep -nE '^>|/Users/|~/|'"$(whoami)"` on `v5/change.md` and
  `narrative.md` prints nothing.
- [ ] **Step 9:** `npx vitest run --config evals/dial-skill/vitest.config.ts`. Expected: PASS.
- [ ] **Step 10: Commit** (`Dial skill eval: Part 5, a second look when a turn stops, on val and test in every
  condition`). The measurement is committed whatever the verdict.

**Report** (numbers only): the held-out rows of the base and v5, the verdict and what it rests on, the extra rounds per
run, the spend per pass and in the flow, and Claude Code's version. Then: Tasks 6-15 if v5 ships; Task 5 and the pull
request of the eval alone if not.

### Task 5: results and the spec

**Effort:** medium. **Depends on:** Task 4. **Test that must fail first:** none (docs); one commit.

**Files:**
- Modify: `cli/evals/dial-skill/README.md`. Results gains a Part 5 block above Part 4's: the held-out counts of the
  base and v5 per condition, `nudged`, the verdict, and the spend. The Cost paragraph states the cap and what the flow
  spent.
- Modify: `cli/evals/dial-skill/flow/narrative.md`. The headline gives Part 5's result.
- Modify: `docs/plans/2026-11-26-needs-you-right-design.md`. Only a "Measured (<date>)" paragraph under Part 5's
  "Measured" bullet: the held-out numbers against the base, the intervals, the pooled specificity, the extra rounds,
  the verdict and the spend.

- [ ] **Step 1:** Write them, numbers only.
- [ ] **Step 2:** `grep -nE '^>|/Users/|~/|'"$(whoami)"` on the three files finds nothing new, and
  `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow` leaves the narrative's tables unchanged.
- [ ] **Step 3: Commit** (`Dial skill eval: Part 5's results`, or with `; the hook does not ship` when it does not).

## Gate V: Task 4's verdict ships

Tasks 6 to 15 run only after V. If V fails, they do not run. The pull request then carries Tasks 2-5, the eval alone.

## After V

### Task 6: `nudge` on the devices' listener

**Effort:** high (a local message any process of this account can send). **Depends on:** V.

**Files:**
- Modify: `cli/src/services/devicesListener.ts` (`nudgeHandler` and its bounds; the header comment's list of messages)
- Test: `cli/src/services/devicesListener.spec.ts`

**Interfaces:**
- Produces: `export const NUDGE_PER_SECOND = 1`; `export const NUDGE_MAX_BYTES = 256`;
  `export interface NudgeAsk { engine: 'claude' | 'codex'; sessionId: string }`;
  `export function nudgeHandler(nudge: (ask: NudgeAsk) => boolean): ListenerHandler`. It answers `{ nudge: <boolean> }`
  and refuses anything else.

- [ ] **Step 1: Write the failing tests** in `describe('nudge')`.
  - Refused: no engine, `engine: 'cursor'`, a number engine, no `sessionId`, one with `/`, 129 characters, and an empty
    one.
  - Answered: `{ type: 'nudge', engine: 'codex', sessionId: 's-1' }` hands on exactly `{ engine: 'codex', sessionId:
    's-1' }` (`toStrictEqual`; an extra field of the message is not handed on). The answer is `{ nudge: true }` or
    `{ nudge: false }` as the function says.
  - The bounds are `[NUDGE_MAX_BYTES, NUDGE_PER_SECOND]` = `[256, 1]`.
  - Over a real socket listener, as the spec's `'who may connect'` cases open one: `askDevices` with a nudge gets
    `{ nudge: true }`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/services/devicesListener.spec.ts`.
  Expected: FAIL (no export).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** as `noticeHandler` is built, with its validation (`NOTICE_SESSION`, the two engines). The
  comment says it keeps nothing and logs nothing, since the id names a person's session.
- [ ] **Step 5: Run them and see them pass.** The same command. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 7: the observed source holds a stop that goes on

**Effort:** xhigh (two hooks of one event arrive in either order; timers). **Depends on:** Task 1 (F3, F4), V.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`CONTINUE_QUIET_MS`, `CONTINUE_MAX_MS`, `ObservedSource.continues`,
  `Entry.continuing`, the hold's timer, the `turn-stop` case, `dropStop`, `remove`, and the `'continued'`
  `PromptSource` only if F4)
- Test: `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Produces: `export const CONTINUE_QUIET_MS = 10_000`, `export const CONTINUE_MAX_MS = 120_000` and
  `continues(agentId: string): boolean`. It is true when the agent is listed, live and of engine `claude` or `codex`;
  false changes nothing. On true:
  - the entry's held stop, if any, is cleared, and `entry.continuing` becomes
    `{ phase: 'heard' | 'awaited', since: <now>, lastActive: <now> }`: `'heard'` if a stop was held, else `'awaited'`;
  - `entry.heldStop` becomes the hold's one timer, due at `min(lastActive + CONTINUE_QUIET_MS, since + CONTINUE_MAX_MS)`.
    It stays set for the hold's whole life, the stamp read included, so `checkWorking`'s `ownerEnds` and every turn
    event see a held stop as today.
  - **Activity** is decision 12's: `entry.agent.lastActivityAt` (set by every hook `ingest` takes for the entry) and
    `deps.fileStamp(entry.transcriptPath)?.mtime`. A null stamp, or no transcript, is no activity.
  - When the timer fires before `since + CONTINUE_MAX_MS`, the hold reads the stamp once. `lastActive` becomes the
    latest of itself, `agent.lastActivityAt` and the mtime. If that is under `CONTINUE_QUIET_MS` ago, the timer is set
    again for the new due time; else the hold expires. At `since + CONTINUE_MAX_MS` it expires with no read. After the
    read's `await`, a hold that is no longer the entry's (a stop, an event, a removal) changes nothing.
  - Expiry while `'heard'`: `finish` runs, so the held turn end is announced, with its answer. Expiry while
    `'awaited'`: the hold ends and nothing is told.
  - A `turn-stop` while `'awaited'` becomes `'heard'` and keeps the hold (the blocked stop's own).
  - A `turn-stop` while `'heard'` ends the hold and takes the normal grace (the next stop).
  - A `turn-start`, `needs-input`, `turn-error`, `turn-aborted` or `session-end` ends the hold, as each drops a held
    stop today.
  - A second `continues` while one holds changes nothing: neither `since` nor `lastActive` moves.
  - Only if F4 says yes: the first `turn-start` of a Codex entry while it holds returns `'continued'` and ends the hold.
    `PromptSource` gains `'continued'`.

- [ ] **Step 1: Write the failing tests** in `describe('a stop that goes on (Part 5)')`. Use a fake clock
  (`vi.useFakeTimers()`, `deps.now` read from it) and the spec's fake `fileStamp`, whose mtime the test moves, and a
  listed Claude Code session with a transcript (as the spec's other turn tests set one up). No fixed sleeps: each check
  advances the fake clock and flushes the stamp read.
  - `'the yes after the blocked stop, inside the grace: nothing told at 1.5 s or 9.9 s; the next stop is told done once,
    1.5 s after it, with its answer'`.
  - `'the yes before the blocked stop: that stop is held; the next one is told done once'`.
  - `'a continuation longer than 10 s that keeps showing activity is still held, and is announced at its next stop'`.
    The transcript's mtime moves at 6 s, 14 s, 22 s and 30 s after the yes. Nothing is told at 10 s, 20 s, 30 s or 38 s.
    The next stop comes at 38 s and is told done once, 1.5 s after it, with its answer. Red against the spec's flat
    10 s hold.
  - `'a hook for the session counts as activity'`: a `subagent-start` and its `subagent-stop` at 8 s, the transcript
    untouched. Nothing told at 17.9 s; told once at 18 s.
  - `'no next stop, quiet: told once 10 s after the last activity'`: the mtime moves at 4 s, then never. Nothing at
    13.9 s; told once at 14 s, with its answer; nothing more at 30 s.
  - `'the 120 s cap'`: the mtime moves every 5 s and no next stop comes. Nothing at 119.9 s; told once at 120 s from the
    yes. The mtime moving after that tells nothing more.
  - `'an unreadable transcript shows no activity'`: `fileStamp` gives null; told once at 10 s.
  - `'a stop while the stamp is being read'`: the stamp's promise is held open at 10 s, the next `turn-stop` comes,
    then the promise resolves with an old mtime. Told once, 1.5 s after the stop, never at the read.
  - The `'awaited'` twin: `'no stop at all, quiet for 10 s: nothing told, and the turn still works'`; and with the mtime
    moving every 5 s, nothing told at 120 s either.
  - `'a prompt during the hold: nothing told for the held stop; the turn works'`. The same for `needs-input`,
    `turn-error` (told as an error), `session-end` (idle) and `turn-aborted`.
  - `'continues for an agent no hook listed, an ended session, or another engine is false and changes nothing'`.
  - `'a second continues keeps the first deadline'`: a second yes at 100 s; told at 120 s from the first.
  - `'checkWorking leaves a held turn alone'`: the owner reads idle inside the hold, the stamp read pending included,
    and nothing is told before the hold expires.
  - `'a lead with subagents running: the stop is not held by the yes, as today'`.
  - Only if F4: `'Codex: the hook prompt's turn-start inside the hold is continued, not the person's'`. After the hold
    a turn-start is `person` again.
  - For each case, `this.deps.log` holds no line with the session id.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected:
  FAIL (`continues` is not a function).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment on `continues` says why both orders occur: the engine runs Harness's native
  hook and the plugin's together, so their requests race. It also says why the hold reuses `heldStop`: `checkWorking`
  and every turn event already treat a held stop as the turn going on. The comment on the hold says why activity is
  the transcript and the hooks: outside a pane Harness hears no tool events, and the transcript grows with every
  step of a continuation (Task 1's F10). It also says why it is capped at 120 s: a continuation's turn end is told
  even when the transcript keeps growing with no stop.
- [ ] **Step 5: Run them and see them pass.** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts && npm run
  typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 8: the devices answer `nudge` and hold the turn end

**Effort:** xhigh (presence, notices and turn ends meet here). **Depends on:** Tasks 6 and 7.

**Files:**
- Modify: `cli/src/services/devices.ts` (the `nudge` handler in `listen`, `nudged`, the `[device] nudge` tally;
  `followPrompt` and `port.observed` for `'continued'` only if F4)
- Test: `cli/src/services/devices.spec.ts` (`fakeListener` gains `nudge`)

**Interfaces:**
- Consumes: Task 6's `nudgeHandler`; Task 7's `continues`; `noticeCaller`, `notices.pending`, `present`,
  `cable.isConnected`, `observedAgentId`.
- Produces, inside `startDevices`: `nudge: nudgeHandler((ask) => { let yes = false; part.call('notices', () => { yes =
  nudged(ask) }); return yes })`. `nudged` answers in this order and tallies each answer:
  - `no dial` when `!cable.isConnected`;
  - `notice` when `notices.pending(agentId)`;
  - `present` when `present(agentId)`;
  - else `yes`, after `observed?.continues(observedAgentId(engine, sessionId))`.
  `agentId` is `noticeCaller({ text: '', engine, sessionId }).agentId`. Task 9 adds `nudged` (the word) before `yes`.
  The tally is `createEngineTally('[device] nudge', ['claude', 'codex'], ['yes', 'no dial', 'notice', 'present',
  'nudged'], log)`.
- Only if F4: `port.observed` reads `'continued'` as not the person's (no `prompted`, `usage.turnStarted(…, false)`),
  and `followPrompt` logs `[device] prompt · skipped · continued`.

- [ ] **Step 1: Write the failing tests.**
  - The listener test's key list gains `'nudge'` after `'notice'`, with
    `expect(handlers.nudge).toMatchObject({ maxBytes: NUDGE_MAX_BYTES, perSecond: NUDGE_PER_SECOND })`.
  - In `describe('a second look when a turn stops (Part 5)')`, with the Part 2 helpers (`there`, `host().front`):
    - `'yes for an outside agent the person left: its blocked stop is told nothing, its notice rings, and its next stop
      ends silent under rule:notice'`. The agent was prompted 130 s ago. `listener.nudge(...)` is `{ nudge: true }`.
      Then `port.observed(hook('turn-stop'))`, 2 s, the notice (`shownAsks()` has it), and the next `turn-stop` and
      1.5 s. Expect one `summary` call, silent, and `[cable] notify · silent · rule:notice` in the logs.
    - `it.each` no: no dial (`{ nudge: false }`, `[device] nudge · claude · no dial`); a notice pending, shown and
      quiet (`· notice`); the person there (`there(port)`, `· present`); a Harness agent whose turn began 30 s ago with
      its tile on screen (`· present`).
    - `it.each` yes: a Harness agent past 120 s; an unknown session (not present by Part 2's rule); a Codex session.
    - `'the tally names no session'`: no log line holds `sess-1`.
    - Only if F4: `'a Codex turn-start inside the hold moves no dial and is not the person's prompt'`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL
  (no `nudge` handler).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The comment beside the handler names the spec's four conditions and says why "the skill is
  on" is the hook's to read (decision 4).
- [ ] **Step 5: Run them and see them pass.** `cd cli && npx vitest run src/services/devices.spec.ts && npm run
  typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 9: once an agent, and a Harness agent's presence through its continuation

**Effort:** xhigh. **Depends on:** Task 8.

**Files:**
- Modify: `cli/src/services/devices.ts` (`NUDGED_MAX = 64`, `NUDGE_ONCE_MS = 600_000`, the `nudged` map,
  `harnessPresent`, `dispatch`'s `processing` and `done`, `port.observed`'s `turn-start`, the agent leaving)
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Produces:
  - `const nudgedAgents = new Map<string, { at: number; phase: 'asked' | 'continuing' | 'over' }>()`, at most
    `NUDGED_MAX` entries, the oldest first out. A yes sets `{ at: monotonic(), phase: 'asked' }`.
  - A nudge for an agent in the map, younger than `NUDGE_ONCE_MS`, answers no as `nudged`.
  - An entry goes on: an outside agent's `turn-start` whose source is `person` or `dial`; the agent leaving; or age
    past `NUDGE_ONCE_MS`.
  - For a Harness agent (no outside row), a `processing` card while `'asked'` makes it `'continuing'`. Its `done`
    while `'continuing'` makes it `'over'`, after `rouse` is read.
  - `harnessPresent(agentId)` is false while the phase is `'asked'` or `'continuing'` (decision 13).

- [ ] **Step 1: Write the failing tests.**
  - `'a second nudge before the person's next prompt is no, as nudged; after their prompt, yes again'`.
  - `'after 10 minutes a nudge is yes again'`.
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

**Effort:** xhigh (reads the person's answer; decides a block). **Depends on:** Task 1 (F1, F2, F8), Task 3 (the guard
reads `flow/v5`), Task 2 (`stop-inputs.json`), V.

**Files:**
- Create: `cli/src/deviceClaude/stop.ts`
- Create: `cli/src/deviceClaude/stop.spec.ts`
- Modify: `cli/src/deviceClaude/command.ts` (`case 'stop'` for `claude` and `codex`; `DeviceDeps.ask?`; the header
  comment's list of the plugin's own words)
- Test: `cli/src/deviceClaude/command.spec.ts`
- Only if Part 4's product part was cut (its Task 10): modify `cli/src/deviceClaude/asked.ts` (export `hookInput`) and
  `cli/src/devices/dialSkill.ts` (export `ownSkill`), as Part 4's Task 1 did, and add `ownSkillIn` to `stop.ts`.

**Interfaces:**
- Consumes: `hookInput` (asked.ts), `ownSkillIn` (start.ts), `within`, `NOTICE_SESSION`, `askDevices`, `pluginActs`,
  `claudeHome()`, `readRemoved`, `codexPluginState`.
- Produces:
  - `export const DIAL_STOP_REASON` (the Global Constraints' text) and `export function stopOutput(): string` (one line,
    no newline).
  - `export const ASK_TAIL_CHARS = 400` and `export function endsOnAsk(message: string): boolean`.
  - `export const NUDGE_ANSWER_MS = 300`.
  - `export interface StopDeps { stdin: AsyncIterable<Buffer | string>; dataDir: string; engine: 'claude' | 'codex';
    headless(input: Record<string, unknown>): boolean; acts(): boolean; ask(message: { type: 'nudge'; engine: 'claude'
    | 'codex'; sessionId: string }): Promise<Record<string, unknown> | number | null>; out(line: string): void }`.
  - `export async function runStop(deps: StopDeps): Promise<0>`.
  - In `command.ts`, Claude:
    `case 'stop': return runStop({ stdin, dataDir, engine: 'claude', headless: () => /^sdk-/.test(deps.env.CLAUDE_CODE_ENTRYPOINT ?? ''), acts: () => pluginActs(deps.dataDir) && ownSkillIn(claudeHome()), ask: deps.ask ?? ((m) => askDevices(deps.dataDir, m, { timeoutMs: NUDGE_ANSWER_MS })), out })`.
    Codex: the same, with Part 4's Codex `acts` and F8's `headless` (decision 14: Task 1 stops when F8 finds no sign,
    so Codex's side is never built without one).

- [ ] **Step 1: Write the failing tests.**
  - `stop.spec.ts`:
    - `'the reason is the plan's, word for word, one line of printable ASCII with no < or >, naming harness device
      notify'`.
    - `'stopOutput is the block on one line'`: `JSON.parse` gives `{ decision: 'block', reason: DIAL_STOP_REASON }`.
    - `endsOnAsk` over every case of `cli/evals/dial-skill/test-data/stop-inputs.json` equals `asks` (the eval's fake
      reads the same file).
    - `runStop` prints `stopOutput()` once on `{ nudge: true }`, and the ask it sent is exactly `{ type: 'nudge',
      engine, sessionId }`. The message's words are absent from `JSON.stringify` of every ask.
    - It prints nothing and returns 0, without asking, for: `stop_hook_active` true; no, empty or non-string message;
      no question mark in the tail; a `cwd` that is the data folder or `voice-route-scratch` inside it; a session id
      with `/`; `headless` true; `acts` false; `acts` throwing; input that is not JSON, an array, or over 256 KiB.
    - It prints nothing for answers `{ nudge: false }`, `{}`, `{ nudge: 'yes' }`, `429` and `null`.
    - `'an ask that never answers: done within NUDGE_ANSWER_MS, nothing printed'` (fake timers; the injected `ask`
      honors its abort as `askDevices` does).
    - `out` throwing still returns 0.
    - The guard: `'the eval's Part 5 variant answers exactly what this command prints'`. `flow/v5/harness-answers.json`'s
      `stop` answer has stdout `stopOutput() + '\n'`, and `flow/v5/hooks.json`'s `Stop` hook runs `harness device
      claude stop` with timeout 5.
  - `command.spec.ts`, using the spec's throwaway homes and data folder and an injected `ask`:
    - `'claude stop prints the block with the plugin on and Harness's skill in the session's home, and exits 0'`.
    - `it.each` `'claude stop prints nothing and exits 0: %s'`: plugin off, removed, no skill, `CLAUDE_CODE_ENTRYPOINT`
      `sdk-cli`, and a no from the devices.
    - The same two for `codex stop`, F8's sign of a `codex exec` run standing for `sdk-cli`.
    - `'stop is not in DEVICE_USAGE'`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/deviceClaude/stop.spec.ts
  src/deviceClaude/command.spec.ts`. Expected: FAIL (`stop.ts` not found; `claude stop` prints the usage, exit 1).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** `stop.ts`'s header comment says:
  - what the look is for;
  - which fields it reads, and that the answer never leaves its process;
  - why `cwd` in the data folder and headless runs get nothing;
  - why the cheap checks come before any file read and the ask;
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
- Test: `cli/src/harnessDevicePlugin.spec.ts`, `cli/src/devices/claudePluginBundle.spec.ts`

**Interfaces:**
- Produces: `hooks.json` keys are main's plus `'Stop'`, last. Its value is
  `[{ hooks: [{ type: 'command', command, onFailure: 'continue', timeout: 5 }] }]`, with no matcher.
  - POSIX first line: ``echo `# <#` >/dev/null; exec "${CLAUDE_PLUGIN_ROOT}/hooks/stop"``.
  - After `#>` comes the PermissionRequest form's lookup without its `HARNESS_DEVICE_MOD_ASKS` check, ending
    `if ($h) { $o = & $h device claude stop 2> $null; if ("$o".StartsWith('{"decision":"block","reason":')) { [Console]::Out.Write("$o") } }; exit 0`.
  - `hooks/stop` is `hooks/start`'s shape (Part 4): the lookup, `device claude stop` with the hook's stdin, stderr to
    `/dev/null`, stdout captured and printed with a newline only under the prefix; `cat >/dev/null` with no launcher;
    `exit 0`.

- [ ] **Step 1: Write the failing tests**, as Part 4's Task 2 wrote the SessionStart ones. Use `STOP_INPUT`
  (`session_id`, `transcript_path`, `cwd`, `hook_event_name: 'Stop'`, `stop_hook_active: false`,
  `last_assistant_message`) and `BLOCK = '{"decision":"block","reason":"r"}'`.
  - The `hooks.json` keys test.
  - `posix.each(SHELLS)` from a folder with a space: the launcher's argv is `device\nclaude\nstop\n`, its stdin is
    `STOP_INPUT` byte for byte, and the result is `{ status: 0, stdout: BLOCK + '\n', stderr: '' }`.
  - `'prints nothing but the block'` over usage text, `ALLOW`, `''`, exits 0, 1 and 2, and stderr.
  - With no launcher: nothing, exit 0. The executable check and `#!/bin/sh`.
  - The Windows form: `device claude stop 2> $null` once, the guard, no `HARNESS_DEVICE_MOD_ASKS`, no `[Console]::In`
    and no `|` into `$h`, ending `; exit 0`.
  - In the win32 block, for PowerShell and Git Bash: the block passes (`stdout.trim()`); `ALLOW` prints nothing; no
    launcher prints nothing; a `last_assistant_message` of `Đã xong, không cần gì thêm.` reaches the stand-in byte
    for byte.
  - `claudePluginBundle.spec.ts`: the executable list gains `hooks/stop`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts
  src/devices/claudePluginBundle.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** the three files. `hooks/stop`'s comment says that Claude Code reads a Stop hook's stdout as
  its decision, so only the block the launcher shapes passes.
- [ ] **Step 5: Run them and see them pass.** The same command. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 12: Codex's Stop hook in the plugin, trusted as the others

**Effort:** high. **Depends on:** Task 11 (the same spec, bundle list and form), Task 1 (F2, F7).

**Files:**
- Modify: `plugins/harness-device/hooks/codex.json` (the `Stop` key, appended)
- Create: `plugins/harness-device/hooks/codex-stop` (mode 755)
- Modify: `cli/scripts/lib/claudePluginBundle.mjs` (`EXECUTABLE` gains `plugins/harness-device/hooks/codex-stop`)
- Test: `cli/src/harnessDevicePlugin.spec.ts`, `cli/src/devices/claudePluginBundle.spec.ts`,
  `cli/src/devices/codexPluginTrust.spec.ts`

**Interfaces:**
- Produces: `codex.json` keys are main's plus `'Stop'`, last, with no matcher.
  - POSIX: ``echo `# <#` >/dev/null; exec "$PLUGIN_ROOT/hooks/codex-stop"``.
  - Then the Codex lookup, with Task 11's guarded write for `device codex stop`.
  - `hooks/codex-stop` is `hooks/codex-asked`'s lookup with Task 11's capture and prefix check.
  - The trust record `…:stop:0:0` comes from the unchanged `pluginTrustRecords`.

- [ ] **Step 1: Write the failing tests:**
  - the Codex counterparts of Task 11's cases, run the `runCodexHook` way (`<shell> -c`, `PLUGIN_ROOT` set; argv
    `device\ncodex\nstop\n`; the win32 block through `powershell.exe -NoProfile -Command`);
  - the executable list;
  - `codexPluginTrust.spec.ts`: `'the repository's plugin gets a stop record, its matcher not hashed'`. Its
    `trustedHash` equals `reviewHash({ ...hooks.settings.reviewed!, matcherEvents: [...] }, 'Stop', undefined,
    { command, timeout: 5 })`, and every record shares one `contentHash`. If F7's `hooks/list` hash differs, stop and
    report.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts
  src/devices/claudePluginBundle.spec.ts src/devices/codexPluginTrust.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** the three files. `codexPluginTrust.ts` does not change.
- [ ] **Step 5: Run them and see them pass.** The same command. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 13: Harness's Codex reader names a Stop hook's prompt (only if F5 says it reads as the person's)

**Effort:** high. **Depends on:** Task 1 (F3, F5), V. **Runs only** when F5 shows that Harness's Codex reader, in a
pane, opens a turn whose `userMessage` is the hook's reason. If F5 shows the reader leaves the hook prompt out and the
turn open, this task is dropped, and the pull request says so.

**Files:**
- Modify: `cli/src/engines/codex/normalizer.ts`
- Create: `cli/src/engines/codex/__fixtures__/stop-hook-prompt.jsonl` (Task 1's rollout lines, Codex's own, with paths
  set to `/home/person`)
- Test: `cli/src/engines/codex/normalizer.spec.ts`

**Interfaces:**
- Produces: a hook prompt, as F5's record marks it, opens or continues the turn as
  `Continuing: <its first line, cut at 200>`, the label `engines/claude/normalize.ts` `stopHookContinuation` gives. It
  applies to any hook's prompt, not only Harness's. A person's own `user_message` is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - the fixture replayed live gives `turn_started { userMessage: 'Continuing: Your answer asks the person something,
    and they are not at this session. If the task …' }` (cut at 200) and never the reason as the person's words;
  - in replay, a `user_message` with the same label;
  - a person's `user_message` reading like the reason is still the person's.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/engines/codex/normalizer.spec.ts`.
  Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** it beside `goalTurn`.
- [ ] **Step 5: Run them and see them pass.** The same command. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 14: end to end, on the real daemon with the carried hooks

**Effort:** high. **Depends on:** Tasks 9, 10, 11 and 12.

**Files:**
- Create: `cli/e2e/deviceStopLook.e2e.ts` (no change to `cli/e2e/harness/`)

**Interfaces:**
- Consumes:
  - `IsolatedDaemon`, `Desk`, `FakeDial`, `fileBundle()`, `harnessPath('claude-marketplace', HOME)`, `tellDevices`;
  - `InOrca` (Claude Code in an Orca terminal, its hooks run by the test with `hook('Stop')`) and `CodexOutside`;
  - Task 10's `stopOutput`;
  - Part 4 Task 5's `launcher(d)` pattern for `<HOME>/.local/bin/harness`.

- [ ] **Step 1: Write the test.** Run the carried `hooks/stop` and `hooks/codex-stop` command lines through
  `/bin/sh -c`, with `d.env`, `${CLAUDE_PLUGIN_ROOT}` or `PLUGIN_ROOT` set to the carried folder, and the Stop input on
  stdin. Absence is shown against an anchor: a second session B, with no question, stops at the same moment, and its
  told summary is the barrier.
  1. `'Claude Code, the person away: one block, the first end not told, the notice rings once, the next stop ends
     silent'`. The front is `vscode` and the dial is on another agent. A's native Stop runs, then the hook gives
     `stopOutput()`. B's summary arrives while A has none. A's `harness device notify` gives one `question` frame.
     A's next Stop (`stop_hook_active: true`) prints nothing. Then one `summary`, `tier: 'silent'`, and the log has
     `rule:notice`.
  2. `'no question: nothing printed, no nudge asked'`: no `[device] nudge` line, and A is told as B is.
  3. `'the person there: no block'` (`[device] nudge · claude · present`).
  4. `'a notice pending: no block'` (`· notice`).
  5. `'no dial: no block'` (`· no dial`).
  6. `'the block lost: told once when the hold goes quiet'`. The hook says yes, no next Stop is run and the transcript
     is left untouched: one summary, 10 s or more after the yes and before 120 s, waited for as an event with a bound,
     never a fixed sleep.
  7. `'the yes before the blocked stop'`: case 1 with the hook run before the native Stop.
  8. `'a second look before the person's next prompt: no block'` (`· nudged`).
  9. `'Codex, the person away'`: case 1 with `CodexOutside` and `device codex stop`, including F4's turn-start if it
     fires.
  Every case: no daemon log line holds the answer's words or the session id.
- [ ] **Step 2: Run it.** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceStopLook.e2e.ts`.
  Expected: PASS on top of Tasks 9-12. Its red is theirs.
- [ ] **Step 3: Commit.** One commit.

### Task 15: docs

**Effort:** medium. **Depends on:** Tasks 9, 10, 11, 12, and Task 13 when it runs. **Test that must fail first:** none
(docs); one commit.

**Files:**
- Modify: `plugins/harness-device/README.md`. A "When a turn stops" section:
  - the `Stop` hook in both engines and what it reads;
  - the 400 characters and the two question marks;
  - the four conditions for a yes;
  - the reason, word for word;
  - once a turn, and never for a headless run or Harness's own one-shots;
  - the 300 ms bound;
  - what the person sees (one more round of the agent, and Claude Code's "Stop hook feedback");
  - how to take it away (`harness device claude|codex disable`).
  "What it never does" gains: it never logs, keeps or sends the answer.
- Modify: `cli/AGENTS.md`. The devices row gains: the `nudge` message on the devices' listener (engine and session id,
  answered within 300 ms), the four conditions, and the observed source holding a nudged agent's turn end until its next
  stop, or 10 s with no activity (a hook, or its transcript growing), at most 120 s. The plugin clause gains its `Stop` hooks running `harness device claude|codex stop`
  (`deviceClaude/stop.ts`).
- Modify: `docs/cli.md`. The `harness device claude` and `harness device codex` rows get one sentence each: the plugin
  stops a turn that ends on a question once, while the person is away and the dial would ring, so the agent decides
  whether to ring.

- [ ] **Step 1:** Write them, short. No UI element changes, so the design doc does not.
- [ ] **Step 2:** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts` (its README test). Expected: PASS.
- [ ] **Step 3: Commit.**

---

## Task graph

| Task | Depends on | Effort |
|---|---|---|
| 1 spike, both engines (no repository file) | G0 | high |
| 2 the eval answers a Stop hook, `nudged` | G1 | high |
| 3 the variant `flow/v5` | 2 | medium |
| 4 the eval pass (not before GO) | 1, 3, GO | high |
| 5 results and the spec | 4 | medium |
| V Task 4's verdict ships | 4 | gate |
| 6 `nudge` on the listener | V | high |
| 7 the observed source holds a stop that goes on | 1, V | xhigh |
| 8 the devices answer `nudge` | 6, 7 | xhigh |
| 9 once; a Harness agent's presence | 8 | xhigh |
| 10 `device claude|codex stop` | 1, 2, 3, V | xhigh |
| 11 Claude Code's Stop hook | V | high |
| 12 Codex's Stop hook and its trust | 1, 11 | high |
| 13 Codex reader label (only if F5) | 1, V | high |
| 14 end to end | 9, 10, 11, 12 | high |
| 15 docs | 9, 10, 11, 12 (13) | medium |

Longest chain: 2 → 3 → 4 → (V) → 6 → 8 → 9 → 14 → 15, eight tasks after G1. Task 1 and GO join it at Task 4, and Task
7 joins it at Task 8. Tasks 6, 7, 10, 11 and 13 start together at V. Tasks 8 and 9 share `devices.ts`, and Tasks 11
and 12 share the plugin spec and the bundle list, so each pair runs in order.

## Pull request notes

- One pull request, released by the PM: the CLI, which carries the plugin, after Part 4's eval (Release order 8). No
  backend. If V fails, the eval alone (Tasks 2-5).
- Codex's side ships only on Verification 2's proof (the spec). If it fails, the main session takes Task 12, Task 13
  and Task 10's `codex stop` case out before the merge, and Claude Code's side ships alone.
- Evidence:
  - the red-then-green commits;
  - Task 4's held-out table, verdict, extra rounds and spend (numbers only);
  - Task 1's facts;
  - Verification 1-3's results, and Verification 3's hook times (median and maximum);
  - `local-checks.py`'s receipts;
  - the stated limits under Review Focus;
  - the platforms (macOS, Linux, Windows) and how each was tested.

## Verification

**On GitHub, automatic on the pull request** ([validation and release](../validation-and-release.md)):
- `cli-typecheck` and `cli-tests`: every spec above, `architecture.spec.ts` and `architecture.failureLogs.spec.ts`
  among them.
- `linux-e2e`: the new `deviceStopLook.e2e.ts`, plus the dial app eval's six, as `services/devices.ts` and
  `cable/hosts/observed.ts` change.
- `windows-e2e` x64, selected by path for `plugins/harness-device*/` and `cli/src/devices/`. There
  `harnessDevicePlugin.spec.ts` runs both Stop forms under Windows PowerShell and Git Bash, and Codex's under PowerShell.
- The other jobs `scripts/ci-plan.py` selects for these paths.

Picked up front, by hand: one run of `cli-e2e.yml` from the branch at the final head (Actions → CLI end to end → Run
workflow). The observed source's turn ends feed every outside-agent e2e file, and PR CI runs only the pull request's
own. No other workflow is started by hand.

**Local gates PR CI does not run:** at the final commit, from a clean tree, `python3 scripts/local-checks.py --run`. It
selects `npm run test:core`, as `services/devices.ts` and `cable/` change, with every file at 100%. Paste its receipts
in the pull request. Also run the eval's own specs: `cd cli && npx vitest run --config
evals/dial-skill/vitest.config.ts`.

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
   - With the dial unplugged, `· no dial`. An answer with no question mark gives no `[device] nudge` line. An answer
     that rang first gives `· notice`.
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
   - Outside a pane, in the TUI: the same signs as 1. If F4 fired, the log shows no `[device] prompt` follow for the
     hook's prompt.
   - In a Harness pane: as F5 says, Task 13's label or the turn left open; the first end told nothing.
   - `codex exec`: no block (F8).
   - Harness's own one-shot flags from the data folder: no block.
3. **The hook's time at a turn end, on this Mac** (a tester; macOS; code standard 4). Run the installed `hooks/stop`
   with the wrapper 20 times for each of three inputs, one after another, timed from spawn to exit with
   `process.hrtime.bigint()`:
   - an answer with no question mark;
   - one with a question mark and the devices answering no;
   - one with a question mark and no devices listening.
   Report the median and maximum of each; each maximum must be under 1 s. Before Part 5, a turn end ran no such hook.
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
   - Claude Code in Git Bash: one block and one `question` frame, no `summary` before it, with the hook's time and the
     nudge's round trip over the pipe recorded;
   - Codex through PowerShell: the same, with its time;
   - for each, `[device] nudge · <engine> · yes` once in the isolated daemon's log, and the second Stop not blocked.
   The record gives the times and counts, no answer text and no user or machine name.

6. **The eval** (Task 4) is Claude Code's end-to-end measurement. It runs locally on this Mac, with no workflow, and
   **needs the user's own Claude Code sign-in** through the session profile. It does not run before GO. Its isolation
   is the eval's own (its README): a temporary repo per run, the fake `harness`, the curated `PATH`,
   `--setting-sources project`, Claude's sandbox, and no backend.
7. **The person's own eye, after the release** (needs the user: their own login, their dial). In a fresh session, a
   long turn ends on a question while the person is in another app: one extra round, one ring, and no done ring before
   it. A question asked back in a live exchange gives no block and no ring.

**Proposal, not built here:** Part 7's proposed scheduled check of the newest Codex release, and a Claude Code
counterpart, against the stub. Both would confirm that a plugin `Stop` hook still gets `last_assistant_message` and
`stop_hook_active`, and that the block still goes on as F1 and F3 found. Then a CLI release that changes either is seen
before a turn is stopped twice or never. No such workflow exists.
