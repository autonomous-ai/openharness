# Asynchronous native version probes

An OpenCode launch could run a synchronous five-second `--version` command on the
core event loop. Its executable resolver could first run a synchronous login shell
for another five seconds. A slow installation therefore blocked unrelated sessions'
Stop requests, listings and timers. This change makes both subprocesses asynchronous
and bounded, while retaining native launch control in eager code.

Each probe selects its executable once and verifies the same pathname, realpath and
file identity after the child answers. Replacement discards the observation. The
child has a deadline, a 64 KiB output limit and closed stdin. Overlapping probes may
return their own verified observations, but only the current attempt may publish to
the memo. An obsolete hook installer cannot write; same-port concurrent callers join
the current installation under a fixed follow-up deadline. A changed port or expired
join refuses preparation. All version callers await the result, and startup contains
asynchronous installer failures while allowing sibling installers to run.

## Compatibility and fault evidence

Commit `564460afacc66abbc42e254758fa5e3c76e9b3ff` recorded the former code before
the move. `nativeVersion.golden.spec.ts` exercises real core pre-spawn installation
and records version reads plus exact generated v1/v2 plugin contents on pinned Linux
and macOS. The clock, timezone and private paths are fixed; host executables are
forbidden. Its artifact and the existing OpenCode launch artifact stay unchanged.

Private regression tests cover event-loop responsiveness, resolver substitution,
executable replacement, missing replies, output floods, stdin EOF, cache completion
order, obsolete plugin writes and simultaneous creates through the actual creator
and installer. Independent review identified the production shell fallback, stdin,
cache and installation races; the corresponding assertions failed before correction.
The daemon e2e uses separate private connections because each connection deliberately
serializes requests. A fake version child waits for a release file while the other
connection lists and stops a live sibling. Both operations must finish before the
probe is released. This proves Stop/list responsiveness, not a fresh discovery scan.

`cli/scripts/handoff-2026-10-08/mutate-native-version.py` deliberately breaks the
golden wiring and the new fault protections in an owned disposable worktree. Only
assertion failures count. The existing OpenCode launch mutation recipe follows the
new awaited composition. Final validation requires types, architecture, affected
specs, per-file core/services and harnessd coverage, the private e2e lane, automatic
Linux CI and independent review of the committed head and current base.

## Matched component cost

[The measurements](2026-10-10-native-version-cost.json) compare `ea4e800b5` with the
candidate using Node 22.23.2 on the same macOS x64 host. Each workload/revision runs
in a fresh process. A private executable reports v2 immediately or after 100 ms;
cached reads reuse one successful observation. No real daemon or vendor executable
runs. The recipe is `cli/scripts/handoff-2026-10-08/native-version-cost.ts`.

| Workload | Probe median, before → after | Timer delay median, before → after | Parent CPU total, before → after | Peak RSS, before → after |
| --- | --- | --- | --- | --- |
| 10 healthy probes | 55.84 → 54.42 ms | 56.65 → 2.17 ms | 10.87 → 42.90 ms | 77.70 → 73.54 MiB |
| 10 probes with 100 ms delay | 156.93 → 157.03 ms | 157.00 → 1.88 ms | 10.38 → 75.20 ms | 79.32 → 78.67 MiB |
| 500 cached reads | 0.037 → 0.046 ms | 1.34 → 1.32 ms | 57.97 → 54.49 ms | 79.63 → 78.03 MiB |

The useful improvement is that unrelated callbacks run during a slow probe. Probe
latency remains dominated by the child, and cached reads add identity checks. CPU
includes the one-millisecond measurement timer, which can now run while a child is
pending; these small samples do not establish production CPU or full-startup cost.
Cold-start maxima are noisy and retained in the artifact. No numerical performance
gate is inferred from this run. The reported median uses the upper-middle observation
for an even sample count.

## Remaining completion scope

This is a partial implementation of launch-preparation item 2 in the
[completion checklist](2026-10-09-daemon-core-completion.md). It does not yet carry one
confirmed executable through the entire launch, change permanent caching of unknown
versions, or make hook write/removal failures durable holds. Those behaviors need
their own former-code observations and failure tests. Startup still awaits bounded
native installation; service readiness remains a separate boundary. Manual lifecycle
intent persistence and the remaining Stop/Close authority audit are still required.

Work on this phase began October 10 at 15:14 UTC, after #1145 merged. Implementation,
diagnosis and review overlapped with local validation; cost measurement completed at
15:45 UTC. Final validation, CI waiting and merge time belong in the PR evidence.
Publication is zero; no release is authorized.
