# Friendly desktop experiment

Requested on 2026-09-28. Local review branch: `experiment/friendly-desktop`.
This experiment follows the user's new direction for the UI around the terminal.
The [desktop design system](desktop-design-system.md) now governs all UI outside
the terminal panes, superseding fixed-cell geometry, bracket buttons, and
all-monospace app controls. Track the full scope in the
[migration ledger](desktop-ui-migration.md). This experiment was not included in
Desktop 1.2.27 and must not be merged without the user's approval.

- Startup and New Tab embed the same `NewHarnessForm` and
  `NewHarnessController` used by Cmd-N. The form keeps its 680-point maximum
  width on the full page, without a modal backdrop or Close button. Recent
  sessions use the existing `WelcomeSessions` eligibility and visit ordering,
  rendered as a quiet list below the composer. Both form and list scroll in
  short windows. Typing numbers edits the message; recent rows remain clickable
  and keyboard-focusable rather than intercepting plain digit keys.
- Empty tabs initially focus the message. Cmd-N returns to that tab's existing
  draft. Each empty tab keeps its own choices and message when switching tabs
  or opening search. Launching uses that tab, with the same pending-receipt,
  installation, validation, and duplicate-start guards as the popup. A populated
  workspace still opens Cmd-N as a popup. No harness starts merely by visiting
  the page.
- On macOS the native footer yields to a modal route or creation/search backdrop,
  including its accessibility controls, then restores when it closes.
- Cmd-N places a centered, 680-point composer directly on a 95% dark backdrop,
  without an outer card, border, or shadow. Light mode uses a 95% white backdrop
  so the unframed labels remain readable. Cmd-P retains its floating frame.
  Both use system typography and visible focus boundaries without shifting controls.
- Agent and Repo are compact capsule selectors above the editor, with the
  agent's existing brand mark, opaque neutral fills, and Close at the right. The always-visible message
  editor says “Harness anything”; New Harness sits inside its lower-right corner,
  works without a message, and has no visible Return symbol.
  Model, Approvals, and Codex Profile sit below the composer on the left;
  a checked Worktree control and a branch icon/name sit on the right. Git
  controls stay together, moving below the other settings in narrow windows
  or at larger text sizes. Long branch names truncate at the beginning, keeping
  their identifying suffix and complete Unicode characters; the tooltip and
  accessibility label retain the complete branch and worktree plan.
- Machine selection sits inside the Repo search row: “Search repos in This Mac”.
  Selecting the machine opens a separate menu on the right, repositioning to
  stay onscreen in narrow windows. The folder query never filters machines.
  Tab reaches the machine selector from search; selecting a machine returns
  to Repo, and Escape closes only the machine menu. Open Folder, New Folder,
  and GitHub appear above the recent folders, separated by a thin rule.
  Recent folders are scoped to
  that machine. Fresh launch contexts still default to local; restored drafts
  and explicit Store machine choices retain their destination. The closed Repo
  control includes the machine name for remote destinations.
- Agent choices keep every coding agent above specialized harnesses. A stable,
  curated order starts with Claude Code, Codex, Cursor, Copilot, Grok, and
  OpenCode, followed by Antigravity, Amp, Kilo, Devin, Pi, Hermes, Command Code,
  and Muse. Newly supported coding agents also stay in this first group.
  Specialized harnesses follow with recent choices first, then Blender,
  CircuitJS, Godogen, MuJoCo, RDKit, Strudel, Typst, and the remaining catalog.
  Terminal comes last. Entries appear once; removed packages and viewers remain
  excluded. Search still ranks matching names by relevance. The saved launch
  choice remains the default selection without moving it above coding agents.
- The last explicit approval choice is remembered per agent, including Full
  access when selected. Worktree choices are remembered per machine/project.
  Projects without a saved choice keep Worktree on; agents without a saved
  approval mode keep Auto-approve. Drafts take precedence over these defaults.
