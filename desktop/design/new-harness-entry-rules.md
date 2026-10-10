# New Harness entry rules

Presentation follows the [desktop design system](desktop-design-system.md).
This document owns entry, drafts, and launch behavior; the
[desktop experiment](friendly-desktop-experiment.md) records the reviewed
composer and picker interactions. Earlier terminal-cell form styling is retired.

Startup and New Tab embed the same `NewHarnessForm` and controller used by
Cmd-N, at the same 680-point maximum width. The page has Recent harnesses below
the composer, without a modal frame or Close button. Opening the page or dialog
never starts a harness; Enter or New Harness starts it, with or without a prompt.

Agent, Computer, and Repo selectors sit above the message. The local computer is
**This Mac** on macOS and **This Computer** on Linux; remote computers retain their
names. Model, Approvals, applicable Account, Worktree, and Branch remain visible
below the message. Worktree and Branch stay on one line, without explanatory text
underneath. **From main** identifies the base of a new worktree branch; a tooltip
explains the operation. Existing branches and worktrees retain their branch name.

The model control retains the provider/subscription picker and shared models.
Per-agent model selection stays in the agent's own UI. Model, Approvals, Account,
Worktree, and Branch remain on one row; narrow windows scroll horizontally
instead of wrapping settings onto another line. Named accounts are currently
Codex-only; an unnamed account reads **Default account**. Fresh forms and recovered
launches focus the prompt. Terminal, which takes no task, focuses New Harness. In the message,
Enter submits and Shift-Enter inserts a newline, respecting composition and the
active keymap. Tab/Shift-Tab traverse the visible controls. Arrow keys navigate
an open chooser. Accepting or cancelling returns focus to its originating control.

Outside clicks close an open picker but never dismiss the main popup. Escape
closes the innermost child picker first; with no picker open, it closes the popup.
The X directly closes the popup. Closing discards an ordinary unfinished task
and its attachments; unresolved launch receipts retain their close guards and recovery values.
The popup's 95% dark backdrop covers the native footer. Reopening starts fresh. Choosers use system typography, normal controls, a search field,
natural row heights, and bounded scrolling.

![Cmd-N composition with a separate computer selector and one settings row](images/new-harness-cmd-n.png)

Agent combines direct coding agents and specialized harnesses in one searchable
list. A specialized harness then offers compatible coding agents. Repo searches
recent folders on the computer selected in the header; the search row does not
repeat the computer picker. Open Folder, New Folder,
and GitHub operate on that selected machine. Open invokes the native local
folder dialog or remote browser; New and Clone offer Change machine inside
their prompts. Escape retraces child steps. The computer remains visible in its own header selector, with the full folder
path available in the Repo tooltip.

Opening, searching, and cancelling never send input to an existing harness.

| Entry | Initial values | Destination after a successful start |
| --- | --- | --- |
| Cmd-T, then Cmd-N | Last successful setup and last focused real project with its machine | The blank tab opened by Cmd-T |
| Cmd-Shift-P → New Harness | Last successful setup and last focused real project with its machine | Current tab |
| Cmd-N or the New Harness command | Last successful setup and last focused real project with its machine; retain explicit task and destination | Current tab unless its source requests a new tab |
| Pane-edge split, Split Right/Down command, menu, or shortcut | Opens creation directly with the clicked/focused pane's agent, machine, and project | Requested split in that tab after submission |
| Store New Harness, or a product's Open action in the pane or native Models menu | Explicit product and machine; suggested project named for that product | New tab |
| Store Resume Harness | Existing harness and its machine; choose from a menu when several match | Focus its existing tab or reopen a view of the same harness |
| Store Try this prompt | Same as Open, with the example as the editable task | New tab |
| First empty workspace / New Tab | Same successful setup and working project; a suggested local folder on first launch | That tab when the user submits New Harness |

The Store and orchestration tabs cannot host a terminal pane. Generic creation
from either uses a new tab.

The unified picker has search and results on the left, with details and inline
management controls on the right. Enter opens a harness, uses or gets a model,
or focuses a machine's controls. Projects drill into their session lists. Cmd-P never offers New
Harness, including when no sessions match or a scoped list is empty. Cmd-N opens
creation explicitly. Cmd-Shift-P searches named
commands for the selected resource and returns to the same search after an action
or cancellation. Each item action names its target, which is revalidated before
execution. Filters and sorting are explicit commands, with no More menu.

