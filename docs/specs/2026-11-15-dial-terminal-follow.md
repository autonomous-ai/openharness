# The dial and the terminal apps follow each other, tab by tab (Diego, 2026-11-15)

Stacked on [the dial and the apps follow each other, pane by pane](2026-11-14-dial-pane-follow.md) (#4311,
`feat/dial-pane-follow`). That branch made the dial and Orca follow each other. This one does the same for the tabs of
macOS Terminal, iTerm2 and Ghostty.

## Why

Diego tested #4311 on 2026-11-15 with three Claude Code tabs in macOS Terminal:

1. Swiping the dial did not change Terminal's tab.
2. Selecting another Terminal tab did not move the dial. It moved only after a prompt.

Earlier Diego chose to do Terminal, iTerm2 and Ghostty "via Harness Device Automation". This branch builds that.

## What the apps offer (checked 2026-11-15)

- **Terminal 2.15** (macOS 26.6), checked with `osascript` against a scratch window opened and closed for the test.
  `tty of selected tab of front window` reads the selected tab's tty. `set selected tab of w to t` selects a tab, and
  `set index of w to 1` raises a window inside Terminal. Neither brought Terminal forward: the app in front stayed in
  front. One read takes about 10 ms. A closed window can stay in the scripting model as `visible false` with 0 tabs, so
  a script skips invisible windows. AppleScript cannot make a tab: that needs a keystroke, which needs Accessibility.
- **iTerm2**, from its scripting docs and sdef. A session has `tty` and `unique id`. A tab's `select` makes it the
  window's current tab, and a session's `select` makes it the active split in its tab. The docs do not say either brings
  iTerm2 forward. Not installed on this Mac: untested.
- **Ghostty**, AppleScript since 1.3.0 (a preview). The sdef on Ghostty's `main` has, for a `terminal`, `tty` ("TTY
  device path for this terminal"), and for a window and tab `selected tab` and `focused terminal`. It also has
  `select tab` and `focus`. The 1.3.0 docs list only `id`, `name` and `working directory` for a terminal, so an installed
  Ghostty may have no `tty`. Ghostty's PR describes `select tab` as "select and foreground", which may bring Ghostty
  forward. Not installed on this Mac: untested.
- **Push.** None of the three tells another app when its selected tab changes. Only macOS Accessibility does, through
  a window-title notification, and it needs the Accessibility permission.
- **The agent's tty.** An agent outside Harness has a pid (`callerPid`, Claude Code's process, which its hook's parent
  names). `ps -o tty= -p <pid>` prints its terminal, such as `ttys023`, which is the tab's tty. An agent in tmux inside
  Terminal has tmux's pty, not the tab's: it matches no tab.

## Decided (PM for Diego, 2026-11-15)

- **Option A: Harness Device asks for the selected tab every 500 ms.** It asks only while Terminal, iTerm2 or Ghostty
  is in front, a watch is running and the dial is attached, and stops as soon as another app comes to the front. It
  needs only the Automation permission. Not chosen: an Accessibility observer (push, but it asks for control of the
  whole computer), or no tab following at all.
- **Fixed scripts.** Every AppleScript is fixed text in Harness Device's code. A tty reaches a script only as a
  parameter of a handler call, after the tty check (`^/dev/ttys[0-9]{1,4}$`). It is never put into the script's text.
  Which app's script runs comes from Harness Device's own fixed list (Terminal, iTerm2, Ghostty), keyed by an app id.
  No bundle id or name from the daemon is used.
- **Nothing but ttys and selection.** Scripts read a tab's or session's `tty` and which tab is selected. They read
  no title, name, working directory, history or contents.
- **Several windows.** A tab report is the selected tab of the app's front window. A swipe looks for the tty in every
  visible window and selects the tab in the window that holds it.
- **When Terminal comes to the front, the dial goes to the agent of its selected tab**, once the app in front settles
  (1 s, as `feat/dial-app-filter` settles it).
