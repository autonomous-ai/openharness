# Merge rule matches how merges are done: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. One task, one commit: docs only, so there is
> no red test. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `AGENTS.md`, `docs/validation-and-release.md` and `CONTRIBUTING.md` name the merge that is done when
`make merge-pr` refuses only because `main` moved: `gh pr merge <PR> --squash --admin --match-head-commit <head>`, on
green required checks and no conflict. A conflict still means integrating `main`.

**Architecture:** Docs only. One rule, said in four spots of three files with the same conditions and the same
command: the root rule (`AGENTS.md`, "Merge and release"), the guide's short rule (the hand-merge bullet of "In
short"), the guide's detail (the "If `main` moved" paragraph of "Merge an already-reviewed PR") and the contributor
guide (`CONTRIBUTING.md`, step 5 of "How a change lands"). The old "integrate whenever `main` moves" text goes in the
same commit.

**Tech Stack:** Markdown. No code, no dependency.

**Spec:** [docs/plans/2026-11-14-merge-rule-docs-design.md](2026-11-14-merge-rule-docs-design.md). Read it with this
plan and the root `AGENTS.md`. The spec is the authority.

## Decisions

- `CONTRIBUTING.md`, step 5, gets the same rule in this pull request (Task 1, Step 4).
- `docs/pr-triage/roles.md` does not change: that role merges outside contributors' pull requests and keeps its
  stricter rule. The docs this change edits say nothing about it.

## Global Constraints

- Files: `AGENTS.md`, `docs/validation-and-release.md` and `CONTRIBUTING.md` only. `docs/pr-triage/roles.md`,
  `scripts/merge-validated-pr.py` and the `Makefile` do not change; nor do branch protection, CI or the merge train.
- Docs describe and name no person. Short, in each file's own words and wrap:
  - `AGENTS.md` says "pull request" and wraps at 120.
  - The guide says "PR"; "In short" wraps at 120 with a two-space continuation, and "Merge an already-reviewed PR"
    wraps at about 84.
  - `CONTRIBUTING.md` says "PR" and "the merge helper"; step 5 wraps at about 100 with a three-space continuation.
- The fallback needs all three: `make merge-pr` refuses only because `main` moved; the required checks are green on
  the head; GitHub shows the PR mergeable with no conflict.
- The command reads the same in all four spots: `gh pr merge <PR> --squash --admin --match-head-commit <head>`.
- A conflict: integrate `main`, review the combined change, rerun only the affected checks.
- `make merge-pr` (in `CONTRIBUTING.md`, "the merge helper") stays the first step in every spot.
- The heading `## Merge an already-reviewed PR` stays as it is: `CONTRIBUTING.md:180` links to its anchor, and that
  line does not change.
- One pull request. Platforms: none (docs).

## Found while reading the code

Checked at `905fb180ec`:

- **The refusal.** `scripts/merge-validated-pr.py:38-41` (`preflight`) raises
  `main moved since review; inspect the new source before merging` when the `main` ref is not `--reviewed-base`; line
  279 prints it. The guide quotes this string exactly. Only the script holds it
  (`git grep "main moved since review" -- . ':!docs'`).
- **Nothing asserts the doc text.** Phrases from the four spots appear in no test, script or workflow. Outside the
  docs the guide is named only in comments and docstrings (`.github/workflows/ci.yml`, `release-desktop.yml`,
  `windows.yml`, `scripts/ci-plan.py`, `scripts/validate-change.py`, `Makefile`), by its path or by an anchor this
  change keeps. `scripts/`, `.github/` and the `Makefile` never name `CONTRIBUTING.md`; other files link to it by path
  or by the anchors `#your-first-harness` and `#adding-a-multiplexer`, none to step 5. `scripts/tests/` reads the pull
  request template and workflow files, never these three. The repo has no Markdown or link checker.
- **Local gates.** `python3 scripts/local-checks.py --list AGENTS.md docs/validation-and-release.md CONTRIBUTING.md`
  prints `{}`; with the two `docs/plans/` files added, `{}` too.
