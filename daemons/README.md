# Daemons

Pair-programming buddies that hatch from your work and live in your status line. One daemon pairs
with you at a time. It watches every harness on every machine, tells you what needs you, and runs
the orchestration you ask for. Every daemon can do the whole job; they differ in lore, look and
voice. Each is named after a piece of terminal history, the way **tim** is **t**mux **im**proved.

The lookbook ([lookbook.html](lookbook.html)) shows all of it moving: the status line, the zoo drop
by drop (with a switch to see an announced drop as players do), a working hatch simulation, eggs, growth, moods, memory and learning. This file is the contract the
clients and the server build against.

## Files

| file | what it is |
|---|---|
| `roster.json` | The source of truth: rules, odds, drops (with announce and release dates), and every daemon's art, colours, lore and lines. |
| `tools/render.mjs` | The reference renderer. Every client port draws exactly what it draws. |
| `tools/generate.mjs` | Checks the roster against the art, colour, egg, trait and drop rules and writes the copies below. `--check` in CI. |
| `tools/card.mjs` | Cards and shelves as text and SVG (see "Cards and shelves"). |
| `frames.json` | Generated. Frames every port must reproduce, byte for byte. |
| `desktop/lib/daemons/roster.g.dart` | Generated. The roster as a Dart raw string. |
| `mobile/lib/daemons/roster.g.dart` | Generated. The same raw string for the phone, which depends on no other package here. |
| `backend/src/lib/daemonRoster.g.ts` | Generated. Only what decides a draw, a grant or a level: ids, rarities, drops and their dates, egg, earn and bond rules, easter hashes; and each plate species' trait catalogue, for naming an individual's traits from its seed. |
| `plates/<id>.mjs` | A filled daemon's model: shapes, in every mood, version and animation frame, for the species and for every individual's traits (see "Plates", "Individuals"). |
| `plates/egg.mjs` | The egg's model: every kind's shell through every stage, from whole to open (see "Eggs"). |
| `tools/plate.mjs` | The shader that prints a model as characters, at any width, with each cell's material when asked; and `bakeModel`, every frame of one model (bake.mjs, and harnessd for individuals). |
| `tools/bake.mjs` | Bakes every plate a client shows, daemons' and eggs', and the colour rules every client follows (`plateColor`, `eggColor`, `individualColor`). |
| `plates.json` | Generated (by `generate.mjs`, through `bake.mjs`). Every species plate frame, as text, and every egg frame with its material rows. Baked again only when a model, the shader, the egg kinds or what `rules.plate` says about frames changes; a bake takes minutes. |
| `desktop/lib/daemons/plates.g.dart`, `mobile/lib/daemons/plates.g.dart` | Generated. `plates.json` as a Dart raw string. |
| `cli/src/pair/roster.g.ts` | Generated. Ids, line templates, lore, first words and family: the pair brain's voice and the pair harness's persona ([BRAIN.md](BRAIN.md)); and `awayMinutes`, how long an absence makes a finished turn an away turn. |
| `cli/src/pair/plates/*.g.ts` | Generated. The shader, every plate species' model and the reference renderer, copied as they are (type checks off), with `PLATE_MODELS`, `PLATE_ROSTER` and `PLATE_SOURCE`: harnessd draws each individual with them (see "Individual art"). |

`hn` (the Rust terminal client) reads `roster.json` and `plates.json` with `include_str!` and tests against `frames.json`.

## Words

