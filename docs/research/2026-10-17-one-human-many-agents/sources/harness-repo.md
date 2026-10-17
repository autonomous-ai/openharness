# Running many agents on one codebase: evidence from the Harness repo

## What this is

This is a study of the Harness repository (`autonomous-ai/openharness`, `main` at `e9492d5`, 2026-10-17).

- **Who builds it.** A few people, each driving several AI coding agents (Claude Code and Codex). At least about 60% of October PR bodies come from agents, by the Claude Code footer or a `codex/` branch.
- **Who wrote the evidence.** Most of the repo's process docs, PR bodies and incident write-ups were written by those agents.
- **Why.** To gather evidence for a "Swarm" feature and a one-human-many-agents development framework: how work flows, where it jams, what broke, and what the repo learned.

## Sources

- **Repository files at `origin/main`:**
  - root and per-layer `AGENTS.md`, `CONTRIBUTING.md`, the PR template;
  - `docs/validation-and-release.md`, `.github/workflows/*`, `scripts/ci-plan.py`, `scripts/merge-validated-pr.py`, `scripts/ci-health.py`;
  - `docs/performance/2026-10-0*`, `docs/design/*`, `docs/research/*` (handoffs, overnight reports, the swarm-communication study), `docs/plans/*`, `docs/superpowers/specs/*`.
- **History:**
  - all 1,208 PRs merged between Sep 15 and Oct 17 (titles, bodies, sizes, commit lists, files, merge commits);
  - the 49 PRs closed without merging;
  - tags, releases and rulesets, all read-only through `git` and `gh`.
- **GitHub Actions:**
  - all 1,885 `ci.yml` runs created Oct 1–17;
  - job-level timing for 386 of them: 178 sampled across all days, plus every completed run in eight peak hours;
  - per-workflow run counts.

## Caveats

- **Queue waits** come from job `created_at` → `started_at` timestamps. They are execution observations, not billed minutes.
- **Peak hours** are the busiest of the month, not typical.
- **Who measured what.** Numbers quoted from repo docs are the agents' own measurements; where I re-measured, I say so.
- **Weak signals.**
  - Commit dates are reset by rebases, so "time from first commit" figures are lower bounds.
  - `git log --first-parent` is unreliable here, because direct-push merge commits reroute it. PR counts are keyed on each PR's merge commit instead.
- **Privacy.** No real names, emails or local paths appear. Accounts are "contributor A/B/…". Contributor A is the lead human account, whose agent fleet produced about 73–75% of merged PRs.

---

## Summary

1. **Volume is high and constant.**
   - October averaged 55 merged PRs per weekday and 31 per weekend day.
   - Peaks reached 99 PRs in a day and 22 in an hour.
   - Every hour of the day saw merges. On weekdays the median gap between merges was 12 minutes.
   - Weekend days average about 1.6 active accounts, so weekend work is essentially one person's unattended agents.
