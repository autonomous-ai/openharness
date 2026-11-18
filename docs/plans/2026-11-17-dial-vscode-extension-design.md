# The dial reaches Claude Code and Codex in VS Code's integrated terminal (Diego, 2026-11-17)

Status: spec for PR A of two. Research: `docs/plans/2026-11-17-vscode-extension-research.md` (branch
`feat/dial-vscode-follow`, which does only the swipe for the Claude Code extension's *panel*). Models: the Orca plugin
(#4363, #4381) and the Herdr Core adapter (#4382). Nothing here touches the daemon core (cli/AGENTS.md rule 7): the
devices process, its listener and adapters, a new VS Code extension and the CLI's `device` verbs.

## Why

A customer runs Claude Code in VS Code and must decide on a return by 2026-11-24. He asks: a tap on the dial opens
"that chat's own terminal", a swipe switches VS Code to it, and the dial's scroll scrolls it. Diego saw the same gaps
(2026-11-17): Claude Code and Codex in VS Code's integrated terminal are listed on the dial, but a tap only brings VS Code
forward on whatever it showed (`open -b`, `observed.ts` `target`), a swipe does nothing (no adapter has a pane for them:
`vscode.ts` `paneOf` takes only the extension panel's `claude-vscode` entrypoint, and the tabs adapter only Terminal,
iTerm2 and Ghostty), and the scroll goes only to Harness's own windows (`dial_scroll`, `services/devices.ts`).

VS Code offers what is needed only to an extension running in that window: `window.terminals`, `Terminal.processId`
(the shell's pid), `Terminal.show()`, `window.activeTerminal` and `onDidChangeActiveTerminal`, `window.state.focused`,
and the commands `workbench.action.terminal.scrollUp` / `scrollDown`. So Harness gets a small VS Code extension of its
own, which talks to the devices process as the Orca plugin does.

## Decided (PM for Diego, 2026-11-17)

1. **Two pull requests.** PR A (this branch): the extension, the devices' half, the install, and the customer's three
   items: (1) a tap opens the session's own terminal, (2) a swipe switches VS Code to it, (4) the dial's scroll scrolls
   it. PR B (the next branch, its own spec): (3) switching terminal in VS Code moves the dial, and the follow of the
   Claude Code extension's panel by its tab name (see "PR B, decided now"). Within PR A, scroll is the last task, so (1)
   and (2) can merge without it if it runs late (cut-off 2026-11-22).
2. **Install: automatic, once a computer, as #4399 sets up Claude Code's plugin (Diego, 2026-11-18; this replaces the
   menu item decided on 2026-11-17).** The person installs Harness Device and nothing else: once a dial has attached on
   this computer and VS Code is there, the devices process installs the extension once and records it. An extension the
   person uninstalls in VS Code, or removes with `harness device vscode disable`, is never installed again;
   `harness device vscode enable` turns it back on. Harness Device's menu has no VS Code item: #4399's rule (no "Turn
   on" rows) holds unchanged.
3. **Shipping: the `.vsix` is built with the CLI and inlined in `cli.js`**, so the extension's version is the CLI's and
   they change together. No Marketplace, no Open VSX, no outside service or secret in this work; a Marketplace or Open
   VSX listing (VS Code would then update it itself; Cursor needs Open VSX) is Diego's decision later.
4. **One stream per VS Code window, at most 8.** The devices listener today keeps one stream per type; the `vscode` type
   is keyed by window instead. The first task of the plan is a spike on raising the window that holds a terminal (see
   Tap); what it finds is written in the PR.
5. **Tests use a fake VS Code API** (unit and e2e). One local gate runs the extension in a real VS Code with
   `@vscode/test-electron`: a VS Code it downloads into a temporary folder, with its own `--user-data-dir` and
   `--extensions-dir`. Never the VS Code Diego uses, never its settings or extensions.
6. **`harness device vscode link`** prints what `harness device orca link` prints, from the same function.

## What a person sees

- Nothing to turn on. The first time a dial attaches on a computer with VS Code (or the first start or attach after VS
  Code is installed), the extension is installed into VS Code in a few seconds; windows open before may show VS Code's
  own "reload" hint. On failure the devices log says why (a reason word, no path) and it is tried again an hour later.
  To turn it off, the person uninstalls it in VS Code's Extensions view (or runs `harness device vscode disable`);
  `harness device vscode enable` turns it on again.
- Claude Code or Codex in VS Code's integrated terminal, with the extension on:
  - **Tap** a session on the dial: VS Code comes forward and shows that session's terminal.
  - **Swipe** and rest on a session while VS Code is in front: VS Code switches to that terminal.
  - **Scroll** on the dial while VS Code is in front and the dial shows such a session: that terminal scrolls, line by
    line, as Harness's own windows do.
- The extension shows nothing of its own in VS Code: no panel, no status bar item, no notification, no command in the
  palette. Its output channel "Harness Device" names its state (`noHarness`, `notRunning`, `unplugged`, `connected`).

## How it works

```
VS Code window ── extension ──"vscode" stream (NDJSON, devices.sock)◀── devices process ◀──USB── dial
                            └──"vscode-state" reports ──────────────▶     (pid chain → agent; tap, rest, scroll)
```

### 1. The extension: `plugins/harness-device-vscode/`

Id `autonomous-ai.harness-device` (publisher `autonomous-ai`, name `harness-device`), display name "Harness Device",
version the CLI's own, `engines.vscode` `^1.75.0`, activation
`onStartupFinished`, no contributed commands, views or settings. TypeScript built to one JavaScript file; Node's
built-in modules and the `vscode` API only, no runtime dependency. It runs in every local window, Restricted Mode too
(`capabilities.untrustedWorkspaces` supported); in a remote window
(SSH, WSL, container) its terminals are another computer's, so it does nothing there (`vscode.env.remoteName` set).

Like the Orca plugin's worker, its loop (`src/loop.ts`) takes its inputs (platform, home, `PATH`, process runner,
socket connector, folder watcher, clock and a narrow VS Code facade) so tests pass fakes; `src/extension.ts` passes the
real ones.

1. Windows, or a remote window: stop.
2. Find the launcher (`~/.local/bin/harness`, then `harness` in an absolute `PATH` folder: a relative one is the
   extension host's working folder, which can be the untrusted folder VS Code opened) and run `harness device vscode link` (5 s,
   4 KiB). As in the Orca plugin: no launcher is `noHarness`; a failed run or `daemon: false` is `notRunning`;
   `devicesReady: false` is `unplugged`, and the folder of `devicesSocket` is watched for `devices.sock` (at most once a
   second) plus a look every 5 min.
3. Open the `vscode` stream: `POST /` `{"type":"vscode","window":"<id>"}`, where `<id>` is a random id made once per
   activation (`[A-Za-z0-9-]{8,36}`). 409 (8 windows already) or another failure: back off 1 s, 2 s, 4 s … 30 s, as
   the Orca plugin; a stream open over 30 s resets the wait.
4. Once the stream's head arrives, send the window's state as a `vscode-state` message, then again on every change
   (a terminal opened or closed, a shell pid resolved, the active terminal changed, the window gained or lost focus),
   coalesced to the latest state, at most 4 a second, each its own `POST /` on a new connection with
   `Connection: close` (no keep-alive agent), never on the stream's connection:
   `{"type":"vscode-state","window":"<id>","terminals":[<shell pid>, …],"active":<pid>|null,"focused":<bool>}`.
   At most 32 terminals (the first 32 of `window.terminals`); a terminal whose `processId` is not known yet is left out
   until it resolves. Every terminal's pid is read again on each terminal event, on `onDidChangeTerminalState` and on
   a focus change: a relaunched shell gets a new pid.
5. Lines from the stream:
   - `{"show":<pid>}`: `Terminal.show(false)` on the terminal whose shell pid it is; none: ignored, counted.
   - `{"scroll":<n>}`: when the active terminal's pid is the `pid` in the line, run
     `workbench.action.terminal.scrollUp` (n < 0, toward older lines) or `scrollDown` (n > 0) |n| times, at most 100 per
     line; otherwise drop it, counted. The line is `{"scroll":<n>,"pid":<pid>}`.
   - `{"replaced":true}`: the same window id was opened again (only a duplicate id; a reload is a new activation with
     a new id): end quietly.
   - Anything else (a line over 1 KiB ends the stream): skipped, counted.
6. On `deactivate`: close the stream, the watcher and any running `link`.

The extension types nothing into a terminal and reads nothing from one. Spoken words keep going through Claude Code's
`harness-device` mod and `codex queue`, which deliver only while the agent is idle (the same rule as Herdr Core's
`if: "idle"`): this work adds no way to type.

### 2. The devices' listener: per-window streams and state reports

In `services/devicesListener.ts`:

- A stream handler may declare a **key** (a function of its opening message) and a **limit**. The open streams are kept
  by type plus key. Streams of a keyed type are kept one per key: a second open with the same key replaces the older
  (`{"replaced":true}`, as today), even at the limit; a new key while `limit` streams of that type are open gets 409,
  checked before the handler's `open` and not counted as a drop (as the standby 409). Types without a key (`tabs`,
  `dial`) keep today's one-per-type rule unchanged. `vscode`: key `window`, limit 8, message at most 96 bytes, 1 per
  second per connection.
- `vscode-state` is a one-shot handler: at most 1 KiB, 8 per second per connection. Refused (400) unless every field has
  its form: `window` as above and naming an open `vscode` stream; `terminals` an array of at most 32 distinct integers
  in 2..2^31-1; `active` one of them or null; `focused` a boolean.
- Both handlers come from `vscodeStreams()` in `cable/hosts/vscodeTerminals.ts`, as `tabsStream()` and `dialStream()`
  come from their files. That module keeps the open windows (so `vscode-state` can check its `window`), keeps the latest
  state per window, and drops a window's state on its stream's `ended`.
- Writing to a window: one line may be in flight per stream. A pending show (the latest wins) and a scroll accumulator
  are written from `onWritable`, the show first.
- Connections stay at `LISTENER_MAX_CONNECTIONS = 16`: at most 10 long-held connections (8 windows, `tabs`, `dial`)
  leave 6 for short ones (`front`, `tab`, `attach`, state reports), which close after each message.

### 3. The devices process: matching an agent to its terminal

New file `cable/hosts/vscodeTerminals.ts`, which owns the windows' states, the streams, and the match. It is named once
in `services/devices.ts`, like every app.

- **The match is the process tree, exact.** An agent's process (`claude`, or Codex's own process) is a descendant of
  the shell whose pid VS Code reports. For each VS Code agent (app `vscode`, not the extension panel's), the devices
  take its pid's parent chain from one `ps -axo pid=,ppid=` read (`readProcessParents`, and `scannedApp.ts`
  `parentChain`, 16 levels at most), and the agent's terminal is the window and shell pid found in that chain. The chain
  of a running pid does not change, so it is read once per agent pid and kept until the agent leaves; one `ps` read
  serves every agent that needs one, and a read is asked for only while some window holds a state and some VS Code
  agent has no chain (so never with the extension off): when such an agent appears, or its last read failed (at most once per 5 s per agent; at most one read in flight, one queued). A shell with no agent in
  it never asks for a read. Only pids and parents are read: never another process's environment (cli/AGENTS.md rule 4).
