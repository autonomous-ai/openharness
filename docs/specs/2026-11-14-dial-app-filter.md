# The dial's app filter (Diego, 2026-11-14)

With no Harness window, the round dial shows this computer's agents (#4290) as one fixed ring
(`fix/dial-swipe-order`). This spec splits that ring by app. The dial shows the agents of one app at a time
(Harness, Orca, Ghostty, VS Code, …). A hold on the face picks another app, and the dial follows the app the person
brings to the front on the computer.

## Why

Diego runs agents in several apps at once. One ring of everything means swiping past agents of apps he is not
working in. The app he is working in is the one in front, and the computer already knows it.

## Today

- The devices process knows each agent's nearest host: `cli/src/cable/hosts/hostDetect.ts` reads the hook's
  `hostHints` and gives `harness`, `orca`, `iterm`, `ghostty`, `vscode`, `cursor`, `warp`, `zellij`, `kitty`, ….
- Nothing on this computer reports which app is in front. `focus` in `cli/src/services/devices.ts` is the focus
  inside the Harness window only.
- Firmware, `ui_habitat.c`: a hold on the face (`face_hold`) opens TABS, the desk tabs in a carousel
  (`tab_carousel`, `focus_carousel`). With no window there are no desk tabs, so it shows "TABS — No tabs yet.". In
  the machine view each face draws its host under the agent's name (`host_name(a->host)`).
- The dial says what it reads in `hello` (`swarmCard`, `swarmThread`, …). An older daemon ignores a field it does not
  know.

## Decided (Diego through the PM, 2026-11-14)

1. **A hold on the face in the machine view opens the app picker** instead of "TABS — No tabs yet.". With a window,
   the hold still opens TABS. The picker reuses the TABS carousel.
2. **The host sends the apps with their agent counts, and the dial sends back the app picked.** These are two new
   frames. There is no "All".
3. **The ring is per app:** at most 16 agents of the shown app, and each app keeps its own fixed order (the
   `fix/dial-swipe-order` rules, applied per app).
4. **The default is the app with the most agents.** A tie is drawn at random once and held until an app's agent count
   changes.
5. **The dial follows the app in front** once it has stayed in front for 1 s. An app in front with no agents changes
   nothing. A pick on the dial wins until the person brings another app to the front.
6. **The shown app's name is on the face.**
7. **Needs-you in another app:** proposed below (§ Needs-you elsewhere), for the PM to approve.
8. **Whether the pick survives a replug or a daemon restart:** proposed below (§ Memory), for the PM to approve.
- **Which app is in front is private.** It goes only from the Harness Device app to the devices process, never to the
  backend, the phone or a log. The log line is `app filter: switched` and never names the app.
- **The Harness Device app reports the app in front** when the OS says it changed. There is no polling, no osascript
  and no System Events. Without the Harness Device app, the dial does not follow the app in front.
- **An agent's app is its outermost app.** Claude Code in zellij inside Ghostty is in Ghostty.
- **The core gains one small file,** `cli/src/core/dialFront.ts` (a new line in `architecture.coreFiles.txt`), and
  one block in `localWsServer.ts` that hands it the frame. The file checks the frame against the fixed set, bounds it
  and forwards it to the devices process. It keeps no state and logs no app name. `architecture.spec` and 100%
  coverage per file test it.

## Decided on the plan's questions (the PM, 2026-11-14)

1. **The core's check is a file of its own,** `cli/src/core/dialFront.ts`, with its line in
   `architecture.coreFiles.txt` and 100% per file. The port (`core/api.ts`), its event (`core/devicesLink.ts`) and one
   wiring line (`core/main.ts`) carry the frame on.
2. **macOS and Linux X11 now.** The Windows source of the app in front comes with the wave that builds the Harness
   Device app for Windows (Follow-ups).
3. **kitty, WezTerm and Harness Desktop are named** in the tables (§ Each agent's app, § From the watch to the devices
   process). Cursor outside macOS is a follow-up.
4. **The unknown app reads "Other"** in the picker and on the face. Apple's Terminal stays "Terminal". The
   [Naming System](../naming-system.md) defines Terminal ("A shell for entering commands") and neither defines nor
   forbids Other, so two pages no longer share one name. To keep it apart from that app, the front value for "no
   listed app is in front" is `none` (this spec first called it `other`).
