# Exact source references for coding-memory extraction

The extractor now selects source excerpts instead of copying their text into its
answer. This fixes a concrete failure: a model can preserve a statement's meaning
but collapse a double space, causing exact-quotation admission to reject it. Fuzzy
matching would weaken the evidence contract and can change code or string values.
The host therefore retains responsibility for copying original evidence.

`coding-memory-v6` supplies each source's original metadata plus ordered excerpts.
Concatenating a source's excerpts reconstructs its entire text without normalization
or truncation. Excerpts contain at most 4,000 UTF-16 code units, prefer nearby line
boundaries, preserve separators and do not split surrogate pairs. Their short IDs
are local to the current extraction lease. Episode source indexes retain their
original meaning.

The model supplies an excerpt reference and the proposed fields it supports. The
host resolves the exact source ID, text and captured verification, then applies the
existing draft schema and queue admission. Unknown references fail the whole batch;
model-supplied metadata overrides are rejected. Original source roles, scope,
field coverage, record size, account authorization and durable lease checks remain
authoritative. Legacy raw evidence remains accepted only under its original exact
matching rules. Stored records and recall packets keep their existing format.

The prompt also distinguishes explicit requested behavior from tentative options
in the same message. This is guidance to the model, not a mechanical proof that it
will preserve uncertainty. Selecting a valid excerpt proves provenance, not that
the model's interpretation is supported by it.

## Actual-model evidence

The same cached Qwen3.8-27B-Q4_0 weights and llama.cpp 9870 runtime used in the
[previous comparison](2026-10-02-memory-local-extraction.md) ran the unchanged
synthetic diagnostic corpus. Model and source hashes are recorded in the reports.
Each call had a 90-second deadline, 4,096 output-token limit, 16,384-token context,
temperature zero and seed 42, with thinking disabled and no retries. The worker's
OS sandbox denied external networking; its non-loopback connection probe returned
EPERM. No account credentials or live memory were used.

The [single-case report](2026-10-02-memory-source-references/single.json) completed
all six cases. The implementing agent's [attributed review](2026-10-02-memory-source-references/single-review.json)
judged all three retained memories supported, specific and useful. All three
positive recall probes and seven abstention probes passed semantic review. The
unconditional database preference no longer acquired the unsupported task condition
observed with v5. [Reproducible scores](2026-10-02-memory-source-references/single-scores.json)
bind those judgments to the exact report and frozen suite.

The separate [batch report](2026-10-02-memory-source-references/batch.json)
completed both multi-episode cases. Its [review](2026-10-02-memory-source-references/batch-review.json)
judged all three retained memories supported, specific and useful, with three
correct positive recall probes and five correct abstentions. The previously
rejected SQLite batch now includes the required applicability coverage. Separate
episodes did not turn an unrelated acknowledgement into adoption of an assistant's
experiment. [Batch scores](2026-10-02-memory-source-references/batch-scores.json)
use the unchanged frozen batch corpus.

A separate approved offline diagnostic repeated five bounded, consented user
excerpts against disposable private storage. All five completed, including the
excerpt previously rejected after the model collapsed whitespace. All fifteen
presence/scope probes passed. Semantic review accepted four of the six retained
memories and rejected two: one overgeneralized a default, and another promoted
unresolved options to a specification. Those defects also made two positive recall
packets unfaithful. The new prompt's uncertainty guidance has therefore **not**
solved faithful interpretation. Original transcripts, model answers, source IDs,
private report hashes and attributed review labels remain outside the repository.

These are small development diagnostics, not held-out quality estimates or
independent human assessment. They do not certify the selected companion model,
native account lifecycles, automatic task-condition recognition, or improved coding
outcomes. A green parser suite cannot establish any of those properties.

## Review against the design principles

These are our applications of the published work cited in the
[design council](../plans/2026-09-30-coding-memory-council.md), not participation or
endorsement by its authors.

| Perspective | Review question | Result |
| --- | --- | --- |
| Parnas: boundaries around change | Does changing extraction redefine durable knowledge? | Source-reference handling is isolated before persisted-draft validation. Storage and recall formats are unchanged. |
| Liskov and Wing: behavioral contracts | Are source identity, role, scope and uncertainty preserved? | Host-owned provenance and existing admission remain enforced. Semantic preservation still requires review of actual model outputs. |
| Dijkstra: correctness and observations | Is a passing check being used for a broader claim? | Regression tests establish exact reconstruction and rejection behavior. Attributed model-output review is reported separately from native delivery and task benefit. |
| Knuth: explanations for people | Can someone inspect the statement and its evidence? | Memories retain exact readable source excerpts, reasons and unknowns. A reference ID never replaces the stored quotation. |

## Validation and reproduction

TypeScript and all 466 memory/companion tests across 31 files passed on macOS with
Node 22.23.2. Tests cover spacing, Unicode, long sources, unknown references, atomic
failure, source authorship, captured verification, required field coverage, record
size and legacy quotation validation. Local receipt:
`.harness/validation/20261002T172600.652155Z-8672/receipt.json`.

The code commit is `a4642683bc04d7e1d9917268383d4515a6b4a852`.
The [full CLI run](https://github.com/autonomous-ai/openharness/actions/runs/37040969426)
is recorded separately. Later evidence-only documentation does not change the
tested CLI tree or dependencies.

To reproduce the single-case scores without calling a model, run from `cli/` with
the pinned Node runtime and installed lockfile dependencies:

```sh
node --import tsx scripts/memory-quality-review.ts \
  --suite ../docs/research/2026-09-30-memory-extraction-cases.json \
  --report ../docs/research/2026-10-02-memory-source-references/single.json \
  --review ../docs/research/2026-10-02-memory-source-references/single-review.json \
  --output /tmp/memory-source-reference-scores.json
```

The scorer requires a new output path. It does not overwrite prior evidence.
