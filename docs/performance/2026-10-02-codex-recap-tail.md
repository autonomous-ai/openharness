# Codex recap history reads — October 2, 2026

Every Codex recap previously read the entire rollout into an array of strings and
parsed it, even though only the latest turn contributes to the result. Long-lived
sessions can accumulate hundreds of megabytes of old tool receipts. Repeating
that work on completion causes avoidable I/O, parsing, allocations and collection.

The recap now reads backward in 64 KiB chunks and stops at the latest nonempty
user message or injected goal objective. It discards irrelevant records while
scanning and sends the selected prompt/answer records, in chronological order,
to the unchanged final-answer parser. Both Codex message vocabularies, phase
handling, multiple final messages and unfinished goals retain their semantics.
History pagination, conversation storage, other engines and session lifecycle
are unchanged. No transcript is modified.

The reader captures the initial file length, excludes later appends, assembles
whole records before decoding UTF-8, and supports LF, CRLF and bare CR. A missing
boundary scans to the beginning. Read failures return no recap; the configured
reader remains authoritative, so live commentary cannot become a stale answer.

## Measurements

[Raw results](2026-10-02-codex-recap-tail.json) compare the former full-history
reader with the candidate using the same final-answer parser, minified bundle,
macOS ARM64 and managed Node 22.23.2. Each scenario has three paired trials in
alternating order, using fresh child processes and real synthetic files. All
42 output hashes match the expected complete prompt and final answer.

| History shape | Median elapsed, before → after | Peak worker RSS, before → after |
| --- | ---: | ---: |
| Short latest turn, no older tool history | 0.307 → 0.202 ms | 55.0 → 52.0 MiB |
| Short latest turn, 1 MiB older tool history | 2.507 → 0.239 ms | 58.0 → 52.1 MiB |
| Short latest turn, 64 MiB older tool history | 125.656 → 0.246 ms | 196.6 → 52.2 MiB |
| Short latest turn, 512 MiB older tool history | 997.593 → 0.267 ms | 912.7 → 52.1 MiB |
| One latest turn containing 64 MiB of tool records | 142.121 → 91.190 ms | 300.7 → 57.3 MiB |
| 64 MiB of tool records without a recognized prompt | 129.125 → 92.832 ms | 194.6 → 56.9 MiB |
| One 64 MiB tool record in the latest turn | 148.721 → 105.098 ms | 350.6 → 309.6 MiB |

The 512 MiB history case reduces elapsed time by **99.97%**, process CPU by
**99.91%**, and peak worker RSS by **94.29%**. The latest-turn and no-boundary
controls improve elapsed time by **35.84%** and **28.11%** respectively. An initial
prototype was about 25% slower on those controls; the final code uses native
delimiter searches and discards irrelevant records immediately instead of keeping
and parsing them twice.

Peak RSS includes process startup and warmup. Explicit GC runs only in disposable
benchmark children before timing. Submillisecond measurements include file-cache,
scheduling and runtime noise. These are component measurements, **not** retained
daemon memory, whole-app energy savings or removal from macOS's energy list.
A live daemon heap burst motivated investigation, but its causal attribution to
this recap path remains unproven. A single huge JSONL record still requires memory
to decode and parse; the reader does not truncate it to manufacture a lower result.

Reproduce from the repository root with CLI dependencies installed:

```sh
node cli/scripts/benchmark-codex-recap.mjs /tmp/codex-recap-comparison-new
```

The output directory must be new. Workers have 60-second deadlines, use private
fixture directories, and remove their large transcript fixtures. No app, daemon,
engine, shared server or tmux session is restarted or changed.

## Validation and delivery

Validation covers real files, long Unicode records, separator/chunk boundaries,
append/truncate handling, missing files, malformed records, goal continuations,
phase rules, empty prompts and exact parity with the existing full-history parser.
Integration cases drive the Codex normalizer and Commander through notifications
and persisted recaps, including suppression of stale answers for unfinished goals.
They use local summarization and do not start a live Codex process or contact a model.

Typecheck and affected tests run locally. The full CLI CI scope, including its
OS/Node matrix and release-bundle checks, is required before merge. Final counts,
source identity, validation receipt, CI link and merge time are recorded on the PR.
No desktop rendering code is changed; whole-app battery behavior remains unverified.

The exact original request time is unavailable. Final benchmark finished at
18:26:40 UTC; implementation, validation and merge timestamps are tracked separately
in the PR. Publication is excluded under the user's weekend release hold.