5. **The picker's measure counts each `app.pick`** the dial sends. No third frame.
6. **The filter keeps following the app in front while a Harness window is open.** Only the dial does not show it.
7. **The X11 source is tested live in PR CI's `device-app-checks`,** under Xvfb with openbox, xdotool and xterm. The
   pull request records how much longer the job runs.
8. **The on-dial check's agents are the end-to-end suite's fake Claude Code,** against an isolated daemon.

## Design

### Each agent's app (`cli/src/cable/hosts/`)

- `HostAgent` gains `app`, the outermost app. `host` stays the nearest host, for caps and for "See it in …".
- `detectApp(hints)`, next to `detectHost`, reads `__CFBundleIdentifier`, then `TERM_PROGRAM`, and ignores the
  multiplexer variables (`ZELLIJ`, `HERDR_PANE_ID`, `REX_BLOCK`). With no outer value, `app` is `host`. A Harness
  agent's `app` is `harness`.
- The outer values it knows are the ones `detectHost` knows, plus:

  | Value | App | Source |
  |---|---|---|
  | `__CFBundleIdentifier=net.kovidgoyal.kitty` | `kitty` | kitty's `setup.py` (`CFBundleIdentifier=f'net.kovidgoyal.{appname}'`) and `kitty/constants.py` (`appname: str = 'kitty'`): <https://github.com/kovidgoyal/kitty/blob/master/setup.py> |
  | `__CFBundleIdentifier=com.github.wez.wezterm` | `wezterm` | WezTerm's `Info.plist`: <https://github.com/wezterm/wezterm/blob/main/assets/macos/WezTerm.app/Contents/Info.plist> |
  | `TERM_PROGRAM=WezTerm` | `wezterm` | `config/src/config.rs` (`cmd.env("TERM_PROGRAM", "WezTerm")`): <https://github.com/wezterm/wezterm/blob/main/config/src/config.rs> |
  | `__CFBundleIdentifier=ai.autonomous.harness` | `harness` | `/Applications/Harness.app`, read on Diego's Mac, 2026-11-14 |

- **kitty sets no `TERM_PROGRAM`.** Its documented variables are `KITTY_WINDOW_ID`, `KITTY_PID`, `TERM` and the rest of
  <https://sw.kovidgoyal.net/kitty/glossary/#environment-variables>, and its repository has no `TERM_PROGRAM`. So with
  no bundle id and no `TERM_PROGRAM` (Linux), `KITTY_WINDOW_ID` names kitty as the outer app, also inside zellij.
- The apps are the fixed set of host ids hostDetect knows (14 today). An app it does not know is `terminal`, which
  reads "Other" in the picker and on the face. Apple's Terminal (`terminal-app`) reads "Terminal". The set has 16
  members at most, which bounds every per-app structure below.
- Windows and Linux hooks report less, so `app` there is often `terminal`. That still filters, but it is followed to
  the front only for apps that say who they are (VS Code and Cursor through `TERM_PROGRAM=vscode`).

### The rings (`select.ts`, built on `DialRing` from `fix/dial-swipe-order`)

- One `DialRing` per app, in a map keyed by app id and bounded by the fixed set. Each ring follows the swipe-order
  rules over that app's agents only: a fixed order, a new agent at the end, a gap closing up when one ends, 16
  places, the replace-when-full rule, and needs-you never replaced.
- A ring is dropped when its app has no agents left. If that app comes back, it starts a new ring (swipe-order
  rule 7).
- The machine list sent to the dial is the shown app's ring. `total` is the shown app's agent count.
- The Buddy filter and the wait for Swarm cards still run first: an agent they hide counts in no app.

### Which app is shown (devices process, `AppFilter`, one per `CableHost`)

The state is `shown`, `pickedOnDial` (a boolean), `tieBreak` (the app drawn and the counts it was drawn for), and
`settledFront` (the app in front at the last settle). It holds no timers apart from the settle below, and does no I/O.

1. **No `shown` yet, or `shown` has no agents left:** show the app in front if it has agents. Otherwise show the
   app with the most agents. On a tie, keep `tieBreak` while the counts are the ones it was drawn for, else draw again.
   The random function is injected, so tests are deterministic. This clears `pickedOnDial`.
