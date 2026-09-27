# Daemons in hn

The contract is [daemons/README.md](../../daemons/README.md) (art, moods, motion, voice, the zoo,
habits, hatching, cards) and [daemons/BRAIN.md](../../daemons/BRAIN.md) (the pair brain's frames and
its security). The desktop client is the reference; this page says where hn keeps each part and what
it chose where the contract leaves room. It replaces `tim.rs` and `~/.harness/tui/tim.json`.

## Where things live

| part | file |
|---|---|
| roster and banner (`include_str!` of `daemons/roster.json`, `banner.json`) | `src/daemon/roster.rs` |
| plates (`include_str!` of `daemons/plates.json`, parsed on first use) and their colour (bake.mjs `plateColor`) | `src/daemon/plates.rs` |
| renderer: sprite, portrait, status cell, base width, banner, nest stage (render.mjs) | `src/daemon/render.rs` |
| cards and shelves, text and SVG (card.mjs) | `src/daemon/card.rs` |
| harnessd's Unix socket | `src/daemon/socket.rs` |
| the zoo's shape, `daemon.json` (Quiet, habits seen here, days) | `src/daemon/zoo.rs` |
| moods, blinks, work steps, the status cell, `#{daemon}` | `src/daemon/state.rs` |
| the pair brain's frames: lines, shown and armed, keys, talk, the brief | `src/daemon/brain.rs` |
| the hatch reveal (a pure function of time) | `src/daemon/hatch.rs` |
| popups: the reveal, the zoo, a line's detail, the consent, the brief, the key table | `src/daemon/overlay.rs` |
| where the rest of hn calls in (one line each), the zoo's reads and writes, habits | `src/daemon/hooks.rs` |
| `hn zoo`, `hn card`, `hn hatch`, `hn talk`, `hn lessons`, `hn tim` | `src/daemon/shell.rs` |

`cargo test` checks every sprite, portrait, status cell, card, nest and banner in
`daemons/frames.json` byte for byte, and every cell of `plateColors` in truecolor. Change the roster,
run `node daemons/tools/generate.mjs`, and the test says whether the port still draws what the
reference draws.

## Drops and plates

Drop 1 is `init`: ten daemons drawn filled (`plate: true`), tim the octopus among them. `unix` and
`tty` are on hold (`hold: true`, no dates): hn never shows them — no shelf, no silhouettes, no count,
and a record of one in a zoo is passed over (`dropState` is hidden for a hold before any date).

A filled daemon keeps its one-line sprite in the status line. Everywhere else it is its plate from
`plates.json`: the `portrait` size (28 columns) over the zoo and on the card (idle, frame 0), and the
`reveal` size (56) in the hatch when the whole reveal fits the terminal, else the portrait size. A
plate runs its mood's loop, a frame every `frameMs` (170 ms), while `@daemon-motion` is on and the
terminal is in front; else it shows frame 0.

**Colour** (daemons/README.md, "Plate colour"): row r of R takes mix(top, bottom, r / (R - 1)) of the
daemon's gradient (the gold `shinyGradient` when shiny). In truecolor (`COLORTERM=truecolor|24bit`,
as hn decides for its own chrome) each glyph is `plateColor` on `#0c0c0c`: its ink level mixes from
the background toward the row colour, above 1 on toward white. With 256 colours it is the row's
nearest xterm index, SGR dim below 0.6 and bold above 1; with 16, the nearest base colour the same
way. `NO_COLOR` prints the plain text.

## Keys

