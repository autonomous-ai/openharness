# WIP #1612: Codex Ctrl+Z under bash times out on the Linux e2e runner

Work-in-progress checkpoint. Not for merge: this folder is a reproduction kit and notes, to be removed
before a PR.

## Root cause (reproduced locally, runner artifacts agree)

- The `ubuntu-latest` runner is now **Ubuntu 26.04**: bash 5.3, tmux 3.6, Rust coreutils. The earlier
  Docker triage used bash 5.2 images.
- **bash 5.3 no longer prints `[1]+ Stopped …` when a foreground job stops in a script that `bash -ic`
  runs.** It holds the notice back for the next prompt. An agent's pane never shows a prompt, because
  `harness_resume`'s `fg` (cli/src/lib/engineLaunch.ts `STOP_PROOF_FUNCTIONS`) continues the job first.
  bash 5.2.21 and macOS bash 3.2.57 print the notice right away. `jobs` in bash 5.3 still lists the job
  as Stopped (`notice.sh`, `variants.sh`).
- The stop itself works under bash 5.3. The fake Codex reads `^Z`, calls `kill(0, SIGTSTP)`, and its
  one-time SIGCONT handler fires about 5 ms later from `harness_resume`'s `fg`. The engine then
  repaints (`diag5.py`, a trace inside the fake engine). The pane output after Ctrl+Z is only
  `ESC[?2004l` and the repaint, with no "stopped" or "suspended" (`diag6.py`).
- `e2e/suspend.e2e.ts:126` waits for `/suspended|stopped/` in the pane output. Under zsh, zsh prints
  `suspended`. The Claude fake prints "Claude Code has been suspended". Under dash (the tcsh hand-off),
  dash prints `Stopped`. The Codex fake prints nothing of its own, as real Codex prints nothing. So only
  codex + bash 5.3 fails.
- Side finding: this spec's `onTestFailed` dumps run after `afterEach` has closed the daemon. That is
  why the runner log says the tmux socket is missing, and the pane capture and pipe-pane output are
  lost on failure.

## Proposed fix (not yet made)

Product, cli/src/lib/engineLaunch.ts `STOP_PROOF_FUNCTIONS`: under bash only (`BASH_VERSION`), report a
stopped job that bash has not reported yet before resuming it: `jobs -n %%`. Measured
(`jobsn.sh`): it prints the `Stopped` line exactly once on bash 5.3.9, 5.2.21 and 3.2.57. On 5.3 it
supplies the line; on the others bash already printed it, so it prints nothing. zsh and dash are not
touched (dash has no `jobs -n`). The e2e assertion and its 15 s timeout stay as they are.

Steps:

1. Write a failing test in `src/lib/engineStop.real.spec.ts` (`npm run test:tmux-real`): under bash,
   the pane reports the stopped job after Ctrl+Z. It fails on bash 5.3 (use the container).
2. Change the code, then update the launch goldens (`src/engines/__fixtures__/*launch*.golden.json`,
   `engines/launchArgv.golden.spec.ts`).
3. Run the unit suite, `test:tmux-real` on macOS and in the 26.04 container, and `e2e/suspend.e2e.ts`
   in the container and on macOS.
4. Run the CLI end-to-end workflow once on the branch. It has no shard or spec input, so it runs all 8
   shards. Record the run link in #1612, then open a PR and wait for ci/required.

## Container

    docker build -t suspend-u2604 -f wip-1612/Dockerfile.ubuntu2604 wip-1612   # arm64 Node; use linux-x64 on Intel
    docker run -d --name suspend-repro --init -v "$PWD":/src:ro suspend-u2604 sleep infinity
    docker exec suspend-repro bash -c 'mkdir -p ~/cli && cd /src/cli && tar --exclude=./node_modules -cf - . | tar -xf - -C ~/cli && cd ~/cli && npm ci'
    docker exec suspend-repro bash -c 'cd ~/cli && SHELL=/bin/zsh npx vitest run --config vitest.e2e.config.ts e2e/suspend.e2e.ts -t "codex under /bin/bash: Ctrl"'

Runner evidence: https://github.com/autonomous-ai/openharness/actions/runs/39914133336/job/120283697525
(the artifact `cli-e2e-daemon-logs-3` pane dump shows Codex still running after Ctrl+Z).
