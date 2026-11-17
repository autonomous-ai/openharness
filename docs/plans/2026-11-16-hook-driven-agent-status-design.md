# Hook-driven agent status

Date: 2026-11-16, reviewed against `main` at `e9670ffd23` on 2026-11-17. Reference: Orca (`stablyai/orca` at
`2e71fadda87`, 2026-11-16).

## Intent

Harness shows each agent as working, waiting on the person, finished (unread), failed or idle. For Claude Code and
Codex that state is read mostly from the engine's transcript and the pane, and it is sometimes wrong:

- a turn shown as working after it ended;
- a turn shown as finished while the agent still works;
- an agent waiting on a permission prompt shown as working.

Ken asked to learn from Orca, which gets the same states right, and apply what it does to Harness.

Orca treats the engine's own hook events as the truth for when a turn ends or waits on the person; the transcript and
terminal are fallbacks. This design does the same for Claude Code and Codex, and carries over Orca's rules for not
announcing a state it cannot prove.

## Goals

- For Claude Code and Codex in a Harness pane, a turn ends when the engine says so: Stop, StopFailure, an interrupt.
  The transcript's own end of a turn no longer ends it alone.
- An agent waiting on a permission or a question is not shown as working from the moment its hook arrives, and its
  question shows at the pane reader's next poll, as today.
- A turn the person stopped (Esc or Ctrl-C, from the app or typed in the pane) ends quietly for Codex too: no
  "Finished", banner or sound. Claude already does.
- A lead whose subagents still run stays working until they are done, as in Orca.
- "Finished" is announced only after 1.5 s of quiet, and once per turn, on every client that announces it.

## Non-goals

- Other engines (OpenCode, Kilo, Cursor, Copilot, Grok, Agy, Hermes, Pi, Amp, Devin, Command Code) keep today's
  sources.
- Agents outside Harness panes. The devices service keeps mapping their hooks through `/api/hook/observed`.
- Terminal-escape (OSC) or title-glyph status, and watching keys typed in the pane.
- Orca's attention UI (presence-based read, Mark unread, Dock badge): a separate, later change.
- Recap text, turn summaries, Agent Messages delivery and transcript content: unchanged.

## Anti-goals

- A status that flickers between working and finished within one turn.
- An agent shown as finished while its work goes on, or as working long after it stopped.
- A daemon that gets slower or busier at rest.
- A hook process per tool call that reports to the daemon.
- A second way to decide working, waiting or finished beside the existing one.

## How it works today (checked on `e9670ffd23`)

- **Where turns live.** For Claude and Codex the live transcript parser runs in the engine worker (engine-claude,
  engine-codex). The core holds only a cursor handle on it, with `closeTurn` and no `openTurn`
  (`engines/facets/live.ts:23-29`, `core/engines/liveSessions.ts:100-111`); the inline parser runs in the core only
  under an older master (`core/main.ts:741`). `sessionTurnOpen` reads the parser (`core/transcripts/normalizers.ts`),
  and heartbeats, the question watcher and recaps follow it.
- **Opening.** The parser opens a turn from the prompt record, and also opens a pass that another plugin's blocking
  Stop hook continued (a `/goal` loop: `engines/claude/normalize.ts:868-876`), which has no UserPromptSubmit.
  UserPromptSubmit goes to `/api/hook/session-start` (`hook/notify.mjs:2328`) and, after admission, to
  `onPromptHook`, which only records when the prompt hook ran (`core/turns/turnHooks.ts:65`).
- **Closing.** The parser closes a turn on its end record. Claude's Stop/StopFailure is a delayed fallback
  (`engines/kit/stopHook.ts`): it drains, waits `STOP_HOOK_GRACE_MS` (1.5 s), and force-closes only the turn it is
  about. A Stop run before the latest prompt hook, or before the open turn's opening record, closes nothing; a
  continued `/goal` pass is left to the transcript. The grace exists because the Stop hook beats the transcript's
  final text by about 200 ms (`lib/commander.ts:631`), and a recap read early is stale or empty.
- **Interrupts.** Claude's interrupt line closes the turn with `turn_ended {aborted: true}`, the only signal for Esc
  typed in the pane (`engines/claude/normalize.ts:891-899`). Codex `turn_aborted` closes with a plain
  `turn_ended {}` (`engines/codex/normalizer.ts:373-378`), so a Codex Esc reads as finished. `core/turns/cancel.ts`
  is the app's cancel: it types Ctrl-C into the pane, then closes the turn quietly.