- Poll every 500 ms. A tab report that matches the dial's own select within 2 s is that select's echo. macOS only.
- **Coordination with `dial-claude-app-follow`** (same base, agreed 2026-11-15). That branch also changes the follow
  code in the devices process. Two shared shapes; whichever branch lands first defines them, and the other rebases and
  adds its own branch:
  - `CableSession.followPrompt` becomes `followLocal(agentId, cause)`, with cause `'prompt' | 'tab' | 'attach'`.
    `'attach'` is that branch's. This branch makes the rename, and the pane dispatch below, as one task of two
    commits that touch only these shared shapes. That branch cherry-picks exactly those two commits (PM,
    2026-11-15).
  - The observed source's `hasPane` and `showPane` dispatch on the agent's pane kind (`orca`, `tty`, and that branch's
    `claude`). Each kind has its own action in `ObservedActions`: `orcaSwitch` (as today) and this branch's `tabSelect`.
  - That branch adds `attachHandler` next to `frontHandler` in `devicesListener.ts`, and registers it in `devices.ts`.
    That does not overlap with this branch's stream handler.

## Design

### Messages

All of these go between Harness Device, `harness hardware watch` and the devices process's own listener
(`services/devicesListener.ts`). None goes through the core (cli/AGENTS.md, Protect the core, rule 7).

| From → to | Line | Bounds |
|---|---|---|
| Harness Device → watch stdin | `{"tab":{"app":"terminal-app","tty":"/dev/ttys023"}}` | one line under 140 bytes, one pipe write |
| watch → listener | `POST /` `{"type":"tab","app":"terminal-app","tty":"/dev/ttys023"}` | 96 bytes, 10 a second per connection |
| watch → listener | `POST /` `{"type":"tabs"}`, answered by a stream that stays open | one stream at a time; a newer one ends the older |
| listener stream → watch | `{"app":"terminal-app","tty":"/dev/ttys023"}` NDJSON, one line per select, a tap's with `"raise":true` | at most one line per swipe rest or tap |
| watch → Harness Device stdout | `{"select":{"app":"terminal-app","tty":"/dev/ttys023"}}`, a tap's with `"raise":true` | one line |

`app` is always one of the three tab apps' ids: `terminal-app`, `iterm` and `ghostty` (`APP_IDS`). Every hop checks
`app` against that list and `tty` against the tty check, and drops a line that fails either. The existing `front` line
and message do not change. An older Harness Device skips a `{"select":…}` line, since it reads only lines with a
boolean `attached`, and writes no `tab` line, so nothing breaks either way.

**The stream** is a new kind of listener handler. Its answer is a `200` with an NDJSON body that stays open: the
handler writes lines, and the stream ends when either side closes or the listener closes. The connection drops the
2-second deadline other connections have. It still counts as one of the 16. Its limits (checked by the PM):
- **One watch at a time.** At most one stream is open across every connection. A newer `tabs` request ends the older
  stream, so the last watch Harness Device started owns it.
- **A dead connection is closed.** A stream whose socket closes, errors or stops draining is ended and forgotten at
  once. A write that the socket does not take within 2 s (backpressure) ends it.
- **Bounded per connection.** One stream per connection. A connection that holds a stream sends no other message on
  it.
- **Rate.** Opening one is rate-limited like any type (2 a second per connection), so a loop cannot churn it.
The watch opens it after `connected` and opens it again when it ends: after 1 s, doubling to 30 s, and at once when
the dial attaches. Nothing is queued for a stream that is not open: a select with no stream is not sent.

### 1. A swipe selects the agent's tab

An agent outside Harness **has a tab** when all of these hold:

- the daemon runs on macOS;
- its app is `terminal-app`, `iterm` or `ghostty`;
- its tty is known;
- a tabs stream is open.