2. **The app in front changes** (`dial_front`): start a 1 s timer, and restart it on every later change. The timer
   runs only after a change. When it fires:
   - if the app is not `settledFront`, it ends `pickedOnDial`, and `settledFront` becomes it;
   - if it has agents and is not `shown`, `shown` becomes it (`none`, no listed app in front, is no app and never
     has agents);
   - otherwise `shown` stays.
3. **A pick on the dial** (`app.pick`): `shown` becomes the picked app and `pickedOnDial` is set. While it is set,
   step 2 changes only `settledFront`. A pick of an app with no agents (the list moved under the finger) is ignored,
   and the dial gets `apps` again.
4. **With a Harness window,** the dial keeps the active tab, as decided on 2026-09-17: it gets no `apps` and a pick
   is ignored. The filter still follows the app in front (step 2) meanwhile, so when the window closes the dial shows
   the app in front, if it has agents.

Every change of `shown` writes the log line `app filter: switched` and counts once in the measures.

### The wire (cable protocol, optional, both ways)

- `hello` gains `appFilter: "v1"`. Only a dial that sends it gets the frames below and a filtered ring. An older dial
  gets the one ring of all agents, as today. An older daemon sends no `apps`, so the new firmware's hold opens TABS as
  today.
- **Host → dial, `apps`:** `{ shown, apps: [{ id, name, count, waiting }] }`, at most 16 entries. `name` is the
  display name (the daemon's `NAMES`, with "Other" for `terminal`, so the firmware needs no table of its own for it). `count` is the app's
  agents and `waiting` is how many of them need the person. It is sent in the machine view only: on attach, and when
  `shown`, an app, a count or a waiting count changes, coalesced with the machine list's 1 s. The apps keep a fixed
  order: an app keeps its place from the moment it appears, a new one goes at the end, and a gone one closes up. The
  picker therefore never reorders under the finger.
- **Dial → host, `app.pick`:** `{ app }`. The host answers with `apps` (the new `shown`) and the new ring
  (`agents.begin` / `agent` / `agents.end`). A duplicate pick does its work once: picking `shown` changes nothing.

### The app picker (firmware, `ui_habitat.c`)

- `face_hold` in the machine view, with `appFilter` known to the daemon (an `apps` frame received), opens `APPS`
  instead of TABS. The Personal | Team picker on a Swarm recap is unchanged.
- `APPS` reuses `focus_carousel` and `tab_carousel`. The header is `APPS`. Each page is the app's name in the tab
  page's type, with `3 agents` under it, or `3 agents · 1 waiting` with the waiting part in the accent. Done is at
  the bottom, as in TABS. It opens on `shown`.
- Browsing the pages does not switch: only Done, or a tap on a page, sends `app.pick`. This is unlike TABS, which
  switches the desk while browsing (`tabs_sync`), because a pick here rebuilds the ring.
- Picking returns to the face, on the first agent of the new ring.
- With no agents at all, there is no app, so the hold opens nothing (anh Dee: an empty list shows nothing).
- With one app, the picker opens with one page.
- An `apps` push while the picker is open moves the carousel by id, never by index. A page whose app went away closes
  up, and the person stays on the same app if it is still there.

### The app's name on the face

- In the machine view with `apps` known, the grey line under the agent's name (`.chat`) shows the `name` of `shown`
  from `apps`, instead of `host_name(a->host)`. For Claude Code in zellij inside Ghostty it reads "Ghostty", the app
  the person sees in front. For an agent in a terminal the daemon does not know it reads "Other". "See it in …" still
  uses the nearest host.
- Without `apps` (an older daemon), it stays `host_name(a->host)`.

### Needs-you elsewhere (decision 7, proposed)

Options:

- A. The bell and inbox keep counting every agent on this computer, as today. The picker's page shows `· 1 waiting`.
  Opening that agent's notice from the inbox turns the dial to it and its app, which counts as a pick on the dial.
- B. As A, plus the face shows a small dot when another app has an agent waiting.
- C. The dial switches to that app by itself.

**Proposed: A.** The person already hears needs-you through the bell and the notice, which say the app ("Waiting
for you · Orca"). C makes the dial jump under the finger, and the swipe-order fix exists to stop that. B adds UI on a
face that already has the bell for this. A needs one new behavior: a notice opens its agent across apps. If the
inbox cannot open an agent today, the plan adds that one action and nothing else.

### Memory (decision 8, proposed)

Options:

- A. In memory in the devices process only. A replug keeps the pick while the devices process keeps running. A
  daemon restart, or the devices process ending, starts again from rule 1.
- B. On disk in the devices process (one host id).
- C. In the dial's NVS.

**Proposed: A.** Following the app in front finds the right app again within 1 s of the person's next app switch, so
little is lost. B and C store a person's choice that A never stores, and C also needs a firmware setting and a
desktop change. The rings are memory only too, as swipe-order decided.

### Which app is in front (`device-app/`)

| Platform | Source | Permission |
|---|---|---|
| macOS | `NSWorkspace.frontmostApplication` once, then `NSWorkspaceDidActivateApplicationNotification`: the bundle id | none (no Accessibility, no Screen Recording) |
| Windows | not in this wave: the Harness Device app is not built for Windows yet (Follow-ups). Then: `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` → `GetWindowThreadProcessId` → the exe name | none |
| Linux X11 | `PropertyNotify` on the root window's `_NET_ACTIVE_WINDOW` → `_NET_WM_PID` → the exe name | none |
| Linux Wayland | not reported: there is no common protocol | — |

- The app writes `{"front":"<bundle id or exe name>"}` on the stdin of the `harness hardware watch --json` child it
  already runs, only when the value changes, cut to 128 characters. It does not log it. This keeps to
  `device-app/AGENTS.md`: the app stays thin over the CLI.

### From the watch to the devices process

- `runDialWatch` (`cli/src/devices/client.ts`) maps the value to an app id through a table next to `hostDetect.ts`:
  the bundle ids `detectApp` knows (kitty's, WezTerm's and Harness Desktop's among them), plus the exe names: Linux's
  `code`, `cursor`, `wezterm-gui` (WezTerm's `CFBundleExecutable`, the same `Info.plist`), `kitty` and `ghostty`, and
  Windows's `Code.exe`, `Cursor.exe` and `WindowsTerminal.exe`, which nothing sends until the Windows source exists.
  The list is closed: a new row is a new decision.
- An app the table does not know is `none`: no listed app is in front. `none` is not an app id. It is never the
  unknown app `terminal` ("Other"): Safari in front and an agent in an unknown terminal are different things, so on
  macOS and Linux the dial reaches "Other" by a pick or as the default, and never by following (the one row that
  gives `terminal` is `WindowsTerminal.exe`). The raw value never leaves the CLI process.
- The watch sends `dial_front { app }`. With an older daemon (no `dial-front` in `connected.features`), it ignores
  the `front` lines.
- Core (`core/dialFront.ts`, called from one block of `localWsServer.ts`): `dial_front` is accepted only from a tool
  that asked for `watch: ['dial']`, with `app` in the fixed set or `none`, and at most 10 per second per connection.
  The core forwards it through `devicesLink` as it does the window's dial frames, keeps no state, logs no app name,
  and drops the frame when the devices process is not running.

## Data

- **What:** the app in front (as an app id), the app shown, and whether it was picked on the dial.
- **Where:** the app in front exists as a raw name only in the Harness Device app and the `hardware watch` process,
  and as an app id in the devices process's memory. The shown app's name and the counts go to the dial over USB.
- **Kept:** in memory only. Nothing is written to disk, a log, an error, a measure, the backend, the phone or the
  gateway.
- **Bounded:** 16 apps, 16 agents per ring, 10 `dial_front` per second, values cut to 128 characters.

## Measures

The devices process's existing counters, with no app name and no agent id:

- switches by cause: `front`, `pick`, `empty`, `notice`;
- the picker's use: each `app.pick` the dial sends. Done and a tap are the only ways out of the picker, and each
  sends one, also for the app already shown. The dial sends nothing when the picker opens.

## Out of scope (follow-ups)

- Harness Desktop reporting the app in front, for people who run the desktop app without the Harness Device app.
- The Windows source of the app in front, with the wave that builds the Harness Device app for Windows. Until then a
  dial on Windows filters by app and takes a pick, and does not follow the app in front.
- Cursor outside macOS: its agents say `TERM_PROGRAM=vscode` there, so they are in VS Code's ring, and Cursor in front
  is followed nowhere.
- Wayland.
- A setting to turn the filter or the following off.
- Harness Pro.

## Order of work

The code waits for `fix/dial-swipe-order` and #4296 to merge. Before the firmware, a mockup of `APPS` and of the
face's app line goes in the main checkout's `devices/harness-device/mockup/`, for review.

## Done when

**Tests (red first)**

- `detectApp`: zellij, herdr and rex inside Ghostty, iTerm2 and Terminal give the terminal; Cursor before VS Code; a
  Harness agent gives `harness`; kitty's and WezTerm's bundle ids, `TERM_PROGRAM=WezTerm` and zellij inside kitty with
  no bundle id; an unknown app gives `terminal`, which reads "Other" while Apple's Terminal reads "Terminal".
- Rings: one per app, swipe-order rules inside each, a ring dropped when its app empties, the map bounded.
- `AppFilter`: the default by count; the tie drawn once and again only when the counts change; the 1 s settle with
  Alt-Tab-like bursts; an app in front with no agents, and `none`, change nothing; a pick holds through count changes
  and through the same app in front, and ends when another app settles in front; the picked app emptying; a pick of an
  app with no agents is ignored; a duplicate pick does nothing; with a window the dial is sent none of it, and the
  front is still followed. Fake timers, no fixed sleeps.
- Wire: `apps` only to a dial with `appFilter`; an older dial gets today's single ring; the apps' fixed order; the
  1 s coalescing; `app.pick` answered with `apps` and the new ring.
- `runDialWatch`: bundle ids and exe names mapped, unknown → `none`, the raw value never sent (the test reads every
  frame), `front` ignored with an older daemon.
- Core: `dial_front` only from a dial watch, only with a known app or `none` (the old word `other` and the display
  name "Other" are refused), rate-bounded, forwarded, dropped with no devices process, never logged.
  `architecture.spec`; 100% per file (`npm run test:core`).
- Device app (`cargo test --lib`): one line per change, none for a repeat, the 128-character cut, nothing in `log`.
  The macOS and X11 sources each sit behind a trait with a fake. The X11 source also runs live in PR CI's
  `device-app-checks`, under Xvfb.
- Privacy: across a devices-process run with front changes, no log line, measure or outgoing frame other than the
  dial's own holds a front value or a raw app name.
- Firmware host tests (`test_touch_ui.py`): the hold opens `APPS` in the machine view with `apps`, TABS with a window
  or with no `apps`, and nothing with no agents; pages, the waiting line, Done and tap send `app.pick`, browsing sends
  nothing; a push while open keeps the app by id; the face's line shows the shown app's name. Rendered previews for
  review. `make device-test` and every `firmware/test/test_*.py` pass.

**On a dial** (an isolated daemon, never Diego's own; the shared dial needs the PM's go)

1. Agents in Ghostty (3) and VS Code (2): the dial opens on Ghostty. The face says "Ghostty", and a swipe goes
   around Ghostty's 3 only.
2. Hold → `APPS`: Ghostty and VS Code with their counts. Pick VS Code: VS Code's ring, in its own fixed order.
3. With the Harness Device app: bringing Ghostty to the front turns the dial to Ghostty in about 1 s. Cmd-Tab across
   three apps and back moves nothing. Finder in front changes nothing.
4. Pick VS Code on the dial while Ghostty is in front: it holds. Safari, then Ghostty, in front: the dial returns to
   Ghostty.
5. A VS Code agent asks for approval while the dial shows Ghostty: the bell rings, the picker says
   `· 1 waiting`, and opening the notice turns the dial to it.
6. Claude Code in zellij inside Ghostty is in Ghostty's ring.
7. Opening the Harness window: the dial goes back to the active tab, and a hold opens TABS.
8. An older firmware against the new daemon: the single ring, as today.
9. Linux X11: the front line arrives and following works for VS Code. (Windows: Follow-ups.)

Platforms: the daemon on macOS, Linux and Windows; the Harness Device app on macOS and Linux X11; the round dial (OTA
key `harness-device`).
