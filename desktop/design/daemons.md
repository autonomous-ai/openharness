# Daemons on the desktop

The contract is [daemons/README.md](../../daemons/README.md): the roster, the
art rules, moods, blinks, voice, the zoo, habits and hatching. This page only
says where the desktop keeps each part and what it chose where the contract
leaves room. It replaces the local "terminal companion" (six species, canned
chat, a local blind box), which is gone.

## Illustrated collection and eggs

When Settings → Experimental → Focus-bar creature is on, the creature now sits
at the far right of the **top tab bar**, after Harness Store. The setting keeps
its existing account, rollout and collection behavior. Turning it off removes
the slot and any hover preview; it never deletes the saved collection.

All ten init daemons use code-authored PNG artwork shared with the Pro drawing source:
`daemons/tools/illustrated/`. The desktop bundles 64px slot images and 350px
portraits. A small slot never decodes the larger image. PNGs are cached; a
portrait animation repaints only its own boundary and stops for Reduce Motion,
Motion off, hidden pages and background windows. No model or vector parser runs
while drawing. Future species outside the init collection retain their existing renderer.

Tab-bar artwork is centred on the visible idle pose, not the PNG canvas. Each
growth stage and the egg family keep a fixed anchor through every frame, so
breathing and hatching retain their registration. `IllustratedArt.center` and
`SwarmDaemonArt.center` read matching generated source-pixel anchors from
`illustrated_alignment.g.dart` and `assets/daemon-art/alignment.json`. AppKit drawing respects flipped coordinates.
Native checks measure the painted centre at all thirty species/age combinations and for the egg.

The zoo leads with a growth label (Hatchling, Young, Adult), a centred portrait,
bond progress, and Rename / Card / Details. Details reveals lore, rarity,
version and collected traits. A single companion is not repeated in an
individuals section. The collection wraps on narrower windows and highlights
only the selected name row. None of these presentation changes alter ownership,
hatching, progress or pairing.

Versions **0.1 / 1.0 / 2.0** show a hatchling, a young daemon, and its approved
adult shape. Tim grows longer arms; the other nine grow from smaller proportions. Bond/XP thresholds, random draws, ownership,
naming and consent are unchanged. All eight egg kinds use new shell artwork for
p0–p4, rocking, bursting, falling shell halves and the open bowl. The hatchling
rises behind that bowl as a silhouette before its colour appears. Collection
cards, portraits, previews and every growth transition use the same artwork.
Rolled traits remain metadata; arbitrary markings and accessories are not yet
illustrated by the curated artwork.

Hovering for 220ms reveals the full-size artwork below the tab bar without
taking keyboard focus, hatching, or changing progress. Leaving, clicking,
opening a modal, switching the experiment off or leaving the foreground closes
it. Click retains the existing hatch/boop/panel action. Work frames in the slot
still advance with real agent activity; the hover portrait may gently animate.

The art adapter is `lib/daemons/illustrated_art.dart`; the isolated bitmap view
is `lib/widgets/daemon_illustration.dart`. Native `daemonState.art` carries a
validated bundled slot asset key, never a file path or downloaded artwork.
Native hover emits `daemonHover` so Flutter owns the same preview on every
platform. The bottom focus bar retains pane context and the existing voice line.

Regenerate with `python3 daemons/tools/illustrated/generate.py`. The manifest
records all 1,124 art keys, both resolutions, frame counts, source hashes and hatch
registration. Review sheets live beside the generator. Test with
`test/daemons/illustrated_art_test.dart`, `test/daemon_off_test.dart`, and
`test/daemon_review_render_test.dart`, plus the native titlebar checks.

Zoo → **Browse artwork** opens a local preview of all ten, including Beastie.
Left/right and Previous/Next wrap through the collection; the named controls
jump directly to a species. Stage, Expression and Pause change the preview.
Escape returns to the zoo. This view has no account or collection writer: it
never discovers, hatches, renames, pairs, or grants XP to a daemon. The regular
collection still hides unearned species and the secret.

## Off: invisible and free

