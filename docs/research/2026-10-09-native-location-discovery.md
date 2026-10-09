# Native location completeness and discovery retry

The former native location implementation was recorded in `1121bf7fd` before production edits. A separate fixture-only commit, `1f82cef1b`, maps streamed Linux descriptor enumeration in the existing identity golden to the same private evidence as its previous listing. The new 24-observation artifact pins Linux, UTC, clock, native declarations and private filesystem/process fixtures; no host binary runs. Recording again against merged main `138ae6766` left it unchanged. Artifact SHA-256: `0efe2ce638b5d65f34cace39a8d686e3e758aea55bf04cc5d61f371ea265809a`.

The existing locators could interpret read errors as absence, stop at the first matching transcript or descriptor, and accept the readable prefix of a failed process probe. Transcript discovery could leave its initial lookup permanently marked busy after rejection; one failed candidate could also abort the remaining sweep. Bound Copilot, continuation and argv-resume lookup failures could escape the serial binding pass.

## Behavior

Native directory enumeration now streams under an entry budget. Exact transcript lookup checks the complete project pool, distinguishes inode aliases from conflicting files, bounds workspace sidecars, and rejects a changed directory listing or candidate. Ordinary transcript appends keep the same file identity. A shared listing carries evidence for that one sweep and is checked before publication; caller-supplied subsets cannot hide competitors.

Copilot requires a complete lock pool and a unique newest claim. Every claim, including absence, is rechecked; the selected claim is read last. Linux descriptor enumeration shares one budget across its initial and verification listings, checks descriptor changes, and refuses conflicting or deleted conversation locks. Darwin's process probe has a four-second deadline and 256 KiB output bound per invocation; two complete matching replies are required. A failed probe's partial stdout is never authority.

Native reads are contained separately from registry publication in core binding. A rejected read preserves the current row and allows the next session and readiness to continue. Transcript discovery retains pending intent through lookup, listing and publication failures; one candidate's failure cannot abort its siblings. Remove, replacement and stop still revoke late completions. Repeated identical polling reasons are logged once per candidate.

## Validation plan and scope

Run types, architecture, core/services and master coverage at their per-file 100% gates, affected native/repair/Stop/Close specs and unchanged goldens. Run the affected resume coverage lane alone. Extend both private bundled eager-identity lanes: optional native modules missing and stalled, a held Copilot lock pool, a failed Cursor transcript lookup, sibling publication, and recovery. The mutation script deliberately breaks native declarations, completeness and retry wiring; every break must fail an assertion after a green baseline. Measure CPU, RSS and latency with the same private native corpus on former and candidate production. Exact-head independent review and automatic CI precede merge. No release.

The initial affected run passed 127 tests and types; the directory/descriptor race follow-up passed 135 tests and types. Final gate results, mutation outcomes, runtime cost, review and merge evidence are recorded in the PR and appended after completion. Initial recording passed its test but the validation wrapper correctly reported `source_changed` because recording created the artifact; verification with recording disabled passed. The later recording against merged main passed without changing the artifact.

This is part of the [completion checklist](2026-10-09-daemon-core-completion.md), not completion of its whole native-identity group. The legacy saved-home catalog, exact-ID traversal in `sessionRepair`/compatibility session records, complete Hermes pools, and shared visible binding-hold state remain separate named blockers. This change does not claim atomic filesystem snapshots or a cancellable filesystem API; it rejects observed incompleteness and changed evidence within bounded lookup work.

Timing starts with baseline preparation at approximately 13:55 UTC on October 9. Implementation and its focused validation overlap; final validation, independent review/CI waiting and merge are recorded separately. Publication remains zero.

## Independent review corrections

The review of `94f7a2270` against `138ae6766` withheld approval for three concrete races. Grok now validates the selected workspace sidecar after every other native await; Copilot binding and Copilot/agy repair revalidate the complete process claim after transcript lookup; Cursor control paths use strict path validation so an inspection error cannot silently exclude a competing candidate. A known foreign path is still a verified rejection. Fixed-size sidecar digests also prevent retaining up to 64 KiB of text for every workspace.

