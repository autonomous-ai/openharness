Rollback: harmless in a pane. Outside a pane, an older CLI tells the devices every Codex Stop as `turn-stop` until the person updates (Known gap below).

# Facts: an older CLI with the new hook blocks

Plan Task 3, spec §7. A rollback to an older CLI does not prune hook blocks, so the blocks this change installs stay
and run that CLI's `notify.mjs`. This records what that `notify.mjs` does with each new event.

## How it was checked

- `notify.mjs` as of `e9670ffd23` (`git show e9670ffd23:cli/hook/notify.mjs`; identical to the feature branch's at
  `8f597968e1`), run from a scratch copy.
- Run as `cli/src/hookNotify.spec.ts` runs the hook: its `runHook` and `collect` (a stub server on a free port that
  records every POST), a throwaway data folder and Codex home, the fixture `tmux` and `ps`, and the argv the spec builds
  (`--port`, `--data-dir`, `--codex-home`, `--engine codex`), the flags `hookArgv` passes that this hook reads.
- Each event once in a pane (`TMUX_PANE=%4`, a Harness tmux session) and once with no `TMUX_PANE`. Every input carried
  a `tool_input` with a marker string, to see whether any body carries it.
- macOS (Darwin 25.6), Node 24, 2026-11-17.

## In a pane

| Engine | Event | Posts | `hookEvent` | Time |
|---|---|---|---|---|
| Claude Code | PreToolUse (`AskUserQuestion`) | `/api/hook/session-start` | `PreToolUse` | 287 ms |
| Claude Code | PermissionRequest | `/api/hook/session-start` | `PermissionRequest` | 268 ms |
| Claude Code | Elicitation | `/api/hook/session-start` | `Elicitation` | 252 ms |
| Claude Code | Notification (`permission_prompt`, `elicitation_dialog`) | nothing | | 235-237 ms |
| Claude Code | SubagentStart | `/api/hook/session-start` | `SubagentStart` | 629 ms |
| Claude Code | SubagentStop | `/api/hook/session-start` | `SubagentStop` | 366 ms |
| Codex | Stop | `/api/hook/session-start` | `Stop` | 265 ms |
| Codex | PermissionRequest (`exec_command`) | `/api/hook/session-start` | `PermissionRequest` | 537 ms |
| Codex | PreToolUse (`request_user_input`) | `/api/hook/session-start` | `PreToolUse` | 251 ms |
| Codex | Interrupt | `/api/hook/session-start` | `Interrupt` | 272 ms |
| Codex | SubagentStart | `/api/hook/session-start` | `SubagentStart` | 247 ms |
| Codex | SubagentStop | `/api/hook/session-start` | `SubagentStop` | 645 ms |

- Every run: stdout empty, exit 0. So no hook of the old CLI decides a permission, answers a question or blocks a tool.
- No body carries a `prompt` or any of the tool's input (the marker string reached no request).
- Time is the whole child process, Node start and the fixture `tmux` and `ps` included, as every hook of today costs.
  The engine waits this long before it draws a wait's dialog: once per wait, the same as any hook it runs today.
- Why: Claude Code's Notification in a pane returns at once (`notify.mjs:2064`). Every other new event, for Claude Code
  and Codex alike, takes none of the engine branches (the Stop branch is Claude Code's, Command Code's and Devin's
  only) and ends in the registration at the end of `main()` (`notify.mjs:2350`), the catch hook. The prompt is sent only
  for UserPromptSubmit (`notify.mjs:2338`).

## What the daemon does with those registrations

At `e9670ffd23`, `/api/hook/session-start` takes these as it takes UserPromptSubmit's, without the prompt credit:

- The prompt credit (`onPromptSubmitted`, and `onPromptHook` that turns a late Stop apart from the next turn) is given
  only when `hookEvent === 'UserPromptSubmit'` (`cli/src/hookServer.ts:866-869`). None of these is credited.
- `onRegistered` gets the `hookEvent` (`hookServer.ts:870-871`). The bind resets the session's transcript only for a
  new or recovered session or a `SessionStart` (`cli/src/core/agents/bind.ts:254-256`). None of these resets it.
- `hookEvent` passes `validHookBody` (a string of at most 100 characters, `hookServer.ts:229`).

So in a pane each new event re-registers a session already registered (idempotent) and changes nothing else: status is
read from the transcript, as before this change.

## Outside a pane

| Engine | Event | Posts to `/api/hook/observed` |
|---|---|---|
| Claude Code | PreToolUse, PermissionRequest, Elicitation, SubagentStart, SubagentStop | nothing |
| Claude Code | Notification (`permission_prompt`, `elicitation_dialog`) | `needs-input`, as today |
| Codex | Stop | `turn-stop` |
| Codex | PermissionRequest, PreToolUse, Interrupt, SubagentStart, SubagentStop | nothing |

Stdout empty and exit 0 every time, 65-144 ms each.

Why: `observedEvent` (`notify.mjs:588-605`) maps `Stop` to `turn-stop` through `OBSERVED_EVENTS` (`notify.mjs:579`)
for every engine; the only engines it treats apart (agy, Grok, Cursor, Copilot) are not Codex. Nothing else of the new
events is in that map.

## Known gaps

- **Codex outside a pane, after a rollback.** The older `notify.mjs` tells the devices every Codex Stop outside a pane
  as `turn-stop`, so the dial sounds at each Codex turn outside a pane until the person updates again. Today no Stop
  block is installed for Codex, so this is new. It is the plan's open question; recorded here as found, not judged.
- **Codex's subagent events depend on Task 2.** The old hook registers a Codex SubagentStart or SubagentStop under its
  `session_id` and `transcript_path`, unless `isCodexSubagent` (`notify.mjs:2069`) finds the source or the rollout's
  `session_meta` names a subagent. This run gave the lead's `session_id`, as Task 13 expects. If Task 2 finds these
  events name the child's thread with a rollout `isCodexSubagent` does not recognise, the old hook would register the
  child in the lead's pane, and this verdict is to be redone.
