# Harness desktop design system

The canonical system for everything around terminal panes. This supersedes
older BIOS, bracket-button and mixed desktop recipes. The user-approved
direction is the authority: refine one system, then use it everywhere.

Product names, meanings, and action labels follow the
[Naming System](../../docs/naming-system.md), shared across the OS, apps, and device.

## Character

A calm, precise Mac workspace. Content supplies the personality: an agent's
real mark, a session name, a useful preview. Surfaces organize; they do not
compete. System typography, comfortable density, consistent optical alignment,
quiet neutral controls and a deliberate blue selection are the visual language.
No ornamental gradients, noisy borders, imitation terminal forms or gratuitous
animation. Keep the live terminal, terminal font, status glyphs and native tabs.

The Spotlight references guide search hierarchy and recognizable identity.
They are inspiration, not a claim of Apple authorship or pixel-identical AppKit.

## The design brief

Harness should feel like a precise, welcoming instrument for working with agents.
The terminal is the working surface. Starting, finding and arranging work should
feel effortless around it. Opening a picker should lower the amount the person
has to think about; closing it should return them to exactly where they were.

Our interpretation of Jony Ive's published emphasis on "bringing order to
complexity" is to design these relationships before their decoration. It is not
a prediction of what he or his team would make. See the
[research and comparison record](macos-design-research.md) for primary sources.

Five decisions give this system its character:

1. **One focal point per surface.** The task in Cmd-N, the query and selected
   result in Cmd-P, the name in Rename. Configuration stays visible but quiet.
   Only the action that completes the task has a strong filled treatment.
2. **Depth has a job.** The workspace, one floating task surface, and an anchored
   child picker are distinct layers. A child menu stays attached to its source;
   its parent loses active emphasis. Opaque content protects legibility over
   busy terminals. Decorative glass, refraction and stacks of translucent cards
   are not part of this implementation.
3. **Content supplies identity.** Real agent marks and clear names carry color
   and recognition. System symbols explain actions. Text needs no extra symbol
   unless the symbol makes the action faster to recognize.
4. **Proportion is deliberate.** A short form has a short reading line. The
   space around a heading relates to the fields below it. Nested corners share
   a rhythm. Controls keep their bounds through hover, focus and press.
5. **Continuity is part of the finish.** Typing never moves its own field.
   Search scopes preserve the query. Menus open at the expected edge, dismiss
   one level at a time and return focus. Drafts survive dismissal. Immediate
   feedback takes priority over a decorative transition.

The benchmark is the relationship between surfaces, not a collection of good
looking individual dialogs. Rename and Move Pane have different content but
must clearly belong to the same application when viewed beside Cmd-N and Cmd-P.

## Bringing order to machines, agents and models

The interface follows the person's task, not the internal service architecture.
Show each decision where it changes the outcome, and disclose the next level
from the control that owns it.

| Person's decision | Visible place | Relationship to preserve |
| --- | --- | --- |
| What should happen? | Prompt, then the terminal's work | The task remains the focal point |
| Where is the project? | Project selector; machine inside its search row | A folder belongs to a machine; its path is not globally interchangeable |
| Which agent or specialized harness? | Agent selector, with its real mark | A specialized harness can run with an agent framework: “Run Blender with” |
| Which model? | Model control and its options | Available models belong to the selected agent and connection |
| What may it do? | Visible approvals control | Preserve the explicit setting; never hide a permission change behind styling |
| How is the work isolated? | Worktree and branch together | Fresh main default, worktree remembered after a successful Git launch |
| Which work am I returning to? | Session name in tabs/search, with machine/project context when useful | Session identity stays stable when its model or activity changes |

The footer describes the focused work. Creation controls describe the next
launch. Search scopes describe the result set. Do not mix those contexts or repeat
all machine, framework and model details in every row. Reveal extra context when
names are ambiguous; full values remain available to accessibility and tooltips.

## Reference decisions

