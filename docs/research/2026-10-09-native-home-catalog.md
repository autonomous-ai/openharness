# Native home catalog evidence

Exact resume and process discovery now read a fresh bounded `engine-homes.json` through `nativeSessionRoots`. The former reader cached inode/mtime/size and treated read failures as an empty or partial catalog. An unreadable competing home could therefore disappear from an identity pool. A same-stamp replacement could also hide a newly adopted home.

The new reader requires a complete regular file owned by this account, without group/world write permission or a final symlink. It opens nonblocking, ties the descriptor to the inspected file, reads at most 64 KiB, and checks the descriptor and pathname again. Invalid UTF-8, incomplete JSON, duplicate properties, unknown schemas and malformed paths hold lookup with `IDENTITY_UNAVAILABLE`. There are at most 63 moved homes per engine, leaving one slot for its default home, 64 read calls and a 250 ms work deadline. Missing parents are inspected with a 32-component bound; a dangling parent link does not prove an empty installation. These are bounded work and change-detection checks, not cancellable kernel I/O or an atomic filesystem snapshot.

Every positive moved root comes from that call's complete file. Within a process, previously observed and in-memory adopted homes are used only to detect missing evidence: an unsaved adoption cannot silently remove a possible competitor. Valid held reads add positive facts before omission checks, so A → B (held) → A cannot forget competitor B. The cumulative facts stay bounded; an overflow remains a hold, and an oversized legacy list is rejected before visiting it. Those facts cannot supply a cached positive result. An explicit Codex profile and engines without movable session stores do not require this catalog. Existing exact/discovery/process-record final root checks read it again after asynchronous native evidence.

The separate golden commit `75d80e65f2ebf56b7c31ffdff94e012cd7b1fe7f` recorded 28 former-main observations on `fb834fb18c8642b424a30d06b643db376ca27cf9`, with Linux, UTC, fixed time, private homes and forbidden host binaries. Native roots replay its healthy observations; the artifact stays unchanged at SHA-256 `271edb4bf525076a19681d142b16be2db22da4e21aa115b2341093e4ad081f7f`. Compatibility observations, including legacy bound-home fallback, remain explicitly about the old API.

Validation covers malformed and disappearing catalogs, failed adoption persistence, a same-stamp added competitor, descriptor/path replacement, short reads, bounds, typed recovery and deliberate broken wiring. The private daemon case corrupts the catalog while a hookless process awaits binding: readiness and a sibling continue, Stop/Close keep the process alive with the reason, and the same process binds after atomic catalog recovery. Exact-head receipts, review and merge timing belong in the PR body. All 21 deliberate wiring mutations failed by assertion after a green baseline. The corrected source passed 429 focused assertions, 1,942 core/service assertions and 265 harnessd assertions (both coverage gates at 100%), 27 private enginehomes/machine e2e cases, and 57 private tmux cases. The latter excludes 15 vendor-dependent rows; harnessd retains its existing single skip. Serial resume ran alone: 451 assertions and 100% coverage. An intermediate iterator test mock crashed its worker; the corrected fixture and its mutation passed. No failed run is counted as passing.

## Measured root-collection cost

The [private workload driver](../../cli/scripts/handoff-2026-10-08/home-catalog-cost.ts) ran three interleaved fresh processes per source/workload, with 25 calls per process, on Node 22.23.2, macOS x64, UTC and `/tmp`. Former source matches main `fb834fb18c8642b424a30d06b643db376ca27cf9`; current source is `81d028f3f78741fd72a8d72e97c4923fc7546e91`. Measurement ran October 9 17:56:18–17:56:35 UTC without concurrent local validation. An earlier sandbox invocation stopped before sampling because its private runner IPC socket was denied. [Raw samples](2026-10-09-native-home-catalog-cost.json) include every call, CPU and whole-process peak RSS.

| Catalog workload | Former median / p95 ms | Current median / p95 ms | Current result across 75 calls |
|---|---:|---:|---|
| New installation | 0.0139 / 0.0701 | 0.0274 / 0.1147 | Default root |
| Eight moved homes | 0.0173 / 0.1113 | 0.0911 / 0.4574 | All nine roots |
| 63 moved homes | 0.0864 / 0.3785 | 0.2295 / 0.4029 | All 64 roots |
| 62,320-byte valid catalog | 0.2862 / 0.6569 | 0.6157 / 1.2807 | All 64 roots |
| Malformed JSON | 0.0142 / 0.0734 | 0.0945 / 0.3327 | Held |
| 65,537-byte catalog | 0.0109 / 0.0730 | 0.0169 / 0.0930 | Held |
| Added home, unchanged old cache stamp | 0.0115 / 0.0521 | 0.0769 / 0.2513 | Both roots |
| Failed adoption persistence | 0.0131 / 0.0820 | 0.0862 / 0.3145 | Held |

For eight homes, median CPU per 25 calls was 1.967 → 7.204 ms; for the 62,320-byte catalog it was 17.497 → 34.518 ms. Median process peak RSS across the workloads ranged from 77.60–85.87 MiB before and 78.73–89.56 MiB after. Setup/import is excluded from timed calls and CPU but included in peak RSS. These measure root collection only, not complete discovery or resume. The former reader returned a partial/default or unconfirmed root pool in the failure workloads; its shorter time is not equivalent evidence. These are reference measurements without a numerical performance gate.

## Explicitly unfinished compatibility migration

This change does not make legacy `sessionRoots`, `movedHomes`, home selection or catalog writers strict. Their caller migration remains part of the fixed [completion checklist](2026-10-09-daemon-core-completion.md). The independent design review identified the required ordering:

- Serialize cooperating catalog writers and confirm durable adoption before treating it as saved. A missing catalog after durable adoption must remain distinguishable from a new installation across restart. A failed save must retain pending adoption; retry hook installation even if rename succeeded before durability confirmation failed.
- Preserve typed unavailability through transcript validation, and contain registration errors per discovery row. Registry load must retain affected bindings and prevent unverified rows from automatically restoring.
- Check home evidence before restart terminates an engine. Restore needs a durable hold and a real retry trigger; native catalog recovery does not produce a service-connect event.
- Validate checkpoint evidence before writing screen/history files. A bound transcript with no proven home must not fall back to another login.
- Contain unavailable homes per row for titles, activity, resources and optional readers. Search admission requires a complete snapshot and final fence when its roots migrate.
- Hook publication must retain pending intent if its final synchronous commit cannot confirm evidence. Prompt effects follow successful admission, and distinct prompt deliveries must remain distinct.

These are existing callers that must migrate together with their hold/retry behavior. Leaving the compatibility API explicit avoids introducing a new exception after a legacy caller has already stopped a process or written a checkpoint. The native-identity group is not yet complete. No release is authorized.
