# Settings opened from Swarm: Swarm's look, a shorter list

- Date: 2026-11-03
- Scope: the phone app only (`mobile/`). Desktop and the backend do not change. Settings opened
  from the terminal (Find, a terminal's menu, the screens before a computer is ready) does not
  change either.
- Base: `origin/main` @ `f7fdd4fd5`, branch `feat/mobile-swarm-settings`
- Prototype: [2026-11-03-swarm-settings/prototype.html](2026-11-03-swarm-settings/prototype.html).
  Open it in a browser. It shows the lean list as built next to the first cut, with the six changes
  numbered.
- Status: **implemented**. Tony picked direction A ("cards like You") and asked for Settings to
  change only when opened from Swarm, with every label kept. Dee found the first cut too long, so
  it was shortened to the "A lean" list described here, keeping every setting.

## 1. Goal

Settings opened from Swarm's You should look like the app that opened it, and it should be short
enough to scan. Every setting and every fact must stay reachable.

## 2. What was wrong

Paths are relative to `mobile/lib/`.

1. **It looked like a terminal, not like Swarm.** Every row was in the terminal's face, and it had
   a 34pt title under a back row. Swarm draws a 52pt top bar, sans-serif rows and a mono title only.
2. **The account card held 11 rows** of equal weight, with no glyphs and no grouping. It read like
   a log.
3. **Captions were lower case** ("account", "terminal"). Swarm writes them in sentence case.
4. **Some rows spent lines on little.** Notifications had a two-line description cut off by "…".
   Version and Build took a row each.
5. **It was long:** 24 rows, 10 cards and 6 captions in the first cut of A, about 2.6 screens.
   Help (3 rows) and About (2 rows) are opened once in a while but took about a fifth of the page.

**Biggest issue:** one card of 11 equal rows in the terminal's face. It did not look like the app
that opened it, and nothing told the eye where to look.

## 3. Directions

| | A · Cards like You (**chosen**) | B · Folded like Home | C · Two levels |
|---|---|---|---|
| Idea | One page in Swarm's cards, the account split by job | Flat 44pt rows; each section folds and shows a summary | The first page keeps you and your computers; the rest opens sub-pages |
| Strongest point | Every row stays where it was; looks exactly like You | Shortest; most like Home | Shortest first page; familiar drill-down |
| Cost | Long (fixed by the lean pass, section 5) | Folding is unusual in Settings; full-bleed rows differ from You, where it opens from | Terminal size is one tap deeper; four more pages |

**Why not B.** A Settings page that folds is something people have not seen before, and its flat
rows would not match You, the page Settings is opened from.

**Why not C.** It costs the most and makes the setting people reach for most often, terminal
size, one tap deeper. It is still the next step if the lean list is ever not short enough.

## 4. The page as built

```
‹ Settings                              (SwarmTopBar)

[ Tony at Autonomous ›                  (avatar 40)
  Usage ›
  Notifications            Off ›
  Privacy › ]

[ Computers ›
  Profile        All computers ›        (only with 2+ computers, or one chosen)
  Connectors ›
  Sign in a computer ›
  Set up Intern 3 › ]                   (only while Computers has no list, D9)

[ Your devices ›
  Phone name         iPhone 16 › ]

Terminal
[ ~/web ❯ claude "fix the login"        (live preview)
  Font                 SF Mono ›
  Size                  − 13 +
  Colors              Graphite ›
  Language             English › ]      (D6)

Appearance
[ App colors          Graphite ›
  Text size             − 14 + ]

Experimental
[ Swarm                      (switch) ] (D5)

[ Help ›                                (sheet: How Harness works · Try the sample · Show the tips again)
  About           1.0.12 (80) › ]       (sheet: "Version 1.0.12 (80)" · Privacy Policy)
```

In the sample, a Sample caption heads the first card, which starts with "Leave the sample";
Notifications and Privacy are not there, and Help's sheet offers no sample to try.

## 5. Decisions

### D1. Only when Settings is opened from Swarm

- **Why:** Settings in the terminal is the phone's own look and must stay as it is (Tony,
  2026-11-03). One list in two looks avoids two copies of every row's logic drifting apart.
- **Built:** `SettingsPage(swarm: true)`, pushed by `openPhoneSettings(..., swarm: true)` from
  Swarm's `onSettings` in `phone/phone_shell.dart`. The page wraps its list in `SettingsSwarmLook`
  (`phone/settings_row.dart`), an `InheritedWidget` read without a dependency. Inside it,
  `SettingsCaption`, `SettingsGroup` and `SettingsRow` draw as `SwarmCaption`, `SwarmGroup` and
  `SwarmRow`.

### D2. Swarm's parts, as You uses them

- **What:** `SwarmTopBar` with `SwarmBackButton` and a 17pt mono title; sentence-case captions;
  cards; 56pt rows in the app's face, each led by a 22pt glyph (`SwarmRowGlyph`, shared with You).
- **Why:** You opens Settings, so the two pages should read as one app. You's private glyph became
  the shared `SwarmRowGlyph` so both draw it the same way.
- **Kept on purpose:** the 56pt row height and the glyphs. Shorter rows were considered: they save
  little height, and they cost touch targets under 44pt and rows that no longer match You.

### D3. Every label stays