| Reference | What informs this system | Harness decision |
| --- | --- | --- |
| Apple Spotlight, including the user's references | Query first; recognizable identities; a clear selected row; secondary details separated from results | Compact scope pills, real agent marks, quiet toolbar, optional preview |
| Apple design system and Materials guidance | Layout and grouping establish hierarchy; curvature relates to its container; materials separate functional layers | Shared surface anatomy and concentric geometry; legible neutral panels rather than a simulated Liquid Glass effect |
| Things' task editor | Optional detail is available without competing with the task | A prompt-led composer with calm configuration and one completion action |
| Raycast's official design/engineering account | Native quality includes placement, focus, opening behavior and responsiveness | Check interaction continuity alongside screenshots; keep the user's requested hand cursor as a deliberate Harness choice |

Capsules are a deliberate part of Harness's requested control language, not a
claim that every Mac control should be a capsule. Apple retains rounded
rectangles for dense controls. Here, action buttons and scope/identity selectors
use capsules; fields, result rows and compact icon targets use related rounded
rectangles. Consistency means the same role looks and behaves the same everywhere.

## One implementation

`AppType` owns typography. `AppPalette` owns semantic colors. `AppDesktop` and
`AppControl` own geometry, focus, selection and control dimensions. `AppMenu`
owns floating surface colors. `buildAppTheme` applies those recipes to standard
Flutter buttons, fields, menus and dialogs. `DesktopChrome` exposes the same
values to creation, search and desktop presenters; it is not a second palette.

`DesktopDialogSurface` frames every custom dialog and chooser.
`DesktopDialogHeader` provides the shared title/dismiss anatomy.
`DesktopPromptSurface` keeps form actions visible beneath scrolling content.
`DesktopPill` is the selector/scope variant of the same control family.
`AppMenuItem` is the ordinary context-menu row. Controllers, keymaps, pending
receipts, transport state and persistence remain independent of presentation.

Do not solve a local styling problem by inventing another button or palette.
Use a named role below. If a new role is necessary, define it here and in shared
tokens before adopting it at call sites.

## Type and language

| Role | System face, size, weight | Use |
| --- | --- | --- |
| Display | 28, semibold | Welcome or sign-in title |
| Page title | 20, semibold | Settings or substantial detail page |
| Dialog / section heading | 17, semibold, 1.3 line height | Rename Tab, Move Pane |
| Body | 13–14, regular, 1.45 line height | Explanations and result names |
| Control | 13, regular or medium, 1.25 line height | Buttons and menu choices |
| Metadata | 12, regular, 1.35 line height | Context, counts, explanations |
| Search / task editor | 17 / 15, regular | Cmd-P and Cmd-N |

SF system typography on Apple platforms, system fallbacks elsewhere. Monospace
is explicit for code, copyable technical identifiers and shortcut hints; it is
not the default for navigation or session context. Terminal zoom never resizes
app controls. Platform text scaling does, and controls grow rather than clip.
Buttons keep at least 6 points of padding above and below the rendered label.
The fallback workspace tab strip and Harness Store control follow these same
rules, including platform text scaling; compact terminal/status bars retain
their separate sizing contract.

Names before context. Buttons state the action: New Harness, Save, Cancel,
Open Folder, New Folder, GitHub. Use short sentence-case instructions: Enter
project name, Enter GitHub URL, Run Blender with. Standard named destinations
retain their names, such as Harness Store and New Tab. Avoid repeated labels,
internal state names, decorative punctuation and implementation details.

## Color and state

Use semantic light/dark tokens throughout. Floating surfaces share the same
neutral material (`AppMenu.fill`); fields are one step inset, not another card.
A hairline rim and soft shadow separate floating content from its background.
Avoid repeatedly drawing cards inside a dialog.

- Primary text is nearly white or nearly black. Metadata remains readable.
- Blue filled capsules identify the primary action. Blue rows identify the
  active keyboard/pointer choice; their labels and secondary text turn white.
- Focused pane rims share one solid 1-point boundary: blue for this computer,
  muted teal-gray (`AppPalette.remotePaneFocus`) for a known remote machine.
  Location is a quiet cue, with less emphasis than the local focus blue; avoid
  saturated teal, dashes, double rims or glow. The remote token is `#567C77` in
  light appearance and `#6C9691` in dark, distinct from teal text and badge ink.
  It retains at least 3:1 contrast against built-in pane grounds and workspace
  gutters. Only the focused pane carries the cue; unfocused rims stay neutral
  and waiting-question borders retain their amber priority. The footer's
  machine name supplies explicit location context alongside the color.