Workspace panes remain terminals, with viewers as the only exception. Model,
machine, and API management stays inside the picker. Tab switches panes;
arrows navigate within the active pane and Enter activates the focused item.

## Harness and agent choices

Agent keeps every coding agent first, in the curated order documented in the
desktop experiment. Specialized harnesses follow with recent choices, the tuned
set, and the remaining catalog. Terminal comes last. All are searchable and
the saved default selection does not move specialized harnesses above coding
agents. There is no separate Coding category. A specialized harness asks which compatible
coding agent should run it, using the last successful agent when compatible. The form's value
then reads `Blender · Codex`. Choosing a direct agent removes the package choice
and sends no `dsh`; it does not remove project instructions or skills.

With nothing remembered, a fresh harness opens on the agent the person already uses: Claude Code
or Codex when the machine reports it installed and signed in (the one used most recently when both
are). Otherwise fresh harnesses use OpenCode with Muse Spark 1.3, xhigh effort and Auto-approve when compatible. Explicit and
remembered agent choices are retained; reopening a session keeps its saved agent
and model. A package's declared agent is a compatibility fallback, not a global default.

The running pane header shows the agent name as plain text beside the model,
with the same type, padding and hover/focus treatment and no pill or chevron.
Clicking it opens the shared Cmd-P picker in `&` Agents mode. All agents are
listed; unsupported choices explain why they cannot be selected. Selecting a
supported agent saves and stops the current session, starts a fresh conversation
in the same folder, and replaces its references in every pane without changing
tab positions or layout. The previous saved conversation stays in history. No
confirmation dialog is shown. Failed saves do not start a replacement; uncertain
creation replies retain one receipt for retry.

Explicit entry choices and pending receipts win over remembered defaults. A
remembered agent, package, project, or profile that is unavailable requires an
explicit replacement. A package requested explicitly keeps its identity. Packages
offered by the machine can install when started; the dialog narrates installation and
failure details. Another agent or project machine clears that narration.
Machine changes re-evaluate compatibility and never silently substitute at
launch. The installed package's compatibility takes precedence over a newer
catalog listing.

The existing local state store remembers one global **last successful launch**:
agent and specialized harness, model route, approvals, and account/profile.
A profile path is only reusable on its original machine. Worktree is a global
choice from the last successful Git launch; plain folders leave that choice alone.
Choosing options, cancelling, or a failed start never changes these defaults.
A confirmed start saves them even when creation has already replaced the form.
Legacy preference keys and the app data directory stay in place; migration uses
actual launch history instead of previously persisted dropdown edits.

The working project is the last focused real work pane in this window, including
its machine. Monitor, Grid, Store, and Settings do not replace it. Without a working
pane, use the last successfully launched user project. Without either, suggest a
new local folder so Enter can launch immediately. Normalize linked worktrees back
to their repository. Utility launches never update this project history or the
successful setup. Task text, attachments, branch names, and worktree folder names
are never global preferences. There is no extra Draft, Save as default, or
reasoning-effort control.

## Model selection

Model is a compact control below the message and uses the chosen agent’s supported routes. Show the
selected model name, or its provider (OpenAI / Anthropic) when the launch model
is not reported. Its picker reuses the Models menu's subscription usage
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
its Model row is omitted.

An explicit model survives an uncertain creation receipt. A successful launch
remembers its model route globally with its agent. A first OpenCode session starts
with Muse Spark 1.3; other engines use their default subscription. Start refreshes availability
and sends only `gridModel` and `gridName`; the selected machine resolves the endpoint
and credentials. Older daemons without `supportsModelLaunch` explain that an update
is needed while continuing to allow ordinary subscription launches.

## Git projects

Git projects enable Branch and Worktree. Worktree defaults to **Yes** until a
successful Git launch remembers another global choice.
The checkbox supports pointer and keyboard activation through the form's active
keymap. Its label and branch icon remain together as the form narrows.
An empty repository explains that a commit is required for a worktree and asks
for a choice. Folders without Git keep both rows disabled. Discovery runs on the selected machine
without fetching, switching branches, or creating a worktree. A failed
discovery offers Retry and blocks starting until the result is known.

