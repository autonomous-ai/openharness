# Small fixes batch 2026-11-25: design

## Intent

A Windows user's daemon log (2026-11-19 to 11-24, CLI 0.6.73 to 0.6.86) shows Harness failing quietly on Windows in
several places, and the dial ringing for nothing. Each item below was checked on `main` at `3d72dc8c68`: all nine still
apply. They ship as one pull request, each behavior change with a test that fails first.

The log is a customer's file. Nothing from it (paths, names, prompts, text) goes into code, tests, commits or the pull
request; only our own fixed log words and counts are quoted.

## Goals

1. **Windows DSH viewers start.** `autonomous/harness-monitor`'s viewer exits 1 right after an agent attaches and
   loops (`[dsh] autonomous/harness-monitor viewer exited 1 · restarting in …ms`, 56 exits, 14 `giving up`). Each exit
   follows one printed line of 124 chars.
2. **One ring per question; none for a gone agent.** `[cable] notify · alert · rule:question · question` was logged
   62 times, about once a minute for an hour, for one dialog.
3. **Windows one-shot workers start.** `[router-pool] claude warm spawn failed (…): ENOENT` (63 times): the voice
   router never has a warm worker on Windows.
4. **Process repair runs on Windows.** `bind.ts` reads a start marker with `Date.parse`, which is NaN for a Windows
   `w:<FILETIME>` marker, so the repair and the session-claim comparison never run there.
5. **Held rows saved by 0.6.86 or older are not stuck forever.**
6. **No log noise from a machine without Orca.** `[observed] orca homes · not read · no orca` was logged 1059 times.
7. **The silent-card rule has one source.**
8. **#4620 has an end-to-end case.**
9. **PR CI runs `e2e/dialWindowsTools.e2e.ts` when a module the Windows desk imports changes.**

## Non-goals

- Why the dialog's fingerprint drifts each minute on that machine (item 2). The pane's text is the customer's and is
  not in the log; the fix makes the ring rule hold whatever the cause.
- Hook admission, resume binding and BOM reading: another branch (`fix/win-hook-admission`) is changing them.
- New workflows, settings or switches.

## Constraints

- `cli/src/core/` files: `npm run test:core` at 100% per file (AGENTS.md).
- Items 4 and 5 touch files `fix/win-hook-admission` also changes (`cli/src/core/agents/bind.ts`,
  `cli/src/core/agents/hermesTerminal.ts`, `cli/src/lib/restoreAgents.ts`): they are done after that pull request
  merges, on a rebased branch (orchestrator's decision).
- Platforms: macOS, Linux, Windows. Windows code is tested on Windows CI (`windows-e2e`, selected by path) and, for
  items 1 and 3, on the Windows VM after the orchestrator gives the turn.
- Windows rules: [docs/windows-rules.md](../windows-rules.md). Windows programs start through
  `cli/src/lib/windows/program.ts` (`windowsProgram`), never cmd.exe.

## The items

### 1. Windows viewer: `harness_node` reads a Windows `current-node`

**Cause (reproduced on macOS with stubs).** `viewer.sh` runs `set -euo pipefail`, sources `toolchain/runtimes.sh`
and calls `harness_node 22`. On Windows `current-node` holds `C:\Users\…\.harness\runtime\node-v…-win-x64\node.exe`
and a CRLF (written by `cli/scripts/install.ps1` and `cli/src/lib/selfUpdate.ts`). When the node on PATH is older
than 22, `harness_node` (`store/tools/runtimes.sh:100-118`) takes `${recorded%/*}`, which strips nothing from a
backslash path, tests `-x ".../node"`, fails, and prints
`miss node >= 22, and Harness's own Node is not in $HARNESS_RUNTIME — run \`harness start\` once to lay it down`
(92 chars plus the 32-char Git Bash runtime path: 124). `set -e` exits 1. `dsh/shell.ts` adds Harness's Node to PATH
only when PATH has no node at all, so a machine with an old Node of its own hits this.

**Fix.** In `store/tools/runtimes.sh` (the one hand-written copy), `harness_node` reads `current-node` as Windows
writes it: drop a trailing CR, turn a drive-letter path into a Git Bash path (`cygpath -u` where it exists), and take
the folder of the file it names, `node` or `node.exe`. The "already Harness's own" comparison (line 107) reads it the
same way. `node store/tools/sync-runtimes.mjs` rewrites every package's copy; `cli/src/dsh/store.spec.ts` fails on
drift. Every package that calls `harness_node` (18 viewers, setups and doctors) is fixed by the same change.

**Tests.** Red first on PR CI: a CLI spec runs `harness_node 22` from `store/tools/runtimes.sh` under bash with a
Windows `uname`, a node older than 22 on PATH, a CRLF backslash `current-node` and a `cygpath` stand-in: today it
exits 1 with the miss line; after the fix it exits 0 with Harness's Node first on PATH. Where it runs on Windows CI
(a real Git Bash), the builder decides whether an existing Windows spec can carry the same case.

### 2. One ring per question, none for a gone agent

**Cause.** The core's pane watcher (`cli/src/lib/questionController.ts`, `QuestionWatcher`) found the same 18-char
question on one session's pane every minute with a different fingerprint, so it announced it again under a new
`requestId`: 61 `[question] … asking the user` lines, 57 distinct ids, one session, no re-attach between them.
`fingerprintOf` is the question, its rows, `multi` and `dialogSignature(dialog)`; `dialogSignature` strips the drift
engines are known to paint (timers, cursors, ticked boxes), and its comment says the id "may only change when the
QUESTION does". Something on that machine's dialog changed each minute that it does not strip; what it was is in the
customer's pane, not in the log, and is not chased. Every new id re-alerts every client (the dial's ring, the
needs-you alert and sound, the usage counts), and an answer typed after the drift is refused as STALE_QUESTION
(`AskQuestionController` recomputes the id off the live pane, `questionController.ts:389`).