- Fresh and restored task drafts focus the prompt. Enter launches without an
  extra step. Explicit agent and project selections become remembered defaults;
  use recents still record actual launches. The task shortcut focuses
  the editor; the former Options shortcut opens Model directly (Repo for
  Terminal). Terminal keeps the editor read-only and outside keyboard
  traversal while preserving a carried message.
- In the task editor, Enter submits; Shift-Enter inserts a newline. Cmd-Enter
  remains a remappable launch shortcut. Opening a chooser does not submit the task.
  Outside clicks close an open chooser but keep the main form open. Escape
  dismisses the innermost chooser first, then the main form on another press.
  X directly dismisses the composer and remains available while a chooser is open.
  Explicit dismissal discards the unfinished task and attachments; reopening starts
  fresh with the usual launch defaults. Existing pending-launch checks still
  protect unresolved creation receipts.
  A choice or cancellation returns focus to the originating control. Tab and
  Shift-Tab dismiss a chooser without applying a value and continue form traversal.
- Focus stays inside the active dialog. The prompt receives initial focus;
  Terminal focuses New Harness because it has no task. Tab from New Harness wraps
  to Agent, then Repo, message, Model, Approvals, Profile, Worktree,
  Branch, and Close. Shift-Tab reaches Close. Tab reaches each visible control without
  stopping on hidden fields. Arrow keys navigate searchable option lists.
  Existing command identities and shortcut remapping remain available.
- Dismissing Cmd-N or switching to Cmd-P preserves its unsent draft in the same
  machine/project/source-pane context. Another source pane gets its own defaults.
  Cmd-N resumes that draft even after typing a search query; a fresh composer
  uses the query when there is no draft. Explicit create-from-search and Store
  task actions keep their requested text and existing ownership rules.
  Restoration uses the current destination tab and never duplicates a pending
  launch receipt.
- New, Open, and Clone use the selected machine directly. Open Folder invokes
  the native local folder dialog or remote folder browser in one step. Accepting
  returns to the composer; cancelling returns to the Repo list. New and Clone
  prompts offer Change machine. Choosers begin at a focused search field and
  size to their contents, with no visible title, close button, or key legend.
  A back control appears inside search only for nested prompts. Machine rows
  keep names, the current checkmark, and unavailable status; redundant remote
  captions are omitted. Repo paths remain available for disambiguation.
- Configuration uses the existing creation controller and choice navigation.
  Remote machine checks, worktree errors, launch receipts, and installation
  recovery retain their existing behavior. Task text survives configuration
  changes and narrow layouts.
- Cmd-P uses a rounded, compact palette, a native-sized search editor, and
  visible Harnesses / Machines / Projects / Models / Store / Commands filters.
  Filters edit the existing searchable prefixes; typing prefixes still works.
  Sessions show their context in the second line. A visible preview toggle
  keeps session history and resource management available, with their existing
  keyboard controls and safety checks. Tab traverses the toolbar, the scope-pill
  group, and preview actions; Up/Down navigates results. Escape returns from
  management controls to search before dismissing the dialog.
- System UI typography is used for app headings, controls, fields, shortcut
  browsing, and task text. Explicit code, paths, workspace bars, and terminal
  content retain their appropriate monospace styles.
- Header selectors use compact capsules; composer settings use quiet text
  controls with a focus ring. The default action retains its keyboard commands
  without displaying a shortcut symbol.
  Clickable controls show a hand cursor, while editors retain a text cursor.
  Icon-only toolbar controls and navigation links retain their roles.

Review creation and search with keyboard, mouse, input composition, long text,
light/dark palettes, narrow windows, and unavailable resources. Use synthetic
fixtures for saved previews; never commit live account screenshots.

Validation of the shared welcome composer on 2026-09-29, after `cc5c4ecf`:

