# Bounded native identity discovery

Former-code baseline: main `b6e15e10c7dee075b8db098647bb5b4ffca56d83`. The repair-identity, other-identity and session-store goldens were re-recorded before implementation under `TZ=UTC TMPDIR=/tmp`, with their pinned platform, clock, homes and process fixtures. Recording passed in 28.0 seconds; verification with recording disabled passed in 27.6 seconds. All three artifacts are byte-for-byte identical to main. The subsequent launch-preparation merge changes none of these identity inputs.

Artifact SHA-256:

- `repair-identity.golden.json`: `0de8c0b227abaf0efc909cda0d4f627c3434dea2234659757e5dda5bc6c1b3c8`
- `other-identity.golden.json`: `deab341a2808e65e1a2fa23c67144d247850f39771ef09497a2e1024f7ce9eb6`
- `session-store.golden.json`: `dd3be450efddfae1c9336f82e0e71225fa741c17399297ed44ef0b24e95fc236`

The next safety change replaces truncated evidence with an explicit incomplete result. A directory scan that stops at a count or depth bound cannot prove a unique conversation. Native metadata reads must be bounded and a cut or unreadable record must not make another candidate look unique. Known excluded subagent directories remain excluded. Exact process evidence remains available independently of optional readers; discovery isolates an incomplete lookup so other sessions and readiness continue.

Validation preserves these former artifacts, adds incomplete-scan and large-file regressions, deliberately breaks the actual wiring, and runs types, architecture, core/master coverage, affected identity/Stop/resume tests and private bundled lifecycle lanes. Independent exact-head review and automatic CI precede merging. No release.

## Implementation boundary

File-backed live repair now streams directory entries with one entry/file budget across all known homes. An unfinished walk, unreadable candidate, missing or cut header, nonregular file, or changed identity record holds the lookup. Native header readers use bounded asynchronous I/O; Copilot no longer reads an entire transcript. Codex repair uses a strict first-record reader while registry/history compatibility readers retain their existing nullable API. Declared child directories and verified other workspaces remain excluded.

Claude process records must be complete and valid before a different PID/start can establish staleness. A current record contradicting the observed workspace holds. Every home's claim must agree, and the records are read again before publishing the pool, with the selected claim read last. The known-home set must still match. Missing directories consume the traversal budget and more than 64 known homes holds before native probes. Bounded reads reject short reads and changed descriptors and reopen the path to detect atomic replacement. Existing verified conversation bindings keep their fast path. Stop captures identity before saving or signalling; a deferred Close retains its waiting intent and reason when native identity is unavailable, then retries.

The former-code goldens shared unrelated fixture files between observations. A separate fixture-only commit isolates Muse cases (retaining the age-test file), ages previous resolver fixtures before the fresh repair corpus, and removes only continuation-owned files before the next platform pass. Recording and verification on former production code passed with all three JSON artifacts unchanged. The comparison names the intentional safety deltas: unusable/contradictory Claude process records and four incomplete Muse identities now hold instead of returning absence. All other recorded observations remain exact.

The new regressions include hidden competing candidates, shared budgets, partial headers, invalid/current-but-contradictory PID claims, atomic replacement, two-home revalidation, sparse histories larger than a JavaScript string, private FIFOs, Stop before mutations, deferred Close retry, and a private bundled daemon whose held process does not block readiness or its sibling.

## Remaining native-identity work

This change does not claim that every native lookup is bounded yet. Strict process-lock/descriptor enumeration in `kit/sessionLocation.ts`, complete Hermes store-home/database pools, exact-ID traversal, and containment/retry at every binding and transcript-discovery entry point remain separate follow-ups. Those changes must preserve the same distinction between verified absence and unavailable evidence. Discovery currently reports a binding hold in the daemon log; a shared visible hold state remains part of the broader durable-intent work.

