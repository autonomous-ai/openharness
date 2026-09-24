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

Control requests run in a separate phase, using the application's normal
streamless machine `terminal_capabilities` request.
These are application RPCs, **not network pings**. Requests and replies can take
different routes; the terminal's reported link mode alone does not prove that
both directions of a control RPC use that route. Do not subtract independent
percentiles to invent a server-processing or network-only number.
Failed control requests are retained and counted separately from successful
latencies; the run fails overall even when its later typing checks complete.
The baseline never adds experimental stream-routing hints to a control request.

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
node --import tsx --test scripts/benchmark-route.test.ts
npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext \
  --target es2023 --allowImportingTsExtensions --skipLibCheck \
  scripts/benchmark-terminal-latency.mts scripts/benchmark-route.test.ts
```

## Compare the three remote routes

Add `--route p2p`, `--route turn`, or `--route relay` to opt into an **isolated
source-built transport client**. Use the same remote machine, payload, sample
count, and checkout for all three. Rotate route order between repetitions. The
ordinary mode above continues to measure the installed daemon's automatic route.

```sh
npx tsx scripts/benchmark-terminal-latency.mts \
  --machine MACHINE_ID --label office --route turn \
  --samples 200 --control-samples 30 --revision SOURCE_COMMIT \
  --output /private/tmp/office-turn-1.json
```

This mode hosts an ephemeral loopback WebSocket and the production
`RemoteRelayPool` in the benchmark process. The loopback client, E2EE, wire format,
remote daemon, and PTY remain real. The installed local daemon is not on the
measured path; its version is recorded only as environment context. This shares
one Node event loop between client and transport, so compare these three modes
against each other, not as a before/after of the older installed-daemon results.

- `p2p`: production negotiation with TURN credentials removed from this isolated
  connection's offer policy, accepted only if the nominated ICE pair
  has no relay candidate on either side. TURN fallback is an unavailable direct
  trial, not a P2P result. This measures an available direct path, not the
  production automatic route-selection success rate.
- `turn`: the existing `TERMINAL_P2P_FORCE_RELAY` diagnostic flag is set only in
  this process. A nominated relay candidate and Cloudflare policy hostnames are
  required. The flag alone is not proof that traffic used TURN.
- `relay`: production pool option `p2p: false` keeps terminal traffic on the
  Harness backend WebSocket, including across automatic retry scheduling.

Each run waits at most 35 seconds after probe readiness for the requested route.
Every typing observation records a nominated candidate pair with addresses and
ports removed, stream membership/migration state, and counters for actual binary
sends and deliveries. It must have one input send and a matching PTY response on
the expected path, with no opposite-path binary traffic during the observation.
Missing candidate evidence, fallback, and mixed-route observations fail the run;
retain them separately from the successful latency distributions. This checks
one-at-a-time probe delivery, not arbitrary exactly-once semantics across outages.

The adapter inspects the pinned production/werift internals and wraps send and
delivery methods on its own pool for counters. Route restrictions apply only to
this isolated connection; the installed daemon and production source are unchanged.
Revalidate that instrumentation when upgrading those implementations. No candidate
addresses, access tokens, TURN credentials, or private keys belong in published
results. Console logs may identify machines: keep logs private and review failed
result diagnostics before publishing.

Authentication and the existing machine identity/pin are consumed read-only.
Trust removal on this isolated connection affects only an in-memory snapshot.
No key is generated or copied to disk. A scratch data directory prevents legacy
state migration, and an expired login fails rather than refreshing or clearing
the account. The active desktop's transport pool and sessions are never changed.
Cleanup removes the one created terminal, closes the isolated pool and listener,
and deletes the scratch directory before ending the process.

For a serial, repeatable matrix with rotated route order and alternating target
order, use a fresh directory:

```sh
python3 scripts/benchmark-route-series.py \
  --target office=OFFICE_MACHINE_ID --target home=HOME_MACHINE_ID \
  --samples 200 --control-samples 30 --repetitions 3 \
  --output-dir /private/tmp/harness-route-series
```

The runner requires committed transport probe files, saves a public-label-only
trial plan, and preserves every result and private log. It stops on missing
artifacts or a known cleanup failure. A failed route trial is retained and the
other routes continue; successful timings must never hide unavailable routes.
