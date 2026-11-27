Codex hashes: Interrupt does not match with labels and matcherEvents alone (Task 2, Step 4: stop)

# Facts: Codex's hooks, labels and hashes

For [the plan](2026-11-16-hook-driven-agent-status-plan.md), Task 2. Taken 2026-11-17.

- **Targeted Codex:** codex-cli 0.169.0, the newest stable on npm that day (`npm view @openai/codex dist-tags.latest`,
  published 2026-11-13). **Oldest supported:** 0.144.0.
- **How:** each release installed with `npm install --prefix` into a scratch folder; every run had `HOME` and
  `CODEX_HOME` set to a throwaway folder, no sign-in. Runs were `codex app-server` `hooks/list` only (no turn needs a
  model). Payloads and timing are read from the source at the release tags `rust-v0.169.0` and `rust-v0.144.0`
  (`codex-rs/...` below).

## 1. Labels and hashes

`hooks.json` held one block for each event, each running `COMMAND` of `engines/kit/hookReview.spec.ts` with
`timeout` 5, PreToolUse with matcher `request_user_input`, SessionStart with today's matcher. `hooks/list` on 0.169.0:

| Event | Label in the key | `currentHash` | Harness's `reviewHash`, timeout 5 |
|---|---|---|---|
| SessionStart | `session_start` | `sha256:7d719f8e2849620d0d2d81085877e79793c61d8b46ee15cc6251d2e0c69a1b41` | same (as 0.162.0) |
| UserPromptSubmit | `user_prompt_submit` | `sha256:2aeba9ad1676fa3124e519bbcbb7602380bae087ba5345ce604bb12f5bb76199` | same (as 0.162.0) |
| Stop | `stop` | `sha256:51ccf08c5abb298e3640ad1aa2a6d97a1e4c9aa50bf54769012a5f48e9819103` | same |
| PermissionRequest | `permission_request` | `sha256:dea5f4e595e43e7116728901dbcbd71915be5be2b4159916d43d06d125ebe833` | same |
| PreToolUse (`request_user_input`) | `pre_tool_use` | `sha256:6759b736f953bcb9cc9a47f366def174a2a3bf0394cc456d07494d3700dfc852` | same |
| Interrupt | `interrupt` | `sha256:6168570fe3ae52db10c67e1abfa5d8743900a146979b56191e5c9a7e5f737d72` | **differs**; same only with timeout 3 |
| SubagentStart | `subagent_start` | `sha256:45953e2ce6d243a93ae7c39c7a0d88b31a164c77886987cc3c00c4d6f9a1a0b9` | same |
| SubagentStop | `subagent_stop` | `sha256:dc4c1942bdf604e001ff4ea033e3b91f59beca216b41facadc6dbd4eda44e95d` | same |

`reviewHash` was run with the plan's record: the six labels added to `reviewed.events`, `matcherEvents`
`['SessionStart', 'PreToolUse']`.

- **Interrupt's timeout is clamped to 3 s and hashed clamped.** `normalize_command_hook`
  (`codex-rs/hooks/src/engine/discovery.rs`) gives SessionEnd and Interrupt a default of 1 s and a cap of 3 s, and the
  hash is taken of the normalized hook. `hooks/list` reports `timeoutSec: 3` and the warning
  `clamping Interrupt hook timeout to 3s in <hooks.json>`. The same clamp is in 0.150.0 and 0.162.0. Two effects of a
  block written with timeout 5:
  - the record Harness writes does not match: with the eight records written by the repo's own `reviewRecords` and
    `withReviewRecords` into the throwaway `config.toml`, `hooks/list` read seven `trusted` and Interrupt `modified`, so
    Codex asks the person to review, and "Continue without trusting" turns every Harness hook off (spec §1);
  - every session start shows that warning to the person (`hooks.startup_warnings()` becomes a `Warning` event,
    `codex-rs/core/src/session/session.rs`).

  Written with timeout 3 (or `reviewHash` clamping as Codex does), the hash matches. Which one is a decision for
  Task 20.
