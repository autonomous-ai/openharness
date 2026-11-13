# The Harness device without the app (Diego, 2026-11-13)

Wave 0 of the device integration roadmap: the foundation every later integration (Orca, herdr, Claude Code's mod,
Codex, the terminals) plugs into. Research: "Device first, with integrations" (2026-11-12) and the integration
priority list (2026-11-13), Diego's notes outside the repository.

## Why

The round dial lists agents only while the desktop app has a window: with none, `CableHost.listAgentSnapshot`
sends `[]` (`cli/src/cable/cableHost.ts`). So the device's market is the app's users. Most developers run their
agents somewhere else: Orca, herdr, Ghostty, iTerm2, VS Code.

The daemon already follows 14 engines through their own hooks (`docs/engines.md`), and those hooks fire wherever
the agent runs. But `cli/hook/notify.mjs` returns before posting when the session has no tmux or Harness pane
(`if (!tmuxPane && !PTY_PANE) return`). The daemon never hears about Claude Code in Orca.

## Decided (Diego, 2026-11-13)

- **Keep the app; the device works without it.** The app becomes one place the device works, not its gate.
- **With no window, the dial shows this computer's agents, the ones that need the person first** (option A).
  With a window, nothing changes: the dial holds the active tab, as decided on 2026-09-17.
- **Agents outside a pane appear on the device only** (option A). The app, the phone, ⌘K and the Swarm do not see
  them; ⌘P still finds their conversations, as today.
- **It lives in the devices process** (approach 1). The core gains one hook route that checks and forwards; it keeps no
  new state. Third-party hosts are parsed there too, never in the core (`cli/AGENTS.md`, "Protect the core").

## Goal

With the desktop app closed, a person plugs in the dial and sees the agents running on this computer: Harness
agents and agents in any other app or terminal, with live status and the last answer. Later waves add a voice and an
open action per host through the same `HostSource` interface, without touching this design.

## Design

### Data flow

```
an agent outside a Harness or tmux pane (Claude Code in Orca, Codex in Ghostty, …)
  │  the engine's own hook → cli/hook/notify.mjs
  ▼
POST /api/hook/observed          (no pane: today's early return becomes this post)
  ▼
core: validate, bound, rate-limit → forward to the devices process (devicesLink); drop if it is not running
  ▼
devices process, cli/src/cable/hosts/
  HostRegistry ── HarnessSource   this computer's Harness agents (the fleet list, local machine only)
              └─ ObservedSource  agents outside a pane, from hook events and a scan of open sessions
  → dedupe → select and order → CableSession → the dial
```

### The hook (`cli/hook/notify.mjs`)

- With no pane, post `{ engine, sessionId, event, cwd, callerPid, transcriptPath, hostHints }` to
  `/api/hook/observed`, fire and forget: wait only until the request is written (150 ms at most), never for the reply;
  no `fallbackRegister`, no `routeToPaneOwner`. The engine must not get slower.
- `event` is one of `session-start`, `turn-start`, `needs-input`, `turn-stop`, `turn-error`, `session-end`, mapped
  from each engine's hook names where the existing code already maps them.
