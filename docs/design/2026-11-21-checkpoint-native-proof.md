# Check the native checkpoint size at the copy boundary

A transcript can shrink while Close reads the old checkpoint's metadata. The original code checked for an empty
source before that read, then overwrote its stat snapshot without checking the new size. For a native engine without
a header rule, it could successfully publish an empty checkpoint and delete the previous history. A real Grok fixture
reproduces this through `SessionCheckpointStore.save`, without mocking its authority proof or writer.

## Design

The source is opened once. Read the previous checkpoint's private metadata, then stat the source descriptor, prove
its native identity and check its type, size and nonemptiness. Those are the facts used by both reuse and copy.
Remove the earlier stat/proof and the immediately repeated proof inside the synchronous reuse comparisons.
Keep the full native proof after copying, the source metadata-stability comparison, the proof after source close
on reuse, and the final proof before publishing the screen and manifest. JSON writing and its durability barriers
stay synchronous and unchanged.

- Growth: no new stored records, caches, queues, dependencies or processes. Existing file and copy-buffer bounds remain.
- Concurrency: no input bytes are read before the retained descriptor-bound proof. The only earlier work is opening
  the source and reading private checkpoint metadata. A substituted descriptor is refused before copying. A source
  that becomes valid before the final stat can now be saved; a source that becomes empty is refused.
- Read cost: fresh copies drop from four explicit authority verifications to three; reuse drops from four to two.
  The initial authority capture remains. These are predicted call counts, not a measured speed improvement.
- Scale: measure actual fresh and reused native saves with the same private inputs before and after. Include complete
  save/cleanup CPU, main-thread CPU, elapsed time and concurrent responsiveness. No inference to database engines.
- Compatibility: manifests and stage formats are unchanged, with no backend or migration requirement. Rollback reads
  the same data but restores the old truncation bug. Clients retain their existing contracts.
- Audience and identity: existing local-owner, native-header, root/catalog and opened-descriptor identity checks.
  No component gains publication authority. All failures precede a manifest pointing to the new history.
- Failure: the final fresh stat determines whether a headerless source is empty. Identity is checked before that
  refusal, preserving the distinction used by deferred Close. Existing actual-close and publication-error handling
  remain. Tests use private fixture content only.
- Platforms: shared TypeScript affects macOS, Linux and Windows. Native macOS first; Linux CI remains required and
  native Windows is deferred by the user.

Independent design review `20261121T001530.152031Z-52234` approved removal of the redundant checks with the final-size
check. Its optional proposal C (replacing the after-copy full proof with only metadata checks) is **not implemented**:
keeping that proof preserves its earlier refusal point and the existing coarse-timestamp behavior. The discarded
fully asynchronous and mixed checkpoint writers remain withdrawn; this change starts from delivery head d0.

## Validation

Keep actual file-swap, header mutation, same-size and different-size rewrite, descriptor-copy and post-close authority
cases. Prove the truncation bug red, including empty replacement and loss of the old history, then green with the
previous checkpoint retained. Prove that an initially empty source completed before the final stat can be copied
exactly. Retain publication failures, native/database checkpoint tests, Close/Resume authority suites and types.
Independent source review and a frozen complete-work comparison follow. Existing unrelated coverage receipts apply
only to their unchanged code; this change makes no claim about the separate Hermes Close/Resume performance hold.
