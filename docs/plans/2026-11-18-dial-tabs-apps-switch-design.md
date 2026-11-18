# Round dial: a TABS | APPS switch on the TABS screen (Diego, 2026-11-18)

Status: approved by the PM (2026-11-18). Branch `feat/dial-tabs-apps-switch`, from `main` e6737565c2.

## Why

With a Harness window in front, a hold on the round dial opens TABS, and the dial has no way to reach another app's
agents until that app is brought to the front on the Mac. Diego picked the "Pill" variant of the mockup
`devices/harness-device/mockup/tabs-apps-options.html` (main checkout, gitignored): the TABS title becomes a two-cell
pill, TABS | APPS, and one tap flips to the other apps.

## What the person sees

- **TABS** (only on the window's tab, as today: a window open and the daemon's view `tabs`, which is Harness in front or
  Harness picked on the dial over another app): the small grey title is replaced by a pill split in two
  cells, `TABS | APPS`; the cell of the list on screen is filled. The carousel, Done and everything under the title are
  unchanged.
- **Tap APPS** (the right cell): the list becomes APPS, on its first page. It is today's APPS carousel (the app's name in
  green Inter 44, under it "N agents" in grey Inter 25 and " · 1 waiting" in the accent), listing the **other** apps with
  agents, never Harness. Browsing changes nothing until a pick, as today.
- **Pick** (✓ or a tap on a page): the dial turns to that app's agents and the app comes to the front on the Mac (#4373's
  path: `open -b <bundle>`; an app with no bundle, and herdr, change the ring only, as on today's APPS). The dial goes
  to its face, on that app's first agent.
- **Tap TABS** (the left cell) on APPS: back to TABS, on the desktop's tab. A tap on the selected cell does nothing. The
  pill shows on "No tabs yet." too, so APPS stays reachable.
- **No other app has agents**: the title is `TABS` alone, as today (an empty list shows nothing). The last other app
  going while the switch's APPS is on screen goes back to TABS (`ui_apps_replace` with 0 rows: TABS from the switch's
  APPS, HOME from the machine view's, as today).
- **The view flips while the switch's APPS is open** (the person brings another app to the front on the Mac): the
  switch's APPS is `s.view == APPS && !s.machine_view`, and `ui_fleet_set_view(true)` closes it to HOME, as today.
- **Another app in front** (the machine view): unchanged. A hold opens today's APPS, title `APPS`, with Harness in the
  list and no switch; picking Harness there brings the window back and a hold opens TABS again.
- Each hold opens TABS on TABS; the switch remembers nothing.

## Drawing (firmware `ui_habitat.c`)

- The pill replaces `focus_header` on TABS and on the switch's APPS: a rounded box (`ht_box`) centred on the glass at the
  title's place, about 168 x 36 px, radius 18, border `#2c2c2c` on black; the selected cell a box inset 3 px, fill
  `#1e1e1e`. Letters on the filled cell take `#1e1e1e` as their `bg` (a text run fills its `bg`), the others black. The words in **Inter 20 letter-spaced 2** (today's title type; the dial has no Inter 17, and a new font is
  flash for one word), selected `#8a8a8a`, the other `#3a3a3a`, each centred in its cell. The mockup's colours; the
  size grows from the mockup's 152 x 34 only as far as Inter 20 needs.
- The flip is instant: no slide between the lists (the mockup's 280 ms slide is left out: a new animation on the scene
  diff for a one-tap move).
- Tap targets: the pill's two halves, generous (each half of the band from about y 30 to y 108, split at x 233), above the
  carousel's own targets (from y 110), as two new actions `A_SWITCH_TABS` / `A_SWITCH_APPS` dispatched by the plain tap.
  A swipe on the title does nothing.
- Two boxes plus eight letter runs in every state (today's title is four runs; `HT_RUNS` is 40, APPS goes from about 25
  to 31), so the scene diff redraws only what changes.

## Protocol and both mixes of old and new

The cable already versions optional controls with the welcome's `features` list (`cable_features.h`: "a new dial can
remain useful with an older daemon").

- **Daemon → dial, new `apps` while on the window's tab.** For a dial that says `appFilter: 'v1'`, while a window is open
  and the view is `tabs`, the daemon also sends `apps`: the apps with agents in the registry **other than Harness**, at most
  16 (`APP_LIMIT`), `shown: 'harness'`. The same frame, fields and bounds as today's; it goes when its key changes, as now.
  The tab's list is built from `rings.counts` / `rings.apps()` over one `registry.entries()`, with Harness removed and
  `shown` the literal `'harness'`; it never calls `filter.shown()` (which can switch the filter and push every dial).
- **Welcome feature `apps.switch`**, advertised only to a dial that says `appFilter: 'v1'` and when the host can pick
  (`this.appFilter && this.host.pickApp`, as the other features follow the host). The firmware shows the pill
  only when the daemon advertised it, so a stale list from an earlier machine view never makes a dead control.
