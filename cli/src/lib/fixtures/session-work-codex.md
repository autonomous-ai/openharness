# Batched Codex work receipts

`session-work-codex.jsonl` preserves the tool-call and output-block structure
recorded while creating PR #397 on 2026-09-28. It includes a sequential patch and
yielded PR creation, a later process poll and shell call, and a parallel
`Promise.allSettled` batch with indexed results. Session/call identifiers,
commands, paths, repository URLs and shell output are reduced to test fixtures.
No transcript prose, credentials or private project content is included.
