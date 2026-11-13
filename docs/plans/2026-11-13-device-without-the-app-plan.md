# The Harness device without the app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With the desktop app closed, the round dial lists this computer's agents — Harness agents and agents running in any other app or terminal — with live status and the last answer.

**Architecture:**
- The hook stops dropping paneless sessions and posts them to a new core route. The core checks and bounds each event, then forwards it to the devices process and keeps nothing.
- In the devices process, a `HostRegistry` merges a `HarnessSource` (this machine's Harness agents) and an `ObservedSource` (paneless agents). It selects and orders at most 10 for the dial, and adds optional `host` / `caps` / `view` fields to the existing agent frames.
- The round firmware reads those fields and holds back the actions an agent cannot take.

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`), the hook script `cli/hook/notify.mjs`, ESP-IDF 5.5.4 C firmware with Python host tests.

**Spec:** `docs/specs/2026-11-13-device-without-the-app.md`.

## Global Constraints

- **Where the logic goes.** The core keeps no observed state. The route's logic lives in `cli/src/core/`, which is inside the `npm run test:core` 100% gate; `hookServer.ts` and `src/cable/**` are outside it. Third-party hints and transcripts are parsed only in the devices process (`cli/AGENTS.md`, "Protect the core").
- **Core file list.** Every new file the core's process loads gets a sorted line in `cli/src/architecture.coreFiles.txt`. The PR says why every session needs it.
- **The route's limits:**
  - `/api/hook/observed` accepts a body of at most 4 KB, read with `readBody(req, 4096)`.
  - `engine` must be in `ENGINES`; `callerPid` is a positive safe integer.
  - String bounds: `sessionId` ≤ 128, `cwd` ≤ 1024, `transcriptPath` ≤ 1024.
  - At most 8 hint keys, each value at most 64 characters.
  - At most 20 events per second per session; the rest are dropped.
- **Events:** `session-start`, `turn-start`, `needs-input`, `turn-stop`, `turn-error`, `session-end`.
- **Host-hint allowlist, exact names only, never by prefix:** `TERM_PROGRAM`, `__CFBundleIdentifier`, `HERDR_PANE_ID`, `REX_BLOCK`, `ZELLIJ`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, `ORCA_AGENT_SESSION_ID`, `ORCA_APP_VERSION`. Orca also sets `ORCA_PAIRING_CODE` and `ORCA_AGENT_SESSION_SPAWN_TOKEN` in the same environment, and they must never leave the hook.
- **Dial list:**
  - At most 10 rows; `total` = every agent on this computer.
  - Changes are coalesced for 1 s, and pushes are at least 1 s apart.
  - Order: needs-you, working, done-and-unseen, then the rest by last activity, most recent first within each group.
- **`ObservedSource`:**
  - Removal: pid check every 30 s, generation-checked with `externalProcessGeneration`. No pid and no event for 12 h → removed. `session-end` → removed after 10 s.
  - Bound: at most 50 sessions; when full, evict the oldest idle one.
  - Last answer: the last 256 KB of the transcript, a 1 s deadline, paths only under `claudeProjectsRoots` / `codexHomeRoots` + `sessions`. Claude Code and Codex only.
  - Codex end of turn: `OpenSessions.working(sessionId)` every 3 s while the session is working.
  - Open-session scan on dial attach, then every 60 s while a dial is attached.
  - Agent id: a name-based UUID of `engine + sessionId` (36 characters, fits firmware `ID_MAX` 48).
- **Wire:**
  - `agent.host`: `harness|orca|herdr|rex|zellij|kitty|wezterm|ghostty|iterm|terminal-app|vscode|cursor|warp|terminal`.
  - `agent.caps`: letters `s` status, `v` voice, `f` focus, `a` answer. A Harness agent with no window is `sva`; an observed agent is `s`; firmware treats an absent value as `svfa`.
  - `agents.end.view`: `machine` with no window, absent with one.
  - `tab` stays `''` with no window.
- **Refusals:**
  - Voice without `v`: no audio kept; on `voice.end`, `voice.error` "This agent is in {Host}. Talking to it from the device comes in an update."
  - Answer without `a`: `toast`.
  - Focus without `f`: ignored without a toast. The dial sends `focus` on every swipe, so a toast there would fire on each turn of the carousel. It only marks a done agent seen.
- **Kill switch:** `HARNESS_DEVICE_OBSERVED=off`. The per-person setting is wave 1.
- **Privacy:** nothing observed leaves this computer: not to the backend, the phone or another machine.
- **Unchanged:** with a window, the dial holds the active tab as today; a session in a pane follows today's hook paths.
- **Repo rules:** tests never touch the developer's real `~/.claude`, `~/.codex`, daemon (port 18473) or tmux. Firmware dev builds use `-DPROJECT_VER=0.1.0-dev`. Flash only by the repo procedure (quit Harness, flag file, `harness stop`, chip check). Never edit `devices/harness-pro`.

## Review Focus

1. **A pid reused after the engine exits.** The session must disappear, not linger as idle under a new process. Covered in Task 4 (`removes a session whose pid generation changed`).
2. **A Claude Code session that moves into tmux later** (resumed inside a Harness pane). It must show once, as the Harness agent. Covered in Task 3 (`harness wins over observed for the same engine+sessionId`).
3. **A hook flood** from parallel tool calls or a stuck engine repeating Stop. The rate limit must hold the core and the dial steady. Covered in Task 1 (`drops the 21st event within a second for one session, keeps another session's`).
4. **A forged transcript path** (a symlink or `..` out of the engine's folder). It must not be read. Covered in Task 4 (`refuses a transcript path that resolves outside the engine roots`).
5. **The app window opening and closing quickly.** The dial must switch between tab and machine lists without a push storm. Covered in Task 5 (`window flip coalesces to one push per second`).

---

### Task 1: Core route `/api/hook/observed` and the forward to the devices process

**Files:**
- Create: `cli/src/core/observedHook.ts`, `cli/src/core/observedHook.spec.ts`
- Modify:
  - `cli/src/hookServer.ts` — `HookServerHandlers` (:69); a new route block beside `turn-stop` (:958)
  - `cli/src/core/api.ts` — `DevicesPort` (:1625), `DEVICES_FALLBACKS` (:1675)
  - `cli/src/core/devicesLink.ts` — the port (:69-93)
  - `cli/src/core/main.ts` — the `startHookServer` wiring (:2262-2305)
  - `cli/src/architecture.coreFiles.txt` — add `core/observedHook.ts`, sorted
- Test: `cli/src/core/observedHook.spec.ts`; the route table in `cli/src/hookServer.spec.ts` (:304-307)

**Interfaces:**
- Produces:
  - `type ObservedEventName = 'session-start'|'turn-start'|'needs-input'|'turn-stop'|'turn-error'|'session-end'`
  - `interface ObservedHookEvent { engine: AgentEngine; sessionId: string; event: ObservedEventName; cwd?: string; callerPid: number; transcriptPath?: string; hostHints: Record<string,string>; at: number }`
  - `parseObservedHook(body: unknown, now: number): ObservedHookEvent | null`
  - `createObservedHook(deps: { forward: (e: ObservedHookEvent) => boolean; now: () => number }): { onObserved(body: unknown): 'ok'|'invalid'|'dropped' }`. It holds a per-session 20/s token bucket.
  - `DevicesPort.observed?(event: ObservedHookEvent): void` — fallback `undefined`. `devicesLink` sends `event('observed', event)`; a closed link drops it.
  - `HookServerHandlers.onObserved?(body: unknown): 'ok'|'invalid'|'dropped'` → 200 / 400 / 200.

- [ ] **Step 1: Write the failing tests** in `observedHook.spec.ts`:
  - `parses a full event` with all fields.
  - `rejects an unknown engine`, `a missing sessionId`, `callerPid 0 or 1.5`, `sessionId of 129 chars`, `cwd of 1025 chars`.
  - `rejects 9 hint keys and a 65-char hint value`.
  - `rejects a control character in cwd`.
  - `drops the 21st event within a second for one session, keeps another session's`.
  - `forward false (devices down) is 'dropped', not an error`.
  - `keeps nothing: a second instance after forward has no memory of the first except the bucket`.

  In `hookServer.spec.ts`:
  - Add a row `/api/hook/observed` → `onObserved` to the route table.
  - `answers 400 to a 4097-byte body`.
  - `answers 401 without the hook token`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/observedHook.spec.ts src/hookServer.spec.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - `observedHook.ts`: use `optionalBoundedString` semantics (copy the rule: it rejects control characters) and `ENGINES`.
  - The route block: `if (!hookOk) 401`; `readBody(req, 4096)`; `JSON.parse` in a try; `handlers.onObserved`.
  - Add `observed` to `DevicesPort`, its fallback and `devicesLink`.
  - Wire it in `main.ts`, and add the coreFiles line.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core && npx vitest run src/architecture.spec.ts`. Expected: PASS, 100% for `core/observedHook.ts` and `core/devicesLink.ts`.
- [ ] **Step 5: Commit** `core: /api/hook/observed checks, bounds and forwards a paneless session's hook event to the devices`.

### Task 2: The hook posts paneless sessions; Claude Code gains `Notification`

**Files:**
- Modify:
  - `cli/hook/notify.mjs` — `main()` (:1791-2116); a new `postObserved` beside `post` (:388); a new `observedHostHints()`
  - `cli/src/engines/claude/hookContract.ts` (:19)
- Test: `cli/src/hookNotify.spec.ts` (`runHook` :121); the Claude hook contract's spec

**Interfaces:**
- Consumes: the Task 1 route and body shape.
- Produces:
  - Paneless sessions post `{engine, sessionId, event, cwd, callerPid: process.ppid, transcriptPath, hostHints}`.
  - Event mapping: SessionStart → `session-start`; UserPromptSubmit / turn-start-like → `turn-start`; Stop → `turn-stop`; StopFailure / error status → `turn-error`; SessionEnd → `session-end`; Claude `Notification` → `needs-input`.
  - The same mapping covers Copilot, Antigravity, Grok, Cursor, Command Code and Devin, using the event names `main()` already distinguishes.

- [ ] **Step 1: Write the failing tests** (`runHook` with no `tmuxPane`, `HARNESS_PANE` unset):
  - `paneless claude Stop posts turn-stop to /api/hook/observed with callerPid and transcriptPath`.
  - `paneless claude Notification posts needs-input`.
  - `claude Notification inside a tmux pane posts nothing` (today's behaviour).
  - `paneless codex subagent posts nothing` and `paneless cursor background agent posts nothing` (the guards run first).
  - `hostHints carries only the allowlist: ORCA_PAIRING_CODE and ORCA_AGENT_SESSION_SPAWN_TOKEN set in the env are absent from the body`.
  - `a hint value of 200 chars is cut to 64`.
  - `the hook exits within 300 ms when the daemon never answers` (a listener that accepts and never responds).
  - `paneless never calls fallbackRegister or routeToPaneOwner` (no registry writes in the temp data dir).

  Contract spec: `claude hook contract includes Notification`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/hookNotify.spec.ts src/engines/claude`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Move the pane check below the engine guards. When there is no pane, map the event, call `postObserved`, and return.
  - `postObserved` writes the request and resolves on the request's `finish`, or after 150 ms, never waiting for a response. It uses `hookRoute(port)` and its token.
  - In a pane, `Notification` returns before any post.
  - Add `Notification` to the Claude contract.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS. Then `cd cli && npm test -- --run src/hook src/engines/claude`. Expected: no regressions.
- [ ] **Step 5: Commit** `hook: a session outside a pane posts its events to the devices, and Claude Code says when it waits for the person`.

### Task 3: `HostSource` types, `HostRegistry`, dedupe and the selection

**Files:**
- Create:
  - `cli/src/cable/hosts/types.ts`
  - `cli/src/cable/hosts/registry.ts`
  - `cli/src/cable/hosts/select.ts`
  - `cli/src/cable/hosts/registry.spec.ts`
  - `cli/src/cable/hosts/select.spec.ts`

**Interfaces:**
- Produces:
  - `HostSource`, `HostAgent`, `Caps` exactly as in the spec's "HostSource" section. `Caps = { status: boolean; voice: boolean; focus: boolean; answer: boolean }`. `capsLetters(c: Caps): string` returns the letters in the order `svfa`.
  - `class HostRegistry { constructor(sources: HostSource[]); agents(): HostAgent[] /* deduped */; onChange(cb): () => void; source(agentId): HostSource | undefined }`
  - Source strength: `harness` > host adapters > `observed`.
  - `selectForDial(agents: HostAgent[], max = 10): { rows: HostAgent[]; total: number }`

- [ ] **Step 1: Write the failing tests:**
  - `harness wins over observed for the same engine+sessionId`.
  - `dedupes by callerPid when sessionId is missing`.
  - `orders needs-you, working, unseen done, then by lastActivityAt desc`.
  - `ties inside a group go most recent first`.
  - `returns at most 10 rows and total of all`.
  - `capsLetters({status,voice,answer}) === 'sva'`.
  - `onChange fires once per source change`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified. These are pure functions over the sources' lists.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `devices: host sources, their dedupe, and the dial's choice of ten`.

