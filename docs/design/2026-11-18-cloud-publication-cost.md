# Cloud publication cost correction

## Evidence and scope

The fixed v2 source/relayed-IPC comparison showed unchanged retained reconnect rewriting and retransmitting an already accepted 1,600-owner image eight times: 20.99 MB of state writes and 16.71 MB of query traffic. Core CPU increased from 241.5 to 300.6 ms; combined CPU from 364.8 to 1,017 ms. Connected work also rose substantially (64 publications: 3,288 to 8,524 ms combined CPU, 80.33 to 286.32 MB state writes). These are three-sample descriptive source fixtures, not native transport or p95.

The separately approved two-arm CPU diagnostic preserved exact output and write/query counters. Samples identified component sizing/diff, fingerprints, persistence and journal checksums, with fixture byte/IPC work reported separately. `persist()` captures identical journal state twice; unchanged reconnect forces row publication after its readback already proved the same accepted image. Evidence: `/tmp/core-cloud-publication-cost-measured-v2-20261118`, `/tmp/core-cloud-publication-profile-run-20261118` (manifest `c079ea683850f49eb5fa4f27a329f62772a85669a4af31d68f58a8dc3dcc6ef0`). These packets remain frozen.

## Design

Only an intact journal and a proven retained **nonempty** core can take the no-change path. Recover accepted-before-pending exactly as before, then normalize and bound the current complete provider snapshot, including duplicate/malformed rows and image limits. If its full ordered fingerprint equals the recovered authority, populate the existing component `wire`/`projected` maps and byte accounting, omit the redundant row publication and state rewrite, and replay current questions through the same bounded ordered queue. Every question still reaches final current-service/owner admission.

The preceding intent was durable before core accepted this image. No new state exists to persist. A pending-match recovery may therefore leave the existing pending journal on disk: another component restart proves the same pending match again. An accepted-match recovery keeps its accepted-first precedence even if an older unapplied pending image remains. The next real provider save or changed publication writes the current recognized state through the existing writer. No journal entry, provider session or notification history is guessed or discarded.

| Path | Behavior |
| --- | --- |
| Intact journal, retained nonempty core, identical validated snapshot | Seed existing component maps/accounting; no row publication/write; current questions replay. |
| Snapshot differs | Existing bounded journal-before-send publication and ACK progression. |
| Missing/corrupt/unmatched journal with nonempty core | Existing named unavailable hold; no output or quiet reconstruction. |
| Empty/replacement core | Existing quiet initialization/metadata repair, including invalid presentation metadata; provider state is never erased. |
| Stale physical connection/read result | Existing generation/current-service refusal; no later output under stale authority. |
| Future change after a skip | Normal row delta/removal and card preparation from the recovered accepted state, with durability before send. |
| Persist fails | Do not change the durable journal reference or send the publication. |

`persist()` captures one checksummed value, passes it to its synchronous writer, and records that exact value as durable only after success. It does not cache a checksum across mutations, reduce any changed-state write or introduce a second store. The saved provider format, checksum format, queue/image/reservation bounds, optimistic-provider-state separation, reconnect semantics and whole-cohort rollback remain unchanged. No core map, receipt, history or catalogue is added.

This is component-only runtime work. It changes no public client bytes, provider operation, user/account authority or terminal session path. Active state stays bounded by the existing 64 actions/6 MiB and snapshot limits; map lifetime is still one component connection and updates replace current owners. No production-data migration is required. The code runs on macOS/Linux/Windows; macOS source validation is used here and Windows execution remains deferred by the user. Mobile is outside scope.

## Validation

RED first against the actual Cloud service/core: accepted-match and pending-match unchanged reconnects must perform no publication or state rewrite; repeat component restart without a new write and prove a later completion still arrives once. Cover question replay, seeded-map future changes/removals, malformed/oversized snapshots, generation revocation, accepted/pending ambiguity and all existing crash/recovery controls. Reuse the published fixtures and one test worker. A new matched cost comparison requires reviewed exact before/after pins and revised expected no-change counts; original timing is not reused as optimized evidence. Native proof waits for the parent's final combined artifact. Wider connected/store changes are not part of this correction.


### Source evidence

Pinned Node 24.22.2 and the existing immutable dependency tree, one Vitest worker:

- Corrected physical-reconnect RED: `20261118T084126.069991Z-97674` — all three new cost assertions failed on redundant publication. The earlier `20261118T083831.997899Z-94931` also preserves a mistaken immediate restart-question assumption; that fixture was corrected to the existing physical-reconnect lifecycle before the valid RED.
- Focused GREEN: `20261118T134800.528441Z-12610` — accepted/pending repeated restart and physical-question replay all pass with no extra publication or file write.
- Broad affected evidence: `20261118T134928.863315Z-14030` — types pass, 267 of 268 cases pass in 17 files. One newly added restart-question assertion incorrectly compared the old payload request ID; runtime correctly minted the new ID. The failed receipt remains intact.
- Corrected two-file slice: `20261118T135054.572475Z-15943` — all 50 cases and types pass; the selected 100% coverage gate fails because the narrowed slice omits two previously covered lifecycle branches. Preserve that failure too.
- Final affected slice: `20261118T135155.010395Z-17388` — types and 51 queue/recovery cases pass; `publication.ts` is 100% statements, branches, functions and lines. Added explicit stopped-connect and resolved-ACK-before-continuation controls. Other 15 completed source files are unchanged from the broad receipt. This combined evidence covers 269 cases across the original 17 files; it is not described as one uninterrupted passing broad run.

All receipts live under this worktree's `.harness/validation/`. The final tests prove legacy same-image accepted/pending equivalence using real card preparation, later add/rename/deletion, validation before shortcut, full-image reservation accounting, exact-once later completion, and distinct physical-question replay versus restart/provider-look reconstruction. The source wrappers settled; no native or new timing was started. Matched performance and packaged acceptance remain open.
