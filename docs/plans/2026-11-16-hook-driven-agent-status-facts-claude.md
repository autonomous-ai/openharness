Claude waits: PermissionRequest+Elicitation

# Facts: Claude Code's hooks, for hook-driven status

Task 1 of [the plan](2026-11-16-hook-driven-agent-status-plan.md), for [the spec](2026-11-16-hook-driven-agent-status-design.md)
§1 and "Left to the builder". Read on 2026-11-17.

Sources, each named below by its short name:

- **docs**: <https://code.claude.com/docs/en/hooks.md>, fetched 2026-11-17.
- **changelog**: <https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>, fetched 2026-11-17 (newest entry 2.1.326).
- **326**: `strings` of the installed bundle `~/.local/share/claude/versions/2.1.326`.
- **209**: `strings` of `@anthropic-ai/claude-code-darwin-arm64@2.1.209` (published 2026-07-14), from `npm pack` into the scratchpad.
- **run**: 2.1.209 run with `HOME` and `CLAUDE_CONFIG_DIR` set to throwaway folders, `--version` and `doctor` only.

Names like `Xyr` or `n8e` are the minified names in that one bundle, given so the string can be found again.

## 1. Notification fires 6 s after the dialog opens, not as it opens

Variant P: PermissionRequest and Elicitation are the wait hooks.

- `permission_prompt`, `elicitation_dialog` and `elicitation_url_dialog` all go through one React hook. It checks every
  6 000 ms and fires once the person has not typed for 6 000 ms, counted from when the dialog opened. Each key starts
  the wait again.
  - 209: `function Xyr(e,t){…ec(()=>{if(osb(Zjp))o(!0),Tye({message:e,notificationType:t},r)},n?null:Zjp)}var Tdn,Zjp=6000`.
    Callers: `Xyr(cNx,"permission_prompt")` in the dialog host, `Xyr("Claude Code needs your input","elicitation_dialog")`
    and `Xyr(…,"elicitation_url_dialog")` in the two elicitation dialogs.
  - 326: `function Z4o(h,x){return Date.now()-Math.max(Gm(),x)>=h}` and `qFe(…){…Za(()=>{if(!Z4o(jqn,Ke))return;…nV({message:h,notificationType:x},…)},De?null:jqn)}`, `jqn=6000`.
  - docs, Notification: "`permission_prompt` … and the prompt has waited about six seconds"; "Expect `permission_prompt`
    once you haven't typed for about six seconds. The timer starts when the permission prompt appears, and each
    keystroke defers it. To run a hook immediately when Claude asks for permission to use a tool, use
    PermissionRequest instead." The same six-second gate for both elicitation types.
- This matches the repo's own record: `cli/e2e/harness/fakeEngine.mjs`, `PERMIT_NOTICE_MS = 6_000`.
- A permission answered within 6 s sends no Notification at all, so Variant N would miss every fast answer and read
  working for the first 6 s of every wait.

## 2. The events the plan installs

### First release with each (changelog)

| Event | First release | Entry |
|---|---|---|
| PreToolUse | 1.0.38 | "Released hooks" |
| SubagentStop | 1.0.41 | "Split Stop hook triggering into Stop and SubagentStop" |
| Notification matcher | 2.0.37 | "Added matcher values for Notification hook events" |
| SubagentStart | 2.0.43 | "Added the `SubagentStart` hook event" |
| PermissionRequest | 2.0.45 | "Added `PermissionRequest` hook" |
| `agent_id`, `agent_type` on hook events | 2.1.69 | "Added `agent_id` (for subagents) and `agent_type` …" |
| Elicitation | 2.1.76 | "Added new `Elicitation` and `ElicitationResult` hooks" |
| An unknown event no longer voids the file | 2.1.101 | "an unrecognized hook event name in `settings.json` no longer causes the entire file to be ignored" |

### Stdin fields

Every event carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and `agent_id`, `agent_type` when it
fires inside a subagent (docs, Common input fields). Built by one function for every event: 209 `function If(e,t,r)`
returns `{session_id:n,transcript_path:MH(n),cwd:…,permission_mode:e,agent_id:r?.agentId,agent_type:o,…}`; 326 `function Nm(e,n,r,a)`.

| Event | Its own fields (docs; the same in 209 and 326) |
|---|---|
| PreToolUse | `tool_name`, `tool_input`, `tool_use_id` |
| PermissionRequest | `tool_name`, `tool_input`, `permission_suggestions` (no `tool_use_id`); 209: `{…If(o,void 0,n),hook_event_name:"PermissionRequest",tool_name:e,tool_input:r,permission_suggestions:i}` |
| Elicitation | `mcp_server_name`, `message`, optional `mode`, `url`, `elicitation_id`, `requested_schema` |
| SubagentStart | `agent_id`, `agent_type`; 209: `{…If(void 0),hook_event_name:"SubagentStart",agent_id:e,agent_type:t}` |
| SubagentStop | `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons` |
| Notification | `message`, optional `title`, `notification_type` |