### Task 4: `ObservedSource`

**Files:**
- Create:
  - `cli/src/cable/hosts/observed.ts`
  - `cli/src/cable/hosts/hostDetect.ts`
  - `cli/src/cable/hosts/lastAnswer.ts`
  - `cli/src/cable/hosts/observed.spec.ts`
  - `cli/src/cable/hosts/hostDetect.spec.ts`
  - `cli/src/cable/hosts/lastAnswer.spec.ts`

**Interfaces:**
- Consumes: `ObservedHookEvent` (Task 1), `HostSource` / `HostAgent` (Task 3).
- Produces:
  - `class ObservedSource implements HostSource` with `id = 'observed'`. Constructor: `(deps: { now(): number; pidGeneration(pid): string|null; openSessions: Pick<OpenSessions,'known'|'working'|'owner'>; externalSessions: { scan(): Promise<void>; get(id): {cwd?: string; transcriptPath?: string} | undefined }; lastAnswer(engine, path): Promise<string|undefined>; log(line): void })`.
  - Methods: `ingest(e: ObservedHookEvent): void`, `scanOpen(): Promise<void>`, `tick(): void`, `markSeen(agentId): void`.
  - `capabilities()` always returns `{status: true, voice: false, focus: false, answer: false}`.
  - `observedAgentId(engine, sessionId): string`: a name-based UUID (SHA-1, RFC 4122 v5 layout, a fixed namespace constant).
  - `detectHost(hints: Record<string,string>): string`: herdr, rex, zellij, kitty, wezterm, orca (also `__CFBundleIdentifier` `com.stablyai.orca`), then `TERM_PROGRAM` / bundle → `iterm` / `terminal-app` / `ghostty` / `vscode` / `cursor` / `warp`, else `terminal`.
  - `readLastAnswer(engine: 'claude'|'codex', path: string, opts: { roots: string[]; maxBytes: 262144; deadlineMs: 1000 }): Promise<string|undefined>`. It realpaths the file, refuses anything outside `roots`, reads with `tailFileCapped`, and parses with `lastTurnTextFromRawLines` / `lastCodexTurnText`.

