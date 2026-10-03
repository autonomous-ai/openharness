# hn terminal recovery — 2026-09-29

The reported screens showed `The terminal closed / heartbeat timeout` and
`Could not open the terminal / TIMEOUT: no terminal_open answer within 45s`.
The original interruption is unknown. Both stuck states were reproduced with
an isolated, pre-fix hn binary; heartbeat expiry also removed a background shell.

## Change

A heartbeat lease expiry or disconnected backend now renews the affected machine's
connection and reopens its panes. An open RPC that times out or disconnects uses
the same recovery. All panes on that machine participate, including inactive
windows and split shells. Other machines keep their connections. Recovery asks
for `takeover: false`; it does not restart programs or claim another client's
keyboard. Genuine process exits, paused harnesses and permanent refusals remain
closed.

The old connection is explicitly cancelled, including RPC-held clones. Pending
requests are released on every exit, even selection failure or cancellation.
Queued events and replies from the cancelled connection cannot overwrite the
recovering panes. Opens wait until machine selection succeeds.

## Verification

- Release build and 129 Rust tests passed. New tests exercise cancellation with
  outstanding RPCs, selection refusal, stale events/replies, hidden shells,
  timeout versus permanent refusal, and selection readiness.
- `tests/reconnect.py` passed with a real hn client in a private tmux PTY. It
  reproduces expired leases across foreground/background panes, socket loss,
  real process exit, watch-only recovery, and the actual 45-second open deadline
  while WebSocket pongs still arrive. It verifies fresh connections, no leaked
  old connection, no automatic takeover/restart, and input/output after recovery.
  Both `--repro-heartbeat` and `--repro-open` failed on the pre-fix binary with
  the reported screen text.
- Existing `tests/e2e.sh`, `tests/native-terminal.py`, `tests/local-shells.py`
  and `tests/viewer.py` passed.
- `tests/viewer-live.mjs` passed all nine checks on a physical Mac with isolated
  real hn, daemon, backend, Mongo, Redis, tmux and Chrome. Its new terminal check
  suspends only its verified fixture hn process, waits for the real daemon to log
  heartbeat expiry, resumes hn, verifies an input/output round trip, and compares
  all private tmux pane IDs/process IDs before and after. OAuth and the model
  process are deterministic fixtures. Existing browser/viewer checks also passed.
- The reconnect PTY test is included in both Linux architecture jobs in CI.
- Initial full CI passed both Linux architecture jobs and the backend job. The CLI
  job found an existing store-matrix assertion requiring all package arguments to
  be empty, contradicted by KiCad's current default-engine arguments. The failure
  reproduced locally with CLI/store files identical to the base branch. The test
  now checks actual arguments on every engine, preserving default-engine flags
  and verifying they do not leak to other engines. No launch behavior changes.
  The other initial failure exceeded a 1.5-second fuzz-test budget by 10 ms; its
  unchanged targeted rerun passed. Another full run exceeded the bound by 12 ms
  on a different input. CI now runs that suite separately from sibling workers;
  all tests and the timing bound remain unchanged. A Linux viewer-fixture cleanup
  race also surfaced after its assertions passed: deleting its home could race
  the final headless-client save. Both viewer and reconnect fixtures now wait for
  their own clients to exit before removing the test home.

## Reproduce

From `tui/`, after building:

```sh
cargo build --release --offline
cargo test --release --offline
HN_RECONNECT_TEST_PORT=19781 python3 -u tests/reconnect.py
```

`HN_RECONNECT_TEST_BINARY` selects a frozen build. Ports are restricted to
19780–19789; the runner creates a disposable home, a private mock and named
hn/tmux sockets, and removes its processes afterward. `--repro-heartbeat` and
`--repro-open` isolate the original failures.

The real-daemon check uses the dependencies and isolated launch described in
[the browser integration record](2026-09-28-hn-browser-viewer.md). It does not use
an existing account, daemon, tmux server, or harness. This validates recovery on
one physical machine; it does not establish which interruption triggered the
reported remote sessions or provide exhaustive network-fault coverage.