- **Refresh.** When a window's state, or a new chain, changes which agents have a terminal, `vscodeTerminals` asks the
  devices for a list refresh, since an adapter's capabilities are read at each look (`observed.ts`).
- **The agent's pid.** A hooked session's place carries its caller (the engine's own process, `notify.mjs`
  `observedCallerPid`); a session found by the scan has none today (`observed.ts` `locate` gives `entry.caller`). The
  place takes the entry's own pid when no hook has given a caller yet (Claude Code's `sessions/<pid>.json`, Codex's
  `lsof` owner), so a session started before the daemon still has a terminal.
- **The pane.** `vscode.ts` stays one adapter, `id: 'vscode'`, with two pane kinds told apart by the id's form. #4407
  (`feat/dial-vscode-follow`) lands first and makes the adapter `tap: 'instead'`, with a rest for the extension panel
  through its link; this branch is rebased onto it and keeps the panel's tap and rest as #4407 left them (PM,
  2026-11-17). The bullets below are for the new terminal pane only; where they say `tap: 'before'` and "the opener then
  runs `open -b`", the terminal pane's `focus` runs `open -b com.microsoft.VSCode` itself on macOS after its show is
  queued, as `tap: 'instead'` asks. The new one: `paneOf` gives
  `{ adapter: 'vscode', id: 'term:<agent pid>' }` for a Claude Code or Codex agent whose app is `vscode`, whose
  entrypoint is not `claude-vscode`, and whose place has a pid. Its verbs ask `vscodeTerminals` for the pid's terminal at
  each call; an id of neither form is refused.
  - `canFocus`: a `term:` id whose terminal a window holds (any platform where the listener runs); a panel id, macOS as
    today.
  - `focus` (tap): writes `{"show":<shell pid>}` to that window and answers true once it is queued; the opener then runs
    `open -b com.microsoft.VSCode` on macOS (`open.ts`, `tap: 'before'`). Off macOS the line alone is the tap. A show
    that cannot be written answers false, and the opener falls back to `open -b`.
  - `canShow` (swipe): a `term:` id whose terminal a window holds, while `cableHost.latestFront() === 'vscode'`, as the
    Claude app's and Herdr's rests; false for a panel id.
  - `show`: writes `{"show":<shell pid>}`; `'ok'` once queued, `'failed'` when the window's stream is gone; `'failed'`
    for a panel id.
  - No `type`, no `paneKey`.
  - The adapter declares `bundle: APP_BUNDLES.vscode`, and `observed.ts` `target()` uses the pane's adapter's `bundle`
    whenever the entry has none of its own, and only from a pane it can focus. So a tap on a session the scan found (no
    hook yet) brings VS Code forward only while a window's stream holds its terminal. With the extension off, or its
    terminal in a window past the eighth, the tap does nothing.