- [ ] **Step 1: Write the failing tests:**
  - Each event drives the state of the spec's table, and `since` resets on `turn-start`.
  - `session-end removes after 10 s`.
  - `removes a session whose pid is gone` and `removes a session whose pid generation changed`.
  - `removes a pidless session after 12 h without an event`.
  - `holds at most 50, evicting the oldest idle`.
  - `turn-stop for claude sets lastAnswer and unseenDone`.
  - `codex working → done when openSessions.working turns false (3 s check)`.
  - `scanOpen adds terminal/app sessions as idle and skips 'harness'-owned ones`.
  - `observedAgentId is stable and 36 chars`.
  - `detectHost` for every allowlisted hint, plus `unknown → terminal`.
  - `refuses a transcript path that resolves outside the engine roots`, including a symlink.
  - `gives up after the 1 s deadline` and `reads at most 256 KB from the end`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/cable/hosts/hostDetect.spec.ts src/cable/hosts/lastAnswer.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `Promise.race` with a timer for the deadline. Timers come from the deps' `now` plus a scheduled `tick` driven by the owner (Task 7), not a timer of its own.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `devices: agents outside a pane, from their hooks and the open sessions, with their last answer`.

### Task 5: The machine list on the dial

**Files:**
- Create: `cli/src/cable/hosts/harness.ts` (`HarnessSource`)
- Modify:
  - `cli/src/cable/cableHost.ts` — `listAgentSnapshot` (:612), its doc comment (:592-607)
  - `cli/src/cable/cableSession.ts`
    - `agentsKey` (:2579), so it includes `host` and `caps`
    - `syncAgentsNow` (:2627-2662): the `agent` rows gain `host` and `caps`; `agents.end` gains `view`
    - push pacing
  - The `CableAgent` type (`cableSession.ts:269`): optional `host?: string; caps?: string`