- The full desktop suite passed: **4,522 passed, 12 skipped**. Tests cover
  independent tab drafts, delayed default loading during tab switches, launch
  retries and pending receipts, recent-session navigation, search round trips,
  keyboard focus, and coding-agent ordering. The Repo machine control now
  handles Right Arrow before the menu anchor consumes it.
- Fresh full-suite coverage passed the complete New Harness gate:
  **1,882/1,882 controller lines** and **1,926/1,926 form lines**. This measures
  executable lines, not exhaustive branch coverage.
- App/test static analysis, the macOS debug build, and all **996 native
  titlebar checks** passed. Native checks include hiding and restoring the
  footer and its accessibility controls around a modal.
- Synthetic page previews were inspected in light and dark themes at regular
  and narrow widths with enlarged text. The rebuilt app was reopened for live
  review of the full-page composer, recent sessions, agent ordering, and popup
  footer coverage. No real agent was launched for validation. This iteration
  did not rerun the older 19-journey native Flutter fixture or a Linux build.

Validation of the interaction polish on 2026-09-29, after `67dc29f1`:

- All 169 tests passed across the seven affected composer, dialog, edge-case,
  entry-rule, preference, and friendly-desktop suites. The additional agent
  picker, harness selection, install, and project-context suites also passed.
- App/test static analysis and the macOS debug build passed. Synthetic previews
  were inspected in dark and light themes, including enlarged text and narrow
  windows. The final machine-menu styling also passed both theme layout tests.
- The normal app was reopened. Live review checked the Repo/machine cascade,
  agent ordering, and Escape returning to the composer without closing it.
  This iteration did not rerun the full suite, native fixture, or Linux build.

Validation of the frameless composer iteration on 2026-09-29, after `89aceb38`:

- 177 targeted tests passed across composer layout, compact launch, dialog
  interaction, launch edge cases, entry rules, saved preferences, project
  context, and friendly desktop suites. This includes keyboard machine
  selection, machine-scoped folders, nested cancellation, and draft retention.
- App/test static analysis and the macOS debug build passed. Synthetic previews
  were inspected in both themes, including narrow layouts and enlarged text.
  The normal app was reopened and the composer and local Repo menu inspected.
- This iteration did not rerun the full suite or native fixture described below.

Validation of the minimal composer iteration on 2026-09-29,
against the experiment baseline `a26237c9`:

- The full desktop unit/widget suite passed: **4,500 passed, 12 skipped**.
  The native macOS fixture passed all **19 journeys**, once each across four
  sequential native processes. App/test analysis and formatting passed.
  The normal macOS debug app was rebuilt after the fixture and opened for review.
- The fresh full-suite trace covers **1,986/1,986 changed executable lines**.
  The complete creation form/controller cover **3,627/3,627 lines**; the
  resource-picker gate covers **1,265/1,265 lines**. These are executable-line
  measurements, not a claim of complete branch coverage or every possible
  interaction. No coverage exclusions or stale traces were used.
- Independent AI developer reviews exercised creation, nested cancellation,
  mouse/keyboard focus, preview actions, unavailable resources, narrow windows,
  enlarged text, legacy presentation, and full-tab recovery. The final pass
  added 26 layout/interaction journeys and a four-round mixed-input sequence.
  It fixed competing focus restoration after folder acceptance, a stale Return
  hint, clipped actions in short folder menus, and search text replacing an
  interrupted draft. Synthetic renders were visually inspected in both themes
  with real fonts and shadows.
- A long native test process encountered background frame throttling in this
  environment. All 19 independent journeys passed in four fresh-process shards
  with unchanged assertions and timeouts. No Flutter lifecycle or frame
  completion was overridden. Launch submission uses fake daemons in tests;
  no real agent sessions were created for validation.

The native fixture injects Flutter keyboard events into the macOS engine.
Physical AppKit IME behavior and VoiceOver were not separately verified.
Linux behavior is covered by widget tests; a Linux native build was not run.
See [the validation record](friendly-desktop-validation.md) for commands and
the interaction suites.
