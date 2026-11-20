# Dial follows the thread opened in the ChatGPT app

Branch: `feat/dial-chatgpt-follow-ax`. Components: `device-app/` (Harness Device, Rust and its window) and `cli/` (the
watch command and the devices process). Platforms: macOS, where the ChatGPT app (bundle `com.openai.codex`) is. Linux
and Windows: nothing a person sees changes.

## Why

#4494 made the dial's ChatGPT page list the app's sidebar Codex threads. When the person opens a thread in the app, the
dial does not move to it: the app writes nothing a file reader can follow on a selection (the #4494 spec, "Out of
scope"). Every other host follows (the Claude app's attach, Terminal/iTerm2/Ghostty's selected tab, Orca's
`watch-focus`). Diego approved reading the ChatGPT window through macOS Accessibility for this (2026-11-20).

## What the person sees

- With the dial plugged in and the ChatGPT app installed, Harness's menu has a check item **Follow ChatGPT**, unchecked
  until Harness may use Accessibility.
- The first time ChatGPT comes to the front while the dial is plugged in and Harness may not use Accessibility yet,
  Harness's window opens once with the **Follow ChatGPT** screen. It never opens at the app's start, and never a second
  time by itself. The menu item opens it again.
- **Allow** asks macOS (its own Accessibility prompt). **Not now** closes the window.
- Once allowed, the item is checked. When ChatGPT is in front and the person opens a Codex thread, the dial moves to
  that thread's row on the ChatGPT page, after the usual settle, as it does for a terminal tab.
- Clicking the checked item opens System Settings' Accessibility list, where the person turns it off. Turned off there,
  the item unchecks and the dial stops following, quietly: today's behaviour.

## Decisions (the PM, 2026-11-20)

- **D1. When to ask.** A menu check item plus the screen opened by itself once (the first time ChatGPT settles in front
  with the dial attached and no Accessibility). Never at start. Only **Allow** calls macOS's prompt.
- **D2. The menu item.** One native check item, `Follow ChatGPT`: checked when Harness may use Accessibility. Unchecked:
  a click opens the screen. Checked: a click opens System Settings' Accessibility pane. A change of the permission is
  heard (revocation included) and the item follows it.
- **D3. Limits accepted.** A thread with no Codex name (the window may show another title) is not followed; a ChatGPT
  chat whose title equals a Codex thread's name may move the dial to that thread. The real app is tried by hand after
  release (Diego, through the PM); the pull request lists that step.

## What the ChatGPT app exposes (read on this Mac, read-only)

Inspected with a read-only probe that printed roles and the lengths of values only (no text), from a process that
already had Accessibility (no grant made, nothing set, no click):

- The app is Electron. Chromium's web accessibility tree is **off** (`AXManualAccessibility` unset): the window has
  11 native elements (window, groups) and no sidebar, row or link. A thread id is not reachable without setting
  `AXManualAccessibility`, a write that makes Chromium build the whole conversation's tree: more than this needs, and a
  cost to the app. Not done.
- The window's `AXTitle` is the open thread's Codex name: it equalled exactly one of the 21 names in Codex's
  `session_index.jsonl`, and no name contained it or was contained in it.

