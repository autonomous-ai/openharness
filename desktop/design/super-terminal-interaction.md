# Terminal prompts in OpenHarness

For current dialog presentation, follow the
[terminal dialog design system](terminal-dialogs.md). It supersedes the older
visual descriptions below, including dock placement and chrome.

The terminal is the workspace. Search and creation are temporary prompts over
it, using the same monospace family, compact text rows, a thin border, and a
visible cursor. No backdrop dims the running agents. No permanent status bar
is added.

## Patterns studied

| Source | Pattern carried into OpenHarness |
| --- | --- |
| [fzf](https://github.com/junegunn/fzf) | Filter immediately, keep one highlighted result, show a match count, fit the list to its content, and make preview a keyboard toggle. |
| [zsh's line editor](https://zsh.sourceforge.io/Doc/Release/Zsh-Line-Editor.html) | Edit a real input buffer, use familiar kill/yank keys, and complete paths in context without losing the typed stem. |
| [Vim's command line](https://vimhelp.org/usr_20.txt.html) | Let one prefix identify the input mode and use highlighting for completion selection. Keep completion reversible. OpenHarness uses the agreed Quick Open `>` for commands. |
| [tmux](https://github.com/tmux/tmux/wiki/Getting-Started) | Keep pane placement separate from process lifetime. Opening a view or dismissing a prompt must not restart an agent. Keep application bindings scoped away from terminal input. |
| [Lazygit](https://github.com/jesseduffield/lazygit/blob/master/docs/keybindings/Keybindings_en.md) | Put a short, contextual key guide beside the action. Enter confirms; Escape returns to the workspace. |

These are interaction references, not a new shell language. Search accepts
ordinary text; task text is sent as the agent's first message. Plain `j` and
`k` remain characters while typing. Existing keymap customizations still apply.

## Workspace frame and command dock

The workspace uses flat monospace tabs, a selected background and bold label,
and 3px pane corners. The standalone New Pane titlebar pill is removed. Cmd-P, File → New
Pane and command search retain the action; the empty start page can still teach
New Tab and New Pane explicitly. The tab bar is 40pt tall, using AppKit's
compact unified toolbar on macOS. A quiet, labeled Harness Store control stays
at the far right, separate from the working tabs.

Search and creation attach to the bottom of the workspace, matching its 6px
outer inset. The best result sits immediately above the input; other matches
extend upward, with about six visible rows. Defaults sit above a task and the
key guide below. Preview sits beside the list, or above it when narrow. This
is a temporary overlay: terminal size, scroll position and
session ownership remain stable. Tab traversal stays within the dock and
reaches results from the input before the key guide.

Customize OpenHarness → Prompt, or `customize` in command search, chooses Plain
ASCII, Symbols or Powerline metadata. All use the same machine, project and
branch data. Color and field visibility are optional. These preferences do not
change search matching or run commands in the user's shell. See
[the theme research](terminal-prompt-styling.md).

## Search and placement

- **Cmd-T** opens New Tab; **Cmd-P** opens New Pane. Both offer existing agents
  and a **New agent…** row. Empty input selects New agent; typing selects the
  best existing match.
- Search uses a plain monospace input, a result count, and compact rows. The
  full-width highlight identifies the selected result without an arrow marker.
  Input and result text share a left inset. The empty picker says "Find an
  agent…"; typed prefixes identify modes, with no decorative `>` or `:` before
  them. Names, projects, machines, and tab names remain searchable.
- Results identify the agent and machine before the project and branch. Narrow
  results put that metadata below the task, so two agents with the same task
  remain distinguishable without opening a preview.
- Docked results follow spatial directions: Up/Ctrl-P/Ctrl-K move away from the
  bottom prompt; Down/Ctrl-N/Ctrl-J move toward it, stopping at either edge.
  The inline start-page picker retains its top-down order. Enter opens the
  selection. Tab from the dock input reaches the best-ranked result first.
- **Ctrl-/** shows or hides the preview. Page Up/Down scroll the preview while
  input focus and selection stay put. Previews start visible in New Tab and
  New Pane, as well as the start-page picker. The dock's New agent row does not
  show an empty preview; the preference remains on for real results.
  With preview hidden, Page Up/Down move through the result list.
- **Escape or Ctrl-C** dismisses the picker and restores terminal focus.
- The same input uses Quick Access prefixes: plain text finds agents, `>`
  commands, `#` projects, `@` machines, and `?` mode/help entries. Deleting a
  prefix returns to ordinary agent search. **Shift-Cmd-P** inserts `> ` in
  the same picker, retaining its New Tab/New Pane destination.
- Selecting a project or machine narrows to its individual agents. It never
  opens a whole group at once. Escape returns to the previous project/machine
  query; another Escape closes. Switching prefixes leaves that group scope.
- `?` rows for commands/projects/machines insert their prefix without closing
  the dock or replacing its text controller. Other help entries run their
  usual command. The hint row stays the same height while typing a query.

Reference: [VS Code Quick Open](https://code.visualstudio.com/docs/editing/getting-started/tips-and-tricks#_quick-open)
and its [symbol provider](https://github.com/microsoft/vscode/blob/main/src/vs/editor/contrib/quickAccess/browser/gotoSymbolQuickAccess.ts).
The shared input/provider interaction is the reference. OpenHarness deliberately
uses `@` for machines (the user's SSH `user@host` association), not VS Code's
file symbols; agent search is already the default.

The destination is chosen before the agent. New Tab receives the agent's name
only after selection or successful creation. New Pane auto tiles. A harness can
have views in multiple tabs; selecting one already in the current tab focuses
its existing pane.

## Harness Store

The persistent Harness Store control opens or focuses the window's single
Store tab. A working tab and its agents remain intact; an empty starter can
become the Store. Command search recognizes `store`, `install`, `browse
harnesses`, `packages` and `extensions`. The command ID `app.store` can be
assigned a shortcut in the existing keymap.

The creation prompt's agent choices include **Browse more harnesses…**. It
remains available when no harness matches. Enter opens the Store and keeps the
task/default draft associated with its source; return to that source and Cmd-N
to resume. Merely opening the Store never installs or starts anything.

## Arranging a workspace

Keyboard tab selection keeps its tab visible, even in a long strip. Manually
scrolling the strip is preserved during background agent updates. Pane movement
swaps neighboring panes without disturbing the others or detaching the running
session. Pins move with their pane. A pane moved through a scrolling layout
stays visible.

Resize mode shows a temporary monospace guide: arrows resize, Shift takes
larger steps, Tab selects the next divider, and Escape returns to terminal
input. No permanent status area is added.

A narrow pane gives its agent name priority. The machine remains visible;
project and branch details are available in the identity tooltip. Extra pane
actions use a compact keyboard menu, while reconnect remains directly
accessible. Model and action menus accept arrows, Enter, and Escape, restore
focus when closed, and stay within the window. Wider panes retain direct
controls. Header names follow the selected terminal font.

## Terminal input and clipboard

Output Find uses the same thin frame and terminal font, with a `/` prompt and
match count inside the existing pane header. Opening it does not resize the
terminal. Enter/Shift-Enter step through matches while the query owns focus;
Enter on a focused control activates that control. Escape restores the prior
scroll position and returns input to the terminal. At narrow widths or larger
text sizes, match controls move into a compact keyboard menu so the query stays
readable. The menu closes with its pane and retains clickable alternatives.

The search, creation, agent picker, Find, and remote-password prompts share
kill/yank editing.
Ctrl-H/D delete a complete visible character, including accented letters and
joined emoji. Ctrl-W respects whitespace and path separators. In multiline
tasks, Ctrl-U kills back to the current line's start; Ctrl-Y restores the last
kill. Active composition and pending, locked tasks are preserved.

Mac copy/paste/select-all remains Cmd-C/V/A. Linux uses Ctrl-Shift-C/V/A,
leaving Ctrl-A and Ctrl-V with the shell; its Copy and Paste match
[GNOME Terminal](https://help.gnome.org/gnome-terminal/txt-copy-paste.html).
The shortcut guide displays the platform's actual chords. Control keys such
as Ctrl-B/C/D/R/Z continue to reach the running program. In particular,
[Zsh's line editor](https://zsh.sourceforge.io/Doc/Release/Zsh-Line-Editor.html)
uses Ctrl-V for quoted insertion.

On Linux, left Alt sends Meta input with the keyboard's actual character,
including uppercase letters, punctuation, and numeric arguments. Right Alt
(AltGr) stays with text composition; macOS Option keeps composing characters.

Paste belongs to the session and stream where it began. A delayed clipboard
read is discarded if that pane changes agents, reconnects, closes, or becomes
read only. Copy still works on retained output in read-only panes. Empty
clipboard content sends no input to a shell. Clipboard read errors leave the
session usable and offer a retry. Older daemons keep bracketed paste, and
remote agents retain their image-upload path.

A terminal has one controller. When another client opens the same agent, the
displaced pane keeps its last screen, read only, under a band that says who:
"Mac mini took control of this terminal", with Take control (or ⏎) as the
way back. The name comes from the taker's own introduction on `terminal_open`
(`client: {kind, name, machineId}` — a desktop names its machine in the fleet,
a phone the name given it under Settings ▸ This phone, else the name its OS
reports, else its model, "iPhone 15 Pro"), which the daemon repeats on the incumbent's
`terminal_closed` as `takenBy`; a machine this app knows is shown by its
current fleet name. An older daemon, or a taker that said nothing, reads as
"Another app took control of this terminal". The phone draws the same line
under its header. Retaking control introduces this app in turn, so the other
side sees this machine's name.

**Only a person at this window may take a terminal.** Every `terminal_open`
this app sends says whether a hand on THIS Mac asked for it (`AttachIntent`):
a click, a key, a menu item, the band's button. Everything else — a tab another
Mac opened arriving over the desk, a reconnect, a machine answering its agent
list, a push about an agent created elsewhere, the dial turning, `harness
remote` handing a session over — opens with `takeover: false` and is answered
as a WATCHER: real output, live, with the terminal left where it was and the
band offering it. Where the machine's CLI is too old to understand that key
(`features.noTakeover` absent) nothing opens by itself at all; the tile says so
and offers "Open here". This is what stops two screens trading one terminal
while somebody is typing in it.

Opening the app is itself a gesture, so the tiles a launch restores may claim
their terminals on their FIRST attach — the window comes back the way it was
left, typing where it was typing, even if another screen picked one of them up
meanwhile. That claim is spent on the attach it pays for and dropped from every
tile a few minutes after launch, so a machine that only comes back in the
afternoon is met by the ordinary rule rather than by a gesture made at
breakfast. Tiles that arrive later — over the desk, from a push — never carry
it.

## Creation

Cmd-N opens a compact launch menu with inherited arguments:

```text
agent    Claude Code
machine  dev
project  ~/work/payments
task     (optional)

Start agent

↑/↓ select    enter start agent    esc close
```

The bottom Create/Start row is highlighted on entry, so Enter starts immediately
with the displayed arguments. Up/Down move the highlight through Agent,
Machine, Project, Task, and Create in visual order,
wrapping at either end. Enter edits the highlighted argument; Cmd-Enter keeps
the direct start action available. Returning from an editor selects Create
again. Mouse movement can select a row; a parked pointer cannot steal selection.
Launch has no default letter shortcuts or letter hints. Permissions and profiles
belong inside Agent, with explicit labels indented directly beneath the
highlighted agent. Arrows and typing update the available settings without
changing the saved agent. Down enters that agent's settings; choosing a setting
commits the engine with it. Escape discards an unaccepted preview.
The launch Agent row shows nondefault permissions and any selected profile;
default settings stay quiet. Stable command IDs
remain available for explicit custom bindings. Letters remain text inside a
prompt. Agent/project choices return to the launch menu; Enter in the
task prompt starts with that task. Escape retains the task and returns to the
menu before closing it. A missing project opens its menu first and cannot
silently create an unnamed folder.

Agent and Machine pickers show only their title, choices, input, and key hints.
The Agent/Machine/Project summary stays on the launch screen rather than being
repeated above those lists.

Project shows its recent folders in one place, with up to nine rows visible
and the rest available by scrolling or Page Up/Down. Typing filters the list
by name or path, like Agent and Machine. Three fixed actions sit below the
history and above the input; the best matching recent is selected on entry.
Machine is shared context, also accessible from the Project header:

```text
project on M2                           change machine

recent · 4
research       ~/harnesses/research
product-video  ~/harnesses/product-video
website        ~/work/website
payments       ~/work/payments

New project
Open folder…
Clone GitHub repository

project   Find a project by name or path
```

History never pushes the fixed actions out of view, even with no matches.
Up/Down selects, Enter chooses, and Escape goes back. No numbers or action
letters are reserved; all ordinary characters enter the search. The current
folder is first, followed by that machine's recent history and known agent
folders. The list grows upward from the actions. Project inherits remappable
picker navigation. Action/recent command IDs remain available for explicit
custom bindings, with no defaults. When there are no matches, Open folder
is selected. Arrows move in visual order. New opens a `name` input with
`machine:~/harnesses/<name>` as guidance; `payments processing` previews
`Create payments-processing` and its exact destination. An existing destination
offers Open existing instead. Open folder opens a `folder` input for a typed/pasted
path with completion. The empty prompt offers only an Open folder browse row,
nearest the input; it does not repeat the recent-project list. Enter on that
row or Ctrl-O opens the native/remote browser on the selected machine. A path
without a matching folder never becomes a new-folder request.

GitHub opens a `repo` input labeled "Paste a GitHub repository URL" and previews
"Clone to machine:~/harnesses/<repository>". HTTPS and GitHub SSH URLs work, as
do short names like `openai/codex` (the GitHub username/organization and repository).
Choosing the repository returns to the launch menu; launching performs the clone.
An invalid repository cannot launch in the previous project via Cmd-Enter.
Machine returns to the screen it was opened from; cancelling preserves that
screen's query and accepted choices. Switching machines clears a project/folder filter
from the previous machine and refreshes the recents. Escape from other project
editors restores the Project search, then returns to the launch summary. Each machine retains its
own selected folder; remote home
paths are resolved on that machine.

Task stays visible for every agent. When the CLI has no first-task launch
contract (including Pi), the row says to enter the task after launch; pressing
Enter on Task explains the limitation. A supported agent restores the editable task
prompt. Retained tasks are never silently discarded when changing engines.

Tab completes the current argument without accepting it or switching fields.
Project paths retain common-prefix completion, candidate cycling, and Escape's
restoration of the original stem. Cmd-Enter can still launch an explicitly
highlighted agent/project; inside Machine it chooses and returns to Project.
Inside Agent, select **Permissions** or **Codex profile** to open a
searchable picker. Enter commits and returns to Agent; Escape returns without
changing the choice. Profile discovery never selects an account automatically.
Profiles, refresh, and linking a profile folder use the selected machine;
switching machine clears the profile, and late responses from the old machine
are ignored. Cmd-period retains the full creation form as a compatibility path.
Auto-approve remains the default; explicit profiles/nondefault modes get a
compact summary beside the launch Agent value.
Option-Enter inserts a task newline; Ctrl-W/U/H/D/Y retain line editing.

Defaults stay vertically aligned at every width.
Input labels share the first text baseline with their hint and multiline
editor, and align with the context labels. Cmd-N inputs and result selections
have no decorative `>`; a full-row highlight indicates the selected result.
Cmd-N argument values have no decorative harness marker.
Rows grow with text size. Key hints wrap, keeping Escape and advanced options
visible without horizontal scrolling. The prompt takes the space its contents
need; long first tasks scroll inside their editor when the panel reaches its
available height. Errors appear above the available recovery keys and are
announced to screen readers. An in-flight request shows its status. Pending
creation is labeled `pending agent`, with Enter to check status and Escape to
close; unavailable editing and advanced-options hints are omitted.

Escape keeps an unfinished task and its complete setup with the source
machine, agent, and project. Returning from another project does not carry
that task into the new context. An empty New Tab/New Pane chooser or Cmd-N
resumes the source's draft; explicit task text from search starts fresh using
the inherited defaults. Clearing the task or successfully creating consumes
that draft. These buffers last for the current window, not across app restarts.

For an unsubmitted draft, the latest New Tab/New Pane choice determines its
destination. A submitted request with a lost reply retains its original receipt
and destination, even if it had no first task. Reopening it checks that request
instead of starting another. The dismissal warning retains its acknowledgement
when resumed, so the visible Escape instruction stays accurate.

Rows, defaults, and the key guide remain clickable. Floating forms, including
New Harness and Rename Tab, use the shared near-black dialog backdrop without
blur. The bottom command dock keeps the workspace visible.

## Advanced options and reliable transitions

The advanced form uses the same top-anchored thin frame and monospace text.
Machine and project choices are compact rows instead of cards. Its agent
search also starts with a list, with Ctrl-/ toggling a text preview and Page
Up/Down paging the active list or preview. The footer exposes Cmd-Enter on
macOS (Ctrl-Enter elsewhere), Tab/Shift-Tab, and Escape.

While the agent picker is open, Enter or Cmd-Enter chooses its highlighted
agent. The form does not launch from beneath the picker. Configured picker
bindings and their hints follow the same live keymap as the workspace. The
open panel resizes with its window and text size, keeping its input and guide
visible while results and preview scroll within the remaining space.

Opening advanced options preserves the first task, permission mode, named new
project, existing folder, or repository. A per-machine choice is retained when
switching away and back. Successful creation consumes the saved first task.
Escape/back from advanced options returns to the compact prompt with edits
intact, including the chosen Codex profile. Default remains an explicit choice
when selected. The profile is displayed beside the other creation defaults and
is cleared when the target machine or agent changes.
Outside-click and keyboard dismissal share the compact prompt's pending-request
guard, so a lost creation receipt cannot be silently discarded by a click.
An unresolved advanced creation can return to the prompt with that receipt;
Enter checks the existing request. Pending task input is read-only.

Numbered results and folder completions sort naturally (`1, 2, 10`); stronger
search matches and recent work keep their ranking priority.

## Linking a machine

The remote-password prompt uses the same top-anchored thin frame, monospace
text, and the shared dark backdrop. The target machine stays visible above a
`password >` input. Typing works immediately. Enter submits from the input;
Tab moves through controls, and Escape returns to the existing terminal. An
active text composition keeps Enter and Escape until the composition ends.
Errors keep the masked password, announce the failure, and return focus to the
editor for a keyboard retry. Ctrl-U/W and Ctrl-Y edit the local input buffer.

A pending handshake belongs to its machine, independently of its prompt.
Closing it leaves the connection running, as the visible status explains.
Reopening joins that attempt instead of starting another, and shows its stage
without retaining the closed prompt's password. Repeated submission is ignored
while pending. Different machines have independent attempts. Successful linking
reconnects the target; a late reply from a disposed or changed auth session
cannot update the current workspace.

The footer stays visible when a short window or enlarged text requires the
body to scroll. Troubleshooting details are optional.

“Link machine” starts with a `machine >` chooser. Search machine names, choose
a machine that needs its password, or choose desktop/SSH setup. Direct matches
rank before loose fuzzy matches. Linked machines remain identifiable and explain
that their agents are available through New Tab/New Pane. The current computer
is excluded from the remote list.

The guides keep commands and links selectable, with focusable copy/download
actions. Commands are copied for the other machine, never executed here.
Incoming machines appear below the instructions without changing the current
selection or folding the guide. Escape returns to the retained query; another
Escape closes the chooser. Nested password entry also returns to the query.

Configured picker navigation, accept, cancel, traversal, and refresh keys carry
through both direct and Machines Manager routes, including live edits. Hints
prefer custom bindings. `picker.refresh` defaults to Cmd-R/Ctrl-R, stays scoped
to machine setup/password prompts, and works in the guides. Refresh preserves the query and focus,
joins an existing refresh, and reports recovery without hiding the key guide.
On a focused guide control, the configured accept key activates that control.

The local password prompt is titled “This computer’s password” and uses
`password >` and `again >`. Enter advances to confirmation, then sets the
password. Native Next/Done preserve focus; errors keep the input for retry.
Changing an existing password can be cancelled with Escape. Accept on a focused
control activates that control, including after the password fields disappear.
Configured picker keys and their hints remain live through the nested route.

Only one panel is visible while entering a password; the machine chooser hides
and returns with its query and selection intact. A pending set/clear belongs to
the model and can be rejoined after closing the prompt. New concurrent changes
are rejected, status reads cannot roll back a newer change, and closing clears
the local input buffer. Status failure stays distinct from an unset password.

Outgoing trust has a separate “Links from this computer” view. Refresh retains
known rows on failure and reports errors; repeated unlink requests join one
operation. Clear and unlink confirmations start on Cancel. Clearing a password
prevents new password-based links; existing links and sessions stay connected.
The fingerprint and date remain available without a separate settings card.

## Managing machines

Machines Manager uses a `machine >` filter with compact text rows. The current
computer comes first, followed by naturally ordered machine names. Presence,
link requirements, shared access, and agent counts remain separate facts.
Search accepts machine names, hostnames, IDs, and status words; direct matches
rank before loose fuzzy matches. Background arrivals retain the selected row.

Enter opens the selected machine's `action >` list. Escape returns to the
original machine query; another Escape returns to the terminal. Action queries
also survive nested prompts. Only the active panel is visible. Navigation,
refresh, completion, accept, and cancel follow the live picker keymap, including
through the native menu. Refresh retains the query and reports failure in place.
The query and key guide stay visible while a short window scrolls the body.

The Machines menu lists every harness a machine remembers, including ones that
have stopped; those read " · stopped" after the name and stay enabled, because
choosing one resumes its saved conversation the way ⌘P does. Only a harness
with neither a terminal nor a saved conversation is disabled. A resume the
daemon refuses answers with the picker's snackbar — its reason, and Start New
Conversation in the same place.

Rename selects the existing name in a `name >` input. Enter saves, errors retain
the edited name for retry, and pending input is read-only. A delete confirmation
names its account-level effect and starts on Cancel. Local computers cannot be
deleted here; shared machines explain that their owner manages their settings.

Rename and delete requests belong to the model. Closing a pending prompt does
not cancel its request, and reopening joins it rather than sending another.
Successful deletion closes that machine's views across this window's tabs.
Late replies cannot edit a replacement machine or a new auth session. Older
inventory reads and offline cache cannot undo a confirmed change; newer live
inventory can reflect changes made from another client.

## Naming tabs and agents

Tab, agent, and machine renaming share one `name >` editor. Opening it selects
the whole current name once; typing is immediately available and is never
reselected by a delayed focus timer. Enter saves, Escape returns to the
workspace, and readline editing and composition use the same rules as other
prompts. Empty names report an inline error with focus retained. Tab names
retain their 80-character limit. The field has a specific accessible name.

“Rename Agent” is available in command search for the focused owned agent and
can be assigned a key in `keybindings.jsonc`. Double-clicking a pane title uses
the same editor. Tab naming remains independent of agent naming, so a manually
named workspace retains its label. The native Rename Tab action acknowledges
the open editor before waiting for a name.

Pending agent renames are read-only. Closing and reopening joins the same
request, while repeated Enter cannot send another. Failed requests retain the
name for retry. A response for a replaced machine, stopped agent, different
agent session, or disposed/auth-stale model cannot rename current work. A newer
observed name takes priority over an older receipt or inventory snapshot.
Authoritative renames and refreshed names update all open pane titles without
restarting their terminals.

## Stopping an agent or shell

“Stop Agent” is available in command search for the focused owned agent. A
shell uses “Stop Terminal.” Both can be assigned a key without reserving a
default terminal chord. The existing pane menu uses the same compact terminal
prompt, naming the agent and machine. It explains that stopping ends the
process and closes its views across tabs, while project files and saved
conversation history are retained. Close Pane leaves the process running.

The initial control is Cancel. Tab moves to Stop; Enter activates the focused
control. Escape closes the prompt and returns input to the workspace. Custom
accept, cancel, and traversal bindings stay live, including while a request is
pending. Page Up/Down scroll long explanations at enlarged text sizes while
the controls and key guide stay visible.

Pending stops belong to the model. Dismissing and reopening joins the same
request, and repeated confirmation cannot send another. Failures remain in
the prompt and return focus to Cancel. Timeouts say that the result could not
be confirmed. A confirmed deletion event can finish the prompt before its RPC
receipt arrives; the late receipt cannot affect a recreated agent.

Confirmation retains the machine and agent session shown when it opened. A
changed session or replaced target before confirmation reports the change without
sending a stop request. Older inventory cannot restore a just-stopped agent or
overwrite a recreated ID, and late responses cannot remove a replacement
machine/session. Successful stopping removes all views of that agent while
leaving other terminal sessions and their input available.

## Forking an agent

“Fork Agent” is available in command search for a supported, owned agent, and
can be assigned a key without taking a default terminal chord. The pane menu
opens the same compact terminal prompt. It names the source, machine, and
project folder, and explains whether the engine continues the conversation
or starts from a handoff summary.

The task input owns focus immediately. `name >` starts with the source name
plus ` - fork`; `task >` accepts an optional first task. Enter from the name
moves to the task; Enter from the task starts the fork. Tab moves through the
fields, Alt-Enter inserts a newline, and the submit binding can launch from
either field. Readline editing, native Next/Done, composition, and live picker
remappings follow the other prompts. Up/Down and Ctrl-N/P move within a
multiline task. Escape returns to the workspace with the draft retained.

Pending work belongs to the model. Reopening joins the existing operation;
inputs remain read-only until its outcome is known. Refusals stay inline and
retain the draft for retry. A lost response switches Enter to “check status”
using the same receipt, without sending another fork. “Start another fork”
explicitly leaves that receipt behind, warns that the prior fork may exist,
and requires a separate confirmation. Status, recovery controls, and Escape
remain visible in short windows; Page Up/Down scroll the details.

The CLI persists the fork receipt before launch and retains native/handoff
information with its outcome. This status recovery needs the updated CLI.
Older CLIs can still return a successful legacy fork response; an uncertain
legacy response requires checking existing agents before explicitly starting
another. The desktop draft and receipt reference last for the current window,
not across app restarts.

## Cloning an agent

“Clone Agent” (⇧⌘N, File menu, pane command search) is fork minus the
context: another agent of the focused pane's kind with a fresh conversation.
There is no prompt, as with ⇧⌘T — every answer is already on the agent's
frame: its machine (its own or a relayed one), project folder, engine or
harness, Codex profile, named agent, and permission mode. The clone is named
`<source> - clone`, opens as another tile in the current tab, and takes
focus; the source is not touched, so a clone works while the source is busy
or has no session yet, where a fork would wait or refuse. A terminal clones
to a terminal in the same folder. An agent on a grid is refused before asking,
since the frame carries the grid's model and never its key.

The launch choices come from the CLI's agent frame (`permissionMode`,
`bypassPermission`, `namedAgent`). A daemon that predates them reports none,
and the clone then opens the way New Harness would by default — folder,
harness and profile still carry. Errors surface as a snackbar; there is no
receipt to reopen, and a second ⇧⌘N is a second clone.

A confirmed fork opens in its original tab without stealing focus if the user
has moved elsewhere. If that tab closed, or filled while the user moved away,
the agent stays available through New Pane/New Tab. A full tab still in focus
opens a new tab named for the fork. Replaced machines/auth sessions and changed
source identities cannot receive a stale request. Late receipts cannot undo
an observed rename or restore a fork that was stopped in the meantime.

## Restarting an agent or shell

Restart Agent / Restart Terminal remain immediate actions. Command search,
custom bindings, pane controls, and the machine list open the same compact
status prompt. The source and machine remain visible. Escape returns to the
terminal while the model keeps the request; reopening joins it. Restart keeps
the existing panes, terminal views, tabs, and focus.

Confirmed refusals retain their explanation inline with Enter/retry. A lost
reply switches Enter to “check status” using the original receipt. It never
implicitly sends another restart. “Restart again…” is an explicit second
action, with Cancel initially focused and a visible reminder that the earlier
restart may have completed. Escape returns from this confirmation, then closes
the status prompt. Tab traverses controls; Page Up/Down scroll text without
adding a scrollable-text stop to focus traversal. Live picker remappings apply.
Enter on a focused Close control also dismisses a pending restart; it does not
submit another restart or cancel the operation.

A resumed agent closes the prompt when confirmed. A fresh conversation stays
visible with an explanation and Enter/close. A terminal restart means a fresh
shell, so it does not show a conversation-resume warning. Stale targets offer
Close instead of inviting a retry against a changed agent.

Restart receipts are durable in the updated CLI, including the resumed/fresh
outcome. Overlapping restarts of the same canonical agent share the process
operation even when requests come from different clients. Stop invalidates
that operation; the restart checks its target across asynchronous steps before
continuing process replacement. An already-issued system operation still has
to finish. The desktop rejects replies after a Stop request, removal,
replacement machine, or auth change. Newer session/name observations and
inventory begun before a confirmed restart cannot roll back current state.

Status recovery requires the updated CLI. Older successful replies remain
supported, while uncertain older replies require checking the terminal before
explicitly restarting again. Desktop receipt references last for the current
window; they are not persisted across app restarts.
