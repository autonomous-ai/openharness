# Harness requests and Claude Code / Codex actions

Implementation review: `worktree-agent-resume`, [PR #168](https://github.com/autonomous-ai/openharness/pull/168).
The original proposal and pre-change mapping are preserved in [issue #167](https://github.com/autonomous-ai/openharness/issues/167).
The original command dock and welcome screen were merged in #165. This branch adds CLI/daemon lifecycle behavior and the follow-up desktop changes described below. It remains unmerged for team review.
Commands below omit existing profile, permissions, provider, installer and shell-wrapper arguments.

## Three identities

- `agentId` identifies the Harness row that clients address.
- `sessionId` identifies the Claude Code or Codex conversation. A session
  rotation can change it without changing the Harness row or tab.
- The process identity and terminal route identify the running CLI and its
  pane. Restart replaces the process; resuming a stopped harness allocates a
  new pane while retaining the Harness and conversation IDs.

The registry has separate process, route and conversation indexes. A running
CLI can be idle, working, or waiting for input; these are turn states, not
evidence that the process is stopped.

## Request mapping

These are client-to-daemon requests, answered with `<request>_result`. The
three pushes discussed below run in the opposite direction.

| Request | tmux action | Claude Code / Codex action | Registry and persisted state |
| --- | --- | --- | --- |
| `agent_create` | `new-session -d`: new session and initial pane | Launch `claude [prompt]` / `codex [prompt]`; install a missing executable through the existing launch wrapper | `openPendingAgent` creates a new Harness ID with the new route, saved launch settings, `launch: starting`, and no engine conversation yet. Hooks/discovery bind `sessionId` and the process identity. |
| `agent_delete` | **`kill-session` for the session containing the registered pane** | In parallel, validate the engine PID identity; SIGTERM if still alive, then SIGKILL after the grace period if needed | Remove the live row and its route/process/conversation indexes through `removeAgent`; clear runtime tracking. Vendor history, recaps and name overrides remain. Save a durable archive **before removal**; a storage failure refuses the explicit stop before mutation. |
| `agent_restart` | Enable `remain-on-exit`; terminate the engine; `respawn-pane -k` in the existing pane | `claude --resume ID` / `codex resume ID` when known; existing fallback can launch fresh | Retain Harness ID and route. Hold reconciliation during replacement; update process identity and provider observations, then persist. A fresh fallback's new conversation is bound by a later hook. No missing-pane recreation. |
| `agent_fork` | New session and pane; source untouched | `claude --resume ID --fork-session` / `codex fork ID` | New pending row and Harness ID, initially carrying `forkedFrom`; bind the newly forked engine conversation later. Source row remains. |
| `agent_retarget` | Existing pane, same process-swap mechanism as restart | Relaunch with changed provider/grid configuration and native resume arguments | Retain Harness ID and route; replace process identity, save the new grid launch configuration and any remembered subscription model. Inherits restart's possible fresh fallback. |
| `agent_update` with `name` | `select-pane -T` changes the pane title | No native conversation rename command | `registry.rename` persists a name override keyed by engine `sessionId`, or `agentId` before a session is bound. Does not replace the row, process or conversation. |
| `agent_update` with `selectedModel` | Send terminal input in the existing pane | Claude `/model <model>` and `/effort <effort>`; Codex `/model` menus | Keep registry identity, route and process. Runtime profile state/observations are updated and announced; no lifecycle row replacement. |
| `agents_list` | No mutation | None | Reads `registry.advertised()` (verified available terminal routes). `includeStopped: true` merges eligible archive records into the response without adding stale routes back to the live registry. |
| `agent_create_status` | No mutation | None | Reads a separate durable operation receipt, optionally resolving its resulting live row. Does not launch or recreate a registry entry. |
| `agent_recent` | No mutation | None | Resolves Harness ID to engine `sessionId` and reads stored recaps/recent user asks. Providers resolve through the live registry or the archive, so recaps and recent asks work before Open. |
| `agent_files` | No mutation | None | Reads the live row's `cwd`, then lists project files. No registry change. |
| `agent_read_file` | No mutation | None | Reads the live row's `cwd`, then a bounded project file/media chunk. No registry change. |
| `agent_resume` **(this PR)** | Keep a verified running runtime; otherwise allocate a new session and pane for saved work | `claude --resume <savedSessionId>` / `codex resume <savedSessionId>`; no fresh fallback | Return a verified running engine. Otherwise reserve the operation, restore the **same Harness ID and conversation ID** on a new route with no stale PID and `launch: starting`, and await the exact conversation hook from the new process. Keep the saved record on failure. No fresh fallback. |


Harness normally creates one tmux session per harness, initially with one
pane. The app's multi-pane layout displays these runtimes; selecting an
existing harness adds or focuses a view rather than starting another CLI.
The implementation of `kill` still targets the **whole tmux session**. Any
additional windows/panes in that session would close too. This corrects the
earlier description of `agent_delete` as killing only one pane; the exact
command is in [`tmuxBackend.ts`](../../cli/src/lib/tmuxBackend.ts).

For restart, a removed registry row yields `AGENT_NOT_FOUND`. If the stale
row still has a missing pane, the `remain-on-exit` step fails and restart
returns a failure before signalling the saved engine. If the pane disappears
later, respawn also fails. Restart never calls `agent_delete` and never
allocates a replacement tmux session.

`agent_pause` is not implemented. No native pause operation is wired here.

Request dispatch lives in [`backendSocket.ts`](../../cli/src/backendSocket.ts).
The daemon wires its callbacks in [`cli.ts`](../../cli/src/cli.ts). The production Stop and Resume handlers are [`stopAgentService.ts`](../../cli/src/lib/stopAgentService.ts) and [`resumeAgentService.ts`](../../cli/src/lib/resumeAgentService.ts); the native acceptance fixture uses these same handlers. Exact resume and fork argv are in [`engineLaunch.ts`](../../cli/src/lib/engineLaunch.ts).
Process replacement and fallback are in
[`restartAgent.ts`](../../cli/src/lib/restartAgent.ts); strict stopped resume is
in [`resumeStoppedAgent.ts`](../../cli/src/lib/resumeStoppedAgent.ts).
In-process model changes are in
[`runtimeProfileController.ts`](../../cli/src/lib/runtimeProfileController.ts).

## Registry design to review

The live registry is persisted, but it is an index of runtimes and their
current conversation bindings, not a complete history of every conversation.
This PR adds a separate durable saved-session store. Old pane IDs and
PIDs can be retained there as historical evidence, but must not be reinserted
as live routes/processes when resuming.

The stop/resume transition is:

1. Capture the conversation before stopping the process. If its binding is missing,
   verify the PID/start marker and recover from Claude's native process record,
   explicit resume arguments, or an unambiguous newly created native transcript.
   Never select a different conversation merely because it shares the project.
   Save the Harness ID, conversation ID, cwd, name, profile and launch settings
   before removing the live row. An unbound snapshot of the same process cannot
   overwrite a previously confirmed conversation.
2. End the old runtime. The saved record remains searchable in the user-facing
   harness catalog; it has no user-facing Stopped badge or different action.
3. On Enter, either return a verified running instance of that conversation or
   create a new runtime and associate it with the same saved identity.
4. Confirm startup separately from pane allocation. Failure retains the saved
   session and reports an error, without silently starting fresh.

When an engine exits into a surviving shell, its conversation is archived under the original Harness ID. `releaseEngine(agentId, true)` removes its process, route and conversation indexes, then preserves that physical shell under a new Terminal ID. No input is sent and no shell process is replaced. The saved conversation remains searchable under the original ID; Open creates a new runtime for it. Archives written by the early prototype behind a same-ID Terminal are separated on startup or Open.

A rename uses the separate name-override file, so it outlives removal from the
live registry. A new conversation created through `/clear` or `/new` rebinds
the existing Harness row to a different engine `sessionId`; it need not change
the app tab, Harness ID or tmux route.

## Turn actions and events are separate

| Action or event | What this code does |
| --- | --- |
| `message` | Types the prompt into the existing terminal and submits Enter. Transcript/hook events report the resulting turn. |
| `cancel` | Sends Ctrl-C through the input queue and closes Harness's busy bookkeeping. Intended to interrupt the turn, not implement process pause/resume. |
| Terminal attach/detach | Connects or disconnects a terminal viewer. Detaching is separate from stopping the CLI. |
| Claude `SessionStart` / catch hooks | Bind the engine conversation and transcript to a discovered or pending Harness row. |
| Claude `Stop` / `StopFailure` | Close the turn, with an error indication for failure. They do not mean the CLI process exited. |
| Claude `SessionEnd` | Requests reconciliation. Process discovery decides whether the engine actually exited; this hook alone does not remove the Harness. |
| Codex `task_started` / user-message events | Feed turn tracking. In the normalizer, `task_started` marks a pending task and the user-message event opens `turn_started`. |
| Codex `task_complete` / `turn_aborted` | Close the open turn as `turn_ended`. They do not imply process death. |
| Engine process exits while its shell survives | Archive the conversation under its original ID; preserve the shell under a new Terminal ID. Send a retained-session snapshot and a separate terminal snapshot. |
| Terminal route disappears | Reconciliation removes the live row. The new archive retains its saved resume information. |

Evidence: [`notify.mjs`](../../cli/hook/notify.mjs),
[`codex/normalizer.ts`](../../cli/src/engines/codex/normalizer.ts),
[`sessionInput.ts`](../../cli/src/lib/sessionInput.ts), and
[`registry.ts`](../../cli/src/lib/registry.ts).

| Daemon push | Meaning for clients | tmux / engine action caused by the push |
| --- | --- | --- |
| `agent_synced` | Upsert the current Harness row, including identity, launch state and terminal availability. Used for newly observed and updated agents. | None; reports a change already observed or performed. |
| `agent_deleted` | Remove the row/view from the receiving client's live inventory. The `retained` flag tells desktop to reload the stopped catalog. | None. It is not itself a kill command or proof that the engine exited; terminal unavailability can also produce it. |
| `agent_renamed` | Update the Harness display name. | None; name/title mutation happened separately. |

Natural engine exit sends `agent_synced` with `status: stopped` and no terminal route for the original identity. The separate shell is announced as a Terminal. Devices receive a deletion for the engine because they list live agents. Explicit Stop still sends `agent_deleted` with `retained: true`, so desktop closes its live views and refreshes the saved catalog.

## Cmd-P/T contract

- Cmd-T immediately opens a temporary tab with a plain charcoal background, **Follow your curiosity.** centered in the visible area above the dock, and no wallpaper or animation. Escape cancels an untouched draft and returns to its previous tab; if that tab has since closed, the final empty workspace returns to onboarding with its dock. The full diagram is reserved for onboarding.
- Cmd-P opens the dock over the current tab. Both pickers show up to ten recent sessions plus New Harness, with a smaller visible viewport on short windows; typing searches the full catalog.
- The New Harness form has **Open in** after Task and before Start. Cmd-N and Cmd-P default to New Pane; Cmd-T defaults to New Tab and fills the tab already created. Enter or a click toggles directly between the two destinations. Creation in flight or awaiting its receipt keeps its destination.
- Stop closes tabs emptied by that harness and its owned viewers. Occupied tabs, other machines' panes, unrelated tabs, presets and pending creation destinations are preserved. If no tabs remain, one onboarding page opens with the dock.
- Pane menus and corresponding dialogs call the whole session a **Harness**. Agent remains the engine choice inside New Harness.
- All retained harnesses use the same row, Enter glyph and **Open** action. No Stopped badge, separate Resume action or confirmation dialog.
- Running sessions keep their existing process and conversation; opening multiple app views was already supported.
- Stopped Claude Code and Codex sessions use native resume with the exact saved conversation. Required cwd, Codex profile, permission mode, DSH and provider configuration are preserved. Missing history, project, DSH or provider credentials produce explicit errors.
- Pane allocation publishes `launch: starting`. Process discovery alone does not mark strict resume ready. A verified native hook must bind the requested conversation and the readiness poll must observe that same process. A different session ID fails instead of rebinding to a new conversation.
- Desktop can open the newly allocated terminal while its receipt is pending, so native login, trust review and input remain usable. The terminal must match the selected machine, Harness ID and saved conversation; a mismatched or failed launch cannot replace the selected view.
- **Codex 0.154.0 defers its SessionStart hook until the first submitted message.** Native history is visible before that input, but daemon confirmation remains pending until the exact hook arrives. After ten minutes without confirmation, the receipt reports `RESUME_UNCONFIRMED` and retains the runtime/reservation; it does not launch a replacement. The acceptance fixture verifies this order. Production does not submit a prompt, restore process memory or promise to continue an interrupted tool call.
- An explicit **Start New Conversation** action remains available after failure; it is never invoked automatically.

## Concurrency and recovery

- Resume and Restart share an agent coordinator. Repeated requests for the same operation join; conflicting operations return `AGENT_BUSY`. Stop cancels a pending operation before its next mutation. Retarget checks this coordinator and its terminal control lease.
- Conversation reservations match the registry's conversation uniqueness constraint, including requests through different retained Harness IDs.
- `creationId` uses the existing durable receipt protocol and `agent_create_status`. A retry of the same intent returns its recorded result or uncertainty, never a new process.
- A private, fsynced per-agent `.resume` reservation is written **before** history preparation and tmux allocation. It protects the gap between starting tmux and persisting a new registry row, including requests with a different receipt ID after daemon restart.
- Confirmed native binding, verified completion or a confirmed stop clears the reservation. Unknown allocation/readiness keeps it; startup failure keeps history and preserves the shell/output when available.
- On daemon restart, a strict-resume row whose pane disappeared is archived for explicit Open. It never enters restore's fresh fallback. A surviving engine is re-observed, and a surviving shell is separated from the saved conversation.

## Scope and review limits

- Conversation resume supports **Claude Code and Codex on tmux**. A retained Terminal can open a new shell; shell process memory is not restored. Other engines' saved rows remain discoverable and return an explicit unsupported-history error on Open.
- The catalog contains histories retained by this daemon, not vendor conversations that Harness never recorded. Previously deleted histories are not imported.
- `agent_recent` works from the archive. Other file/model/edit RPCs still use a live row; open the harness before using them.
- Unknown tmux allocation is intentionally conservative. If the daemon died before any runtime was registered and no native hook later confirms it, the reservation remains blocked for operator investigation. There is no automatic force-clear, destructive retry or terminal takeover in this PR.
- Native acceptance passed with Claude Code 2.1.278 and Codex 0.154.0 on macOS/tmux. Login with real accounts, other vendor versions and Linux remain team acceptance checks. Verification uses isolated profiles and a separate tmux server; it does not replace the running user daemon.

## Repeatable verification

From `cli/`:

```sh
npm run test:resume
npm run test:resume-native
```

`test:resume` runs 181 tests and enforces **100% lines, statements, branches and functions** for five production modules: `captureResumeIdentity.ts`, `resumeAgentService.ts`, `resumeStoppedAgent.ts`, `stopAgentService.ts` and `stoppedAgents.ts`. This is measured coverage of those modules, not a claim of 100% coverage of the repository or every runtime environment. The complete CLI suite passed **3,820 tests, with 63 skipped**. TypeScript checking and the normal `build.mjs` build passed.

`test:resume-native` requires installed Claude Code, Codex and tmux. It launches the real vendor CLIs against synthetic saved conversations using the production BackendSocket, Stop/Resume handlers, registry/archive, launch arguments and native hook server. It verifies visible saved history, exact conversation IDs, live attach without process replacement, operation receipts, Stop persistence across a registry reload, new tmux runtimes on resume, preservation of a surviving shell after engine exit, and recovery when the live row and archive have deliberately lost their conversation binding before Stop. It uses a separate tmux socket, isolated data/config directories and unavailable loopback model endpoints, without real credentials or paid model calls. Only after restored Codex history is visible does the fixture submit a harmless test message to trigger its deferred native hook. No such message is submitted by production resume.

The native desktop acceptance test also passed using the production local WebSocket,
terminal stream manager, tmux backend and installed CLIs. For **each** Claude/Codex
session it stops and reopens through both Cmd-P and Cmd-T, verifies the original
history in the desktop terminal buffer, checks the live registry and archive,
confirms replacement PID/pane IDs after Stop and unchanged IDs for live attach,
and keeps an unrelated tab open. Run it with the fixture isolated from real work:

```sh
# cli/ — prints its loopback URL; keep this process running
npm run test:resume-native -- --serve
# desktop/ — replace the port with the printed fixture port
FLUTTER_TEST=1 flutter test -d macos --no-pub integration_test/native_resume_e2e_test.dart \
  --dart-define=RESUME_FIXTURE_URL=http://127.0.0.1:PORT
# Stop the disposable fixture after testing (or press Ctrl-C in its terminal)
curl -X POST http://127.0.0.1:PORT/shutdown
```

This fixture build replaces the local debug app; rebuild the normal `lib/main.dart`
review artifact afterward. Its injected keyboard events verify Flutter commands,
not physical OS keyboard/IME delivery.

Desktop regression coverage includes Cmd-P/T selection of retained sessions, pending native terminals, receipt and identity races, creation placement, repeated Cmd-T, Escape from search and creation, occupied-tab preservation, and the last-tab onboarding exception. The final full desktop suite passed **2,739 tests, with 10 skipped**. The analyzer reported no errors or warnings, with 17 existing informational findings. The plain New Tab and onboarding layouts were visually reviewed with the real dock at 1280×800 and 960×640; a widget regression verifies the tagline stays centered in the visible area above search and creation docks.

## Suggested manual acceptance checks

1. Open a running Claude Code/Codex harness in a second app pane; its process and conversation should be unchanged.
2. Stop a disposable harness, find the same name in Cmd-T/P, and press Enter. Check the same conversation, folder and permissions; no confirmation or fresh conversation.
3. Exit the engine into its shell, start harmless shell work there, then Open the retained conversation. The shell must remain untouched; the resumed engine gets another pane under its original Harness ID.
4. Press Enter repeatedly or from two clients. Confirm one runtime and identical receipt outcomes.
5. Make a disposable history unavailable, or make its native resume command fail. Check the explicit error, retained saved row and separate Start New Conversation action.
6. Restart the daemon during startup and repeat the same receipt. Check confirmed recovery or explicit uncertainty, with no duplicate engine or fresh fallback.

`agent_pause` is outside this PR. Turn completion/cancellation is separate from process stop and conversation resume.
