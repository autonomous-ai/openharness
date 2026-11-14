# Windows parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. The owner asked for no subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person on Windows can do everything a person on a Mac can, without learning anything Windows-specific about Harness.

**Architecture:** Fix each gap at its one cause and share the Mac's path. A Windows difference lives behind one helper, never in a screen.

**Tech Stack:** TypeScript CLI (vitest), Flutter Desktop, Rust (`serial/`, `tui/`).

**Spec:** `docs/superpowers/specs/2026-11-04-windows-parity-design.md`

## Global Constraints

- Signing is solved (Azure Artifact Signing since #2708); no task works on it.
- Web panes: the standard `WebViewController` only. Store apps and their agents are out of scope.
- Fewer branches, not more: a Windows fix replaces a special case wherever it can.
- macOS and Linux behavior does not change; their existing tests stay green.
- A commit or push runs only after its typecheck and tests passed, in that same command.
- No public release until the owner has seen Windows work. Test with `make release-desktop ARGS="--prepare"` and the CLI bundle on the PC. Other members release Mac and Linux.

## UX rules (every task obeys these)

The person is using Harness, not Windows administration. So:

1. **Same steps as a Mac.** No extra screen, setting or command exists because this is Windows.
2. **Windows words on Windows.** Never "this Mac", "macOS", "⌘", "System Settings", "brew" on a PC. Use the existing helpers (`thisComputerName`, `importComputerWord`, the keymap's labels).
3. **Harness does the work.** If Harness can install or fix it, there is a button, not instructions.
4. **Every wait says what it waits for.** One line, in plain words, naming the engine or device.
5. **Every failure says what happened and the one next step.** No error codes, paths, `ENOENT`, or "see the log" as the only words. A button when there is an action.
6. **Nothing silently does nothing.** A feature that cannot act says so where the person clicked.
7. **A person's work survives.** A failed install, a missing web view or a blocked program never loses a chat, a pane or a typed message.

## What a person sees

| Moment | Today on Windows | After |
|---|---|---|
| Picks an engine that isn't installed | Launch stops: "Installing engines is not supported on Windows yet: install it, then try again." | Same as a Mac: the row says it will install and shows the exact line, then "Installing Grok. The harness starts once it is installed." and the agent starts by itself |
| The install fails | Nothing to retry | "Grok could not be installed: <the installer's own last line>." with **Try again** |
| Windows blocks the program | A pane that closes, or a generic failure | "Windows blocked Grok: Smart App Control does not trust it. Choose another engine." |
| No Git for Windows | Setup scripts refuse with a URL | Harness installs it in the background, asking nothing. If that can't work, whatever needs Git says so with the link |
| Opens a web pane | Shows only a URL | The page, beside its terminal. Menus and dialogs show over it normally |
| Web pane without WebView2 | Shows only a URL | The URL, **Open in browser**, and "Install Microsoft Edge WebView2 to see it here." |
| Pastes an image into an agent | The file's path | The image, as on a Mac |
| Types `harness remote` in a tile | "runs inside a Harness terminal tile" | It works |
| Robots not found | "macOS is blocking Harness from your local network" with a Mac button | "Windows Firewall may be blocking Harness." with **Open firewall settings** |
| Notifications are off | "System Settings ▸ Notifications ▸ Harness" | "Settings ▸ System ▸ Notifications ▸ Harness" with **Open settings** |
| Dial turned while the app is behind others | Nothing | The window comes forward |
| Runs `hn` | "not available on Windows yet" | `hn` works |
| Offers this PC to guests | "Sharing this computer needs macOS or Linux." | Same form as a Mac, with one permission prompt |

## Review Focus

- Another account holding the configured port: every local command reaches the daemon (Task 1).
- An engine installer killed halfway, or the PC restarted during it: the next launch recovers and never waits forever (Task 5).
- Two windows asking for the same engine at once: one install, both start (Task 5).
- A Windows user name with a space or non-English letters: installs, hooks and helpers still work (Tasks 5, 3).
- A person who does nothing: no prompt, firewall dialog or console window appears by surprise (Tasks 5, 6, 7).

---

## PR A: one daemon record lookup (#2979)

### Task 1: One daemon record lookup (done)
`configuredPortOf` in `cli/src/lib/daemonRecord.ts`, used by `daemonPipe`, `daemonPipeNow`, `daemonFetch`, `localSocketPath`.

---

## PR B: everything a Windows person touches (`fix/windows-small-gaps`)

Done, committed locally: `harness remote`; image paste; window forward; time zone; standard web view.

### Task 5: Engines install themselves

**Files:**
- Create: `cli/src/engines/kit/windowsInstall.ts`, `cli/src/engines/kit/windowsInstall.spec.ts`
- Modify: `cli/src/lib/engineInstall.ts`, `cli/src/lib/engineInstall.spec.ts`, `cli/src/core/main.ts:2428`, `cli/src/backendSocket.ts:1199`, `cli/src/lib/engineLaunch.ts:1319`, `cli/src/engines/kit/nativeInstall.ts:155`, `cli/src/engines/nativeHooks.ts:44`, `desktop/lib/bootstrap/agent_prefetch.dart` (comment)

**Interfaces:**
- Produces: `readonly windows: WindowsInstall` on `EngineInstallRecipe`, required, so a new engine must decide.
- `type WindowsInstall = { npm: string; args?: readonly string[]; armArgs?: readonly string[] } | { powershell: string; programs: readonly string[] }`, `programs` relative to `%LOCALAPPDATA%` or, starting `~\`, the profile, without an extension.
- `windowsInstallLine(recipe, arch?): string`, the line a person is shown.
- `createWindowsInstallations({ directory, node?, spawn?, now?, alive? })`, returning the same `{ ensure, status }` as `createNativeInstallations`.

Each vendor's own Windows installer, checked 2026-11-04:

| Engine | `windows` | Where it lands |
|---|---|---|
| Claude Code | npm `@anthropic-ai/claude-code` | `~\.local\claude.cmd` |
| Codex | npm `@openai/codex` | `~\.local\codex.cmd` |
| OpenCode | npm `opencode-ai`, `armArgs: ['--cpu=x64']` | `~\.local\opencode.cmd` |
| Pi | npm `@earendil-works/pi-coding-agent`, `args: ['--ignore-scripts']` | `~\.local\pi.cmd` |
| Command Code | npm `command-code` | `~\.local\command-code.cmd` |
| Kilo | npm `@kilocode/cli` | `~\.local\kilo.cmd` |
| Copilot | npm `@github/copilot` | `~\.local\copilot.cmd` |
| Cursor | `https://cursor.com/install?win32=true` | `cursor-agent\cursor-agent.cmd` |
| oh-my-pi | `https://omp.sh/install.ps1` | `omp\omp.exe` |
| Hermes | `https://hermes-agent.nousresearch.com/install.ps1` | read from the installer in Step 1 |
| Devin | `https://cli.devin.ai/install.ps1` | `devin\cli\bin\devin.exe` |
| Muse | `https://dev.meta.ai/install.ps1` | `Programs\muse\muse.cmd` |
| Amp | `https://ampcode.com/install.ps1` | `~\.amp\bin\amp.exe` |
| Grok | `https://x.ai/cli/install.ps1` | `~\.grok\bin\grok.exe` |
| Antigravity | `https://antigravity.google/cli/install.ps1` | `agy\bin\agy.exe` |

- [ ] **Step 1: Run every installer on the PC, once, in a throwaway Windows account.** Record where the program lands, whether it asks a question or for administrator rights, and whether Smart App Control lets it run. Correct the table. An installer that asks a question gets the vendor's non-interactive flag.
- [ ] **Step 2: Write the failing recipe tests.** Every engine has `windows`; `engineInstallPaths` on Windows lists `~\.local\<name>` for npm engines and each `programs` entry; `windowsInstallLine` gives `npm install -g opencode-ai` and `irm https://omp.sh/install.ps1 | iex`; on arm64, OpenCode's line has `--cpu=x64`.
- [ ] **Step 3: Write the failing runner tests.**
  - `ensure` starts one install and says `running`; a second `ensure` starts none.
  - After a good exit, `ensure` is `complete`.
  - After a failed exit, the same request gets `failed` with the installer's last non-empty output line, and a new request (Try again) starts over.
  - A record whose pid is gone, or older than 21 minutes, is a dead install: `status` is `null` and `ensure` starts a new one.
  - Two callers racing the claim file: exactly one spawn.
  - The spawn has `windowsHide: true`, `detached: true`, and no stdin.
  - npm runs with Harness's Node first on PATH and `--prefix` set to `~\.local`.
  - PowerShell runs with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`.
- [ ] **Step 4: Run them and see them fail.** `npx vitest run src/engines/kit/windowsInstall.spec.ts src/lib/engineInstall.spec.ts`
- [ ] **Step 5: Implement.** Per engine, an exclusive-create claim file and one JSON record, `{ state: 'running' | 'done' | 'failed', pid, request, startedAt, detail }`. A small detached Node helper runs the installer, ends its tree with `taskkill /T /F` at 20 minutes, keeps output in a log beside the record, and writes the result. In `core/main.ts`, Windows uses this runner; the POSIX one stays untouched. `backendSocket.ts` sends `windowsInstallLine` on Windows. Remove both refusals. Hermes gets its hook runner.
- [ ] **Step 6: Run the tests and `npx tsc --noEmit -p .`; all pass.**
- [ ] **Step 7: Commit.**

### Task 6: Git for Windows, with no click at all (done)

`desktop/lib/bootstrap/windows_git_setup.dart`: where Git is missing, the app installs it once with `winget ... --scope user --silent`, in the background, which asks nothing. Without winget, or if it fails, Harness goes on, and whatever needs Git says so with the link.

### Task 7: Windows words, everywhere

**Files:** `desktop/lib/notify/system_notifications.dart:160,202,523`, `desktop/lib/settings/sections/terminal_section.dart:363`, `desktop/lib/devices/wifi_robots.dart:520-535`, `desktop/lib/autonomous_device/autonomous_device_cli.dart:24`, `cli/src/messages/tell.ts:104,108`, `cli/src/lib/autonomous-device/discovery.ts:14`. Create: `desktop/test/windows_words_test.dart`.

- [ ] **Test:** walk `desktop/lib` and fail on a string holding `this Mac`, `your Mac`, `macOS`, `⌘`, `System Settings` or `brew install`, unless the file is on a short list of Mac-only code (`core/process_responsibility.dart`, `core/browser_label.dart`), or the string sits behind a platform check on that line.
- [ ] Replace each with the helper. Each has its Windows sentence from the table above.
- [ ] `wifi_robots.dart`: on Windows the blocked text names Windows Firewall, and its button opens `ms-settings:windowsdefender`.
- [ ] `system_notifications.dart`: on Windows, **Open settings** opens `ms-settings:notifications`.
- [ ] Run the test; commit.

### Task 8: Blocked programs say so

**Files:** `cli/src/lib/windows/launch.ts`, `cli/src/engines/kit/launchExecutable.ts`, specs.

- [ ] Test: a probe or start failing with Windows' application-control error (`ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION`, 4551, or exit `0xC0E90002`) refuses with "Windows blocked <engine>: Smart App Control does not trust it. Choose another engine."
- [ ] Implement in the one place launches start a program. Run; commit.

### Task 9: A computer without WebView2 (done)

Windows 11 ships WebView2, and Windows Update brings it to Windows 10, so this is rare: the pane keeps **Open in browser** and says what would show it here.

### Task 11: A silent dial resets over its cable

**Files:** `serial/src/model.rs`, `serial/src/` port code and tests, `cli/src/cable/boardReset.ts`, `cli/src/cable/windowsSerial.ts`, specs.

- [ ] Test: `parse(["reset", "COM3"])` is `Command::Reset("COM3")`; `resetBoard` on win32 runs `harness-serial reset <port>` and is true on exit 0.
- [ ] Implement the same pulse as `boardReset.ts`: RTS high with DTR low 200 ms, then both low 200 ms. Run `cargo test` in `serial/` and the spec; commit.

### Task 12: Ship PR B

- [ ] Run affected tests, then push once, only if they pass. Wait for `ci/required`.
- [ ] `make release-desktop ARGS="--prepare"` for the signed Windows build.

### Task 13: The walk-through, as a person

On the PC, with the signed build and the CLI bundle, in order, one screenshot per row:

- [ ] Fresh account: open the app, sign in, reach New Harness with no typing beyond the sign-in.
- [ ] New Harness with Kilo absent: see the install line, click, see "Installing Kilo", the agent answers.
- [ ] Repeat with one PowerShell engine (Amp); then start one that fails, and use **Try again**.
- [ ] Web pane: a page beside a terminal; open a menu over it, a dialog over it, switch tabs, drag panes, resize, 150% display scale.
- [ ] Devices: the Wi-Fi list shows robots; pair one; plug in a dial, see it attach, unplug and replug.
- [ ] Paste an image into Claude Code. `harness remote` in a tile.
- [ ] Look for any Mac word, console flash, or surprise prompt. Each one found becomes a fix before this task is done.

---

## PR C onward: `hn`

### Task 14: `hn` on Windows

One PR per step. First rerun `cargo check` on current main on the PC for the true list.

- [ ] **Transport:** `tui/src/ipc.rs`, `daemon.rs` reach the daemon over its pipe with its token, as `cli/src/lib/localTransport.ts` does.
- [ ] **Local panes:** `tui/src/local.rs` on the vendored `alacritty_terminal`'s `tty/windows` ConPTY. Signals, uids and modes each get a Windows meaning or a `cfg`.
- [ ] **Shell:** `shell_integration.sh`, `shell_picker.rs`, `shell_context.rs` get PowerShell.
- [ ] **Same keys:** default keys and `~/.tmux.conf` behave as on a Mac. Mac and Linux gates (`cargo test --locked`, `scripts/validate-tui-native.py`) stay green at each PR.
- [ ] **Ship:** a Windows target in `.github/workflows/release-tui.yml`, signed like `pty-sign`; `cli/src/tui/install.ts` and `cli/scripts/install.ps1` install it; the `tuiCommand` refusal goes.

---

## Then: guests

### Task 15: Sharing this PC with guests

Its own spec first, because it is a security boundary. To the person it is the Mac's form and one permission prompt.

- [ ] Spike: can one daemon drive panes on a second `harness-pty` in another account? The answer sets the design.
- [ ] Write `docs/superpowers/specs/<date>-windows-guests-design.md` with the Design section and take it to security review, then its own plan.