- Test: `cli/src/cable/cableHost.spec.ts`, `cli/src/cable/cableSession.spec.ts`, `cli/src/cable/hosts/harness.spec.ts`

**Interfaces:**
- Consumes: `HostRegistry`, `selectForDial` (Task 3).
- Produces:
  - `HarnessSource`: local agents from `listAgentsFlat()` filtered by `localId()`, with `lastActivityAt` from `activityTimes()`, states from the card events the host already sees, `host: 'harness'`, and caps `sva`.
  - `CableHost.setRegistry(r: HostRegistry | null)`.
  - `listAgentSnapshot()` returns `{agents, tab, total, view?: 'machine'}`. With `swarms === null` and a registry, the result is `selectForDial(registry.agents())` mapped to `CableAgent`, with `view: 'machine'`. With a window, today's result exactly.
  - Push pacing: a list change is coalesced for 1 s, and pushes are at least 1 s apart. Forced pushes (hello, `agents.list`, `agents.refresh`) stay immediate.

- [ ] **Step 1: Write the failing tests:**
  - `no window and a registry: sends the selected rows with host, caps and agents.end.view machine`.
  - `no window and no registry: sends [] as today`.
  - `with a window: identical frames to today` (snapshot the frames before the change).
  - `agentsKey changes when caps change`.
  - `window flip coalesces to one push per second`.
  - `hello still pushes at once`.
  - `HarnessSource lists only this machine's agents`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts src/cable/cableSession.spec.ts src/cable/hosts/harness.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update the doc comment above `listAgentSnapshot`: the "no window" answer is now the machine list when the devices have a registry.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `dial: with no window, this computer's agents, the ones that need the person first`.

