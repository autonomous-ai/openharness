# What the real Claude Code and Codex write, and what the daemon reads: 2026-10-06

Daemon QA with the real CLIs (Claude Code 2.1.290, Codex 0.160) found three bugs in one day, all where the e2e fake engines had drifted from what the CLIs write:
- a tool's aborted output arriving after an interrupt (#850);
- Claude's mid-turn `queued_command` attachment missing from history (#855);
- Claude writing `/compact` as a plain user line, which opened a turn nothing closed (#858).

This audit counts every record type in real recent transcripts. Each type the daemon's readers never mention gets one of three verdicts, checked against the code paths:
- **handled**: some reader acts on it;
- **irrelevant**: pure metadata, or a duplicate of a record that is handled;
- **GAP**: missing it changes what a person sees: the turn lifecycle, the history (`session_get`), tool events, questions, compaction, sub-agents, titles, models and effort, token usage, or search.

**Method.** 152 Claude Code transcripts (2.1.270 to 2.1.290, mostly 2.1.283 and 2.1.287) and 200 Codex 0.160.0 rollouts were read on one development machine. Only record types, keys, counts and orderings were recorded, never content. Every test and fixture uses synthesized records with invented text.

**Readers checked.** Claude records:
- the live turn lifecycle: `lineToEvents`, the Stop hook in `core/turns/turnHooks.ts`, activity in `lib/turnActivity.ts`;
- the history (`messagesToEvents`), the recap (`lastTurnTextFromRawLines`), paging and attach (`claudePageLine`, `startsClaudeTurn`);
- models and effort (`runtimeProfile.ts` `ingestClaude`), token usage (`agentTokenUsage.ts`), search (`sessionSearch/`), idle time (`transcriptActivity.ts`), titles (`sessionTitle.ts`, the terminal title), and the dial's sub-agent rows (`commander.ts`).

For Codex: `CodexNormalizer` (live and replay), `lastCodexTurnText`, `codexTaskBoundary`, `subagent.ts`, the model controller, token usage and idle time.

## Gaps found

| # | Engine | Record | What a person saw | Fix |
|---|---|---|---|---|
| 1 | Codex 0.160 | `function_call_output` of `spawn_agent` is `{"task_name":"/root/<name>"}`; the child is named by `event_msg/item_completed/SubAgentActivity` (`started`, `completed`) | Every sub-agent Codex started closed at once as a failed Task, with `{"task_name":…}` as its output, live and in the history. Its work and result never showed. | this PR: the spawn's child comes from the `started` activity (or the path), the Task closes on `completed`, and its result is the child's report (`response_item/agent_message`, `Payload:`) |
| 2 | Claude | `attachment/queued_command` with `commandMode: "task-notification"`: a background sub-agent's `<task-notification>` handed back into a turn still running | That sub-agent never finished: its row stayed running on the dial, and the parent's recap was held until the backstop gave up on it. This is the more common delivery (about 800, against 370 as user records). | this PR: `taskNotificationEvent` reads the attachment as well as the user record |
| 3 | Claude | `user` (isMeta) `"Stop hook feedback:…"`, then `attachment/goal_status` `{met:false}` (the `/goal` loop) or `attachment/hook_blocking_error` (a Stop hook that blocks); Claude continues in the same turn | The turn closed at the iteration's `end_turn`. The continuation ran with no turn open: no `turn_started`, no `turn_ended`, no recap, and the agent read idle again after each 30 s lease. | #863 |
| 4 | Codex 0.160 | `item_completed/UserMessage` (and its `response_item/message`) wrapping `<send_user_message_question_reply>[{"answer","question","questionItemId"}]</…>`: the person's answer to `request_user_input_async`, a question that does not stop the turn | The wrapper and its JSON were the person's message, in the live turn, the history, the recap and search. | #868 |

Moved engine homes (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` from the login shell) are the same class of drift but not a record type. They are fixed in #865.

## Claude Code

| Record | Count | Verdict | Evidence |
|---|---|---|---|
| `user`, `assistant` | 28,746 / 54,032 | handled | `transformLine` and every reader above |
| `system/compact_boundary` | 37 | handled | `compactEventFromRaw` emits `context_compact` |
| `system/turn_duration` | 1,657 | irrelevant | Written after the Stop hooks of a finished turn. The turn already closed on the assistant's terminal `stop_reason` (1,655 of 1,657 turns end `end_turn`/`stop_sequence` with text), and the Stop hook closes the rest. Counted as activity in `transcriptActivity.ts`. |
| `system/stop_hook_summary` | 1,639 | irrelevant | Bookkeeping for the Stop hooks, which reach the daemon as the hook itself. Counted as activity. |
| `system/local_command` | 107 | handled, models and effort | `/model`, `/effort`, `/usage`, `/goal` with no args, and dialogs closing, as `<command-name>` or `<local-command-stdout>`. `ingestClaude` reads `raw.content`, so "Set model to …" and "Set effort level to …" land. A local command is not a turn; `transformLine` ignores `system` records. |
| `system/informational` | 55 | irrelevant | TUI notices: "Usage limit reached/reset", "Goal paused/still active", "A hook blocked", "Remote Control disconnected", "Unknown command". When one ends a turn, the turn's own synthetic assistant record (`<synthetic>`, `stop_sequence`, `isApiErrorMessage`) carries the reason and closes it. |
| `system/away_summary` | 51 | irrelevant | Claude Code's own "while you were away" summary, written after `turn_duration` when the person comes back. Not part of the conversation. The daemon makes its own recaps. |
| `system/scheduled_task_fire` | 3 | handled, by the record after it | The `/loop` or cron prompt it fires is the next record, a `user` line with `isMeta` and `promptSource: "system"`, which opens a turn (`compactEventFromRaw`). |
| `system/bridge_status` | 1 | irrelevant | Remote-control bridge status. |
| `queue-operation` | 6,361 | irrelevant | The TUI's queue: `enqueue`, `dequeue`, `remove`, `popAll`. What is delivered is written again, as a `user` prompt when the turn has ended or as a `queued_command` attachment mid-turn. `remove` is the person taking it back. |
| `attachment/queued_command`, `commandMode: "prompt"`, `origin.kind: "human"` | 1,541 (all modes) | handled (#855) | In the history (`queuedHumanPrompt`), search and the device's result evidence. It opens no live turn, by design: it joins the running one. |
| `attachment/queued_command`, `commandMode: "task-notification"` | (included above) | **GAP 2, fixed here** | See above. |
| `attachment/queued_command`, `origin.kind: "auto-continuation"` or `"peer"` | rare | irrelevant | Claude's own continuations, and sub-agent hand-backs to the model. Not the person's words (#855). |
| `attachment/goal_status` | 80 | **GAP 3** (`met: false`, not `sentinel`) | Not met: written after the Stop hook's feedback line, then Claude continues the turn. Met: written after the final `end_turn`. `sentinel: true` restates an active goal in a session's opening attachments and is not a continuation. |
| `attachment/hook_blocking_error` | 6 | **GAP 3** (`hookEvent: "Stop"`) | A Stop hook that blocked; the same continuation as the goal loop. |
| `attachment/task_status` | 54 | irrelevant | Restates background tasks (`running`/`completed`) after a compaction, beside `compact_file_reference`. The task's own `<task-notification>` is what finishes it. |
| `attachment/silent_turn_reminder`, `total_tokens_reminder`, `batching_reminder_sent`, `bash_output_audience_note`, `task_reminder`, `date`, `instructions`, `nested_memory`, `skill_listing`, `agent_listing_delta`, `deferred_tools_*`, `mcp_instructions_delta`, `hook_additional_context`, `hook_success`, `hook_system_message`, `invoked_skills`, `prompt_snapshot`, `session_context`, `environment`, `credential_org`, `remote_session_change`, `command_permissions`, `file`, `directory`, `read_truncation_notice` | — | irrelevant | Context injected for the model, or session plumbing. Nothing a person reads in the conversation. |
| `attachment/compact_file_reference` | 72 | irrelevant | Files re-attached for the model after a compaction. |
| `attachment/thinking_drop`, `thinking_stripped` | 26 | irrelevant | Telemetry about thinking blocks the API dropped. |
| `attachment/hook_non_blocking_error`, `hook_cancelled` | 5 | irrelevant | A hook failed or was cancelled without stopping anything. The turn goes on as written. |
| `attachment/edited_text_file` | 583 | irrelevant | Tells the model a file changed outside it. |
| `attachment/auto_mode`, `auto_mode_exit`, `permission-mode`, `mode` | 168 / 1 / 10,217 / 10,220 | irrelevant | The permission mode. The daemon chooses it at launch (`engineLaunch.ts`) and shows no live permission mode. |
| `attachment/model` | 200 | irrelevant | The model's identity, at session start. The model comes from each assistant record's `message.model`, the startup banner and "Set model to" (`runtimeProfile.ts`), which arrive no later. |
| `ai-title`, `custom-title` | 10,063 / 1 | handled, search | `sessionSearch/indexer.ts` (a custom title outranks the AI one). The tile is named from the terminal title Claude Code sets from the same title (`sessionTitle.ts`). |
| `agent-name` | 1,521 | irrelevant | The same title, for Claude Code's own agent views. |
| `last-prompt`, `pr-link`, `cost-state`, `file-history-snapshot`, `file-history-delta`, `atis-latch`, `worktree-state`, `relocated`, `frame-link`, `bridge-session`, `artifact-*`, `continued-in` | — | irrelevant | Claude Code's own bookkeeping. Token usage is summed from the assistant records' `usage` (`agentTokenUsage.ts`), not `cost-state`. |

## Codex 0.160

| Record | Count | Verdict | Evidence |
|---|---|---|---|
| `event_msg/task_started`, `task_complete`, `turn_aborted` | 2,285 / 2,276 / 6 | handled | The turn lifecycle, `codexTaskBoundary`, and the turn error (`codexTaskError`) |
| `event_msg/item_completed/UserMessage`, `AgentMessage` | 297 / 3,093 | handled, except **GAP 4** | The 0.147+ TUI vocabulary (`USER_TURN_TYPES`, `AGENT_TEXT_TYPES`). A message typed mid-task (75 measured) opens a new turn card while Codex keeps working. That is long-standing behaviour, not drift. A `UserMessage` can be the answer to an async question, wrapped (gap 4). |
| `event_msg/token_count` | 7,723 | handled | Token usage and context (`agentTokenUsage.ts`) |
| `token_usage_record` | 7,415 | irrelevant | The same usage, written beside each `token_count`. |
| `event_msg/thread_settings_applied`, `turn_context` | 2,377 / 2,375 | handled | The model controller's model and effort |
| `world_state` | 318 | irrelevant | `AGENTS.md`, environment, permissions and model, injected for the model. The model is read from `thread_settings_applied`/`turn_context`. |
| `event_msg/thread_goal_updated` | 2 | irrelevant | The `/goal` objective and status. The turn is driven by the injected `<codex_internal_context source="goal">` message (still written by 0.160), and the goal's status by the pane. |
| `response_item/message`, `reasoning`, `function_call(_output)`, `custom_tool_call(_output)` | — | handled | Tool cards, thinking and `/goal` turns |
| `compacted` | 83 | handled | `context_compact` |
| `event_msg/item_completed/ContextCompaction` | 73 | irrelevant | Always next to a `compacted` (32 of 32 in main sessions). |
| `response_item/compaction` | 153 | irrelevant | The encrypted summary. At the head of a forked thread it is inherited history, and in a main session it sits beside `compacted`. |
| `event_msg/item_completed/Reasoning` | 7,226 | irrelevant | Duplicates `response_item/reasoning`. |
| `event_msg/item_completed/CommandExecution`, `FileChange`, `McpToolCall`, `ImageView`, `Extension` (`web.search`, `clock.sleep`) | 5,004 / 358 / 378 / 118 / 529 | irrelevant | Details of a tool call already shown as a card. Each sits inside an open `exec`/`js`/`sleep` call: web searches inside `exec` calling `tools.web__run` (240 of 241), which already renders as a WebSearch card. The rest are a background command's completion after its `exec` returned. |
| `event_msg/item_completed/SubAgentActivity` | 769 | **GAP 1, fixed here** | `started` names the spawned child's thread; `completed` is the only record that it finished; `interacted` follows `send_message`/`followup_task`. |
| `event_msg/item_completed/CollabAgentToolCall` | 61 | irrelevant | Detail of `wait_agent`, with empty `agents_states` in v2. |
| `response_item/agent_message` | 1,699 | **part of GAP 1, fixed here** | Inter-agent messages, `Message Type: FINAL_ANSWER/MESSAGE/NEW_TASK`. A child's message to its parent is its report. |
| `inter_agent_communication_metadata` | 663 | irrelevant | `trigger_turn` for the agent_message after it. |

## Not record types, noted on the way

- `runtimeProfile.ts` `readCodexCache` and `sessionTitle.ts` `codexThreadName` fall back to the daemon's own `CODEX_HOME`. This is the moved-homes class, and it is left to that branch.
- `request_user_input_async` (11 calls) is Codex 0.160's question tool beside `request_user_input`. It returns `{"accepted":true}` at once, and the answer arrives later as a user message (gap 4). Its card is the plain tool name, as before. The question itself is read from the pane, and how 0.160 draws this one was not recorded, so this audit does not cover it.