Such an agent goes through #4311's swipe path unchanged. `hasPane` is true, the dial rests 400 ms, a later turn
restarts the rest, and a turn away runs nothing. When the rest ends, `showPane` writes the agent's `{app, tty}` to the
stream instead of running `orca terminal switch`. The outcome is `ok` when the line is written, and `failed` with no
stream or no tty. The devices process records the tty and the time, for the echo guard below.

**The tty** of an agent in one of the three apps is read once per pid: `ps -o tty= -p <pid>` through `execFile`, with a
1 s timeout and a 256-byte output bound. It runs in the background when the agent is first known in that app (a hook
event or the open scan), and again when its pid changes. `??` or anything that fails the tty check is no tty. Kept in
memory with the agent and gone with it.

**Harness Device** receives `{"select":{app, tty}}` and checks both. It drops the line if the app is not running: an
Apple Event would launch it. Otherwise it calls that app's fixed `select_tty(tty)` handler:

- **Terminal:** for each visible window, read `tty of tabs`. In the window that holds the tty, `set selected tab`.
  When Terminal is the frontmost app, also `set index of` that window `to 1`. Never `activate`.
- **iTerm2:** in the window, tab and session that hold the tty, `select` the tab, then the session. When iTerm2 is
  frontmost, also raise the window. Never `activate`.
- **Ghostty:** `select tab` on the tab whose terminal holds the tty, and only while Ghostty is frontmost. Its
  `select tab` may bring Ghostty forward, so a swipe never selects a tab of a Ghostty in the back. This holds until
  Diego's check shows `select tab` leaves a Ghostty in the back where it is.

The answer is `ok`, `none` (no tab holds the tty) or an error, counted as below. One select runs at a time. A select
that arrives while one runs replaces any select still waiting.

**A tap** on a notification for such an agent brings the app forward with `open -b`, as #4296 does. It then writes the
select with `"raise":true` (PM, 2026-11-15). Without that, a tap could bring Terminal forward on the wrong tab while
the dial shows the agent. The flag only picks the second fixed handler, `focus_tty(tty)`, instead of `select_tty`.
`focus_tty` selects the tab and raises the window that holds it. For Ghostty it selects the tab, whether or not
Ghostty is already in front, since the tap is bringing the app forward anyway. It never calls `activate`: `open -b`
did that. Only a tap sets the flag; a swipe never does.

### 2. Selecting a tab moves the dial

**Harness Device** polls while all of these hold:

- the app in front is Terminal, iTerm2 or Ghostty (its own fixed bundle ids);
- a watch is running;
- the last dial status said `attached`.

Every 500 ms it calls that app's fixed `selected_tty()` handler:

- **Terminal:** `tty of selected tab of front window`.
- **iTerm2:** `tty of current session of current window`.
- **Ghostty:** `tty of focused terminal of selected tab of front window`.

It writes a `tab` line when the answer changes, and also on the first answer after the app comes to the front. No two
calls overlap: a call still running skips the next tick. Polling stops at once when the app in front changes, the
watch ends or the dial detaches, so with any other app in front nothing runs.

**The watch** maps the line to a `tab` message and tells the listener. As with `front`, one tell runs at a time and
the newest wins.

**The devices process** keeps the latest tab report. It acts on the report when the settled app in front
(`cableHost.settledApp()`) is the report's app: at once if it has settled, or when it settles. A report for an app that
did not settle in front is dropped. Acting on a report:

1. **Echo:** a select the dial itself sent for that tty in the last 2 s. Every select of the last 2 s is kept, at most
   8, not only the last one; otherwise a late report for A, after rests on A then B, would pull the dial back to A. The report is consumed and the dial stays, so a fast
   swipe is not pulled back to a tab it passed.
2. **The agent:** the live agent outside Harness with that app and that tty, the most recently active one if two
   match. None (a plain shell tab, an agent in tmux): the dial stays.
