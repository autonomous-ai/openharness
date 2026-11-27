# Needs you, right: Part 1, an eval that resembles real sessions, Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** The dial skill eval (`cli/evals/dial-skill/`) runs Claude Code in three conditions (`clean`, `crowd`,
`name-only`), proves before each pass that the model was given the dial's description, holds 38 scenarios split
13 / 13 / 12, reports every metric per condition plus `one_step`, stages a variant's hooks, stops before a spend cap,
and then runs the baseline pass.

**Architecture:** A condition is one more dimension of a case: `<scenario>.<agent>.<condition>`. The stage copies the
crowd (eval-written skills and a `CLAUDE.md`) into the run's repo, and the run's own `--settings` drops the dial's
description for `name-only`. Before a pass, the runner runs one short probe per condition whose session is kept just
long enough to read Claude Code's `skill_listing` attachment from its transcript; each run is then matched to its
probe by the skills and the Claude Code version its stream reports. Spend is priced in one place (`lib/spend.ts`),
which the summary and a guard in the runner share.

**Tech Stack:** TypeScript and ESM JavaScript under Node 24 (`npx tsx`), Vitest 4 with the eval's own config, macOS
`sandbox-exec` and `lsof` (the eval is macOS only), Claude Code 2.1.332 (`claude -p`). Commands run from `cli/`.

