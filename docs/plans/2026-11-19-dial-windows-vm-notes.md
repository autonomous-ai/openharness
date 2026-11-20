# The dial on Windows — VM notes

What the VM showed, one section per task (plan: `2026-11-19-dial-windows-plan.md`, "The VM"). No account name, token or
personal path: a profile is written `<profile>`, `%LOCALAPPDATA%` is `<profile>\AppData\Local`, `%APPDATA%` is
`<profile>\AppData\Roaming`.

## Task 1

UTM Windows 11 ARM64, the owned test user made by `desktop-e2e.sh user-add`, apps installed for that user alone (no
machine-wide install, no sign-in to any app). Read 2026-11-20 over SSH as that user, which is session 0: nobody was
signed in at the VM's console, so nothing below was seen in a desktop a person would see. What needs that session is
marked **Open (console)**: the test user signed in at the console, then `desktop-e2e.sh session-on`.

**Contradicts the plan:**
- `orca.cmd` is not an Electron launcher. It forwards `%*` to a native `orca.exe` beside it, with no
  `ELECTRON_RUN_AS_NODE` and no script (section 1). Task 10's "its `.exe`, with the CLI script first" does not fit it.
- Claude Code's VS Code extension starts `claude` with the extension host's environment, which has no
  `VSCODE_GIT_ASKPASS_NODE`; only the integrated terminal has it (section 6). Task 30's variable names the editor for
  a session started in a terminal, not for one started from the extension's panel.

### 1. Launchers

All three files are in `cli/src/lib/windows/fixtures/`, byte for byte (CRLF), SHA-256 checked against the VM.

**VS Code** 1.147.0 (arm64), `<profile>\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd`, 189 bytes:

```bat
@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\Code.exe" "%~dp0..\8a14f0cc1b\resources\app\out\cli.js" %*
IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%
endlocal
```

- `.exe`: `%~dp0..\Code.exe` (its version resource names it `electron.exe` as the original file name).
- Script: `%~dp0..\8a14f0cc1b\resources\app\out\cli.js`. The app lives in a folder named by the build's commit
  prefix (`8a14f0cc1b`), so the script's path changes with every update; it exists on the VM.
- Beside it in `bin\`: `code` (a `sh` script for Git Bash and WSL), `code-tunnel.exe`, and `copilot-shim\`
  (`copilot`, `copilot.exe`).

**Cursor** 3.30.14 (arm64), `<profile>\AppData\Local\Programs\cursor\resources\app\bin\cursor.cmd`, 172 bytes:

```bat
@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\..\Cursor.exe" "%~dp0..\out\cli.js" %*
IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%
endlocal
```

- `.exe`: `%~dp0..\..\..\Cursor.exe` (the install root). Script: `%~dp0..\out\cli.js` (`resources\app\out\cli.js`,
  exists).
- Beside it: `cursor` (`sh`), `cursor-tunnel.exe`, `code-tunnel.exe`. `resources\app\codeBin\code.cmd` is the same 172
  bytes as `cursor.cmd` (a `code` that runs Cursor); `codeBin` is not on PATH.

**Orca** 1.4.263, `<profile>\AppData\Local\Programs\orca\resources\bin\orca.cmd`, 665 bytes:

```bat
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "LAUNCHER=%SCRIPT_DIR%orca.exe"

if not exist "%LAUNCHER%" (
  echo Unable to locate the native Orca CLI launcher at "%LAUNCHER%" 1>&2
  exit /b 1
)

REM Why: cmd.exe reparses %%* and can execute/truncate embedded newlines. The
REM native launcher is the supported path for orchestration message bodies.
if /I "%~1"=="orchestration" if /I "%~2"=="send" goto :unsafe_body
if /I "%~1"=="orchestration" if /I "%~2"=="reply" goto :unsafe_body

"%LAUNCHER%" %*
exit /b %ERRORLEVEL%

