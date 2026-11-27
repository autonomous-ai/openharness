# Needs you, right: Part 3, the skill's words, Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** The dial skill's description carries the moment and the command, so Claude Code rings before it ends a turn
that leaves the person something to decide, answer or do, also in a crowded session. The text is tuned by rounds of
the eval and ships only if the eval says it is better.

**Architecture:** Four small changes come first. The eval gets a per-run `loaded` field and a pooled held-out paired
score. The runner refuses a round whose text is not the one staged. `dialSkill.ts` gets the spec's starting text,
guarded by red-first limit tests. Then up to two rounds run in `crowd` on train and val, one after the other, in the
main checkout. Each round reads the last round's misses from its git-ignored traces. The winner then runs val and test
in every condition, and its text stays in `dialSkill.ts`.

**Tech Stack:** TypeScript and ESM JavaScript under Node 24 (`npx tsx`), Vitest 4 (the CLI's config for `src/`, the
eval's own config for `evals/dial-skill/`), Claude Code 2.1.332 (`claude -p`, `claude-opus-5-5`, effort `high`), macOS
for the eval. Commands run from `cli/`.

**Spec:** `docs/plans/2026-11-26-needs-you-right-design.md`: Part 3 ("The skill's words", "The baseline it starts
from", "How the rounds run"), within Part 1's targets and gates, "Release order", "Platforms", "Tests (red first)" and
"Docs in the same pull requests". Read it with this plan. The spec file stays uncommitted: Part 6's pull request
carries it.

## Global Constraints

- **Scope.** `cli/src/devices/dialSkill.ts` and its spec, `cli/evals/dial-skill/**`, `docs/cli.md` (the notify row
  only), and this plan. Nothing in `cli/src/core/`, `plugins/`, `backend/`. No release: harness-pm releases it with or
  after Parts 2 and 2b.
- **Commit only the files a task names** (`git add <path>…`, never `git add -A` or `.`). The spec file must never be
  staged.
- **The text's limits** (spec, Part 3): `DIAL_SKILL` is under 4096 bytes; the name stays `dial`; the marker line
  stays `# Written by Harness. Remove it with harness device claude disable or harness device codex disable.`; no new
  front-matter field. The description is one JSON-quoted line of at most 600 characters, with the moment and
  `harness device notify` in its first 300. Task 4's tests check all of these.
- **What stays in the body, from #4545:** never block on a question form; `--proceeding` against `--waiting` and what
  must wait; never for done or progress; one notice per ask; no secret in the line; the answer carries the whole ask
  whatever the command prints. New: every such turn rings, a short one too ("Harness decides whether the dial
  sounds"), and an offer of more work is not an ask.
- **Claude Code only.** No Codex run. Nothing reads or writes `~/.codex` or `~/.codex-hq`. No sign-in is copied.
  `CLAUDE_CONFIG_DIR` is the session's profile, already set in the session; never `~/.claude` (the runner refuses
  it).
- **Spend.** Pass `--spend-cap-usd 115` on every pass (the PM, 2026-11-26). The cap counts the whole flow, the
  baseline's $47.49 included, so about $67.5 is left for Part 3: two rounds, the winner's pass and a third rep fit.
  Exit 4 (the cap) or exit 3 (the account limit): stop and report to the PM with the spend so far. Never raise the
  cap, switch accounts or work around a limit. Use `--concurrency 3` at most and `--timeout-s 900`. Run no CPU-heavy
  loop on the Mac.
- **No transcript text leaves the Mac.** Each round's traces (`flow/<variant>/traces/`) and `private.jsonl` stay
  git-ignored on this Mac. Commits, `change.md`, `narrative.md`, the README and the PR hold numbers, scenario names,
  fixed ids, metric names, the skill's own text, and the executor's own reading of the behavior. They never hold a
  quote from an answer, a tool's output or a judge's reason.
- **Red, then green.** A behavior task commits its failing test first, then the change. Run only the named specs:
  `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts evals/dial-skill/<file>.spec.ts` for the
  eval, `cd cli && npx vitest run src/devices/dialSkill.spec.ts` for the skill. No fixed sleeps.
- **Comments say why** (cli/AGENTS.md). Names and copy follow `docs/naming-system.md`. Runner messages are short and
  say what to do.
- **Platforms:** the skill file is the same on macOS, Linux and Windows. The eval runs on macOS only. The PR names all
  three.

## What this plan decides from the spec's words

- **Round 1 measures the spec's starting text.** The README's convention is that `flow/v<k>/SKILL.before.md` is the
  text round k started from and `flow/v<k>/SKILL.md` is round k's text. So `v1/SKILL.before.md` is today's text (the
  baseline) and `v1/SKILL.md` is the spec's starting text, verbatim. Round 2 starts from v1's text and tightens it.
- **`loaded`** is in the grade of every scored run (need and no-need, rang or not, harmed too): 1 when a tool call
  loads the dial's body, by the same test `one_step` uses (`loadsDial` in `lib/grade.ts`: a `Skill` call whose input
  `skill` is `dial`, or a tool call naming `.claude/skills/dial/SKILL.md`). An invalid, truncated or unlisted run has
  no grade, as today. It is reported beside `one_step`: a rate in the aggregate table and `k of n` over the scored
  held-out runs in the held-out table. The baseline's rows have none (its traces are not on this Mac), so its cells
  read `n/a` and `0 of 0`.
- **The moment in the description** is pinned by a test constant, `MOMENT = 'end a turn that leaves the person
  something to decide, answer or do'` (the spec's trigger). A round that rewords the moment changes `MOMENT` in the
  same commit and keeps its meaning: the end of a turn that leaves the person something to decide, answer or do.
- **A round is kept** by the flow's own goal (`_state.json`: target `score`, hold `quiet`, `ask_ok`, `harmed`,
  `went_on`). v1 is kept when its paired crowd val score against the baseline is above 0.2, the earlier flow's keep
  threshold, and its holds on train and val are no worse than the baseline's by more than one run. v2 is kept over v1
  when its crowd val mean is above v1's by more than 0.2 and it has no more needless rings on train and val. The
  winner is the last kept round. With no kept round, Task 7 stops and reports to the PM ("If no round meets the
  gates", below).
- **The gates** (the PM, 2026-11-26) are read in `crowd`, val and test pooled, on the held-out table: recall at
  least 29 of 32, needless rings at most 1 of 18, `line_ok` at least 85%, and `harmed` and `went_on` at most one run
  worse than the baseline's held-out crowd counts (0 of 8 harmed, 6 of 8 went on: so at most 1 harmed and at least 5
  went on). When the variant's scored n differs from the baseline's (a third rep, an invalid run), the comparison is
  of rates, and one run is one run of the variant's n. "Above the baseline beyond noise" is Task 3's pooled paired 95%
  interval of the crowd score lying above 0.
- **If no round meets the gates** (the PM, 2026-11-26): stop and report to the PM with the best variant's numbers
  before anything more, and before the pull request opens. The default is to keep today's text: `DIAL_SKILL` goes
  back to `flow/v1/SKILL.before.md`, the moment-and-command test (Task 4) is dropped, and the pull request carries the
  eval changes and the rows as findings for Part 4. The PM may instead ship a variant that is above the baseline
  beyond noise but misses the gates; then its text stays. Task 7, Steps 10 and 11 apply whichever the PM picks.
- **Round 2 runs only when it is worth it and fits the cap.** Skip it when v1 already meets every target on crowd val
  alone: recall at least 15 of 16, no needless ring, `line_ok` at least 85%. If the flow's spend after round 1, plus
  about $16 for round 2 and about $27 for the winner's pass, would pass the $115 cap, round 1 cost far more than
  planned: stop and report to the PM, who decides. When round 2 is skipped as not worth it, Task 6 writes why in
  `narrative.md` and commits only that.
- **"Within one run of its line"** (Part 1's third-rep rule): a number for which one run scored the other way would
  put it on the other side of its line. With 32 need runs, recall of 28 or 29 qualifies. With 18 no-need runs, 1 or 2
  needless rings qualify. `line_ok` qualifies when one run either way crosses 85%. At 3 reps the targets read as
  their rates: recall at least 90%, needless rings at most 1 in 18 no-need runs, `line_ok` at least 85%. Only `crowd`
  gets a third rep, since the gates are read there.
- **The runner checks the round's text.** Until now a person set `dialSkill.ts` to the round's text by hand, and
  nothing checked it. A round measured under the wrong text costs about $15 and gives false numbers. So the runner
  refuses a variant whose `SKILL.md` differs from `DIAL_SKILL` (code standard 13).

## Spend plan

Per-run cost from the baseline: crowd $0.294, clean $0.235, name-only $0.29, a probe about $0.2.

| Step | Runs | About |
|---|---|---|
| Spent (baseline, probes included) | 177 | $47.49 |
| Round 1: v1, crowd, train and val, 2 reps | 52 + 1 probe | $15.5 |
| Round 2: v2, the same | 52 + 1 probe | $15.5 |
| Winner: crowd test (val already ran), clean val and test, at 2 reps | 24 + 50 + 2 probes | $19.5 |
| Winner: name-only val and test, 1 rep | 25 + 1 probe | $7.5 |
| Third rep, crowd val and test, if a number is within one run | 25 | $7.4 |

The cap is $115 (the PM, 2026-11-26), about $67.5 for Part 3. Two rounds plus the winner's pass come to about $58
(flow about $105.5), and a third rep brings the flow to about $113: all of it fits. Every pass carries
`--spend-cap-usd 115`. A pass that would go over stops at exit 4: stop and report to the PM, never raise the cap.

## Review Focus

1. **The listing probe on the new description.** The new description holds `"`, `<` and `>`. If Claude Code renders
   any of them differently in its listing, the probe reads `cut`, and the pass exits 2 before any case. Round 1's
   probe is the real-CLI check. On exit 2, stop and report. Never loosen `lib/probe.ts` to make it pass.
2. **A round measured under the wrong text.** For example, the winner is v1 but `dialSkill.ts` still holds v2's text.
   Task 2's refusal prevents it. Its spec holds a mismatched `SKILL.md`.
3. **`loaded` counted from what is not a call.** A tool result that lists the path (an `ls`, a `find`), or a skill's
   args that name `dial`, must not count. Task 1's spec holds both.
4. **Transcript text in a commit.** `change.md` and the narrative are written by hand from traces. Before each commit,
   each round task greps what it stages for quote blocks, paths and the user name, and runs `scrub` (Tasks 5 to 8).
5. **A description Codex or Claude Code skips without a word.** If the quoted line does not parse as YAML, the engine
   skips the skill. The existing front-matter test parses `DIAL_SKILL` with `yaml` and expects exactly
   `{ name, description }`. It runs on every text, every round's included.

## Tasks at a glance

| # | Task | Depends on | Effort | Where |
|---|---|---|---|---|
| 1 | `loaded` on every run, in both tables | none | high | any worktree |
| 2 | The runner refuses a round whose text is not staged | none | high | any worktree |
| 3 | The held-out score paired with the baseline | none | high | any worktree |
| 4 | The description's limits, and the spec's starting text | none | medium | any worktree |
| 5 | Round 1: v1 in crowd, train and val | 1, 2, 3, 4 | high | main checkout |
| 6 | Round 2: v2 in crowd, train and val (or why not) | 5 | high | main checkout |
| 7 | The winner's pass: val and test in every condition | 6 | high | main checkout |
| 8 | Docs: results, narrative, `docs/cli.md` | 7 | medium | main checkout |

Tasks 1, 2 and 3 share `run-eval.spec.ts`, `summarize.ts` or the README, so devcrew runs them one at a time. Task 4
shares no file with them. Tasks 5 to 8 run in the main checkout, on the branch that holds Tasks 1 to 4.
They run there and not in a task worktree because each round's git-ignored traces must outlive the task for the next
round to read.

---

### Task 1: `loaded` on every run, in both tables

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `cli/evals/dial-skill/lib/grade.ts`, `cli/evals/dial-skill/lib/summarize.ts`,
  `cli/evals/dial-skill/flow/_state.json` (`metrics` only), `cli/evals/dial-skill/flow/metrics.md` (the metric row),
  `cli/evals/dial-skill/README.md` (the sentence on `one_step`)
- Test: `cli/evals/dial-skill/grade.spec.ts`, `cli/evals/dial-skill/summarize.spec.ts`,
  `cli/evals/dial-skill/state.spec.ts`, `cli/evals/dial-skill/run-eval.spec.ts` (the grades it expects gain `loaded`)

**Interfaces:**
- Produces: `export function loaded(transcript: Turn[]): boolean` in `lib/grade.ts`: true when any `tool_call` turn
  passes `loadsDial`. `gradeRun`'s `grade` gains `loaded: 0 | 1` on every scored run (beside `one_step`'s spread, in
  each of its three returns). `VariantStats.loaded: number` (a rate over the scored train and val rows that have it).
  `HeldOut` gains `loaded: number; loaded_n: number` (`loaded_n`: the scored held-out rows that have it).
  `aggregateTable` and `heldOutTable` gain a `loaded` column right after `one_step`.

- [ ] **Step 1: Write the failing tests.**
  - `grade.spec.ts`, `describe('loaded')`:
    - `'is true for a Skill call for dial or a call naming its SKILL.md'`: `loaded([skill('dial')])`,
      `loaded([call('Read', { file_path: '<run>/repo/.claude/skills/dial/SKILL.md' })])` and
      `loaded([call('Bash', { command: 'cat .claude/skills/dial/SKILL.md' })])` are `true`.
    - `'is false for another skill, args naming dial, a tool result, or nothing'`:
      `loaded([skill('dial-tone'), call('Skill', { skill: 'tdd', args: 'dial' })])`,
      `loaded([{ role: 'tool_result', content: '.claude/skills/dial/SKILL.md' }])` and `loaded([])` are `false`.
  - `grade.spec.ts`, under gradeRun:
    - `'gives loaded on every scored run, rang or not'`: a silent need run whose transcript holds `skill('dial')` has
      `grade.loaded` 1 and no `one_step`. A quiet no-need run has `{ score: 0, rang: 0, quiet: 1, loaded: 0 }`. A
      harmed run has `loaded`.
    - `'gives no loaded to an invalid or truncated run'`: grade `{}`.
    - Every existing `toEqual` on a grade gains its `loaded` value.
  - `summarize.spec.ts`:
    - `'takes loaded as a rate over every scored row'`: rows with `loaded` 1, 0, 1 and a truncated one with 1 give
      `2 / 3`.
    - `'counts loaded over the scored held-out rows'`: `held_out.loaded` and `loaded_n`.
    - `'reads n/a and 0 of 0 for rows with no loaded'`: the baseline's shape.
    - The aggregate and held-out headers end `…, 'one_step', 'loaded', …` and `…, 'one_step', 'loaded'`.
  - `state.spec.ts`: `'declares loaded, a rate outside the guardrails'`:
    `{ id: 'loaded', label: 'Loaded', kind: 'float', scale: 1 }`, and `goal.hold` does not contain `loaded`.
  - `run-eval.spec.ts`: the expected grades at the oracle row (about line 271) and the harmed row (about line 1062)
    gain `loaded: 0`.
- [ ] **Step 2: Run them; expected FAIL** (`loaded` is not exported; grades lack it; headers differ).
  `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts evals/dial-skill/grade.spec.ts evals/dial-skill/summarize.spec.ts evals/dial-skill/state.spec.ts evals/dial-skill/run-eval.spec.ts`
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): loaded on every run`).
- [ ] **Step 4: Implement.**
  - `lib/grade.ts`: add `loaded`. In `gradeRun`, put `loaded: Number(loaded(run.transcript))` in each of the three
    graded returns.
  - `lib/summarize.ts`: add `loaded: rate(scored, 'loaded')`. In `heldOut`, add `loaded: sum('loaded')` and
    `loaded_n: count('loaded')`. Add the column after `one_step` in both tables, with `pct(x.loaded)` and
    `of(h.loaded, h.loaded_n)`.
  - `_state.json`: append the metric after `one_step`.
  - `metrics.md`: a `loaded` row after `one_step`: "all scored | 1 when the run loaded the dial's body at any point (a
    `Skill` call for `dial`, or a tool call naming `.claude/skills/dial/SKILL.md`). A miss with `loaded` 0 never
    looked (the description), one with 1 looked and did not ring (the body). Outside `score`."
  - README: one sentence after the one on `one_step`.
- [ ] **Step 5: Run the eval's whole suite; expected PASS.**
  `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts`
- [ ] **Step 6: Commit** (`feat(dial-eval): loaded says whether a run read the dial skill's body`).

