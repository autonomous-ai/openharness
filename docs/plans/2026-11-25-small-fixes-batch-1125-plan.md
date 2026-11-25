# Small fixes batch 2026-11-25 Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Nine fixes in one pull request: Windows DSH viewers start, one ring per question and none for a gone agent,
Windows one-shot workers start, process repair runs on Windows, held rows of 0.6.86 or older recover, Orca's homes line
is said once per change, one silent-card rule, an end-to-end case for #4620, and windows-e2e selected for the Windows
desk's imports.

**Architecture:** Each cause is fixed where it lives: `store/tools/runtimes.sh` (then every copy by
`sync-runtimes.mjs`) and the local AI packages' `store/tools/local-ai/toolchain/node.sh` (then its three copies by
`npm run build` there); the question watcher and its answer check in `lib/questionController.ts`, with the core's open
questions in `core/questions.ts` and `core/agents/cloud.ts`; one Windows engine lookup (`engineNearby`, generalised from
`claudeNearby`) under every one-shot worker, started through `windowsProgram`; `startMarkerMs` at every start-marker
read; the restore's held branch; the devices' Orca cache; `agentNotifications.ts`; `deviceNotify.e2e.ts`;
`scripts/ci-plan.py`. Tasks 12-14 wait for `fix/win-hook-admission` to merge and this branch to be rebased (Task 11).

**Tech Stack:** TypeScript (Node 24), Vitest 4, bash (3.2 on macOS, Git Bash on Windows), Python 3 (`unittest`). All
`npx`/`npm` commands run in `cli/`; Python and `node store/...` commands from the repository root.

