# Fewer frames between daemons, backend and apps

Status: design, 2026-10-31. Requested by Ken.

> **Status after the builder check (2026-10-31):** changes 2 (heartbeats) and 4 (slim transcript events) stand and
> are planned. Changes 1 (`swarm_changed`) and 3 (`agent_synced`) are **on hold** for the reasons in "On hold" below;
> change 1 needs its own design with a client change, which Ken has not yet decided on.

## Why

Every frame a daemon sends its apps away from the computer crosses the backend: the daemon's link is
`/api/adapter-ws` (`backend/src/lib/adapterWs.ts`, `env.t === 'up'`), which parses it, runs its taps and PUBLISHes it
to Redis on `up:{machineId}` (`bus.ts` `publishUp`); the instances with clients for the machine stringify it again for
each socket (`hub.ts` `deliverUpLocal`). The backend's own pushes to apps (`swarm_changed`) go out on every socket of
every member. Fewer and smaller frames is less backend CPU, Redis traffic, sealing on the daemon and work on the
apps' UI threads.

## What was measured (before)

Ken's Desktop log for 2026-10-30 (`~/.harness/logs/app-20261030.log`, 75 MB): every frame the app received in a day,
from this computer's daemon and, through the relay, from the account's other machines. Desktop was open about 22 of
the 24 hours. Values in the log are cut, so byte counts understate tool payloads.

| Frame | Per day | Share |
|---|---|---|
| `swarm_changed` | 54,282 | 31.8% |
| `agent_activity` | 32,819 | 19.2% |
| `turn_heartbeat` | 28,411 | 16.6% |
| `agent_synced` | 17,099 | 10.0% (about 44% of the logged bytes) |
| transcript events (`tool_start`, `tool_end`, `text_delta`, `thinking_*`, `subagent_finished`, `context_compact`) | about 31,900 | about 19% |
| `turn_started`, `turn_ended`, `turn_summary` | about 3,800 | 2% |
| all frames | 170,666 | |

Findings behind each change:

- **`swarm_changed`**: all 54k are for one Swarm (openharness), one about every second (median gap 1.07 s), at the
  backend's cap of one push per Swarm a second (`backend/src/lib/swarmClientPushes.ts` `COALESCE_MS`). Their source is
  each machine's reading every 15 s (`cli/src/superTabs/machines.ts` `MACHINE_HEARTBEAT_MS`): each is a Swarm write
  that pushes `parts: ['machine']` to every socket of every member (`backend/src/superTabs/store.ts` ~2503); ten
  machines make about 57,600 a day. Desktop reads a Swarm at most once per its read gap (3 s) and makes a machine-only
  change wait for that tick anyway (`desktop/lib/super_tabs/controller.dart` `told`), so pushes faster than that buy
  it nothing.
- **Heartbeats**: while a turn is open, every 5 s, the daemon sends `agent_activity` and, while working, also
  `turn_heartbeat`, both carrying the same `activity` (`cli/src/core/turns/heartbeats.ts`). Desktop and the terminal
  app read `activity` from any frame that has it (`app_state.dart`, `tui/src/app.rs` `on_frame`); the phone reads only
  `turn_heartbeat` and ignores `agent_activity` (`mobile/lib/state/app_state.dart`). An idle or waiting session sends
  the same `agent_activity` every 5 s.
- **`agent_synced`**: the daemon sends the whole agent (1-2 KB) whenever anything touches the registry
  (`cli/src/lib/sessionSync.ts`, 13 callers), with no check that anything changed. Of 17,099: 680 first sends, 4,239
  identical to the previous one for that agent, 181 that differ only in `activity`, 11,999 with another change
  (mostly `updatedAt`, which the phone sorts agents by: `mobile/lib/phone/agent_index.dart`).
- **Transcript events** carry what the engine wrote (a tool's whole input, its output's head, thinking text, pasted
  images) to apps that read little of it:

