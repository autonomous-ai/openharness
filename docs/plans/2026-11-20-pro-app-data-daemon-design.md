# The daemon serves the Harness Pro the round dial's app data (item A)

Status: spec approved by the PM, 2026-11-20. Split and shared wire shapes: [2026-11-20-pro-parity-split.md](2026-11-20-pro-parity-split.md)
(sections 1-3, 5, 6). Base: `main` ea1bffc979.

## Goal

The Harness Pro (`devices/harness-pro`, USB cable only) is going to say `appFilter: "v1"`, `questionTier: "v1"` and a
new `appCards: "v1"` in its hello (item B). The devices process already hosts every app the round dial reaches. This
item makes the daemon's answer to that hello right:

1. `appCards: "v1"` adds `working` to each `apps` row.
2. A device that says `swarms: "members-v1"` keeps getting the window's `swarms` while the view is `apps`.
3. Specs pin the rest of what a Pro hello gets, which the daemon already does.
4. `devices/harness-pro/docs/cable.md` documents it.

Nothing changes for the round dial, and nothing goes into `cli/src/core/`.

Decided by the PM (not reopened here): one app filter per host, shared by every dial; `appCards: "v1"` gates
`working`; the round dial's frames and cadence stay as they are.

## 1. `appCards: "v1"` and `working`

**Hello.** `cableSession.ts` reads `appCards` beside `appFilter` (`str('appCards') === 'v1'`), resets it in
`resetCapabilities()` (a new port, a close), and names it `appCards` in the capability log line
(`capabilitiesNamed()`). No welcome feature: the device learns from the field itself, and an older daemon simply
sends no `working`, which the firmware reads as 0.

**Counting, in one place.** `AppRings.update()` (`hosts/select.ts`) already counts each app's `waiting` from the
agents it is given. It counts `working` beside it: agents whose `HostAgent.state` is `'working'` (Harness agents get
it from `processing`, `hosts/harness.ts:48`; the other hosts map their own lifecycle to it). `apps()` returns
`{ id, count, waiting, working }`, so `0 <= working <= count` by construction (both counted over the same list).
`AppEntry` (`hosts/types.ts`, one line, allowed by the PM 2026-11-20) gains `working: number`; `cableHost.ts` `appList()` and `tabApps()` copy it into each
row. The host always counts it: it is one pass over a list it already walks, at most `APP_IDS` apps.

**The wire, decided per session.** `syncAgentsNow()` builds the `apps` frame from the host's list:

- a session that says `appCards`: rows `{id, name, count, waiting, working}`, and the apps key adds `:${working}` per
  row, so a turn starting or ending pushes `apps`;
- any other session: rows `{id, name, count, waiting}` (the host's `working` dropped, keys in today's order) and
  today's key, so its frames are byte-identical and a change of `working` alone pushes nothing.

The machine view's one-second gap (`AGENTS_PUSH_GAP_MS`) already bounds how often `apps` can go; a `working` change
rides it like a `waiting` change does. The tab's `apps` (`tabApps`) carries `working` the same way.

## 2. `swarms` while the view is `apps`

Today `windowOf({apps: true})` is `null` while the host's view is `apps` (`cableHost.ts:634`), so `listSwarms`
returns no tabs, and a Pro that says `appFilter` would see its Tabs cards vanish whenever an app's ring is shown.

Change, in the session only: `syncSwarmsNow()` asks `listSwarms()` as a dial on the window
(`listSwarms(this.swarmMembers ? {} : this.asItself)`) when the device says `swarms: "members-v1"`. The swarms key is
then the window's, so a view flip pushes no `swarms` frame and the Pro keeps the cards it holds; a real tab change
still pushes. Everything else still asks `asItself`: the ring, `agents.end` (`tab` stays `''` on an app's ring, and
`view: "machine"`), focus, the app filter and the round dial's frames (it does not say `swarms`).

## 3. What a Pro hello gets (specs, no new code expected)

A hello with `board: "pro"`, `appFilter`, `questionTier`, `appCards` and `swarms: "members-v1"`:

- welcome `features` include `apps.switch`, `question.tier` and `resync`, 11 entries at most with every optional host
  method present (the firmware reads 0 past 16);
- every `apps` frame carries `seq`, in order with the frames around it;
- `resync` resends `apps` (it forces `syncAgents(true)`);
- `app.pick` of another app turns the ring (`apps.shown`, the ring of that app) and brings the app (`pickApp` →
  the host's open);
- on an app's ring, `agent.open` (a tap) of a Harness agent turns the view back to the window's tab and opens it;
- `scroll` reaches `host.scrolled` with the same phase, travel and velocity as the round dial's, which routes it to the
  focused agent's terminal (herdr, VS Code) as it does for the round dial.

Where a spec already passes on `main`, it is a pinning test with no red commit; the plan says which.

## 4. `devices/harness-pro/docs/cable.md`

- Section 1, hello: `appFilter: "v1"`, `questionTier: "v1"`, `appCards: "v1"`.
- Section 2, capability table: `appFilter` (the `apps` frame, `app.pick`, welcome `apps.switch`, the ring of the shown
  app, `view`/`tab` on `agents.end`), `questionTier` (`tier: "list"` on a question told again, welcome
  `question.tier`), `appCards` (`working` on each `apps` row), and the swarms rule above.
- Section 5: `apps` in the messages the Pro uses, `app.pick` in the ones it sends.

## Data

Stores nothing, syncs nothing new. Exposes one integer per app row (how many agents are mid-turn) to a device on the
user's own cable that asked for it; no names, ids or content. Logs: the capability line gains a fixed word; no new
log line carries content or identifiers.

## Errors and limits

`working` is bounded by `count` and by `APP_LIMIT` rows. A device that sends `appCards` with any other value gets
nothing new. No new timers, retries or lists.

## Platforms

The app list, the counts and the swarms rule are platform-neutral TypeScript, run on macOS, Linux and Windows.
Bringing an app forward on `app.pick` is `open -b` on macOS (`hosts/open.ts`) and the raise on Linux
(`hosts/linuxRaise.ts`); Windows has none yet, which is Ken's dial-windows #4513: the PR names the gap and builds
nothing for it. The Pro's cable on Windows (`harness-serial.exe`, `cable/windowsSerial.ts`) is not yet checked with a
Pro; the PR says so.

## Testing

- Vitest, red then green: `hosts/select.spec.ts` (`working` per app, `0 <= working <= count`),
  `cableHost.spec.ts` (`appList`/`tabApps` carry `working`), `cableSession.spec.ts` (hello parse and reset, the log
  word, the frame with and without `appCards`, byte-identical frames and no push on a `working`-only change for a
  round hello, swarms kept on an app's ring for `members-v1` and still empty for the round dial, the section 3 list).
- `npm run typecheck`.
- End to end, `cli/e2e/dialProApps.e2e.ts`: an isolated daemon, the fake `open`, outside agents in two apps, a fake
  dial with the Pro's hello: welcome features, `apps` with `seq` and `working` (an agent mid-turn counts 1, then 0),
  `app.pick` turning the ring and bringing the app, a window open with the view on an app's ring still sending its
  `swarms`. Runs locally; on GitHub only with the orchestrator's turn for "CLI end to end".
- No hardware: no flashing, no serial port to a board.

## Out of scope

Firmware (items B, C, E), custom pets, a per-dial app filter, Windows bring-forward.