- A stored choice also has a checkmark. Focus and stored selection differ.
- Ordinary controls use a faint neutral fill and one thin rim. Hover increases
  the fill. Press increases it again. Focus has a stable 1.5-point blue boundary.
- Quiet inline controls beneath the creation prompt stay borderless. A subtle
  neutral fill identifies focus; Increase Contrast may add the focus boundary.
  Returning from a chooser must not leave a bright outline around the branch.
- Destructive actions use the shared danger fill or semantic error ink.
- Unavailable choices explain why and preserve useful previews. Disabled
  controls do not show a hand cursor. Color is never the only status signal.
- Increase Contrast strengthens boundaries. Reduce Motion removes optional
  motion. Live terminal content is never blurred or scaled for decoration.
- The welcome tour (first-run setup and Help ▸ Welcome Tour) has its own two
  colours: amber `AppPalette.onboardingAccent` for the kicker, the current
  pager dot and the install bar, and gold `AppPalette.onboardingTagline` for
  the tagline. Nothing else uses them; actions there stay neutral or blue.

The terminal's chosen color palette remains independent from UI focus blue.
All modal veils share one 95% token: black in dark appearance, white in light.
Cmd-N and Cmd-P must have exactly the same backdrop darkness, including coverage
of the native footer. Popovers have no independent full-window veil.

## Icons

The [icon design system](icon-design-system.md) defines the complete vocabulary,
size roles, state treatment, deliberate exceptions and audit workflow.

`AppIcons` owns one monochrome outline vocabulary: the regular (400) Lucide
family with rounded ends and joins. Use its named constants, never raw Material
icons, alternate stroke weights or text characters for app actions. A close
button always uses `AppIcons.close`; plus, search, back, disclosure, folder,
branch and check retain one silhouette everywhere.

Small pane split/zoom controls use the shared `AppPaneIcon` optical variants:
the same 24-unit grid, two-unit outline and round caps, with four-unit corners
so their rounding remains visible at 14 points. This includes Restore. The
close mark remains the unchanged Lucide ×; keep this adjustment in the shared
icon implementation, not in individual pane widgets.

Use 16-point icons beside text, 20 for standalone controls, and 24 for a feature
illustration. Center the drawing optically inside its role's target; icon-only
controls retain a 32-point target and a descriptive tooltip/accessibility label.
Workspace close marks (tabs and pane headers) are full foreground ink at rest
(`AppIcons.closeInk`, mirrored by `HarnessControlSymbols.closeInk`), weighted like
the text beside them: in AppKit the tab's × is the SF Symbol `xmark` at the
title's size and weight (13-point regular, small scale); in Flutter it is the
14-point Lucide × (`AppIcons.closeSize`), whose 1.1-point stroke matches that
text's stems. Both sit in a 28-point square target. Tabs reveal the mark on
hover, while pane headers keep it visible. Neither changes geometry on
interaction.
Use the surrounding text's semantic color. Hover changes emphasis or the shared
control fill, never the symbol, weight or position. Disabled icons stay legible
without suggesting an action. Agent, provider, service and product logos retain
their recognizable artwork; welcome recents keep the original color at a small
size so agent identity remains easy to distinguish.

AppKit-owned menus and toolbar controls use regular monochrome SF Symbols with
one shared sizing recipe, matching the system menus. Terminal text, user-chosen
Powerline symbols, activity marks and companion artwork retain their meaning;
they are content rather than competing app-control styles. Quantitative stars
use `AppRatingStar`: one rounded outline with a proportional fill. Connection
dots remain solid at their intended size; color is accompanied by status text.

## Geometry

| Role | Logical points |
| --- | --- |
| Spacing scale | 4, 8, 12, 16, 24 |
| Dialog outer radius | 20 |
| Popover outer radius | 16 |
| Field / inset row / pane radius | 10 |
| Tab upper corner / outward lower shoulder | 10 / 8 |
| Tab top inset | 6 |
| Tab close target (square) | 28 |
| Tab close target inset from outer bounds | 11 (the 8-point shoulder + one 3-point gap, equal above, below and beside it) |
| Pane close target trailing inset | 4 |
| Dialog content inset | 24 |
| Group / control gap | 16 / 8 |
| Menu inset | 6 |
| Standard / compact control minimum height | 32 / 28 |
| Standard field minimum height | 36 |
| Inline icon / search identity mark | 16 / 28 |
| Small form / destination chooser width | 460 |
| Creation composer maximum width | 680 |
| Search maximum width / height | 1120 / 680 |

