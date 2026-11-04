# Windows parity: design and plan

## Why

The owner wants one thing: **everything Harness does on a Mac works on Windows**, and each piece is
proven on a real Windows PC before it is called done. Today several features refuse on Windows with
"not on Windows yet", which makes the Windows app feel unfinished.

## Goals

- Each row of the table below works on the Windows test PC, to its last real step.
- A feature that truly cannot run on some Windows machine says why and what to do instead.
- Each work package ships on its own, following AGENTS.md.

## Non-goals

- Mac chrome with no Windows meaning: traffic lights, the Dock count, the Local Network prompt, the
  keychain read, `DaemonOwnerGuard`. Windows already has its own version (window buttons, tray, credential
  files) or has no such problem.
- Linux gaps. Voice playback on Linux, for example, stays as it is.

## Anti-goals (a failure even if the feature "works")

- A Windows Buddy reading outside its folder with nothing enforcing the limit.
- A guest's agent running as the owner's account.
- A `Platform.isWindows` patch that hides a refusal without doing the work.
- Moving a published tag, or claiming a feature works from unit tests alone.

## Constraints

- Test PC: `DESKTOP-0TFH0OJ`, Windows 11 Pro, x64, Smart App Control on, WebView2 156 present. It cannot
  test Arm.
- AGENTS.md: PR CI once, `make merge-pr`, a Design section (below), local coverage gates recorded in the PR.
- Native plugins carry a cost: each new DLL ships in the Windows package and must be signed there. The
  release signs each zip's `.exe` and `.dll` (`sign-windows` in `release-desktop.yml`).

## Where Windows stands today

Read from the code on 2026-11-04.

| # | Feature | Windows today | Where | Package |
|---|---|---|---|---|
| 1 | Buddy | Built in #2979, not merged or released | `superTabs/callerPane.ts` | W0 |
| 2 | Team account's engine report | Never written: the reporter reads no config off Mac and Linux, though Windows has had Team accounts since 0.5.4. To confirm on the PC | `team/engines.ts:136` | W1 |
| 3 | Import an agent | Not offered | `super_tabs/import_agent_dialog.dart:28` | W1 |
| 4 | `harness team model` | Refused | `team/model.ts:123` | W1 |
| 5 | Image written to the OS clipboard by the CLI | "no clipboard writer" | `lib/osClipboard.ts:113` | W1 |
| 6 | Bringing the window forward when a device appears | Mac only | `screens/swarm_screen.dart:7460` | W1 |
| 7 | Signed native files on an updated PC | The PC still has `harness.exe` and `harness-launch.exe` from Oct 21, unsigned | `lib/updateCommand.ts` | W1 |
| 8 | Voice message plays in the chat | Opens the system player | `super_tabs/voice_bubble.dart:35` | W2 |
| 9 | Installing an engine | Refused: "install it, then try again" | `engines/kit/nativeInstall.ts:155`, `lib/engineLaunch.ts:1319` | W3 |
| 10 | Hermes hooks | None | `engines/nativeHooks.ts:43` | W3 |
| 11 | Web panes | Shows the URL instead | `widgets/web_pane_panel.dart:93` | W4 |
| 12 | OpenCode on Windows on Arm | Refused: its Arm build crashes | `lib/windows/launch.ts:74` | W5 |
| 13 | `hn` | Refused: 200 compile errors in 19 files | `tui/index.ts:104` | W6 |
| 14 | Sharing this computer with guests | Refused: "needs macOS or Linux" | `lib/guestHelperInstall.ts:130` | W7 |
| 15 | Buddy reading beyond its folder | No longer a gap: every Buddy runs with its owner's full rights (#2832) | | W8, dropped |

Checked and fine: dial and cable wake (`core/devicesWake.ts:139` has its own Windows path).
`harness team sign-in` refuses, but signing in from the Harness app works, so it stays.

## Work packages

Every package has the same finish line: code, tests, local gates, one PR, CI, merge, release, then the real
steps below on the test PC. A package is not done until those steps pass.

### W0: Buddy (built)

1. Merge #2979. Needs a review or the owner's merge (see Open items).
2. Release the CLI, deploy the backend.
3. Update the PC. Start a real Buddy on it in the autonomous-ai Swarm, send a message, read its reply.
4. After teammate PR #2975 lands, release Desktop 1.3.61, which carries #2947's UI as well.

### W1: Small Windows bugs (one PR)

- **Engine report.** Remove the platform check; `teamConfigFile` is already per platform. Check that
  `realEngineCheckDeps` finds the engines under `windowsTeamPaths`. *Proof: `harness team status` lists them.*
- **Import.** Add Windows to `superTabImportOffered` and fix what the real flow finds. *Proof: import an
  agent into a project on the PC, then message it.*