- **A pick on the tab.** `app.pick` of a listed app other than Harness while the view is `tabs` is no longer `ignored`.
  `answerPick` makes the filter show **and hold** that app even when it already shows it (a new `AppFilter.hold(app)`
  that shows it and sets `pickedOnDial`, as a pick does; today's `pick` answers `same` and holds nothing, and the next
  read's D1 rule would show Harness again and `viewOnRing` would bounce the view back to `tabs`). It clears
  `pickedOver`, turns the view to `apps` (cause `pick`) and answers `switched`, so `pickApp` brings the app
  (`appBrought`) and the session pushes `apps` and that app's ring at once (`syncAgents(true)`); that this push comes
  before the view change's own (which then finds nothing new) is accepted: the machine view has no tab to send first. A
  pick of `harness`, or of an app not in the list, on the tab stays `ignored` and is answered with the list again.
- **A ✓ on the machine view's APPS just as the view flips to the tab** (the tab's `apps` can reach the dial before the
  ring's `agents.end`): its `app.pick` reaches the daemon on the tab and is taken as a tab pick. Accepted: the person
  picked that app.
- **Old firmware, new daemon**: old firmware never sends `app.pick` from TABS. It stores the new `apps` and shows nothing
  new: TABS opens on a hold in the window view (`hold_picks_app` needs the machine view). On the tab the face shows no
  app (`.chat` is read only in the machine view, ui_habitat.c:1172); the frame only updates `apps`, `app_shown` and
  `apps_known` (`ui_apps_replace`).
- **New firmware, old daemon**: no `apps.switch` in the welcome, so the title is `TABS` as today.
- No hello field, no proto bump. Harness Pro does not say `appFilter` and is untouched (`devices/harness-pro` is not
  changed).

## Components

- `cli/src/cable/cableHost.ts`: the tab's app list in `listAgentSnapshot` (window path, `opts.apps`); `answerPick` on the
  tab; `pickApp` brings on a tab pick. Nothing in `cli/src/core/`.
- `cli/src/cable/cableSession.ts`: the welcome feature; `app.pick` answers as today by the pick's answer.
- Firmware: `cable_features.h/.c` (`CABLE_FEATURE_APPS_SWITCH`, parsed from `apps.switch`); `ui_habitat.c` (the pill, its
  hits, the switch's APPS: `apps_open` from the pill, back to TABS when the list empties, render).

## Hot path

The daemon's one-second tick, while a window is open and a dial says `appFilter`, now reads the registry for the app list
(today it reads it only when another app is in front). Bounded: one `registry.entries()` per tick and 16 rows at most,
sent only on a change. The PR records the tick's read time before and after on this Mac (with 0 and with about 50
agents across apps).

## Failures and logs

- A tab pick that brings nothing (no bundle, `open` fails) logs as #4373 does; the ring still turns. No retry.
- The view's turn logs as today's (`appView`, cause `pick`). No content or identifiers beyond the app id the log already
  carries.

## Tests (red first)

- CLI specs (`cableHost.spec.ts`, `cableSession.spec.ts`, `hosts/appFilter.spec.ts`): the tab's snapshot carries `apps`
  without Harness and `shown: 'harness'`, and switches no filter; a dial without `appFilter` gets none; a tab pick of
  another app turns the view to `apps`, shows and holds that app and brings it, also when the filter already showed it;
  with Harness settled in front with known agents, one more read keeps the view `apps` (no bounce); a tab pick of
  `harness` or an unlisted app stays ignored; the welcome lists `apps.switch` only for an `appFilter` dial with a host
  that picks. The specs that assert today's opposite change with it: cableHost.spec.ts around lines 1497-1505,
  1801-1806 and 1822-1830 (a tab pick `ignored`, no `apps` on the tab).
- Firmware host tests: `test_cable_features.c` parses `apps.switch`; `test_touch_ui.py` clicks through it as a person
  does: hold on the face in the window view → TABS with the pill (TABS filled); tap APPS → APPS on its first page with
  the pill (APPS filled), no pick sent; swipe, ✓ → one `app.pick` of that page, face; tap TABS → TABS on the desktop's
  tab; no feature or an empty list → the plain `TABS` title and no pill hits; the list emptying on the switch's APPS →
  TABS; the view flipping to the machine view on the switch's APPS → HOME; the machine view's hold → today's APPS with
  its `APPS` title. New functions join the test's extracted-function lists and its `host_features`.

## Verification

- `devices/harness-device/firmware/test/run.sh` and the CLI specs locally; `firmware-checks` and the CLI suites on CI.
- CLI end to end (`dialAppFilter.e2e.ts`, isolated daemon, fake `open`, fake dial): with a window and Harness in front, a
  dial that says `appFilter` is sent `apps` without Harness and the welcome's `apps.switch`; its `app.pick` of another
  app sends the dial that app's ring and, on macOS (the existing `skipIf`), runs one `open -b` of that app. On GitHub: **CLI end to end → Run workflow**
  on the branch (heavy: the PM's go first).
- On the dial: not in this item (no release, no flash; the PM asks Diego after the merge).

Platforms: the daemon on macOS, Linux and Windows (the bring itself is macOS only, as #4373); the round dial's firmware.