### Task 2: The runner refuses a round whose text is not staged

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `cli/evals/dial-skill/run-eval.mjs`, `cli/evals/dial-skill/README.md` (Run: one sentence)
- Test: `cli/evals/dial-skill/run-eval.spec.ts`

**Interfaces:**
- Produces: before any probe or case (right after `checkHarness`), when `<flow>/<variant>/SKILL.md` exists and is not
  byte for byte `DIAL_SKILL` (imported from `../../src/devices/dialSkill.ts`), the runner prints
  `<variant>/SKILL.md is not the text cli/src/devices/dialSkill.ts holds: set the file to it, then rerun` and exits 2.
  A variant with no `SKILL.md` (the baseline) runs as today.

- [ ] **Step 1: Write the failing tests** in `describe('run-eval.mjs pass')`, with the stand-in agents:
  - `"refuses a variant whose SKILL.md is not the text dialSkill.ts holds, before any probe or case"`:
    `flow/v1/SKILL.md` holds `DIAL_SKILL + 'x'`. Expect exit 2, stderr containing `v1/SKILL.md is not the text`, and
    no `results.jsonl`, `probes.jsonl` or `summary.json` under `v1/`.
  - `'runs a variant whose SKILL.md is DIAL_SKILL'`: the same pass with `SKILL.md` = `DIAL_SKILL` exits 0 and writes
    its rows.