- **Tap with two or more windows** (spike, task 1). `open -b` raises VS Code's last active window; a terminal in
  another window is shown there but stays behind it. The spike tries, in the throwaway VS Code, what raises the
  window that holds it from outside or from the extension, and the plan takes the first that works without a new
  permission; if none does, the PR says that a tap on a terminal in a window behind shows it in that window without
  raising it, and nothing else changes.

### 4. The dial's scroll

`services/devices.ts` `scrolled` today sends every scroll to Harness's windows (`dial_scroll`). `dialShows` carries a
name and an app only, so `CableSession.reportShown` also passes the shown agent's id (a change of id is a change too);
`CableHost` keeps it and exposes `shownAgentId()`; the `dial` stream keeps writing name and app only. `scrolled` reads
`cableHost.shownAgentId()`, then that agent's `vscode` pane (`observed.ts` `paneOf`), then `vscodeTerminals`: when the
agent has a terminal in an open window and `cableHost.latestFront() === 'vscode'` (the rule the swipe uses), the scroll
goes to that window and not to Harness's windows. Otherwise it goes nowhere, unless the dial holds the window's tab or
shows a Harness agent (`2026-11-18-dial-pick-focus-back-design.md`).

The devices turn travel into lines with Harness's own numbers (`tui/src/dial.rs`: remainder += −dy × 2.5, a 16 px
line, whole lines spent, n < 0 toward older lines; `down` resets the remainder), and write
`{"scroll":<n>,"pid":<shell pid>}` only for whole lines. A fling (`up` with a velocity) is not played in PR A: the scroll stops where the finger stops. Lines
that cannot be written at once (the window's stream not drained) are added to the next line, at most 100 a line.

### 5. `harness device vscode`

In `cli/src/deviceClaude/command.ts`, beside `claude` and `orca`. `enable` and `disable` are in the usage text as
`claude`'s are (they are the person's way to turn it back on or off); `link` and `status` are left out like `orca link`.
The work itself is one module, `cli/src/devices/vscodeExtension.ts`, which the command and the devices process both
call:

