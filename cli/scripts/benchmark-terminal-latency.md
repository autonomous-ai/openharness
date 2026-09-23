# Real terminal latency

Run from `cli/` against a running, signed-in daemon. Remote machines must already
be linked and support the `terminal` engine. The script creates one named
disposable shell, runs a Python 3 probe, and deletes only that shell in `finally`.
It never launches a model or types into an existing agent.

```sh
npx tsx scripts/benchmark-terminal-latency.mts \
  --machine MACHINE_ID --label local --local \
  --samples 200 --control-samples 30 --revision SOURCE_COMMIT \
  --output /private/tmp/terminal-local-1.json
```

Omit `--local` for remote targets. Use a fresh output filename for every run.
Run machines and repetitions sequentially after builds and tests finish. Keep
all completed runs, including slow runs and failed attempts. Ten-sample runs
are calibration only. The source revision identifies the benchmark checkout;
the recorded local daemon version identifies the installed daemon actually
serving traffic. Remote daemon versions are not inferred from this checkout.

The primary boundary is **binary input send to matching PTY response received**.
Every byte crosses the real terminal input path, Python stdin/stdout, tmux, and
the local or remote transport. Sequence-specific responses check that input
arrives. This excludes OS keyboard delivery, Flutter parsing/rendering, display
presentation, and model response time. A raw-mode Python echo is reproducible;
it is not a shell editor or a model workload.

Each workload has ten warmups, followed by the requested number of observations:

- Idle terminal, one outstanding input byte at a time.
- The same terminal repainting at a requested 20 Hz, about 86 KB/s before
  compression. Actual received bytes and duration are recorded. A deterministic
  8–42 ms think time precedes each input and is outside its measured interval.

Control requests run in a separate phase, alternating streamless machine
`terminal_capabilities` requests and requests carrying the terminal's stream ID.
These are application RPCs, **not network pings**. Requests and replies can take
different routes; the terminal's reported link mode alone does not prove that
both directions of a control RPC use that route. Do not subtract independent
percentiles to invent a server-processing or network-only number.

Creation, attach, probe readiness, and reconnect are retained as individual
observations. The reconnect closes this script's local client socket, opens a
new one, and verifies the next sequence from the same running probe. It reuses
the daemon's existing remote route: it does not simulate a network outage,
daemon restart, or cold ICE negotiation. Machine-selection acknowledgement is
local; `readyForRequests` also waits for the first remote capability response.

Results include p50/p95/p99/max using nearest-rank percentiles, every warmup and
measured observation, reported terminal link modes, and confirmed cleanup.
Results default to private permissions. Successful results omit machine IDs
and terminal content. Failed results may include a shell-output tail and an ID
needed for cleanup: inspect and redact those before publishing. A cleanup
failure is a failed run; remove only the recorded probe, never unrelated agents.

For validation:

```sh
npx tsc --noEmit --module nodenext --moduleResolution nodenext \
  --target es2022 --allowImportingTsExtensions --skipLibCheck \
  scripts/benchmark-terminal-latency.mts
```
