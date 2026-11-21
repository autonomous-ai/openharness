# Existing hook route verification

The Close/Resume diagnostic finds repeated hook route reconstruction, snapshots
and metadata reads. A fixed ABBA/BAAB model of existing paths reduces CPU by
21–25% while retaining two fresh route passes and the final file-version read.
This is a verification-only model, not production or whole-workload acceptance.

## Design

- Growth: use the immutable route facts already retained by an observation; no
  additional persistent facts, file handles, caches, timers or dependencies.
- Concurrency: only a bare verification of a completely observed existing route
  uses those facts directly. Check every fact twice, freshly, before the final
  leaf-version check. A replacement at a child or leaf read must still revoke an
  earlier ancestor. The one-pass proposal was rejected for violating that rule.
- Read cost: preserve the two metadata passes, but avoid rebuilding a route map,
  generator and snapshot arrays. Shared provisional-directory passes and absent
  routes keep the existing algorithm, including ordinary parent creation.
- Scale: the existing 256-fact bound, path validation and work deadlines remain.
  Measure the actual implementation and the complete workload before acceptance.
- Compatibility: the same retained identity, owner, mode and alias target/version
  checks apply. No schema, public API or admission rule changes are intended.
  Both passes use the retained fact's device-independent identity, as the prior
  retained comparison did. Unlike the old walk-to-snapshot check, they do not
  separately compare device numbers between the two passes. The old verifier
  already allowed such a device change before its walk; accepted final states
  remain the same. The selected leaf's final version still includes its device.
- Migration and rollback: no migration; revert restores route reconstruction.
- Audience and identity: no network or account changes; the same selected file
  and account ownership remain required at every effect and acknowledgement.
- Failure: retain named native-identity failures, independent nested verification,
  missing-route handling and final publication checks. No fallback masks failure.
- Platforms: shared macOS/Linux/Windows logic. Validate native macOS and portable
  Windows fixtures; native Windows remains explicitly deferred by the user.

The initial test records unnecessary route reconstruction through the public file
observation while requiring both fresh ancestor passes and the final leaf read.
Existing actual ancestor-replacement, alias, ownership, publication and deadline
controls remain mandatory. The implementation and matched costs require review.
