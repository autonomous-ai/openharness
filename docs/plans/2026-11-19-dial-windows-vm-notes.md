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

## Task 2

**Stop: mod runtime.** `$.http.fetch` refuses every named pipe as a `socketPath`, before it connects (section 1), so the
mod cannot reach the daemon's pipe or the devices' pipe at all. Tasks 15 and 16 do not start. HMAC-SHA256 is there only
built by hand over `crypto.subtle.digest` (section 2); that alone would not have stopped them.

**Contradicts the plan, beyond the stop:**
- Task 17: with no Git Bash, today's `PermissionRequest` hook makes Claude Code **deny the tool call**. Its command is a
  quoted path, which PowerShell prints and runs nothing. Claude Code reads exit 127 and logs `PermissionRequest command
  hook failed; blocking (no Git Bash)`. Every Write in that run was denied, and the model was told to install Git
  (section 4).
- Task 17: Windows PowerShell, the runner without Git Bash, takes 3-6 s to start on this VM. Inside Claude Code the
  hook timed out once at its 5 s timeout, and that was blocking too (section 4).
- Task 16: on Windows, `$.process.run` of a missing absolute path does not reject. It resolves with exit 1 and
  `The system cannot find the path specified.` on stderr, so the mod's `catch { continue }` never reaches `harness` on
  PATH (section 3).

Read 2026-11-20 on the UTM Windows 11 ARM64 VM (build 26200), as the owned test user over SSH (session 0). Nobody was
signed in at the console. The engines: Claude Code 2.1.328 (native, arm64) and Codex 0.170.0 (npm, arm64). Each ran
with the test key as "The VM" says: read from its file into the engine's own process, never on a command line. Each
had a throwaway `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in the profile. Claude Code ran as `claude -p` with two throwaway
mods (`--plugin-dir`, outside the repo, never committed). The stand-in daemon was
`cli/scripts/windows-pipe-test-server.ts`: the daemon's own authenticated pipe and a squatter, on a throwaway data
folder. It ran from this branch's `cli/`, copied to a throwaway folder (`npm ci --ignore-scripts`). Process chains come
from `harness-pty ps --json` (a build already on the VM). Every file was checked for the key before it was copied off;
none held it. The throwaway folders are removed; the key file and the test user stay.

### 1. `$.http.fetch` over the pipe

Every spelling of the stand-in's pipe was refused at once (2-6 ms), the same way:

```
t2probe: $.http.fetch: socketPath \\.\pipe\harness-<32 hex> refused: a network location is not reached from here
```

| `socketPath` | Answer |
| --- | --- |
| `\\.\pipe\harness-<id>` (the daemon's pipe), signed and unsigned, GET and POST with a JSON body | refused as above |
| the squatter's `\\.\pipe\harness-<id>` | refused as above |
| `\\.\pipe\harness-000…0` (nothing there) | refused as above |
| `//./pipe/harness-<id>` and `\\?\pipe\harness-<id>` | refused as above |
| `<profile>\…\none.sock` (a file-system path, nothing listening) | not refused: it tries an AF_UNIX connect, `FailedToOpenSocket` |
| no `socketPath`, `http://127.0.0.1:<the stand-in's loopback port>/api/status`, no auth header | reached: `404`, text `{"error":"NOT_FOUND"}` |

- The cause is Claude Code's own check on `socketPath`. It sits in the 2.1.329 binary's `socketPath` validator, and
  2.1.328 answers with the same words: an absolute path, no NUL, not "a network location", then "no Unix socket
  transport in this build". A `\\.\` or `\\?\` path counts as a network location. No setting or spelling gets past it.
- The runtime has an AF_UNIX transport on Windows: the file-system path was dialled. Node on Windows cannot serve one,
  though: `net.createServer().listen('<profile>\…\x.sock')` fails with `EACCES` (libuv takes a path as a pipe name).
- What an answer gives, seen on the loopback answer: `{ status, ok, headers, text }`, header names in lower case, the
  text whole. A pipe answer's `x-harness-proof` would be readable as `headers['x-harness-proof']`, if a pipe could be
  reached. No credential was sent over TCP.

### 2. HMAC-SHA256 and random bytes

- `crypto` holds `subtle`, `randomUUID` and `getRandomValues`. `crypto.subtle` holds `digest` alone: no `importKey`,
  no `sign`. No `process`, `require` or `Bun`.
- `node:crypto` cannot be imported. The module did not load at all: `cannot import "node:crypto" (from hooks\probe.js):
  a hooks module imports its own files by relative path and "claude-code", nothing else` (`claude plugin validate`
  says the same).