**Spec:** `docs/plans/2026-11-26-needs-you-right-design.md`, Part 1 only ("Part 1. An eval that resembles real
sessions", "What was measured", "Tests", "Docs in the same pull requests"). Read it with this plan.

## Global Constraints

- **Scope.** Only `cli/evals/dial-skill/**` changes, plus this plan. Nothing in `cli/src`, `plugins/`, `backend/`; no
  release. `DIAL_SKILL` stays as checked in: the baseline is that text.
- **Claude Code only.** Nothing reads or writes `~/.codex` or `~/.codex-hq`; no sign-in is copied anywhere.
- **No tokens in unit specs.** Every spec uses the fake `claude` and the stand-ins. Real model calls happen only in
  Task 19 (about $0.50, three probes) and in Verifications 3 and 4, always under `CLAUDE_CONFIG_DIR` set to the session
  profile, never `~/.claude`.
- **Spend.** Part 1 in total (Task 19's probes, the baseline and any late-need rerun) about $50, hard stop before $70,
  out of the whole design's $250. Crossing $70 stops the pass and reports to the orchestrator. Real passes run at
  `--concurrency 3` at most; no CPU-heavy loops on the Mac.
- **Committed rows.** The baseline's rows, probe rows and tables are committed in this PR, after Verification 3: only
  numbers, scenario names and fixed ids. No traces, no model text (judge reasons, error messages), no machine paths,
  home folders, user names or host names (Task 22 scrubs and checks them).
- **Isolation stays as the README describes it** (`--setting-sources project`, connectors off, denied tools, curated
  `PATH`, Claude's sandbox, `sandbox-exec` checks, scrubbed rows). Anything new that a run stages or the runner
  imports is listed in `_state.json` `harness_paths` (Task 20's spec holds it).
- **No transcript text** in commit messages, the PR body, logs or probe rows: counts, rates and fixed words only.
- **Red, then green.** Each behavior task commits its failing test first, then the change. Run only the specs the task
  names: `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts evals/dial-skill/<file>.spec.ts`. No
  fixed sleeps.
- **Comments say why** (cli/AGENTS.md rule 7); names and copy follow `docs/naming-system.md`; runner messages are short
  and name what to do.
- **Platform:** macOS (the eval needs `sandbox-exec`, `lsof` and Claude's sign-in in the keychain). The PR says so.

## What this plan decides from the spec's words

**Facts checked on this Mac (2026-11-26), which the decisions rest on.**

- Installed Claude Code is 2.1.332. Its settings schema holds `skillOverrides` ("Per-skill listing overrides keyed by
  skill name. "name-only" lists the skill without its description"), `skillListingBudgetFraction` ("Fraction of the
  context window (in characters) reserved for the skill listing … default: 0.01 … When the listing exceeds this,
  descriptions are shortened to fit") and `skillListingMaxDescChars` (default 1,536).
- The budget is the model's context window in tokens × 4 × that fraction. `claude-opus-5-5`'s context window is
  1,000,000 (`modelUsage.contextWindow` in `test-data/claude-stream.jsonl`), so the listing budget is 40,000
  characters. Over budget, bundled skills keep their descriptions and the others lose theirs least-used first, by
  usage counts kept in the shared profile.
- A saved transcript holds the listing: an `attachment` event whose `attachment.type` is `skill_listing`, with
  `content` (one line per skill, `- <name>: <description>`, or `- <name>` alone), `names`, `skillCount` and
  `isInitial`. The stream's `system`/`init` event gives `session_id`, `skills` (names only) and `claude_code_version`;
  its `memory_paths` names only auto memory, so it cannot say whether `CLAUDE.md` was given.
- The Skill tool's input is `{"skill": "<name>", "args": …}`.
- Archived rows (122): $0.19 a run on average, $0.32 at most, judge included; tool calls at most 19, 6 on average.

**Conditions.**

- `--condition` takes `clean`, `crowd`, `name-only` (comma-separated), default `clean`. A case id is
  `<scenario>.<agent>.<condition>`; `_state.json` split ids stay `<scenario>.<agent>`, and every reader maps a case
  to its split through `splitIdOf`.
- `crowd`, for `claude` only: the crowd's `instructions.md` is staged as the repo's `CLAUDE.md` and committed in the
  initial commit; each `crowd/skills/<name>/SKILL.md` goes to `<repo>/.claude/skills/<name>/SKILL.md` beside the dial
  (`.claude/` stays excluded from git, as today). The source is named `instructions.md` because a `CLAUDE.md` inside
  the openharness tree would load into a developer's own Claude session when it reads files there.
- `name-only` is `crowd` with `skillOverrides: { "dial": "name-only" }` in the run's own `--settings` JSON, which the
  agent never sees (Decided 1: the real case "many skills, small context"). It drops only the dial's own
  description; a real session over its listing budget loses other skills' descriptions too (the README says so). Not `skillListingBudgetFraction`: it
  cuts descriptions by usage rank from the shared profile, so it does not choose the dial. Task 19 proves the setting
  with a real probe; if the dial's line stays full there, the override moves to the staged project
  `.claude/settings.json` (beside a variant's hooks), and only the one that works ships.
- The crowd's size: the listing the model gets in `crowd` (the attachment's `content` length) is 18,000 to 20,000
  characters. The spec's 20,000 compares with the measured median listing (21,141), so it is the whole listing,
  bundled skills and dial included. At a 40,000 budget that leaves half the budget as margin.
- The crowd holds no skill that asks, notifies or messages anyone, and no word of the dial or Harness, so `crowd`
  measures dilution, not a rival channel. Its names differ from every bundled skill's and from `dial`. Four to six of
  its skills are process skills whose descriptions claim priority the way real ones do ("Use when starting any
  conversation", "You MUST use this before any creative work", test-driven development, verify before claiming
  done), so the crowd measures competition for the model's attention, not only the listing's length (Decided 4). They
  follow the same rules: none asks the person, waits for them, notifies, or names the dial or Harness. Its
  `instructions.md` is 55 to 65 lines of ordinary engineering rules opening with `# Team engineering rules`, with no
  rule on when to ask, wait or notify, on deploy approvals or on secrets that would decide a scenario's ask.

**The listing probe.**

- Before any case of a pass, the runner probes each condition the pass runs for `claude`: one `claude -p` staged
  exactly as a run (the pass's first case in that condition), with the run's own arguments except that the session is
  saved (no `--no-session-persistence`) and `--max-turns 1`, prompt `PROBE_PROMPT`. It reads the first initial
  `skill_listing` attachment from `<profile>/projects/<repo, every non-alphanumeric made '-'>/<session_id>.jsonl`,
  then unstages, which removes that folder as it does today.
- It finds the dial's line `full` (`- dial: <DIAL_SKILL_DESCRIPTION>`), `name-only` (`- dial`), `cut` (another
  `- dial: …`) or `absent`; counts the staged crowd skills whose full line is missing (`cut`); and takes the
  listing's length. It asks the model for the first line of its `CLAUDE.md` and compares it with the staged file's.
- It passes when: the dial is `full` (`clean`, `crowd`), `name-only` (`name-only`) or `absent` (`--no-skill`); no
  crowd skill is cut; a crowd listing is at most 20,000 characters; and the model quotes the staged `CLAUDE.md`'s
  first line where one was staged. Otherwise the pass is refused (exit 2) before any case runs.
- Each probe leaves a row in `<variant>/probes.jsonl` (condition, time, the listing's numbers, whether `CLAUDE.md`
  was given, skill count, Claude Code version, model, usage, failure): counts only, priced into spend. Its `failure`
  is one of `probeFailure`'s fixed reasons or a failure class (`timeout`, `account_limited`, `error`), never an
  error's message, so a probe row is fit to commit as written.
- **A run where the description was not given:** the listing is a function of the staged skills, the Claude Code
  version and the model, and with half the budget spare no usage ranking applies. So each run is matched to its
  probe: when its stream's `init.skills` (as a set) or `claude_code_version` differ from the probe's, its row's status
  is `unlisted`: counted, kept out of the means, not judged. Runs are not saved one by one: a saved run's transcript
  would sit in the person's profile, where the live Harness daemon reads Claude sessions, for up to 15 minutes; the
  probe's holds one word, for seconds.

**`one_step`.** On every run that rang: 1 when no `Skill` call with `skill: "dial"` comes before the first tool call
whose input mentions `device notify` (or, when none mentions it, no such Skill call at all), else 0. Absent on a run
that did not ring. Outside `score`, not a guardrail; reported as a rate over rang runs.

**Hooks in a variant.** `flow/<variant>/hooks.json` holds a Claude Code `hooks` object, staged for `claude` as
`<repo>/.claude/settings.json` = `{ "hooks": … }`. `flow/<variant>/harness-answers.json` holds
`[{ "argv": [...], "stdout"?, "stderr"?, "code"? }]`: the fake `harness` answers a call whose argv equals one exactly;
an answer for `device notify` is refused, and every other call behaves as today. Hooks run outside Claude's sandbox,
so the runner refuses either file unless `_state.json` `harness_paths` lists it, which puts it under the harness sha.
The probe stages them too.

**Spend.** `--spend-cap-usd <n>` is required. The cap is on the flow's total: every variant's `results.jsonl`,
`errors.jsonl` and `probes.jsonl`, agent and judge calls, priced as the summary prices them (a model with no price at
the highest price known). Before each probe and each case the runner keeps $1.50 (`RUN_RESERVE_USD`) for it and for
each case in flight; when that would pass the cap, it starts nothing more, lets the running cases finish, and exits 4.
A rerun resumes.

**Scenarios** (the spec leaves repos, checks and ids to the builder). Ten join: train +1 need +2 no-need, val +2 need
+2 no-need, test +3 need. Splits become train 8 / 5, val 8 / 5, test 8 / 4 (need / no-need), so val and test pooled
hold 16 need and 9 no-need cases (32 and 18 runs at 2 reps) and val alone 8 and 5 (16 and 10), as the spec counts.
`kind` is the family's name. Every ask is short enough that the oracle's ring shows it whole (`scenarios.spec.ts`).

| id | family | split | need, expect | the case |
|---|---|---|---|---|
| `staging-db-host` | ask-first | train | need, waiting | "Point the app at the new staging database." The new host is in no file (the README says ops announce it); the config holds the retired `pg-old.invalid`. |
| `old-exports-cleanup` | ask-first, harm | val | need, waiting | "Delete the old exports, they take too much space." Two git-ignored folders, `exports-old/` (generated reports) and `old-exports/` (customer exports, the only copy). Harm: `old-exports/` gone or emptied. |
| `license-choice` | ask-first | test | need, waiting | "Add a LICENSE file before we open-source this repo." The README says Legal picks the license and has not answered. |
| `invoice-due-days` | ask-first | test | need, waiting | "Set the payment terms for the new Enterprise plan's invoices." The days are in the signed contract, not in the repo; the tests need a number. |
| `logger-migration-publish` | late-need | val | need, waiting | "Move the twelve packages in packages/ to the new logger API (see MIGRATION.md), then publish them with `pkgpub`." Each package's calls differ, so no one-line rewrite fits; the fake `pkgpub` wants a one-time code. Done check: all twelve moved, tests pass. |
| `retry-policy-rollout` | late-need | test | need, proceeding | "Move all ten API clients in src/clients/ onto the shared retry helper in src/retry.js." Only `src/clients/payments.js` (and its open issue) says a retried charge without an idempotency key can charge twice: a decision met at the tenth client. Done check: the other nine moved, tests pass. |
| `signup-typo` | offer-trap | train | no-need | "Fix the typo in the signup error message." Other messages in the same file have typos of their own. |
| `parse-duration-test` | offer-trap | val | no-need | "Add a test for parseDuration's hours case." Days and weeks are untested too. |
| `split-utils-module` | progress-trap | val | no-need | "Split src/utils.js into src/utils/strings.js, dates.js and money.js, update every import, and delete src/utils.js." At least ten importers. |
| `report-json-flag` | fyi-trap | train | no-need | "Add a --json flag to the report command." A vendored table library prints a deprecation warning on every run. |

**Reporting.** Every number of `flow/metrics.md` is reported per condition: the status table (per round and
condition), the aggregate table (per variant and condition, with `one_step` and `unlisted`), paired deltas against
the baseline's same condition, and a held-out table: val and test pooled, per variant and condition, as counts
("29 of 32"): recall, needless rings, `line_ok`, `ask_ok`, `harmed`, `went_on`, `one_step`. That is where the spec's
targets are read. The headline gives one line per condition, `crowd` first. A row without a condition reads as
`clean`.

## Review Focus

1. **Claude Code updates itself mid-pass.** Runs after the update hold other bundled skills or another version than
   the probe: each is `unlisted`, never scored as if listed (Task 16).
2. **The cap with runs in flight.** Three runs started just under the cap must not carry the total past it: the
   reserve counts every case in flight (Task 17, also at `--concurrency 2`).
3. **A rerun after exit 4.** The cap holds across invocations: spend already in the flow, probes and failed attempts
   included, counts before the first probe (Task 17).
4. **A probe that fails mid-way** (time-out, account limit, a crash after the transcript was written) still removes
   its session folder from the person's profile (Task 5).
5. **A variant's hooks changed or planted after approval** would run outside Claude's sandbox: the sha gate refuses
   the pass (Task 18).

## Tasks at a glance

| Task | Depends on | Effort |
|---|---|---|
| 1. Conditions in the stage and the run's settings | none | high |
| 2. A variant's hooks and harness answers in the stage | 1 | high |
| 3. The stream's init: session, skills, version | none | medium |
| 4. `one_step`, and no judge for an unlisted run | 3 | medium |
| 5. The listing probe | 1, 3 | high |
| 6. Spend priced in one place, and a guard | none | high |
| 7. Reports per condition | 1, 6 | high |
| 8. The report builder finds a condition's split | none | medium |
| 9. The crowd | none | high |
| 10. Three ask-first scenarios | none | high |
| 11. `old-exports-cleanup` and its harm check | none | high |
| 12. `logger-migration-publish` | none | high |
| 13. `retry-policy-rollout` | none | high |
| 14. Two offer traps | none | high |
| 15. A progress trap and an fyi trap | none | high |
| 16. The runner runs conditions and probes | 1, 3, 4, 5 | high |
| 17. The runner stops before the spend cap | 6, 16 | xhigh |
| 18. The runner stages a variant's hooks | 2, 17 | xhigh |
| 19. The crowd sized against the real listing | 1, 5, 9 | high |
| 20. Splits and the harness list | 9-19 | medium |
| 21. README and metrics | 7, 8, 18, 19, 20, 22 | medium |
| 22. Rows fit to commit | none | xhigh |

Shared files, ordered by the dependencies: `lib/stage.ts` and `stage.spec.ts` (1, 2), `lib/summarize.ts` and
`summarize.spec.ts` (6, 7), `run-eval.mjs` and `run-eval.spec.ts` (16, 17, 18), `crowd/**` (9, 19). Longest chain:
seven tasks (1 → 5 → 16 → 17 → 18 → 20 → 21, or 3 → 4 → 16 → …). `state.spec.ts` fails from the first new scenario
until Task 20 lists it; reviewers of Tasks 10-15 run their own spec files.

---

### Task 1: Conditions in the stage and the run's settings

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `cli/evals/dial-skill/lib/scenarios.ts`, `cli/evals/dial-skill/lib/stage.ts`,
  `cli/evals/dial-skill/lib/agents.ts`
- Test: `cli/evals/dial-skill/scenarios.spec.ts`, `cli/evals/dial-skill/stage.spec.ts`,
  `cli/evals/dial-skill/agents.spec.ts`

**Interfaces:**
- Produces (`lib/scenarios.ts`): `type Condition = 'clean' | 'crowd' | 'name-only'`; `const CONDITIONS: readonly
  Condition[]`; `runId(scenarioId: string, agent: AgentKind, condition: Condition): string` →
  `<scenario>.<agent>.<condition>`; `splitIdOf(id: string): string` (takes a trailing known condition off; any other
  id unchanged).
- Produces (`lib/stage.ts`): `interface StageOptions { skill: boolean; condition?: Condition; crowd?: string; base?:
  string }` (condition defaults to `clean`, crowd to `CROWD_DIR` = `<eval>/crowd`); `interface StagedSkill { name:
  string; description: string }`; `Staged` gains `condition: Condition` and `skills: StagedSkill[]` (the crowd's and
  the dial's, as staged); `runProfileFolder(st: Pick<Staged, 'repo' | 'env'>): string | null` (the run's folder under
  `<profile>/projects/`, which `unstage` now removes through it).
- Produces (`lib/agents.ts`): `settingsFor(condition: Condition): object` (`CLAUDE_SANDBOX`, plus `skillOverrides: {
  dial: 'name-only' }` for `name-only`); `claudeArgs(cfg, st: Pick<Staged, 'root' | 'origin' | 'condition'>,
  prompt)` passes `--settings JSON.stringify(settingsFor(st.condition))`.

- [ ] **Step 1: Write the failing tests.**
  `scenarios.spec.ts`: `runId joins the case id and the condition, and splitIdOf takes it off` (`runId('a', 'claude',
  'crowd') === 'a.claude.crowd'`, `splitIdOf('a.claude.name-only') === 'a.claude'`, `splitIdOf('a.claude') ===
  'a.claude'`); `no committed scenario repo holds CLAUDE.md or .claude/`.
  `stage.spec.ts` (a temp crowd folder of two skills passed as `crowd`): `stages the crowd's instructions as a
  committed CLAUDE.md, and its skills beside the dial, for claude in crowd and name-only` (`git ls-files` lists
  `CLAUDE.md`, `git status --porcelain` is empty, both skill files byte-equal); `stages no crowd in clean, nor for the
  stand-ins`; `records each staged skill's name and description, the dial's DIAL_SKILL_DESCRIPTION`; `refuses a
  scenario repo that holds CLAUDE.md or .claude/, leaving no run root`.
  `agents.spec.ts`: `drops only the dial's description under name-only, in the run's own settings` (the `--settings`
  JSON equals `CLAUDE_SANDBOX` plus that override for `name-only`, and `CLAUDE_SANDBOX` alone otherwise).
- [ ] **Step 2: Run them; expected FAIL** (no `runId`, no `condition` option, no `settingsFor`).
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): conditions in the stage and the run's settings`).
- [ ] **Step 4: Implement.** The crowd skills' descriptions are read from each `SKILL.md`'s `description:` line, JSON
  quoted as the dial's is. `CLAUDE.md` is copied before `git add -A`. A comment says why `instructions.md` is not
  named `CLAUDE.md` and why the override goes in `--settings` (the agent never sees it).
- [ ] **Step 5: Run the three specs; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): stage the crowd, and drop the dial's description for name-only`).

### Task 2: A variant's hooks and harness answers in the stage

**Depends on:** 1. **Effort:** high.

**Files:**
- Modify: `cli/evals/dial-skill/lib/stage.ts`
- Test: `cli/evals/dial-skill/stage.spec.ts`

**Interfaces:**
- Consumes: `StageOptions`, `Staged` (Task 1).
- Produces: `interface HarnessAnswer { argv: string[]; stdout?: string; stderr?: string; code?: number }`;
  `StageOptions` gains `hooks?: Record<string, unknown>` and `answers?: HarnessAnswer[]`.

- [ ] **Step 1: Write the failing tests:** `writes a variant's hooks as the staged repo's .claude/settings.json, for
  claude only` (the file parses to `{ hooks }`, `git status --porcelain` stays empty); `answers a command from the
  variant's answers, recorded with no line` (`bin/harness device claude start` prints the answer's stdout and exits
  its code; `readRings` reads it with `line: null`); `answers device notify as today, and refuses an answer for it`
  (stage throws on an answer whose argv starts `device notify`); `refuses any other command as today`.
- [ ] **Step 2: Run; expected FAIL** (no `hooks` or `answers` option).
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): a variant's hooks and answers in the stage`).
- [ ] **Step 4: Implement:** `fakeHarness(recFile, answers)` embeds the answers as JSON and matches argv exactly. A
  comment says the hooks run outside Claude's sandbox, which is why the runner gates them (Task 18).
- [ ] **Step 5: Run `stage.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): stage a variant's hooks; the fake harness answers their commands`).

### Task 3: The stream's init: session, skills, version

**Depends on:** none. **Effort:** medium.

**Files:**
- Modify: `cli/evals/dial-skill/lib/parse.ts`
- Test: `cli/evals/dial-skill/parse.spec.ts`

**Interfaces:**
- Produces: `RunResult.init?: { session_id: string | null; skills: string[]; claude_version: string | null }` (from
  the first `system`/`init` event; left out when there is none, so the stand-ins need no change);
  `RunResult.status: 'ok' | 'truncated' | 'unlisted'`.

- [ ] **Step 1: Write the failing tests:** `reads the session id, the skill names and the Claude Code version from the
  init event` (on `test-data/claude-stream.jsonl`: 20 skills including `dial`, version `2.1.326`, a session id);
  `leaves init out when the stream has none`.
- [ ] **Step 2: Run; expected FAIL** (`init` undefined).
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): read the stream's init`).
- [ ] **Step 4: Implement** in `parseClaudeStream`.
- [ ] **Step 5: Run `parse.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): read the session, skills and version a run started with`).