- [ ] **Step 2: Run; expected FAIL** (the first pass exits 0).
  `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts evals/dial-skill/run-eval.spec.ts`
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): a round runs only under its own text`).
- [ ] **Step 4: Implement** in `run-eval.mjs`, reading `SKILL.md` through the existing `readIfPresent`. Add a comment
  saying why: the runner stages whatever the file holds.
- [ ] **Step 5: Run `run-eval.spec.ts` and `state.spec.ts` (the import list); expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): the runner refuses a round whose text is not the one staged`).

### Task 3: The held-out score paired with the baseline

**Depends on:** none. **Effort:** high. This column is the gate "above the baseline beyond noise" (the PM,
2026-11-26): the pooled paired 95% interval of the crowd score, val and test together, lies above 0. Task 7 reads it.

**Files:**
- Modify: `cli/evals/dial-skill/lib/summarize.ts`, `cli/evals/dial-skill/flow/metrics.md` (the prose on the held-out
  table)
- Test: `cli/evals/dial-skill/summarize.spec.ts`

**Interfaces:**
- Produces: `Summary.held_out_paired: Record<string, Record<string, Paired>>` (variant → condition). These are the
  paired differences of case means over the val and test cases pooled that both the variant and the baseline's same
  condition scored, with the same `interval` and `significant` as `paired`. The held-out table gains a last column,
  `score vs baseline`: `+3.00 [0.52, 5.48]`, `n/a` with no shared case, empty on the baseline's rows.

