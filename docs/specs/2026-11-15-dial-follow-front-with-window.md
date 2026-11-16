# The dial follows the app in front with a Harness window open (Diego, 2026-11-15)

Until now a Harness Desktop window held the round dial on its active tab, whatever app the person was using
(the 2026-09-17 decision, kept by [the app filter](2026-11-14-dial-app-filter.md), § Which app is shown, step 4).
This spec replaces that decision. With a window open, the dial follows the app in front as it does with no window,
and returns to the window's tab when Harness Desktop comes to the front.

## Why

Diego's live test (harness.log, 2026-11-15 16:55-17:03): the Desktop window was open, `app filter: switched · front`
arrived as he changed apps, and the dial stayed on the window's tab. A prompt in Terminal logged
`prompt · skipped · no tile` and a tab selected in Terminal logged `tab · no-tile`, because that agent had no tile on
the Desktop tab. The window being open somewhere behind is not the person working in it.

## Today

- `CableHost.listAgentSnapshot` (`cli/src/cable/cableHost.ts`) sends the machine view (one app's ring, `apps`,
  `view: 'machine'`, `tab: ''`) only when no window is open (`swarms === null`). With a window it sends the active
  tab's agents and the tab's id.
- `AppFilter` (`cli/src/cable/hosts/appFilter.ts`) keeps following the app in front while a window is open. A pick
  is ignored with a window (`pickApp`).
- The firmware reads `tab: ''` as no window and `view: 'machine'` as the machine view, and opens `APPS` on a hold in
  the machine view once it has `apps` (`ui_habitat.c`, `apps_pick`). Otherwise the hold opens TABS.
- `devices.ts` keeps the agents outside a pane from the dial while a window is open (`windowOpen`: `tell`,
  `showWaits`, `remind`).
