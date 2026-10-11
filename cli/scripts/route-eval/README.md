# ⌘B's router, measured on a real desk

How ⌘B's routing was hill-climbed (docs/design/2026-10-09-auto-router.md), and how to do it again.
Nothing here sends anything: the router only decides. Each decision costs about $0.0002 of the
OpenRouter key the router uses.

1. Snapshot the desk, from `cli/`: `node scripts/route-eval/collect.mjs ~/route-eval/desk.json`.
   It holds your sessions' names, last prompts and summaries: keep it out of the repository.
2. Write cases against it, in English, as a person really types:
   `[{"text": "...", "want": [index, ...] or ["new"], "last": index (optional), "why": "..."}]`.
   `want` is the desk index (or indexes, when two are equally right) the message belongs to, or `"new"`.
   `last` is where the previous ⌘B message went, for a follow-up. Have someone who did not write the
   router write some of them blind, keep a set held out until the end, and have a red team write
   messages to break it: sets written while reading the sessions are too easy.
3. Run them through the router as the desktop calls it:
   `npx tsx scripts/route-eval/eval.mts ~/route-eval/desk.json ~/route-eval/cases.json 3`.
   A WRONG send (a message typed into the wrong conversation) is the failure that matters; a miss
   (new work where a session should have taken it) costs a harness.