- [ ] **Step 1: Write the failing tests:**
  - `'pairs each variant with the baseline over the val and test cases pooled'`: baseline crowd case means val `a` 0,
    val `b` 0, test `c` 0, and v1 crowd 2, 3, 4. Expect `held_out_paired.v1.crowd`: n 3, mean 3, `ci_lo` close to
    0.5156, `ci_hi` close to 5.4844, significant `true`.
  - `'shows the pooled paired score in the held-out table'`: the v1 crowd row ends `| +3.00 [0.52, 5.48] |`, and the
    baseline's row ends `|  |`.
- [ ] **Step 2: Run `summarize.spec.ts`; expected FAIL.**
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): the held-out score paired with the baseline`).
- [ ] **Step 4: Implement** next to the per-split `paired` loop in `summarize()`. Update the sentence in `metrics.md`
  that lists the held-out columns.
- [ ] **Step 5: Run the eval's whole suite; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): the held-out table pairs each round with the baseline`).

### Task 4: The description's limits, and the spec's starting text

**Depends on:** none. **Effort:** medium.

**Files:**
- Modify: `cli/src/devices/dialSkill.ts` (`DIAL_SKILL_DESCRIPTION`, the body in `DIAL_SKILL`)
- Create: `cli/evals/dial-skill/flow/v1/SKILL.before.md`, `cli/evals/dial-skill/flow/v1/SKILL.md`
- Test: `cli/src/devices/dialSkill.spec.ts`

**Interfaces:**
- Produces: `DIAL_SKILL` byte for byte the spec's starting text (Part 3, the fenced block, from `---` to the last
  line, with a trailing newline). `flow/v1/SKILL.before.md` is today's `DIAL_SKILL`, and `flow/v1/SKILL.md` is the
  new one. The marker line, `DIAL_PLUGIN_ID` and every function are unchanged.

- [ ] **Step 1: Before any edit, keep today's text.** From `cli/`:
  `mkdir -p evals/dial-skill/flow/v1 && npx tsx -e 'import { DIAL_SKILL } from "./src/devices/dialSkill.ts"; process.stdout.write(DIAL_SKILL)' > evals/dial-skill/flow/v1/SKILL.before.md`
- [ ] **Step 2: Write the failing tests** in `dialSkill.spec.ts`, `describe('the dial skill')`:
  - `"the description is one JSON-quoted line of at most 600 characters"`:
    `DIAL_SKILL.split('\n')[2]` is `` `description: ${JSON.stringify(DIAL_SKILL_DESCRIPTION)}` ``. The description has
    no `\r` or `\n`. `JSON.stringify(DIAL_SKILL_DESCRIPTION).length` is at most 600. (Today's text passes this one. It
    guards the limit for every later round.)
  - `"the description holds the moment and the command in its first 300 characters"`: with
    `const MOMENT = 'end a turn that leaves the person something to decide, answer or do'`,
    `DIAL_SKILL_DESCRIPTION.slice(0, 300)` contains `MOMENT` and `'harness device notify'`. **This is the red one:**
    today's description holds neither. If no round meets the gates and the PM keeps today's text, Task 7, Step 11
    drops this test; the other limit tests stay.
  - `'the skill is under 4096 bytes'`: `Buffer.byteLength(DIAL_SKILL)` is less than 4096. The existing assertion in
    the front-matter test says at most 4096; tighten it to less than 4096 to match the spec.
  - Change the expectations that pin today's words. In the front-matter test, the body line becomes
    `'\n    harness device notify "<the ask, in one line>" --suggest "<your recommendation, a few words>" --waiting\n'`.
    `'the skill is the needs-you text, byte for byte'` becomes the spec's starting text.
