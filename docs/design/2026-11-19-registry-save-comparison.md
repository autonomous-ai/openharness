# Registry save comparison

## Design

The fixed 1,600-row comparison at `6c5c378781` measured Registry save parent CPU at
245.465 → 330.893 ms and wall time at 255.766 → 431.863 ms. The subsequent two-arm
diagnostic attributes repeated canonical serialization to both fresh live rebases;
sampled occupancy includes waits and is not function CPU. That measured source
predates the native owner-notification correction. This change starts from
`78c9c0ad10` and requires a new matched comparison before claiming an improvement.

Each rebase already has a private captured row and its canonical fingerprint.
Compare the fresh live row with that capture using Node's strict deep equality.
An equal row may reuse that capture's fingerprint; any difference uses the
existing canonical formatter, including differences that JSON intentionally
ignores. No comparison survives an await. A binding or recovery may replace the
capture: reuse its own fingerprint, never the original baseline by assumption.
Both rebases, the complete identity proof, locks, refreshes and native admission
notifications retain their present order. There is no new cache, map or module.

1. Growth: no new records or retained state. The existing publication owns and
   releases its captured rows and private fingerprint WeakMap.
2. Concurrency: retain the whole-registry lock and three-way merge. Both pre- and
   post-durability rebases inspect fresh live nested data. All ownership, binding,
   recovery, deadline and cleanup checks stay in place.
3. Read cost: no storage read or IPC changes. Unchanged rows avoid constructing
   canonical strings during both rebases; changed rows still use the old formatter.
   Actual caller tests count canonical work and check identical persisted output.
4. Scale: work remains proportional to admitted rows and nested data. Parent CPU,
   wall time and queued callback delay in the established 160/1,600-row workload
   are the warning measures; no new numerical limit or timing claim is introduced.
5. Compatibility: no new field, wire shape, audience or reader. Preserve canonical
   key ordering, omitted undefined values and ignored credential image witnesses.
6. Migration and rollback: none; the file format and writer protocol are unchanged.
7. Audience: no new data copies, logs or endpoints. Captures remain private to one
   publication. Credential references stay in core; key material stays in storage.
8. Identity: unchanged native session authority and owning OS identity. No fallback
   or additional access path.
9. Failure: all existing refusals, uncertain-publication recovery, cleanup and
   bounded deadlines remain authoritative. A failed deep comparison always falls
   back to canonical semantics, rather than deciding that a row changed.
10. Platforms: shared TypeScript affects macOS, Linux and Windows. Source checks
    run on macOS; native Windows execution remains excluded by user instruction.

Validation is selected before implementation: an actual caller RED for redundant
serialization; canonical-equal/deep-unequal and live nested-edit controls before
and during durability; Registry persistence/fingerprint/authority tests; relevant
types and core coverage. The coordinating agent owns combined native gates,
independent review and the next approved matched cost run.

The coordinating agent reviewed this exact Design and caller-test diff before
runtime edits. On unchanged `78c9c0ad10`, the actual changed-save caller preserves
its durable image and live/process identities, then fails with four unchanged-peer
canonical serializations against a maximum of two. Three controls pass: omitted
nested values with reordered keys, credential witness changes, and a nested edit
after real directory sync. Both canonical-equal/deep-unequal controls subsequently
pass an explicit four-call assertion. The earlier sandboxed attempt refused
storage access during fixture admission; it is a setup failure, not RED evidence.
