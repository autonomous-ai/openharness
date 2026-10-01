# Desktop UI migration and review

Objective: a coherent, welcoming Mac-style application around unchanged terminal
panes. This tracks the complete requested scope, not only the initial composer.
The [design system](desktop-design-system.md) is normative; historical screenshots
and tests do not override it. The user authorized PR, merge, and desktop release
on 2026-09-30; the unmerged checkpoints below describe earlier review stages.

## Surface inventory

| Surface | Current evidence / work remaining |
| --- | --- |
| Shared type, controls, fields, menus | System typography, semantic colors, 32-point icon controls, stable focus boundaries, Increase Contrast and platform text scaling implemented; terminal scaling stays independent |
| Welcome / New Tab | Shared 680-point composer; six muted Recent harnesses with status-format context and “now”; empty welcome omits history; machine discovery and pending defaults have distinct, actionable startup presentations |
| Cmd-N and child choosers | Purpose icons, approval explanations, visible focus, and coding-agent-first order implemented; shared controller retained |
| Cmd-P and resource previews | 1120×680 bounded panel, wider preview, natural-height model groups, explicit loading/error/retry states; six scopes rendered in both appearances |
| Full History | Shared desktop header/search/results with explicit “This window” scope; initial focus, Close activation, composition, result reveal and terminal focus return tested; light/dark and narrow/enlarged renders inspected |
| Rename and takeover | Desktop prompt anatomy implemented; safety/IME and focus-return tests pass |
| Stop, delete, restart, fork | Desktop confirmations implemented; long errors scroll independently of fixed actions; synthetic light/dark/narrow renders inspected |
| Sharing | Access/people/options, comments, observer sidebar, and viewer access/error states use desktop surfaces; existing sharing and authentication rules retained |
| Add Phone | Desktop QR/device layout implemented; pairing lifecycle tests and light/dark enlarged-text renders pass |
| Machine recovery/linking | Desktop linking/password layouts implemented; bounded selectable errors, fixed actions, and 32-point reveal controls tested/rendered |
| Notifications | Native name/message rows share the tab/pane activity marks, with colors adapted to menu contrast. Ready and Working use compact headers; all working sessions stay visible. Synthetic light/dark, all-working, empty, long, selected and unavailable states inspected; live menu interaction still needs review |
| Branches / pull requests | Desktop lists and shared modal veil implemented; colored icons, readable status words, honest load failures, Page Up/Down tested and rendered |
| Settings / customization | Desktop status customization, natural-height controls, error contrast, keyboard focus and passive native footer preview implemented; actual status previews preserve the selected renderer |
| Store | Existing graphical discovery/detail/launch routes retained; ordinary labels, search and counts use system typography; desktop and narrow/enlarged previews inspected |
| Sign-in / setup / boot | Boot/preflight/setup migrated and rendered; installer lifecycle tests pass; sign-in already graphical and scrollable |
| Shortcuts / keyboard practice | Desktop browsing/practice layout implemented and rendered; remapping and scratch terminal retained |
| Teams / ancillary dialogs | Swarm conversation, questions, member controls and Quick Start use desktop typography and controls; polling, answers, learning steps and storage unchanged |
| Layout / move / pane menus | Graphical layout previews, scrollable move list, shared model menu, compact Find options and desktop resize guidance implemented; keyboard navigation and terminal Find sizing retained |
| Daemon panels | Companion settings, pairing, proposal controls and consent use desktop controls; artwork, reveal frames, state and approval gates retained |
| Native tabs / footer / menus | System-font curved tabs with names, hover close and Command-held hints; 10-point pane frames. Pane model control before an always-visible close icon. Remaining subscription usage at left and focused machine/project/branch/PR at right. Empty New Tabs hide the footer; modals isolate it, with a passive customization preview |
| Linux / browser presentation | Shared light/dark, narrow and enlarged-text fixtures cover responsive behavior; physical Linux/browser platform validation is not claimed |