Primary and secondary action buttons and scope selectors are capsules. Text
fields are rounded rectangles. Icon buttons have 32-point targets. Related
corners are concentric: an inset row is less rounded than its enclosing panel.
Widths describe content: agent 304, project 400, model 440, machine submenu 264;
all clamp to the available window. The project search grows with enlarged text
so its query and machine remain readable together. Never stretch a short list
to fill a page.

List anatomy is consistent: identity at left, name, optional useful secondary
context, then a checkmark, shortcut or disclosure at right. Text baselines and
accessory columns align. Specialized harness names need no marketing second
line. Machine menus align to the project popover's top edge with an 8-point gap,
then flip or constrain when the window has insufficient room.

## Numbers and rankings

A ranking, a score or a count is read by comparing rows, so its figures line
up and only one of them speaks. Leaderboards, team summaries, usage tables and
any later list of people or numbers use this recipe and the existing roles;
there is no number style, ranking palette or medal artwork of its own.

| Part | Role | Rule |
| --- | --- | --- |
| Rank | `AppType.label`, `FontWeight.w700`, `AppPalette.textSecondary` | A bold numeral in a fixed leading column. First place differs from tenth only by its number. |
| Emphasized number (points) | `AppType.label`, `FontWeight.w600`, `AppPalette.textPrimary` | One per row, at the trailing edge. Shown even when it is 0, so the column holds. |
| Secondary metrics | `AppType.caption`, `AppPalette.textSecondary` | Plain words beneath the name, joined by a spaced middle dot: `3 shipped · 2 unblocked`. A metric at 0 is left out; a row with none has no second line. |
| Trend | `AppIcons.arrowUp` / `AppIcons.arrowDown` at 14 points, with a caption-size number | Shape and color together: up in `AppPalette.online`, down in the theme's semantic error ink. No change shows nothing. |
| Current person | `AppSurface.selectedFill` | The sidebar's selected-row fill, not the blue keyboard selection (`AppDesktop.selection`). Text stays in ordinary ink. |

Every figure that sits in a column (rank, points, counts, percentages and
trend values) passes `fontFeatures: [FontFeature.tabularFigures()]` to its
existing `AppType` style, so digits keep one width and a column does not
shimmer as values change. Numeric columns are right-aligned at a fixed width
sized for the widest expected value; names take the remaining width and
truncate first. Row anatomy is the list rule above: rank, identity, name with
its metadata, then trend and the emphasized number at the right.

Medals, cups, trophies, flames and emoji are not icons and not ranks. A place
is its numeral. Color never carries a trend, a rank or a threshold on its own:
the arrow's direction, the number and the accessible label ("up 3 from last
week") say the same thing. Hover and keyboard focus keep their ordinary
treatment over the current person's fill, so focus stays visible on that row.

## Phone

The phone app speaks the same language at a thumb's scale. It uses the same
role names in `mobile/lib/shared/theme` (`AppType`, `AppPalette`, `AppSurface`,
`AppControl`, `AppMenu`, `AppCard`) with the sizes below. A role keeps its
meaning, color and weight on both; only the size changes, and only where this
section says so. Every other rule in this document holds on the phone.

| Role | Desktop | Phone |
| --- | --- | --- |
| Display (`AppType.display`) | 28, semibold | 34, semibold |
| Page title (`AppType.title`) | 20, semibold | 22, semibold |
| Heading (`AppType.heading`) | 17, semibold | 17, semibold |
| Body and control (`AppType.body`, `AppType.label`) | 13 | 17 |
| Metadata (`AppType.caption`) | 12 | 13 |
| Code (`AppType.mono`, `monoLabel`, `monoMeta`) | 13 / 12 / 11 | 13 / 12 / 11 |
| Touch target | 32 icon, 28 compact | 44 (`minTouchTarget`) |
| Icon beside text / standalone | 16 / 20 | 20 / 24 |
| Screen side inset | 24 (dialog content) | 16 |
| Spacing scale | 4, 8, 12, 16, 24 | 4, 8, 12, 16, 24 |
| Field / row / pane radius | 10 | 10 |
| Card / inset tile radius | 12 / 8 | 12 / 8 |
| Popover and menu radius | 16 | 16 |
| Dialog radius | 20 | 20 |
| Action buttons | capsule | capsule |

