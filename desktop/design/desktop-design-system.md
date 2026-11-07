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

The Desktop left pane's Humans has no rank number and no crown: it is the
Leaderboard in short, its people most points first with their points at the
right ([Swarm left pane](#swarm-left-pane)). There, as the one exception to the
table, points are the row's quiet detail: 12, tertiary, tabular.

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
leaderboard, profiles and the project chat) are where people appear, and they
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
are not app icons and do not join the `AppIcons` vocabulary. A person's badges
live on their profile sheet; a new badge is announced once in the project
chat, naming the person and the badge, and is not repeated.

**Every mark has words.** The crown, a badge or a celebration message carries
an accessible label that says what it means ("Number one this week", "Badge:
First pull request merged"), and color or artwork never carries that meaning
alone.

## People and conversations in lists

Lists of projects, groups and people (the sidebar, the project chat, the
leaderboard) share four rules.

- **Unread.** Goal: see what changed without a second signal to decode. An
  unread project or group shows its name in bold, with no dot beside it.
- **Mentions.** Goal: tell "something changed" apart from "someone needs
  you". A conversation that mentions you is bold and adds an `@N` count of
  those mentions at its trailing edge, just before the status column.
- **Status column.** Goal: compare status down the list at a glance. Status
  marks use the shared activity vocabulary (see the
  [icon design system](icon-design-system.md#deliberate-exceptions)) and sit
  in a fixed trailing column, last on rows that show status (agents,
  conversations); a mention's `@N` sits just before it. Ranking rows have no
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
(`test/swarm_elements_gallery_test.dart`) draws every one in light and dark
against `test/goldens/swarm-elements-{light,dark}.png`, holding each element
to its own area: a face or ring may barely differ, an icon or letter a
quarter of its box, and nothing else outside the words more than 38 pixels.

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
  it under all three, and the Tasks pane paints it too, so no pane shows its
  host's colour. A palette the person chose that names its own sidebar (Plum)
  keeps it.
- **Top bar.** Every agent's chat has the same 44-high bar
  (`SuperTabAgentChatHeader`): at the left the 22-point face and the name in
  13-point semibold, inset as the Buddy card button insets them, the name
  taking at most half the bar; at the right one line
  (`SuperTabEngineModelLine`), `Claude Code · Opus 5.5`, in 12-point
  `textFaint`, then the ⋯ menu (`AppIcons.ellipsis`). The line gives way with
  "…" before the name or ⋯ do. For the reader's own Swarm Buddy it is a
  dropdown by rule 5 and opens one menu: its engines first (the one it runs on
  takes it back from a shared model), then the models shared in the Swarm.
  The server switches no other agent, so theirs is the same words and opens
  nothing. A switch under way reads `Switching to Codex…`; a shared model
  nobody serves adds `not served now`. The subscription, the machine and
  "reads all your projects" are not in the bar. The gallery draws the bar of
  the reader's Buddy and of a member agent.
- **Agent face.** An agent with no chosen picture wears a face
  (`SuperTabAvatarFace`, `avatar_art.dart`) in rows, cards, chat and profile:
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
- **Task status marks.** Proposal is Lucide `lightbulb`, Declined
  `thumbs-down`, Failed (Stuck) `triangle-alert` in the semantic error ink.
  The check, question mark and spinner stay, from the shared activity
  vocabulary. No status in Flutter draws an X: an X means close. Terminal text
  and native tab marks may keep `✗`.
- **Left pane row.** The left pane's row (`SuperTabQuietRow`,
  [Swarm left pane](#swarm-left-pane)) carries the elements above at its
  shipped size; its size and layout do not change when an element does.
- **Tasks pane header** (`SuperTabTasksPaneHeader`). "Tasks" in 13 semibold
  on the left. The Accept all or Ask me choice on the right is plain 12
  secondary text; its chevron and a faint fill show only on hover, focus or
  while its menu is open, and the chevron's room is held at rest so the text
  never moves. The menu is the app's one dropdown, with a check on the stored
  choice.
- **Tasks pane card** (`SuperTabPersonalTaskCard`). A card surface with one
  hairline (`DesktopChrome.rim`), radius 10 and no shadow; a selected card
  differs by its fill alone. On top, the project's name in a neutral grey
  capsule (`AppSurface.wellFill`, secondary text), never a project colour, and
  the status mark at the right. Then the title in 13 medium, up to three
  lines, and two 18 faces: who asked, then who is doing it. Only while the
  task waits for the reader: Decline as plain text and Accept as the blue
  capsule, on the right.
- **Chat message.** A message row (`SuperTabMessageRow`) leads with a round
  28 face, then one header line: the name at 13 semibold and the time at 12
  in tertiary ink (`textFaint`), nothing else; no engine mark, since colour
  is only the face's. The text reads at 14 on 20 px lines (`SwarmType`).
  An empty chat shows no line; only a chat that can't be read or is still
  loading says so (task #4467).
- **Chat composer.** Both composers (the chat's and a thread's) are Cmd-N's
  field: radius 12, a hairline (`rim`) and the faint fill (`field`). Under
  the text, the paperclip on the left and, on the right, the mic beside the
  round send (`SwarmSendButton`, `super_tabs/chat/send_button.dart`): a 28
  circle in a 32 target, `rim` with a `textFaint` arrow while there is
  nothing to send, `AppPalette.accent` with a white (`onSelection`) arrow
  once there is text or a file. No @ button: an @ typed tags.
- **Adding or changing one.** A new or changed element updates this section
  and the gallery, with its images, in the same pull request.

## Swarm left pane

The Desktop's Swarm left pane (anh Dee, 2026-11-07, task #4466) follows the
Swarm's six rules: grey everywhere, colour only on agent faces; blue only for
the main action, red only for failed; 14 chat, 13 names, 12 details, and in a
list bold means unread; every row a face, a name and one quiet detail on the
right; dropdowns plain text until hovered; nothing that does not help you
decide. Top to bottom:

```text
 autonomous.ai ⌄              org name, semibold 13 primary; ⌄ only on hover
 ⊡  Decisions              3  inbox icon; the waiting count is the detail
 ▦  Projects               1  grid icon; opens the grid; the detail counts tags of you
 My agents ⌄                  quiet heading; ⌄ only on hover; folds, remembered
 ◉  Buddy                  ⠋  the Buddy first, by its own name and face
 ◎  River        harness   ?  a Lead's detail is the project it leads
 ◉  Leftquiet    offline      a down agent's detail is "offline"
 +  New agent                 the last row, opens Cmd-N
 Humans                       quiet heading; opens the Leaderboard
 D  dee              120      the board's top 8 by points; a tap opens it
 ⚙  Manage                    at the foot
```

| Element | Implementation | Rule |
| --- | --- | --- |
| Quiet row | `SuperTabQuietRow` (`super_tabs/buddy_rows.dart`) | 30 high, 2 under it. A 20 face (`SuperTabQuietRow.faceSize`) or a 16 icon centred in the 32 column, so every name starts on one line. Name 13 (`DesktopChrome.control`): read `textSecondary` regular, unread `textPrimary` semibold, the open row `SidebarInk.selected` with a primary name. One detail, 12 (`DesktopChrome.metadata`) in the tertiary grey (`SidebarInk.faint`, `textFaint`), right-aligned, tabular figures, no brackets; it keeps up to 40% of a row whose name is long, and is cut first. |
| Status mark | `SuperTabQuietRow.mark`, `superTabAgentMark` | My agents only, in one 20 column at the right edge after the detail, kept on every agent row so details line up. A mark only while the agent works (the spinner), needs you (`?`) or failed: grey, failed in the error ink. Idle and finished show nothing; a finished agent's unread reply is its semibold name. |
| Quiet heading | `SuperTabQuietHeading` | 12 `textSecondary`, its text level with the faces' left edge. A group that folds shows `chevronDown` (`chevronRight` folded) only while hovered or focused. |
| Org name | `SuperTabQuietHeading.org` | Semibold 13 primary, no icon; its chevron only on hover; opens the Swarm menu. |
| Person | `SuperTabAvatar.person` at 20 | A photo, or an initial on the neutral grey disc. |
| Projects grid | `SuperTabProjectsPage` (`super_tabs/projects_page.dart`) | Every project as a card, as repositories under a GitHub org, most recent first (the latest message in its chat or tasks). Cards at least 260 wide with 12 between them, transparent with a hairline (`DesktopChrome.rim`) and the hover fill; the name semibold 13 primary, one line 12 tertiary: its repository's `owner/name`, or Private. New project is the page's one blue button. A card opens its project's Board, which lights Projects in the left pane. |

The phone and web layouts keep their own rows.

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
- Swarm Home starts a new message from a round, 56-point, accent-filled +
  floating at its bottom right (New message, as Slack Mobile does), not from
  a button in its top bar.

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