### Task 6: Actions the dial cannot take

**Files:**
- Modify: `cli/src/cable/cableSession.ts`
  - `case 'voice.begin'` (:1713-1814): decide before `this.voice = {…}` (:1787)
  - `case 'voice.end'` (:1830)
  - `case 'focus'` (:1513)
  - `case 'answer'` (:1694)
- Modify: the host interface CableSession uses, adding `capsOf?(agentId): string | undefined`. `CableHost` answers from the registry; `undefined` means today's behaviour.
- Test: `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Consumes: `capsLetters`, registry `source(agentId)` (Tasks 3, 5).
- Produces:
  - `voice.begin` for an agent without `v` sets a pending refusal and keeps no PCM (`onPcm` sees no `this.voice`).
  - `voice.end` with a pending refusal sends `{t:'voice.error', message, uploadId}`, with `message` = "This agent is in {Host}. Talking to it from the device comes in an update." `{Host}` is the display name: Orca, herdr, Ghostty, iTerm2, VS Code, Terminal, …
  - `focus` without `f` is not forwarded, sends nothing, and calls `markSeen(agentId)`.
  - `answer` without `a` sends a `toast`.

- [ ] **Step 1: Write the failing tests:**
  - `voice to an observed agent keeps no audio and answers voice.error on voice.end`.
  - `no transcription request is made for it`.
  - `voice to a harness agent works as today`.
  - `focus without f sends no toast, does not call host.focus, and marks the agent seen`.
  - `answer without a toasts and does not call host.answer`.
  - `no capsOf (older host) behaves as today`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with the host display-name table beside `detectHost`'s ids.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `dial: say kindly what an agent outside Harness cannot do from the device yet`.

### Task 7: Wiring in the devices process

**Files:**
- Modify:
  - `cli/src/services/devicesProcess.ts` — the `heard` record (:225-260) gains `observed`
  - `cli/src/services/devices.ts` — `startDevices` (:91). Build the sources, the registry and `cable.setRegistry` beside `new DaemonCableHost` (:192). The `port.observed` and the inline `ports.devices` path (:640). Timers: `tick` every 30 s, the Codex check every 3 s, the scan every 60 s while a dial is attached, and the scan on `onDialAttached` (`cableSession.ts:1427`). The kill switch.
- Test: `cli/src/services/devices.spec.ts`, `cli/src/services/devicesProcess.spec.ts`. These are in the 100% gate.

**Interfaces:**
- Consumes: everything above. `OpenSessions` / `ExternalSessions` are built with `externalProviders()` as in `services/externalSessions.ts:18`.
- Produces:
  - `HARNESS_DEVICE_OBSERVED=off` → no `ObservedSource` (the registry holds only `HarnessSource`), and incoming `observed` events are ignored.
  - Each `ObservedSource` state change becomes a dial frame through `toDial` (`devices.ts:493`):

| Change | Frame |
|---|---|
| → working | `turn.started` |
| → needs-you | `turn.activity` with the text "Waiting for you · {Host}" |
| → done | `turn.done`, then `summary {text: lastAnswer}` (the dial's chime) |
| → error | `turn.error` |

  - Observed agents never reach the core, a window or the gateway: no `card`, `desk` or fleet frame carries them.

- [ ] **Step 1: Write the failing tests:**
  - `an observed event from the core reaches ObservedSource and the dial's list`.
  - `HARNESS_DEVICE_OBSERVED=off ignores observed events and lists only harness agents with no window`.
  - `scan runs on dial attach and every 60 s only while a dial is attached`.
  - `timers stop when the service stops`.
  - `inline (HARNESSD_SERVICES=none) wiring gets the same port`.
  - `observed turn-stop reaches the dial as turn.done and summary with the last answer`.
  - `observed needs-input reaches the dial as turn.activity Waiting for you · Orca`.
  - `an observed agent is never sent to the core, a window or the gateway` (spy on every outbound port).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts src/services/devicesProcess.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% per file.