Every independently tappable control reaches 44 points. A control drawn
smaller, such as a 32-point icon button in a header, keeps its drawn size and
extends its hit area with `TouchTarget` rather than growing the row around it.
A screen's own primary action is drawn 44 points tall.

Deliberate differences from Desktop, and only these:

- Type, touch target, icon and side-inset sizes, as in the table.
- No hover state and no hand cursor. Press feedback replaces hover; focus
  outlines appear only with a hardware keyboard.
- Swarm screens set their top-bar titles in the terminal face, as the approved
  phone prototype does. Everything else on them uses the system face.
- The terminal keeps its own font, size and palette, as on Desktop.
- Bottom sheets, which Desktop does not have, round their top corners at the
  card radius (12).

The mobile style check (`scripts/check-ui-style.py`) covers `mobile/lib/swarm`
with the same rules as Desktop's Swarm code and an allowlist of its own.

## Surface families

**Titlebar dropdowns** — the avatar's menu, the bell's inbox and the other
menus a titlebar button opens are built on the shared overlay menu
(`showPaneMenu`): no modal route and no veil, the popover radius and one rim.
A click outside closes the dropdown and lands where it was aimed; Escape
closes it and returns the keyboard; choosing a row closes it; opening another
dropdown, or any titlebar action, closes it first (`dismissTransientMenus`),
and its own button closes it again. A dropdown never disables the titlebar or
dims its controls. It opens fresh: no row is lit when a pointer opened it, the
first is focused only when a key did. The Settings page is a page: the tab
row stays live over it and a click there leaves Settings, then acts. Only a
real modal dialog holds the titlebar.

**Task dialogs** — one heading, optional short explanation, fields, and fixed
trailing actions. Rename, confirmation, linking and sharing use the same type,
frame, padding and control states. Content scrolls before actions disappear.
`DesktopPromptScrollBody` shows a quiet, draggable scroll thumb when the body
overflows, including before the first scroll gesture. Text leaves 12 points of
clearance for the thumb. Short content has no visible scroll furniture; nested
editors keep their own input and scrolling behavior.

**Pickers** — the same frame and header, inset result rows and a quiet footer
with relevant keyboard hints. Move Pane uses a tab icon, destination name,
harness count and optional number accelerator. Selection uses the same blue
row treatment as search; no competing outlined selection card.

**History** — use the shared dialog header, search field and result rows.
The scope label is “This window”: these are the window's visited and closed
tabs and panes. Search receives initial focus. Tab reaches Close, and Enter on
Close dismisses the dialog without accepting a result. Results scroll and
reveal the active row without moving the search field. History keeps its
existing controller and does not add a preview.

**Cmd-P** — a prominent search field, separate compact scope pills, recognizable
agent marks and clean results. Harnesses is the default scope. Preserve typed
words when changing scope. Keep result selection stable through live updates.
Details remain in the existing optional preview. No second search index or
management implementation. Toolbar controls are secondary to the query. Keep
the editor and footer stationary while results update; do not resize the panel
on every keystroke or make short lists stretch their individual rows. On wide
windows, results take 44% and the preview 56% of the reading area. The panel
clamps to the window; narrower layouts retain their existing preview toggle.
Section headings use their natural text height with 8-point group spacing,
never a full result-row height. Loading, failed refresh and settled emptiness
are different states; keep existing results visible while refreshing.

**Cmd-N / New Tab** — one shared form and controller. Agent and project above
the “Harness anything” prompt; model, approvals and profile below; Worktree and
branch together.
The dialog is frameless over its veil. New Tab uses the same width on the page.
Agent and project capsules use an opaque neutral surface beneath their state
tints, so workspace text never shows through them. Machine stays inside the
repo search row.

