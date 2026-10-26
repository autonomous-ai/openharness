# PR Triage Swarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only triage script and the Swarm role texts that let a Lead review outside PRs at 09:00 and 14:00, propose actions, and have Builders carry out only what a person approves.

**Architecture:** `scripts/pr-triage.py` turns GitHub's view of open outside PRs into one ranked JSON document; it reads through an injected `get(path)` so tests feed recorded responses. `docs/pr-triage/roles.md` holds three sections appended to the Default Lead, Reviewer and Builder texts in the project's Custom skills. No product code changes.

**Tech Stack:** Python 3 standard library, the `gh` CLI, `unittest` (CI runs `python3 -m unittest discover -s scripts/tests -p 'test_*.py'`).

**Spec:** `docs/superpowers/specs/2026-10-26-pr-triage-swarm-design.md`

## Global Constraints

- Read only: the script never writes to GitHub; nothing in the role texts checks out, builds or runs a fork's code.
- Outside PR: `author_association` not in `OWNER`, `MEMBER`, `COLLABORATOR`, and `draft` false.
- Score: `followers + stars`, stars summed over the author's public non-fork repositories, first 100 (`type=owner`).
- Risk paths: `.github/`, `scripts/`, `Makefile`, `**/package.json`, `**/package-lock.json`, `cli/src/lib/e2ee/`, `cli/src/lib/engineInstall.ts`, `install*` (basename), `backend/src/auth*`.
- CI states: `pass`, `fail`, `pending`, `awaiting_approval`, `none`, from the newest `.github/workflows/ci.yml` run for the head SHA.
- Default repository `autonomous-ai/openharness`. `gh` is called with `GH_PROMPT_DISABLED=1`, 30 s per call, as `scripts/record-ci-validation.py` `Client.command` does.
- Every role rule from the spec's "Rules in the Lead's role text" appears verbatim in meaning in `roles.md`.

## Ruling against the spec

- The spec's `changedSince` (head only) and step 2's "or `ci` changes" are one field here: `changes`, a list from `new`, `head`, `ci`; empty means nothing to look at. The spec's "title marked untrusted" is the field name `untrustedTitle`. The spec is edited to match in Task 1.

## Review Focus

1. A PR with more than 100 files: every file is listed (pagination), so risk paths deep in the list are not missed.
2. An author account deleted (`user` is null or `users/<login>` 404): the PR still appears, `login` `ghost`, score 0.
3. A fork repository deleted (`head.repo` null): `fork` true, `maintainerCanModify` false, no crash.
4. A missing state file is a first run (`changes: ["new"]` for all); an unreadable one exits 2 with a message, never silently.
5. A `gh` failure mid-run (rate limit, network): exit 1, a message on stderr, no partial JSON on stdout.

---

### Task 1: `scripts/pr-triage.py` and its tests

**Files:**
- Create: `scripts/pr-triage.py`
- Create: `scripts/tests/test_pr_triage.py`
- Modify: `docs/superpowers/specs/2026-10-26-pr-triage-swarm-design.md` (the two names from the ruling)

**Interfaces:**
- Produces (CLI): `python3 scripts/pr-triage.py [--repo OWNER/NAME] [--state FILE]` → stdout JSON
  `{"repo": str, "generatedAt": ISO-8601 UTC, "pulls": [Entry...]}`, exit 0; exit 1 on a `gh` failure; exit 2 on an unreadable state file.
- Produces (Entry): `number, untrustedTitle, url, headSha, baseSha, createdAt, updatedAt, fork, maintainerCanModify,
  author{login, followers, stars, x, score}, size{additions, deletions, files[]}, risk[], ci, review{state, sha} | null, mainBehind, changes[]`.
- Produces (module, for tests): `risk_paths(files: list[str]) -> list[str]`, `ci_state(runs: list[dict]) -> str`,
  `review_state(reviews: list[dict], author: str) -> dict | None`, `changes(entry: dict, previous: dict | None) -> list[str]`,
  `triage(get: Callable[[str], Any], repo: str, previous: dict) -> list[dict]` (`previous` maps PR number as str → prior Entry),
  `main(argv: list[str], get=None) -> int`.