| Client | Reads |
|---|---|
| Desktop and web (`app_state.dart`, `session_preview.dart`) | the event type, `turn_started.userMessage`, `user_message.content`, `text_delta.content`, the tool's name, `turn_ended.aborted` |
| Phone (`state/session_preview.dart`, `state/app_state.dart`, `notify/done_notice.dart`) | the same preview fields; `turn_started`, `turn_heartbeat`, `turn_ended`; `aborted` and the envelope's `subagent`/`replay` |
| Terminal app (`tui/src/app.rs` ~1705-1853), over the relay too | the above, plus `tool_start.id`, `.parentToolUseId`, `.input` (`todos`, `description`, `command`, `file_path`/`path`/`notebook_path`, `pattern`, `query`, `url`), `tool_end.id`, `thinking_title.title`, `done.result` |
| Every client | `payload.agentId`, `payload.sessionId`, `payload.replay`, `payload.activity` |
| Backend | the envelope of `turn_started` (`agentId`, `replay`) for the daily turn count |

  No client reads `tool_end.output`, `.summary`, `.subagent`, `.durationSeconds`, `thinking_delta.content`,
  `context_compact`, `subagent_finished.summary` or `user_message.images`.

Not pursued: holding transcript events back while no remote app is attached. Desktop dials every machine of the
account (`desktop/lib/state/app_state.dart` ~9899) and the terminal app watches them all, so on Ken's machines someone
is attached about 22 hours a day; and those events are about 19% of frames. Sending events only for the agent a
client is looking at would need every client changed, for at most that 19%.

## The changes

### 1. `swarm_changed`: a machine's reading pushed at most every 30 s (backend)

Where the server publishes a commit to its people (`announceSwarmChanges`, `backend/src/lib/swarmClientPushes.ts`,
design call: there it also saves the Redis PUBLISH per person, not only the socket frame), a change whose parts are
only `machine` goes at once if none went for that Swarm in the last `MACHINE_COALESCE_MS = 30_000`, else waits, merged
with any others, until that window ends. A change with `main` keeps today's rule (the first at once, the next within
`COALESCE_MS = 1_000` merged) and carries any held machine part with it, so nothing is told twice. The per-socket
coalescing in `relaySwarmChanges` and the repeat that keeps apps on pushes (`PUSHES_REPEAT_MS`) are unchanged.

Effect: from about 54,000 to at most about 2,880 machine pushes a day per socket for a Swarm of any size, plus its
`main` changes. A machine card (CPU, slots, quota) on Desktop, web or phone is at most 30 s behind, against readings
taken every 15 s.

### 2. Heartbeats: one per beat, and an unchanged activity not repeated (CLI)

In `createHeartbeats` (`cli/src/core/turns/heartbeats.ts`), each beat sends one frame:

- working: `turn_heartbeat` carrying `activity` (every client keeps working from it; the phone needs this one);
- not working (`idle` or `unknown`, the only other states, `cli/src/lib/turnActivity.ts`, while the turn is still
  open or the device still needs the beat): `agent_activity`, only when the activity differs from the last one sent
  for that session (by `state`, `epoch` and `revision`; `validForMs` ignored). The last sent is forgotten with the
  heartbeat (`stopHeartbeat`).

Effect: about 30,000 fewer frames a day on the measured account.

### 3. `agent_synced`: not sent when nothing but activity changed (CLI)

In `createSessionSync` (`cli/src/lib/sessionSync.ts`), the daemon remembers, per agent, the last agent frame it sent
to the apps, without `activity`. A frame equal to it is not sent to the apps (`deps.send`). The dial's copy
(`deps.sendCommander`) is unchanged. No reset is needed (design call): an app that connects, or reconnects after the
relay dropped, lists agents itself (`agents_list`); a connected app missed nothing, since a frame is delivered or its
connection ends; and an agent created again has a new `createdAt`, so it never equals the old one. The memory forgets
an agent on the unavailable path it already has, and keeps at most 2,000 agents (oldest first).

Effect: about 4,400 fewer frames a day, among the largest frames there are.

### 4. Transcript events: a slim frame for apps away from the computer (CLI)