**Welcome and New Tab hierarchy** — creation is primary. Show at most six rows
under “Recent harnesses”, separated from creation controls by 56 points. Use
small original-color agent marks and one muted neutral ink for names, context,
heading and timestamps. Use “now” for visits under one minute old. Context
reuses `StatusLine`, honoring the selected wording, machine/project/branch
visibility and status font, but omitting ANSI colors and segment backplates.
It is never a second renderer with a hard-coded dot separator.
A new user with no history sees the composer
without an empty recents section; initial project guidance is neutral. Keep the
workspace footer visible on empty tabs so inventory controls are discoverable
from first launch, including zero counts. Leave the right-side context blank on
Welcome and New Tab; machine/project/branch context appears when a harness is
open. Model inventory shows `—` until its first reading.
Before a creation machine is available, show “Harness anything”, a short next
step and a natural-width “Choose a machine” action. Keep that action available
while finding machines. While saved defaults load, show “Preparing your harness…”
in the same quiet hierarchy, then hand focus to the existing composer. Startup
must not leave a blank page or imply that a harness has already started.

Fresh forms focus an empty prompt. The last focused real project supplies its
machine and folder; the global last successful launch supplies agent, model,
approvals, account and worktree choice. Fresh branches default to main. Enter
submits even with an empty prompt, except during composition. Escape and outside
click dismiss the innermost picker first, then the dialog. Closing discards ordinary
edits; pending operations retain their close guards and exact recovery values.
Opening any form or preview must never start work.
The GitHub entry starts with only “Enter GitHub URL”; a valid address reveals
its clone action and an invalid submission reveals inline validation. Do not
add a duplicate example line or an empty results area beneath an empty field.

**Workspace tabs and pane frames** — tabs share one width, independent of label
length, selection and activity. Divide the available tab area
equally, capped at 256 points; shrink together down to 128 points, then scroll.
A tab area narrower than 128 points can show one clipped tab. Mirror these limits
in Flutter and AppKit. Tabs use the 13-point system control face, independent of
the status bar and terminal font. Center the name and its adjacent
status as one compact group, without permanent number prefixes. Navigation ink
follows the tab-bar surface, including beside light app content. The default label
is New Tab. A small right-hand close icon appears on hover, in the pane close
button's 28-point square target, centred on the tab's body with one equal gap
above, below and to the body's straight right side (3 points in the 40-point
row; 11 from the outer tab bounds). × is the tab's only control: Agent
Messages' 💬 that sat left of it was removed, since it was easy to hit by mistake
and turned the tab off (owner, 2026-10-12); the account's Settings ▸ Experimental
holds that switch now, off by default. At rest the name and status have the whole tab; on hover a name that would run
into × moves left only as far as it needs, then truncates, so hover never
crowds the name or status. Holding Command shows the original small shortcut
label in each tab's status slot. Release or window deactivation restores the
status; remapped and unbound shortcuts follow the current keymap. An idle tab
has no empty status slot when Command is released; its name centers
on its own. Hover never changes tab width. Long names truncate and retain a
full-name tooltip. Selection, dragging, middle-click close and the
existing keyboard commands keep their meaning.

Devices and Harness Store use compact 28-point capsules, centered in the
40-point row with 6-point vertical gutters and a 12-point trailing inset.
Keep 12-point internal horizontal padding and an 8-point icon-to-label gap.
Flutter capsules grow with platform text scaling and retain at least 6 points
above and below the label; search and New Tab keep their 32-point icon targets.

The selected tab has 10-point upper corners and 8-point outward lower shoulders,
joining the workspace along its bottom edge. It starts 6 points below the top
of the strip. Pane frames use the related 10-point radius, with a 9-point clipped
inner edge beneath their 1-point rim. Only their frame changes: terminal content,
input, selection and status typography remain the terminal's own. AppKit mirrors
these shared geometry values; Flutter uses AppDesktop directly.

Closing a tab leaves the remaining tab in its normal selected appearance.
Show a focus outline when a tab control is deliberately reached by keyboard
navigation; the temporary input hold after Close does not add one.

**Pane header** — terminal panes show agent, model and close at every width.
Splitting is revealed at the pane edges; zoom remains available through menus,
command search and shortcuts. Keep split, add and zoom icons out of the header.