A worktree is a temporary folder, never a project: a harness is known by the
folder it was started in and its repository's branch. The focused workspace
footer shows machine, project, branch and PR together using the user's selected
status style. Pane headers keep harness identity, the model control and close
action; they do not repeat project or branch context. The project label is the
folder the harness started in (a subfolder as itself, a checkout's root — a
worktree's too — as its repository), and does not follow the agent's shell.
Detached checkouts do not invent a branch name; full path and checkout details
remain available through the context controls. Worktree implementation folders
are not everyday project labels. See [workspace-status-bar.md](workspace-status-bar.md)
for context actions and compact layout. A folder inside a linked
worktree (the focused pane's, or one typed or browsed) shows as the same folder
in the repository's main checkout, so Cmd-N from a worktree pane starts beside
it rather than inside it. Worktrees Start made are never offered as recent
projects.

**Branch** starts on `main` for a fresh desktop form. With Worktree on, local
`main` or `origin/main` can supply the base. With Worktree off, it must be a local
branch; a remote-only `main` requires an explicit local branch choice. Missing `main` requires
an explicit branch choice; a failed worktree creation never silently turns
Worktree off. Branch does not follow the pane New Harness was opened from:
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
to one or two words of the session's name, when the session first has a name.
Filler words and a leading verb are dropped, and a generic second word (page,
flow, experience, issue…) is too: `Fix the harness list order` becomes
`harness-list`, `Fix the login page` becomes `login`. A taken name falls back to
the two-word one (`login-page`), then adds the title's next telling word
(`harness-monitor-ddos`), and only then numbers the shortest (`login-2`). Local
and remote branches both count, without regard to case, and a repository's own
names (`main`, `master`, `head`, `origin`, `develop`…) are always taken. It is
renamed only that once, and never again:
not after a later session name, a push, or a rename by the person or the agent.
A picked or created branch keeps its name. The worktree is checked out in
`~/harnesses/worktrees/<repository>/<branch>`, and ignored files listed in the
repository's `.worktreeinclude` (gitignore syntax, e.g. `.env`) are copied in.

With **No**, **Branch** selects the local checkout branch, initially `main` for
fresh desktop work. Only local branches are selectable. A branch with a worktree of its own opens there.
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

An open form preserves these choices. A lost start reply reuses
its receipt, and retrying a confirmed launch failure reuses its prepared
worktree: the retry selects that worktree's branch with Worktree off.

## Fresh forms and launch recovery

- Every newly opened Cmd-N starts with an empty prompt and the successful setup.
  Closing discards ordinary edits. Repeating Cmd-N while the same form is still
  open simply focuses it.
- Browsing search does not become a new task. An explicit create action or Store
  example supplies its requested prompt. Explicit product, machine, split and
  destination choices take precedence over inferred defaults.
- The current tab controls placement. Store entries start fresh on their requested
  machine, with a suggested project named for that product.
- A request awaiting confirmation is the exception: restore its exact values and
  receipt. A new task must not silently turn an uncertain start into a duplicate.
  In-flight and uncertain requests cannot be replaced while open.
- Pending receipts belong to their original source context. Closing keeps them
  recoverable. Opening a nested picker or returning from advanced options keeps
  the currently open form and its destination.

## Project names

Suggested projects display the existing `<agent>-YYYY-MM-DD-HH-MM` naming
convention. Untouched suggestions follow agent changes; a user's edited name
does not. The suggestion is frozen while reviewed. Project → New Folder
opens the name prompt on the selected machine, with Change machine available;
accepting a name returns to the Repo control.

Project paths retain their owning machine. A folder on one machine is never
silently reused on another. Generated folders use exclusive reservation and
advance to seconds/a suffix only on a confirmed collision. Explicit names are
never silently renamed, and existing files are never overwritten.

## Regression coverage

`tool/check_new_harness_coverage.mjs` requires 100% executable-line coverage of
the complete `lib/state/new_harness.dart` and `lib/widgets/new_harness_form.dart`
modules, including the install clock. Neither module excludes lines from coverage.
After running tests with `flutter test --coverage --branch-coverage`, run
`node tool/check_new_harness_coverage.mjs coverage/lcov.info`. This is a line
coverage gate; branch coverage and the native fixtures provide additional evidence,
not a guarantee about every possible external machine or agent failure.

- `test/new_harness_controller_edges_test.dart`: late discovery, unavailable
  main, conflicting worktrees, profile validation/link errors, stale choices,
  generated-name collisions, bounded folder caches, and lost creation receipts.
- `test/new_harness_scenarios_test.dart`: keyboard and pointer parity, Unicode
  editing and composition, unavailable replacements, long errors, small windows,
  delayed folder/browser/launch replies, and callbacks after form disposal.

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
