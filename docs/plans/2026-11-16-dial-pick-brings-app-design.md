# A pick on the dial brings that app to the front (Diego, 2026-11-16)

Status: approved by the PM (2026-11-16). Branch `feat/dial-pick-brings-app`, on `main` after #4340 (ae81a1f077), #4366
(herdr) and #4363 (Orca plugin). Checked against that `main` (Changes since the draft, at the end).

## Why

Diego, third live dial test: "switch app trên device, trên laptop cũng không chuyển focus theo". Picking an app in
`APPS` on the round dial changes the ring only (#4309, `AppFilter.pick`); the app stays behind. Two things break from
that:

- The person turns to an app's agents and the screen still shows another app.
- A swipe on the Claude app's ring then switches nothing: a rest runs the Claude app's continue link only while that
  app is in front (`claudeApp.ts` `canShow`), so after a pick of Claude with Orca in front the dial walks sessions the
  app never shows. That is the "Claude app does not follow" half of the same test report.

## Today

- `app.pick` (`cableSession.ts`) → `host.pickApp(app)` → `AppFilter.pick`: `pickedOnDial = true`, the shown app
  changes, `appSwitched('pick')` logs `app filter: switched · pick` and pushes the new ring. Nothing runs on the Mac.
- A tapped notice (`agent.open`) already brings its agent's app forward through the opener (`open.ts`, `open -b`).
- With a window open (#4340): a pick of `harness` on an app's ring turns the view to `tabs`; on the tab a pick is
  ignored.

## Decided

1. **A pick that switches the ring brings the picked app to the front**: `open -b <bundle>` from `APP_BUNDLES`, the
   same command and bundle table a tap uses, run in the devices process. Only for cause `pick`, only when the pick
   answered `switched` (not `same`, not `ignored`). A tapped notice keeps its own open, unchanged.
2. **An app with no bundle** (tmux, Rex, Zellij, Other) **and herdr** bring nothing forward: the ring changes as today.
   herdr is in `APP_BUNDLES` (`dev.herdr.app`), but the `herdr` ring holds the agents herdr's socket lists, whose
   terminal nobody knows (#4366): the herdr app opens only on a tap of a hooked agent that says it runs there
   (docs/specs/2026-11-16-device-herdr.md), never on a pick. Since `fix/herdr-socket-path`, a herdr ring that holds a
   Herdr agent (one Herdr Core lists, or a hooked agent with a pane of Herdr's) brings Herdr on a pick
   (docs/plans/2026-11-16-herdr-app-design.md, Q-pick).
3. **Not running:** `open -b` starts the app. The dial lists VS Code's agents with VS Code closed (#4336), so a pick of
   VS Code can start it: the PM's decision, no extra rule.
4. **No loop.** The picked app coming to the front is reported as a front of that same app: the filter's settle sees the
   app it already shows, so nothing changes on the dial (the settle clears `pickedOnDial`, which no longer matters once
   that app is in front). A burst of picks: the last one wins (the PM, 2026-11-16). One bring runs at a time, for any
   app; a pick while one runs replaces the one waiting, which runs as soon as the running one ends, so at most one runs
   and one waits. Picks A, B, A with A's `open` still running: B is replaced by A, which runs once A's first run ends,
   and A is in front, matching the ring.
5. **macOS only.** Linux and Windows: no bundle ids, nothing runs, as today.

6. **The Harness page** (the PM, 2026-11-16). With a window open, a pick of `harness` (→ `tabs`) brings Harness Desktop
   forward through the opener's existing `desktop()`. With no window, a pick of `harness` brings nothing forward and
   never starts Harness Desktop (a Harness Device user may not use it).

## Design

- `cableHost.pickApp`: when `filter.pick(app, 'pick')` answers `switched` (with or without a window), it calls a new
  optional wiring `appBrought?(app)`. `pickApp` for `harness` with a window calls it with `harness` after
  `setView('tabs')`. With no window, `harness` never reaches it as a bring of Desktop: it has no bundle, and
  `launchDesktop` stays the tap's alone.
- `services/devices.ts` wires `appBrought` to the opener (`cable/hosts/open.ts`): `APP_BUNDLES[app]` → `open -b`, except
  herdr; `harness` → `desktop()`, which with a window open only brings the running Desktop forward. The last pick
  wins (decision 4); a run that fails logs `[device] app filter: bring · failed` (the cause only, never the app). No new frame,
  no firmware change, no core change.
- No loop with #4340's view: a pick of `harness` keeps `pickedOver`; Desktop settling in front then clears it and asks
  for `tabs`, the view it already has, so nothing is sent. A pick of an app on an app's ring: that app settles, the
  filter already shows it and the view is already `apps`.
- The end-to-end tests must never bring a real app forward on the developer's Mac (cli/AGENTS.md rule 6), and today's
  `dialAppFilter.e2e.ts` picks VS Code and Ghostty. The opener runs `/usr/bin/open` by its absolute path, so a fake on
  PATH does not shadow it: the e2e names its own (below).
- The core is not touched: the devices process owns the opener and the filter.

## Failures and logs

- `open` fails or times out (the opener's existing timeout): one log line, the ring is already switched, nothing retried.
- An app unknown to `APP_BUNDLES`: nothing runs, no line.

## Data

Nothing stored, synced or exposed. The bundle id comes from the daemon's own table, never from the dial's frame (the
frame's `app` is only a key into it, checked as today: at most 16 characters, a listed app).

## Measures

`[device] app filter: bring · ok|failed`, a count only.

## Done when

- Unit (`cableHost.spec.ts`, `services/devices.spec.ts`): a pick that switches calls `appBrought` once with the app; a
  pick that answers `same` or `ignored`, and a notice, do not; picks A, B, A while A's first `open` runs end with two
  `open`s, A then A, and B never runs; `harness` with a window brings Desktop, without a window
  nothing; devices map the app to its bundle and run `open -b` once; an app with no bundle, and herdr, run nothing; `HARNESS_OPEN_BIN` absolute is the path run, relative
  or empty falls back to `/usr/bin/open`.
- End to end (`cli/e2e/dialAppFilter.e2e.ts`, the fake dial and a fake `open`, macOS only since nothing runs elsewhere):
  `app.pick` of a listed app runs one `open -b` with its bundle; the front that follows changes nothing on the dial.
  It reads the fake `open`'s record.
- On a dial (Diego's Mac): Orca in front, pick Claude on the dial → the Claude app comes forward and a swipe on its ring
  switches its session; pick Orca → Orca comes forward.

Platforms: the daemon on macOS. Linux and Windows unchanged.

## The e2e's `open` (the PM, 2026-11-16)

- `HARNESS_OPEN_BIN`, the way `HARNESS_GRID_BIN` names grid's binary: read only by the devices' code
  (`services/devices.ts`, which hands it to `createOpenActions`), the path of the `open` the opener runs. It must be an
  absolute path; unset, empty or relative, the opener runs `/usr/bin/open`, as today.
- Documented where it is read, as `HARNESS_GRID_BIN` is (`lib/gridExec.ts`): a comment in `open.ts` saying it is for the
  end-to-end tests.
- The e2e harness (`e2e/harness/daemon.ts`) sets it for every daemon to a fake that records its arguments and opens
  nothing, so no dial e2e on a Mac brings a real app forward: today's picks of VS Code and Ghostty, and the new check.
  The same path serves the tap's opens and `desktop()`.

## Changes since the draft (checked against `main` at ae81a1f077)

- #4340 merged: `pickApp`'s window branch and `pickedOver` are as the draft assumed; the no-loop path is written out above.
- #4366: herdr is excluded by name (decision 2).
- #4336: VS Code's agents show with VS Code closed, so a pick can start it (decision 3).
- #4363: the Orca plugin reads the `dial` stream only; nothing here changes it.
- The e2e's fake `open` had no seam: `HARNESS_OPEN_BIN` (the PM). The opt-in rig on a real dial
  (`e2e/dialAppFilterOnDial.e2e.ts`, a person at the desk) sets it to `/usr/bin/open` (the PM).
- A burst of picks: the last one wins, replacing "one run at a time per app" (the PM).
