# `local-checks.py --run`: receipts written by the program

## Why

PR CI refuses a pull request whose paths need local checks (`scripts/local-checks.py`, step `process-checks`) unless
its body carries one `harness-local-checks` JSON fence with an exact-head receipt per check. Agents write that fence by
hand: read the PR template, run `--list`, run each command, copy the head and the passed count into JSON. In the last
four pull requests (#4201, #4225, #4229, #4239) the fence was missing or wrong every time, and each cost an extra CI
round.

Goal: an agent runs one command and pastes its output. No Harness PR fails CI for a missing or malformed receipt again.

Direction approved by Ken on 2026-11-13.

## What it does

`python3 scripts/local-checks.py --run [--base REF]`, from the repository root:

1. **Refuses a dirty tree.** Any line from `git status --porcelain` (staged, unstaged or untracked, ignored files
   excepted) exits non-zero before anything runs. HEAD is then the source under test.
2. **Picks the checks.** Changed paths come from `git diff --no-renames --name-only REF...HEAD`; `REF` defaults to
   `origin/main`. `--no-renames` matches CI (`changed_paths` in `scripts/ci-plan.py`): a moved file counts at both its
   old and new path. The script does not fetch. The checks are `required_checks(paths)`, the same function `--list` and CI use.
3. **No check required:** prints nothing on stdout, one line on stderr saying none is required, exits 0. The PR then
   carries no fence, as the template already says.
4. **Platform.** The receipt's platform is the running OS (`macos`, `linux`, `windows`, from `sys.platform`). A check
   whose contract names another platform (for example `cli-pty` on Linux) is not run: the script exits non-zero
   naming it and the platform it needs, before running any check.
5. **Runs each required check, in name order,** with its exact `CHECKS` command, through the shell, in its `cwd`
   relative to the repository root. Only `make desktop-test` gets a cap, one validation already accepts:
   `ARGS="--timeout 3600"`, the budget the docs give for a slower Mac; workers stay host-sized. Vitest checks run as
   `CHECKS` has them: every Vitest suite already sizes its workers to half the cores its run may use, the machine's or
   its Swarm agent's share (`cli/src/testing/suiteWorkers.ts`), and a `--maxWorkers` from `--run` would override that
   share. Checks run one at a time.
   The receipt's `command` is the exact command run, so it passes `validate_receipts`. The check's output streams to stderr as it runs, so stdout carries
   only the fence. Every check runs even after one fails, so one round shows every failure.
6. **Reads the passed count** from the output:
   - Vitest commands (every `cli-*` check): the summary line `Tests  N passed` (also `Tests  F failed | N passed`),
     with ANSI colour codes stripped.
   - `make desktop-test`: the `receipt.json` path on its last line (`passed: PATH` or
     `passed_after_startup_retry: PATH`), and that receipt's `coverage.passed`.
   A check passes only with exit code 0 and a count above 0. A check with no readable count fails, named.
7. **Checks the source did not move.** After all checks, HEAD must be unchanged and the tree still clean; otherwise
   every receipt is void and the script exits non-zero.
8. **Prints the fence.** On success, stdout is exactly one ` ```harness-local-checks ` fence holding a JSON list, one
   receipt per check in name order, each `{check, command, cwd, head, status: "passed", passed, platform}`, with the
   full 40-character HEAD. Before printing, the script passes the list through `validate_receipts({HEAD: checks},
   receipts)` itself; a refusal there is a bug and exits non-zero.
9. **On failure** exits 1 and prints on stderr one line per failed check: its name and why (exit code, no count,
   timeout). No fence is printed, not even a partial one.

Each check runs with a 65-minute limit, above the Desktop suite's own hour so that budget ends it first with its
receipt; on timeout the check fails as `timed out`. A check runs in a process group of its own, which the terminal's
signals never reach, so `--run` stops it at its limit and whenever `--run` itself is stopped (Ctrl+C, SIGTERM, a closed
terminal's SIGHUP): Ctrl+C to the group first, as a terminal would send it, so the check stops what it started in a
session of its own (`test-desktop.py`'s Flutter run), then a kill 10 s later, or at once on a second Ctrl+C or SIGTERM.
Windows has no Ctrl+C for another group, so there the tree is killed at once.
`--run` takes no paths: they always come from git, so the receipts match what CI computes.

Decided in the main session after the builder check (not by Ken): the Desktop budget in step 5, and `--no-renames` in
step 2. Evidence for the budget: 3 of 6 Desktop receipts raised the 900 s default. A Vitest worker cap was dropped in
the final review: the suites' own config already leaves half the cores, or half the agent's share, free.

## Constraints

- **CI never runs a command.** The validation path (`main()` without `--run`, as `ci.yml` calls it) is unchanged.
  `--run` executes only the fixed command strings in `CHECKS`; nothing from a PR body, a path or git output is ever
  run or put into a command.
- **No new dependencies.** Python standard library only, as today.
- **Errors carry no personal content.** Failure lines name the check and a fixed reason; check output goes to stderr
  as the tool printed it, never into the fence.
- Every platform the receipts allow: macOS, Linux, Windows (`shell=True` uses the platform shell; the commands with a
  `VAR=value` prefix are macOS-only).

## Changes

- `scripts/local-checks.py`: the `--run` mode above. The module docstring stops saying the program never runs
  commands: validation never runs them; `--run` runs only `CHECKS` commands, locally. `missing()`'s hint names
  `--run` instead of `--list`.
- `scripts/tests/test_local_checks.py`: tests for `--run`, committed failing first, then the code. They build a
  throwaway git repository with fake `CHECKS` entries (commands that print a Vitest summary, fail, print no count, or
  sleep), so no real suite runs. Cases: dirty tree refused (staged, unstaged, untracked); paths from `--base`; no
  required check prints nothing; the printed fence passes `check()` on a PR body at HEAD; failure names every failed
  check and prints no fence; no count fails; wrong platform refused before running; HEAD moved during a run voids it;
  the Desktop count read from its receipt; every Vitest command runs as `CHECKS` has it.
- `.github/pull_request_template.md`: the local-checks paragraph says: after testing the final commit, run
  `python3 scripts/local-checks.py --run` from a clean tree and paste its output into the body before pushing that
  commit or marking the PR ready. The hand-written JSON example and its field rules go. The note that body edits do
  not start another CI run stays.
- `docs/validation-and-release.md`: the "Checks PR CI does not run" bullet names `--run` as the way to run them and
  record them. The root `AGENTS.md` does not change: it already points at that doc.
- Not in the pull request: a temporary workflow, `.github/workflows/tmp-local-checks-run.yml`, runs
  `scripts/tests/test_local_checks.py` on `windows-latest` for pushes to the feature branch, and is removed before
  the pull request.

## Non-goals

- No flags for the Desktop budget: the program picks it (above). Validation keeps accepting hand-written receipts, but the
  template and docs describe only `--run`, the one way to make them.
- No fetching, no PR body editing, no `gh` calls: the agent pastes the fence.
- No change to which checks a path needs, to `ci-plan.py`, `ci.yml`, or the train.
- No product code.

## Left to the builder

- How output is streamed and how much of it is kept for parsing (bounded: the tail is enough).
- Argument parsing shape, as long as `--list` and the CI path behave as today.