On the remote path only (`cli/src/backendSocket.ts` `toRemoteApps`, before the frame crosses to the gateway's
process), a pure `slimForRelay(frame)` (in `cli/src/gateway/`) keeps:

| Event | Payload kept |
|---|---|
| `turn_started`, `turn_ended` | everything |
| `user_message` | `content`; `images` dropped |
| `text_delta` | `content` |
| `thinking_delta` | nothing |
| `thinking_title` | `title`, `thinkingId` |
| `tool_start` | `id`, `tool`, `parentToolUseId`, `input` with every string value cut to 200 characters, arrays to 50 items, depth to 4 |
| `tool_end` | `id`, `tool`, `parentToolUseId`, `isError` |
| `subagent_finished` | `id`, `status` |
| `done` | `result` cut to 500 characters |
| `context_compact` | nothing |

Every one keeps `activity`, `agentId`, `sessionId` and `replay` in its payload; the envelope (`type`, `agentId`,
`dbSessionId`, `replay`, `subagent`) is never touched. Windows on this computer and everything inside the daemon (the
dial's cards, recaps, the Swarm, search, the orchestrator, local tool clients) keep the full event. The gateway's
`productUsage.observe` reads only fields the slim frame keeps.

Security: `subagent_finished`, `turn_heartbeat` and `agent_activity` are not in `ENCRYPTED_UP_TYPES`
(`cli/src/lib/e2ee/core.ts`), so they cross the relay in the clear today, `subagent_finished.summary` (a sub-agent's
own words) included. The slim frame drops the summary, so only ids and a status remain in the clear. Sealing the type
is left out (design call): `core.ts` is pinned by hash with the browser client and the paired device in other
repositories (`core.test.ts` "interop keystone"), and any edit to it forces those to be re-derived.

## On hold (builder check, 2026-10-31)

**Change 1 would show machines late or offline.** Desktop and the web build judge a machine by how old its last
reading is (now minus `observation.receivedAt`, `desktop/lib/super_tabs/machine_status.dart`): late after 20 s
(`kSuperTabMachineLateAfter`), offline after 35 s (`kSuperTabMachineOfflineAfter`). Today a reading is at most about
19 s old when shown (about 1 s of push batching, Desktop's 3 s read gap, a reading every 15 s). Held 30 s, it reaches
about 48 s: dots flap between late and offline. The same 35 s decides which machines can take a Buddy
(`buddy_machines.dart`), whether team work can launch (`launch.dart`), and `terminal_unavailable.dart`,
`agent_mark.dart`, `message_receipt.dart` and the dimming in `machines.dart`. Released apps cannot change those
thresholds. Any saving here needs its own design: the server judges a machine's freshness and says so, apps stop
deriving it from read timing, and older apps keep today's pushes. The phone is unaffected either way (it ignores
`swarm_changed` and reads the Swarm every 5 s on screen, `mobile/lib/swarm/swarm_reader.dart`).

**Change 3 saves little that is safe to drop.** Most identical `agent_synced` come from the deliberate full
republish every 5 minutes (`cli/src/core/main.ts` ~2617, `RUNTIME_RECONCILE_MS`, "safety passes"), which Desktop and the
phone use to re-attach panes stuck on "Attaching…" (`app_state.dart` ~21850, phone ~10725), and which the phone counts
as proof that a machine's session is alive (a sealed frame; `agent_activity` and `turn_heartbeat` are not sealed,
`lastHeardFromMachineAt` in `mobile/lib/ws/ws_conn.dart`). The 181 activity-only frames are the ones that carry the
corrected `idle` after a heartbeat stopped. Not every `agent_synced` goes through `createSessionSync` either
(`core/agents/update.ts`, `core/agents/cloud.ts`, `backendSocket.ts` `publishStoppedAgent`), and the 13 callers are 7
direct ones plus about 40 through `announceSession`.

## Expected effect on the measured day

| Change | Frames a day |
|---|---|
| 1. `swarm_changed` | on hold (about -48,000 if it can be done safely) |
| 2. heartbeats | about -30,000 |
| 3. `agent_synced` | on hold |
| 4. transcript events | none fewer; smaller |
| total now | about -30,000 of 170,666 (about 18%), plus smaller transcript frames |

