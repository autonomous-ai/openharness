# Checkpoint capture fences

Status: source independently approved and caller tests passed; matched cost pending.

The production Close/Resume diagnostic at `6e81658b06` completes eight cycles
per side (receipt `20261120T030427.495986Z-98610`). Close makes 4,296 `lstat`
calls versus 66 before extraction. Its instrumented core CPU is 145 versus
103 ms per cycle. These timings include observer overhead and are diagnostic,
not acceptance evidence. Independent source review identifies repeated route
verification immediately after capture, with no intervening effect or await.

## Design

- Growth: no persisted data, cache, timer, new module or dependency. Native file
  groups retain their three-file limit and existing operation and byte budgets.
- Concurrency: capture keeps its pre-open route check, one complete route check
  after all descriptors close, and the final leaf-version checks. Every later
  `verify()` still checks the route and all leaves afresh. No proof crosses an
  await without another verification.
- Read cost: `NativePaths.retain()` already verifies its captured route. Initial
  file observation need only verify the leaf versions after that check. A plain
  database checkpoint's fresh capture then returns that already checked group.
  OpenClaw retains the additional full check after its separate location-proof
  callback: that callback must not separate the final file check from return.
- Scale: work remains bounded by the existing native-evidence budgets. Actual
  filesystem-call regression cases distinguish initial capture, fresh capture
  and every later verification. Matched CPU/wall evidence precedes acceptance.
- Compatibility, migration and rollback: no API, wire or saved-format change.
  A revert restores the extra reads. Existing clients are unaffected.
- Audience and identity: selected native routes, aliases, descriptors, owner,
  mode, link count and file versions remain checked. No SQL moves into core.
- Failure: all existing named refusals remain. No retries or relaxed deadlines.
- Platforms: shared macOS/Linux/Windows source. Local macOS validation; final
  integrated Linux native check remains required. Native Windows is deferred
  by the owner.

Selected checks: baseline RED for duplicate reads; changed ancestor, absent
sidecar appearance and post-read leaf changes before return; returned-proof
freshness and OpenClaw callback changes; existing native/checkpoint callers and
typecheck. Final source needs independent review and matched cost evidence.

Baseline receipt `20261120T031251.873721Z-10160` has exactly three expected
read-count failures and 20 passing adversarial controls. The corrected source
passes 501 tests across 20 caller/boundary files plus typecheck, receipt
`20261120T031346.802268Z-11003`. Independent source review approves the complete
fence sequence, including retaining OpenClaw's post-callback file verification.
