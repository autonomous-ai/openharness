# The dial follows the focus in cmux (PM for Diego, 2026-11-25)

After #4591 (tmux's pane switch through a read-only `list-clients` place in the focus poll, herdr's through its
`pane.focused` event), cmux is the one multiplexer-like app whose focus the dial does not follow: the integration
report has cmux App → dial ⚠️. Switching cmux's workspace, pane or tab to an agent's surface should turn the dial to that
agent, without typing. Nothing in the core (`cli/src/core/`).

## What cmux offers (read 2026-11-25 from `manaflow-ai/cmux` at the tag `v0.65.2.2`, its latest release, and `main`)

cmux is not installed on this Mac; nothing here installs it, runs it or changes its settings. Read from its docs and
source only.

- **The socket** (`cmux events`, `events.stream`, `identify`, `tree`, focused-surface queries) is refused to the Harness
  daemon in cmux's default Socket Control Mode, `cmuxOnly` (2026-11-17 spec, decided 1). Not used.
- **The event log, no socket.** cmux appends every event of its event bus to `~/.cmuxterm/events.jsonl`
  (`docs/events.md`; `Sources/CmuxEventBus.swift` `static let shared = CmuxEventBus(eventLogURL: defaultEventLogURL())`:
  always on, no setting). One JSON object a line (`JSONSerialization` with `.sortedKeys`, a newline inside escaped),
  each line at most 16 KiB. Written with `O_APPEND` and flushed as soon as a line is queued, no timer
  (`Sources/CmuxEventLogWriter.swift`). Each file is capped at 16 MiB: past it the file is renamed `events.jsonl.1` and
  a new one starts; on start cmux may rewrite the file whole. It is in the folder the cmux source already watches.
- **The focus events** (`Sources/CmuxLifecycleEventPublishing.swift`), each with `type: "event"`, `boot_id` (changes
  when cmux restarts), `seq`, `name`, `workspace_id`, `surface_id`, `pane_id`, `window_id`, `payload`:
  - `surface.focused`: the focused surface of a workspace changed (`workspace_id`, `surface_id`). Published by
    `publishCmuxFocusedSelection` only when that workspace's focused surface changes, with `pane.focused`
    (`payload.selected_surface_id`) and `surface.selected` beside it. This is "the surface that should receive
    keyboard/input commands". Every tab or pane selection, a tab or split created focused included, goes through
    `Workspace.applyTabSelection` → `applyTabSelectionNow`, which ends with that publish (`Sources/Workspace.swift`
    at the tag); only a remote tmux mirror's mutations skip it (`suppressesFocusActivation`), and their surfaces are no
    local agent's.
  - `workspace.selected`: the selected workspace of a window changed (`workspace_id`). It names no window
    (`window_id` is not set), and a switch fires no `surface.focused`: that workspace's focused surface did not change.
  - `window.keyed`: a cmux window became the key window (AppKit), with `payload.workspace_id`, that window's selected
    workspace. Fires each time cmux comes forward, and when the person moves to another cmux window.
  - `surface.closed`, `workspace.closed`, `window.closed`.
- Other lines are other events: agent hooks, notifications, Feed, `workspace.prompt.submitted` (with a redacted message
  and a preview). They are never parsed (below).

So cmux offers a push: a change of `events.jsonl` in the watched folder, and its new lines.

## Goal

With cmux settled in front and a dial attached, on macOS:
- moving the focus to another surface (a pane, a tab) in the workspace shown turns the dial to the agent there;
- switching to another workspace turns the dial to the agent at that workspace's focused surface;
- cmux coming forward turns the dial to the agent at its focused surface, as Orca's settle does;
- the dial never moves to a wrong session: only a surface that exactly one live agent on the dial is at; unknown or
  ambiguous moves nothing; the dial's own tap or rest is not followed back (2 s).

## Decided (from the PM's brief, 2026-11-24/25)