- `link`: the same function and output as `orca link`.
- `status --json`: `{"vscode":"absent"|"off"|"on","version"?:"<installed version>"}`. `absent`: no VS Code found
  (macOS: `Visual Studio Code.app` in `/Applications` or `~/Applications`; Linux: `code` on `PATH`; Windows: always
  absent). `on`: VS Code's own extensions record for its default profile (`~/.vscode/extensions/extensions.json`) lists
  `autonomous-ai.harness-device`, and `version` is that entry's. Reads files only: it runs no `code`.
- `enable`: clears `removed.vscode` in `dial-skill.json` (below), packs the `.vsix` (below) into a private temporary
  file, runs VS Code's own CLI (the app's `Contents/Resources/app/bin/code` on macOS, `code` on Linux) with
  `--install-extension <file> --force` (60 s), removes the file, and prints the status; exit 0 when on. On failure it
  prints `{"vscode":"off","error":"no-code"|"timeout"|"failed"}` and exits 1.
- `disable`: records `removed.vscode: true` in `dial-skill.json`, then `--uninstall-extension
  autonomous-ai.harness-device` (60 s).

**Set up once a computer (Diego, 2026-11-18).** `cli/src/cable/vscodeExtensionSetup.ts` replaces
`vscodeExtensionUpdate.ts`, in the devices' own process alone, as `dialPluginSetup.ts` sets up Claude Code's plugin. Its
record: `dial-setup.json` gains `vscode`, the CLI version that last set the extension up or found it, written only by
the devices service through the dial setup's record (one writer, as `plugin`); `dial-skill.json`'s `removed` gains
`vscode`, written only by the command's `disable` and `enable`. A pass runs at the service's start, at each dial attach,
and an hour after a failed one; one at a time; never on Windows or with no built extension. A pass:

1. `removed.vscode`, or a record that could not be read: nothing.
2. `vscode` recorded at this CLI's version: nothing.
3. VS Code `absent`: nothing, nothing recorded; the next start or attach looks again.
4. The extension `on`: at another version, `enable` (counted `updated`); then this version is recorded.
5. The extension `off` with a `vscode` recorded: the person uninstalled it; left alone, this version recorded, counted
   `left removed` (once a CLI version).
6. The extension `off`, nothing recorded, and a dial has attached here once (`dial-setup.json` `dial`): `enable`
   (counted `set up`), then recorded. No dial yet: nothing.
7. An `enable` that fails is counted `failed` with its reason word, records nothing, and is tried again an hour later.
   A `disable` that lands while a pass installs is honoured: the pass reads `removed` again after the install and
   uninstalls, recording nothing.

No test, e2e daemon or gate run ever reaches a real VS Code: unit tests use a fake `code` and record, and an e2e
daemon's devices process finds no VS Code even on a Mac that has one in `/Applications`.

**The build.** The CLI builds (`cli/build.mjs`, `build-bundle.mjs`) bundle the extension to one JavaScript file and
inline it, with its `package.json`, as text through esbuild `define`, as `__STATUS_LINE_SCRIPT__` is inlined (tens of
KB). `enable` packs the `.vsix` at run time with the repo's zip writer (`cli/src/lib/zipWriter.ts`):
`extension/package.json`, `extension/<main>.js`, `extension.vsixmanifest` and `[Content_Types].xml`. No `@vscode/vsce`.
The manifest's version is each build's own `version` variable, the one it gives `__ADAPTER_VERSION__`; a dev label whose
sha is all digits with a leading zero is not valid semver, so the build guards it (a letter prefix).

### 6. Harness Device's menu