Legacy/test-only paths (including the old NewAgentDialog entry when
`newHarnessOpensInBox` is disabled) are excluded from the visible migration.
The standalone MachinesManager, old machine-link dialog, and generic
team-creation presenter have no production caller in this tree. They are not
counted as completed user journeys. Shared controls still serve their tests.

## Notification overview refinement — 2026-10-01

The earlier overview repeated a status caption and tab/machine context under
nearly every title. It now pairs the harness name directly with the message,
uses the existing tab/pane activity marks and colors, and keeps full context
in tooltips and accessibility. The first section is Ready, which includes both
completed replies and questions awaiting input. Working always shows all of its
28-point rows, without a disclosure arrow or overflow submenu; the section
disappears when empty. Clear is a quiet icon with a 32-point target.
The menu keeps native actions, keyboard navigation and receipt validation.
Status hues adapt to the menu's light or dark appearance independently of the
terminal theme, so a bright yellow question mark remains legible on a light
translucent menu. Monochrome status preferences remain monochrome.
[Apple notification research](macos-design-research.md#notification-menu-refinement--2026-10-01)
informed the hierarchy, not a claim of system Notification Center equivalence.

Native captures use synthetic sessions and the production AppKit views:
[light](images/notification-overview-light.png),
[dark](images/notification-overview-dark.png), and
[all seven working sessions](images/notification-overview-all-working.png).
The six-session sample is 360×465 points, down from 360×597. The all-working
sample is 360×423. Empty is 360×184; long
names preserve the 360-point menu width. These are view renders on neutral
surfaces; they do not simulate window-server blur. The fixture also covers
long/truncated, highlighted and offline rows. Reproduce with
`tool/check_swarm_titlebar.sh <flutter-sdk> --status-menu-preview`.

Validation for this refinement: 39 targeted Flutter tests and 48 native menu
checks; changed-file static analysis and the icon audit pass. Menu and tab bridge
payloads match for glyph, label and source color. Tests cover receipt-bound
previews, stale clicks, snapshot clearing, tab moves, existing-pane navigation,
all working rows, shortcut hints, sign-out, menu contrast and the animation
lifecycle. Activity from stopped or replaced conversations is rejected, and a
working row expires when its heartbeats stop. This does not suppress a machine
that continues to send heartbeats for its current conversation; that upstream
case still requires investigation. The native glyph drawing is shared without
changing tab geometry. Physical pointer/keyboard tracking
and VoiceOver in the user's running app remain manual review items; these
fixtures are not that evidence.

## AI review panel

The user requested independent AI perspectives. These are design and engineering
reviews, not claims of human credentials or Apple endorsement.

- Mac design research: checked Apple HIG/WWDC and official excellent-app
  references; recommends hierarchy, visible focus, consistent anatomy, semantic
  light/dark colors, and restrained optional motion. See the research record.
- Product/accessibility review: found value-only composer controls, missing
  approval explanations, misleading All scope, weak focus, and ambiguous recents.
- Frontend review: traced live paths, identified TerminalBox and bespoke
  terminal-cell forms, and found that AppMenuItem ignored its textStyle input.

Address findings in shared components where appropriate. Each surface still
needs rendered and runtime review after its migration. A code review or one
passing screenshot does not establish whole-app completion.

## Verification ledger

Baseline `7782202b`: 4,522 desktop tests passed, 12 skipped; 996 native titlebar
checks; full form/controller executable-line coverage; local debug build opened.
These results precede the broad redesign and must not be attributed to later edits.

### Broad desktop surfaces checkpoint, 2026-09-29

- Full desktop suite: **4,560 passed, 16 skipped**, with fresh line and branch
  coverage. The complete creation controller/form line gate passed.
- Static analysis covers `lib`, `test`, and `integration_test`. The macOS debug
  build and **996 native titlebar checks** passed. The native drag fixture needs
  access to the macOS pasteboard service; its sandboxed run failed the drag
  assertion, then the authorized native run passed without code changes.
- AI review fixes include Tab traversal past prompt wrappers, scrollable and
  selectable long errors with actions kept visible, clear composer-control
  purposes, honest history load failures, readable status words, and paging
  the active PR/branch list.
- Real-font synthetic renders cover light/dark confirmations, sharing, history,
  notifications, setup, shortcuts, and connection forms. Connection forms were
  checked at 720×560 with 1×/2× text and 480×360 with 1.6× text; confirmation
  error layouts include 480×360 at 1.7×.
- The rebuilt app was reopened. Live review checked the New Tab composer,
  recent context, coding-agent-first chooser, search scopes/dismissal, native
  footer coverage, and notification empty state. No real agent was launched.
- Remaining work is explicit in the inventory above. Physical IME and VoiceOver
  have not been verified; this checkpoint does not include a Linux build or a
  repeat of the historical 19-journey native Flutter fixture.

For each new checkpoint record changed surfaces, relevant tests, actual renders,
native runtime checks, reviewer findings, fixes, and unresolved gaps. Test traces
must correspond to the final source. Native keyboard injection does not prove
physical AppKit IME or VoiceOver interaction. No live user data in saved previews.

### Complete desktop presentation pass, 2026-09-29

- Full desktop suite: **4,628 passed, 16 skipped**, with fresh line and branch
  coverage. New Harness covers **3,813/3,813 executable lines** across its
  complete controller and form. This is not a whole-app coverage claim.
- Static analysis of `lib`, `test`, and `integration_test` is clean. The normal
  macOS debug build succeeds. **999 native titlebar checks** pass, including
  passive footer preview containment. The macOS Flutter integration fixture
  passes **19 creation/search journeys**. Its test app is replaced by the normal
  review build afterward.
- Independent frontend and product review found and resolved a scrolling-menu
  focus loop, Find scaling inheritance, observer-header overflow, Add project's
  intrinsic-layout failure, small-window conversation space, stale focus styles,
  and Quick Start's remaining terminal-style app controls. The last guide-strip
  fill adjustment passed its **24-test** guidance/practice rerun.
- Synthetic real-font renders were inspected for the remaining menus, Store,
  layout/move palettes, comments, Swarm conversation, Quick Start, observer
  header, status customization, and companion panels. Cases include both
  appearances, 360–390-point widths, up to 200% text, Increase Contrast, and
  Reduce Motion. Rendering fixtures preserve real approval and stale-response
  guards while substituting data and services.
- Live macOS review checked the creation form and coding-agent-first chooser,
  nested dismissal, full footer coverage, search scope switching, settings,
  status customization's visible but noninteractive footer preview, Store, and
  Quick Start. Existing terminals and tabs restored. No agent was launched,
  sharing changed, account authorized, or companion approval accepted for review.
- The migrated reachable surfaces now follow the shared desktop system.
  Terminal rendering, status artwork, core controllers, and launch/notification
  semantics retain their existing behavior. Physical AppKit IME, VoiceOver,
  and native Linux/browser execution remain separate validation limits; widget
  semantics and injected-key tests do not establish those results.

The experimental branch remains unmerged for the user's visual review.


### Coherent desktop system and focused footer, 2026-09-29

- The specification now defines the task/project/machine hierarchy, shared
  surface and control tokens, interaction defaults, one 95% modal veil, and one
  regular outline icon family. `AppIcons` replaces mixed Material/Lucide weights
  throughout app controls; native menus use the matching regular SF recipe.
  Agent/provider logos, terminal glyphs and companion artwork retain identity.
- Cmd-N and Cmd-P, nested pickers, Rename, Move Pane, layout, task routing,
  connection forms and resource editing use shared geometry and focus states.
  API editor actions remain visible while the fields scroll. Explicit launch
  choices persist; fresh forms default to main without overwriting drafts.
- Welcome/New Tab shows at most six secondary recents, small monochrome agent
  marks, a 56-point separation and “now” below one minute. Context uses the
  actual customized status renderer with contrast correction for unbacked ink.
  No-history welcome has no empty recents section or blank footer.
- Model/effort is left; focused machine/project/branch/PR is right in both
  Flutter and AppKit. Branch actions retain their existing target guards.
  Pane headers retain their quiet titles and hover-only close control.
- Full suite: **4,645 passed, 16 skipped**. The creation controller/form gate
  covers **3,894/3,894 executable lines (100%)**. Subsequent icon presentation
  refinements passed the relevant **76-test** footer/dialog/Store/sharing/pane
  rerun; no creation logic changed after the full coverage run.
- Static analysis is clean. **999 AppKit titlebar checks** and **19 native macOS
  journeys** pass across four sequential batches (5, 5, 4, 5). The native fixture
  uses fake transports and in-memory workspaces; it starts no real agent.
- Final real-font synthetic renders were inspected for creation and its machine
  submenu, search, welcome with/without history, rename/move/layout, focused
  footer, pane close and customized status styles. Both appearances and narrow,
  enlarged-text cases are covered. Screenshot fixtures now load the actual
  regular outline font rather than substituting Ahem squares.
- The normal macOS debug build succeeds and is open for review. Live review
  confirmed the focused footer's left/right arrangement, branch/PR click target,
  matching Cmd-N/Cmd-P veils covering the native footer, Escape dismissal, and
  six quieter New Tab recents without an empty footer. Existing windows were
  restored; no real agent was launched. The design system file is open in
  TextEdit for review.
- Physical IME, VoiceOver and native Linux/browser execution remain outside this
  verification. These results do not claim those platform checks or whole-app
  code coverage. The branch remains experimental and unmerged.


### Review refinements and familiar tabs, 2026-09-29

- Creation and New Tab share “Harness anything”. Recent harnesses use one muted
  neutral ink, retain the chosen status wording/fields/font, and suppress colored
  backgrounds. Quiet inline creation controls keep a neutral focus fill; normal
  branch focus no longer leaves a bright outline.
- GitHub entry begins as a single field. Validation grows only as needed. Long
  chooser errors and model notices scroll within a bounded area while search and
  a complete option remain available. A lost-machine message now opens the existing
  machine chooser directly. Anchors scrolled out of view cannot place its popover
  above the window; the regression was reproduced with real fonts and a long draft.
- Cmd-P has a 1120×680 maximum, with 44/56 results/preview proportion on wide
  windows. A synthetic answer has 591 points of reading width rather than 360.
  Model section headings and gaps use their own natural height. Loading, retrying,
  errors and settled emptiness are distinct without discarding available results.
- AppKit and Flutter tabs use system type, left-aligned names and related curved
  geometry. Permanent numbering is removed. Hover reveals close; Command reveals
  actual remapped shortcut hints without shifting titles. Legacy automatic New
  Swarm names become New Tab; explicitly saved custom names remain exact. Pane
  frames adopt the shared 10-point radius and clipped 9-point inner edge.
- Supporting refinements include purpose/value/state accessibility for settings,
  naturally sized enlarged-text menus, 6-point vertical button padding, consistent
  model/Find selection and checkmarks, and the Harness manager's shared surface,
  typography and readable semantic status/error colors.
- Independent AI reviewers exercised rendered interaction fixtures for search,
  creation, settings, model/Find menus and the manager. Native tab review includes
  rest, hover and Command-held states in both appearances.
- Each pane now shows its model immediately before an always-visible close icon.
  The model opens the shared Models picker for that exact harness. Narrow panes
  retain the close target; stale or unavailable targets cannot switch an agent.
  Tab-strip close still appears on hover and yields to Command-held hints.
- The footer's left side shows remaining subscription usage, such as
  “Claude 0% · Codex 50%”, from the same deduplicated accounts and limiting
  windows as Models. Unknown readings show “—”; distinct accounts remain
  distinct. Hover explains the reading; click opens Subscriptions. The right
  side retains the focused machine/project/branch/PR and their actions.
- Final suite: **4,702 passed, 16 skipped**. New Harness has **3,948/3,948**
  covered executable lines and the resource picker **1,271/1,271** (both 100%).
  App, test and integration source analysis is clean. A whole-directory analysis
  additionally reports 12 pre-existing informational lints in vendored xterm;
  terminal dependency code was not changed.
- **19 native macOS journeys** pass across four sequential batches (5, 5, 5, 4),
  using in-memory workspaces and fake transports. **1,224 AppKit checks** pass,
  including hidden native-window layout. These do not establish physical
  AppKit keyboard/IME behavior.
- The normal macOS debug review build succeeds. Final actual-font renders cover
  the pane model/close arrangement, subscription footer, muted recents and curved
  tabs at wide and narrow sizes. Automatic reopening was blocked by the native
  app-control connection (“Sky Computer Use native pipe startup failed”); this
  checkpoint does not claim a live-account app review.

### Quiet workspace controls and supporting-surface review, 2026-09-29

- Subscription readings use whitespace rather than dot separators. Names remain
  neutral; only percentages use red for zero and amber through 20%. Flutter and
  AppKit receive the same colored spans. Unavailable readings remain neutral and
  cannot appear as exhausted accounts. Contrast checks cover every workspace
  palette in both appearances.
- Pane close marks use the shared smaller size and 45% resting ink, strengthening
  for hover, focus and Increase Contrast without reducing their click target.
- Tab names and status form a centered group. Command replaces the status with
  the resolved shortcut immediately beside the name. Empty status marks reserve
  no visible slot. Close glyphs are optically matched across Flutter and AppKit,
  inside separate 32-point targets. Eight tabs fit the reviewed 1280-point width
  without truncation or horizontal scrolling.
- Shared confirmation/form bodies now show a draggable scroll thumb whenever
  content overflows, before the first scroll gesture. Long selectable recovery
  messages retain their own bounded scroll area and fixed actions. Error text can
  still be selected and copied in full without changing keyboard ownership.
- Settings navigation exposes button/selected/enabled accessibility states.
  Setup metadata and errors now use readable semantic ink. Export Logs retains
  visible, scalable, keyboard-accessible actions at enlarged text. Store
  recordings use the shared modal veil.
- Integrated supporting-surface checks: **121 passed**. Footer/pane checks:
  **21 passed**, including updates, unknown values, low/exhausted colors, pane
  targeting, and narrow widths. **10 actual-font render checks** cover light/dark
  confirmations and connection forms, including enlarged selectable errors.
- Tab/workspace checks: **53 passed**. Native checks: **1,331 titlebar/layout**,
  **169 keyboard bridge**, and **9 viewer**; a final windowless run passed
  **1,090** checks after updating the colored subscription fixture. Actual-font
  light/dark tab captures cover rest, hover, Command and enlarged text. Source
  analysis is clean and the normal macOS debug build succeeds.
- A fresh review instance was launched from this worktree after rebuilding;
  process start time was verified newer than the bundle. The unavailable native
  app-control connection still prevents claiming a live visual automation pass.

Remaining review: physical VoiceOver and AppKit IME, and native Linux/browser
use. These remain explicit gaps, not completed checks. This checkpoint remains
unmerged.

### Welcome handoff and final interaction review, 2026-09-29

- The no-machine welcome now has a clear heading and natural-width action.
  Machine discovery keeps that action available. Pending saved defaults show
  distinct preparation copy before the existing composer receives focus. Recent
  harnesses retain their 56-point separation in this fallback presentation.
- Project search measures its header at enlarged text sizes; both “Search repos”
  and the machine remain readable at 880×560 and 200% text. The ordinary width
  stays compact. The branch/PR route now uses the shared modal veil, including
  native footer coverage, without changing the underlying pane or terminal input.
- Add project uses the same desktop remote-folder chooser as New Harness,
  preserving path shortcuts and visible recovery. Errors use shared semantic
  ink. Orchestrator guidance wraps before its Send action can leave the panel.
- Pane-resize instructions use the desktop surface and system type; divider and
  key behavior are unchanged. Clone repository gives its URL initial focus.
  Synthetic composition checks protect Escape in cloning and Enter/Escape in
  task routing; ordinary actions resume after composition. Explicit Cancel stays
  available, and retry preserves its existing focus behavior.
- The independent reviewers inspected actual-font light/dark renders, enlarged
  text, startup/loading/recovery states, and input handoffs. Supporting dialogs
  passed **48 render checks**, with **9 final clone tests/renders** after the
  initial-focus correction. Resize guidance fits 480×360 at 200% text.
- With source frozen, the combined affected-journey suite passes **171 tests**.
  Static analysis of `lib`, `test`, and `integration_test` is clean; the normal
  macOS debug build succeeds. New Harness passes its full **3,953/3,953** line
  gate, and the resource picker passes **1,271/1,271** lines.
- The broader run passed **4,754 tests**, skipped **16**, and reported one clone
  focus failure because it had compiled the library before the final focus edit.
  The final 171-test run recompiles and passes that regression. Do not describe
  the earlier broad run as a clean run of the final source.
- The native app-control service still returns “native pipe startup failed”.
  Actual VoiceOver and physical AppKit IME remain unverified. Light renders test
  shared components; the production workspace still uses its approved dark
  appearance and this work does not add an appearance switch.

### Completion audit and supporting navigation, 2026-09-30

- A fresh frozen full suite at `4bbe5a255` resolves the earlier compilation
  timing ambiguity: **4,755 passed, 16 skipped**. Its fresh coverage passes the
  New Harness **3,953/3,953** and resource picker **1,271/1,271** line gates.
  Those results precede the following final audit fixes.
- Full History now uses the shared desktop surface, header, search field and
  result treatment. “This window” names its existing scope accurately. Close
  receives its own Enter action; search composition retains Escape. Synthetic
  native-command tests cover selection, dismissal and terminal focus return.
- The fallback Harness Store control uses system UI type and measured label
  padding. The fallback tab strip respects platform text scaling; ordinary
  navigation can grow while terminal zoom remains independent. Actual-font
  renders cover normal and 200% text.
- Pending device pairing prevents keyboard and queued selector changes, keeping
  the displayed device aligned with the operation. Fake failure/cancellation
  journeys verify accessible state and editing/retry recovery. Manage harnesses
  now displays and announces “now” for activity under one minute, including
  future clock skew, consistent with welcome and search.
- The combined affected-journey suite passes **167 tests**, with **1 optional
  render skipped**. History also passes all six final interaction/layout tests
  with actual fonts, and its four normal/narrow light/dark renders were inspected.
  Static analysis of `lib`, `test`, and `integration_test` is clean, and the
  normal macOS debug review build succeeds.
  Shared tab/pane close marks remain the small, fine, muted recipe documented in
  the design system, with their larger click targets and interaction emphasis.
- Native runtime verification is still pending: app control reports “Sky
  Computer Use native pipe startup failed”. Automatic approval review timed out
  twice before a native integration test could launch; no native test executed
  in this checkpoint. Physical VoiceOver and AppKit IME remain unverified.

### Native journey verification, 2026-09-30

- The existing fixture launches successfully without the optional sleep-control
  wrapper. The earlier automatic-review timeout no longer prevents native test
  execution. A complete creation/search run passes **19 native journeys**;
  the newly included History checks pass **6 native journeys** in a subsequent
  process. Both use the macOS engine, fake transports and in-memory workspaces.
- The first creation/search run passed 18 journeys and observed an unexpected
  `r` in one nominally empty prompt. That journey passed in isolation, then all
  19 passed together with explicit checks that both the editor and controller
  were empty before Return. No production input code changed. The unexpected
  input's source was not established; the first run is not counted as passing.
- History's native checks cover initial focus, bidirectional Tab traversal,
  Close versus result activation, synthetic composition, terminal focus return,
  and bounded light/dark layouts at normal and 200% text. This strengthens
  engine-level evidence; it does not establish physical AppKit IME or VoiceOver.
- Supporting documentation now agrees with the current system: centered tab
  name/status groups, Command hints beside the name, shared plus icons,
  whitespace-separated usage, model/close pane headers, and focused Git context
  in the footer. Draft, project and worktree ownership rules are unchanged.
- The independent completion review found no further concrete UI source
  contradiction. Final live visual continuity, physical VoiceOver and AppKit IME
  remain unverified while native app control is unavailable. These are the
  remaining completion gaps; further styling without a demonstrated defect is
  optional polish.
- Scoped fixture analysis is clean and the normal `lib/main.dart` review app
  was rebuilt after native tests. A final app-control attempt still returns
  “Sky Computer Use native pipe startup failed”, so no live visual review is
  claimed for this checkpoint.

### Tab close and recent identities review, 2026-09-30

- Tab close targets now sit 8 points inside the outer bounds, keeping the cross
  clear of the curved edge in both AppKit and Flutter. The 32-point click target
  is preserved; the title reserves that space before truncating and remains
  stationary on hover. Natural tab widths gain 16 points to retain the centered
  name/status group, so the eight-tab full-name fixture now uses a 1440-point
  strip. Existing narrow-window scrolling behavior is retained.
- The native tab uses an 8-point regular SF cross to match the pane's small
  12-point Lucide mark. Flutter tabs and pane headers already share
  `AppIcons.closeSize`. Hover emphasis and keyboard commands are unchanged.
- Recent harnesses retain the original agent colors at 18 points. Removed the
  grayscale filter and additional opacity; names and context remain quiet.
  The canonical design system records both revised rules.
- The existing tab/welcome suites pass **20 tests**, including light/dark,
  narrow layouts, enlarged type, draft continuity, and close/select ownership.
  The isolated AppKit titlebar harness passes **1,090 checks** without opening
  windows. Scoped analysis and formatting are clean. Synthetic native and
  Flutter renders were inspected in both appearances.
- The normal macOS debug app builds and was reopened for review. Physical
  AppKit input and VoiceOver were not exercised in this small visual update.


### Coding memory owner viewer, 2026-09-30

- The existing companion DSH viewer contains a local coding library with personal
  and project records, evidence, correction drafts, dependent-forget previews and
  independent Learn/Recall settings. Its real terminal and workspace placement
  are unchanged. Existing approved lessons remain available; the 24-hour test
  action is hidden when the new development service is available.
- Forms use the shared desktop surface, typography and controls. Content scrolls
  above persistent actions. Destructive previews focus Cancel; pending requests
  disable dismissal and duplicate application. Account changes purge displayed
  evidence, while a stale correction preserves the owner's draft for comparison.
- Validation spans 94 desktop checks across the broad and targeted runs, including
  the original companion, workspace, WebSocket and experimental-toggle suites.
  Scoped analysis and the icon audit pass. Synthetic normal and 200% real-font
  renders were inspected in both appearances: [dark detail](../../docs/research/2026-09-30-memory-viewer/memory-dark-1.0x.png),
  [narrow light detail](../../docs/research/2026-09-30-memory-viewer/memory-light-2.0x.png).
- The normal macOS review build and signature verification pass; no installed app
  was replaced or launched. Native viewer interaction, physical IME and VoiceOver
  remain unverified. Human-readable project names, scope changes, per-session
  privacy controls and a delivery/usefulness view remain outstanding.