1. **Push, not poll.** The event log's change, told by the cmux source's watch that already holds `~/.cmuxterm`. No
   second watcher, no timer, no cmux process, no socket.
2. **Zero reads when cmux is not in front.** A change of the log is read only while cmux is the settled front app and a
   dial is attached. Coming forward, one read catches up.
3. **Never a wrong session** (the hard rule): below, "Who is followed".
4. **Eval:** no cmux scenario exists. The gate is a pure bug-fix gate: both tiers of the dial eval run, no app drops,
   wrong-session sends stay 0; `baseline.json` is updated in this pull request only if the numbers change. The eval's
   code is not changed.
5. **Platforms:** cmux runs on macOS only. The cmux source runs only on macOS (`devices.ts`), so on Linux and Windows
   nothing of this runs or changes.

6. **Approved by the PM (2026-11-25):** the log's tail through the existing watch, only while cmux is in front; cmux's
   settle follows its focused surface unless the dial moved within 2 s; with two or more cmux windows known, only
   `window.keyed` sets the front workspace. Only the needed fields are read (event name, workspace and surface ids), no
   workspace name or content is kept or logged, at most 1 MiB a read, and the file is never written.

## Design

Everything is in the devices process: one new file, `cli/src/cable/hosts/cmuxFocus.ts`, a callback on the cmux source,
and a section in `cli/src/services/devices.ts` beside herdr's.

### The log's reader (`cmuxFocus.ts`)

`createCmuxFocus(deps)`, with `deps` the file reads (`open`, `fstat`, `read`, `close`, injected for tests), returns
`read(): Promise<CmuxFront>` and `reset()`. `CmuxFront` is `{ workspace?: string; surface?: string }`: cmux's front
workspace and its focused surface, as far as the log says, or none.

What it keeps, in memory only:
- the file's identity (`dev`, `ino`) and the offset read up to, and a partial last line (at most 16 KiB);
- the `boot_id` of the last event read;
- the front workspace;
- each workspace's focused surface (at most 256 workspaces; past it the oldest goes);
- the cmux windows seen (at most 16): `window.created` and `window.keyed` add one, `window.closed` takes it out.

A read:
- fstat's the log. No log: front unknown, nothing kept. Another identity than kept (rotated, rewritten), or a size below
  the offset: a **gap**.
- Reads the new bytes from the offset. More than 1 MiB new, or a gap, or the first read: the state is cleared and only
  the last 1 MiB is read, its first partial line dropped. The log's lines are in order and the last 1 MiB is its end, so
  every workspace's surface learned from it is that workspace's latest; one whose last focus event is older is unknown.
- Splits complete lines. A line is parsed only when it contains `"name":"surface.focused"`, `"pane.focused"`,
  `"workspace.selected"`, `"window.keyed"`, `"window.created"`, `"window.closed"`, `"surface.closed"` or
  `"workspace.closed"` (a substring test before `JSON.parse`), and is at most 16 KiB; any other line is never parsed.
  Every id it takes must be a UUID (`CMUX_ID`).
- A new `boot_id` clears the state: cmux restarted, and publishes each workspace's focus again.
- Applies, in order:
  - `surface.focused`: that workspace's surface. `pane.focused` with a `selected_surface_id`: the same.
  - `workspace.selected`: the front workspace, **while at most one window is known**. With two or more, it names no
    window, so the front becomes unknown until the next `window.keyed` (a selection in a window behind would otherwise
    move the dial: missed, never wrong).
  - `window.keyed`: the front workspace is its `payload.workspace_id`.
  - `surface.closed`: that surface is no workspace's focus. `workspace.closed`: that workspace is forgotten, and the
    front with it.
- Returns the front: the front workspace and its focused surface, either unknown.

One read at a time: a change while one runs gives one more after it. A read never throws; a failed one is a gap.

### When it reads (`cmuxSource.ts`, `devices.ts`)

