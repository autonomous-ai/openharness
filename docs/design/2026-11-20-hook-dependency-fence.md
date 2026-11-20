# One dependency check per hook verification

Status: implemented and independently source-reviewed; 882 caller tests pass
(8 existing skips), with TypeScript passing. Matched cost and integrated native
acceptance remain pending.

The production diagnostic still attributes Resume work to hook route verification.
Independent source review identifies another duplicate: `runHookPreparation` checks
its dependency callback both before and after reading destination metadata. Shared
publications pass the parent verifier as that callback, multiplying these reads.

## Design

- Growth: no cache, record, setting, module, dependency or timer. Existing limits
  on preparations, destinations, paths, waiters and bytes remain.
- Concurrency: keep the owner/deadline check before metadata inspection. Keep all
  destination route and observed-file checks. Verify dependencies after those
  reads, then check the owner/deadline again before returning to any effect.
  No write, open, flush, await or callback that consumes authority occurs between
  the removed dependency check and the retained one. Production observation
  callbacks only inspect metadata (`inspectHookFile.verify` and native path facts).
- Read cost: one complete dependency proof per verification; nested preparations
  no longer duplicate the parent's dependency proof at each nesting level.
- Scale: existing preparation bounds are unchanged. Count actual filesystem reads
  at the dependency in ordinary and nested callers, then measure matched CPU/time.
- Compatibility, migration and rollback: no API, wire or saved format changes.
  Reverting restores duplicate reads. If both a destination and dependency are
  invalid, the destination's named refusal may be reported first.
- Audience and identity: no authority cache. Replaced dependencies, changed
  destinations and revoked owners still refuse before effects or acknowledgement.
- Failure: existing refusals, deadlines and cleanup remain; no new retries.
- Platforms: shared CLI code, macOS local validation, final integrated Linux
  native check required, native Windows deferred by the owner.

Selected checks: baseline RED for ordinary/nested dependency reads; dependency
mutation and owner revocation during metadata reads; existing hook publication,
shared-file, cancellation, flush/durability and native launch callers; typecheck,
independent source review, matched cost. Whole-daemon acceptance remains separate.
