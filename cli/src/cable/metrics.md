# Local usage on the cable

`metrics.read.v1` is an optional welcome feature. A device that does not see it
must not offer a measured total. The feature means the daemon understands the
request; an updated local Desktop window and its existing per-provider opt-in
are still needed to obtain readings. Attaching or greeting a device does not
enable or scan a ledger.

The device sends `{t:"metrics.get",requestId}`. The ID is 1–47 ASCII letters,
digits, or hyphens. The answer is `{t:"metrics.state",requestId,schema:1,ok,usage?}`;
a refusal has a short fixed `error` and no `usage`. Requests are read-only.

`usage` contains:

| Field | Meaning |
| --- | --- |
| `scope` | Always `local-transcripts`: only opted-in transcript sources on the cable host. |
| `machineId`, `machineName` | Exact host identity (at most 47 UTF-8 bytes) and display label (39 bytes). Focus on a remote agent does not change this scope. |
| `day` | Local calendar date, `YYYY-MM-DD`. |
| `windowStartMs`, `windowEndMs` | Half-open local calendar day in Unix milliseconds; includes daylight-saving transitions. |
| `generatedAtMs` | Time this projection was produced, not the time the transcripts were read. |
| `asOfMs` | Oldest scan contributing to the amount. Present only with `costUsd`. |
| `currency`, `costKind` | `USD`, `estimated`; never an account bill or remaining quota. |
| `costUsd` | Optional known subtotal. Missing is not zero. A complete empty scan can establish a real zero. |
| `coverage` | `complete`: every enabled named source was read and priced. `partial`: a subtotal exists but some enabled data or pricing is missing. `unavailable`: no amount can be established. Disabled sources remain visible in the provider list. |
| `stale` | No amount is available, or the contributing scan is more than five minutes old. |
| `providers` | Exactly `claude`, `codex`, `opencode`, each with `enabled`, `state`, `priced`, and optional `asOfMs`. State is `disabled`, `scanning`, `ok`, `partial`, `unavailable`, or `failed`. |

Any disabled/unavailable source is missing coverage, not a measured zero for
that source. `complete` only describes the enabled local sources; it never
means complete computer, fleet, Harness-only, account, or billing spend. A
device must qualify partial/stale estimates and show no numeric amount when
`costUsd` is absent. It must not infer elapsed time, goal completion, loop
progress, or future schedules: this protocol provides none of those.

Dates follow each provider's existing ledger entry timestamps. Claude and
Codex report turn usage; OpenCode reports session aggregates. The estimate
inherits those attribution and model-pricing limits. Duplicate-source handling
and pricing belong to the existing Desktop ledger, not to the cable bridge.
An old-day cache cannot establish today's zero; it stays unavailable until a
normal requested refresh reads the new day. Nothing polls or force-enables a
provider. Existing five-minute scan caching applies.

Desktop's lazy `AppNotifier.usageLedger` is shared with Settings. Switching a
provider off clears the same store a pending read uses. `device_usage.dart`
projects only counts' cost, dates, and fixed provider state, never paths,
sessions, prompt text, diagnostics, or provider credentials.

An updated daemon includes `deviceMetricsProtocol:1` in the initial local UI
`connected` handshake only when the private metrics reader is installed. An
updated native window registers `app_metrics_ready {schema:1}` only with its
own discovered local daemon after that handshake. The capability belongs to
that exact WebSocket and resets on disconnect; pending reads and sends cannot
cross a reconnect. Old daemons receive neither usage registration nor figures.
`WindowMetrics` selects one such local UI socket,
pins its connection and machine, sends `dial_metrics {requestId,schema:1,
machineId,expiresAt}`, and waits at most 15 seconds. The Desktop response
`app_metrics_result` repeats all identity fields, then `ok` and `usage` or a fixed
error. The daemon requires an exact request/window/machine match and a bounded,
freshly generated projection. A second simultaneous read receives a busy
refusal. Disconnects and late replies cannot revive a pending read. These
frames never forward through relay or backend sockets; tool sockets cannot
register a source. Unknown fields and raw errors never pass to the device.

Old Desktop apps do not announce support and get no new request. Old firmware
can ignore the added welcome feature. Firmware metrics parsing and display must
gate the entry on this feature, match request/schema/host identity, and invalidate
pending requests and displayed readings on reconnect. Tests cover the pure projection, opt-in revocation,
session invalidation, correlation, expiry, local socket isolation, bounded
responses, and continued scroll input during a scan. A native app and physical
cable smoke test plus both components' full required suites remain necessary
before release.
