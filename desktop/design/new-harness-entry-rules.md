# New Harness entry rules

Presentation follows the [terminal dialog design system](terminal-dialogs.md).
Use that guide for current visuals; this document owns entry and launch behavior.

Startup and Cmd-T show the same quiet welcome page. Cmd-T creates a blank tab;
Escape leaves that tab open. The command dock opens only after an explicit
Cmd-N, Cmd-P, or Cmd-Shift-P action. Start Harness submits the reviewed draft;
opening or cancelling the dock never starts a harness.

The launch form starts on Harness, followed by Agent and Model, then Machine,
Project and Branch; a blank row separates each group and Advanced. Machine
always stays visible. Advanced expands Worktree, Approvals, and Profile for
Codex subscription sessions. Its expanded state is remembered. The
`[ New Harness ]` action stays pinned below the scrolling fields, prints the
key bound to `picker.start` (⇧⏎ by default), and submits the draft; that key
starts from any field, taking a value highlighted in an open list first. Plain
Return on a value row never starts. The machine list puts this computer first,
then usable machines, then unlinked or offline ones in dark grey. There is no heading,
Task row, or Open In row. Cmd-P and Cmd-Shift-P also omit headings and counts.
Tasks carried from search or Store examples remain part of the draft.

Values and search use the terminal's selected font, size, and line height, on a
character grid: one cell wide and one row tall, with every margin, column and
gap a whole number of them, and text whose line height is the row.
The right pane previews choices without a selection highlight while the left
has focus. Right arrow, Return, or typing activates the list, and Left arrow
gives the keys back to the rows once the search is empty; accepting a value
returns to its field. The three project actions have icons. Clone, folder path, and new
project prompts return to Project after acceptance; only New Harness starts.
Project, machine, branch, and approval options occupy one line. Only the local
machine has a note, **This machine**. Approvals come from the chosen agent's
supported modes, and Profile disappears for agents or model routes that do not use it.
Narrow windows show the active list full-width with a back action.

| Entry | Initial values | Destination after a successful start |
| --- | --- | --- |
| Cmd-T, then Cmd-N | Previous pane's agent, machine, and project | The blank tab opened by Cmd-T |
| Cmd-Shift-P → New Harness | Focused pane's agent, machine, and project | Current tab |
| Cmd-N or the New Harness command | Focused pane's defaults; retain a task and destination already chosen in search | Current tab unless its source requests a new tab |
| Explicit pane split | Focused pane's defaults | Requested split in that tab |
| Store New Harness, or a product's Open action in the pane or native Models menu | Explicit product and machine; suggested project named for that product | New tab |
| Store Resume Harness | Existing harness and its machine; choose from a menu when several match | Focus its existing tab or reopen a view of the same harness |
| Store Try this prompt | Same as Open, with the example as the editable task | New tab |
| First empty workspace | No automatic action; show the welcome page | User chooses with Cmd-N, Cmd-P, or Cmd-S |

The Store and orchestration tabs cannot host a terminal pane. Generic creation
from either uses a new tab. Command-bar requests keep the workspace context and
apply any agent or machine explicitly named by the request.

The unified picker has search and results on the left, with a read-only preview
on the right. It has no action strip or keyboard footer. Enter opens a result;
machines and projects drill into their session lists. Cmd-P never offers New
Harness, including when no sessions match or a scoped list is empty. Cmd-N opens
creation explicitly. Cmd-Shift-P searches named
commands for the selected resource and returns to the same search after an action
or cancellation. Each item action names its target, which is revalidated before
execution. Filters and sorting are explicit commands, with no More menu.

Workspace panes remain terminals, with viewers as the only exception. Do not add
model or API details tabs: status stays in the picker preview, Model Manager opens
as a terminal session, and API configuration uses the existing edit dialog.

## Harness and agent choices

Harness lists every harness in the selected machine's catalog, installed or
not, in this order: recent harnesses, Coding, installed harnesses, then the rest
of the Store, followed by Browse Harness Store. All of them are searchable. The
form opens on the last harness used with the last agent used on it; with no
history it opens on Coding and Claude Code. Once the machine's catalog has
answered, a remembered harness it no longer lists (or a viewer package) is not
offered as recent and does not open; the form falls back to Coding. A harness
opened by name, from a pane or the Store, keeps its row. A harness that is not installed
installs when it starts. While it installs, and after a failed install, the
right pane shows the machine's fetch / set up / check steps on the form's grid.
Choosing another harness or machine clears it; an open list covers it while
choosing. Agent
contains compatible engines only. Coding sends no `dsh` and does not remove any
existing instructions or skills from the project. Changing an engine preserves
the selected harness and its generated project name. Machine changes re-evaluate
compatibility; an incompatible selection cannot start, and is never silently
replaced at launch. The selected machine's installed-package compatibility wins
over a newer catalog listing. Current daemons expose every integrated agent
engine; older daemons without compatibility metadata offer the manifest default.
Wide pickers use the available height and show a scrollbar when choices overflow.

