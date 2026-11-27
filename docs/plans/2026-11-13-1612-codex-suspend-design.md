# Codex Ctrl+Z under bash 5.3: prove the stop from the engine, not the shell's notice (#1612)

## Intent

The nightly CLI end-to-end workflow fails on main at `cli/e2e/suspend.e2e.ts:126`: "codex under /bin/bash:
Ctrl+Z and a SIGSTOP leave the agent there and working" times out after 15 s waiting for the engine to
suspend itself. A failing test is a bug; this fixes it at the layer where the defect lives, with no skip,
retry or longer deadline.

## Cause

- `ubuntu-latest` is Ubuntu 26.04, with bash 5.3. bash 5.3 holds back the `[1]+ Stopped …` notice for a
  foreground job that stops inside a `bash -ic` script until its next prompt. bash 5.2 and macOS's bash
  3.2 print it at once.
- An agent's pane never reaches that prompt: the launch script's `harness_resume`
  (`cli/src/lib/engineLaunch.ts`, `STOP_PROOF_FUNCTIONS`) continues the stopped job with `fg` about 5 ms
  after the stop.
- The test proves the stop by waiting for `suspended|stopped` in the pane's output. That text comes from
  zsh, from Claude Code's own message, or from an older bash. Codex, the real CLI and the fake, prints
  nothing on Ctrl+Z, so only Codex under bash 5.3 fails.
- The product works: the engine stops on Ctrl+Z and the launch script continues it (trace in the issue;
  PR #1664's printed notice made all 12 cases pass on the runner).

So the defect is the test's proof, which depends on a shell's incidental output that bash 5.3 no longer
gives.

## Goals

- The Ctrl+Z case proves, under every shell and bash version, that the engine really stopped itself and
  that the launch script continued it.
- The test stays as strict as before or stricter: same 15 s deadline, same later checks.

## Non-goals and anti-goals

- No product change: Harness prints nothing new to users to imitate an older bash (PR #1664's approach,
  rejected).
- Not polling the process state for `T`: the engine is stopped for about 5 ms before `fg` continues it,
  so a 100 ms poll misses it; that would be a flaky test.
- The failure dumps that run after `afterEach` closed the daemon ("tmux socket missing") stay out of
  scope; noted in the final report.

## Approaches

- **A, chosen: the fake engine records its own stop and its continue.** In `suspend()`
  (`cli/e2e/harness/fakeEngine.mjs`), before `process.kill(0, 'SIGTSTP')`, it appends a `stopped` line to
  a file in the test root (`config.root`, as `launch-argv` is), and its one-time SIGCONT handler appends
  `continued`. Only `fg` from the launch script sends that SIGCONT (tmux continues only the pane's own
  process), so a `continued` after a `stopped` proves both the real stop and the launch script's resume.
  The test waits for that record in place of the pane text. Strictly stronger, shell-independent, no
  product change.
- **B, rejected: print the notice from the product** (`jobs -n %%` under bash, PR #1664). It adds a line
  every bash user sees only so a test can read it, and changes four launch goldens.
- **C, rejected: wait for process state `T`.** Racy, as above.

## Design

- `fakeEngine.mjs`: `suspend()` notes `stopped` before the SIGTSTP and `continued` in its one-time SIGCONT
  handler, each a line in one file under `config.root` (name left to the builder, e.g. `suspends`), with
  the engine's pid. Writing never fails the engine (as the existing notes do).
- `suspend.e2e.ts`: after sending `C-z`, wait (15 s, as now) for the record to show the engine stopped and
  was continued; drop the `suspended|stopped` pane regex. Keep the pane capture (`pipe-pane`) and the
  Claude Code message check, which is Claude's real behavior. The header and step comments say what the
  proof is now.
- Every other step of the test is unchanged.

## Verification

- Locally on macOS: the suspend spec passes (all 12 cases), and the new wait fails before the fake writes
  the record (red), passes after (green).
- On the Linux runner (`ubuntu-latest`, bash 5.3): the CLI end-to-end workflow's `workflow_dispatch` runs
  every shard and has no single-spec input, so a temporary workflow `.github/workflows/tmp-1612-codex-suspend.yml`
  (push to this branch only, `contents: read`, no secrets) runs only `e2e/suspend.e2e.ts` with the e2e
  shard job's setup. Started only after the orchestrator's go; all 12 cases, including Codex under
  `/bin/bash`, pass. The file is removed before the PR opens.

## Left to the builder

The record file's name and line format, and the helper that reads it in the test.
