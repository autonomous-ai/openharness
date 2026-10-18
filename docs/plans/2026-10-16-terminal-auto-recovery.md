# Remote terminals recover by themselves: find dead streams fast, keep retrying, log why

Requested 2026-10-16. Phase 2 of the "remote terminal keeps showing Reconnect while the network is
fine" investigation; Phase 1 (relay rate budget) shipped in #1365 and #1367
([spec](2026-10-16-terminal-relay-rate-budget.md)). This spec also carries Phase 3 (failure reasons in
the desktop's file log), because Phase 2 cannot be verified on someone else's machine without it.

Scope: the CLI's terminal stream manager (host side), `TerminalSession` and `AppNotifier` in the desktop
(the web build shares this code) and in mobile (its own copies). No backend change, no new frame type,
no E2EE type-set change.

## Who hits it

People with many harnesses across several remote machines and tabs. Every pane is a separate chance to
fall into one of the gaps below, so the person with the most panes sees Reconnect most. A person with a
few panes on direct p2p rarely does.

## What happens today

When a host loses its backend link (a backend deploy, which happened about every four hours on
2026-10-15/16, a network blip, sleep), the host closes every remote terminal stream without telling
anyone (`backendSocket.ts` `linkDown`, `notify=false`). The backend immediately publishes
`node_status {online:false}` (`role.detach()`). The desktop marks the machine's panes offline and,
when the machine comes back, reloads its agents and reattaches every pane in every tab (polling up to
~10 s for the agents to be ready). That path mostly works. The 2026-10-15 14:07 desktop log shows
panes back four seconds after the drop.

Panes are left on Reconnect by three gaps:

- **(a) The host comes back after the recovery window.** Adapter backoff reaches 16–30 s, or the CLI is
  restarting for an update. A pane whose reattach missed its window stays `error` until the machine's
  next status change, which may never come.
- **(b) A stream dies while the machine stays online, as far as the desktop can tell.** Examples: the
  viewer's relay socket is replaced, a p2p demotion races a close, or the host's core restarts while
  its link stays up. The desktop notices only after 15 s of silence (`TERMINAL_STREAM_TIMEOUT`), then
  sends three resyncs 4 s apart. The host ignores a resync, ack or alive for a stream it does not have
  (`streamFor` returns null and the handlers return quietly), so the desktop reopens once, and if that
  fails it calls `_fail`. After `_fail`, nothing retries: the reattach sweep runs only on machine
  events or a tab switch.
- **(c) A polite reopen meets the old stream's control lease** (`CONTROL_LEASE_HELD`), and the pane
  becomes `takenOver`, which is never retried automatically. Out of scope here (see below).

## Change

### 1. Host: report a missing stream to clients that ask (CLI)

In `cli/src/lib/terminalStreamManager.ts`, `alive()` and `resyncRequested()` answer a frame for a
stream this connection does not own, but only when the frame carries `reportMissing: true`:

```
terminal_error { streamId, code: 'TERMINAL_STREAM_NOT_FOUND', message: 'no live terminal stream' }
```

`TERMINAL_STREAM_NOT_FOUND` is the code the chunked-upload path already sends for the same condition.
Clients that do not send the flag (every client shipped before this change) get exactly today's
silence, so an older desktop keeps its one-reopen behaviour instead of failing sooner. The answer
travels like any other terminal frame over relay or p2p, so it needs no new frame type or E2EE type.

### 2. Clients: ask, and reopen on the answer (desktop + mobile `TerminalSession`)

- `terminal_alive` and `terminal_resync` payloads add `reportMissing: true`.
- A `terminal_error` with `TERMINAL_STREAM_NOT_FOUND` for the current stream reopens the stream in
  place (`_recoverByReopen`, keeping the rendered screen) instead of `_fail`.

With a new CLI, a dead stream is found by the next heartbeat (≤ 5 s) instead of after
15 s of silence plus 12 s of resync. With an old CLI nothing changes here; the sweep in 3 still
recovers the pane.

### 3. Desktop: keep reattaching broken panes while the machine is online (desktop `AppNotifier`; web shares it)

Mobile is excluded on purpose. Its pager has a deliberate rule that a page a person has already looked
at is not reopened by a guess (`app_state_terminals_test.dart`, "a page a person has looked at is not
reopened by a guess"), and it already redials a dropped p2p channel itself. Mobile gets parts 1 and 2
only.

A pane whose session is `error` or `closed` (`_paneNeedsAttach`) on a machine that is online and
connected is reattached by a sweep, whichever tab it is in:

- One timer per notifier, armed only while at least one such pane exists and cancelled when none
  remain, so an idle app runs no timer.
- Each pane retries with backoff: 1, 2, 4, 8, 16, then every 30 s. The backoff resets when the pane
  reaches `controlling`. It stops while the machine is offline, because the existing offline/online
  path already owns that case.
- Reattach goes through the existing `_attachPendingPanes(machine, intent: AttachIntent.automatic)`.
  That keeps today's rules: it is a polite open (a watcher where someone else is driving), it
  respects `terminalNoTakeoverAvailable` and `_canAttachPane`, and `takenOver` panes are never
  touched.
- The per-session limit of one automatic reopen stays. The sweep is what makes "one reopen, then
  `error`" stop being a dead end.

No UI change. The header keeps showing Reconnect while a pane is `error`, and clicking it still
retries immediately. With the sweep, that state now lasts seconds instead of until someone clicks.

### 4. Desktop: write terminal failures and recoveries to the file log (Phase 3)

Today `TerminalSession`'s diagnostics go to `debugPrint` only, so `~/.harness/logs/app-*.log` cannot say
why a pane showed Reconnect. Log, through `appLog` (category `terminal`, one line each):

- `_fail`: machine, agent, stream, code, message;
- `transportLost`: machine, agent, message;
- `_recoverByReopen`: attempt and reason; `recovery_failed`;
- each sweep reattach: machine, agent, attempt number.

No terminal content and no paths are logged. Per-frame events (each resync attempt, each ack) stay out
of the file. Mobile is out of scope for this part.

## Compatibility

| Client | CLI on the host | Result |
|---|---|---|
| new | new | dead stream found within 5 s, reopened; sweep covers anything left |
| new | old | today's 15 s + 12 s detection; sweep then recovers the pane |
| old | new | unchanged: no `reportMissing`, so the host stays silent |
| old | old | unchanged |

The host and the clients ship independently: the CLI by self-update, desktop and mobile by release.

## Tests

- CLI (`terminalStreamManager` spec): `terminal_alive` and `terminal_resync` for an unknown stream with
  `reportMissing: true` produce one `TERMINAL_STREAM_NOT_FOUND` error naming that stream. Without the
  flag they produce nothing. A stream owned by another connection counts as missing for this one.
- Desktop and mobile `TerminalSession`: alive and resync payloads carry `reportMissing: true`;
  `TERMINAL_STREAM_NOT_FOUND` for the current stream reopens and keeps the terminal, and for another
  stream it is ignored.
- Desktop `AppNotifier`, with fake time:
  - an `error` pane on an online machine is reattached on the backoff schedule, in a background tab too;
  - the timer is cancelled once no pane needs it;
  - no sweep runs while the machine is offline;
  - `takenOver` panes are never reattached.
- Desktop log: `_fail` and a sweep reattach each write one `terminal` line to the file log sink.
- End to end on the local rig (this Mac plus the two docker remote boxes): open several
  remote panes across two tabs, then run each of these, and every pane must return to `controlling` with no
  click:
  1. restart the remote box's daemon;
  2. drop the remote box's backend link (stop the local backend for ~20 s);
  3. kill only the viewer's relay socket.

  Record times to recovery before and after.

Validation: the CLI suites that cover `terminalStreamManager`, plus `test:core` if any `src/core`
wiring changes; the desktop affected tests (`terminal_session_test.dart`, the new pane-retry test);
the mobile `terminal_session_protocol_test.dart`. Record them in the PR, since PR CI runs only Linux unit checks.

## Out of scope

- Gap (c): letting a pane's own reopen reclaim its old stream's lease.
- Keeping p2p-carried streams alive across a backend link drop. Both ends tear p2p down with the relay
  socket today, and separating their lifetimes is an architectural change.
- Reducing frame counts (client ack cadence, coarser relay flushes).