So the signal is **the focused window's title**, matched to a thread id in the devices process, which already reads the
threads and their Codex names (#4494).

## Design

### Harness Device (macOS)

**Who asks.** Harness Device: one signed bundle id, one TCC entry, a clear prompt. Not the daemon (node, unsigned,
changing binary).

**What it reads.** Only the ChatGPT app's focused window's `AXTitle`, only while all hold: ChatGPT
(`com.openai.codex`) is the app in front, a watch runs, the dial is attached (the watch's `attached`), and
`AXIsProcessTrusted()` is true. Nothing else of the app's tree is read; no attribute is set; no action performed.

**How (push, no poll).** An `AXObserver` on ChatGPT's process for `kAXFocusedWindowChangedNotification` and
`kAXTitleChangedNotification`, both registered on the application element (which hears them from every element of the
app); at each, the focused window's title is read again. The pid is that of `NSWorkspace`'s front application, taken
when the rules start observing and only when its bundle id is `com.openai.codex` (a lookup by bundle id can return
several). The observer runs on a thread of its own with its own run loop, with a 1 s messaging timeout on every call,
so a hung ChatGPT never holds the runner. It stops (observer removed, run loop stopped) when ChatGPT leaves the front,
the dial detaches, the watch ends or the permission goes. An observer that cannot be created is logged once a start
(`chatgpt: no observer`) and nothing follows until the next start.

**The line.** `{"thread":"<title>"}` on the watch's stdin (the app is always the ChatGPT app: no `app` key). Each
observer start sends its first read, whatever was sent before (as the tab follow does at each start: going back to
ChatGPT on the same thread must move the dial); after that, a line only for a change. A title over 256 characters (UTF-16 code units) or
with a control character (Unicode Cc) is sent as the empty title (the CLI's limit, so the two never disagree), and so
is one whose line would pass 512 bytes (`PIPE_BUF`: the pipe is non-blocking and only such a line is written whole; the
PM, 2026-11-20); no focused window is
the empty title. The longest line is well under 1024 bytes (the watch's line cap). The title is private like a tty: it
goes on the watch's stdin and nowhere else (no Event, log, state file or window).

**Units.** `follow.rs`: the rules (`ChatgptFollow`: front, watching, attached, trusted → whether to observe; each read →
the line to write; the offer cue), the `ChatgptWindow` and `AxTrust` traits, and `NoFollow` for Linux and Windows,
which PR CI compiles and tests. `follow_macos.rs`: the macOS door (AX observer, trust, prompt, the distributed
notification). A `follow` door in the runner's `Doors`, as `tabs`. Crates: `objc2-application-services` (AXUIElement,
AXObserver, AXIsProcessTrusted[WithOptions]) and `objc2-core-foundation` (CFRunLoop), both of the objc2 family the app
already uses. The revocation notice comes through CoreFoundation's distributed notification center with "deliver
immediately" (`CFNotificationCenter`): AppKit holds distributed notifications back while an app is inactive, and
Harness almost never is active (the PM, 2026-11-20).

**The permission.**
- `AXIsProcessTrusted()` read at start, when ChatGPT comes to the front, and on the distributed notification
  `com.apple.accessibility.api` (which macOS posts when the Accessibility list changes; the change can land just after
  it, so it is read again once 1 s later). A change redraws the menu and is logged `chatgpt: follow on` / `off`.
- **Allow:** always `AXIsProcessTrustedWithOptions` with the prompt option (it also puts Harness back in the list if the
  person removed it). The first time (`askedAx` false) that is all: macOS shows its dialog. Afterwards macOS shows no
  dialog, so Allow also opens the pane with the fixed command
  `/usr/bin/open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`. The checked item's
  click runs the same `open`.
- **Allow and the window.** Allow closes the window at once; a grant heard while the screen shows closes it too (the PM,
  2026-11-20).
- **The offer.** The rules give a valueless cue when ChatGPT *comes* to the front (a change the front source reports
  after its first value, so never for the app in front at start) while a watch runs, the dial is attached, ChatGPT is
  installed and Harness is not trusted. The app then opens the screen unless `askedFollow` is set, and sets it. In
  `due()` the screen ranks after Install and Sign in: it never covers them. The cue says nothing more than that, and is
  never logged; `device-app/AGENTS.md`'s "the app in front is private" rule names it as the one exception.
- **Events.** `Event::Follow { trusted, installed }` on a change (the menu's item), and `Event::FollowOffer` (the cue).
  The title is never in an Event.
- **The check item.** A native check item flips its own check on a click; the click pushes the menu again
  (`Effect::Menu`), as Sound does, so the check always shows the permission.
- **Saved state.** `askedFollow` and `askedAx` (camelCase, as the file's other keys), each `#[serde(default)]`: a file
  without them reads as before, and `askedSignIn` is not reset.
- No entitlement is added: the hardened runtime does not gate Accessibility.

**Installed.** The CLI's rule, the same one: `ChatGPT.app` in `/Applications` or `~/Applications` whose bundle id is
`com.openai.codex`, read when the dial attaches.

**Menu position.** After `Notifications ▸`, with the other settings, before the app-update row.

**Log lines** (`chatgpt:` prefix, fixed words only): `follow on`, `follow off`, `no observer`, `asked`. Never a title,
pid or path.

### The watch (`cli/src/devices/client.ts`)

A new single-key stdin line `{"thread":"<title>"}`: a string of at most 256 characters with no control character;
anything else is dropped, as the other keys. It is told to the devices process as `{type:'thread', title}` with the
same 100 ms gap as `front` and `tab`. An empty title is passed (it clears a waiting report).

### The devices process

- **Listener** (`devicesListener.ts`): a `thread` handler, checked again (same rules), 10 a second like `tab`, a
  message of at most 1024 bytes (`THREAD_MAX_BYTES`); keeps nothing, logs nothing.
- **Report and settle** (`devices.ts`), as `tabReported`/`tabSettled`: a report is stamped `{at: monotonic(), moves:
  dialMoves}`. With the ChatGPT app (`codex`) settled in front it is followed at once; else it waits for `codex` to
  settle, and is dropped (`thread · skipped · not in front`) when another app settles. An empty title drops the waiting
  report and does nothing else.
- **Match** (`codexAppSource.ts`): the source keeps its last read's thread ids in order (all of them, up to 200, not
  only the 16 listed; today only the 16 rows and a joined order string are kept), cleared on stop. `threadNamed(title)`
  runs only when a report is followed: Codex's own name of each of those ids, read through the same index reader as
  `codexThreadName` (one read of `session_index.jsonl` a report, not one per id, and the raw name, not the listed
  row's 64-character cut), trimmed, equal to the trimmed title. Exactly one → its thread id; none → `no match`; two or
  more → `ambiguous`. The folder-name fallback is not matched: the window shows Codex's name. With the source stopped
  (no dial), none.
- **Echo** (as `tab · skipped · echo`): the dial moved since the report came (`report.moves !== dialMoves`) → `echo`.
  And a `codexSwitches = dialMovesTo()` list, noted with the thread id in `codexNoted.show` and `focus` (a rest or a tap
  opens `codex://threads/<id>`, and the app then shows that thread's title): a match that is the dial's own switch of
  the last 2 s is consumed as `echo`, and while that switch is unseen, a match naming another thread is `echo` too (the
  window's old title read late, after the settle). And the settle rule of the Claude app and Orca (`ATTACH_ECHO_MS`): a report
  followed at the settle within 2 s of `dialMovedAt` is `echo` (a tap brings ChatGPT forward, and the observer's first
  read can still be the old thread's title).
- **Move:** `cable.followLocal(observedAgentId('codex', threadId), 'thread')`, a new `FollowCause` with its row in
  `FOLLOWED`: `thread · moved`, or `thread · skipped · no tile` for a thread not on the dial's ring.
- **Log lines** (`[device] thread · …`): `moved`, `skipped · echo`, `skipped · not in front`, `skipped · no match`,
  `skipped · ambiguous`, `skipped · no tile`. Never a title, name or id.

Nothing goes into `cli/src/core/`.

## Data

- **Stored:** Harness Device's saved state gains two booleans, `askedFollow` (the screen opened by itself) and
  `askedAx` (macOS's prompt called). Nothing else is stored; the CLI stores nothing new.
- **Exposed:** the title crosses one pipe (Harness Device → the watch, same user) and one local socket (the watch →
  the devices process's private listener), and is held in memory only for a waiting report. Never logged, never in an
  event, file or the window.
- **Synced:** nothing.

## Copy

- Menu: `Follow ChatGPT` (check item).
- Screen heading: `Follow ChatGPT`. Body: `Your dial moves to the thread you open in ChatGPT. Harness reads only the
  ChatGPT window's title, while ChatGPT is in front.` Buttons: `Not now`, `Allow` (primary).

The window's actions gain one name, `allow` (`later` is Not now); `device-app/AGENTS.md` lists five.

## Testing

- **Rust** (`cargo test --lib`): the follow rules with a fake AX source and a fake permission (lines only for ChatGPT in
  front + watching + attached + trusted; each start's first read sent even when equal to the last; a repeat within a
  start not sent; empty title; the 256-character and control-character cuts; stop on front change, detach,
  revocation); the offer opens once, never for the app in front at start, and after Install and Sign in; Allow
  prompts every time and opens the pane after the first; the menu item's presence, position and check, pushed again on
  a click; an old saved file without the new keys keeps `askedSignIn`; the log never holds the title. The macOS AX door has a test that the real source starts and stops with no ChatGPT running.
- **Window** (`npm test`, typecheck): the screen renders its copy, Return takes Allow, Not now sends `later`; the gallery
  shows it in both themes.
- **CLI unit:** `client.spec.ts` (the `thread` line rules), `devicesListener.spec.ts`, `devices.spec.ts` (settle, the
  echo cases, no match, ambiguous, empty title, not in front, no tile), `codexAppSource.spec.ts` (`threadNamed`).
  `npm run test:core` at 100% (it covers `devices.ts` and `devicesListener.ts`).
- **E2E** (`cli/e2e/dialChatgptFollow.e2e.ts`, macOS): the fixture Codex home and applications folder of
  `deviceCodexAppThreads.e2e.ts`, a fake dial attached with `appFilter`, the real watch; `{"front":"com.openai.codex"}`
  then a `thread` line with a fixture thread's name moves the dial to that row; a duplicated name does not; the log has
  no title.
- **No real-app gate on this Mac.** The pull request lists the by-hand check for Diego after release: allow Harness,
  open two Codex threads in ChatGPT, the dial follows; swipe on the dial, no bounce back.

## Docs changed in the same pull request

`desktop/design/desktop-design-system.md`, Harness Device section, and the gallery: the menu (the item after
Notifications), the third screen (the section says two today, and that sign-in is the one thing it offers), and a new
rule: a permission another app keeps (macOS's Accessibility) is one check item, checked when given, whose click always
asks for more and so has no `…` (its label never changes, as every check item's). `device-app/AGENTS.md`: three screens;
the window title is private as a tty; what Accessibility reads; the offer cue as the one front-derived Event; five
action names; the `open` of the Accessibility pane among the fixed commands. `cli/AGENTS.md`: the devices row, the
ChatGPT thread follow.

## Release order

The pull request says: release the CLI before or with Harness Device. Either order is safe: an older CLI drops the
`thread` line, an older Harness Device sends none.

## Out of scope

- A thread id from the app (needs Chromium's tree on).
- ChatGPT chats; Linux and Windows' ChatGPT app.
- Following a thread whose title is not its Codex name.