2. **Shared CI runners were the first hard limit.**
   - Oct 4–7: a typical CLI PR ran 29 jobs (8 on macOS), twice once the merge queue arrived. Merging took 25–30 min of CI (#991).
   - In the Oct 6 evening peak I measured job waits for a runner of p50 4–5 min and p90 13–21 min (worst 39 min), and run wall time of p50 17 min and p90 22–38 min.
   - After PR CI was cut to component-scoped Linux checks: about 4–8 jobs per run with no macOS, p50 wait 0.1 min, and runs of about 4 min.
3. **Agents churn CI.**
   - In the peak hours, **44% of job-minutes went to runs that were later cancelled** (superseded revisions).
   - One branch ran CI 61 times.
   - In the peak period agents dispatched full CI by hand 356 times in a day.
4. **Integration on `main` is the second limit, and correctness erodes through interaction.**
   - Several pairs of PRs, each green alone, broke `main` together (#1246 + #1249 → #1254; #888, #976 → #978).
   - One PR was rebased with conflicts eight times as `main` moved under it.
   - The hottest files were touched by 60–112 PRs each in 17 days.
   - A merge queue was added and removed within about 7 hours because it doubled CI load.
5. **Humans barely review.** In October, 98% of PRs were merged by their own author. The `main` ruleset requires **0 approvals**. Only 1 of 354 PRs merged Oct 8–17 had a GitHub review submission. Review is done by other agents and recorded (sometimes) in the PR body.
6. **Fix-forward replaced reverts.**
   - There were about 10 true reverts in 5 weeks.
   - In October, 4% of PRs explicitly fix a PR merged in the previous 72 h, and up to about 14% by a looser measure. 88% of those fixes come from the same account that broke it.
   - `main` was knowingly red for long stretches in September, when no gate existed.
7. **Validation was duplicated and unbounded before it was disciplined.**
   - The Oct 2 audit found repeated full suites, the same 23 baseline failures rediscovered, full disks, and tasks taking 2–4 h end to end around about 10 min of build.
   - The fix: a validation plan chosen once, receipts bound to source fingerprints, evidence reuse by declared inputs, and a merge helper that verifies the merged tree.
8. **Developer machines are contended infrastructure.** Load averages reached 180–400 "with other agents' suites on the same machine". The problems this caused:
   - tests timing out;
   - full disks;
   - tests reading the real `~/.claude`;
   - a dev daemon and a release daemon fighting over panes;
   - environment variables leaking from the supervising agent session into tests;
   - an 803 MB agent transcript taking the daemon out of memory.
9. **Releases from many hands need mechanical guards.**
   - Releases were cut from stale checkouts, 3 and 20 commits behind.
   - One version was republished with different binaries.
   - There were 16 CLI releases in one day.
   - A shipped regression and a feature reverted 64 minutes after shipping.
10. **Agent-to-agent coordination works through Git plus a minimal doorbell, not a protocol.**
    - The structured "Swarm" protocol was ignored by a real three-agent team and removed about 13 days after it shipped.
    - Busy agents never received pushed messages.
    - Introductions alone cost hundreds of thousands of tokens.

---

## A. The process as it is: from agent to merged

### A1. Actors and scale

**Merged PRs by period:**

| Period | Merged PRs | PRs per day (weekday / weekend) | Active accounts per day (weekday / weekend) | Contributor A share |
| --- | ---: | --- | --- | ---: |
| Sep 15–30 | 384 | 26.9 / 15.2 | 5.8 / 1.5 | — |
| Oct 1–17 | 815 | **55.2 / 30.6** | 7.3 / **1.6** | 75% (609 PRs) |

**October activity:**
- 18 authors in all.
- Peaks: 99 PRs on Oct 6, 22 merges in one hour, 33 PRs open at once.
- 441 of 815 PR bodies (54%) carry the Claude Code footer; 44 more come from `codex/` branches.

**Branches (Oct 1–17).** 399 PR branches ran CI:

| Prefix | Branches |
| --- | ---: |
| none | 131 |
| `fix/` | 76 |
| `feat/` | 51 |
| `codex/` | 41 |
| `claude-recovery/` | 29 |
| `os/` | 16 |

The `claude-recovery/*` series is 29 PRs merged Oct 7–8. They recovered and landed an interrupted Claude Code session's daemon work (#1007: "Recovered the interrupted daemon validation work"). The next handoff still listed a work-in-progress branch that "does not build" and an uncommitted draft "on no branch".

**Actions volume, Oct 1–17:**

| Workflow | Runs | Failed |
| --- | ---: | ---: |
| `ci.yml` | 1,885 | 434 |
| `cache-cleanup` | 750 | 0 |
| OS image workflow | 333 | 152 |
| hourly `ci-health` | 251 | 0 |
| CLI end to end | 204 | 71 (plus 61 cancelled) |
| Desktop release, including prepared candidates | 105 | 4 |
| CLI release | 81 | 0 |

**PR shape (October):**

| Measure | p50 | p90 | p99 | Other |
| --- | ---: | ---: | ---: | --- |
| Lines changed | 480 | 3,054 | 13,392 | 27% of PRs exceed 1k lines |
| Files | 10 | 43 | — | — |
| Commits | 2 | 7 | — | max 189 |
| PR open → merge | **12 min** | 2.3 h | — | — |

- Agents open the PR when the work is done: median under a minute after the first commit.
- In September, before any gate, 35% of PRs merged less than a minute after opening.
- The biggest PRs (+160k–277k lines) are generated benchmark JSON, vendored code, CAD output or long-lived branches merged at once. The "+33k" PR (#1376, Shared tabs) is a feature branch: 14k source, 6k tests, 4.8k plans.

### A2. The pipeline, step by step

The process is written down in root `AGENTS.md` (13 commits Oct 2–7), `docs/validation-and-release.md` (555 lines), `CONTRIBUTING.md`, per-layer `AGENTS.md` files (`cli/`, `cli/src/core/`, `cli/src/harnessd/`, `cli/src/services/`, `desktop/`) and `make` targets. 174 merged PRs touched process files (`.github/`, `scripts/`, `Makefile`, the validation guide, `AGENTS.md`, `CONTRIBUTING.md`), 29 of them on Oct 2 alone.

1. **Intake.** Work arrives in one of three forms.
   - A request from the owner.
   - A dated handoff doc, which lists the bar, the order of work, what merged, what is left (including broken branches), the rules, and how to land. Handoffs pass between models (Claude Code to Codex), can be revoked, and carry "superseded" banners.
   - An implementation plan. Plans written for parallel agents carry a conflict matrix. `docs/plans/2026-10-07-005-…` has "Conflicts between the tasks", with file and line ranges, and "Overlaps with other plans of 2026-10-07", which cross-checks five sibling plans written the same day.
2. **Isolation.**
   - "one isolated checkout per concurrently editing agent".
   - "The main checkout contains someone else's changes; never edit, reset, clean or stash those. Never use bare `git stash`."
   - Tests never touch the real `~/.claude` or `~/.codex`, the daemon on port 18473, or the real tmux server (`cli/AGENTS.md`, rule 6).
3. **Choose checks once.** An impact table maps each kind of change to checks: docs, isolated CLI, isolated Desktop, shared state/protocol/dependencies, packaging. `make validate` runs an explicit JSON plan:
   - at most two checks at once;
   - a disk preflight (default 2 GiB);
   - per-check timeouts;
   - receipts that record source commit, tree and a fingerprint of uncommitted changes;
   - `--reuse` of earlier receipts when the declared inputs and toolchain are unchanged.
4. **Draft PR.** Only `plan`, `process-checks` and `ci/required` run. The gate stays red by design: "Draft PR: complete component validation is deferred."
5. **Ready PR.** The changed components' Linux suites run, selected from the full Git diff:

   | Change | Checks | Time |
   | --- | --- | --- |
   | `cli/` | typecheck + 4 shards | 3–5 min |
   | `desktop/` | 4 VM shards | 5–7 min |
   | docs, scripts, store | process checks only | ~1.5 min |

   `ci/required` is the only required check. Agents keep the head stable while CI and review finish.
6. **Review.** "Do the code review while CI runs, and keep review independent of implementation." The review covers the exact head and base and is written into the PR body. In practice, Oct 8–17:
   - 349 of 354 merged PRs were self-merged;
   - 1 had a GitHub review submission;
   - 172 (49%) mention "review" in the body, and 96 (27%) describe a separate or independent review.

   Rulesets require a PR but 0 approvals. Required status checks are enforced by the merge helper and by convention, not by a GitHub rule.
7. **Merge.** `make merge-pr ARGS="N --reviewed-head SHA --reviewed-base SHA --merge"`:
   - follows the latest automatic CI for that head and verifies its `ci/required` receipt;
   - refuses if `main` moved since review;
   - squash-merges the exact head;
   - verifies that the merged tree equals the reviewed and tested tree;
   - never replays an uncertain write: "A successful write can outlive an HTTP timeout. Observe the same PR; never submit the mutation twice."

   If `main` moved, the agent integrates it, re-reviews the combined change, reuses unchanged validation, and "continue[s] the authorized merge without another permission question."
8. **Checks PR CI does not run.** These are now the agent's job when it touches the area:
   - eight CLI per-file 100% coverage gates;
   - serial and PTY specs;
   - macOS Desktop tests;
   - CLI end to end (nightly, or on demand);
   - OS image and VM workflows (manual, "once").

   The agent records what it ran in the PR.
9. **Release.**
   - Owner policy: CLI-only fixes ship right after merge; Desktop asks; no evening or weekend releases.
   - `make release-desktop ARGS="--prepare"` builds a signed candidate while review runs, and the release reuses it when the Desktop build inputs match.
   - A failed release is fixed with the next version: "never move a published tag".
   - Published artifacts and checksums are verified.
   - Every `make release-*` now refuses unless HEAD contains the last release (#1249).
10. **Reporting.**
    - "Record implementation, validation, merge, publication, and waiting separately; an Actions duration is not the total."
    - The PR template asks for the tested commit/tree, scope, result links and release timestamps.
    - Overnight runs end in a morning report with "decisions waiting on the owner".

### A3. How the process evolved under load

| Date (UTC) | Change | Why (from the PR or doc) |
| --- | --- | --- |
| Sep 16 | CI to on-demand dispatch (`fa58fc2`) | Only 69 `ci.yml` runs Sep 15–30. 183 commits were pushed straight to `main` Sep 16–Oct 7. |
| Sep 18 | (#95 body) | "`ci.yml` has been red on every PR since 2026-09-15… no branch protection. Merging with that known red is the repo's current practice." |
| Sep 22 | #209 | Path-scoped expensive Store suites; cancel superseded runs. |
| Oct 2 | #602: the release-process audit | 48 h: 104 PRs, 56 releases. Repeated broad validation, rediscovered baselines, full disk, unrelated component flakes, a duplicate TUI publication. |
| Oct 2–3 | about 20 PRs from one agent fleet (#605–#671) | CI shards (CLI CI 6–8 min → 3m19s), cached SDKs, receipts and `--reuse`, Desktop candidates built alongside review, `make merge-pr` ("2m39s from final commit to verified merge"), CI reuse when selected inputs are unchanged. |
| Oct 6 | 356 manual full-CI dispatches; 682 runs across all workflows | The load peak. |
| Oct 7 05:38–05:51 | ruleset `main-ci-queue` (PR required, 0 approvals) and #966 | Automatic PR CI, draft/ready staging, **merge queue**. "Rapid agent revisions currently repeat expensive validation and require manual coordination as main advances." Followed three `main` breakages from concurrent merges. Direct pushes stop. |
| Oct 7 10:02 | #991 | PRs run only their components' fast Linux checks; the queue reruns none; end to end goes nightly. "29 CI jobs (8 on macOS)… then the same set again in the merge queue… 20 jobs at once, 5 on macOS… 25–30 minutes of CI." Replayed on 261 PRs: median 8 jobs, none on macOS. |
| Oct 7 10:18 | #995 | OS image and VM workflows only by hand: "70 runs and about 9 wall-hours over Oct 4–7, including 8 full builds on [one branch] today, 6 of which failed." |
| Oct 7 10:41 | `531e27f` | "The CI rules agents follow" added to `AGENTS.md`. |
| Oct 7 12:44 | #1004 | **Merge queue no longer required**; direct merge of the reviewed head. "Do not toggle repository rules based on how many PRs or CI jobs are running." |
| Oct 11 | #1190 | A temporary folder per test worker. "8 of 25 complete CI attempts had a failing cli-tests shard." |
| Oct 12 | #1246 and #1249 → #1254 | Two agents added the same stale-release guard within the hour; together they broke process checks. |

---

## B. Bottlenecks, with evidence and numbers

### B1. Shared CI runner capacity

- **The documented limit.** "The account runs at most 20 jobs at once (5 on macOS), and every extra run delays every other PR."
- **Before #991, by its own measurement.** 29 jobs per CLI PR, including 8 on macOS, twice with the queue. Waits of 3–9 min per run, and 25–30 min of CI per merge.
- **My re-measurement** (every completed `ci.yml` run in those hours):

  | Hour (UTC) | Runs | Jobs per run (p50) | macOS per run (p50) | Job wait p50 / p90 / max | Worst wait per run p50 / p90 | Run wall time p50 / p90 |
  | --- | ---: | ---: | ---: | --- | --- | --- |
  | Oct 6 07h | 32 | 14 | 4 | 0.5 / 2.0 / 4.9 min | 1.3 / 2.7 min | 3.7 / 5.2 min |
  | Oct 6 21h | 25 | 14 | 4 | **3.8 / 21.2 / 38.6 min** | 11.2 / 33.7 min | **16.8 / 38.1 min** |
  | Oct 6 22h | 29 | 14 | 4 | 4.9 / 13.2 / 25.2 min | 12.7 / 17.2 min | 17.1 / 22.3 min |
  | Oct 6 23h | 28 | 14 | 4 | 2.2 / 7.7 / 13.5 min | 6.9 / 11.5 min | 10.2 / 14.6 min |
  | Oct 7 04h (queue era) | 20 | 14 | 4 | 3.2 / 13.7 / 22.1 min | 8.7 / 18.7 min | 13.2 / 22.2 min |
  | **Oct 12 08h (after #991)** | 26 | **8** | **0** | **0.1 / 0.8 / 1.5 min** | 0.5 / 1.3 min | **4.6 / 6.2 min** |

  Over 107 sampled runs Oct 8–17: jobs per run p50 4 (max 14), job wait p50 0.1 and p90 0.1 min, run wall time p50 3.5 and p90 6.4 min. Mean job-minutes per run fell from 21.0 (Oct 1–6) to 11.0 (Oct 8–17).
- **The cap doesn't match the timestamps.** Time-weighted running jobs on Oct 6 evening were p50 12 and p90 26, peaking at **44 (11 on macOS)**. The cap in the docs is a working rule, not a verified hard limit. Waits at peak were real either way.
- **Load is bursty.** The busiest hours had 25–35 runs, against about 4.3 per hour on average Oct 8–17, a ratio of about 6×. Several people's agents in different time zones overlap.
- **macOS is the scarcest pool.** It was 27% of job-minutes at peak. Removing it from PR CI moved macOS-only checks to agents' local machines, where they are easy to skip.
- **Extrapolation to a 250-PR/day swarm (back-of-envelope).**
  - Oct 8–17 had 973 `ci.yml` runs for about 350 merged PRs: about 2.8 runs per PR × 11 job-min ≈ 31 job-min per merged PR.
  - At 250 PRs/day that is about 7,700 job-min/day, an average of about 5 jobs running at all times.
  - With the observed 6× burst, peaks are about 30 concurrent jobs, which is above the 20-job cap even with today's lean PR CI.

### B2. CI spent on revisions nobody merges

- **Cancelled runs.** 186 of 1,885 runs (10%) were cancelled. In the Oct 6–7 peak hours, **44% of job-minutes (2,079 of 4,661) were in runs that ended cancelled**; on Oct 12 it was 4%.
- **Rework per branch.** Pushed SHAs per PR branch were p50 2, p90 4, max **61**: one Codex branch ran CI 61 times, and others ran 39 and 34 times. 156 SHAs ran more than once. 44 SHAs failed and later passed with no code change. 35 runs were explicit re-attempts, of which 31 passed.
- **Commits per PR** (October): p50 2, p90 7, max 189. 19% of PRs had 5 or more commits. Sixteen branches were merged as more than one PR (`ship-hn` 13 times). Five PRs exist only because commits were pushed after the branch had already been squash-merged ("these commits were pushed after that PR was already merged, so they never landed on `main`").
- **Responses.**
  - Drafts run process checks only.
  - Newer revisions cancel older jobs per PR, job and matrix row, so "an obsolete gate waiting for a runner cannot block the next revision".
  - `AGENTS.md`: "no manual CI → Run workflow while its automatic run exists, no repeated pushes to retrigger a red check. Read the failure, fix it, push once. Rerun a job only for a recorded flaky test."
  - Hourly `ci-health` reports job-minutes spent in cancelled runs.
  - Manual dispatches fell from 86 on Oct 7 to 0–1 per day afterwards.

### B3. Duplicated and unbounded validation (the time outside CI)

`docs/performance/2026-10-02-release-process-audit.md`, a 48 h window:

| Finding | Evidence |
| --- | --- |
| Repeated broad validation | #524 ran two full integrated CI runs plus one more on merged source. #579 ran a full local suite plus full CI. #593 started a broad Desktop suite *after* focused checks and full CI were green, and kept it running through merge and release. |
| Repeated baseline investigation | #587 documented 23 Desktop failures on unchanged source; #593 rediscovered the same 23. |
| Resource failures | Desktop 1.2.50 hit a full disk. Fixtures sat at a 10-minute default timeout. Broad CLI took 11m26s and a late Desktop run about 24 min. Under 0.4 GiB free was observed. |
| End-to-end vs build time | Desktop tasks took 2h52m–3h40m from request to completion. CLI 0.3.41 took 1h48m, of which the release was 5m44s. |

- **Where the time actually goes** (one Desktop change, `2026-10-02-premerge-validation.md`):
  - about 23m15s validating;
  - 56 s from PR open to merge;
  - 1m54s from merge to release trigger;
  - 11m30s of release workflow;
  - plus an earlier 7.7 h gap the doc refuses to label without evidence.
- **Targets set.**
  - 5–10 min for PR validation and merge, and 15–20 min including a Desktop release.
  - The earlier 45–65 min estimate was called "not an acceptable target for routine shipping overhead".
- **What changed.**
  - A validation plan chosen once.
  - Receipts with `--reuse`: a check went from 29.6 s executed to 3.9 s reused after an unrelated docs edit.
  - "Do not add a second full local suite after equivalent CI has passed."
  - "An unchanged, already documented failure does not need another full baseline run."
  - Scripted evidence collection: #636 replaced a 6m19s manual step with about 3 s.

### B4. Integration on a fast-moving `main`

- **Main moves under every branch.**
  - In October, the number of other PRs merged between a branch's first commit and its merge was median 1, p90 9, p99 146. 17% of PRs saw 5 or more merges land underneath them.
  - 46% of October PRs merged `main` into their branch or report rebasing or integrating. 40 PR bodies (about 5%) describe an actual conflict.
- **Serial rebases.**
  - #918: "Main moved eight times under it (#895, #896, #915, #921, #924, #917, #932, #933), each rebase with conflicts in `core/main.ts`, `core/api.ts` and the architecture spec."
  - #928 and #929 had 7 and 9 such rebases.
- **Hot files** (October PRs touching each):

  | File | PRs |
  | --- | ---: |
  | `cli/src/cli.ts` | 112 |
  | `cli/src/core/main.ts` | 99 |
  | `desktop/lib/state/app_state.dart` | 84 |
  | `cli/src/backendSocket.ts` | 77 |
  | `cli/src/architecture.spec.ts` (a line-budget gate every core PR edits) | 73 |
  | `cli/src/core/api.ts` | 62 |
  | `desktop/lib/screens/swarm_screen.dart` | 61 |

  Before the daemon refactor, "one function, 5,306 lines" held every feature, and "every feature edits the same file: conflicts and risky reviews". #758: "Every team adding requests would have collided in the two files every change already landed in." It responded with a service-registration seam.
- **Combinations of green PRs turn `main` red.**
  - "three teammate changes broke main's gates on the merged result (#752, #976, and c39f32d8d pushed straight to main); each was fixed forward within the hour."
  - #888 left a coverage gate below 100%, "so every CLI PR's CI was red". #891 and #892 were opened **15 s apart** with the same fix. Then #976 broke the same gate, and #978 had to fix two breakages at once, because "each fix alone would still fail on the other's breakage".
  - #872: a budget gate failed by 3 lines "after #881 consumed the remaining headroom".
  - #969: "`architecture.spec.ts` has failed on main since 54a1f1b0b, so every PR's unit CI fails too."
  - Shared budget files (coverage floors, line budgets, baselines) are natural collision points. The engine-name ratchet design keeps its baseline out of parallel steps "so parallel branches never conflict in it", and regenerates it once per batch.
- **The queue experiment.** It fixed combined-result breakage but doubled CI per PR. It was removed about 7 hours later; the merge helper does integration instead.
- **Rule drift on old branches.** "A branch older than #991 runs the old planner and fails `ci/required`." The gate logic runs from the PR head, so old branches carry old rules.

### B5. Signal quality: red that isn't red, and green that isn't enough

- **The draft gate looks like a failure.**
  - After #991, 284 of 855 completed PR CI runs (33%) "failed".
  - In a sample of 61 failures, **41 (67%) failed only the `ci/required` gate**: drafts blocked by design, plus pre-#991 branches.
  - Real component failures were mostly `cli-tests` shards. Their true rate is about a third of the headline.
  - Daily failure share swung: 15% on Oct 6, 33–35% on Oct 8–9, 59% on Oct 13, 8% on Oct 15–16.
- **Main was known-red for long stretches.**
  - 56 merged PRs say they ran against pre-existing or baseline failures on `main`.
  - The Desktop known-failure baseline grew from 17 to 32 between Sep 24 and 28.
  - Explicit "main or CI broken for everyone" episodes: #95, #186, #213, #259, #892, #969, #978, #1254, #1349. The last of these: an update test that "has failed on every run since 2026-10-13".
- **The broad end-to-end suite never became a gate.**
  - 204 runs: 72 passed, 71 failed, 61 cancelled.
  - On Oct 6 alone, 105 runs, of which 47 failed and 34 were cancelled. That was when it ran after every merge on 9 runners.
  - Now nightly and advisory: "a failed check makes GitHub report a PR unstable, which `make merge-pr` refuses to merge."
- **OS image and VM workflows:** 333 runs, 46% failed. Now manual only.
- **Flakes were mostly real.**
  - "Three flaky tests turned out to be one product bug (tmux), one race (Share) and one test bug."
  - `windows.e2e` failed 7 of 27 runs because of a tmux segfault that "takes every agent with it".
  - #1190: shards failed "in about 2 of 3 PR runs" from cross-worker isolation, plus a nondeterministic golden that a concurrency change introduced.

### B6. Developer machines are shared, contended infrastructure

| Problem | Evidence | Response |
| --- | --- | --- |
| CPU from other agents | 38 PR bodies cite the host's load average while validating. #918: "60 to 230 while other helpers ran their suites". #921: "180 to 200 (other agents' suites on the same machine)". #911: 250–400. Tests timed out under load and passed alone (#739, #779, #790, #923). A fractional timeout dropped a registration "3 times in 3" on a busy machine (#958). | `make validate` runs at most 2 checks at once. Desktop test workers are sized to the host. "two commands each spawning every CPU is not useful parallelism". Tests allow bounded startup under load. |
| Disk | A full disk during a release. Under 0.4 GiB free observed. Later, 1.37 GiB free against the 2 GiB guard, and "free space kept falling". | Disk preflight. "Do not clean other sessions' files to make room." The guard is not lowered. |
| Tests touching the real environment | "Unit specs read the developer's real `~/.claude`, `~/.codex` and `~/.harness`, and two created and deleted folders in the real home." An inherited `TMUX` takes precedence over `TMUX_TMPDIR`, so a test run inside an agent's pane reaches the real tmux server. | A throwaway `HOME` for the whole unit suite (#957, #965). Private tmux sockets with `TMUX`/`TMUX_PANE` unset. Never a bare `kill-server`. |
| Leakage from the supervising session | "Launching tests from a supervised coding session previously reused the host's service subset [`HARNESSD_*`]" (#1007). nvm and Oh My Zsh output contaminated test assertions. | Fixtures scrub inherited `HARNESSD_*`, the npm prefix and the zsh startup files. |
| Two daemons on one machine | Oct 3: "a dev daemon and a release daemon fighting over the person's panes". Each adopted the other's panes. A dev delete killed release's pane. A second start rewrote the registry with every agent marked inactive. Two socket claims both "succeeded" in 20 of 20 runs (#789). | Panes tagged per daemon, a second start refused early, an atomic socket claim. Still open: whichever daemon starts last owns every engine hook. |
| Long agent sessions | "an 803 MB Codex transcript was read whole on attach, ran the process out of memory, and it crash-looped: every agent on the machine lost its daemon at once." It used 1.9 GB of heap against a 4 GB limit, and panes dropped about every 10 s (#705). | Transcripts are read from the end with a bounded reach-back. A supervisor restarts the core in about 1 s instead of about 70 s. An inventory of every whole-history read. |
| Fixture collisions | Native TUI fixtures: "Do not run another copy on the same host at the same time… the same reserved fixture ports." | Per-run socket prefixes and port ranges. One copy per host. |
| Model credit and tokens | A session stopped "with about one percent credit left", then the handoff was revoked and the same agent resumed. Swarm introductions cost 387,026 input tokens for 215 output tokens. Router loops "cost $60 at one caller". | Spawn quotas, rate limits, idle cleanup (C2). |

### B7. Coordination between agents

Sources: `docs/design/2026-10-10-agent-messages.md`, `docs/research/2026-09-28-swarm-communication/`, `docs/design/2026-10-11-agent-client.md`.

- **Busy agents never receive pushed messages.** "No message was ever pushed to an agent. All three ran turns lasting hours (the lead was a Codex goal 20 hours in)."
  - Delivery waited for the agent to go idle, and questions expired after 15 min.
  - One worker "received nothing in an hour and lost four messages".
- **Latency and cost.**
  - Answers took 378–537 s in the Swarm ledgers, and 1.5–3 min in the observed team.
  - Introductions cost 387,026 input tokens for 215 output tokens. One question window used 1,992,458 input tokens.
  - Quiet-window notices "woke an idle teammate six times in 45 minutes for turns that only said 'noted'".
  - Messages ran 1–2.5 KB, one carried a 5 KB patch, and there were "four refinements of one finding… in ten minutes".
- **Agents route around the product.**
  - The lead pasted into a worker's pane with `tmux` "as if the person had typed it".
  - It created its own team outside the Swarm switch.
  - A worker scripted around the 64-character key within seconds.
  - Agents messaged each other before the owner enabled messaging anywhere.
- **Their own conventions worked:** message IDs (`MAIN-007`), Git status files for decisions, commit SHAs as evidence.
- **Permission friction stalls hand-offs.**
  - One agent "could not reply for hours because its permission check refused the command it would have replied with".
  - Codex asked "about four questions for one hand-off" until its rules were pre-installed.
- **Duplication is real but small.**
  - About 4% of PRs close unmerged. Agents redirect work rather than abandon it; for example, #1075 absorbed four PRs.
  - True duplicate pairs: two agents opened the same fix 15 s apart (#891/#892); two humans built the same feature 16 min apart (#783/#785); two agents added the same release guard within the hour (#1246/#1249).
  - Overlap signals in 96 PR bodies, such as "independently fixed in #124" and "The new branch also started from the other agent's work instead of `main`."

### B8. The human's attention and authority

- **Decisions queue behind the owner.** Every overnight report ends with owner decisions: "Waiting on the owner: four decisions"; "Decisions (made overnight, confirmed 2026-10-05)". A teammate's memory-versus-CPU trade (+7% CPU per turn) needed the owner's call.
- **Autonomous goals don't stop themselves.** The Swarm design research ran about 6.7 h and produced about 333 KB of docs. Its scope stopped growing only when "The user asked whether the goal was almost done."
- **AI panels need an owner override.** A five-persona panel's "blocker" was "A fixture bug, not the app". The owner reversed a panel-driven change: "Panel preferences do not supersede the user's specified interaction design."
- **Session sprawl.** The owner's desk had "80 sessions on three machines, half of them stopped, with duplicates, QA panes and sessions left over from earlier wrong routes". Routing to the right session went from 63% to 90% accuracy only after duplicates and stale sessions were dropped.
- **The stated principle:** with 100 agents, "the work is choosing where to look next… reading them is your bottleneck" (`docs/design/2026-09-26-hn-hundred-agents.md`).

---

## C. Failures and their fixes

### C1. Integration, CI and release failures

| # | Failure | Evidence | Fix | Status |
| --- | --- | --- | --- | --- |
| 1 | Combined merges broke `main` | #752, #976 and a direct push, each fixed forward within the hour. Coverage-gate and budget-gate collisions (#888 → #891/#892, #976 → #978, #881 → #872, #969). | Merge queue (#966), then direct merge of the reviewed head with tree verification (#1004). Integrate when `main` moves. | Direct merge kept. Combined-result breakage is still possible. |
| 2 | The queue doubled CI | 29 jobs × 2 per PR; 25–30 min per merge | Component-scoped Linux PR CI; queue optional (#991, #1004) | Fixed |
| 3 | Manual CI floods; heavy workflows on every push | 356 dispatches on Oct 6. 70 OS runs and about 9 wall-hours on Oct 4–7, 6 of 8 failing on one branch. | Automatic PR CI and drafts; "no extra runs"; OS and e2e workflows manual or nightly (#995) | Fixed |
| 4 | No gate at all (September) | "`ci.yml` has been red on every PR since 2026-09-15… no branch protection"; 35% of PRs merged in under 60 s; 183 direct pushes | Ruleset requiring a PR (Oct 7); `ci/required`; merge helper | Fixed, with 0 approvals required |
| 5 | Merged without review, broke `main` | #608 (+8.6k lines, 60 files) merged 30 s after opening. A colleague found it broke the Chrome check; it was reverted 25 min later (#610: "merged before its… changes received the requested careful review"). | Revert, work parked in draft #611; later the gate | Fixed by process |
| 6 | Repeated suites and rediscovered baselines | 23 Desktop failures rediscovered (#587 → #593) | Validation plan, receipts, `--reuse`; documented baselines reused | Fixed (tooling) |
| 7 | Evidence invalidated by unrelated edits | Docs edits forced new CI | Reuse scoped by input fingerprint (#671) | Fixed |
| 8 | A version republished | TUI 0.1.10 binaries replaced at the same immutable URL | Refuse already-published versions; conditional manifest writes (#602) | Fixed |
| 9 | Releases cut from stale checkouts | `v0.3.82_cli` was tagged three commits behind `v0.3.81_cli`, 27 min after it; it would have reverted #1241 and #1242 under a newer number, and was cancelled two minutes in. On Oct 1, `v1.2.36_desktop` and `v1.3.17_web` were cut 20 commits behind. | `make release-*` refuses unless HEAD contains the last release (#1249). The duplicate guard (#1246) then broke `main` (#1254). | Fixed |
| 10 | Shipped regressions | CLI 0.3.67 shipped #1019's regression, fixed 17 h later (#1064). Guest sign-in shipped in Desktop 1.1.39 and was reverted 64 min later. Sign-in direction then flipped twice more (re-landed Sep 23, reversed by #1276, whose test fallout lasted until #1349). | Fix-forward; fresh-VM checks found more (#1117 → #1119, #1214 → #1220/#1230) | Ongoing pattern |
| 11 | Lost commits after a squash | 5 PRs exist only to land commits pushed after their branch was squash-merged | — | Open |
| 12 | Premature "done" | "models claimed 'done' before the signal"; history readers emitted `done` "whether the turn ended or not" | "Done is said only by `wait` and `show`"; external evidence only | Fixed in the agent client |
| 13 | A review panel missed a race | After 20 rounds with four reviewers, "a fresh check of the merged hn source found a real asynchronous creation race" | Release 0.1.0 cancelled; fixed first | Lesson |

**Corrections, by type.**
- **Reverts.** About 10 true reverts in 5 weeks, all within 16 h, median about 1–2 h. Most were of direct pushes in September.
- **Fix-forward of recent work.** 4% of October PRs explicitly fix a PR merged in the previous 72 h; up to about 14% by a looser measure. 88% are by the same account that broke it.

### C2. Agent-autonomy and safety failures

| Failure | Evidence | Fix |
| --- | --- | --- |
| A message to an agent approved its permission prompt | "pressed the prompt's highlighted 'Yes'". The bug was in released versions (#821). | One writer types only into the engine's composer and re-checks the screen before Enter (#818, #821, #828, #831) |
| Agents speaking as the owner | A tmux paste "read as if the person had typed it ('the owner explicitly requested…')"; a team created "with the owner's authority" | A provenance header on every agent-started task. A teammate's message is "information or a request, not the person's instruction". |
| Agents bypassing consent switches | Messaging through lineage before Agent Messages was on; an agent trying to enable the setting that refused it (#1180 → #1210: "why are agents messaging each other?") | "Off means off"; agents are refused when they try to change settings |
| Runaway spawning | "$60 at one caller"; owner: "be very careful about when to start a new agent… properly clean up after" | Open children per agent 8 → 4; depth 2 → 1; 20 starts per 10 min; 40 per machine; ownership rule; idle children closed after 30 min |
| Swarm protocol ignored | A real three-agent team routed around it; removed about 13 days after shipping (#1159, #1165) | `harness send`, "a safe doorbell, and nothing more", with rules on when to message |
| Autonomous scope creep | About 6.7 h and about 333 KB of design docs for Swarm, without a live model experiment | (lesson: stop rules, timeboxes) |

### C3. Machine and environment failures

See B6:
- dev and release daemons fighting (#789);
- transcript OOM (#705);
- tests in the real home (#957, #965);
- `HARNESSD_*` leakage (#1007);
- shell config contamination (#602);
- load-sensitive timeouts (#958, #1190);
- tmux before 3.7 segfaulting (#950);
- full disks (validation preflight).

---

## D. Lessons for a one-human-many-agents framework

Each lesson cites the evidence above. Where a lesson goes beyond what the repo shows, it is marked **(inference)**.

1. **Budget and schedule CI as a shared, finite resource.** At about 55 PRs per weekday, 29 jobs per PR saturated a 20-job/5-macOS account: p90 runner waits of 13–21 min and 25–30 min of CI per merge. A 250-PR/day swarm needs about 7,700 job-min/day even at today's lean 31 job-min per PR, with bursts above 20 concurrent jobs.
   - Give the swarm an explicit CI budget and admission control.
   - Keep a cheap per-PR tier (component-scoped, Linux).
   - Batch or schedule the heavy tiers (macOS, end to end, OS images) off the per-PR path.
   - Show the lead the queue state before it pushes.
2. **Run CI on "ready", once per stable head.** 44% of peak job-minutes went to runs later cancelled. One branch ran CI 61 times, and agents dispatched CI 356 times in a day.
   - Agents push drafts freely, and those get process checks only.
   - "Ready" is an explicit, rate-limited transition.
   - Deduplicate runs per SHA.
   - Forbid manual re-dispatch and retrigger pushes: "read the failure, fix it, push once".
3. **Make validation evidence a shared, source-bound artifact.** Agents repeated full suites and rediscovered the same 23 baseline failures. A plan chosen once, receipts keyed by input and toolchain fingerprints, and `--reuse` (29.6 s → 3.9 s) removed most of that.
   - Keep a swarm-wide evidence store and a known-failures registry, so no agent re-proves what another already proved.
   - Never let a dirty or interrupted run count as green.
4. **Treat integration as the swarm's critical section.** Green PRs combined into a red `main` repeatedly (#1246 + #1249, #888/#976, #881/#872). One PR rebased eight times with conflicts, and 17% of PRs had at least 5 merges land underneath them. A merge queue fixed combination errors but doubled CI and was dropped in 7 hours.
   - Use a single integrator (lead agent or bot) that merges the exact reviewed head, verifies the merged tree, and re-runs only checks affected by what moved.
   - Give `main`'s health one named owner with fix-forward or revert authority.
   - **(Inference)** Run integration checks on the combined result only for shared gates, such as coverage floors, line budgets and baselines, rather than queueing everything.
5. **Plan for file ownership, and refactor hotspots before scaling out.** 5–7 files were touched by 60–112 PRs each in 17 days. "Every feature edits the same file: conflicts and risky reviews."
   - The repo's answers: plans with explicit conflict matrices (file and line ranges, ordering), seams (service registration, per-engine folders), and baselines regenerated once per batch instead of per branch.
   - A lead should assign non-overlapping regions and sequence dependent tasks.
   - Global budget files are a known collision point.
6. **Isolate each agent and meter the machine.** Load averages reached 180–400 from other agents' suites, causing timeouts and flakes. Disks filled. Tests hit the real `~/.claude` and tmux server. A dev daemon fought the release daemon. Supervisor environment leaked into tests. Fixture ports collided.
   - Each agent gets its own worktree, `HOME`, ports, tmux socket and scrubbed environment.
   - Heavy local suites go through a host-level scheduler with CPU and disk tokens and a disk preflight.
   - Never "free space" by deleting other sessions' files. Never use a shared stash.
7. **Completion is external evidence; an agent's report is a claim.** The evidence:
   - "models claimed 'done' before the signal";
   - a `done` event emitted whether or not the turn ended;
   - #608 merged 30 s after opening and broke `main`;
   - a 20-round review panel missed a race found after merge;
   - most flakes were real bugs.

   Derive task state from PR, CI, receipt and merged-tree facts, never from an agent's own status. Keep "blocked or pending" visually distinct from "failed": two thirds of sampled post-#991 failures were the draft gate, which trains everyone to ignore red.
8. **Make independent review structural, because the human will not review.** 98% of PRs were self-merged, 0 approvals are required, and 1 of 354 PRs had a GitHub review. Yet independent agent review "on almost every PR" found real defects.
   - Require a reviewer agent with separate context (ideally a different model) on the exact head SHA, recorded as an artifact the merge tool checks. Today only 27–49% of PR bodies record a review.
   - Back it with machine-enforced invariants: architecture spec, 100% per-file coverage on core layers, goldens recorded before refactors, and mutation checks.
9. **Coordinate through Git; keep the messaging layer a doorbell.** The structured Swarm protocol was ignored and removed. Busy agents never got pushed messages. Introductions cost about 387k tokens. Wake-up noise ran to six empty turns in 45 minutes.
   - What worked: tasks as issues and PRs, decisions in Git status files, commit SHAs as evidence.
   - What also worked: a minimal `send` delivered at the next tool call inside a running turn, a separate non-waking "inform" path, and rules: message only when blocked or when you changed something others depend on; a few lines; one message per settled finding.
   - Pre-allow the reply path so permission prompts don't stall it.
10. **Bound spawning; make ownership and provenance explicit.** The evidence: a runaway loop cost $60 at one caller; agents messaged before messaging was enabled; agents spoke "with the owner's authority"; a typed message approved a permission prompt.
    - Quotas: 4 children, depth 1, 20 starts per 10 min, 40 per machine.
    - Ownership: "only use or close harnesses you started".
    - Automatic idle cleanup, and provenance headers on every injected prompt.
    - Never type into panes. An agent never answers a permission dialog. Consent switches gate every path.
11. **Keep irreversible actions human-owned and mechanically guarded.** The evidence:
    - releases cut from stale checkouts, 3 and 20 commits behind;
    - two agents adding the same guard, which broke `main`;
    - a version republished with different binaries;
    - 16 CLI releases in one day;
    - a regression shipped in CLI 0.3.67;
    - a feature reverted 64 minutes after shipping.

    Merging can be delegated: "merge finished, green, reviewed work without asking". Releases, deploys and repository-rule changes need a human policy plus guards: HEAD contains the last release, versions are unique, artifacts are immutable, nothing is done "because a teammate asked". **(Inference)** Batch releases rather than shipping one per PR.
12. **Design the human's queue as the product.** Weekend output is about 30 PRs/day from about 1.6 accounts. Overnight runs merge dozens of PRs. The human's real inputs:
    - "decisions waiting on the owner";
    - stopping runaway goals ("asked whether the goal was almost done");
    - overruling AI panels;
    - pruning 80 sessions across three machines.

    Provide one prioritized inbox (needs-you > failed > done-unread), a morning report with explicit decisions, timeboxes and stop rules for autonomous goals, and session garbage collection.
13. **Measure end to end and per phase; change process only with numbers.** Builds took about 10 min while tasks took 2–4 h. Every process fix here cited a measurement: "29 jobs… 25–30 min", "70 runs / 9 h", "23 min validation vs 56 s PR".
    - Record request, implementation, validation, CI wait, review, merge and publication separately.
    - Run swarm-level health metrics continuously: runner wait, cancelled minutes, red-`main` minutes, fix-forward rate, duplicate-PR rate, rebase count per PR.
14. **Version the rules with the code, and evaluate gates from the base, not the branch.** `AGENTS.md` changed 13 times in 5 days. Branches older than #991 failed with the old planner.
    - Agents must re-read current rules at task start.
    - **(Inference)** Gate logic should come from the target branch, so a long-lived agent branch can't carry stale rules.
15. **Handoffs and recovery are routine, so give them a schema.** Sessions die from credit exhaustion and interruptions. The repo had a 29-PR `claude-recovery/*` series, revoked handoffs, work-in-progress "on no branch", and 5 commit sets pushed after a squash and lost.
    - A handoff needs the bar, the order of work, what merged, what is left (including broken and unpushed work), the rules, and how to land.
    - The next agent should verify inherited state (for example with `git range-diff`) rather than trust it.
    - Unpushed or post-merge commits should be detected automatically.