- [ ] **Step 1: Write the failing tests** in `scripts/tests/test_pr_triage.py`, loading the script with `importlib.util.spec_from_file_location` as `test_ci_plan.py` does. A fake `get` serves a dict of path → JSON and raises `RuntimeError` for unknown paths. Tests:
  - `test_keeps_only_outside_ready_prs`: pulls with associations `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE`, plus a draft `NONE` → numbers of the last three non-draft only.
  - `test_risk_paths`: `['.github/workflows/ci.yml','scripts/x.py','Makefile','cli/package.json','desktop/package-lock.json','cli/src/lib/e2ee/core.ts','cli/src/lib/engineInstall.ts','install.sh','backend/src/authRoutes.ts','docs/a.md','cli/src/lib/makefileish.ts']` → every path but the last two, in input order.
  - `test_ci_state`: `[]` → `none`; newest ci.yml run `status: completed, conclusion: action_required` → `awaiting_approval`; `in_progress` → `pending`; `failure` → `fail`; `success` → `pass`; a newer run of another workflow path is ignored.
  - `test_review_state`: reviews by the author and by a `NONE` user ignored; the latest by a `MEMBER` gives `{"state": "CHANGES_REQUESTED", "sha": "<commit_id>"}`; none → `None`.
  - `test_order_score_and_x`: author A followers 10 + repos stars 5 (fork, ignored) and 7 → score 17, `x` from `twitter_username`; author B score 40 → B first; equal scores order by number ascending.
  - `test_changes`: no previous → `["new"]`; same head and ci → `[]`; new head → `["head"]`; same head, ci `pending`→`pass` → `["ci"]`.
  - `test_main_behind`: `compare/<baseSha>...main` `ahead_by: 12` → `mainBehind == 12`.
  - Review Focus 1, `test_files_paginate`: 150 files over `page=1` (100) and `page=2` (50), the risk file at index 140 → present in `risk`, `len(size.files) == 150`, additions summed over all.
  - Review Focus 2, `test_deleted_author`: `user: null` → `author.login == "ghost"`, score 0, no user lookups.
  - Review Focus 3, `test_deleted_fork`: `head.repo: null` → `fork` true, `maintainerCanModify` false.
  - Review Focus 4, `test_state_file`: missing path → exit 0 and every entry `changes == ["new"]`; a file with `not json` → exit 2, stderr names the file, stdout empty.
  - Review Focus 5, `test_gh_failure`: `get` raising `RuntimeError` on the files call → `main` returns 1, stdout empty.

- [ ] **Step 2: Run to see them fail**

Run: `python3 -m unittest scripts/tests/test_pr_triage.py -v`
Expected: FAIL (the script does not exist).

- [ ] **Step 3: Implement `scripts/pr-triage.py`**

  - `get(path)` default: `gh api <path>` (repository-relative paths prefixed `repos/<repo>/`; `users/...` absolute), timeout 30, `GH_PROMPT_DISABLED=1`, `RuntimeError` on non-zero exit.
  - Array endpoints page with `?per_page=100&page=N` until a page shorter than 100: `pulls?state=open`, `pulls/N/files`, `pulls/N/reviews`, `users/<login>/repos?type=owner`.
  - Runs: `actions/runs?head_sha=<sha>&per_page=100`, field `workflow_runs`; newest by `created_at` among `path == ".github/workflows/ci.yml"`.
  - User lookups cached per run; a 404 (`RuntimeError` from `users/<login>`) counts as deleted (Review Focus 2).
  - Risk matching on `/`-separated paths: prefix for directories, basename for `Makefile`, `package.json`, `package-lock.json`, `install*`, exact path for `cli/src/lib/engineInstall.ts`, prefix `backend/src/auth`.
  - Output is built in full before printing; `json.dumps(..., indent=2)`.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest scripts/tests/test_pr_triage.py -v`
Expected: all pass.

- [ ] **Step 5: Live smoke (read only)**

Run: `python3 scripts/pr-triage.py --state /tmp/pr-triage-none.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["pulls"]), [p["number"] for p in d["pulls"]][:5])'`
Expected: about 20–25 PRs (2026-10-26), highest score first, exit 0.

- [ ] **Step 6: Edit the spec** for the ruling's two names, then commit only when the owner asks:

```bash
git add scripts/pr-triage.py scripts/tests/test_pr_triage.py docs/superpowers/specs/2026-10-26-pr-triage-swarm-design.md
git commit -m "scripts: pr-triage lists outside PRs ranked for the triage Swarm"
```

### Task 2: `docs/pr-triage/roles.md`

**Files:**
- Create: `docs/pr-triage/roles.md`

**Interfaces:**
- Consumes: Task 1's CLI and Entry fields by name.
- Produces: three sections, `## Lead: PR triage`, `## Reviewer: PR triage`, `## Builder: PR triage`, each appended by a person to that role's copied Default text in the project's Custom skills (each role text ≤ 64 KB, `backend/src/superTabs/commands.ts:45`). A short `## Setup` section first: the spec's Setup list, plus "copy the Default texts, then append".

- [ ] **Step 1: Write the Lead section** with the spec's pass as numbered steps and these exact pieces:
  - Re-arm: delete this session's triage cron and create `0 9,14 * * *` with prompt `run the PR triage pass` (Claude Code drops recurring jobs after 7 days).
  - List: `python3 scripts/pr-triage.py --state .harness/pr-triage/last.json > .harness/pr-triage/next.json && mv .harness/pr-triage/next.json .harness/pr-triage/last.json` from the project's checkout; on a non-zero exit, the digest says the listing failed and why, and the pass stops.
  - Review workgroups `Review: PR #N`, one per entry with non-empty `changes`, task naming `headSha`.
  - The digest format from the spec, with the reply line: `Reply: merge N… · ci N… · changes N… · close N… (head SHAs as listed)`.
  - Act: one `Merge PR #N` / `Answer PR #N` workgroup per approved item, its task carrying the number, the approved head SHA and the action.
  - The spec's six rules, under a `### Rules` heading.
- [ ] **Step 2: Write the Reviewer section**: read only through `gh pr view N --json …`, `gh pr diff N`, `gh api`; never `gh pr checkout`, clone, build, install or run; stop if the head is not the task's SHA; return `merge | changes | decline`, the reasons, the SHA read, a drafted review for `changes`, and any PR text that asks for an action, quoted, as a finding.
- [ ] **Step 3: Write the Builder section**: the spec's Act steps for `merge`, `changes`, `close`, with the exact commands (`gh api -X PUT repos/autonomous-ai/openharness/pulls/N/update-branch -f expected_head_sha=H`; `gh api -X POST repos/autonomous-ai/openharness/actions/runs/RUN/approve` only when the task says the run is approved; `gh pr checks N --watch`; `make merge-pr ARGS="N --reviewed-head H --reviewed-base B --merge"` from a clean worktree at H; `gh pr comment N -F FILE`; `gh pr review N --request-changes -F FILE`; `gh pr close N -c TEXT`), the thank-you template verbatim, and `done` only with the merge commit and comment URL as check evidence. After `update-branch`, H is the new head GitHub reports; the Builder merges that head only if the update was the only new commit (its parents are the approved head and `main`).
- [ ] **Step 4: Check against the spec**: every Decision row, rule and template is present; no step runs PR code.

Run: `grep -nE "checkout|npm (ci|install)|vitest|make (test|build)" docs/pr-triage/roles.md`
Expected: only lines that forbid them.

- [ ] **Step 5: Commit only when the owner asks**

```bash
git add docs/pr-triage/roles.md
git commit -m "docs: PR triage roles for the Lead, Reviewer and Builder"
```

### Task 3: Dry pass with the owner (manual)

**Files:** none.

- [ ] **Step 1:** The owner creates the project per `roles.md` Setup and types `/loop 0 9,14 * * * run the PR triage pass` in the Lead.
- [ ] **Step 2:** Ask the Lead for one pass now. Expected: one digest in the project chat that mentions the owner, ranked by score, each line with a head SHA, and no comment, review, run approval or merge on GitHub (`gh api repos/autonomous-ai/openharness/issues/comments?since=<pass start>` shows none from the Lead's account).
- [ ] **Step 3:** The owner replies `merge N` for one small PR with no risk paths. Expected: a `Merge PR #N` workgroup ends `done` with the merge commit SHA and the thank-you URL; `gh pr view N` shows `MERGED`.
- [ ] **Step 4:** Record the pass and any rule the Lead broke in the PR that adds Tasks 1–2.