- [ ] **Step 3: Run; expected FAIL** on the moment-and-command test and the byte-for-byte test.
  `cd cli && npx vitest run src/devices/dialSkill.spec.ts`
- [ ] **Step 4: Commit the red tests** (`test(dial): the skill's description carries the moment and the command`).
- [ ] **Step 5: Set the text.** `DIAL_SKILL_DESCRIPTION` = the spec's `description` value, unquoted. The body under
  the front matter = the spec's body, verbatim, with backticks escaped for the template literal. Keep the comment on
  why the description is quoted.
- [ ] **Step 6: Write v1's text.**
  `npx tsx -e 'import { DIAL_SKILL } from "./src/devices/dialSkill.ts"; process.stdout.write(DIAL_SKILL)' > evals/dial-skill/flow/v1/SKILL.md`
- [ ] **Step 7: Run; expected PASS:**
  - `npx vitest run src/devices/dialSkill.spec.ts src/cable/dialSetup.spec.ts src/cable/dialHomeSetup.spec.ts src/deviceClaude/command.spec.ts`
  - `npm run typecheck`
  - `npx vitest run --config evals/dial-skill/vitest.config.ts evals/dial-skill/crowd.spec.ts evals/dial-skill/probe.spec.ts evals/dial-skill/stage.spec.ts`.
    These import the description. `crowd.spec.ts` checks that the crowd's listing with the dial's line is at most
    20,000 characters.
- [ ] **Step 8: Commit**: `dialSkill.ts`, the two `SKILL*.md` files
  (`feat(dial): the skill rings before a turn ends on an ask, and its description carries the command`).

### Task 5: Round 1: v1 in crowd, train and val

**Depends on:** 1, 2, 3, 4. **Effort:** high. **Runs in the main checkout** (see Tasks at a glance).

**Test that must fail first:** none. This task measures. Its checks are the pass's exit code, the probe, `scrub` and
the eval's suite.

**Files:**
- Create: `cli/evals/dial-skill/flow/v1/{change.md,results.jsonl,errors.jsonl,probes.jsonl,summary.json,table.md}`
  (`errors.jsonl` only if the pass wrote one)
- Modify: `cli/evals/dial-skill/flow/narrative.md`, `cli/evals/dial-skill/flow/metrics.md` (the aggregate block, by
  `summarize`), `cli/evals/dial-skill/flow/_state.json` (`harness_sha` by `--approve-harness`, `current_round`,
  `best`)
- Git-ignored, kept on this Mac: `flow/v1/traces/`, `flow/v1/private.jsonl`

- [ ] **Step 1: Check the start.** From `cli/`: `CLAUDE_CONFIG_DIR` is set and is not `~/.claude`, and
  `git status --short` shows only the spec file modified. Run
  `diff <(npx tsx -e 'import { DIAL_SKILL } from "./src/devices/dialSkill.ts"; process.stdout.write(DIAL_SKILL)') evals/dial-skill/flow/v1/SKILL.md`;
  expect no output. Then `marker=$(mktemp)`.
- [ ] **Step 2: Run the pass.**
  `npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v1 --condition crowd --split train,val --reps 2 --concurrency 3 --timeout-s 900 --spend-cap-usd 115`
  - Exit 2, "harness changed": review `git diff 1f9e6db327 -- cli/evals/dial-skill/run-eval.mjs cli/evals/dial-skill/lib cli/package-lock.json`.
    Expect only Task 1's `lib/grade.ts` and Task 2's `run-eval.mjs`. If so, rerun with `--approve-harness`. Anything
    else (a lockfile change, say): stop and report.
  - Exit 2, `listing probe · crowd: …`: stop and report the probe row's dial state (Review Focus 1).
  - Exit 1: rerun the same command, which runs only the failed cases. Exit 3 or 4: stop and report the spend so far
    to the PM.
  - Expected: 1 probe passing, 52 rows, about $15.5.
- [ ] **Step 3: Check the profile:** `find -H "$CLAUDE_CONFIG_DIR"/ "$CLAUDE_CONFIG_DIR"/*/ -newer "$marker" | sort -u`
  lists only the startup files the README names.
- [ ] **Step 4: Summarize:** `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow`.
- [ ] **Step 5: Read the misses** from `flow/v1/traces/` and the rows (judge reasons sit in the rows until Step 8).
  Sort every crowd need run with `hit` 0 into one of two kinds: `loaded` 0 (never looked: the description) or
  `loaded` 1 (looked and did not ring: the body). Also list every needless ring, every `line_ok` 0 with its fault
  kind (flags, a second ring, the judge), and every `went_on` or harm change against the baseline's same cases.
  Compare with the baseline's crowd train and val rows by scenario.
- [ ] **Step 6: Write `flow/v1/change.md`.** Its first line is the round's title, which the status table shows, for
  example `# Round 1: the spec's starting text`. Then three parts:
  - **Evidence:** counts per kind and scenario names.
  - **Change:** what v1 changed against the baseline, in the skill's own words.
  - **Result:** crowd val score and paired, recall, needless rings, `line_ok`, `loaded`, `one_step`, harmed,
    `went_on`, and spend.

  Add a `## Round 1` section to `narrative.md` below the held-out block with the same numbers. End it with a reading
  of what round 2 should change, aimed at the larger of the two miss kinds. No transcript text.
- [ ] **Step 7: Keep or not.** Apply "A round is kept" (above). If kept, `_state.json`: `current_round` 1, `best`
  `{ "round": 1, "val_score": <crowd val mean> }`. If not kept, `current_round` 1 and `best` stays `null`. Rerun
  `summarize`.
