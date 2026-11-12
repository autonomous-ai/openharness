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

Six decisions give this system its character:

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
6. **People are celebrated.** The terminal is calm; the team is warm. When
   someone ships, unblocks a teammate or takes #1, Harness notices once,
   specifically, and with a smile. Celebration is earned, brief, and never in
   the way of work. See [Team and celebration](#team-and-celebration).

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
`AppMenuItem` is the ordinary context-menu row. A row that stands somewhere
says so in one word at its far end (`state`: `fails`, `not run`), 12 and faint,
in the error ink when it failed, and in the active row's detail ink on blue; a
`trailing` widget keeps its own colours and is not for a word of state. A
dropdown's search finds a row by that word too.
`AppDropdown` is every
dropdown: however a click or a key opened it, the control that opened it holds
focus, and Escape closes the menu from there and leaves focus on the control (on
a submenu's own row it closes the submenu first). Controllers, keymaps, pending
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

All copy is sharp, not only empty states (anh Dee, 2026-11-07, task #4465):

1. **One idea per line.** No line runs past one short sentence unless someone
   asked for an explanation.
2. **Buttons are one or two words, verb first:** Accept, New agent, Join.
3. **Labels and notes are a few words.**
4. **Cut filler:** please, you can, just, simply, currently, in order to,
   will appear here.
5. **Say it once.** Never repeat what the screen already shows.
6. **Errors say what happened and what to do**, in two short sentences at
   most.

An empty list or pane says nothing (Swarm elements, rule 7).

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
The chat's picture viewer is the one exception: `AppDesktop.mediaVeil`, a
see-through black in both appearances, with its own white ink and control fills
(`mediaInk`, `mediaInkMuted`, `mediaControl`, `mediaControlHover`), because a
picture reads best on dark.
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
| Sidebar row gap (`listRowGap`) | 2 |
| Count badge: capsule, text inset from its ends (`badgeInset`) | 5 |
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
| Chat and thread message avatar (rounded square) / corner | 36 / 8 |
| Above a new sender in the chat / above its name | 16 / 8 (group / control gap) |
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
there is no number style or ranking palette of its own. Marks that celebrate a
place, such as the #1 crown, follow [Team and celebration](#team-and-celebration).

| Part | Role | Rule |
| --- | --- | --- |
| Rank | `AppType.label`, `FontWeight.w700`, `AppPalette.textSecondary` | A bold numeral in a fixed leading column. First place differs from tenth only by its number. |
| Emphasized number (points) | `AppType.label`, `FontWeight.w600`, `AppPalette.textPrimary` | One per row, at the trailing edge. Shown even when it is 0, so the column holds. |
| Secondary metrics | `AppType.caption`, `AppPalette.textSecondary` | Plain words beneath the name, joined by a spaced middle dot: `3 agents shipping · Level 3`. A metric at 0 is left out; a row with none has no second line. |
| Trend | `AppIcons.arrowUp` / `AppIcons.arrowDown` at 14 points, with a caption-size number | Shape and color together: up in `AppPalette.online`, down in the theme's semantic error ink. No change shows nothing. |
| Current person | `AppSurface.selectedFill` | The sidebar's selected-row fill, not the blue keyboard selection (`AppDesktop.selection`). Text stays in ordinary ink. |

Every figure that sits in a column (rank, points, counts, percentages and
trend values) passes `fontFeatures: [FontFeature.tabularFigures()]` to its
existing `AppType` style, so digits keep one width and a column does not
shimmer as values change. Numeric columns are right-aligned at a fixed width
sized for the widest expected value; names take the remaining width and
truncate first. Row anatomy is the list rule above: rank, identity, name with
its metadata, then trend and the emphasized number at the right.

The Desktop left pane's Top Teams has no rank number and no crown: it is the
Leaderboard in short, its people most points first with their points at the
right ([Swarm left pane](#swarm-left-pane)). There, as the one exception to the
table, points are the row's quiet detail: 12, tertiary, tabular.

The Leaderboard (`SuperTabLeaderboardPage`,
`super_tabs/leaderboard/leaderboard_page.dart`) ranks people by how many of
their agents ship (`docs/plans/2026-11-09-swarm-v4-leaderboard.md`). The bar
above it names it; its header is two `ToolbarPill`s, This week and All time,
the one shown tinted, each label centred in its pill, and Refresh ending on the
rows' right edge. Each row is the recipe above: the place, the
top three's mark beside it, the face, the name with `You` for the reader, the
second line `3 agents shipping · Level 3`, and the points to one decimal
(`4.2`), as the server rounds them. A computer of the reader's own that could
not read GitHub shows above the rows as one caption line in
`AppPalette.textSecondary` after `triangleAlert`: `Mac Studio · GitHub signed
out`. Only its person sees it, and the numbers stay. While the first read is on
its way, three skeleton rows hold the place; a failed read keeps the board shown
with the reason and Retry, and writes its name (`OFFLINE`, never the server's
words) to the app log; an empty board shows nothing. Top Teams and the page
show one board, read when the Swarm shows and every five minutes while it does.

A place is its numeral; a celebration mark sits beside it and never replaces
it, as [Team and celebration](#team-and-celebration) describes. Color never
carries a trend, a rank or a threshold on its own: the arrow's direction, the
number and the accessible label ("up 3 from last week") say the same thing.
Hover and keyboard focus keep their ordinary treatment over the current
person's fill, so focus stays visible on that row.

## Team and celebration

Harness is used by teams, and the work is done by people. The design gives
them their due without disturbing the work.

**Two registers.** Instrument surfaces (terminals, panes, tabs, pickers,
dialogs, the footer, Settings) stay calm: everything above applies unchanged
and nothing there celebrates. Harness's own UI uses no emoji on instrument
surfaces; what people and programs write shows as written. Team surfaces (the
leaderboard, the people list and the project chat) are where people appear, and they
may be warm: they may name a moment, carry a mark and smile in their words.

**Earned, not ambient.** One real event earns one moment: a person ships,
unblocks a teammate or takes #1. Harness notices it once, where the team
already looks, and then it becomes history. No looping confetti, no modal, no
sound unless the person turned sounds on, and nothing that takes focus or
blocks the next action. A celebration is optional motion, so Reduce Motion
removes its movement and keeps its words.

**Specific.** Name the person and the thing: "Mai shipped the machine
picker", "Lan unblocked Bao on the phone build", "Mai is #1 this week".
Never "Great job!", "Awesome!" or praise that would fit anyone. The words
follow the [Naming System](../../docs/naming-system.md) like any other copy.

**Ranks still line up.** The #1 crown sits beside #1's name, after the rank
numeral where a list has one (the left pane's People has none); it never
replaces the numeral and never moves the columns. Rank,
points and counts keep [Numbers and rankings](#numbers-and-rankings): tabular
figures, fixed columns, one emphasized number. A row with a crown is exactly
as tall as a row without one.

**Badges are content artwork**, like agent marks: each has its own colors, a
name and one line saying how it was earned ("First pull request merged"). They
are not app icons and do not join the `AppIcons` vocabulary. A new badge is
announced once in the project chat, naming the person and the badge, and is
not repeated.

**Every mark has words.** The crown, a badge or a celebration message carries
an accessible label that says what it means ("Number one this week", "Badge:
First pull request merged"), and color or artwork never carries that meaning
alone.

## People and conversations in lists

Lists of projects, groups and people (the sidebar, the project chat, the
leaderboard) share four rules.

- **Unread.** Goal: see what changed without a second signal to decode. An
  unread project or group shows its name in bold, with no dot beside it.
- **Asks you.** Goal: tell "something changed" apart from "someone needs
  you". In Swarm v4 an agent reaches its person only in its own chat: an
  agent with something new there asks you. Its Your Team row is bold, and the
  Swarm's tab, the Swarm list, the Dock and the menu bar count those agents
  (`superTabAgentsAsking`, from read marks). No row carries an `@N`.
- **Status column.** Goal: compare status down the list at a glance. Status
  marks use the shared activity vocabulary (see the
  [icon design system](icon-design-system.md#deliberate-exceptions)) and sit
  in a fixed trailing column, last on rows that show status (agents,
  conversations). Ranking rows have no
  status mark and keep the points number last. Names and marks keep their
  positions as status changes.
- **Names.** Goal: recognize teammates the way they know each other. People
  show as usernames, by default the prefix of their email address
  (`mai@example.com` shows as `mai`); full identity stays available to
  tooltips and accessibility.

## Swarm elements

Goal: every element in a Swarm looks like it came from one hand, Apple-quality
and never random (anh Dee, 2026-11-07, task #4461). Each element below has one
implementation; a screen uses it and never draws its own. The gallery
(`test/swarm_elements_gallery_test.dart`) draws every one in light and dark,
each section against its own images,
`test/goldens/swarm-elements/<section>-{light,dark}.png`, so a pull request
that changes one element changes only its section's images. It holds each
element to its own area: a face or ring may barely differ, an icon or letter a
quarter of its box, and nothing else outside the words more than 38 pixels
of its section's image.

Seven rules hold the whole Swarm screen to minimal, clear and quiet, with less
on it (anh Dee, 2026-11-07, task #4465). Every element below follows them.

1. **Grey everywhere; colour only on agent faces.** Grounds, text, rules and
   controls take the neutral ramp. The faces and the Lead ring are the colour.
2. **Blue only for the main action; red only for failed.** One filled blue
   action per surface; the semantic error ink only for what failed.
3. **Three text sizes: 14 chat, 13 names, 12 details.** Messages are 14,
   names and controls 13 (`AppType.label`), every detail 12
   (`AppType.caption`). In lists, bold means unread and nothing else.
4. **Every row: face, name, one quiet detail on the right.** One detail, in
   12-point `AppPalette.textFaint`; anything more waits for hover or a menu.
5. **Dropdowns stay plain text until you hover.** At rest a dropdown is its
   value in quiet text; hover, focus or an open menu brings the chevron and
   the primary ink. The chevron's room is kept at rest, so hover moves nothing.
6. **If it doesn't help you decide, it's gone.** A line that only describes
   (a subscription, a machine, what an agent can read) leaves the screen; its
   full value stays in menus, tooltips and accessibility.
7. **Empty means empty.** An empty list or pane shows nothing, or only the
   action that fills it (such as + New agent). Words stay only when they help
   someone act: why something can't be used and who can fix it, or an error.
   "None yet", "No tasks yet", "Nothing here yet", "Start the conversation."
   and the like are not drawn. The gallery draws each element empty.

- **One surface.** The left, middle and right panes share one ground,
  `AppPalette.swarmField`, the colour the selected native tab joins. Only the
  layout's 1-point `AppDesktop.rim` hairlines split them. `SuperTabView` paints
  it under all three, so no pane shows its host's colour. A pane opened beside
  the chat or in its place (Info, Instructions, Browser, Tasks, a task, a
  thread) stands on that ground too, never a white sheet of its own
  (`test/swarm_pane_room_test.dart`). A palette the person chose that names its own sidebar (Plum)
  keeps it.
- **Top bar.** An agent's chat (Swarm v4, anh Dee 2026-11-08) has one bar, as
  high as the channel's: the 22-point face, the name in 13-point medium, then
  where it runs and its engine, `Mac Studio · Claude Code`, in 12-point
  metadata grey. The name takes the room it needs up to two thirds of what the
  icons leave, then is cut with "…"; where it runs takes what is left, cut the
  same way: a long name, even 60 characters, never pushes an icon off the bar.
  At the right three icons: Info (`AppIcons.info`) opens what the app knows of
  it, Instructions (`AppIcons.fileText`) opens `agents/<name>.md`, and
  Terminal opens its terminal, each with its own header and ×, beside the chat
  or in its place (Panes beside the chat). Every running agent on one of the
  person's own computers has a fourth after Terminal, Browser
  (`BrowserButton`, `AppIcons.globe`), selected while its panel is open, with
  or without a browser. While its browser runs (`ready`), a 6-point dot in
  `AppPalette.online`, the connection dot's green, sits at the glyph's top
  right; the tooltip stays `Browser` and its label reads `Browser, running`.
  A computer shared with them, a stopped agent, the web build and Windows draw
  none. In a window under 720 the list of
  conversations is behind a Conversations button that starts the bar, as a
  project's bar has it.
- **Panes beside the chat.** An agent's Instructions, a project's Tasks and
  the task opened from them open beside the chat at equal width, half and
  half, from a window 1080 wide (each half at least 390), and a terminal from
  1260: it needs about 480, and the left pane's 300 and two halves of 480 make
  1260. Narrower, the pane takes the chat's place, under the same bar, and a
  `Chat` pill (`SwarmBackToChat`: a compact quiet pill with a left chevron,
  one word, in the gallery) leads back to the chat, its composer ready to
  type; it closes only what is in the chat's place, so a pane beside stays.
  The bar's own icon, or the pane's ×, closes it as well. A pane comes before
  a terminal in the chat's place, as it does in the right pane. A task's
  thread opens as a drawer over the chat below 1080, as before. What is typed
  in Instructions, and what Tasks and a task have read and where they are
  scrolled, stay while the window narrows and widens. The window is never
  under 880, and every pane opens at 880x560, 1024x700 and 1280x800, in place
  or beside (`test/swarm_pane_room_test.dart` opens each of them at those
  sizes).
- **Instructions** (`SwarmAgentInstructions`, `super_tabs/agent_instructions.dart`).
  The agent's file `agents/<name>.md`, titled by it in 13 medium, read from the
  computer the agent runs on over the encrypted link between this account's
  computers (`SwarmInstructionsLink`), never through GitHub or the server (anh
  Dee, 2026-11-09: some people keep it out of git). Its person reads it in
  `AppType.mono` and changes it here: `Edit` (a compact `DesktopPill`) turns
  the text into a field, and `Save` and `Cancel` take its place; Save waits for
  a change. An empty own file says so in one metadata line, whatever else the
  folder holds: `Empty for now. Tell Faye how you want it to work, and it
  writes it down here.`, and its field, typed into, starts on the hint `Rules
  for Faye, as you would tell it. It reads them at every start.` (anh Dee,
  2026-11-10: Arlo's empty file read as the project's long AGENTS.md, and Edit
  as a blank page). Under the agent's own file, after a hairline and the
  metadata heading `From its folder`, read only, is what else instructs it in
  its folder (anh Dee, 2026-11-10: Faye's, in lampOS): the project's
  `AGENTS.md` and `CLAUDE.md`, as that computer sends them, each folded to a
  row of its name in 13 medium (its path when it sends one) and its size in
  metadata grey (`212 lines`) with a `chevronRight`; a click opens it to its
  text in `AppType.mono`, selectable, with `Cut at 64 KB.` in metadata grey
  after a text it cut, and folds it again. A file with the text of one above
  it (a `CLAUDE.md` linked to `AGENTS.md`) says `Same as AGENTS.md.` in place
  of its size and has nothing to open. A
  file it did not show gets one metadata line (`CLAUDE.md is a link.`,
  `CLAUDE.md isn't text.`, `../AGENTS.md isn't shown: too much text.`), in its group. An older computer sends
  none: the agent's own file alone. After the folder, each under its own metadata heading after a hairline,
  read only and folded the same way, is the rest of what goes into the agent (anh Dee, 2026-11-11: "show
  users what goes into the agent. and what they can edit"): `From Harness`, one row `Swarm basics`, the
  text Harness starts it with for its part, which its computer's Swarm service gives (`basics`); and `From
  Mac 3`, its person's own file there that its engine reads for every session (`~/.claude/CLAUDE.md`,
  Codex's `~/.codex/AGENTS.md`, named by its path). Last, after a hairline, one metadata line for what the
  engine's maker tells it first, which nobody sees or changes here: `And Claude Code's own instructions,
  from Anthropic.` (`And Codex's own instructions, from OpenAI.`). Only the agent's own file has Edit. A
  computer from before them sends neither group, and the last line still shows. Edit, Save and the 64 KB limit are for the
  agent's own file: while it is typed it has the pane to itself, and the
  others are back after Save or Cancel. A read the computer refuses for the
  agent's own file still shows them, under its one line. A save names the
  version it read, so a change the agent made
  meanwhile is refused (`It changed on Mac 3. Close it and open it again.`)
  and the typed text stays. A computer that cannot be
  asked says what to do in one line, with a retry icon: `Update Harness on
  Mac 3.`, `Update Harness on this computer.`, `Mac 3 is offline.`, `Faye isn't
  running on Mac 3.`, `agents/Faye.md on Mac 3 isn't a plain file.` Nothing is
  sent unless both that computer's daemon and this one's (which seals the
  request for another computer) report `agentInstructions` among their
  features: an older one would send a save in the clear. A save whose answer
  was lost and is made again is read back, and counts as saved when the file is
  what was typed. When the file changed meanwhile, the new version is taken, the
  typed text stays and a second Save replaces it on purpose (`It changed on Mac
  3. Save again to replace it.`). A text over 64 KB (bytes, not characters) is
  refused as it is saved, with nothing sent and nothing cut. A computer another
  account shares is never asked, and a daemon not heard from yet is waited for
  (`This computer isn't ready. Try again.`), not taken for an old one. The
  header's buttons (Edit, or Cancel and Save), then the ×, end at its right
  edge; the title takes the room before them.
- **Info** (`SwarmAgentInfo`, `super_tabs/agent_info.dart`). The bar's first
  icon (`AppIcons.info`, `Info`) opens what the app already knows of the
  agent, beside the chat or in its place as the other panes: one row each, a
  12-point grey label in an 88-point column and its value in 13 points:
  `Owner` (its person), `Project` (`lampos · PM` or `· Builder`, one line per
  project), `Computer` (`Mac Studio · online`), `Engine` (`Claude Code`, else
  the app's name for it, `OpenCode`), `Model` (`Opus 5.5`), `State` in the
  words its line and the roster use (`Working`, `Idle`, `Needs input`,
  `Limited until 14:00`, `Offline`), `Task` (`#5759` and its title: the issues
  of its projects' boards that are taken and labelled for it, read with the
  board's own reader, shown at once from what it read last and read again on
  opening and each minute while Info is open), `Folder` in `AppType.mono`, and
  `Workspace` in `AppType.mono` below it for an engine whose tools work
  somewhere other than the pane's folder (OpenClaw).
  A row the app has no value for is not drawn; a board that cannot be read
  puts GitHub's reason in the Task row, under the tasks it held when last
  read, so they never read as current. Its text can be selected. Info,
  Instructions, Terminal and Browser are one at a time: each closes the others.
- **A stuck terminal** (`SwarmTerminalButton`, `super_tabs/terminal_button.dart`).
  While an agent's terminal waits on its person, its chat bar's Terminal carries
  a red `1` (`SuperTabCountBadge`) over its top right corner, as a notification
  does, and its tooltip reads `Terminal · waiting on you`. Waiting is a question
  on its screen, as its computer's daemon tells this Desktop, or a prompt its
  computer has seen it sit on for 3 minutes (`SuperTabAgent.atPrompt`, the
  backend's `alerting`). The badge is drawn only; the button is what is pressed.
- **Set up Browser** (`BrowserSetupPrompt`, `browser/browser_setup_dialog.dart`).
  The Browser panel's Install, on a computer with no Podman, asks once in the
  shared prompt (`DesktopPromptSurface`): the title in the dialog heading, then
  `Installs Podman on this computer to run the agent's Chrome. Asks for your
  password once. About 15 minutes, 3 GB.` in 13 body, `Podman on this computer
  won't start. Harness will set up its own.` on its own line when its Podman
  machine will not start. `Cancel` and the blue `Install`: Install starts the
  setup; Cancel does nothing.
- **Browser panel** (`BrowserPanel`, `browser/browser_panel.dart`). The agent's
  own Chrome, beside its chat or in its place as the other panes. Its header is
  `Browser` in 13 medium, then Stop (`AppIcons.circleStop`, tooltip `Stop`,
  an `AppIconButton` as the gear is, never a bare square, which is an
  unticked box and Maximize; there in every state while the browser is on, a
  failed one too, with no confirmation), the gear (`Browser settings`, which
  opens them in the panel, off too), Paste (`AppIcons.clipboardPaste`, which
  sends the clipboard's text, only while the screen shows) and ×. × only
  hides the panel: the browser runs on. Off, one centred line in 13, `A sandboxed Chrome the agent
  drives`, and the blue `Start` under it. Ready, the screen fills the panel:
  the bundled noVNC page in the native webview, which the person uses as the
  agent does. It shows Chrome's window at 1:1, and the window follows the
  panel: the panel asks the computer for its size when the screen opens and
  300 ms after the panel last changed size (at most the Device setting's
  screen). Only a window that is not the panel's size (one Chrome would not
  make that narrow, too, or another Desktop's), or one the computer could not
  size, is scaled to fit. While it sets up, four lines in 13, `Podman
  installed`, `Starting Podman…`, `Building browser`, `Starting browser`, each
  after a mark as Import's steps have: ticked when done, a small spinner on the
  current one, an empty circle (and the line muted) for those to come.
  Starting, the spinner over `Starting browser…`. From the person's Stop
  until the computer says the browser is off, the same spinner over
  `Stopping browser…`, never the starting line; a Stop the computer did not
  take, or took and still shows on 20 s later, goes back to what the browser
  shows. Otherwise one centred line in
  13 with at most one blue button under it: the failed states' words (`Podman
  is not running` and Retry, `Browser isn't set up` and Install on that
  computer, `Set up Browser on Ken Mac first` from another, `Browser data
  can't be read` alone) and the panel's own: `Browser is slow here` and Retry,
  `Browser lost its connection` and Retry (after the panel's one silent
  reconnect), `Browser is open in too many places`, `Only its owner can open
  this browser`, `Reconnect this machine to open its browser`, `This computer
  can't show the browser`. A request the computer did not take adds one 12
  grey line under what the panel shows: `Update Harness on Mac Studio first`
  from an older Harness, `Browser doesn't run on Windows yet`, `Only its owner
  can open this browser`, any other `Browser isn't available on Mac Studio
  right now`. The gallery draws the button plain, open and running, and the
  panel off, running, failed and stopping.
- **Browser settings** (`BrowserSettingsPage`, `browser/browser_settings_page.dart`).
  Inside the agent's Browser panel, read from and saved to the agent's
  computer only. `‹ Browser settings` (a compact quiet `DesktopPill` with a
  left chevron) leads back. Under `Proxy`, 12 grey: the scheme (HTTP, HTTPS,
  SOCKS5) in an `AppSelectField`, host and port, username and password
  fields, then `Remove`, `Test` and the blue `Save` at the right. A saved
  password is never sent back: its field is empty, with dots as its hint,
  and it is sent only once a new one is typed. Test's answer is one 12 grey
  line under the buttons, `Proxy works · 203.0.113.7 · Asia/Ho_Chi_Minh` or
  `Proxy is not reachable`, gone at the next proxy edit. Then rows, a 12 grey
  label in a 96 column and its control: `Time zone` (a field, `Auto` when
  empty), `Language`, `Screen` (three portrait sizes, `1080 × 1920` the
  default, as the panel is taller than wide, then five landscape ones,
  `1920 × 1080` first; a size only a newer computer offers is kept, last),
  `Human input` (a ticked square, as Worktree's, never a blue switch: blue is
  Save's, and the speed beside it, dimmed while off). `Advanced` (a quiet pill with a
  right chevron, down when open) holds `Device`, off by default, `GPU, CPU,
  memory` beside it in faint, and when on four fields for what to report.
  Save waits for a change and for every field to be valid. A failure is one
  12 grey line under the header: `Only its owner can open this browser`,
  `Reconnect this machine to open its browser`, `Update Harness on Mac
  Studio for this screen` when an older computer refuses a portrait screen,
  or for another save the machine refused, `Browser settings weren't saved.
  Check them and save again.`
- **Agent face.** An agent with no chosen picture wears a face
  (`SuperTabAvatarFace`, `avatar_art.dart`) in rows, cards and chat:
  a round disc with a soft top-to-bottom fill, two eyes and a small smile.
  Everything comes from the FNV-1a hash of the trimmed, lowercased name, so a
  name draws the same face on every computer. The fill is
  `SwarmPalette.faces[hash % 8]`, top to bottom: coral hsl(14 86% 72%) to
  hsl(10 76% 62%); apricot hsl(38 92% 70%) to hsl(32 84% 59%); sage
  hsl(146 46% 64%) to hsl(150 42% 52%); teal hsl(178 44% 60%) to
  hsl(182 48% 48%); sky hsl(206 82% 70%) to hsl(212 72% 59%); periwinkle
  hsl(238 72% 76%) to hsl(242 60% 65%); lilac hsl(274 60% 76%) to
  hsl(278 48% 64%); rose hsl(334 76% 76%) to hsl(338 66% 65%). On a 100-unit
  disc, in ink `#221F29` (`SwarmPalette.faceInk`): eyes are ellipses at
  (36,45) and (64,45) with radii 5.2 and 7; the mouth is a quadratic curve
  from (37,62) through (50,74) to (63,62), stroke 5.6, round caps. Eyes and
  mouth shift sideways by `[-3,0,3][(hash>>9)%3]` units and tilt around the
  centre by `[-9,-4,0,5,10][(hash>>5)%5]` degrees. The face is artwork: the
  same in light and dark, and always a disc. A chosen picture still wins.
- **Person avatar.** A person keeps their photo or preset, else an initial on
  a neutral grey disc (task #4466); a person never wears an agent face.
- **Lead ring.** A Lead (a PM) wears a thin gold ring, hsl(42 92% 58%)
  (`SwarmPalette.leadRing`), around its avatar: stroke 5% of the face's
  diameter, gap 7%, drawn outside the avatar's box so no row moves. Its
  accessible label says Lead. The crown is only number one's on the
  leaderboard.
- **Left pane row.** The left pane's row (`SuperTabQuietRow`,
  [Swarm left pane](#swarm-left-pane)) carries the elements above at its
  shipped size; its size and layout do not change when an element does.
- **Task board** (`SwarmTaskBoard`, `super_tabs/task_board.dart`). A task is an
  open GitHub issue of its project's repository (anh Dee, 2026-11-09), read
  with `gh` on this computer as its person (`super_tabs/github_issues.dart`),
  so each person sees what github.com shows them. The Tasks icon in the
  channel's bar opens the board beside the channel at equal width: three
  columns, To do (nobody has it), Assigned (its `builder:<name>` label names an
  agent) and On it (its `status:taken` label), each headed by its name and
  count, newest activity first; a narrower pane scrolls sideways (a column is
  140 wide at least, so all three show beside the channel in the 1280 window the
  app opens in). A card is a hairline (`DesktopChrome.rim`) at radius 12
  on `cardBg` and holds what github.com's list shows: the issue's number in a
  grey capsule (`AppSurface.recess`, 12 metadata), its title at the text's size in semibold (`SwarmType.boardTitle`) on
  up to three lines, its labels as chips in their own GitHub colour (the first
  four and a `+N`; `SwarmLabelChips`: the colour at 18% behind it, its
  lighter shade as text in dark, its darker in light), then who opened it and
  how long ago (`69tc · 6h`, with the face of the agent its builder label names
  before it) and, at the right, how many comments it has (a speech bubble and
  the count, none for no comments). A task with an open pull request (one
  that closes it, "Closes #14", else one on its builder's branch for it,
  `pip/14`) shows it at the card's top right, or under the task's number when the column has no room for both whole (`SwarmPullChip`,
  `super_tabs/pull_chip.dart`): the pull request's icon, number and one word in
  a capsule of its colour at 14%, by the rule Harness merges by
  (`super_tabs/github_pulls.dart`): Draft and Checks (running) in muted grey,
  Review (green checks, no READ-OK on its head yet) in the accent, Failing and
  Conflict in the error red, Held (a reader's last word is a HOLD) in `warn`,
  and Merging (a READ-OK on its head from someone other than its builder, two
  for TWO READS, checks green; from the login that opened it only one signed by
  another of the Swarm's agents, as Harness merges) in `online`; in a narrow column the word
  shortens, never the task's number. No pull request, no chip. The open pull
  requests are one GraphQL read after the issues (the newest 50), and a read
  of them that fails keeps the last chips. The board shows what it last read at once
  and brings the rest: the newest hundred first, then the others, but only
  where nothing shows yet: a list already shown stays whole while a refresh is
  read, one refresh at a time. While the app is hidden (minimized or fully
  covered) or its page is not showing, the board and an open task read nothing
  on their clocks; back in sight they read at once if their minute has passed
  (`VisibleTick`). A refresh that fails keeps the cards and says
  why in the bar, in 12 metadata grey on up to two lines, with a retry icon (`Try again`).
  A card opens its issue in the board's place (`SwarmIssuePanel`,
  `super_tabs/issue_panel.dart`), titled by its number, with Open in GitHub:
  its title, its agent, state and who opened it, its labels, its open pull
  request as a row (the chip, its title and branch, and Open, which goes to it
  on GitHub; a tap on the row opens the pull request's own chat in the task's
  place, and closing that goes back to the task), then its text and
  comments as posts, each under the face and name its first words sign it with
  (`Migrate, 09:3x: …`) and its GitHub login. It reads the newest 30
  comments; the rest are one tap away (`1,546 earlier comments` and Show,
  100 at a time), because reading all of lampOS #5385's 1,576 took 22 s. A
  later read joins what is held when its newest comments start at one of them,
  else it stands alone: a gap is never hidden. The header says `opened now` or
  `opened 5m ago`. A project with no GitHub repository says so in one line; a failed read says
  what to do (`Sign in to GitHub: run gh auth login.`; `GitHub is limiting
  requests. Wait a few minutes.` when GitHub's rate limit answers, and
  then no `gh` runs for two minutes, whatever asks; `Authorize gh for this
  organization's SSO: run gh auth refresh.` when SAML does) with a retry.
- **Pull requests** (anh Dee, 2026-11-10: "it has its own comments on PRs").
  Beside the Tasks icon, ⑂ (`gitPullRequest`) opens the project's open pull
  requests in the same pane, titled Pull requests, as GitHub has Pull requests
  beside Issues; each icon shows its list, or closes the pane when it already
  shows it, and no tab switches them. Three columns, newest activity first, by
  who acts next, as lampOS's train bot sorts them each round (`train-bot.sh`
  `eligible`): To read (no READ-OK on its head yet: a reader), To fix (a HOLD,
  a failing check or a conflict, or still a draft: its builder) and Merging
  (read, its checks running or green: Harness merges it). A card holds its chip
  (`#5770 Merging`), its title on up to three lines, and its agent's face with
  its branch and last activity. Harness's train (`Train: #5770`, on a
  `harness-train/` branch) carries pull requests already read: it is under
  Merging with no face, and its chip says Checks, Merging or Failing. They are the newest 50 the board reads for its
  chips, those that are no task's included: of lampOS's last 197 builder pull
  requests, one was linked to an issue. A card opens the pull request's own
  chat in the list's place, the task's panel reading its pull request:
  titled by its number, its branch and chip (`Merged` or `Closed` once it is
  not open), its text, its comments, and its reviews among them by time, each
  with its verdict (`Approved`, `Changes requested`, `Review`) and line
  comments with their place (`rows.py, line 40`); its merge is one quiet
  centred line (`Merged · 16:02`). The same read brings them: the newest 30
  comments (the rest a tap away), 30 reviews and each review's first 20 line
  comments. Read only, as a task is: agents write on GitHub.
- **Machines** (`SuperTabMachines`, `super_tabs/machines.dart`): Manage ›
  Machines in Swarm v4 (the lead for anh Dee, 2026-11-11), on the Swarm's
  ground. The Machines tab names it, so it has no title of its own: one
  metadata line of the counts a person acts on (`2 online · 1 offline`; a
  count at 0 is left out), then the search field and the blue `Add machine`.
  The reader's own computers sit under `Yours`, then `Online`, `Asleep`,
  `Status unknown` and `Offline`, each a 12 `textSecondary` heading in
  sentence case; an empty group has none. A row is the connection dot, the
  name in 15 semibold primary, its owner (`This machine` for this one) and,
  when it is not online, when it was last seen, in metadata grey, and at the
  right what its disk has free in 12 faint (`200 GB free`; nothing without a
  reading). No badge, no blue row, no filter chips, no note on the order and no
  disk bar. A click opens its readings and agents beneath it; a machine with no
  agents says nothing of them.
- **Project menu.** A project's channel header, `# name ▾`, opens a menu of
  one thing: `Project settings…`, whose rows are Rename project, Project
  details, Product Manager and Delete Project. It has no Notifications: a channel
  is agent to agent only (anh Dee, 2026-11-09). Status, Pull requests, the
  instructions document, Crew and Sharing are v3 and not drawn, nor are the
  settings rows Project rules, People (who may chat) and Archived conversations:
  a v4 channel is agents only, its tasks are GitHub issues and nothing is
  archived, so no other way to them is wanted. Product Manager, for the
  project's owner, shows its PM's name (`None` without one) and opens Choose PM
  (`super_tabs/choose_pm.dart`; anh Dee, 2026-11-11: "the person chooses the PM
  from their agents. Choosing again switches it. No new folders."): their own
  agents, each a row with its face and name, the PM itself `Current` and
  another project's PM `PM of web` at the right, neither chosen; in their
  Personal Swarm, their panes in Your Team not in it yet follow, each with its
  face, its name and under it its computer as its row says it, `offline` and
  not chosen while that computer is off (PSQA, 2026-11-12: a person whose
  agents were all panes met an empty list). Then Cancel and the blue
  `Choose`. A pane chosen joins first, as a click on its row joins it, and the
  dialog stays until that is done. Choosing sends `project.pm`: the agent becomes the
  PM, the one before keeps running in Your Team, nothing is started, and the
  PM's own chat opens. A refusal of this choice is said under the list; an
  empty list shows nothing. While the PM New project started is on its way
  (its chat waits for it), the row says `Starting…`.
- **Goal score** (`SwarmGoalScore`, `super_tabs/goal_score.dart`; in the
  gallery; [design note](../../docs/design/2026-11-11-swarm-goal/README.md)).
  A project that states its goal in `agents/GOAL.md` says how far it is in its
  bar, 12 after the name's chevron: `Goal 41 of 60`, the milestones whose check
  passes on the default branch out of those the file lists, in 12-point
  metadata grey with tabular figures, as an agent's bar says where it runs. A
  score is plain figures ([Numbers and rankings](#numbers-and-rankings)): no
  ring, bar or chart, and no count of failures at rest. It is a dropdown that
  stays plain text until hovered (rule 5): hover, focus or its open menu brings
  `chevronDown` at 14 and the primary ink, and the chevron's room is kept at
  rest. The name gives way before the score does. Its menu, 320 wide at most,
  lists the milestones that do not pass yet, those that fail first, then those
  not run, each in the file's order, with the row's state word (`fails` in the
  error ink, `not run` faint); past 8 rows it opens on its search field, as
  every dropdown does, and `fails` typed there leaves the rows that fail. A
  milestone's name is the repository's text: a row and its tooltip show it
  without control characters and the marks that turn a line's direction. A row
  opens its check run on GitHub, only a page of github.com over https, or
  `agents/GOAL.md` when nothing ran for it. Tab reaches the score, Enter opens
  it, the arrows move among its rows and Enter opens one. With every milestone
  passing it is text alone, with
  no chevron and no menu; a project with no goal file, or no row in it, shows
  nothing, and its bar is as it was. A read that fails keeps the last score,
  and the menu's first line says why in the board's own words (`Sign in to
  GitHub: run gh auth login.`; with no gh, `Install the GitHub CLI (gh) to see
  the goal.`), in metadata grey; a score that is text alone says it in its
  tooltip; with no earlier score nothing shows. Desktop reads it with `gh`
  (`SwarmGitHub.goal`), by the REST calls the daemon makes and by its rules
  (`cli/src/superTabs/goal.ts`), so the bar and the PM are told one number:
  when the project's bar comes on screen, every five minutes while it stays,
  and when the menu opens, each only on a reading older than a minute. An
  answer that comes after a later read's is dropped. Nothing is read for a
  project that is not shown, on a phone, or while the Swarm is out of sight.
  `test/swarm_goal_score_test.dart` clicks through it.
- **Agents only.** People read a project's channel and its threads; only
  agents post there. In place of a composer, one quiet line in a grey pill:
  `Only agents post here. To change what happens, talk to your agents.`
  (`Only agents post here.` in a thread). A person talks to their own agents
  in each agent's chat.
- **A PM's chat before its PM.** Asking for a project's PM opens the person's
  1:1 chat with it at once (backend `lead.start` and `lead.claim` answer its
  id), before the PM is up. New project sends its task and files there and
  opens it. What the person sends there waits for the PM, and their newest
  message's receipt says `Waiting for the Product Manager` in muted grey with
  a clock; a row the server wrote there (a start that failed) carries none.
  Nothing goes to the channel.
- **Choose PM** (`SwarmPmChoose`, `super_tabs/choose_pm.dart`; in the
  gallery). A project's empty channel with no PM shows its owner one card above
  the agents-only line: one line, `This project has no Product Manager.`, and
  the blue `Choose PM`, which opens Choose PM (Project menu above); not while
  a PM New project started is on its way. Anyone else sees the empty channel as
  it is. A message's `Not sent · this chat has no Lead` in a project's channel
  offers Choose PM too, never a new agent.
- **Channel talk** (`super_tabs/channel_talk.dart`; anh Dee, 2026-11-09: "i dont
  see any agent to agent chat"; 2026-11-10: "channel chat here replaces the
  queue", "why not use tag? like in a group chat"). A project's channel is where
  its agents talk to each other, as lampOS's agents do on their Queue issue: only
  their own posts, nothing copied from GitHub. A task's talk, its issue's
  comments, is in the task's chat. A channel whose posts have been read and are
  none says why, in one centred line of muted text where the page was blank,
  above the grey bar, which stays: `No posts yet. Agents talk to each other
  here.` (`SuperTabEmptyWords`: the one empty pane that says why, since a blank
  channel read as broken; every other keeps rule 7). It says nothing while the
  channel's first page is on its way. A post reads as a group chat's: the
  agent's face, its name alone over the bubble, and whom it is for as tags. A
  post by an agent that is to others (the agents in its `recipientIds`, which
  its words and `--to` address) stands on its own row, however soon after the
  agent's last, and each of those agents its words do not tag opens the bubble
  as a tag (`@Juno`, `SuperTabMessageText.addressed`): the agents the Swarm has,
  each once, never its author. A post to one agent whose words name it as a
  teammate writes a name (`thanks Juno, confirmed`: the whole name, in its own
  case, not in a path, an address, code or a link's address) opens nothing: its
  tag besides read `@Juno thanks Juno`. A post to several keeps each tag. A post
  to nobody (`free: Pip`) has no tag. Under a post that names an agent that was offline
  when it was posted and still is (`downSince`), one quiet line
  (`SuperTabPostNote`, in 12 metadata grey, as `Response interrupted` is):
  `Juno is offline` (`Pip and Juno are offline`, `Juno, Pip and Faye are offline`): its answer waits. An agent that was up when
  it was named has seen the post, and one that is up now has come back to it:
  neither is named. A task's chat reads the same. In a person's own 1:1 chat
  with an agent that Your Team shows offline, their newest message not yet
  typed into it says so at once, in the same quiet grey (`Juno is offline`,
  `SuperTabMessageReceipt`), and the line goes once the agent is back; a
  computer that is off keeps its own line (`Mac Studio is offline`).
- **Tags.** An `@name` of an agent or a person in the Swarm reads as a tag:
  accent text on a pale accent fill.
- **Chat bubbles.** A chat reads like iMessage (anh Dee's mockup,
  2026-11-07, task #4529). Your own messages are bubbles on the right in
  `SwarmPalette.ownBubble` (#0A84FF) under white text (`onSelection`);
  everyone else's on the left in grey (`field`). Radius 18, and 4 on the
  sender's side where one sender's bubbles meet; your own bubble takes at most
  three quarters of the row, and another's, like a card, 92% of it, so an
  agent's words read nearly the column's width, as Codex's answers do (anh
  Dee, 2026-11-10; `SwarmBubble`, `super_tabs/chat/bubble.dart`,
  `SuperTabMessageRow.shareOf`). Between
  you and a chat's own agent (an agent's own chat) there are no names
  or faces; in a group chat a speaker's name sits over their first bubble in
  plain secondary ink at the text's size, and their round 28 face by their
  last. No engine mark: colour is the face's. **One size with the terminal**
  (anh Dee, 2026-11-10: "keep all the font size consistent between chat pane,
  terminal pane, and instruction pane. and resize the font will resize all"):
  a Swarm's chats, its task and pull request chats, its boards' titles and an
  agent's instructions read at the terminal's own size (`SwarmType.sizeOf`,
  `SwarmTextSize` over the Swarm's panes): 13 at first, on lines 1.6 times as
  tall (21), names at it, times one smaller; ⌘+ and ⌘−, and Settings ▸
  Terminal's stepper, change every pane together. The instructions keep the
  terminal's own face too. A phone keeps the app's 14, 13 and 12. A
  message reads in the direction of its first words (the first letter of its prose; code, links, `@name` and `#12`
  aside): Arabic or Hebrew from the bubble's right edge, whatever the app's; its code still left to right
  (`SuperTabMessageText.directionOf`).
- **Chat times.** No time in a bubble's row. A time sits centered between
  messages only after a pause of more than five minutes (`SwarmChatTime`);
  a bubble's full date and time are on its tooltip.
- **Message states.** Under your newest message, at the bubble's side as
  iMessage's Delivered (Swarm plan, step 1, item 2, 2026-11-11;
  `SuperTabMessageReceipt`, in the gallery): `Sending…`, `Sent` once the
  server has it, `Typed` once it is in its agent's session, in 12-point muted
  ink with no mark; once its agent answers, the line goes, the answer being
  the third state. Two minutes after it was sent and still not typed, the line
  turns amber, `Not typed yet`, with why in a note under it: its agent is
  working, waits on your answer in its terminal, has unsent text or a menu
  open there (each of these three with Open terminal), is not running, or its
  computer has not taken it. Not sent, offline and an unconfirmed delivery
  keep their own lines.
- **Chat cards.** A compact card (`SwarmChatCard`) is an icon and a small
  label, one title line, and one blue action that shows the rest in place.
  What GitHub said to your agent (a comment, review or line comment that names it or is on
  its own task or pull request, or a task labelled for it) is your agent's alone since 2026-11-12: your chat
  with it is your conversation, not a feed of GitHub's (anh Dee). A server before that one still sends it to
  you, as a card on the left, never your bubble (`SuperTabGitHubRow`): the pull request or issue mark, where it
  was and who wrote it (PR #4 · deehw, Review, Line, New task · #13), its first line or a review's verdict, and
  Read for the rest and Open in GitHub. The card goes on or after 2026-12-11.
- **Long messages.** Every message shows whole: nothing folds behind More
  (anh Dee, 2026-11-09). So does a code block in it: every line, a line wider
  than the column wrapped, never a scroll inside the chat, with its language
  and Copy over it; a clipboard that refuses says `Couldn't copy it.`
- **No reactions.** A message has no reaction chips under it and no reaction
  button in its actions, whatever the server sends with it (anh Dee,
  2026-11-09).
- **Voice.** A voice message is its own bubble with play, waveform and
  length, blue on your side; it plays only, with no words under it (anh Dee,
  2026-11-04, again 2026-11-07).
- **Chat composer.** The chat's composer is a pill (`SwarmComposerPill`,
  radius 20, a hairline and the faint fill) holding the paperclip, the text
  and its options; beside it the mic while there is nothing to send, and the
  round send (`SwarmSendButton`, 28, blue) in its place once there is text or
  a file. A thread's box keeps its row under the text, with a grey send until
  there is something to send. No @ button: an @ typed tags.
- **Chat column.** A chat is one column, at most 880 wide and centred in its
  pane (`SwarmChatColumn`, `super_tabs/chat/column.dart`; anh Dee, 2026-11-09;
  720 until anh Dee's 2026-11-10 "the center chat area is too small").
  Its message rows, day lines, New messages line, composer and the notes
  around it (an error, a reply being written, the agents-only line) share it,
  each keeping its own 24-point inset inside it, so a pane under 880 is filled
  with 24 each side. The header stays the pane's whole width, and so does the
  list, so its scrollbar sits at the pane's edge, and the bars across the top
  of the chat (the connection line, Find, the unread bar) and the Jump to
  latest button over it. Two panes open together (a
  chat with its terminal, its instructions, a task's thread, or a project's
  tasks and one task) share the width the left pane leaves half and half, the
  column centred in the chat's half. The browser keeps its full-width chat until
  it moves to v4. `test/swarm_chat_column_test.dart` measures it.
- **Blue.** Blue is for the main action and for your own bubbles, nothing
  else.
- **Adding or changing one.** A new or changed element updates this section
  and the gallery, with its section's images, in the same pull request.

## Swarm left pane

The Desktop's Swarm left pane (anh Dee, 2026-11-07, tasks #4466 and #4645; Swarm v4, 2026-11-08) follows the
Swarm's six rules: grey everywhere, colour only on agent faces; blue only for
the main action, red only for failed; 14 chat, 15 rows, 12 details, and in a
list bold means unread; an agent row is a face, a name and at most one word of state;
dropdowns plain text until hovered; nothing that does not help you decide.
Top to bottom:

```text
 autonomous.ai ⌄              org name, semibold 13 primary; ⌄ only on hover; its menu: Personal, your Swarms (another person's Personal as Dee's Swarm), Rename (one you may change), New Swarm
 ⊕  Invite people             its owner only, in Personal too: opens the Swarm's people, titled Invite people, where a link, a domain or an invitation is made
 Your Team           ⌄  ∞ +  quiet heading; ⌄ folds the list (open); ∞ (link) Attach agent, + New agent
 ◌  Faye            starting  first: a New agent going on after its form closed, a grey face; a click opens nothing yet
 ◌  Ivy               failed  its start failed: `failed` in red; a click opens its form again with why, and Try again
 ◎  River                     the PM wears the gold ring
 ◉  Kai                 free  bold: something new from it; the state at the right
 ◉  Quinn             on #12
 ◌  Wren             offline  a grey face
 ◉  Finn              paused  right-click: Pause, Resume (its person, its machine's owner, the Swarm's owner; never a PM), Remove (its person)
 ◉  Docs bot   Mac Studio     your Personal Swarm only: a pane you run that is not in the Swarm yet, with its computer; a click
                              makes it an agent, its chat opens with its terminal beside it
 ◉  Billing fix  joining      while it joins
 ⌄  32 more                   past the first eight; opens the rest, then "Show fewer"
 Projects              ⌄  +  quiet heading; ⌄ folds the list (open); + opens New project
 #  docs-home       starting  first: a New project going on after its form closed, in place of its own row
 #  lampos                    a project's channel; bold: something new; your Personal Swarm: each repo your panes work in
 Your Machines         ›     quiet heading, folded, but open by itself while a computer is off; each row a computer of this account, `offline` at its right when it is
                              (a click opens Manage's Machines)
 Top Teams             ›     quiet heading, folded, only once someone has points (in a Swarm of one, a board of one zero shows nothing)
 D  dee                 120   the board's top 8 by points; a tap opens it
 ⚙  Manage                    at the foot
```

| Element | Implementation | Rule |
| --- | --- | --- |
| Quiet row | `SuperTabQuietRow` (`super_tabs/quiet_rows.dart`) | 30 high, 2 under it. A 20 face (`SuperTabQuietRow.faceSize`) or a 16 icon centred in the 32 column, so every name starts on one line. Name 15 (`SwarmType.sidebar`), the size of a project's row: read `textSecondary` regular, unread `textPrimary` semibold, the open row `SidebarInk.selected` with a primary name. One detail, 12 (`DesktopChrome.metadata`) in the tertiary grey (`SidebarInk.faint`, `textFaint`), right-aligned, tabular figures, no brackets; it keeps up to 40% of a row whose name is long, and is cut first. |
| Start row | `SwarmStart`, `SwarmStarts` (`super_tabs/swarm_starts.dart`, the app's `swarmStarts`); `ProjectSidebar._startRow` | New project and New agent never hold their person while a project or an agent starts (anh Dee, 2026-11-10: "as soon as i hit new project or new agent, just get me back to my main screen ... NEVER block users for minutes"). Once the form's own checks pass and the start is under way, the form closes, back to what its person was doing, and the start goes on: the project made, its folder cloned, its agent started and joined. Meanwhile its row is first in Projects or Your Team: a project's `#` (its lock if private) or a grey face, its name (the repository's, or the agent's once it has one) and `starting`; it opens nothing. A new project's own row is not drawn while its start's is. Done, it is the project's or the agent's own row, and nothing opens by itself: its person goes in when they choose. Failed, its detail is `failed` in red (`colorScheme.error`), and a click, like that section's +, opens its form again with why, its Try again and Discard. Closing the form while it still checks sends nothing. |
| Shared edges | `SuperTabQuietRow`, gallery check "the left pane's details end at one edge" | Every section's rows share the left edge (the faces' and icons' column), the right edge (every detail ends `AppDesktop.controlGap` from the row's right, with no column kept for anything after it) and the baselines (30 high rows). A heading's + ends on that right edge. |
| No status marks | — | The left pane draws no spinner, check, `?` or failed mark (anh Dee 22:25, task #4645): status lives on the Tasks cards. An agent with something new is its row's semibold primary name, like an unread Slack channel; read rows stay regular, and the open row keeps its fill. |
| Agent state | `SwarmAgentStates.rowOf` (`super_tabs/agent_state.dart`) | An agent's row ends with one state in the row's detail, the first of (Swarm plan, step 1, item 1, 2026-11-11: "What Harness knows is a state anyone can see"): `offline` (its machine reports its session gone, `SuperTabAgent.downSince`), `starting` (a message to it waits while its engine starts: its frame's `waitingFor: engine`, which the daemon sends again when it changes and a reconnect reads whole; its 1:1 chat's bar adds `· starting` too, and neither says a failure), `needs you` to its person and `waiting on its person` to anyone else (a question on its screen, or its terminal waits on their input), `paused` (its person, its machine's owner or the Swarm's owner paused it, `SuperTabAgent.paused`: Harness gives it no task and types it nothing while its session runs on, and its tasks go to others as a down machine's do), `limited until 15:40` (its machine saw a usage limit on its screen, `SuperTabAgent.limitedUntil`, until the reset), `waiting on a build` (at a task whose pull request's checks run, the board's Checks, while no turn of its runs), `on #12` (its project's board has the open issue labelled `status:taken` and `builder:<its name>`; in a Personal Swarm, whose projects name no repository, the board of the repo its own pane works in), `working` (a turn runs), `free` (its latest post in its project's channel says `free: <name>`, as the Swarm's basics ask of an agent with no task); none of them shows nothing. What its computer's daemon says (a turn, a question) is known where this Desktop reads that computer, the person's own; the rows redraw as the app changes only once what one of them says has moved. An offline agent's face is grey (`SuperTabAvatar.agent` draws it so, `super-face-offline`) wherever it is drawn: its row, its 1:1 chat's header and its posts. Read only for the projects the person's own agents are in: a channel again when the Swarm says it moved, a board once a minute while the Swarm is on screen, and its open pull requests with it while one of its tasks is taken. |
| Agent menu | `ProjectSidebar` (`super_tabs/project_sidebar.dart`), `showContextMenuAt` | An agent's row has a right-click menu and nothing else to pause or remove it (anh Dee, 2026-11-11: "make it subtle. right click you see pause. it should be available but shouldn't be too visible"). `Pause` (`Resume` once paused) for its person, its machine's owner and the Swarm's owner, who leads the work it would be given (backend `agent.pause`), never on a project's PM, which gives the work; `Remove` under it for its person alone, disabled with why for a project's PM (Remove an agent, below). A pause refused says why in a short notice. Anyone else's right-click opens nothing. |
| Quiet heading | `SuperTabQuietHeading` | 12 `textSecondary`, its text level with the faces' left edge. A group that folds shows `chevronDown` (`chevronRight` folded) beside its name, always; the org name's chevron shows only while hovered or focused. Your Team and Projects start open, Your Machines and Top Teams folded, except that Your Machines opens by itself while a computer is off, so why an agent is silent is in sight; the reader's choice is kept and then stands. `onAdd` puts the `plus` button at its right, as on every section heading: Your Team's opens New agent, Projects' New project. Your Team also has `onAttach`, the `link` button before the + (tooltip Attach agent; anh Dee 2026-11-09: "like ⌘P, while + is like ⌘N"): ⌘P's picker titled Attach agent, its field `Search agents` (`No matching agents`; an empty list says nothing), of the Claude Code and Codex sessions running on its person's own computers, those on the team left out and the rest unavailable with why; the one chosen joins with its own chat, which opens. |
| Team fold | `ProjectSidebar.teamShown` (`super_tabs/project_sidebar.dart`) | Your Team shows at most 8 rows, so Projects stays in sight with forty agents (tester Q1, 2026-11-10: 880x560). The 8 are the rows with something new, then those on a task, then the rest, each in its place in the list; the open agent's row always shows. In a Personal Swarm its pane rows are in the one list from A to Z with its agents and ranked as they are, never put last. Under them, a quiet row with `chevronDown`, `N more`, opens every row; then `chevronUp`, `Show fewer`, folds them again. The reader's choice is kept (`agentsAllShown`). |
| Remove an agent | `removeSwarmAgent` (`super_tabs/remove_agent.dart`) | Its person's right-click on its row in Your Team: Remove (a project's PM stays until its project goes, said in the item). `Remove Kai?`, then `Its chat goes. It keeps running in your tab.` while one of their tabs shows its session, else `Its chat goes and its session stops.`; Cancel, and the red Remove. It follows the rule a tab's last view has (anh Dee, 2026-11-11): shown in a tab, only the Swarm lets go of it; with Your Team its last place, an idle session stops quietly and a working one asks first, in the review closing a tab's last view shows, whose Cancel keeps the agent. A stop its computer refuses says why there and keeps the agent. |
| Pane row | `SuperTabQuietRow` (`super_tabs/personal_agents.dart`) | In a person's own Personal Swarm, whoever else they invited there, every Claude Code or Codex session they run in their tabs that is not in the Swarm yet (a running session on one of their own computers; a plain shell, a stopped session, a shared computer's and a Team account's are no agents of theirs) is a row among their agents, by name, each once; one they took out of the Swarm (`removedPanes`) is not. A session that is an agent of another Swarm (as this Desktop last read each Swarm open or closed here and still theirs, `SuperTabClient.agentsOutside`) or that a Swarm started stays that Swarm's and has no row; one another Swarm lets go has its row again (anh Dee, 2026-11-11: "the agents started in other swarms leave them in other swarms, they are not part of this swarm"). Its face is the one it wears once it joins (`swarmAgentId`, the Swarm's id for it), its name the one it joins under and keeps: its pane's (the folder it works in while that is still Untitled Pane), or, when it has none or the Swarm or an earlier row has it already, one of the Swarm's names, the same on every draw and computer; its computer the detail, or `offline` with its face grey, as an agent's row says it, while that computer is off (PSQA, 2026-11-12: a long computer name cut `· offline` off; in the gallery). Nothing is sent for it until its person clicks it: the click makes it an agent as Attach does (its own 1:1 chat opens, its terminal shows beside the chat) and the row is then the agent's. The row says `joining` while that goes on and waits, one join at a time; a refusal is said in a line at the foot and the next click finishes the join; a row of a computer that is off does nothing. |
| Personal project | `PersonalProjects` (`super_tabs/personal_projects.dart`) | In a person's own Personal Swarm, whoever else they invited there, Projects are the repos their panes work in: the same repo on two of their computers is one project, named after the repo (`api`; `api (acme/api)` beside another `api`). A pane with no repo is in no project and stays a row of Your Team. A project whose panes are all closed leaves the list until one opens again. Which project a repo has is asked of the server by the same request on every computer, and nothing of it is kept on one. Its Tasks board reads the repo's GitHub issues with the reader's own `gh`, on every computer: for a repo on GitHub the Desktop sets the project's `owner/name` once (`project.github`), so the server learns the project's name and that, nothing of a pane. No project is named after a tab: the tab projects of v3 are closed once (an empty one goes, one with messages is kept read-only and out of the list; this computer keeps their ids until 2026-12-10). The Swarm's own first project (Personal), which the server keeps only while it has messages, is listed as any project. |
| Org name | `SuperTabQuietHeading.org` | Semibold 13 primary, no icon; its chevron only on hover; opens the Swarm menu, Personal first. |
| Swarm name | `swarmShownName`, `swarmTabShownName` (`super_tabs/swarm_name.dart`) | The one way the Desktop names a Swarm: in its tab and its hover, the org name, the Swarm menu, Recent Swarms on the New Tab page and a Swarm draft, ⌘K (Recently closed too) and the menus, Move pane, Open Harness in, Manage's Name, Add agent's and Project settings' titles. Personal is only ever the reader's own: someone invited to another person's Personal Swarm sees it as `Dee's Swarm`, its owner by the name the Swarm shows them (the name they set, else their username), or plain `Swarm` before any Swarm read on this Desktop has them (anh Dee, 2026-11-12). Which Swarm is a Personal one the server tells every member (the list's `personalSwarm`, the read's `personal`), so a team Swarm named Personal keeps its name; against an older server every Swarm keeps its name. Join Swarm's preview names no owner and shows the name. Its owner still sees Personal, and every other Swarm keeps its name. Shown only: the Swarm stays named Personal, and Rename starts from that. |
| Personal outside a Swarm | `swarmsToOpen` (`super_tabs/swarm_switcher.dart`) | A person's Personal Swarm is in reach on each of their computers without another Swarm open (anh Dee, 2026-11-11): on the Desktop it is the first of Recent Swarms on the New Tab page and a Swarm draft, and in ⌘K, always, listed once whether it is open, closed or not made yet. Picking it shows it (its tab if one shows it, else in that page's tab), made by the server the first time; one that cannot be made says why in a line at the foot. The web lists only the Swarms closed there. |
| Invite people | `ProjectSidebar.onInvite` (`super_tabs/project_sidebar.dart`) | A quiet row with `AppIcons.userPlus`, right under the org name, for the Swarm's owner alone (only an owner invites: backend `commands.ts`, `invite.create`), their Personal Swarm too (anh Dee, 2026-11-11: "the person can invite people, like any Swarm"), which stays theirs: Your Team keeps their panes and Projects their repos; it opens the Swarm's people (`showSuperTabSharing`), titled Invite people; Manage ▸ Swarm ▸ Manage people opens the same dialog titled Manage people. A dialog's title is the words that opened it (PSQA, 2026-11-12: both said Share Swarm). A Swarm with no project yet, as a new Personal one is, takes no email invitation, and the dialog says `Create a project before inviting people: + beside Projects.` In sight, not in Manage: people join a Swarm by an invitation, and each brings their agents and computers (anh Dee, 2026-11-11: "it's quite difficult to invite people. i have no idea where to find it. invite should be visible"). |
| Person | `SuperTabAvatar.person` at 20 | A photo, or an initial on the neutral grey disc. |

The phone keeps its own rows. The browser draws this pane, as the Desktop does.

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
Themed buttons and icon buttons reach 44 on their own: they are drawn at their
usual size, but their layout box is 44 tall, so a row holding one is at least 44.
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
- An agent row's status line says a named state (`Agent.namedState`) in the
  attention tone in place of what the agent is doing, below only Waiting for
  you, where Desktop puts it in a pane note.

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
real modal dialog holds the titlebar. The bell's empty inbox is its heading
and × (Swarm elements, rule 7).

**Task dialogs** — one heading, optional short explanation, fields, and fixed
trailing actions. Rename, confirmation, linking and sharing use the same type,
frame, padding and control states. Content scrolls before actions disappear.
`DesktopPromptScrollBody` shows a quiet, draggable scroll thumb when the body
overflows, including before the first scroll gesture. Text leaves 12 points of
clearance for the thumb. Short content has no visible scroll furniture; nested
editors keep their own input and scrolling behavior.

**Old Team Account** (`widgets/old_team_account.dart`) — the one task dialog
the app opens by itself: once a launch, as the workspace opens on a computer
whose old Harness Team account is still there. One line, "An old Harness Team
account is still on this computer. Remove it.", and one action, Remove, which
opens the system's administrator prompt. Nothing else closes it until Remove
is pressed. While the system's prompt waits, the footer says where it is
("Enter your password in the system's window. It may be behind Harness.") and
Close or Escape lets the person go, the removal going on to the prompt's
answer (anh Dee, 2026-11-11: it sat at "Waiting for the administrator prompt…"
with macOS's window out of sight, and nothing closed it). Once it has run, the
footer shows "Removed." or the CLI's own reason in the danger color, with
Close and Retry. Cancelled or failed, the next launch asks again.
`test/old_team_account_test.dart` clicks through it.

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
Details remain in the existing optional preview; its folder line is followed by
`Workspace · <path>` for an engine whose tools work elsewhere (OpenClaw). No second search index or
management implementation. Toolbar controls are secondary to the query. Keep
the editor and footer stationary while results update; do not resize the panel
on every keystroke or make short lists stretch their individual rows. On wide
windows, results take 44% and the preview 56% of the reading area. The panel
clamps to the window; narrower layouts retain their existing preview toggle.
Section headings use their natural text height with 8-point group spacing,
never a full result-row height. Loading, failed refresh and settled emptiness
are different states; keep existing results visible while refreshing.
In a full tab the footer says `This tab is full. Open a new tab to add more.`
once, and the empty list says nothing. A Swarm's pickers (Attach, Add agent)
bring an agent into its team, so a full tab never limits them or their footer.

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
heading and timestamps. “Recent Swarms” rows wear an 18-point Swarm mark
(`AppIcons.user` for Personal, `AppIcons.users` for the others) in the marks'
column, so their names start where the recent harnesses' names do. Use “now” for visits under one minute old. Context
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

**Pane notes** (`PaneNote`) — one 30-point line under the header, in flow so it
covers none of the terminal, on a 10% warning tint with a 14-point warning-ink
mark and one body line that truncates with its full text on hover. Two say why
an agent cannot work: its model not answering (`PaneModelNote`, with Pick
another where the pane has a picker) and a named state the daemon says only the
person can fix (`Agent.namedState`, triangle mark, the daemon's sentence as it
is, such as `OpenClaw Gateway is not running. Start it with openclaw gateway.`).
A note is gone the moment the daemon stops sending it.

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
Settings ▸ About adds one body-size secondary line under the app identity, `Node v24.22.2` or
`Node v22.23.2 · stays on 22: <reason>`, from the daemon's status; it is absent when the daemon
sends no Node.

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
      emphasized number, zeros hidden, a place is its numeral
- [ ] Celebration follows Team and celebration: team surfaces only, no emoji
      on instrument surfaces, one real event, named person and thing, marks
      with accessible words
- [ ] Color is never the only signal; a trend or state also has a shape or words
- [ ] Light and dark, 160–200% text, long and missing names, empty, loading and
      error states, with screenshots
- [ ] Phone: Phone table sizes, 44-point targets, differences from Desktop listed
- [ ] Copy follows the Naming System
- [ ] Keyboard, focus return and hand cursor (Desktop)
- [ ] A new or changed element updates Swarm elements and the gallery
      (test/swarm_elements_gallery_test.dart) in this pull request, or it
      doesn't merge
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