:unsafe_body
echo orca.cmd cannot safely forward orchestration message bodies. Use "%LAUNCHER%" instead. 1>&2
exit /b 2
```

- Not the Electron shape: no `ELECTRON_RUN_AS_NODE`, no script. It runs `%~dp0orca.exe` (`resources\bin\orca.exe`,
  389 KB, x64 under emulation, version 1.4.263) with the arguments as given; Orca's own comment names `orca.exe`
  as the supported path for message bodies, which `cmd.exe` would reparse. The app's window program is `<Orca>\Orca.exe` (x64).
- Beside it: `orca.exe`, `orca-agent-hook.exe`, `orca-administrator-restart.exe`.

### 2. Install folders and PATH

| App | Installed at (per user) | Machine-wide | On the user's PATH |
| --- | --- | --- | --- |
| VS Code (user setup, arm64) | `%LOCALAPPDATA%\Programs\Microsoft VS Code\` | none (`%ProgramFiles%\Microsoft VS Code` absent) | `…\Microsoft VS Code\bin` and `…\bin\copilot-shim`, added by the installer |
| Cursor (user setup, arm64) | `%LOCALAPPDATA%\Programs\cursor\` | none | `…\cursor\resources\app\bin`, added by the installer |
| Orca (`/S`) | `%LOCALAPPDATA%\Programs\orca\` | none | no: `resources\bin` is not added |
| herdr 0.9.5 (x64 build under emulation) | `<profile>\.herdr\packages\standalone\releases\0.9.5-x86_64-pc-windows-msvc\herdr.exe`; `…\standalone\current` and `%LOCALAPPDATA%\Programs\Herdr\bin` are junctions to that release | none | the release folder itself (not `current`, not `Programs\Herdr\bin`) |
| Warp v0.2026.11.11.08.17 (arm64, `/CURRENTUSER`) | `%LOCALAPPDATA%\Programs\Warp\` (`warp.exe`, `arm64\OpenConsole.exe`, `bin\oz.cmd`) | none | `…\Warp\bin` |
| WezTerm 20240203-110809-5046fc22 (x64) | its setup refuses a non-administrator ("You must be logged in as an administrator"), so the release zip was unpacked to `%LOCALAPPDATA%\Programs\WezTerm\` (`wezterm-gui.exe`, `wezterm.exe`, `wezterm-mux-server.exe`) | not installed | no |
| Alacritty 0.17.0 (x64) | the MSI is machine-wide, so the portable `.exe` was placed at `%LOCALAPPDATA%\Programs\Alacritty\alacritty.exe` | not installed | no |
| Claude app 0.14.10 (arm64) | **not installed**: `Add-AppxPackage Claude-arm64.msix` fails with `0x80073D19` ("a user was logged off"): an MSIX deploys only in an interactive logon. **Open (console)** | — | — |
| ChatGPT app | **not installed**: Microsoft Store only, no winget for this user, and an MSIX does not deploy over SSH (as above). **Open (console)** | — | — |

The HKCU uninstall entries name VS Code, Cursor, Orca and Warp (Orca's has no `InstallLocation`). Machine PATH holds
`C:\Program Files\nodejs\` and `C:\Program Files\Git\cmd`.

### 3. `claude` and `codex`

- `where claude`: nothing. Claude Code 2.1.328 (native installer) is `<profile>\.local\bin\claude.exe`, an arm64
  `.exe`; the installer did not put `.local\bin` on the user's PATH.
- `where codex`: `%APPDATA%\npm\codex` (`sh`), `%APPDATA%\npm\codex.cmd`. Codex 0.170.0 from npm. `codex.cmd` is
  the npm shim, byte for byte the repo's `fixtures/npm-codex.cmd` (SHA-256 `c54db675…`): it runs
  `node "%dp0%\node_modules\@openai\codex\bin\codex.js" %*` (`node.exe` beside the shim, else on PATH). `codex.ps1`
  beside it does the same. The package's own `.exe` is
  `node_modules\@openai\codex\node_modules\@openai\codex-win32-arm64\vendor\aarch64-pc-windows-msvc\bin\codex.exe`.

### 4. The ChatGPT app

**Open (console)**: not installed (section 2), so its program's name, whether it holds a `codex` of its own, and which
`codex` a thread started in it takes are not known. The stop condition is not decided either way.

### 5. Program names

`harness-pty` is not built on the VM, so these are the image names (`Get-Process`, which `harness-pty ps --json`
reads the same way) of what ran, and the `.exe` the install holds:

| App | Program | Seen running |
| --- | --- | --- |
| VS Code | `Code.exe` (9 processes, the extension host among them) | yes |
| Cursor | `Cursor.exe` (9 processes) | yes |
| Orca | `Orca.exe` (window); CLI `orca.exe` | CLI only |
| Warp | `warp.exe` | no |
| WezTerm | `wezterm-gui.exe` (the window), `wezterm.exe` (CLI) | no: `wezterm-gui.exe start` exits 1 in session 0 |
| Alacritty | `alacritty.exe` | no: exits 1 in session 0 |
| Claude app, ChatGPT app | not installed | — |

**Open (console)**: which process owns each app's visible top-level window. Session 0 shows none of them as visible.

### 6. Environment names

Read by a probe that prints names and the shape of each value (profile, digits and hex runs replaced).

**VS Code, integrated terminal** (a terminal opened by `createTerminal`, running the probe as its shell):

```
COLORTERM=truecolor
GIT_ASKPASS=<user data>\User\globalStorage\vscode.git\askpass\<hex>\askpass.sh
LANG=en_US.UTF-8
TERM_PROGRAM=vscode
TERM_PROGRAM_VERSION=<n>.<n>.<n>
VSCODE_GIT_ASKPASS_EXTRA_ARGS=
VSCODE_GIT_ASKPASS_MAIN=<user data>\User\globalStorage\vscode.git\askpass\<hex>\askpass-main.js
VSCODE_GIT_ASKPASS_NODE=<profile>\AppData\Local\Programs\Microsoft VS Code\Code.exe
VSCODE_GIT_IPC_HANDLE=\\.\pipe\vscode-git-<hex>-sock
VSCODE_NONCE=<uuid>
```

`VSCODE_GIT_ASKPASS_NODE` is the editor's own `.exe` (git is on the machine PATH, so the git extension is on).

**VS Code, extension host** (every extension's process, Claude Code's included):

```
ELECTRON_RUN_AS_NODE=1
VSCODE_CRASH_REPORTER_PROCESS_TYPE=extensionHost
VSCODE_CWD=<profile>
VSCODE_ESM_ENTRYPOINT=vs/workbench/api/node/extensionHostProcess
VSCODE_HANDLES_UNCAUGHT_ERRORS=true
VSCODE_IPC_HOOK=\\.\pipe\<hex>-<n>.<n>.<n>-main-sock
VSCODE_NLS_CONFIG={"userLocale":…,"defaultMessagesFile":"<install>\\<commit>\\…"}
VSCODE_NODE_COMPILE_CACHE_ROOT=<profile>\AppData\Local\Programs\Microsoft VS Code\<commit>\resources\app\node-compile-cache
VSCODE_PID=<n>
```

No `TERM_PROGRAM`, no `VSCODE_GIT_ASKPASS_*`. Its `process.execPath` is `…\Microsoft VS Code\Code.exe`.

**Claude Code's VS Code extension** (anthropic.claude-code 2.1.329, `win32-arm64`; it bundles
`resources\native-binary\claude.exe`): its spawn environment is the extension host's, then
`CLAUDE_CODE_ENTRYPOINT=claude-vscode` (and `CLAUDE_CONFIG_DIR` when configured), with `CLAUDECODE`,
`CLAUDE_CODE_CHILD_SESSION`, `TRACEPARENT` and `TRACESTATE` removed (read from its `extension.js`; its panel was not
opened). So a session started from the panel carries `VSCODE_PID`, `VSCODE_NODE_COMPILE_CACHE_ROOT` and
`VSCODE_NLS_CONFIG`, which point at the editor, but not `VSCODE_GIT_ASKPASS_NODE`.

**Cursor**: **Open (console)**. Started the same way in session 0, Cursor ran 9 processes for 180 s and its
extension host never ran the probe (most likely its first-run screen waits for a person).

**WezTerm, Warp, Alacritty**: **Open (console)**: none of them opened a terminal in session 0. From their source:
- Alacritty 0.17.0 (`94e7c88`) sets `TERM` (`alacritty` or `xterm-256color`) and `COLORTERM=truecolor`
  (`alacritty_terminal/src/tty/mod.rs` `setup_env`) on every platform, and `ALACRITTY_LOG=<%TEMP%>\Alacritty-<pid>.log`
  (`alacritty/src/logging.rs` `OnDemandLogFile::new`), which its shell inherits. `ALACRITTY_WINDOW_ID` and
  `ALACRITTY_SOCKET` are set on Unix only (`tty/unix.rs`, `polling/ipc.rs`). So on Windows the variable only Alacritty
  sets is `ALACRITTY_LOG`; to confirm in its shell.
- WezTerm's `WEZTERM_PANE` and Warp's `TERM_PROGRAM=WarpTerminal`: to confirm in their shells.

### 7. herdr

- `herdr --version`: `herdr 0.9.5` (the x64 build: the installer picks it on ARM64).
- The marker file: `%APPDATA%\herdr\herdr.sock` by default; `%XDG_CONFIG_HOME%\herdr\herdr.sock` when that is set
  (`HERDR_SOCKET_PATH`, when set, names it outright). A regular file of 24 bytes, `<server pid>:<unix time in ns>`,
  written after the pipe listens, removed by `herdr server stop`.
- The pipe: `\\.\pipe\` followed by the marker's whole path, unchanged:
  `\\.\pipe\<profile>\AppData\Roaming\herdr\herdr.sock` (default) and
  `\\.\pipe\<XDG_CONFIG_HOME>\herdr\herdr.sock`. The pipe list shows that name (with its `C:\`); none is left after
  `herdr server stop`.
- `agent.list` over that pipe, one NDJSON line from a Node `net.connect(pipe)` client, answered in both cases:
  `{"id":"probe-1","result":{"type":"agent_list","agents":[]}}`.
- The mapping, herdr `src/ipc.rs` at `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01` (tag `v0.9.5`; `interprocess`
  2.4.4, whose `GenericNamespaced` on Windows puts a name in `\\.\pipe\`):

  ```rust
  #[cfg(windows)]
  {
      use interprocess::local_socket::{prelude::*, GenericNamespaced};

      let name = path.to_string_lossy().to_string();
      let name = name.to_ns_name::<GenericNamespaced>()?;
      LocalStream::connect(name).map_err(crate::platform::local_server_connection_error)
  }
  ```

  `bind_local_listener` names the listener the same way, then `fs::write(path, windows_socket_marker())`. The marker's
  folder is `config_dir()` (`src/config/io.rs`: `XDG_CONFIG_HOME\herdr`, else `APPDATA\herdr`, else
  `USERPROFILE\AppData\Roaming\herdr`), and the file is `herdr.sock` (`src/session.rs` `api_socket_path_for`).

### 8. Link handlers (HKCU, read only)

- Right after the silent installs: `vscode`, `cursor`, `claude`, `codex` all absent.
- After VS Code and Cursor had each been started once: `HKCU\Software\Classes\vscode` and `…\cursor` exist, with
  `URL Protocol`; open is `"<install>\Code.exe" --open-url -- "%1"` and `"<install>\Cursor.exe" --open-url -- "%1"`.
  Warp registered `warp` at install (`"<install>\warp.exe" "%0"`). `claude` and `codex`: absent (no Claude app, no
  ChatGPT app).

### 9. Orca's plugin tools

`orca plugin test [dir] [--json]` ("Run a plugin's own tests on this machine, unsandboxed") and
`orca plugin check [dir] [--json]` ("Validate, then render each panel on this machine, unsandboxed") both exist in
Orca 1.4.263 for Windows (`orca.exe --help`).
