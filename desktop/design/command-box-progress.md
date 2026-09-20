# Command box continuation — 2026-09-20

Branch: `worktree-command-box`, based on fetched `origin/main` at `eb35e248`
(PR #136). The earlier local focus/JEV commits are now included through merged
PR #132. The terminal UI, creation, and onboarding changes remain uncommitted.

## Direction carried forward

The terminals are the product; Harness is the frame, one keystroke away.
Keep the bottom-docked search/new-agent prompt, fast launch with inherited
agent/machine/project, remappable keys, and clickable alternatives. Keep the
noun **Tab**. Do not add a status bar or permanent status segments.

The original operational brief is the session memory named
`command-box-handoff.md`; its design history is
`superterminal-design-direction.md`. This file records the subsequent work
inside the worktree so it is discoverable without searching session memory.

## Settings follow the highlighted agent — current continuation

The user could not reach a Codex profile while another engine was saved:
settings were based on the saved agent, not the highlighted result. They also
requested removing the repeated Agent/Machine/Project rows from both Agent
and Machine selection.

- Agent settings now follow typing and arrow selection. Permissions/Profile
  appear indented directly below the highlighted engine, so Down enters its
  settings without crossing another engine and changing the target.
- Browsing remains a preview. Escape preserves the saved agent and profile.
  Choosing a permission/profile commits the highlighted engine with that
  setting; Enter on an engine keeps the existing choose-and-return fast path.
  Returning from settings restores the filter and the selected settings row.
- Agent and Machine pickers now show a left-aligned title, choices, input,
  and hints. Their repeated summary rows are removed. The launch screen keeps
  the full summary. Scroll sizing retains room for six engine results plus
  inline settings, subject to window height and text size.
- Profile/mode pickers retain their agent target when opening and returning
  from Machine. The saved profile is untouched by merely browsing other
  engines. Filtering to no matching agent cannot launch or select a setting.

Verification: **65 focused checks pass**, including the Claude → highlighted
Codex → Profile flow, cancellation, committed-profile preservation, and hidden
summary rows in Agent/Machine (`/private/tmp/agent-highlight-tests.log`).
Inspected normal and enlarged-text previews in `agent-highlight-renders`.
Analysis, formatting, and `git diff --check` pass.

The native fake-agent creation test passed twice with packet diagnostics
enabled (`agent-highlight-native.log`, `agent-highlight-native-repeat.log`).
Its first run observed two unexpected terminal-input packets; this did not
reproduce in either repeat, and the source was not established. Keep the
diagnostics rather than weakening the empty-input assertion. These are
injected Flutter keys, not physical AppKit/IME validation.

Rebuilt normal `lib/main.dart` with the existing JEV endpoint
`http://127.0.0.1:18478` (`/private/tmp/agent-highlight-build.log`), verified the
bundle's deep/strict signature, and opened review PID **33363**. Previous review
PID 66703 remains open. No real agents were created by the fixtures; nothing
committed or pushed. Backups are in `/private/tmp/agent-highlight-before`.

## Agent settings without a main Options row — previous continuation

The user found Options too prominent and approved moving the settings into
Agent. The launch menu now contains Agent, Machine, Project, Task, and
Start/Create. Create remains selected initially; Up reaches Task directly.

- Removed the standalone Options row. Nondefault permissions and any explicit
  profile are summarized beside the Agent value; defaults stay quiet.
- Agent keeps its fast choose-and-return behavior. Permissions and Codex
  profile are explicit settings below its results, using the same typing,
  arrows, Enter, and Escape interaction. Choosing a setting returns to Agent
  with its search and settings-row selection restored.
- Added a profile picker scoped to the selected machine, with Default,
  discovered profiles, Refresh, and Link profile folder. Discovery never picks
  an account. Changing engine or machine clears the profile; stale discovery
  replies are ignored. Older CLIs explain missing support without issuing an
  unsupported request. Linking blocks editing, dismissal, and creation until
  the response arrives.
- An unmatched Agent query leaves no implicit selection; Enter/Cmd-Enter
  explains the empty result rather than using another agent or a settings row.
- Cmd-period retains the full form for compatibility and install guidance.
  Updated keyboard-practice copy, review notes, fixtures, and the native
  creation flow to use Agent → Permissions.

Verification: **75 focused checks pass** in
`/private/tmp/agent-settings-tests.log`; all four profile-flow checks also pass
after the final pending-link dismissal guard (`agent-settings-fix.log`).
Touched-file analysis and `git diff --check` pass. Inspected normal and
enlarged-text root, Agent, permissions, and profile layouts in
`/private/tmp/agent-settings-renders`.

The native fake-agent creation flow also passes in
`/private/tmp/agent-settings-native.log` (injected Flutter keys, not physical
AppKit/IME input). Rebuilt normal `lib/main.dart` afterward, preserving JEV at
`http://127.0.0.1:18478`; log `/private/tmp/agent-settings-build.log`.
Deep/strict signature verification passes. Opened the review app and confirmed
PID **66703**. No real agents were created by these fixtures; nothing committed
or pushed.

## Launch menu without letter shortcuts — previous continuation

The user observed that the launch menu was the remaining creation screen with
letter shortcuts and requested the same Up/Down/Enter interaction throughout.

- Removed the `a/m/p/t` labels and default bindings and the footer's `o` option.
  Rows and input context now share the same left alignment without a shortcut
  column. Explicit custom bindings still work through the stable command IDs.
- Options is always a selectable row above Create, including with default
  settings. Nondefault permissions/profile remain summarized beside Options.
  Up from Create opens the route to Options; Enter opens the full form.
- Create remains selected on entry and on return from an editor. Arrows move
  through Agent, Machine, Project, Task, Options, and Create. Enter edits or
  launches the selected row. Cmd-Enter and Cmd-period remain available.
- Updated keyboard-practice examples, design/review notes, existing test flows,
  and the native creation fixture to navigate the launch rows with arrows.
  Plain-letter tests confirm there are no default jumps or side effects.

Verification: **94 focused checks pass**, including Options via Up/Enter and
return to Create, plus the native fake-agent creation flow. Logs:
`/private/tmp/launch-arrows-tests.log`, `/private/tmp/launch-arrows-native.log`.
The native fixture uses injected Flutter keys, not physical AppKit/IME input.
Touched-file analysis, formatting, and `git diff --check` pass. Inspected
normal and enlarged-text layouts in `/private/tmp/launch-arrows-renders`.
The native-keymap helper's launch assertions were updated; its unrelated
legacy workspace assertions were not rerun.

Rebuilt normal `lib/main.dart` after the fixture, preserving JEV at
`http://127.0.0.1:18478`; log `/private/tmp/launch-arrows-build.log`. Deep/strict
signature verification passes. Opened the review app and confirmed new PID
**47771** (previous review PID 66905 remains open). No real agent was created;
nothing committed or pushed.

## Project search without action shortcuts — previous continuation

The user requested typing to filter Project just like Agent and Machine,
with recent projects above fixed New/Open/Clone actions and the input below
them. They then simplified the request: remove `1–9` and `n/o/g`; use typing,
Up/Down, Enter, and Escape throughout Project.

- Project now focuses a search input and filters names/paths, including case
  and common word-separator variations. Results stay on the selected machine.
  The best matching recent is highlighted, or Open folder when none match.
- New project, Open folder, and Clone GitHub repository stay visible above
  the input in that visual order. The recent list remains scrollable, with
  room for up to nine visible rows and older projects reachable by arrows.
  Search changes re-reveal the best result even if its cursor index is unchanged.
- Removed action letters and numbered row labels/default shortcuts in Project.
  Ordinary letters/digits remain search text, including `m`; the header's
  clickable Change machine action remains, and launch `m` still edits Machine.
  Existing command IDs remain unbound for explicit custom remaps. Navigation
  continues to inherit picker remaps. Root launch `a/m/p/t/o` is unchanged.
- Escape from New/Open/Clone restores the Project filter; reopening from
  launch resets it. Changing machines clears a filter belonging to the previous
  machine. The folder child still has no duplicate recent list.
- Updated keyboard practice, render/native fixtures, interaction tests, and
  the current design and manual-review notes.

Verification: **94 focused controller/widget/keymap/practice/render checks
pass**, plus the native creation flow with fake agents. Logs:
`/private/tmp/project-filter-tests.log`, `/private/tmp/project-filter-native.log`.
The native fixture uses injected Flutter keys, not physical AppKit/IME input.
Touched-file analysis has no issues; formatting and `git diff --check` pass.
Inspected the long-history, filtered, no-match, and enlarged-text renders in
`/private/tmp/project-filter-renders`. The older native keymap helper's Project
assertion now reflects unbound action keys; its unrelated legacy workspace
assertions were not rerun in this continuation.

Rebuilt normal `lib/main.dart` after the native fixture, preserving JEV at
`http://127.0.0.1:18478`; log `/private/tmp/project-filter-build.log`. Deep/strict
signature verification passes. Opened the review app and confirmed new PID
**66905** (previous review PID 81012 remains open). No real agent was created;
nothing committed or pushed.

## Arrow-selectable launch menu and plain prompts — previous continuation

The user requested clearer GitHub cloning copy, no extra `>` markers, and
Up/Down selection for the launch arguments as well as the child pickers.

- GitHub now says "Paste a GitHub repository URL" and "Clone to
  machine:~/harnesses/<repository>". Short names such as `openai/codex`, HTTPS,
  and SSH URLs still parse as before. Selection prepares the repository;
  launching performs the clone. Invalid-input guidance uses a concrete example
  instead of the unexplained word "owner".
- Cmd-N input labels (`agent`, `machine`, `folder`, `repo`, `name`, `task`) no
  longer append `>`. Their baselines and value columns align with the context.
  Result rows use the full-width highlight without an extra `>` selection
  pointer, and their names use the input/context's left inset.
- The launch menu has an explicit Create/Start row, selected initially, so
  Enter retains the fast launch with inherited defaults. Up/Down cycle through
  the displayed arguments, any visible options summary, and Create. Enter
  opens the highlighted argument; `a/m/p/t/o` still jump directly. Returning
  from an editor highlights Create again. Cmd-Enter starts from any selected
  launch row. A missing project still opens Project instead of creating an
  unnamed folder. Pending creation disables argument navigation.
- The footer describes the selected action and prints the effective remapped
  navigation keys. A moved pointer can select a launch row; a parked pointer
  does not override keyboard selection. Keyboard-practice examples and the
  design/review notes match the new copy and interaction.

Verification: **60 focused creation/controller/layout tests pass**, followed
by **21 layout/render/practice checks** after the final alignment adjustment
(overlapping sets). Logs: `/private/tmp/launch-menu-tests.log` and
`/private/tmp/launch-menu-final-tests.log`. New coverage drives every launch
argument through arrows/Enter without starting an agent, checks return to
Create, and verifies live navigation remapping. The native creation workflow
also passes with fake agents and arrow-selected Machine:
`/private/tmp/launch-menu-native.log`. This uses injected Flutter keys, not a
physical AppKit/IME walkthrough. Final touched-file analysis, formatting, and
`git diff --check` pass. Inspected normal, highlighted-argument, enlarged-text,
and GitHub renders in `/private/tmp/launch-menu-renders`.

Rebuilt normal `lib/main.dart` after the native fixture, retaining JEV at
`http://127.0.0.1:18478`; log `/private/tmp/launch-menu-build.log`. Deep/strict
signature verification passes. Opened the review app and confirmed PID
**81012**. No real agent was created; nothing committed or pushed.

## One Project history and a focused folder prompt — previous continuation

The user requested more than four recents, removal of the duplicate history in
Open folder, bottom placement for the default action, and `o` instead of `e`.
Recommended and implemented one history in Project, with a separate path prompt
for a known folder or browsing on the selected machine.

- Project includes every available recent for the selected machine. The dock
  makes room for up to nine rows, with older entries accessible by arrows,
  Page Up/Down, or scrolling. Plain `1`–`9` pick the numbered entries. The current
  folder remains number 1; the list grows upward from the actions.
- GitHub, New project, and Open folder stay fixed below the recents. Open folder
  is the bottom/default row, reached with Enter or `o`. History cannot push the
  actions offscreen. `m` still changes the shared Machine setting.
- Open folder contains a path/completion prompt and an `Open folder…` browse
  row next to the input. It no longer repeats or searches recent projects.
  Empty Enter or Ctrl-O opens the selected machine's browser. Typed paths
  select matching folders; browse stays nearest the input. New project and
  GitHub remain separate intents.
- A `project` keymap context inherits picker navigation/remaps and scopes `o`
  to Open folder. The launch menu retains `o` for options. Printed hints,
  shortcut settings, keyboard practice, and the native snapshot share this
  distinction. The macOS snapshot validator and context handler now accept it.
- The selected recent remains visible when resizing or increasing text size.
  Other command docks keep their existing compact heights.

Verification: controller, completion, keyboard, and creation checks passed in
focused runs. The last layout/render run passed **18 checks**; the preceding
layout/keymap/shortcuts run passed **44** (overlapping sets). Logs:
`/private/tmp/project-recents-focused.log`,
`/private/tmp/project-recents-layout.log`, and
`/private/tmp/project-recents-resize.log`. Earlier failures were corrected and
rerun in the affected files; the complete desktop suite was not repeated.
Final touched-file analysis has no issues, formatting and `git diff --check`
pass. Inspected normal, older-history, path-only, and large-text renders in
`/private/tmp/project-recents-renders`.

The native creation workflow passes with fake agents:
`/private/tmp/project-recents-native-fixed.log`. Its first run caught and led
to fixing the macOS `INVALID_KEYMAP` rejection of the new context. Injected
Flutter keys do not establish physical AppKit/IME behavior. The separate older
`tool/check_keymap_native.sh` executes the new Project-context assertions but
then fails at its pre-existing obsolete expectation that Cmd-R splits right;
that helper has not been reconciled with the earlier shortcut redesign. Log:
`/private/tmp/project-recents-native-keymap.log`. No production shortcut was
changed to satisfy that stale expectation.

Rebuilt normal `lib/main.dart` after the native fixture with JEV retained at
`http://127.0.0.1:18478`; log `/private/tmp/project-recents-build.log`.
Deep/strict signature verification passes without a manual signing repair.
Opened the review app and confirmed PID **31023**. No real agent was created;
nothing committed or pushed.

## Quieter Quick Access symbols — previous continuation

The user approved keeping the Quick Open prefixes while removing the decorative
input `>` / `:` and the selected result's `>` pointer. Cmd-P/T and command
search now use a plain monospace input and a full-width selection highlight.
Only the editable prefix identifies the mode (`>`, `@`, `#`, or `?`); the footer
keeps the mode cheat sheet. Input and result names align at the same left inset.
The empty agent picker says "Find an agent…". Other field prompts are unchanged.

`SwarmSearchInput.terminal` separates terminal typography from the optional
prompt decoration used by the advanced agent chooser. TerminalBox supplies the
dock input's background, avoiding Material's extra filled-field inset.

Verification: **29 focused checks pass** (Quick Access, dock geometry, picker
entry, search rendering, and the existing render fixture), plus analysis and
`git diff --check`. Logs: `/private/tmp/quick-access-symbols-tests.log` and
`/private/tmp/quick-access-symbols-analyze.log`. Reviewed empty, command, and
narrow/large-text renders in `/private/tmp/quick-access-symbols-renders`.

Rebuilt normal `lib/main.dart`, retaining JEV on port 18478:
`/private/tmp/quick-access-symbols-build.log`. Opened PID **96237**. The rebuilt
App.framework verified independently, but the incremental build left its old
signature in the enclosing app's resource seal. Refreshed the generated app's
ad-hoc signature, preserving identifier, entitlements, flags, and runtime;
deep/strict signature verification now passes. No source signing settings were
changed. No real agent was created; nothing committed or pushed.

## Quick Access prefixes and creation polish — previous continuation

The final user-approved mapping is plain text = agents, `>` = commands,
`#` = projects, `@` = machines, and `?` = modes/help. An intermediate suggestion
of `@` agents and `m ` machines was rejected; it is not in the implementation.
Cmd-P/T now allow these prefixes. Cmd-Shift-P inserts `> ` instead of opening
a permanently command-only buffer. Deleting it returns to agents in the same
picker, keeping the New Tab/New Pane destination. Help's prefix rows switch
in place. Project/machine selection shows only that group's agents; Escape
restores the parent query. Missing groups never fall back to unrelated agents.
Prefix hints retain their space while typing so the dock input does not jump.

Recents previously used only the current folder and explicit creation history.
They now merge known agent folders from the selected machine (including local
CLI project metadata), collapse equivalent paths, and load saved history on
the first opening. The menu still shows four, with the full list under Open
folder. Live metadata updates refresh the menu without changing its selection.

Cmd-N's agent row no longer has `>_`. The editable prompt label uses an input
prefix aligned to the first text baseline, including empty hints and multiline
tasks, and shares the context column's left inset. Selected tabs retain their
3pt top rounding and use matching outward curves where they join the workspace,
in both the native macOS tab strip and Flutter fallback.

Research sources are linked in `super-terminal-interaction.md`; the interaction
comes from VS Code Quick Open, with object-specific meanings chosen by the user.

Verification: the full desktop run reached 2,326 passes and five skips, exposing
ten failures from outdated command-prefix/menu expectations, a test-local name
collision, and the hint-wrap input movement. After fixing those, all **71 checks
in the affected files plus the new Quick Access/render cases pass**:
`/private/tmp/quick-access-final.log`. The whole suite was not repeated after
that focused rerun. All **11 native macOS workflows pass** with fake agents:
`/private/tmp/quick-access-native.log`. This verifies injected Flutter input,
not physical AppKit/IME or VoiceOver behavior. Analysis, formatting, and
`git diff --check` pass. Final renders are in `/private/tmp/quick-access-renders`.

Rebuilt normal `lib/main.dart` after the native fixture, retaining JEV on
`http://127.0.0.1:18478`: `/private/tmp/quick-access-build.log`. Deep/strict
signature verification passed. Opened the review app with `open -n` and
confirmed PID **35448**. No real agent was created; nothing committed or pushed.

## Shared Machine setting, immediate recents, and quieter tabs — previous continuation

The user approved removing the selected-tab underline and making Machine a
first-class launch setting. Cmd-N now shows `a agent`, `m machine`, `p project`,
and `t task`. The path on the launch summary omits the duplicate machine prefix;
full `machine:path` notation remains in folder search and location previews.

Project now has three fixed actions (New project, Open folder, Clone GitHub)
and up to four numbered recent projects for the selected machine. The accepted
current folder is first, followed by that machine's recent history. `1`–`4`
select immediately; full history/search/browsing stays under `e`. Actions stay
fixed if the recent list needs scrolling. The Project header exposes the same
remappable `m` chooser as the launch screen. Cancelling Machine returns to its
source screen with its query intact; a changed machine clears a folder filter
from the old machine. Accepted project choices remain separate per machine,
and stale recent rows from another machine are rejected.

Both the native macOS tab strip and Flutter fallback now use the existing
selected background and bold label without the 2pt underline.

Verification: 86 focused creation/practice/render checks passed, followed
by 62 final keyboard/render checks including shared-Machine return, remapping,
numbered recents, stale-machine rejection, and retained task/project choices.
Touched-source/test analysis has no issues; formatting and whitespace checks
pass. Normal and enlarged-text/narrow Project renders were inspected under
`/private/tmp/machine-recent-renders`.

All **11 native macOS journeys pass**, including the new top-level Machine
chooser and direct recent selection: `/private/tmp/machine-recent-native.log`.
These use fake agents and injected Flutter input; physical AppKit/IME and
VoiceOver were not newly verified. The whole desktop suite was not rerun.
The normal app was rebuilt from `lib/main.dart` after the native fixture,
retaining `JEV_COMMAND_BAR_URL=http://127.0.0.1:18478`:
`/private/tmp/machine-recent-build.log`. Deep/strict signature verification
passed. Opened `build/macos/Build/Products/Debug/Harness.app` with `open -n`
and confirmed PID 14979; existing app instances were left alone. Nothing was
committed or pushed, and no real agent was created for verification.

## Project actions and visible task availability — previous continuation

User review found that project history buried New/Open/GitHub/Machine, and Pi
hid the task row. Project now opens a separate four-action menu: `n` New project,
`e` Open existing project, `g` Clone GitHub repository, and `m` Change machine.
All four stay visible regardless of recent history. Arrows follow the menu's
top-to-bottom order, Enter chooses, and the letters follow the live keymap.

Each action opens a dedicated prompt: `name >`, `folder >`, `repo >`, or
`machine >`. Existing searches only that machine's folders and never converts
a missing match into a new folder. Its footer keeps Ctrl-O/clickable Browse
folders visible. New previews the exact slug/path and offers Open existing on
a collision. A late folder listing now refreshes that name preview too.
GitHub accepts owner/repo or supported GitHub URLs and cannot silently launch
in the old project on invalid input. Selection retains the repository for
launch; it does not clone while merely browsing the menu. Escape backs out to
Project, then the launch summary. Switching machines retains their accepted
project choices separately.

Task stays visible for Pi and other unsupported engines with “Enter a task in
<agent> after launch”; `t` explains the restriction. This reflects the current
CLI first-prompt contract, not a claim that Pi itself lacks prompt support.
No CLI engine-launch behavior changed. Supported agents retain the task editor
and all first-message/draft/recovery protections.

Verification: **90 focused creation/practice/render checks**, **92 keymap,
first-task, and recovery checks**, and **11 native macOS journeys** pass. Logs
are `/private/tmp/project-menu-focused2.log`, `project-menu-keymap.log`, and
`project-menu-native.log`. Final touched-file analysis has no issues; formatting
and whitespace checks pass. Visuals in `/private/tmp/project-menu-renders`
include all four project actions at normal and enlarged text/narrow width,
New/Existing/GitHub/Machine prompts, and Pi's visible task row. The final render
fixture also passes. The entire desktop suite was not rerun for this revision.
Native journeys use fake agents and injected Flutter input, with no new
physical AppKit/IME or VoiceOver coverage.

The normal macOS debug app was rebuilt from `lib/main.dart` after the native
fixture, retaining `JEV_COMMAND_BAR_URL=http://127.0.0.1:18478`:
`/private/tmp/project-menu-build.log`. Deep/strict signature verification passed.
Opened `build/macos/Build/Products/Debug/Harness.app` with `open -n` and confirmed
the new review process (PID 30111). The earlier review instance was left alone.
No real agent was created; nothing was committed or pushed.

The user also asked about the selected-tab underline. It was explained as a
generic active-tab marker, not a copy of a particular terminal app. Simplifying
it to the existing fill and bold label was recommended; no tab-style change
was requested or made during this Project pass.

## Cmd-N launch menu and focused prompts — previous continuation

The user approved trying a launch-command model after reviewing Vim, Emacs,
tmux, zsh, and Magit patterns. Cmd-N reuses the current agent/project and shows
`a agent`, `p project`, and `t task`; Enter launches with the displayed setup.
Each letter opens one focused picker/editor, and Enter on an agent/project
returns to the launch menu. Enter in Task launches; Escape retains it and
returns to the menu. Menu letters are ordinary text inside editors. `o` and
Cmd-period open advanced options; these keys follow the live keymap.

Tab now completes the current argument without accepting a selection or
switching fields. Existing path completion/cycling and line editing remain.
If there is no project, its picker opens first; compact creation no longer
silently allocates an unnamed folder. New project opens `name >` with the
machine/path preview; whitespace in a name becomes the destination slug.
Machine selection remains nested in Project, with recents and cached choices
scoped to the selected machine. Escape goes back through these prompts.

The user also requested a much darker background behind floating forms.
New Harness and shared terminal forms (including Rename Tab) now use the
existing shared 90% black dialog tint with no blur. Docks keep their workspace
alignment. The updated ideal-user brief at the main checkout's
`docs/ideal-users.md` describes technical founders building across disciplines;
the task copy remains broad enough for a deck, analysis, video, or code.

Verification and review build:

- The full desktop run completed with **2,340 passed, 5 skipped, and one
  outdated test failure**. That test switched machines and attempted creation
  without choosing a project on the new machine. It now selects that project
  explicitly; all **26 final placement, Store, and render checks pass** in
  `/private/tmp/cmd-n-launch-final-focused.log`. The full suite was not rerun
  after this test-only correction. An earlier default-concurrency run was
  interrupted under heavy load; its local-discovery timing failures passed in
  isolation and in the completed concurrency-2 run.
- **All 11 native macOS journeys pass**, including the new launch menu, retained
  task, argument editing, advanced-form return, chosen destination, and terminal
  focus recovery: `/private/tmp/cmd-n-launch-native.log`. These use fake agents
  and Flutter-injected input. Physical AppKit keyboard/IME and VoiceOver are not
  newly verified. The fixture logged a foreground warning but completed all
  tests successfully.
- Final touched-source/test analysis has no issues; full app/test analysis has
  no errors or warnings and the same three existing informational lints.
  Formatting and `git diff --check` pass.
- Rendered and inspected the launch menu, empty and named project prompts,
  narrow layout at enlarged text, and dark Rename Tab/advanced-form backdrops:
  `/private/tmp/cmd-n-launch-renders`.
- Rebuilt the normal app from `lib/main.dart` after the native fixture, retaining
  `JEV_COMMAND_BAR_URL=http://127.0.0.1:18478`. Build log:
  `/private/tmp/cmd-n-launch-build.log`. Deep/strict signature verification passed.
  Opened `build/macos/Build/Products/Debug/Harness.app` with `open -n` and confirmed
  the review process (PID 43696). No real agent was created for verification;
  nothing was committed or pushed.

## PR #136 rebase and project-picker clarity — latest continuation

- Rebased onto `eb35e248` and restored all 184 working files. The only conflict
  was the import block in `swarm_screen.dart`; both sets of imports are retained.
  Hash comparison found no missing files and changes only in the three files
  that intentionally received upstream JEV updates. Nothing was committed or
  pushed, and the user's local `main` was not changed.
- Recovery copies: branch `backup/command-box-before-pr136-20260920` at
  `d46ffaf4`, stash `1b36d3c672ad8f7037b814e427f3cb3eba769056`, and the file archive,
  patch, and hash manifest in `/private/tmp/command-box-before-pr136-cn1qkthp`.
- **Cmd-Shift-J** still opens the separate experimental JEV prompt. PR #136
  makes exact app commands and unique session/tab titles run locally on Enter.
  Navigation offers **Go back** to the original view without closing the target.
  Duplicate names stay choices; full phrases are checked, including compound
  and negated requests. Semantic automatic actions use separate intent, target,
  and fit decisions. Send/create/watch continue to require explicit selection.
- The review service on `http://127.0.0.1:18478` was already running and connected.
  Its service, HTTP, credential resolver, and launcher source match the rebased
  code and predate its process start. The review build uses this service via
  `JEV_COMMAND_BAR_URL`; no daemon or existing service was restarted. A temporary
  unconfigured service on port 28577 was stopped after checking it.
- The initial twelve synthetic live checks were blocked by `OPENROUTER_CREDITS`.
  During user review, requests to the new service on port 18478 started returning
  HTTP 200 (01:37–01:40 local). The reported 404s came from the old daemon endpoint
  on port 18473, used by an older app instance. The new review build targets
  18478. Transport success is verified; the twelve-case semantic smoke suite has
  not been rerun, so its decision quality is not yet newly validated live.
  Exact local commands and Go back do not require provider credits.
- Project editing now says **on <machine>**, with **Search or name a project**
  at the prompt. An empty query offers **Open folder…**, existing folders on
  that machine, and **Change machine…**. There is no selected-looking `<name>`
  path or empty Create row. Typing `payments processing` offers
  **Create payments-processing** and one `machine:~/harnesses/payments-processing`
  destination. Clone requests do not also offer an unrelated new folder.
- Recent projects are scoped to the chosen machine. Switching to iMac cannot
  show M2 folders; switching back restores that machine's draft choice. Stale
  project rows from a different machine are rejected. Action rows are compact;
  real project choices keep their two-line name/path presentation.
- Synced Score's bundled tagline to the updated Store manifest brought in by
  PR #134. This fixes the two catalog identity checks exposed by the rebase.
- Added a native JEV journey covering exact navigation, Go back to the original
  pane, restored terminal input, and opening the existing New Tab chooser.
  Like the other native fixtures, it uses fake sessions and injected input.

Verification artifacts are under `/private/tmp/pr136-*`: 73 focused desktop
checks, 58 CLI checks, TypeScript checking, and the CLI build pass. The first
full desktop run passed 2,335 tests (5 skipped) with only the two Score tagline
mismatches; after synchronization, all 22 render/catalog/JEV checks pass.
App/test/integration analysis reports only the same three informational lints;
final touched-file analysis has no issues. Project empty/named states and JEV
Go back renders were inspected in `pr136-box-renders` and `pr136-jev-renders`.
All **11 native macOS journeys pass**, including the new JEV flow, in
`/private/tmp/pr136-native-final.log`. The fixture submits through the text-input
action and waits for the completion notice's entrance animation before tapping
Go back. This exercises the native workspace with injected Flutter input;
physical AppKit keys, IME, and VoiceOver are not newly covered.
The normal macOS debug build from `lib/main.dart` succeeded after the native
fixture, using `--dart-define=JEV_COMMAND_BAR_URL=http://127.0.0.1:18478`:
`/private/tmp/pr136-review-build.log`. Deep/strict signature verification passed.
Opened `build/macos/Build/Products/Debug/Harness.app` with `open -n` and confirmed
the new process (PID 47919, started 2026-09-20 01:34:14 local). An older review
instance was left running; the newly opened window is the one to review.

## Creation polish and keyboard learning — previous continuation

The user chose to leave JEV experimental and improve the everyday workflow.
No new JEV integration or promotion was added in this continuation.

- Project searches match words with spaces to hyphenated/underscored folder
  names. Selecting a recent project still chooses its machine and path together.
  Punctuation-only names cannot accidentally become an unnamed new project.
- Escape retains edited agent/project defaults even before a task is typed.
  Drafts remain scoped to their source and bounded to 32 inactive contexts;
  unresolved creations are retained. Cancelling Browse restores prompt focus.
- **Quick start** is an optional four-step guide alongside real work: open an
  agent, add a second pane in the tab, zoom, then open command search. Opening
  and cancelling an empty chooser does not count. It never takes typing focus.
  Progress and dismissal persist locally; the guide can be paused or restarted.
- **Keyboard practice** is a separate, repeatable terminal-styled scratch
  surface. Search by action/group, press the actual shortcut, see a simulated
  result, then Enter to continue or Escape to return. It covers the stable
  command catalog and prompt editing, follows live remaps/sequences/unbindings,
  and tracks local progress. Actions without a binding can be practiced by
  typing their command-search name. It does not execute workspace/agent actions.
  Page Up/Down reads longer explanations at enlarged text sizes.
- Both are discoverable on the start page, through command search, and from
  native Help. The shortcut reference links to practice too. `Pause quick start`
  is available through command search while the guide is active.
- Nested keyboard hosts now defer to the host nearest the focused control.
  This prevents one Escape from firing twice in the scratch surface and keeps
  real workspace shortcuts out of practice.

Primary files: `lib/state/workspace_learning.dart`,
`lib/widgets/workspace_quick_start.dart`, `lib/shortcuts/keyboard_practice.dart`,
and their integration in `lib/screens/swarm_screen.dart`.

Verification:

- **2,323 desktop tests passed, 5 skipped**:
  `/private/tmp/keyboard-learning-full.log`.
- After the final practice scrolling/typography refinements, **34 focused
  regressions** and **14 final keyboard/layout checks** passed, including the
  added narrow Quick start render:
  `/private/tmp/keyboard-learning-focused-final.log`,
  `/private/tmp/keyboard-learning-layout-final.log`.
- **All 10 native macOS journeys passed**, including the new Help-command
  dispatch, guide progression, simulated practice, single-step Escape, and
  restored terminal input: `/private/tmp/keyboard-learning-native.log`.
  These use fake agents and Flutter-injected keys; physical AppKit keyboard,
  IME, VoiceOver, and Linux runtime were not newly exercised.
- App/test/integration static analysis has no errors or warnings and the same
  three pre-existing informational lints:
  `/private/tmp/keyboard-learning-analyze-final.log`.
  `git diff --check` and formatting checks pass.
- Captured and inspected the practice list, exercise, result, keyboard-scrolled
  explanation, and narrow guide: `/private/tmp/keyboard-learning-renders`.
- Normal macOS debug build succeeded from `lib/main.dart` after the native
  fixture: `/private/tmp/keyboard-learning-build.log`. Signature verification
  passes. Review artifact: `build/macos/Build/Products/Debug/Harness.app`;
  opened with `open -n` for review. Nothing was committed or pushed.

## Agent → Project → Task, main rebase, and JEV — previous continuation

The accepted creation layout is now:

```text
agent     >_ Claude Code
project   iMac–Home:~/work/payments

task >    What should it do?
```

- Agent and Project are vertically aligned; Task initially owns input. Tab and
  Shift-Tab follow Agent → Project → Task. Choosing an agent or project with
  Enter returns to Task. The inherited project still makes repeat creation fast.
- Machine lives inside Project. Recent projects from all available machines
  show a two-line name and `machine:path`; selecting one chooses both together.
  Browse folders and Change machine are inside the project picker. Machine
  choice returns to Project; Escape backs out without dropping the task. Each
  machine remembers its project for this draft, including a More options round trip.
- The project prompt says `Type a project name`. `payments processing` offers
  `Create “payments processing”` with
  `machine:~/harnesses/payments-processing`. If that folder already exists under
  the selected machine's harnesses directory, the choice becomes Open. Existing
  paths, path completion, and repository cloning remain supported.
- Remote `~` resolves against the selected machine's home. Old directory/home
  replies cannot retarget the project after a machine switch. Browse results
  also check machine identity before applying.
- Auto-approve is hidden under More options (Cmd-period). A changed permission
  mode or chosen Codex profile appears in one compact options summary.

Main was behind upstream and carried two unpushed local commits. Those were
rebased on an isolated integration branch before applying them to this worktree;
the user's local `main` remains at `d626604d`. Two additional upstream commits
arrived during validation, including the JEV Sheets desktop chooser fix; this
branch includes them through `252fdc18`. Nothing was pushed. Existing desktop
and CLI WIP was restored unstaged. The final restoration compared all 175 saved
working files byte-for-byte with its stash and found no differences.

Recovery copies retained:

- Original branch: `backup/command-box-before-jev-20260919` at `3cd4014a`.
- Original WIP stash: `7a06eebf4db3805519430d90adae21e0a5c522a0`.
- Original file archive/patch/hashes: `/private/tmp/command-box-before-main-mthmiuvc`.
- Validated WIP before the final two upstream commits:
  `d6d70f2f1c9918002ba1373434520d7da7479847`.

### JEV catch-up

- **Cmd-Shift-J** opens the experimental command bar. Typing filters locally;
  Enter can ask JEV to navigate, find sessions by recent activity, route the
  exact task to an existing agent, suggest a specialized harness, or propose a
  watch. Sending, creating, and watching require their explicit action cards.
- Requests use bounded live evidence (up to 24 sessions, 24 harnesses,
  96 candidates / 32k characters) and revalidate targets before dispatch. The
  two watches per window recheck changed evidence at most once per minute.
- Its new-agent action now supplies engine and task to this dock. A folder
  from a focused remote pane is not inherited when JEV chooses another machine.
  JEV and the dock dismiss each other, preserve unsubmitted drafts, and respect
  an unresolved creation. The experimental JEV pill styling is unchanged.
- **JEV Sheets** is a separate Store harness: bring a spreadsheet, ask row-wise
  choice/score/yes-no questions, review confidence, export answers and findings.
  Its newest fix adds an in-pane file chooser because the macOS web view did
  not open the system file dialog. It offers recent files, browsing, pasted
  paths, and a paste-rows box.
- The command bar needs an updated daemon or the documented standalone
  service, plus OpenRouter credentials, for provider-backed requests. This
  continuation did not update/restart the daemon or make live provider calls.
  See `../../docs/experiments/jev-command-bar.md` and
  `../../store/agents/jev-sheets/README.md`.

Verification:

- **2,309 desktop tests passed, 5 skipped**:
  `/private/tmp/project-context-full-final.log`. The last two upstream commits
  touched Store packages/docs only; all desktop/CLI working files were restored
  identically afterward. Updated old field expectations and synchronized
  FreeCAD's bundled tagline with the changed upstream Store description.
- **All 9 native macOS journeys passed**:
  `/private/tmp/project-context-native.log`.
- **75 targeted CLI tests** and TypeScript checking passed:
  `/private/tmp/project-context-cli.log`,
  `/private/tmp/project-context-cli-typecheck.log`.
- **All 42 JEV Sheets tests passed**, including the new in-pane chooser:
  `/private/tmp/project-context-jev-sheets.log`.
- **5 new project-context tests** cover Tab order, spaces in names, machine
  ownership, duplicate folder names, offline choices, remote home completion,
  existing destinations, draft retention, and delayed replies. JEV-to-creation
  integration and focus ownership also have a regression journey.
- Rendered 107 box states and inspected ordinary, narrow and enlarged-text
  layouts: `/private/tmp/project-context-renders`. Static analysis has no errors
  or warnings and the same three existing infos:
  `/private/tmp/project-context-analyze-final.log`.
- Normal macOS debug build succeeded after the native fixture, with
  `--target lib/main.dart`: `/private/tmp/project-context-build.log`.
  Artifact: `build/macos/Build/Products/Debug/Harness.app`. Opened with `open -n`;
  its process remains running and `codesign --verify --deep --strict` passes.
  Live UI automation could not reliably distinguish it from the installed
  copy with the same bundle ID. The observed launch crash reports name
  `/Applications/Harness.app` and mismatched framework Team IDs, not this
  worktree artifact. That installed copy was not modified. Visual verification
  of this change is from the rendered fixtures and native integration journeys.

## Compact dock, tab height and Harness Store — current continuation

The user accepted the simulated panel's compact bottom-dock direction, asked
to check the unusually tall tab bar, and approved three prominent Store
entrances. Implemented:

- Bottom-up dock results: best match immediately above the input, about six
  visible rows, Up/P/K away from the input and Down/N/J back toward it. Docked
  lists clamp at their ends; inline start-page search keeps its existing order.
- A smaller dock height budget, default preview beside results or above them
  when narrow, no redundant preview for New agent, and stable footer widths.
- New Pane shows its captured destination tab. New-agent choices follow the
  same spatial ordering; the inherited engine is first, while task arrows
  remain text-editing keys.
- AppKit `.unifiedCompact`: measured 40pt versus the previous 52pt with a
  scratch AppKit probe. The Flutter fallback is also 40pt, with matching tab
  top insets and centered controls.
- Persistent **Harness Store** text control at the far right of both tab bars.
  `app.store` is a remappable command, searchable as store/install/browse
  harnesses/packages/extensions. **Browse more harnesses…** in agent choices
  opens the Store while retaining the source's task/default draft. All paths
  reuse the existing singleton Store-tab behavior.
- Utility tabs now hide the retained canvas rather than disposing its terminal
  renderers. A native regression caught the previous remount after Store
  browsing; the original view, selection and scroll can now survive the trip.
- The taller offline help card scrolls when needed, including the breakpoint
  newly reached by reclaiming 12pt from the tab bar.

Verification:

- **2,277 desktop tests passed, 5 skipped**, including dock geometry/spatial
  keys, Store aliases/remapping, singleton tabs, native/Flutter dispatch,
  retained terminal views, focus and draft ownership.
  `/private/tmp/terminal-compact-full-final.log`.
- **All 9 native macOS journeys passed**, including Store round trips retaining
  the original terminal renderer. `/private/tmp/terminal-compact-native-retained.log`.
- **69 focused regressions passed** while generating 107 box renders and
  wide/narrow/2x-text picker captures. Inspected input adjacency, preview order,
  footer wrapping and the compact top bar.
  `/private/tmp/terminal-compact-regressions.log`,
  `/private/tmp/terminal-compact-final-render`,
  `/private/tmp/terminal-compact-final-picker`.
- Static analysis: no errors or warnings, the same three informational lints
  in app_state.dart, grid_model_picker.dart and pane_grid.dart.
  `/private/tmp/terminal-compact-analyze-final.log`.
- The normal macOS debug build succeeded with `--target lib/main.dart` after
  native fixtures and was opened for review. Native UI inspection confirmed
  the compact bar and permanent Harness Store control beside the user's tabs.
  `/private/tmp/terminal-compact-build.log`.

## Dock placement discussion

The user is reconsidering top versus bottom and explicitly wants AI reviewers
roleplaying expert terminal developers. No human outreach is requested. The
roleplayed panel splits: two favor compact bottom docks with different internal
ordering; one favors top. All prioritize query/result adjacency, explicit scope
and reliable focus restoration. The bottom-dock direction is now implemented
as described above.
The opinions, design tradeoffs and primary-source references are in
[command-dock-placement-review.md](command-dock-placement-review.md).

## Default previews and harness marker — latest review feedback

New Tab and New Pane now open with preview visible, matching the start-page
picker. Ctrl-/ still hides or restores it without changing the query, selection
or input focus. The default was previously off to keep the picker compact;
the user prefers immediate context. The Enter hint is shortened to `open`
when the dock title already names its destination, avoiding a footer wrap that
moved the input while filtering in narrow windows.

`>_` is the ASCII harness marker before Codex, Claude and other harness names
in all prompt presets, agent previews and new-agent defaults. Machine symbols
use a monitor so the two kinds of context are visually distinct. Catalog data
now supplies a separate harness field; offline and fork annotations do not
acquire a harness marker. The customization preview includes a Codex segment.

Verification: **147 focused checks passed** (128 picker/layout/keyboard and 19
placement checks), 107 box states and 21 customization states rendered, and
wide/narrow prompt examples inspected. Static analysis has no errors or warnings
and the same three existing infos. The normal macOS debug build succeeded with
`FLUTTER_TARGET=lib/main.dart`. Logs:
`/private/tmp/terminal-preview-marker-checks.log`,
`/private/tmp/terminal-preview-marker-placement.log`,
`/private/tmp/terminal-preview-marker-analyze.log`, and
`/private/tmp/terminal-preview-marker-build.log`.

## Workspace dock and prompt customization

The requested workspace styling is implemented and rebuilt for review. Search, New Tab, New Pane and New Agent use a bottom command dock,
aligned with the pane grid's 6px outer inset. Results sit above the input. The
dock does not resize terminal renderers. The editor retains its input connection
when switching between task and default fields; ordered traversal takes Tab from
the search input to the first result, including virtualized lists.

The New Pane pill has been removed from both native macOS and Flutter titlebars.
Cmd-P, File → New Pane and command search remain. Tabs use monospace labels,
flat 3px corners and a thin selection rule; pane corners share that radius.
Native tab labels follow the selected terminal font.

Customize OpenHarness now opens on a Prompt tab, also reachable by typing
`customize` in Cmd-Shift-P command search. Plain, Symbols and Powerline presets
have a live preview, optional color, and machine/project/branch visibility.
Choices persist together without replacing wallpaper, color palette or fonts.
Search and pane headers share this presentation. Catalog identity and ranking
remain based on the actual agent metadata. No repository status is fabricated.
See [research and design decisions](terminal-prompt-styling.md).

Verification for this pass:

- Full desktop suite: **2,270 passed, 5 skipped** (`/private/tmp/terminal-dock-full-final.log`).
- Final focused field/creation/customization/startup/identity regressions: **40 passed**;
  dock and configured-key regressions: **30 passed**.
- Native macOS workspace fixture: **9 journeys passed** (`/private/tmp/terminal-dock-native.log`).
- Static analysis: no errors or warnings; the same three pre-existing infos.
- Rendered 107 box states and 21 customization states. Inspected the three
  context styles, narrow Powerline, wide/large-text creation, search preview,
  and customization at ordinary and enlarged text sizes.
- Normal macOS debug build succeeded; `FLUTTER_TARGET=lib/main.dart` confirmed.
  Artifact: `build/macos/Build/Products/Debug/Harness.app`.
  Build log: `/private/tmp/terminal-dock-macos-build.log`.

The user's installed or already running applications were not replaced or
restarted. Relaunch the worktree artifact to see the new styles.

The unfinished Settings navigation experiment was parked before this review:
its three source files were restored to their previous state, with its exact
patch retained at `/private/tmp/terminal-settings-wip.patch`. It needs live
keymap propagation, section focus, responsive layout and tests before resuming.

At that stage onboarding remained a design proposal. It is now implemented as
Quick start and optional Keyboard practice; see the latest continuation above.

## Terminal restart status and lifecycle — latest continuation

Restart Agent / Restart Terminal now use a compact terminal status prompt.
The action still starts immediately; Escape returns to the workspace while
the request continues. Reopening joins that request. Confirmed refusals stay
inline with Enter/retry. Lost replies switch to Enter/check status on the
original receipt. “Restart again…” is a separate action, with Cancel focused
initially and an explicit reminder that the earlier restart may have completed.
The confirmation stays fully visible at 480×360 with 1.7× text. Tab goes directly
through controls; Page Up/Down scroll the explanation without making it an
extra focus stop. Picker bindings, including live changes, apply throughout.

Command search and custom bindings now expose Restart Agent, or Restart Terminal
for shells. Pane controls and the machine list use the same names and prompt.
A resumed agent closes the prompt. A fresh conversation retains a clear notice
with Enter/close; a fresh shell does not show a conversation-resume warning.
The existing terminal views, tab membership, and focused pane remain intact.

Restart attempts belong to the model, with one pending request per source.
Completed explicit intents cannot replay, and uncertain attempts only query
status until the user deliberately starts another. Stale source/machine/auth
identity and any intervening Stop request invalidate late results. Replies
cannot restore a removed or recreated agent, undo a newer name/session, or
let inventory begun before the restart restore the old session.

The CLI now persists restart receipts, including resumed/fresh outcomes.
An in-memory coordinator also joins overlapping restarts of one canonical
agent across clients and receipt IDs. Stop cancels that operation; target
checks around asynchronous steps prevent subsequent process replacement or
fresh fallback after cancellation. Already-issued system calls still finish.
No real agent, shell, or running daemon was restarted during this work.

Verification:

- Focused restart, stop, fork, rename, and pane regressions: **89 passed**.
  New coverage includes **18 restart model tests and 6 keyboard tests**. Log:
  `/private/tmp/terminal-restart-focused-final.log`.
- A final keyboard check found that Enter could not activate a focused Close
  control while Restart was pending. Focused controls now own Enter before the
  pending-submit guard. All **27 restart model, keyboard, and pane checks pass**,
  including Tab/Enter dismissal followed by reopening the same request. Log:
  `/private/tmp/terminal-restart-review-focused.log`.
- Full desktop suite before that final focused-control fix: **2,266 passed,
  5 skipped, no failures**. Log:
  `/private/tmp/terminal-restart-suite-final.log`.
- CLI socket, receipt, and restart tests: **117 passed** across three files.
  Cancellation is exercised before dispatch and during hold, termination,
  resume preparation, respawn, and process discovery; no fresh fallback runs
  after cancellation. Log: `/private/tmp/terminal-restart-cli-tests.log`.
- TypeScript typecheck passed with `--incremental false`, and the local CLI
  compiled successfully. Logs: `/private/tmp/terminal-restart-cli-typecheck.log`
  and `/private/tmp/terminal-restart-cli-build-final.log`.
- Analyzer: no errors or warnings; the same three preexisting infos. Log:
  `/private/tmp/terminal-restart-analyze-review.log` (after the final keyboard
  and native fixture changes).
- **103 rendered states** in `/private/tmp/terminal-restart-final`. All ten
  new restart states were inspected, including pending reopen, refusals,
  uncertainty, explicit repeat confirmation, small-window/enlarged-text views,
  keyboard-scrolled details, fresh conversation, and shell restart. Log:
  `/private/tmp/terminal-restart-render-final.log`.
- All thirteen touched Dart files are formatted; `git diff --check` passes.
- Native macOS workspace fixture: **9 passed**. Log:
  `/private/tmp/terminal-restart-native-review.log`. Earlier runs passed eight
  journeys, including Restart, but Find correctly released its index while the
  fixture window was inactive. The fixture now explicitly shows and focuses
  its own window for each journey, and waits for the completed query snapshot
  before checking all four matches. Product background indexing is unchanged.

- Normal macOS debug rebuild succeeded after native verification, with explicit
  `--target lib/main.dart`; the generated target was checked. Artifact:
  `build/macos/Build/Products/Debug/Harness.app`. Log:
  `/private/tmp/terminal-restart-macos-build-final.log`.

The [30-item review checklist](terminal-review-checklist.md) records exact keys,
expected behavior, and useful feedback. Existing app instances and the installed
application were not replaced or restarted. Status recovery
requires the updated CLI; legacy successful replies remain supported. Desktop
receipt references last for the current window, not across app restarts.
Native tests use simulated traffic and injected Flutter keys. Real process
replacement, physical keyboard/IME, VoiceOver, Linux runtime, settings, and
remaining onboarding need further work. The broader goal remains active.

## Terminal fork prompt and receipt recovery — preceding continuation

Fork Agent now uses the same thin terminal frame, font, transparent backdrop,
and local key guide as search and creation. The source, machine, and actual
project folder are visible above `name >` and `task >`. Task input owns focus
immediately; the draft survives Escape. Native Next/Done, multiline tasks,
Alt-Enter, Readline editing, composition, custom submit/accept/cancel/traversal,
and live keymap reload are covered. Up/Down and Ctrl-N/P keep their editing
behavior inside the task. Fork Agent is available in command search and as a
remappable action without reserving a default terminal chord.

Pending forks now belong to the model. Reopening joins the existing request;
repeated submission cannot start a second fork. Refusals keep the edited draft
and report errors inline. A lost response locks the submitted choices and
offers “check status” using the same creation receipt. Starting another fork
is a separate explicit action followed by confirmation. A short uncertainty
message, recovery controls, and Escape stay visible in short windows; longer
details scroll with Page Up/Down.

The CLI now gives `agent_fork` the durable receipt support already used by
creation. It reserves the intent before launch, coalesces repeated requests,
and retains native/handoff information through status lookup and daemon
restart. Spawn/registration failures remain unconfirmed rather than inviting
an automatic retry. The desktop accepts legacy successful fork responses;
lost-response status recovery requires this updated CLI. No running daemon
was restarted or updated as part of verification. Desktop drafts and receipt
references remain in memory for the current window.

The original destination and focus are captured when the fork starts. A late
result opens there without moving the user's newer focus; closed or full
background destinations leave the created agent available through New Pane or
New Tab. A full tab still in focus opens a new tab named for the fork. Stale
machine/auth/source identities are rejected before dispatch, and late receipts
cannot undo a newer observed name or restore a fork stopped in the meantime.
Restart behavior is unchanged in this continuation and remains a separate audit.

Verification:

- Focused fork, creation recovery, placement, stop/rename, and menu regressions:
  **115 passed**, including 19 new fork model tests and 8 keyboard tests. Log:
  `/private/tmp/terminal-fork-focused-final.log`.
- Full desktop suite: **2,242 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-fork-suite-final.log`.
- Native macOS workspace fixture: **8 passed**. The new journey verifies
  immediate task focus, multiline draft restoration, pending reopen, lost-reply
  status lookup without another fork, successful placement, and returning input
  to the original terminal. Log: `/private/tmp/terminal-fork-native-final.log`.
- CLI receipt/socket checks: **89 passed**; existing fork planning checks:
  **8 passed**. Logs: `/private/tmp/terminal-fork-cli-tests.log` and
  `/private/tmp/terminal-fork-cli-plan-tests.log`. TypeScript typecheck passed;
  local CLI compilation passed (`/private/tmp/terminal-fork-cli-build-final.log`).
- Analyzer: no errors or warnings; the same three preexisting infos. Log:
  `/private/tmp/terminal-fork-analyze-final.log`.
- **93 rendered states** in `/private/tmp/terminal-fork-final`. All nine new
  fork states were inspected, including pending reopen, refusals, uncertainty,
  480×360 at 1.7× text, keyboard-scrolled details, and OpenCode handoff. Finder
  and creation previews were also inspected. Render log:
  `/private/tmp/terminal-fork-render-final.log`.
- All fourteen touched Dart files are formatted; `git diff --check` passes.

The normal macOS review app was rebuilt after native testing with explicit
`--target lib/main.dart`, also confirmed in generated configuration. Artifact:
`build/macos/Build/Products/Debug/Harness.app`. Build log:
`/private/tmp/terminal-fork-macos-build-final.log`. Existing user app instances
remain untouched. Tests use simulated traffic; no live fork or engine-history
copy has been exercised. Physical keyboard/IME, VoiceOver, Linux runtime,
restart lifecycle, settings, and remaining onboarding still need further work.
The broader goal remains active.

## Terminal stop prompts and agent lifecycle — preceding continuation

Stop Agent / Stop Terminal now use the same compact terminal frame, font, and
key guide as search and creation. The prompt identifies the agent and machine,
explains what stopping does, and starts on Cancel. Controls and Escape remain
visible in short windows; Page Up/Down scroll the explanation at enlarged text
sizes. Stop Agent is available through command search and custom bindings,
with Stop Terminal used for shell agents. No default terminal chord is taken.
Pane menus use the same names and prompt.

Stopping now retains progress and errors inside the prompt. Its persistent
focus node fixes Escape/custom cancellation after the focused Stop button
disappears. Reopening joins the existing model-owned request instead of
sending another. Failures return focus to Cancel and allow retry. Closing a
pane continues to leave the agent running.

Confirmation captures the machine, agent session, auth revision, and observed
deletion generation before the user accepts. A replaced target cannot receive
the old confirmation's stop request; ordinary inventory/name updates are still
accepted. Pending stop receipts also check identity/session, and an
`agent_deleted` event can complete the request before its RPC receipt arrives.
An old receipt cannot affect a recreated ID. All views of the stopped agent
are removed across tabs before awaiting local detach cleanup, retaining other
terminals. Older inventory cannot restore a stopped row or overwrite an ID
recreated after the stop. Rename and new restart requests are blocked while a
stop is pending.

Verification:

- Focused stop, rename, machine-manager, pane, and handoff regressions:
  **103 passed**, including 19 new stop model/widget checks. Log:
  `/private/tmp/terminal-stop-focused-final.log`.
- Final full desktop suite: **2,215 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-stop-suite-final.log`.
- Native macOS workspace fixture: **7 passed**. The new journey confirms the
  default Cancel, pending dismissal/reopen, inline refusal/retry, closing only
  the target's views, and returning input to the retained terminal. Traffic
  is entirely simulated. Log: `/private/tmp/terminal-stop-native-final.log`.
- Analyzer: no errors or warnings; the same three preexisting infos. Log:
  `/private/tmp/terminal-stop-analyze-final.log`.
- **84 rendered states** in `/private/tmp/terminal-stop-final`; all eight new
  stop states were inspected, including pending reopen, errors, 480×360 at
  1.7× text, and keyboard-scrolled details. Finder and creation previews were
  also inspected. Log: `/private/tmp/terminal-stop-render-final.log`.
- All fifteen touched Dart files are formatted; `git diff --check` passes.

The normal macOS review app was rebuilt after the native fixture with explicit
`--target lib/main.dart`, also confirmed in generated configuration. Artifact:
`build/macos/Build/Products/Debug/Harness.app` (binary timestamp 18:53:41).
Build log: `/private/tmp/terminal-stop-macos-build-final.log`. Existing user
app instances were not restarted, and no real agent or shell was stopped.

The CLI acknowledges deletion before its asynchronous process cleanup ends;
the native fixture does not prove live process termination. A CLI restart may
retain the same agent/session identity; the new guard protects changed
identities and observed deletion/recreation, not every same-agent restart.
Requests for restart that began before Stop still need a separate lifecycle
audit. Fork dialogs, settings, remaining onboarding, physical keyboard/IME,
VoiceOver, and Linux runtime are further work. The broader goal remains active.

## Terminal renaming and agent name consistency — preceding continuation

Tab, agent, and machine rename now share `TerminalNamePrompt`: the same thin
terminal frame, `name >` editor, monospace font, and local key guide. The whole
name is selected once on opening. Immediate typing, native Done, readline
editing, composition, live picker remapping, inline errors, and short-window
layouts share one implementation. Tab names keep the 80-character limit, and
each editor has a specific accessible name.

Rename Agent is now a command-search action for the focused owned agent. It
can be assigned a key without taking a default chord away from the terminal.
The existing double-click path uses the same editor. Its delayed focus timer
was removed: that timer could reselect a name after the user had begun typing.
The direct title path is tested with background terminal output while editing.
Native Rename Tab acknowledges the visible input before awaiting its value.
Custom tab names remain independent of agent names.

Agent rename requests now belong to the model. Reopening joins a pending
request with read-only input, repeated Enter cannot duplicate it, competing
names are rejected, and different agents remain independent. Failures release
busy state and retain the draft for retry. The CLI's returned name is used
when present; timeout text distinguishes an unconfirmed result from a refusal.
Inspection of `cli/src/backendSocket.ts` confirms that `agent_update` replies
with the updated agent and broadcasts `agent_renamed`.

Late replies cannot rename a replacement machine, a different agent session,
or a deleted/recreated ID. Auth changes and disposal invalidate outstanding
requests. A newer observed name cannot be rolled back by an earlier request
receipt or inventory read. Fresh inventory and sync events now update every
open pane title, which previously required a separate rename event. Background
agent inventory also checks the machine/auth identity before applying a reply.

Verification:

- Focused rename, manager, commands, and focus regressions: **89 passed**. Log:
  `/private/tmp/terminal-renaming-focused-final.log`.
- New model and keyboard regressions: **16 passed** independently. Log:
  `/private/tmp/terminal-renaming-new-tests.log`.
- Final full desktop suite: **2,196 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-renaming-suite-final.log`. The first full run found
  two focus tests still locating the removed `AlertDialog`; their editor
  finders now use the stable tab-name key, preserving their focus assertions.
- Native macOS workspace fixture: **6 passed**. The new journey renames a tab
  and agent through command search, closes/reopens a pending save, retries a
  refused save, uses Ctrl-W, and returns input to the original terminal. Traffic
  is entirely simulated. Log: `/private/tmp/terminal-renaming-native-final.log`.
- Analyzer: no errors or warnings; the same three preexisting infos. Log:
  `/private/tmp/terminal-renaming-analyze-final.log`.
- **76 rendered states** in `/private/tmp/terminal-renaming-final`; all seven
  new rename states were inspected, including errors, pending work, and 480×360
  with 1.7× text. The refactored machine rename was also inspected at ordinary
  and enlarged text sizes. Log: `/private/tmp/terminal-renaming-render-final.log`.
- All fifteen touched Dart files are formatted; `git diff --check` passes.

The normal macOS app is rebuilt after native testing with explicit
`--target lib/main.dart`, also confirmed in generated configuration. Artifact:
`build/macos/Build/Products/Debug/Harness.app`. Build log:
`/private/tmp/terminal-renaming-macos-build-final.log`. Existing user app
instances remain untouched.
The broader product goal remains active; stop/fork dialogs, settings,
onboarding, physical keyboard/IME, VoiceOver, and Linux runtime remain useful
next audits.

## Machines Manager and account edits — preceding continuation

Machines Manager now uses the terminal frame and font, a `machine >` filter,
compact naturally ordered rows, and a contextual key guide. This computer comes
first; presence, linking, shared access, and agent counts remain distinct.
Search includes names, hostnames, IDs, and status. Direct matches outrank loose
fuzzy matches, and background updates retain the selected row.

Enter opens an `action >` list. Escape restores the machine query, then returns
to the terminal. Nested rename, delete, password, and link prompts hide the
parent panel and restore its action query and editing connection afterward.
The live picker keymap follows every nested route. Refresh keeps the input
focused and reports errors in place. Small windows scroll the body while the
input and footer stay visible; prompt labels and text share a baseline.

Rename uses a `name >` prompt with the current name selected. Native Done and
keyboard submission retain focus for retries. Delete names its account-level
effect and starts on Cancel. Shared machines explain their view-only access,
and this computer cannot be deleted here. Successful linking reports the result
even when the retained filter no longer matches an available action.

Machine rename/delete requests now belong to the model. Identical pending
requests join, competing edits are rejected, and reopening a prompt joins the
existing operation. Failures retain the edited input or confirmation and offer
a retry. Late replies cannot mutate a replacement machine or a different auth
session. Successful deletion closes that machine's panes across this window's
tabs; failed local stream cleanup does not repeat the committed account action.
Terminal disposal runs even when stream close fails.

An inventory response begun before an edit, or an offline cache response after
it, can no longer restore an old name or deleted machine. Newer live inventory
can still reflect another client's changes or a re-registered machine. This
protection belongs to the current window/auth session and clears on auth reset.

Verification:

- Focused manager/menu/link/inventory set: **74 passed** before the final prompt
  alignment and linked-status refinement; the final full suite includes those
  changes and the linked-status assertion. Log:
  `/private/tmp/terminal-machines-manager-focused.log`.
- Final full desktop suite: **2,180 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-machines-manager-suite-final.log`.
- Native macOS workspace fixture: **5 passed**. The added journey covers
  commands → machine/action search → rename → pending reopen → delete/cancel →
  pending reopen → retained terminal input. API responses and terminal traffic
  are fake. Log: `/private/tmp/terminal-machines-manager-native-final.log`.
- Analyzer: no errors or warnings; the same three preexisting infos. Log:
  `/private/tmp/terminal-machines-manager-analyze-final.log`.
- **69 rendered states** in `/private/tmp/terminal-machines-manager-final`.
  All twelve new manager states were inspected, including pending/error views,
  shared access, missing machines, and 480×360 at 1.7× text. Search and creation
  previews were also checked. Log:
  `/private/tmp/terminal-machines-manager-render-final.log`.
- All twelve touched Dart files are formatted; `git diff --check` passes.

The normal macOS review app is rebuilt after the native fixture with explicit
`--target lib/main.dart`: `build/macos/Build/Products/Debug/Harness.app`.
Generated configuration confirms the normal target. Build log:
`/private/tmp/terminal-machines-manager-macos-build-final.log`.
Existing user app instances remain untouched.

The broader product goal remains active. Other secondary dialogs, settings,
onboarding, and platform parity remain useful next audits. Native fixture keys
are injected through Flutter; physical AppKit keyboard/IME, VoiceOver, Linux
runtime, and live daemon behavior remain outside this evidence.

## Local password and outgoing links — preceding continuation

“This computer’s password” now uses the same thin terminal frame, transparent
backdrop, monospace font, and local key guide as search and creation. The two
masked prompts read `password >` and `again >`. Initial typing works immediately;
Enter advances and then submits, native Next/Done keep focus, and Escape cancels
an edit or returns to the chooser. Composition owns its keys. Readline editing,
visibility controls, retry focus, and live remapping work across the nested
route. The summary's focused control owns Enter after the input is removed.

The machine chooser hides while a nested password prompt is open, leaving one
visible panel. Returning restores its query, selection, and focus. Outgoing
trust is a separate “Links from this computer” view, keeping it distinct from
this computer's incoming password. Fingerprints and dates remain available.
Clear and unlink confirmations focus Cancel first; errors remain visible and
retryable. Short windows scroll the body while the key guide stays visible.

Password mutations now belong to the model. Reopening joins a pending operation
without retaining the closed password buffer; concurrent mutations are rejected.
A late status read cannot overwrite a completed change, unexpected exceptions
release busy state, and disposed/auth-stale replies cannot update current state.
Linked-machine refreshes coalesce, retain known rows on failure, and show errors.
Repeated unlink requests join; a failed refresh cannot restore a removed row.

The old clear confirmation claimed existing remote access would be revoked.
Inspection of `cli/src/lib/e2ee/manager.ts`, `store.ts`, and the CLI clear command
shows that clearing removes the password verifier; established trust/sessions are
separate. The UI and Dart API comment now accurately say that clearing prevents
new password-based links and leaves existing links/sessions connected. No actual
password, trust pin, or live agent was changed during verification.

Verification:

- Focused setup/password/keymap/boot set: **81 passed** before the final summary
  ownership assertion; that assertion also passed in the final full suite. Log:
  `/private/tmp/terminal-local-password-focused.log`.
- Final full desktop suite: **2,161 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-local-password-suite-final.log`.
- Native macOS workspace fixture: **4 passed**, including a new commands →
  chooser → set password → pending reopen → change/cancel → retained terminal
  journey. All CLI responses and terminal traffic are fake. Log:
  `/private/tmp/terminal-local-password-native-final.log`.
- Analyzer: no errors or warnings; the same three preexisting infos. Log:
  `/private/tmp/terminal-local-password-analyze-final.log`.
- **57 rendered states** in `/private/tmp/terminal-local-password-final`.
  All eight new states were visually inspected: initial, pending, failed, set,
  clear, outgoing links, unlink, and 480×360 with 1.7× text. Log:
  `/private/tmp/terminal-local-password-render-final.log`.
- All nine touched Dart files are formatted; `git diff --check` passes.

The normal macOS review artifact is rebuilt after the native fixture with
`--target lib/main.dart`: `build/macos/Build/Products/Debug/Harness.app`. Build
log: `/private/tmp/terminal-local-password-macos-build-final.log`. Existing user
app instances remain untouched. Physical AppKit input/IME, VoiceOver, Linux
runtime, and live daemon behavior remain outside the fake-fixture evidence.
The broader product goal remains active; Machines Manager, other settings and
onboarding surfaces, and platform parity remain useful next audits.

## Machine chooser and terminal setup guides — preceding continuation

“Link machine” now starts with a compact `machine >` chooser instead of two
large installation cards. It searches machine names and setup actions, shows
presence separately from trust, and puts direct matches before loose fuzzy
matches. Existing machines can go straight to password entry. Desktop and
SSH setup are explicit choices; already-linked machines explain how to open
their agents. The local computer is excluded from the remote list.

Both setup guides use the terminal frame and monospace text. Commands and the
download URL are selectable, all actions are keyboard focusable, and Tab
reveals controls even in short windows at enlarged text sizes. Clipboard
errors offer retry; commands are only copied, never executed. The desktop
guide points to the current command-palette path, and the local password
dialog was accurately titled “This computer’s password”. Its subsequent visual
and interaction audit is recorded above.

Machine arrivals preserve the selected row and do not fold away an open guide.
Escape returns from a guide to the original query, then closes the chooser.
Nested password dialogs return to that query as well. Refresh remains
available in every stage, coalesces repeated requests, and preserves focus and
filtering on failure. Active composition retains ownership of its keys.

The chooser carries the live keymap across both direct workspace and Machines
Manager routes. Navigation, accept, cancel, traversal, and refresh use picker
bindings. A new `picker.refresh` command defaults to Cmd-R/Ctrl-R; only the
machine chooser supplied its action at this stage. Custom bindings take precedence in hints.
The configured accept key activates focused guide controls. An unbound Enter
or Escape cannot fall through and open/close the search anyway. Live binding
updates, disabled defaults, both route paths, and Linux refresh are tested.

Verification:

- Focused setup/keymap/boot/manager set: **64 passed**. Log:
  `/private/tmp/terminal-machine-setup-keymap-checks.log`.
- Final full desktop suite: **2,147 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-machine-setup-suite-final.log`.
- Native macOS workspace fixture: **3 passed**. Its linking journey now uses
  the actual command palette and machine chooser to reopen a pending request,
  verifies the retained query after linking, and returns input to the original
  terminal. Traffic remains entirely simulated. Log:
  `/private/tmp/terminal-machine-setup-native-final.log`.
- Analyzer: no errors or warnings; the same three preexisting infos. Log:
  `/private/tmp/terminal-machine-setup-analyze-final.log`.
- Forty-nine rendered states in `/private/tmp/terminal-machine-setup-final`.
  All five new machine chooser/guide states were inspected, including an empty
  result and the SSH guide at 600×420 with 1.7× text. Log:
  `/private/tmp/terminal-machine-setup-render-final.log`.
- Formatting of all eleven touched Dart files and `git diff --check` passed.

The normal macOS debug app rebuilt with `--target lib/main.dart` after the
native fixture: `build/macos/Build/Products/Debug/Harness.app`. Log:
`/private/tmp/terminal-machine-setup-macos-build-final.log`. Existing app
instances were not restarted. Work remains uncommitted and unpublished.
Widget platform variants establish the Linux key behavior; Linux runtime,
physical AppKit keyboard/IME, VoiceOver, and real daemon setup remain unverified.
The broader product goal remains active.

## Terminal machine linking and connection ownership — preceding continuation

The remote-password entry now shares search and creation's thin, top-anchored
terminal frame, monospace text, transparent backdrop, and compact key guide.
The target machine appears above a `password >` input. The body scrolls in
short windows while the recovery instructions remain visible. Troubleshooting
details stay optional, and the prompt follows terminal-font changes.

The keyboard audit reproduced two focus failures. Native Done unfocused the
input, leaving Escape outside the prompt's handler while connecting. The
dialog's fallback autofocus also took focus before its password editor, which
the native fixture and a separate widget reproduction both caught. Done now
retains focus; the prompt explicitly claims initial input after mounting.
Enter submits from the input, Tab reaches controls, Escape returns to the
original terminal, and active composition owns Enter/Escape. Shared readline
editing works in the password field and is disabled while connecting. Errors
are announced and return focus for a keyboard retry.

Connection attempts now belong to `AppNotifier`, keyed by machine and auth
revision. Reopening the prompt joins the same pending future without copying
the old prompt's password or launching another CLI request. Progress remains
visible, repeated Enter is ignored, and different machines proceed
independently. Unexpected link-process exceptions release the busy state and
offer retry. Disposed or stale-auth replies cannot update the current workspace.
The CLI remains responsible for the actual password exchange.

Verification:

- Focused linking/boot/reconnect/offline set: **41 passed**. Log:
  `/private/tmp/terminal-link-final-checks.log`.
- Full desktop suite: **2,137 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-link-suite.log`.
- Native macOS workspace fixture: **3 passed**, including retry, close/reopen
  while pending, automatic close on success, and input returning to the same
  retained terminal. All traffic is fake. Log:
  `/private/tmp/terminal-link-native-workspace.log`.
- The dialog-focus regression failed before its fix; reproduction log:
  `/private/tmp/terminal-link-dialog-focus-before.log`.
- Analyzer: no errors or warnings; the same three preexisting infos. Includes
  both native fixtures. Log: `/private/tmp/terminal-link-analyze-final.log`.
- Forty-four rendered states in `/private/tmp/terminal-link-final`. The four
  new link states (ready, pending, error, and 600×420 at 1.7× text) were
  inspected, along with the current chooser and creation prompt. Log:
  `/private/tmp/terminal-link-render-final.log`.
- The normal macOS app rebuilt successfully with `--target lib/main.dart`
  after native testing. Log: `/private/tmp/terminal-link-macos-build.log`.
- Formatting of all six touched Dart files and `git diff --check` passed.

Artifact: `build/macos/Build/Products/Debug/Harness.app`. Existing app instances
were not restarted. Physical AppKit keyboard/IME, VoiceOver, Linux runtime,
and live daemon behavior remain outside this fixture evidence. The separate
“Link another machine” setup guide and this computer's password-management
dialog still need an interaction audit. Work remains uncommitted and
unpublished; the broader product goal remains active.

## Native workspace journey and prompt editing — preceding continuation

Output Find still had a rounded, proportional-font toolbar. It now uses the
same thin terminal frame and monospace family as search and creation, with a
`/` prompt and match count. It occupies the existing header, so opening Find
does not resize or reflow terminal output. Narrow panes and larger text sizes
put match controls in a compact keyboard menu, keeping the query readable.
Enter activates a focused control; Enter/Shift-Enter step matches from the
query. The menu closes with Find or its pane, and Escape restores typing.

The shared prompt editing audit reproduced six failures before the fix:
Ctrl-H/D could split emoji or combining characters on macOS and Linux, Ctrl-W
could erase a word on the preceding task line, and Ctrl-U erased all preceding
lines. Character deletion now uses grapheme boundaries, word kill respects
whitespace/path separators, and line kill stops at the current line's start.
Ctrl-Y restores the killed text. These keys also work in output Find, with
query updates isolated from terminal input. Composition and locked prompts
remain protected.

The new native workspace fixture runs a real macOS window/titlebar around
fake sessions and a fake creation connection. Its two keyboard journeys cover:

- Staying at the current scrollback location while output streams; searching
  output and returning to the original location and terminal input.
- Opening a shared agent in a named tab, closing/reopening it, switching panes,
  moving a pane, zooming, resizing, and retaining the original terminal view.
- Editing a multiline task and inherited agent/project/mode, dismissing and
  resuming the draft through New Pane, checking the exact simulated creation
  request, and immediately finding that agent to name a new tab.

Both native fixtures now require `FLUTTER_TEST=1`. They never bootstrap the
real CLI or load real Harness state. `CLAUDE.md` documents their invocation
and the required normal-app rebuild afterward. Injected Flutter keys do not
establish physical AppKit keyboard/IME or VoiceOver behavior.

Verification:

- Focused prompt/Find/creation set: **50 passed**. Log:
  `/private/tmp/terminal-prompt-find-checks.log`.
- Full desktop suite: **2,131 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-workspace-suite.log`.
- Analyzer: no errors or warnings; the same three preexisting infos. Includes
  both native fixtures. Log: `/private/tmp/terminal-workspace-analyze-final.log`.
- Native terminal fixture: **2 passed**. A combined run then failed to launch
  its second test app before any workspace assertion ran. Log:
  `/private/tmp/terminal-workspace-native.log`.
- Running the native workspace fixture independently: **2 passed**. Log:
  `/private/tmp/terminal-workspace-native-workspace.log`. Use separate native
  invocations, as documented in `CLAUDE.md`.
- Forty rendered states in `/private/tmp/terminal-workspace-final`; the three
  new Find states at normal/enlarged text and with keyboard options open were
  inspected. These use fake terminal output, not a live PTY. Log:
  `/private/tmp/terminal-workspace-render.log`.
- Formatting of all eight touched Dart files and `git diff --check` passed.

The normal macOS debug app rebuilt successfully with `--target lib/main.dart`
after the native fixtures. Artifact: `build/macos/Build/Products/Debug/Harness.app`.
Build log: `/private/tmp/terminal-workspace-macos-build.log`. Existing app
instances were not restarted. Work remains uncommitted and unpublished. The
broader product audit remains active.

## Clipboard ownership and Linux shell input — preceding continuation

The terminal audit reproduced three input failures: Linux Ctrl-A/Ctrl-V were
intercepted for selection/paste, a delayed clipboard read could paste into a
replacement agent, and an empty shell paste emitted Ctrl-V (quoted-insert).
A follow-up reproduction showed Linux Alt word-motion keys emitted no input.

- Linux clipboard keys are Ctrl-Shift-C/V/A. Ctrl-A/B/C/D/R/V/Z reach the
  program unchanged. The shortcut guide now names Linux's actual copy/paste/
  select-all chords. Other existing platform clipboard shortcuts are unchanged.
- Linux sessions use xterm's Linux input target. Left-Alt printable keys send
  an escape prefix with the actual character, preserving case, punctuation,
  and numeric arguments. The fallback letter handler now respects Shift.
  macOS Option and Linux AltGr remain native text composition.
- Paste captures its target session and stream before reading the clipboard.
  It revalidates ownership after text and image reads, cancelling if the pane
  changes agents, reconnects, closes, or becomes read only. A pending paste
  cannot follow a reused pane to a different agent.
- Empty clipboard content sends no quoted-insert to a shell. Clipboard read
  errors show a local retry message without freezing the stream. Paste clears
  the old selection. Read-only output can still be copied, older daemons retain
  bracketed paste, and Linux's paste chord reaches remote image upload.
- The vendored xterm patch is documented in
  `third_party/xterm/README.autonomous.md`. Protocol behavior remains covered
  by the existing session tests; the new UI tests record actual outgoing input,
  paste, and image-upload frames using fake sessions and an in-memory clipboard.

Verification:

- Focused input/clipboard/IME/shortcut set: **60 passed**. Log:
  `/private/tmp/terminal-input-final-checks.log`.
- Full desktop suite: **2,122 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-input-suite.log`.
- Analyzer: no errors or warnings; the same three preexisting infos. Includes
  the native terminal fixture. Log: `/private/tmp/terminal-input-analyze-final.log`.
- Native macOS fixture: **2 passed**. Log:
  `/private/tmp/terminal-input-native.log`. It exercised streamed keyframe
  replacement, alternate-buffer scroll routing, Unicode input injection, and
  switching across eleven agents while retaining exactly one terminal view.
  It ran in its own process with `FLUTTER_TEST=1`, fake terminal senders, no
  AppNotifier bootstrap, and no real agent traffic. The SDK desktop runner was
  inspected: it tracks and stops only processes it launches. Existing app
  sessions were not restarted.
- This native fixture does not establish physical AppKit keyboard/IME behavior,
  VoiceOver behavior, a complete workspace walkthrough, or Linux runtime parity.
  Those remain outstanding. Earlier `cgWindowNotFound` capture failures still
  apply to the attempted walkthrough of the existing app window.

The normal macOS debug app was rebuilt successfully with `--target lib/main.dart`
after the native fixture. Artifact: `build/macos/Build/Products/Debug/Harness.app`.
Build log: `/private/tmp/terminal-input-macos-build.log`. The final clipboard
checks passed all 14 tests after analyzer cleanup
(`/private/tmp/terminal-input-final-clipboard.log`); formatting of all seven
touched Dart files and `git diff --check` passed. Work remains uncommitted and
unpublished.

The broad product goal remains active; terminal selection/scrollback and the
other product areas still need the end-to-end review tracked in the audit.

## Workspace arrangement and compact pane headers — preceding continuation

Directional pane moves previously removed and reinserted a pane, shifting
unrelated neighbors and bypassing pinned-slot updates. They now use the same
swap operation as direct reordering, keep pins with their panes, and request
visibility for the moved terminal. Shift-Cmd-arrows stop at the layout edge;
the existing wrap behavior for directional focus is unchanged.

- The Flutter tab strip now reveals the selected tab after keyboard selection,
  closing, reordering, and window resizing. Background updates preserve a
  deliberately scrolled strip. The native strip already had reveal behavior.
- Keyboard resize uses a compact monospace guide. Arrow keys resize, Shift
  takes larger steps, Tab changes divider, and Escape returns to terminal input.
- Narrow pane headers prioritize a monospace agent name and machine identity.
  Extra project/branch detail remains in the tooltip. Model selection has a
  compact trigger; other actions move into an arrow/Enter/Escape menu. Wider
  headers retain their direct controls. Hover does not shift the title.
- Reconnect/take-control remains directly accessible at narrow widths.
  Enlarged text no longer lets the action row reduce the title to zero width.
  Header typography follows changes to the terminal font preference.
- The model menu now uses the thin terminal prompt frame, clamps to the actual
  window bounds, and scrolls when necessary. It owns focus, supports arrows and
  Enter, restores focus after Escape/selection, and dismisses on native chrome
  actions. Its Open Grid action is keyboard focusable. Outside clicks continue
  to reach the control beneath the menu.

Focused verification: **50 passed** for headers, model menus, arrangement, and
resize; **71 passed** for viewer and terminal-session regressions. Logs:
`/private/tmp/terminal-arrange-final-checks.log` and
`/private/tmp/terminal-arrange-regression-checks.log`.

The first full suite exposed a viewer assertion that expected the now-collapsed
icons, plus a resync timeout test that raced a 45 ms wall-clock delay. The viewer
check now opens the real compact menu. The resync test uses the widget test's
controlled clock and retains its exact three-retry/one-reopen/failure assertions;
no production timeout changed.

Render verification: 37 states in `/private/tmp/terminal-arrange-final`, including
four-pane resize, many tabs, compact actions, and model menus at 600 px / 1.7×
text. The new states were inspected. The fixture exercises workspace chrome
with fake sessions and matching agent metadata; no real PTY or agent is started.
Log: `/private/tmp/terminal-arrange-render.log`.

Final verification:

- Full desktop suite: **2,108 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-arrange-suite-final.log`.
- Analyzer: no errors or warnings; the same three preexisting infos. Log:
  `/private/tmp/terminal-arrange-analyze-final.log`.
- macOS debug build succeeded with Swift Package Manager. Artifact:
  `build/macos/Build/Products/Debug/Harness.app`. Log:
  `/private/tmp/terminal-arrange-macos-build-final.log`.
- Formatting (13 touched Dart files) and `git diff --check` passed. Existing
  app instances were not restarted; native runtime and VoiceOver checks remain
  outstanding. No changes were committed or published.

The broad product goal remains active. Native runtime, terminal correctness,
and remaining product areas are still tracked in the product audit.

## Draft ownership and visible recovery keys — preceding continuation

The canceled compact prompt previously saved only a global task string. A
reproduction showed that reopening from another project put that task in the
wrong context, and canceling after an advanced-form round trip lost the chosen
Codex profile. It also reset the edited machine, project, and permissions.

- Drafts now retain the complete setup in memory for their source machine,
  agent, and project. Separate agents working in the same project have separate
  buffers, as do machines with identical folder paths. The buffers last for the
  current window. They are not persisted across app restarts.
- An empty chooser or Cmd-N resumes that source's draft. Explicit search text
  starts a fresh task with inherited defaults. Clearing the task removes it;
  successful creation consumes only that source's draft. Advanced options keeps
  the original source context through edits and returns.
- An unsubmitted draft honors the newly chosen New Tab/New Pane destination.
  A dismissed unresolved creation retains its original receipt, even with no
  task. Resuming sends `agent_create_status` with that same creation ID and
  completes at the original destination. It does not launch another agent.
- Errors previously replaced all key hints. They now retain the available keys
  underneath. A pending prompt says `pending agent` and exposes check status
  and close; editing and advanced-options hints are omitted. Busy requests show
  progress. All message text uses the shared monospace styling.
- The dismissed receipt carries its warning acknowledgement so an existing
  “Escape again” message still means what it says after reopening.

Focused tests: **60 passed** including the render fixture, and **30 recovery
checks passed** after preserving the warning acknowledgement. Exact outgoing
requests cover clone URLs, profiles, permissions, first task, placement, and
receipt identity. Logs: `/private/tmp/terminal-context-final-checks.log` and
`/private/tmp/terminal-context-recovery-checks.log`.

Render verification: 31 states in `/private/tmp/terminal-context-final`, adding
pending creation and reopened pending creation at 600 px / 1.7× text. Both new
states were inspected. The fixture simulates a timeout through its overridden
connection; no real agent creation or daemon traffic is involved.

Final verification:

- Full desktop suite: **2,102 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-context-suite.log`.
- Analyzer: no errors or warnings; the same three preexisting infos. Log:
  `/private/tmp/terminal-context-analyze-final.log`.
- macOS debug build succeeded with Swift Package Manager. Artifact:
  `build/macos/Build/Products/Debug/Harness.app`. Log:
  `/private/tmp/terminal-context-macos-build.log`.
- Formatting and `git diff --check` passed. Existing app instances were not
  restarted; native runtime and VoiceOver verification remain outstanding.

The broad product goal remains active. This completes the scoped draft audit;
the remaining product areas are listed below and in the product audit.

## Mixed catalogs and workspace navigation — preceding continuation

Compact search now names the agent and machine before the project and branch.
Removing provider logos had left otherwise identical Codex and Claude tasks
indistinguishable without a preview. The plain-text identity also uses discovered
agent names such as Robot Studio. Existing domain metadata remains searchable.

- Wide results stay on one line. Narrow results, enlarged text, and the list
  beside a preview put identity on a second line. Row height follows the actual
  text size, and the selected row stays visible when preview or geometry changes.
- Commands and shortcut help now say Next Tab, Previous Tab, and Select tabs.
  History says Reopen Closed Tab or Pane in both the palette and native menu.
  Existing IDs and bindings are unchanged.
- A complete keyboard journey verifies finding a specific agent among duplicate
  task names, opening a shared tab, closing and reopening it, tab and pane
  switching, zoom, and closing/reopening a pane. The same running sessions survive
  every transition, and picker keys do not reach terminal input.

Verification:

- Full desktop suite: **2,098 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-catalog-suite.log`.
- Analyzer: no errors or warnings; the same three existing infos. Log:
  `/private/tmp/terminal-catalog-analyze.log`.
- Render fixture: 29 states in `/private/tmp/terminal-catalog-final`, including
  mixed local/remote/offline agents, duplicate tasks, preview, and 600 px with
  1.7× text. These states were visually inspected. Log:
  `/private/tmp/terminal-catalog-final-render.log`.
- macOS debug build succeeded. Artifact:
  `build/macos/Build/Products/Debug/Harness.app`. Log:
  `/private/tmp/terminal-catalog-macos-build.log`.

The narrow-preview test waits for the scheduled post-layout scroll before
inspecting the selected row's viewport bounds. The keyboard journey lets the
terminal's existing 50 ms resize debounce finish before teardown. No production
timer or scrolling change was required for those two test timing corrections.
Native app interaction remains unverified; existing app instances were not
restarted and no real agents were created.

## Draft recovery and picker ownership — preceding continuation

Advanced options now returns to the compact task prompt with the complete
edited draft. Escape, the back hint, and an outside click retain the task,
machine, agent, project or clone intent, permission mode, and Codex profile.
An explicit Default profile remains default even when discovery finds one
named profile. The compact prompt displays the selected profile; changing
machine or agent clears it before the next launch.

- An unresolved creation keeps its original receipt across the return. Enter
  checks that request instead of sending another create. Pending input is
  read-only, including the custom readline editing keys. Busy requests still
  prevent dismissal.
- A dialog pop could complete before the screen's cached route flag updated,
  suppressing the returning prompt. The open guard now reads the live route.
- The advanced agent picker previously let Cmd-Enter reach the parent form
  and launch its old selection. It now accepts the highlighted agent; an
  unbound modified Enter cannot submit the parent form. IME composition does
  not choose an agent, dismiss the picker, or launch a request.
- The form now receives the workspace's live keymap. Picker remappings,
  unbindings, aliases, and visible hints remain effective after opening the
  separate dialog route, including config changes while it is open.
- The agent picker measures its anchor and available space during layout,
  replacing the snapshot taken when it opened. Resizing or changing text size
  keeps the panel, input, preview, and key guide inside the window. The result
  list gives up space before the input or key guide does.

Focused verification: **48 tests passed**, including exact creation payloads,
receipt recovery, profile round trips, real workspace key dispatch, IME,
remapped keys, and narrow/short/enlarged-text layouts. Log:
`/private/tmp/advanced-agent-final-checks.log`.

Render verification: 25 isolated macOS fixture states passed and were written
to `/private/tmp/terminal-draft-preview`; the returned draft, enlarged draft,
and resized agent searches were inspected. The fixtures reject real agent
creation. Native app interaction remains unverified for the reason below.

Final verification:

- Full desktop suite: **2,094 passed, 5 skipped, no failures**. Log:
  `/private/tmp/terminal-draft-suite.log`.
- Analysis of `lib` and `test`: no errors or warnings; the same three
  preexisting informational lints. Log:
  `/private/tmp/terminal-draft-analyze-final.log`.
- Formatting and `git diff --check` passed.
- macOS debug build succeeded with Swift Package Manager. Artifact:
  `build/macos/Build/Products/Debug/Harness.app`. Log:
  `/private/tmp/terminal-draft-macos-build.log`. Existing native app instances
  were not restarted. No real agent was created for verification.

The broad product goal remains active. This pass completes the draft/back and
nested-picker audit; the remaining areas are listed below and in the product
audit.

## Creation integrity and terminal forms — preceding continuation

Advanced options now shares the compact terminal appearance: an 840 px
top-anchored thin frame, monospace text, full-width machine/project choice rows,
small controls, and a visible keyboard guide. The backdrop stays clear. The
agent selector uses a `>` prompt and Ctrl-/ preview toggle, preserves input
focus, and supports readline editing and Page Up/Down. Provider descriptions
and installation status remain available in the preview.

- The compact prompt's key guide wraps instead of hiding later hints offscreen.
  Creation sizes itself from the actual fields, editor, and guide. Long task
  text scrolls in its editor at the available height, keeping actions visible.
- Advanced handoff preserves named new projects, clone requests, existing
  folders, permission modes, and the first task. A successful full-form launch
  consumes the saved task. Tests inspect the resulting creation request.
- Explicit project choices survive switching to another machine and back in
  advanced options. The dialog's per-machine choice bucket includes inherited
  choices and new-project names.
- Outside-click and keyboard dismissal now share the compact prompt's pending
  creation guard; a lost receipt cannot be bypassed by clicking outside.
- Numbered agents, projects, and folder completions use natural ordering after
  search score and recency (`1, 2, 10`). The already-resolved collection package
  is now an explicit dependency; no package version changed.
- The form's agent picker changes selection only when the pointer moves;
  rebuilding or scrolling beneath a parked pointer leaves keyboard selection
  alone.

Verification:

- Full desktop suite: **2,083 passed, 5 skipped, no failures**, recorded in
  `/private/tmp/terminal-refinement-suite-final.log`.
- Earlier in this continuation, the handoff/order changes alone passed 2,082
  tests. Focused checks exercise narrow and enlarged-text layouts, multiline
  tasks, actual creation payloads, machine round trips, and preview toggling.
- After visual review corrected the two-line agent row height, all **27 focused
  picker/form tests passed**. The responsive tests verify that both text lines
  remain inside each row's selection bounds. Log:
  `/private/tmp/terminal-final-picker-tests.log`.
- Final analysis of `lib` and `test`: no errors or warnings; the same three
  preexisting informational lints. Log:
  `/private/tmp/terminal-refinement-analyze-final.log`.
- macOS render fixtures passed and produced the final screenshots in
  `/private/tmp/terminal-final-preview`, including advanced options, agent
  search and preview, and narrow/large-text forms. The fixture uses an isolated
  connection and rejects agent creation. Inspected representative search,
  creation, advanced, and large-text states, and corrected the row-height
  issue found during that review.
- Final macOS debug build succeeded with Swift Package Manager. Artifact:
  `build/macos/Build/Products/Debug/Harness.app`. Log:
  `/private/tmp/terminal-refinement-macos-build.log`. Existing app instances
  were not restarted during this continuation.
- Native UI inspection remains unavailable: the selected app returned
  `cgWindowNotFound`, and inventory reports multiple OpenHarness entries.
  Render fixtures and keyboard tests do not claim a live native walkthrough.

The ongoing product audit is in [terminal-product-audit.md](terminal-product-audit.md).

## Terminal appearance and interaction — preceding continuation

The search and creation overlays now use the terminal font family, a thin
border, compact rows, text prompts, and an ASCII key guide. Large provider
marks, rounded cards, repeated row-action buttons, and the creation explanatory
paragraph/button were removed from these overlays. The workspace stays visible.

- New Tab/New Pane search starts with a compact list and a `>` prompt. The
  New agent row stays above matches; its detail carries any proposed first task.
  A match count is always visible.
- Ctrl-/ toggles the preview. Its text and status are also compact and monospaced.
  Once opened, its geometry stays stable while navigating, including the create
  row, so Tab traversal does not lose its place.
- Page Up/Down page results when preview is hidden, or scroll the preview when
  shown. Escape/Ctrl-C dismiss the picker; Ctrl-C still reaches the terminal
  after dismissal. All bindings remain scoped and remappable.
- Creation exposes labeled agent, machine, mode, and project defaults above
  `task >`. Tab edits defaults through the same prompt; Enter chooses an option
  and returns to the task. Existing path completion, drafts, receipt recovery,
  and cancellation guards remain. Defaults stack with narrow/large-text layouts.
- The command palette has a `:` prompt and an empty input instead of a second
  `>` inside the editor.
- [Design references and interaction rules](super-terminal-interaction.md)
  record the studied fzf, zsh, Vim, tmux, and Lazygit patterns.

Verification:

- Full desktop suite: **2,075 passed, 5 skipped, no failures**.
- After the final hidden-preview paging addition: **88 targeted tests passed**,
  including creation, placement, preview paging, input ownership, remapping,
  cancellation, and terminal key routing.
- Analysis of `lib` and `test`: no errors/warnings; the same three preexisting
  informational lints in app_state, grid_model_picker, and pane_grid.
- Rendered and inspected search, creation, defaults, preview, command palette,
  and large-text/narrow layouts. The render fixture uses Menlo for the terminal
  font aliases; runtime uses the user's terminal font. PNGs are in
  `/private/tmp/terminal-box-preview`.
- macOS debug build succeeded with Swift Package Manager. Artifact:
  `build/macos/Build/Products/Debug/Harness.app`. Opened a fresh review instance
  with `open -n`; existing instances were not stopped. No real agent was created
  during verification.

## New Tab / New Pane — built after the design discussion

The primary choice is now where to put the work:

- **⌘T / New Tab** opens the harness picker with a pending new-tab destination.
- **⌘P / New Pane** opens the same picker for the current tab, automatically
  tiling after an addition. From the Store or Orchestrator it offers a new tab.
- Both show a pinned **New agent** row, selected with an empty query.
  Typing selects the best existing match and carries the text into the first
  task if New Harness is chosen. Projects, machines, and tab names are searchable
  metadata; the results are individual harnesses, with no bulk group actions.
- New Tab allocates only after choosing an existing harness or receiving a
  successful creation receipt. Cancellation, failures, and pending recovery
  leave the layout alone. A recovered receipt allocates exactly once.
- A tab opened through New Tab takes the chosen or newly created agent's name.
  Adding/focusing panes preserves an existing tab name, including custom names.
- A harness can appear in multiple tabs. Within a tab it appears once:
  choosing a harness already there focuses its pane. Views share the session,
  and closing one view leaves the others intact.
- The picker and creation actions show the destination. Existing creation
  inheritance (agent, machine, project) remains, including multiple feature
  harnesses on the same project and panes from different machines.
- Native and Flutter tab strips now have New Tab and New Pane controls. The
  File menu follows the same model. Directional split edges were removed;
  directional splits and Orchestrator remain in the **⇧⌘P** command palette,
  without default directional/orchestrator bindings. **⌘N** remains a secondary
  direct-creation shortcut. Existing command IDs remain remappable.
- A pending creation cannot be replaced by another picker or the full form.
  Cancellation after transitioning from search restores terminal focus rather
  than focusing the disposed search editor. The full form receives the pending
  destination and task.

The placement intent is `lib/state/harness_placement.dart`. Regression coverage
is in `test/harness_placement_test.dart`, with existing entry, keymap, shared
session, layout, and recovery tests updated for the new behavior. Keyboard
documentation is in `../docs/keyboard.md`.

### Verification of this implementation

- Desktop suite: **2,074 passed, 5 skipped, no failures**. The old pane-control
  count assertion now includes the existing Fork button.
- Final analysis of `lib` and `test`: no errors or warnings; the same three
  existing informational lints. The final cleanup subset also passed (68 tests).
- Focused tests cover successful, failed, and recovered creation; retained
  context and task; cancellation; shortcut/focus recovery; cross-machine panes;
  shared views; duplicate selection; full tabs; and stale results.
- Rendered and inspected the New Tab and New Pane pickers, matching/no-match
  results, creation destination, permission selection, and separate command
  palette. Fixture glyph substitutions remain as recorded below.
- macOS debug build succeeded with Swift Package Manager. Final artifact:
  `build/macos/Build/Products/Debug/Harness.app`.
- Live creation against the user's running harnesses was not performed.

## Earlier continuation work

- Verified the final held-Tab fix through real key-down/repeat/up events in
  the screen's keymap dispatcher. The chosen agent is committed once;
  subsequent repeats preserve the machine and project. Existing controller
  tests also cover a current machine absent from the choices and Escape
  restoring a path-completion stem.
- Search now puts openable matches before unavailable matches, preserving
  ranking within each group and any explicitly selected row. Location-tree
  ordering and the create row's position keep their existing contracts.
- The search overlay measures its editor and hints before sizing the results
  to whole rows. This works with side-by-side and stacked previews and larger
  text. A create-only result uses exactly one row plus list padding.
- Risky permission modes use amber text in the list and selected mode label.
  Codex's choices read Read only, Ask first, Auto-approve, Full access. The
  default remains Auto-approve by ID, verified in an actual form submission.
- New-harness errors and creation status use explicit accessibility
  announcements. Updates coalesce per frame, messages take precedence over
  row announcements, and clearing an error allows it to be announced again.
- Corrected the keyboard documentation: text carried from search becomes the
  first task, not a new project name.

Relevant additions: `test/box_polish_test.dart`. The implementation changes
are in `state/swarm_search.dart`, `widgets/swarm_switcher.dart`,
`screens/swarm_screen.dart`, `state/new_harness.dart`,
`widgets/new_harness_box.dart`, `widgets/box_chrome.dart`, and
`core/permission_modes.dart`, all under `lib/`.

## Earlier verification

Using Flutter 3.47.2 / Dart 3.13.2:

- Before changes: 2,056 desktop tests passed, 5 skipped, 1 failed.
- After changes: 2,064 desktop tests passed, 5 skipped, the same 1 failed.
  The unchanged failure is `swarm_interactions_test.dart`, "pane controls
  zoom, confirm stopping and close only this view": it expects six icon
  buttons after a seventh Fork button was added on the base branch.
- Static analysis of `lib` and the changed tests: no errors or warnings;
  three existing informational lints in `app_state.dart`,
  `grid_model_picker.dart`, and `pane_grid.dart`.
- CLI: all 19 new-command/project-folder tests and TypeScript checking passed.
- All 12 rendered box states were inspected. Known render-fixture artifacts
  remain: some shortcut glyphs render as boxes and some logos load late.
- The normal macOS debug app built successfully with Swift Package Manager.
  Artifact: `build/macos/Build/Products/Debug/Harness.app`.
- Live interaction with the newly built app and native VoiceOver have not
  been verified. Accessibility tests verify emitted announcements.

## Next work

The broad product goal remains active. Next audits include pane moves and
resizing, many-tab workflows, secondary dialogs, terminal correctness,
reconnect/offline states, settings, and platform parity. Mixed-catalog identity,
the keyboard close/reopen journey, and scoped draft ownership are verified
above. Renamed/moved-project relinking still needs a design decision. Physical
AppKit keyboard/IME, VoiceOver, Linux runtime, and live daemon verification
remain outstanding; separate fake-traffic native fixtures are recorded above.

The original handoff's independent terminal-reviewer re-review has not been
run in this continuation; verification above was performed locally. Details
and unresolved findings are maintained in `terminal-product-audit.md`.

## First workspace guide and predictable harness entry — 2026-09-20

Built the approved pared-down keyboard wallpaper as native Flutter line art:
Cmd-T new tab, Cmd-P new pane, Cmd-S Harness Store, and the command dock. The
callouts invoke the actual actions and read the active keymap. A small All
keyboard shortcuts link opens the existing help sheet. The production empty
workspace uses this guide; the old full-form compatibility path is retained.

The first empty workspace automatically opens the real New Harness draft,
with an editable `~/harnesses/first-project` destination. Machine-scoped engine
detection chooses an installed agent, preferring a saved choice when available.
Discovery does not overwrite an agent or machine the person has begun editing.
No harness starts until Enter/click. A persisted marker keeps Escape dismissed;
restored tabs or discovered existing harnesses bypass automatic entry.

The creation/search vocabulary now calls the whole session a harness: New
harness, Start harness, New harness…, and Find a harness…. The inner engine field
remains agent. New Tab and New Pane still name placement.

The New harness… action is pinned outside the scrolling search matches, across
the dock width directly above the input. Typing, clearing, scrolling, and
preview changes leave it there. Typed queries still select their best match;
Down reaches creation. Preserved result state across preview changes fixes
keyboard focus being lost during Tab traversal.

Cmd-S opens Harness Store. Layout is Cmd-Shift-L, including the native menu;
Cmd-L remains focus right. Shortcut help and the guide follow remaps.

Validation: 95 focused unit/widget/render checks passed; two native macOS
journeys passed (first workspace and edited creation/placement). Static analysis
of changed production code and new fixtures is clean. Dart-to-AppKit export and
130 native keymap checks passed. The subsequent legacy titlebar harness cannot
compile: stale `openButton`, `createButton`, and `managerCaption` references in
`tool/swarm_titlebar_checks.swift`. It was not changed for this task.

The first native fixture exposed that local creation prepares its project folder
before sending agent_create. Its empty first-project test folder was removed,
and the fixture now overrides folder preparation with an in-memory path. No
real agent was created. The native fixtures' injected Flutter keys do not prove
physical AppKit/IME event delivery.

Rebuilt the normal `lib/main.dart` debug app with the existing JEV endpoint
`http://127.0.0.1:18478`, verified its code signature, and opened it. No commits or
pushes. Logs: `/private/tmp/harness-guide-{focused,native,native-keys,analyze,build}.log`.
First-run render: `/private/tmp/harness-guide-render/first-harness.png`.

## Entry polish, focus, titles, and Store — 2026-09-20 follow-up

This supersedes the earlier guide and entry behavior above. Agent settings now
live behind a small gear shown on hover/focus; permissions and Codex profiles no
longer insert rows into the agent list. New Harness stays pinned above the
search input. Labels use title case, the action reads Start, the optional task
reads Add a task (optional), and typed tasks have no `task:` prefix.

The welcome illustration is larger, with one tall pane on the left and two on
the right, using Codex, Claude Code, and Grok examples. Tab, Pane, and Store
callouts explain the concepts and are static. Only All Keyboard Shortcuts is
clickable; it shows the current Cmd-/ binding. Removed the redundant command
dock callout. Each visit to the empty workspace opens New Harness when there
are no harnesses, or search when harnesses already exist. Escape stays dismissed
for that visit. Empty first projects default to `~/harnesses/first-project`.

Installed-agent detection now has a separate status beside Agent. Start stays
labeled Start and cannot activate during detection. The visible snapshot tracks
detection completion so a stale loading label cannot conceal an enabled action.

Creation hands keyboard focus to the newly mounted terminal after closing the
dock, with guards against stealing focus after navigation. Four native macOS
fixture journeys pass, including New Tab and New Pane accepting input without
a click. The fixture needed a valid protocol UUID to record encoded input.
These injected Flutter keys do not establish physical AppKit/IME behavior.

Automatic CLI labels display as Untitled Pane, and new tabs as Untitled Tab.
Engine session titles take over until the user renames; explicit tab naming
ownership and its source harness persist across layout restore and reopening.
Placeholder labels are never sent to the CLI as explicit names.

Store Open and Try this prompt invoke the workspace dock with the chosen
harness, machine, and example task. The Store button is now a compact filled
pill with an original six-color polymath mark, shared by its tab and History.
The native button preserves keyboard focus, enabled state, and remapped shortcut
tooltip; its normal, hover, and disabled states were rendered and inspected.
Asset vector source: `tool/render_store_mark.swift`.

Validation: 56 Store/navigation/title checks pass; agent settings, welcome,
project context, command dock, and placement checks passed earlier in this
follow-up. All four native creation/onboarding fixture journeys pass. Logs:
`/private/tmp/harness-store-name-regression.log` and
`/private/tmp/harness-settings-native.log`. Button preview:
`/private/tmp/harness-store-preview/button.png`. No real harnesses were created
by these fixtures, and no commits or pushes were made.

The normal `lib/main.dart` review build was rebuilt with the existing JEV URL,
passed `codesign --verify --deep --strict`, and was opened. Analysis has no
errors or warnings; two pre-existing style infos remain in `app_state.dart`
and `pane_grid.dart`. Build log: `/private/tmp/harness-final-build.log`.

## Editable generated project defaults — 2026-09-20

This supersedes the fixed `first-project` default above. The first-workspace
draft shows a concrete name using the existing harness-and-date convention,
for example `~/harnesses/codex-2026-09-20-17-22`. The timestamp is captured when
the suggestion is made; Start uses the reviewed name even after a delay.
Project → New Project prefills and selects the proposed name for replacement.
Edited names remain explicit and survive agent changes. Machine changes keep
separate project choices, and an untouched suggestion follows its agent.

A read-only directory listing offers an unused candidate. Start reserves the
folder exclusively, so a concurrent collision advances only generated names
to seconds and then a suffix. Existing folders and their files are preserved.
Long labels retain the timestamp and suffix within the remote naming limit.
Remote confirmed collisions get a fresh receipt; uncertain replies and replies
belonging to another receipt cannot trigger another start. User-chosen names
are never silently renumbered. A known name conflict leaves the form editable.
The action remains Start and its pending label is Starting harness….

Validation: 103 focused unit/widget tests pass (one optional render skipped),
plus four native macOS creation/onboarding journeys and the separate first-run
render. Inspected `/private/tmp/harness-generated-project-render/first-harness.png`.
Analysis has no errors or warnings and one pre-existing informational lint in
`app_state.dart`. `git diff --check` and strict bundle signature verification
pass. Normal `lib/main.dart` was rebuilt with the existing JEV endpoint and
opened. Logs: `/private/tmp/harness-generated-project-{test,native,analyze,render,build}.log`.
These fixtures do not create live agents. No commits or pushes were made.

Live computer-use inspection was attempted again, but the native tool returned
`Sky Computer Use native pipe startup failed`. Native fixtures use injected
Flutter events; physical keyboard/IME and live daemon behavior remain separate
from the evidence above. The broader product audit goal remains active.

## Consistent creation entry points — 2026-09-20

Fixed Store product switches restoring the previous product's draft. Draft
ownership now includes the entry source and explicit product, in addition to
machine, source harness, and project context. An already-open dock processes a
new product request instead of just focusing its old Start row. Store Open/Try
do not inherit a workspace search task, project, or split. Explicit product and
machine choices win over incompatible saved defaults; user edits remain in
their own compatible drafts. Uncertain starts retain their exact receipt and
cannot be silently replaced by another task.

Cmd-T and Cmd-P retain their common focused-pane defaults and draft recovery;
the current shortcut decides placement. Found and removed a separate legacy
popup route in the native Models menu. It now shares the product entry helper
with Store and pane-menu requests, including the native keyboard handoff.
The current rules and coverage matrix are in `new-harness-entry-rules.md`.

Validation: **2,398 unit/widget tests passed; 6 optional tests skipped. All 7
native macOS creation journeys passed**, including immediate input after
Cmd-T/Cmd-P and Store Open/Try/Models starts. Focused product-route checks also
passed (66). Updated stale test expectations for the already-approved Start
wording, layout shortcut, pinned creation row, and Store discovery action.
Full analysis has no errors or warnings (18 existing informational lints,
mostly vendored xterm); targeted analysis reports one existing style info.
`git diff --check` passes. Rebuilt normal `lib/main.dart` with the existing JEV
endpoint, verified the bundle signature, and opened it for review.

Logs: `/private/tmp/harness-entry-full-final.log`,
`/private/tmp/harness-entry-native-final.log`,
`/private/tmp/harness-entry-analyze-final.log`, and
`/private/tmp/harness-entry-build.log`. Fixtures use fake transport; no live
harnesses were started. No commits or pushes were made. Live computer-use
inspection remains unavailable as noted above; this is automated fixture
coverage, not a claim of physical keyboard/IME validation.

## Startup and keyboard entry — 2026-09-20

Removed redundant chmod subprocesses from persisted settings reads. Each
operation still stats the current path and repairs permissions when needed;
there is no cached permission assumption. Tests cover external changes to the
directory and lock, a second store instance, and replacement of the directory
at the same path. Locking, fresh reads, atomic writes, and private file modes
remain covered by the persistence suite.

The existing startup benchmark uses fresh store objects, temporary files,
20 warmups, and 100 measured samples per operation in the headless debug
runner. Settings initialization median/p95 changed from 21.656/41.626 ms to
4.205/7.378 ms. Settings plus keymap changed from 22.604/25.238 ms to
6.052/9.858 ms. These are warm-filesystem initialization measurements, not
cold-launch, first-frame, or native input latency results. Raw logs:
`/private/tmp/harness-startup-baseline.log` and
`/private/tmp/harness-startup-optimized.log`.

Settings now focuses Search settings immediately. Enter selects the first
matching section, Down reaches its row, and Escape returns to the workspace.
Filtering preserves the current section until selection; empty/unmatched
queries do not switch sections. Composition retains its keys. A native
journey verifies Cmd-comma → search → Enter → Escape → terminal input with
no mouse click or leaked input. Pending sign-in now accepts Escape to cancel
and restores Sign in focus for Enter to retry. Late completion of a cancelled
attempt cannot sign in or disturb a new attempt.

Validation: **2,406 unit/widget tests passed, 6 optional tests skipped; all 18
native workspace journeys passed**. The focused settings/sign-in suite has
16 passing checks; the earlier startup, persistence and sign-in suite has 64.
Full analysis has no errors or warnings and the same 18 informational lints.
Formatting is unchanged across the nine touched Dart files. Logs:
`/private/tmp/harness-startup-settings-full.log`,
`/private/tmp/harness-startup-settings-native-full.log`,
`/private/tmp/harness-settings-signin-final-test.log`, and
`/private/tmp/harness-startup-settings-analyze.log`.

Live computer-use inventory was retried and again failed with
`Sky Computer Use native pipe startup failed`; no live UI inspection is
claimed. Native tests use simulated sessions and injected Flutter keys. No
real harnesses, sign-ins, or user settings were changed by the tests.

Rebuilt the normal application from explicit `lib/main.dart` with the existing
JEV endpoint after the native fixtures. The build and strict deep signature
verification pass; `git diff --check` is clean. Build log:
`/private/tmp/harness-startup-settings-build.log`. No commit or push was made.

## Keyboard help at enlarged text and reliable config reload — 2026-09-20

Reviewed all five production Settings sections at the minimum 880×560 window,
in light and dark themes at 1× and 1.8× text. The render fixture navigates via
the Settings search and Enter, uses synthetic account data, and never invokes
a mutating settings action. It also renders the keyboard-shortcuts sheet in
each theme/scale. All 24 final images were inspected in
`/private/tmp/harness-settings-review/`; the fixture passes 20 checks.

Found and fixed clipped keycaps and a truncated shortcut-context selector at
large text. Keycaps now have a minimum height and grow to fit glyphs or wrapped
multi-stroke bindings; Tab and Return symbols scale too. The deck reduces its
column count as text grows, and the context selector gives its label enough
width. Three new layout tests failed before the changes and pass afterward.
The real-font context-width check also reproduced the truncation before its
fix. Settings keyboard coverage now includes Tab into the content, Page Down/
Page Up, changing shortcut context, Escape closing only its open menu, and
then Escape returning to the terminal. Both native Settings and keyboard-
practice journeys pass with fake traffic and injected Flutter keys.

The full regression run exposed an intermittent dotfile-symlink reload failure.
An isolated ordinary run passed, but a controlled filesystem-resolution delay
reproduced a missed save after switching targets: the new map was published
before the new target's watch was installed. `KeymapStore.reload` now establishes
the watches before reading and publishing the map. The delayed test observes
the real filesystem replacement event and passes with this ordering; it does
not hide the issue with a longer timeout. The focused watcher, remapping, and
Settings suite passes 38 checks. The generated keyboard-config template now
correctly describes moving New Tab from Cmd-T and lists the project context.
Existing user configuration files are preserved.

Logs: `/private/tmp/harness-shortcuts-scale-before.log`,
`/private/tmp/harness-settings-context-before.log`,
`/private/tmp/harness-keymap-watch-before.log`,
`/private/tmp/harness-settings-help-watch.log`,
`/private/tmp/harness-settings-help-review.log`, and
`/private/tmp/harness-settings-help-native.log`.

Further Settings review remains: the Usage range selector still abbreviates
its current range at enlarged text, and the About card could use more room
for its action descriptions. This pass checks the visible initial states and
keyboard navigation; provider data, pairing, account changes, and update flows
still require their own full interaction audit. Live computer-use remains
unavailable as recorded above.

Final validation for this pass: **2,431 unit/widget tests passed; 6 optional
tests skipped**. Full analysis has no errors or warnings and the same 18
informational lints. The normal `lib/main.dart` macOS build completed after the
native fixtures and passes strict deep signature verification. Formatting and
`git diff --check` pass. Logs:
`/private/tmp/harness-settings-help-full-final.log`,
`/private/tmp/harness-settings-help-analyze-final.log`, and
`/private/tmp/harness-settings-help-build.log`. No commit, push, real account
change, device pairing, or production configuration edit was performed.

## Honest update results and readable Usage/About — 2026-09-20

The existing Cmd-T/Cmd-P and Store ownership rules remain the creation
contract in `new-harness-entry-rules.md`. Rechecked the native first workspace,
new tab, new pane, Store Open, Store Try, Models, and edited-default placement
journeys: all seven pass, including immediate terminal input after creation.
They use simulated sessions and do not launch real harnesses.

Usage's current range was truncated at 1.8× text in both themes. The real-font
regression failed before the change. Overview and provider headers now share
a range field that grows with text, and controls move below their captions
when needed. Keyboard selection, Escape, and return focus are tested in both
views. The local-only Usage subtitle is shorter. About explanations and actions
stack at enlarged text; its version/status line wraps instead of overflowing.

The update audit found failures that were being presented as "up to date" and
a concurrent manual check that returned an early, stale answer. Three new
regressions reproduced these before the fix. Results now distinguish current,
available, disabled, and failed checks, including absent/malformed platform
metadata. Manual and background callers share a request. About and the native
menu share one result dialog; a failed result offers Retry in place. About
does not claim the build is current before a successful check. Development,
disabled, and viewer builds do not contact the desktop update service.

Two further failing regressions showed that Update/Skip could act on a newly
arrived offer instead of the version displayed. Both actions now take the
reviewed version explicitly. Failed installs retain that version for retry;
skipping an older displayed version leaves a newer offer visible. A recheck
failure preserves a known offer and its installation error. Valid current
metadata clears a withdrawn offer. Escape dismisses results and pending
checks, while an installation stays open. Late replies after dismissal or
notifier disposal are covered. Already-skipped versions show Close and Update,
without the redundant Not now action.

Background polling now matches the six-hour cadence described in About,
does not overlap a slow request, and cannot publish after its timer is
cancelled. Download hashing, staging, and platform artifact selection still
pass their existing tests. All update tests use intercepted manifests, temporary
fixture archives, or a fake installer; no real desktop update was performed.

The render fixture captures 52 states at 880×560, in light/dark and 1×/1.8×
text. All 36 Usage/About/update images were inspected in
`/private/tmp/harness-settings-update-review/`. Dialog action fonts use the app
font explicitly; labels, facts, and controls remain readable at enlarged text.
The expanded native Settings journey verifies keyboard navigation into About,
the disabled-build result, Escape returning to the button, then Settings
closing and terminal input returning without a click. That journey passes,
bringing the native reruns in this pass to eight.

Final regression: **2,450 unit/widget tests passed; 6 optional tests skipped**.
Full analysis has no errors or warnings and the same 18 informational lints.
Formatting passes for all 15 touched Dart files. Evidence:
`/private/tmp/harness-settings-update-full-final.log`,
`/private/tmp/harness-settings-update-analyze-final.log`,
`/private/tmp/harness-settings-update-native.log`, and
`/private/tmp/harness-settings-update-native-launch.log`.

Live computer-use remains unavailable with the previously recorded native-pipe
startup failure. Native fixtures inject Flutter keys and fake transport;
physical keyboard/IME, Linux, real device/account changes, and the broader
product/performance audit remain unfinished. No commit or push was made.

Rebuilt the normal `lib/main.dart` macOS application after the native fixtures,
preserving `JEV_COMMAND_BAR_URL=http://127.0.0.1:18478`. The build and strict deep
signature verification pass; `git diff --check` is clean. Build log:
`/private/tmp/harness-settings-update-build.log`. The rebuilt app was not opened.

## Cmd-T/Cmd-P preserve the open picker — 2026-09-20

Rechecked the creation entry contract after the user's request to concentrate
on the common keyboard paths. The initial 62 focused tests passed, including
Workshop → Blender Open/Try, machine changes, generated versus edited names,
source-pane draft ownership, uncertainty, and destination recovery. A further
keyboard audit found a separate data-loss interaction: pressing Cmd-T or Cmd-P
while search was open closed and recreated it, clearing its query. All four
repeat/switch combinations failed before the fix:
`/private/tmp/harness-picker-retarget-before.log`.

The picker now changes destination in place. Repeating a shortcut refocuses
its existing input; switching shortcuts preserves the query, text selection,
highlighted harness, and project/machine scope. Header and Enter action update
together. Capacity and existing-pane membership are refreshed for the chosen
destination. Store/orchestration tabs continue to send terminal work to a new
tab. Pending creation receipts still prevent a shortcut from replacing an
unresolved start.

Seven additional widget journeys cover the four repeat/switch combinations,
both directions with a highlighted existing harness, and project filtering
with Escape back to the parent. The full-tab model regression now switches the
same picker between destinations and verifies capacity and Focus pane versus
Open in new tab. The native New Tab/New Pane journeys type a task, switch and
repeat shortcuts, start it, then send terminal input without a mouse click.

Validation: **2,457 unit/widget tests passed, 6 optional tests skipped**. All
**seven native creation journeys passed**: first workspace, New Tab, New Pane,
Store Open, Store Try, Models, and edited-default placement. Full analysis has
no errors or warnings and the same 18 existing informational lints. Formatting
and `git diff --check` pass. The normal `lib/main.dart` macOS build was restored
after the fixture, retaining the command-bar URL above, and passes strict deep
signature verification. No real harness was started; the native fixture uses
fake transport and injected Flutter keys, and does not establish physical
AppKit/IME or live-daemon behavior. The rebuilt normal app was not opened.

Evidence:
- `/private/tmp/harness-entry-recheck.log`
- `/private/tmp/harness-picker-retarget-focused.log`
- `/private/tmp/harness-picker-retarget-full.log`
- `/private/tmp/harness-picker-retarget-native.log`
- `/private/tmp/harness-picker-retarget-analyze-final.log`
- `/private/tmp/harness-picker-retarget-build.log`

The broader overnight goal remains active. The next independent audit is
Usage's delayed load/scan/toggle/disposal behavior. Code inspection found
missing generation guards in `UsageLedgerStore` and post-disposal checks in
`UsageLedgerController`; controlled timing regressions and any fixes remain to
be implemented. Native performance benchmarking still requires isolation from
the three development previews last observed (PIDs 21874, 32129, 64557); none
were stopped. Live computer-use remains unavailable as previously recorded.

## Usage lifecycle, loading states, and repeated aggregation — 2026-09-20

Controlled delayed reads and writes reproduced 12 failures in the old Usage
store/controller lifecycle. A late scan could restore figures and a snapshot
after Off; delayed preferences or cache reads could overwrite an explicit
choice; reopening could race pending persistence; and disposing during load
could still notify or start a scan. Failed reads also retained stale figures
or joined a failed request when Retry should have started a new one.

The stores now guard results with a choice revision, share concurrent loading
and scanning, and serialize provider persistence across reopened stores.
Switching Off clears memory immediately and queues snapshot deletion after
earlier writes. Failed/unavailable scans clear figures, timestamps, and cached
sources. An Off/On waits for the old physical read and discards its result
before rescanning; the scanner API cannot cancel a read already in progress.
Disposal prevents later state changes, notifications, or new scanning.

Usage distinguishes reading preferences, an initial scan, a rescan with
previous figures, failure, and Off. Initial pending/failed/disabled sources no
longer show zero tokens, cost, or sessions as if those were measured results.
Changing the date range uses in-memory data and does not rescan the disk.

Repeated overview aggregation was measured with 60,000 synthetic turns in
warm debug CPU work: median 30,716 μs and p95 88,298 μs before the change.
Caching each range and its cutoff date gives a median below the timer's 1 μs
resolution and p95 1 μs afterward. Provider changes and midnight invalidate
the relevant results. This only measures repeated overview lookups, not cold
parsing, first aggregation, app launch, or native input/frame latency.

Enlarged-text renders exposed a daily-chart overflow and shorter bars floating
above the baseline. Chart height/width now use measured label sizes; small
bars align at the bottom. A dedicated geometry regression checks 1:2 bar
heights, the shared baseline, and readable labels at 2.5× text.

Validation:

- **2,480 unit/widget tests passed; 7 optional tests skipped.** The added
  benchmark is opt-in. After the final zero-session-count refinement, all
  **80 focused Usage tests passed** again.
- Added **18 lifecycle tests and five UI/chart tests**. The four UI workflows
  cover both themes at 1.0×/1.8× text and 880×560, with real font metrics and
  icon fonts. All 24 captured loading/failure/rescan/Off states were inspected.
- Eight native journeys passed together: Settings/About, first workspace,
  Cmd-T, Cmd-P, Store Open, Store Try, Models, and edited-default placement.
  The new native Usage journey initially sent keys before its menu's first
  frame. After making that fixture wait for the rendered menu, it passed
  separately, including keyboard range selection, Retry, and Off during scan.
- Static analysis has no errors or warnings and the same 18 informational
  lints. Formatting and `git diff --check` pass.
- Rebuilt the normal `lib/main.dart` macOS app after native fixtures with
  `JEV_COMMAND_BAR_URL=http://127.0.0.1:18478`; strict deep signature verification
  passes. The rebuilt normal app was not opened.

Evidence:

- `/private/tmp/harness-usage-lifecycle-before.log`
- `/private/tmp/harness-usage-full.log`
- `/private/tmp/harness-usage-final-focused.log`
- `/private/tmp/harness-usage-native.log`
- `/private/tmp/harness-usage-native-retry.log`
- `/private/tmp/harness-usage-performance-before.log`
- `/private/tmp/harness-usage-performance-after.log`
- `/private/tmp/harness-usage-lifecycle-review/`
- `/private/tmp/harness-usage-analyze-final.log`
- `/private/tmp/harness-usage-build.log`

All Usage data in tests is synthetic; no real transcript was read or harness
started. Native fixtures use fake transport and injected Flutter keys. Live
computer-use and isolated native performance measurement remain limited as
previously recorded. No commit or push was made. The broader goal remains
active: next inspect scanner cache validity while OpenCode writes to SQLite
WAL, unreadable-database states, and cold parsing/aggregation performance.
These are inspection targets, not verified bugs or completed work.

## OpenCode live reads, incomplete data, and scan responsiveness — 2026-09-20

The next audit used temporary SQLite databases exclusively. Six initial
regressions failed: a committed update in WAL was missed when the main file's
mtime/size stayed unchanged; locked and corrupt databases were called missing;
an unsupported schema returned a successful empty scan; a broken sibling was
silently omitted from totals; and sessions with only cache-write tokens were
excluded by the query.

OpenCode now queries SQLite's committed snapshot for each requested scan,
without using the main file's metadata as proof that its contents are unchanged.
The aggregate query runs in a worker isolate. The store's five-minute cache
still avoids rescanning on every visit. Tests hold a writer open, update its
WAL, check an uncommitted transaction is excluded, then checkpoint/truncate and
update again. They also cover locks and recovery, corruption, absent versus
misconfigured directories, unsupported schemas, duplicate session ownership,
cache-write-only usage, and a genuinely empty supported database.

An unreadable source is a read failure, distinct from a missing installation.
When other databases are readable, their figures remain visible with an
Incomplete badge and explanation. Overview totals carry the same warning.
The warning stays during Retry, and disappears only after a complete read.
Partial results clear the old disk snapshot rather than being restored later
as a complete fresh result. Empty incomplete scans do not claim zero sessions
or zero tokens; successful empty scans still can.

A report-only benchmark uses 30,000 synthetic sessions and a 1 ms periodic
timer on the caller isolate. Across five measured scans after one warmup, the
median maximum event-loop gap fell **44,440 → 5,828 μs**. Median total scan time
was **44,320 → 60,631 μs**. The tradeoff is responsiveness while waiting for
the worker, not higher query throughput. This is debug scheduling evidence on
a shared development machine, not a native frame/input measurement or the
cost of subsequent aggregation/rendering.

Validation:

- **2,493 desktop unit/widget tests passed; 8 optional tests skipped.** Nine
  scanner, two lifecycle, and two UI regressions were added; the four existing
  theme/text-scale journeys now exercise partial data and retry too. The added
  scheduling benchmark is opt-in.
- Three native macOS journeys pass: delayed Usage retry/range/Off, real SQLite
  worker reads and recovery through the Refresh button, and Settings/About
  keyboard ownership with return to the terminal. The real-database journey
  only touches its temporary fixture. It never reads production transcripts.
- Thirty-two Usage states were captured in both themes at 1.0×/1.8× text;
  the 12 new or changed partial-data/rescan images were inspected. The unchanged
  loading/Off states were inspected in the preceding pass.
- Static analysis has no errors or warnings and the same 18 existing info
  findings. Formatting and `git diff --check` pass.
- The normal macOS `lib/main.dart` app was rebuilt after native testing with
  `JEV_COMMAND_BAR_URL=http://127.0.0.1:18478` and passes strict deep signature
  verification. It was not opened. No commit or push was made.

Evidence:

- `/private/tmp/harness-scanners-before.log`
- `/private/tmp/harness-scanners-first-fix.log`
- `/private/tmp/harness-scanners-partial-ui-final.log`
- `/private/tmp/harness-scanners-performance-before.log`
- `/private/tmp/harness-scanners-performance-after.log`
- `/private/tmp/harness-scanners-full.log`
- `/private/tmp/harness-scanners-native.log`
- `/private/tmp/harness-scanners-analyze-final.log`
- `/private/tmp/harness-scanners-build.log`
- `/private/tmp/harness-usage-partial-review/`

The broader goal remains active. Live computer-use and isolated native timing
have the limitations already recorded. The next useful work is controlled
JSONL file-read failures and cold parsing/first-aggregation profiling; current
Claude/Codex parsers still run on the caller isolate and swallow filesystem
read failures as empty entries. Those observations need concrete reproductions
before choosing changes. Device/account changes and the remaining product
audit are also still outstanding.

## JSONL failure recovery, live writes, and first aggregation — 2026-09-20

Temporary Claude/Codex transcripts reproduced ten failures: denied file reads
were silently cached as empty successful files (and stayed empty after access
returned), unreadable roots were called missing, a broken sibling could hide
valid data, and a file caught halfway through a Unicode character failed the
whole refresh. These are now handled by a shared file lifecycle while each
provider keeps its existing parsing and deduplication rules.

The shared reader distinguishes missing roots from listing/read failures,
retains readable sources with an incomplete-data warning, and never caches a
failed source as empty. Snapshot format 3 invalidates version 2 caches that may
contain that mistake. A migration regression uses a fresh old snapshot and
verifies the next refresh really scans, rather than accepting its cached zero.

Reads stop at the captured file size. A streaming transformer holds only the
last four bytes, omitting a valid unfinished UTF-8 suffix while still sending
all earlier bytes through the strict UTF-8 decoder and normal line splitter.
Earlier complete usage records survive concurrent writes; a subsequent refresh
picks up the finished record. Corrupt completed text remains a failed source.
Tests cover every byte cut through two-, three-, and four-byte characters,
CRLF, a valid last line without a newline, malformed and out-of-range suffixes,
both transcript roots, appended/deleted files, and permission restoration.
Permission-denial cases skip only on Windows or a host that can bypass their
temporary file permissions; they all ran on this macOS host.

The timing fixture uses 20,000 synthetic usage turns and a 2 MiB tool result.
It found the larger aggregation pause in repeated Claude model-name matching.
A bounded cache (128 names per provider, maximum 512-character keys) now
retains normalization results, including unknown names. Token-dependent tier
arithmetic still runs separately for each entry; neither rates nor model-name
matching rules changed. Cold file reads retain the standard chunked decoder.

Final debug medians, five measured runs after one warmup:

| Work | Before | After |
| --- | ---: | ---: |
| Claude cold scan | 137.717 ms | 129.314 ms |
| Codex cold scan | 86.577 ms | 90.045 ms |
| Claude cached scan | 0.567 ms | 0.665 ms |
| Codex cached scan | 0.600 ms | 0.794 ms |
| Claude aggregation | 21.288 ms | 4.671 ms |
| Codex aggregation | 2.128 ms | 2.076 ms |

The corresponding median maximum caller event-loop gap during Claude
aggregation was 21.383 → 4.732 ms. Cold-scan gaps stayed around 5–6 ms. These
are shared-machine debug observations, not a native-frame or full-app input
latency claim. The final comparison is `performance-before` versus
`performance-final`; an intermediate per-line decoder was discarded after
timing showed unnecessary overhead.

Validation:

- **2,513 desktop unit/widget tests passed; 10 optional tests skipped.**
  Added 18 transcript/Unicode regressions, one old-cache migration regression,
  one per-turn pricing regression, and two opt-in benchmark cases.
- Five native macOS journeys pass: delayed Usage retry/range/Off, live SQLite
  reads, live Claude transcripts, live Codex transcripts, and Settings/About
  keyboard ownership with terminal focus restored. Both JSONL journeys use
  real temporary files and the actual Refresh control to recover from an
  interrupted Unicode write and a corrupt sibling.
- Static analysis has no errors or warnings and the same 18 existing info
  findings. Formatting and `git diff --check` pass.
- Rebuilt normal `lib/main.dart` after the native fixture, retaining
  `JEV_COMMAND_BAR_URL=http://127.0.0.1:18478`. Strict deep signature verification
  passes. The rebuilt app was not opened. No commit or push was made.

Evidence:

- `/private/tmp/harness-jsonl-before.log`
- `/private/tmp/harness-jsonl-focused.log`
- `/private/tmp/harness-jsonl-stream-fix.log`
- `/private/tmp/harness-jsonl-performance-before.log`
- `/private/tmp/harness-jsonl-performance-final.log`
- `/private/tmp/harness-jsonl-full.log`
- `/private/tmp/harness-jsonl-native.log`
- `/private/tmp/harness-jsonl-analyze-final.log`
- `/private/tmp/harness-jsonl-build.log`

All transcript data is synthetic and confined to temporary directories. No
user transcript was read, no account changed, and no real harness started.
Native keys remain Flutter-injected; live computer-use and isolated native
performance measurement retain the previously recorded limits. The broader
goal is active. Next audit account changes and reconnect/inventory responses,
with attention to old replies restoring stale workspace or onboarding state.
The rest of the device, platform, and product audit remains outstanding.

## Account lifetime, sign-out recovery, and readable authentication — 2026-09-20

The initial viewer-auth probes reproduced ten failures in fourteen cases.
An old refresh could restore credentials after sign-out, overwrite a new
account, or clear it when the old refresh failed. Cancelling browser sign-in
during server binding, authorization, exchange, or persistence could still
publish a URL or save credentials. An older attempt's cleanup also owned
the replacement attempt's callback reference.

Viewer authentication now gives each login and account session a revision.
Refresh completion checks that revision before saving or clearing anything;
its cleanup only releases its own in-flight future. Credential writes and
deletions are serialized, and token readers wait for pending writes. A
cancelled save clears its incomplete credentials before a newer queued
login is allowed to write. Callback cancellation closes its listener, treats
an early outcome as data until it is awaited, and cannot cancel a replacement.

Desktop sign-out previously ignored CLI failure and enabled Sign in while
the CLI could still be clearing the saved session. It now owns the child
process, checks its exit, drains output, and terminates a timed-out child
before returning failure. App state joins repeated sign-out requests, clears
the visible account, and waits for credential and connection cleanup before
allowing sign-in. Failure offers a focused Retry sign out action with a plain
explanation. Failed terminal/connection closure cannot strand the remaining
cleanup. Disconnecting a development fixture never runs real CLI logout.
A delayed machine response can no longer change signed-out cache status.

Visual review caught a separate accessibility issue: at 880×560 with 1.8×
text, the decorative fleet diagram pushed the action and recovery message
below the viewport. Short windows now omit that diagram when text is enlarged.
The action and explanation remain visible, and retry/success restore keyboard
focus. The capture fixture was also corrected to synchronize its global
palette with the requested theme; its initial light captures mixed light text
styles with a dark palette. All twelve final captures were inspected.

Validation:

- Full suite: **2,541 passed, 10 optional tests skipped**. Added 17 viewer
  lifecycle cases, three CLI logout cases, seven sign-out state/keyboard/
  visual cases, and one delayed-inventory case.
- After the viewport adjustment: all 25 sign-in/sign-out widget regressions
  pass, followed by all seven sign-out cases with synchronized light/dark
  captures. Capture states are pending, failed, and ready at 1.0× and 1.8×.
- Nine native macOS journeys pass: sign-out retry and keyboard focus,
  Settings, first workspace, New Tab and New Pane creation, Store Open and
  Try, Models, and edited creation destination. Creation tests deliver
  terminal input without a mouse click and cover product-prefix isolation.
- Static analysis: no errors/warnings, the same 18 informational findings.
  Formatting and `git diff --check` pass.
- Normal `lib/main.dart` rebuilt with the existing command-bar URL
  `http://127.0.0.1:18478`; strict deep signature verification passes.
  The rebuilt app was not opened. No commit or push was made.

Evidence:

- `/private/tmp/harness-auth-lifecycle-before.log`
- `/private/tmp/harness-auth-recovery-focused.log`
- `/private/tmp/harness-auth-full.log`
- `/private/tmp/harness-auth-visual.log`
- `/private/tmp/harness-auth-visual-final.log`
- `/private/tmp/harness-auth-review/`
- `/private/tmp/harness-auth-native.log`
- `/private/tmp/harness-auth-analyze-final.log`
- `/private/tmp/harness-auth-build.log`

Accounts, credentials, CLI processes and harnesses in these tests are fakes;
viewer callback tests use ephemeral loopback listeners and in-memory storage.
No real account was changed. Native keys are Flutter-injected, so physical
AppKit/IME and live account interaction retain their earlier verification
limits. The broader goal remains active. Next inspect runtime session expiry,
saved workspace restoration across account changes, and concurrent machine
inventory responses; the remaining platform/device/performance audit continues.

## Workspace restoration and concurrent inventory — 2026-09-20

Thirteen initial account/workspace regressions reproduced lost restoration,
stale layout reads after sign-out, and callbacks from replaced connections.
Four additional inventory cases reproduced older replies replacing newer
rows, loading state, or retry errors. These cases now pass.

Sign-out and runtime expiry share live-workspace cleanup. They close all
terminal sessions on their original transports, clear account-owned inventory
and history, and leave one fresh empty tab without saving it over the previous
desk. Sign-in waits for pending cleanup; cancellation while waiting prevents
later login. Layout reads check account and layout revisions. Saved tabs,
active selection, pinning, layout presets, and zoom restore after signing in.
The persisted desk remains computer-local intent, not an account-namespaced
store. Replaced WebSocket connections lose callback ownership immediately.

Machine inventory now has request ownership as well as account ownership.
Only the latest request can publish rows, finish loading, or clear its error.
API responses retain their own freshness, and shared-machine fallback cannot
cross account changes. Retry retains the public refresh path, whose boolean
result tells callers whether its response was applied. An early version
bypassed this path; the full suite caught three regressions, which were fixed.

Runtime expiry now presents one Sign in action with its explanation, without
mislabeling it as a failed sign-in. Four captures were inspected at 880×560:
dark/light themes and 1.0×/1.8× text. A visual fixture initially left a timer
alive after successful sign-in; explicit fixture disposal fixed all four
failures. The first native restoration fixture waited for an indeterminate
reconnect spinner to settle; it now waits for sign-in completion and checks
keyboard tab selection directly, with a bounded timeout.

Validation:

- Focused account/connection cases: **80 passed**. Focused inventory cases:
  **80 passed**. Retry/public-path regression pass: **71 passed**. Final
  inventory-result and expiry-screen checks: **29 passed**.
- Full suite: **2,565 passed, 10 optional tests skipped**.
- Native macOS: **10 passed**, covering expiry/restoration, sign-out recovery,
  Settings, first workspace, Cmd-T/Cmd-P immediate input, Store Open/Try,
  Models, and edited draft placement.
- Static analysis: no errors or warnings, the same 18 informational findings.
- Normal `lib/main.dart` rebuilt with command-bar URL
  `http://127.0.0.1:18478`; strict deep signature verification passes. The app
  was not opened. No commit or push was made.

Evidence:

- `/private/tmp/harness-workspace-account-before.log`
- `/private/tmp/harness-workspace-account-focused.log`
- `/private/tmp/harness-inventory-before.log`
- `/private/tmp/harness-inventory-focused.log`
- `/private/tmp/harness-workspace-account-retry.log`
- `/private/tmp/harness-workspace-account-final-focused.log`
- `/private/tmp/harness-workspace-account-full-final.log`
- `/private/tmp/harness-workspace-account-review/`
- `/private/tmp/harness-workspace-account-native-final.log`
- `/private/tmp/harness-workspace-account-analyze-final.log`
- `/private/tmp/harness-workspace-account-build.log`

Account and terminal fixtures are synthetic; API tests use an ephemeral
loopback server and memory storage. The temporary retry-path regression
bypassed discovery overrides and attempted local read-only discovery; no real
account changed and no real harness started. Native keys are Flutter-injected;
live AppKit/IME and platform/device checks retain their recorded limits. The
broader goal remains active. Next inspect restored panes whose machines no
longer appear in a successful inventory and their reconnect guidance.

## Clear recovery for unavailable restored panes — 2026-09-20

A successful inventory with no row for a saved pane still displayed an
indefinite "Waiting for this machine" spinner. Five initial UI regressions
failed, covering a fresh empty reply, a recovered-but-absent machine, a cached
empty reply, failed reads, and keyboard Retry.

App state now records whether an inventory has completed for the current
account. A missing fresh row says the machine is unavailable; cached data
says its status could not be confirmed; failed reads say machines could not
be loaded. Initial loading retains its waiting state. All completed states
offer Retry, which stays mounted while a request is pending and preserves
its position and keyboard focus. Repeated activation joins the current retry.
The progress/icon space has a fixed size. Account changes reset completion.
Unknown agent headers use the established Untitled Pane placeholder instead
of exposing a raw identifier, and retained-output notices no longer promise
an answer from an absent machine.

Validation:

- **64 focused checks pass**, including keyboard activation during/after
  refresh, unchanged Retry geometry, stale-versus-fresh guidance, and account
  reset. The pane fixture now listens to notifier updates as the real shell
  does; its earlier static host was corrected.
- **12 small-pane captures** at 440×240 were inspected: missing/cached/failed
  in both themes at 1.0× and 1.8× text. All content and Retry remain visible.
  Initial captures lacked a Material ancestor; the final fixture includes
  the app's normal surface and removes the debug banner.
- Full suite: **2,581 passed, 10 optional tests skipped**.
- Native: nine launch/account scenarios passed in the combined run. The new
  recovery assertion first assumed Retry was the first Tab stop; the workspace
  also has pane-header controls. The corrected test traverses the real order,
  activates Retry with Enter, and verifies another inventory request. It
  passes separately, retaining saved-tab selection checks. Ten native
  scenarios therefore pass across these final runs.
- Analyzer: no errors or warnings; the existing 18 informational findings.
  Formatting and `git diff --check` pass. A missing import for the shared
  placeholder constant was caught and corrected before the final runs.
- Normal `lib/main.dart` rebuilt with command-bar URL
  `http://127.0.0.1:18478`; strict deep signature verification passes. The
  rebuilt app was not opened, and no commit or push was made.

Evidence:

- `/private/tmp/harness-missing-machine-before.log`
- `/private/tmp/harness-missing-machine-focused-final.log`
- `/private/tmp/harness-missing-machine-review/`
- `/private/tmp/harness-missing-machine-full-final.log`
- `/private/tmp/harness-missing-machine-native-final.log`
- `/private/tmp/harness-missing-machine-native-recovery.log`
- `/private/tmp/harness-missing-machine-analyze-final.log`
- `/private/tmp/harness-missing-machine-build.log`

This pass uses fake inventory and account fixtures and in-memory storage. No
real account changed or real harness started. Native keys are Flutter-injected;
physical input, live account/daemon behavior, and platform coverage retain the
previously recorded limits. The broader product goal remains active. Continue
with reconnect transitions, retained terminal state, and the remaining
device/platform/performance checks.

## Reconnect discovery and retained terminal input — 2026-09-20

Five new discovery probes failed before the fix: a reconnect reused pending
capability discovery from the old connection; its late success/failure could
replace new capability state; an old inventory timeout marked the reconnected
machine offline; an offline transition still accepted pending discovery; and
a background inventory reply overwrote the fresh reconnect snapshot. Two
further probes reproduced a second reconnect waiting behind obsolete recovery
and an old stream ID remaining writable after connection replacement.

Machine discovery now has a connection revision in addition to its account
and machine-object guards. A disconnect or new connection releases old
inventory/capability futures so fresh discovery can begin immediately. Each
completion checks its originating revision. Reconnect clears negotiated
capabilities until this connection answers, and old completion handlers cannot
release a newer request's ownership. Background inventory uses the same guard.
Pending-agent recovery has explicit ownership and checks its revision both
before and after discovery; a second reconnect can begin without waiting for
the first recovery loop to finish.

A replacement connection also releases prior stream IDs immediately. The
session and renderer remain in place with retained output, scroll, selection,
and draft state, while input waits for the replacement stream's first keyframe.
Taken-over sessions remain under the existing explicit-retry policy.

Validation:

- The initial probes failed **5/5**, then **2/2**. The final focused reconnect,
  discovery, offline, and retained-view pass has **37 passing checks**. The
  final shared discovery fixture separately has **19 passing checks**.
- Full suite: **2,588 passed, 10 optional tests skipped**.
- Native workspace: **11 passed together**. The new journey verifies retained
  renderer, output, scroll, selection, suppressed input before negotiation,
  fresh screen arrival, unchanged focused pane, and input resumption without
  a mouse click. Main Cmd-T/Cmd-P, Store Open/Try, first-run, Settings, account
  recovery, and edited draft placement remain covered in that run.
- Native terminal: **2 passed**, exercising keyframe replacement and switching
  agents without stale/duplicate native terminal views.
- Analyzer: no errors or warnings; 18 existing informational findings after
  correcting six new brace-style findings. Formatting and diff checks pass.
- Normal `lib/main.dart` rebuilt with command-bar URL
  `http://127.0.0.1:18478`; strict deep signature verification passes. The app
  was not opened. No commit or push was made.

Evidence:

- `/private/tmp/harness-reconnect-discovery-before.log`
- `/private/tmp/harness-reconnect-handoff-before.log`
- `/private/tmp/harness-reconnect-discovery-focused-final.log`
- `/private/tmp/harness-reconnect-discovery-final.log`
- `/private/tmp/harness-reconnect-discovery-full.log`
- `/private/tmp/harness-reconnect-discovery-native.log`
- `/private/tmp/harness-reconnect-terminal-native.log`
- `/private/tmp/harness-reconnect-discovery-analyze-final.log`
- `/private/tmp/harness-reconnect-discovery-build.log`

The direct computer-use retry returned empty app/browser inventories and
`Sky Computer Use native pipe startup failed`. Native checks therefore remain
Flutter-injected input with synthetic transport; they do not establish
physical AppKit/IME, live credentials/daemon behavior, or other-platform parity.
No real agent or account was changed. Immediate discovery is verified by
request ordering under held fake replies, not a network latency claim. The
broader goal remains active. Continue the performance and interaction audit,
especially sustained command-dock use and large inventories, with the existing
physical/platform limits kept explicit.

## Command-dock query rendering profile — 2026-09-20

Exercised the real SwarmScreen with 2,000 and 10,000 synthetic harnesses:
repeated Cmd-T, broad/narrow typing, another character with the same matches,
arrows, and Cmd-P → Cmd-T retargeting. The fixture asserts that no machine
transport is used. Optional CPU sampling connects only to its own loopback VM
service and saves samples outside the workspace. Run the benchmark explicitly;
it is excluded from the normal `*_test.dart` suite.

The first CPU sample involved Flutter rebuild work in roughly 44% of samples;
search filtering appeared in roughly 7%. Debug/test overhead and truncated
stacks limit interpretation. A focused regression then reproduced five visible
ListTile controls rebuilding when only query match text changed. Row text now
listens for match-query/help-mode changes separately from the bounded control
cache. Unchanged controls keep their widgets; row metadata, availability,
selection, actions, geometry, palette, and font still invalidate as needed.
The regression now sees zero unchanged control rebuilds, updated matches, and
retained input focus. Existing arrow movement still rebuilds only two rows.

A paired experiment temporarily restored query-driven control invalidation,
then removed it before final verification. Consecutive-character timings:

| Synthetic harnesses | Controls invalidated: median / p95 | Controls retained: median / p95 |
| --- | --- | --- |
| 2,000 | 11.059 / 12.485 ms | 9.513 / 11.888 ms |
| 10,000 | 16.568 / 19.649 ms | 17.648 / 35.046 ms |

These are 50-sample **headless debug widget elapsed** measurements after eight
warmups. Broad open/filter timings also have noisy tails. The consistent result
is reduced rebuild work; the mixed timings do not establish a general speedup,
native display latency, or release-build performance. No ranking or visible
interaction rules were changed for this optimization.

Verification:

- 88 focused dock, Store, project, draft, and placement checks passed.
- The initial full run found a race in the shared-viewer fixture: a recorded
  server request was treated as proof its reply had reached the UI. The fixture
  now awaits the actual displayed response. Its four tests pass, followed by
  the full suite: **2,589 passed, 10 optional tests skipped**.
- **All 25 native macOS workspace journeys passed together**, including first
  workspace, shared views, Cmd-T/Cmd-P creation, edited placement, Store
  Open/Try/Models, immediate terminal input, Settings, machine management,
  account recovery, rename, stop, fork, and restart.
- Analyzer: no errors/warnings; the same 18 existing informational findings.
  Two new informational findings were corrected before the final analysis.
- The optional profiler and cleanup path passed in a final 2,000-row run.
- Normal `lib/main.dart` rebuilt with the existing command-bar URL at port
  18478. Deep strict code-signature verification passed. App not opened;
  nothing committed or pushed.

Evidence:

- `/private/tmp/harness-dock-row-before.log`
- `/private/tmp/harness-dock-query-focused.log`
- `/private/tmp/harness-dock-widget-before.log`
- `/private/tmp/harness-dock-widget-after.log`
- `/private/tmp/harness-dock-widget-query-control.log`
- `/private/tmp/harness-dock-widget-query-growth.log`
- `/private/tmp/harness-dock-cpu-2000.json`
- `/private/tmp/harness-dock-cpu-final-2000.json`
- `/private/tmp/harness-dock-observer-fixture.log`
- `/private/tmp/harness-dock-query-full-final.log`
- `/private/tmp/harness-dock-query-native.log`
- `/private/tmp/harness-dock-query-analyze-final.log`
- `/private/tmp/harness-dock-query-build.log`

The broader audit remains active. Native checks use synthetic state and
Flutter-injected keys; physical computer use, AppKit IME, real daemon/account
behavior, and native Linux remain outside the evidence above.

## First-run setup diagnostics and recovery — 2026-09-20

Continued from the verified command-dock pass. Three failing probes established
that malformed installer output disappeared from diagnostics, a partially
written result could return the provisioner to Review, and a 1.4 MB log was
copied wholesale into UI state on every five-second recheck. The malformed log
was caught as a filesystem read failure; it did not itself crash this fixture.

The provisioner now reads at most the final 64 KiB and retains at most 200 lines.
It tolerates incomplete UTF-8, keeps the end of long single-line output, and
replaces the preceding snapshot when the log changes. The original log is
untouched; truncation includes its path. Empty, unreadable and malformed result
files stay pending, while live dependency probes remain authoritative. Tests
also cover an empty completion file and preserve the existing no-duplicate
Terminal launch behavior. These are bounded I/O and UI-state guarantees, not
native Linux timing measurements.

Two failing UI tests additionally reproduced unhandled clipboard failures and
an older copy error arriving after a newer success. Setup now catches clipboard
errors, announces an inline recovery message beside the still-available Retry,
and lets only the latest attempt update feedback. Timers cancel on disposal and
renew for the latest copy. Setup's lead now says first harness, consistently
with its footer and the dock. Visual review found white step numbers against
light circles; they now use the theme's text color.

Verification:

- 44 focused setup, provisioner, timer, and rendered-layout checks passed.
- Full unit/widget suite: **2,599 passed, 10 optional tests skipped**.
- A final 12-test setup/layout run passed after the light-theme color change.
- **Eight native macOS journeys passed together**: first setup, first workspace,
  Cmd-T/Cmd-P creation, Store Open/Try/Models, and edited-draft placement. The
  new first-setup journey uses Enter to start, checks duplicate suppression,
  simulates failure, handles clipboard failure, reaches Retry with Tab, and
  reaches sign-in after successful verification. All installers/auth are fakes.
- Twenty PNGs in `/private/tmp/harness-setup-review` cover review, manual setup,
  Terminal waiting, failure, and copy failure, with real fonts/icons, both
  themes and 1×/2× text at 880×560. All were visually inspected. Enlarged
  content scrolls while the primary action stays visible.

Evidence:

- `/private/tmp/harness-setup-log-before.log`
- `/private/tmp/harness-setup-log-boundary.log`
- `/private/tmp/harness-setup-copy-before.log`
- `/private/tmp/harness-setup-recovery-final.log`
- `/private/tmp/harness-setup-visual-final.log`
- `/private/tmp/harness-setup-recovery-full.log`
- `/private/tmp/harness-setup-recovery-native.log`

Direct computer use was retried; it still returned no apps/browsers and
`Sky Computer Use native pipe startup failed`. The broader goal remains active.
These checks establish fake-transport/native-widget and rendered-layout behavior,
not physical AppKit input, real package installation, or native Linux execution.

Final checks: analyzer has no errors/warnings and the existing 18 informational
findings. Formatting and targeted diff checks pass. Normal `lib/main.dart` was
rebuilt after the final contrast change with the existing port-18478 command
bar configuration. Its final signature check found a nested-code mismatch;
the App.framework signature itself was valid, but the outer bundle seal was
stale. Refreshing only the debug app's existing ad-hoc signature resolved it.
Deep strict verification now passes; before/after entitlement files are
byte-identical. The artifact was not opened, and nothing was committed or
pushed. Final logs:
`/private/tmp/harness-setup-recovery-analyze-final.log` and
`/private/tmp/harness-setup-recovery-build-final.log`.

## Bounded startup checks and final review build — 2026-09-20

Startup retries now retain whether the user explicitly started installation. An initial check
failure retries the check; a failed automatic recheck stops before running another installer.
Readiness requires the final ready phase and all required tools, preventing stale successful steps
from showing “Environment ready” while a new verification is still pending.

Dependency probes own their subprocesses and apply a ten-second deadline to startup, exit, and
pipe closure. They stop their owned process and detach output on failure, stop late launches, cap
retained output at 64 KiB per stream, and tolerate partial UTF-8. Installers keep their separate
streaming path. Twelve process-lifecycle regressions cover shell/tmux/Node/CLI hangs, late starts,
inherited pipes, stream errors, retry, Windows verification, stale readiness, and termination of an
isolated native sleep process. No real installer or agent is involved.

The preflight screen announces changing status and respects Reduce Motion. Render review caught
that a frozen spinner looked like a single pixel; reduced motion now uses a static waiting icon.
Both themes and 1×/2× text at the minimum window size render without overflow.

Verification: **114 focused checks** and **2,616 full unit/widget tests passed**, with 10 optional
tests skipped. Logs: `/private/tmp/harness-preflight-final-focused.log` and
`/private/tmp/harness-preflight-final-full.log`. The explicit first-setup native journey now also
covers read-only Retry before choosing Install; that added journey stage still needs a native run.
The previous native launch/Store/focus results remain recorded above. Direct computer-use inventory
still failed with `Sky Computer Use native pipe startup failed`; no physical/AppKit input claim.

At the user's request, normal `lib/main.dart` was rebuilt with port-18478 command-bar configuration.
The debug outer signature needed resealing after incremental framework replacement; deep strict
verification passed and entitlements remained byte-identical. Opened the current workspace's
`Harness.app` and confirmed active PID 99321. Preserve this review window while preparing the PR.
Build log: `/private/tmp/harness-review-rebuild.log`.