The existing synchronous compatibility readers remain for registry/history callers, and the shared saved-home catalog still uses its legacy synchronous loader. Bounding that catalog read is a remaining prerequisite for a fully bounded native lookup path; the per-lookup home/probe cap here does not claim otherwise. Runtime cost is measured with the same private native corpus and Node toolchain on both trees using `cli/scripts/handoff-2026-10-08/identity-cost.ts`; line count is not an acceptance metric.

The [cost record](2026-10-09-bounded-identity-cost.json) compares the former production tree at `62cc1cc4343b05c7c800f614ba9254f7cadf7990` with the corrected implementation at `cc6470abef447662b6a790a7fc32e9b49b66efb0`. Three interleaved processes per source/workload perform ten lookups each. The corpus includes 160 ordinary files, 420 files for incomplete-pool behavior, and 64 known homes for empty-home probe cost. These measure a warm filesystem cache; process peak RSS includes setup and module import, while lookup latency/CPU exclude them. This is a reference measurement of the safety cost, not a new numerical acceptance threshold.

## Validation and measured cost

The final production change is `9d79c4607`; `40b30bbbd` only canonicalizes private test paths on macOS. Integration with main `576ae7246` changes Desktop and TUI only. No CLI/Store validation input or production behavior changed in that integration.

- Core/services: 1,930 tests, 100% per-file coverage (receipt `20261009T133531.927972Z-92550`).
- Master: 265 passed, one existing skip, 100% per-file coverage; types and 244 affected identity/architecture tests passed (receipt `20261009T133800.424067Z-8569`).
- Resume: 313 tests and 100% coverage, run alone (receipt `20261009T134355.238968Z-36854`, 48.5 seconds).
- Bundled private lifecycle: six selected tests passed, including incomplete native identity, manual start/resume, and Codex tmux-crash resume (receipt `20261009T133531.927972Z-92550`, 67.4 seconds). Twenty tests outside those selected lanes were skipped.
- All 18 deliberate wiring mutations failed by assertion after a passing unchanged baseline. All three former-code golden artifacts remain unchanged.
- Cost comparison: 24 interleaved processes, 14.2 seconds (receipt `20261009T134506.715167Z-47079`).

The initial final-production run exposed a macOS-only test fixture path mismatch and an unrelated existing master-test flake: its polling reader observed an incomplete JSON log append. The fixture correction, affected specs, types and full master coverage gate passed on rerun. Passing core and bundled e2e evidence is retained because the intervening correction changed only test paths. A mistyped resume receipt argument stopped the runner before tests; the corrected invocation passed.

Latency below pools all 30 lookups per source/workload. CPU is per ten lookups; RSS is process peak including imports and corpus setup.

| Workload | Former median / p95 ms | Candidate median / p95 ms | Former / candidate CPU ms | Former / candidate RSS MiB |
| --- | --- | --- | --- | --- |
| pool | 36.06 / 42.83 | 55.31 / 65.37 | 506–508 / 776–833 | 101.7–103.7 / 99.0–104.3 |
| process | 0.34 / 1.45 | 0.69 / 2.26 | 5–5 / 10–10 | 94.2–94.8 / 92.4–94.0 |
| limit | 86.53 / 101.22 | 12.72 / 14.91 | 1206–1219 / 179–184 | 105.2–105.8 / 100.8–105.3 |
| homes | 0.39 / 1.82 | 5.61 / 7.81 | 8–9 / 84–85 | 90.8–91.8 / 96.9–98.3 |

The 160-file pool and exact process lookups keep the same answer. The 420-file case changes from an unsafe absence to an explicit hold. The 64-home case checks every claim and revalidates the selected one instead of stopping at the first claim; that completeness accounts for the added work. These are local reference measurements, not guarantees or new performance gates.

For this follow-up, implementation and diagnosis ran from approximately 12:48 to 13:38 UTC on October 9; validation overlapped that work and finished at 13:45, including the final isolated resume lane and cost measurement. Independent review and CI waiting are tracked separately in the PR, followed by merge time. Publication is excluded: no release is authorized. The overall daemon-separation request began at 23:26 UTC on October 8; this follow-up is one part of that work, not its total duration.
