# Launch preparation and durable holds

Former-code baseline, recorded before implementation: main `ee33093971d27e9dcda7f2ae8c35f54b61cec0bb`. The native OpenCode, grid/saved API and DSH launch goldens were re-recorded under UTC and `/tmp`, with the existing pinned Linux platform, private homes and binary placeholders. All three artifacts are byte-for-byte identical to main. Recording passed in 28.7 seconds, followed by verification with recording disabled in 28.7 seconds (six tests across three files).

Artifact SHA-256:

- `opencode-launch.golden.json`: `f5985028ccaa7c363389a482471d0ad6d97c27b9140e537a0698e380a86779b1`
- `launch-shapes.golden.json`: `ba6f25ebdf3cb56bb930d603d938830d93ef09939208aa59b7ffb29d2d8be9de`
- `dsh-launch-shapes.golden.json`: `d523f9b50b9ed6b5f33aee2222035aeda085bdd7a4d74c7afeb4c05c1710e9bd`

The launch-port design's older refusal policy for manual operations is superseded by the current requirement: an unavailable dependency must hold the intent with a visible reason, without failing or half-writing it. Session control and readiness stay independent. Preparation must use confirmed executable facts, preserve operation authority across awaits, and publish only confirmed effects. A durable journal must distinguish safe retries from unconfirmed mutations. These are safety changes following the compatibility extractions, not line-count targets.

Validation will preserve the former golden artifacts, add regressions for the new guarantees, deliberately break wiring, run the affected private-daemon lanes and enforce TypeScript, architecture and per-file core/master coverage. Independent exact-head review and automatic CI precede each merge. No release is authorized.

The first implementation introduces a preparation/commit boundary for relaunch overrides. Models answers before the Store is asked; profile hooks and grid configuration wait until both answers succeed. One deep request snapshot and one machine-fact snapshot supply the attempt. Core instruction-file preparation and saved-API notes wait for success. The Store opens SCM instruction files only inside its durable workspace reservation, immediately before the package writes them; an unavailable or uncertain Store causes no earlier core SCM edit. Fresh create and fork likewise defer their own saved-API instruction work.

This step does not yet journal a manual create/fork/restart/retarget intent, make grid writes atomic, or solve retarget authority and native-write uncertainty. Those remain required. In particular, callers still need a durable held outcome instead of converting unavailable-service answers into ordinary failure receipts. Successful former golden observations must remain unchanged through this staging change.