Daemons ship dark ([daemons/README.md](../../daemons/README.md), "Off
switches"). Anyone who does not have them gets the window from before daemons
existed, exactly:

- **Signed in**, the server decides. `GET /api/zoo` answering 200 is on. A 404
  (the server's `HARNESS_DAEMONS`, an account not in `HARNESS_DAEMONS_USERS`,
  harnessd's local kill switch answering `DAEMONS_OFF`, or a harnessd that
  predates the zoo) or a 401 is off, and so is `error: 'DAEMONS_OFF'` on any
  `daemon_*_result` or `pair_result` (`DaemonBrain.switchedOff`), and a 404 on
  a write. A 5xx or no answer is not off: whatever was known stands (nothing
  shows until the first answer) and it is asked again after 5 s, doubling to
  6 h. It is asked again on `zoo_changed`, on a reconnect, and once the last
  answer is 6 h old (`ZooController.recheckIfDue`, checked as the window syncs:
  no timer is kept for it).
- **Signed out**, there is no server to ask, so the creature stays hidden.
  The old Settings ▸ Account preview switch is removed and its saved value
  is no longer loaded.

### Experimental focus-bar creature

Open **Settings → Experimental → Focus-bar creature** to start with an egg in
the top tab bar. Switch it off there to hide the creature, its
panel and any hatch. The activation shortcut has been removed entirely,
including its command and native Mac binding. The switch works by mouse or
keyboard and leaves focus in Settings.

The Experimental section is a shared catalog of opt-in features. This first
switch is off by default, is available on desktop without sign-in, and saves
its choice on this computer (`experimental.focus_bar_creature`). The store is
loaded before the first frame, so a saved choice takes effect at launch.

The preview works even while the server rollout is off. The window gets a
separate, empty in-memory collection. The first egg cracks as habits are
completed: a finished turn and any two other habits make it ready. Click the
egg to see progress; once ready, click to hatch and name the new companion.
Earning an egg never hatches it automatically or preselects its species.
Only turns finishing after activation count toward preview progress. Hide/show
keeps that window's collection; closing the window discards it. Motion, Quiet
and the panel tab also stay temporary. There is no collection upload, guest
seeding, brain traffic, rules-file access, account consent or autonomy change.
Art uses the bundled species fallback; individual plate requests remain off.

The saved choice overrides the separate account rollout: on selects the test
collection, and off suppresses all creatures, even after relaunch, pushes or
reconnects. An installation that has never made a local choice keeps its
existing account rollout. This switch does not enable the server or harnessd
feature. The old Settings → Account preference is not migrated.

Checks: `test/experimental_features_test.dart`, `test/settings_screen_test.dart`,
`test/settings_section_test.dart`, `test/startup_test.dart`,
`test/daemon_off_test.dart`, `test/daemons/zoo_preview_test.dart`, and
`test/keymap_native_test.dart`. Real-font render fixtures are
`test/settings_review_render_test.dart` and `test/daemon_review_render_test.dart`;
set `HARNESS_SETTINGS_CAPTURE_DIR` or `HARNESS_DAEMON_CAPTURE_DIR` to save PNGs.
Export `HARNESS_KEYMAP_FIXTURE_PATH` when running the keymap test, then point
`HARNESS_TITLEBAR_KEYMAP_FIXTURE` at that JSON and run
`bash tool/check_swarm_titlebar.sh /path/to/flutter --window-layout` for the
production AppKit slot and keyboard checks. Use isolated state and stubbed tmux.

Off (and while it is not known yet) means: no status slot and no space kept
for it (the Flutter bar and native lay out the bar from before daemons; native
hears no `daemon` key and no `daemonState`), no voice line, panel, reveal,
notices or hint, no habits, `zoo.turn` or easter ops, no `daemon_*` or `pair`
frame (the brain's sends go through `_sendDaemonFrame`, which sends nothing
unless the zoo has loaded; frames harnessd sends are heard but nothing of them
shows), no `xyzzy` row, and the daemon's commands are not bound
(`HarnessCommand.daemon`, `daemonCommandsActive`): ⌘⌥T reaches the pane as it
did before, and neither the command list, the shortcut list, keyboard practice
nor the native keymap has them. The daemon's settings file is read only once
daemons are on. Switching off while on takes all of it away at once.

`test/daemon_off_test.dart` holds all of this to the bar from before daemons
at five widths (`test/fixtures/status_bar_before_daemons.json`, measured on
`main` at `0e4724cd`, including Share, by `test/support/status_bar_layout.dart`); the native
checks hold the AppKit bar to the same with the daemon hidden.

**Appearing.** When daemons turn on (the first 200, or the preview switched
on), the slot takes its space at the first quiet moment: no mouse button held,
the pointer off the bottom status bar, and no key or pointer event for 800 ms (at once when
nothing has been touched yet). Native holds the slot back the same way while a
button is down or the pointer is on its footer (`daemonMayAppear`). Controls never
move under a click.

**The welcome's steps are not the daemon's habits.** `WorkspaceOnboarding` is
the one from before daemons: Harnesses, Machines, Models; a harness at work in
a pane completes Harnesses; Machines or Models imply it; a person who had
finished stays finished. The daemon's habits are its own, reported only while
daemons are on.

## Where things live

| part | file |
|---|---|
| roster (generated, never edited) | `lib/daemons/roster.g.dart` |
| roster and banner face as Dart values | `lib/daemons/roster.dart` |
| renderer, status cell, nest, egg frames, banner, card | `lib/daemons/render.dart` (a port of `daemons/tools/render.mjs` and `card.mjs`) |
| baked plates (generated `plates.g.dart`, parsed once, on first use) and the plate colour rule | `lib/daemons/plates.dart` (a port of `bake.mjs` `plateColor`) |
| a portrait wherever one shows: a plate's loop in colour, or line art | `lib/widgets/daemon_portrait.dart` |
| line templates and their slots | `lib/daemons/daemon_lines.dart` |
| Motion, Quiet and the panel's last tab, kept per computer | `lib/daemons/daemon_settings.dart` (`daemons.settings.v1`) |
| zoo shape, rules, local draw | `lib/daemons/zoo.dart` |
| zoo state: account, guest, seed; on, off or not known yet | `lib/daemons/zoo_controller.dart` |
| Experimental local preview | `lib/settings/experimental_features.dart`; `lib/settings/sections/experimental_section.dart`; `SwarmScreen._experimentalFeaturesChanged`; `ZooController.showPreview` |
| moods, blinks, work steps, activity details, voice | `lib/daemons/daemon_face.dart` |
| the pair brain's frames, shown and armed, confirms, talk and `pair` requests | `lib/daemons/daemon_brain.dart` |
| lessons (list, show, skip, revert; taught only by the live line's key) | `lib/daemons/daemon_lessons.dart` |
| `pair.jsonc`: where it is, the file written when missing, what a rules confirmation turns on | `lib/daemons/pair_rules_file.dart` |
| the first-day consent screen | `lib/widgets/daemon_consent.dart` |
| first-egg habit signals | `lib/daemons/daemon_habits.dart` |
| colours, Flutter status slot, voice line and its keys, a line's detail disclosure, card text, notices, the brief notice | `lib/widgets/daemon_slot.dart` |
| hatch reveal, the consent after it, the level-up morph | `lib/widgets/daemon_hatch.dart` |
| panel and its tabs | `lib/widgets/daemon_panel.dart`, the pair brain's sections in `daemon_panel_pair.dart` |
| native status slot and voice line | `macos/Runner/SwarmTitlebar.swift` (`SwarmSymbolButton`, `SwarmVoiceLabel`) |

`test/daemons/render_frames_test.dart` checks every sprite, portrait, status
cell, card, nest and banner in `daemons/frames.json` byte for byte, and
`test/daemons/plates_test.dart` every plate, `plateColors` cell and plate
card, and that drops on hold show nowhere. Change the
roster, run `node daemons/tools/generate.mjs`, and that test tells you whether
the Dart port still draws what the reference draws.
`test/daemon_review_render_test.dart` draws the slot, the reveal and the panel
in real fonts and, with `HARNESS_DAEMON_CAPTURE_DIR` set, writes them as PNGs.

## The zoo

An account's zoo is read and changed exactly as the desk is: `GET /api/zoo`
and `POST /api/zoo/ops` through the local harnessd (its Unix socket, TCP as the
fallback), refreshed by the `zoo_changed` local frame only when its revision is
news. Writes are queued and retried; every op is idempotent. Habits, pair and
nickname show at once and are confirmed by the answer; eggs and draws are the
server's.

The guest local-zoo rules remain for compatibility and tests, with the same
shape and rules as the server (`daemons.zoo.v1.local`). Each hatch is a separate
individual with its own UID and seed; repeated species never merge XP. Local
individuals carry no server serial. An existing guest zoo can be seeded once
when an account's zoo first answers, preserving the account's own dial and
consent. A 404 never falls back to that local zoo. The experimental preview uses a
separate `ZooSource.preview` and cannot read, write or seed this durable zoo.

At sign-in the guest's zoo is queued first, ahead of any habit report, and
only when the account holds no daemon, egg or habit (the server refuses it
after that). Its answer is a baseline: the guest's eggs come back under server
ids and are not news.

Every zoo the window shows is compared with the one before it: a new egg id is
an arrival and a higher `bond` is a level-up, whether it came in this window's
own answer (`grants`, `levelUps`) or another window's change learned from
`zoo_changed`. A first read and a seed are baselines.

## Earning eggs and growing

Signed in, harnessd counts turns and reports them with `zoo.turn`; the desktop
never sends `zoo.turn` (the turns would count twice). A guest's turns are
counted by the app (a live `turn_started`, then a `turn_ended` without error or
interrupt, not a sub-agent, terminal or the pair harness) and applied to the
local zoo with the server's rules: 20 a local day, a turn egg every 40, week,
marathon, night and history eggs, held eggs when the nest is full (past 64,
`overflowXp` for the pair), and xp for the pair (levels 0–4 on
`rules.bond.levels`, 1.0 at level 2, 2.0 at level 4). A turn that finishes
after the window has been away or idle for `earn.night.awayMinutes` is an
away turn, which is what night eggs count (22:00 to 06:59, named by the day
the night began). The app does not measure a guest's turn minutes, so long
turns count once.

The paired daemon draws at its `version`. A new egg sits in the status slot for
3 s (an ack blink, no line), then the daemon returns and `1 egg` stays after
it until the egg is opened; the tooltip shows one egg look and a count
(`\_O_/ x2 waiting`). A level-up is a slow blink, no line. Before the first
hatch the slot shows the waiting egg itself: the first egg's ready face, or
its kind's `look` (the setup egg is `\_$_/`). The panel shows the bond, xp
toward the next level, and meters: counted turns toward the next turn egg,
today's count against the daily cap, and habits toward the setup egg until it
comes.

Nothing is drawn until the window knows whose zoo it is and the first read has
answered. A signed-in window waits for its profile (the old code keyed its
first reads by a temporary scope and flashed other progress at boot).

## First-egg habits

Each is reported once with `zoo.habit`. The first egg comes at
`firstEgg.need` habits with every `firstEgg.require` among them (today: a
finished turn and any two more), the setup egg at `setupEgg.need` (6). The
nest is render.mjs `nestStage` (ported, checked against `frames.nests`):
without the required habit at most need - 1 count. Every count, threshold
and the checklist's words (`finish a turn in a harness, and any 2 more`, the
required habit marked `needed`) come from the roster, never from the code.

| key | signal in this app |
|---|---|
| `turn` | a turn ends without error in a harness open in a pane here |
| `split` | a tab holds two or more different harnesses |
| `find` | something is opened from the Cmd-O finder |
| `elsewhere` | **not reported**: the app cannot tell which device started a harness; harnessd or the server has to |
| `machine` | another computer of the account is connected (signed in only) |
| `store` | a turn ends in a Store harness |
| `resume` | a paused harness is resumed from this window |
| `days` | the window is in front on three different local days (kept locally per account) |

The panel lists all eight with their shortcuts, the six this computer can do
first (`all of it can happen on this computer.`), then, under `with another
computer or device (never needed):`, `elsewhere` and `machine`, dimmed. No
copy implies a second computer is needed to hatch. Enter on one opens the
place to practise it.

## Creature slot

The top-right slot has a fixed 44pt footprint, independent of mood, name, egg
count and progress. All ten init species and eggs use the illustrated assets
above; future species outside that set use a fitted legacy cell. When disabled,
no space is reserved and the original tab layout returns.

The compact artwork alone occupies the slot. Additional eggs, progress and
activity details live in the panel and accessibility descriptions. Hover is a
look; clicking a ready egg hatches it, otherwise it boops and opens the panel.
The reveal keeps showing an anonymous egg until the new creature is revealed.
The footer's context and model geometry do not depend on the creature.

## Motion

While agents work, the work frame steps once per real agent event
(`AppNotifier.agentPulse`: a turn or tool starting or ending, output
arriving; not a heartbeat), at most twice a second: a burst is one step, and a
baton that stops means an agent that stopped. The portrait's parts step with
it. There is no free-running loop. The return wave (1.3 s) and blinks are the
only timed motion. Reduce Motion, a background window and the **Motion**
setting (the panel's `[ motion ]`, kept per computer) stop all of it; the face
still changes with the mood.

## Voice

Silent by default. **Only a harness waiting on you and a failure take over the
status line**, in the terminal's yellow for 5.2 s, as tmux's message line
does. A reply to something you did (a boop, the first words after a hatch, why
an answer failed) speaks at once, dim, in the status line's own ink. Finished
turns, new eggs, level-ups and returns are never a line: they are a blink,
the wave, the panel and the brief.

A line nobody asked for:

- at most one every two minutes; an answer you give lets the next through;
- never about the pane in front of you (dropped if you switch to it, and the
  brain hears the focused harness in `daemon_presence`);
- waits for Enter, a pane switch or 8 s without a key, never 2 s after the
  last one, and for any dialog, picker or the reveal; dropped after 20 s;
- none at all while the **Quiet** setting is on (the panel's `[ quiet ]`, kept
  until you turn it off); a nap still lasts 15 minutes and lets a need through.

**Templates.** Roster lines may hold slots (`rules.lineSlots`). The window
fills them when it speaks: `{who}` is `engine@machine` of the harness the line
is about, `{q}` its question (one line, at most 48 characters), `{n}` the count
that matters for the mood (working harnesses, waiting questions, idle ones,
failures, the tally), `{summary}` what this window saw while you were away
(`2 done, 1 waiting 40m`). `{recap}` is filled only when a recap is known; the
window does not have the daemon's turn recaps. A slot that cannot be filled
takes its clause with it (sentences, then `, ` `; ` `: ` ` - ` and runs of
spaces); what is left of a sentence that lost a slot must still hold a
filled slot, so a label (`E37:`) or voice v3's tag (`(bell)`, `woof`,
`[exit 1]`) is never a line on its own; a line with nothing left becomes a
neutral one (`a harness needs you.`). Never a literal `{who}`, never a
made-up fact. The panel's idle line
may show the roster's `examples`; every other line is filled from real values.

## The pair brain

When this computer's harnessd has a pair brain ([daemons/BRAIN.md](../../daemons/BRAIN.md),
frame shapes in `cli/src/pair/protocol.ts`) it sends local frames, heard only
from the loopback socket bound to this computer's own harnessd
(`AppNotifier.daemonFrames`: `daemon_*`, `pair_result`); `daemon_*` and
`pair` frames are sent only on that socket, never a relayed one.
`lib/daemons/daemon_brain.dart` holds what was heard.

