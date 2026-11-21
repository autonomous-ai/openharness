# Journal the checkpoint destination with export settlement

Status: implemented and source-reviewed; lifecycle cost validation pending. Parent b6fd0c729b. Independent design review: 20261120T072419.977265Z-43636, APPROVE_DESIGN with the five conditions below. No full performance or release approval.

A database checkpoint currently flushes its owner four times: initial reservation, writer, settlement, destination. The unique destination is already selected before acquisition. Bind it at acquire and persist it with the existing settlement update. Publication then checks the confirmed owner record without another write. Keep both full database exports around Close, all data flushes, the history pin, every owner and session guard, and the bounded actual I/O custody.

## Design

- Growth: existing four slots and <=1024-byte owner records; one fixed destination and one confirmed text per lease; no new collection, core file, service, cache, timer, dependency or setting.
- Concurrency: existing slot and lease identity, owner-write/verification/publication guards and Close admission; each destination is immutable for its lease. Actual operations retain descriptors after reply timeout.
- Read cost: replace a redundant write/flush with a bounded fresh owner read. Neither source exports nor source/manifest/identity validation are skipped.
- Scale: existing four slots, one-GiB stage limit and 30-second deadline remain; failures hold uncertain slots with STAGE_CLEANUP_UNAVAILABLE.
- Compatibility: same existing version2 owner shape (settled:true plus optional destination), old version1/2 records still recover. No IPC, backend or client protocol change.
- Migration and rollback: no migration; old recovery already handles destination intent before a link. Revert uses the same record shapes.
- Audience and identity: core selects the private destination; worker still receives only the stage path/key. Existing account ownership, private modes, native root checks and generation proofs remain; no names/content in logs.
- Failure: failed or uncertain writes never grant publication. Destination absent removes only the safe stage; orphan and committed links keep their existing pin/manifest proof; a foreign destination is preserved and the slot held.
- Platforms: shared TypeScript on macOS/Linux/Windows; Windows retains secure owner reads and fresh named identity without comparing a stored pre-close ctime. Native Windows testing remains user-deferred. No process launch changes.

## Binding correctness conditions

1. Bind and validate the private parent and history filename before any mkdir. Publish takes only the current-authority guard and always uses that destination.
2. The in-memory owner is intent, not durability. Clear its confirmed text before an update, then confirm the exact written text only after the actual flush, verification and required owner close succeed. A failed settlement cannot publish even if matching bytes are visible. Settlement remains retryable.
3. Require confirmed settlement for every publisher, including in-process fixtures with no assigned writer. Do not invent a PID for them.
4. After the actual history descriptor close, synchronously check slot identity, exact confirmed owner bytes/inode/private mode/nlink and named/held versions, then stage version and allowed/current guards, then link. No await in this segment; no authority callback after a refused owner fence.
5. Preserve generation-safe recovery, failed-link retry to the same destination, no foreign unlink and descriptor/callback custody through timeout.

## Validation

First reproduce the missing destination at the confirmed-settlement caller boundary and the redundant owner flush count. Then exercise all stage asynchronous, durability, generation, owner handle/read controls, session checkpoint/SQLite WAL behavior, storage and Close/Stop callers, plus types. New controls cover matching bytes after failed flush, exact same-lease rewrites, owner change during history close, invalid target before mutation and crash after settlement before verification. Independent source review and actual stage lifecycle measurements follow; no timing alongside tests/build/review. Full Close/Resume and other release holds remain.

## Evidence

- Before the runtime change, the caller-boundary destination and owner-flush controls both failed (20261120T073342.646167Z-52049); both passed afterward (20261120T073507.380080Z-53166).
- The 15-file checkpoint/storage/Close/Stop group passed all 448 tests, including real SQLite/WAL exports, and type checking (20261120T073943.839091Z-57155). The final short-record/truncation control and types passed (20261120T074116.404556Z-58426).
- Independent source review approved the runtime (20261120T074159.247731Z-59110). Its requested publication-cancellation, private-owner link/mode, and portable-filename test corrections passed: 60 tests across three files plus types (20261120T074714.628972Z-63680). The first control run caught a wrong expected error string in two new tests; both correctly refused the unsafe owner. No runtime change was required. POSIX mode control is explicitly skipped on Windows.
- Owner durability is three actual flushes per export, previously four. Both full database exports remain. Stage lifecycle and full Close/Resume timing still need measured evidence; no performance or release clearance is implied by source approval.