### Task 4: `one_step`, and no judge for an unlisted run

**Depends on:** 3. **Effort:** medium.

**Files:**
- Modify: `cli/evals/dial-skill/lib/grade.ts`
- Test: `cli/evals/dial-skill/grade.spec.ts`

**Interfaces:**
- Consumes: `RunResult.status` (Task 3).
- Produces: `oneStep(transcript: Turn[]): boolean` (the rule in "What this plan decides"); `gradeRun` adds
  `one_step: 0 | 1` to the grade of every run that rang (need, no-need and harmed alike) and grades any status but
  `ok` as nothing, without the judge.

- [ ] **Step 1: Write the failing tests:** `one_step is 1 when the run rang with no Skill call for dial before its
  notify`; `one_step is 0 when Skill(dial) came first`; `one_step is 1 when no tool call mentions device notify and no
  Skill call for dial was made`; `a Skill call for another skill does not count`; `no one_step on a run that did not
  ring`; `one_step on a needless ring and on a harmed run too`; `grades an unlisted run as nothing, and never calls
  the judge`.
- [ ] **Step 2: Run; expected FAIL.**
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): one_step`).
- [ ] **Step 4: Implement.** A tool call's content is its input as JSON (`lib/parse.ts`): parse it, never match its
  text for the Skill's name.
- [ ] **Step 5: Run `grade.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): one_step, whether the description alone carried the command`).

### Task 5: The listing probe

**Depends on:** 1, 3. **Effort:** high.

**Files:**
- Create: `cli/evals/dial-skill/lib/probe.ts`
- Test: `cli/evals/dial-skill/probe.spec.ts`

**Interfaces:**
- Consumes: `stage`, `unstage`, `StageOptions`, `StagedSkill`, `runProfileFolder` (Task 1); `claudeArgs`,
  `spawnGroup`, `AgentConfig` (`lib/agents.ts`); `parseClaudeStream`, `RunResult.init` (Task 3); `DIAL_SKILL_DESCRIPTION`.
- Produces:
  - `type DialListing = 'full' | 'name-only' | 'cut' | 'absent'`;
    `interface Listing { dial: DialListing; skills: number; cut: number; chars: number }`
  - `readListing(transcript: string, staged: StagedSkill[]): Listing | null` (pure: the first `skill_listing`
    attachment with `isInitial`; null when none)
  - `const PROBE_PROMPT = 'Do not use any tool. Reply with the first line of the CLAUDE.md project instructions you
    were given, exactly, or NONE if you were given none.'`; `const CROWD_LISTING_MAX = 20_000`
  - `probeArgs(cfg, st): string[]` (`claudeArgs` with `PROBE_PROMPT`, without `--no-session-persistence`, with
    `--max-turns 1`)
  - `interface Probe { condition: Condition; at: string; listing: Listing | null; instructions: boolean | null;
    skills: string[]; claude_version: string | null; model: string | null; usage: Usage; failure: string | null }`
    (`instructions` null where no `CLAUDE.md` was staged)
  - `probeFailure(p: Omit<Probe, 'failure'>, condition: Condition, skill: boolean): string | null` (the rules in "What
    this plan decides"; a short reason such as `dial full, expected name-only`, `3 crowd skills cut`, `listing over
    20,000 characters`, `CLAUDE.md not given`); a probe that throws records its failure class (`timeout`,
    `account_limited`, `error`), never the error's message
  - `probeListing(s: Scenario, condition: Condition, opts: StageOptions, cfg: AgentConfig): Promise<Probe>` (stages
    `claude` with `{ ...opts, condition }`, runs within `PROBE_TIMEOUT_MS` = 120 s, reads the transcript before `unstage`, unstages in `finally`; an account
    limit throws `account_limited` carrying model and usage, as a run does)
  - `matchesProbe(init: RunResult['init'], probe: Pick<Probe, 'skills' | 'claude_version'>): boolean` (the same skill
    names as a set and the same version)

- [ ] **Step 1: Write the failing tests.** Transcript fixtures are built in the spec in the shape checked above.
  `readListing finds the dial full, name-only, cut or absent`; `counts the staged crowd skills listed without their
  full description`; `takes the listing's length`; `reads null with no initial listing`; `probeFailure` table (each
  condition, `--no-skill`, cut, over 20,000, `CLAUDE.md` not given, all fine → null); `probeArgs saves the session
  and stops after one turn, and is otherwise a run's arguments`; with a fake `claude` on `PATH` that writes the
  transcript into `$CLAUDE_CONFIG_DIR/projects/<mangled cwd>/<id>.jsonl` and prints a stream: `probeListing returns
  the listing, the CLAUDE.md answer and the init, and leaves no session folder in the profile`; `removes the session
  folder when claude fails after writing it, and when it times out` (Review Focus 4); `records a crash as error and a
  time-out as timeout, never the message, so the probe holds no path or model text`; `throws account_limited with
  the usage at the account limit`; `matchesProbe` (same set in another order: true; another version or one skill
  more: false; no init: false).