- `daemon_state` (`pair`, `needs` with each dialog as `detail`, `working` as
  a count, `failing`, `machines` with their status, `done { count, last }`,
  `asks` with their harness and detail, `acted`, `autonomy`,
  `autonomyRequested`, `confirms`) is merged into the face's inputs: its
  needs (same ids as the window's own questions,
  `machineId/agentId#requestId`), work and failures across every machine;
  `asks` and `confirms` make the face `need` (it asks you something);
  `done.count` is the labeled done count; the dial is the badge. `pair: null` keeps the
  roster's lines (a harnessd with no consent yet pairs nothing).
- **Shown, then armed** (BRAIN.md, "Security" 1). A key counts only on a
  line this connection was sent and acknowledged as drawn with `daemon_shown
  { id }` at least 400 ms before. The window sends it once per id, only
  after the line and everything a key on it would act on (its `detail`) are
  on screen, and arms the keys 450 ms later (the daemon's 400 ms and a
  margin for the frame's trip). Until then a key is drawn faint and does
  nothing, in Flutter and natively (`voiceArmed`), ⌘⌥ plus the key passes
  through, and `DaemonBrain.act`/`confirm` send nothing. `[g]` opens at any
  time (the window's own). A `NOT_SHOWN` or `TOO_SOON` answer (a new
  connection) acknowledges the line again and re-arms it. The status line
  acknowledges a keyed line after its first frame, or once its detail
  disclosure has drawn; the brief, each keyed item once drawn; the panel, a
  row only once it and its detail are wholly inside the panel's view. A
  line is new by its id, not its words.
- **Keys first.** A `daemon_say` is shown exactly as sent (`[y/n/g] api@office
  Bash: npm test`), for what is left of its `ttlMs` (5.2 s) since it arrived:
  its keys work only while the line shows, on the brain's clock. The offered
  keys in the leading bracket are the buttons, in Flutter and natively (the
  native label draws the line as sent and hit-tests those cells), and ⌘⌥
  plus the key answers from anywhere in the window, once armed. `[g]` opens
  the harness here (`revealAgentFromAlert`), which is the window's to do; y,
  n and s go out as `daemon_act`, a confirmation's y and n as
  `daemon_confirm`. A second `daemon_say` with the same id replaces the line
  in place with the time the brain says is left.
- **The detail.** A line with keys and a `detail` opens a disclosure under
  the status line (`DaemonDetailNotice`): `[-] api@office · exactly what a
  key does` (or `the lesson, in full`, `what a yes turns on`, `<tim> asks`),
  then the whole command, diff, prompt or lesson, never cut (it scrolls past
  fourteen rows), then the keys named (`y Yes · n No · g open`). `[-]` folds
  it; it goes with the line. Every approval surface shows the harness by
  name and machine and the exact command: the disclosure, each row in the
  panel, a brief's waiting item.
- **The pair speaking.** A `from: 'pair'` line is the pair harness's words,
  not the daemon's facts: drawn after IRC's `<tim>` nick (bold), dim, and a
  `say` from the pair never carries a key, whatever it sends. Its proposals
  (`ask`, `from: 'pair'`) keep their keys, their harness and their detail.
- **Moods.** `need` and `fail` take over the status line in the message
  yellow like the window's own alerts (at most one line nobody asked for every
  two minutes, never about the pane in front of you, never mid-thought).
  `ask` (a proposal, a lesson) is yellow, draws `need`, and shows at once, even
  mid-thought or behind a dialog: its keys are short-lived. `auto` (a rule or
  the pair acted) holds `done` with an ack blink and says it dimly, counted as
  a line nobody asked for; it is also in "what tim did". `say` (the pair
  answering you, or a setting that changed) is a dim reply and draws idle. `done` and `back` are never a
  line: the expression and the brief carry them.
