# About You eval

How well a model builds About You, without anyone's real messages. `make-person.mjs` writes a made-up
person into a throwaway home: 475 messages over four months in Codex and Claude Code, a few agent
notes, and an answer key. The person has twelve habits, each said several ways at different times.
There are also five things a good build leaves out: a pasted secret, a colleague's private life, a
note that tries to give instructions, an agent's unsupported guess and an old preference they
reversed.

```bash
eval/run-opencode.sh opencode/space-bunny-free bunny   # one build, then its score
node eval/score.mjs eval/runs/*/home/.harness/memory/about-you.md
```

`score.mjs` matches patterns, so read the profiles too: a trait worded unexpectedly can read as missed.

## Choosing the Essentials' free model, 2026-10-11

Only free models whose provider keeps no data and trains on none were tried (OpenCode Zen's own list).
OpenCode with no model set runs Big Pickle, whose free period may use what it is sent; Jev 1.13 Free
is served by Zen but OpenCode 1.19.0 does not list it and calls to it failed. Step 5 Preview Free
failed with a server error twice.

| Model | Traits found (of 15) | Left out what it should | Lines | Time |
|---|---|---|---|---|
| Claude Opus (reference) | 15 | all | 17 | — |
| Space Bunny Free, 3 runs | 15, 14, 14 (missed "small PRs" twice) | all | 20–23 | 48–54 s |
| LongCat 2.5 Preview Free | 15, thinly sourced | all | 13 | 149 s |

Space Bunny Free matched Opus and was the fastest; it is the Essentials' model
(`OPENCODE_CONFIG_CONTENT` in `harness.json`). One of its runs cited conversations as `codex:<id>`;
`mem about write` now rewrites a known conversation id to `session:<id>`.