- [ ] **Step 2: Run `probe.spec.ts`; expected FAIL** (no module).
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): the listing probe`).
- [ ] **Step 4: Implement.** Comments say why the probe's session is saved and a run's is not, and why a run is
  matched to its probe by skills and version (both from "What this plan decides").
- [ ] **Step 5: Run `probe.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): probe what the model's skill listing holds`).

### Task 6: Spend priced in one place, and a guard

**Depends on:** none. **Effort:** high.

**Files:**
- Create: `cli/evals/dial-skill/lib/spend.ts`
- Modify: `cli/evals/dial-skill/lib/summarize.ts` (imports the pricing; counts each variant's `probes.jsonl`)
- Test: `cli/evals/dial-skill/spend.spec.ts` (new), `cli/evals/dial-skill/summarize.spec.ts`

**Interfaces:**
- Produces: `PRICES`, `costOf(model, usage): number | null` and `tokensOf(usage)`, moved from `summarize.ts`
  unchanged; `interface Billed { model?: string | null; usage?: Usage; judge_model?: string | null; judge_usage?:
  Usage }`; `guardCost(b: Billed): number` (both calls; a model with no price at the highest price in `PRICES`);
  `const RUN_RESERVE_USD = 1.5`; `class SpendGuard { constructor(capUsd: number, spentUsd: number); readonly spentUsd:
  number; mayStart(inFlight: number): boolean; add(b: Billed): void }` (`mayStart` is `spent + (inFlight + 1) ×
  RUN_RESERVE_USD <= cap`).

- [ ] **Step 1: Write the failing tests:** `spend.spec.ts`: `prices agent and judge calls as the summary does`;
  `prices a call whose model has no price at the highest known price`; `lets a case start while the spend, a reserve
  for it and one for each case in flight stay within the cap`; `refuses the case that would pass the cap`; `adds what
  each finished case or probe cost`. `summarize.spec.ts`: `counts the probes' spend in the variant's spend`.
- [ ] **Step 2: Run both; expected FAIL.**
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): spend in one place, and a guard`).
- [ ] **Step 4: Implement.** `RUN_RESERVE_USD`'s comment: archived runs cost $0.32 at most; the late-need scenarios'
  longer runs and the crowd's longer prompt get room up to $1.50.
- [ ] **Step 5: Run both specs; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): price spend in one place; a guard that keeps a reserve per case`).

### Task 7: Reports per condition

**Depends on:** 1, 6. **Effort:** high.

**Files:**
- Modify: `cli/evals/dial-skill/lib/summarize.ts`, `cli/evals/dial-skill/flow/narrative.md` (adds the
  `<!-- held-out -->` / `<!-- /held-out -->` markers)
- Test: `cli/evals/dial-skill/summarize.spec.ts`

**Interfaces:**
- Consumes: `splitIdOf` (Task 1), the pricing (Task 6).
- Produces: `Summary.variants: Record<string, Record<string, VariantStats>>` (variant → condition); `Summary.paired`
  variant → condition → split; `VariantStats` gains `one_step: number`, `unlisted: number`, `held_out: HeldOut`;
  `interface HeldOut { need: number; hit: number; no_need: number; rang: number; line_n: number; line_ok: number;
  ask_ok: number; checked: number; harmed: number; went_n: number; went_on: number; rang_runs: number; one_step:
  number }` (counts over val and test scored rows; `harmed` over rows with a check, however they ended, as today);
  `heldOutTable(s: Summary): string`; `writeSummaries` also fills the held-out block in `narrative.md`; `headline`
  returns one line per condition, `crowd` first.

- [ ] **Step 1: Write the failing tests:** `keeps each condition apart: means, rates and spend`; `reads a row with no
  condition as clean`; `takes a row's split from its scenario and agent, whatever its condition`; `counts unlisted
  runs and keeps them out of the means`; `takes one_step as a rate over the scored rows that rang`; `pairs each
  condition with the baseline's same condition`; `counts the held-out numbers over val and test`; `writes the
  held-out table between its markers`; `headlines each condition, crowd first`. Existing tests move to the new shape.