No change (Diego, 2026-11-18). The "Turn on VS Code" item, its status read, its runner and its wait on relaunch, which
this branch first added, are removed: `device-app/` and `docs/plans/2026-11-13-device-menubar-design.md` match `main`,
and the menu test forbids every "Turn on" row again as #4399 left it. `docs/naming-system.md` keeps VS Code among the
vendor names kept as they are (the extension's README and log copy name it).

## Measures (rule 8)

The devices log: a `vscode` stream opening and ending, with its reason and the number of windows open; once a minute,
when any happened, counts of shows, taps, scroll lines sent and dropped, refused states, `ps` reads and failed `ps` reads; the extension's
setup (`set up`, `updated`, `failed`, `left removed`: the plugin's tally, `SETUP_COUNTS`). Never a pid, a window id, a path, a name
or a label. The extension's output channel: its state and counts, nothing else.

## Failure

| What fails | Who notices | What the person sees | Recovery |
| --- | --- | --- | --- |
| Extension not on (removed by the person) | `status` says `off` | a tap brings VS Code forward as today; no swipe or scroll | `harness device vscode enable` |
| VS Code not found | `status` says `absent` | nothing installed | the next start or attach looks again |
| The setup's `enable` fails (no VS Code CLI, timeout) | the devices log, `failed` with a reason word | as with the extension off | tried again an hour later; or `enable` |
| Daemon or devices process down | the stream ends; `link` | a tap falls back to `open -b`; no scroll | the extension's backoff (30 s at most) and folder watch |
| A 9th window | 409 | that window's terminals are not reached | backoff; it gets a slot when another window closes |
| An agent's terminal not found (no chain, a shell not reported) | no pane | as with the extension off | the next `ps` read or state |
| `ps` fails | the read's error, counted | as above | the next agent or state asks again |
| A `show` for a terminal that closed | the extension, counted | nothing | none needed |
| Scroll while the shown agent's terminal is not active | the extension drops it, counted | nothing scrolls | a tap or swipe shows it |
| Stream not drained in 2 s | the listener ends it (`stalled`) | a line lost | the extension reopens and resends its state |
| Two VS Code windows, terminal in the one behind | see the spike | per the spike's result | per the spike's result |

## Design (docs/feature-design-rules.md)

1. **Growth:** two fields in files that exist: `dial-setup.json` `vscode` (a version, at most 64 characters) and
   `dial-skill.json` `removed.vscode` (true or absent). In memory: at most 8 windows' states (32 pids each), one kept
   chain per VS Code agent (16 pids), dropped when the window's stream ends or the agent leaves. VS Code's own record
   says whether the extension is on.
2. **Concurrency:** the devices' single event loop owns every state. A window's newer state replaces the older whole. At
   most one `ps` read runs, with one more queued. A reloaded window's old stream ends with its extension host's socket
   (`gone`); the new activation has a new id. One setup pass at a time. The command's `enable` and a pass can meet:
   both run VS Code's own `--install-extension --force` of the same file, which ends with the same extension
   installed. A `disable` during a pass's install is undone by that pass (step 7). Each record has one writer.
3. **Read cost:** a state message is under 1 KiB, sent only on change, at most 4 a second per window; a show line
   under 32 bytes; scroll at most one line per dial scroll frame.
4. **Scale:** 8 windows × 32 terminals; a `ps` read per new VS Code agent, not per state. First warning
   sign: the per-minute `ps` read count in the devices log.
5. **Compatibility:** an older daemon answers `vscode` with 404 and an older CLI has no `device vscode`; the extension
   reads both as `notRunning` and backs off. An extension newer or older than the daemon speaks the same lines; a field
   it does not know is ignored on both sides. `tabs` and `dial` keep their one-per-type rule.
6. **Migration and rollback:** none. Rolling the CLI back leaves the extension installed and reading `notRunning`; the
   person can uninstall it in VS Code. An older CLI that rewrites `dial-setup.json` drops `vscode`, so after rolling
   forward an extension removed in between is installed once more; accepted, as a rollback is rare.
7. **Audience:** shell pids and the window's state go only over the devices socket (0600, this account's folder) to
   the devices process. Nothing leaves the computer. Nothing is logged but counts.
8. **Identity:** everything runs as the person, on their computer. The extension types nothing and starts nothing but
   `harness device vscode link`.
9. **Failure:** above.
10. **Platforms:** macOS (the customer, and where a tap brings VS Code forward). Linux: a tap shows the terminal
    without raising VS Code; swipe and scroll need the app in front, which only Harness Device's X11 reader reports, so
    they work under X11 with Harness Device running, not under Wayland. Windows: the devices listener has no Windows
    path, so the extension stops and the setup never installs it. VS Code's default profile only (`--install-extension`
    and `~/.vscode/extensions`); Cursor, VS Code Insiders and VSCodium are not in this work.

## Verification