- [ ] **Step 5: Commit** `devices: wire the host sources, their timers and the kill switch`.

### Task 8: Round firmware: `host`, `caps`, `view`

**Files:**
- Modify (paths under `devices/harness-device/firmware/main/`):
  - `cable_client.c`: `cable_agent_t` (:46-54) gains `host[16]` and `caps` (`uint8_t`, bits S/V/F/A); `handle_agent` (:1082); `handle_agents_end` (:1128) reads `view`.
  - `cable_client.h`: `project_t` (:36-49) gains the same two fields.
  - `app_main.c`: `refresh_projects` (:71-96) gains new setters.
  - `ui/ui_screens.h`: declares `ui_project_set_host_caps(id, host, caps)` and `ui_fleet_set_view(bool machine)`.
  - `ui/habitat/ui_habitat.c`:
    - `agent_t` (:157-164)
    - the Focus face tap that starts voice (`habitat_touch` :3696-3713, `case A_VOICE` :3080)
    - `render_home` (:1720-1743), for the "See it in {Host}" line and the "Waiting for you · {Host}" status
    - the question screen's `[ say ]` (:2018), gated on `v`
  - `test/test_touch_ui.py`: new cases and `DESIGN` previews (:4215-4246).

**Interfaces:**
- Consumes: the wire from Task 5.
- Produces:
  - An absent `caps` means `S|V|F|A`.
  - Without `V`: a face tap opens no microphone and sets a 2 s hint "See it in {Host}". `{Host}` comes from the same display table, kept short: Orca, herdr, Ghostty, iTerm2, VS Code, Cursor, Warp, Terminal.
  - needs-you: no firmware logic. The daemon sends the activity line "Waiting for you · {Host}" (Task 7), and the face draws it as any activity text.
  - `view` machine: the host's display name under the agent's name.