- [ ] **Step 8: Make the rows fit to commit:**
  - `npx tsx evals/dial-skill/flow-rows.ts scrub evals/dial-skill/flow`: expect exit 0.
  - `node evals/dial-skill/build-report-lite.mjs evals/dial-skill/flow`.
  - `git status --short -- evals/dial-skill/flow`: shows only the files listed above. `traces/`, `private.jsonl`,
    `report.html` and `progress.txt` stay ignored.
  - `grep -nE '^>|/Users/|~/|'"$(whoami)" evals/dial-skill/flow/v1/change.md evals/dial-skill/flow/narrative.md`:
    expect no output.
- [ ] **Step 9: Run the eval's suite:** `npx vitest run --config evals/dial-skill/vitest.config.ts`. Expect PASS.
- [ ] **Step 10: Commit** the files listed above
  (`Dial skill eval: round 1, the spec's starting text, in crowd on train and val`).

**Report:** exit codes, rows, crowd train and val numbers, the held-out (val) row, the miss counts by kind, spend
this round and in the flow, and kept or not.

### Task 6: Round 2: v2 in crowd, train and val (or why not)

**Depends on:** 5. **Effort:** high. **Runs in the main checkout.**

**Test that must fail first:** none. The text is copy measured by the eval. Task 4's limit tests must stay green
with the new text.