Private real-file regressions change a selected Grok sidecar during a later sidecar read, switch Copilot/agy native claims during the real caller's transcript lookup, and fail Cursor realpath/stat validation beside a readable competing file. The affected 265-test run passed; typecheck found a new fixture missing required discovery fields, corrected before final gates. Final validation adds the private real-tmux contract and stand-in engine rows (installed vendor smoke rows excluded) and a Grok sidecar workload to the matched cost comparison. No golden artifact was changed.

Independent review approved production head `7a962068f2dc8a3fce8ae3ec0a19bd79e087ba44` against `138ae6766febff6f094f1401705e4e4eb7f6ef9f`. All 21 deliberate wiring mutations failed assertions after a green baseline. At that source, types, 439 affected/architecture tests, master coverage, both bundled native lanes, and 57 private tmux cases passed; 15 installed vendor smoke rows were excluded. Core's 1,942 assertions passed but its gate correctly failed on one uncovered ownership-fence return. The existing deferred Copilot fixture now keeps the native claim stable through the added revalidation so it reaches that fence; production code is unchanged. Only core coverage and types need repeating for that fixture correction.

## Matched runtime cost

Node 22.23.2 on the same Intel macOS machine, three interleaved processes per source/workload, ten lookups per process. Former production is `138ae6766`; candidate is `b65769a31` (production unchanged from the independently approved `7a962068f`). Import and fixture setup are excluded from lookup CPU/latency; process peak RSS includes both. These are reference measurements, not thresholds. The [machine-readable report](2026-10-09-native-location-cost.json) retains every sample.

| Workload | Median lookup, former → current | Median CPU per 10 lookups | Median peak RSS |
|---|---:|---:|---:|
| 160 Cursor projects | 5.65 → 11.25 ms | 77.42 → 161.12 ms | 85.37 → 89.41 MiB |
| 160 Copilot process locks | 3.99 → 8.07 ms | 51.02 → 111.24 ms | 86.80 → 83.61 MiB |
| 4,200 projects, no match | 120.55 → 8.98 ms | 1448.01 → 131.17 ms | 97.00 → 93.91 MiB |
| 160 Grok sidecars, 60 KiB each | 30.02 → 122.90 ms | 351.90 → 1415.87 ms | 98.35 → 106.15 MiB |

The complete second inspection approximately doubles ordinary Cursor/Copilot lookup cost on this corpus. The deliberately large Grok sidecars cost about four times as much: bounded complete reads, file replacement checks and final workspace validation replace unchecked reads. Fixed-size digests prevent retaining all those sidecar contents. This stress corpus is not a typical workspace path size. At the directory limit, former code reported absence after scanning 4,200 projects; current code holds with its reason after the bounded scan.

Final local evidence: 1,942 core tests at 100% statements/branches/functions/lines per covered file; 265 master tests and one existing skip at 100%; 439 affected/architecture cases; two bundled native outage/recovery lanes; 57 private tmux cases and 15 explicitly excluded installed-vendor smoke rows; 313 serial resume tests at 100%; types; all 21 mutants assertion-caught. The failed coverage receipt remains failed; the passing core-only correction is recorded separately.

Main advanced to `a18b55e3b` through Desktop-only #1117/#1116. The conflict-free integration changed no CLI source, fixture, dependency or toolchain input. The passing coverage/types/resume receipts can be reused for the final documentation commit with their declared CLI+Store/toolchain scopes; no equivalent full suite is repeated.

Timing: baseline preparation began about 13:55 UTC; implementation and review corrections ended at 14:35, with a test-only coverage correction at 14:39. Local validation finished at 14:41:28, then matched measurement ran 14:42:38–14:42:57. Independent review overlapped those phases. Final automatic CI waiting and merge are recorded in the PR; publication is zero.