**Spec:** `docs/plans/2026-11-25-small-fixes-batch-1125-design.md` (read it with this plan). The orchestrator's decisions
are final: one pull request with all nine items; item 5 small (only rows 0.6.86 or older saved, bounded as #4604);
items 4 and 5 after `fix/win-hook-admission` merges, on a rebased branch; item 2 fixed at its cause in the module that
owns questions, no client change: a question keeps its id while its words, options and `multi` stay, a permission
dialog only while its whole body (as `dialogSignature` reads it) does, so a changed body is a new ask that rings, and a
volatile part found in an engine's dialog is normalized in the fingerprint; item 5 takes both old details; item 1's
same cause in the local AI packages' `node.sh` is fixed here (Task 15); the Windows VM only in phase 4 on the
orchestrator's turn, the Ubuntu VM off; no production backend or accounts anywhere.

## Global Constraints

- **The customer's log is data.** No path, user name, prompt or text from it in a test, fixture, comment, commit message,
  doc or the pull request. Invented values only: `C:\Users\abcdef\.harness\runtime\node-v22.12.0-win-x64\node.exe`,
  `/c/Users/abcdef/.harness/runtime`. Only our own fixed log words and counts are quoted.
- **`cli/src/core/**` and `cli/src/services/**` are 100% per file** (`npm run test:core`, `cli/vitest.core.config.ts`;
  `core/main.ts` excluded). v8 counts `??` and `?.` as branches: cover both sides or write it with none.
  `src/lib/captureResumeIdentity.ts` is 100% in `npm run test:resume`.
- **Test first**, at the layer where the behavior lives; run only the tests of what changed (the command each task
  names); no full suites locally; no fixed sleeps (fake timers, `until`, `vi.waitFor`).
- **Hands off `fix/win-hook-admission`'s area**: hook admission, resume binding, BOM reading. Tasks 1-10 and 15 never
  touch `cli/src/core/agents/bind.ts`, `cli/src/core/agents/hermesTerminal.ts`, `cli/src/lib/restoreAgents.ts`. That branch
  also edits `cli/src/core/main.ts` (its import at line 175 and line 2088): Task 3's two lines are other hunks. No task
  edits `cli/e2e/harness/*` (that branch edits `daemon.ts` and `fakeEngine.mjs`).
- **Windows** ([docs/windows-rules.md](../windows-rules.md)): a program starts through `cli/src/lib/windows/program.ts`
  `windowsProgram`, never `cmd.exe`; never `detached: true` there (`ownProcessGroup()`); a new Windows mistake goes into
  the rules with its test (Task 10).
- **`store/tools/runtimes.sh` is the one hand-written copy.** `node store/tools/sync-runtimes.mjs` writes the 57 package
  copies; none is edited by hand. It runs under macOS's `/bin/bash` 3.2 (no `${v,,}`, no `declare -l`) and under
  `set -euo pipefail`; its `miss …` lines keep their words.
- **No client change** (dial firmware, Desktop, mobile). `core/main.ts` gets wiring only.
- **Logs** name fixed words, counts and our own ids (as `[question] <sid> … req=<id>` does today), never stored text or a
  path.
- **Comments say why** and copy follows [the Naming System](../naming-system.md).
- **A change to `scripts/ci-plan.py` needs two independent security reviews before it merges**
  ([validation and release](../validation-and-release.md)).
- Platforms: macOS, Linux, Windows.

## What this plan decides from the spec's words

- **Item 1, the Windows test.** The red test for PR CI and the real Git Bash case are one file,
  `cli/src/lib/windows/gitBashNode.spec.ts`: Linux CI runs its stand-in case (cli-tests), and windows-e2e runs its real
  Git Bash case, because `src/lib/windows/` is already on `windows.yml`'s spec list and in `WINDOWS_SPECS`. So no
  `windows.yml` or `WINDOWS_SPECS` edit, and only the x64 leg is selected: a file whose own name says `windows` would
  add the arm64 leg (about 27 runner-minutes). `store/tools/test_runtimes.py` gets no case (no workflow runs it; the
  CLI spec is the one test of this behavior) and is run locally as a regression (Verification).
- **Item 1, the helper.** `_harness_node_dir RECORDED` (in `runtimes.sh`) prints the folder of the Node a
  `current-node` names, as this shell reads paths; both reads in `harness_node` (the "already Harness's own" comparison,
  line 107, and the PATH step, lines 108-113) use it, and the comparison accepts `$dir/node` and `$dir/node.exe`.
- **Item 1, the local AI packages** (Task 15). `store/tools/local-ai/toolchain/node.sh` reads `current-node` with the
  same `${x%/*}/node`. It is the one hand-written copy: `store/tools/local-ai/scripts/build-{ollama,mlx,vllm}.mjs`
  (`npm run build` there) copy it into `store/agents/{ollama,mlx-lm,vllm}/toolchain/node.sh`, and
  `store/tools/local-ai/test/packaging.test.mjs` fails when a copy differs (the build was checked to change nothing else
  at `8c703aca14`). These packages carry no `runtimes.sh` and a package installs alone, so `node.sh` gets its own
  `local_ai_node_dir RECORDED`, the same rule as `_harness_node_dir`, its comment naming that one. It is sourced by
  `/bin/sh` (dash on Linux): POSIX only. Its red test is a case in Task 1's `gitBashNode.spec.ts`, the one CLI spec of
  "Harness's Node from a Windows `current-node`", on PR CI (cli-tests) and windows-e2e alike.
- **Item 2, where the answer check reaches the held id:** `AskQuestionDeps.heldRequestId(sessionId, view)`, which
  `core/questions.ts` wires to `QuestionWatcher.heldRequestId`. **Where the core drops a gone agent's question:**
  `core/questions.ts` `openQuestionFrames()`, used by both attach-time resends in `core/main.ts` (the dial's at
  1023-1030 and the window's `openQuestions` at 2474) and by `reannounceRemote`; it forgets only this module's own
  questions (the keys it put in `askedRemotely`), never a cloud agent's, which `cloud.ts` closes itself (Task 4).
  "Same question" is the spec's: same session, same question text, same row labels, same `multi`, no confirmed miss,
  and neither the announced dialog nor the live one a permission dialog (`isApprovalDialog`). A permission dialog is
  the same ask only while its whole fingerprint is (`dialogSignature` included): its id stays `questionRequestId`'s and
  `heldRequestId` gives nothing for it, so its answer check is today's. The pre-turn baseline (`preTurn`) still compares whole fingerprints, on purpose: by words alone a new prompt that
  shares its first line with the last turn's would never be announced.
- **Item 3, the lookup reused:** `claudeNearby` (`devices/claudePlugin.ts`) becomes `engineNearby(engine)` in
  `lib/engineBin.ts`, and `claudePlugin.ts` calls it (the old function goes). It looks where `claudeNearby` looked:
  the engine's path override (`enginePathOverride`), its install recipe's names (`engineInstallRecipe(engine).executable
  .names`, never `cmd` on Windows; not `ENGINE_CLI_ALIASES`, whose shared `agent` names Grok for Cursor) on PATH, then
  the installer's folders (`engineInstallPaths`). On Windows each is tried with Windows' extensions
  (`windowsLaunchCandidates`, `lib/binaryOnPath.ts`), a name that already ends in `.exe`/`.cmd`/`.bat`/`.com` as it is;
  elsewhere through `resolveBinaryOnPath`, as today. A file counts when `executableFileIdentity` reads it (a Store
  app's alias does not). OpenCode on Windows uses it too (one lookup); off Windows `opencodeBinAsync` stays.
- **Item 4, the sites.** `lib/processEvidence.ts:74` stays: its rows come from the `ps -axo …,lstart=` graph, whose
  regex (line 32) admits no `w:` marker. `lib/captureResumeIdentity.ts:56,65` and `core/agents/hermesTerminal.ts:89`
  are not reached on Windows (no `ps` graph there; `deps.platform === 'win32'` returns first): converted for one way,
  with no new red test. Where a site's old value flowed into a comparison or arithmetic, it reads
  `startMarkerMs(marker) ?? NaN`, so an unreadable marker behaves as before.
- **Item 5, the old shape.** The held details v0.6.86 (and older) wrote and `main` writes nowhere (checked with
  `git grep -F` over every `v0.6.*_cli` tag against `HEAD`): `'Waiting to confirm the engine executable and native
  hooks.'` (v0.6.86 `restoreAgents.ts:493`) and `'The engine did not start because its executable or native hooks
  changed. The original launch is held for recovery.'` (v0.6.86 `newPane.ts` and `restoreAgents.ts:1003`). The four
  other old-looking details (`Waiting to confirm the engine’s native hooks.`, Codex's profile hooks, the external
  conversation's hooks, the fork's configuration) are still written by `main` (`create.ts`, `externalPreflight.ts`,
  `fork.ts`, `launchOverrides.ts`) and are not touched. Both details are converted (orchestrator, 2026-11-25).
- **Item 8, the file:** `cli/e2e/deviceNotify.e2e.ts`: it already drives a Harness agent's fake Claude Code turns from a
  window and a stand-in dial on a desk, and its cases are what rings and what does not. `linux_e2e_file` selects it
  when modified (not in `LINUX_E2E_NEVER`, not a dial host's).
- **Item 9, the walk's boundary:** from `cli/scripts/windows-dial-e2e/desk.mts` and `cli/e2e/dialWindowsTools.e2e.ts`,
  through `cli/e2e/harness/` and `cli/src/testing/` only, as the dial hosts' and the app eval's walks stop at their
  folders. Today that closure has 20 files no rule selects for windows-e2e: `cli/e2e/harness/{artifacts,client,daemon,
  desk,fakeBackend,fakeDial,reaper}.ts` and `cli/src/testing/{daemonEnvironment,dialCarousel,executableFixture,ghStub,
  isolatedTmux,placeNode,removeRoot,rootProcesses,socketPathRoom,spawnedRuns,startEnvFile,testNode,testPath}.ts`.
  Product code the bundle also carries (about 400 files under `cli/src/` through `harness/daemon.ts`) is not walked: it
  would run windows-e2e for almost every CLI pull request, and its Windows code is selected by the rules already there
  (`lib/windows/`, `devices/`, `cable/`, a name with `windows`, `WINDOWS_SPECS`' modules).

## Review Focus

1. **A permission prompt whose body changes while it stays up** (`npm test && git push` becoming `npm test && rm -rf
   ~/work`, the title unchanged): a new ask, announced under a new id and ringing, and an answer to the old id refused
   as STALE_QUESTION, never typed into the new command. Task 2 pins it at the watcher (`heldRequestId` gives nothing
   for a permission dialog) and keeps `still refuses an answer once the command itself changed`
   (`askQuestion.spec.ts:1147`) unedited and green with `heldRequestId` wired.
2. **`current-node` in its other Windows forms:** a lowercase drive (`c:\`), forward slashes (`C:/…`), a space in the
   profile folder (`C:\Users\abc def\…`), an LF only, a POSIX path with no CR: Task 1's spec has a case for each.
3. **A cloud agent's question in the attach-time resend:** the registry never resolves a cloud agent, so the gone-agent
   drop must leave its question alone: Task 3 has the case.
4. **A path override naming the program itself** (`CLAUDE_PATH=C:\…\claude.exe`, or a `.cmd` that is no npm shim):
   used as it is, or refused with its kind (`WindowsProgramRefused`), never ENOENT: Task 5 has both.
5. **Orca's line going A, B, A:** said three times (once per change, not once ever): Task 6 has the case.

---

## Task graph

| # | Task | Item | Effort | Depends on | Gated |
|---|---|---|---|---|---|
| 1 | `harness_node` reads a Windows `current-node` | 1 | high | - | no |
| 2 | A question keeps its id while its words stay, a permission dialog while its body does; reset keeps what it must close; a volatile dialog part, if found, normalized | 2 | xhigh | - | no |
| 3 | The core asks the watcher, and forgets a gone agent's question | 2 | high | 2 | no |
| 4 | A cloud harness gone from the list closes its question | 2 | medium | - | no |
| 5 | One-shot workers start through `engineNearby` and `windowsProgram` | 3 | high | - | no |
| 6 | Orca's homes said once per change | 6 | medium | - | no |
| 7 | The silent-card rule in one place | 7 | medium | - | no |
| 8 | End to end: a turn that goes on after an approved ask rings (#4620) | 8 | high | - | no |
| 9 | windows-e2e for the Windows desk's imports | 9 | high | - | no |
| 10 | Windows rules: Git Bash reads `current-node`; engines by their lookup | 1, 3 | medium | 1, 5, 15 | no |
| 11 | Rebase on `main` once `fix/win-hook-admission` has merged | 4, 5 | high | 1-10, 15, and that merge | gate |
| 12 | Start markers through `startMarkerMs` in the core | 4 | xhigh | 11 | **GATED** |
| 13 | Start markers through `startMarkerMs` in `lib/` | 4 | high | 11 | **GATED** |
| 14 | Held rows saved by 0.6.86 or older | 5 | xhigh | 11 | **GATED** |
| 15 | The local AI packages' `node.sh` reads a Windows `current-node` | 1 | high | 1 | no |

Longest chain: five tasks (1 → 15 → 10 → 11 → 12; also 1 → 15 → 10 → 11 → 13 and → 14). Without the gate: three
(1 → 15 → 10). Task 11 rewrites the whole branch, so it waits for every task before it. Files (each in one task,
except `cli/src/lib/windows/gitBashNode.spec.ts`, which Task 15 extends after Task 1):

- 1: `store/tools/runtimes.sh`, the 57 copies `sync-runtimes.mjs` writes (`store/agents/*/toolchain/runtimes.sh`,
  `store/viewers/*/runtimes.sh`), `cli/src/lib/windows/gitBashNode.spec.ts` (new).
- 2: `cli/src/lib/questionController.ts`, `cli/src/lib/askQuestion.spec.ts`, `cli/src/lib/askQuestion.polling.spec.ts`.
- 3: `cli/src/core/questions.ts`, `cli/src/core/questions.spec.ts`, `cli/src/core/main.ts` (two lines).
- 4: `cli/src/core/agents/cloud.ts`, `cli/src/core/agents/cloud.spec.ts`.
- 5: `cli/src/lib/engineBin.ts`, `cli/src/devices/claudePlugin.ts`, `cli/src/lib/oneshot.ts`,
  `cli/src/lib/engineBin.nearby.spec.ts` (new), `cli/src/lib/oneshot.program.spec.ts` (new).
- 6: `cli/src/devices/orcaHomes.ts`, `cli/src/devices/orcaHomes.spec.ts`.
- 7: `cli/src/lib/agentNotifications.ts`, `cli/src/lib/agentNotifications.spec.ts`, `cli/src/cable/cableHost.ts`,
  `cli/src/device/deviceFleet.ts`.
- 8: `cli/e2e/deviceNotify.e2e.ts`.
- 9: `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md`.
- 10: `docs/windows-rules.md`.
- 12: `cli/src/core/agents/bind.ts`, `cli/src/core/agents/bind.spec.ts`, `cli/src/core/agents/hermesTerminal.ts`.
- 13: `cli/src/lib/captureResumeIdentity.ts`, `cli/src/lib/closeAgentService.ts`, `cli/src/lib/closeAgentService.spec.ts`,
  `cli/src/lib/handoffDiscovery.ts`, `cli/src/lib/handoffDiscovery.spec.ts`,
  `cli/src/lib/sessionSearch/externals/support.ts`, `cli/src/lib/sessionSearch/externals/support.spec.ts`.
- 14: `cli/src/lib/restoreAgents.ts`, `cli/src/lib/restoreAgents.spec.ts`.
- 15: `store/tools/local-ai/toolchain/node.sh`, its three copies `store/agents/{ollama,mlx-lm,vllm}/toolchain/node.sh`
  (written by `npm run build` in `store/tools/local-ai`), `cli/src/lib/windows/gitBashNode.spec.ts` (after Task 1).

---

### Task 1: `harness_node` reads a Windows `current-node`

**Files:** Modify `store/tools/runtimes.sh` (`harness_node`, lines 100-118, and the header's `harness_node` lines
9-11); regenerate every copy with `node store/tools/sync-runtimes.mjs`; Create `cli/src/lib/windows/gitBashNode.spec.ts`.

**Depends on:** nothing. **Effort:** high. **Failing test:** the stand-in case below, on every host but Windows.

**Interfaces:** Produces, in `runtimes.sh`: `_harness_node_dir RECORDED`: prints the folder of the file RECORDED names,
after dropping one trailing CR; a drive-letter path (`[A-Za-z]:\…` or `[A-Za-z]:/…`) is turned into this shell's path
first, by `cygpath -u` when `cygpath` is on PATH, else `/<drive in lower case>/<rest, \ as />` (the fallback may use
`tr`, which Git Bash has). Any other path is read as today (`${x%/*}`).

- [ ] **Step 1: Write the failing test.** `gitBashNode.spec.ts`, header comment: Harness's Node as a store package's
  script finds it in Git Bash, from a `current-node` Windows wrote (`cli/scripts/install.ps1`, `lib/selfUpdate.ts`
  `\r\n`). `RUNTIMES` is `store/tools/runtimes.sh` from the repository root (`new URL('../../../../store/tools/runtimes.sh',
  import.meta.url)`).

  `describe.skipIf(process.platform === 'win32')('a Windows current-node, in a stand-in Git Bash')`: a throwaway root
  with `bin/` holding only stubs and links (as `store/tools/test_runtimes.py`'s `Box` builds it): `uname` (`-s`
  prints `MINGW64_NT-10.0-26100`, `-m` prints `x86_64`), an old `node` (`-v` prints `v20.0.0`; `-e SCRIPT MIN` is the
  at-least probe answered in bash, as `test_runtimes.py`'s `NODE`), `cygpath` (`-u C:\Users\abcdef\…` prints
  `<root>/c/Users/abcdef/…`), links to `cat` and `tr`. HOME is `<root>/c/Users/abcdef`; Harness's Node is a stub
  `node` reporting `22.12.0` in `<HOME>/.harness/runtime/node-v22.12.0-win-x64/`; `current-node` holds
  `C:\Users\abcdef\.harness\runtime\node-v22.12.0-win-x64\node.exe\r\n`. Each case runs
  `bash -c 'set -euo pipefail; . "$RUNTIMES"; …'` with `env: { PATH: bin, HOME }` only.
  - `it('finds Harness's Node through a CRLF backslash current-node when the node on PATH is too old')`: script
    `harness_node 22; command -v node`; expect exit 0 and the last stdout line `<runtime>/node-v22.12.0-win-x64/node`.
    Today: exit 1 and stdout contains `miss node >= 22, and Harness's own Node is not in`.
  - `it('asked twice, adds that folder to PATH once')`: `harness_node 22 && harness_node 22 && echo "$PATH"` →
    `<that folder>:<bin>`.
  - `it.each` of `_harness_node_dir` with no `cygpath` on PATH (a `bin` without it): `C:\Users\abcdef\x\node.exe\r` →
    `/c/Users/abcdef/x`; `c:\Users\abcdef\x\node.exe` → `/c/Users/abcdef/x`; `C:/Users/abcdef/x/node.exe` →
    `/c/Users/abcdef/x`; `C:\Users\abc def\x\node.exe\r` → `/c/Users/abc def/x`;
    `/home/abcdef/.harness/runtime/node-v22.12.0-linux-x64/bin/node` (no CR) →
    `/home/abcdef/.harness/runtime/node-v22.12.0-linux-x64/bin`.

  `describe.runIf(process.platform === 'win32' && findGitBash() !== null)('a Windows current-node, in the real Git
  Bash')` (`findGitBash` from `./gitBash.js`): a throwaway profile (`realpathSync(mkdtempSync(…))`, removed after);
  `<profile>\.harness\runtime\node-v<this major>-win-x64\node.exe` copied from `process.execPath`; `current-node` written
  as Windows writes it (`<that path>\r\n`); an older `node` first on PATH: a folder holding a `#!/bin/bash` script
  `node` (`-v` prints `v18.0.0`, `-e` exits 1). Run `findGitBash()`'s bash with `-c` `set -euo pipefail; export
  ADAPTER_RUNTIME_DIR="$(cygpath -u "$RUNTIME_WIN")"; . "$(cygpath -u "$RUNTIMES_WIN")"; harness_node <major>; command -v
  node`, env `{ ...process.env, PATH: '<old node folder>;' + process.env.PATH, RUNTIME_WIN, RUNTIMES_WIN }`. Expect exit
  0 and the last line ending in `/node-v<major>-win-x64/node` or `/node.exe`. 60 s timeout.
- [ ] **Step 2: Run it to see it fail.** `npx vitest run src/lib/windows/gitBashNode.spec.ts`. Expected: the first case
  fails with exit 1 and the `miss node >= 22` line; the `_harness_node_dir` cases fail (`command not found`). Commit
  (red): `test(store): harness_node finds Harness's Node through a Windows current-node`.
- [ ] **Step 3: Implement** `_harness_node_dir` as the Interfaces block says and use it in `harness_node` for both
  reads (lines 107 and 108-113, `$dir/node` or `$dir/node.exe` in the comparison). The header's `harness_node` lines
  say Windows' form is read. Comment why: Windows writes `current-node` as `C:\…\node.exe` with a CRLF, which
  `${x%/*}` cannot cut, so every package's setup, doctor and viewer exited 1 under `set -e` on a computer whose own Node
  is older (spec item 1). Then `node store/tools/sync-runtimes.mjs`.
- [ ] **Step 4: Run.** `npx vitest run src/lib/windows/gitBashNode.spec.ts src/dsh/store.spec.ts`; from the root
  `node store/tools/sync-runtimes.mjs --check` (prints nothing) and `python3 -m unittest store/tools/test_runtimes.py`.
  Expected: PASS.
- [ ] **Step 5: Commit** `fix(store): harness_node reads a Windows current-node, in every package`.

### Task 2: A question keeps its id while its words stay, a permission dialog while its body does; reset keeps what it must close

**Files:** Modify `cli/src/lib/questionController.ts` (`QuestionWatcher`: `tick` 806-834, `reset` 715-720, `noteGone`,
`forget`, `stopAll`; `AskQuestionDeps` 170-181; `drive`'s id check 388-394; `dialogSignature` 896-913 and its regexes
865-888 only if Step 1 finds a volatile part); Test `cli/src/lib/askQuestion.spec.ts` (the `describe('the review\'s
simulation: …')` block from line 1085; for a found part, the `describe('a waiting dialog keeps one requestId')` block
from line 986), `cli/src/lib/askQuestion.polling.spec.ts`. Read only (Step 1): the pane fixtures
`cli/src/lib/__fixtures__/{permission,question}-*.txt`, the readers behind `parseEngineQuestionPane`
(`cli/src/lib/questionPane.ts`, `cli/src/engines/screens.ts`, `cli/src/engines/*/screen.ts`,
`cli/src/engines/*/askQuestion.ts`, `cli/src/engines/kit/questionPane.ts`) and their specs.

**Depends on:** nothing. **Effort:** xhigh (an answer typed into a terminal; the consent check). **Failing test:** below.

**Interfaces:** Produces:
- `AskQuestionDeps.heldRequestId?: (sessionId: string, view: QuestionView) => string | undefined`; `drive` accepts the
  answer's `requestId` when, for one of `asked.owners`, `questionRequestId(owner, view)` or `heldRequestId(owner,
  view)` equals it.
- `QuestionWatcher.heldRequestId(sessionId: string, view: QuestionView): string | undefined`: the id announced for that
  session while it is still held (no confirmed miss), when the announced dialog was a question, this view is one too
  (`!isApprovalDialog(view)`), and this view's words equal the announced words; else undefined. A permission dialog
  never gets one: its id is `questionRequestId`'s, as today.
- A private `questionWords(view)`: `` `${question}|${row labels joined by |}|${multi}` ``, which `fingerprintOf` builds
  on. `questionRequestId` is unchanged.

Rules (spec item 2, "An unchanged ask keeps its id"):
- After `if (this.last.get(sessionId) === fingerprint) return` in `tick`: a session whose held id belongs to a question
  announced with this view's words, the view itself not a permission dialog, keeps that id: `last` takes the new
  fingerprint, and the dialog is announced again under the held id only when `last` was empty (a `reset()`, or a miss
  not yet confirmed: what today re-announces); otherwise nothing is announced.
- A permission dialog (`isApprovalDialog(view)`) whose fingerprint differs from the one announced is a new ask: it is
  announced under `questionRequestId` (today's path), so it rings, and the old id's answer is refused (STALE_QUESTION).
- Words that differ are a new question, announced under `questionRequestId` as today.
- The announced words are kept (`lastWords`, beside `lastId`) only when the announced dialog is a question; a
  permission dialog leaves none, so it can never keep an id.
- `reset()` clears `last` and `misses` only; the held ids and words stay until `stop()`, a confirmed miss or
  `stopAll()`.

- [ ] **Step 1: Look for what moves the dialog each minute** (spec item 2, "What changed each minute"; no code). The log
  shows the fingerprint changing every 60 s (±1 s), offset from the wall clock (an elapsed counter at minute grain, not
  a clock), on an 18-char question. Check every fixture and reader above for a part painted inside `view.dialog` that
  changes while the dialog waits and that `dialogSignature` does not strip: an elapsed time at minute grain outside
  parentheses, a spinner glyph, a re-wrap at a new width. A part counts as found only when a fixture shows it or a
  reader in the repo names its form; a form only guessed is reported as a lead, not normalized. Leads seen while
  planning, not checked against `view.dialog`:
  - `DURATION` (line 874) has no minute-only form: a bare `3m`, or `1m 5s` with a space, outside parentheses is
    matched by neither `BARE_TIMER_LINE_RE` nor `TRAILING_TIMER_RE` (inside parentheses `TIMER_GROUP` takes `3m`).
  - `tickTimers` (`askQuestion.spec.ts:907`) keeps each timer's form (`37s` → `98s`), so no case crosses the first
    minute, where an engine may change form (`59s` → `1m`).
  - Copilot's question pane paints a right-aligned elapsed `37s` on its `Asking user …` line
    (`question-copilot.txt:280`); grok's question pane `4.2s` (`question-grok.txt:74`).
  - Grok's permission pane has a right-aligned wall clock `2:31 PM` (`permission-grok.txt:370`): a clock, so not the
    log's offset counter, but a volatile part if it reaches `view.dialog`.
  Write down what was checked and what was found (or "none found"); it goes into the task's report for the pull
  request body. Steps 7-10 run only for a part found.
- [ ] **Step 2: Write the failing tests.** In the simulation block, the `world` helper's controller gets
  `heldRequestId: (s, v) => watcher.heldRequestId(s, v)`; the case `still refuses an answer once the command itself
  changed` (line 1147) is not edited and must pass with it. A `world` variant whose `readQuestion` returns a view built
  by the test, with that same wiring:
  - `it('a question whose signature moves each poll while its words and options do not is announced once, and its answer is typed')`:
    `{ kind: 'question', question: 'Which drink?', rows: [Tea, Coffee], multi: false, dialog: 'Which drink?\nrow
    <n>\n1. Tea\n2. Coffee' }` (`row <n>` is a line no rule of `dialogSignature` strips); six polls with `n` = 1…6;
    `announced` has one id; `answer({ agentId: 'a1', requestId: announced[0], answers: { x: 'Coffee' } })` with `n` = 9
    on screen → `{ ok: true }`, keys `['2']`. Today: six ids, then STALE_QUESTION.
  - `it('a permission dialog whose body moves is a new ask each time: announced anew, and the old answer refused')`:
    `{ kind: 'question', question: 'Run this command?', rows: [Yes, No], multi: false, permission: true, dialog: 'Run
    this command?\n$ npm test <n>\n1. Yes\n2. No' }`, three polls with `n` = 1…3 → three ids;
    `watcher.heldRequestId('s1', <the n = 3 view>)` is undefined; the first id's answer → `STALE_QUESTION`, nothing
    typed. (Guards today's behavior under the new wiring.)
  - `it('a question whose words change is a new question, under its own id')`: the question becomes `'Which snack?'` →
    two ids; the first id's answer → `STALE_QUESTION`, nothing typed.
  - `it('a question that leaves for two polls and comes back is announced again, under the id its words give')`.
  In `askQuestion.polling.spec.ts` (a question, not a permission dialog):
  - `it('after a reset, stopping the session closes the question it announced')`: announce, `reset()`, `stop('s1')` →
    `onQuestionGone('s1', <that id>)`. Today: never called.
  - `it('after a reset, the next poll announces the open question again under the id it holds, and a confirmed miss closes it')`:
    announce; the dialog's signature moves; `reset()`; one poll → `onQuestion` again with the first id; two empty
    polls → `onQuestionGone` with it.
  - `it('after a reset, a removed agent\'s question is closed at the next poll')`: announce; `reset()`; the session
    deleted from `sessions`; one poll → `onQuestionGone('s1', <that id>)`. Today: never called.
- [ ] **Step 3: Run to see them fail.** `npx vitest run src/lib/askQuestion.spec.ts src/lib/askQuestion.polling.spec.ts`.
  Expected: the first question case and the three reset cases fail as noted (the permission, new-words and come-back
  cases and line 1147 guard today's behavior and pass). Commit (red).
- [ ] **Step 4: Implement** the Interfaces and Rules above. Announcing goes through one private method for both the new
  and the held id (the baseline cancel and `onQuestion`'s payload as today, the raw `dialog` as read now). Update
  `fingerprintOf`'s and `reset`'s comments: a question's id moves when its words do, a signature change alone keeps it
  (the customer case: one dialog re-announced every minute, each answer refused); a permission dialog's id moves with
  its whole body, because an approval meant for one command must never be typed into another.
- [ ] **Step 5: Run** `npx vitest run src/lib/askQuestion.spec.ts src/lib/askQuestion.polling.spec.ts
  src/lib/askQuestion.more.spec.ts src/lib/questionController.spec.ts src/cable/cableSession.spec.ts`. Expected: PASS
  (line 1147 unedited and green; `cableSession.spec.ts`'s new greeting still rings open questions).
- [ ] **Step 6: Commit** `fix(questions): a question keeps its id while its words stay, and its answer is taken`.
- [ ] **Step 7 (only for a part Step 1 found): Write the failing test** in the `a waiting dialog keeps one requestId`
  block: `it('<fixture>: its <part> moving keeps the id')`, the fixture with that part advanced in the engine's own form
  (as `tickTimers` does for today's timers) keeps `idIn(file, pane)`. If the normalization could reach a command's
  words, a case that a command's own text of the same form (for example `sleep 3m` on the command line) still moves a
  permission dialog's id.
- [ ] **Step 8: Run to see it fail.** `npx vitest run src/lib/askQuestion.spec.ts -t "keeps the id"`. Commit (red).
- [ ] **Step 9: Implement:** normalize just that part in `dialogSignature`, a comment naming the engine and the form.
  Nothing else in the signature changes.
- [ ] **Step 10: Run** the Step 5 command; `two different commands are still two requestIds` and `every captured dialog keeps
  its requestId` (line 1247, its id table) stay green. Commit `fix(questions): <the part> no longer moves a dialog's id`.

### Task 3: The core asks the watcher, and forgets a gone agent's question

**Files:** Modify `cli/src/core/questions.ts`, `cli/src/core/main.ts` (line 1030 and line 2474 only); Test
`cli/src/core/questions.spec.ts`.

**Depends on:** 2 (`heldRequestId`). **Effort:** high. **Failing test:** below. Core file: 100% in `npm run test:core`.

**Interfaces:** Consumes `QuestionWatcher.heldRequestId` (Task 2; it gives nothing for a permission dialog, so the
wiring here is the same for both kinds: pass it through, decide nothing). Produces on `createQuestions`' return:
`openQuestionFrames(): Record<string, unknown>[]`: the open questions to hand a dial or a window that attaches, after
forgetting each of this module's own questions (a key in `askedRemotely`) whose agent `resolve` no longer finds
(deleted from `openQuestions`, `askedRemotely` and `pending`, one log line `[question] <sid> forgotten · its agent is
gone · req=<id>`). A key not in `askedRemotely` (a cloud agent's) is handed on as it is. `reannounceRemote` forgets the
same first.

- [ ] **Step 1: Write the failing tests** in `questions.spec.ts`:
  - `it('checks an answer against the id the watcher holds')`: `given(asking.questions).heldRequestId('s1', view)` calls
    `asking.questionWatcher.heldRequestId('s1', view)` (spy) and returns its answer.
  - `it('hands a dial or window that attaches no question of an agent that is gone, and forgets it')`: `onQuestion` for
    `s1` (known) and `s9` (not in `agents`); `openQuestionFrames()` is `[s1's frame]`; `openQuestions.has('s9')` is
    false; `monitorActivity('s9')` is not `'needsInput'`.
  - `it('keeps a cloud agent's question, which the registry never knows')`: `openQuestions.set('cloud-a', …)` →
    `openQuestionFrames()` holds it.
  - `it('tells an app that connects no question of an agent that is gone')`: `reannounceRemote()` after `s9`'s
    question → `commander_questions_open` lists `s1`'s id only.
- [ ] **Step 2: Run to see them fail.** `npx vitest run src/core/questions.spec.ts`. Expected: FAIL (`heldRequestId` and
  `openQuestionFrames` undefined). Commit (red).
- [ ] **Step 3: Implement.** In `createQuestions`, the controller gets `heldRequestId: (sessionId, view) =>
  questionWatcher.heldRequestId(sessionId, view)` (read when an answer comes, after the watcher exists); add
  `openQuestionFrames` and the forgetting in `reannounceRemote`. In `core/main.ts`: line 1030 `for (const frame of
  asking.openQuestionFrames())`, line 2474 `openQuestions: () => asking.openQuestionFrames()`; nothing else there.
- [ ] **Step 4: Run** `npx vitest run src/core/questions.spec.ts` and `npx vitest run --config vitest.core.config.ts
  src/core/questions.spec.ts --coverage.include=src/core/questions.ts` (100%), then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(questions): a gone agent's question is closed and forgotten`.

### Task 4: A cloud harness gone from the list closes its question

**Files:** Modify `cli/src/core/agents/cloud.ts` (`doors.publish`, line 116); Test `cli/src/core/agents/cloud.spec.ts`.

**Depends on:** nothing. **Effort:** medium. **Failing test:** below. Core file: 100% in `npm run test:core`.

**Interfaces:** none new: a harness in the last list and not in this one has each request id `asked` holds for it
closed as `doors.unask(agentId, requestId)` closes one (the dial if it was shown, the windows, `openQuestions`,
`setUserAction(agentId, false)`), before `gone(agentId)`.

- [ ] **Step 1: Write the failing test** `it('closes the question of a harness that leaves the list, on the dial and the window, and forgets it')`:
  `publish([harness()])`, `ask('cloud_1', 'cloud_q_1', { text: 'Which one?', choices: ['A', 'B'] })`, `publish([])` →
  `commander_question_close` for `cloud_q_1` on `sendCommander` and `sendLocal`, `openQuestions.has('cloud_1')` false,
  `setUserAction('cloud_1', false)`; an `answer({ requestId: 'cloud_q_1', … })` afterwards is `null`.
- [ ] **Step 2: Run to see it fail.** `npx vitest run src/core/agents/cloud.spec.ts`. Commit (red).
- [ ] **Step 3: Implement** in `publish`'s loop over the harnesses that left.
- [ ] **Step 4: Run** `npx vitest run src/core/agents/cloud.spec.ts` and `npx vitest run --config vitest.core.config.ts
  src/core/agents/cloud.spec.ts --coverage.include=src/core/agents/cloud.ts`. Expected: PASS, 100%.
- [ ] **Step 5: Commit** `fix(cloud): a harness that leaves the list closes its question`.

### Task 5: One-shot workers start through `engineNearby` and `windowsProgram`

**Files:** Modify `cli/src/lib/engineBin.ts` (add `engineNearby`), `cli/src/devices/claudePlugin.ts` (`claudeNearby`
136-143 goes; `claudeInstalled` and `claudeFound` call `engineNearby('claude')`; unused imports go),
`cli/src/lib/oneshot.ts` (every `spawnTied` of an engine: Claude 163, Codex 273, Cursor 362, OpenCode 491, Kilo 641,
Pi 737, Command Code 815, Grok 945); Create `cli/src/lib/engineBin.nearby.spec.ts`, `cli/src/lib/oneshot.program.spec.ts`.

**Depends on:** nothing. **Effort:** high. **Failing test:** below.

**Interfaces:** Produces:
- `engineBin.ts`: `export function engineNearby(engine: ProcessEngine, options?: { platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv; home?: string }): string | null`, as "What this plan decides" (item 3) says. It adds
  no import file (`engineBin.ts` is in `src/architecture.coreFiles.txt`): `engineInstallRecipe`, `engineInstallPaths`,
  `windowsLaunchCandidates`, `resolveBinaryOnPath` and `executableFileIdentity` are all already reachable there.
- `oneshot.ts`: `export function oneShotProgram(engine: ProcessEngine, command: () => string, args: readonly string[],
  options?: { platform?: NodeJS.Platform; environment?: NodeJS.ProcessEnv; home?: string }): Program` (`Program` from
  `./windows/program.js`). Off Windows: `{ file: command(), args }`, `command` read as today (`claudeBin()`,
  `cursorBin()`, …). On Windows `command` is not read: `engineNearby(engine, …)`, then `windowsProgram(found, args, {
  platform, environment })`; none found throws `Object.assign(new Error(`${engine} is not installed on this computer`),
  { code: 'ENGINE_NOT_INSTALLED' })`; a batch file it refuses throws `WindowsProgramRefused`. Each worker spawns
  `program.file` with `program.args` (and `program.env` when set). A throw in a worker's constructor rejects
  `createOneShotWorker`'s promise, so the pool logs `warm spawn failed (n): ENGINE_NOT_INSTALLED` (or
  `WindowsProgramRefused`), as it logs a spawn error today.

- [ ] **Step 1: Write the failing tests.** `engineBin.nearby.spec.ts` (temp folders; `platform: 'win32'`, PATH joined
  with `;`; files made with `writeFileSync`):
  - `it('finds claude.exe on PATH')`; `it('finds an npm shim, claude.cmd, on PATH')`;
  - `it.each` of every one-shot engine by its install name as `<name>.exe` on PATH: `claude`, `codex`, `cursor-agent`,
    `opencode`, `pi`, `command-code`, `kilo`, `grok`;
  - `it('never takes cmd.exe for Command Code')` (a `cmd.exe` on PATH, no `command-code`) → null;
  - `it('finds Claude Code where its installer puts it, off PATH')` (`<home>/.local/bin/claude.exe`, empty PATH);
  - `it('takes a path override that names the program itself')` (`env.CLAUDE_PATH` = a `claude.exe` off PATH, restored
    after);
  - `it('off Windows looks as claudeNearby did')` (a `claude` with mode 0755 on PATH, `platform: process.platform`;
    skipped on win32).
  `oneshot.program.spec.ts`:
  - `it('off Windows, starts the command as it is')`: `oneShotProgram('claude', () => 'claude', ['-p'], { platform:
    'linux' })` → `{ file: 'claude', args: ['-p'] }`;
  - `it('on Windows, starts the claude.exe the lookup finds')`;
  - `it('on Windows, starts an npm shim as node on its script')`: Codex as npm installs it, `codex.cmd` with
    `lib/windows/fixtures/npm-codex.cmd`'s bytes, its `codex.js` and a `node.exe` on PATH → `{ file: <node.exe>, args:
    [<codex.js>, …] }`;
  - `it('on Windows, none found is ENGINE_NOT_INSTALLED')` (`errorKind(error)` is `'ENGINE_NOT_INSTALLED'`);
  - `it('on Windows, a batch file that is no npm shim is refused')` (`@echo off\r\nstart calc %*\r\n` as `claude.cmd`
    → `errorKind` `'WindowsProgramRefused'`);
  - `it('the warm worker on Windows spawns the program the lookup found, not claude')`: `vi.mock('./tied.js')` whose
    `spawnTied` records its call and throws; `process.platform` set to `'win32'` and restored (`Object.defineProperty`);
    `vi.stubEnv('PATH', dir)`, `vi.stubEnv('HOME', home)`, `vi.stubEnv('LOCALAPPDATA', …)`; `runRouterOneShot('claude',
    { prompt: 'p', cwd: dir })` rejects, and `spawnTied`'s first argument is `<dir>/claude.exe`. The same for
    `runGrokOneShot` with `grok.exe` (its `GROK_HOME` is under `vitest.setup.ts`'s throwaway HOME).
- [ ] **Step 2: Run to see them fail.** `npx vitest run src/lib/engineBin.nearby.spec.ts src/lib/oneshot.program.spec.ts`.
  Expected: FAIL (not exported). Commit (red).
- [ ] **Step 3: Implement** the Interfaces. Comment in `oneShotProgram` why: `spawn` with no shell on Windows finds
  neither an npm `.cmd` nor a `claude.exe` off PATH, so every one-shot engine failed with ENOENT and the voice router
  never had a warm worker there (spec item 3).
- [ ] **Step 4: Run** `npx vitest run src/lib/engineBin.nearby.spec.ts src/lib/oneshot.program.spec.ts
  src/lib/oneshot.spec.ts src/lib/oneshot.tied.spec.ts src/devices/claudePlugin.spec.ts src/lib/engineBin.spec.ts`, then
  `npm run typecheck` and `npx vitest run src/architecture.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(windows): one-shot workers start the engine the daemon finds, through windowsProgram`.

### Task 6: Orca's homes said once per change

**Files:** Modify `cli/src/devices/orcaHomes.ts` (`createOrcaHomesCache`, 214-216); Test `cli/src/devices/orcaHomes.spec.ts`.

**Depends on:** nothing. **Effort:** medium. **Failing test:** below.

**Interfaces:** none new: the cache logs its line only when it differs from the last line it logged.

- [ ] **Step 1: Change the tests.** `after 5 minutes it reads again, and says whether the list changed` expects
  `['… 2 claude · 1 codex', '… 1 claude · 2 codex']`; `a read that throws is failed` expects one `not read · failed` line
  after the first; new `it('says a line again once another came between: A, B, A')`.
- [ ] **Step 2: Run to see them fail.** `npx vitest run src/devices/orcaHomes.spec.ts`. Commit (red).
- [ ] **Step 3: Implement** with the last logged line kept in the cache's closure. Comment why: read every 5 minutes on
  a computer without Orca, the unchanged `not read · no orca` line filled the log (1059 lines in one log).
- [ ] **Step 4: Run** `npx vitest run src/devices/orcaHomes.spec.ts`, then `npx vitest run src/services/devices.spec.ts -t
  "the cache is built on this computer's orca"`. Expected: PASS (the devices spec still sees the first line).
- [ ] **Step 5: Commit** `fix(devices): Orca's homes line is said once per change`.

### Task 7: The silent-card rule in one place

**Files:** Modify `cli/src/lib/agentNotifications.ts`, `cli/src/cable/cableHost.ts` (line 1658),
`cli/src/device/deviceFleet.ts` (line 433); Test `cli/src/lib/agentNotifications.spec.ts`.

**Depends on:** nothing. **Effort:** medium. **Failing test:** the new function's test (no behavior changes).

**Interfaces:** Produces, beside `notNewsOf`: `export function silentCard(payload: { subagent?: unknown; restored?:
unknown }): boolean`: true for a sub-agent's turn end or a recap restored after its turn ended unseen.

- [ ] **Step 1: Write the test** `it('a card is silent for a sub-agent's turn end or a restored recap, never for a word that is not true')`:
  `{ subagent: true }`, `{ restored: true }` → true; `{}`, `{ subagent: 'true' }`, `{ restored: 1 }` → false.
- [ ] **Step 2: Run to see it fail.** `npx vitest run src/lib/agentNotifications.spec.ts`. Commit (red).
- [ ] **Step 3: Implement**, and both sites call it; their comments point at it.
- [ ] **Step 4: Run** `npx vitest run src/lib/agentNotifications.spec.ts src/cable/cableHost.spec.ts
  src/device/deviceFleet.spec.ts`. Expected: PASS, unchanged.
- [ ] **Step 5: Commit** `refactor(dial): one rule says whether a card is silent`.

### Task 8: End to end: a turn that goes on after an approved ask rings (#4620)

**Files:** Modify `cli/e2e/deviceNotify.e2e.ts` (a case, and a line in its header's list).

**Depends on:** nothing. **Effort:** high. **Failing test:** none: #4620 is on `main`, so the case passes at once. It is
shown not to be vacuous in Step 2. One commit.

- [ ] **Step 1: Write the case** `it('a Harness agent\'s turn that asks permission, is allowed on the dial and goes on rings when it ends')`:
  `fresh()`; a window (`LocalClient.connect`); `create(d, window, 'permit-rings')`; `plugged(desk)` and `listed(dial,
  id)`; `since = dial.messages.length`; `window.send('message', { agentId: id, content: '!permit printf hi' })`; the
  dial's `question` for the agent; `dial.send({ t: 'answer', agentId: id, requestId: question.id, answers: { [q]:
  'Yes' } })`; the dial's `question.close`, then its `summary` for the agent after `since`, which `toMatchObject({
  tier: 'alert' })` and has no `silent`; the pane holds `ran printf hi`.
- [ ] **Step 2: Show it can fail.** Put `this.cancelled(sessionId)` back at the end of `answered()` in
  `cli/src/lib/agentNotifications.ts` (what #4620 removed), run `npx vitest run --config vitest.e2e.config.ts
  e2e/deviceNotify.e2e.ts -t 'goes on rings'`: FAIL on the summary (`tier: 'silent'`, `silent: true`, or none). Then
  `git checkout -- src/lib/agentNotifications.ts`.
- [ ] **Step 3: Run** `npx vitest run --config vitest.e2e.config.ts e2e/deviceNotify.e2e.ts`. Expected: PASS, every case.
- [ ] **Step 4: Commit** `test(e2e): a turn that goes on after an approved ask rings when it ends (#4620)`.

### Task 9: windows-e2e for the Windows desk's imports

**Files:** Modify `scripts/ci-plan.py` (a `WINDOWS_DESK_PATHS` tuple beside `WINDOWS_SPECS`; `windows_e2e` returns true
for its paths), `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md` (the windows-e2e row of "The end-to-end
suites").

**Depends on:** nothing. **Effort:** high (the planner; two security reviews before merge). **Failing test:** below.

**Interfaces:** Produces `WINDOWS_DESK_PATHS`: the 20 files listed under "What this plan decides" (item 9), x64 alone
(not `windows_only`).

- [ ] **Step 1: Write the failing tests.**
  - `test_what_the_windows_desk_imports_runs_windows_end_to_end_on_x64_alone`: for `cli/src/testing/placeNode.ts`,
    `cli/e2e/harness/fakeDial.ts` and `cli/e2e/harness/daemon.ts`, `"windows-e2e" in planner.select([path])[0]` and
    `planner.e2e_plan([path], {"windows-e2e"})["windows_arm64"]` is false.
  - `test_the_windows_desk_imports_are_listed` (full checkout; `full_checkout(self, …)` as its neighbours): `run =
    imports_from(root, ["cli/scripts/windows-dial-e2e/desk.mts", "cli/e2e/dialWindowsTools.e2e.ts"],
    ("cli/e2e/harness/", "cli/src/testing/"))` minus the two sources; no path in `run` fails `planner.windows_e2e`; every
    `WINDOWS_DESK_PATHS` entry is in `run` (a stale entry fails) and is a file.
- [ ] **Step 2: Run to see them fail.** `python3 -m unittest scripts/tests/test_ci_plan.py -k windows_desk`. Commit (red).
- [ ] **Step 3: Implement**, with the comment the dial hosts' list has: what the desk bundle builds and runs, and
  test_ci_plan walks the imports. The doc's windows-e2e row names them ("and what the dial desk bundle imports from
  `cli/e2e/harness/` and `cli/src/testing/`, `WINDOWS_DESK_PATHS`").
- [ ] **Step 4: Run** `python3 -m unittest scripts/tests/test_ci_plan.py`. Expected: PASS.
- [ ] **Step 5: Commit** `ci: windows-e2e runs for what the Windows desk imports`.

### Task 10: Windows rules: Git Bash reads `current-node`; engines by their lookup

**Files:** Modify `docs/windows-rules.md`.

**Depends on:** 1, 5, 15 (the rules name their functions and tests). **Effort:** medium. **Failing test:** none (docs;
one commit).

- [ ] **Step 1: Write** two rules, each what happened (no log content), the rule, the test:
  - §3 Files: **A file Windows writes is read in Git Bash as Windows wrote it.** `current-node` holds `C:\…\node.exe`
    and a CRLF; `${x%/*}` cuts nothing from it, so every store package's `harness_node` failed under `set -e` where
    the computer's own Node was older (a customer's viewers, 2026-11), and the local AI packages' `node.sh` the same.
    Read through `_harness_node_dir` (`store/tools/runtimes.sh`) and, in the local AI packages, which carry no
    `runtimes.sh`, `local_ai_node_dir` (`store/tools/local-ai/toolchain/node.sh`). Test:
    `cli/src/lib/windows/gitBashNode.spec.ts`.
  - §2 Starting processes: **An engine is started by the program its lookup finds, never by its bare name.** `spawn`
    with no shell finds neither an npm `.cmd` nor a `claude.exe` off PATH: every one-shot worker failed with ENOENT.
    `engineNearby` (`lib/engineBin.ts`), then `windowsProgram`. Tests: `lib/engineBin.nearby.spec.ts`,
    `lib/oneshot.program.spec.ts`.
- [ ] **Step 2: Commit** `docs(windows): Git Bash reads current-node; engines start by their lookup`.

### Task 11: Rebase on `main` once `fix/win-hook-admission` has merged

**Files:** the branch. **Depends on:** Tasks 1-10 and 15, and `fix/win-hook-admission` merged to `main` (its worktree:
`/Users/nqhieu84/orca/workspaces/openharness/win-hook-admission`). **Effort:** high. **Failing test:** none.

- [ ] **Step 1:** `git fetch origin && git rebase origin/main`; resolve any conflict by keeping both changes (expected
  only in `cli/src/core/main.ts`, other hunks). Never force anything of `fix/win-hook-admission`'s back out.
- [ ] **Step 2:** `npm run typecheck`, and rerun each task's Step 4 command whose files the merge touched
  (`git diff --name-only <old base> origin/main` against the file list above).
- [ ] **Step 3:** note in the PR the lines Tasks 12-14 now point at (expected: `bind.ts` 647-648 unchanged, 968 → about
  975; `hermesTerminal.ts` 89 → about 87; `restoreAgents.ts` held branch 480-510 and starting-row branch 523-537 about
  one line down). Push only as the devcrew flow says.

### Task 12: Start markers through `startMarkerMs` in the core — GATED

**Files:** Modify `cli/src/core/agents/bind.ts` (`mayClaim`, lines 647-648; the process repair, line 968),
`cli/src/core/agents/hermesTerminal.ts` (line 89); Test `cli/src/core/agents/bind.spec.ts`. Line numbers are `main`
at `3d72dc8c68`; read them again after Task 11.

**Depends on:** 11. **Effort:** xhigh (which process may claim a session; repair on a platform it never ran on).
**Failing test:** below. Core files: 100% in `npm run test:core`.

**Interfaces:** Consumes `startMarkerMs(marker: string): number | null` from `lib/processProof.ts` (unchanged).

- [ ] **Step 1: Write the failing tests** in `bind.spec.ts`, with invented FILETIMEs (`w:133700000000000000` and one
  10 s later, `w:133700000100000000`):
  - `it('a later Windows process may claim a session an earlier one holds')`;
  - `it('an earlier Windows process may not claim a session a later one holds')`;
  - `it('repairs a Windows process from its start')`: `findLiveSession` is called with `startMarkerMs` of its marker.
    Today: never called (`Date.parse` is NaN).
- [ ] **Step 2: Run to see them fail.** `npx vitest run src/core/agents/bind.spec.ts`. Commit (red).
- [ ] **Step 3: Implement**: each site reads `startMarkerMs(marker ?? '') ?? NaN`, so an unreadable marker behaves as
  before. `hermesTerminal.ts:89` the same, for one way (it returns before on Windows; no new test).
- [ ] **Step 4: Run** `npx vitest run src/core/agents/bind.spec.ts src/core/agents/hermesTerminal.spec.ts` and `npx
  vitest run --config vitest.core.config.ts src/core/agents/bind.spec.ts src/core/agents/hermesTerminal.spec.ts
  --coverage.include=src/core/agents/bind.ts --coverage.include=src/core/agents/hermesTerminal.ts`. Expected: PASS, 100%.
- [ ] **Step 5: Commit** `fix(windows): process repair and session claims read a Windows start marker`.

### Task 13: Start markers through `startMarkerMs` in `lib/` — GATED

**Files:** Modify `cli/src/lib/captureResumeIdentity.ts` (56, 65), `cli/src/lib/closeAgentService.ts` (95, `age`),
`cli/src/lib/handoffDiscovery.ts` (68), `cli/src/lib/sessionSearch/externals/support.ts` (226, `listProcesses`); Test
`cli/src/lib/closeAgentService.spec.ts`, `cli/src/lib/handoffDiscovery.spec.ts`,
`cli/src/lib/sessionSearch/externals/support.spec.ts`.

**Depends on:** 11. **Effort:** high. **Failing test:** below. `captureResumeIdentity.ts`: 100% in `npm run test:resume`.

- [ ] **Step 1: Write the failing tests:**
  - `closeAgentService.spec.ts`: `it('a harness whose engine started after its row, by a Windows start marker, is young by that start')`;
  - `handoffDiscovery.spec.ts`: `it('looks for the session of a process with a Windows start marker')` (today:
    resolves null);
  - `support.spec.ts`: `it('gives a process with a Windows start marker its start')`: `listProcesses(async () => [{
    ...row, startMarker: 'w:133700000000000000' }])[0].started` is `startMarkerMs` of it (today: undefined).
- [ ] **Step 2: Run to see them fail.** `npx vitest run src/lib/closeAgentService.spec.ts src/lib/handoffDiscovery.spec.ts
  src/lib/sessionSearch/externals/support.spec.ts`. Commit (red).
- [ ] **Step 3: Implement** as Task 12 Step 3. `captureResumeIdentity.ts` for one way (its markers come from the
  `lstart` graph; no new test).
- [ ] **Step 4: Run** the Step 2 command and `npm run test:resume`. Expected: PASS, 100%.
- [ ] **Step 5: Commit** `fix(windows): every start marker is read through startMarkerMs`.

### Task 14: Held rows saved by 0.6.86 or older — GATED

**Files:** Modify `cli/src/lib/restoreAgents.ts` (the held branch, 480-510 at `3d72dc8c68`; read again after Task 11);
Test `cli/src/lib/restoreAgents.spec.ts`.

**Depends on:** 11. **Effort:** xhigh (persisted rows of older releases; never two engines). **Failing test:** below.

**Interfaces:** Produces, exported from `restoreAgents.ts`: `LEGACY_HELD_DETAILS: ReadonlySet<string>` (the two details
under "What this plan decides", item 5) and `legacyNativeHold(row: RegisteredSession): boolean`: `launch.state ===
'held'`, `service === 'native'`, a `nativeToken`, no `startsAgain`, no `sessionId`, and its detail in
`LEGACY_HELD_DETAILS`. Consumes `guardHold`, `DID_NOT_START`, `deps.startAgain`, `deps.waitingPane` as the
starting-row branch (523-537) uses them.

- [ ] **Step 1: Confirm the old shape** at the rebased head: `for t in $(git tag -l 'v0.6.*_cli'); do git grep -h -o
  "detail: '[^']*'" $t -- cli/src/lib/restoreAgents.ts 'cli/src/core/agents/*.ts' ':!*.spec.ts'; done | sort -u`
  against the same at `HEAD`, each candidate checked with `git grep -F` at `HEAD`: the set is the two details (both
  converted, orchestrator 2026-11-25).
- [ ] **Step 2: Write the failing tests** in `restoreAgents.spec.ts`, a row held as 0.6.86 saved it (native token, no
  session, no `startsAgain`, one of the details), with a `creationId`:
  - `it.each(LEGACY_HELD_DETAILS)('a held row 0.6.86 saved, its waiting pane alive and its own, starts again: %s')`:
    the row becomes `guardHold`'s launch, `startAgain` is called once, it is restored into its own pane
    (`paneCreates` 0), never skipped as `original native launch awaits recovery`;
  - `it('one with no creationId fails: DID_NOT_START')`;
  - `it('one whose pane is gone, or not its held shell, fails: DID_NOT_START')`;
  - `it('one whose pane cannot be read waits for the next pass')` (`unsurveyed`);
  - `it('a held row current code saves (newPane.ts: Waiting to confirm the native engine process…) is skipped as today')`.
- [ ] **Step 3: Run to see them fail.** `npx vitest run src/lib/restoreAgents.spec.ts -t "0.6.86"`. Commit (red).
- [ ] **Step 4: Implement** in the held branch, before the "awaits recovery" skip: a `legacyNativeHold` row is handled
  as the starting-row branch handles a guard hold (pane alive and `waitingPane === true`: `guardHold`, `setLaunch`, a
  failed one in `summary.failed` and the log line, else `startAgain` and into `missing` with `alive`), and as a held
  first launch whose pane went (`DID_NOT_START`); `waitingPane` undefined is `unsurveyed`. Comment why: #4604 bounds
  holds it marks itself; a row 0.6.86 saved has no `startsAgain`, and every pass skipped it on purpose, so it stayed
  held for good. From then on #4604's bounds apply (10 holds or 15 minutes, `heldLaunches.ts`, unchanged).
- [ ] **Step 5: Run** `npx vitest run src/lib/restoreAgents.spec.ts src/lib/restoreAgents.settle.spec.ts
  src/core/agents/heldLaunches.spec.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `fix(restore): a held row 0.6.86 saved starts again or fails, bounded`.

### Task 15: The local AI packages' `node.sh` reads a Windows `current-node`

Not gated: it runs once Task 1 is done.

**Files:** Modify `store/tools/local-ai/toolchain/node.sh` (the `else` branch that reads `current-node`); regenerate
`store/agents/{ollama,mlx-lm,vllm}/toolchain/node.sh` with `npm run build` in `store/tools/local-ai`; Test
`cli/src/lib/windows/gitBashNode.spec.ts` (Task 1's file: new cases in both of its `describe`s; its stand-in root may
be hoisted into a helper both use).

**Depends on:** 1 (its spec file and stand-in Git Bash). **Effort:** high. **Failing test:** the stand-in cases below,
on every host but Windows.

**Interfaces:** Consumes Task 1's stand-in root (`bin/` with `uname` printing `MINGW64_NT-10.0-26100`, an old `node`,
`cygpath`, `cat`, `tr`; HOME `<root>/c/Users/abcdef`) and its `_harness_node_dir` table of `current-node` forms.
Produces, in `node.sh`: `local_ai_node_dir RECORDED`, the same rule as `_harness_node_dir` (one trailing CR dropped; a
drive-letter path through `cygpath -u` when it is on PATH, else `/<drive in lower case>/<rest, \ as />`; then the
folder of the file it names), POSIX sh only, and calling no program for a path that is not drive-letter (the existing
`packaging.test.mjs` cases put only `cat` and `uname` on PATH). `LOCAL_AI_NODE` is `$dir/node` when executable, else
`$dir/node.exe`, through today's `>= 22` probe; the `miss Node.js 22 or newer …` line keeps its words.

- [ ] **Step 1: Write the failing tests** in `gitBashNode.spec.ts`. `NODE_SH` is
  `new URL('../../../../store/tools/local-ai/toolchain/node.sh', import.meta.url)`. In the stand-in `describe`, each
  case runs `/bin/sh -c '. "$1" && printf "%s" "$LOCAL_AI_NODE"' sh <NODE_SH>` with `env: { PATH: bin, HOME }` only;
  the old `node` answers any `-e` with exit 1; Harness's Node is a stub that answers any `-e` with exit 0, in
  `<HOME>/.harness/runtime/node-v22.12.0-win-x64/`, and `<HOME>/.harness/runtime/current-node` holds
  `C:\Users\abcdef\.harness\runtime\node-v22.12.0-win-x64\node.exe\r\n` (`uname` is not Linux, so `node.sh` reads
  `$HOME/.harness/runtime`).
  - `it('the local AI packages find Harness's Node through a CRLF backslash current-node when the node on PATH is too old')`:
    the stub named `node`; expect exit 0 and stdout `<runtime>/node-v22.12.0-win-x64/node`. Today: exit 1 and stderr
    contains `miss Node.js 22 or newer`.
  - `it('the local AI packages take node.exe when that is the file there')`: the stub named `node.exe` only; stdout
    `<…>/node-v22.12.0-win-x64/node.exe`.
  - `it.each` of `local_ai_node_dir` over the same forms and expected folders as `_harness_node_dir`'s table, no
    `cygpath` on PATH (one table, both functions).
  In the real Git Bash `describe`: `it('the local AI packages find Harness's Node there too')`: the same throwaway
  profile, runtime and older `node` first on PATH as Task 1's case; `findGitBash()`'s bash with `-c` `export
  ADAPTER_RUNTIME_DIR="$(cygpath -u "$RUNTIME_WIN")"; . "$(cygpath -u "$NODE_SH_WIN")" && "$LOCAL_AI_NODE" -v`; expect
  exit 0 and stdout `process.version`. 60 s timeout.
- [ ] **Step 2: Run to see them fail.** `npx vitest run src/lib/windows/gitBashNode.spec.ts`. Expected: Task 1's cases
  pass; the first new case fails with exit 1 and the `miss Node.js 22` line; the `local_ai_node_dir` cases fail (`not found`).
  Commit (red): `test(store): the local AI packages find Harness's Node through a Windows current-node`.
- [ ] **Step 3: Implement** `local_ai_node_dir` as the Interfaces block says and use it in the `current-node` branch.
  Comment why: Windows writes `current-node` as `C:\…\node.exe` with a CRLF, which `${x%/*}` cannot cut, so Ollama's,
  vLLM's and MLX-LM's viewer, setup and doctor stopped on a computer whose own Node is older (spec item 1); and why its
  own copy of the rule (these packages install alone and carry no `runtimes.sh`; `_harness_node_dir` is the same
  rule). Then `cd store/tools/local-ai && npm run build`; `git status --short store/agents/ollama store/agents/mlx-lm
  store/agents/vllm` lists the three `toolchain/node.sh` and nothing else (anything else is reverted with `git checkout
  --` and named in the task's report).
- [ ] **Step 4: Run** `npx vitest run src/lib/windows/gitBashNode.spec.ts`; from the root `node --test
  store/tools/local-ai/test/packaging.test.mjs` (the copies equal, the runtime-folder cases unchanged). Expected: PASS.
- [ ] **Step 5: Commit** `fix(store): the local AI packages read a Windows current-node`.

---

## Verification

1. **Item 8's end to end, locally, this Mac.** `cd cli && npx vitest run --config vitest.e2e.config.ts
   e2e/deviceNotify.e2e.ts`. Isolation is the e2e harness's (`e2e/harness/daemon.ts` `IsolatedDaemon`, cli/AGENTS.md
   rule 6): a throwaway root with its own HOME and data folder, a private tmux server under its own `TMUX_TMPDIR` with
   `TMUX`/`TMUX_PANE` unset, its own port (never 18473), the fake Claude Code engine, a stand-in dial on a desk file
   (`HARNESSD_TEST_DIAL_PORT`), signed out: no backend, no account. What a person sees: every case passes; the new one's
   summary is `tier: 'alert'` with no `silent`; Task 8 Step 2's run fails.
2. **linux-e2e, on the pull request, by path** (`scripts/ci-plan.py`): `cli/e2e/deviceNotify.e2e.ts` (modified,
   `linux_e2e_file`); and, because Task 6 changes `cli/src/devices/orcaHomes.ts` (in `LINUX_E2E_APP_EVAL_PATHS`), the six
   dial app eval files beside it. By hand only if a rerun is needed: Actions → CI → Run workflow, scope `linux-e2e`,
   `e2e_files cli/e2e/deviceNotify.e2e.ts`.
3. **windows-e2e, x64, on the pull request, by path:** selected by `cli/src/lib/windows/gitBashNode.spec.ts` (in
   `src/lib/windows/`), `cli/src/lib/engineBin.ts` (the module of `engineBin.pathEntries.spec.ts`),
   `cli/src/devices/claudePlugin.ts` and `cli/src/devices/orcaHomes.ts` (`cli/src/devices/`), `cli/src/cable/cableHost.ts`
   (`cli/src/cable/`). The arm64 leg is not selected (no Windows-only file: no file whose own name says `windows`, no
   `pty/`, no `windows.yml`). It runs the Windows CLI specs (`gitBashNode.spec.ts`'s real Git Bash cases, for
   `harness_node` and for the local AI packages' `node.sh`;
   `devices/claudePlugin.windows.real.spec.ts`, which runs `engineNearby` on real Windows), `dialWindows.e2e.ts`,
   `dialWindowsTools.e2e.ts` and the install check. By hand only if needed: `ci.yml` `workflow_dispatch`, scope
   `windows-e2e`.
4. **Windows VM, phase 4, on the orchestrator's turn** (`ssh admin@192.168.64.7`, UTM "Windows", Windows 11 ARM64; the
   Ubuntu VM suspended first: one VM at a time). Isolation: a temporary Standard user made for this run (for example
   `hxfix1125`), its own `%USERPROFILE%\.harness`, deleted with its profile at the end; nothing signed in anywhere (the
   daemon signed out: no backend, no account; engines not signed in). Setup as that user, after
   [docs/testing/windows-cli-e2e.md](../testing/windows-cli-e2e.md) "Setup recipe": Git for Windows (`winget install
   --id Git.Git -e`), the current Harness release from its public `install.ps1` (a download: its signed `node.exe` and
   terminal host), then this branch's CLI over it with `install.ps1 -Manifest` from `node
   scripts/windows-install-manifest.mjs` (`npm run build`'s `dist/`, the release's own pty folder, nodejs.org's win-arm64
   zip). Before the branch install, each check is run once on the release, which must show the bug (so the check is not
   vacuous).
   - **Item 1:** an older Node (nodejs.org's v20 win-arm64 zip, extracted in the profile) first on the user's PATH;
     `harness start`; an agent started (`harness new claude <folder>`, Claude Code from Anthropic's own installer, not
     signed in). Read the data folder's `harness.log`. On the release: `[dsh] autonomous/harness-monitor viewer exited 1 ·
     restarting in …`. On the branch: `[dsh] autonomous/harness-monitor viewer up on 127.0.0.1:<port>` and no
     `viewer exited 1`; `harness dsh doctor <a package whose doctor calls harness_node>` prints no `miss node >= …`;
     the Ollama package's doctor (`store/agents/ollama/toolchain/doctor.sh`, through `node.sh`; Task 15) prints no
     `miss Node.js 22 or newer` (on the release it does).
   - **Item 3:** Claude Code from its own installer (`%USERPROFILE%\.local\bin\claude.exe`, off PATH); the branch's desk
     in `--own-account` mode on the stand-in dial ([cli/scripts/windows-dial-e2e/README.md](../../cli/scripts/windows-dial-e2e/README.md):
     `node scripts/windows-dial-e2e/bundle.mjs <out>` on the Mac, `<out>` copied over, run through `console.ps1` and
     `run-desk.ps1` in the user's console session), with a Claude Code harness started in that daemon. On the release:
     `[router-pool] claude warm spawn failed (n): ENOENT`. On the branch: `[voice-route] router engine=claude …`, then
     `[router-pool] claude warm ready=1/1`, and no `warm spawn failed`. Windows rule 1: the visible windows of class
     `ConsoleWindowClass`, `CASCADIA_HOSTING_WINDOW_CLASS` and `PseudoConsoleWindow`, recorded every 40 ms in that console
     session through the warm spawn: none.
   - Clean-up: the desk's `quit`, `harness uninstall` for the user, the user and its profile deleted; nothing left in
     `C:\Users`.
5. **Local gates PR CI does not run**, from a clean tree at the final commit (after Tasks 12-14):
   `python3 scripts/local-checks.py --run` (preview: `python3 scripts/local-checks.py --list <changed paths>`). It
   selects `cli-core` (`npm run test:core`: Tasks 3, 4, 12) and `cli-resume` (`npm run test:resume`: Task 13); paste its
   fence into the pull request body before marking it ready (`process-checks` reads the receipts from the event).
   The store packages' own tests, which no PR check names, recorded in the pull request: `python3 -m unittest
   store/tools/test_runtimes.py`; `node store/tools/sync-runtimes.mjs --check` (no output); `node --test
   store/tools/sync-runtimes.test.mjs`; `node --test store/tools/local-ai/test/packaging.test.mjs` (Task 15: the three
   `node.sh` copies equal the source); in `store/agents/harness-monitor`, `node --import ./test/setup.mjs --test
   test/*.test.mjs`; each package test that sources its copy (`git grep -l "runtimes.sh" --
   'store/agents/*/toolchain/test_*.py'`, each with `python3 -m unittest`, and `node --test
   store/agents/marp/toolchain/test/scripts.test.mjs`). The planner: `python3 -m unittest scripts/tests/test_ci_plan.py`
   on this full checkout (`process-checks`' checkout is sparse; `cross-read-scan` runs the full-checkout tests on PR
   CI), and two independent security reviews of the `scripts/ci-plan.py` change before merge.
6. **Proposal (not added here):** a PR check for `store/tools/` (`python3 -m unittest store/tools/test_runtimes.py`,
   `node store/tools/sync-runtimes.mjs --check`, `node --test store/tools/*.test.mjs`, `node --test
   store/tools/local-ai/test/packaging.test.mjs`) selected by changes there, so the next `runtimes.sh` or `node.sh`
   change is tested on PR CI without a CLI spec.
7. **No check needs the user themselves:** no client change, the VM checks use a temporary test user, and what the dial
   is sent is asserted on the stand-in's frames.

## Open questions

None. The three earlier ones were answered by the orchestrator on 2026-11-25 (item 2: rule (b) plus the search for the
volatile part, Task 2; item 5: both details, Task 14; item 1: the local AI packages' `node.sh` in this pull request,
Task 15).