The existing local state store keeps `new_harness_preferences_v1`: separate
engine and harness recents, the last successful engine per harness (including
Coding), and Advanced's expanded state. Legacy `new_agent_engine` and
`new_agent_recent` are read and split by identity; package ids never appear in
Agent history. Legacy keys and the app data directory stay in place. Explicit
entry choices and pending receipts take priority over remembered defaults.

## Model selection

Agent and Model are adjacent because the agent determines which model routes
are supported. The Model picker reuses the Models menu's subscription usage
source and the selected machine's model catalog. It shows the relevant
subscription/default login, running models on the person's machines, and shared
models grouped by grid. Each model identifies its serving machine; search matches
that machine too. Two grids serving the same model id remain distinct choices.

Machine identifies where the agent, project and tools run. The model can be
served from a different machine. Changing Machine or Agent preserves an explicit
model, refreshes availability, and blocks Start with an explanation if the new
combination is unavailable. It never substitutes a subscription. Refresh models
updates the choices; Manage Models opens the existing Models panel for lifecycle
management and preserves the launch draft. Choosing Terminal clears model routing;
its Model row is disabled and explains that Terminal does not use a model.

An explicit model survives draft dismissal/restoration and uncertain creation
receipts. A new session starts with the selected engine's default subscription;
model routing is not persisted as a global preference. Start refreshes availability
and sends only `gridModel` and `gridName`; the selected machine resolves the endpoint
and credentials. Older daemons without `supportsModelLaunch` explain that an update
is needed while continuing to allow ordinary subscription launches.

## Git projects

Git projects enable Branch and Worktree. Worktree defaults to **Yes** for a
repository with a commit; Enter, Left/Right, Page Up/Down, or a click toggles
**Yes** and **No**. Folders without Git keep both rows visible but disabled. Discovery runs on the selected machine
without fetching, switching branches, or creating a worktree. A failed
discovery offers Retry and blocks starting until the result is known.