- **Working.** `lib/turnActivity.ts`: a 30 s lease renewed by live progress events (turn_started, text and thinking
  deltas, tool_start/tool_end, subagent_finished). While a turn is open, heartbeats probe the pane or Codex's
  app-server every 5 s (`core/turns/heartbeats.ts`). The `activity` frame is `working | idle | unknown`.
- **Waiting.** The question watcher (`lib/questionController.ts`) reads the pane every 1.5 s while a turn is open;
  the screen reading runs in the engine worker. `core/questions.ts` builds the `commander_question` frame, whose id
  is a hash of the rendered dialog, and its withdrawal.
- **Subagents.** The recaps service (`lib/commander.ts`, CommanderMirror, in the edge process) holds a turn's end
  while async subagents run and until the lead's wrap-up lands (3-10.8 s measured, `commander.ts:222-229`).
- **Finished.** Desktop raises "Finished" only from `turn_summary.notification`, deduped by its id, which is one per
  turn (`lib/agentNotifications.ts`, `desktop/lib/state/app_state.dart:22065-22084`). The same decision serves the
  devices. An `aborted` turn gets no notification (`commander.ts:530-533`). There is no quiet window.
- **Hooks installed.** Claude (`engines/claude/hookContract.ts`): SessionStart, SessionEnd, UserPromptSubmit, Stop,
  StopFailure, and Notification for `permission_prompt|elicitation_dialog|elicitation_url_dialog|...`, which
  `notify.mjs` ignores in a pane (`notify.mjs:2064`). Codex (`engines/codex/hookContract.ts`): SessionStart and
  UserPromptSubmit, and its turns close only through the transcript. Both install the Agent Messages PostToolUse
  inbox script. Codex's own review records (`reviewed`, trusted hashes in `config.toml`) cover SessionStart,
  UserPromptSubmit and PostToolUse, checked against Codex 0.162.0.
- **Installer.** `installHookSettings` writes declared events only (`engines/kit/hookSettings.ts:248`); a block of
  ours left in an event no longer declared stays. Uninstall already walks every event and removes review records
  (`engines/kit/hookRemoval.ts:47-60`, `156`).
- **Hook bodies.** The hook server refuses unknown body fields (`hookServer.ts:162-166`); every body carries the
  engine's `cliVersion`. `notify.mjs` posts an event it does not know to registration (`notify.mjs:2328`).

## What Orca does (verified at `2e71fadda87`)

- Hooks first; the transcript and terminal are fallbacks. Hooks silent for 2 minutes and a terminal that disagrees:
  the terminal wins.
- Claude: PermissionRequest, Elicitation and PreToolUse for AskUserQuestion → waiting; Stop, StopFailure → done;
  PreCompact never installed (an aborted compact leaves the agent stuck working).
- Codex: Stop and Interrupt (0.150+) → done; PermissionRequest and PreToolUse for `request_user_input` → waiting.
- A child's events never end the lead's turn.
- A finished turn is announced after 1.5 s of quiet, once per turn.

## Approaches

- **A. Hooks decide turn ends and waits; the existing lease keeps deciding working (chosen, Ken).** Hook events feed
  the turn and question machinery Harness already has. No per-tool-call hook.
- **B. Keep the transcript as the authority and patch gaps.** Smaller, but the cause stays: a transcript written late,
  in pieces, or rewritten by a compact.
- **C. Read the terminal.** Least reliable; only for engines with no hooks, later.

## Design

### 1. Hook events installed

All run `notify.mjs`. Only end and wait events are added; there is no hook per tool call.

- **Claude:** keep today's events. Add PreToolUse with matcher `AskUserQuestion`. Permission and elicitation waits
  use the Notification block already installed (`permission_prompt`, `elicitation_dialog`,
  `elicitation_url_dialog`): `notify.mjs` now also sends them for a pane session, to a wait route. If the builder
  measures Notification firing later than the dialog opens, PermissionRequest and Elicitation replace it instead.
  Add SubagentStart and SubagentStop (section 2, Subagents). No PostToolBatch or ElicitationResult: a wait ends on
  what follows it (section 3). Never PreCompact.