Separately (found reading the code), a question can outlive its agent in the core's open questions, which are given
again to every dial that attaches (`cli/src/core/main.ts:1023-1030`): `QuestionWatcher.reset()` (a device joined)
clears the announced ids, so a later `stop()` or confirmed miss finds no id and never closes the question; and a cloud
harness removed from `publish` (`cli/src/core/agents/cloud.ts`) never drops its open question.

**Fix (orchestrator's call: the cause, in the module that owns questions; no client change).**
- **An unchanged ask keeps its id (orchestrator's rule).**
  - A *question* (an engine's own question, such as AskUserQuestion) keeps its announced `requestId` while it stays on
    the pane (no confirmed miss) and its question, rows and `multi` are what was announced: a change in the rest of the
    dialog alone is the same question. The watcher announces nothing and remembers the new fingerprint. Its answer is
    taken under the kept id: the answer's check accepts the id the watcher holds for that session's live dialog when
    the live dialog's question, rows and `multi` match it.
  - A *permission* dialog (`isApprovalDialog`) keeps its id only while its whole body, as `dialogSignature` reads it,
    is unchanged. A changed body is a new ask: it is announced under a new id and rings, and an answer to the old one
    is refused as STALE_QUESTION, as today (`askQuestion.spec.ts` "still refuses an answer once the command itself
    changed" keeps its guarantee). `npm test && git push` becoming `npm test && rm -rf ~/work` is a new request the
    person is told about again.
  - **What changed each minute.** The log shows the fingerprint changing every 60 s (±1 s), offset from the wall clock
    (an elapsed counter at minute grain, not a clock), on a question of 18 characters, shorter than any permission
    question Claude Code asks, so most likely a question, which the rule above covers. The builder checks the engines'
    dialog fixtures and parsers for a volatile part that `dialogSignature` does not strip (an elapsed time at minute
    grain, a spinner, a re-wrap at a new width); one found is normalized there, so a permission dialog with it keeps
    its id too. None found: the spec's rule stands, and the pull request says so.
- **A gone agent's question is closed and forgotten.** `reset()` lets the next poll announce an open question again
  without losing the id it must close; a removed agent (including a cloud harness) closes its question; the
  attach-time resend gives no question of an agent that is gone.
- Unchanged: a new greeting (the dial lost its RAM) rings open questions again (`cableSession.spec.ts`); a question
  with other words or options rings.

**Tests.** Red first, in the watcher's and the core questions' specs: a question whose dialog signature changes but
whose words and options do not is announced once, with one id, and an answer under that id is typed; a permission
dialog whose body changes is announced anew and the old answer is refused; a question with other words is announced
anew; after `reset()`, stopping the session closes its question; a removed cloud harness's question is
closed; the attach-time resend skips a gone agent's question. Core files (`cli/src/core/`) at 100% in `test:core`.

### 3. One-shot workers start through the Windows program resolver

**Cause.** `cli/src/lib/oneshot.ts` spawns each one-shot worker by its bare command (`claude`, `codex`, `pi`,
`command-code`, `kilo`, `grok`, `cursor-agent`; OpenCode through its own lookup). On Windows `spawn` without a shell
finds neither an npm `.cmd` shim nor a `claude.exe` outside PATH, so it fails with ENOENT, every engine alike. The
devices already do this right for Claude (`cli/src/devices/claudePlugin.ts`: `claudeNearby` finds it with Windows'
extensions and the installer's folders, then `windowsProgram` starts it).

**Fix.** Every one-shot worker on Windows finds its program the way the daemon finds that engine elsewhere (its path
override, PATH with Windows' extensions, the installer's folders) and starts it through `windowsProgram`; a program
it refuses or cannot find is a failure with a kind (`errorKind`), as a spawn error is today. Unchanged off Windows.
One lookup serves every engine; no second resolver.

**Tests.** Red first: with `platform: 'win32'` and a fake PATH holding `claude.cmd` (an npm shim fixture, as
`lib/windows/fixtures/` has) or `claude.exe`, the worker's spawn gets the resolved program, not `claude`.

### 4. Start markers read through `startMarkerMs`

**Cause.** `startMarkerMs` (`cli/src/lib/processProof.ts`) reads both a C-locale `lstart` and a Windows
`w:<FILETIME>`. These read a start marker with `Date.parse`, NaN on Windows:
`cli/src/core/agents/bind.ts:647-648` (whether an observed process may claim a session another row owns) and `:968`
(process repair), `cli/src/core/agents/hermesTerminal.ts:89`, `cli/src/lib/captureResumeIdentity.ts:56,65`,
`cli/src/lib/closeAgentService.ts:95`, `cli/src/lib/handoffDiscovery.ts:68`,
`cli/src/lib/sessionSearch/externals/support.ts:226`. (`cli/src/lib/processEvidence.ts:74` compares Linux
`/proc` birth: the builder checks whether it can see a Windows marker.)

**Fix.** Every one reads the marker through `startMarkerMs`. A fix covers every case of the same cause.

**Tests.** Red first for each behavior that changes on Windows: the repair runs for a `w:` marker; a later `w:`
process may claim a session from an earlier one. Core files at 100% in `test:core`.

**Order.** After `fix/win-hook-admission` merges; rebase first.

### 5. Held rows saved by 0.6.86 or older

**Cause.** #4604 bounds launches the native guard held (`startsAgain` and a native token: their own timer, then
`DID_NOT_START` after 10 holds or 15 minutes). A row 0.6.86 or older saved as held (native token, no session, no
`startsAgain`, detail "Waiting to confirm the engine executable and native hooks.") is skipped by every pass on purpose
(`cli/src/lib/restoreAgents.ts:486-488`) and nothing converts it: it stays held forever. (The rows a pass re-holds,
"K still waiting", already get the shared retry timer: that part of the log is not a bug.)

**Which rows.** Only what 0.6.86 or older wrote and no current code writes: the held row with the detail
"Waiting to confirm the engine executable and native hooks." (the builder confirms the exact old shape from
`git show v0.6.86_cli:cli/src/lib/restoreAgents.ts` and its neighbours). Not the shape alone: current code still saves
a held row with a native token and no session on purpose (`cli/src/core/agents/newPane.ts:249`, "The original launch
and terminal are preserved."), and `restart.ts:204` refuses to start it fresh because its first prompt may have reached
an engine. Those stay as they are.

**Fix.** Such a row is handled as #4604 handles a guard hold: when its waiting pane is alive and its own, it gets the
guard hold and starts again (as `restoreAgents.ts` already does for starting rows); one it cannot rebuild (no
`creationId`) fails with `DID_NOT_START` ("Close it and open a new one."). Bounded as #4604 is. Holds that wait on a
service are not touched.

**Tests.** Red first in `cli/src/lib/restoreAgents.spec.ts`: an old-shape held row is started again or failed, not
skipped. If `cli/src/core/agents/heldLaunches.ts` changes, `test:core` at 100%.

**Order.** With item 4, after `fix/win-hook-admission` merges.

### 6. Orca homes: said once per change

`createOrcaHomesCache` (`cli/src/devices/orcaHomes.ts`) logs its line at every read (every 5 minutes). It logs only
when the line differs from the last one it logged. Tests in `orcaHomes.spec.ts` change to match (two equal reads,
one line); the devices spec still sees the first line.

### 7. The silent-card rule in one place

`subagent === true || restored === true` is written in `cli/src/cable/cableHost.ts` (`cableEventFor`) and
`cli/src/device/deviceFleet.ts`. One function beside `notNewsOf` in `cli/src/lib/agentNotifications.ts` says whether
a card is silent; both use it. No behavior change: the existing tests stay green; one test of the function.

### 8. End-to-end: a turn that goes on after an approved ask rings when it ends (#4620)

A CLI e2e case: an agent's turn asks for permission, the ask is approved while the turn runs, the turn goes on, and
its end rings the dial (a `summary` card that is not silent, at the alert tier). The builder picks the e2e file whose
harness already drives a fake engine's turn and the stand-in dial (for example `cli/e2e/questions.e2e.ts` or
`cli/e2e/deviceNotify.e2e.ts`). It runs on PR CI (linux-e2e runs a modified e2e file).

### 9. ci-plan selects windows-e2e for the Windows desk's imports

`scripts/ci-plan.py` `windows_e2e(path)` selects windows-e2e by folder prefixes and windows.yml's spec list. The dial
desk bundle `cli/e2e/dialWindowsTools.e2e.ts` builds and runs imports modules outside them (for example
`cli/src/testing/placeNode.ts`), so a change there runs it only nightly. The desk's import closure is listed in
`ci-plan.py`, and `scripts/tests/test_ci_plan.py` walks the imports so the list cannot fall behind, as it does for
dial-hosts and the app eval. Red first: a test that a change to `cli/src/testing/placeNode.ts` selects windows-e2e.

## Approaches

- **Chosen: fix each cause where it lives, one PR.** Each item is small and independent; the orchestrator asked for
  one batch PR.
- Patch the symptoms (raise the viewer's restart limit, mute `rule:question` logs, rate-limit the router's retries):
  rejected, the failures would stay.
- Items 4 and 5 now, merging conflicts later: rejected by the orchestrator; they wait for `fix/win-hook-admission`.

## Orchestrator's decisions

- Item 5 stays, small: only rows 0.6.86 or older saved, bounded as #4604; done with item 4.
- Items 4 and 5 after `fix/win-hook-admission` merges, on a rebased branch. The pull request opens early (CI and the
  testers run on items 1-3 and 6-9); the merge waits until 4 and 5 land in the same pull request.
- Item 2 is fixed at its cause in the module that owns questions, for every client. A question keeps its id on its
  words and options; a permission dialog only while its whole body is unchanged (a changed body is a new ask that
  rings); a volatile part found in a dialog is normalized in the fingerprint.
- Windows VM in phase 4, asked for first; the Ubuntu VM stays off.

## Calls made here (the builder may revisit with a reason)

- Item 1: the fix is in the shared `runtimes.sh`, so all 18 packages that use `harness_node` are fixed, not only
  harness-monitor.
- Item 2: the log shows only that the fingerprint changed each minute; the builder looks for the volatile part in the
  engines' fixtures and parsers.
- Item 5: both held details that only 0.6.86 or older wrote are converted ("Waiting to confirm the engine executable
  and native hooks." and "The engine did not start because its executable or native hooks changed. The original
  launch is held for recovery.").
- Item 1: `store/tools/local-ai/toolchain/node.sh` and its copies (ollama, vllm, mlx-lm) read `current-node` the same
  broken way: fixed in this pull request (same cause).
- Item 3: every one-shot engine, not only Claude (same cause).
- Item 4: every `Date.parse` of a start marker, not only `bind.ts`.

## Left to the builder

- Where each test lives, within the rules above.
- Item 2: how the answer's check reaches the id the watcher holds (`AskQuestionDeps`), and where the core drops a
  gone agent's question (`core/questions.ts` owns the open questions).
- Item 3: which existing lookup to reuse for the Windows search.
- Item 8: which e2e file.

## Verification (for the plan)

- Unit and spec tests per item, red then green, run locally for what changed.
- `npm run test:core` (items 4, 5 if core files change), recorded in the PR.
- PR CI, with windows-e2e selected by the changed paths.
- Windows VM (orchestrator's turn): item 1, harness-monitor's viewer comes up for an attached agent with an older
  Node on PATH; item 3, the router logs `warm ready` for an installed engine.
