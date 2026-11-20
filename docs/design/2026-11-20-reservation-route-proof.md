# Recheck complete destination routes without rebuilding them

Status: corrected source approved; actual-source measurements pending. Parent ae88587dfa.

V6 counts-only profiling found 2,064 Resume lstat calls in destination route reconstruction and another 2,064 in its grouped final fence. V21 showed request CPU and wall regressions; its timings do not isolate this helper. The full release remains held.

For at most 32 destinations whose complete parent/alias routes were already observed, retain a union of at most 256 immutable route facts. Each verification reads those facts and every physical writable leaf twice, using one fresh bounded budget. The first pass captures leaf identity; the second rejects replacements, appearance, disappearance or a new alias within that check. Between checks, ordinary writable leaves may be created or replaced as today. Every retained alias and ancestor must keep its original identity/version. No final fence, caller guard, filesystem flush or source dependency is removed.

Final-component aliases, incomplete routes, conflicting observations and larger unions keep the existing bounded reconstruction path. Both passes remain necessary: a later sibling can replace an ancestor an earlier read already checked. Stored facts still ignore device numbers for reboot compatibility. Within one check, a local bounded map also requires each ancestor/alias device to remain unchanged across both passes; leaf identity includes the device. Public keys are returned as a copy so callers cannot change the private leaf set. This preserves the dangling-target refusal.

## Design

- Growth: bounded operation-local facts; released with the existing preparation proof. No global cache, timer, service, runtime dependency or new core file.
- Concurrency: existing destination reservations and native identity guards remain; every invocation reads the filesystem afresh, including nested checks.
- Read cost: two fresh passes; shared aliases are read once per pass, not once per destination plus a final pass. Unknown ancestry retains the old walk.
- Scale: at most 32 leaves and 256 union facts; above this use the existing bounded algorithm. Validate work and deadline limits.
- Compatibility: no stored format, protocol, public contract or backend change.
- Migration and rollback: no migration; revert the helper change.
- Audience and identity: existing local account ownership and alias authority unchanged; no new caller or account exposure.
- Failure: existing named route/identity refusals; unreadable metadata remains a refusal.
- Platforms: shared TypeScript for macOS/Linux/Windows; no process spawning. Native Windows testing remains deferred by the user.

## Validation

First run the caller controls against the unchanged implementation: the shared-alias read bound must fail and integrity controls must pass. Then run the affected hook, launch and architecture checks plus typecheck. Independent review covers the combined source and mutation controls. Measure actual committed sources in fixed ABBA+BAAB order, with capture reported separately/excluded from verification timing, no discarded samples or retries. Retain the optimization only with at least 15% CPU, main-thread and wall gains for ordinary and aliased complete routes in both orders; report missing-leaf and missing-parent controls. This helper measurement cannot clear full Close/Resume or other release holds.


Review correction: initial source review held the patch for dangling final aliases and a mutable returned key array. Caller tests reproduced both failures; a third RED reproduced within-call ancestor device drift. The correction preserves all three checks. Receipt 20261120T070957.528491Z-30756: 63 PASS, 3 expected failures before correction. The initial shared-alias work RED is 20261120T070515.046032Z-26713 (58 PASS, 1 expected failure). Broad initial caller check 20261120T070745.025813Z-28859 passed 856 tests plus types; final evidence must follow these corrections.


Corrected source review 20261120T071107.528715Z-31862: APPROVE_SOURCE, no blocking findings. Corrected 32-file check 20261120T071032.525036Z-31418: 860 PASS, 8 intentional skips, typecheck PASS. Final added controls cover a mixed final-alias destination set and saved-device tolerance on a complete plain route. The conflicting-capture control now makes the first capture disagree, so silently keeping the final capture cannot pass. Runtime unchanged after the approved review. These are scoped correctness results; no performance or release acceptance is claimed.
