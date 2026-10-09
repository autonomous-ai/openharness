# Bounded native identity discovery

Former-code baseline: main `b6e15e10c7dee075b8db098647bb5b4ffca56d83`. The repair-identity, other-identity and session-store goldens were re-recorded before implementation under `TZ=UTC TMPDIR=/tmp`, with their pinned platform, clock, homes and process fixtures. Recording passed in 28.0 seconds; verification with recording disabled passed in 27.6 seconds. All three artifacts are byte-for-byte identical to main. The subsequent launch-preparation merge changes none of these identity inputs.

Artifact SHA-256:

- `repair-identity.golden.json`: `0de8c0b227abaf0efc909cda0d4f627c3434dea2234659757e5dda5bc6c1b3c8`
- `other-identity.golden.json`: `deab341a2808e65e1a2fa23c67144d247850f39771ef09497a2e1024f7ce9eb6`
- `session-store.golden.json`: `dd3be450efddfae1c9336f82e0e71225fa741c17399297ed44ef0b24e95fc236`

The next safety change replaces truncated evidence with an explicit incomplete result. A directory scan that stops at a count or depth bound cannot prove a unique conversation. Native metadata reads must be bounded and a cut or unreadable record must not make another candidate look unique. Known excluded subagent directories remain excluded. Exact process evidence remains available independently of optional readers; discovery isolates an incomplete lookup so other sessions and readiness continue.

Validation preserves these former artifacts, adds incomplete-scan and large-file regressions, deliberately breaks the actual wiring, and runs types, architecture, core/master coverage, affected identity/Stop/resume tests and private bundled lifecycle lanes. Independent exact-head review and automatic CI precede merging. No release.
