# Windows parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. The owner asked for no subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything Harness does on a Mac works on Windows, proven on the released, signed build.

**Architecture:** Fix each gap at its one cause and share code with the Mac path. One PR per group, each released, then tested on the Windows PC with the released version.

**Tech Stack:** TypeScript CLI (vitest), Flutter Desktop, Rust (`serial/`, `tui/`).

**Spec:** `docs/superpowers/specs/2026-11-04-windows-parity-design.md`

## Global Constraints

- Signing is solved (Azure Artifact Signing since #2708); no task works on it.
- Web panes: the standard `WebViewController` only. Store apps and their agents are out of scope.
- Fewer branches, not more: a Windows fix replaces a special case wherever it can.
- macOS and Linux behavior does not change; their existing tests stay green.
- PR CI once per push. `make merge-pr`. Local gates recorded in the PR. Design section in the PR.
- Proof is the released build on `DESKTOP-0TFH0OJ`, to the last real step.

## Review Focus

- A PC with a Team account holding the configured port: every local command must reach the daemon on its given port (Task 1).
- A Buddy naming another drive or a drive-relative path: refused (Task 2).
- A Swarm agent pushing on Windows: git asks `harness git-credential`, and it must find the agent's pane (Task 3).
- A PC without Git for Windows: a Buddy must not start with its guard unable to run (Task 4).
- An engine installer killed halfway: the next launch recovers and does not wait forever (Task 13).

---

## PR A: finish Buddy and Swarm reach (added to #2979)

### Task 1: One daemon record lookup

**Files:** Modify `cli/src/lib/daemonRecord.ts`, `cli/src/lib/windows/daemonPipe.ts`, `cli/src/lib/localTransport.ts`, `cli/src/lib/localSocket.ts:83`. Test `cli/src/lib/daemonRecord.spec.ts`, `cli/src/lib/windows/daemonPipe.spec.ts`.

**Produces:** `configuredPortOf(dataDir: string, port: number, platform?: NodeJS.Platform): number`, the name a daemon serving `port` was recorded under, or `port` when there is none.

- [ ] Test: with only `daemon-18473.json` saying port 55332, `configuredPortOf(dir, 55332)` is 18473 and `configuredPortOf(dir, 18473)` is 18473.
- [ ] Test: `daemonPipe(dir, 55332, alive)` returns the recorded pipe and token. Run it and see both fail.
- [ ] Add `configuredPortOf`; use it in `daemonPipe`, `daemonPipeNow`, `daemonFetch` and the pipe path in `localSocket.ts`. Delete `recordServing`. `localSocketRoute`'s own scan stays: it checks that a socket exists, and the Mac must not change.
- [ ] Run `npx vitest run src/lib/daemonRecord.spec.ts src/lib/windows/daemonPipe.spec.ts src/lib/localTransport.spec.ts src/lib/localSocket.spec.ts`; all pass.
- [ ] On the PC, with a dev bundle: `harness autonomous-device status`, `list` and `discover --json` answer.

### Task 2: Guard refuses drive paths

**Files:** Modify `cli/src/lib/buddyGuard.ts:413`. Test `cli/src/lib/buddyGuard.spec.ts`.

- [ ] Test the generated guard's `outward`: on Windows, `C:secret.txt`, `D:x`, `C:` and `--file=D:x` are outward; `a.txt`, `HEAD:src/x` and `main..HEAD` are not.
- [ ] Add it to `outward`, only when `process.platform === 'win32'`: a word or its part after `=` starting with a drive letter and colon. `%NAME%` needs nothing: Git Bash does not expand it.
- [ ] Rerun `guard/run.cjs` on the PC: 43 cases, 0 wrong.

### Task 3: Pane names on Windows

**Files:** Modify `cli/src/superTabs/gitCredential.ts:70,81`, `cli/src/cli.ts:2849`. Test `cli/src/superTabs/gitCredential.spec.ts`.

- [ ] Test: with `HARNESS_PANE=p2:%3` and a frame on that pty pane, `get` asks for that agent's token. See it fail.
- [ ] Use `sendPane(process.env)` in both `gitCredential` lines and in `case 'mcp'`, with the `inPane` form `mcp-servers` uses.
- [ ] Run the spec; passes.

### Task 4: No Buddy without Git Bash

**Files:** Modify `cli/src/lib/swarmSkills.ts` (`prepareSwarmSkill`), using the lookup in `cli/src/dsh/shell.ts`. Test `cli/src/lib/swarmSkills.spec.ts`.

- [ ] Test: on win32 with no Git Bash, preparing a Buddy skill throws a sentence saying a Buddy needs Git for Windows. See it fail.
- [ ] Add the check, for Buddy skills only, with an injected lookup for tests.
- [ ] Run the spec; passes.

### Task 5: Ship PR A

- [ ] Run `test:portability`, `test:core`, `test:super-tabs`; record them in the PR. Push once. Wait for `ci/required`.
- [ ] Merge, release the CLI, deploy the backend.
- [ ] Update the PC to the release. Start a real Buddy on it in the autonomous-ai Swarm, message it, read its reply.
- [ ] From a real Swarm pane on the PC: `harness git-credential` answers for a task's repository.
- [ ] `Get-AuthenticodeSignature` on the installed `harness.exe` says Valid. Only if not, find why `harness update` left it.

---

## PR B: small Windows bugs

### Task 6: Team engine report

**Files:** `cli/src/team/engines.ts:136`, spec beside it. Remove the platform check; test that a win32 Team config reports. *Proof: `harness team status` lists engines.*

### Task 7: Import an agent

**Files:** `desktop/lib/super_tabs/import_agent_dialog.dart:28`, its test. Offer on Windows. *Proof: import an agent on the PC and message it.*

### Task 8: `harness team model`

**Files:** `cli/src/team/model.ts:123`, `cli/src/team/windowsScript.ts`, specs. Add `windowsTeamModelScript(input): string`, the twin of the root script, through the existing admin prompt. *Proof: a Team agent answers through the set API.*

### Task 9: `harness remote`

**Files:** `cli/src/cli.ts:3017`, `cli/src/remoteCommand.ts:290`, `cli/src/lib/terminalHandoff.ts`, `cli/src/backendSocket.ts:1166`, specs. Take `sendPane(process.env)`; accept the pty pane form in `HANDOFF_PANE_RE`. *Proof: a Windows tile switches machine.*

### Task 10: Board reset

**Files:** `serial/src/model.rs`, `serial/src/` port code, `cli/src/cable/boardReset.ts`, `cli/src/cable/windowsSerial.ts`, tests. Add a `reset <COM>` verb with the same pulse (`RTS` 200 ms, then both low 200 ms). *Proof: needs a dial on the PC; the owner plugs one in.*

### Task 11: Clipboard, window forward, time zone

**Files:** `cli/src/lib/osClipboard.ts:113`, `desktop/lib/screens/swarm_screen.dart:7460`, `desktop/lib/super_tabs/local_time_zone_native.dart`, tests.
- `writeWindowsClipboard(pngPath)` through PowerShell in STA mode.
- Window forward through `window_manager`.
- Time zone: `DateTime.now().timeZoneName` mapped to IANA by a const table from CLDR `windowsZones`. A name not in it stays null.

*Proof: each seen on the PC.*

---

## PR C: voice

### Task 12: Voice plays in the chat

**Files:** `desktop/pubspec.yaml`, `desktop/lib/super_tabs/voice_bubble.dart:35`, `desktop/THIRD_PARTY` notices, test.
- [ ] Add `video_player_win: 3.3.1`; build on the PC. A failed build stops here and picks another player.
- [ ] Remove Windows from `_playsHere`. A load failure opens the file, as today.
- [ ] *Proof: a real clip plays on the released build.*

---

## PR D: installing engines

### Task 13: Install on Windows

**Files:** Create `cli/src/engines/kit/windowsInstall.ts`. Modify `cli/src/lib/engineInstall.ts`, `cli/src/engines/kit/nativeInstall.ts:155`, `cli/src/lib/engineLaunch.ts:1319`, `desktop/lib/bootstrap/agent_prefetch.dart` comment. Specs beside each.

**Produces:** `windows?: { npm: string } | { powershell: string }` on `EngineInstallRecipe`; `createWindowsInstallations(...)` with the same result shape as `createNativeInstallations`.

- [ ] Test: two launches of one engine run one install; a claim whose holder is dead (pid gone, or a later `w:<FILETIME>`) is taken over; a timeout ends the tree and reports; a finished install is only believed through `captureLaunchExecutable`.
- [ ] Implement per the spec's W3.
- [ ] Fill in `windows` per engine from each vendor's documented install, run on the PC. None documented stays refused, by name.
- [ ] *Proof on the released build: with an engine absent, `harness new` and the Desktop form install it, and the agent answers.*

---

## PR E: web panes

### Task 14: Standard web view

**Files:** `desktop/pubspec.yaml`, create `desktop/lib/core/windows_webview_runtime.dart`, modify `desktop/lib/widgets/native_webview_host.dart:20`, `desktop/lib/widgets/web_pane_panel.dart:93`, `desktop/lib/store/store_demo_dialog.dart:81`, `desktop/lib/main.dart:23`, tests.
- [ ] Add `webview_win_floating: 3.0.3`; on the PC, open a page and test a menu over it, tab switch, drag, resize, 150% scale, minimize. A failure here changes the plugin before anything else.
- [ ] Merge the Linux and Windows runtime checks into one `NativeWebViewRuntime`, so there is one check, not two.
- [ ] `NativeWebViewHost` covers both platforms.
- [ ] *Proof on the released build: a page in a pane beside its terminal.*

---

## PR F: OpenCode on Arm

### Task 15: OpenCode on Windows on Arm

**Files:** `cli/src/lib/windows/launch.ts:74`, spec, one manual run on a `windows-11-arm` runner. Re-measure the current Arm build; if it runs, remove the refusal; if not, run the x64 build under emulation. *Proof: it answers a prompt there.*

---

## PR G onward: `hn`

### Task 16: `hn` compiles and ships on Windows

Per the spec's W6, one PR per step: transport, local panes, shell, ship. Start by rerunning `cargo check` on current main for the true error list, on the PC. Mac and Linux gates stay green at each PR. *Proof: `hn` on the PC lists every machine's harnesses, attaches, and splits.*

---

## Then: guests

### Task 17: Guest sharing spec

Write `docs/superpowers/specs/<date>-windows-guests-design.md` after the spike: can one daemon drive panes on a second `harness-pty` in another account? It goes to security review before any code, then gets its own plan.