3. **The move:** the same path as a prompt the person submits (`CableSession.followPrompt`, through `followApp`). It
   keeps that path's ring check (no tile, no move), its queue and its echo guard, and an agent the dial already shows
   sends nothing. The shared entry point, and its name, is agreed with `dial-claude-app-follow` (see Decided).

### 3. Permission

Harness Device sends the Apple Events itself, in its own process, so macOS asks "Harness Device wants access to
control Terminal". The daemon never sends one. `Info.plist` gains `NSAppleEventsUsageDescription`: "Your dial follows
your terminal tabs." The scripts run in process through `NSAppleScript`: each app's script is compiled once, on one
thread of their own that never blocks AppKit's main thread. Each call has a 2 s Apple Event timeout. A tty goes in as
an `NSAppleEventDescriptor` handler parameter.

- **First use.** The first poll, when one of the three apps is in front with the dial attached, triggers macOS's
  prompt. That is the first moment the feature is used. While the prompt is open the call waits, and ticks and selects
  for that app are skipped.
- **Denied** (`-1743`, errAEEventNotPermitted). That app's scripting stops until Harness Device starts again. The log
  says so in one line (`tabs: Terminal not allowed`). The dial still follows prompts, as in #4311. To allow it later:
  System Settings › Privacy & Security › Automation › Harness Device. No new UI.
- **No `tty` in the app's dictionary** (an older Ghostty: `-1728` or `-10000` on the property). That app's scripting
  stops the same way, with `tabs: Ghostty has no tty`.
- **The app quits or times out** (`-600`, `-1712`). That call is counted as failed, and the next tick tries again.
- **Debug builds** are signed ad hoc, so each rebuild may make macOS ask again.
- **The entitlement.** A build signed with the hardened runtime sends no Apple Event unless it has
  `com.apple.security.automation.apple-events`; every app would then answer "not allowed", with no prompt. The bundle
  gains an entitlements file that holds only that key (`bundle.macOS.entitlements`). It changes nothing for an ad hoc
  build, and it is in place for when the app is signed for release. The pull request says so (PM, 2026-11-15).

### Measures

No tty, title, agent or session in any line.

- **Devices log:** `[device] tab · moved | no-tile | not-in-front | no-agent | echo`, and the existing
  `[device] swipe · <outcome>` for selects.
- **Harness Device log:** `tabs: <app> select ok | none | failed`, one line each. Poll failures as one count line a
  minute while there are any. `not allowed` and `has no tty` once each.

## Out of scope

The following are not part of this branch:

- Accessibility.
- Linux and Windows. Harness Device reports no tab there, and the daemon gives no agent a tab off macOS.
- Agents in tmux, zellij or herdr inside these apps: their tty is the multiplexer's.
- Warp, WezTerm, kitty and VS Code.
- Opening a new tab, firmware, the core and a release.

## Done when

**Tests** (each red first):

- **Listener:** a stream handler answers `200`, streams lines and ends when the client closes. A second stream ends
  the first. The stream drops the 2 s deadline but counts as a connection. A `tab` message is checked (app list, tty
  check, 96 bytes, rate).
- **Observed source:** an agent in Terminal gets its tty from one `ps` per pid, `??` is none, and a new pid reads
  again. `hasPane` needs macOS, a tab app, a tty and an open stream. `showPane` writes one stream line, and gives
  `failed` with no stream.
- **Devices:** a tab report moves the dial through the prompt path when its app has settled in front, and waits for
  the settle otherwise. It is dropped when another app settles. It does not move the dial for its own echo within 2 s,
  but does after. It does not move with no agent or no tile. A tap runs `open -b`, then writes the select with `"raise":true`; a failed `open -b` writes none.
- **Watch:** a stdin `tab` line becomes a `tab` tell, newest wins, and a bad app or tty is dropped. A stream line
  becomes a stdout `select` line. The stream reopens with the stated backoff, and at once on attach.