- **The matcher in the hash.** Codex keeps a matcher for PreToolUse, PermissionRequest, PostToolUse, SessionStart,
  SessionEnd, SubagentStart, SubagentStop, PreCompact and PostCompact, and drops it for UserPromptSubmit, Stop and
  Interrupt (`matcher_pattern_for_event`, `codex-rs/hooks/src/events/common.rs`). Harness writes no matcher for
  PermissionRequest, SubagentStart or SubagentStop, so `matcherEvents` needs only SessionStart and PreToolUse. A
  PreToolUse matcher other than `request_user_input` gives another hash.
- **The record** is still `[hooks.state."<hooks.json real path>:<label>:<block>:<hook>"]` `trusted_hash` in
  `config.toml`: with those tables written, `hooks/list` reports `trusted` on 0.169.0 and on 0.144.0. The `.hook-trust`
  folder 0.169 names is for plugin hooks only (`codex-rs/hooks/src/engine/plugin_trust.rs`).

## 2. Payload and timing (0.169.0)

`session_id` is the root thread's id for the root and for every thread it spawns ("the identity shared by the root
thread and all descendant threads", `Session::session_id`, `codex-rs/core/src/session/session.rs`;
`AgentControl.session_id`, `codex-rs/core/src/agent/control.rs`). Every stdin below also has `turn_id`, `cwd`,
`hook_event_name`, `model` and `permission_mode` (`codex-rs/hooks/src/schema.rs`).