- **What waits for you** (the now tab) keeps what the line could not: every
  confirmation in `daemon_state.confirms`, every proposal in
  `daemon_state.asks` (a proposal's keys work for its ten minutes; one
  proposal, one key, no batches), and every need, with its keys, harness and
  dialog while its line shows and `[g]` after (the brain drops a need's keys
  with its line: a late `y` must never land on the next dialog). A focused
  row answers y, n, s or g from the keyboard once armed.
- **Confirmations** (`pair/gate.ts`). A raise of the dial above `suggest`, or
  a pair.jsonc with rules, the model or a learning opt-in on, waits for the
  person's yes at a window: a `daemon_say` with `confirm { kind, nonce }` and
  a row in `daemon_state.confirms`. The panel shows it under the level it
  raises (settings) and in what waits for you (now): its line, a list of what
  a pair.jsonc turns on (each rule, the model, `learn.borrow`,
  `learn.export`, `learn.agentsMd`, read from the file in its detail), then
  the detail in full. y is `daemon_confirm { requestId, kind, nonce, accept:
  true }`, n keeps it as it is; `daemon_confirm_result` errors are worded
  (`STALE_CONFIRM`: no longer waiting).
- **Talk.** The panel's talk box, and the keymap's **Talk to daemon**
  (`app.daemon_talk`, ⌘⌥T: ⌘⌥Space is macOS's Finder search, and ⌘⌥ plus
  y, n, s or g answers lines), send `daemon_talk { requestId, text }`. The
  panel says the pair harness is waking, starting (a new conversation),
  resuming or reached, or why not (`daemon_talk_result`), keeps the last few
  turns (its answers as `<tim> ...`), and says what a talk costs (the
  result's `cost`). A `retryAfterMs` (six a minute, sixty an hour) disables
  the box and counts down (`again in 30s`). **Open the conversation**
  focuses the `autonomous/pair` harness's pane (the agent the talk reached,
  else the one this machine lists).
