# Cloud publication encoding capture

## Design

The measured connected-publication regression remains open. Its preserved CPU profile attributes repeated work
to fingerprinting and payload sizing. The actual publication/core caller encodes a three-owner catalogue twice,
three singleton-owner arrays, and the complete publication payload once. Admission normalizes each owner once;
`cloudFingerprint` does not normalize it again.

`prepareCloudCards` now encodes each row once during its existing synchronous transition loop. The transient
string supplies the existing ordered image SHA-256, the existing singleton-array SHA-256 and an exact UTF-8 byte
count. It is not returned or retained. The pump serializes only `{harnesses: [], cards}` for its bound, replacing
the empty array's two bytes with that count. It keeps the same complete-payload limit before persistence or send.

Only `cloud/cards.ts` and `cloud/publication.ts` change at runtime. Admission normalization, row/image limits,
diff calculation, queue reservations, core admission, provider saves and journal writes are unchanged. There is
no core change, new map, retained string cache, public representation, codec or transport limit.

## Data and lifetime

The input is the already-admitted current wire image, in its existing Map order. Production `service.ts`
`cardOf`/`snapshot` supplies plain rendered card string fields. The normalizer creates the other plain fields;
the existing admission optimization may reuse a JSON-equal source card. This is not a new admission guarantee
for arbitrary programmatic objects with getters or `toJSON` hooks, and that optimization is not widened.

For these records, the encoded array is exactly `[` followed by comma-separated encoded rows followed by `]`.
The incremental hash consumes those same UTF-8 bytes, including singleton brackets. Encoded strings cannot
split a surrogate pair between hash updates: each update ends after the encoded object and its punctuation.
The payload byte arithmetic replaces only the literal empty array. Card bytes still use the same serializer.

The encoded row lives for one synchronous loop iteration. It is bounded by existing row admission and never
survives into the queue, journal or provider state. The prepared checkpoint and card strings retain their
existing lifetime across the publication acknowledgement. A later source mutation cannot alter those strings;
the next queued publication captures the new values normally.

Journal version/checksum inputs, provider file format, atomic temporary-file replacement and write counts do
not change. Pending intent is persisted before send; acknowledgement updates memory only. The existing durable
journal reference advances only after a successful writer. Accepted-before-pending recovery, empty-core quiet
reconstruction, lost-acknowledgement rename suppression, question order and physical-connection fences remain.
No new failure state is needed: oversize payloads retain `CLOUD_PUBLICATION_LIMIT`; existing persistence and
delivery failures retain their named hold and recovery action.

## Validation

Pinned Node 24.22.2 and existing immutable dependency tree
`/tmp/harness-core-deps-main-86558/node_modules`. Source was tested in the isolated
`/tmp/harness-core-session-factory-ownership` checkout. All receipts are under its `.harness/validation/`.

- RED `20261118T155242.202590Z-9877`: 37 passed / 8 intended failures. The real publisher/core caller observed
  encoding counts `2 / 3 / 1` instead of `1 / 0 / 0`; seven byte controls lacked the new `imageBytes` result.
  Existing frames, checkpoint, exactly one intent write and the held-ACK mutation control passed.
- Corrected source `20261118T155414.988075Z-14165`: 111 cases / 7 files and types passed. Aggregate failed only
  the card branch coverage threshold (37/39); publication coverage was 100% on every metric. The initial plan's
  nonexistent `services/coreCloudLink.spec.ts` path selected no file; this was corrected to `core/cloudLink.spec.ts`.
- `20261118T155514.975710Z-16750`: final types and 15 cases / 2 files passed, including the correct link consumer
  and three additional failure/question-card controls. Its isolated card coverage omitted transitions covered
  by the real publication/service callers; the coverage-failed receipt is preserved.
- Final combined coverage `20261118T155555.371126Z-17711`: 96 cases / 4 files passed; `cards.ts` and
  `publication.ts` each reached 100% statements, branches, functions and lines (285 / 205 / 39 / 179 total).
  Unchanged passing consumer evidence is reused, for 116 unique affected cases across 8 files. All validation
  process groups settled; no native or timing workload ran for this correction.

Controls cover empty/single/multiple/reversed images, absent versus null fields, Unicode/lone surrogates/control
escapes, maximum existing fields, full failure/question completion cards, oversized whole payload rejection,
held acknowledgement with later source mutation, exact persistence-call counts, malformed batches, queue bounds,
lost acknowledgements, component/daemon restart, questions and physical-connection races. The actual caller now
observes one catalogue encoding at admission and no singleton-array or full nonempty-payload encoding in card
preparation/sizing. No wall-clock improvement is claimed from source counts.

## Open acceptance

The original connected-performance hold remains. A reviewed matched cost comparison and final combined packaged
proof are still required; previous frozen cost/profile packets are unchanged. This correction keeps all 48 provider
saves and 64 pending-intent writes in the frozen connected workload. It does not resolve the common-owner/read
boundary or its dense-image capacity counterexamples. Windows execution remains deferred by the user; mobile is
outside this refactor. Rollback is the prior two-file implementation, with the same provider and journal formats.