- A prompt, a tab selected in Terminal, iTerm2 or Ghostty, and the Claude app's session move the dial through
  `CableSession.followLocal`, which moves it only when the agent is on the ring it walks (#4311, #4326, #4331).
- The window's own focus moves the dial through `followApp` (`appFocus`, `windowFocus`).

## Decided (Diego, through the PM, 2026-11-15)

1. **Another app settles in front and has agents:** the dial shows that app, as with no window: its ring, its name
   on the face, a hold opens `APPS`, and prompts, tabs and the Claude app's sessions move it (#4309, #4311, #4326,
   #4331). This is the **app view**.
2. **Harness Desktop settles in front:** the dial goes back to the window's active tab, and lands on the agent the
   window has in focus. This is the **tab view**, today's behaviour with a window.
3. **An app in front with no agents, or `none` (Safari, Finder, no listed app), changes nothing:** the dial keeps the
   view and the app it shows. This is the app filter's existing rule, now applied to the view as well.
4. **A hold** opens `APPS` in the app view and TABS in the tab view. In the app view, picking the Harness page in
   `APPS` goes to the tab view. Picking any other app works as with no window.
5. **A pick on the dial ends when Harness Desktop settles in front**, as it ends when any other app settles there
   (the app filter, step 2). The dial goes to the tab view.
6. **The window changing its tab, or focusing an agent, while another app is in front** does not move the dial off
   that app. When Harness Desktop comes to the front, the dial shows the tab active at that moment and lands on the
   window's agent in focus. This also covers a click in the window: its `appFocus` arrives before the 1 s settle,
   and the dial lands on that agent once the window settles in front.
7. **Approach A:** no firmware change and no protocol change. In the app view the daemon tells the dial exactly what
   it tells it with no window.

## What does not change

- **No Harness Device app** (nothing reports the app in front, Windows today): the window holds the dial on its tab,
  as today.
- **An older round dial and Harness Pro** (no `appFilter` in `hello`): the window holds them on its tab, as today. The
  view below applies only to a dial that says `appFilter`.
- **No window:** everything as in the app filter spec.
- **Voice:** the candidates for a voice turn stay the single ring (`cableSession.ts`), and words spoken on the overview
  still go to the window's palette while a window is open. Unchanged by this work, except dictation (§ Dictation).
- **The core:** nothing. All of it is in the devices process (`cli/AGENTS.md` rule 7).

## Design

### The view (devices process, cable host)

The cable host keeps one more piece of state beside the app filter: **the view**, `tabs` or `apps`. It has meaning
only while a window is open. With no window the dial is in the machine view, as today. One view per cable host,
shared by every `appFilter` dial on it, like the filter.

- **A window opens** (`setSwarms` from null to a value): the view is `tabs`, unless the app settled in front is not
  Harness and has agents. In that case it is `apps`. Normally the window opening brings Harness to the front,
  and the settle that follows confirms `tabs`.
- **An app settles in front** (the filter's settle, `FRONT_SETTLE_MS`):
  - `harness`: the view becomes `tabs`. The filter ends a pick, as it already does for any app settling in front.
  - another app that has agents: the view becomes `apps`, and the filter shows that app (its step 2).
  - an app with no agents, or `none`: no change.
- **The app in front gets agents later** (the filter's D1): while the view is `tabs` and the app settled in front is
  not Harness, that app getting known agents turns the view to `apps`, as D1 turns the shown app with no window.
- **A pick on the dial:** `harness` turns the view to `tabs`. Any other app is `AppFilter.pick`, as with no window.
  `pickApp` stops ignoring picks while a window is open and the view is `apps`. In `tabs` the hold opens TABS, so no
  pick arrives.
- **The shown app runs out of agents in the `apps` view** (the PM, 2026-11-15): the filter falls back to its default.
  When that default is Harness, or there is no app at all, the view becomes `tabs`, with the cause `empty`. A window is
  open, and with a window Harness is its tab. Any other default stays in `apps`.
- **The window closes:** the view no longer matters. The dial is in the machine view, as today.

The view lives in the cable host, not in `AppFilter`. The filter stays "which app", and the view is "the window's tab
or that app". The settle reaches the host through a callback, so the view changes on the same settle as the filter.

### What the dial is sent

- **The `apps` view with a window:** `listAgentSnapshot({ apps: true })` takes the machine path. The shown app's ring,
  `apps`, `view: 'machine'` and `tab: ''`. `listSwarms` and `activeSwarm` answer as with no window for that dial, so
  the firmware draws its no-window machine view and its hold opens `APPS`. An older dial asking without `apps` still
  gets the tab.
- **The `tabs` view:** as today, the active tab's agents and its id.
- **On every view change**, the `appFilter` dials get the new list and swarms at once (`syncAgents`, `syncSwarms`),
  not on the next 1 s tick.
- **Landing in `tabs`:** the dial focuses the window's last `appFocus` agent, through `followApp`, after the tab's
  list is pushed (the list first, then the focus, as `followApp` already orders it). A window focus that arrived while
  the view was `apps` and named an agent off the shown ring did not move the dial, and is applied now.
- **A window focus while the view is `apps`:** it moves the dial only when the agent is on the shown app's ring, as
  `followLocal` does. Otherwise it is kept for the landing above. The window's `appFocus` follow is otherwise unchanged.

### Dictation (the PM, 2026-11-15)

Today `voice.begin` sends plain dictation to the agent the window has in focus whenever the window reports one
(`cableSession.ts`, `host.appFocus()`), whatever agent the dial shows. In the `apps` view the words go to the agent on
the dial's face, as with no window: the host answers no window focus for an `appFilter` dial in the `apps` view. In the
`tabs` view, and for an older dial, nothing changes. Words spoken to an agent reach it whatever the view when they are
delivered: Harness settling in front between the words and their delivery does not refuse them (the PM, 2026-11-15).

### The agents outside a pane (`devices.ts`)

`windowOpen` keeps them from the dial today. It becomes "the dial holds a window's tab": a window is open, and either
the view is `tabs` or no dial that says `appFilter` is connected (the PM, 2026-11-15: an older dial or a Harness Pro
alone on the computer stays as today). So in the `apps` view their turns, waiting lines, questions and reminders reach the dial as with no
window. Switching to `apps` runs `showWaits` and `remind`, as the window closing does today. Switching to `tabs` runs
`showWaits`, which closes their questions, as the window opening does today.

Accepted edge: with an older dial and an `appFilter` dial on one computer, the older dial in the tab view may hear an
outside agent's card while the newer one is in the `apps` view. One dial per computer is the norm. The older dial
shows a card for an agent it does not hold by its own name, as it does today for a Harness agent off its tab.

### Failures and logs

- The view change writes one line, `app filter: view tabs` or `app filter: view apps`, with its cause (`front`,
  `pick`, `window`, `empty`). No app name and no agent id. It is a log line, like `app filter: switched`.
- `prompt · skipped · no tile` and `tab · no-tile` keep their meaning: with this change they appear with a window open
  only in the `tabs` view, or for an agent off the shown ring.

## Data

Nothing new is stored, synced or sent off the computer. The view is one value in the devices process's memory,
derived from what it already holds (the app in front as an app id, whether a window is open). It is lost on a restart
and rebuilt by the next settle. Nothing about which app is in front reaches a log, a measure, the backend or the
phone. The dial over USB gets what it already gets with no window.

## Measures

The devices process's existing counters, with no app name and no agent id: view changes by cause (`front`, `pick`,
`window`, `empty`). Switches of the shown app keep their counters from the app filter.

## Docs

- The app filter spec, § Which app is shown, step 4, and § Decided on the plan's questions, 6: replaced by a pointer
  to this spec. § Done when, On a dial, 7: "Opening the Harness window: the dial goes back to the active tab" becomes
  "Harness Desktop in front: the dial goes back to the active tab". The edit lands after #4331 merges, which also
  edits that file.
- The app filter spec's front table (§ From the watch to the devices process) gains the Linux exe name `harness`
  (`desktop/linux/CMakeLists.txt`, `BINARY_NAME`) → `harness` (the PM, 2026-11-15), so Harness Desktop in front
  returns the dial to the tab on Linux X11 as on macOS. One row in `EXE_APPS` (`cli/src/cable/hosts/frontApp.ts`).
- `cli/AGENTS.md`, the devices row: "which app the dial shows" also covers the view while a window is open. One
  clause, no new process or listener.

## Done when

**Tests (red first)**

- Cable host, fake timers: the view on a window opening, with Harness, another app with agents, an app with no
  agents, and `none` settled in front; `harness` settling ends a pick and turns to `tabs`; another app with agents
  turns to `apps`; an app with no agents and `none` change nothing in either view; D1 in the `tabs` view; picking
  `harness` turns to `tabs`; a pick of another app works with a window in the `apps` view and is ignored in `tabs`; the
  window closing; the view never applies with no window; the shown app emptying to Harness or to no app turns to
  `tabs` with `empty`, to another app stays `apps`.
- Cable session: an `appFilter` dial in the `apps` view with a window gets the machine list, `apps`, `view: 'machine'`,
  `tab: ''` and no tabs. An older dial on the same host gets the tab. A view change pushes at once. Landing in `tabs`
  focuses the window's last focus after the list. A window focus off the shown ring in `apps` does not move the dial.
  Dictation in `apps` goes to the agent on the dial's face; in `tabs` to the window's focused agent.
- `devices.ts`: with a window and the `apps` view, a prompt and a selected tab in the app in front move the dial
  (Diego's two log lines no longer appear). Outside agents' turns, waits and reminders reach the dial in `apps` and
  not in `tabs`, and never with a window open when no `appFilter` dial is connected. The view's log line names no app.
- Front table: the exe name `harness` maps to `harness`.
- End to end (`cli/e2e/`, the fake dial and desk, an isolated daemon): with a window open, the front set to the fake
  terminal app with agents turns the dial to that app's ring; the front set to Harness returns it to the tab and the
  window's focused agent.

**On a dial** (an isolated daemon, never Diego's own; the shared dial needs the PM's go). The window is the rig's own
fake window, and "Harness in front" is the rig's file for it: Harness Desktop is not pointed at the rig's daemon. Before
the check, the shared dial must greet with `appFilter`; if it does not, ask the PM before any flash.

1. Harness window open, Terminal agents running, Terminal brought to the front: in about 1 s the dial shows
   Terminal's ring, and the face says "Terminal".
2. A prompt in Terminal, and a tab selected in Terminal, move the dial to that agent.
3. Hold: `APPS`. Pick Harness: the window's tab. Bring Terminal to the front: Terminal's ring. Bring Harness to the
   front: the tab, on the window's focused agent.
4. Safari in front, and an app with no agents in front, change nothing in either view.
5. Change the window's tab while Terminal is in front: the dial stays on Terminal. Harness to the front: the new tab.
6. An agent in Terminal waits on the person in the `apps` view: its line and question show. In the `tabs` view they
   do not.

Platforms: the daemon on macOS and Linux X11 (where the Harness Device app reports the app in front). Windows has no
source of the app in front yet, so nothing changes there. No firmware change: the round dial on its current release.