- `hostHints`: values of a fixed allowlist of environment variables, each cut to 64 characters: `TERM_PROGRAM`,
  `__CFBundleIdentifier`, `HERDR_PANE_ID`, `REX_BLOCK`, `ZELLIJ`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`,
  `ORCA_AGENT_SESSION_ID`, `ORCA_APP_VERSION`. Nothing else from the environment, and never by prefix: Orca also sets
  `ORCA_PAIRING_CODE` and `ORCA_AGENT_SESSION_SPAWN_TOKEN` in the same environment (read on an Orca 1.4.256 session,
  2026-11-13), which must never leave the hook. cmux's variables join with its adapter in a later wave.
- The engine-specific guards (Cursor background agents, Codex subagents, Devin's Claude duplicate) still run first:
  the paneless post goes after them.
- **Two hooks the engines do not send today.** Claude Code's installed hooks have no `Notification`, so nothing says a
  session waits for the person: `Notification` joins Claude's hook contract, posts `needs-input` for a paneless
  session, and is ignored for a session in a pane (today's behaviour there is unchanged). Codex's installed hooks have
  no `Stop`: an observed Codex session's end of turn comes from the open-session check below instead, so Codex's hook
  contract does not change.

### The core route

- `/api/hook/observed`, on the core's existing local listener, beside the other `/api/hook/*` routes.
- Accepts only a known engine id; `sessionId` ≤ 128 characters, `cwd` ≤ 1024, `transcriptPath` ≤ 1024,
  `callerPid` a positive integer, at most 8 hint keys of 64 characters, the whole body ≤ 4 KB. Anything else: 400.
- At most 20 events a second per session; the rest are dropped.
- Forwards the typed event to the devices process through `devicesLink` and returns. When that process is not
  running, the event is dropped: no device, nobody to tell. The core stores nothing.
- One new file at most, listed in `src/architecture.coreFiles.txt` with the reason: hook events are what the core
  already receives; this route only stops dropping the paneless ones on the floor.

### `HostSource` (`cli/src/cable/hosts/`)

```ts
interface HostSource {
  readonly id: 'harness' | 'observed' /* later: 'orca' | 'herdr' | … */
  list(): HostAgent[]
  onChange(listener: () => void): () => void
  send?(agent: HostAgent, text: string): Promise<SendResult>   // wave 0: Harness only, the existing path
  focus?(agent: HostAgent): Promise<boolean>                   // wave 0: none
  capabilities(agent: HostAgent): Caps                         // { status, voice, focus, answer }
}
interface HostAgent {
  id: string                    // what the dial sends back; a UUID
  engine: string; sessionId?: string; callerPid?: number; cwd?: string
  name: string; host: string    // 'harness' | 'orca' | 'herdr' | 'ghostty' | 'iterm' | 'vscode' | 'terminal' | …
  state: 'idle' | 'working' | 'needs-you' | 'done' | 'error'
  since: number                 // when the state began
  lastActivityAt: number
  lastAnswer?: string           // the end of the last turn, cut to the card's length
  unseenDone: boolean
}
```

The interface is the seam a later service can lift out whole if the app or the phone should see these agents too.

### `HarnessSource`

This computer's agents from the fleet router (`listAgentsFlat`, local machine only), with their states from the
existing activity tracking. Voice and answers use today's paths. No focus with no window: the dial's `focus` is a
statement to the window (`CableHost.focus`), and there is none.

### `ObservedSource`

- **Id.** A UUID derived from `engine + sessionId` (name-based, stable), so it fits the firmware's `ID_MAX`.
- **Name.** The basename of `cwd`. **Host.** From `hostHints`: herdr, Rex, Zellij, kitty, WezTerm, Orca by their own
  variable (Orca also by `__CFBundleIdentifier` `com.stablyai.orca`); else `TERM_PROGRAM` / `__CFBundleIdentifier`
  (iTerm2, Terminal, Ghostty, VS Code, Cursor, Warp); else `terminal`.
- **States.**

| Event | State |
|---|---|
| `session-start` | idle (appears) |
| `turn-start` | working; `since` starts the timer |
| `needs-input` | needs-you |
| `turn-stop` | done; `unseenDone` until the dial shows it; `lastAnswer` read (below) |
| `turn-error` | error |
| `session-end` | removed 10 s later |

- **The last answer.** On `turn-stop`, read at most the last 256 KB of the transcript, under a 1 s deadline, and take
  the agent's last message, for Claude Code and Codex. Other engines show done with no text. Only paths inside the
  engine's own folders are read (`~/.claude/projects`, `CODEX_HOME/sessions`, as the engine readers already resolve
  them): a forged hook cannot point it at another file.
- **Codex's end of turn.** While an observed Codex session is working, check `OpenSessions.working(sessionId)` every
  3 s; when it stops working, the turn is done.
- **Agents already running.** When a dial connects, and every 60 s while one is connected, scan open sessions with
  `OpenSessions` (`cli/src/lib/sessionSearch/external.ts`, what ⌘P uses to know which conversations a process holds).
  A session found only this way is idle until its next hook event. Sessions that Harness owns are skipped, as ⌘P does.
- **Removal.** Every 30 s, check each `callerPid` (with `externalProcessGeneration`, so a reused pid does not keep a dead
  session); gone → removed. No pid and no event for 12 hours → removed.
- **Bound.** At most 50 sessions; when full, the oldest idle one goes.
- **Privacy.** None of it leaves this computer: not to the backend, the phone or another machine.

### Dedupe

Identity is `engine + sessionId`; failing that, `callerPid` inside a host's process tree. When two sources hold the
same agent, the stronger wins: Harness, then a host adapter (wave 1), then observed. In wave 0 the sources barely
overlap (Harness agents have a pane), but the rule and its tests land now, so wave 1 plugs Orca in without changing it.

### What the dial gets with no window

- **Which.** `HarnessSource` and `ObservedSource`, deduped.
- **Order.** needs-you, then working, then done and unseen, then the rest by last activity; within a group, the most
  recent first.
- **How many.** At most 10 rows (to be tuned on a dial). `total` is every agent on this computer. The bound is in the
  selection, not in name lengths: the 78-agent reconnect (`listAgentSnapshot`'s comment) is not repeated.
- **When.** Changes are coalesced for 1 s, and pushes are at least 1 s apart. The list is pushed only when its members or
  order change (`agentsKey`, as today); a state change inside the same list goes as the existing per-agent frames.
- **With a window.** Exactly today's behaviour.

### The wire

The existing `agents.begin` / `agent` / `agents.end` frames, with optional fields:

| Field | On | Value |
|---|---|---|
| `host` | `agent` | `harness`, `orca`, `herdr`, `ghostty`, `iterm`, `vscode`, `terminal`, … |
| `caps` | `agent` | letters of `s` status, `v` voice, `f` focus, `a` answer: `sva` for a Harness agent with no window, `s` for an observed one |
| `view` | `agents.end` | `machine` with no window; absent with one |

`tab` stays `''` with no window. The firmware reads frames by key, so an older dial ignores the new fields and shows
the list: the round firmware no longer reads the window flag (`s.window` is set and never read).

### Actions the dial cannot take on an agent

- `voice.begin` for an agent without `v` keeps no audio (`CableSession`; nothing is sent for transcription). The
  refusal is answered on `voice.end` as `voice.error` "This agent is in Orca. Talking to it from the device comes in
  an update.": today's firmware shows a voice error only once the person has let go, so one sent at `voice.begin`
  would be dropped.
- An answer for an agent without `a` is refused with a `toast`. A `focus` for an agent without `f` is ignored without
  a toast (the dial sends it on every swipe), and marks a done agent seen.

### Round dial firmware (`devices/harness-device/firmware`)

1. Parse `host` and `caps` per agent; no `caps` means `svfa`, so an older daemon changes nothing.
2. Without `v`: a tap on the face does not open the microphone and shows "See it in Orca" (the host's name). (The
   Focus face draws no `[ say ]` control; the question screen's stays, gated the same way.)
3. Without `f`: no open hint.
4. needs-you: the daemon sends the activity line "Waiting for you · Orca" (`turn.activity`); the face draws it as any
   activity, with no question card.
5. With `view: machine`, the host's name under the agent's.
6. Host tests in `test_touch_ui.py` for each, with rendered previews for the mockup review.

Ships by OTA under the `harness-device` key. Harness Pro is not part of wave 0.

### Switches

On by default. `HARNESS_DEVICE_OBSERVED=off` turns the observed source off (the kill switch). A per-person device
setting ("Show agents outside Harness") is wave 1: device settings live in the dial's NVS, so one more needs firmware,
desktop and protocol changes beyond this foundation.

## Out of scope (later waves)

Host adapters (Orca, herdr, cmux, Superset, the terminals); voice, open and answers for observed agents; Claude Code's
mod; `codex queue`; AI-written recaps for observed agents; Harness Pro; the app, the phone and ⌘K seeing observed
agents; Windows and Linux beyond what the hook already does there.

## Done when

**Tests**

- Core route: typed and bounded input, rate limit, drop when the devices process is down; 100% per file
  (`npm run test:core`).
- `HostRegistry`, `ObservedSource`: each event, removal by pid and by age, the 50-session bound, the open-session scan,
  the transcript read (bounded, deadline, inside the engine's folders only), host detection.
- Selection: order, the 10-row bound, `total`, the 1 s coalescing, dedupe precedence.
- `voice.begin` refused for an agent without `v`, before audio is kept.
- `notify.mjs`: the paneless post, fire and forget; the hint allowlist; the existing guards still run.
- End to end: the real daemon, a fake engine started outside tmux firing its hooks, a fake dial. The machine list with
  no window; idle → working → done with the answer; needs-you; removal when the process exits; an agent already running
  before the dial connects; opening a window brings back the tab's list.
- Firmware host tests for `caps`, `host`, the waiting card and the "See it in" line; `make device-test` and every
  `firmware/test/test_*.py` pass.

**On a dial** (Diego's Mac, app closed)

1. The dial shows Claude Code in Orca, Claude Code in Ghostty and a Harness agent in tmux.
2. Their states follow: idle, working, done with a chime and the last answer, needs-you while one waits for approval.
3. A tap to talk on an Orca agent shows "See it in Orca"; an older firmware gets the card, and nothing breaks.
4. Plugged in after the agents started, the dial still lists them.
5. 60 observed sessions: the dial gets 10; no reboot, no watchdog; the devices process's CPU and memory stay within
   the recorded baseline.
6. Opening the app: the dial goes back to the active tab.

## Design notes

- **Cost.** Nothing runs without a device: the devices process starts only when one is there, and the core drops the
  events otherwise. The scan is every 60 s and bounded; the transcript read is bounded in bytes and time.
- **Compatibility.** The cable protocol only gains optional fields. An older dial shows the list; an older daemon sends
  no `caps`, which the new firmware reads as everything allowed.
- **Failure.** A wrong or missing hook event leaves an agent idle or late, never a wrong action: observed agents take
  no action in wave 0. The kill switch turns the source off.
- **Security.** The core parses only typed, bounded data from its own local listener, as for the other hook routes.
  The devices process reads transcripts only inside the engines' folders. Nothing observed leaves the computer.
- **Platforms.** macOS first, where the done-when runs. The hook already runs on Linux and Windows; host detection
  there is `terminal` until a later wave.