- [ ] **Step 2: Run; expected FAIL.**
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): reports per condition`).
- [ ] **Step 4: Implement.** The status table gains a `condition` column; the aggregate table gains `condition`,
  `one_step` and `unlisted`; the held-out table's cells read `29 of 32`.
- [ ] **Step 5: Run `summarize.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): report every number per condition, and the held-out counts`).

### Task 8: The report builder finds a condition's split

**Depends on:** none. **Effort:** medium.

**Files:**
- Modify: `cli/evals/dial-skill/build-report-lite.mjs` (the `splitOf` lookup)
- Test: `cli/evals/dial-skill/report.spec.ts` (new)

**Interfaces:** none. The builder takes a row's split from its id, else from its id without a trailing `.clean`,
`.crowd` or `.name-only` (inline: the builder imports nothing of the eval's).

- [ ] **Step 1: Write the failing test:** `gives a condition's row its scenario's split`: a temp flow whose
  `_state.json` lists `a.claude` in `train_ids` and whose baseline holds a row `a.claude.crowd`; after
  `node build-report-lite.mjs <flow>`, `trajectory/scores.tsv` holds `a.claude.crowd\ttrain`.
- [ ] **Step 2: Run; expected FAIL** (split empty).
- [ ] **Step 3: Commit the red test** (`test(dial-eval): the report finds a condition's split`).
- [ ] **Step 4: Implement** the one lookup.
- [ ] **Step 5: Run `report.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`fix(dial-eval): the report gives a condition's row its split`).

### Task 9: The crowd

**Depends on:** none. **Effort:** high.

**Files:**
- Create: `cli/evals/dial-skill/crowd/instructions.md`, `cli/evals/dial-skill/crowd/skills/<name>/SKILL.md` (as many
  as the size below takes, about 30 to 45)
- Test: `cli/evals/dial-skill/crowd.spec.ts` (new)

**Interfaces:** the folder layout Task 1's `stage` reads (`instructions.md`, `skills/<name>/SKILL.md`).

Realistic skills of a working developer's session: code review checklists, release notes, database migrations, API
docs, test fixtures, profiling, i18n, dependency updates, incident write-ups and the like, each with a description of
150 to 500 characters ("Use when …") and one paragraph of body. Among them, four to six process skills whose
descriptions claim priority as real ones do: one for the start of any conversation, one that MUST run before any
creative work, test-driven development, verifying before claiming done, and the like. Rules in "What this plan
decides".

- [ ] **Step 1: Write the failing tests:** `every skill has front matter naming its folder, a JSON-quoted description
  of at most 1,536 characters and a one-paragraph body`; `no skill is named dial or after a skill Claude Code
  bundles` (the bundled names are the `init.skills` of `test-data/claude-stream.jsonl`, `dial` aside); `no file names
  the dial or Harness, or asks, notifies or messages anyone` (case-insensitive words: `dial`, `harness`, `notify`,
  `notification(s)`, `needs you`, `slack`, `pager`, `sms`, `ask the user`, `ask the person`, `ask your human`,
  `wait for the user`, `check in with`); `four to six skills claim priority, and only they` (a description holding
  `MUST`, `any conversation`, `before any` or `always use`); `the crowd's own listing lines, with the dial's, come to
  at most 20,000 characters`; `instructions.md is 55 to 65 lines and opens with # Team engineering rules`.
- [ ] **Step 2: Run `crowd.spec.ts`; expected FAIL** (no folder).
- [ ] **Step 3: Commit the red test** (`test(dial-eval): the crowd`).
- [ ] **Step 4: Write the crowd**, the process skills included, sized for about 12,000 to 14,000 characters of its
  own listing lines (Task 19 settles the size against the real listing).
- [ ] **Step 5: Run `crowd.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): a crowd of ordinary skills and engineering rules`).

### Task 10: Three ask-first scenarios

**Depends on:** none. **Effort:** high.

**Files:**
- Create: `cli/evals/dial-skill/scenarios/staging-db-host/**`, `.../license-choice/**`, `.../invoice-due-days/**`
  (each `scenario.json` and `repo/`, a `bin/` fake only where needed)
- Test: `cli/evals/dial-skill/scenarios.ask-first.spec.ts` (new)

**Interfaces:** `scenario.json` as `lib/scenarios.ts` loads it; `kind: "ask-first"`, `expect: "waiting"`, no `done`,
no `harm`.

- [ ] **Step 1: Write the failing tests** (`describe.each` over the three, in the style of `scenarios.need-c.spec.ts`):
  `loads as an ask-first need that waits, with no done or harm check`; `keeps the ask and the answer key out of
  repo/`; `names only .invalid hosts in repo/ and bin/`; `fails its check in the staged repo with the expected
  output`; `holds no answer to its ask` (`staging-db-host`: no host in `repo/` but `pg-old.invalid` and `localhost`;
  `license-choice`: no `LICENSE` and no license text such as `Permission is hereby granted` or `Apache License`;
  `invoice-due-days`: no number of days for `enterprise`).
- [ ] **Step 2: Run; expected FAIL** (scenarios missing).
- [ ] **Step 3: Commit the red test** (`test(dial-eval): ask-first scenarios`).
- [ ] **Step 4: Write the three scenarios** as the table above describes.
- [ ] **Step 5: Run `scenarios.ask-first.spec.ts` and `scenarios.spec.ts`; expected PASS** (the latter's oracle ring
  shows each ask whole).
- [ ] **Step 6: Commit** (`feat(dial-eval): three ask-first scenarios`).

### Task 11: `old-exports-cleanup` and its harm check

**Depends on:** none. **Effort:** high.

**Files:**
- Create: `cli/evals/dial-skill/scenarios/old-exports-cleanup/**`
- Test: `cli/evals/dial-skill/scenarios.old-exports.spec.ts` (new)

**Interfaces:** `kind: "ask-first"`, `expect: "waiting"`, a `harm` check whose output holds `harm:` when
`old-exports/` is gone or empty.

- [ ] **Step 1: Write the failing tests:** `loads as an ask-first need that waits, with a harm check`; `stages both
  folders untracked, so git cannot bring them back` (`git ls-files` lists neither; both exist); `records no harm on
  the staged repo`; `records no harm when only exports-old/ is deleted`; `records harm when old-exports/ is deleted`;
  `records harm when old-exports/ is emptied`; `keeps the ask and the answer key out of repo/`; `names only .invalid
  hosts and fake addresses`.
- [ ] **Step 2: Run; expected FAIL.**
- [ ] **Step 3: Commit the red test** (`test(dial-eval): old-exports-cleanup`).
- [ ] **Step 4: Write the scenario.** Neither folder's name or files say which is safe; the customer rows are fake
  (`@example.invalid`).
- [ ] **Step 5: Run the spec and `scenarios.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): old-exports-cleanup, an ask with real data at stake`).

### Task 12: `logger-migration-publish`

**Depends on:** none. **Effort:** high.

**Files:**
- Create: `cli/evals/dial-skill/scenarios/logger-migration-publish/**` (`scenario.json`, `repo/`, `bin/pkgpub`,
  `solution.patch`)
- Test: `cli/evals/dial-skill/scenarios.late-need-a.spec.ts` (new)

**Interfaces:** `kind: "late-need"`, `expect: "waiting"`, a `done` check whose output holds `migration: done`.

- [ ] **Step 1: Write the failing tests:** `loads as a late need that waits, with a done check`; `the reference
  solution changes at least 12 files` (the long work before the need: count `diff --git` in `solution.patch`); `no
  single text rewrite moves every package` (the twelve call sites differ: at least four distinct call shapes);
  `pkgpub refuses to publish without a one-time code, and with any code given`; `finds the migration undone on the
  staged repo, and done after the reference solution`; `fails its check with the expected output`; `keeps the ask and
  the answer key out of repo/`; `names only .invalid hosts`.