- **Unit (CI, vitest in `cli/`):** the listener's keyed streams (per-window replace, the 9th's 409, the unkeyed types
  unchanged) and `vscode-state` forms; the chain match (a shell several levels up, a pid in no window, a reused window
  id, a new VS Code agent with no chain asks one read while a window holds a state, none with no window, reads never
  overlap); the scanned session's place taking
  its own pid, and `target()` taking the adapter's bundle; the adapter's verbs (a tap writes the show and then runs
  `open -b`, a tap off macOS, a show not written falls back, `canShow` only with VS Code in front, a panel id
  unchanged, a refused id, a gone stream); the shown agent's id reaching `CableHost`; scroll routing (to the window only
  when VS Code is in front and the shown agent has a terminal, else `dial_scroll`) and the line count against
  `dial.rs`'s numbers; `device vscode link|status|enable|disable` with a fake `code` and a fake extensions record, and
  the `.vsix` packed by `zipWriter`; `enable` clearing and `disable` setting `removed.vscode`; the setup (a dial attached
  and VS Code there installs once and records it, a second pass or attach does nothing, an extension uninstalled after
  the setup is never installed again and counts `left removed` once, `removed.vscode` does nothing, no VS Code does
  nothing and records nothing, no dial yet does nothing, on at another version is updated, a failure records nothing and
  is tried an hour later, a `disable` during the install is undone, Windows does nothing). The extension's
  loop and its line handling with a fake VS Code facade run in the same suite: `cli/vitest.config.ts` includes
  `../plugins/harness-device-vscode/src/**/*.test.ts`, and `scripts/ci-plan.py` maps `plugins/harness-device-vscode/`
  to the CLI's checks (the CLI build reads it), so PR CI runs them.
- **End to end (`cli/e2e`, this Mac and Linux, isolated):** an isolated daemon with a fake dial (the
  `dialStream.e2e.ts` harness), the extension's loop with a fake VS Code facade over the real devices socket, and real
  processes: a shell started by the test with the fake engine under it, so the pid chain is the computer's own. A tap
  and a swipe send `show` for that shell; a scroll on the fake dial sends the expected lines. It never reaches Diego's
  daemon, dial or VS Code.
- **Local gate, real VS Code (`@vscode/test-electron`):** a VS Code downloaded into a temporary folder, launched with
  its own `--user-data-dir` and `--extensions-dir`, with the built `.vsix` installed there: two terminals report their
  shells' pids, `show` selects the right one, and a scroll line runs VS Code's scroll command on the right
  terminal (the extension's count); the gate does not read the scroll position, which the person checks after merge
  (PM, 2026-11-17). The spike (task 1) runs in the same throwaway.
  Tests never open anything by bundle id or `vscode://` link (that reaches Diego's VS Code): `open` is stubbed.
- **device-app:** no change from `main`.
- **Local gates:** `npm run test:core` (the listener is under `src/services/`), recorded in the PR.
- **By a person, after merge:** a dial attached with VS Code installed turns the extension on with no step, and a real
  tap, swipe and scroll on a dial, in a VS Code that is theirs to change (Diego decides where); not run by an agent.

## Docs changed in the same pull request

`cli/AGENTS.md` (the devices row: VS Code's terminals, the extension's update), `cli/src/services/AGENTS.md` and the
header of `devicesListener.ts` (a keyed stream type beside one-per-type), `docs/validation-and-release.md` (the
`@vscode/test-electron` local gate), `docs/naming-system.md` (VS Code among vendor names), and
`plugins/harness-device-vscode/README.md` (what it does and never does, that it turns on by itself, how it is turned off
and on again).

## PR B, decided now (its own spec and branch)

- (3) A window's state with `focused: true` and a new `active` shell, while VS Code is the settled app in front, moves
  the dial to the agent in that terminal (`followLocal`, cause `vscode`), with the 2 s echo guard of the dial's own
  shows; a report before the settle waits for it, as a tab's does.
- The Claude Code extension's panel: the extension adds the active tab's label when it is that extension's panel; the
  devices match it against each panel session's title (custom title, else AI title, read from its transcript, cut to
  24 characters and `…` as the panel cuts it) and follow only when exactly one matches. The title is used for the match
  only: never shown, sent, or logged (PM, 2026-11-17).

## Known gaps (PM, 2026-11-17)

- With two dials, one dial's scroll can follow the agent the other dial shows.
- A swipe that rests on a terminal in a window behind does not raise that window. Only a tap does.

## Not in this work

- Cursor, VS Code Insiders, VSCodium, remote windows; the Marketplace or Open VSX.
- A fling after the finger lifts; the device's `scrollReversed` (the daemon applies it nowhere today).
- Typing into a terminal from the extension.
- Anything in the core.
