# CLI Super Tab path fixtures are data (#4253): Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. One task, one commit: the code (see "Red and
> green" for why there is no red commit). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `scripts/ci-plan.py` declares the repository paths three CLI Super Tab specs hold as test data, so the
cross-read scan reports nothing for `cli` on a full checkout and the merge helper stops refusing to reuse the `cli`
suite because of them.

**Architecture:** One table changes: `NOT_READS` in `scripts/ci-plan.py`. `undeclared_reads` already skips a path
named from the repository root when the source's data entries cover it, so no function changes.

**Tech Stack:** Python 3 standard library, `unittest`, git. No new dependency.

**Spec:** [docs/plans/2026-11-13-4253-cross-read-fixtures-design.md](2026-11-13-4253-cross-read-fixtures-design.md).
Read it with this plan and the root `AGENTS.md`. The spec is the authority.

## Global Constraints

- Only `scripts/ci-plan.py` changes, and in it only `NOT_READS`: one line changed, two added.
- `DEPENDS` and `PR_READS` do not change. The three specs do not change. No test file changes.
- Folders as the spec names them, no wider: `backend/src/superTabs/` (not `backend/`) and `docs/`.
- Platforms: none of the product's. A CI planner table, read by `process-checks` on Linux and by `make merge-pr`.

## Found while reading the code

Checked at `d80ed139fc`:

- **Shape.** `NOT_READS` is `{source: (why, {path the scan reports, or a folder "dir/" covering it})}`
  (`ci-plan.py:198-201`).
- **A data folder covers the file under it.** For a path named from the repository root the scan skips the target
  when `any(covers(entry, known) for entry in data)` (`ci-plan.py:647`); `covers` is
  `path == entry or (entry.endswith("/") and path.startswith(entry))` (`ci-plan.py:311`). So `backend/src/superTabs/`
  covers both the folder and `commands.ts`. A relative read never consults a data folder and stays reported.
- **All four reported pairs are root-named strings:** `githubMerge.spec.ts:1178, 1240`, `plainPath.spec.ts:7`,
  `pmNumbers.spec.ts:179, 731, 758`. With the entries below set in memory, `undeclared_reads(root, "cli")` returns
  `[]` against `DEPENDS` and against `PR_READS`.
- **PR CI cannot show this test red or green.** A change to `scripts/ci-plan.py` selects no suite, and
  `process-checks` runs the scripts tests in a sparse checkout, where this test skips.
- **Baseline on a full checkout (macOS).** `scripts/tests`: 474 tests, one failure (this test), no skip, about
  4 minutes. `scripts.tests.test_ci_plan`: 97 tests, about 1 minute.

## Red and green

The failing test is already on main and this branch does not touch it, so a separate red commit is not possible: there
is nothing to commit before the code. The code commit alone carries the change, and the pull request body carries the
proof: the test's output at base (red) and at the code commit (green), both from a full checkout, each with the commit
it ran on. A reviewer reproduces the red with the same command on `origin/main`.

## Review Focus

No test is added (the spec fixes the files). Each line names the test that already pins it, or what to check by eye.

- A real read hidden by a data folder: a root-named path under `backend/src/superTabs/` or `docs/` in these three
  specs now counts as data. None opens a repository file today:
  `grep -nE "readFile|readdir|existsSync|import\.meta\.url|__dirname" cli/src/superTabs/{githubMerge,plainPath,pmNumbers}.spec.ts`
  shows only `pmNumbers.spec.ts` reading `t.file`, its own file under `mkdtempSync(join(tmpdir(), 'pm-numbers-'))`.
- A relative read from these specs is still reported:
  `test_a_data_folder_covers_the_paths_under_it_but_never_a_relative_read`.
- The selection scan (`inputs=planner.PR_READS`) is clean too, for every suite: the repository test asserts both.
- Each new entry has a reason and targets: `test_strings_that_are_only_data_are_listed_with_a_reason`.

---

### Task 1: Declare the three specs' path fixtures as data

**Depends on:** nothing. **Effort:** medium (mechanical, one file).

**Files:**
- Modify: `scripts/ci-plan.py` (`NOT_READS`, lines 201-266)
- Test (unchanged, must fail before the change): `scripts/tests/test_ci_plan.py`
  `CrossReadTests.test_every_cross_read_in_this_repository_is_declared`

- [ ] **Step 1: Run the test at base and keep the red output**