- **Harness Device:**
  - The line formats, and the tty and app checks.
  - The poll state machine: it runs only with a tab app in front, a watch and the dial attached; it stops on a front
    change; it never overlaps; it reports on a change and on first front.
  - The select queue keeps only the newest waiting select.
  - Denied or no `tty` turns that app off. A not-running app is never sent an event.
  - The handler-parameter path is proven in process with a script that returns its parameter. The tty never appears
    in the compiled source.
  - No tty in the log.
- **End to end** (`cli/e2e/dialTerminalFollow.e2e.ts`) runs the real daemon, a fake dial and the real
  `harness hardware watch`. A fake Claude Code runs on a pty of its own (`Outside`, `cli/e2e/harness/outsideAgent.ts`)
  with Terminal's bundle id in its hook environment, so `ps` gives it a real tty. It does not run in a tmux pane:
  `TMUX_PANE` would make the hook treat the session as a pane (PM, 2026-11-15). The file runs on a Mac by hand; adding
  it to the nightly macOS job is a separate proposal. With Terminal in front:
  - a `tab` stdin line with that tty moves the dial;
  - a tty of no agent does not;
  - a swipe that rests on the agent prints one `select` line after at least 395 ms, and the report that echoes it
    does not move the dial.

**On this Mac** (a scratch window only, opened and closed by the check): Harness Device's Terminal handlers run in
process against two scratch Terminal windows.

- `select_tty` finds the window holding a scratch tty and selects its tab, and Terminal does not come forward.
- An unknown tty answers `none`.
- `selected_tty` reads the scratch window's tty once that window is raised.

Tab switching inside one window, iTerm2, Ghostty and a real denial are not checked here: AppleScript cannot open a
tab, two apps are not installed, and a denial would mean resetting this Mac's Automation grants.

**On a dial** (Diego, when he returns; asked for from the orchestrator first). Build the CLI from this branch with
`make install-cli` and the debug Harness Device from this branch, then put the release builds back afterwards.

1. First use: with Terminal in front and the dial attached, macOS asks once. Allow.
2. With three Claude Code tabs in one Terminal window and Terminal in front, select each tab: the dial follows within
   about 1.5 s.
3. Swipe: Terminal selects that agent's tab each time the dial rests. With another app in front, Terminal's tab
   changes behind it and Terminal stays behind.
4. Two Terminal windows: a swipe to an agent in the other window raises that window while Terminal is in front.
5. A fast swipe across three agents ends on the last one, and the dial is not pulled back.
6. iTerm2 and Ghostty, if installed: cases 2 and 3. For Ghostty, also check whether `select tab` brings it forward.
7. Denied: in System Settings, turn Harness Device's Terminal off, then restart Harness Device. Prompts still move the
   dial, and tab selection does nothing.

8. A tap on a notification for an agent in the other Terminal window: Terminal comes forward on that agent's tab, in
   its window, and the dial stays on that agent.

## Design notes

- **Data.** Nothing on disk. In memory, the devices process holds each agent's tty, the latest tab report and the selects of
  the last 2 s (at most 8). Harness Device holds the last tty it reported. A tty crosses only the local pipes and the
  devices' private socket.
- **Cost.**
  - With no tab app in front: nothing runs.
  - With one in front: one Apple Event every 500 ms (about 10 ms each in Terminal). The pull request records CPU for
    Harness Device and Terminal over a minute with Terminal in front, before and after.
  - A swipe: one stream line per 400 ms rest.
  - `ps`: once per agent pid.
- **Security.**
  - Fixed scripts, a checked tty passed only as a parameter, and an app chosen from a fixed list.
  - The listener stays this account's private socket: another account cannot connect.
  - A process of this account can already tell the listener the app in front. It can now also report a tab, which
    can move the dial, or take the stream, which stops tab selection until the watch reopens it. Both are within the
    account's own trust, as `front` is.
- **Platforms.** macOS: unit tests, the end-to-end test and the scratch-window check. Linux: the daemon and watch code
  run in CI, and no tab follows. Windows: nothing changes.