`prefix Z` enters the `daemon` key table (tmux's `switch-client -T daemon`). Z is unbound in tmux
3.5a's prefix table (`tests/fixtures/tmux-3.5a-prefix.txt`) and not one of hn's own Harness keys
(`a A B C I K N P R S T g @ |`); it is also free in the common plugins (tmux-yank's y/Y, sessionist's
g C X S @, tpm's I U, urlview's u, fingers' F) and in Oh My Tmux, and `z`, its neighbour, is the zoo.
`prefix n` stays tmux's next-window.

| key | does |
|---|---|
| `y` `n` | the line's yes / no (a one-time yes on an allow-class prompt, a decline; teach / skip a lesson) |
| `g` | go to the harness the line is about (hn's own; nothing is answered) |
| `s` | show the lesson in full |
| `d` | what a key on the line does, in full (the popup) |
| `t` | talk to your daemon (`daemon_talk`) |
| `z` | the zoo |
| `h` | hatch an egg |
| `Escape` | dismiss the line or the brief |

Plain tmux underneath: `bind Z …` of your own wins, `bind -T daemon y …` changes one key, and
`list-keys -T daemon` lists them. The table and `prefix Z` exist only while the daemons are on. While
it is up, the table's keys show over the window as the prefix's which-key does.

## The status line

`#{daemon}` (and `#{tim}`, the old name) is the paired daemon's ten-cell status cell — eight cells and
a gutter each side, the sprite centred on its version's base width — in the status line's own
colours, never the daemon's: bold while something needs you, dim asleep, a `*` in the left gutter
when it is shiny. Before the first hatch it is the waiting egg, else the nest for the habits done.
`#{daemon_tally}` is `+1 egg` while eggs wait; `#{daemon_name}` and `#{daemon_mood}` are there for a
status line of your own. The default `status-right` has `#{daemon_tally}#{daemon}` before the clock.

**Moods**, in the README's order: `boop` (`:daemon boop`), `need` (a question on any harness, or the
brain's needs, asks and confirmations), `nap`, a held reaction (`done` 3 s after a turn you have open
finishes, at most once in 20 s; `back` 1.3 s after 15 minutes away; `fail` 4.2 s on an error), `work`
(any agent working, here or as `daemon_state.working`), `fail` (a harness you have open failed, or
`daemon_state.failing`), `idle`. A machine asleep or out of reach is never a failure.

**Motion.** The 2.0 sprite's work frame steps once per real agent event (`turn_started`,
`tool_start`, `tool_end`, `text_delta`; never a heartbeat), at most twice a second, and nothing
moves between events. **Blinks** answer something: `ack` (a turn finished, a question, a new egg),
`look` (the terminal came to the front — its focus-in event —, the daemon table opened; at most once
in 2.5 s), `slow` (back after a break, a level-up, the reveal closing). `set -g @daemon-motion off`
(Reduce Motion) stops all frames; a terminal not in front draws none either.

**Quiet**: `set -g @daemon-quiet on`, `set -g @tim off` (kept from tim), or `:daemon quiet` (kept in
`daemon.json`). Nothing nobody asked for is said; the face still changes. **Nap**: `:daemon nap`, 15
minutes; a need still wakes it.

## The zoo

`GET /api/zoo` and `POST /api/zoo/ops` through this computer's harnessd, exactly as the desk
(`http_json`), re-read on `zoo_changed` whose revision is news (never on a desk change) and on every
new connection. A new egg arriving sits in the slot for 3 s with an ack blink; a higher bond is a
slow blink. A first read is a baseline.

- **Off** (daemons/README.md, "Off switches"). `GET /api/zoo` answering 404 (the server's switch, or
  harnessd's local kill switch, `DAEMONS_OFF`), `{ enabled: false }`, or a key, talk or confirmation
  answered `DAEMONS_OFF`: hn shows nothing of the daemons. No cell, no `prefix Z`, no key table, no
  habits reported or kept, no `daemon_*` frame sent (and those it hears dropped): hn as before them.
  `hn zoo` and the rest say `the daemons are off here`. Asked again on `zoo_changed`, on a reconnect,
  and every six hours.
- **Signed out** (401): the nest from the habits hn saw here, and `sign in to hatch`. hn draws no
  guest daemons; the habits it kept are reported once there is an account.
- **Not answering** (a 5xx, or no answer): not off. What was shown stays (nothing, before a first
  answer), and it is asked again after five minutes, doubling to six hours, or at a reconnect.

`~/.harness/tui/daemon.json` keeps Quiet, the habits seen here, the days hn ran and how many hatches
it showed. The first time, `tim.json`'s `off` becomes Quiet and `tim.json` goes (its species was
never a daemon).

**Habits** hn sees, each reported once with `zoo.habit`: `turn` (a turn ends in a harness open in a
pane here, not a re-read or a sub-agent's), `split` (two different harnesses in one window), `find`
(something opened from the fzf list), `resume` (a paused harness resumed from here), `days` (hn run on
three different local days).

## The pair brain

Heard only from this computer's harnessd, and sent only over its Unix socket (`socket.rs`; a link
over TCP says so and sends nothing): harnessd refuses `daemon_*` writes over TCP.

- `daemon_state` feeds the face (needs, asks, confirms, working, failing). harnessd pushes it unasked
  when a window attaches and whenever pairing, the paired daemon, the dial or the switch changes.
  `pair: null` (the brain not thinking: nothing paired, no consent, or the daemons off) takes the
  brain's line, what waits and the brief down — their keys would answer `PAIR_OFF` — and, coming
  from a thinking brain, has hn read the zoo again, where an off switch shows.
- Question ids stay still now (a timer or a cursor in the dialog no longer moves them): a `daemon_say`
  with an id already showing replaces that line in place, and a key still needs its current detail
  on screen first.
- `daemon_say` is a line in the message line, as tmux's display-message, keys first
  (`[y/n/g] api@office Bash: npm test`), for its `ttlMs` since it arrived; loud (`need`, `fail`,
  `ask`, a confirmation) in `message-style`, a reply dim in the status style, the pair's words after
  its nick (`<tim> …`), which never carry a key. `need`, `fail` and `auto` wait for a pause (Enter, a
  pane switch, or 8 s without a key; never while a popup, list or prompt is open), at most one every
  two minutes, never about the pane in front, dropped after 20 s; `ask` and `say` show at once. A
  second say with the same id replaces the line in place.
- **Shown, then armed.** hn sends `daemon_shown { id }` once the line and its `detail` have been on
  screen. A line with a detail shows it first: the first key opens the popup (`exactly what a key
  does`, the whole command or diff, the keys named), and `daemon_shown` goes once all of it has been
  drawn. Keys arm 400 ms after; before that they are faint and do nothing. `NOT_SHOWN` or `TOO_SOON`
  acknowledges again.
- `daemon_act { id, choice }` for y, n and s; `daemon_confirm { kind, nonce, accept }` for a line
  with `confirm`; `g` opens the harness here. Errors are worded (`STALE_QUESTION`: the question
  changed — nothing typed). A lesson's `s` shows its text in the popup.
- `daemon_brief` shows over the bottom right on return, keys first, a minute when an item has keys
  (else 10 s); `prefix Z y/n/g` answer its first keyed item.
- `daemon_presence`: `active` and `awayMs` when the terminal loses or regains the front (its focus
  events), `active: false` after five minutes without a key in front and `active: true` with the whole
  absence at the next key, `focusAgentId`/`focusMachineId` whenever the pane in front changes (null
  when none), `doneSeen` after 4 s in front or on opening the zoo or the table, and the account's
  `consent`.
- `daemon_talk` from `prefix Z t` or `hn talk "<words>"`: the result (waking, resuming, reached, or
  why not, with `again in 30s` for a rate limit) and its cost note.

## Hatching

`prefix Z h`, `h` in the zoo, or `hn hatch` from a shell (the running hn does it): a popup over the
whole window. The egg wobbles until harnessd answers `zoo.hatch` (two wobbles at least), then tells
the rarity at the crack — a rare's shell glows cyan, a legendary's pop throws yellow `*'.` sparks, a
secret's stage is pitch black first — pops, and the 0.1 portrait appears as `#` in the faint colour
for 1200 ms, fills with its colour (a plate in its gradient, its idle loop running; line art blinks),
and its name types in as a banner (`banner.json`); then the rarity stamp, `fork() returned 0.`, its
first words and the card, with the server's serial. The reveal is laid out in a fixed place (its
tallest moment, or the card's height; its width), so nothing moves as rows arrive. A duplicate has
no new name: `another tux. +150 xp.` (`yours is shiny now.` when it was), and a level-up morphs the
portrait into the new version in three dithered frames of 160 ms. From the fourth
hatch any key skips to the card; Escape closes. Reduce Motion goes straight to the card.

While nobody has answered the consent, the card's next key shows **what the daemon sees** (the
README's words): `y` sends `zoo.consent { watching: true }`, `n` false, Escape asks later
(`:daemon consent`).

## From a shell

```
hn zoo                     your daemon's portrait, the box back, what you own, eggs, the meters (or the nest)
hn card [daemon] [--version v] [--svg]
                           a card as text (copied with OSC 52 at a terminal) or SVG; a filled
                           daemon's shows its portrait plate at the card's version
hn hatch                   the running hn hatches an egg
hn talk "<words>"          words to your daemon, through the running hn
hn lessons [...]           harness pair lessons — approving one asks you at the terminal
hn tim                     one line about it
```

`:daemon` (alias `:tim`) takes `key y|n|g|s`, `detail`, `dismiss`, `talk <words>`, `zoo`, `hatch`,
`card`, `consent`, `nap`, `quiet [on|off]`, `boop`; with nothing it says how the daemon is.

## Tests

`cargo test` (the frames, the plates and their colours, drops on hold, the reveal at chosen moments
and sizes, the zoo's rows, the key table coming and going) and `tests/e2e.sh` against `tests/mock-daemon.mjs`, which serves harnessd's Unix socket in
`ADAPTER_DATA_DIR`, a zoo (`MOCK_ZOO=egg|tim|nest|signedout|off|disabled`, `MOCK_HATCH`,
`MOCK_SHINY`, and `POST /test/zoo-mode` to flip the switch) and the pair brain's frame rules (shown
before a key, 400 ms, the socket only). The e2e hatches, consents, answers a keys-first line through
the table, replaces a line by its id, takes pushed `daemon_state` (a need, then `pair: null`), switches
the daemons off and on again under a running hn, talks, reads the brief and the zoo, prints a card
(`hn card tim --version 2.0` byte for byte against `daemons/tools/card.mjs`), checks Quiet, and runs
hn against the daemons off and signed out. `E2E_SNAPSHOTS=<dir>` keeps the screens it saw (and the
card).
