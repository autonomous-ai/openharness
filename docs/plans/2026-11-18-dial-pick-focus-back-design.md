# Dial: a stroke on another app's agent never wakes Harness

## Bug

With the Harness desktop app open, picking another app on the dial brings that app forward, then focus jumps back to
Harness (Diego, 2026-11-18, CLI 0.6.68, round dial firmware 0.1.2).

## Cause

The daemon log of the report shows each jump back about one second (`FRONT_SETTLE_MS`) after a scroll stroke from the
dial:

```
21:24:04.258 app filter: switched · pick / view apps · pick
21:24:04.324 app filter: bring · ok
21:24:11.081 cable: scroll ↓          (a touch on the glass: down, up, no travel)
21:24:11.304 cable: scroll ↑ (v=0)
21:24:12.112 app filter: switched · front / view tabs · front
```

1. After the pick the dial shows the picked app's ring.
2. A touch on the dial's glass sends a scroll stroke (`down`, then `up`), even with no travel.
3. `routeScroll` (`cli/src/services/devices.ts`) finds no pane of that app that can scroll the shown agent, so the
   stroke goes to Harness's windows as `dial_scroll`.
4. Desktop asks macOS for its window on a stroke's `down` (`_requestDeviceWindow`, `desktop/lib/state/app_state.dart`):
   Harness comes to the front.
5. Harness settles in front: the filter shows Harness and the view turns back to the tab.

Every other dial message that raises the window already skips another app's agent: `focus` marks it seen, a tap
(`openAgent`) asks its own app. `dial_scroll` is the one that does not. The hold (`AppFilter.hold`), the front watch and
a tap starting Desktop are not involved.

## Rule

A stroke goes to Harness's windows only when **the dial holds the window's tab, or the agent it shows is Harness's**
(not another app's by the test `CableHost.outsideEntry` already makes: an agent of another source, unless its session
now runs in a Harness pane). Harness's windows do not show another app's agent, so a stroke on one there scrolled a
terminal unrelated to it and brought Harness to the front.

- The shown agent is another app's, and a pane of its app takes the stroke (VS Code, Herdr, the Claude Code page keys):
  unchanged.
- The shown agent is another app's, and no pane takes it (no adapter, another app in front, not on screen, the guard
  sends it to the windows, the devices stopping): the stroke goes nowhere. Nothing scrolls, and Harness stays where it
  is.
- No agent shown (`shownAgentId()` is undefined: another app's ring that is empty or scoped, or a pick whose new ring
  has not reached the dial yet): to Harness's windows only while the dial holds the window's tab; otherwise nowhere.
- The shown agent is Harness's (the window's tab, Harness's ring, the machine list with no window): to Harness's
  windows as today.

The route is still chosen at the stroke's `down` and kept to its `up`.

The docs that say a stroke on another app's agent goes to Harness's windows change in the same pull request (PM,
2026-11-18): the rows of `docs/plans/2026-11-17-dial-herdr-scroll-design.md` for a Herdr agent,
`docs/plans/2026-11-17-dial-vscode-extension-design.md` ("Otherwise it goes as today") and the devices row of
`cli/AGENTS.md` ("goes to Harness's windows otherwise").

## Scope

Devices process only (`cli/src/services/devices.ts`, and a public method on `CableHost` for the test it already
makes). Not the core, not Desktop, not the firmware. macOS is where other apps' panes and the front watch run; on Linux and Windows a stroke on an agent of
another source also goes nowhere, by the same rule.

## Measure

None new: `[device] scroll · herdr-app · not on screen` stays as it is, once per stroke.

## Tests

- `cli/src/services/devices.spec.ts`, red first: the dial showing another app's agent with no pane that scrolls
  (another app in front); a stroke (`down`, `up`) sends no `dial_scroll`. The same stroke on a Harness agent still
  sends it. No agent shown off the tab: nothing sent.
- The existing VS Code and Herdr cases that expected the windows for another app's agent now expect nothing sent (the
  `not on screen` line stays).
- End to end: `cli/e2e/dialVscode.e2e.ts` (Ghostty's ring) and `cli/e2e/deviceHerdrApp.e2e.ts` (Herdr off screen,
  Orca's ring) wait for the stroke's end on another signal than a windows `dial_scroll`; `cli/e2e/dialAppFilter*.e2e.ts`
  still pass.