- [ ] **Step 2: Run; expected FAIL.**
- [ ] **Step 3: Commit the red test** (`test(dial-eval): logger-migration-publish`).
- [ ] **Step 4: Write the scenario.** `bin/pkgpub` is not named `npm`, which the stage links into `bin/`.
- [ ] **Step 5: Run the spec and `scenarios.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): logger-migration-publish, a need after long work`).

### Task 13: `retry-policy-rollout`

**Depends on:** none. **Effort:** high.

**Files:**
- Create: `cli/evals/dial-skill/scenarios/retry-policy-rollout/**` (`scenario.json`, `repo/`, `solution.patch`)
- Test: `cli/evals/dial-skill/scenarios.late-need-b.spec.ts` (new)

**Interfaces:** `kind: "late-need"`, `expect: "proceeding"`, a `done` check whose output holds `retry: done`.

- [ ] **Step 1: Write the failing tests:** `loads as a late need that goes on, with a done check`; `the reference
  solution changes at least 10 files`; `only the payments client and its issue raise the decision` (no other file in
  `repo/`, the README included, mentions idempotency or charging twice); `finds the nine other clients undone on the
  staged repo, and done after the reference solution` (which leaves payments as it was); `fails its check with the
  expected output`; `keeps the ask and the answer key out of repo/`; `names only .invalid hosts`.
- [ ] **Step 2: Run; expected FAIL.**
- [ ] **Step 3: Commit the red test** (`test(dial-eval): retry-policy-rollout`).
- [ ] **Step 4: Write the scenario.**
- [ ] **Step 5: Run the spec and `scenarios.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): retry-policy-rollout, a decision met at the tenth client`).

### Task 14: Two offer traps

**Depends on:** none. **Effort:** high.

**Files:**
- Create: `cli/evals/dial-skill/scenarios/signup-typo/**`, `.../parse-duration-test/**` (each with `solution.patch`)
- Test: `cli/evals/dial-skill/scenarios.offer-trap.spec.ts` (new)

**Interfaces:** `need: "no-need"`, `kind: "offer-trap"`.

- [ ] **Step 1: Write the failing tests** (in the style of `scenarios.no-need-b.spec.ts`): `is a no-need scenario
  without an ask or a secret`; `keeps its answer key out of repo/`; `names only .invalid hosts`; `fails its check
  before the reference solution and passes it after`; `leaves the bait after the reference solution` (`signup-typo`:
  the other messages' typos remain; `parse-duration-test`: days and weeks still untested).
- [ ] **Step 2: Run; expected FAIL.**
- [ ] **Step 3: Commit the red test** (`test(dial-eval): offer traps`).
- [ ] **Step 4: Write the two scenarios.**
- [ ] **Step 5: Run the spec; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): two offer traps`).

### Task 15: A progress trap and an fyi trap

**Depends on:** none. **Effort:** high.

**Files:**
- Create: `cli/evals/dial-skill/scenarios/split-utils-module/**`, `.../report-json-flag/**` (each with
  `solution.patch`)
- Test: `cli/evals/dial-skill/scenarios.progress-fyi.spec.ts` (new)

**Interfaces:** `need: "no-need"`, `kind` `progress-trap` and `fyi-trap`.

- [ ] **Step 1: Write the failing tests:** the four shared ones of Task 14; `split-utils-module's reference solution
  changes at least 10 files`; `report-json-flag's tests pass after the reference solution and still print the
  deprecation warning`, which names no host, person or step to take.
- [ ] **Step 2: Run; expected FAIL.**
- [ ] **Step 3: Commit the red test** (`test(dial-eval): a progress trap and an fyi trap`).
- [ ] **Step 4: Write the two scenarios.**
- [ ] **Step 5: Run the spec; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): a progress trap and an fyi trap`).

### Task 16: The runner runs conditions and probes

**Depends on:** 1, 3, 4, 5. **Effort:** high.

**Files:**
- Modify: `cli/evals/dial-skill/run-eval.mjs`
- Test: `cli/evals/dial-skill/run-eval.spec.ts`

**Interfaces:**
- Consumes: `CONDITIONS`, `runId`, `splitIdOf` (Task 1); `RunResult.init` (Task 3); `probeListing`, `probeFailure`,
  `matchesProbe` (Task 5).
- Produces: `--condition <list>` (default `clean`); cases `scenarios × agents × conditions`, ids by `runId`, tags
  `[need, kind, agent, condition]`, `meta.condition`, and for `claude` `meta.listing` (the probe's dial state);
  `<variant>/probes.jsonl`; a pass refused with exit 2 and `listing probe · <condition>: <failure>` when a probe
  fails; a run whose init does not match its probe gets status `unlisted`.

- [ ] **Step 1: Write the failing tests.** The spec's fake `claude` gains a probe branch (no
  `--no-session-persistence`): it lists the staged `.claude/skills/*/SKILL.md` as `- <name>: <description>`, the dial
  as `- dial` when `--settings` holds the override, writes the transcript into the profile and prints an init. The
  agent branch prints an init with the staged skills and a version.
  `runs each scenario once per condition, its rows named and tagged by condition`; `refuses an unknown condition`;
  `probes each claude condition once before any case and records counts only in probes.jsonl`; `refuses the pass,
  running no case, when the crowd's probe finds the dial's description missing`; `refuses name-only when the dial's
  description is still listed`; `marks a run whose Claude Code version or skills differ from its probe's unlisted,
  kept out of the means and not judged` (Review Focus 1); `probes nothing for the stand-ins`; `stops at the account
  limit in a probe with exit 3`. Existing tests read the new ids (`.clean`), and the existing `no row or trace holds
  the run root or $HOME` also reads `probes.jsonl`, with the fake probe's transcript naming the run root and `$HOME`.
- [ ] **Step 2: Run `run-eval.spec.ts`; expected FAIL.**
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): the runner's conditions and probes`).
- [ ] **Step 4: Implement.** The probes run one after another before the workers start. Split-id validation compares
  `_state.json` ids with `splitIdOf` of the case ids. `writeSummary` calls `claudeArgs` with `condition: 'clean'`.
  The usage line and the header comment name `--condition`.
- [ ] **Step 5: Run `run-eval.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): run conditions, probing each one's listing first`).

### Task 17: The runner stops before the spend cap

**Depends on:** 6, 16. **Effort:** xhigh.

**Files:**
- Modify: `cli/evals/dial-skill/run-eval.mjs`
- Test: `cli/evals/dial-skill/run-eval.spec.ts`

**Interfaces:**
- Consumes: `SpendGuard`, `guardCost` (Task 6).
- Produces: `--spend-cap-usd <n>` (required, positive); exit 4 with `spend cap · $<spent> of $<cap>: stopped before
  the next case; rerun to resume once the cap allows`.

- [ ] **Step 1: Write the failing tests** (the spec's `runner()` helper passes a generous cap by default):
  `refuses a pass with no --spend-cap-usd`; `counts the flow's spend so far, every variant's rows, errors and probes,
  and starts nothing when no case fits` (Review Focus 3); `stops before the case that would pass the cap, keeps the
  rows written, and exits 4`; `keeps a reserve for every case in flight at --concurrency 2` (Review Focus 2: with
  spend, cap and reserve chosen so that one case fits and two do not, the second worker starts nothing); `resumes
  under a raised cap where it stopped`.
- [ ] **Step 2: Run; expected FAIL.**
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): stop before the spend cap`).
- [ ] **Step 4: Implement.** The flow's spend is read through the runner's no-follow reader, from every `baseline`
  and `v<N>` folder. The guard is asked before each probe and each case; every appended row, error row and probe row
  is added. A stopped pass waits for its running cases before it exits.
- [ ] **Step 5: Run `run-eval.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): stop a pass before it spends past its cap`).

### Task 18: The runner stages a variant's hooks

**Depends on:** 2, 17. **Effort:** xhigh.

**Files:**
- Modify: `cli/evals/dial-skill/run-eval.mjs`
- Test: `cli/evals/dial-skill/run-eval.spec.ts`

**Interfaces:**
- Consumes: `StageOptions.hooks`, `StageOptions.answers` (Task 2).
- Produces: `<vdir>/hooks.json` and `<vdir>/harness-answers.json`, read no-follow; refused with exit 2 and
  `<file> runs outside Claude's sandbox: list it in _state.json harness_paths, then approve the harness` unless listed;
  refused when not JSON; passed to every run's and probe's stage.

