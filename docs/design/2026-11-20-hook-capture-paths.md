# Reuse the provisional route while capturing a hook file

The V12 Close/Resume diagnostic recorded 320 directory-walk `lstatSync` calls
inside `inspectHookFile` in each eight-Resume arm. This nominates work; its
instrumented timing is not performance acceptance. The current function walks
the selected file, snapshots that route, then independently walks its parent
only to recover the directory name. It already has that provisional route.

## Design

- Read cost: give `directoryPath` the capture's existing `NativePaths` object.
  The file walk already visited the requested parent's components, including
  aliases and the first absent component. Reuse those provisional facts for
  the directory name. Keep the initial snapshot, descriptor and content
  checks, final fresh route/leaf verification and every later verification.
  This is local to one synchronous capture, never a successful-proof cache.
- Growth and concurrency: no new state, file, process, timer, API, export or
  dependency. Existing path depth, alias, byte and operation budgets remain.
  No proof crosses asynchronous work without its existing fresh fence.
- Scale: the removed reads grow with the already bounded parent route.
  Measure the actual capture on the same private files and pinned runtime,
  and retain all original-baseline Close/Resume holds pending integration.
- Audience and identity: no new authority or account access. A changed
  ancestor, alias, leaf, owner, mode or version still refuses the capture.
  Derive the requested parent, not the destination of a leaf symlink.
- Compatibility, migration and rollback: no stored or public contract
  changes. A revert restores the independent provisional parent walk.
- Failure: existing named refusals and deadlines remain. No new retry or
  fallback. Directory changes during capture must still fail before return.
- Platforms: shared TypeScript on macOS, Linux and Windows. Run local macOS
  checks and existing modeled Windows coverage; native Windows is deferred
  by the owner. Current Linux integration acceptance remains outstanding.

Selected checks: failing public-capture read-count cases for present, absent,
nested-absent and aliased paths; changed ancestry between snapshot and content
read; leaf-symlink directory semantics; freshness after capture; all hook-file,
native-path and setup callers; types; independent source review; fixed ABBA
capture cost against unchanged `ac267ae121` before production comparison.
