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

Claude process records must be complete and valid before a different PID/start can establish staleness. A current record contradicting the observed workspace holds. Every home's claim must agree, and the records are read again before publishing the pool. Bounded reads reject short reads and changed descriptors and reopen the path to detect atomic replacement. Existing verified conversation bindings keep their fast path. Stop captures identity before saving or signalling; a deferred Close retains its waiting intent and reason when native identity is unavailable, then retries.

The former-code goldens shared unrelated fixture files between observations. A separate fixture-only commit isolates Muse cases (retaining the age-test file), ages previous resolver fixtures before the fresh repair corpus, and removes only continuation-owned files before the next platform pass. Recording and verification on former production code passed with all three JSON artifacts unchanged. The comparison names the intentional safety deltas: unusable/contradictory Claude process records and four incomplete Muse identities now hold instead of returning absence. All other recorded observations remain exact.

The new regressions include hidden competing candidates, shared budgets, partial headers, invalid/current-but-contradictory PID claims, atomic replacement, two-home revalidation, sparse histories larger than a JavaScript string, private FIFOs, Stop before mutations, deferred Close retry, and a private bundled daemon whose held process does not block readiness or its sibling.

## Remaining native-identity work

This change does not claim that every native lookup is bounded yet. Strict process-lock/descriptor enumeration in `kit/sessionLocation.ts`, complete Hermes store-home/database pools, exact-ID traversal, and containment/retry at every binding and transcript-discovery entry point remain separate follow-ups. Those changes must preserve the same distinction between verified absence and unavailable evidence. Discovery currently reports a binding hold in the daemon log; a shared visible hold state remains part of the broader durable-intent work.

The existing synchronous compatibility readers remain for registry/history callers. Runtime cost is measured with the same private native corpus and Node toolchain on both trees using `cli/scripts/handoff-2026-10-08/identity-cost.ts`; line count is not an acceptance metric.