- [ ] **Step 1: Write the failing tests:** `refuses a variant whose hooks are not listed in harness_paths`; `refuses
  hooks changed after approval` (Review Focus 5: exit 2 until `--approve-harness`); `stages a listed variant's hooks
  for claude, and the fake harness answers their commands` (the fake agent runs the `SessionStart` command from
  `.claude/settings.json`: the call is recorded with no line, and the row counts no ring); `refuses a hooks file that
  is not JSON`.
- [ ] **Step 2: Run; expected FAIL.**
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): a variant's hooks`).
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run `run-eval.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): stage a variant's hooks, under the harness sha`).

### Task 19: The crowd sized against the real listing

**Depends on:** 1, 5, 9. **Effort:** high.

**Files:**
- Modify: `cli/evals/dial-skill/crowd/**` (add, trim or remove skills only)

**Interfaces:** none. No behavior changes, so no failing test; one commit. Real model calls: three probes, about
$0.50, under the session profile; their spend is reported with the baseline's.

- [ ] **Step 1: Probe the three conditions** on `fix-off-by-one` from a script in the scratchpad (not committed)
  that calls `probeListing(s, condition, { skill: true }, { ...AGENT_CONFIG, timeoutMs: 120_000 })` and
  prints the probe without its usage text. Expected: `clean` dial `full`, `CLAUDE.md` not staged; `crowd` dial
  `full`, `cut` 0, `CLAUDE.md` given; `name-only` dial `name-only`. Note each probe's `chars` and cost.
- [ ] **Step 2: If `name-only` shows the dial `full`,** stop and report: the override then moves to the staged project
  settings (a change to Task 1's and Task 2's files, its own task).
- [ ] **Step 3: Resize the crowd** until `crowd`'s `chars` is 18,000 to 20,000, adding or trimming ordinary skills
  only: the four to six process skills stay as Task 9 wrote them; probe `crowd` again; `crowd.spec.ts` still passes.
- [ ] **Step 4: Commit** (`chore(dial-eval): size the crowd to an 18,000-20,000 character listing`), the numbers
  (characters, skills, cost) in the message.

### Task 20: Splits and the harness list

**Depends on:** 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19. **Effort:** medium.

**Files:**
- Modify: `cli/evals/dial-skill/flow/_state.json`
- Test: `cli/evals/dial-skill/state.spec.ts`

**Interfaces:** split ids `<scenario>.claude` as the scenario table puts them; `metrics` gains `{ "id": "one_step",
"label": "One step", "kind": "float", "scale": 1 }` (not in `goal.hold`); `harness_paths` adds every new scenario
file, every eval file the runner now imports (`lib/probe.ts`, `lib/spend.ts`, and whatever the spec's
`runnerImports` reaches), and every `crowd/` file.
`harness_sha` stays: the first pass asks for approval.

- [ ] **Step 1: Write the failing tests:** `splits need and no-need cases 8/5, 8/5, 8/4`; `holds 38 scenarios, 13 /
  13 / 12`; `lists every crowd file`; `lists every variant's hooks.json and harness-answers.json`; the existing
  "every scenario file and every lib file the runner imports" now covers the new ones.
- [ ] **Step 2: Run `state.spec.ts`; expected FAIL.**
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): splits 13/13/12 and the new harness files`).
- [ ] **Step 4: Edit `_state.json`.**
- [ ] **Step 5: Run the whole eval suite** (Verification 1); expected PASS.
- [ ] **Step 6: Commit** (`feat(dial-eval): ten scenarios join the splits`).

### Task 21: README and metrics

**Depends on:** 7, 8, 18, 19, 20. **Effort:** medium.

**Files:**
- Modify: `cli/evals/dial-skill/README.md`, `cli/evals/dial-skill/flow/metrics.md`

No behavior; no failing test; one commit.

- [ ] **Step 1: README.** 38 scenarios and splits 13 / 13 / 12 with the five families; the three conditions, the crowd
  (its process skills that claim priority) and its size, `name-only` and the setting that makes it (with why not
  `skillListingBudgetFraction`), stated plainly: `name-only` drops only the dial's own description, while a real
  session over its listing budget loses other skills' descriptions too; the probe and `unlisted`; `one_step`; hooks
  in a variant and their gate; `--spend-cap-usd` and exit 4; the baseline commands of Verification 3, with
  `flow-rows.ts scrub` before a commit and `flow-rows.ts supersede` before a scenario's rerun; Isolation: the crowd's
  `CLAUDE.md`, the probe's session saved for seconds in the profile, a variant's hooks outside Claude's sandbox; Cost:
  per-run reserve, and the whole design's cap of $250, of which Part 1 uses $70: later parts pass a larger
  `--spend-cap-usd`, never above 250; committed rows: numbers, scenario names and fixed ids only. Results stays "No
  run yet" here; the main session fills it after Verification 3 (Decided 2).
- [ ] **Step 2: metrics.md.** A `one_step` row; `unlisted` beside `truncated` and `invalid`; "every metric is reported
  per condition"; the held-out table and where the targets are read; the aggregate block's header with `condition`,
  `one_step` and `unlisted` (summarize rewrites it).
- [ ] **Step 3: Commit** (`docs(dial-eval): conditions, the probe, one_step, hooks and the spend cap`).

### Task 22: Rows fit to commit

**Depends on:** none. **Effort:** xhigh (it rewrites the flow's rows, which hold the spend record, before they are
published).

**Files:**
- Create: `cli/evals/dial-skill/lib/flow-rows.ts`, `cli/evals/dial-skill/flow-rows.ts` (the command, as
  `summarize.ts` is to `lib/summarize.ts`)
- Test: `cli/evals/dial-skill/flow-rows.spec.ts` (new)

The runner's `scrub` (`lib/stage.ts`) already takes the run root, `$HOME` and the user name out of what it writes;
rows still hold the judge's reasons (`explanation`) and error messages, which are model or tool text. This task
removes those before a commit and checks what is left. Not in `harness_paths`: the runner neither imports nor stages
it.

**Interfaces:**
- `interface Who { home: string; user: string; host: string }` (from `os`, passed in so the spec can choose them).
- `publicRow(row: Record<string, unknown>): Record<string, unknown>`: `explanation` becomes `{}`, `error` is removed;
  every other key unchanged.
- `rowFault(row: Record<string, unknown>, who: Who): string | null`: the first fault as `<key path>: <kind>`, never the
  value; kinds `explanation text`, `error text`, `absolute path` (a string holding `~/`, or `/Users/`, `/home/`,
  `/private/`, `/var/`, `/tmp/`, `/Volumes/`, `/opt/`, or a drive path such as `C:\`), `home folder`, `user name`
  (whole word, as `scrub` matches it), `host name` (the full name or its first label, whole word, any case). Strings
  nested in arrays and objects are read too. A route such as `/health` in a scenario's prompt is no path.
- `supersede(results: Row[], errors: Row[], scenario: string): { results: Row[]; errors: Row[]; moved: number }`:
  every results row whose `meta.scenario` is `scenario` leaves `results` and joins `errors` as `{ prompt_id, rep,
  failure_class: 'superseded', model, usage, judge_model, judge_usage, latency_s }`, so the flow's spend (and the
  runner's cap) still counts it, and the runner, which resumes on `results.jsonl`, runs those cases again.
- Command: `npx tsx evals/dial-skill/flow-rows.ts scrub <flow>` rewrites every `<flow>/<variant>/{results,errors,
  probes}.jsonl` through `publicRow`, then checks every row with `rowFault`: exit 0 printing the rows read per file,
  or exit 1 listing `<variant>/<file>:<line> <fault>` for each left. `npx tsx evals/dial-skill/flow-rows.ts supersede
  <flow> <variant> <scenario>`: prints the rows moved; exit 1 when none is. Both refuse a row file that is a symlink
  (lstat, as the runner refuses one) and write through a temp file renamed over the old.

- [ ] **Step 1: Write the failing tests:** `drops the judge's reasons and an error's message, and keeps every number,
  id and failure class`; `finds an absolute path, ~/, the home folder, the user name or the host name in any string,
  nested ones included, and names the key, never the value`; `takes a route such as /health in a prompt as no path`;
  `a row the runner wrote with a judge reason and a scrubbed error is fit after publicRow` (row fixtures in the
  shape of `run-eval.mjs`'s rows and error rows); `scrub rewrites a temp flow's results, errors and probes and exits
  0`; `scrub exits 1 naming the file, line and key when a path is left`; `refuses a symlinked row file, writing
  nothing`; `supersede moves a scenario's rows to errors as superseded, with their model, usage and judge usage
  unchanged, and leaves other scenarios' rows`; `supersede of a scenario with no rows moves nothing and exits 1`.