A worktree is a temporary folder, never a project: a harness is known by the
folder it was started in and its repository's branch. Pane headers read
`folder › branch`, with the machine first only for another computer: the folder
the harness started in (a subfolder as itself, a checkout's root — a
worktree's too — as its repository), which does not follow the agent's shell,
and the branch with the same icon everywhere. A checkout on no branch — a
commit an agent checked out to read or test — shows no branch; the tooltip says
`No branch: on commit 65281563`. Worktree folders are never shown; the header's
tooltip has the full path. Cut short, the folder shortens in the
middle before the branch does. A folder inside a linked
worktree (the focused pane's, or one typed or browsed) shows as the same folder
in the repository's main checkout, so Cmd-N from a worktree pane starts beside
it rather than inside it. Worktrees Start made are never offered as recent
projects.

**Branch** starts on the default branch with Worktree on, and on the folder's
own branch with it off. It does not follow the pane New Harness was opened from:
New Harness is new work, and another agent's branch is one pick away. The start
action reads **New Harness**, whatever the rows say.
The picker names local branches; a remote branch is listed only when no local
branch has its name.

With **Yes**, **Branch** is what the new worktree works from. At Start a new
branch starts from the newer of that branch and its upstream, fetched for at
most ten seconds: `main` behind `origin/main` starts from `origin/main`, and
`main` with commits of its own starts from `main`, so nothing is lost; offline,
it starts from the last fetch. The branch the harness works on follows from it, with no row of its
own: the default or current branch gets a new branch named after the session
(`onboarding-experience`);
another local branch is checked out as it is; a remote branch nobody has
locally becomes a local branch of the same name tracking it; a branch that
already has a worktree opens there, as the Branch row's tooltip says. The
project folder's own branch cannot be checked out twice. Typing a name no
branch has offers **Create branch**: a new branch in a new worktree, from the
default branch. Spaces become `-` and anything Git refuses in a name is
dropped.

A session has no name at Start, so that branch starts as a made-up
`<word>-<word>`, marked `branch.<name>.harness = placeholder` in the
repository's config and left out of the pane header. The daemon renames it once,
to the session's name (`-2` when a local or remote branch has it), when the
session first has a name, and never again:
not after a later session name, a push, or a rename by the person or the agent.
A picked or created branch keeps its name. The worktree is checked out in
`~/harnesses/worktrees/<repository>/<branch>`, and ignored files listed in the
repository's `.worktreeinclude` (gitignore syntax, e.g. `.env`) are copied in.

With **No**, **Branch** is the branch the folder itself is on; only local
branches are selectable. A branch with a worktree of its own opens there.
Typing a name no branch has offers **Create branch**:
a new branch from the folder's branch, keeping its uncommitted changes.
Switching or creating needs no harness working in the folder, and switching
also needs nothing uncommitted. No changes are forced,
stashed, or discarded. A selected subfolder follows into a new worktree only if
it exists in that commit.

The picker displays branch names on one line; metadata such as `default`,
`current`, `worktree`, and `remote` remains searchable. It leaves out branches Harness made (marked `branch.<name>.harness`, or named
`harness/…` by older builds) whose worktree is gone. The daemon removes a
worktree it finds in `~/harnesses/worktrees` only when no live or stopped
harness uses it, nothing is uncommitted, and it has been idle for a week; the
branch stays unless Harness made it and its commits are all elsewhere.

Drafts and advanced options preserve these choices. A lost start reply reuses
its receipt, and retrying a confirmed launch failure reuses its prepared
worktree: the retry selects that worktree's branch with Worktree off.

## Draft ownership

- Workspace drafts belong to their original machine, focused source harness,
  and project context. A different focused harness does not inherit their edits.
- Cmd-N and Cmd-Shift-P can resume the same workspace draft. The current tab controls
  placement; a saved draft cannot redirect it to an old destination.
- Store drafts belong to the explicitly requested product and machine. Opening
  Blender cannot restore Workshop's agent, task, or generated project name.
- Escape preserves edits. Reopening the same source without a new task resumes
  its compatible draft, including the selected agent. Store Open still wins if the
  harness or machine was changed inside that saved draft.
- A newly typed search task or Store example starts from that entry's defaults.
  Repeating the same request while its draft is already open keeps its edits.
- A request awaiting confirmation is an exception: restore its exact values and
  receipt. A new task must not silently turn an uncertain start into a duplicate.
  An in-flight or uncertain draft cannot be replaced while it is open.
- Closing the dock does not discard unresolved receipts. Advanced options and
  return-to-dock preserve the same draft ownership and placement.

## Project names

Suggested projects display the existing `<agent>-YYYY-MM-DD-HH-MM` naming
convention. Untouched suggestions follow agent changes; a user's edited name
does not. The suggestion is frozen while reviewed. Project → New Project
opens the name prompt; accepting a name returns to the Project field.

Each machine retains its own project choice. A folder on one machine is never
silently reused on another. Generated folders use exclusive reservation and
advance to seconds/a suffix only on a confirmed collision. Explicit names are
never silently renamed, and existing files are never overwritten.

## Regression coverage

- `test/new_harness_git_test.dart`, `test/git_worktree_test.dart`, and
  `test/git_worktree_failures_test.dart`: Git defaults, disabled non-Git rows,
  keyboard/click toggles, branch search, branch resolution, stale
  replies, retries, actual Git worktrees and branch safety, fetching,
  tracking, `.worktreeinclude`, process deadlines, and bounded output.
  `cli/src/lib/gitProject.spec.ts` and `worktreeSweep.spec.ts` cover the same
  rules on a remote machine and the daemon's cleanup.
- `test/new_harness_entry_rules_test.dart`: product changes with an open or
  dismissed dock, Open/Try, edited names, machine changes, explicit agent
  precedence, search isolation, exact launch payloads, pending receipts, source
  pane changes, and Cmd-N/Cmd-Shift-P draft recovery and placement. Repeated/switched
  shortcuts retain typed tasks, text selection, existing results, and project
  scope; starting then uses the displayed destination.
- `test/harness_placement_test.dart`, `test/box_flows_test.dart`,
  `test/harness_store_entry_test.dart`: pinned creation, keyboard routing,
  cancellation, pending starts, tab allocation, source context, and capacity
  and existing-pane actions after changing a picker's destination.
- `test/models_menu_test.dart`: the native Models menu uses the product dock
  on its explicitly chosen machine; an uninstalled product opens its Store page.
- `test/new_harness_models_test.dart`: subscription relevance, local/shared model
  identity, independent agent/model machines, stopped models, old/offline daemons,
  stale asynchronous responses, pending receipts, draft restoration, and wide and
  compact keyboard/pointer flows. `cli/src/backendSocket.models.spec.ts` and
  `cli/src/lib/newAgentModel.spec.ts` cover daemon resolution and receipt semantics.
- `test/generated_project_launch_test.dart` and
  `test/new_harness_project_context_test.dart`: generated versus edited names,
  collisions, delayed replies, and machine-specific project choices.
- `integration_test/native_workspace_e2e_test.dart`: native onboarding,
  Cmd-T/Cmd-Shift-P creation, edited defaults, Store product switching for Open/Try,
  the Models menu, and terminal input immediately after starting without a
  mouse click. Creation journeys also switch and repeat shortcuts while a task
  is already typed into the picker.

Native fixtures use fake transport and injected Flutter keys. They do not start
live harnesses or establish physical AppKit/IME behavior.