Before any edit (`git status --short scripts/` prints nothing, and `HEAD` is the branch's base, `d80ed139fc` today),
from the repository root of a full checkout:

```bash
git rev-parse HEAD
python3 -m unittest scripts.tests.test_ci_plan.CrossReadTests.test_every_cross_read_in_this_repository_is_declared
```

Expected (about 12 s): `FAILED (failures=1)`, in the subtest `(suite='cli')`, with exactly these four pairs:

```
('cli/src/superTabs/githubMerge.spec.ts', 'backend/src/superTabs/')
('cli/src/superTabs/githubMerge.spec.ts', 'backend/src/superTabs/commands.ts')
('cli/src/superTabs/plainPath.spec.ts', 'docs/')
('cli/src/superTabs/pmNumbers.spec.ts', 'backend/src/superTabs/commands.ts')
```

`OK (skipped=1)` means the checkout is sparse: use a full one. Any other list means main moved past the spec: stop
and report the list; declare nothing the spec does not name.

- [ ] **Step 2: Edit `NOT_READS` in `scripts/ci-plan.py`**

Change the existing entry (line 203; the comment line above it stays):

```python
    "cli/src/superTabs/githubMerge.spec.ts": ("test data: a pull request's file paths", {"backend/src/superTabs/", "docs/"}),
```

Add two entries between the `cli/src/superTabs/githubTrain.spec.ts` (line 243) and
`cli/src/superTabs/scoreboard.spec.ts` (line 244) entries, where the single entries run in source order:

```python
    "cli/src/superTabs/plainPath.spec.ts": ("test data: a path to make plain", {"docs/"}),
    "cli/src/superTabs/pmNumbers.spec.ts": ("test data: a hot file's name", {"backend/src/superTabs/"}),
```

No new comment: each reason string says why.

- [ ] **Step 3: Run the same test and keep the green output**

The command of Step 1. Expected: `Ran 1 test` and `OK`, with no `skipped`.

- [ ] **Step 4: Run the cross-read tests**

Run `python3 -m unittest scripts.tests.test_ci_plan.CrossReadTests`. Expected (about 15 s): `Ran 10 tests` and `OK`,
with no `skipped`. The planner's whole test file and the `scripts/tests` suite run once, in Verification.

- [ ] **Step 5: Check the diff, then commit**

`git diff --stat` shows `scripts/ci-plan.py | 4 +++-` and no other tracked file.

```bash
git add scripts/ci-plan.py
git commit -m "CI: the paths three CLI Super Tab specs hold are test data, not cross-reads (#4253)"
```

Report the commit, and the red (Step 1) and green (Step 3) outputs with the commit each ran on.

---

## Verification

Nothing here needs a backend, an account, a device, a port or a state directory: the checks read the working tree and
build throwaway git repositories in the system's temporary folder. All run on the final head, on the Mac, from the
repository root of a full (not sparse) checkout of the branch. None touches production.

1. **The cross-read scan on the real tree** (the spec's first "Done when"). Run
   `python3 -m unittest -v scripts.tests.test_ci_plan`. A person sees
   `test_every_cross_read_in_this_repository_is_declared ... ok` (not `skipped`), `Ran 97 tests` and a final `OK` with
   no `skipped`, in about 1 minute. This is the `undeclared_reads` call the merge helper makes before it accepts a
   reused suite (`ci-plan.py:690`), so a clean scan here is what stops the refusal. Local only: it needs a full
   checkout and no workflow has one (`process-checks` is sparse and skips this test). At a minute it gets no temporary
   workflow.
2. **The whole `scripts/tests` suite** (the spec's second "Done when"). Run it once as CI does, on the full checkout:
   `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false python3 -m unittest discover -s scripts/tests -p 'test_*.py'`.
   A person sees a final `OK` in about 4 minutes; the base's one failure was this issue's test, so any failure is new.
   On GitHub the same command runs by itself on the push, in the `process-checks` job of `ci.yml` (step "Validation
   deadlines, cleanup, receipts and release version guards"), sparse, so the full-checkout tests skip there; that run
   is the Linux evidence. By hand it is `ci.yml` with scope `process`, which the push makes unnecessary: start no
   manual run beside the automatic one.
3. **Required local checks.** Run `python3 scripts/local-checks.py --list scripts/ci-plan.py`. A person sees `{}`: this
   path needs no local receipt, so the pull request body carries no `harness-local-checks` fence.

No end-to-end check beyond these: nothing ships to a client, the backend or a device, and the helper's refusal path
is pinned by `test_an_undeclared_read_of_a_file_main_changed_is_refused` plus check 1 on the real tree.