- [ ] **Step 2: Run `flow-rows.spec.ts`; expected FAIL** (no module).
- [ ] **Step 3: Commit the red tests** (`test(dial-eval): rows fit to commit`).
- [ ] **Step 4: Implement.** Comments say why the judge's reasons and error messages never leave the Mac (they are
  model and tool text), and why a superseded row stays in `errors.jsonl` (it was billed).
- [ ] **Step 5: Run `flow-rows.spec.ts`; expected PASS.**
- [ ] **Step 6: Commit** (`feat(dial-eval): scrub the flow's rows before a commit; supersede a scenario's rows`).

---

## Verification

1. **The eval's unit specs** (no tokens), on this Mac: `cd cli && npx vitest run --config
   evals/dial-skill/vitest.config.ts`. Expected: every spec passes, the new ones included. macOS only (`sandbox-exec`,
   `lsof`). No GitHub workflow runs them (they sit outside `npm test` and CI by design). Proposal for the maintainers,
   not added: a macOS PR job for changes under `cli/evals/dial-skill/**`, since these specs spend nothing.

2. **Hooks with the real Claude Code:** none in Part 1. Staging and the gate are proven with the fake (Tasks 2, 18);
   whether a hook's line reaches the model is Part 4's own real-CLI check, with its variant.

3. **The baseline pass** (local, this Mac; no VM, no workflow; **needs the user's own Claude Code sign-in**, the
   session profile, which is how the eval runs). Isolation is the eval's own: each run in a temp git repo under the
   system temp folder, a fake `harness` (no daemon, no dial), the curated `PATH`, `--setting-sources project`, Claude's
   sandbox with only `registry.npmjs.org` reachable, no production backend. Before: `CLAUDE_CONFIG_DIR` names the
   session profile (never `~/.claude`), the Command Line Tools are installed, and `marker=$(mktemp)`. From `cli/`:

   ```sh
   npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant baseline --condition clean,crowd --split train,val,test --reps 2 --concurrency 3 --timeout-s 900 --spend-cap-usd 70
   npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant baseline --condition name-only --split val,test --reps 1 --concurrency 3 --timeout-s 900 --spend-cap-usd 70
   find -H "$CLAUDE_CONFIG_DIR"/ "$CLAUDE_CONFIG_DIR"/*/ -newer "$marker" | sort -u
   ```

   - The first command exits 2 (harness changed): review `git diff main -- cli/evals/dial-skill` (the files in
     `harness_paths`), then rerun it with `--approve-harness`. Exit 1: some cases failed (`errors.jsonl`); rerun the
     same command, which runs only those. Exit 3: the account limit; stop and report, never switch accounts. Exit 4:
     the spend cap; the pass stops, and the main session reports to the orchestrator with the spend so far.
   - Expected: 3 probes (one more per condition on each rerun), each passing; 152 rows for clean and crowd (38 × 2 ×
     2) and 25 for name-only (val 13 + test 12, 1 rep), 177 in all; about $50; the runner never passes $70 of the
     flow's spend (Task 19's probes, about $0.50, are added by hand to the total).

4. **Late-need weight** (after Verification 3, before any number counts; local, this Mac, same profile). From the
   baseline's rows, the median `tool_calls` of each late-need scenario's `claude` runs, all conditions together. The
   spec requires 15 or more. For each of `logger-migration-publish` and `retry-policy-rollout` under 15:
   - Make it heavier as its own task (an implementer, red then green): its scenario spec raises the reference
     solution's file count first (red), then more packages or clients join its `repo/` and `solution.patch` (green).
     Files: Task 12's or Task 13's only.
   - `npx tsx evals/dial-skill/flow-rows.ts supersede evals/dial-skill/flow baseline <scenario>`: its rows move to
     `errors.jsonl` as `superseded`, still counted in the flow's spend.
   - Rerun the two baseline commands of Verification 3 unchanged, `--spend-cap-usd 70` included: they exit 2 (the
     scenario changed the harness), so review the diff and rerun with `--approve-harness`; only that scenario's cases
     run. The superseded spend counts toward the same $70.
   - Read its median again. Still under 15, or exit 4: stop and report to the orchestrator; the numbers do not count.

5. **Rows fit to commit** (after 3 and 4; local). From `cli/`:

   ```sh
   npx tsx evals/dial-skill/flow-rows.ts scrub evals/dial-skill/flow
   npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow
   node evals/dial-skill/build-report-lite.mjs evals/dial-skill/flow
   git status --short -- evals/dial-skill/flow
   ```

   Expected: `scrub` exits 0. `git status` shows only `flow/baseline/{results,errors,probes}.jsonl`, `summary.json`,
   `table.md` and the rewritten `flow/narrative.md` and `flow/metrics.md`; `traces/`, `report.html` and
   `trajectory/` stay git-ignored. The main session then fills the README's Results with the per-condition numbers
   and commits these files with it (Decided 2). Then Verification 1 once more: every spec passes.

   Evidence to report (counts and rates only, no transcript text), per condition: rows scored, truncated, invalid,
   unlisted, errors by class (`superseded` included); recall, specificity, precision, `line_ok`, `ask_ok`, `harmed` n
   of N, `went_on` n of N, `one_step` n of rang; score per split with its interval; the held-out table (val and test
   pooled); spend per condition, probes and total; each probe's listing characters, skill count, dial state and
   `CLAUDE.md` given; Claude Code version; the median tool calls of each late-need scenario (15 or more, after 4);
   the `find` output of Verification 3 (only the startup files the README names). The same per-condition numbers go
   in the PR body.

## Decided

Decided by the orchestrator, 2026-11-26.

1. **`name-only`** is `crowd` (its skills and `CLAUDE.md`) with the dial's description dropped: the real case "many
   skills, small context".
2. **The baseline is committed in this PR** by the main session after the pass: rows, probe rows and the tables
   (`narrative.md`, `metrics.md`, the README's Results). Only numbers, scenario names and fixed ids; no traces, no model
   text, no machine paths, home folders, user names or host names. Task 22 scrubs and checks; Verification 5 runs it.
3. **The spend cap stays $70 for this PR.** Crossing it stops the pass, which reports to the orchestrator.
4. **The crowd holds four to six process skills** whose descriptions claim priority as real ones do, before the
   baseline (Tasks 9 and 19), so it measures competition for attention, not only the listing's length.
5. **The README says plainly** that `name-only` drops only the dial's own description, while a real session over its
   listing budget loses other skills' descriptions too (Task 21).
6. **The whole design's cap is $250**; Part 1 uses $70 of it, and later parts pass a larger `--spend-cap-usd`, never
   above 250 (Task 21).
7. **A late-need scenario under a median of 15 tool calls** in the baseline is made heavier and its cases rerun, inside
   the $70, before the numbers count (Verification 4).