- **daemon**: the creature. User-facing text calls the background service `harnessd` so the word is free.
- **zoo**: your daemons and eggs. `hn zoo`.
- **individual**: one hatch of a species, with its own seed, traits and name (`pip the tim`). See "Individuals".
- **hatch**: opening an egg. The reveal says `fork() returned 0.`
- **pair**: the one daemon in your status line.
- **drop**: a set of daemons released together. Drop 1 is `init`: `init(8)` is PID 1, the first process
  a Unix machine starts and the parent of every daemon (when a daemon's parent dies, init adopts it). It
  is ten animals hiding in Unix names, drawn filled and in colour, and tim, tmux improved, is its
  octopus. `unix` and `tty` are kept on hold, to come back later as a step up. Drops ship when an idea
  is ready.

## Art rules

Printable 7-bit ASCII only (0x20–0x7e), so every terminal, font, phone and paste into Slack or GitHub
shows the same thing. Turn off ligatures wherever a daemon is drawn, and keep the art safe where that
is impossible (a terminal's own font):

- **No ligature pairs.** Many people keep ligatures on, so no frame may contain a pair that programming
  fonts (Fira Code, JetBrains Mono, Cascadia) draw as one glyph: `rules.ligatureUnsafe` lists them
  (`==` `??` `!=` `::` `~~` `->` `=>` `<=` `>=` `<>` `||` `&&` `++` `//` `^=` `~=` `:=`), and
  `generate.mjs` renders every sprite, portrait, egg line and rare extra's sprite in every mood, frame and
  blink and fails on any of them. So two eyes never touch (tim's `[o o]`, not `[oo]`, or working would
  draw `[==]` as one glyph), and an eye never touches a face character that pairs with a mood's eye (`=`
  `?` `-` beside `>`, `<`, `!`, `^`, `~` or `:`). Put a nose, a mouth, a pane `|` or a space between.
- **Sprite**: one line, at most 8 cells, centred in the status line with one cell of gutter each side.
  Three versions: `0.1`, `1.0`, `2.0`. Every 0.1 sprite has its own silhouette characters, so ten
  hatchlings never read alike at a glance.
- **Portrait**: at most 8 rows by 28 columns. Shown in the daemon's panel, the hatch reveal, the zoo and
  the card. Every daemon in drop 1 draws one portrait per version, growing from the same face (NetHack's
  kitten, housecat, large cat): fewer parts when young, a lore-true feature each release. A missing
  version uses the nearest one drawn.
- **Plates** (drop `init`): a daemon with `plate: true` is drawn filled, the way line printers shaded
  the Mona Lisa: denser characters for more light, from `rules.plate.ink` (`` .,:;ox%#@``). It is not
  drawn by hand. Its model, `plates/<id>.mjs`, is a set of shapes with a `model({ t, mood, age, traits })`
  (no traits: the species plate; see "Individuals"), and `tools/plate.mjs` shades it into characters:
  light from the upper left, round volumes, a dark line where a part crosses the parts behind it, and
  each cell's glyph picked by where its light falls in the cell. `::` is broken as `:;`; `generate.mjs` checks every frame against every ligature pair
  anyway. `bake.mjs` prints each plate at two widths, `rules.plate.cols`: `portrait` (28 columns, at
  most 12 rows) where a portrait shows, and `reveal` (56 columns, at most 24 rows) for the hatch reveal
  and anywhere with room. Every version and mood gets a loop (`idle` 8 frames, the others 4, a frame
  every `frameMs`, 170 ms). All frames of one width and version share one crop, so nothing jumps
  between moods. Clients never run a model: they print the baked text. The versions grow as NetHack's
  pets do, the same animal throughout: the hatchling is mostly head. The status line still takes the
  8-cell sprite, in the same line-art rules as everyone else (a filled daemon cannot be eight
  characters wide). A plate daemon needs no line portrait; its card shows its portrait plate. A part may
  say what it is made of (`mat`), and `plate()` then prints a second set of rows, a letter per cell: `g`
  glow, `s` star, `p` peek (eggs), `m` marks, `a` a rare extra, `e` the odd eye (individuals), `.` none.
  A cell takes a material when at least half its lit samples are made of it; a blank cell never does.
- **Eyes carry the mood.** The body stays still; a mood changes at most two cells of the sprite. A
  portrait may add one or two lore-true mood parts, never more. A daemon may give its own `eyes` per mood
  (and a `lid`): the grue's glow in the dark, tty's are upper case (a Model 33 printed nothing else), and
  rogue's "eye" is whatever lies next to the `@`: floor `.`, a weapon `)` while working, a scroll `?`,
  gold `*`, a trap `^`, the stairs `%`.
- **Charset.** A daemon may keep to fewer characters, as its lore did: `charset` lists what its drawing
  may use, eyes aside, and `generate.mjs` checks every sprite, work frame, portrait, part and mood part
  against it. tty draws only what a Teletype Model 33 could print (the 64 characters from space to `_`:
  no lower case, no `|`); lp0 only a line printer's density ramp, `` .:-=+*#%@``.
- **Placeholders** (see `render.mjs`): `{e}` an eye; `{<part>}` a moving part with a `rest` glyph and
  `work` frames; `{<moodPart>}` a value per mood (tim's mouth `{m}` and tmux window flag `{g}`, vim's
  mode line `{mode}`, fish's mouth bubble `{b}`, ping's sonar `{s}`, biff's mouth `{m}` with its tongue
  out when happy, fzf's match count `{n}`, and the grue's teeth `{t}`, seen only when something was eaten).
  Drop 2: xeyes's pupils, `{a}{b}` looking toward what changed (left, where the panes are, when one needs
  you; right, at you, when you come back) and `{c}{d}` following the pointer `{p}` while agents work;
  oneko's tail `{t}` and its nap `{z}`; cowsay's bubble `{b}` (cowthink's `( )` for a nap) and tongue
  `{t}`, out only when a turn failed (`cowsay -d`); fortune's slip `{f}`; rogue's message line `{m}`
  (`--More--` while something needs you) and the corridor `{w}`, drawn as you walk it; sl's smoke `{s}`,
  ageing as it drifts, and `{h}`, the passengers of `sl -a` crying for help when a turn failed; doctor's
  notepad `{q}`; hack's legs `{l}`; tty's print head `{h}`, ten characters a second; lp0's flames `{f}{g}`.
- **Colour** is a filter over the drawing, never the only signal. Each daemon has one xterm-256 colour,
  `color: { xterm, hex }`, used only on the terminal background (panel, reveal, zoo, card), with a
  darker variant on light themes. A shiny daemon wears its own `shiny: { xterm, hex }` there instead: a
  clearly different, lore-true colour (tim a brighter cyan-green, fish a goldfish, ping deep-sea sonar,
  bat a pale ghost bat, vim the yellow of `hlsearch`, zsh the purple pincher, biff a chocolate lab, fzf
  its own pointer colour, tldr a highlighter, the grue a deep violet; xeyes `-fg magenta`, oneko
  `-tora`, a purple cow, fortune's red ink, rogue's gold, sl flying (`-F`, the galaxy express), doctor a
  rubber duck, hack a winter wolf (NetHack's cyan `d`), tty a glass tty's green phosphor, lp0 a hotter,
  blue flame). `generate.mjs` checks every hex is the xterm index it names. In the status line the daemon takes the status line's own text colour:
  daemon colours fail contrast on tmux's green bar and on the yellow message line.
- **Plate colour.** A plate daemon also has `gradient: { top, bottom }` and `shinyGradient` (each stop an
  xterm index with its hex; every shiny in drop `init` is gold). Row `r` of a plate of `R` rows takes
  the colour `mix(top, bottom, r / (R - 1))`, and each glyph its brightness from `rules.plate.ink`: at
  most 1 mixes from the background toward the row colour (`.` is faint, `#` is the colour itself), above
  1 mixes on toward white by the excess (`@` burns). `bake.mjs` has the reference `plateColor`, and
  `frames.json` has `plateColors` for every port to match. A terminal (hn) prints each glyph's exact
  colour in truecolor; with 256 or 16 colours, the row colour's nearest index, with SGR dim below 0.6
  and bold above 1; with `NO_COLOR`, plain text. A soft glow in the bottom colour is welcome where a
  client can draw one.

## Moods

`idle` content · `work` agents working · `need` a harness needs you · `done` a turn finished ·
`fail` a turn failed or a harness is offline · `back` you returned · `nap` asleep · `boop` clicked.

Moods come from work, never from the clock. The face is decided in this order:

1. `boop` for 900 ms after a click.
2. `need` while any harness waits on you. It wins over everything automatic, and it wakes a nap.
3. `nap` while you asked it to nap (15 minutes, or until you interact).
4. A held reaction: `done` 3 s after a turn you started finishes (at most once per 20 s),
   `back` 1.3 s when you return after 15 minutes or more (it waves), `fail` 4.2 s when a turn fails.
5. `work` while any agent works.
6. `fail` while a harness you have open failed to start or its last turn failed. A machine that is
   asleep or unreachable is not a failure: the panel says so calmly and the face stays as it was.
7. `idle`.

Imported history, reconnects and restored state are baselines, never fresh reactions. Several
finishes at once do not queue.

## Motion and blinks

Every motion is finite and ends at rest. There is no idle animation timer.

- **Working**: the 2.0 sprite steps through its `work` frames, one step per real agent event (a tool
  starting, output arriving), at most two steps a second (tim's arms turn like a twirling baton), and
  the portrait's parts move the same way (tim's arms wave, bat's wings flap, zsh's claws snap, biff's
  tail wags). A baton that stops turning means an agent that stopped. Younger versions borrow the
  baton `|/-\` after the sprite; the face never shifts, because the slot centres on the version's base
  sprite. A Motion setting turns all of this off.
- **Blinks answer something**:
  - `ack`, one blink 160 ms after something it watches changes (a harness needs you, a turn finishes, a test fails);
  - `look`, one blink when you look at it (hover, open its panel, return to the window), at most once per 2.5 s;
  - `slow`, a slow blink (cats show trust this way), about a second long (half-lid, shut, half-lid), when you
    return after a break, when you meet, when it levels up.
  - No blinks while working, napping or booped.
- Reduce Motion and background windows stop all frames; the face still changes.

## Voice

One line at a time, in the status line. Every line carries information; the joke rides on the fact.
Silent by default.

- **Only what needs you takes over the status line** (it becomes tmux's yellow message line for
  5.2 s): a harness waiting on you, and a failure. Finished turns become a small `+3` beside the
  daemon, cleared when you look.
- At most one line nobody asked for every two minutes. Nothing about the pane you are looking at.
- It speaks after Enter, a pane switch, or 8 s without a key, never mid-thought, and never while a
  dialog is open. A Quiet setting keeps it silent until you turn it off; a nap lasts 15 minutes.
- Lines are templates in `roster.json` with slots: `{who}` the harness, `{q}` the question, `{recap}`
  the turn's recap, `{n}` the count that matters, `{summary}` the brief's facts. A client fills them
  from what it knows; a line whose slot cannot be filled is dropped, never shown with made-up facts.
  `examples` holds each line filled with sample values for previews.
- Answer keys come first in the line, and work only while the line is showing.
- A daemon with `typeMs` types its line out, a character every that many ms (tty: a Model 33's ten
  characters a second); the line then shows for its 5.2 s. Reduce Motion, or a client that does not type,
  shows it at once.

## Off switches

Every daemon deploy ships dark: until daemons are turned on, nothing here changes anything for anyone.

- **Server** (`backend/src/lib/daemonsSwitch.ts`). `HARNESS_DAEMONS` is off unless `true`. Off, the zoo
  routes are not registered — `/api/zoo` and `/api/zoo/ops` answer the server's ordinary 404 — nothing
  publishes `zoo_changed` and no socket subscribes to it. On, `HARNESS_DAEMONS_USERS` (comma-separated user
  ids or emails; empty is everyone) limits the zoo to those accounts; any other gets the same 404 before
  anything is read or written.
- **harnessd** (`cli/src/lib/daemonsSwitch.ts`). Idle until `GET /api/zoo` answers 200: no `zoo.turn`
  reporter, no `zoo.lesson` credit, no PairSensor or journal, no brain, no learning (signals, distilling,
  usage, lessons in launches), no pair harness, no pair.jsonc tick — no timers, no files, no model warm-up,
  and one request, the probe: at startup (a sign-in restarts harnessd), at most every 6 hours after that
  (plus up to 30 minutes of jitter), and at once on `zoo_changed`. A 404 is off, and cached; a 5xx or no
  answer is unknown — idle, asked again after 5 minutes, doubling to 6 hours, or at the next reconnect. A
  window's own read through the proxy, and a 404 on a report, count as answers. Once on, it re-reads the
  zoo on `zoo_changed` and every reconnect, as before; a later 404 switches it all off again (reports
  dropped, the pair harness paused). Signed out it asks nothing, and is on only while a window bound to
  this machine says its guest zoo has consent (`daemon_presence { consent: true }`).
- **Local kill switch.** `HARNESS_DAEMONS=0` (or `false`, `off`, `no`) in harnessd's environment, or
  `"daemons": false` in `~/.config/harness/pair.jsonc`, beats the server and a guest window: nothing is
  asked and nothing runs. Set while on, it takes effect within 30 s; cleared, at the next zoo read or start.
- **What harnessd answers while off.** A window's `/api/zoo` and `/api/zoo/ops`: the server's 404, or —
  killed locally — `404 { error: { code: 'DAEMONS_OFF' } }` without asking. `daemon_act`, `daemon_confirm`,
  `daemon_talk`: `{ ok: false, error: 'DAEMONS_OFF' }`. The `pair` request (`harness pair`, the MCP server):
  `{ error: 'DAEMONS_OFF' }`. `daemon_shown` and `daemon_presence` are dropped (but a guest's consent), and
  no `daemon_*` frame is sent. Another machine's `pair_*`: `PAIR_OFF`. `GET /api/status` says
  `daemons: { on, server, killed }`.
- **What every client does** (desktop, phone, `hn`, web). A 404 from `GET /api/zoo`, or a `DAEMONS_OFF`
  result, means off: hide everything daemon-related (the daemon in the status line, the nest, zoo, hatch,
  consent screen, panel and cards), send no zoo ops or `daemon_*` frames, and behave exactly as before
  daemons existed. Ask again on `zoo_changed`, on a reconnect, or at most every 6 hours. A 5xx is not off:
  keep what you had and try later. A guest client keeps its local zoo, as before.

## The zoo (server contract)

The zoo is account state, the same on every client, like the desk but separate from it: a desk
change never re-fetches the zoo and the other way round. It is moving to individuals, one record per
hatch (see "Individuals", "In the zoo"); below is the zoo as built today.

```
GET  /api/zoo        -> { revision, zoo }
POST /api/zoo/ops    -> { ops: [...] } applied in order under `revision`;
                        answers { revision, zoo, hatched, grants, levelUps }
event zoo_changed    { revision }   (same paths as desk_changed: bus -> adapter -> harnessd -> local clients,
                                     and bus -> web socket -> phone and browser)
```

`grants: [{ kind, eggId }]` is every egg that arrived in the nest during the request (first, setup,
easter, earned, or held until there was room); an egg earned with 64 already held arrives as
`{ kind, xp }` instead (see "Earning eggs and growing"). `levelUps: [{ id, level, version }]` is every
daemon whose bond reached a new level. `hatched: [{ eggId, daemonId, shiny, serial? }]` is every hatch;
a duplicate reads `{ eggId, daemonId, shiny, duplicate: true, xp }`. Only the client that sent the
request sees them; every other client learns the same thing by re-reading the zoo after `zoo_changed`
(a new egg id, a higher `bond`, a higher `dupes`).

`harnessd` proxies `/api/zoo` for local clients exactly as it proxies `/api/desk`.

`zoo_changed` goes out only when something a client draws changed (`lib/zoo.ts` `shownZoo`: the daemons
but not their xp alone, eggs, pair, dial, consent, habits, the first and setup eggs). A report that only
tallied — turns, days, batch ids, xp short of a level — still moves the revision, and reaches the other
clients on their next read of the zoo.

```
zoo = {
  daemons: [{ id, hatchedAt, egg, shiny, nickname?, bond, xp, version,
              dupes?, serial?, origin? }],   // one record per roster id; see "Serials and duplicates"
  eggs:    [{ id, kind, grantedAt, date?, origin? }],  // kind is a key of rules.eggs; date on a history egg
  pair:    daemonId | null,
  autonomy: 'watch' | 'suggest' | 'act-on-key' | 'act-within-rules',   // the pair's dial; default watch
  consent: { watching, at } | null,  // the first-day answer: may the daemon watch at all (null: not asked)
  habits:  [habitKey],             // habits done, from rules.firstEgg.habits
  firstEgg: bool,                  // the first egg has been granted
  setupEgg: bool,                  // the setup egg has been granted
  pity:    number,                 // hatches of eggs that can hold a secret since the last secret
  easter:  [sha256],               // easter words already used, as rules.easterHashes entries
  progress: {                      // what counts toward eggs earned from work (server-written)
    turns:    number,              // counted turns, all time (long turns count more)
    days:     { 'YYYY-MM-DD': n }, // counted turns per local day, the last 14 days
    weeks:    ['YYYY-Www'],        // ISO weeks whose week egg was earned (last 8)
    nights:   ['YYYY-MM-DD'],      // nights (by the day they began) counted since the last night egg
    machines: [machineId],         // the first 2 of the account's machines that reported turns
    marathon: ['turns' | 'machines'],  // marathon eggs earned
    history:  ['YYYY-MM-DD'],      // history dates (with their year) whose egg was earned (last 16)
    held:     [{ kind, date? }],   // eggs earned while the nest was full, oldest first (up to 64)
    batches:  [batchId],           // the last 64 zoo.turn batches applied
    lessons:  [lessonId],          // the last 256 zoo.lesson ids credited
  },
}
```

Ops (every op is idempotent; an op on something missing is dropped, never an error):

| op | effect |
|---|---|
| `zoo.habit { key }` | Records a habit. Grants the `first` egg and then the `setup` egg when they are due (see "First egg: habits"). |
| `zoo.hatch { eggId }` | Draws on the server, removes the egg, and adds the daemon (with its serial) or merges a duplicate into the one you have; pairs a new daemon if nothing is paired. Answers `hatched`. |
| `zoo.pair { id }` | Pairs a daemon you own. |
| `zoo.nickname { id, nickname }` | 1–24 printable ASCII characters, or null to clear. |
| `zoo.autonomy { level }` | How much the paired daemon may do on its own ([BRAIN.md](BRAIN.md), "Autonomy dial"). A level the server does not know is dropped. A request: each harnessd acts above `suggest` only after the person confirms it at a window there ([BRAIN.md](BRAIN.md), "Security"). |
| `zoo.consent { watching }` | The first-day consent screen's answer (see "What your daemon sees"). Sets `consent { watching, at }` (`at` moves only when a request changes the answer). Every yes sets the dial to `watch`, a repeated one too (the person opts into more with a dial move after it); a no leaves the dial, and the next yes starts at `watch` again. In one request the dial ends at the person's last move, so a request delivered twice lands where it did the first time. Until `watching` is true no harnessd senses anything. Never seeded. |
| `zoo.easter { word }` | The server trims and lowercases the word and hashes it (sha256); a hash in `rules.easterHashes` grants one `easter` egg, once per word. |
| `zoo.seed { zoo }` | A guest's local zoo on first sign-in. Applied only while the account zoo is empty. Brings only regular daemon ids, first and turn eggs, and habits (see Details). |
| `zoo.turn { batchId, n, minutes?, away?, day, hour, machineId }` | Turns finished on one machine in one local hour (see "Earning eggs and growing"). harnessd sends it. Self-reported (see below). |
| `zoo.lesson { lessonId, daemonId }` | A lesson the person approved ([LEARNING.md](LEARNING.md)): `rules.lessonXp` (25) xp for `daemonId` when you own it, else for the paired daemon, level and version recomputed and answered in `levelUps`. Once per lesson id (the last 256 are remembered); with no daemon to grow nothing happens and the id is not remembered. harnessd sends it when a lesson is approved, signed in only; `lessonId` is 1–64 id-safe characters. Self-reported, like `zoo.turn`. |

Limits: 12 eggs, 64 daemons (a duplicate merges, so it never needs a place). The server alone grants
turn, week, marathon, night and history eggs from the turns reported to it; clients never send a draw
result or an egg.

**Self-reported.** `zoo.turn` (and the presence behind its `away`) and `zoo.lesson` are what a harnessd says
happened; anything holding the account's token can say it. A person can only ever cheat their own zoo, and the
daily cap bounds even that. Nothing in a zoo is proof to anyone else: a card's serial and rarity are not
verified (a later verify endpoint will be), and a guest's seeded daemons and eggs are marked `origin:
'local'`.

**Drops.** Each drop in `roster.drops` has `announce` and `release` (UTC `YYYY-MM-DD`, announced 14
days before release), or `hold: true` and no dates. Only released drops are drawn from; a drop announced
but not yet released shows on shelves as silhouettes, and one not yet announced, or on hold, shows
nowhere. Drop 1, `init`, is released (announced 2026-09-13, released 2026-09-27). `unix` and `tty` are
on hold: kept in the roster, never drawn, seeded, hatched or shown, until they get dates.

**The draw** (`zoo.hatch`, server only, `crypto.randomInt`):

1. **Regulars first.** Eligible: every regular (not a secret) of a released drop that you do not own.
   Once you own every released regular, every released regular is eligible again (a duplicate).
2. **Secrets sit outside the set.** A secret never counts toward "every regular owned", and owning or
   missing it never holds duplicates back. An unowned secret of a released drop is eligible only from
   an egg whose `weights.secret` is above 0: the night egg (8) and the easter egg (10).
3. **Weight**: `egg.weights[rarity] / (eligible daemons of that rarity)`, plus `pity * pityPerMiss` for
   a secret, times `egg.boost[id]` when the egg has one (the first egg: tim x4; the night egg: bug x4,
   the moth drawn to your screen's light).
   A rarity with no eligible daemon gives its weight to nothing (it is not redistributed).
4. **Pity** counts only hatches of eggs that can hold a secret: it resets on a secret (from any egg)
   and grows by one on any other hatch of such an egg. **The guarantee**: when it stands at
   `secretGuaranteeAt - 1` (7) and a released secret is unowned, the next hatch of such an egg draws
   only from the unowned secrets. So the 8th night or easter egg without beastie is beastie.
5. **Shiny**: 1 in `shinyOneIn` (256), independent of who hatched.
6. An egg with nothing eligible that weighs anything (an easter egg once every legendary and beastie
   are owned) draws from every released daemon, as if you owned them all: a duplicate.

**Details** (as built in `backend/src/lib/zoo.ts`; a guest client follows the same rules):

- A daemon's `egg` is the kind of egg it came from (the card's "first egg"). Egg ids come from the server.
- One record per roster id: `pair` and `zoo.nickname` address it by id. A zoo stored (or seeded) from
  before duplicates merged, with two records of one id, reads as one: the first, shiny if either was,
  the others counted in its `dupes` (no xp for them).
- A name the server does not know (a habit key, an easter word, an egg id, a daemon you do not own)
  drops that op. A malformed op, such as a 25-character nickname or a `zoo.turn` whose `away` is more
  than its `n`, refuses the whole request. Nicknames are trimmed.
- A full nest does not lose anything: the first and setup eggs arrive with the next habit report, an
  easter word stays unspent, and earned eggs are held.
- `zoo.seed` brings only what a client could not have made valuable, because all of it was drawn and
  counted on a client: the REGULAR daemons of released drops (never a secret, never a drop not yet out), each fresh at `0.1` —
  no shiny, xp, bond, duplicates or serial, its nickname kept — the `first` and `turn` eggs (never an
  egg that can hold a secret: night, easter; nor setup, week, marathon or history eggs), and the habits,
  every daemon and egg marked `origin: 'local'` and each egg given a server id. Pity, easter words,
  progress, the dial and consent stay the account's own. It pairs the guest's pair if it survived, else
  the first daemon. A guest with nothing that survives seeds nothing. `zoo.seed` is refused once the
  account holds any daemon, egg or habit, so a client seeds right at sign-in.
- Held eggs land after any op that leaves room, a hatch included, oldest first, and are answered in
  `grants` like any other.
- Easter words never ship: the roster holds `rules.easterHashes` (sha256 of the lowercased word), and
  the zoo records the hash of each word used (a word stored before hashing reads as its hash). A client
  that wants to react locally to `xyzzy` may hard-code that one classic.

**Serials and duplicates.**

- **Serials.** Every server hatch of a daemon the account did not own takes that daemon's next mint
  number: `DaemonMint { daemonId @unique, count }` (Mongo), one counter per roster id across every
  account, bumped with an atomic increment (created at 1 on the first hatch anywhere; two first hatches
  at once turn the loser's create into an increment). The daemon keeps it as `serial` (1-based) and
  `hatched` answers it; the card shows `#0042`. A serial minted for a write that lost the revision race
  is reused by the retry's hatch of the same daemon; a request that never writes leaves a gap. A number
  is never given twice. A guest's daemons (`origin: 'local'`) and daemons hatched before serials have
  none.
- **Duplicates.** A hatch that draws a daemon you own (every regular owned, or an egg's fallback) merges
  into it: `+rules.duplicateXp` (150) xp to that daemon, whether or not it is paired, with its level and
  version recomputed and any new level answered in `levelUps`; if the duplicate was shiny, yours
  becomes shiny (never the other way); its `dupes` grows by one (the shelf's `x2` is one). It takes no
  serial, no place in the 64, and never pairs. `hatched` answers `{ eggId, daemonId, shiny,
  duplicate: true, xp }`, `shiny` being the duplicate's own roll.

**Guests** (no Harness account) keep a local zoo with the same shape and rules, drawn on the client.
On first sign-in it is sent once with `zoo.seed` (which keeps only what is listed above). A guest's
turns are counted by its client, not by harnessd (which reports only while signed in). A guest window
says its pair, dial and consent in `daemon_presence { pair, autonomy, consent }`.

## What your daemon sees

For the first-day consent screen (`zoo.consent`). Nothing below happens until the person says yes; saying
no (or never answering) leaves every harnessd sensing nothing. [BRAIN.md](BRAIN.md) has the detail.

**What it reads**, on each of your machines, only for that machine's own coding agents:

- when each agent's turns start and end (from the session transcripts Harness already reads);
- a question an agent is waiting on: the whole dialog on its pane — the command, the edit's preview,
  the options — and the agent's open tool call from its transcript, to read it exactly;
- the short recap of each finished turn;
- to notice a lesson (LEARNING.md): your next prompt after a turn (is it a correction?), and the commands
  and failures in its turns; with `learn.borrow` on, what Hermes, Claude Code and Codex learned on their own;
- `~/.config/harness/pair.jsonc`, your rules and learning opt-ins (they apply only after you confirm them at
  a window).

It never reads a terminal (a shell is not an agent), an Orchestrator's sub-agents, or its own harness.

**What it writes**, on that machine, in Harness's data folder (0600):

- a journal of the last 2,000 events: turns done, questions and answers, recaps, failures, and everything
  it did and who asked (a key, the pair, a rule, another of your machines). Keys, tokens, passwords,
  emails and your home folder are taken out before a line is written;
- what you confirmed (`pair/confirmed.json`), the harnesses the pair started, the pair harness's token and
  workspace, the week's lesson signals (redacted), and — only on your yes — lessons in `~/.harness/lessons`
  (LEARNING.md): an approved note in the project's untracked `.harness/lessons.md` (its AGENTS.md only for
  a project you opted in), and with `learn.export` a copy of each approved skill in `~/.agents/skills` or
  `~/.claude/skills`.

**Where it goes.** The journal stays on the machine. Another of YOUR machines' daemons can read it over
the end-to-end sealed link, redacted; the Harness backend never can (it holds no keys). The account zoo
holds only which daemon is paired, the dial, this consent and when, habits, eggs, turn counts and the
ids of lessons credited — no questions, commands, recaps or lesson text. A model sees any of it only if you
opt in (`"model": true`: one small call per new question, and one to distill a lesson, redacted) or when
you talk to the pair harness (it reads through its tools, redacted), each a turn of your own engine.

**What it does.** At `watch` (where it starts) nothing but tell you. Above that, only what the dial you
chose — and confirmed at a window — allows, and never: delete, restart, fork or bypass anything; type
into a terminal; approve a push, force, `rm -r`, sudo, deploy, publish, drop or merge; choose "don't ask
again"; answer a question the agent asks you or a plan. Another machine can only answer an allow-class
prompt here.

## Earning eggs and growing

Work earns eggs; the server decides. `harnessd` reports turns, the server counts them under
`rules.earn`, grants eggs, and grows the paired daemon under `rules.bond` (`backend/src/lib/zoo.ts`).

**What counts as a turn** (`cli/src/lib/zooTurns.ts`). A turn counts when `turn_ended` arrives for a
turn whose `turn_started` harnessd saw live: the engine normalizers' prompt record, which already
leaves out tool results, injected context, compaction summaries and interrupts. Never counted: a
replayed transcript or a turn picked up at attach, a sub-agent's turn (an Orchestrator specialist, or
its Director while specialists are out), a terminal, the pair harness (`dsh` `autonomous/pair`), a turn
killed by an interrupt. There is no per-prompt signal that a person typed it (a delivered message has a
`deliveryId`, a prompt typed straight into a pane has nothing), so a prompt typed by a script or a
`/loop` counts too; the daily cap bounds it.

A counted turn carries two facts:

- **minutes**: whole agent-minutes from its first live `turn_started` to its `turn_ended` (a second
  live start before the end, a prompt queued into a running turn, keeps the first), at most 1,440.
- **away**: whether the person was away from this computer when it finished: no attached window or
  `hn` active for 30 minutes (`earn.night.awayMinutes`). harnessd knows this from its local clients
  (`LocalPresence`): here while any attached client is active (one that never said otherwise is), away
  from the moment the last one sent `daemon_presence { active: false }` (less the `awayMs` of idle it
  reports) or detached. Until a client has come and gone, the absence counts from harnessd's own
  start, so a restart never makes a turn an away turn. Tool clients (`harness pair`, the MCP server)
  are never presence.

**Reporting.** Counted turns gather for 60 s, then go out as `zoo.turn` ops, one per local day and hour,
through the same signed-in backend path harnessd uses for `/api/zoo`. `day` and `hour` are the machine's
local time when the turn finished; `machineId` is the machine's id; `minutes` and `away` are the sums of
the batch's turns, sent only when above 0 (so a server from before them takes the rest). A bucket past
50 turns is split, its minutes and away turns going with the first ops that can hold them. Each op has
a fresh `batchId`; a send that failed is retried a minute later with the same ids, beside newer ops (at
most 64 wait). A 400, 401 or 403 drops the report; a day the server would no longer take is let go.
Shutdown sends the last minute, waiting at most 2 s.

**`zoo.turn { batchId, n, minutes?, away?, day, hour, machineId }`**: `batchId` and `machineId` are 1–64
id-safe characters, `n` is 1–50, `minutes` 0–72,000 (a day per turn), `away` 0–`n`, `day` a real
`YYYY-MM-DD` in 2000–2999, `hour` 0–23. Anything else refuses the request. Absent `minutes` or `away`
is 0. Then, in order:

1. A batch id among the last 64 applied is dropped (a retry of a send that landed).
2. A `day` that cannot be today anywhere on Earth (UTC−12 to UTC+14) is dropped, allowing one day late:
   from two days before the server's UTC date to one day after.
3. **Machine**: the first 2 of the account's machines to report are remembered; the second earns a
   **marathon** egg, once. An id that is not one of the account's machines is not remembered, but its
   turns count.
4. **Long turns count more**: the batch is `n + floor(minutes / earn.turn.minutesPerTurn)` counted
   turns (every 10 agent-minutes is one more).
5. **Daily cap**: at most `earn.turn.dailyCap` (20) counted turns per local day, whatever machine
   reports them and however long they ran. Only counted turns do anything below.
6. **turn** egg every `earn.turn.every` (40) counted turns. **marathon** egg once at
   `earn.marathon.turns` (500).
7. **week** egg once per ISO week (Monday start; 2027-01-01 is in 2026-W53) once `earn.week.days` (3)
   distinct local days of that week have a counted turn.
8. **night** egg: a night counts when a batch with counted turns has `away` above 0 and its `hour` is in
   the night hours `fromHour`–`toHour` (22:00 to 06:59, across midnight). A night is named by the day
   it began: 23:00 on the 21st and 02:00 on the 22nd are the same night, the 21st's. When
   `earn.night.nights` (3) distinct nights have counted, the egg is earned and the count starts again
   from none. Nights need not be in a row. The night egg is the only ordinary egg that can hold the
   secret (beastie).
9. **history** egg: `rules.historyDates` maps `MM-DD` to the daemon that day belongs to, or null:
   `04-01` teapot (HTTP 418), `08-25` tux (Linux announced, 1991), `09-09` bug (the first actual bug,
   1947), `09-27` gnu (GNU announced, 1983), `10-31` zombie (processes).
   Each date's egg is open for `earn.history.days` (7) days from the date (09-09 to 09-15; 12-30 would
   run to 01-05 of the next year), earned by the first counted turn in that week, once per date per
   year. The egg carries `date: 'YYYY-MM-DD'`, the date it remembers (with the year its week began), not
   the day it was earned. teapot and zombie do not exist yet. Hatched, a history egg gives its date's
   daemon when a released drop holds it and you do not own it; otherwise it draws from the usual pool
   with `eggs.history` weights, which hold no secret.
10. **Bond**: the paired daemon (the one with the paired id) gains `bond.xpPerTurn` (1) xp per counted
    turn, plus `bond.xpPerDay` (5) for the first counted turn of a local day. `bond` is the level its xp
    reached on `bond.levels` [0, 50, 150, 300, 600] (levels 0–4); `version` follows `bondForVersion`:
    0.1, 1.0 at level 2, 2.0 at level 4. Nothing is earned without a pair, and xp never goes down. At
    the cap a full day is 25 xp, so 2.0 takes about 24 full days. A duplicate hatched gives its daemon
    150 more (see "Serials and duplicates").
11. A batch that changed nothing (its day already at the cap) is not remembered, and writes nothing.

**A full nest** (12 eggs): an earned egg is held in `progress.held`, oldest first, up to 64, and lands
when there is room (after the op that makes it). Held eggs never vanish: earned past 64 held, an egg
becomes `rules.overflowXp` (50) xp for the paired daemon, levels answered in `levelUps`, and is answered
in `grants` as `{ kind, xp }`. (With nothing paired, nothing has hatched to grow, and it is lost.)

**Stored daemons** from before xp read `xp` as the least xp their stored `bond` needs; `bond` and
`version` are always read back from `xp`, so they never disagree.

Bond also comes from lessons you approve (`zoo.lesson`, 25 xp for the daemon that found it). Not built:
the lookbook's "first merged PR" marathon, and bond from suggestions you take or talking to the daemon. What the client shows for a grant or a level-up (a new egg in
the nest, a slow blink, the release's changelog) is the client's.

## First egg: habits

The first egg arrives after 3 of these 8, in any order, as long as one of the three is `turn`
(`firstEgg.need` 3, `firstEgg.require` `['turn']`): a finished turn plus any two others. A second
egg, kind `setup`, arrives at 6 habits (`setupEgg.need`), after the first, once, drawn from the usual
pool (the same weights as a turn egg). Each client reports the ones it sees with `zoo.habit`.

| key | counts when |
|---|---|
| `turn` | A turn you started finishes in any harness. |
| `split` | Two harnesses are side by side in one tab. |
| `find` | You open something from Cmd-O (or `hn`'s finder). |
| `elsewhere` | You answer a harness from a different device than the one that started it. |
| `machine` | A second computer connects to your account. |
| `store` | A turn finishes in a Store harness. |
| `resume` | A paused harness is resumed. |
| `days` | You use Harness on three different days. |

The first egg leans toward tim (`eggs.first.boost` tim x4: about 42%, four times any other common), so
most people meet tim first and get the joke. While it incubates it cracks as habits count toward it
(see "Eggs"): `render.mjs` `habitProgress` counts them, and without a finished turn at most 2 count;
`eggStage` turns the count into a stage (`frames.json` `firstEgg`). An egg never hatches on its own;
clicking a ready egg opens it.

## Eggs

Every egg is drawn filled, like drop `init`: a shaded shell (`plates/egg.mjs`) in its kind's pattern and
colour, so each kind looks different the way a blind box's art tells you the series. It cracks as you
earn it and cracks open when you open it. Its rarity shows only then: while you earn it, the light
inside is plain.

**Stages.** While you earn it: `p0` whole; `p1` a crack part way across; `p2` all the way, with a chip
knocked out; `p3` split a little, light inside; `p4` ready: it rocks in the nest and two eyes peek out
of the chip. Opening it: `rock` (two big rocks), `burst` (the top lifts and light pours out), `tumble`
(the top breaks in two, the halves land either side, bits of shell scatter) and `open` (the bottom
half; the hatchling then rises out of it).

**Which stage** (`render.mjs` `eggStage(done, need, ready)`, pinned in `frames.json` `eggStages`): `p4`
once the egg is earned and waits in the nest; otherwise by `done / need`, `p0` at none, `p1` below a
third, `p2` below two thirds, `p3` from there. What counts toward each kind:

| egg | done / need |
|---|---|
| first | habits (`habitProgress`: until a finished turn is among them, at most `need - 1` count) / `firstEgg.need` |
| setup | habits / `setupEgg.need` |
| turn | `progress.turns % earn.turn.every` / `earn.turn.every` |
| week | local days of this ISO week with a counted turn / `earn.week.days` |
| night | `progress.nights` / `earn.night.nights` |
| marathon | `progress.turns` / `earn.marathon.turns`, until it is earned |

Easter and history eggs arrive earned. The status line shows one egg, the nearest to hatching: an
earned egg waiting in the nest (`p4`) if there is one, else the egg being earned with the highest
`done / need`.

**One line.** In the status line an egg is one line of at most 8 cells, in the bar's own colour
(`rules.eggLine`, `render.mjs` `eggLine`, pinned in `frames.json` `eggLines`). `{k}` is the kind's
`rules.eggs[kind].mark`: first a space, setup `$`, turn `.`, week `7`, marathon `@`, night `*`, easter
`?`, history `#`.

| stage | line | stage | line |
|---|---|---|---|
| `p0` | `\_({k} )_/` | `rock` | `\_(oo)_/` |
| `p1` | `\_({k}')_/` | `burst` | `'*(oo)*'` |
| `p2` | `\_(/\)_/` | `tumble` | `')_^^_('` |
| `p3` | `\_(*')_/` | `open` | `)\_^^_/(` |
| `p4` | `\_(oo)_/`, blinking `\_(--)_/` | `hatchling` | `)` + its 0.1 sprite + `(`: `)(o o)(` |

A ready egg blinks when a daemon would (`rules.blinks`). The hatchling line is the hatchling's 0.1
sprite between the halves of its shell when that fits 8 cells, else the sprite alone; an individual
with a rare extra shows that extra's sprite (see "Individuals"). `generate.mjs` checks every line with
every mark and blink, and every hatchling's, against printable ASCII, 8 cells and
`rules.ligatureUnsafe`.

**Opening** (`rules.plate.eggMs`): the ready egg's `p4` frames, then `rock` twice through (65 ms a
frame), `burst` (the first frame holds 420 ms, then 150 ms each), `tumble` (75 ms each), `open` (380
ms), and the hatchling's reveal plate rises out of the bottom half a row at a time. While it waits in
the nest, `p0` and `p4` loop a frame every 190 ms (`eggMs.loop`); `p1` to `p3` hold still. Reduce
Motion shows each stage's first frame and goes straight to the card.

**Colour** (`bake.mjs` `eggColor`, pinned in `frames.json` `eggColors`). The shell runs down its kind's
`rules.eggs[kind].gradient { top, bottom }`, a row at a time, each glyph's brightness from
`rules.plate.ink`, exactly as a daemon's plate does:

| egg | top | bottom |
|---|---|---|
| first | cream `#ffffd7` | `#d7d7af` |
| setup | lavender `#d7d7ff` | `#8787d7` |
| turn | white `#eeeeee` | `#a8a8a8` |
| week | robin's egg `#afffff` | `#5fafaf` |
| marathon | orange `#ffd7af` | `#d7875f` |
| night | `#8787d7`, with pale `#ffffd7` stars (`rules.eggs.night.stars`) | `#5f5f87` |
| easter | pink `#ffafd7` | `#af5faf` |
| history | sepia `#d7af87` | `#875f5f` |

A glow cell (`g`, the light inside) is `rules.plate.light.plain` (`#ffffd7`) while the egg is earned
and the rarity's light once it is opened (`light.common` `#eeeeee`, `rare` `#5fd7ff`, `legendary`
`#ffd75f`, `secret` `#af87ff`); a peek cell (`p`) is `light.peek`, white; a star (`s`) is the kind's
stars. A secret's opening goes dark: the stage turns black, the shell dims to 0.22 of its colour and
the stars to 0.3, and only the violet light shows. Every hex is the xterm-256 index it names
(`generate.mjs` checks). A soft glow in the bottom colour, or in the light once it is opened, is welcome
where a client can draw one.

**Baked** into `plates.json` as `eggs[kind][size][stage] = [{ rows, mats }]`, each its rows joined by
newlines: `portrait` 28 columns and `reveal` 56 (`rules.plate.cols`); `p0` and `p4` 8 frames, `p1` to
`p3` 1, `rock` 8, `burst` 6, `tumble` 8, `open` 1 (`plates/egg.mjs` `STAGES`). Every stage of one kind
and width shares one crop, so nothing jumps as it opens. `mats` holds each cell's material: `g` glow,
`s` star, `p` peek, `.` shell or nothing. `generate.mjs` checks every frame like a daemon's plate, and
its material rows against its rows. These replace the one-line looks (`rules.eggs[kind].look`), the
line-art egg (`rules.egg`) and the nest (`rules.nest`, `nestStage`).

## Individuals

A species (tim, the octopus) is a type. Every hatch is its own individual: a seed the server draws, the
traits that follow from it, a serial, and the name the person gives it at the hatch. Duplicates of a
species are normal, and two identical individuals practically never happen; people collect species
and traits. Traits read as command-line flags, `tim -c coral --spots --glasses --fidgety`, and a card
says how rare that look is: `1 in 515`.

**The catalogue** (`roster.json` `daemons[].traits`, for every plate species):

```
traits: {
  colours: [[name, weight, top, bottom]],     // colour families; the first is the species' gradient
  marks:   [[name | null, weight]],           // markings; null is none
  extras:  [[name | null, weight, hex, { sprites: { 0.1, 1.0, 2.0 }, work: [...] }]],
                                              // rare extras: their colour and status-line variant
  props:   { key: [lo, hi] },                 // proportions, each a range around 1
  flags:   { key: { high?, low? } },          // a proportion's flag near an end of its range
  accents: [hex],                             // the colours markings are painted in
  oddEye:  0.02,                              // the chance of an odd eye
  fidgety: 0.3,                               // the chance of a fidgety temper
}
```

Six colour families (the rarest about 6%), four markings, three to five proportions and three
rare extras per species (together 12%, each 3 to 5%), lore-true: tim's beanie and headset, gnu's
mortarboard, mutt's mail bag, bug's lamp to circle, auk's top hat. `generate.mjs` checks that every hex
is an xterm-256 colour, the weights whole, every name a short lowercase flag meaning one thing, every
range around 1 and the first colour the species' gradient; and that the model takes every trait: its
`DEFAULT` holds every proportion at 1, and every marking, extra and the odd eye paints cells of its own.

**The roll** (`render.mjs` `rollTraits(roster, id, seed)`, pinned in `frames.json` `traitRolls`, which
every port matches exactly, the server's TypeScript first). The seed is a whole number from 1 to
4294967295, drawn with `crypto` at the hatch and stored; traits are derived from it, never stored as
truth. One stream of mulberry32 on the seed (`plate.mjs` `rng`) is drawn in this order: the colour,
the markings, the extra (each a weighted pick: `r * total weight`, walked down the list until it drops
below 0), the odd eye (`r < oddEye`), each proportion in the catalogue's key order (`lo + (hi - lo) *
r`, rounded half up to hundredths), and the temper (`r < fidgety`). The accent is `accents[seed %
accents.length]`. Seed 0 is the species as it was drawn before individuals: the first colour, no
markings, no extra, every proportion 1, calm. The result:

```
{ seed, colour, marks, extra, oddEye, <each proportion>, temper: 'calm' | 'fidgety', accent }
```

**Flags** (`individualFlags`): the species, `-c` and the colour, then `--` and the markings, the extra,
`--odd-eye`, each proportion's `high` flag when it falls in the top fifth of its range (`v >= hi - (hi -
lo) * 0.2`) and its `low` flag in the bottom fifth, in catalogue order, and `--fidgety`.

**Rarity** (`oneIn`): `round(1 / p)`, p the chance of its colour, its markings, its extra and its eyes
(odd or not) together. Proportions and temper do not count. Shown as `1 in 2,130`.

**Status line** (`renderIndividualSprite`, `individualDaemon`, pinned in `frames.json`
`individualSprites`). Eight cells in the bar's own colour, so traits show only in characters: an
individual with a rare extra uses that extra's sprites and work frames, in the species' sprite
contract (`generate.mjs` checks them like every sprite: width, printable, ligatures after every eye and
blink, unlike any other daemon's); a fidgety one steps its work frames at half `workMs`. Colour,
markings and the odd eye do not show there. Centre it on `baseWidth` of `individualDaemon`.

**Individual art.** An individual's plates are drawn on the person's machine by harnessd, with the
same shader and models (`generate.mjs` copies them into `cli/src/pair/plates`): `bakeModel(
PLATE_MODELS[id].model, PLATE_ROSTER.rules, { traits: rollTraits(PLATE_ROSTER, id, seed), mats: true
})` has the shape of a species plate, `[size][version][mood]`, each frame `{ rows, mats }`: `m` a
marking, `a` the extra, `e` the odd eye, `.` the body. harnessd caches them per individual (species,
seed and `PLATE_SOURCE`) under the adapter's data folder and serves them on request. An individual's
canvas may have room above its species' for a hat or long tufts, whole portrait rows and at most
`rules.plate.room` (3) of them, so its plates stay within `rules.plate.maxRows` plus that: 15 rows at
the portrait, 30 at the reveal. Until its art arrives, a client shows the species plate painted in the
individual's colour family.

**Colour** (`bake.mjs` `individualColor`, pinned in `frames.json` `individualColors`): the body runs down
its colour family (a shiny one's runs down the species' `shinyGradient`), a marking is its `accent`, an
extra its catalogue colour, the odd eye `rules.plate.oddEye` (`#5fffd7`); every glyph's brightness from
`rules.plate.ink`, as a daemon's plate.

**In the zoo** (the server builds this next, in `backend/src/lib/zoo.ts`). A zoo holds individuals,
`{ uid, id (species), seed, serial, name?, shiny, xp, bond, version, hatched, egg }`, and `pair` names a
uid. A hatch mints the species' serial (`DaemonMint`, per species) and draws the seed. The draw keeps
the species weights; duplicates are allowed; the first 4 hatches of an account are always a species it
does not own, and after 8 hatches in a row with no new species the next is a new one, while an unowned
released regular exists. Secrets as before. Ops address a uid: `pair { uid }`, `zoo.nickname { uid,
name }` (the name given at the hatch). A zoo from before (one record per species, `dupes`) reads as
individuals with seed 0, one per record. At most 256 individuals.

## Hatching

Open, silhouette, name, card (Reduce Motion: straight to the card): the ready egg rocks, bursts in its
rarity's light and the top tumbles off (see "Eggs"); the hatchling rises out of the bottom half as `#`
in the faint colour, holds 850 ms, fills with its colour (an individual's own colour family), blinks;
its name types in as a banner in the face from `banner.json` (`renderBanner`); the rarity stamp, the
individual's flags and `1 in N`, and first words appear, and the person names it. A secret's reveal
starts pitch black. The card copies as a fenced code block:

```
.----------------------------------------.
| #01/09  DROP 1: INIT            COMMON |
|                                        |
|                   .,                   |
|                 x####x                 |
|                %####%%;                |
|                x%;%%;;x                |
|                :%x%%x%,                |
|                :;:;:;:;                |
|                                        |
|   pip the tim 0.1  #0042               |
|   tim -c coral --spots --beanie        |
|   1 in 644                             |
|   screen -> tmux -> tim                |
|                                        |
|   "oh hi. i'm tim. tmux, improved.     |
|   what are we building?"               |
|                                        |
|   hatched 2026-09-27, turn egg         |
'----------------------------------------'
```

Until the zoo holds individuals, a duplicate has no reveal of its own name: it says it merged
(`another tim. +150 xp.`), and a shiny one says yours is shiny now. A shiny hatch fills with the
daemon's shiny colour.

## Cards and shelves

`daemons/tools/card.mjs` draws what people share. A card is the daemon's portrait at its version, its
number, rarity (`SHINY` first when it is), name, serial (`#0042`, when it has one), lineage and first
words, 42 columns of printable ASCII, copied as a fenced code block. The same lines render as SVG for
places a code block does not travel (X, previews, a GitHub profile README), in monospace system fonts;
a shiny card's portrait wears the roster's shiny colour. A shelf is a drop as a box back: owned sprites
in their colours (shiny ones in their shiny colour), `x2` beside a daemon with one duplicate merged in,
`[ ? ]` for a numbered slot still empty, `[ ! ]` for a secret. A drop announced but not yet released
shows its regulars as `#` silhouettes of their 0.1 sprites and its release date; one not yet announced
shows nothing. Cards and shelves never show a live mood, so they never reveal whether you are working.

An individual's card (`cardLines` with its `traits` and `name`) says `pip the tim 2.0  #0042`, then its
flags wrapped as a long command is (` \` at the end of a line, the next indented two), then how rare it
is (`1 in 2,130`); it shows the individual's own portrait plate once harnessd has drawn it, else the
species plate. Its SVG runs down its colour family.

Secrets sit outside the numbered set, and every drop numbers its own: drop 1 is tim `#01/09` to auk
`#09/09`, and beastie is `#S/09`. A plate daemon's card shows its portrait plate (idle, first frame);
its SVG runs down the daemon's gradient, a row at a time.

```
node daemons/tools/card.mjs tim --version 2.0 --serial 42          # a card as text
node daemons/tools/card.mjs tim --version 0.1 --seed 13 --name pip   # an individual, drawn by its model
node daemons/tools/card.mjs tim --version 2.0 --shiny --svg > tim.svg   # a shiny card as SVG
node daemons/tools/card.mjs --shelf 'tim*x2,yak,beastie' --svg > zoo.svg   # a shelf: shiny tim, two of it
node --test daemons/tools/card.test.mjs
```

## Build

1. **Ready fixes** from the companion branch as their own PR (a tab closes with its last pane; the
   New Harness launch spinner).
2. **One daemon everywhere**: this folder; the zoo on the server; the desktop replaces its local
   companion with the zoo (status line, nest, hatch, panel); `hn` replaces `~/.harness/tui/tim.json`.
3. **The pair brain** ([BRAIN.md](BRAIN.md)): always sensing on every machine, thinking on the one
   you are at, plus a persistent pair harness that pauses when idle, over a Harness control interface
   (list, read, answer, send, start, pause). First jobs: triage what waits on you, and brief you when
   you come back.
4. **Learning** ([LEARNING.md](LEARNING.md)): notice real signals, propose in one line, teach every
   agent with SKILL.md, only with your yes. L1 (notice, propose, teach, revert) and L2 (borrow from Hermes,
   Claude Code and Codex, opt-in; usage and a curator that marks stale at 30 days and archives at 90;
   export to `~/.agents/skills` and `~/.claude/skills`, opt-in) are built, with person-only approval and
   bond for each lesson (`zoo.lesson`). Across machines and "about your agents" are designed. See also the
   lookbook's LEARNING section.
5. **The rest of the zoo**: turn/week/marathon/night/history eggs, bond and versions, serials,
   duplicates and drop dates (the server and harnessd: see "Earning eggs and growing" and "Serials and
   duplicates"; the clients follow), logbooks, more drops.
6. **Eggs that crack and individuals with traits**: the contract is here ("Eggs", "Individuals", the
   references in `render.mjs` and `bake.mjs`, `frames.json`); next, in parallel, the server's zoo of
   individuals, harnessd's individual art, the desktop, the phone and `hn`.