- **`team model`.** Write the Windows twin of its root script, through the admin prompt `team logs` already
  uses: connections and settings written under the Team home, with the same locked-down ACL as the rest of
  that home, then the Team task restarted. *Proof: a Team agent answers through the set model API.*
- **Clipboard.** Write the PNG with PowerShell in STA mode (`Windows.Forms.Clipboard.SetImage`), through the
  existing PowerShell query helper. *Proof: paste the image into another app on the PC.*
- **Window forward.** Use `window_manager` on Windows. *Proof: plug in a device and the window comes up.*
- **Signed files.** First find the cause: download the current release's payload, check its signature, and
  read which step would replace `harness.exe`. Likely cause, not yet proven: a signed rebuild with an
  unchanged version is treated as "nothing newer". Fix that step. *Proof: `harness update` on the PC, then
  `Get-AuthenticodeSignature` says Valid.*

### W2: Voice in the chat (one PR)

- Add `video_player_win` 3.3.1. It implements `video_player_platform_interface`, so `voice_bubble.dart` keeps
  using one controller. Remove Windows from the `_playsHere` exclusion.
- Clips are WAV (`voice_wav.dart`, `wavFromPcm16`), which Media Foundation plays with no extra codec.
- If the player fails to load, keep today's behavior of opening the file, so nothing gets worse.
- Spike first: `flutter pub get` and a Windows build. Its pubspec still says `sdk: ^2.17.0`, which the
  resolver should accept under Dart 3 but must be seen to.
- *Proof: a clip recorded on the Mac plays in the Windows chat with its progress moving; seek and speed work.*

### W3: Installing engines (one PR, maybe two)

Before: a missing engine stops the launch. After: Harness installs it, then starts the agent, as on a Mac.

- **Recipe.** Add `windows` to `EngineInstallRecipe` in `lib/engineInstall.ts`, either `{ npm: '<package>' }`
  or `{ powershell: '<vendor url>' }`. No entry means the launch refuses and names the vendor's page. The type
  stays exhaustive, so a new engine must decide.
- **Which engines.** npm today: Claude Code, Codex, Pi, Command Code, Kilo, Copilot. The others use
  `curl | bash` (Cursor, OpenCode, oh-my-pi, Hermes, Devin, Muse, Amp, Grok, Antigravity). For each, check the
  vendor's documented Windows install and run it on the PC. An engine with no official Windows install stays
  refused, by name. Hermes has one (`install.ps1`), so it has a hook runner too: its home on Windows is
  `%LOCALAPPDATA%\hermes`, and it splits a hook's line itself (`shlex.split(posix=False)`), as `cmd` quotes it.
- **Runner.** New `engines/kit/windowsInstall.ts`, with the same result shape as `createNativeInstallations`,
  whose evidence walks POSIX paths and cannot be reused. It takes:
  - one claim per engine, an exclusive-create file holding the pid and its `w:<FILETIME>` start marker, so a dead
    holder is recognised and a reused pid is not mistaken for it;
  - a hidden process running `npm.cmd` through `cmd`, Harness's Node on PATH, no window, output to a log. The
    same pattern as `windowsTeamEnginesScript`, tested there;
  - an 8 minute limit, then `taskkill /T`;
  - after it exits, `captureLaunchExecutable` is the only proof it worked.
- **Remove** the two refusals and the stale comment in `bootstrap/agent_prefetch.dart`. Desktop keeps
  installing on first use rather than prefetching.
- **Smart App Control.** It may block an unsigned engine `.exe`. The launch must then say so rather than hang.
  The test PC has it on, so this is seen for real.
- *Proof: on the PC, with an engine absent, `harness new` and the Desktop form install it, the agent starts and
  answers a prompt. Repeated for one engine of each kind, and for an engine that stays refused.*

### W4: Web panes (one PR)

- Add `webview_win_floating` 3.0.3. It implements `webview_flutter_platform_interface`, so `WebViewController`
  and `web_pane_panel.dart` stay one code path. It uses WebView2.
- It draws a real window above Flutter, as Linux's plugin does, so reuse `NativeWebViewHost`: extend its
  Linux check to Windows, so the pane hides while a menu or a dialog is open.
- Add `core/windows_webview_runtime.dart`, the twin of `LinuxWebViewRuntime`. Without WebView2 the pane falls
  back to the URL, as it does today. Update `webviewAvailable` and `store_demo_dialog.dart`.
- WebView2's data folder goes under `%LOCALAPPDATA%`, never beside the app in its install folder.
- **Rejected:** `webview_windows` (last release February 2024, its own interface); `webview_all_windows`
  (released yesterday, and the interface family already avoided on Linux, per `desktop/RELEASE.md`).