Agent and model share `PaneHeaderTextButton`: plain 13-point workspace text,
regular weight, matching padding and a 28-point target height. No pill, border or
chevron. Both brighten on hover and keyboard focus without changing weight or
geometry; use a hand cursor and Change agent / Change model tooltips. Their labels
rest at 75% foreground (85% with Increase Contrast). Both selectors use 8-point
horizontal padding, matching the close glyph's inset within its target. Their
targets meet without an extra gap, leaving 16 points between adjacent contents.
The agent keeps its natural width up to 140 points; the model uses the remaining
selector space. Long names truncate with an ellipsis and show their full text on
hover, without wrapping or reducing the font size. Remove a coding-agent logo
that repeats the agent selector; keep a distinct domain-harness mark on the left.
The session name and its activity/status remain on the left.

Use the shared close mark (14-point Lucide ×, `AppIcons.closeSize`) in a
28-point target, sitting 4 points inside the header's trailing edge. It is full
foreground ink at rest (`AppIcons.closeInk`), as the tab's ×, with no fill,
border, or movement on hover or keyboard focus. Keep the controls on one
line; the session title yields first, then the model truncates while the agent
retains readable identity. Never shrink the close target.

Hovering within 44 points of the right or bottom edge reveals one 32-point
target, inset 8 points and centered along that edge. Use the rounded
`AppPaneIcon` with `AppPaneSymbol.splitRight` or `splitDown` at 16 points, not a plus. Keep the header
and corners clear and the resize gaps unobstructed. Hide edge controls while
dragging, zoomed, in a phone's single-pane view, or unable to add a pane. Hover
does not focus, resize or rebuild the terminal. Split opens New Harness directly,
inheriting the clicked pane's agent, machine,
and project; the pane is created only after submission. Clicking the model focuses that
pane and opens the same Models picker as Cmd-:. The agent name opens the shared Agents picker (`&` in Cmd-P). Selection stays bound to that
harness; a closed or replaced pane cannot receive a stale selection. Long model
names truncate and retain their full-name tooltip. Keep effort in the terminal,
and keep the icon targets clear at narrow widths. Tab-strip close behavior is
separate and remains hover-revealed.

**Focused workspace footer** — `Harnesses N`, `Machines N`, `Models N`, then subscription
icons with remaining percentages at the left; focused machine, project, branch and PR at the right.
Harnesses counts connected owned sessions, including idle and starting sessions, and opens Harness
Monitor. Machines counts linked owned computers, including this computer, and opens the `@` picker.
Models counts distinct installed local model variants across those computers, running or stopped,
and opens local models. Exclude downloadable catalog, API, subscription and shared-grid rows.
The picker and footer share cached model inventory; background reads never force a disk scan,
set up Grid, download models or create harnesses. CPU/RAM/GPU/storage remain in Monitor.

Each distinct subscription account has its own authentic provider icon and remaining percentage.
Account identity, machines, limiting window, freshness and resets stay in its tooltip; clicking
selects that subscription in Models. Percentages use neutral ink above 20%, `usageLow` amber at
6–20%, and `usageCritical` red at 5% or less. Keep positive fractions as `<1%`, zero as `0%`,
unknown as `—`. Color only the value; retain provider artwork. Omit signed-out accounts. Compact
widths preserve whole account controls and expose overflow through `+N`.

Count labels use neutral readable ink. Preserve focused context actions and the selected status face,
fields, colors and shell/Powerline treatment. Companion and sharing controls follow the count;
the companion's fixed gutter replaces the preceding control's trailing padding. See the
[status bar contract](workspace-status-bar.md). Do not repeat branches in pane headers or model/effort
in the footer. Recent-harness context uses its monochrome presentation.

**Settings, Store and supporting screens** — the same type, colors and controls
at page scale. Related settings use grouping and whitespace. Existing artwork,
terminal previews, native toolbar/footer components and domain-specific visuals
retain their meaning. Read-only loading/error views use the same hierarchy.

