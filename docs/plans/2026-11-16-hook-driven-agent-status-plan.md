# Hook-driven agent status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** plan review answered (Ken, 2026-11-17) and folded in; the Codex facts answers (Ken, 2026-11-17) folded in: Interrupt written with a 3 s timeout (Task 20), Codex ends with no Stop marked `over` (Task 25), subagents counted for Claude Code only (Tasks 13, 14, 19, 20, 22, R5).

**Goal:** For Claude Code and Codex in Harness panes, a turn ends when the engine's own hook says so, a wait on the person stops reading as working at its hook and its question shows at the next poll, a lead stays working while its subagents run, and "Finished" is announced once, after 1.5 s of quiet.

**Architecture:**
- **One record a session, in a file the core already loads.** `core/turns/turnHooks.ts` keeps today one number a session (its latest prompt hook's time). That entry becomes the spec's record: whether the transcript's end is read and held, when the last hook came, the wait, and one integer for running subagents. Every transcript read passes it on its way to the funnel (`createIngest`'s `emit`), which is the one point the worker parser's frames and the inline parser's lines share; `core/engines/liveSessions.ts` does not change.
- **Hooks reach it through two new local routes** (`/api/hook/wait`, `/api/hook/subagent`) beside `/api/hook/turn-stop`, which also carries Codex's Interrupt as `status: 'interrupted'` (a field it already takes), so the interrupt needs no route of its own. `hook/notify.mjs` maps each engine's event to a route and sends the event's name and the tool's name, nothing else, and only from a Harness pane.
- **Everything that is not a turn boundary or a wait stays out of the core:** the engine workers say when a record was written and when the engine's own record ends a turn; the recaps service holds the quiet window; the hook process maps events.

**Tech Stack:** TypeScript (Node 24, vitest) in `cli/`. No Desktop, mobile or backend change.

**Spec:** [docs/plans/2026-11-16-hook-driven-agent-status-design.md](2026-11-16-hook-driven-agent-status-design.md).

## Base

- Branch `feat/hook-driven-agent-status`, from `main` at `e9670ffd23`. One pull request, no release.
- Before the first task: `cd cli && npm ci`.
- Tasks name code by name, never by line. If a name below is gone, stop and report.
- A task that names failing tests is two commits: the tests, red, then the change. The message given is the second's.
- Never touched by a task, a test or a check: the person's daemon (port 18473), `~/.harness`, `~/.claude`, `~/.codex`, and any Claude Code or Codex the person runs. Unit tests use throwaway homes; end-to-end tests use `IsolatedDaemon` (`cli/e2e/harness/daemon.ts`: throwaway root, its own port, a private tmux server, `src/testing/isolatedTmux.ts`).
- `COV` below is `--coverage --coverage.thresholds.lines=100 --coverage.thresholds.statements=100 --coverage.thresholds.branches=100 --coverage.thresholds.functions=100`, with one `--coverage.include=<file>` for each core file the task changes.

## Core footprint

Every addition to the core's process. No file is added: `cli/src/architecture.coreFiles.txt` gains no line, and `src/architecture.spec.ts` stays green. Lines are estimates of code added, tests left out. About 400 lines is the frame Ken accepted (2026-11-17); this plan is under it, and the final review looks at the core's part on its own and cuts what it can (Verification, check 8).

