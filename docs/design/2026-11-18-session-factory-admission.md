# Session factory admission at read/reply boundaries

## Design

Core composition already creates one immutable factory-owner lookup from native `ENGINES` and build-owned
`SERVICE_HOSTS` declarations. Native launch and Cloud create use it. Two remaining read/reply checks still consult
a separate Cloud roster: prepared agent replies and device-list projection. They must use the same selected owner.

The Cloud wrapper binds reply admission to its existing `ownsFactory` predicate, in addition to the existing exact
requested/current engine, owner identity, creation time, physical connection and bounded-shape checks. The list
receives a predicate from the same composition lookup, excluding the existing native terminal engine; its device
projection uses that predicate. No component starts to answer the lookup, and a disabled declared component stays
declared while its operation port remains unavailable.

No stored record, wire field, public key order, list order, clipping, stopped/guest policy or terminal filter changes.
Unknown engines keep their existing field omission. The existing response-invalid failure and unavailable result
remain. Lookup state is the same frozen closure already created in composition; no second registry/cache is added.
Native Registry rows and Cloud publication/journal/provider state remain untouched.

The actual caller REDs remove a known native factory and/or the Cloud declaration from a selected lookup. The
device list must keep the same rows/order while omitting unowned engine fields, and a prepared rename reply for an
undeclared service factory must be refused before its rename event is sent. Valid full-build cases retain existing
serialized public bytes. Existing reply identity/physical-port, list guest/monitor/terminal controls remain in scope.

This deletes duplicated roster policy only. The Cloud row normalizer/public formatter and remaining common-owner
read boundary are still unfinished; this slice does not remove their architecture audit entry or resolve capacity.
No native/timing run is included. Source checks use Node 24.22.2 and existing immutable dependencies. Windows
execution remains deferred and mobile remains outside the refactor. Final combined packaged/cost acceptance is
coordinated separately.

## Evidence

Isolated source receipts under `/tmp/harness-core-session-factory-ownership/.harness/validation/`:

- `20261118T160357.138144Z-27593`: preserved fixture setup failure (two cases treated the `SERVICE_HOSTS`
  record as an array). Its 23 other cases passed; it is not the behavioral RED.
- `20261118T160446.278639Z-28559`: both corrected caller cases failed for the intended reason. The old list
  still exposed `codex`/`fo` engine fields excluded from the selected lookup, and the old reply admission accepted
  a prepared rename for an undeclared service factory.
- `20261118T160721.458668Z-31878`: final types PASS, 96 cases / 6 files including the architecture check PASS,
  and 9 selected socket-list cases PASS. Both changed core modules reach 100% lines/statements/functions/branches
  (206 / 276 / 84 / 339 total). Validation process groups settled. `git diff --check` passed.

The three runtime files change only injected selected-lookup admission; there is no new runtime state or wire-byte
format. The parent's packaged `46144f76b9` proof predates this roster slice, so it is not native validation of this
checkpoint. Parent coordinates the final combined build and acceptance; no source-only pass closes that hold.