- The cmux source's watch already tells each change in `~/.cmuxterm` with the file's name. A change of `events.jsonl`,
  or one with no name, is told on a new dep `events()`; it starts no `sessions list` run.
- `devices.ts` reads the log on `events()` only while the dial is attached, the cmux source runs and cmux is the
  settled front app (`cableHost.settledApp() === 'cmux'`). Otherwise it reads nothing, and the change is not kept: the
  read at cmux's next settle catches up.
- At cmux's settle (dial attached): one read, the **settle read**. The dial's detach, or the source's stop, resets the
  reader.

### Who is followed (`devices.ts`)

After each read, as herdr's `herdrFocused` and the pane poll's `paneAnswered`:
- Only when the front surface **changed** since the last read (the settle read: always), so a dial turned by hand is not
  turned back by an unrelated line of the log.
- No dial linked: nothing.
- **Echo:** the dial's own tap or rest on a cmux pane notes its surface (`cmuxFocuses = dialMovesTo()`, through
  `cmuxAppNoted`'s `focus` and `show`, as herdr's `herdrFocuses`); a front surface noted within 2 s is skipped. The
  settle read is also skipped while the dial moved within `ATTACH_ECHO_MS`, as Orca's settle is.
- **The agent:** the live entries of the merged list (`registry.entries()`, not ended) that hold the pane key
  `cmux:<surface>` (a hooked copy's and cmux's row's), or the session of cmux's row at that surface (the open scan's
  copy placed there). Exactly one: followed. None (a shell, a browser surface) or two: nothing.
- **In front:** cmux must still be the settled and the latest front app as the read ends.
- `cable.followLocal(agentId, 'pane')`. cmux's agents are on cmux's own page, so no `followPage`.

Each outcome is one fixed line: `[device] cmux focus · skipped · echo | not in front | unknown agent`, and the read's
`[cmux] events · gap` when the state was cleared mid-run. The first read's time, and any read slower than every one said,
as the cmux source's `[cmux] read`. Never an id, a path or a title.

### Data (feature-design-rules checklist)

- **Read:** cmux's own event log, on this computer, as the person's own user, opened read-only (`O_RDONLY`): Harness
  never writes, truncates, renames or deletes it (PM, 2026-11-25). Only the fields it needs: the event's name, `boot_id`,
  and the workspace, surface and window ids. A workspace's title, folder, a prompt preview or any other payload field
  is never taken into a value, kept or logged (PM, 2026-11-25). Lines of other events are never parsed.
- **Kept:** in memory, in the devices process: an offset, a file identity, a boot id, up to 256 workspace→surface ids,
  up to 16 window ids, a partial line. Dropped at detach.
- **Stored, synced, exposed:** nothing. No new file, frame, request or log content.
- **Bounds:** 1 MiB a read, 16 KiB a line, one read at a time, reads only on cmux's own writes while it is in front.

### Tests

- `cmuxFocus.spec.ts`: lines in cmux v0.65.2.2's form (sorted keys) for each event; a workspace switch to a known
  and an unknown workspace; two windows; a gap by rotation, by a shorter file, by more than 1 MiB; a new boot id; a
  partial line split across two reads; a line over 16 KiB; ids not in form; no log.
- `cmuxSource.spec.ts`: a change of `events.jsonl` (and a nameless one) calls `events()`; it starts no run for a store.
- `devices.spec.ts`, through the devices service with a fake log in a temp home and cmux as the front app: a pane
  switch follows; a workspace switch follows; cmux settling follows its focused agent; a shell or browser surface, two
  agents at one surface, an unknown workspace move nothing; cmux not in front reads nothing (no `open` of the log) and
  moves nothing; the dial's own tap is not followed back; detach resets.
- Each red first, then green.

## Not in this

- The socket, `cmux events`, `cmux identify`; cmux NIGHTLY; Linux and Windows (no cmux there).
- Following cmux's focus while cmux is behind another app.
- Any change to the eval's scenarios or checks.