| File (already in the core's process) | What is added | State | Lines | Why every session needs it |
|---|---|---|---|---|
| `core/turns/turnHooks.ts` | the session's hook record; the pass every transcript read takes to the funnel; Interrupt (a Stop with `status: 'interrupted'`); the wait; the subagent count; the two timeouts | `Map<string, HookTurn>` in place of today's `promptFiredAt: Map<string, number>`, the same 512 kept. `HookTurn`: `promptAt: number` (today's value), `endsByHook: boolean`, `held: { identity?: string; openedAt?: number; at: number } \| null`, `awaiting: Array<(held: boolean) => void>` (Stops waiting at most 1.5 s), `hookAt: number`, `waitAt: number \| null`, `subagents: number`, `progressAt: number` | +180 | where a Claude Code or Codex turn ends and waits: the turn is the core's |
| `engines/kit/stopHook.ts` | the Stop rule on the held end | none | +25 | the turn boundary |
| `engines/facets/hooks.ts` | the Stop rule's context; a declared event's own timeout | none (types) | +11 | — |
| `core/transcripts/normalizers.ts` | a turn reads open while its end is held; a cancel and a forget drop the record | none | +8 | "is its turn open" has one answer |
| `core/transcripts/ingest.ts` | hands a read's `at`, `over` and `turn` on with its events | none | +6 | the boundary's and the wait's input |
| `core/turns/heartbeats.ts` | one call a beat | none | +3 | the timeouts run only while a turn is open |
| `core/turns/activity.ts` | the probe answers `unknown` while Working is withheld, `working` while subagents run | none | +6 | the wait; the lead's open turn |
| `lib/turnActivity.ts` | `withdraw`; progress claims nothing while withheld | one optional boolean on the runtime value | +10 | the wait |
| `lib/questionController.ts` | `awaitDialog`; `onClear`, on the existing gone count (`misses`, `GONE_TICKS`) | `Set<string>`: the watched sessions a hook said wait and no dialog has been read for since | +12 | the wait |
| `core/questions.ts` | tells the record a question closed or the pane read clear | none | +5 | the wait |
| `hookServer.ts` | two routes; an unbound hook said once a session | `Set<string>`, at most 512 session ids | +30 | the hooks' one door |
| `engines/worker/liveProtocol.ts` | `at`, `over` on a frame, checked | none | +4 | what the workers say reaches the core as typed, bounded data |
| `engines/claude/hookContract.ts`, `engines/codex/hookContract.ts` | the declared events, labels | data | +16 | — |
| `engines/kit/hookSettings.ts`, `notifyHooks.ts`, `hookReview.ts` | the installer's prune (spec §1); a declared event's own timeout written | none | +36 | see below |
| `core/main.ts` | wiring | one `let` reference | +14 | wiring only |

About 365 lines, no new file. Cut since the draft (about 400): the pane read at the hook (`readNow`, its in-flight follow-up and its first read on `start`, and the core's `readQuestionNow` dependency), and the interrupt route with its handler and wiring.

- **The subagent count** is `HookTurn.subagents`, one integer. The core has no per-session turn record today: the parser's turn is its worker's, and the core holds a cursor on it (the parser itself only under an older master). The nearest is `promptFiredAt` in `turnHooks.ts`, one number a session. The spec's record (§2) is that entry widened, in the same map with the same bound, and the count is one field of it: no second map, no list, no record of its own. It is the smallest place because the three hooks that write it and the Stop rule that reads it already meet in `turnHooks.ts`, which already makes and drops that entry.
- **Not a boundary or a wait, and still in the core (Ken, 2026-11-17):** the installer's prune. `installHookSettings` runs in the core (launch waits for it) and is the one writer of the person's settings file; a prune anywhere else is a second writer of that file. It is the spec's §1 and about 35 lines in three files the core already loads. The other is the lease reading that subagents run (`atWork`, 6 lines in `core/turns/activity.ts`): the spec's §2 keeps the lead working from the count, and the lease is the core's.
- **In a component, not the core:** when a record was written and whether the engine's own record ends the turn (engine-claude and engine-codex workers, Task 6); Codex's aborted end (engine-codex, Task 5); a Codex end with no Stop after it (engine-codex, Task 25); the quiet window (recaps service, Task 9); which event is which, and that nothing new is sent from outside a pane (the hook process, Task 13). The devices are untouched.
- **Measured, not estimated, in the pull request:** the core's line count at `e9670ffd23` (92 229, the sum of the files `architecture.coreFiles.txt` lists, measured 2026-11-17) and at the head (check 8).

## File structure

| File | Process | Is |
|---|---|---|
| `cli/src/core/turns/turnHooks.ts` | core | the record, the pass to the funnel, and what each hook does to a turn |
| `cli/src/engines/kit/stopHook.ts` | core | what a Stop means: deliver the held end, wait for it, or close |
| `cli/src/hookServer.ts` | core | the two new routes |
| `cli/src/lib/turnActivity.ts`, `cli/src/core/turns/activity.ts` | core | the lease: withheld, at work |
| `cli/src/lib/questionController.ts`, `cli/src/core/questions.ts` | core | a dialog is coming; the pane read clear |
| `cli/src/engines/claude/normalize.ts`, `live.ts`, `cli/src/engines/codex/normalizer.ts`, `live.ts`, `cli/src/engines/worker/liveStreams.ts` | engine workers | a record's time, the engine's own end, Codex's aborted end, a Codex end with no Stop |
| `cli/src/lib/agentNotifications.ts`, `cli/src/lib/commander.ts` | recaps service | the quiet window |
| `cli/hook/notify.mjs` | the hook's own process | event to route, in a pane only |
| `cli/src/engines/kit/hookSettings.ts`, `notifyHooks.ts`, `hookReview.ts`, the two `hookContract.ts` | core (installer) | the events installed, pruned, reviewed |
| `cli/e2e/harness/fakeEngine.mjs`, `cli/e2e/hookStatus.e2e.ts`, `cli/e2e/hookStatusRealClaude.e2e.ts`, `cli/e2e/perf.e2e.ts` | tests | the fake engines' new events, end to end, the real Claude Code check, the numbers |

## Global Constraints

- **Scope:** Claude Code and Codex, in Harness panes. Other engines keep today's sources.
- **Outside panes, unchanged:** `notify.mjs` sends none of the new events for a session outside a pane, Codex's Stop included; the devices see exactly what they see today.
- **Oldest supported:** Claude Code 2.1.209, Codex 0.144.0. An engine older than an event never sends it and stays on today's transcript path, with a test (Tasks 15, 22).
- **Values:** `STOP_HOOK_GRACE_MS` 1 500 (kept); `HOOK_SILENCE_MS` 120 000; `SUBAGENT_TIMEOUT_MS` 600 000; `SUBAGENTS_MAX` 64; `DONE_QUIET_MS` 1 500; `HOOKS_KEPT` 512 (today's `PROMPT_HOOKS_KEPT`); the heartbeat stays 5 000 and the question poll 1 500.
- **Wire:** no new frame and no new field. `turn_ended.aborted` and `turn_summary.notification.id` carry it. No Desktop change.
- **Hook bodies:** only fields `validHookBody` already takes (`hookEvent`, `toolName`). Never a tool's input, never a prompt. `notify.mjs` writes nothing on stdout for Claude Code and Codex and exits 0, so no hook of ours decides a permission or blocks a tool.
- **Hooks installed:** end and wait events only. No hook per tool call, never PreCompact, no PostToolBatch or ElicitationResult.
- **Events, final.** Codex: SessionStart (`startup|resume|clear|compact`), UserPromptSubmit, Stop, PermissionRequest, PreToolUse (`request_user_input`), Interrupt (timeout 3 s: Codex caps it at 3 s and hashes the capped value, facts-codex §1). No subagent hooks for Codex (Ken, 2026-11-17): its subagents keep today's behaviour. Claude Code: today's six, PreToolUse (`AskUserQuestion`), SubagentStart, SubagentStop, and under Variant P (Task 1) PermissionRequest and Elicitation.
- **The core:** no new file; no logic in `runForeground`; 100% a file for `src/core/` (`npm run test:core`).
- **Tests:** a test that fails first, at the layer where the behaviour lives; fake timers, no fixed sleeps; comments say why.
- **Logs:** a fixed line and the session's short id (`sid`). Never a tool's input, a prompt or a path.
- **Bounds:** one record a session, at most 512, dropped when the session is forgotten; one dropped to make room has its held end delivered first. No per-tool-call hook reaches the daemon.
- **Platforms:** macOS, Linux, Windows (Claude Code exec form, Codex a PowerShell line: the same line for every event).

## Turn rules

The tasks cite these by number.

- **R0 Ends by hook.** A session's turns end by hook from the first Stop, StopFailure or Interrupt it sends in this daemon run. Until then every read goes to the funnel as it came.
- **R1 The pass** (a live read of a session whose turns end by hook):
  1. a replay goes on as it came; when it carries a turn's start or end, what is held is dropped (the transcript was read again);
  2. an aborted end, or the end of a read the engine marked `over`, goes on at once. `over` is an end no Stop follows: Claude Code's `turn_duration` (a paused `/goal` pass, Task 6); Codex's turn that ended in an error or was stopped by a prompt hook (Codex runs no Stop for either and has no StopFailure, Task 25);
  3. any other end is held, with its turn's identity and opening time, and Stops waiting for it are answered;
  4. a turn's start with an end held sends the held end first, in the same batch, in order;
  5. everything else goes on, in order.
- **R2 Stop.** Which turn it is about is taken before the first await: the turn whose end is held, else the parser's open turn. Then drain. A Stop its engine ran before the session's latest prompt hook, or before that turn's opening record, closes nothing. Otherwise: an end held → delivered; none held → wait up to 1 500 ms for it, deliver it the moment it is read; none by then → drain, then close as today's fallback does. A continued `/goal` pass is closed by its own Stop. A StopFailure closes whichever turn is open or held.
- **R3 Interrupt** (Codex; it arrives on `/api/hook/turn-stop` with `status: 'interrupted'`). Closes the parser's open turn at once as `turn_ended { aborted: true }` through the funnel, the path Claude Code's interrupt line takes: no drain, no wait, no key. The same two stale rules as R2.
- **R4 Wait.** Opens with the hook's `firedAt`, unless it ran before the latest prompt hook. At once: the Working claim is withdrawn and told, and the question watcher is told a dialog is coming. No pane is read at the hook (the engine draws its dialog after the hook returns): the question shows at the watcher's next 1.5 s poll, as today. Ends on: the watcher (a question closed, or two polls in a row read the pane with no dialog); any turn end; a turn start; progress of the lead (no `parentToolUseId`, not `subagent_finished`) whose record's `at` is after `firedAt`. A read with no `at` ends nothing.
- **R5 Subagents (Claude Code only).** Codex installs no SubagentStart or SubagentStop hook, so its count stays 0 and its subagents keep today's behaviour (its SubagentStop fires per child turn and never for an interrupted or failed one, facts-codex §2). Start +1 (not past 64, said once), stop −1 (not below 0), a prompt hook sets 0. A Stop while any runs leaves the end held. The first Stop with none running ends the turn; when its held end was read before an earlier hook, it waits 1 500 ms and drains again first (the lead's wrap-up lands after its Stop: `lib/commander.ts`, `SUBAGENT_TEXT_SETTLE_MS`). A StopFailure ignores the count. 600 000 ms with no hook and no progress while any runs: 0, one line, the held end delivered.
- **R6 Silence.** An end held for 120 000 ms with no hook since (measured from the later of the last hook and when the end was read) is delivered, with one line. Not while subagents run: R5's timeout governs then.
- **R7 Open.** A session's turn is open while its parser says so or its end is held.
- **R8 Working.** `lib/turnActivity.ts` stays the one place. Working is withheld while a wait is open, and for a session whose turns end by hook with none open: progress read then claims nothing, a turn's start still does.

## Design (docs/feature-design-rules.md)

The spec's §8 answers the checklist. What this plan adds to it: nothing is stored; the record's bound is in Global Constraints; the hot path gains one map lookup a transcript read for a session with no record; an old CLI after a rollback runs the new blocks through its own `notify.mjs` (Task 3: harmless in a pane; outside a pane a Known gap, Verification); each failure has its line (`ended by its transcript`, `subagent count reset`, `subagent not counted`, `refused · unbound`).

## Review Focus

1. **A next prompt read while an end is held** (its Stop lost or late): the held end reaches the funnel before the new turn's start, in order. Task 15.
2. **A Stop delivered twice, or two in flight:** one end. Task 15.
3. **An agent closed, cancelled or attached again while an end is held or a Stop waits:** nothing is sent for it later and its record is gone. Task 15.
4. **A permission answered before any read finds its dialog** (the dial's own hook, a fast key): the wait ends once two polls read the pane clear, so a long tool reads working again. Tasks 8, 18.
5. **Codex: a Stop or Interrupt that arrives after the next turn's start was read and before its prompt hook:** the next turn is left open. Codex's turn carries no opening time today. Tasks 6, 15, 16.

## Tasks

| # | Task | Depends on | Effort |
|---|---|---|---|
| 1 | Facts: Claude Code's hooks | none | high |
| 2 | Facts: Codex's hooks, labels and hashes | none | high |
| 3 | Facts: a rollback is harmless | none | medium |
| 4 | Perf: hook requests and the round trip in the report | none | medium |
| 5 | Codex: a stopped turn ends as aborted | none | medium |
| 6 | Engine workers: a record's time, the engine's own end, Codex's opening time | none | high |
| 7 | The lease: withheld, and at work | none | high |
| 8 | The question watcher: a dialog is coming, and the pane is clear | none | high |
| 9 | Recaps: Finished after 1.5 s of quiet | none | high |
| 10 | Hook server: wait and subagent routes | none | xhigh |
| 11 | Ingest: a read's time, end and turn go on with its events | 6 | medium |
| 12 | Installer: prune Harness's blocks from undeclared events | none | xhigh |
| 13 | `notify.mjs`: the new events | 1, 2 | high |
| 14 | Fake engines: the new events | 1, 2 | high |
| 15 | Turn ends by hook: the held end and the Stop | 7, 11 | xhigh |
| 16 | Codex Interrupt | 15 | xhigh |
| 17 | Hook silence | 15 | xhigh |
| 18 | Waits | 8, 10, 15 | xhigh |
| 19 | Subagents | 10, 15, 17 | xhigh |
| 20 | Codex: events, labels and hashes | 2 | xhigh |
| 21 | Claude Code: events | 1 | high |
| 22 | End to end | 5, 9, 13, 14, 16, 18, 19, 20, 21, 25 | high |
| 23 | Temporary workflow: the numbers before and after | 4, 22 | medium |
| 24 | Real Claude Code check, opt-in | none | high |
| 25 | Codex: an end with no Stop after it goes on at once | none (5, 6 landed) | high |

Longest chain: 6 → 11 → 15 → 17 → 19 → 22 → 23 (seven). Files shared without a dependency, so those tasks run one at a time: 16 to 19 (`turnHooks.ts`; 17 to 19 also `core/main.ts`), each after 15; 5, 6 and 25 (`codex/normalizer.ts`; 6 and 25 `codex/live.ts`, `codex/live.spec.ts`); 12, 20 and 21 (the installers' golden fixture, and 12 and 20 `hookReview.spec.ts`, `hookSettings.ts`, `hookSettings.spec.ts`); 15, 20 and 21 (`engines/hooks.spec.ts`, and 15 and 20 `codex/hookContract.ts`); 15, 19 and 20 (`engines/facets/hooks.ts`).

---

### Task 1: Facts: Claude Code's hooks

**Depends on:** none. **Effort:** high. **Failing test:** none: no behaviour changes; one commit.

**Files:**
- Create: `docs/plans/2026-11-16-hook-driven-agent-status-facts-claude.md`

Read only: Claude Code's hooks documentation and changelog, and the installed bundle with `strings` (here `~/.local/share/claude/versions/2.1.326`). Run nothing against `~/.claude`. If a run is the only way, an older release goes into the scratchpad with `npm pack`, with `HOME` and `CLAUDE_CONFIG_DIR` set to throwaway folders, and only `--version` or `doctor` is run.

- [ ] **Step 1: Establish, each with its source** (a URL and date, a changelog entry, or the file and string):
  1. When `Notification` (`permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`) fires against the dialog being drawn. The repo's own record says 2.1.x sends it once the dialog has waited 6 s (`e2e/harness/fakeEngine.mjs`, `PERMIT_NOTICE_MS`). The file's first line is the verdict: `Claude waits: Notification` (**Variant N**, it fires as the dialog opens) or `Claude waits: PermissionRequest+Elicitation` (**Variant P**).
  2. For PermissionRequest, Elicitation, PreToolUse, SubagentStart and SubagentStop: the first release with it; the stdin fields (`hook_event_name`, `session_id`, `transcript_path`, `tool_name`, the subagent's id); whether Claude Code waits for the hook before it draws the dialog; that a PreToolUse matcher `AskUserQuestion` runs the hook for that tool only; that exit 0 with empty stdout leaves the decision to the person; that a subagent's events carry the lead's `session_id`; that a subagent's end fires SubagentStop and never Stop.
  3. The oldest supported Claude Code, 2.1.209 (Ken, 2026-11-17): which of PreToolUse's `AskUserQuestion` matcher, PermissionRequest, Elicitation, SubagentStart, SubagentStop and the three Notification types it has, and what it does with a `settings.json` whose `hooks` holds each event it does not know. Ignored, or the file refused. The events it lacks are the fake's `withoutHooks` in Task 22's older-engine case.
- [ ] **Step 2: Stop and report, changing nothing else, when** an unknown event makes a supported release refuse the file; a subagent's end fires `Stop` with the lead's session; the PreToolUse matcher is not honoured; or an empty stdout decides a permission.
- [ ] **Step 3: Commit** `Docs: what Claude Code's hooks do, for hook-driven status`.

### Task 2: Facts: Codex's hooks, labels and hashes

**Depends on:** none. **Effort:** high. **Failing test:** none: no behaviour changes; one commit.

**Files:**
- Create: `docs/plans/2026-11-16-hook-driven-agent-status-facts-codex.md`

The targeted Codex is the newest stable `@openai/codex` on the day this task runs, installed into the scratchpad with `npm install --prefix`, never the person's. Every run has `CODEX_HOME` and `HOME` set to throwaway folders. The planner's read of 0.167.1's strings: its hook events are PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt, PreModelRequest and PostModelRequest, and it names `hooks/src/events/interrupt.rs`.

- [ ] **Step 1: Labels and hashes.** Write a `hooks.json` in the throwaway home with one block for each of Stop, PermissionRequest, PreToolUse (matcher `request_user_input`), Interrupt, SubagentStart and SubagentStop, each running `COMMAND` of `engines/kit/hookReview.spec.ts` with `timeout` 5. Ask `codex app-server` for `hooks/list`. Record, for each, the label in its key and its `currentHash`, and whether `reviewHash` gives the same with labels `stop`, `permission_request`, `pre_tool_use`, `interrupt`, `subagent_start`, `subagent_stop` and PreToolUse in `matcherEvents`. Record the six hashes for Task 20, and that the record is still `[hooks.state."<key>"]` `trusted_hash` in `config.toml` (0.167.1 also names `.hook-trust`).
- [ ] **Step 2: Payload and timing**, from the source at the release's tag (`codex-rs/hooks/src/events/`) or a run: each event's stdin fields; whether Stop fires for every finished turn and for none that is interrupted; when Interrupt fires against the `turn_aborted` record; whether PermissionRequest and PreToolUse run before the dialog is drawn and are waited for; that the PreToolUse matcher takes the tool's name; that an empty stdout leaves the decision to the person; whose `session_id` and `transcript_path` SubagentStart and SubagentStop carry, and which field names the lead; whether a child thread's own Stop, Interrupt or PermissionRequest names the child's rollout (`notify.mjs` `isCodexSubagent` drops those).
- [ ] **Step 3: The oldest supported Codex, 0.144.0** (Ken, 2026-11-17): which of Stop, PermissionRequest, PreToolUse, Interrupt, SubagentStart and SubagentStop it has, and what it does with a `hooks.json` holding an event it does not know. The events it lacks are the fake's `withoutHooks` in Task 22's older-engine case.
- [ ] **Step 4: Stop and report, changing nothing else, when** a hash cannot be matched with labels and `matcherEvents`; a supported release refuses the file; the matcher is not honoured (a hook process a tool call); a subagent event names no lead; or a child's Stop carries the lead's session.
- [ ] **Step 5: Commit** `Docs: what Codex's hooks do, their labels and hashes`.

### Task 3: Facts: a rollback is harmless

**Depends on:** none. **Effort:** medium. **Failing test:** none: no behaviour changes; one commit.

**Files:**
- Create: `docs/plans/2026-11-16-hook-driven-agent-status-facts-rollback.md`

- [ ] **Step 1:** `git show e9670ffd23:cli/hook/notify.mjs` into the scratchpad. Run it as `src/hookNotify.spec.ts` runs the hook (a stub server on a free port, a throwaway data folder, `TMUX_PANE` and the fixture tmux and ps), with the argv `hookArgv` gives, once for each new event and engine.
- [ ] **Step 2: Record** the route each posts in a pane (expected: `/api/hook/session-start`; nothing for Claude Code's Notification in a pane), that stdout is empty and the exit 0, and the time taken. And from `e9670ffd23`'s `hookServer.ts`: that a registration carrying one of those `hookEvent` values takes UserPromptSubmit's path without the prompt credit, with the lines. Then run each once more with no `TMUX_PANE` (outside a pane) and record what reaches `/api/hook/observed` (expected from `observedEvent`: Codex's Stop as `turn-stop`, nothing for the others).
- [ ] **Step 3:** The file's first line is `Rollback: harmless`, or what breaks. Not harmless: stop and report (spec §7: the prune then ships in a release first). The Codex Stop outside a pane of Step 2 is written down as found, not judged here: it is a Known gap of the pull request (Verification).
- [ ] **Step 4: Commit** `Docs: an older CLI with the new hook blocks`.

### Task 4: Perf: hook requests and the round trip in the report

**Depends on:** none. **Effort:** medium. **Failing test:** none: measurement tooling; one commit.

**Files:**
- Modify: `cli/e2e/perf.e2e.ts`

Each phase of the report gains `hooks: { count, perTurn, roundTripMs: { p50, p95 }, byEvent }`, read from the fake engines' hook log (`d.hookLog()`), whose lines are `<ISO time> <engine> pid=<pid> <Event>[(<source>)] session=<id> ran in <ms> ms · exit=<code>`. Only lines whose time is inside the phase's window count. `perTurn` is `count / completedTurns`, null with no turn.

- [ ] **Step 1: Add it.**
- [ ] **Step 2: Run** `cd cli && PERF=1 E2E_BUNDLE=1 PERF_AGENTS=4 PERF_ACTIVE=2 PERF_SECONDS=10 PERF_WARMUP_SECONDS=0 PERF_HISTORY_MIB=0 PERF_REPORT="$SCRATCH/perf.json" npx vitest run --config vitest.e2e.config.ts e2e/perf.e2e.ts`. Expected: PASS, and the `active` phase's `hooks.count` is above 0 with `roundTripMs.p95` a number.
- [ ] **Step 3: Commit** `CLI: the perf report counts hook requests and their round trip`.

### Task 5: Codex: a stopped turn ends as aborted

**Depends on:** none. **Effort:** medium.

**Files:**
- Modify: `cli/src/engines/codex/normalizer.ts`
- Test: `cli/src/engines/codex/normalizer.spec.ts`
- Modify only where an existing Codex interrupt case expects a plain end: `cli/e2e/turns.e2e.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('a turn the person stopped ends as aborted, a finished one does not', () => {
  const normalizer = new CodexNormalizer('live')
  const say = (payload: object) => normalizer.ingest(JSON.stringify({ type: 'event_msg', payload }))
  say({ type: 'user_message', message: 'go' })
  expect(say({ type: 'turn_aborted' }).at(-1)).toEqual({ type: 'turn_ended', payload: { aborted: true } })
  say({ type: 'user_message', message: 'again' })
  expect(say({ type: 'task_complete' }).at(-1)).toEqual({ type: 'turn_ended', payload: {} })
})
it('an abort with no turn open, or on a replay, ends nothing', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/engines/codex/normalizer.spec.ts`. Expected: FAIL (`payload: {}`).
- [ ] **Step 3: Implement** in `CodexNormalizer.ingest`: the end `turn_aborted` emits carries `aborted: true`. For every Codex session, hook-driven or not.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `Codex: a turn the person stopped ends as aborted`.

### Task 6: Engine workers: a record's time, the engine's own end, Codex's opening time

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `cli/src/engines/facets/live.ts`, `cli/src/engines/claude/normalize.ts`, `cli/src/engines/claude/live.ts`, `cli/src/engines/codex/normalizer.ts`, `cli/src/engines/codex/live.ts`, `cli/src/engines/worker/liveStreams.ts`, `cli/src/engines/worker/liveProtocol.ts`
- Test: `cli/src/engines/claude/live.spec.ts` (new), `cli/src/engines/codex/live.spec.ts` (new), `cli/src/engines/worker/liveRequests.spec.ts`, `cli/src/core/engines/liveTransport.spec.ts`

**Interfaces — Produces:**

```ts
// engines/facets/live.ts
export interface LiveRead {
  events: LiveEvent[]
  failure?: string
  /** When the engine wrote this record (its own `timestamp`), epoch ms. Absent when it says none. */
  at?: number
  /** This record is the engine's own word that its turn is over, and no Stop follows it (Claude Code's `turn_duration`). */
  over?: true
}
// engines/worker/liveProtocol.ts: LiveFrame gains the same two, and livePage checks them
//   at: absent or a safe integer; over: absent or true
// engines/codex/live.ts: snapshot() carries openedAt, the `at` of the record that opened the turn
```

The time is taken in the parse each normalizer already does (`lineToEvents`, `CodexNormalizer.ingest`): `TurnState` and `CodexNormalizer` keep the last record's `at`. `claude/live.ts` reads it for `openedAt` too, and its own `writtenAt`, a second parse of the line, goes.

- [ ] **Step 1: Write the failing tests**

```ts
// engines/codex/live.spec.ts
const line = (timestamp: string | undefined, payload: object) => JSON.stringify({ ...(timestamp ? { timestamp } : {}), type: 'event_msg', payload })
it('a read says when its record was written, and a turn when it opened', () => {
  const parser = live.create({ engine: 'codex', codexHome: undefined })
  expect(parser.ingest(line('2026-11-17T01:02:03.000Z', { type: 'user_message', message: 'go' })).at).toBe(Date.parse('2026-11-17T01:02:03.000Z'))
  expect(parser.snapshot().openedAt).toBe(Date.parse('2026-11-17T01:02:03.000Z'))
})
it('a record with no timestamp says none, and the turn it opens has no opening time', …)
// engines/claude/live.spec.ts
it('a read says when its record was written', …)
it('turn_duration on a continued pass ends the turn and is marked over; an end_turn is not', …)
it('a turn\'s opening time is still its opening record\'s', …)
// engines/worker/liveRequests.spec.ts
it('a frame carries its record\'s at, and over when the engine said so', …)
// core/engines/liveTransport.spec.ts
it('takes a frame with at and over, and refuses an at that is no integer or an over that is not true', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/engines/claude/live.spec.ts src/engines/codex/live.spec.ts src/engines/worker/liveRequests.spec.ts src/core/engines/liveTransport.spec.ts`. Expected: FAIL (`at` undefined).
- [ ] **Step 3: Implement** the interfaces above. `liveStreams.ts` copies `at` and `over` from the read onto the frame it builds.
- [ ] **Step 4: Run** the same, and `npx vitest run src/architecture.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Engines: a record's own time and the engine's own end travel with its events`.

### Task 7: The lease: withheld, and at work

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `cli/src/lib/turnActivity.ts`, `cli/src/core/turns/activity.ts`
- Test: `cli/src/lib/turnActivity.spec.ts`, `cli/src/core/turns/activity.spec.ts`

**Interfaces — Produces:**

```ts
// lib/turnActivity.ts
export interface ActivityRuntime {
  key: string
  turnOpen: boolean
  /** Working is withheld: the turn waits on the person, or the session's turns end by hook and none is open. */
  withheld?: boolean
}
class TurnActivity {
  /** A Working claim reads as an expired one does, now: unknown while a turn is open, idle with none. */
  withdraw(sessionId: string): void
}
// core/turns/activity.ts: TurnActivityDeps gains
withheld?: (sessionId: string) => boolean
/** Work is known to go on with nothing in the transcript: the lead's subagents run. */
atWork?: (sessionId: string) => boolean
```

`observe`: while `withheld`, a progress event other than `turn_started` claims nothing. `activity.ts`: the runtime carries `withheld`; the probe answers `'unknown'` while withheld and `'working'` while at work, in that order, and reads no pane for either.

- [ ] **Step 1: Write the failing tests**

```ts
it('withheld: text, a tool or a subagent\'s end read then claims nothing; a turn\'s start still does', …)
it('withdraw: a Working claim reads unknown at once while its turn is open, idle with none, and an idle one is left', …)
// activity.spec.ts
it('while withheld the probe answers unknown and reads no pane', …)
it('while at work the probe answers working and reads no pane; withheld wins', …)
it('with neither given, the runtime and the probe are today\'s', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/turnActivity.spec.ts src/core/turns/activity.spec.ts`. Expected: FAIL (`withdraw` is not a function).
- [ ] **Step 3: Implement.** `withdraw` shares the expiry's own branch in `entry()`.
- [ ] **Step 4: Run** the same with `$COV --coverage.include=src/core/turns/activity.ts`. Expected: PASS, 100%.
- [ ] **Step 5: Commit** `CLI: the work lease can be withheld, and withdrawn at once`.

### Task 8: The question watcher: a dialog is coming, and the pane is clear

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `cli/src/lib/questionController.ts`
- Test: `cli/src/lib/questionController.spec.ts`

**Interfaces — Produces:**

```ts
export interface QuestionWatcherDeps {
  // …
  /** A hook said this session waits (`awaitDialog`), and two polls in a row since found no dialog: nothing is asked there. */
  onClear?: (sessionId: string) => void
}
class QuestionWatcher {
  /** A hook said a dialog is coming. Reads nothing now: the next poll reads the pane, as every poll does. */
  awaitDialog(sessionId: string): void
}
```

- No pane is read at the hook (Ken, 2026-11-17): the engine draws its dialog after the hook returns, so a read then finds nothing; the question shows at the next 1.5 s poll, as today.
- Since `awaitDialog`: `GONE_TICKS` (2) polls in a row with no dialog call `onClear` once. The count is the existing gone count (`noteGone`, `misses`), taken for a told session with no question announced; one `Set<string>` says which sessions were told. A dialog read drops the session from the set: its close is told as any question's (`onQuestionGone`). A capture that fails is no read. A paused poll (no device, driving an answer) counts nothing. `stop`, `stopAll` and a session never watched forget it.

- [ ] **Step 1: Write the failing tests** (fake timers)

```ts
it('told a dialog is coming, reads nothing until the next poll', async () => {
  const { watcher, capture } = watching(DIALOG)
  watcher.awaitDialog('s1')
  await vi.advanceTimersByTimeAsync(0)
  expect(capture).not.toHaveBeenCalled()
})
it('two polls in a row with no dialog since it was told say the pane is clear, once', async () => {
  const { watcher, onClear } = watching(NO_DIALOG)
  watcher.awaitDialog('s1')
  await vi.advanceTimersByTimeAsync(POLL_MS); expect(onClear).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(POLL_MS); expect(onClear).toHaveBeenCalledExactlyOnceWith('s1')
  await vi.advanceTimersByTimeAsync(POLL_MS * 4); expect(onClear).toHaveBeenCalledTimes(1)
})
it('a dialog read since ends the count: its close is a question\'s close, and nothing is called clear', …)
it('a capture that fails, or a paused poll, is no read', …)
it('not told: polls with no dialog call nothing, as today', …)
it('stop forgets what was told', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/questionController.spec.ts`. Expected: FAIL (`awaitDialog` is not a function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: the question watcher says when a pane a hook said waits shows no dialog`.

### Task 9: Recaps: Finished after 1.5 s of quiet

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `cli/src/lib/agentNotifications.ts`, `cli/src/lib/commander.ts`
- Test: `cli/src/lib/agentNotifications.spec.ts`, `cli/src/lib/commanderNotifications.spec.ts`

**Interfaces — Produces:**

```ts
// lib/agentNotifications.ts
export const DONE_QUIET_MS = 1_500
class AgentNotifications {
  /** The turn ended now: its done notification is decided DONE_QUIET_MS from here. */
  ended(sessionId: string): void
  /**
   * Decide the ended turn's notification. `tell` is called once: when the quiet window ends, or at once when it
   * already has; with null at once when the session's next turn starts first. Never for a session forgotten first.
   */
  decide(sessionId: string, result: string, silent: boolean, tell: (notification: AgentNotification | null) => void): void
}
// `completed` goes: `decide` is the one way.
```

- A wait inside the window is the recaps' own `asked`: at the window's end the answer is null, as `completed` answered today. No new message from the core.
- `commander.ts`: `ended` is called where a live, not aborted `turn_ended` is taken in `ingest`. In `startSummary`, the block that reads the notification (the `summary` card, `turn_summary`, the tier) runs inside `decide`'s `tell`. The `done` card stays where it is. `started` is already called before the next turn's first card, so a dropped notification's recap still lands before it.

- [ ] **Step 1: Write the failing tests** (fake timers)

```ts
it('decides done 1.5 s after the turn ended, not before', () => {
  const policy = new AgentNotifications(); const tell = vi.fn()
  policy.started('s'); policy.ended('s'); policy.decide('s', 'Finished.', false, tell)
  vi.advanceTimersByTime(1_499); expect(tell).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1); expect(tell).toHaveBeenCalledExactlyOnceWith({ id: expect.any(String), kind: 'done' })
})
it('a result that came after the window is decided at once', …)
it('the next turn opening inside the window drops it: told null at once, and never again', …)
it('a question asked inside the window drops it', …)
it('a cancelled turn tells null; a forgotten session tells nothing', …)
it('once a live turn; a replay, an empty result and a subagent\'s tell null', …)   // today's cases, through decide
// commanderNotifications.spec.ts
it('the dial\'s summary card and the apps\' turn_summary carry the notification only once 1.5 s have passed', …)
it('a /goal pass that opens inside the window: the recap is told silent before the next pass\'s Processing card, and nothing rings', …)
it('an aborted turn announces nothing', …)   // today's case stays green
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/agentNotifications.spec.ts src/lib/commanderNotifications.spec.ts`. Expected: FAIL (`ended` is not a function).
- [ ] **Step 3: Implement.** One timer a session with a decision pending, unref'd, cleared by `started` and `forget`.
- [ ] **Step 4: Run** the same and `npx vitest run src/lib/commander.spec.ts src/services/recaps.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Recaps: Finished is decided after 1.5 s of quiet`.

### Task 10: Hook server: wait and subagent routes

**Depends on:** none. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/hookServer.ts`
- Test: `cli/src/hookServer.spec.ts`

**Interfaces — Produces:**

```ts
// HookServerHandlers gains
/** The engine waits on the person: a permission, a question. */
onWait?: (body: { sessionId: string; firedAt?: number }) => void
/** A subagent of the session started, or stopped. */
onSubagent?: (body: { sessionId: string; started: boolean }) => void
```

- `POST /api/hook/wait`, `/api/hook/subagent`, each as `/api/hook/turn-start` is: the hook token (401), `validHookBody` (400), `verifiedBoundMutation` (403 `UNBOUND_HOOK`), then the handler and `200 { ok: true }`. `firedAt` is `hookFiredAt(req)`.
- `/api/hook/subagent` reads `hookEvent`: `SubagentStart` or `SubagentStop`, anything else 400. `/api/hook/wait` refuses a body with `input` or `prompt` (400).
- Codex's Interrupt needs no route: it is a `/api/hook/turn-stop` with `status: 'interrupted'`, which that route already takes and hands on as it is (Task 16 reads it).
- An unbound hook on these two and on `/api/hook/turn-stop` is logged once a session: `[hooks] <sid> <route> refused · unbound`. The set holds at most 512 session ids, the oldest dropped.

- [ ] **Step 1: Write the failing tests.** The two existing tables, `rejects a forged bound-session mutation on %s` and `refuses a binding changed during process resolution on %s`, gain the two routes. New:

```ts
it('hands a wait on with when its engine ran it', …)                              // x-harness-hook-fired-at → firedAt
it('a subagent hook says started or stopped by its event, and any other event is refused', …)
it('refuses a wait that carries a tool\'s input or a prompt', …)
it('says an unbound hook once a session, and answers each one 403', …)
it('needs the hook token on each', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/hookServer.spec.ts`. Expected: FAIL (404).
- [ ] **Step 3: Implement.** One helper reads, checks and binds the body for the two.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: hook routes for a wait and a subagent`.

### Task 11: Ingest: a read's time, end and turn go on with its events

**Depends on:** 6. **Effort:** medium.

**Files:**
- Modify: `cli/src/core/transcripts/ingest.ts`
- Test: `cli/src/core/transcripts/ingest.spec.ts`

**Interfaces — Consumes:** `LiveRead.at`, `LiveRead.over`, `LiveFrame.at`, `LiveFrame.over` (Task 6). **Produces:**

```ts
/** What a transcript read says beside its events. */
export interface TranscriptRead { replay?: boolean; at?: number; over?: true; turn?: LiveTurn }
// IngestDeps
emit: (sessionId: string, events: LiveEvent[], read?: TranscriptRead) => void
```

`acceptFrame` passes the frame's `replay`, `at`, `over` and `turn`. The watcher's live `line` passes the parser's `at` and `over` and its snapshot after the line. A history batch passes `{ replay: true }`; `acceptStreamFrame` is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it('hands a worker frame\'s time, own end and turn on with its events', …)
it('hands a live line\'s on, with the parser\'s turn after it', …)
it('a history batch and another engine\'s frame say neither', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/transcripts/ingest.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same with `$COV --coverage.include=src/core/transcripts/ingest.ts`. Expected: PASS, 100%.
- [ ] **Step 5: Commit** `CLI: a transcript read's time and turn reach the funnel's caller`.

### Task 12: Installer: prune Harness's blocks from undeclared events

**Depends on:** none. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/engines/kit/notifyHooks.ts`, `cli/src/engines/kit/hookRemoval.ts`, `cli/src/engines/kit/hookSettings.ts`, `cli/src/engines/kit/hookReview.ts`
- Test: `cli/src/engines/kit/hookSettings.spec.ts`, `cli/src/engines/kit/hookReview.spec.ts`; `cli/src/engines/kit/hookRemoval.spec.ts` stays green
- Record again only if a case's output changes, and say so in the commit: `cli/src/engines/__fixtures__/hook-installers.golden.json`

**Interfaces — Produces:**

```ts
// engines/kit/notifyHooks.ts: the walk hookRemoval.ts does today, in a file the core already loads
/** Our hooks out of the events `of` takes: a shared block keeps its other hooks, an emptied event leaves the object. How many went. */
export function withoutOwnHooks(events: Record<string, unknown>, owns: (block: HookBlock) => boolean, of: (event: string) => boolean): number
// engines/kit/hookReview.ts
prepareReviewed(record, home, settingsFile, settings, platform?, pruned?: Settings)   // `pruned`: the blocks taken out, as they were
```

- `withoutHarnessHooks` (uninstall) calls `withoutOwnHooks` for its nested schema: one walk.
- `installNotifyHooks`, after its declared events: `withoutOwnHooks(current.hooks, isOurs, event => !declared.has(event))`. Anything gone is a change to write. Agent Messages' block is not `isOurs` and stays.
- With `settings.reviewed`: the records of the pruned hooks (`reviewRecords` of `pruned`) go through `withoutReviewRecords`, in the same publish as the records added. A label stays in `reviewed.events` after its event leaves `settings.events`, so its records can be found.

- [ ] **Step 1: Write the failing tests**

```ts
it('takes Harness\'s block out of an event its engine no longer declares, and leaves the person\'s', async () => {
  // settings: PreCompact: [ours, theirs], SubagentStop: [ours]; the contract declares SessionStart alone
  // after: PreCompact is [theirs], SubagentStop is gone, SessionStart holds one block of ours, every other key is as it was
})
it('a second install writes nothing', …)                                  // the same bytes and inode
it('leaves Agent Messages\' block where it is', …)
it('Codex: the review record of a pruned hook goes with it, and the others stay', …)
it('on Windows, prunes the forms Harness writes there', …)                // platform 'win32'
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/engines/kit/hookSettings.spec.ts src/engines/kit/hookReview.spec.ts`. Expected: FAIL (the blocks stay).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/engines/kit src/engines/hookInstallers.golden.spec.ts src/engines/removeHooks.spec.ts src/architecture.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: the hook installer takes its blocks out of events no longer declared`.

### Task 13: `notify.mjs`: the new events

**Depends on:** 1, 2. **Effort:** high.

**Files:**
- Modify: `cli/hook/notify.mjs`
- Test: `cli/src/hookNotify.spec.ts`

In a pane, after the engine guards and before the registration that ends `main()`. Every body is `{ sessionId, hookEvent, ...mutationFields }`; a wait's has `toolName` too.

| Engine | Event | Posts |
|---|---|---|
| Claude Code | PreToolUse, `tool_name` `AskUserQuestion` | `/api/hook/wait` |
| Claude Code, Variant N | Notification of `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog` | `/api/hook/wait` |
| Claude Code, Variant P | PermissionRequest, Elicitation (Notification in a pane posts nothing, as today) | `/api/hook/wait` |
| Codex | PermissionRequest; PreToolUse, `tool_name` `request_user_input` | `/api/hook/wait` |
| Codex | Stop | `/api/hook/turn-stop` |
| Codex | Interrupt | `/api/hook/turn-stop`, `status: 'interrupted'` |
| Claude Code | SubagentStart, SubagentStop | `/api/hook/subagent`, with the lead's session id |

- A PreToolUse for any other tool posts nothing: a matcher edited by hand must not turn each tool call into a request.
- Codex runs PermissionRequest and PreToolUse before its dialog and waits for them, and reads an empty stdout with exit 0 as no decision (facts-codex §2): for every Codex event the hook writes nothing on stdout and exits 0, whatever the post's answer, a failed or timed-out post included. Its time delays the dialog, so the wait's post is as bounded as today's posts (the 4.5 s budget). Codex's Interrupt is killed at 3 s: a post cut short there leaves the turn to the transcript's `turn_aborted` (R1.2).
- Outside a pane none of the new events posts anything, Codex's Stop included (Ken, 2026-11-17): the devices see exactly what they see today, so the dial does not sound at every Codex turn. `observedEvent` returns null for Codex's Stop; Claude Code's Stop and every event outside a pane today post as they do.
- A Codex child thread's own hooks still post nothing (`isCodexSubagent`), as today. Codex has no subagent hooks installed (Ken, 2026-11-17), so Task 2's finding on Codex's SubagentStart and `isCodexSubagent` does not apply.

- [ ] **Step 1: Write the failing tests** (`runHook`, `collect`)

```ts
it.each([
  ['claude', 'PreToolUse', 'AskUserQuestion'], ['codex', 'PermissionRequest', 'exec_command'], ['codex', 'PreToolUse', 'request_user_input'],
] as const)('%s %s in a pane posts a wait with the event and the tool\'s name, and none of its input', async (engine, event, tool) => {
  const { port, requests } = await collect()
  await runHook({ port, engine, tmuxPane: '%4', input: { hook_event_name: event, session_id: 'sess-1', tool_name: tool, tool_input: { command: 'input-secret' } } })
  expect(requests.map((request) => request.url)).toEqual(['/api/hook/wait'])
  expect(requests[0].body).toMatchObject({ engine, sessionId: 'sess-1', hookEvent: event, toolName: tool })
  expect(JSON.stringify(requests[0].body)).not.toContain('input-secret')
})
it('a PreToolUse for any other tool posts nothing', …)
it('Claude Code\'s permission and elicitation waits post a wait', …)       // the events of Task 1's verdict
it('codex Stop in a pane posts turn-stop; codex Interrupt posts turn-stop with status interrupted', …)
it('claude SubagentStart and SubagentStop post /api/hook/subagent with the lead\'s session', …)
it('writes nothing on stdout and exits 0 for each new event', …)
it.each(['PermissionRequest', 'PreToolUse'])('codex %s: nothing on stdout and exit 0 when the daemon answers 403, 500 or never', …)   // Codex reads it as no decision
it('outside a pane, a codex Stop posts nothing', async () => {
  const { port, requests } = await collect()
  await runHook({ port, engine: 'codex', input: { hook_event_name: 'Stop', session_id: 'sess-1', turn_id: 't1' } })   // no tmuxPane
  expect(requests).toEqual([])
})
it.each(NEW_EVENTS)('outside a pane, %s %s posts nothing', …)             // every row of the table above, engine by engine
it('outside a pane, claude Stop still tells the devices turn-stop', …)   // today's behaviour, kept
it('a Codex child thread\'s hooks still post nothing', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/hookNotify.spec.ts`. Expected: FAIL (they post `/api/hook/session-start`, and the paneless Codex Stop posts `/api/hook/observed`).
- [ ] **Step 3: Implement** the table. The comment over the Notification guard says what Task 1 found.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `Hook: waits, Codex's Stop and Interrupt, and Claude Code's subagents reach the daemon from a pane`.

### Task 14: Fake engines: the new events

**Depends on:** 1, 2. **Effort:** high. **Failing test:** none: test tooling; one commit.

**Files:**
- Modify: `cli/e2e/harness/fakeEngine.mjs`, `cli/e2e/harness/daemon.ts` (the config's type)

As the facts files say the real CLIs do; where they differ from the lines below, the facts win.

- `HOOK_EVENTS`: Claude Code gains PreToolUse, SubagentStart, SubagentStop, and under Variant P PermissionRequest and Elicitation; Codex gains Stop, PermissionRequest, PreToolUse, Interrupt (no subagent events: Harness installs none for Codex).
- `runHooks` honours a block's matcher for PreToolUse (the tool's name) and Notification (its type), as it does SessionStart's.
- `!ask`, `!askmany`: PreToolUse (`AskUserQuestion`; Codex `request_user_input`), waited for, then the dialog.
- `!permit`, `!permitnext`: PermissionRequest (Codex; Claude Code under Variant P), waited for, then the dialog. Claude Code's Notification after 6 s stays.
- Codex: Stop after each finished turn's last record, waited for, none after an interrupt or an error; Interrupt when Esc or Ctrl-C ends a turn, waited for, before its `turn_aborted` record (facts-codex §2).
- `!fail` (Codex): the turn ends with a `task_complete` carrying an `error`, as `codexTaskError` reads it, and no Stop.
- `!spawn` and the background sub-agent (Claude Code): SubagentStart as the child starts and SubagentStop as it ends.
- Config `withoutHooks: string[]`: the events this release does not have.
- `!heldstop`: the turn's Stop reaches the daemon only once the test writes `held-stop.release` (`hookHeld`, as `!latestop` holds one).
- Each interrupt key it takes is noted in `interrupts` under the test's root, with its pid.
- The header's list of directives and events says all of this.

- [ ] **Step 1: Add it.**
- [ ] **Step 2: Run** `cd cli && E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/turns.e2e.ts e2e/questions.e2e.ts e2e/subagents.e2e.ts`. Expected: PASS (the daemon installs none of the new events yet, so the fakes run none).
- [ ] **Step 3: Commit** `Tests: the fake engines run the hooks for waits, ends and subagents`.

### Task 15: Turn ends by hook: the held end and the Stop

**Depends on:** 7, 11. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/core/turns/turnHooks.ts`, `cli/src/engines/kit/stopHook.ts`, `cli/src/engines/facets/hooks.ts`, `cli/src/core/transcripts/normalizers.ts`, `cli/src/engines/codex/hookContract.ts` (`stopClosesTurns: true`, and the comment that Codex has no Stop goes), `cli/src/core/main.ts`
- Test: `cli/src/core/turns/turnHooks.spec.ts`, `cli/src/core/transcripts/normalizers.spec.ts`, `cli/src/engines/hooks.spec.ts` (its existing `onStop` call passes the context's new members)

**Interfaces — Consumes:** `TranscriptRead` (Task 11); `withheld` of `createTurnActivity` (Task 7). **Produces:**

```ts
// core/turns/turnHooks.ts
export const HOOKS_KEPT = 512
/** What a session's hooks have said of its turn. One a session. */
interface HookTurn {
  promptAt: number
  endsByHook: boolean
  held: { identity?: string; openedAt?: number; at: number } | null
  awaiting: Array<(held: boolean) => void>
  hookAt: number
}
// createTurnHooks returns, beside today's four:
/** Every transcript read of a session, on its way to the funnel: createIngest's `emit`. */
transcript(sessionId: string, events: LiveEvent[], read?: TranscriptRead): void
/** The turn's own end is read and held for its Stop: the turn is still open. */
held(sessionId: string): boolean
/** The turn was closed without its end (a cancel): what is held goes, unsent. */
closed(sessionId: string): void
forget(sessionId: string): void
/** lib/turnActivity.ts: its turns end by hook, none is open and none is held. */
withheld(sessionId: string): boolean
export type TurnHooks = ReturnType<typeof createTurnHooks>
// TurnHookDeps.emit takes the funnel's third argument: (sessionId, events, opts?: { replay?: boolean }) => void

// engines/facets/hooks.ts: HookTurnContext gains
heldEnd(sessionId: string): { identity?: string; openedAt?: number } | undefined
/** True once an end is held, at once when one is; false after `ms`. */
heldEndWithin(sessionId: string, ms: number): Promise<boolean>
/** The held end goes to the funnel. False when none is held. */
deliverHeldEnd(sessionId: string): boolean

// core/transcripts/normalizers.ts
createSessionNormalizers(others, turns?: Pick<TurnHooks, 'held' | 'closed' | 'forget'>)
```

- `transcript` is R1. A session with no record gets one map lookup, and `emit` gets the caller's own array. `emit` is called with two arguments, and with a third, `{ replay: true }`, for a replay.
- `onTurnStop`, for an engine whose hooks have `onStop` (now Claude Code and Codex): the record is marked `endsByHook` and `hookAt` set before `onStop` is called. The stale-evidence shortcut in `current()` holds for every such engine, not Claude Code alone.
- `closeTurnOnStop` is R2. `leftToTranscript` goes. Its log lines stay.
- `normalizers`: `sessionTurnState` is true while `turns.held`; `closeTurns` calls `turns.closed`; `forget` calls `turns.forget`.
- `main.ts`: `createIngest`'s `emit` is `turnHooks.transcript`; `createTurnHooks`' `emit` passes the third argument; `createSessionNormalizers` and `createTurnActivity`, built before it, reach it through one `let` reference, as `stoppingReaderSession` is reached.

- [ ] **Step 1: Write the failing tests** (fake timers; `describe.each(['claude', 'codex'])`). Helpers beside the spec's own `setup`, `setState`, `END` and `ABORT`: `hookDriven(engine)`, a `setup` whose session has sent one Stop, with `emit` cleared; `turnOf(identity, openedAt?)`, a closed `LiveTurn`; `openTurn()`, a `TurnState` with a turn open; `START`, `TEXT` and `TOOL_START`, one-event arrays.

```ts
it('an engine that has sent no Stop (one older than the event, or its first turn): every read goes on as it came, the same array', () => {
  const { deps, hooks } = setup(engine)
  hooks.transcript('s1', END, { turn: turnOf('t1') })
  expect(vi.mocked(deps.emit).mock.calls).toEqual([['s1', END]])
  expect(vi.mocked(deps.emit).mock.calls[0][1]).toBe(END)
  expect(hooks.held('s1')).toBe(false)
})
it('a normal turn: its end is read and held, the turn reads open, and its Stop delivers it once', async () => {
  const run = await hookDriven(engine)
  run.hooks.transcript('s1', [...TEXT, ...END], { turn: turnOf('t1') })
  expect(vi.mocked(run.deps.emit).mock.calls).toEqual([['s1', TEXT]])
  expect(run.hooks.held('s1')).toBe(true)
  run.hooks.onTurnStop({ sessionId: 's1' })
  await vi.advanceTimersByTimeAsync(0)
  expect(run.deps.emit).toHaveBeenLastCalledWith('s1', END)
  expect(run.hooks.held('s1')).toBe(false)
})
it('final text after Stop: the Stop waits for the end and delivers it the moment it is read, not at 1.5 s', async () => {
  const run = await hookDriven(engine)
  setState(run, openTurn())
  run.hooks.onTurnStop({ sessionId: 's1' })
  await vi.advanceTimersByTimeAsync(200)
  run.hooks.transcript('s1', END, { turn: turnOf('t1') })
  await vi.advanceTimersByTimeAsync(0)
  expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
  await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
  expect(run.deps.emit).toHaveBeenCalledTimes(1)
})
it('no end within 1.5 s: the Stop closes the turn itself, as before', …)
it('a next prompt read while an end is held: the held end, then the start, in one batch', async () => {   // Review Focus 1
  const run = await hookDriven(engine)
  run.hooks.transcript('s1', END, { turn: turnOf('t1') })
  run.hooks.transcript('s1', START, { turn: turnOf('t2') })
  expect(run.deps.emit).toHaveBeenLastCalledWith('s1', [...END, ...START])
})
it('an aborted end, and an end the engine marked over, are never held', …)
it('a replay goes on untouched; one with a turn\'s start or end drops what was held', …)
it('a stale Stop, run before the latest prompt hook, delivers and closes nothing', …)
it('a Stop run before the turn opened delivers and closes nothing', …)                 // Review Focus 5
it('a continued /goal pass is closed by its own Stop', …)                              // claude
it('StopFailure closes whichever turn is open or held', …)
it('a Stop heard twice, or two at once, ends the turn once', …)                        // Review Focus 2
it('a cancel drops the held end unsent, a forgotten session\'s record is gone, and a Stop then waiting sends nothing', …)   // Review Focus 3
it('the 513th session\'s record takes the oldest one\'s place, whose held end is delivered first', …)
it('withheld: its turns end by hook, none is open and none is held', …)
// normalizers.spec.ts
it('reads a turn as open while its end is held, whatever the parser says', …)
it('a cancel tells the turn hooks it closed; forgetting a session forgets its record', …)
// engines/hooks.spec.ts
it('Codex\'s Stop closes its turns too', () => { expect(Object.keys(engineHooks.codex).sort()).toContain('onStop') })
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/turns/turnHooks.spec.ts src/core/transcripts/normalizers.spec.ts src/engines/hooks.spec.ts`. Expected: FAIL (`transcript` is not a function).
- [ ] **Step 3: Implement** the interfaces and R0, R1, R2, R7. Each rule that came from a run keeps the comment that names the run.
- [ ] **Step 4: Run** the same with `$COV --coverage.include=src/core/turns/turnHooks.ts --coverage.include=src/core/transcripts/normalizers.ts`, then `npx vitest run src/architecture.spec.ts` and `npm run typecheck`. Expected: PASS, 100%.
- [ ] **Step 5: Commit** `CLI: a Claude Code or Codex turn ends at its Stop, not when its transcript ends`.

### Task 16: Codex Interrupt

**Depends on:** 15. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/core/turns/turnHooks.ts`
- Test: `cli/src/core/turns/turnHooks.spec.ts`

**Interfaces — Consumes:** `onTurnStop` and the record (Task 15). **Produces:** nothing new: `onTurnStop({ sessionId, status: 'interrupted', firedAt? })` is R3. The route is today's `/api/hook/turn-stop` (Task 13 posts it), so no handler is added and `core/main.ts` does not change.

R3. Only for an engine whose hooks have `onStop`. It marks the record as a Stop does. It closes through the existing `closeTurn(sessionId, identity)` and `emit`, and reaches no input: `createTurnHooks` has none. It closes before the route answers: Codex runs Interrupt after the interrupted-turn marker and before it writes `turn_aborted`, and waits for the hook up to 3 s (facts-codex §2), so the close comes first and the parser, closed, emits nothing for that `turn_aborted` (Task 5: an abort with no turn open ends nothing). A hook Codex kills at 3 s leaves the turn to `turn_aborted` (R1.2), as before. `cancel.ts` is not touched (Ken, 2026-11-17): no key is sent, so the engine never gets a second Ctrl-C.

- [ ] **Step 1: Write the failing tests**

```ts
it('an interrupt ends the open turn as aborted at once: no drain, no wait', async () => {
  const run = setup('codex'); setState(run, openTurn())
  run.hooks.onTurnStop({ sessionId: 's1', status: 'interrupted' })
  expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', ABORT)
  expect(run.deps.drain).not.toHaveBeenCalled()
})
it('with no turn open (the app cancelled it, or its abort was read first) says nothing', …)
it('the transcript\'s turn_aborted, read after the interrupt closed the turn, sends nothing more', …)   // Codex writes it only after the hook returns
it('run before the latest prompt hook, or before the open turn opened, closes nothing', …)   // Review Focus 5
it('makes the session\'s turns end by hook', …)
it('leaves an end that is held as it is', …)
it('an engine with no turn hooks, or a session it does not know, is left alone', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/turns/turnHooks.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same with `$COV --coverage.include=src/core/turns/turnHooks.ts`. Expected: PASS, 100%.
- [ ] **Step 5: Commit** `Codex: an interrupt in the pane ends the turn quietly, with no key from Harness`.

### Task 17: Hook silence

**Depends on:** 15. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/core/turns/turnHooks.ts`, `cli/src/core/turns/heartbeats.ts`, `cli/src/core/main.ts`
- Test: `cli/src/core/turns/turnHooks.spec.ts`, `cli/src/core/turns/heartbeats.spec.ts`

**Interfaces — Produces:**

```ts
export const HOOK_SILENCE_MS = 120_000
/** The open turn's heartbeat: what a hook that never came leaves is settled here. */
beat(sessionId: string): void
// core/turns/heartbeats.ts: HeartbeatDeps gains  turns: Pick<TurnHooks, 'beat'>
```

R6. Each beat of an active session calls `turns.beat` first. The line: `[turn] <sid> ended by its transcript · no Stop in 2 min`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a missing Stop: the held end is delivered at the first beat 2 minutes after it was read, with one line', async () => {
  const run = await hookDriven('claude')
  run.hooks.transcript('s1', END, { turn: turnOf('t1') })
  vi.advanceTimersByTime(HOOK_SILENCE_MS - 1); run.hooks.beat('s1')
  expect(run.deps.emit).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1); run.hooks.beat('s1')
  expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
})
it('a hook in between starts the 2 minutes again', …)
it('nothing held, or a session with no record: a beat does nothing', …)
// heartbeats.spec.ts
it('each beat of an active session tells the turn hooks first', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/turns/turnHooks.spec.ts src/core/turns/heartbeats.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `main.ts`: `turns` in `createHeartbeats`, through the same reference.
- [ ] **Step 4: Run** the same with `$COV --coverage.include=src/core/turns/turnHooks.ts --coverage.include=src/core/turns/heartbeats.ts`. Expected: PASS, 100%.
- [ ] **Step 5: Commit** `CLI: a turn whose Stop never came ends by its transcript after 2 minutes`.

### Task 18: Waits

**Depends on:** 8, 10, 15. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/core/turns/turnHooks.ts`, `cli/src/core/questions.ts`, `cli/src/core/main.ts`
- Test: `cli/src/core/turns/turnHooks.spec.ts`, `cli/src/core/questions.spec.ts`

**Interfaces — Consumes:** `TurnActivity.withdraw` (Task 7); `QuestionWatcher.awaitDialog`, `onClear` (Task 8); `HookServerHandlers.onWait` (Task 10); `TranscriptRead.at` (Task 11). **Produces:**

```ts
// HookTurn gains  waitAt: number | null
// TurnHookDeps gains
turnActivity: Pick<TurnActivity, 'withdraw' | 'snapshot'>
clients: { send(frame: ReturnType<typeof correlateAgentEvent>): void }
agentIdFor: (sessionId: string) => string
/** QuestionWatcher.awaitDialog: no pane is read at the hook. */
awaitDialog: (sessionId: string) => void
// createTurnHooks returns also
onWait(body: { sessionId: string; firedAt?: number }): void
/** The watcher: a question closed, or the pane read clear. */
waitOver(sessionId: string): void
// withheld(sessionId) is also true while a wait is open
// core/questions.ts: QuestionDeps gains  waitOver: (sessionId: string) => void
```

R4. `onWait` needs no turn to end by hook: a session's first turn waits the same way. It sets `hookAt`. The frame it sends is cancel.ts's `agent_activity`. `questions.ts` calls `waitOver` from `onQuestionGone` and from the watcher's `onClear`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a permission wait: Working is withdrawn and told at once, and the watcher is told a dialog is coming', () => {
  const run = setup('claude')
  run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
  expect(run.deps.turnActivity.withdraw).toHaveBeenCalledWith('s1')
  expect(run.deps.clients.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_activity' }))
  expect(run.deps.awaitDialog).toHaveBeenCalledWith('s1')
  expect(run.hooks.withheld('s1')).toBe(true)
})
it('the waited tool\'s own start, read later with an earlier time, does not end the wait', () => {
  const run = setup('claude'); run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
  run.hooks.transcript('s1', TOOL_START, { at: 4_900 })
  expect(run.hooks.withheld('s1')).toBe(true)
})
it('progress written after the hook ends it', …)                         // { at: 5_001 }
it('a read with no time ends nothing', …)
it('a subagent\'s progress never ends it', …)                            // parentToolUseId; subagent_finished
it('the watcher ends it: a question closed, or two polls read the pane clear', …)  // Review Focus 4
it('a turn\'s end, an aborted one too, and the next turn\'s start end it', …)
it('a wait hook run before the latest prompt hook opens nothing', …)
it('an agent the lease no longer knows is told nothing', …)
// questions.spec.ts
it('tells the turn hooks when a question closes and when the pane reads clear', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/turns/turnHooks.spec.ts src/core/questions.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `main.ts`: the four dependencies, `waitOver` to `createQuestions`, `onWait: turnHooks.onWait`. `questions.ts` hands the watcher's `onClear` to `waitOver`.
- [ ] **Step 4: Run** the same with `$COV --coverage.include=src/core/turns/turnHooks.ts --coverage.include=src/core/questions.ts`. Expected: PASS, 100%.
- [ ] **Step 5: Commit** `CLI: an agent waiting on the person stops reading as working at its hook`.

### Task 19: Subagents

**Depends on:** 10, 15, 17. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/core/turns/turnHooks.ts`, `cli/src/engines/kit/stopHook.ts`, `cli/src/engines/facets/hooks.ts`, `cli/src/core/main.ts`
- Test: `cli/src/core/turns/turnHooks.spec.ts`

**Interfaces — Consumes:** `beat` (Task 17); `atWork` of `createTurnActivity` (Task 7); `HookServerHandlers.onSubagent` (Task 10). **Produces:**

```ts
export const SUBAGENTS_MAX = 64
export const SUBAGENT_TIMEOUT_MS = 600_000
// HookTurn gains  subagents: number; progressAt: number
// createTurnHooks returns also
onSubagent(body: { sessionId: string; started: boolean }): void
/** lib/turnActivity.ts: the lead's subagents run. */
atWork(sessionId: string): boolean
// engines/facets/hooks.ts: HookTurnContext gains
/** Subagents of the session run: a Stop leaves its turn open. */
subagentsRun(sessionId: string): boolean
/** The held end was read before an earlier hook of its turn: what the lead wrote since lands after this Stop. */
heldBeforeHook: boolean
```

R5, and R6's last sentence. Claude Code only: Codex installs no subagent hooks (Task 20), so no Codex session's count leaves 0 and its Stop is never held for a subagent; the core adds no engine check for it. `onSubagent` sets `hookAt`. `onPromptHook` sets the count to 0. `transcript` sets `progressAt` on a progress event. `heldBeforeHook` is taken in `onTurnStop` before `hookAt` is set. The lines: `[turn] <sid> subagent not counted · 64 running`, `[turn] <sid> subagent count reset · no hook or progress in 10 min`, `[turn] <sid> Stop left its turn open · subagents run`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a background subagent: the lead\'s Stop leaves its turn open while one runs, and its first Stop after the last one stops ends it', async () => {
  const run = await hookDriven('claude')
  run.hooks.onSubagent({ sessionId: 's1', started: true })
  run.hooks.transcript('s1', END, { turn: turnOf('t1') })
  run.hooks.onTurnStop({ sessionId: 's1' }); await vi.runAllTimersAsync()
  expect(run.deps.emit).not.toHaveBeenCalled()
  expect(run.hooks.held('s1')).toBe(true)
  run.hooks.onSubagent({ sessionId: 's1', started: false })
  run.hooks.onTurnStop({ sessionId: 's1' }); await vi.runAllTimersAsync()
  expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
})
it('that last Stop waits 1.5 s and drains again before it delivers', …)       // nothing at 1 499 ms; drain called twice
it('a stop with none running stays at zero; the 65th start is not counted, said once', …)
it('a prompt hook sets it to zero', …)
it('10 minutes with no hook and no progress: zero, one line, and the held end is delivered', …)
it('progress or a hook inside the 10 minutes starts them again', …)
it('2 minutes of silence do not end a turn whose subagents run', …)
it('a StopFailure ends the turn whatever runs', …)
it('atWork while any runs', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/turns/turnHooks.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `main.ts`: `onSubagent: turnHooks.onSubagent`, and `atWork` to `createTurnActivity`.
- [ ] **Step 4: Run** the same with `$COV --coverage.include=src/core/turns/turnHooks.ts`, and `npm run typecheck`. Expected: PASS, 100%.
- [ ] **Step 5: Commit** `CLI: a Claude Code lead stays working while its subagents run`.

### Task 20: Codex: events, labels and hashes

**Depends on:** 2. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/engines/codex/hookContract.ts`, `cli/src/engines/facets/hooks.ts` (`HookSettings.events`' type), `cli/src/engines/kit/hookSettings.ts` (the line that writes our block)
- Test: `cli/src/engines/kit/hookSettings.spec.ts`, `cli/src/engines/kit/hookReview.spec.ts`, `cli/src/engines/kit/windowsHooks.spec.ts`, `cli/src/engines/hooks.spec.ts`, `cli/src/engines/hookInstallers.golden.spec.ts` (its `EVENTS`), `cli/src/engines/__fixtures__/hook-installers.golden.json` (recorded again)

**Interfaces — Produces:**

```ts
// engines/facets/hooks.ts, HookSettings
/** One block of ours per event, in this order, with a matcher only where the engine honours one. */
events: ReadonlyArray<{ event: string; matcher?: string; /** Seconds, where this event's own differs from `timeout`. */ timeout?: number }>
// engines/kit/hookSettings.ts: our block's hook is written with `timeout ?? settings.timeout`
```

- `settings.events`: Global Constraints' Codex list, in that order: `{ event: 'Interrupt', timeout: 3 }` (Ken, 2026-11-17: Codex gives Interrupt and SessionEnd a cap of 3 s and hashes the capped value, `normalize_command_hook`, facts-codex §1; a 5 s entry never matches its record and warns at every session start). No SubagentStart or SubagentStop (Ken, 2026-11-17).
- The review records need no change: `reviewRecords` hashes the timeout each hook in the file carries.
- No release wrote an Interrupt block, so no block of ours is found with another timeout; the up-to-date check stays the command's and the matcher's.
- `reviewed.events` gains `Stop: 'stop'`, `PermissionRequest: 'permission_request'`, `PreToolUse: 'pre_tool_use'`, `Interrupt: 'interrupt'`; `matcherEvents` is `['SessionStart', 'PreToolUse']`.
- `messages.current` and `installed` say `Codex session and turn hooks`. The comment over `reviewed` names the Codex the hashes were matched against (codex-cli 0.169.0, `hooks/list`, facts-codex §1), and the comment over Interrupt says why 3.

- [ ] **Step 1: Write the failing tests**

```ts
// The four hashes Task 2 read from the real Codex's `hooks/list` (codex-cli 0.169.0, facts-codex §1), as CODEX_0_162 is kept today.
const CODEX_0_169 = {
  stop: 'sha256:51ccf08c5abb298e3640ad1aa2a6d97a1e4c9aa50bf54769012a5f48e9819103',
  permission_request: 'sha256:dea5f4e595e43e7116728901dbcbd71915be5be2b4159916d43d06d125ebe833',
  pre_tool_use: 'sha256:6759b736f953bcb9cc9a47f366def174a2a3bf0394cc456d07494d3700dfc852',
  interrupt: 'sha256:6168570fe3ae52db10c67e1abfa5d8743900a146979b56191e5c9a7e5f737d72',   // Codex lists it with timeoutSec 3
}
it('hashes each new hook exactly as the targeted Codex does', () => {
  expect(reviewHash(record, 'Stop', undefined, { command: COMMAND, timeout: 5 })).toBe(CODEX_0_169.stop)
  expect(reviewHash(record, 'PermissionRequest', undefined, { command: COMMAND, timeout: 5 })).toBe(CODEX_0_169.permission_request)
  expect(reviewHash(record, 'PreToolUse', 'request_user_input', { command: COMMAND, timeout: 5 })).toBe(CODEX_0_169.pre_tool_use)
  expect(reviewHash(record, 'PreToolUse', 'other', { command: COMMAND, timeout: 5 })).not.toBe(CODEX_0_169.pre_tool_use)
  expect(reviewHash(record, 'Interrupt', undefined, { command: COMMAND, timeout: 3 })).toBe(CODEX_0_169.interrupt)
  expect(reviewHash(record, 'Interrupt', undefined, { command: COMMAND, timeout: 5 })).not.toBe(CODEX_0_169.interrupt)   // why 3
})
it('installs every declared event, Interrupt with a 3 s timeout, and records each as reviewed with the hash the targeted Codex lists', …)   // 6 notify records and Agent Messages' one; Interrupt's record is CODEX_0_169.interrupt
// 'keys only Harness's blocks': its Stop block is now keyed
// hookSettings.spec.ts
it('writes a declared event\'s own timeout in place of the contract\'s, and the contract\'s for the others', …)
// windowsHooks.spec.ts
it('writes every Codex event the one PowerShell line, PreToolUse with its matcher, Interrupt with timeout 3', …)
// engines/hooks.spec.ts
it('declares Codex\'s events, and no subagent event', () => { expect(hookContracts.codex.settings.events).toEqual([
  { event: 'SessionStart', matcher: 'startup|resume|clear|compact' }, { event: 'UserPromptSubmit' }, { event: 'Stop' },
  { event: 'PermissionRequest' }, { event: 'PreToolUse', matcher: 'request_user_input' }, { event: 'Interrupt', timeout: 3 }]) })
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/engines/kit/hookSettings.spec.ts src/engines/kit/hookReview.spec.ts src/engines/kit/windowsHooks.spec.ts src/engines/hooks.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the type, the one write in `hookSettings.ts`, and the contract. Then `RECORD_HOOK_GOLDEN=1 npx vitest run src/engines/hookInstallers.golden.spec.ts`, and read the fixture's diff: only the new events (Interrupt with `timeout: 3`) and the two log lines.
- [ ] **Step 4: Run** `npx vitest run src/engines src/lib/hooks.spec.ts src/architecture.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Codex: Stop, Interrupt and wait hooks, recorded as reviewed (the installers' golden recorded again)`.

### Task 21: Claude Code: events

**Depends on:** 1. **Effort:** high.

**Files:**
- Modify: `cli/src/engines/claude/hookContract.ts`
- Test: `cli/src/engines/hooks.spec.ts`, `cli/src/engines/hookInstallers.golden.spec.ts` (its `EVENTS`), `cli/src/engines/__fixtures__/hook-installers.golden.json` (recorded again)

`settings.events`, after today's six: `{ event: 'PreToolUse', matcher: 'AskUserQuestion' }`; under Variant P `{ event: 'PermissionRequest' }` and `{ event: 'Elicitation' }`; then `{ event: 'SubagentStart' }`, `{ event: 'SubagentStop' }`. The Notification block and its matcher do not change. The comment says what each event is for and what Task 1 found of Notification.

- [ ] **Step 1: Write the failing test**

```ts
it('installs Claude Code\'s wait and subagent hooks beside the person\'s own', async () => {
  // the keys of settings.hooks, in order: today's six, 'PreToolUse', (Variant P: 'PermissionRequest', 'Elicitation',) 'SubagentStart', 'SubagentStop', 'PostToolUse'
  expect(settings.hooks.PreToolUse.at(-1)).toMatchObject({ matcher: 'AskUserQuestion' })
  // a PreToolUse block of the person's (matcher 'Bash') is still there, before ours
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/engines/hooks.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Then record the golden again, and read its diff: only the new events.
- [ ] **Step 4: Run** `npx vitest run src/engines`. Expected: PASS.
- [ ] **Step 5: Commit** `Claude Code: wait and subagent hooks (the installers' golden recorded again)`.

### Task 22: End to end

**Depends on:** 5, 9, 13, 14, 16, 18, 19, 20, 21, 25. **Effort:** high. **Failing test:** the file itself, shown red against `main`'s daemon in Step 2; one commit.

**Files:**
- Create: `cli/e2e/hookStatus.e2e.ts`

Each test has its own `IsolatedDaemon` and a `LocalClient`, as `e2e/turns.e2e.ts` does. A first plain turn makes the session's turns end by hook. No fixed sleep: "not yet" is asserted after an `agents_list` round trip that follows the last frame awaited.

```ts
it.each(engines)('%s: a turn\'s end is told at its Stop, not when its transcript ends', …)      // !heldstop: no turn_ended until the release, then one
it.each(engines)('%s: Esc typed in the pane ends the turn as aborted, and nothing is announced', …)
it.each(engines)('%s: a cancel from the app types one Ctrl-C, and the next message is a fresh turn', …)   // `interrupts` holds one line
it.each(engines)('%s: a permission asked: the agent stops reading as working at the hook, the question is shown at the next poll, and an answer sets it working again', …)
it('claude: AskUserQuestion, and codex: request_user_input, the same', …)
it('claude: a lead whose subagent still runs stays working past its own Stop, and ends at its Stop after the subagent stops', …)
it('codex: a lead with a subagent ends once, as today: no subagent hook is installed or waited for', …)   // `!spawn`; hooks.json holds no SubagentStart or SubagentStop
it('codex: a turn that ends in an error is told at once, with no Stop and no 2-minute wait', …)   // `!fail` after a first plain turn (Task 25)
it('claude: a /goal loop announces nothing between its passes, and Finished once at its end', …)   // turn_summary.notification, once
it.each(engines)('%s: Finished comes once, no sooner than 1.5 s after the turn ends', …)
it.each(engines)('%s: an engine that sends no Stop ends its turns from the transcript, as before', …)   // withoutHooks
it('the oldest supported, Claude Code 2.1.209 and Codex 0.144.0: the events they lack are never waited for, and their turns end from the transcript as today', …)   // the fakes at those versions, withoutHooks as Tasks 1 and 2 found (Codex 0.144.0: ['Interrupt'], facts-codex §3)
```

- [ ] **Step 1: Write the file.**
- [ ] **Step 2: Show it red on `main`'s daemon.** `git worktree add "$SCRATCH/base" e9670ffd23`; in `"$SCRATCH/base/cli"`: `npm ci && BUNDLE_OUT_DIR="$SCRATCH/base-bundle" node build-bundle.mjs`; then in `cli`: `E2E_BUNDLE_PATH="$SCRATCH/base-bundle/cli.js" npx vitest run --config vitest.e2e.config.ts e2e/hookStatus.e2e.ts`. Expected: FAIL in every test but the older-engine ones, Codex's lead with a subagent and Codex's errored turn (today's behaviour, kept). Then `git worktree remove "$SCRATCH/base"`, that worktree and no other.
- [ ] **Step 3: Run** `E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/hookStatus.e2e.ts e2e/turns.e2e.ts e2e/questions.e2e.ts e2e/subagents.e2e.ts`. Expected: PASS.
- [ ] **Step 4: Commit** `Tests: hook-driven status, end to end`.

### Task 23: Temporary workflow: the numbers before and after

**Depends on:** 4, 22. **Effort:** medium. **Failing test:** none: a temporary workflow; one commit. It is removed before the merge.

**Files:**
- Create: `.github/workflows/tmp-hook-driven-agent-status.yml`

```yaml
# TEMPORARY: removed before this branch merges (docs/plans/2026-11-16-hook-driven-agent-status-plan.md, Task 23).
# The hook round trip and the core's CPU at rest and while agents turn, before (main at e9670ffd23) and after (this
# commit), on one runner: cli/e2e/perf.e2e.ts, isolated daemons, fake engines, no backend, no secret.
name: tmp hook-driven agent status
on:
  push:
    branches: [feat/hook-driven-agent-status]
permissions:
  contents: read
concurrency:
  group: tmp-hook-driven-agent-status
  cancel-in-progress: true
jobs:
  perf:
    runs-on: ubuntu-latest
    timeout-minutes: 50
    defaults:
      run:
        working-directory: cli
    env:
      LANG: C.UTF-8
      SHELL: /bin/zsh
      PERF: '1'
      PERF_AGENTS: '8'
      PERF_ACTIVE: '4'
      PERF_SECONDS: '60'
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with:
          node-version: 24.22.2
          cache: npm
          cache-dependency-path: cli/package-lock.json
      - name: tmux, the shells and lsof, as cli-e2e.yml installs them
        run: |
          sudo bash ../scripts/apt-install.sh tmux zsh tcsh dash lsof
          sudo sysctl -w fs.inotify.max_user_instances=1024 fs.inotify.max_user_watches=524288
          insecure=$(zsh -fc 'autoload -U compaudit && compaudit' 2>/dev/null | grep '^/' | sort -u || true)
          if [ -n "$insecure" ]; then
            echo "$insecure" | xargs sudo chown root:root
            echo "$insecure" | xargs sudo chmod g-w,o-w
          fi
      - run: npm ci --no-audit --no-fund
      - name: The baseline bundle (main at e9670ffd23)
        run: |
          git worktree add "$RUNNER_TEMP/base" e9670ffd23
          cd "$RUNNER_TEMP/base/cli"
          npm ci --no-audit --no-fund
          BUNDLE_OUT_DIR="$RUNNER_TEMP/base-bundle" node build-bundle.mjs
      - name: Before
        env:
          E2E_BUNDLE_PATH: ${{ runner.temp }}/base-bundle/cli.js
          PERF_BUNDLE_SOURCE: e9670ffd23
          PERF_REPORT: ${{ runner.temp }}/perf/before.json
        run: npx vitest run --config vitest.e2e.config.ts e2e/perf.e2e.ts
      - name: Before, again (the noise between two runs of one build)
        env:
          E2E_BUNDLE_PATH: ${{ runner.temp }}/base-bundle/cli.js
          PERF_BUNDLE_SOURCE: e9670ffd23
          PERF_REPORT: ${{ runner.temp }}/perf/before-again.json
        run: npx vitest run --config vitest.e2e.config.ts e2e/perf.e2e.ts
      - name: After
        env:
          E2E_BUNDLE: '1'
          PERF_REPORT: ${{ runner.temp }}/perf/after.json
        run: npx vitest run --config vitest.e2e.config.ts e2e/perf.e2e.ts
      - name: The numbers, side by side
        run: |
          node -e '
            const fs = require("fs"), dir = process.argv[1]
            for (const name of ["before", "before-again", "after"]) {
              const report = JSON.parse(fs.readFileSync(`${dir}/${name}.json`, "utf8"))
              for (const phase of report.phases) console.log(name, phase.label ?? "", "cpu%", phase.cpu.percent.toFixed(2),
                "hooks/turn", phase.hooks?.perTurn, "round trip p50/p95 ms", phase.hooks?.roundTripMs.p50, phase.hooks?.roundTripMs.p95)
            }' "$RUNNER_TEMP/perf"
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: tmp-hook-driven-agent-status-perf
          path: ${{ runner.temp }}/perf/
          retention-days: 7
```

- [ ] **Step 1: Add the file.** If a phase's label is under another name in the report, the last step reads that name.
- [ ] **Step 2: Check** it with `actionlint` where installed. Expected: no finding.
- [ ] **Step 3: Commit** `CI: a temporary run of the perf numbers before and after hook-driven status`.

### Task 24: Real Claude Code check, opt-in

**Depends on:** none: it only adds a file, skipped unless asked for; the tester runs it at the final head (Verification, check 7). **Effort:** high. **Failing test:** none: an opt-in check that spends real model turns, run only by the tester; one commit.

**Files:**
- Create: `cli/e2e/hookStatusRealClaude.e2e.ts`

The real Claude Code, signed in through this session's own Claude profile, in a pane of an `IsolatedDaemon`, with only that daemon's hooks. The way the dial skill eval runs Claude (`feat/dial-skill-eval`, `cli/evals/dial-skill/lib/agents.ts` and its README, "Isolation"): the profile is named by `CLAUDE_CONFIG_DIR`, never `~/.claude`, and `--setting-sources project` keeps the profile's own hooks (which call the person's daemon on 18473 and Orca) from loading.

- **Skipped** unless `E2E_REAL_CLAUDE` (the real `claude`) and `E2E_CLAUDE_PROFILE` are both set. `E2E_CLAUDE_PROFILE` unset with `E2E_REAL_CLAUDE` set, or resolving to `~/.claude`, throws before anything starts.
- **The daemon:** `IsolatedDaemon` (its throwaway root, own port, private tmux server, backend at `127.0.0.1:9`, signed out) with `env: { HOOK_INSTALL_ENGINES: 'claude', CLAUDE_PATH: <wrapper> }`. Its Claude home is under its root, and its hooks are installed there, never in the profile.
- **The wrapper**, in a throwaway folder outside the profile: `exec env CLAUDE_CONFIG_DIR="$E2E_CLAUDE_PROFILE" "$E2E_REAL_CLAUDE" --setting-sources project --settings <flags.json> "$@"`. `flags.json` is written once the daemon has installed its hooks: the `hooks` of the daemon's own Claude `settings.json`, and `permissions.deny` of the eval's list (`PushNotification`, `RemoteTrigger`, `DesignSync`, `mcp__claude_ai_Gmail`, `mcp__claude_ai_Google_Calendar`, `mcp__claude_ai_Microsoft_365`, `mcp__claude_ai_Claude_Docs`), so a run never reaches the person's mail, calendar, documents or phone. If the daemon's launch already passes `--settings` or `--setting-sources`, the case fails saying so: never merge by writing the profile.
- **Guards, asserted:** before and after, the SHA-256 of `<profile>/settings.json` is the same; the daemon's `engine-homes.json` names no path outside its root; each installed hook command names the daemon's port, or none and the pane sets it, never 18473. A case whose session the daemon does not take (its transcript is under the profile) fails with that reason; nothing is changed in the profile to make it pass.
- **Afterwards:** the `projects/<the work folder, as Claude names it>` folder Claude made in the profile is removed, as the eval removes its own; nothing else of the profile is touched. The daemon's cleanup takes the rest.
- **Cases**, each in the daemon's work folder (a fresh `git init`), the agent made by the `LocalClient` in ask mode, each bounded at 180 s, frames read from the client:

```ts
it('a normal turn ends at its Stop, and Finished comes once, no sooner than 1.5 s after', …)
// "Reply with the single word ready." → one turn_ended, after the daemon's `turn-stop` line; one turn_summary.notification, ≥ 1 500 ms after it; no agent_activity working after turn_ended
it('a permission: not working from the wait hook, the question at the next poll, working again once answered', …)
// "Run the shell command date and tell me what it printed." → agent_activity not working before the commander_question; the question within 3 s of the hook; answered Yes through the client; one turn_ended
// also logs the time from the dialog's first capture to the wait hook: Task 1's Notification verdict, measured on the real engine
it('AskUserQuestion: the same', …)
// "Use the AskUserQuestion tool to ask me to pick red or blue, then tell me which I picked."
it('Esc typed in the pane ends the turn as aborted, and nothing is announced', …)
// "Write sixty numbered lines about tides." → once working, Escape into the pane through the daemon's private tmux → turn_ended { aborted: true }, no turn_summary.notification
it('a background subagent keeps the lead working past its Stop, and the turn ends once after it stops', …)
// "With the Task tool, start one background subagent that writes a 300-word poem. Reply started and end your turn." → no turn_ended while it runs; one after; skipped with its reason, never passed, if the model starts none in the background
```

- [ ] **Step 1: Write the file.**
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/hookStatusRealClaude.e2e.ts` with neither variable set. Expected: every case skipped. Then `npm run typecheck`. Expected: PASS. Do not run it with the variables: the tester does (check 7).
- [ ] **Step 3: Commit** `Tests: an opt-in check of hook-driven status with the real Claude Code`.

### Task 25: Codex: an end with no Stop after it goes on at once

**Depends on:** none (Tasks 5 and 6, which changed these files, have landed). **Effort:** high. Must land before Task 22.

**Files:**
- Modify: `cli/src/engines/codex/normalizer.ts`, `cli/src/engines/codex/live.ts`, `docs/plans/2026-11-16-hook-driven-agent-status-facts-codex.md` (one line, Step 1)
- Test: `cli/src/engines/codex/live.spec.ts`, `cli/src/engines/codex/normalizer.spec.ts`

Codex runs no Stop for a turn that ends in an error (0.169.0 puts the error on its `task_complete`, 0.144.0 writes an `error` event before it) nor for one a UserPromptSubmit or SessionStart hook stops, and has no StopFailure (facts-codex §2). Under R1 such an end would be held until R6's 2 minutes. The engine-codex worker marks it `over`, as engine-claude marks a paused `/goal` end (Task 6), and R1.2 sends it on at once (Ken, 2026-11-17). Engine worker only: no core file changes, and no Stop the core takes changes.

**Interfaces — Produces:** `live.ts`'s `ingest` returns `over: true` on the read whose plain (not aborted) `turn_ended` ends a turn that carried an error (`codexTaskError(line)` is not null, or the normalizer read an `error` record since the turn opened) or that a prompt hook stopped. `CodexNormalizer` keeps whether its open turn read such a record, reset when a turn opens. A replay marks nothing.

- [ ] **Step 1: Establish** from the source at `rust-v0.169.0` and `rust-v0.144.0` (the prompt hook's stop path, `codex-rs/core/src/hook_runtime.rs` and the turn loop) what the rollout holds for a turn a UserPromptSubmit or SessionStart hook stopped, and add it to facts-codex §2 as one line with its source. If nothing in the rollout tells that turn apart from a finished one, stop and report, changing nothing else.
- [ ] **Step 2: Write the failing tests**

```ts
// engines/codex/live.spec.ts
it('an end that carries an error is marked over: no Stop follows it', () => {
  const parser = live.create({ engine: 'codex', codexHome: undefined })
  parser.ingest(line('2026-11-17T01:02:03.000Z', { type: 'user_message', message: 'go' }))
  const read = parser.ingest(line('2026-11-17T01:02:04.000Z', { type: 'task_complete', turn_id: 't1', error: { message: 'usage limit' } }))
  expect(read.events.at(-1)).toEqual({ type: 'turn_ended', payload: {} })
  expect(read.over).toBe(true)
})
it('an end after an error record is marked over (Codex 0.144.0)', …)
it('a turn a prompt hook stopped ends marked over', …)                 // the records Step 1 found
it('a finished turn, an aborted one, and the next turn after an errored one are not marked', …)
it('a replay marks nothing', …)
```

- [ ] **Step 3: Run** `cd cli && npx vitest run src/engines/codex/live.spec.ts src/engines/codex/normalizer.spec.ts`. Expected: FAIL (`over` undefined).
- [ ] **Step 4: Implement.** `liveStreams.ts` already copies `over` onto the frame (Task 6).
- [ ] **Step 5: Run** the same, and `npx vitest run src/engines/worker src/architecture.spec.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `Codex: a turn that ends with no Stop after it is told at once`.

---

## Verification

PR CI runs by itself on the pull request and needs no start: `cli-typecheck`, `cli-tests`, `companions` and `pty-checks` (a `cli/` change selects them) and `process-checks`, under `ci/required`.

| # | Check | Where | Isolation | What a person sees |
|---|---|---|---|---|
| 1 | **The core's gates**, from a clean tree at the final commit: `python3 scripts/local-checks.py --run` (it runs `npm run test:core`), then `cd cli && npm run test:harnessd`. No GitHub workflow runs them | a Mac or Linux, locally | vitest's throwaway homes | one `harness-local-checks` fence with `cli-core` passed, pasted into the pull request; `test:harnessd` passing, every file at 100% |
| 2 | **The Windows hook specs**, locally: `cd cli && npx vitest run src/engines/kit/windowsHooks.spec.ts src/engines/kit/hookRemoval.spec.ts src/engines/removeHooks.spec.ts src/engines/kit/notifyHooks.spec.ts src/engines/kit/hookSettings.spec.ts src/engines/kit/hookReview.spec.ts src/hookNotify.spec.ts --maxWorkers=1` | a Mac or Linux, locally | throwaway homes; `win32` is a parameter | all pass |
| 3 | **The same on real Windows**, by hand, once, at the final head: `gh workflow run windows.yml --ref feat/hook-driven-agent-status` (Actions → Windows → Run workflow, `release` off). Its step "Contract suite against the real host, and the Windows CLI specs" runs `windowsHooks.spec.ts`, `hookRemoval.spec.ts` and `removeHooks.spec.ts` | GitHub, `windows-latest` and `windows-11-arm` | the runner's own profile; nothing of a person's | both `windows-pty` jobs green |
| 4 | **CLI end to end**, the whole suite once at the final head: `gh workflow run cli-e2e.yml --ref feat/hook-driven-agent-status` (Actions → CLI end to end → Run workflow) | GitHub, eight Linux shards and the macOS runner | each daemon under a throwaway root on its own port, a private tmux server, fake Claude Code and Codex; no backend, never port 18473 | every shard green; `e2e-summary` lists `e2e/hookStatus.e2e.ts` passed. Every file's daemon now installs the new hook blocks and every fake Codex sends a Stop: a file red here and green in `main`'s last nightly run is this change's |
| 5 | **The numbers** (Task 23's temporary workflow, started by each push to the branch): the hook round trip, hooks a turn, and the core's CPU in `populated-idle` and `active`, before, before again, and after | GitHub, one Linux runner | isolated daemons, fake engines, no secret | the last step prints the three runs side by side. "After" is within the gap between the two "before" runs for CPU at rest; hooks a turn rises by Codex's Stop and by nothing a tool call. The printout goes into the pull request |
| 6 | **Codex's new events through PowerShell, on the Windows VM** (`docs/testing/windows-cli-e2e.md`; test user `hxe2e`, `PORT=18474`, this branch's build from the fake CDN, `HARNESS_ALLOW_UNSIGNED=1`). (a) `%USERPROFILE%\.codex\hooks.json` holds a block for each of the six events, each the PowerShell line, Interrupt with `timeout: 3`, and none for SubagentStart or SubagentStop. (b) `codex app-server` `hooks/list` reports each trusted: its `currentHash` is the `trusted_hash` in `config.toml`; Interrupt's `timeoutSec` is 3 and no `clamping Interrupt hook timeout` warning is listed. No sign-in. (c) From a Harness pane, each line run as Codex runs it, `powershell.exe -NoProfile -Command "<line>"` with the event's JSON on stdin, exits 0 and leaves one line in the daemon's log | the VM, locally; no GitHub workflow starts a Codex on Windows | the test user's own profile and daemon on the VM | six blocks; six trusted, no warning; a log line an event |
| 7 | **Real Claude Code on an isolated daemon** (Task 24), run by the tester once at the final head: `cd cli && E2E_REAL_CLAUDE="$(command -v claude)" E2E_CLAUDE_PROFILE="$CLAUDE_CONFIG_DIR" E2E_BUNDLE=1 TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/hookStatusRealClaude.e2e.ts`. Before it, check that `$CLAUDE_CONFIG_DIR` is set and is not `~/.claude`, and that `claude --version` is 2.1.209 or later. **Needs the user's own sign-in:** it runs on this session's Claude profile, as the dial skill eval does; five short turns of model use | this Mac, locally: it needs the real engine and a signed-in profile; no runner has either | `IsolatedDaemon` (throwaway root, own port, private tmux, backend `127.0.0.1:9`, never port 18473); the profile is used for its sign-in only: `--setting-sources project` keeps its own hooks off, only the isolated daemon's hooks run (`--settings`), its `settings.json` is the same before and after, and `~/.claude`, `~/.codex` and `~/.harness` are never read or written | every case passes, or is reported skipped with its reason (a model that starts no background subagent), never as passed. The log line with the time from the dialog's first capture to the wait hook goes into the pull request |
| 8 | **The core's lines, before and after**, at the final head, after the final review: `core_lines() { git show "$1:cli/src/architecture.coreFiles.txt" \| grep -v '^#' \| sed '/^[[:space:]]*$/d' \| while IFS= read -r f; do git show "$1:cli/src/$f"; done \| wc -l; }`, then `core_lines e9670ffd23` (92 229 on 2026-11-17) and `core_lines HEAD`; and `git diff --stat e9670ffd23 HEAD -- $(sed -e '/^#/d' -e '/^[[:space:]]*$/d' -e 's#^#cli/src/#' cli/src/architecture.coreFiles.txt)` for each file's share | anywhere, locally | none needed: it reads git only | both totals and their difference, and the per-file stat, in the pull request body; the difference is within the Core footprint's estimate (about 365) or the body says why |

No check runs against production: no daemon here signs in to a backend and nothing calls one. The only real sign-in is check 7's Claude profile, which talks to Anthropic as Claude Code always does.

**Real Codex is not run:** the fake engine (checks 4, 5) and the Windows VM (check 6, no sign-in, no model) cover it.

**The final review** looks at the core's part on its own: `git diff e9670ffd23 HEAD` restricted to the files `architecture.coreFiles.txt` lists (check 8's list), against the Core footprint table, and cuts what it can before check 8 is measured.

In the pull request: the red-then-green commits, checks 1 to 8 with their output or links, the three facts files, the core's line count before and after (check 8), the platforms (macOS, Linux, Windows), and that `architecture.coreFiles.txt` did not change.

**Known gaps**, a section of the pull request body:
1. **Codex subagents are not counted** (Ken, 2026-11-17): a Codex lead whose subagents run reads as today. Measured on Codex 0.169.0 (facts-codex §2): SubagentStart fires once a child, on its first turn; SubagentStop fires at the end of every turn the child finishes, a later message to a running child giving another and no start; an interrupted or failed child turn fires neither. A count would reach 0 while a child works again, or hold Working for the 10-minute timeout, which is worse than none. So Harness installs no Codex subagent hooks.
2. **A rollback, outside panes** (facts-rollback.md): an older CLI does not prune the new Codex Stop block, and its `notify.mjs` tells the devices every Codex Stop outside a pane as `turn-stop` until the person updates again. In a pane a rollback is harmless.

**After a release, by hand on Ken's Mac (a note, not this pull request's evidence):** his own Claude Code and Codex. (a) A turn shows Finished once, about 1.5 s after it ends, and not while it still works. (b) A permission prompt in each engine: the agent stops showing working at once, the question shows, and after the answer it works again. (c) Esc in a Codex pane: no Finished, no sound. (d) Claude Code with a background subagent: working until its wrap-up, then Finished once. (e) Codex starts with no "Hooks need review".

**Proposals, not built here:** `hookSettings.spec.ts`, `hookReview.spec.ts` and `hookNotify.spec.ts` added to `windows.yml`'s spec list; a nightly check of the review hashes against the newest Codex (`hooks/list`), so a change in how it hashes is seen before a person is asked to review.

## Readings

Taken without a question: the 2 minutes of silence are counted from the later of the last hook and when the end was read (the spec's "never left waiting 2 minutes"); the targeted Codex is the newest stable on the day Task 2 runs; "a wait opens" in the quiet window is the recaps' own `asked`, with no new message from the core; Codex's Interrupt rides `/api/hook/turn-stop` as `status: 'interrupted'` (the spec leaves route names to the builder).

## Open questions

None. The rollback outside panes is a Known gap of the pull request (Ken, 2026-11-17).