- [ ] **Step 1: Write the failing tests** in `test_touch_ui.py`:
  - `a tap on an agent without V starts no voice and shows the hint`.
  - `caps absent: voice starts as today`.
  - `a turn.activity Waiting for you · Orca shows on the home face` (a regression test; no new logic).
  - `machine view shows the host line`.
  - `question screen hides [ say ] without V`.

  Add a `DESIGN` preview for each state.
- [ ] **Step 2: Run** `IDF_PATH=~/esp/esp-idf-5.5.4 python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `env -u IDF_PATH make device-test` and every `devices/harness-device/firmware/test/test_*.py`. Expected: PASS, except the known macOS `test_cable_models.py` "'snprintf' macro redefined". Build `default` with `-DPROJECT_VER=0.1.0-dev`.
- [ ] **Step 5: Commit** `round dial: show where an agent lives, and hold back what it cannot take`.

### Task 9: End to end

**Files:**
- Create: `cli/e2e/deviceWithoutApp.e2e.ts`
- Modify (only if needed): `cli/e2e/harness/fakeEngine.mjs`, so it runs under a pty outside tmux (`pty.fork` + exec, as `ptyRoundTrip.py`). Keep it faithful; do not loosen it.

**Interfaces:**
- Consumes: `FakeDial` (`e2e/harness/fakeDial.ts`), the `heard()` / `onTab` helpers as in `e2e/devicesProcess.e2e.ts:60-135`, the private daemon from the e2e harness.

- [ ] **Step 1: Write the tests:**
  - `with no window the dial lists a paneless claude and a tmux harness agent, with host and caps`.
  - `the paneless agent goes idle → working → done with its last answer`.
  - `a Notification makes it needs-you`.
  - `it disappears when its process exits`.
  - `an agent started before the dial connects is listed`.
  - `opening a window brings back the tab's list; closing it brings the machine list`.
  - `voice to the paneless agent gets voice.error on voice.end`.
  - `HARNESS_DEVICE_OBSERVED=off lists only the harness agent`.
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts`. The config name follows `npm run test:e2e`. Expected: PASS. Then run the related suites: `devicesProcess.e2e.ts`, `deviceCompat.e2e.ts`, `dialBuddyChat.e2e.ts`.
- [ ] **Step 3: Commit** `e2e: the device without the app`.

### Task 10: Proof on a dial (no code)

- [ ] **Step 1:** `make install-cli` from the branch. Flash the Task 8 firmware with the repo procedure:
  1. Quit Harness.
  2. `date +%s > ~/.harness/flasher/flashing`.
  3. `harness stop`.
  4. `esptool chip_id` must say ESP32-S3.
  5. `idf.py -p <port> flash`.
  6. Remove the flag.
  7. `harness start`.
- [ ] **Step 2:** With the app closed, walk the spec's six "On a dial" checks:
  1. Orca + Ghostty + tmux agents listed.
  2. State changes and the last answer.
  3. "See it in Orca".
  4. Plugged in after the agents started.
  5. 60 paneless fake sessions → 10 rows, no reboot or watchdog. Record the devices process CPU and memory against a baseline taken before the change.
  6. Opening the app brings back the tab.
- [ ] **Step 3:** Report each result to Diego with the daemon log lines `cable: agents → N of M`.
