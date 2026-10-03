# Saved-session catalog performance

A 20-second CPU profile of the connected local development daemon identified
repeated `StoppedAgentStore.list` / `get` calls during status updates. The host
had 272 saved metadata files, totaling 324,006 bytes. That profile was taken
against `0.3.41-dev.f7dd8bb4d` with desktop 1.2.38; it is evidence for selecting
a code path, not a measurement of the released 0.3.42 / 1.2.39 pair.
The temporary profiler was stopped and its loopback inspector was closed.

## Change

Catalog reads retain parsed metadata for unchanged files. Every enumeration
still checks the private directory, enumerates its current filenames, and checks
each file's identity, timestamps, permissions, ownership, and size. Changed files
use the existing guarded reader and schema validation. Deletion and failed reads
discard the cached entry; save and patch invalidate it immediately. The cache is
limited to 2,048 records and 4 MiB of source JSON, and entries expire after 30 seconds
when next requested. There is no new timer or watcher. The byte limit bounds source
data retained, not exact JavaScript heap allocation.

Actions such as Resume still call `get`, which always opens and validates the
file afresh. Catalog callers receive independent copies and filter against the
current live inventory, so resuming a conversation immediately hides its archive.
Nanosecond ctime also catches in-place edits with a restored mtime; expiration
bounds staleness on filesystems whose timestamps cannot distinguish such edits.

## Local comparison

The benchmark uses only synthetic metadata in a disposable private directory.
Baseline: main `e2b867772`, before the cache. macOS arm64, Node 22.23.2, 60 warm
reads after five warmups. This is one local before/after comparison with other
applications running. All observed samples are retained.

| Saved records | Warm median before → after | CPU for 60 reads before → after | First read before → after |
| --- | --- | --- | --- |
| 32 | 1.17 → 0.34 ms | 85.2 → 25.5 ms | 2.18 → 2.77 ms |
| 272 | 8.06 → 2.31 ms | 504.7 → 153.8 ms | 11.69 → 16.26 ms |
| 1,000 | 30.81 → 8.31 ms | 1,892.0 → 522.8 ms | 32.44 → 50.88 ms |

Repeated-read CPU fell by about 70–72% for the larger two catalogs. First reads
cost more because they populate and validate the cache; cold means an empty
application cache, not an emptied OS file cache. These measurements do not establish
a whole-app CPU or energy reduction, native display latency, a smaller model
process, or the requested 100-fold reduction in total resources.

Raw observations: [before](2026-10-01-catalog-data/before.json),
[after](2026-10-01-catalog-data/after.json).

Reproduce from `cli/`:

```sh
node --import tsx scripts/benchmark-stopped-catalog.ts /tmp/catalog-results.json
```

## Verification

- Storage and lifecycle regression tests cover uncached Resume reads, caller
  mutation, immediate save/patch/replacement/in-place-edit/delete visibility,
  corrupt records, unsafe permissions, symlinks, replacement during a read,
  expiry/backwards clocks, bounded retained bytes, and catalogs beyond the
  record limit. Existing close, resume, checkpoint, secure-state, and cwd-repair
  tests remain in the validation set.
- The isolated native fixture warms the catalog before each resume and checks
  that the row appears once and leaves the saved catalog immediately after resume.
  Claude Code 2.1.286 and Codex 0.159.3 passed three close/checkpoint/resume cycles
  each, same-conversation history restoration, live reattach, neighboring-pane
  preservation, surviving-shell preservation, deferred-close persistence/cancel,
  and automatic idle close for Claude. Only disposable profiles and a private
  tmux server were used; the fixture cleaned them up.
- The native fixture observed 232–235 MiB of Claude process-tree RSS and 171–173 MiB
  of Codex process-tree RSS released per close. This verifies existing close
  behavior survives the cache; it is not an additional memory saving from caching.
- Native desktop rendering was unchanged and was not re-benchmarked in this pass.
