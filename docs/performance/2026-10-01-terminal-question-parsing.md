# Terminal question parsing without repeated whitespace scans

The daemon checks terminal captures for questions and approval prompts while
agents work. A live 20-second CPU profile attributed about 158 ms of sampled
work to `parseRow` and `unframe`. The row regex split indentation between two
overlapping whitespace runs, and the unanchored closing-frame regex retried
from every column of a padded blank row. Both did unnecessary backtracking.

The change consumes leading whitespace once before reading an option and checks
the last non-whitespace character before removing a closing frame. Lines without
a closing frame retain their whitespace. It leaves capture frequency, dialog
selection, question IDs, permission checks and answer delivery unchanged.

## Matched measurements

Apple M2 Max, macOS arm64, managed Node 22.23.2. Both modules are bundled with
identical options and parser dependencies. Seven alternating trials run the same
number of parses for each variant, after warmup. The recorded-dialog workload
visits all 31 existing question/permission fixtures, using their corresponding
engines. Synthetic blank captures have 60 rows. All samples, including a wall
time scheduling outlier, are retained in [the raw record](2026-10-01-terminal-question-parsing.json).

| Workload | Median CPU per parse, before → after | Reduction |
|---|---:|---:|
| 31 recorded dialogs | 632.2 → 357.7 µs | 43.4% |
| Same dialogs padded to at least 240 columns | 3,477.1 → 2,013.7 µs | 42.1% |
| Blank Claude capture, 80 columns | 827.0 → 25.6 µs | 96.9% |
| Blank Claude capture, 160 columns | 2,505.8 → 44.1 µs | 98.2% |
| Blank Claude capture, 240 columns | 5,094.4 → 61.0 µs | 98.8% |
| Blank Hermes capture, 240 columns | 9,080.3 → 105.1 µs | 98.8% |
| Blank OpenCode capture, 240 columns | 8,991.0 → 122.3 µs | 98.6% |

These are **parser-only** measurements. They exclude terminal I/O, the rest of
the daemon, agents and desktop rendering. They do not establish whole-app CPU
or battery savings. Ordinary dialogs have differing whitespace and see differing
gains; the synthetic blank cases are not a claim about typical usage.

## Compatibility and validation

- 32,329 baseline/candidate comparisons returned identical results. They cover
  whitespace/cursor/checkbox/frame combinations; 5,000 seeded malformed, Unicode,
  ANSI and multiline inputs; and each recorded fixture through all 13 supported
  question engines, both padded and beside another dialog. Question request IDs
  are also compared whenever a question is present.
- All 834 local question and engine tests passed; two opt-in tests were skipped.
  The 28 added checks cover Unicode indentation, checkbox state, internal bars,
  frame indentation, non-question output and stable IDs after padding changes.
- TypeScript checking passed.
- All 433 focused parser/controller/watcher coverage tests passed. Both changed
  functions have every statement and branch arm exercised (10/10 statements,
  8/8 branch arms combined). The entire `askQuestion.ts` file has 100% line and
  function coverage, 98.77% statement coverage and 97.51% branch coverage; this is
  not a claim of whole-app coverage.
- The real tmux 3.7c test passed with 32 private fixture panes on macOS/Node
  22.23.2: question identity, deduplication, answer routing, two-read close,
  stale-answer refusal, reopening, missing-pane isolation, preservation after
  failed captures and polling teardown. All private fixture processes exited.

The fixtures were recorded from real engines, but replay is not a live provider
test. No real agent or user terminal is opened, stopped or modified by the
comparison script.

## Reproduction

From the repository root with CLI dependencies installed:

```sh
git show 3d0873361:cli/src/lib/askQuestion.ts > /tmp/question-before.ts
node cli/scripts/benchmark-question-parsing.mjs \
  /tmp/question-before.ts cli/src/lib/askQuestion.ts /tmp/question-parser-new-run
```

Use managed Node 22.23.2 to match the recorded run. The output directory must not
already exist. It preserves both source files, source hashes and all observations.
The benchmark uses the checkout's unchanged engine parser dependencies for both
variants. Use the commit accompanying these results when reproducing them.
