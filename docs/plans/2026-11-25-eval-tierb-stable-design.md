# Dial eval: a stable tier B baseline

Status: approved by the PM (2026-11-25). Branch `fix/eval-tierb-stable`.

## Goal

Two full `npm run eval:dial-apps -- --update-baseline` runs on the same `main` commit write the same `baseline.json`.
Today they do not, so pull requests regenerate tier A alone (`--tier a`).

## What the runs show

Seven saved full runs on 25/11 (`/tmp/dial-eval-vscode-v12-full4..7`, `dial-eval-final.*`, `dial-eval-orca-win-held-4/5`)
and the six IH4-alone runs (`/tmp/dial-eval-ih4-{A,B}-run{1,2,3}`), compared key by key (held-out: key names and
scores only):

| Key | Kind | What moved |
|---|---|---|
| `b/darwin/I17/needsYou.latency`, `C7`, `O8` | timed | 1 ↔ 0.5. Measured 560-760 ms on a quiet run, 1021 and 1038 ms on two runs: the half mark is 1000 ms (`THRESHOLDS.needsYou`). |
| `b/darwin` app score of iTerm2 | from the above | 99.3 ↔ 98.5 follows I17's latency exactly (and I14 once, below). |
| `b/darwin/IH4/wait.4` | timed (a condition wait) | 0 in 3 of 6 IH4-alone runs and in 2 of 4 full runs. |
| `b/darwin/IH4/ring.recall/precision/order` | pass/fail | 0 in 1 of 7 full runs (wait.4 held in that run); 6 of 6 alone. |
| `b/darwin/I14/ringHerdr.*`, `ringKeptHerdr` | pass/fail | 0 in 1 of 7 full runs: the devices turned the shown page from herdr to iTerm2 on their own 2 s after herdr's rows came back (`apps at 12388 on iterm`), with no pick. That run (full4, 02:43) predates #4599 (12:48), which fixed an I14 `ringHerdr` race; none of the six runs after it failed. |

Tier A moved only where a pull request changed the code between runs (V12, O6).

## Causes

1. **Timed results are written into the baseline.** `updateBaseline` (grade.ts) stores every result, timed ones too,
   and the baseline's app scores (`subsetScores`) count them. A timed tier B part is graded 1, 0.5 or 0 at fixed marks
   on the host's wall clock, and needs-you's path (the fake engine's PermissionRequest hook, a Node process, then the
   daemon, the devices and the dial) sits at 55-75% of its 1 s mark on a quiet Mac. Any load moves it over. The design
   already says these "depend on the runner" and `tierBVerdict` ignores them, but the baseline still holds them: the
   one file meant to be stable carries the one kind of result that is not.
2. **Condition waits are timed too** (`wait.<i>`, runner.ts), and stored the same way. IH4's step 4 waits on something
   the product shows late about half the time, alone or not.
3. **Two pass/fail flakes, about 1 run in 7 each** (IH4's ring, I14's herdr ring). Not explained yet. I14's evidence
   points at the product (a page change after herdr restarts, a list tick racing the rows' return), not at the eval;
   IH4's needs its evidence lines, which this branch has not read (held out). Candidates still open: devices state
   kept in memory across scenarios on a shared daemon (a reset empties files, never the devices process), and a
   wait that ran out letting the next step run early.

Ruled out from the code and the runs: files running in parallel (vitest.e2e.config.ts runs one file at a time), port
reuse (each daemon and fake backend takes its own), state folders (each daemon has its own root; the reset empties
the stores).

## Design

### 1. Tier B's timed results are measures, kept out of the baseline (fixes causes 1 and 2)

- `updateBaseline` writes no tier B result whose `timed` is true: latencies, `cost.cpu`, `cost.loopP99`, `wait.<i>`.
  Tier A keeps its timed results: its clock is the model's and its baseline is exact.
- The baseline's tier B app scores, and the report's delta of them, are computed over tier B's untimed results only,
  so a latency cannot move them.
- `droppedKeys` lets go of a tier B timed key, which an update no longer writes.
- The report keeps every timed result with its `ms`: the failing list and the groups still name a slow path, as now.
- The headline score (`report.apps`, `byTier`, `byPlatform`) keeps tier B's timed results, unchanged (PM, 2026-11-25):
  only the baseline and its delta leave them out. The pull request says so.

One rule, already in the design: timed tier B results depend on the runner, so nothing held or committed is made of
them. No new threshold, no retry, no clock of the eval's own.

### 2. The pass/fail flakes (cause 3): diagnose, then fix by cause

On one PM turn: the iTerm2 file, three times (about 40 minutes with its reruns), with `E2E_ARTIFACTS_DIR` keeping
every daemon log, and the devices' log lines of I14 read. IH4 is out of this branch (PM, 2026-11-25): its author has seen
part of the held-out set, so it reads no IH4 evidence and changes nothing held out; IH4's ring flake is counted, by key
name, and handed to the PM, who gives it to someone who has not.

- A cause in the eval (state left from an earlier scenario): the reset ends it. The likely form is a fresh devices
  process at each reset (the driver already restarts it in `restartDevices`), measured for its cost per scenario
  first; a fresh daemon per scenario only if that is not enough.
- A cause in the product (a race the run's timing decides): a product fix in a pull request of its own, proposed to
  the PM; this branch does not hide it (no new `RACED_B` key, which would still leave the baseline moving).

### The test that fails first

`grade.spec.ts`, `updateBaseline`: two runs that differ only in a tier B timed result (a needs-you latency of 0.5 and of
1, and a `wait.4` of 0 and 1) give the same baseline, checks and app scores; a tier A timed result is still written.
It fails today: the second baseline holds the other latency and another iTerm2 score.

A second red test per fix of cause 3, at the layer of that cause.

### Proof

On the branch head (main plus this fix), two full `npm run eval:dial-apps -- --update-baseline` runs in a row on a
PM turn (`TMPDIR=/tmp`, `caffeinate -i`, about 50 minutes each): the second leaves `baseline.json` unchanged
(`git diff --exit-code`). The first run's baseline is the one committed, by the command, never by hand. IH4's ring,
pass/fail and out of this branch, can still move it about one run in seven: a proof run where it alone moves is
reported as that, by key name, and not counted against this fix.

## Decisions (PM, 2026-11-25)

1. Tier B's timed results stay in the headline score; only the baseline and its delta leave them out.
2. No IH4 evidence is read and nothing held out is changed here; IH4's ring flake goes to the PM by key name and count.
3. The diagnostic runs wait for the PM's Mac turn; the grader change (part 1) goes ahead before it.