- HMAC-SHA256 built by RFC 2104 over `crypto.subtle.digest('SHA-256', …)` (64-byte block, `0x36`/`0x5c` pads) gives the
  `auth` and the `proof` of the first vector of `pipe-auth-vectors.json`, and of every other vector there.
- 16 random bytes: `crypto.getRandomValues(new Uint8Array(16))` gives 32 hex digits, a new value on each call.

### 3. Windows, the environment, processes and files, from the mod

- Telling it runs on Windows: `(await $.session.info()).platform === 'windows'`. `$.session.machine()` gives `sysname`
  `Windows_NT`, `machine` `arm64`.
- `$.env.get`: `USERPROFILE` and `HOME` are both `<profile>`. `APPDATA` is `<profile>\AppData\Roaming`.
  `CLAUDE_CONFIG_DIR` is the throwaway folder. Today's mod builds `${HOME}/.local/bin/harness`, which on Windows is
  `<profile>/.local/bin/harness`.
- `$.process.run`, no shell:
  - `[<absolute node.exe under Program Files>, '-e', …, 'one arg with spaces', "it's & 100%"]`: exit 0, and each
    argument arrives whole. The child's parent is `claude.exe` itself.
  - Bare `node` and `node.exe` are found on PATH. Bare `codex` (the npm `codex.cmd`) runs too.
  - An absolute `.cmd` runs, through `C:\WINDOWS\system32\cmd.exe /q /d /s /c "<file> ^"<arg>^""`.
  - A missing absolute path (`<profile>\.harness\bin\harness.exe`): resolves, exit 1, stderr
    `The system cannot find the path specified.` It does not reject.
  - A bare name not on PATH (`harness`): rejects, `ENOENT: Command 'harness' not found or is in an unsafe location
    (current directory)`.
- `$.fs.exists`: false for the missing launcher, true for `node.exe`.
- `$.fs.read`: `<CLAUDE_CONFIG_DIR>\settings.json`, the same path with forward slashes, and `<profile>\.claude\settings.json`
  all read.
- Whether `$.process.run` flashes a window: **Open (console)**.

### 4. How Claude Code runs a plugin's `command` hook

Both runs used the same throwaway plugin. It had `UserPromptSubmit` and `PermissionRequest` (`*`) hooks in each form,
and the prompt made the model call Write, which asked. `PermissionRequest` fires under `claude -p`; its stdin is about
600 bytes of JSON. The hook's process wrote its own chain from the process table.

**Git Bash installed** (`C:\Program Files\Git`, found by Claude Code's fixed path). The shell form, as today's hook
is written, runs under bash:

```
"C:\Program Files\Git\bin\bash.exe" -c "\"${CLAUDE_PLUGIN_ROOT}/hooks/asked\" perm-script"
  "C:\Program Files\Git\bin\..\usr\bin\bash.exe" -c "<the same>"
    "C:\Program Files\Git\usr\bin\sh.exe" C:/<…>/hooks/asked perm-script     (twice: MSYS's fork)
      "C:\Program Files\nodejs\node.exe" C:/<…>/hooks/chain.mjs perm-script
```

- Claude Code puts `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR` in the hook's environment with forward slashes
  (`C:/…`), and bash expands `${CLAUDE_PLUGIN_ROOT}` from it. Today's `asked`, a `#!/bin/sh` script with no extension,
  runs and exits 0. It looks in `$HOME/.local/bin`; under Git Bash `$HOME` is the profile.
- A failing hook does not block here.

**No Git Bash** (hidden from the test user alone by a deny entry on Git's `bin` folder and `bin\bash.exe`, removed
afterwards). Claude Code logged `Git Bash not found; BashTool will be unavailable`. The shell form runs under Windows
PowerShell (no PowerShell 7 is installed; Claude Code tries `pwsh` 7, then 7-preview, then this one, by fixed paths):

```
C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "node \"${env:CLAUDE_PLUGIN_ROOT}/hooks/chain.mjs\" ups-shell
; if (-not $?) { if ($LASTEXITCODE -eq 2) { exit 2 } }"
```

- Claude Code rewrites `${CLAUDE_PLUGIN_ROOT}` to `${env:CLAUDE_PLUGIN_ROOT}`, which holds backslashes here, and adds
  the second line. `"shell": "powershell"` on a hook gives this same line with Git Bash installed.
- `& "${CLAUDE_PLUGIN_ROOT}/hooks/chain.ps1" <arg>` runs the script.
- Today's hook, `"${CLAUDE_PLUGIN_ROOT}/hooks/asked"` (this branch's `plugins/harness-device`, loaded by itself),
  starts nothing: PowerShell prints the string, and Claude Code reads exit 127 (`status code 127`, stdout the path).
  Then `PermissionRequest command hook failed; blocking (no Git Bash)` and `Write tool permission denied`. The next
  call timed out at the hook's 5 s and was blocked the same way (`timed out; blocking (no Git Bash)`). The model was
  told: "blocking because Git Bash wasn't found, so only exit code 0 or 2 counts as this hook's verdict".