## Goals

- About half the frames on the measured account, with every app showing what it shows today.
- No tool output, thinking text or image crosses the relay, and no sub-agent text in the clear.

## Non-goals

- Holding events back while no remote app is attached, or per-agent subscriptions (see Not pursued).
- Changing what windows on the same computer receive.
- The apps' own read timers.

## Anti-goals

- A phone or window showing an agent idle while it works, or missing a turn's end.
- A phone's agent order going stale (`updatedAt` changes are always sent).
- The daily turn count or the daemon's product metrics changing.
- A dial card losing anything.

## Measure after

The same count from a Desktop log of a comparable day after release (the script reads `~/.harness/logs/app-*.log`,
counting `↓` frames by type), written into this document beside the "before" table.

## Results

Counted with `python3 -I scripts/desktop-frame-count.py <Desktop log>` (received `↓` frames by type, the
`swarm_changed` gap, and each `agent_synced` against the previous one for its agent).

| Log | Window | Frames | `swarm_changed` | `agent_activity` | `turn_heartbeat` | `agent_synced` (identical / activity only) |
|---|---|---|---|---|---|---|
| Before: Ken's Desktop, 2026-10-30 (the table above) | about 22 h open | 170,666 | 54,282 | 32,819 | 28,411 | 17,099 (4,239 / 181) |
| Before: the build Mac's Desktop, 2026-10-30 | 03:05-17:02 | 161,203 | 40,344 (median gap 1 s) | 22,670 | 18,980 | 59,467 (35,601 / 147) |
| After | pending: a comparable day after the release | | | | | |

The build Mac's Desktop had far more identical `agent_synced` (60% of them, against 25% on Ken's): worth weighing if
change 3 is taken up again.

## Design

- **Growth**: one held change per Swarm per socket (backend); one small object per live session and per agent
  (daemon); all dropped with their session, agent or socket.
- **Concurrency**: the held machine part is per socket and merged into the next send; the daemon's memories are
  per process and only decide whether to send.
- **Read cost**: none added; each change removes work per frame.
- **Scale**: `swarm_changed` stops growing with the number of machines in a Swarm (30 s per Swarm per socket);
  heartbeats stop growing with idle sessions. The warning metrics are the frame counts above and backend CPU.
- **Compatibility**: older Desktop, web, phone and terminal apps read only fields that stay (change 4), keep their
  working state from `turn_heartbeat` and `activity` (change 2), read the Swarm on their own timers when not told
  (change 1), and list agents themselves on connect (change 3). An older backend keeps pushing every second; an older
  daemon keeps sending everything.
- **Migration and rollback**: none; a rollback restores today's frames.
- **Audience**: unchanged; `subagent_finished` no longer carries a sub-agent's words in the clear.
- **Identity**: unchanged.
- **Failure**: a held machine push lost with its socket is replaced by the app's own read; a heartbeat or
  `agent_synced` skipped wrongly is corrected by the next change or the next `agents_list`.
- **Platforms**: daemon and backend, the same everywhere.

## Tests

- Backend: `swarmClientPushes` unit tests: machine-only changes within 30 s give one push; a `main` change goes at once
  and carries a held machine part; the repeat still goes.
- CLI: heartbeats unit tests: working sends only `turn_heartbeat` with `activity`; an unchanged waiting activity is
  sent once; a change sends again; a restarted heartbeat sends again.
- CLI: `sessionSync` unit tests: an identical or activity-only frame is not sent to the apps but still to the dial; any
  other change sends in full; an agent forgotten on the unavailable path sends in full next; the memory stays bounded.
- CLI: `slimForRelay` unit tests for each row, the bounded input (a large `Write` cut, `TodoWrite` kept), envelope and
  payload ids untouched; a socket test that windows here still get the full event.
- The terminal app's fleet view against slim frames (`tui/tests/mock-daemon.mjs`): plan, sub-agents and "doing" still
  render.