- **PR CI.** `select()` in `scripts/ci-plan.py` returns no suite for the three paths; all are `inert` (lines 294-297:
  under `docs/`, or a top-level `.md`). The pull request runs `plan`, `process-checks` and `ci/required` only, about
  two minutes.
- **The flags exist.** `gh pr merge --help` (gh 2.95.0) lists `--squash`, `--admin` and `--match-head-commit SHA`.
- **What the fallback leaves out.** The helper verifies the `ci/required` receipt, checks the merged tree, writes the
  squash message that names each co-author once and keeps a record under `.harness/validation/`; `gh pr merge` does
  none of these. The spec does not ask the docs to list them, and the text below does not.
- **Who can run it.** `--admin` needs admin rights on the repository, so in `CONTRIBUTING.md` the fallback is read by
  people who cannot run it. Step 5 already describes the merge itself, and the spec gives it the same rule with no
  qualifier; the text below adds none.
- **The other statement of the old rule:** `docs/pr-triage/roles.md:37`, `:145-149`, `:166` ("Merge only through the
  merge helper"; on "main moved since review", update the branch through GitHub and try once more). Left as it is
  (Decisions).

## Review Focus

Each line is pinned by a check in Task 1, Step 5.

- A reader whose pull request conflicts with `main`: the guide's two spots and `CONTRIBUTING.md` give the conflict
  sentence right after the command; `AGENTS.md` gives the condition ("no conflict") and points to the guide.
- A reader whose `make merge-pr` refused for another reason (a red check, a changed head, GitHub not reporting the PR
  clean): "only because `main`" is in all four spots.
- The four spots drifting apart: one command string, counted.
- The old rule left behind in any of the three files: counted as zero.
- The link from `CONTRIBUTING.md:180`: the heading and the link are counted.

---

### Task 1: The four spots name the fallback

**Depends on:** nothing. **Effort:** medium (mechanical, exact text given).

**Files:**
- Modify: `AGENTS.md:68-69`
- Modify: `docs/validation-and-release.md:35-36` and `:625-631`
- Modify: `CONTRIBUTING.md:181-183`
- Test: none. No test, script or workflow reads these lines (above).

**The test that fails before the change:** none. Docs only, no behavior changes. One commit.

- [ ] **Step 1: `AGENTS.md`, "Merge and release"**

Lines 68-69 (from `touch their area` to `branch.`) become:

```markdown
touch their area, and record them in the pull request. Merge with `make merge-pr`. If it refuses only because `main`
moved, and the required checks are green on the head and GitHub shows the pull request mergeable with no conflict,
merge with `gh pr merge <PR> --squash --admin --match-head-commit <head>`. Never push to a `harness-train/` branch.
```

- [ ] **Step 2: The guide's hand-merge bullet ("In short")**

Lines 35-36 of `docs/validation-and-release.md` (the bullet's second and third lines; line 34 stays) become:

```markdown
  `--run/--scope`. Never replay an uncertain merge; inspect the PR. If `make merge-pr` refuses only because `main`
  moved, and the required checks are green on the head and GitHub shows the PR mergeable with no conflict, merge with
  `gh pr merge <PR> --squash --admin --match-head-commit <head>`. On a conflict, integrate `main`, review the combined
  change, rerun only the affected checks, and finish the authorized merge without asking again.
```

- [ ] **Step 3: The guide's "If `main` moved" paragraph ("Merge an already-reviewed PR")**

The whole paragraph, lines 625-631 on the base (627-633 once Step 2 is in), from `` If `main` moved before a direct
merge `` to `running jobs.`, becomes the paragraph below. The sentence "concurrent changes require only the additional
review and validation they affect" goes: a moved `main` with no conflict now needs neither. The paragraphs before and
after do not change.

```markdown
If the helper refuses only because `main` moved ("main moved since review; inspect
the new source before merging"), and the required checks are green on the head and
GitHub shows the PR mergeable with no conflict, merge with
`gh pr merge <PR> --squash --admin --match-head-commit <head>`. On a conflict,
integrate `main`, review the combined change, then supply the updated reviewed
head/base. Reuse validation only for unchanged inputs; rerun only the checks the
integration affects. This is routine handling of concurrent merges: continue the
user's already-authorized merge without asking for permission again. A quiet branch
takes the direct path immediately after checks and review. Do not enable or disable
a queue based on the number of open PRs or running jobs.
```

- [ ] **Step 4: `CONTRIBUTING.md`, step 5 of "How a change lands"**

Lines 181-183 (from `No merge queue is required.` to `keep their schedules.`; lines 179-180, with the link to the
guide, stay) become the five lines below. The "If `main` moved, inspect and integrate its changes, reusing validation
where the tested inputs still match" sentence goes; the "Harness catalog changes" sentence keeps its words and is only
rewrapped. Each line starts with three spaces.

```markdown
   No merge queue is required. If the helper refuses only because `main` moved, and the required
   checks are green on the head and GitHub shows the PR mergeable with no conflict, merge with
   `gh pr merge <PR> --squash --admin --match-head-commit <head>`. On a conflict, integrate
   `main`, review the combined change and rerun only the affected checks. Harness catalog
   changes publish after merge; app, CLI and firmware releases keep their schedules.
```

- [ ] **Step 5: Check the result**

Run from the repo root:

```bash
git diff --shortstat -- AGENTS.md docs/validation-and-release.md CONTRIBUTING.md
for p in 'gh pr merge <PR> --squash --admin --match-head-commit <head>' 'only because `main`' \
         'mergeable with no conflict' 'On a conflict,'; do
  echo "[$p]"; grep -c -F "$p" AGENTS.md CONTRIBUTING.md docs/validation-and-release.md | sort
done
grep -n -E 'If `main` move|inspect and integrate|concurrent changes require|newly affected|; never push' \
  AGENTS.md CONTRIBUTING.md docs/validation-and-release.md
grep -c '^## Merge an already-reviewed PR$' docs/validation-and-release.md
grep -c -F '(docs/validation-and-release.md#merge-an-already-reviewed-pr)' CONTRIBUTING.md
git diff -U0 -- AGENTS.md docs/validation-and-release.md | grep '^+[^+]' | awk 'length > 121'
git diff -U0 -- CONTRIBUTING.md | grep '^+[^+]' | awk 'length > 101'
git status --porcelain
```

Expected (measured on a scratch copy of `905fb180ec` with the four texts above applied):

- `3 files changed, 22 insertions(+), 14 deletions(-)`.
- The first three strings: `AGENTS.md:1`, `CONTRIBUTING.md:1` and `docs/validation-and-release.md:2`.
  `On a conflict,`: `AGENTS.md:0`, `CONTRIBUTING.md:1` and `docs/validation-and-release.md:2`. (On the base all four
  are 0 in all three files.)
- The old-text `grep` prints nothing (on the base it prints six lines: one in `AGENTS.md`, one in `CONTRIBUTING.md`,
  four in the guide).
- The heading count is `1` and the link count is `1`.
- The two width checks print nothing: no added line is over 120 columns, and none in `CONTRIBUTING.md` over 100.
- `git status` lists the three modified files and the two untracked documents under `docs/plans/`, nothing else.

- [ ] **Step 6: Commit**

Add the three files by name: the two documents under `docs/plans/` are untracked here and are not this task's.

```bash
git add AGENTS.md docs/validation-and-release.md CONTRIBUTING.md
git commit -m "Merge rule: the docs name the admin merge for a moved main"
```

---

## Verification

None. The change is wording in three Markdown files: nothing builds, runs or ships differently, on any platform, and
no test, script or workflow reads the text. There is no end-to-end check to run, on a machine or on GitHub, and nothing
that needs a person's own login or eye beyond the pull request's review.

**Temporary workflow:** none. There is no long check.

**Checks PR CI does not run:** none required. `python3 scripts/local-checks.py --list AGENTS.md
docs/validation-and-release.md CONTRIBUTING.md` prints `{}`, so `python3 scripts/local-checks.py --run` has nothing to
run and the pull request body needs no receipt. PR CI runs its three always-on jobs (`plan`, `process-checks`,
`ci/required`) and no component suite.