- The quoted path with an argument after it is a parse error (`Unexpected token`). That is exit 1, blocking as well.
- What blocks, as Claude Code 2.1.329's code reads: a `command` hook, not async, with no `args` and no
  `"onFailure": "continue"`, under PowerShell. The exec form is outside that rule. On this VM, exec-form
  `UserPromptSubmit` hooks that failed (below) did not stop the prompt; an exec-form `PermissionRequest` hook that
  fails was not tried.

**The exec form** (`"command"` and `"args"`) is taken in a plugin's `hooks.json` (validate lists it; it ran), with or
without Git Bash. No shell: Claude Code starts the program itself.

- `{"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/chain.mjs", "ups-exec"]}` runs as
  `node <profile>\…\mod/hooks/chain.mjs ups-exec`, a child of `claude.exe`. The placeholder is filled per argument
  with the backslash root. A bare `command` is found on PATH.
- Only `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are filled. `${HOME}`, `~`, `%USERPROFILE%` and `$HOME` arrive
  as written.
- `{"command": "powershell.exe", "args": ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
  "${CLAUDE_PLUGIN_ROOT}/hooks/chain.ps1", "exec-ps1"]}` runs, a child of `claude.exe`.
- A `.cmd` as `command` is not run (`spawn <root>/hooks/chain.cmd EINVAL`). Nor is the extensionless `sh` script
  (`failed to start`).

**Start times** of each runner doing nothing, five runs each, idle VM, timed around `Start-Process -Wait` (which adds
its own share):

| Runner | ms |
| --- | --- |
| `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "exit 0"` | 6053, 3047, 3029, 4107, 3051 |
| Git Bash `bash.exe -c true` | 2352, 1020, 1035, 1109, 1026 |
| `node.exe -e 0` | 1145, 1016, 1096, 1092, 1097 |

Under Claude Code, the `PermissionRequest` hooks took 0.6-1.3 s in the exec form (`node`), 1.8 s through Git Bash, and
3.8-14.6 s through PowerShell. The PowerShell runs had a second hook beside them.

Whether a hook flashes a window, in either case: **Open (console)**.

### 5. How Codex runs a hook

Codex 0.170.0 `exec` ran from a throwaway `CODEX_HOME`. Its `config.toml` names an OpenRouter `model_provider`
(`env_key = "OPENROUTER_API_KEY"`, the variable's name only; `wire_api = "responses"`). Its `hooks.json` holds a
`SessionStart` (`startup`) hook and a `UserPromptSubmit` hook, each the line Harness writes for PowerShell
(`& '<node.exe>' '<script>' <tag>`). Both are recorded as reviewed in `[hooks.state."<hooks.json>:<event>:0:0"]
trusted_hash`, by `engines/kit/hookReview.ts`'s formula. Both ran:

```
"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "& 'C:\Program Files\nodejs\node.exe' '<profile>\…\chain.mjs' codex-start"
  parent: <profile>\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-arm64\vendor\aarch64-pc-windows-msvc\bin\codex.exe exec …
    parent: "node" "<profile>\AppData\Roaming\npm\\node_modules\@openai\codex\bin\codex.js" exec …
      parent: C:\WINDOWS\system32\cmd.exe /c ""<profile>\AppData\Roaming\npm\codex.cmd" exec …"
```

For Task 31, the hook's caller chain is: the hook's program, `powershell.exe -NoProfile -Command`, then `codex.exe`.
`codex.exe` is the long-lived engine, two steps up from the hook's program. The npm shim's `node.exe` and `cmd.exe`
sit above it. This matches `codex/hookContract.ts`'s `win32Runner: 'powershell'`.

### 6. Models, and the key

- The cheap model, for both engines: `deepseek/deepseek-v4.1-flash`. This key's guardrails refuse Anthropic's models
  (`anthropic/claude-haiku-4.5` answered `400 … Model blocked by guardrail`). Claude Code warned
  `[claude-code:unrecognized_model]` on stderr and ran.
- `findstr /L /M /G:<the key file> <these notes>` prints nothing. The search reads the key from its file.
