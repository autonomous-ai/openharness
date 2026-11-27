# The dial and the Claude app follow each other, session by session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With the Claude app in front, selecting one of its sessions turns the round dial to that agent, and a swipe that rests on a Claude app agent shows its session in the app.

**Architecture:**
- The harness-device mod hears `session.attach` (surface `desktop`) and posts its own session id to the devices process's own listener, whose socket `harness device claude link --json` now prints. A mod the launcher handed no such socket asks it again at an attach, at most once in 30 s. Nothing goes through the core.
- In the devices process a new `attach` handler names the observed agent. The devices keep the Claude app's last attached agent and turn the dial to it through the existing `cable.followPrompt`: when an attach comes with the app settled in front, or when the app settles in front (a new `settled(app)` call from the app filter).
- A rest of the dial on a Claude app agent runs the app's continue link through `/usr/bin/open`, only while the app most recently reported in front is the Claude app. The devices remember that link for 2 s, so its own attach is not followed back.
- Everything is in memory, in the devices process. No firmware, no Desktop UI, no core file, no change to `cableSession.ts`.

**Tech Stack:** TypeScript daemon and CLI (Node, vitest, `cli/`), the Claude Code plugin's mod (JavaScript, tested with `claude plugin test`).

**Spec:** `docs/specs/2026-11-15-dial-claude-app-follow.md`. Its base: `docs/specs/2026-11-14-dial-pane-follow.md` (#4311).

## Layers

Every file this plan creates or changes, and the process it runs in (`cli/AGENTS.md`, master / core / services).

| File | Layer and process | Gate |
|---|---|---|
| `plugins/harness-device/hooks/device.js`, `plugins/harness-device/test/device.test.ts` | **Plugin**: the mod, inside Claude Code | `claude plugin test`, `claude plugin validate` (local) |
| `cli/src/deviceClaude/command.ts` | The `harness` command's own process | `command.spec.ts` |
| `cli/src/services/devicesListener.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/src/cable/hosts/appFilter.ts`, `cli/src/cable/cableHost.ts` | **Devices service process** | Their specs (`appFilter.spec.ts` keeps its file at 100%) |
| `cli/src/cable/hosts/open.ts`, `cli/src/cable/hosts/observed.ts` | **Devices service process** | Their specs |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/e2e/dialClaudeAppFollow.e2e.ts` (new) | Test: the real daemon, a fake dial, the real watch, the real launcher | `cli-e2e.yml` |
| `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `plugins/harness-device/README.md` | Repo files, no process | `harnessDevicePlugin.spec.ts` reads the README |

Not changed: anything under `cli/src/core` (`src/architecture.coreFiles.txt` keeps its lines), `cable/cableSession.ts`, `cable/cableFleet.ts`, `cable/hosts/types.ts`, `devices/listenerPath.ts`, `devices/listenerClient.ts`, `lib/localTransport.ts`, `hook/notify.mjs`.

## Stack and coordination

- **Base.** `feat/dial-pane-follow` (#4311) at `cb84872467`. Every name this plan consumes is there: `AppFilter` (`front`, `settledApp`, its private `lastFront` and `settle`, `FRONT_SETTLE_MS = 1_000`), `DaemonCableHost` (`front`, `settledApp`, `swipeSwitches`, `swipeEnded`, `promptFollowed`), `CableFleet.followPrompt`, `SWIPE_REST_MS = 400`, `ObservedSource` (`hasPane`, `showPane`, `Entry.opens`), `ObservedActions`, `open.ts` (`CLAUDE_SESSION`, `Pane`, `createOpenActions`), `devicesListener.ts` (`frontHandler`, `ListenerHandler`, `REFUSED`), `devices.ts` (`followPrompt`, the listener registration), `devicesListenerPath`, `socketIsPrivate`, `fetchOverSocket`. If #4311's head moves, the main session rebases; no task here does.
- **`feat/dial-terminal-follow`** is stacked on the same base and writes the same files. No commit is shared; whichever merges second rebases. So every edit here is an addition at a named place:
  - `cableSession.ts`: no edit. This branch calls `cable.followPrompt(agentId)` as it is. After a rebase onto `followLocal(agentId, cause)`, Task 7's calls pass `'attach'` and its `followedFor` goes.
  - `observed.ts`: two members appended to `ObservedActions`, one private method appended, one branch more in `hasPane` and in `showPane`. After a rebase that branch is the `claude` kind of the other branch's dispatch.
  - `devicesListener.ts`: `attachHandler` and its two constants appended at the end of the file.
  - `devices.ts`: one constant; two members in the observed actions literal; `appSettled`, and `promptFollowed`'s line, in the cable host literal; two values, a map and three functions beside `followPrompt`, and one line in it; one key in the listener registration; one line in `port.observed`.
  - A new end-to-end file, so `dialPaneFollow.e2e.ts` is not touched.

## Global Constraints

- **Only attach, only the desktop surface.** The mod acts on `session.attach` with `surface: 'desktop'`. A detach, and an attach on any other surface, send nothing.
- **The mod sends only its own session id**, `$.session.id()`: `{"type":"attach","sessionId":"<id>"}`. No other session's id, no title, no content.
- **Rule 7.** The attach goes from the mod to the devices process's own listener (`services/devicesListener.ts`), never through the core. No file under `cli/src/core` changes.
- **`link --json`** prints `{"socketPath":…,"devicesSocket":…}`; `devicesSocket` only when `socketIsPrivate` says the listener's socket is this account's own. No listener (Windows, a path too long, none running): no `devicesSocket`.
- **No `devicesSocket` at an attach.** The mod runs the launcher that linked once more (`link --json`): at most once in 30 s for a session, killed after 5 s. An answer with a `devicesSocket` is kept and that attach is sent. Any failure is silent: that attach is not sent, nothing retries, the polls go on. A mod that never linked (Windows, the plugin off) asks nothing.
- **The listener's `attach`:** a body of at most 96 bytes whose `sessionId` is a UUID; 10 a second per connection. Anything else is refused and counted by the listener's own minute line. The id is never logged.
- **An attach moves the dial** only when all hold: the observed source lists `observedAgentId('claude', sessionId)` and its app is `claude`; it is not the echo of the dial's own link to that agent within the last 2 s; `cableHost.settledApp() === 'claude'`; a dial is linked and its ring holds the agent. The move is `cable.followPrompt(agentId)`, unchanged: its queue, its list before its focus, its echo guard. An agent the dial already shows: nothing is sent.
- **The kept agent.** One agent id, in memory: the last attach that named a listed Claude app agent. Cleared when that agent's session ends. When the Claude app settles in front, the dial moves to it by the same rules. A settle moves nothing while any continue link of the dial's own is younger than 2 s. A Cmd-Tab across the app settles nothing and moves nothing.
- **A swipe.** A Claude app session (`opens.pane` `{ app: 'claude', id: 'local_…' }`) is a pane only on macOS and only while the app most recently reported in front is `claude` (`AppFilter`'s last `front`, not the settled one). After #4311's 400 ms rest the front is asked again, then `/usr/bin/open claude://code/continue?session=<local_…>` runs: `execFile`, no shell, 10 s timeout, the id checked against `CLAUDE_SESSION` (`/^local_[A-Za-z0-9-]{1,64}$/`). Front no longer `claude`: nothing runs, outcome `failed`, nothing on the dial. A link still running for that agent drops the next: `busy`. Orca agents keep #4311's switch.
- **Measures** are daemon log lines with no content and no identifier: `[device] attach · moved`, `[device] settle · moved`, `[device] attach · skipped · echo | not in front | unknown agent | no tile`, and the swipe's link through #4311's `[device] swipe · ok | failed | busy | superseded`.
- **Memory only, push only.** Nothing is written to disk. The daemon gains no timer: the echo is a time compared when an attach or a settle comes. Nor does the mod: its 30 s is a time compared at an attach.
- **No end-to-end test may reach `/usr/bin/open`.** No end-to-end session carries `CLAUDE_CODE_HOST_SESSION_ID` (without it the observed source holds no Claude pane, on any platform), and no end-to-end test taps. The swipe's link is covered by unit tests only, with a recording runner.
- **Platforms.** macOS: tested, and on a dial. Linux: the attach path's unit and end-to-end tests; no Claude app, so a rest runs no link. Windows: no listener and no link, nothing changes.
- **Repo rules.** Tests never touch the developer's real `~/.claude`, daemon (port 18473), Claude app or dial. No fixed sleeps: fake timers, a scripted clock, or a wait on a condition.

## Review Focus

1. **A session shown and left again before its mod linked, or while the launcher is asked again** (its first moments, the plugin switched off and on, a launcher slow to answer): the app no longer shows it, so no attach is sent for it once the mod links or the launcher answers. Task 1 (`attached and detached again before the link: nothing is sent`, `shown and left again while the launcher is asked: nothing is sent`).
2. **An attach that moved nothing is still the session the app shows.** One skipped as the dial's own echo, or with another app in front, replaces the kept agent: the next settle goes to it, never to an older one. Task 7 (`an attach skipped as the echo is still the session the app shows`).
3. **A dial whose ring lacks the agent** (a pick on the dial, a Harness window, a second dial): it stays, and its answer is counted as the attach's `no tile`, not as a prompt's. Task 7 (`a dial's answer is counted under what it was last asked for`).
4. **A session id that is not the link's form, or a session resumed outside the Claude app since the dial turned to it:** nothing reaches `/usr/bin/open`. Task 5 (`an id not in the link's form never reaches open`), Task 6 (`the session is the latest event's`).
5. **The listener gone when the mod posts** (the daemon restarting, the dial unplugged): the send fails, nothing retries, the polls go on, and the next attach is sent. Task 1 (`a failed send is dropped`).

---

### Task 1: The mod tells the devices when the Claude app shows its session

**Layer:** plugin (the mod, inside Claude Code). **Depends on:** none. **Effort:** `high`.

**Files:**
- Modify: `plugins/harness-device/hooks/device.js` (`register`, `link`, `socketOf`, `poll`; two constants beside `RETRY_MS`; its header comment)
- Test: `plugins/harness-device/test/device.test.ts` (`world` gains the launcher's `devicesSocket` and what it does once the mod has linked, both a test's to change, each launcher run's `init`, and a list of what was sent on the devices' socket)

**Interfaces:**
- Consumes: the launcher's answer `{"socketPath":…,"devicesSocket":…}` (Task 2 prints the second key; here the test's launcher does). The engine's events `session.attach` and `session.detach`, input `{ surface, clientId }`, registered with the matcher `{ surface: 'desktop' }`. A test raises them with `$.session.attach({ surface: 'desktop', clientId: 'desktop:default' })` and `$.session.detach({ surface: 'desktop', clientId: 'desktop:default', reason: 'detach' })`.
- Produces, the one message: `$.http.fetch('http://harness/', { method: 'POST', socketPath: <devicesSocket>, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'attach', sessionId: await $.session.id() }) })`.
- Produces, the launcher asked again: `$.process.run([linked.launcher, 'device', 'claude', 'link', '--json'], { timeoutMs: RELINK_TIMEOUT_MS })`. The engine kills the run at `timeoutMs` and the call rejects.
- Constants:
  - `RELINK_MS = 30_000`: the least time between two such asks of one session.
  - `RELINK_TIMEOUT_MS = 5_000`. Why 5 s: `link` reads one settings file and checks one socket, with no network and no daemon call, so it is done in the time the CLI takes to start; `hooks.json` gives the same launcher 5 s for `asked`; and it is under `RELINK_MS`, which the engine's own 30 s is not, so a launcher that hangs is gone before the next ask and two never run at once.
- State: one object made in `register` and handed to the hooks and to `link`, no module variable:
  - `linked`: the launcher's last answer with a socket (`socketPath`, `settingsPath`, `devicesSocket`, `''` when it printed none, and `launcher`, the `argv[0]` that answered). `null` before, and again once a poll finds the plugin off.
  - `held`: the app shows this session and the devices have not been told. Set by a desktop attach; cleared by a desktop detach, and as the send goes.
  - `askedAt`: `$.clock.now()` when the launcher was last asked again; `null` before the first.
- Rules:
  1. `session.attach`, desktop: answers `await next(e)` unchanged; sets `held`; when `linked`, starts one `$.clock.after(0, …)` for the send. Never awaited in the hook.
  2. `session.detach`, desktop: answers `next(e)`; clears `held`. It sends nothing.
  3. `link`, on a socket: sets `linked`; when `held`, starts one `$.clock.after(0, …)` for the send, beside the poll's. With nothing held it starts no timer more (`every poll is sent from a timer of its own` keeps its exact steps).
  4. The send, from its timer: nothing unless `held` and `linked`. With a `devicesSocket`: clears `held`; the plugin's setting read once (`isOn`), off: nothing; else the one fetch above. Its answer is not read and its failure is dropped: no retry.
  5. The send with no `devicesSocket`: nothing when `askedAt` is less than `RELINK_MS` ago (29 999 ms: no; 30 000 ms: asked), and `held` stays. Else `askedAt` is now, and the launcher is asked again (above), in this timer, never in a hook. Exit 0 with a `devicesSocket` that is a non-empty string: kept in `linked` when one is still set, and rule 4 runs again, so a detach meanwhile sends nothing. Anything else (it cannot start, it is killed at 5 s, a non-zero exit, no JSON, no `devicesSocket`): nothing. No timer, no retry, no line; `linked` and the polls are as they were.
  6. Only `linked.launcher` is asked again: no second launcher is tried, and `HOME` is not read again.
  7. A poll that finds the plugin off sets `linked` to `null` before the launcher is asked again.

- [ ] **Step 1: Write the failing tests** (`DEVICES = '/tmp/harnessd/devices.sock'`; `w.polls` stays the fetches on the core's socket, `w.attaches` is the fetches on the devices'; `w.devices` is the `devicesSocket` the launcher prints, `''` for none; `w.runs` stays each run's argv and `w.inits` is each run's `init`):
  - `an attach on the desktop surface tells the devices its own session id, and nothing else`: `w.attaches` equals the one `{ url: 'http://harness/', init: { method: 'POST', socketPath: DEVICES, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'attach', sessionId: SESSION }) } }`.
  - `the attach is sent from a timer, never inside the hook`: after `await $.session.attach(…)`, `w.attaches` is empty; after `w.clock.settle()`, it holds one.
  - `a detach, and an attach on the mobile, vscode or terminal surface, send nothing`.
  - `an attach before the mod has linked is sent once it links, the latest only`: `$.session.start(…)`, two desktop attaches, then `settle()`: one in `w.attaches`.
  - `attached and detached again before the link: nothing is sent`.
  - `an attach with no devicesSocket asks the launcher again, and the devices are told once it prints one`: linked with `w.devices` `''`, then `w.devices = DEVICES`; a desktop attach and `settle()`: one run more, `[LOCAL, 'device', 'claude', 'link', '--json']` with `init` `{ timeoutMs: 5_000 }`; `w.attaches` holds the one message. A next attach is sent with no run more.
  - `only the launcher that linked is asked again` (`launchers: ['harness']`: the one run more is `['harness', …]`; `w.envAsked` gains nothing).
  - `a second attach within 30 s does not ask again, and one after 30 s does`: the launcher prints no `devicesSocket` throughout; an attach: one run more; an attach 29 999 ms later: none; one at 30 000 ms: a second. `w.attaches` stays empty.
  - `a launcher that fails or is killed at its 5 s sends nothing, and the polls go on`, each of: exit 1; it cannot start; stdout `'{'`; `socketPath` alone; a run that rejects after `clock.sleep(5_000)`, as the engine does at `timeoutMs`. `w.attaches` is empty, nothing throws, no other launcher is run, and the next poll is sent when it would be with no attach.
  - `shown and left again while the launcher is asked: nothing is sent`: the run held; a desktop detach; the run prints `DEVICES`: `w.attaches` is empty. A next attach is sent with no run more.
  - `an attach while the launcher is asked is told once, when it answers`.
  - `a mod that never linked asks nothing at an attach` (`exitCode: 1`: `w.runs` is the link's alone).
  - `a failed send is dropped`: the devices' fetch refused; after 10 minutes of clock still one try; a second attach is a second try.
  - `with the plugin switched off nothing is sent` (off while a poll is held, then an attach), and `switched off and on again: the session the app still shows is told once the mod links`.
  - `the polls go on the core's socket alone and the attach on the devices' alone`; `only HOME and CLAUDE_CONFIG_DIR are read` with an attach sent.
- [ ] **Step 2: Run** `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin test plugins/harness-device`. Expected: FAIL (nothing is sent on the devices' socket).
- [ ] **Step 3: Implement.** The header comment says what the mod now sends and where.
- [ ] **Step 4: Run** the step 2 command, then `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin validate plugins/harness-device` and `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts`. Expected: PASS; the report shows three hooks (`session.start`, `session.attach`, `session.detach`) and no new variable, tool, command or interface.
- [ ] **Step 5: Commit** `mod: the Claude app showing a session tells the devices its id, and nothing else`.

### Task 2: `link --json` prints the devices' socket

**Layer:** the `harness` command's own process. **Depends on:** none. **Effort:** `high` (it decides which socket the mod is handed).

**Files:**
- Modify: `cli/src/deviceClaude/command.ts` (`case 'link'`, and the file's header comment)
- Test: `cli/src/deviceClaude/command.spec.ts`

**Interfaces:**
- Consumes: `devicesListenerPath(dataDir, platform)` (`devices/listenerPath.ts`), `socketIsPrivate(path)` (`lib/localTransport.ts`).
- Produces: `link --json` prints `JSON.stringify({ socketPath, devicesSocket })`, keys in that order, when the listener's path is not null and `socketIsPrivate` is true for it; otherwise `JSON.stringify({ socketPath })` as today. Its exit codes do not change: 1 with no output on Windows and with the plugin off.

- [ ] **Step 1: Write the failing tests** (a real socket from `listenLocalSocket` at `devicesListenerPath(dataDir)!`, in the spec's throwaway folder):
  - `link --json prints devicesSocket beside the socket when the devices' listener is this account's own`.
  - `it leaves devicesSocket out when the socket is missing` (the existing `prints the socket path and nothing else`, kept).
  - `it leaves devicesSocket out when the socket is not private`: the socket's mode `0o666`; its folder's mode `0o777`; a plain file at its path.
  - `link after disable exits 1 with no output, a listener there or not`; the Windows case unchanged.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude/command.spec.ts`. Expected: FAIL (no `devicesSocket`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `device claude link: the devices' socket beside the daemon's, only when it is this account's own`.

### Task 3: The listener takes `attach`

**Layer:** devices service process. **Depends on:** none. **Effort:** `high` (a new message at the devices' trust boundary; the file is in the 100% gate).

**Files:**
- Modify: `cli/src/services/devicesListener.ts` (appended after `frontHandler`; the file's header comment names the mod's attach beside the watch's front)
- Test: `cli/src/services/devicesListener.spec.ts` (a `describe('attach')` after `front`)

**Interfaces:**
- Produces:
  - `export const ATTACH_PER_SECOND = 10`
  - `export const ATTACH_MAX_BYTES = 96` (the message is 68 bytes)
  - `export function attachHandler(attach: (sessionId: string) => void): ListenerHandler`: `sessionId` a string matching `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` is handed on and taken (nothing returned); anything else answers `REFUSED`. It keeps nothing and logs nothing.

- [ ] **Step 1: Write the failing tests:**
  - `attach takes a UUID sessionId and hands it on`.
  - `attach refuses any other body`: no `sessionId`, a number, `''`, `'session-1'`, a `local_…` id, a UUID with a space or a newline after it, 37 characters, an array, `'__proto__'`; the callback is never called.
  - `the attach handler holds nothing: it is its two limits and handle`; `[ATTACH_MAX_BYTES, ATTACH_PER_SECOND]` is `[96, 10]`; its message is 68 bytes.
  - On a real listener (`open({ attach: attachHandler(…) })`): `an attach of 97 bytes is 413 and the handler never runs`; `the 11th attach within a second on one connection is 429`; `a refused attach is 400, counted in the minute line, and no line or answer holds the id`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devicesListener.spec.ts`. Expected: FAIL (`attachHandler` is not exported).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devicesListener.ts`.
- [ ] **Step 5: Commit** `devices listener: attach, a session id from the Claude Code mod, 96 bytes and ten a second`.

### Task 4: The app filter tells each settle and the last front

**Layer:** devices service process. **Depends on:** none. **Effort:** `high`.

**Files:**
- Modify: `cli/src/cable/hosts/appFilter.ts` (`AppFilterDeps` beside `switched`; `settle`; a reader beside `settledApp`), `cli/src/cable/cableHost.ts` (`CableHostWiring` beside `appSwitched`; the `new AppFilter({ … })` literal; a method beside `settledApp`)
- Test: `cli/src/cable/hosts/appFilter.spec.ts` (its `setup` gives `settled`), `cli/src/cable/cableHost.spec.ts` (`describe('the dial that shows one app at a time')`)

**Interfaces:**
- Produces:
  - `AppFilterDeps.settled(app: string): void`: called at the end of `settle(app)`, after any switch it caused, each time an app has stayed in front for `FRONT_SETTLE_MS`. `none`, an app with no agents and the same app settling again are told too.
  - `AppFilter.latestFront(): string | undefined`: the last value `front` was given, at once, before it settles. `undefined` until the first.
  - `CableHostWiring.appSettled?: (app: string) => void`, which the host's filter calls through.
  - `DaemonCableHost.latestFront(): string | undefined`: the filter's, with or without a window.

- [ ] **Step 1: Write the failing tests:**
  - `appFilter.spec.ts`:
    - `settled is told each time an app settles in front, after the switch it caused`: `front('vscode')` and 1 s: `switched('front')` then `settled('vscode')`, in that order; `none` settled; an app with no agents settled; away and back inside a second: told again for the same app; fifty changes inside a second: told once, for the last.
    - `a front that does not stay 1 s tells no settle` (three apps inside a second, then a fourth: only the fourth).
    - `latestFront is the app last reported, before it settles`: `undefined`; `front('claude')`: `claude` while `settledApp()` is still `undefined`; `front('orca')`: `orca`; `front('none')`: `none`.
    - The file stays at 100%.
  - `cableHost.spec.ts`: `appSettled reaches the wiring each time an app settles, after appSwitched` (a scripted `appTimer`); `latestFront is the app last reported, with a window open too`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/appFilter.spec.ts src/cable/cableHost.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: the app filter tells each app that settles in front, and the app last reported there`.

### Task 5: The Claude app's continue link, for a rest

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (a value from a hook reaches `/usr/bin/open`).

**Files:**
- Modify: `cli/src/cable/hosts/open.ts` (`createOpenActions`: its return type, one function appended, a set beside `running`)
- Test: `cli/src/cable/hosts/open.spec.ts` (a `describe('a rest on a Claude app session')`; its `recorder` runs nothing)

**Interfaces:**
- Produces: `createOpenActions(deps)` also returns `claudeShow(agentId: string, session: string): Promise<PaneSwitch>` (`PaneSwitch` from `./types.js`):
  - `'failed'`, with nothing run, off macOS or when `session` fails `CLAUDE_SESSION`.
  - `'busy'`, with nothing run, while a link `claudeShow` started for that `agentId` still runs. Its set is its own: the tap's `running` is not read or written, so neither refuses the other.
  - Else `deps.run('/usr/bin/open', ['claude://code/continue?session=' + session], RUN_TIMEOUT_MS)`: `'ok'` on exit 0, `'failed'` on any other code or none (the 10 s timeout). No `open -b` after a failure, and no log line.
- `can` and `open` (the tap) do not change.

- [ ] **Step 1: Write the failing tests:**
  - `claudeShow runs the continue link, and nothing else`: one call, `run(OPEN, 'claude://code/continue?session=' + SESSION)`; `'ok'`.
  - `a link that exits non-zero, or never exits, is failed, and no app is brought forward` (codes `1` and `null`: one call each, no `-b`).
  - `an id not in the link's form never reaches open`: `''`, `'local_'`, `'local_' + 'a'.repeat(65)`, `'local_a b'`, `'local_a&x=1'`, `'local_a/../b'`, `'-b'`, `'8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'`: each `'failed'`, no call.
  - `on Linux and Windows nothing runs`.
  - `a link still running drops the next for that agent, and another agent's runs`: a held `run`; the second `claudeShow('a1', …)` is `'busy'` with one call; `claudeShow('a2', …)` runs; once the first ends, `a1`'s next runs.
  - `a tap is not refused while a rest's link runs, and a rest is not busy while a tap runs`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/open.spec.ts`. Expected: FAIL (`claudeShow` is not a function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: the Claude app's continue link for a swipe, one at a time for an agent`.

### Task 6: A Claude app session is a pane while the app is in front

**Layer:** devices service process. **Depends on:** Task 4 (`latestFront`), Task 5 (`claudeShow`). **Effort:** `high`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`ObservedActions`, two members appended; `hasPane`, `showPane` and their comments; one private method after `paneHandle`), `cli/src/services/devices.ts` (the observed actions literal, two members after `orcaSwitch`)
- Test: `cli/src/cable/hosts/observed.spec.ts` (`describe('ObservedSource panes')`; `fakeActions` gains the two), `cli/src/services/devices.spec.ts` (`describe("the mod's voice and Orca, …")`, beside the rest tests)

**Interfaces:**
- Consumes: `DaemonCableHost.latestFront()` (Task 4); `createOpenActions(…).claudeShow` (Task 5); `ObservedActions.canOpen` (a Claude pane is openable on macOS only, the tap's own rule).
- Produces, in `observed.ts`:
  - `ObservedActions.claudeInFront(): boolean`: the Claude app is the app most recently reported in front.
  - `ObservedActions.claudeShow(agentId: string, session: string): Promise<PaneSwitch>`.
  - `hasPane(agent)` is also true when the source has actions, the session is live, its latest event's `opens.pane` is `{ app: 'claude', … }`, `actions.canOpen({ pane })` and `actions.claudeInFront()`.
  - `showPane(agent)`: Orca's handle first, as today. Else the Claude pane by that same test, asked again now: `actions.claudeShow(agent.id, pane.id)`. Else `'failed'` with nothing run. It never calls `actions.open`.
- Produces, in `devices.ts`: `claudeInFront: () => cableHost.latestFront() === 'claude'` and `claudeShow: opener.claudeShow`.
- Not here: the 400 ms rest and "three turns in 400 ms run one, for the last" are `cableSession.spec.ts`'s, for any agent whose `swipeSwitches` is true (`a hand's turn to an agent with a pane rests after 400 ms, once`, `three turns within 400 ms: one rest, for the last agent`; #4311's, unchanged). These tests start at `swipeSwitches` and `swipeEnded(id, 'rest')`.

- [ ] **Step 1: Write the failing tests:**
  - `observed.spec.ts`:
    - `hasPane: a Claude app session, where a tap can open it, while the Claude app is in front`: true; false with `claudeInFront` false; false with `canOpen` false; false once its session ended; false for a session with `CLAUDE_CODE_HOST_SESSION_ID` and another app's bundle id; false for an id that is not `local_…`.
    - `showPane shows the session through claudeShow and answers what it said` (`'ok'`, `'failed'`, `'busy'`; called with the agent's id and `local_…`; neither `orcaSwitch` nor `open` called).
    - `showPane asks the front again: no longer in front, it is failed and nothing runs`.
    - `the session is the latest event's`: resumed under another `local_…` id shows the new one; a next event from another app, and an ended session, answer `'failed'` and call no `claudeShow`.
  - `devices.spec.ts` (macOS: `{ ...orca, platform: 'darwin' }`; a Claude app session with `CLAUDE_CODE_HOST_SESSION_ID: 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'`; the front told through the fake listener's `front`):
    - `with the Claude app in front, a rest on a Claude app agent runs one continue link, and no open -b`: `swipeSwitches` true; `orcaRuns` is the one `['/usr/bin/open', ['claude://code/continue?session=local_…'], 10_000]`; `said()` is `['[device] swipe · ok']`.
    - `the front that counts is the one last reported, not the settled one`: Orca settled and `claude` just reported: true; `claude` settled and `orca` just reported: false.
    - `another app in front, none, or no front known: no rest is asked for` (`swipeSwitches` false; the existing `an agent in the Claude app or WezTerm: a rest runs nothing` stays as it is).
    - `a front that changes during the rest runs none`: `swipeSwitches` true, `front('orca')`, `swipeEnded(id, 'rest')`: `[device] swipe · failed`, `orcaRuns` empty, the dial sent nothing.
    - `a link still running drops the next for that agent: busy`; `a link that fails is one line and the dial is sent nothing`.
    - `on Linux a Claude app agent has no pane`.
    - `no swipe line carries the session`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`; the Orca rest and tap tests pass unchanged.
- [ ] **Step 5: Commit** `dial: a swipe that rests on a Claude app agent shows its session, while the app is in front`.

### Task 7: The devices: an attach turns the dial, and so does the app settling in front

**Layer:** devices service process. **Depends on:** Task 3 (`attachHandler`), Task 4 (`appSettled`), Task 6 (the same file, and `claudeShow`'s place in the literal). **Effort:** `xhigh` (an echo guard, a kept value and a settle racing each other; `services/devices.ts` is in the 100% gate).

**Files:**
- Modify: `cli/src/services/devices.ts` (a constant beside `LISTENER_WAIT_MS`; `claudeShow` in the observed actions literal; `promptFollowed`, and `appSettled` beside `appSwitched`, in the `new DaemonCableHost({ … })` literal; three functions beside `followPrompt`, and one line in it; `port.observed`'s `session-end` line; the listener registration)
- Test: `cli/src/services/devices.spec.ts` (`fakeListener` gains `attach(sessionId)`; a `describe` of its own after the prompt's; the listener's wiring test)

**Interfaces:**
- Consumes: `attachHandler` (Task 3); `CableHostWiring.appSettled` (Task 4); `cableHost.settledApp()`, `cable.followPrompt`, `outside`, `monotonic`, `part.call` (the base).
- Produces:
  - `const ATTACH_ECHO_MS = 2_000`.
  - The listener registration: `{ front: …, attach: attachHandler((sessionId) => part.call('dial', () => claudeAttached(sessionId))) }`.
  - `appSettled: (app) => { if (app === 'claude') part.call('dial', claudeSettled) }`.
  - `claudeShow: (agentId, session) => …`: notes the dial's own link to `agentId` at `monotonic()`, as the link starts, then `opener.claudeShow(agentId, session)`. Each note drops the links older than `ATTACH_ECHO_MS`.
  - `let claudeAgent: string | undefined`: the kept agent.
  - `const dialLinks = new Map<string, number>()` and `linkedByDial(agentId?: string): boolean`: whether the dial's own link to that agent, or to any agent when none is named, is younger than `ATTACH_ECHO_MS`. It compares each time kept: a link older than that may still be in the map.
  - `let followedFor: 'prompt' | 'attach' | 'settle' = 'prompt'`: what the dials were last asked to follow for. `followPrompt` sets `'prompt'` before its `cable.followPrompt`. A dial answers only for its latest ask (`cableSession.ts`, `promptGeneration`), so `promptFollowed` counts its answer under this: the prompt's two lines as today; `'attach'`: `[device] attach · moved`, `[device] attach · skipped · no tile`; `'settle'`: `[device] settle · moved`, `[device] attach · skipped · no tile`.
- Rules of `claudeAttached(sessionId)`, in this order:
  1. `agentId = observedAgentId('claude', sessionId)`. Listed with app `claude` (`outside(agentId)?.app === 'claude'`): `claudeAgent = agentId`, whatever follows.
  2. No dial linked (`!cable.isConnected`): nothing more, nothing counted.
  3. Not such an agent: `[device] attach · skipped · unknown agent`. The kept agent stays as it was.
  4. `linkedByDial(agentId)`: `[device] attach · skipped · echo`.
  5. `cableHost.settledApp() !== 'claude'`: `[device] attach · skipped · not in front`.
  6. Else `followedFor = 'attach'`, and `cable.followPrompt(agentId)` is returned.
- Rules of `claudeSettled()`, in this order:
  1. No kept agent, or no dial linked: nothing.
  2. The kept agent is no longer listed with app `claude`: it is forgotten, nothing more.
  3. `linkedByDial()`, any link of the dial's, to the kept agent or to another: `[device] attach · skipped · echo`. The kept agent stays. Why any: a swipe that rests on another agent as the app comes in front shows that one, and its attach, a moment later, is skipped as its own echo.
  4. Else `followedFor = 'settle'`, and `cable.followPrompt(claudeAgent)` is returned.
- `port.observed`: a `session-end` of the kept agent's session clears `claudeAgent`.
- Not here: "the echo of the move starts no swipe rest" is `cableSession.spec.ts`'s `the move's echo starts no Orca switch`, which holds for every `followPrompt` (#4311's, unchanged).

- [ ] **Step 1: Write the failing tests** (a dial attached, no window; fake timers; `now` scripted for the 2 s; a Claude app session `SESSION`, a UUID, listed by `port.observed(hook('session-start'))` with the Claude app's bundle id and a `local_…` id; `attach(id)` is the listener's handler, as the mod posts; the front through the listener and `FRONT_SETTLE_MS`; macOS deps where a link runs):
  - `the devices open their listener once, with front and attach` (in place of `…with a front handler of 10 a second and 64 bytes`: `Object.keys(handlers)` is `['front', 'attach']`; `front`'s limits as before; `attach` is 96 bytes and 10 a second; a body that is no UUID is `REFUSED`).
  - `an attach of a listed Claude app agent, with the app settled in front, asks the dials to follow it` (`calls('followPrompt')` is `[[ID]]`; no attach line yet).
  - `a dial's answer is counted under what it was last asked for`: after an attach, `promptFollowed('moved')` and `('no-tile')` are `[device] attach · moved` and `[device] attach · skipped · no tile`; after a settle, `[device] settle · moved` and `[device] attach · skipped · no tile`; after a prompt, the prompt's two lines again.
  - `another app in front, none, a front not yet settled and no front known: not in front` (one line each, nothing asked).
  - `a session the devices do not list, and one listed in another app: unknown agent`, and the kept agent is still the earlier one (the next settle asks for it).
  - `within 2 s of the dial's own link an attach of that agent is its echo, and after 2 s it is followed`: a rest on `ID` runs the link; an attach 1 999 ms later is `skipped · echo`; one at 2 000 ms asks the dials.
  - `the echo is that agent's alone`: after a link to `ID`, an attach of a second Claude app agent asks the dials at once.
  - `the app settling in front moves the dial to the last attached agent`: Orca settled, two attaches (`A`, then `B`): two `not in front` lines; `claude` settles: `[[B]]` is asked; the dial's `moved` is `[device] settle · moved`.
  - `an attach skipped as the echo is still the session the app shows`: kept `A`; a link to `B` and `B`'s attach (`echo`); 2 s later away to Orca and back: the settle asks for `B`.
  - `a settle within 2 s of any link of the dial's moves nothing`: kept `A`, Orca settled; `claude` reported in front; a rest on `B` runs its link; the app settles 1 999 ms after that link: `[device] attach · skipped · echo`, nothing asked, and the kept agent is still `A`. The same with the link to `A` itself.
  - `a settle 2 s after the dial's last link moves the dial`: the same link, the app settling 2 000 ms after it: `[[A]]` is asked. With two links, 2 500 ms and 1 000 ms old: skipped, the younger counts.
  - `the app shows what the swipe chose`: kept `A`; the app settles 1 000 ms after the link to `B` (skipped), and `B`'s attach comes 500 ms later: `skipped · echo`, and the kept agent is `B` (away and back after 2 s: the settle asks for `B`).
  - `a session's end clears it`; `a kept agent resumed in another app is forgotten at the settle`: nothing asked, nothing counted.
  - `a Cmd-Tab across the app moves nothing`: with an agent kept, `claude` then `orca` inside a second; Orca settles and nothing is asked.
  - `with no dial linked nothing is asked or counted, and the attach is still kept` (linked again, the next settle asks for it).
  - `an attach or a settle whose follow throws is logged and the devices keep running`.
  - `no attach line names a session, an agent or an app`: every `[device] attach` line is exactly one of the six; no log line holds `SESSION`, the agent's id, the `local_…` id or the bundle id.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL (the listener is handed no `attach`).
- [ ] **Step 3: Implement.** The comment on `followedFor` says why a dial's answer can be counted by the latest ask, and that it goes once `followLocal` carries the cause.
- [ ] **Step 4: Run** `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`; the prompt's tests pass unchanged.
- [ ] **Step 5: Commit** `devices: the session the Claude app shows turns the dial, at its attach or once the app settles in front`.

### Task 8: End to end: an attach moves the dial

**Layer:** test. **Depends on:** Task 2 (the launcher's `devicesSocket`), Task 7. **Effort:** `high`. **Red test:** none: no behavior (it adds end-to-end tests of what Tasks 2, 3, 4 and 7 built).

**Files:**
- Create: `cli/e2e/dialClaudeAppFollow.e2e.ts`

**Interfaces:**
- Consumes: `IsolatedDaemon`, `until`, `CLI_ROOT`, `Desk`, `FakeDial`, `InOrca` (`e2e/harness/`), as `dialPaneFollow.e2e.ts` uses them; `fetchOverSocket` (`src/lib/localTransport.ts`). No fake `orca` and no fake backend: nothing here turns the dial by hand, taps or speaks.
- The fake front app: a line on the stdin of the real `harness hardware watch --json`, `{"front":"<bundle id>"}`; a second line on the same pipe is the next app in front.
- The fake mod, as the mod does it: the real `harness device claude link --json` under the daemon's environment (the plugin's entry written into the throwaway home's Claude Code settings first, as `InOrca.asked` writes it), then one `POST /` of `{"type":"attach","sessionId":…}` on the `devicesSocket` it printed. Its answer is 204.
- Sessions: the Claude app's carry `{ __CFBundleIdentifier: 'com.anthropic.claudefordesktop', ORCA_AGENT_SESSION_ID: '' }` and **never** `CLAUDE_CODE_HOST_SESSION_ID`; Orca's carry Orca's bundle id and a handle of their own.
- Orca holds more agents than the Claude app until the Claude app settles, so the dial's switch to the Claude app's ring (`apps` with `shown: 'claude'`) is the settle: nothing waits a fixed second.
- The attach lines are read whole, each from its `[device]` on (`[device] attach · moved` is the start of `[device] settle · moved`).

- [ ] **Step 1: Write the tests** (no window; a daemon of its own for each case; a dial that greets with `appFilter: 'v1'`):
  - `link names the devices' socket, and an attach with the Claude app in front moves the dial`: two sessions in Orca and `C1` in the Claude app listed; the watch written the Claude app's bundle id; the dial hears the Claude app's ring; `C2` started and listed. `C1`'s attach: the dial hears `{ t: 'focus', agentId: C1.id }`. `C2`'s attach: `{ t: 'focus', agentId: C2.id }`. Then the attach of a session the devices do not list (a fresh UUID): 204, and no `focus` since `C2`'s. The attach lines are `[device] attach · moved` twice, then `[device] attach · skipped · unknown agent`.
  - `with Orca in front an attach does not move the dial, and the Claude app settling in front does`: the watch written Orca's bundle id; `C1`'s attach: its line is `[device] attach · skipped · not in front`, and no `focus` for `C1`. The same watch written the Claude app's: the dial hears the Claude app's ring and then `{ t: 'focus', agentId: C1.id }`, the one focus for `C1`; the lines end with `[device] settle · moved`.
  - `the daemon's log has no session id and no bundle id, and no swipe line` (no rest started: nothing could reach `open`).
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialClaudeAppFollow.e2e.ts e2e/dialPaneFollow.e2e.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `e2e: the session the Claude app shows moves the dial, at once in front and at the settle from behind`.

### Task 9: Say it in the docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`. **Red test:** none: no behavior.

**Files:**
- Modify: `cli/AGENTS.md` (the devices row of the processes table: the dial follows the session the Claude app shows, and a swipe shows a session in the Claude app while it is in front), `cli/src/services/AGENTS.md` (the devices bullet: the mod's `attach` is the listener's second message, beside `front`), `plugins/harness-device/README.md` ("What it does": the mod tells the daemon which session the Claude app shows, and the dial turns to it; "What it never does" stays true: the mod sends only the session's id)

- [ ] **Step 1:** Write the three changes, in the files' own words and length.
- [ ] **Step 2:** Check every link resolves, and run `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: the dial follows the session the Claude app shows, and a swipe shows one`.

---

## Decided here, where the spec was silent

- The measures' words are the six `[device] attach` lines of Global Constraints; the swipe's link is counted by #4311's `[device] swipe` lines.
- `cable.followPrompt` keeps its signature (the coordination), so a dial's answer is counted under what the devices last asked for (`followedFor`). A dial answers only for its latest ask, so the count cannot name the wrong cause.
- With no dial linked an attach is kept, and neither followed nor counted.
- An attach of a session the devices do not list, or list in another app, is `unknown agent` and leaves the kept agent as it was.
- Every attach of a listed Claude app agent replaces the kept one, also one skipped as the echo or as not in front.
- The kept agent goes at its session's `session-end`. One the source no longer lists as a Claude app agent (its process gone with no end, or resumed in another app) is forgotten when the app settles.
- The echo is noted as the link starts, since an attach can come before `open` exits, on the devices' monotonic clock. A link that turns out busy or fails notes it too: the dial is on that agent either way. An attach 1 999 ms after the link is the echo; one at 2 000 ms is followed.
- The swipe's link has a set of its own beside the tap's `running`: a tap is not refused while a rest's link runs (#4311's "no false busy"), and two opens of one link do no harm.
- A swipe's link that fails brings no app forward: no `open -b` after it, and no line but its count.
- macOS, for the swipe, is the tap's own rule: `canOpen` of a Claude pane.
- `attach` checks the UUID's form, hex in either case. Other keys in a body within 96 bytes are not read.
- `settled(app)` is told at every settle, `none` and the same app again included; the devices act on `claude` alone.
- The mod keeps its state in `register`, not in the module. A desktop detach drops an attach still held, and sends nothing. The mod reads the plugin's setting before each send, as before it submits a prompt (the README: "the hook and the mod check Claude Code's settings before they act"). Its address is `http://harness/`, as the listener takes `POST /` alone.
- The 400 ms rest and "three turns in 400 ms run one, for the last" stay `cableSession.spec.ts`'s tests, which hold for any agent whose `swipeSwitches` is true; this plan tests that a Claude app agent is one.
- The end-to-end fake mod asks the real launcher for the socket, so `link`'s check runs against the socket the real devices process made.
- A new end-to-end file, not more cases in `dialPaneFollow.e2e.ts`: the other branch writes that one.

### The PM's answers to this plan's three questions (2026-11-15)

1. **A session whose mod linked while the devices' listener was not there** (no dial attached yet, the daemon restarting). The mod asks the launcher again when it holds a desktop attach and its last answer had no `devicesSocket`: at most once in 30 s for a session, the run killed after 5 s, any failure silent. That attach is then not sent, and the next attach after the 30 s may ask again. Task 1 alone; no file and no dependency changed.
   - Decided here, within that answer: the 30 s is between two such asks, so the first attach after a link with no `devicesSocket` asks at once. A session's own time: a reload of the mod starts it over. Only the launcher that linked is run, so one ask is one process and at most 5 s. An attach that found no socket stays held: a detach drops it, and an answer or a next link sends it.
2. **The app settling in front while the dial's own link is on its way.** Accepted: a settle of the Claude app in front moves nothing while any continue link of the dial's is younger than 2 s, counted as `[device] attach · skipped · echo`. Task 7's `claudeSettled` rule 3 and its tests; no file and no dependency changed.
3. **The plugin on Diego's Mac for the on-dial check.** Accepted, with a change: the PM, not Diego, points the `openharness` marketplace at the final combined worktree when preparing Diego's dial session, and points it back at GitHub before that worktree is removed. Check 3's steps, before and after.

## Verification

**Local gates**, recorded in the pull request (PR CI does not run them):
- `cd cli && npm run typecheck && npm run test:core`: 100% per file for `services/devices.ts` and `services/devicesListener.ts`.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit; its receipts go in the pull request.
- The plugin's own checker and test runner: check 2 below. No CI job runs them.
- Not needed: `npm run test:harnessd`, the serial specs, `make device-test` (nothing of theirs changes). PR CI runs `cli-typecheck`, `cli-tests` and every suite that reads a changed file.

**Platforms the pull request names:** the daemon, CLI and plugin on macOS (tested; on a dial by Diego) and on Linux (unit and end-to-end tests of the attach path; no Claude app there, so a rest runs no link). Windows: no listener and no link, nothing changes.

**The pull request also says,** in these words or closer to its own:
- The swipe's continue link is covered by unit tests only: it runs `/usr/bin/open`, which no end-to-end test may reach on a real Mac (decision 7).
- Nothing under `cli/src/core` changes: the attach goes from the mod to the devices' own listener (rule 7).
- The continue link is undocumented and may change with any Claude app release: a link that opens nothing moves nothing, and the attach path works without it.

**Temporary workflow:** none. The one long check runs in the repo's own **CLI end to end** workflow, and the new file joins that suite's nightly run as every file in `cli/e2e` does.

**Turns.** The tester asks the orchestrator for a runner turn before the one hand-started run on GitHub (check 1), and starts nothing until it is granted. The dial is Diego's own: check 3 is not a tester step. The PM prepares it and puts the Mac back; Diego's hand does the four steps.

**1. The real daemon, a fake dial, a fake front app, a fake mod**
- Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialClaudeAppFollow.e2e.ts e2e/dialPaneFollow.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/dialAppFilter.e2e.ts e2e/devicesProcess.e2e.ts e2e/hardwareWatch.e2e.ts`, on a Mac or a Linux box, at the final head.
- Isolation: the suite's own (`e2e/harness/daemon.ts`): a throwaway home and data folder, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal, no backend and no sign-in but `dialPaneFollow.e2e.ts`'s fake one. The front app is a line on the real watch's stdin; the mod is the real launcher's `link` and one post on the throwaway daemon's own `devices.sock`. No session carries `CLAUDE_CODE_HOST_SESSION_ID` and nothing taps, so nothing runs `/usr/bin/open`. The real Claude app, the real plugin, the everyday daemon (18473) and production are not touched.
- A person sees: every test passes. The daemon's log has `[device] attach · moved`, `[device] settle · moved`, `[device] attach · skipped · not in front` and `[device] attach · skipped · unknown agent` lines, with nothing else in them, and no `[device] swipe` line from the new file.
- On GitHub, by hand, once on the final head, after a runner turn: Actions → CLI end to end → Run workflow, branch `feat/dial-claude-app-follow` (`.github/workflows/cli-e2e.yml`). Every shard passes.

**2. The plugin, in Claude Code's own checker and test runner**
- Run on a Mac with Claude Code 2.1.325 or later: `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin validate plugins/harness-device`, then `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin test plugins/harness-device`.
- Isolation: a throwaway config folder; no daemon, no backend, no login, no Claude app.
- A person sees: the validation passes with three hooks (`session.start`, `session.attach`, `session.detach`); every test passes.
- On GitHub: none, and no CI job is added (#4296's answer 4). Both results go in the pull request.

**3. On a dial: the app moves the dial, a swipe moves the app** (the spec's "On a dial" 1 to 4). **Diego's check, on his return.**
- Who: Diego, for the four steps. They need his hand on the dial and on the Claude app's sidebar, so no tester runs them, and nobody reports them as passed for him. The PM prepares his dial session (**Before the check**) and puts the Mac back (**After the check**). Nothing below starts before the orchestrator's go.
- When: after every task and the final review, on the final head.
- Where: Diego's Mac, his round dial on the firmware it has (none is flashed), the real Claude app and Claude Code, the everyday daemon. The Harness window closed, so the dial lists this computer's agents.
- Why not an isolated daemon: the Claude app's sessions run the real `~/.claude` plugin and hooks, which reach only the daemon that installed them. These steps call no backend: every frame stays between the mod, the daemon, `open`, the Claude app and the dial on this Mac.
- **Nobody speaks to the dial in this check:** a spoken word would ask production for its transcript.
- **Before the check**, in this order:
  1. Before anything changes, save `harness version`, `claude plugin marketplace list --json` and `claude plugin list --json`.
  2. Build: `make install-cli` in the final combined worktree, at the final head (a local install; nothing is published).
  3. **The PM, not Diego, points the `openharness` marketplace at the final combined worktree** (the PM's answer 3; the released plugin sends no attach): `harness device claude disable`, `claude plugin marketplace remove openharness`, `claude plugin marketplace add <the final combined worktree>`, `harness device claude enable`. `harness device claude status --json` says `installed` and `enabled`. From here until **After the check** step 1, that worktree is not removed (a worktree removed under such a marketplace broke the plugin on 2026-11-15).
  4. The front app: the Harness Device app built from this stack, the only source of the app in front. `(cd device-app/ui && npm ci && npm run build) && (cd device-app/src-tauri && cargo build --locked)`, then `target/debug/harness-device`, with the released Harness Device app quit.
  5. With the dial attached, `harness device claude link --json` prints a `devicesSocket`. Then quit and reopen the Claude app: a session started before step 3 still runs the released mod, which sends no attach.
- Diego does and sees:
  1. Two Claude Code sessions in the Claude app, the app in front: clicking either in the sidebar moves the dial to it.
  2. Swiping between them on the dial switches the app's session each time the dial rests.
  3. With Orca in front, swiping on the Claude page of the dial does not bring the app forward.
  4. With Orca in front, clicking a session in the Claude app's sidebar moves the dial to it once the app has settled, about a second.
- Evidence: the daemon log's `[device] attach · moved`, `[device] settle · moved` and `[device] swipe · ok` lines, and a photo of the dial for steps 1 and 4.
- Not asked of Diego: the mod asking the launcher again (the PM's answer 1). Step 5 above has the listener open before the app's sessions start, so every mod links with a `devicesSocket`; check 2's tests cover the ask.
- **After the check**, in this order:
  1. **The PM points the `openharness` marketplace back at GitHub, before the final combined worktree is removed** (the marketplace points into it): `harness device claude disable`; `claude plugin marketplace remove openharness`; `claude plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins`; `harness device claude enable` if the saved list had the plugin on. `claude plugin marketplace list --json` shows `openharness` from GitHub, and `claude plugin list --json` reads as saved. Only then may that worktree be removed.
  2. Quit the debug Harness Device app and start the released one if it ran before.
  3. Put the release CLI back with the public installer (`curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash`); `harness version` reads as saved, with no `-dev.`.
  4. Tell the orchestrator the dial is free.
- Not done, for whatever reason: report it as not verified, never as passed.
- On GitHub: none. It needs a real dial and the Claude app.