- **Codex:** add Stop, PermissionRequest, PreToolUse with matcher `request_user_input`, Interrupt, SubagentStart and
  SubagentStop. Each gets its review label (`stop`, `permission_request`, `pre_tool_use`, `interrupt`,
  `subagent_start`, `subagent_stop`, as Codex names them), PreToolUse joins
  `matcherEvents`, and the trusted hashes are checked against the Codex this release targets (`hooks/list`, as
  `engines/kit/hookReview.spec.ts` does today). A wrong hash makes Codex ask the person to review, and "Continue
  without trusting" turns every Harness hook off, so the hash test is a required test.
- **Older engines.** The oldest supported are Claude Code 2.1.209 and Codex 0.144.0, the lowest the code names. An
  engine older than an event never sends it and stays on today's transcript path (section 2), with a test. The
  builder confirms that these versions ignore an unknown event in `settings.json` or `hooks.json` and do not
  invalidate the file. If either rejects it, the plan stops for a decision.
- **Outside panes, unchanged.** `notify.mjs` sends none of the new events, Codex's Stop included, for a session
  outside a pane: the devices see what they see today, so the dial does not sound at every Codex turn. Doing that is
  a separate change.
- **Installer prune.** `installHookSettings` also removes our blocks (`isOurs`) from events the contract no longer
  declares, reusing `hookRemoval.ts`'s walk, and leaves everyone else's alone. For Codex it removes their review
  records too; labels of removed events stay in `reviewed.events` so the records can be found. This makes a later
  rollback or a dropped event clean.
- The dial's own PermissionRequest hook (`hooks/harness-device` plugin, `deviceClaude/asked.ts`) is unchanged; the
  two run side by side and each serves its own reader.

### 2. Turn ends from hooks (core, `core/turns/`)

- **Which sessions.** A Claude or Codex session becomes hook-driven once it has sent a Stop, StopFailure or Interrupt
  hook in this daemon run. That proves its engine sends them. Before that (its first turn, an engine too old, a
  daemon just restarted mid-turn) today's rules apply unchanged, so no turn ever waits on a hook its engine never
  sends.
- **Opening is unchanged.** The parser opens turns as today, including a continued `/goal` pass. UserPromptSubmit
  keeps its role (the prompt-hook time that marks an older Stop as stale).
- **Closing.** For a hook-driven session the core keeps one record per session: whether the transcript has read the
  turn's end, and when the last end or wait hook came. `sessionTurnOpen` reads it for these sessions.
  - The parser's normal end of a turn is held in the core, not delivered, until the turn's Stop arrives.
  - The engine worker marks an end that never has a Stop after it (a paused `/goal` pass, which ends with
    `turn_duration` alone); that end is delivered at once, never held.
  - Stop: drain; if the parser's end is held, deliver it now. If not, wait up to 1.5 s for it, then close as today's
    fallback does. The stale-Stop rules stay: a Stop run before the latest prompt hook, or before the open turn's
    opening record, closes nothing. A continued `/goal` pass is closed by its own Stop like any turn.
  - StopFailure closes whichever turn is open, as today.
  - An aborted end (Claude's interrupt line, Codex `turn_aborted`) closes at once as `aborted`, Stop or not.
  - Codex Interrupt closes as `aborted` at once.
  - Codex `turn_aborted` now emits `turn_ended {aborted: true}`, for every Codex session.
- **Subagents.** The session's turn record holds one number: how many subagents run. Nothing else is kept about
  them, no list or record (Ken, 2026-11-17: the smallest way to keep a lead working while its children run, as
  Orca does).
  - SubagentStart adds one, SubagentStop takes one away, never below zero (a child started before this daemon run
    can stop in it). The count is capped at 64; past that, a start is not counted, with one log line.
  - A lead's Stop while the count is above zero does not end the turn: its end stays held and the agent stays
    working. The turn ends at the lead's first Stop with the count at zero, which comes after the lead's wrap-up.
    That Stop waits the 1.5 s grace before delivering, since the wrap-up lands about 200 ms after it.
  - The 2-minute hook-silence rule does not run while the count is above zero; the 10-minute timeout does.
  - A child's own events never end the lead's turn.
  - While the count is above zero, each heartbeat of the open turn is work evidence, so the lease stays working
    without per-tool hooks.
  - Timeout: when the count is above zero and the session has sent no hook and no progress for 10 minutes, the count
    goes to zero with one log line, and the held end, if any, is delivered. The next prompt hook also sets it to zero.
    So a lost SubagentStop can never keep an agent working for more than 10 minutes.
- **Hook silence.** A hook-driven turn whose end the transcript has read, with no hook for 2 minutes, is closed by the
  transcript's held end. This covers a Stop that failed to run, as Orca's 2-minute rule does. The check runs on the
  existing heartbeat, which runs only while a turn is open; nothing new runs at rest.
- **Working.** The lease in `turnActivity.ts` stays the one place that says working, idle or unknown. A Stop or
  aborted end sets idle through the existing `turn_ended`. Wait hooks do not renew the lease (section 3). A late text
  or tool event read after the turn closed does not renew it either, so the final text landing after Stop cannot
  flip the agent back to working.

### 3. Waiting from hooks

- A wait hook (Claude's permission or elicitation Notification, PreToolUse AskUserQuestion; Codex PermissionRequest,
  PreToolUse `request_user_input`) opens a wait on the session in the core, with the hook's `firedAt`.
- The pane reader stays the one way to build a question, at its usual 1.5 s poll: the hooks run before the engine
  draws its dialog, so reading the pane at the hook would find nothing. The `commander_question` frame is unchanged. No question is built from the hook's
  payload, so there is never a second question, a second notification, or an answer refused as stale.
- While the wait is open the lease's working claim is withdrawn (read as `unknown` while the turn is open, as an
  expired lease is), and progress does not renew it.