| Event | Other stdin fields | `transcript_path` is | Fires |
|---|---|---|---|
| Stop | `stop_hook_active`, `last_assistant_message` | the root's rollout | root threads only |
| Interrupt | none | the root's rollout | root threads only |
| PermissionRequest | `tool_name`, `tool_input`; `agent_id`, `agent_type` for a child | the thread's own rollout | any thread |
| PreToolUse | `tool_name`, `tool_input`, `tool_use_id`; `agent_id`, `agent_type` for a child | the thread's own rollout | any thread |
| SubagentStart | `agent_id` (the child's thread id), `agent_type` | **the child's own rollout** | a spawned child's first turn |
| SubagentStop | `agent_id`, `agent_type`, `agent_transcript_path` (the child's), `stop_hook_active`, `last_assistant_message` | **the parent's rollout** | each turn a spawned child finishes |

- **Stop** runs when the model finishes a turn with no follow-up, before the turn's `task_complete` record is written
  (`run_turn_stop_hooks` in the turn loop, `codex-rs/core/src/session/turn.rs`; `TurnComplete` is sent later, in
  `codex-rs/core/src/tasks/mod.rs`). Post-turn compaction can run between the two. It does not run for an interrupted
  turn (the task is aborted, the loop never reaches it). **It does not run for a turn that ends in an error** (a model
  or request error: `emit_turn_error_lifecycle`, then `break`), nor when a UserPromptSubmit or SessionStart hook stops
  the turn: those turns end only by their `task_complete` record (0.169.0 puts the error on it; 0.144.0 writes no
  error to the transcript at all: its `TurnCompleteEvent` has no `error` field, `codex-rs/protocol/src/protocol.rs:1955`,
  and `EventMsg::Error` is transient on both, `codex-rs/rollout/src/policy.rs:118` at 0.144.0, `:162` at 0.169.0).
  Nothing in the transcript tells a turn a prompt hook stopped from a finished one: both are a plain `task_complete`
  with `last_agent_message: null`. Codex has no StopFailure. A Stop hook of someone else's that blocks continues the turn and
  Stop runs again (`stop_hook_active: true`), as Claude Code's `/goal`.
- **Interrupt** runs only for `TurnAbortReason::Interrupted` (Esc, Ctrl-C, an app's interrupt), for a root thread only
  (`run_turn_interrupt_hooks`, `codex-rs/core/src/hook_runtime.rs`). It runs after the interrupted-turn marker is
  flushed to the rollout and **before the `turn_aborted` record is written**; Codex waits for a hook that is not
  `async`, up to the clamped 3 s, then writes `turn_aborted` (`codex-rs/core/src/tasks/mod.rs`, both abort paths).
  Other abort reasons (`Replaced`, `ReviewEnded`, `BudgetLimited`) send no Interrupt.
- **PermissionRequest** runs, and is waited for, before the approval reaches the person
  (`request_approval_with_user_prompt`, `codex-rs/core/src/tools/approvals.rs`: the hook's result is read before
  `request_reviewer_approval`). It fires for every approval: a command, a patch, an MCP tool, network access. Under
  automatic review (`requires_human_approval()` false) it fires and no dialog is drawn.
- **PreToolUse** runs, and is waited for, before the tool's handler (`apply_pre_tool_use`,
  `codex-rs/core/src/tools/registry.rs`). The matcher is tested against `tool_name`; `request_user_input` is an exact
  match (letters, digits, `_` and `|` only, `codex-rs/hooks/src/engine/matcher.rs`). So a hook process runs for that
  tool only, never for every tool call. It runs before the handler checks its mode: in a mode where the tool is not
  offered ("request_user_input is unavailable in … mode") or from a child ("can only be used by the root thread") the
  hook fires and no dialog follows. The experimental `request_user_input_async` tool has another name and is not
  matched.
- **An empty stdout and exit 0 decide nothing**: for PermissionRequest the approval goes to the person, for PreToolUse
  the tool runs, for Stop the turn ends (`trimmed_stdout.is_empty()` in each of
  `codex-rs/hooks/src/events/{permission_request,pre_tool_use,stop}.rs`). Exit 2 means deny, block or continue in those
  three; a timeout or other failure decides nothing.
- **Subagents.** Which field names the lead: `session_id` (the root thread's id, which is Harness's Codex session id).
  `agent_id` names the child. A child never fires Stop, Interrupt or SessionStart: its end is SubagentStop
  (`run_turn_stop_hooks`), its start SubagentStart, and only for a `ThreadSpawn` child (an internal child, such as
  review or compaction, fires none). Its own PermissionRequest and PreToolUse carry the lead's `session_id`, its own
  rollout as `transcript_path`, and `agent_id`.
  - The child's rollout's first record is `session_meta` with `payload.source.subagent` set (`SessionSource::SubAgent`,
    serialized lowercase, `codex-rs/protocol/src/protocol.rs`). So `notify.mjs` `isCodexSubagent` drops a child's
    PermissionRequest and PreToolUse, **and drops SubagentStart** (its `transcript_path` is the child's), while
    **SubagentStop passes** (its `transcript_path` is the parent's). Task 13 has to route SubagentStart before that
    guard, or by `hook_event_name`.
  - A child of a child: both events still carry the root's `session_id`; SubagentStop's `transcript_path` is then the
    middle child's rollout. SubagentStart carries no parent or depth field; the child's own `session_meta` has
    `source.subagent.thread_spawn.depth` and `parent_thread_id`.
  - **Start and stop do not pair one to one.** SubagentStart fires once, on the child's first turn (a session start
    source of `startup` or `fork`). SubagentStop fires at the end of every turn the child finishes, so a message sent
    later to a running child (`send_input`) gives another SubagentStop and no SubagentStart. A child turn that is
    interrupted or ends in an error fires no SubagentStop. A count of starts less stops (R5) can therefore reach 0
    while a child works again, or stay above 0 until the 600 s timeout.

## 3. The oldest supported Codex, 0.144.0

| Event | 0.144.0 | First release |
|---|---|---|
| Stop | yes | 0.144.0 or earlier |
| PermissionRequest | yes | 0.144.0 or earlier |
| PreToolUse | yes, `request_user_input` matched as above | 0.144.0 or earlier |
| SubagentStart, SubagentStop | yes, same payloads and the same root `session_id` | 0.144.0 or earlier |
| Interrupt | **no** | 0.150.0 (`codex-rs/hooks/src/events/interrupt.rs` is absent at `rust-v0.149.0`, present at `rust-v0.150.0`) |

- **An event it does not know is ignored, and the file is not refused.** `HooksFile` refuses unknown top-level keys,
  but `HookEventsToml` (the `hooks` object) does not (`codex-rs/config/src/hook_config.rs` at `rust-v0.144.0`). Run:
  `hooks/list` on the same eight-event `hooks.json` listed the seven it knows, with the same seven hashes as 0.169.0,
  no warning and no error; the `interrupt` review record in `config.toml` was ignored and the other seven read
  `trusted`.
- So the older-engine case of Task 22 is `withoutHooks: ['Interrupt']` for Codex 0.144.0 to 0.149.x: its Esc ends
  the turn only through the transcript's `turn_aborted`.

## 4. What this means for the plan

1. **Stop (Step 4): Interrupt's hash.** It cannot be matched with labels and `matcherEvents` while the block is
   written with timeout 5. Needed: Interrupt written with a timeout of at most 3, or `reviewHash` clamping Interrupt
   (and SessionEnd) to 1..3 as Codex does. Either changes Task 20's contract or `hookReview.ts`; not decided here.
   Decided since: Interrupt is written with a 3 s timeout (the spec's Decided, the plan's Task 20).
2. **A Codex turn that ends in an error has no Stop.** Under R1, from the session's first Stop its errored turn's end
   is held, and only R6 delivers it, after 120 s. The transcript cannot single that end out (0.144.0 records no error),
   so every Codex end goes on at once (§5, Task 25).
3. **SubagentStart is dropped by `isCodexSubagent` today** (its transcript is the child's). Task 13. Decided since:
   Harness installs no Codex subagent hooks (the spec's Decided), so this does not arise.
4. **SubagentStop fires per child turn**, SubagentStart once per child; an interrupted or failed child turn fires
   neither. R5's count is not exact for Codex.
5. **Interrupt runs before `turn_aborted` is written** and Codex waits for it (at most 3 s), so R3's close comes first
   and the transcript's aborted end follows for a turn already closed.
6. **A wait can open with no dialog:** PreToolUse `request_user_input` where the tool is refused, and PermissionRequest
   under automatic review. R4's "two polls read the pane clear" ends both.

## 5. Stop runs before `task_complete`

Codex runs its Stop hook and waits for it before it writes the turn's `task_complete`, on both supported ends:

| Step | 0.144.0 (`rust-v0.144.0`) | 0.169.0 (`rust-v0.169.0`) |
|---|---|---|
| The turn loop calls the Stop hooks and awaits them | `codex-rs/core/src/session/turn.rs:374` | `codex-rs/core/src/session/turn.rs:807` |
| …which runs the hooks and awaits their outcome | `codex-rs/core/src/hook_runtime.rs:363` (`hooks.run_stop(request).await`) | `codex-rs/core/src/hook_runtime.rs:449` |
| The task's `run` (the turn loop) is awaited | `codex-rs/core/src/tasks/mod.rs:405` | `codex-rs/core/src/tasks/mod.rs:428` |
| Only then `on_task_finished` | `codex-rs/core/src/tasks/mod.rs:428` | `codex-rs/core/src/tasks/mod.rs:460` |
| …builds `TurnComplete` | `codex-rs/core/src/tasks/mod.rs:769` | `codex-rs/core/src/tasks/mod.rs:968` |
| …and sends it, which writes `task_complete` | `codex-rs/core/src/tasks/mod.rs:777` | `codex-rs/core/src/tasks/mod.rs:982` |
| `TurnComplete` is persisted to the rollout | `codex-rs/rollout/src/policy.rs:99` | `codex-rs/rollout/src/policy.rs:139` |

So by the time Harness reads a `task_complete`, its turn's Stop, if any, has already reached the daemon; a Stop that
blocks continues the turn before any `task_complete` is written. An errored or prompt-hook-stopped turn writes the
same `task_complete` and sends no Stop (§2). Holding a Codex end for its Stop can therefore only delay it: the
engine-codex worker marks every Codex end `over` (Task 25), and the fake Codex keeps this order (Tasks 14, 22).