**macOS notification menu** — one Notifications section with up to five unread
session rows and a route to the full inbox. Use a 13-point semibold session title,
13-point message preview capped at two lines, and quiet 12-point timestamps.
The name and message are the content hierarchy. Use the same Harness activity
marks and theme colors as tabs and panes; do not add status captions or unread
dots beside them. Tab/machine context, full text and status descriptions remain
in accessibility and tooltips. Questions precede results; each kind is newest
first. Mark all read is the shared close icon in a 32-point target beside the
heading. Working starts expanded, with 28-point name/status/elapsed rows, and
is absent when empty. Its shared Braille clock only runs while the menu is
open and expanded, respecting Reduce Motion. The unread count excludes work in progress. Use
native menu selection and system colors; no inner cards or decorative borders.
Settings stays in the application menu; this menu ends with Show Harness and Quit.
Pane-resize guidance is app navigation: use the shared popover surface, system
type and wrapping keyboard hints. It must not look like terminal output.

## Interaction and review

Every clickable element has a hand cursor, every editor a text cursor.
Settings controls expose purpose, current value and state to accessibility;
neighboring explanatory text alone is not an accessible label. Do not merge
multiple actions into a single settings row. Short popovers use their measured
content height, including enlarged text, before applying the window height cap. Standard
editing, IME, keymap remaps, focus traversal and focus return remain intact.
Pending selectors must be unavailable to pointer, keyboard and accessibility
activation together. A queued selection cannot change an operation's target;
failure or cancellation restores the original control and permits retry.
Opening a modal isolates the workspace and native footer in the accessibility
tree. A late reply cannot restore a dismissed form or act on a different pane.

Review actual system-font renders in both appearances, narrow/short windows,
160–200% text, long names, empty/loading/error states, changed live data and
Increase Contrast. Exercise mouse, keyboard, nested dismissal, drafts and
composition. Use synthetic review data, not real agent launches or permissions.
Inspect the rebuilt app; widget tests alone do not prove native VoiceOver or
physical IME behavior. Record evidence and limitations in the migration ledger.

## UI checklist

Every pull request that changes UI pastes this into its description and ticks
what it checked, or says why an item does not apply:

```text
UI checklist (desktop/design/desktop-design-system.md)
- [ ] ASCII mockup confirmed by the requester before visuals were built
- [ ] Named roles only (AppType, AppPalette/AppSurface, AppDesktop/AppControl,
      AppIcons); scripts/check-ui-style.py passes and its allowlist only shrank
- [ ] Numbers follow Numbers and rankings: tabular, right-aligned, one
      emphasized number, zeros hidden, no emoji or medals
- [ ] Color is never the only signal; a trend or state also has a shape or words
- [ ] Light and dark, 160–200% text, long and missing names, empty, loading and
      error states, with screenshots
- [ ] Phone: Phone table sizes, 44-point targets, differences from Desktop listed
- [ ] Copy follows the Naming System
- [ ] Keyboard, focus return and hand cursor (Desktop)
```

`scripts/check-ui-style.py` runs in CI for `desktop/lib/super_tabs` and
`mobile/lib/swarm`. It fails on a new `Color(0x…)`, Material `Colors.*` other
than transparent, numeric `fontSize`, `EdgeInsets` with a number, or numeric
`BorderRadius.circular` outside theme folders. Fix the call site with a role;
when a count falls, run `python3 scripts/check-ui-style.py --update` and commit
the smaller allowlist. Each area keeps its list in
`scripts/ui-style-allowlist/<area>.json`. The update never raises a count, and a
pull request whose allowlist records more than its base branch fails.

## Standard of finish

This specification establishes a direction, not an award or a quality score.
The work is ready for visual review only when:

- Cmd-N, Cmd-P, Rename, Move Pane and an ordinary menu are reviewed together,
  in both appearances, at normal desktop scale. None uses a competing recipe.
- The first intended action is obvious without reading a paragraph. Secondary
  settings are discoverable without turning the main surface into a dashboard.
- Optical alignment, text baselines, icon weight, nested corners and empty space
  hold up with short, long, missing and changing content.
- Hover, focus, stored selection, unavailable and error states stay distinct;
  small text remains readable. Enlarged text receives space instead of clipping.
- Opening, typing, scope changes, child menus and dismissal feel continuous in
  the running app. An attractive still image is insufficient evidence.

Remaining defects and unverified platform behavior belong in the review ledger.
Do not describe the implementation as flawless, Apple's design, or the best Mac
design system. Let the functioning app and the user's review establish its quality.