- The wait ends on any of these: the question watcher closing the question; two polls in a row reading the pane with
  no dialog (a dialog answered before it was read, by the dial or a fast key); the next turn end; a progress event whose
  record time is after the hook's `firedAt` (the waited tool's own `tool_start`, read later, does not end it); a
  subagent's progress never ends it.
- Tool input in a hook payload is outside text: the hook sends only the event and tool name, never the input.

### 4. Stopped by the person

- `cancel.ts` stays as it is: the app's cancel, which types Ctrl-C and ends the turn quietly.
- A Codex Interrupt hook or an aborted end from the transcript ends the turn through the existing keyless path,
  `turn_ended {aborted: true}` through the funnel, which Claude's Esc already takes. No key is sent, so the engine
  never gets a second Ctrl-C (two in a row quit Claude Code).
- Keys typed in the pane are not watched. Claude's interrupt line and Codex's Interrupt hook and `turn_aborted`
  already say a typed Esc or Ctrl-C ended the turn.

### 5. Wire

- No new frame or field. `turn_ended.aborted` already says a turn was stopped by the person, and
  `turn_summary.notification.id` already identifies a finished turn once.
- New hook routes for the new events (a wait, an interrupt) are local, token-checked and bound as today's. New body
  fields go to the daemon before the hook sends them; the hook and daemon ship in one CLI.

### 6. Announcing "Finished"

- In the recaps service, where the one notification decision for Desktop and the devices is made
  (`lib/agentNotifications.ts`): a turn's "done" notification is decided 1.5 s after its turn ends, and dropped if
  the session's next turn opens or a wait opens within that time. A `/goal` loop whose next pass opens within 1.5 s
  therefore announces nothing between passes.
- Desktop needs no change: it already announces once per notification id and nothing for an aborted turn.

### 7. Rollout and rollback

- One pull request; no release from this branch.
- Rollback to an older CLI: its installer does not prune, so our new blocks stay and run the older `notify.mjs`,
  which posts the unknown events to registration (idempotent). The builder confirms this is harmless; if not, the
  prune ships in a release first and the rest waits for it.

### 8. Design checklist

- **Growth:** one in-memory record per live hook-driven session (held end, open wait, last hook time, running
  subagent count capped at 64). Nothing stored.
- **Concurrency:** per session, on the core's event loop. Hook-versus-transcript precedence is decided in one place,
  `core/turns/`.
- **Read cost:** a few hooks per turn (Stop, one per wait, two per subagent). No per-tool-call hook reaches the
  daemon.
- **Scale (10x):** 10x turns is 10x a few hook requests. Measure hook requests per turn and the hook round trip
  before and after.
- **Compatibility:** no new wire fields. Old Desktop, mobile and TUI clients see today's frames; the quiet window and
  Codex `aborted` reach them through the frames they already read.
