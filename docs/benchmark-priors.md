# Benchmark priors

A new model is usable on day one from public coding benchmarks (evidence-routing spec, part 2). This page says what the
table holds, how a score becomes a quality level of 1 to 3 per job kind, how an owner changes one, and how to refresh it.
It changes no routing decision: part 3 reads these priors.

## The table

`backend/src/superTabs/benchmarkPriors/data.ts` (checked in, generated). For each model the Swarm routes: its engine
(`claude`, `codex`, or `grid`), our model id, the other names we call it, its names on the benchmark boards, and its scores.
A score has the benchmark, the percent, **the harness it ran in**, a source link, the date it was posted, and whether the
refresh script read it from a board (`leaderboard`) or it was typed in from a model card (`model-card`, with a note on who
reported it). A model on no board has `noData` saying so and keeps its hand rating. Nothing is estimated.

Benchmarks: Terminal-Bench 4.0 (tbench.ai), SWE-bench Verified (swebench.com), Aider polyglot (aider.chat). Terminal-Bench
scores of different versions do not compare, so only the 4.0 board is read. As of 2026-10-29 the SWE-bench Verified and Aider
boards list none of our current models; the table keeps their mapping so a refresh picks the models up when they appear.

**A benchmark number depends on the harness that ran it** (Claude Code, Codex, Kimi Code, Aider ...) as much as on the model;
many are reported by the model's vendor; none is our codebase. A prior is a starting point that our own results replace.

## Score to quality level

1. Per benchmark, the reference is the best score among the models in the table. A model's **ratio** is its best score on that
   benchmark (efforts and harness variants merged) divided by the reference.
2. Per job kind, the ratio is the weighted mean over the benchmarks the model has a score on (weights renormalised):

   | Kind | Weights |
   |---|---|
   | backend, desktop, mobile, general, docs | SWE-bench Verified 0.5, Terminal-Bench 0.3, Aider 0.2 |
   | tests | Aider 0.5, SWE-bench Verified 0.25, Terminal-Bench 0.25 |
   | cli | Terminal-Bench 0.6, SWE-bench Verified 0.4 |
   | security, review | none: no public benchmark measures them, so the hand rating stays |

   Docs borrow the general mix; no benchmark measures writing docs.
3. Ratio of 0.85 or more is level 3, 0.55 or more is level 2, else 1 (the scale #2137's policy uses).

No data on any benchmark of the kind means no prior.

## Owner override

A model's rating now lives in the model catalog (`backend/src/superTabs/catalog.ts`), and a project that wants a model
rated differently says so in words in the Routing section of its instructions (see
[Routing](swarms.md#routing)); the route shows the instructions' words, and the coordinator follows them. The routing
policy's `priorOverrides` rows (`{ model, kind, quality }`, the first row for the kind whose every word is in the
model's name) are read by nothing: an older client's policy save is accepted and ignored, and the migration copied
each saved row into the project's Routing section as a line.

## Refresh

By hand, with network: `cd backend && node --import tsx scripts/refresh-benchmark-priors.ts` (`--dry-run` to only print).
It reads the three boards, maps names through each model's `benchmarkNames`, keeps `model-card` rows, rewrites `data.ts`, and
names any board it could not read (that board's previous rows stay). The server never reads the network for priors.

To add a model: add its entry to `data.ts` with its board names, then refresh. To add a model-card score: type it into the
entry with `via: 'model-card'`, the card's link and a note on who reported it and in which harness.
