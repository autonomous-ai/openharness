# The dial in Orca: a Harness Device plugin for Orca (Diego, 2026-11-16)

Device integration, wave 1, item 2 (the remaining part): "panel plugin trên catalog Orca"
(`2026-11-13-device-integration-priority.md`, section 3; distribution in section 4). Orca already works with the dial
through the Orca CLI from the devices process ([#4296](2026-11-13-device-claude-orca.md),
[#4311](2026-11-14-dial-pane-follow.md), [#4341](2026-11-15-device-host-adapter.md)). This branch adds the other side:
inside Orca, a person sees the dial's state, and someone without Harness is pointed to it.

## Decided (PM for Diego, 2026-11-16)

- **Read only.** The first version shows the dial's state in an Orca panel and in Orca's status bar, and has a
  **Get Harness** button when Harness is not installed. There is no follow/unfollow action: following is automatic today
  (#4311), and the dial has no switch to turn it off. A switch would be its own item.
- **Installed from this repository.** It installs with `orca plugin install` from its folder in this repository.
  Listing it in Orca's community catalog (the `orca-plugin` topic plus a `vX.Y.Z` tag on
  `autonomous-ai/openharness`, or a mirror repository) or in the official catalog (a pull request to
  `stablyai/orca-plugins`) is Diego's decision, made after this merges. This branch publishes nothing and tags nothing.
- **Plan answers (PM, 2026-11-16):** `link` tries a connect before it says the daemon is up; the folder watch reacts
  only to `devices.sock`; a refused or silent devices' socket is `notRunning`; an e2e case runs the plugin's loop
  against an isolated daemon; the new e2e file stays in the nightly run; the manifest is `0.1.0`, "The dial's state in
  Orca.".
- **Checks.** CI has no Orca CLI, so `orca plugin validate`, `orca plugin check` and `orca plugin test` run as local
  gates and go in the pull request, as `claude plugin test` did for `plugins/harness-device` in #4296.

## What Orca offers a plugin (Orca 1.4.256, host API 1.5, checked 2026-11-16)

From `orca plugin create --template worker-panel`, its generated typings, and Orca's public docs
(`docs/reference/plugin-*.md` in `stablyai/orca`):

- **Panels** in the right sidebar. A `components` panel is TSX that Orca draws with its own controls, with no build
  step. Panels run sandboxed: no network, no Node, and nothing outside the plugin's folder. A panel can call
  `shell.openExternal` after a person presses a control, and Orca asks before opening a web host for the first time.
- **A worker** (`execution: "trusted-worker"`, `main`): a separate Node process on the Orca host, running with the
  user's own access. It answers panels (`orca.panels.handle`, `plugin.request`) and pushes to them
  (`orca.panels.post`, at most 256 KiB per post and 200 per 10 s). The user approves full access when they install it.
- **Status bar items** (`contributes.statusBarItems`, since 1.4.248), changed by the worker with `statusBar.update`.
  When a plugin has both `main` and a status bar item, its worker runs for as long as the plugin is enabled.
- Commands, settings, storage and secrets, keybindings, custom editors. Events: `agent.status.changed` and
  `workspace.*`. Hooks: `terminal.send`, `agent.prompt.before`, `agent.tool.before/after`, `agent.launch.before`,
  `workspace.create.*`, `editor.save.before`. Host methods: `agents.list`, `workspace.*`, `terminal.read/sendText`,
  `agent.launch`, `notifications.show`. This plugin uses none of them. No host method focuses a single Orca terminal;
  the dial's switch stays `orca terminal switch` (#4311).
- **Catalogs.** In the community catalog, a public repository with the `orca-plugin` topic gets its newest `vX.Y.Z` tag
  listed automatically, checked by machine. Plugins in subfolders are supported (`source.path`). The publisher is the
  repository owner: here `autonomous-ai`, so the plugin installs as `autonomous-ai.harness-device` (`local.harness-device`
  from a folder). Ids that start with `orca-` are reserved. A listed plugin must be free, and must have no tracking, no
  obfuscated code, and no executables, archives or symlinks. The official catalog is reviewed by Stably.

## What a person sees

The plugin is called **Harness Device**, the menu-bar app's name (docs/naming-system.md); in its copy the hardware is
the **dial**. One panel, "Harness Device", shows one of these:

| State | Panel | Status bar |
| --- | --- | --- |
| No Harness CLI found | "Harness isn't installed." and a **Get Harness** button, which opens `https://harness.autonomous.ai/desktop` | hidden |
| Windows | "Not on Windows yet." | hidden |
| Harness found, its daemon not running | "Harness isn't running." | hidden |
| Another Orca on this account holds the stream | "Open in another Orca." | hidden |
| Daemon running, no dial attached (or no devices process yet) | "Dial unplugged." | hidden |
| Dial attached, showing no agent | "Dial attached." | `Dial` |
| Dial attached, showing an agent | the agent's name, with the app it runs in on a second, muted line ("Orca", "Harness", "Claude", …) | the agent's name |
| Before the worker's first answer | nothing | hidden |

The status bar item uses the `gauge` icon and the tooltip "Harness Device", and pressing it does nothing (it has no
command). Orca has no host method that opens a panel. A manifest item has no hidden state, so it shows the text `Dial`
from the moment the plugin is enabled until the worker's first `statusBar.update`, a few milliseconds later. The panel and the item change as the dial moves, with no refresh
button. Where nothing is attached, the status bar shows nothing ("an empty list shows nothing").

## How it works

```
dial ──USB── devices process ──"dial" stream (NDJSON, devices.sock)── plugin worker ──posts──▶ panel
                                                                                     └─statusBar.update─▶ status bar
```

### 1. The devices process: a `dial` stream on its own listener

The devices' listener (`cli/src/services/devicesListener.ts`) already serves the `tabs` stream to `harness hardware
watch`. This adds a second stream type, `dial`, in the devices process. The core does not change.

- **Message:** `POST /` with the body `{"type":"dial","standby":true}`, at most 64 bytes, at most 1 per second per
  connection. `standby` follows the listener's existing rule: while another `dial` stream is open, the answer is 409
  and the open one stays. A second Orca on the same account (a dev build next to the app) waits its turn instead of
  taking it away.
- **Lines:** the first line is the state at the moment the stream opens, written as soon as the listener has opened
  it (today `write` returns false inside `open`, so the listener gains a way to write once the stream is writable).
  After that, a line comes on each change, and only when the line differs from the last one written:
  - `{"attached":false}`
  - `{"attached":true,"agent":null}`
  - `{"attached":true,"agent":{"name":"<name>","app":"<app>"}}`

  `name` is the name the dial draws on that agent's tile: the `name` of its entry in the ring the session last sent
  (this covers Harness agents, agents outside Harness, other machines' agents and cloud agents alike). `app` is the
  name the dial's own app page gives that entry's `host` (`appDisplayName` in `cable/hosts/hostDetect.ts`: "Harness",
  "Orca", "Claude", "WezTerm", "Terminal", …; an agent in a terminal the daemon does not know reads "Other", as on the
  dial, never Apple's "Terminal"), so the plugin needs no copy of it (PM, 2026-11-16); an entry with no `host`, or one the table does not
  know, has `app` "Harness". A name over 64 characters is cut to 64 (by code point), so a line stays under 400 bytes
  in any script. No agent id, terminal handle, path, transcript or prompt is in a line.
- **"The agent the dial shows":** a cable session's record of where the dial is (`desiredFocus`,
  `cable/cableSession.ts`, set on every swipe's `focus` from the firmware, by `followApp`, `focusAgent` and
  `agent.open`), but only while that agent is in the ring the session last sent (`lastRing`); otherwise none. The
  record alone is not enough: it outlives an unplug, it can name an agent on another tab with no tile, and nothing
  clears it when the agent leaves. So each session works out its shown agent, as `{ name, app }` or none, whenever
  `desiredFocus` changes, whenever it pushes a ring (which also carries a rename and an agent leaving), and as its
  port closes (none). When the result differs from what it last reported, it tells the host, together with which
  session it is. The host keeps the latest report and the session that made it. A later report from any session
  replaces it. A "none" from a session other than the one that made the latest report is ignored, so unplugging one
  dial of two does not blank the other's agent. When the dial that moved last detaches, the line says `agent: null`
  while other dials are still attached; their next move fills it again.
- **"Attached":** the fleet's existing `watching(on)` wiring (`services/devices.ts`), which is true while any dial is
  attached.
- **Writing:** the stream writes only the latest state. When a write returns false (an earlier line has not drained
  yet), the state is marked unsent, and the listener's stream gains a drain signal on which the writer writes the then
  latest state. There are no timers. A line that does not drain within 2 s ends the stream, under the listener's
  existing rule, and the worker opens it again. A swipe across ten agents therefore sends at most ten lines.
- **Measures (rule 8):** the devices log a line when a `dial` stream opens and when it ends, with the reason (`gone`:
  the client closed it; `stalled`: a line did not drain; `closed`: the listener closed). The listener's `ended` signal
  is aborted with that reason so a stream's handler can read it. Once a minute, if any were written, the devices log
  the number of lines written. Names and apps are never logged. (`replaced` cannot happen for `dial`: every client
  opens it with `standby`.)

### 2. Finding the socket: `harness device orca link`

The worker never builds the socket paths itself; the path logic stays in `devices/listenerPath.ts` and
`localSocketRoute`. The devices process starts only once a dial's port shows up (`core/devicesWake.ts`), so with
Harness running and no dial yet there is no devices' socket, and the worker must tell that apart from Harness not
running. A new verb, `harness device orca link`, prints one JSON object and exits 0:

- `daemon`: true when the daemon's local socket (`localSocketRoute`) exists, is this account's own
  (`socketIsPrivate`), and takes a connect within 1 s (a socket a crashed daemon left behind refuses it);
- `devicesSocket`: the path of the devices' socket (`devicesListenerPath`), whether it exists or not; left out on
  Windows, where there is none;
- `devicesReady`: true when that socket exists and is this account's own.

It lives beside `harness device claude link` in `cli/src/deviceClaude/command.ts`, and, like that one, is left out of
the usage text: it is for the plugin, not for people.

### 3. The plugin: `plugins/harness-device-orca/`

It sits next to the Claude Code plugin (`plugins/harness-device/`). Manifest (`orca-plugin.json`): `id`
`harness-device`, `name` "Harness Device", `version` `0.1.0`, `description` "The dial's state in Orca.", `execution` `trusted-worker`, `engines.orca` `>=1.4.248`, `license` `MIT`,
no `publisher`, no capabilities. It contributes one `components` panel (icon `gauge`) and one status bar item. The
folder holds no binaries and no dependencies: Node's built-in modules only.

- **Worker** (`src/worker.ts`): `activate` starts the loop in `src/dial.ts` without awaiting it. The loop takes its
  platform, home, `PATH`, process runner, socket connector, file watcher and clock as inputs; `src/worker.ts` passes
  Node's real ones (`node:child_process`, `node:http`, `node:fs`, `node:os`, timers), and the tests pass fakes. The
  state starts as `checking`.
  1. On Windows: the state is `windows`, and the loop stops.
  2. It looks for the launcher: `~/.local/bin/harness`, then `harness` on `PATH` (the same order as the Claude Code
     plugin). If neither exists, the state is `noHarness`.
  3. It runs `harness device orca link` (with a 5 s timeout and at most 4 KiB of output). A run that fails or prints
     something else is `notRunning`. `daemon: false` is `notRunning`. `daemon: true` with `devicesReady: false` is
     `unplugged`: the worker then watches the folder of `devicesSocket` and runs `link` again when the socket's own
     entry (`devices.sock`) changes, or any entry where the platform gives no name (at most once a second), and every
     5 min as well, in case the daemon stops, so a plugged-in dial shows within about a second with no polling. Other
     entries of that folder (the daemon's data folder: its registry and logs) are ignored.
  4. With `devicesReady`, it opens the `dial` stream over `devicesSocket` with `node:http` (`socketPath`). A 409 sets
     the state to `elsewhere`. Any other status but 200, a refused connect, or no answer's head within 2 s is
     `notRunning`. Each line it reads (at most 1 KiB, else the
     stream is dropped) becomes the state. `{"replaced":true}` ends the stream like a close. A line it cannot read is
     skipped and counted in the log.
  5. When the stream ends or fails, it waits 1 s, then 2 s, 4 s and so on, up to 30 s, and goes back to step 2. A
     stream that stayed open for over 30 s resets the wait to 1 s. `deactivate` cuts every wait short and closes the
     stream, the watcher and any running `link`.

  Each change of state posts `dial.changed` to open panels and calls `statusBar.update`. A panel's `dial.get` returns
  the current state. The worker's log (`orca plugin logs`) names the state (`noHarness`, `notRunning`, `elsewhere`,
  `unplugged`, `attached`) and never the agent's name.
- **Panel** (`src/panel.tsx`): draws the table above from `dial.get` and `dial.changed`. **Get Harness** calls
  `shell.openExternal`.
- **Protocol** (`src/protocol.ts`): `dial.get` and `dial.changed` carry
  `{ state: 'checking' | 'windows' | 'noHarness' | 'notRunning' | 'elsewhere' | 'unplugged' | 'attached', agent?: { name, app } }`.
- **README** (`plugins/harness-device-orca/README.md`): what it does, what it never does (it types nothing, sends
  nothing off the computer and keeps nothing), how to install it from this repository, and the access Orca asks for.

The plugin's design follows Orca's components: its controls are Orca's own, so
`desktop/design/desktop-design-system.md` does not apply (it covers Harness's own screens).

## Alternatives considered

- **The plugin reads only Orca** (`agents.list`, `agent.status.changed`). Orca does not know where the dial is, so
  this cannot show the dial's state.
- **The worker polls a `harness device status` command.** That polls instead of pushing, and starts a CLI every few
  seconds for as long as Orca runs.
- **The stream also names the Orca terminal**, so the panel could mark the pane. Orca's plugin terminal ids are not
  known to be the `ORCA_TERMINAL_HANDLE` the hooks send (docs/specs/2026-11-14-dial-pane-follow.md). Left out: it
  would be more data for nothing the first version shows.

## Failure

| What fails | Who notices | What the person sees | Recovery |
| --- | --- | --- | --- |
| No Harness CLI | the worker, at step 2 | "Harness isn't installed." and Get Harness | found again on the next pass (30 s at most) |
| Daemon stopped | the stream ends; link says `daemon: false` | "Harness isn't running." | reconnects with backoff (30 s at most) |
| Daemon stopped with no dial attached | no stream; the next link says `daemon: false` | "Dial unplugged." for up to 5 min, then "Harness isn't running." | the folder watch's 5 min look at link |
| No dial yet, so no devices process | link says `devicesReady: false` | "Dial unplugged." | the folder watch runs link again as the socket appears |
| The devices process restarting | the stream ends | "Dial unplugged." for a moment | the folder watch and the backoff |
| A socket not private | link says false for it | as for no socket | none until it is private; the devices log already says so |
| Another Orca holds the stream | 409 | "Open in another Orca." | retried with backoff; it takes the stream once the other closes it |
| A line is not drained in 2 s | the listener ends the stream (logged `stalled`) | the last state, for up to 1 s | reopens; its first line is the current state |
| A malformed line | the worker skips it and logs a count | the last state | the next good line |
| The dial unplugged | `watching(false)` | "Dial unplugged."; status bar hidden | a line when it attaches again |
| Orca older than 1.4.248 | Orca, at install | Orca's own "requires Orca >=1.4.248" | update Orca |

## Design (docs/feature-design-rules.md)

1. **Growth:** nothing is stored. Each cable session holds its last reported shown agent, gone with the session. The
   host holds one latest report (one agent, one session), replaced on each report and cleared when that session
   reports none. The worker holds one state. N/A for records.
2. **Concurrency:** one `dial` stream is open at a time (the listener's existing per-type rule). Its writer reads the
   latest state when it writes, so an older state never overwrites a newer one. The setter in a cable session is
   synchronous and runs in the devices' single event loop.
3. **Read cost:** the first line on open, then one line per change, each under 400 bytes. A test checks that an
   unchanged state writes nothing, and that a removal (the agent leaves, the dial detaches) reaches the reader.
4. **Scale:** at 10 dials and constant swiping, still one line per change, each under 400 bytes; a ring push
   compares one shown agent per session, not the ring. The first warning sign
   is the per-minute count of lines written in the devices log.
5. **Compatibility:** an older daemon answers `type: "dial"` as unknown (the listener drops unknown types with a
   status); the worker treats it as `notRunning` and retries with backoff. An older `harness` CLI has no `device orca
   link` and exits non-zero; the worker treats that as `notRunning`. The listener's new drain signal, first-line write
   and `ended` reason are additive: the `tabs` stream does not use them and keeps working unchanged. The existing readers of the listener are the
   `tabs` stream (`devices/client.ts`) and the Claude mod's `attach` (`plugins/harness-device/hooks/device.js`). Neither
   sends `dial`, and the per-type rate limits keep them apart.
6. **Migration and rollback:** none. A rollback of the daemon leaves the plugin showing "Harness isn't running." No
   production data is involved.
7. **Audience:** the socket is 0600, in a folder that is this account's own (the kernel refuses other accounts). An
   agent's name and app go only to a process of the same account. Neither is logged by the devices or by the worker.
   The panel shows the name only on this computer.
8. **Identity:** everything runs as the person running Orca, on their own computer. The worker types nothing and starts
   no agent.
9. **Failure:** see Failure above.
10. **Platforms:** macOS and Linux. On Windows, the plugin shows "Not on Windows yet." (the devices' listener has no
    Windows path yet). The devices part runs where the devices process runs.

## Verification

- **Unit (CI, vitest in `cli/`):** the listener's first-line write, drain signal and `ended` reason; the `dial` stream
  (first line, changes only, standby 409, removal, a refused write written on drain, the 64-character cut); the cable
  session's shown agent (each of the four moves, a move to an agent not in the ring, a ring push that renames or drops
  it, the port closing, no report when nothing changed); the host keeping the latest report across a second dial's
  detach; `harness device orca link` (daemon up or not, devices' socket ready, absent or not private, Windows).
- **Plugin (local gate, `orca plugin test` in the plugin folder, with Orca's `orca/testing` kit):** the loop in
  `src/dial.ts` with fake runner, watcher and clock and a real Unix-socket server in the test serving NDJSON (each
  state, a 409, another status, a malformed line, `{"replaced":true}`, the folder watch, the backoff and its reset,
  `deactivate` closing everything); the worker's wiring with `mountWorker` (`dial.get`, `dial.changed` posts,
  `statusBar.update` calls); and the panel drawing each state from a mocked `dial.get`, with Get Harness calling
  `shell.openExternal`.
- **`orca plugin validate .`, `orca plugin check .`** and `orca plugin release-entry .` (it prints a release for the
  commit) go in the pull request. `check` mounts the real worker, so it runs with `HOME` set to an empty temporary
  folder and `PATH=/usr/bin:/bin`: the worker finds no launcher and the panel draws `noHarness`, never reaching this
  Mac's own Harness. There is no `src/panel.check.ts`; the panel tests cover the other states.
- **End to end, this Mac, isolated:** the existing fake-dial e2e harness (`e2e/dialTerminalFollow.e2e.ts` style)
  starts an isolated daemon with a test dial port, opens the `dial` stream on its socket, swipes the fake dial and
  reads the lines. A second case runs the plugin's own loop (`plugins/harness-device-orca/src/dial.ts`, with Node's
  real inputs) against that daemon through a launcher shim in the throwaway home, so the two halves are checked
  together. It never touches Diego's daemon, dial or Orca app. The new e2e file runs on Linux, so the nightly CLI end
  to end job picks it up with no workflow change.
- **Not run in this branch:** loading the plugin into the Orca app Diego uses (`orca plugin dev load`, `orca plugin
  shot`), since these sessions run inside that app. After merge, Diego can install it with `orca plugin install
  <repo folder>` and look.