- **Audience:** local only. The hook token and binding are checked as today.
- **Identity:** unchanged; hooks run under the person's own engine login.
- **Failure:** the 2-minute hook-silence rule covers a Stop that does not run, the 10-minute subagent timeout a lost
  SubagentStop, and the lease lost work evidence. A
  refused or unbound hook is logged by the daemon once per session.
- **Platforms:** macOS, Linux, Windows. Claude hooks use exec form; Codex hooks run through PowerShell, and the new
  Codex events are checked on the Windows VM. Mobile and TUI unchanged.

## Constraints

- The core stays small (`AGENTS.md`). In the core: the hook routes, the held end and Stop close, the wait, the
  running-subagent count, and the hook-silence and subagent timeouts on the existing heartbeat: turn ends and waits
  only. The quiet window lives in the recaps service. No subagent list or record in the core. No new file in the core's process unless the plan says why every session
  needs it (`architecture.coreFiles.txt`).
- The pull request states the core's line count before and after, and the final review looks at the core's part on
  its own and cuts what it can.
- Hot path: numbers before and after for the hook round trip, daemon CPU at rest, and daemon CPU during a busy turn.
- Tests first, at the layer where the behavior lives:
  - Core turn tests from recorded hook and transcript sequences, Claude and Codex: a normal turn, final text after
    Stop, a stale Stop, a `/goal` continuation, a permission wait, AskUserQuestion / `request_user_input`, a background
    subagent, Esc typed in the pane, Codex Interrupt, app cancel (one Ctrl-C), StopFailure, a missing Stop (hook
    silence), and an engine that sends no Stop.
  - Installer tests: pruning undeclared events, Codex review records and hashes for the new events.
  - Recaps tests: the quiet window, a next turn inside it, an aborted turn.
  - End to end with the fake engines (`e2e/harness/fakeEngine.mjs`) on an isolated daemon.
  - Real Claude Code on an isolated daemon, with this session's own Claude profile (`CLAUDE_CONFIG_DIR`, hooks pointed
    at the isolated daemon, never port 18473). Real Codex is not run; the fake engine and the Windows VM cover it. A
    check by hand on Ken's Mac comes after a release.
- `npm run test:core`, `npm run test:harnessd` and the Windows hook specs are run and recorded in the pull request.

## Decided

- Approach A, for Claude Code and Codex in Harness panes. (Ken)
- Attention UI is a separate, later change. (Ken)
- A lead stays working while its subagents run, as in Orca, from a running count in the core's turn record, capped and
  timed out; no list or record. (Ken, 2026-11-17)
- A Codex update that changes how it hashes hooks asks the person to review Harness's hooks once again, as today.
  (Ken, 2026-11-17)
- Plan review answers (Ken, 2026-11-17): `cancel.ts` is not split, Interrupt takes the keyless aborted path; oldest
  supported Claude Code 2.1.209 and Codex 0.144.0; no pane read at the hook; a wait also ends on two clear polls; a
  paused `/goal` end is never held; the lead's last Stop waits the grace and silence does not run while subagents
  run; the prune and the lease's subagent reading stay in the core; agents outside panes unchanged; about 400 core
  lines accepted as a frame, cut where the review can.
- Calls made in this review, which Ken can overrule:
  - Turns still open from the transcript; only ends come from hooks. The `/goal` continuation and Claude's Esc in the
    pane have no hook of their own.
  - A session is hook-driven only after its engine has sent a Stop in this daemon run, so an older engine is never
    left waiting 2 minutes.
  - The 1.5 s Stop grace stays as a bounded wait for the final text, so a recap is never stale.
  - Waits withdraw Working and leave the question to the pane reader, instead of building a second question from
    the hook payload.
  - The quiet window is in the shared notification decision, so Desktop, phone and dial behave alike.
  - Codex `turn_aborted` reads as aborted for every Codex session, hook-driven or not.
  - No new wire fields; no Desktop change.
  - Keys typed in the pane are not watched.
  - One pull request, no release.

## Left to the builder

- Whether Claude's Notification fires as the permission dialog opens; if not, PermissionRequest and Elicitation.
- What Claude Code 2.1.209 and Codex 0.144.0 do with an unknown hook event.
- Codex's review labels and hashes for Stop, PermissionRequest, PreToolUse, Interrupt, SubagentStart and SubagentStop
  on the targeted Codex.
- Where the held end sits in `core/engines/liveSessions.ts` for the worker parser and the inline one.
- The route names and body fields, fitted to `hookServer.ts`'s validation.