- **Spike first, because this decides the design:** a pane on the PC with a menu over it, a tab switch, pane
  drag and swap, resize, 150% display scale, minimize and restore. If the page reloads on each hide or
  it misplaces itself under scaling, fix it or swap the plugin before building more.
- **Scope (owner, 2026-11-04):** only the standard web view, the same `WebViewController` protocol the Mac uses,
  with no Windows-only web pane code beyond the host and the runtime check above. Making store apps and their agents
  run on Windows is not part of this.
- *Proof: a page opened in a pane beside its terminal, through every step above.*

### W5: OpenCode on Windows on Arm (one PR)

- First re-measure. The refusal came from OpenCode 1.19.3 and a newer Arm build may be fixed. If so, remove the
  refusal.
- If not, install and run the x64 build under Windows' emulation, and refuse only if that fails too.
- The test PC is x64, so this runs once on a `windows-11-arm` GitHub runner, with a pane reading the screen.
- *Proof: OpenCode answers a prompt there.* If the runner cannot show that, this package says so and stops.

### W6: `hn` (several PRs)

Measured: `cargo check` on the PC gives 200 errors in 19 files, 79 in `local.rs`. Mostly `std::os::unix`,
`libc`, `pre_exec` and file modes. **More will appear behind these**, because type checking stops early, and
this measure was on commit 831e22881, not current main.

1. **Transport.** `ipc.rs` and `daemon.rs` talk to the daemon over its named pipe with its token, as
   `lib/localTransport.ts` does.
2. **Local panes.** `local.rs` uses the ConPTY support already in the vendored `alacritty_terminal`
   (`tty/windows`). Signals, uids and modes each get a Windows meaning or a `cfg`.
3. **Shell.** `shell_integration.sh`, `shell_picker.rs` and `shell_context.rs` get PowerShell.
4. **Keep tmux behavior** identical on Mac and Linux. Their gates (`cargo test --locked`,
   `scripts/validate-tui-native.py`) must stay green.
5. **Ship.** A Windows target in `release-tui.yml`, signed like `pty-sign`; `tui/install.ts` learns Windows;
   the `tuiCommand` refusal goes.

*Proof: `hn` on the PC lists harnesses from every machine, attaches to one, splits a pane, and a local shell
runs in Windows Terminal, with the native gate run there.*

### W7: Guests (own spec first, then several PRs)

The Mac design is an OS account per guest and `sudo -n guest-helper`. Windows has no equivalent to sudo, and
this is a real security boundary, so **it gets its own spec and security review before any code.**

Proposed starting point, reusing the Team account's tested parts on Windows:

- One admin prompt to turn sharing on, which registers a fixed-verb task that creates and removes `hg_<hex>`
  accounts. It validates its input strictly, because it crosses a privilege boundary.
- Each guest gets a local account with a generated password, stored for the owner only (DPAPI). The owner's
  daemon starts a `harness-pty` host in that account, and its pipe's ACL admits the owner. This is needed
  because `CreateProcessWithLogonW` cannot attach a ConPTY directly, so **the host, not the engine, is what
  crosses accounts**.
- The daemon drives that host as one more terminal instance; `p<host>:%N` names already carry the instance.

**Spike first:** can one daemon drive panes on a second host in another account? If not, each guest needs their
own daemon, as the Team account has, and the design changes.

*Proof: a second person's account joins, runs an agent there, the agent cannot read the owner's home, and
removing the guest removes the account and its files.*

### W8: Dropped. A Windows Buddy reads as widely as a Mac's, in a real sandbox

**Dropped 2026-11-04.** Ken's decision of 11-04 (task #2832, docs/plans/2026-11-04-buddy-full-access-plan.md) gave every Buddy its owner's full rights on their own machine: no guard, no read-only folder, no sandbox, on a Mac too. Windows gets the same with nothing more to build. The rest of this section is what was designed before that, and is not in the code.

On a Mac, Claude Code's OS sandbox holds a wide Buddy's shell: no writes, a host list, closed folders. Claude Code has none on native Windows, so Harness runs that shell in one itself.

**Research, 2026-11-04.** Anthropic's `@anthropic-ai/sandbox-runtime` (Apache-2.0, the runtime behind Claude Code's sandbox) has a Windows build, marked alpha. Codex's preferred Windows sandbox has the same shape: dedicated low-privilege accounts, filesystem permissions and firewall rules.

| Needed, as on a Mac | How |
|---|---|
| Nothing can be written | A dedicated `srt-sandbox` account under a write-restricted token |
| Reads the person's files | A read and execute grant on the profile, for the sandbox group only |
| Passwords and sign-ins stay closed | The runtime's credential-store exclusions, plus Harness's own closed list through `profileExclude` |
| Only GitHub and the person's hosts | WFP filters on that account's SID block direct connections; a local proxy enforces `allowedDomains` |
| Harness's own commands still work | A wrapper set as `CLAUDE_CODE_SHELL_PREFIX` runs them outside, as `excludedCommands` does on a Mac |

