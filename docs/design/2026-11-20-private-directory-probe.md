# Private directory checks

The current Close/Resume trace identifies at least 125 repeated private-directory
open/stat/close triples per cycle. These calls check metadata, then immediately
close the descriptor. An existing POSIX directory already owned by this account
with exactly mode 0700 can instead be checked with a fresh `lstat` on every call.
No file identity, native route, owner or publication fence is removed.

## Design

- Growth: no retained state, descriptor, cache, queue, timer or new dependency.
- Concurrency: each `create=false` call checks descriptor custody first, then
  reads the current name's type, owner and complete permission bits. Only an
  ordinary directory with a known matching UID and mode 0700 returns early.
  All other results and read errors use the existing open/stat/tighten/close path.
- Read cost: one current metadata read replaces three descriptor operations.
  Creation and Windows retain their existing paths. No scan or polling is added.
- Scale: constant work and no retained allocation per call. Matched workloads
  measure CPU, wall time and repeated-call cost; this does not clear the existing
  complete Close/Resume performance hold by inference.
- Compatibility: no stored or public format changes. A metadata-safe directory
  no longer needs an otherwise unused readable descriptor. Descriptor exhaustion
  or an open-only denial therefore fails at the next operation that actually
  requires a descriptor, using that operation's existing failure path. This
  helper does not grant directory identity: callers still check their exact
  selected record or checkpoint slot afterward.
- Migration and rollback: no migration; revert restores the descriptor probe.
- Audience and identity: the same account UID, exact private mode and non-link
  directory requirement. A failed custody latch still blocks before any read.
- Failure: unexpected metadata reads fall back; unknown UID, links, special
  permission bits, unsafe mode, foreign owner and absent names keep the original
  behavior. Permission tightening still uses the opened descriptor.
- Platforms: macOS and Linux; Windows code is unchanged and tested through the
  portable branch fixture. Native Windows remains deferred by the user.

Validation starts with failing caller work-count tests, then covers current
metadata changes, all fallbacks, custody poisoning, actual archive selection,
checkpoint identity fences, unchanged native-hook authority tests and types.
Independent source review and matched cost measurements precede integration.

The independent review identifies a caller ordering change: deleting a stopped
archive previously encountered descriptor exhaustion in its directory metadata
check. The same cause affects clearing a Resume reservation. Both deletions share
one method that acquires the directory-flush descriptor before unlinking,
retain it through the actual flush, and check that the name still identifies that
opened directory at the final authority fence. Windows retains its existing
directory durability behavior. A failed open must leave the archive intact; a
failed close must poison the existing custody latch rather than retry a descriptor.