**Files:**
- Modify: `cli/src/devices/dialSkill.ts`, `cli/src/devices/dialSkill.spec.ts` (the byte-for-byte text, the body line
  in the front-matter test, and `MOMENT` if the moment's words change)
- Create: `cli/evals/dial-skill/flow/v2/{SKILL.before.md,SKILL.md,change.md,results.jsonl,errors.jsonl,probes.jsonl,summary.json,table.md}`
- Modify: `cli/evals/dial-skill/flow/narrative.md`, `cli/evals/dial-skill/flow/metrics.md`,
  `cli/evals/dial-skill/flow/_state.json`

- [ ] **Step 1: Decide whether round 2 runs** ("Round 2 runs only when it is worth it and fits the cap", above). Read
  the flow's spend from the status table's last `spend` cell. If the flow's spend plus about $43 passes $115, stop and
  report to the PM; nothing is committed. If v1 already meets every target on crowd val, add a
  `## Round 2: not run` section to `narrative.md` with the reason and the numbers, commit only `narrative.md`, and
  report. The rest of this task is then skipped.
- [ ] **Step 2: Write v2's text.** Copy `flow/v1/SKILL.md` to `flow/v2/SKILL.before.md`. Change
  `DIAL_SKILL_DESCRIPTION` and/or the body in `dialSkill.ts`. Make one change aimed at the larger miss kind from
  round 1's reading, within the Global Constraints' limits and "What stays". Update the spec's byte-for-byte text and
  body line (and `MOMENT` if reworded). Then write `flow/v2/SKILL.md` with the `npx tsx -e …` line of Task 4, Step 6.
- [ ] **Step 3: Run the skill's specs:** `npx vitest run src/devices/dialSkill.spec.ts` and
  `npx vitest run --config evals/dial-skill/vitest.config.ts evals/dial-skill/crowd.spec.ts evals/dial-skill/probe.spec.ts evals/dial-skill/stage.spec.ts`.
  Expect PASS.
- [ ] **Step 4: Run the pass,** as Task 5, Step 2, with `--variant v2`. No harness change is expected, so an exit 2
  for "harness changed" means something moved: stop and report.
- [ ] **Steps 5 to 9:** as Task 5, Steps 3 to 9, for v2. "Keep or not" compares v2 with v1 (and with the baseline if
  v1 was not kept). If v2 is kept, `best` is `{ "round": 2, "val_score": … }`.
- [ ] **Step 10: Commit** `dialSkill.ts`, `dialSkill.spec.ts` and the v2 files listed above
  (`Dial skill eval: round 2, <title>, in crowd on train and val`).

**Report:** as Task 5, plus which round is the winner so far.

### Task 7: The winner's pass: val and test in every condition

**Depends on:** 6. **Effort:** high. **Runs in the main checkout.**

**Test that must fail first:** none for the pass, which measures. Step 11 (only if the PM keeps today's text) changes
behavior and commits its red test first.

**Files:**
- Modify (only if the winner is v1 and `dialSkill.ts` holds v2's text, or if the PM keeps today's text in Step 11):
  `cli/src/devices/dialSkill.ts`, `cli/src/devices/dialSkill.spec.ts`
- Modify: `cli/evals/dial-skill/flow/v<w>/{results.jsonl,errors.jsonl,probes.jsonl,summary.json,table.md}`,
  `cli/evals/dial-skill/flow/narrative.md`, `cli/evals/dial-skill/flow/metrics.md`,
  `cli/evals/dial-skill/flow/_state.json`

- [ ] **Step 1: The winner** is `best.round` from `_state.json`. If `best` is `null`, no round was kept: stop and
  report to the PM with the better round's crowd train and val numbers against the baseline ("If no round meets the
  gates", above). The pass does not run; on the PM's answer, go to Step 11. Otherwise make `DIAL_SKILL` byte for byte
  `flow/v<w>/SKILL.md` (the `diff` of Task 5, Step 1). If you edit it, run
  `npx vitest run src/devices/dialSkill.spec.ts`; expect PASS. Then `marker=$(mktemp)`.
- [ ] **Step 2: Check the spend.** The flow's spend plus about $27 must fit under $115. If not, stop and report to the
  PM.
- [ ] **Step 3: Run the pass:**
  - `npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v<w> --condition clean,crowd --split val,test --reps 2 --concurrency 3 --timeout-s 900 --spend-cap-usd 115`.
    Crowd val's rows from the round are resumed, not rerun.
  - `npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v<w> --condition name-only --split val,test --reps 1 --concurrency 3 --timeout-s 900 --spend-cap-usd 115`
  - Exit codes are handled as in Task 5, Step 2 (exit 3 or 4: stop and report to the PM). Expected: 99 new rows
    (24 crowd test, 50 clean, 25 name-only), 3 probes, about $27.
- [ ] **Step 4:** the profile check, then `summarize`.
- [ ] **Step 5: Read the gates** ("The gates", above) from the held-out table's crowd row for `v<w>` (val and test
  pooled), against the baseline's crowd row:
  - recall at least 29 of 32;
  - needless rings at most 1 of 18;
  - `line_ok` at least 85%;
  - `harmed` at most 1 and `went_on` at least 5 (one run worse than the baseline's 0 of 8 and 6 of 8);
  - and, for the report, Task 3's `score vs baseline` column: whether its interval lies above 0.

  If any of the first four numbers is "within one run of its line", run the third rep: the same crowd command with
  `--condition crowd --reps 3` (only rep 2 runs; about $7.4). It must fit under $115 with the flow's spend; if not,
  stop and report to the PM. Then summarize again and read the gates as rates.
- [ ] **Step 6:** set `_state.json` `best.test_score` (the crowd test mean), then `summarize`, `scrub`,
  `build-report-lite` and the `git status` and grep checks, as Task 5, Step 8.
- [ ] **Step 7: Run the eval's suite and the skill's spec;** expect PASS.
- [ ] **Step 8: Commit** the rows and flow files above (`Dial skill eval: v<w> on val and test in every condition`).
  The measurement is committed whatever the verdict.
- [ ] **Step 9: The verdict.** v<w> ships when it meets every gate of Step 5. `name-only` and `clean` are reported,
  not gated. If it ships, the task ends here.
- [ ] **Step 10: A gate missed: stop and report to the PM** before Task 8 and before any pull request opens. The
  report holds the best variant's numbers: each gate's number and line, the `score vs baseline` interval, needless
  rings against the baseline's, `harmed`, `went_on`, the third rep or not, and the spend. The PM picks one:
  - ship v<w> anyway (above the baseline beyond noise, missing a gate): its text stays, and the task ends here;
  - keep today's text (the default): Step 11.
- [ ] **Step 11: Today's text back** (only on the PM's choice, or with no kept round).
  - Red: in `dialSkill.spec.ts`, the byte-for-byte test and the front-matter test's body line take their expected
    text from `git show 1f9e6db327:cli/src/devices/dialSkill.spec.ts`. Drop the moment-and-command test and `MOMENT`.
    Keep the one-line, 600-character and under-4096-bytes tests. Run `npx vitest run src/devices/dialSkill.spec.ts`;
    expect FAIL on the byte-for-byte test. Commit (`test(dial): the skill keeps today's text`).
  - Green: `git checkout 1f9e6db327 -- cli/src/devices/dialSkill.ts`. Check
    `diff <(npx tsx -e 'import { DIAL_SKILL } from "./src/devices/dialSkill.ts"; process.stdout.write(DIAL_SKILL)') evals/dial-skill/flow/v1/SKILL.before.md`
    prints nothing. Run the specs and typecheck of Task 4, Step 7; expect PASS. Commit `dialSkill.ts`
    (`Dial skill: today's text stays; Part 3's rounds are findings for Part 4`).

**Report:** the held-out table (baseline beside v<w>, every condition), each gate pass or fail, the `score vs
baseline` interval, third rep or not, the verdict (or the PM's choice), and spend in the flow.

### Task 8: Docs: results, narrative, `docs/cli.md`

**Depends on:** 7. **Effort:** medium. **Runs in the main checkout.**

**Test that must fail first:** none. No behavior changes, so this is one commit.

**Files:**
- Modify: `cli/evals/dial-skill/README.md` (Results; Cost's line on later parts),
  `cli/evals/dial-skill/flow/narrative.md` (the headline and a "Recommended change" or "Findings for Part 4"
  section), `docs/cli.md` (the `harness device notify` row's first sentence only, and only when a variant's text
  ships)

The outcome of Task 7 decides two steps: a variant's text ships (the gates met, or the PM chose to ship it), or
today's text stays (Task 7, Step 11).

- [ ] **Step 1: README Results.** Add a block for Part 3's winner (or best variant) above the baseline's:
  - the held-out counts of the baseline and v<w> side by side for `crowd`, `clean` and `name-only`, with `loaded`,
    `one_step` and the paired score;
  - the rounds run, kept or not, with one line each on what changed;
  - each gate's verdict, the `score vs baseline` interval, and which text shipped (and, if the PM decided, that it
    was the PM's choice);
  - the spend per round and in total.

  Change the Cost paragraph's "Later parts pass a larger cap" to state what Part 3 passed ($115 for the flow) and
  spent.
- [ ] **Step 2: `narrative.md`.** Add a headline line per condition (the `summarize` headline output). When a
  variant's text ships, add a "Recommended change" section: what the text changes against the baseline and why,
  from the rounds' readings. When today's text stays, add a "Findings for Part 4" section instead: which gates the
  best variant missed, by how much, and the miss kinds (`loaded` 0 against 1). Numbers only.
- [ ] **Step 3: `docs/cli.md`** (only when a variant's text ships; when today's text stays, the row is unchanged and
  this step is skipped). The notify row says an agent rings "when the person must decide or act, and keep
  working". Make it say the winner's moment, for example "before it ends a turn that leaves the person something to
  decide, answer or do", and drop "and keep working", which `--waiting` contradicts. Leave the rest of the row as it
  is. `cli/AGENTS.md` does not quote the skill's words, so it stays unchanged.
- [ ] **Step 4:** run `grep -nE '^>|/Users/|~/|'"$(whoami)"` on the three files; expect no new hit. Then run
  `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow` once more; expect the narrative's tables unchanged.
- [ ] **Step 5: Commit** (`Dial skill: Part 3's results, and the notify row says when an agent rings`, or
  `Dial skill eval: Part 3's results, findings for Part 4` when today's text stays).

---

## Verification

1. **The eval's unit specs** (no tokens; local, this Mac, after Task 4 and again after Task 8):
   `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts`. Expected: every spec passes. These are
   macOS only, and no GitHub workflow runs them (they sit outside `npm test` by design). The proposal from Part 1
   stands, not added: a macOS PR job for `cli/evals/dial-skill/**`.

2. **The skill's own specs and typecheck** (local, then PR CI): `cd cli && npx vitest run src/devices/dialSkill.spec.ts
   src/cable/dialSetup.spec.ts src/cable/dialHomeSetup.spec.ts src/deviceClaude/command.spec.ts && npm run typecheck`.
   PR CI runs `cli-typecheck` and `cli-tests`. Because `cli/src/devices/` changes, it also runs `windows-e2e` on x64
   (the skill file on Windows), plus `pty-checks` and the companions the `cli/` path selects. None of these is
   started by hand.

3. **The eval passes are the end-to-end checks** (local, this Mac; no VM, no workflow). **They need the user's own
   Claude Code sign-in**, through the session profile in `CLAUDE_CONFIG_DIR`, never `~/.claude`. Isolation is the
   eval's own (README, Isolation): each run is a temp git repo under the system temp folder, with a fake `harness`
   (no daemon, no dial), the curated `PATH`, `--setting-sources project`, Claude's sandbox with only
   `registry.npmjs.org` reachable, `sandbox-exec` for the checks, and no backend at all. From `cli/`:

   ```sh
   # Task 5 (and Task 6 with --variant v2)
   npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v1 --condition crowd --split train,val --reps 2 --concurrency 3 --timeout-s 900 --spend-cap-usd 115
   # Task 7
   npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v<w> --condition clean,crowd --split val,test --reps 2 --concurrency 3 --timeout-s 900 --spend-cap-usd 115
   npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v<w> --condition name-only --split val,test --reps 1 --concurrency 3 --timeout-s 900 --spend-cap-usd 115
   # Task 7, only if a gate's number is within one run of its line
   npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v<w> --condition crowd --split val,test --reps 3 --concurrency 3 --timeout-s 900 --spend-cap-usd 115
   ```

   Expected: each probe passes, with the dial's line `full` in crowd and clean and `name-only` in name-only. Rows
   match the counts in Tasks 5 to 7, the flow's spend stays under $115 (about $105.5, or $113 with a third rep), and
   the gates read as Task 7, Step 5 says: crowd, val and test pooled, recall at least 29 of 32, needless rings at
   most 1 of 18, `line_ok` at least 85%, `harmed` at most 1, `went_on` at least 5. Exit 3 or 4, or a missed gate,
   stops the flow with a report to the PM before the pull request opens. After each
   pass, `find -H "$CLAUDE_CONFIG_DIR"/ "$CLAUDE_CONFIG_DIR"/*/ -newer "$marker" | sort -u` lists only the startup
   files the README names.

4. **Rows fit to commit** (local; part of Tasks 5 to 8): `flow-rows.ts scrub` exits 0, `git status` shows only the
   named files, and the grep for quotes, paths and the user name finds nothing.

5. **Local gates PR CI does not run** (docs/validation-and-release.md): none apply. No file under `src/core/`,
   `src/services/`, `src/harnessd/` or any other coverage gate's area changes (`dialSkill.ts` is under no gate). Run
   no `cli/e2e` file: the skill's file handling is unchanged, and `cli/e2e/deviceDialSkill.e2e.ts` compares against
   `DIAL_SKILL` whatever its words.

6. **Codex** is not run (Decision 2). It is read in the field after harness-pm releases this with or after Parts 2
   and 2b: #4642's counts per engine for 7 days. That is outside this pull request.

Evidence for the PR body (counts and rates only): the held-out table for the baseline and v<w> in every condition;
each round's crowd train and val numbers with `loaded` and the miss kinds; the gates, the `score vs baseline`
interval and the shipping verdict (or the PM's choice); spend per pass and in the flow; Claude Code's version; the
red-then-green commits of Tasks 1 to 4 (and of Task 7, Step 11 when today's text stays); and the platforms (macOS,
Linux, Windows; the eval on macOS).

## Decided by the PM (2026-11-26)

1. **Spend cap.** Every pass carries `--spend-cap-usd 115`: about $67.5 for Part 3 on top of the flow's $47.49. Two
   rounds, then the winner's pass, fit (with a third rep). Going over means stop and report to the PM (Global
   Constraints, Spend plan, Tasks 5 to 7).
2. **Gates.** The main gates are the spec's absolute numbers in `crowd`, val and test pooled: recall at least 29 of
   32, needless rings at most 1 of 18, `line_ok` at least 85%. "Above the baseline beyond noise" is the paired 95%
   interval of the crowd score difference, val and test pooled, lying above 0 (Task 3). `harmed` and `went_on`: at
   most one run worse than the baseline. A number within one run of its gate line gets a third rep before it decides,
   per the spec (Task 7, Step 5).
3. **No round meets the gates.** Option (a): keep today's text, drop the "command within the first 300 characters"
   test, and the pull request carries the eval changes and the rows as findings for Part 4. Before the pull request
   opens, stop and report to the PM with the best variant's numbers; the PM decides whether to ship a variant better
   than the baseline that misses the gates (Task 7, Steps 9 to 11; Task 8).