- **Why:** copy is the same on every screen of a flow (one source of words). This includes "Your
  devices", which here means the devices signed in to the account while You ▸ Your devices means
  computers. The clash is known and left for a naming decision.

### D4. The account in three cards, with no caption

- **What:** you, with Usage, Notifications and Privacy; your computers; this phone.
- **Why:** You splits its rows into uncaptioned cards by job, and a card is what says which rows
  belong together. The first cut had you alone in a fourth card; a card of one row cost a card's
  gap for nothing.
- **Cost:** none found. Each row keeps its place in reading order.

### D5. One-line rows: no description under Notifications or Swarm

- **Why:** On or Off says what Notifications needs to say, and its two-line description was cut
  off anyway. Swarm's own intro page explains Swarm as it is turned on, so the switch row does
  not need to.
- **Cost:** the "When …" sentence and Swarm's description are no longer visible here. Both remain
  in the terminal's Settings.

### D6. Language closes Terminal's card; no Voice caption

- **What:** the mic's language is the last row of the Terminal card, led by the mic glyph.
- **Why:** a caption over a one-row card cost about 50pt for the least content on the page. In Swarm's look every row has a glyph, and the mic glyph says what the row is about
  where the terminal's plain rows needed a caption.
- **Cost:** this reverses an earlier decision for the terminal's Settings (see the comment above
  the Voice caption in `phone/settings_page.dart`): someone scanning for the word "Voice" finds
  none. The terminal's Settings keeps its Voice section.

### D7. Help is one row that opens a sheet

- **What:** Help opens a sheet with its three rows, in the same words: How Harness works and Try
  the sample (doors, with chevrons) and Show the tips again (an action).
- **Why:** all three are opened once in a while; three rows became one.
- **Cost:** one more tap to reach each of them.

### D8. About is one row with the version on it

- **What:** "About 1.0.12 (80)". A tap opens a sheet titled "Version 1.0.12 (80)" with the Privacy
  Policy.
- **Why:** the version and the build, the figures support asks for, are visible without a tap.
  The Privacy Policy is needed by the stores, which ask only that it be reachable from inside the
  app.
- **Cost:** the Privacy Policy is two taps away instead of one.

### D9. Set up Intern 3 is left to Computers, except while there is no computer

- **What:** the row shows only while `visibleMachines(notifier)` is empty.
- **Why:** Computers has the same button under its list (`phone/machines_tab.dart`,
  `machines-set-up-device`), so the row was a duplicate. But with no computer (none yet, still
  loading, or the list could not be fetched) Computers is an empty state whose only button is Add
  computer. Without this condition, someone whose first Harness is an Intern 3 would have had no
  way to set it up from Swarm.
- **Cost:** the row appears and disappears with the computer list. That is the same rule Profile
  already follows.

## 6. Numbers

| | First cut of A | A lean (built) |
|---|---|---|
| Rows (preview included) | 24 | 20 |
| Cards | 10 | 7 |
| Captions | 6 | 3 |
| Screens, prototype at 375pt | ≈2.6 | ≈2.1 |
| Screens, Flutter at 390×844 | — | ≈2.05 (1527pt of content, 745pt visible) |

## 7. Code map

- `phone/settings_page.dart`:
  - the `swarm` flag and Swarm's scaffold;
  - `_swarmAccount` (three cards, D4 and D9);
  - Language in the Terminal card (D6);
  - `_helpRow` and `_showTipsAgain` (D7);
  - `_AboutRow` (D8);
  - no detail on Notifications or Swarm in the look (D5);
  - a glyph on every row.
- `phone/settings_row.dart`: `SettingsSwarmLook`, and the Swarm branch of caption, group and row
  (`glyph` param).
- `phone/phone_shell.dart`: Swarm's `onSettings` opens Settings with `swarm: true`.
- `phone/usage_entry.dart`: Usage's glyph.
- `swarm/swarm_style.dart`: `SwarmRowGlyph`, now shared; `swarm/swarm_you_page.dart` uses it.

## 8. Tests

- `test/phone_edge/settings_swarm_look_test.dart` covers:
  - the top bar and the way back;
  - glyphs, and the app's face;
  - three captions, with no Voice, Help or About caption;
  - the three account cards;
  - Set up Intern 3 hidden with a computer and shown with none;
  - Language in the Terminal card;
  - Swarm and Notifications without a line under them;
  - the Help sheet, including inside the sample;
  - the About row and its sheet;
  - the controls that stay;
  - the terminal's look, unchanged.
- `test/phone_edge/settings_layout_test.dart` checks for no overflow at every phone, text scale and
  brightness. It covers Settings opened from Swarm signed in (long, emoji and right-to-left
  names), with no computer, and inside the sample.
- `test/phone/phone_shell_swarm_home_test.dart` checks that Settings opens with `swarm: true` from
  You and with `swarm: false` from the terminal.

## 9. Design (data)

N/A because this changes layout only. Nothing is stored, synced or exposed, and every row reads and
writes through the same stores as before.

## 10. Open

- Sheets (Help, About, account, Font, Colors) still draw in `PhoneSheet`'s look, the terminal's
  face. Swarm has no sheet of its own for settings yet.
- "Your devices" means two different things in Settings and You (D3).