`tool_input`, `message`, `url`, `requested_schema` and `last_assistant_message` are outside text: `notify.mjs` sends
none of them on.

### Does Claude Code wait for the hook before it draws the dialog?

- **PreToolUse: yes.** It runs before the tool call and can block it (docs: "Before a tool call executes. Can block
  it"). The AskUserQuestion dialog is the tool's permission step, which comes after PreToolUse returns.
- **Elicitation: yes.** 326: `let m=await this.deps.runElicitationHooks(i,…);…else if(m){…return…}` before
  `handleElicitation` opens the dialog; 209 logs `Received elicitation request:` then `Elicitation resolved by hook:`
  in the same order. docs: "Hooks can intercept this request and respond programmatically, skipping the dialog entirely".
- **PermissionRequest: no, in the lead's own session. The hook and the dialog start together.** 209 `THd`, 326 `ut`:
  `if(!s)(async()=>{…let b=await t.runHooks(…);…})()`, a call not awaited, where `s` is
  `awaitAutomatedChecksBeforeDialog`. That flag is set only for some subagent runs (209 `runAgent`: `if(o&&!qo)Lr={…Lr,awaitAutomatedChecksBeforeDialog:!0}`)
  and the teammate path (`awaitAutomatedChecksBeforeDialog:!0`). There the hook is awaited first. docs: "the hooks run
  alongside your host, and whichever decides first applies."
  For the plan this changes nothing: no pane is read at the hook (R4). The dialog is on screen by the watcher's next poll either way.

### PreToolUse matcher `AskUserQuestion` runs the hook for that tool only

A matcher of letters, digits, `_` and `|` is an exact-name list. 209 `function p__(e,t,r,n){if(!t||t==="*")return!0;if((r?/^[a-zA-Z0-9_|, -]+$/:/^[a-zA-Z0-9_|]+$/).test(t))return t.split(…).…includes(e);…}`;
326 `sZ` keeps the exact path. docs, Matcher patterns: "Only letters, digits, `_`, `-`, spaces, `,`, and `|` → Exact
string". The tool's name is `AskUserQuestion` in both (docs, PreToolUse; 209 `Um="AskUserQuestion"`).

### Exit 0 with empty stdout leaves the decision to the person

docs, Exit code output table: "Plain text, or nothing | Exit 0: Success". No fields means no decision. PreToolUse then
goes on to the normal permission check. A PermissionRequest hook decides only with `hookSpecificOutput.decision`.
Elicitation: "Leave the request to the user: No output, with exit code 0". For AskUserQuestion even an `allow` without
`updatedInput` does not answer (209 `runHooks`: `if(!y.updatedInput&&e.requiresUserInteraction?.())return null`).

### A subagent's events carry the lead's `session_id`

`session_id` is the session's, never the subagent's: 209 `If` takes `kt()` (the session id), 326 `Nm` takes `e.id` of
the session. The subagent is told apart by `agent_id`. docs, SubagentStop: "The `transcript_path` is the main
session's transcript, while `agent_transcript_path` is the subagent's own transcript". This holds for a subagent's
PreToolUse and PermissionRequest too, which also carry its `agent_id`.

Exception, 326 only: a call served for another session (`a?.remoteCall`) carries `session_id: "served:<caller>"`
with an empty `transcript_path`. That id matches no Harness session.

### A subagent's end fires SubagentStop, never Stop

One function picks the event by whether an agent id is set: 209 `async function*n8e(…){let l=o?"SubagentStop":"Stop"…`,
326 the same (`Pe=h?{…hook_event_name:"SubagentStop",…}:{…hook_event_name:"Stop",…}`). The changelog's 1.0.41 split
says the same. A subagent that is interrupted still fires SubagentStop (209 `runAgent` cleanup:
`[runAgent] SubagentStop on interrupted query failed`). The lead's Stop does not fire on the person's interrupt (docs, Stop).

## 3. The oldest supported, 2.1.209

### Every event the plan installs is there

209's event list (the settings enum `_U`, also printed by `doctor`): PreToolUse, PostToolUse, PostToolUseFailure,
PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure,
SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup, TeammateIdle,
TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove,
InstructionsLoaded, CwdChanged, FileChanged, MessageDisplay.

| Needed | In 2.1.209 |
|---|---|
| PreToolUse with matcher `AskUserQuestion` | yes (exact-name matcher, above) |
| PermissionRequest | yes |
| Elicitation | yes |
| SubagentStart, SubagentStop | yes |
| Notification `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog` | yes (`Xyr` callers, above) |

Since 2.1.209 Claude Code has added only PreModelSwitch, PostModelSwitch (2.1.251) and DirectoryAdded, none of which
the plan installs. So for Claude Code the older-engine case of Task 22 has no event to leave out at 2.1.209 or later:
its `withoutHooks` is empty. An engine that lacks one of these is older than supported.
(`quota_auto_resume_stale` in today's Notification matcher needs 2.1.234, per docs; an older engine never sends it.)

### An unknown event is ignored, the rest of the file applies

- 209 reads a settings file through `Cai`, which runs `sUe` before the schema. `sUe` calls `ckm`, which deletes each
  unknown key under `hooks` with a warning: `if(!lkm.has(i)){delete n[i],o.push({…message:\`Unknown hook event "${i}" was ignored. …\`,severity:"warning"…});continue}`.
  The settings UI says of warnings: "The values listed above were skipped; the rest of the file is in effect."
  Only errors skip the whole file ("Files with errors are skipped entirely").
- run: a `settings.json` with Stop, PreToolUse (`AskUserQuestion`), PermissionRequest, Elicitation, SubagentStart,
  SubagentStop, and two events 2.1.209 does not know (`PreModelSwitch`, `NotAnEvent`). `doctor` lists only the two:
  `hooks.PreModelSwitch: Unknown hook event "PreModelSwitch" was ignored.` and the same for `NotAnEvent`. Nothing else
  is flagged.
- changelog 2.1.101: "an unrecognized hook event name in `settings.json` no longer causes the entire file to be ignored".

## 4. Step 2's stop conditions: none is met

- An unknown event does not make a supported release refuse the file (§3).
- A subagent's end fires SubagentStop, not Stop (§2).
- The PreToolUse matcher is honoured as an exact tool name (§2).
- An empty stdout decides nothing (§2).

## 5. Found on the way, for the tasks that follow

- **SubagentStop without a SubagentStart.** Claude Code's own forked agents end with SubagentStop, with a fresh
  `agent_id` and an empty `agent_type`, and never fire SubagentStart. They include prompt suggestions and `/btw`.
  docs, SubagentStop: "Claude Code also runs internal agents for some of its own features … and SubagentStop fires when
  one of those finishes too". 209 `W_o` gives a fork `agentId:t?.agentId??kO()`. SubagentStart runs only in `runAgent` (209 `LJr`).
- **Before 2.1.311, a SubagentStop about every 30 s for each running background subagent.** changelog 2.1.311: "Fixed
  `SubagentStop` hooks running about twice a minute for each running subagent instead of once when it finishes".
  In 209 a background subagent forks a summary agent every `Hxy=30000` ms (`[AgentSummary] Forking for summary`),
  and each fork ends with SubagentStop.
- **SubagentStart more than once for one subagent.** It also fires when Claude resumes a subagent, and each time an
  in-process teammate handles a new message (docs, SubagentStart).
- **A matcher does not screen these out on every supported release.** A SubagentStop matcher that cannot match an
  empty `agent_type` skips the forks only from 2.1.275. changelog 2.1.275: "Fixed `SubagentStop` hooks with a specific
  `matcher` firing for every stopping subagent whose agent type was empty". In a session run with `--agent`, the forks
  carry that agent's type (docs, SubagentStop), so no matcher tells them apart there either.
  Together these move R5's count, one integer floored at 0, below the number of subagents running. On 2.1.209 to
  2.1.310 it can read 0 about 30 s after a background subagent starts.
- **PermissionRequest also fires for AskUserQuestion and ExitPlanMode.** docs, PermissionRequest decision control:
  "`AskUserQuestion` and `ExitPlanMode` need this field". An AskUserQuestion call so sends PreToolUse and then
  PermissionRequest, both waits on the same dialog.
- **No PermissionRequest for a sandboxed command's network request.** docs, PermissionRequest: "Claude Code doesn't
  run PermissionRequest hooks for a sandboxed command's network request. To get a signal for that prompt, use the
  `permission_prompt` notification type." Under Variant P that prompt opens no wait. It is drawn as a dialog, so the
  question watcher still finds it at its poll, as today.
- **The dial's own PermissionRequest hook runs beside ours** (`hooks/harness-device`). When it answers, the dialog
  closes at once; the wait then ends on two clear polls (plan, Review Focus 4).
- **The lead's Stop while a background subagent runs.** Stop fires when the lead's turn ends even while a background
  subagent still runs; Stop's `background_tasks` lists it (docs, Stop input). Its SubagentStop comes later.