**Chosen over:** AppContainer, whose network access is on or off with no host list; a low-integrity token, which cannot close folders without relabelling the person's files; Windows Sandbox, a separate VM with none of the person's files, tools or sign-ins (Codex rejected it for this reason too).

**Decisions:**
- The helper `srt-win.exe` has no Authenticode signature in the npm package, and Smart App Control would block it. Harness takes it from the package the lockfile pins by hash, and ships and signs it in the pty payload through the existing pipeline. The exact binary the runtime is tested with, and no Rust toolchain or second source to pin.
- The person sees one question in the Buddy bar, on the one Buddy on their own computer, in plain words, and can decline: the Buddy then stays in its folder, as now. On yes, Windows asks once, the person's home is opened for reading (the first time can take minutes, shown as it goes), and the Buddy starts again in the same chat.
- `harness uninstall` removes it, so nothing stays behind.
- Claude Code's own lines stay outside. Only the command runs inside: the rest of its line names the person's temporary folder, which stays closed. A hook line runs outside by its exact words, known at launch. A `harness` command runs outside only on its guard's one-use approval of its exact words (Claude Code quotes every apostrophe in a command, so another command cannot forge that line, measured on 2.1.318 on Windows and a Mac). Anything else runs inside.

**Must hold:**
- A Harness Team account is never in `sandbox-runtime-users`, and its privacy check proves it. The grant is on that group alone, so the privacy check's reads prove it too.
- The session's guard still judges every command first. It allows no program but its fixed reads, so the runtime's documented gaps that need code of its own (a token it derives, an anonymous thread) are behind the guard here, as on a Mac.
- `initialize()` runs for each command. A sandbox that cannot start refuses that command in one line and never runs it outside.

**Known limits, to design around:** the runtime is alpha. Tools using Windows' own TLS stack (Schannel) do not work inside: `System32\curl.exe`, `winget`, git's Schannel backend; Git for Windows is set to OpenSSL there. System DNS and SMB are not fenced. New top-level profile items need a refresh, which Harness runs at each Buddy launch.

**Proof:** from a real wide Buddy on the PC, it reads a file in the profile, cannot write one, cannot read `.ssh` or a browser's profile, reaches github.com and not another host, and `harness tell` still works.

## Order

W0, W1, W2, W3, W4, W5, W6, W7. Quick wins and the most-used features first; W3 is what a new Windows user hits
first, and W2 comes before it only because it is small. W7 is last because it is the biggest risk.

## Design

- **Growth:** W3's install logs and claims are one per engine and overwritten. W4's WebView2 data is cleared with
  the pane's data. W7's accounts are removed with the guest. Nothing else stores anything.
- **Concurrency:** W3 locks per engine with an exclusive-create file. W7's task runs one verb at a time. The rest
  hold no lock.
- **Read cost:** W3 and W7 read the process table only when a claim looks stale, using `harness-pty ps` (42–65 ms
  measured). W1's engine report keeps its existing schedule.
- **Scale:** The limits are one machine's, so 10x is not a server question. First warnings: W3's 8 minute limit;
  W4's memory, with one WebView2 process per pane, to be measured in its spike; W7 by guests per PC, limit to be set
  in its spec.
- **Compatibility:** An old CLI with a new Desktop keeps its old refusal. W3's recipe is only read on Windows.
  Mac and Linux behavior does not change; their existing tests prove that.
- **Migration and rollback:** Nothing migrates. A plugin rollback returns to the fallback. An engine installed
  through W3 stays installed. W7's rollback removes the accounts (in its spec).
- **Audience:** W7's guest limits are enforced by the OS account and the daemon's existing guest policy, never by
  the app. W0's Buddy check is on the server.
- **Identity:** W7 runs as the guest's own account, never the owner's. W1's Team writes go to the Team account's
  files only.
- **Failure:** Each path that fails says so: a blocked exe, a missing WebView2, a failed install, a refused engine.
  None falls silently back to "not installed".
- **Platforms:** Windows x64 tested on the PC. Arm through the runner in W5, and through CI builds elsewhere; **Arm
  is otherwise not tested for real.** macOS and Linux keep their gates.

## Risks

- `webview_win_floating` is one author's plugin. W4's spike is what decides it.
- W6 may be well past 200 errors once it compiles further.
- W7's spike could double its size.
- Vendors may have no Windows install for some engines, which leaves those refused, by name.

## Left to the builder

File layout inside each package, test names, and whether W3 needs two PRs.

## Open items

- **W0's merge:** the auto-mode classifier refused the merge as "Merge Without Review", because #2979 has no
  reviewer. The PR also asks for the review that made the 10-29 ruling. The owner, or a reviewer, must merge it.
