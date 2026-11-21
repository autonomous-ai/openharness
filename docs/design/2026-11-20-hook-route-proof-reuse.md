# Reuse provisional ancestry inside one hook proof

Status: source and matched helper cost accepted; whole-daemon acceptance remains open.

The retained V18 Resume workload still costs more core CPU than the main baseline.
The subsequent diagnostic (`/tmp/core-resume-cpu-profile-v3-results`, receipt
`20261120T022208.337873Z-58012`) retains eight complete Close/Resume cycles per
side. Its Resume-request interval makes 4,718 synchronous `lstat` calls on the
baseline and 16,152 on the candidate. Inspector stacks identify native hook
destination verification, including `directoryPath`, among the extra work.
The diagnostic's wrappers add overhead; its times are not acceptance numbers.

When a settings destination is absent, `hookPreparationRoutes` has already walked
its existing ancestors. Its fallback then walks those same ancestors again to
find the canonical parent. Each missing parent starts yet another walk. These
reads are provisional: the caller still verifies every retained path after the
walks. They can share that caller's current `NativePaths` observation.

## Design

- Growth: no stored format, cache, timer, dependency or new core module. The
  observation ends with its existing synchronous proof; existing path, byte and
  sibling limits remain. The shared directory map remains capped at 256 entries.
  Reused fallback walks consume the same 32,768-step observation budget. A
  pathological unresolved route with 181 existing and 181 missing levels is
  refused at verification before publication; 128 plus 128 levels remains
  accepted. Deterministic caller cases pin this bounded behavior. The former
  fallback started a separate budget at each climb.
- Concurrency: reuse only the paths from this invocation, before its final fresh
  snapshot. No proof crosses an await or survives into a later verification.
  Every later call and nested verification starts its own observations.
- Read cost: a missing descendant reuses its already observed ancestry when
  deriving the canonical target. The grouped final snapshot still reads every
  unique path again, including aliases and absent entries. Snapshot comparisons,
  leaf-version checks and every publication/durability fence remain.
- Scale: the same 32 destinations and 256-component limits apply. Regression
  cases count actual filesystem reads for sibling missing files and directories;
  the shared ancestor needs one provisional read and one final read per route
  verification. No timing threshold is introduced into unit tests.
- Compatibility: wire contracts and files are unchanged. Existing and missing
  destinations must resolve to the same canonical keys. Reuse is confined to
  `verifyRoutes`, whose grouped snapshot checks all fallback facts immediately.
  Initial capture keeps its existing file-walk fact domain: on POSIX a parent
  fallback can transiently observe `/`, which a later walk does not revisit
  after a missing descendant appears. Capture and file observations continue
  using their existing independent fallback behavior.
- Migration and rollback: N/A because no persisted state or public API changes.
  Reverting restores the extra reads.
- Audience and identity: unchanged. Native aliases, owner/mode, file identity,
  sibling replacement and preparation cancellation continue to revoke authority.
- Failure: unchanged named native-evidence/preparation refusals; no new retries.
- Platforms: shared CLI code for macOS/Linux/Windows. Validate macOS locally;
  Linux native evidence belongs to the final integrated head. Native Windows
  remains deferred by the owner.

Selected checks: actual caller RED for the extra missing-path reads; adversarial
missing-parent replacement/alias cases; existing native path, hook preparation,
publication, launch and setup authority suites; TypeScript and affected coverage.
Independent review and matched before/after measurements must precede acceptance.
This slice does not claim to resolve the separate Close/checkpoint cost.

## Review corrections

The initial wider attempt also reused ancestry while capturing file observations
and reservations. Review found that this could retain the POSIX root from a
parent fallback even though later file walks omit it. One reproduced regression
refused an alias directly to root; a second refused a newly created descendant
and changed the refusal for an unbound literal root-level file. Both sets of
cases pass on the original source. The final change confines reuse to the
measured repeated route verification, keeping initial capture exactly as before.
The regression cases remain, alongside all missing-parent and alias controls.

## Local acceptance

At `6e81658b06`, 805 caller tests plus typecheck pass (eight skips); the final
focused file passes all 48 cases, including the bounded-depth cases required by
independent review. Baseline read counts fail six intended assertions.

The fixed eight-arm ABBA/BAAB helper comparison against `1149e34684` retains all
four scenarios and 512 verifications per scenario per arm. Across the measured
windows, pooled process CPU falls 37.65%, main-thread CPU 40.78%, and elapsed time
40.93%; both run orders improve. The unchanged existing-file control is nearly
flat (pooled CPU +0.24%, elapsed +0.38%; opposite CPU directions by run order).
All arms exit normally and verify pipe, process-group and private-fixture cleanup.
Receipt: `20261120T030001.074983Z-94571`.

The production diagnostic at the same source completes eight Close/Resume cycles
per side. Resume-request `lstat` calls fall from the prior candidate's 16,152 to
12,696. This is diagnostic call-count evidence, not a cross-run CPU comparison.
Whole Close/Resume cost and integrated Linux native acceptance remain open.
