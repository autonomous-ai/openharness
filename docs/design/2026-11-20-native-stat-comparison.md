# Native path identity comparison

The fixed V20 Close/Resume diagnostic still uses more core CPU in both orders.
V5/V6 profiles identify repeated native path verification as one contributor.
A frozen direct-comparison model preserves every fresh lstat/readlink and field
check while avoiding temporary identity/version strings. Across ABBA and BAAB,
plain and alias CPU falls 17.9–21.0%; main-thread and elapsed reductions exceed
the predeclared 15% threshold. This model is not production acceptance.

## Design

Compare the native BigIntStats fields directly for live, same-operation evidence:
device, inode, mode and uid identify a path; alias versions also compare size,
mtimeNs and ctimeNs. Keep serialized identity/version strings for wire and saved
facts, including their existing reboot/device treatment. Apply the same comparison
to grouped-route conflicts and fresh retained-route verification. Keep every read,
readlink, deadline, work charge, refusal reason and absent-path rule unchanged.

Growth: no new retained state, cache, descriptor, timer or runtime file. Existing
bounded path maps remain. Concurrency: the same synchronous evidence passes and
publication fences; no reordering or removal. Read cost: the same fresh reads,
less temporary string allocation. Scale: unchanged256-fact/32-route bounds and
existing evidence deadlines. The caller benchmark measures CPU and elapsed;
whole-workload acceptance remains separate and currently held.

Compatibility and migration: no wire, saved format, version or caller change.
Rollback is a revert. Audience and identity: unchanged; no new data exposure or
account authority. Failure: the same named refusal paths and exception handling.
Platforms: shared macOS/Linux/Windows logic; native macOS here, platform path
fixtures included, native Windows deferred by the user.

## Validation plan

First preserve caller field contracts for ordinary ancestors, aliases and grouped
observations; these behavior tests should pass before and after this performance
change. The failing criterion being addressed is measured CPU cost, not an invented
functional defect. Run the broader native path, hook publication, descriptor,
checkpoint and launch safety tests, TypeScript and independent source review.
Then measure the actual committed source using the frozen model workload without
the model replacement. Do not transfer model percentages to production or claim
that this small change alone closes the whole-workload hold.
