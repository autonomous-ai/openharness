# Storage child's fixed creation directory

## Design

Preparation on clean `073718e6226e561a7d4c5b281ad10197c3cbe27a`. Root reviewed this Design and released
the 20 actual-child cases on unchanged runtime; implementation follows the actual RED. This supersedes the unintegrated shared-helper proposal
`fef7faed1116b922c0c264203397f9cb609aa64e`; none of its receipt/security changes belongs in this change.

The actual post-admission regression `/tmp/core-grid-storage-pending-receipt-post-admission-red1-20261119.log`
shows the gap: a directory can change after its admission descriptor closes, provide a terminal
primary, and return before the final pathname fence. The scanner then successfully omits pending work.
An extra pathname stat or timestamp check cannot bind a later relative file open to that directory.

### One lazy lifetime binding

The existing storage child captures its original working directory at initialization. Its dispatch
already admits one operation at a time; no other storage operation is in flight while a creation
operation first binds the child. There is no added process, native dependency or transient cwd switch.

The first creation-page securely admits an existing `agent-creations` directory. If it is missing,
the result remains empty and no directory is created or pinned. The first creation-ensure securely
admits the data root and creates only the required creation-directory leaf with nonrecursive mkdir
(an existing leaf is admitted, never replaced), then calls existing `secureStateDirectory(false)`.
It binds before creating or opening `.pending-v1`. An unsafe or unwritable creation
directory therefore cannot prevent startup or unrelated image/list/query work before binding.

Admission records the existing exact `dev:ino:birthtimeNs:mode:uid:gid` identity, then calls `chdir`
exactly once. The child immediately verifies both `.` and the configured absolute directory against
that identity. Once chdir succeeds, any failed check is lost binding, including a change during the
chdir itself. A failed chdir that never changes cwd remains an ordinary refused operation. There is
no rebinding, even if a later pathname is valid or a later scan requests a fresh cursor.

The storage-only capability supplies a read path, admission and verification to the scanner. The sole
runtime implementation supplies `.`. Direct scanner unit fixtures supply explicit absolute-path
capabilities so they can exercise scanner fences without changing the test worker's cwd; actual-child
tests own all production cwd/lifecycle guarantees. No fallback mode or configuration is exposed to
the product. The capability and its distinguished error stay under `storage/`, never in a shared
receipt/security helper or the core's import graph.

All primary enumeration uses `opendir('.')`; marker enumeration uses `opendir('./.pending-v1')`.
The child's existing receipt decoder is `new AgentCreationReceipts('.')`, so primary, claim, result
and hold paths remain relative all the way to the operating system. No `resolve()` or `process.cwd()`
reconstruction of those read paths is permitted. Current absolute authority fences and marker
operations stay in place. Each new scan, ensure and classification checks the immutable cwd binding;
page/mutation/error fences retain their existing exact identities and deadlines.

The marker inode fsync and marker-directory, creation-directory and data-root fsync remain in their
current order. Creating the creation leaf earlier within ensure does not report success before those
flushes; a crash beforehand leaves only the same unacknowledged private directory/marker residue as
before. A read never creates an absent creation directory. There is no schema migration or cache.

### Lifecycle and compatibility

A distinguished storage-local lost-binding error must escape damaged-record handling. Dispatch retires
the child without sending a normal operation reply. Existing parent custody waits for actual exit
before releasing the active request, and the next request starts a fresh child. It does not retry the
failed operation invisibly. A stale cursor's ordinary `changed` result does not retire a healthy child.
Sticky descriptor/iterator close uncertainty keeps its existing stronger cleanup semantics.

Pinning changes only storage filesystem capability, not the meaning of legacy persisted paths. Pass
the captured original cwd explicitly to the image codec. Resolve a relative stored `row.cwd` from it
before both realpath and fallback resolution. Pass it to `conversationKeyAtHome` for relative saved
and default `codexHome` comparisons; retain the original profile string in the resulting key. Other
callers retain their current default cwd behavior. Absolute image/list/archive paths are unchanged.