- **Autonomy.** The settings tab's dial: watch (the default), suggest, act on
  key ("your key approves one waiting answer at a time; it may drive
  harnesses it started"), act within rules, one line each, posted as
  `zoo.autonomy { level }` (a guest's is kept locally and sent as
  `daemon_presence.autonomy`). `(*)` marks the level the daemon acts at
  (`daemon_state.autonomy`), `(~) ... waits for your yes` a raise it asks
  about (`autonomyRequested`). The floor is stated in full: nothing deleted,
  restarted, forked or bypassed; no push, force, rm -rf, sudo, deploy,
  publish, drop or merge approved; a key a one-time yes, only on a read,
  test, build or in-project edit. `[ rules: ~/.config/harness/pair.jsonc ]`
  writes a commented file meaning "nothing on" (model, learn and rules off)
  when there is none and opens it the way `keybindings.jsonc` is opened.
  Above `suggest` a badge (`[act on key]`) shows beside the name in the panel
  and in the slot's tooltip (`autonomy: act on key`); a raise waiting for a
  yes is in the tooltip too. Until the person consents the dial is disabled:
  the daemon holds `watch`.
- **Consent** (`zoo.consent`). Nothing is watched until the person says yes:
  after the first hatch (any hatch while nobody has answered) the reveal's
  `[ next ]` shows what the daemon sees (README, "What your daemon sees": what
  it reads, never your keystrokes, terminals or files; what it writes,
  nothing to your projects until you allow it, lessons only with your yes;
  where it runs; at watch it only tells you), with `[ Let tim watch ]`
  (`watching: true`, the dial at `watch`) and `[ Not now ]` (`watching:
  false`). Only after a yes, as its own step: "Let tim suggest answers?"
  (`zoo.autonomy suggest`) or keep it at watch. Unanswered, the now tab shows
  the screen; after a no, one line and `[ review what tim sees ]`; settings
  says what was answered and when, with `[ stop watching ]`. A guest says it
  in `daemon_presence.consent`.
- **The brief** (`daemon_brief`, at most five items) shows under the status
  line on return, each item as sent, keys first; it stays up while its keys
  work (a minute) when an item has any, else 10 s, and is in the panel until
  the next one. A keyed item shows its dialog (`detail`) in full under it,
  and a `lesson` item (a lesson's `[s]`) the lesson's text; its keys arm
  once drawn.
- **Lessons** ([daemons/LEARNING.md](../../daemons/LEARNING.md), "Security"):
  a proposal is a `daemon_say` `ask` with `[y/n/s]`, its id
  `lesson:<id>:<nonce>` and the lesson's whole text as its `detail`. Teaching
  is the person's alone: only a key on that live line, sent with its id
  whole (the nonce), once the line and its whole text were drawn and armed.
  The lessons tab shows the proposed lesson in full with its keys; every
  other pending lesson has show and skip and says how to teach it (its `[y]`
  when it is proposed, or `harness pair lessons approve <id>` at a terminal);
  the window never approves through the `pair` request (it would be
  `NONCE_REQUIRED`). `daemon_act_result`'s `learned` or `skipped` is said and
  the list read again; `PERSON_ONLY` and `INSIDE_HARNESS` are worded.
  Approved lessons revert (`lessons revert`, not person-only).
- **What tim did** (the now tab): `daemon_state.acted` (a rule, the pair or
  another machine, what and when), then the lessons it taught with their
  date and `[ revert ]`. An answer typed into a harness cannot be taken back,
  and it says so.
- **Presence** (`daemon_presence`): `active` and `awayMs` when the window
  loses or regains the front, and when it goes idle in front (no key or
  pointer for five minutes: `active: false` with how long; the next input is
  `active: true` with the whole absence), so harnessd knows away turns and
  briefs a return; a focus-only frame whenever the pane in front changes,
  `focusAgentId: null` when there is none (the brain never speaks about what
  you are looking at); `doneSeen` on a look; a guest adds its local zoo's
  `pair`, `autonomy` and `consent` (whether the person said yes).
- Machines `asleep`, `unreachable`, `unlinked`, `old` or `off`, and open
  harnesses on a machine this window cannot reach, are said calmly in the
  panel (`studio is asleep. its harnesses wait.`) and never make the face
  `fail`; only a failed start or a harness whose last turn failed does.

## The reveal

The egg wobbles until harnessd answers, then tells the rarity at the crack: a
rare's shell glows cyan, a legendary's pop throws yellow `*'.` sparks, and a
secret's stage goes black before the crack (light ink on it, on any theme).
A duplicate (`hatched[].duplicate`) has no reveal of a new name: after the pop
it shows yours, `yak x2 · +150 xp`, `another yak. +150 xp.` (and `yours is
shiny now.` for a shiny one), then, if it grew, `yak grew: bond 2 · 1.0` at
its new version; no new card. A new daemon's card carries the server's serial
(`#0042`); a guest's has none. The
0.1 **portrait** appears as `#` in the faint colour for 1200 ms, fills with its
colour and blinks (a filled daemon of drop init shows its plate at the reveal
size, 56 columns and up to 24 rows, looping idle; the reveal floats 60 cells
wide for it); the name types in, in the shared face from
`daemons/banner.json` (`renderBanner`) at a line height of 1.15 so its rows
never touch; then the rarity stamp, `fork() returned 0.`, and the card. From
the person's fourth hatch on, any key skips to the card; Escape closes at any
point; Reduce Motion goes straight to the card.

While nobody has answered the first-day consent, the card (or a duplicate's
merge) ends in `[ next ]`, which shows the consent screen, then the suggest
step (see "The pair brain", Consent); Escape leaves it unanswered, and the
now tab asks again. A duplicate that levels its daemon up shows the grew line,
then the portrait turns from the old version into the new in three frames
(160 ms each; of the cells that differ, a quarter more each frame in
ordered-dither order, on one canvas so nothing jumps), then holds the new
version with the changelog line (`tim 1.0: split-window -h: a second pane;
learned your agents by name`: tim's log is the lookbook's; a daemon without
one says the bond and xp it reached). Reduce Motion goes straight to the held
frame.

## The panel

Before the first hatch: the nest and its habits (above). After, four tabs
like tmux's window list, `1:now*  2:zoo  3:lessons  4:settings`, the one
showing starred and highlighted; 1–4 or a click switch, the last one is kept
per computer (`daemons.settings.v1` `tab`), Escape closes, arrows and j/k
move (the row scrolls into view), Enter acts. The title is the paired
daemon's name, with the autonomy badge above `suggest`.

- **now**: the face and its line (yellow only when something needs you or
  failed), a calm line for each machine not there, waiting eggs, the consent
  screen until it is answered, then with a pair brain: what waits for you,
  the brief, what tim did, and the talk (its cost note under the box).
- **zoo**: the viewed daemon's live portrait (a plate at the portrait size,
  28 columns and up to 12 rows, looping its mood a frame every 170 ms; frame 0
  under Reduce Motion, in a background window or with Motion off; each glyph
  in the plate colour with a soft glow in its bottom colour), or `[ card ]`
  (the portrait plate, idle, frame 0), with `[ copy ]` as a fenced code block;
  identity (`#01/09 tim 2.0 · common · paired`), bond, family, lore, `[ pair ]`
  and `[ rename ]`; the box back of every drop that shows: `#01`..`#09` and
  `#S`, each owned daemon as its sprite at its version in its colour with
  `x2` for duplicates, each empty slot `[ ? ]` (a secret `[ ! ]`), a drop
  announced but not out as `#` silhouettes and its date, a drop on hold not
  at all; the meters
  toward the next earned egg; the waiting eggs, one look per kind with a
  count.
- **lessons**: the proposed lesson in full with its keys, then pending and
  learned lessons.
- **settings**: `[ quiet ]`, `[ motion ]`, `[ nap ]`, the dial with pending
  confirmations, the floor, the rules file and its confirmation, consent.

The talk box takes focus only from Talk to daemon (which opens the now tab);
typing 1–4 or j there is words.

## The finder

The roster ships only `rules.easterHashes` (sha256 of each lowercased word).
Typing `xyzzy`, the one classic the window knows by heart, in Cmd-O answers
with a result row, `Nothing happens.`, that Return never takes; any query whose
hash is an easter hash is sent as `zoo.easter { word }` once from this
window.

## Performance

`SwarmScreen` reads only Reduce Motion from `MediaQuery`, so a resize no longer
rebuilds the workspace. Session rows are built once per tick and shared by the
toolbar, the badge, the native payload and the daemon. Off, none of the daemon's
work runs: no face sync, no habits, no frames, no settings read. There is no idle timer
and no animation loop: work frames step on agent events, and timers only end a
held face, run a blink or the return wave, end a nap, hold a line until you
pause, and clear a spoken line. Agent events reach the face through their own
notifier, so an event never rebuilds the workspace.