On macOS/Linux, rename tests prove reads stay with the original directory and permanent displacement
retires the child. Windows locks the current directory against rename/deletion; therefore tests close
the child before removing its root and rename-race tests are POSIX-only. Native Windows execution is
deferred by the user, not claimed from simulated tests. No detached process or console behavior changes.

### Failure-first caller tests

Tests use the real admitted storage child, private fixture roots and filesystem seams inside that
child. No owner home, port 18473, polling sleeps, production environment or external service is used.

1. After a receipt's real directory-admission descriptor closes, replace A with B and restore A after
   the real primary read. A has a pending primary, B a terminal primary. Require A's pending ID and
   prove the observed file belongs to A; a successful empty result must fail.
2. Replace A around the awaited primary or marker `opendir`. Require enumeration of A's entries,
   actual iterator closure and unchanged marker/primary effects. Absolute-path enumeration must fail.
3. Replace A around actual claim/result/hold reads. Prove all sidecars come from A and classification
   remains correct, including terminal claims and result consistency. A hold never grants dispatch.
4. Permanently displace a successfully bound directory, then issue a fresh page or ensure. Require
   disconnected failure after actual exit, no normal operation reply and no mutation in B. The next
   request starts another child and succeeds against the newly admitted directory.
5. Missing page creates nothing; unsafe/unwritable creation storage refuses creation work while an
   unrelated registry read remains available in the same child. A failed initial bind can recover.
6. A stale cursor refuses with `changed` while that child remains healthy. Existing real marker,
   receipt and iterator close-failure tests continue proving actual reap before request settlement.
7. After successful pin, legacy relative cwd queries (existing path and realpath fallback) and
   relative codexHome owner queries match their pre-pin interpretation and preserve profile strings.
   Unrelated registry/image/list operations continue using the same child.
8. Retain scanner security, marker replacement, four-flush durability, late legacy writes, damaged
   record, missing marker, bounded page/cursor/deadline and all sticky custody controls.

Selected first gates after release: the new actual-child regressions on unchanged runtime, then those
same regressions after implementation; pendingCreations scanner/custody/process, sessionImage and
conversationIdentity controls, storage protocol/authority/list controls, typecheck. Coverage and any
broader caller gates are selected with root before execution. No archive timing rerun, build or native
gate is authorized by this preparation. Before/after archive performance remains a separate held task.

### Data-design checklist

1. Growth: no new disk record, IPC field or cache. One identity lives until the existing child exits;
   directory iterators, markers, receipts and retained close failures keep their existing lifetimes.
2. Concurrency: the child's existing busy serialization owns the one-time cwd change. Immutable cwd
   reads bind all receipt evidence; exact absolute fences still guard current marker authority.
3. Read cost: same receipt/sidecar bytes and bounded output: 64 considered entries or 20 ms per page,
   two iterators, one cursor, 128 existing durable-marker proofs. No new complete scan or polling.
4. Scale: discovery remains O(history), including at 10x. Existing wall/CPU/callback-delay measurements
   remain the evidence; this reliability fix makes no unmeasured performance-improvement claim.
5. Compatibility: no new wire/schema state. Parent discovery, core selected-receipt reread, legacy
   writers and same receipt decoder retain their contracts; relative persisted path semantics remain.
6. Migration/rollback: no migration. Previous builds read exactly the same receipt/sidecar/marker bytes.
   Production restore is N/A because no data format is changed; all new fixtures are synthetic.
7. Audience: existing private directory/file policy applies. No paths, identifiers, content or credentials
   enter new logs or IPC. Lost binding is an internal fixed failure identity and parent disconnected state.
8. Identity: existing daemon OS account and immutable admitted child only; no effect/login authority change.
9. Failure: lost binding is a failed request and actual child exit, followed by ordinary lazy restart.
   Missing pre-bind storage stays empty; unsafe pre-bind storage does not disable unrelated reads.
10. Platforms: storage runtime affects macOS/Linux/Windows. macOS private-child controls are planned;
    Windows cwd locking is documented and its native execution remains explicitly deferred.
