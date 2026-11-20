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

## Task 15

**Follow.** `$.process.spawn` is there in Claude Code 2.1.328 and streams: each piece arrives 2-30 ms after the child
wrote it, a second apart, all before the child exits (section 1). The follow form that landed in
`cli/src/deviceClaude/inbox.ts` stands.

**The child neither sees its parent gone nor fails a write within 30 s, when it writes nothing in that time.** On
Windows, leaving the loop kills nothing. The spawned `node.exe parent.js` (a direct child of `claude.exe`) and its
child both still ran 5 s and 30 s later, and the parent check said "alive" every time. What leaving the loop does is
close Claude Code's end of the stdout pipe, 2-3 s later. From then on the child's next write fails with `EPIPE`, at
once, even 37 s later (section 2). So the follower does not end by `parentAlive()`: `harness.exe` waits on `node.exe`
and is never killed. It ends at its next write (step 6), which comes when its held poll answers (at most 30 s) or after
step 5's 60 s wait. Until then its poll stays held in the core, unless a newer poll for the session replaces it, and a
text the core hands to that hold is written into the closed pipe and lost. `inbox.ts`'s header says Claude Code ends
the loop by killing `harness.exe`; on Windows it does not.

Read 2026-11-20 on the UTM Windows 11 ARM64 VM (build 26200), as the owned test user over SSH (session 0), as Task 2
ran. Claude Code 2.1.328 (`$.session.version()`: base 2.1.328, built 2026-11-18), by `<profile>\.local\bin\claude.exe`,
not upgraded. It ran with the test key as "The VM" says: read from its file into the starting PowerShell's own
environment, never on a command line. The model was `deepseek/deepseek-v4.1-flash`, with a throwaway `CLAUDE_CONFIG_DIR`
in the profile. `claude -p` loaded a throwaway mod by `--plugin-dir` (outside the repo, never committed);
`claude plugin validate` passed it. Its `session.start` hook ran the checks in turn, then held the session open 45 s
with a `$.process.run` of a sleeping `node.exe`, so the 30 s look below came while the session still ran. The children
were `C:\Program Files\nodejs\node.exe` (v24.20.0). The process table came from `harness-pty ps --json`, the VM's own
release build at `C:\work\oh\pty\target\release\harness-pty.exe` (`version`: 0.1.0, protocol 2; built 2026-10-17 from an
older tree, not this branch). Four runs: one to try, then three with the parent and child logging more. They were
`write` (the child writes a line a second), `quiet` (it writes only the three lines the mod reads) and `late` (quiet,
then writing again from its 40th line). Every file was checked for the key before it was read off the VM; none held it.
The throwaway folder (mod, config, scripts, logs) is removed; the key file, the test user and the apps stay.

### 1. Is it there, and does it stream

- `typeof $.process.spawn` cannot be asked: `claude plugin validate` refuses `$.process.spawn` read as a value ("used as
  a value … instead of called"). The call answers instead. It returns an async generator (`next` a function, `result`
  an object), and the validator lists `$.process.spawn` among the module's calls. Which release first had it is not
  known from here: the VM has only 2.1.328, and it has it.
- `$.process.spawn({ argv: [<node.exe>, '-e', <a line a second, five times; the exit time on stderr>] })`, with
  `$.clock.now()` taken at each piece. One run's times, in ms after the child's own timestamp in the line:

  | Piece | Arrived |
  | --- | --- |
  | stdout `line 1` | +30 |
  | stdout `line 2` | +6 |
  | stdout `line 3` | +8 |
  | stdout `line 4` | +5 |
  | stdout `line 5` | +4 |
  | stderr `exit` | +4 |

  The stream then returned `{ code: 0, signal: null }`, 30 ms after the last piece. The four runs were the same: 2-30 ms
  late, about 1 s apart. Each piece was one whole line as the child wrote it, and stderr came as pieces of its own.
- In section 2's check the first piece came 190-250 ms after the call, through two `node.exe` starts.

### 2. A parent and its child, after the loop is left

`$.process.spawn` of `node.exe parent.js`. The parent starts `node.exe child.js` with `stdio: 'inherit'` and waits on it
(`spawnSync`), as `harness.exe` starts `node.exe` (`pty/src/command.rs` `run_resolved`). The parent's own parent was
`claude.exe` itself. The child wrote its pid, then a line a second, checked `process.kill(process.ppid, 0)` before each
line and every 100 ms, logged each write's callback, and on the first failed write logged its code and exited. The mod
left the `for await` loop after three pieces.

| Run | +5 s (`ps --json`) | +30 s (`ps --json`) | The child's writes after the loop was left | The parent check |
| --- | --- | --- | --- | --- |
| `write` (twice) | both gone | both gone | +1.0 s and +2.0 s written; +3.0 s `EPIPE`, then it exited | alive, every check, to the end |
| `quiet` | both running | both running | none | alive, every check, until its cap at +42 s |
| `late` | both running | both running | the first, at +37.4 s: `EPIPE`, then it exited | alive, every check, to the end |

- The parent was never killed. Its log shows it returning from `spawnSync` each time, a few ms after its child ended,
  and exiting with the child's status. In `write` both were gone at +5 s only because the child had exited on `EPIPE`.
- The write that fails, fails in the write's callback (`code=EPIPE`). No `error` event came first, and the write did
  not throw.
- Not tried: whether the two outlive `claude.exe` itself. Every child had exited before the session ended.

## Task 37

**Nothing here contradicts Task 27 or Task 30, so Task 38 does not run.** Every window belongs to the program
`WINDOWS_APPS` names (section 1). Every variable Task 30 reads is set where it expects and unset where it does not
(sections 4 and 5).

**Contradicts the plan elsewhere:**
- Task 26: a link whose scheme has no handler is not refused. `ShellExecuteExW` with `SEE_MASK_FLAG_NO_UI` returns TRUE,
  and Windows opens "Pick an app" (`OpenWith.exe`). `open-link` would print `opened`, and a window shows (section 3).
  `AssocQueryStringW`'s `COMMAND` and `EXECUTABLE` also find nothing for a packaged handler that is registered (`codex`
  once the ChatGPT app is installed). Its `PROGID` finds both kinds.
- `cli/src/cable/hosts/frontApp.ts` says `ChatGPT.exe` on Windows is OpenAI's chat app, not the Codex app. That is
  wrong. The Store's ChatGPT app is package `OpenAI.Codex`, there is no separate Codex app, and the old chat app's Store
  id is gone. Task 27's `com.openai.codex` → `ChatGPT.exe` is right (section 2).
- `cli/src/cable/hosts/codexQueue.ts` (Task 18) says it is not known whether the ChatGPT app holds a Codex of its own on
  Windows. It does: `<package>\app\resources\codex.exe`, which runs the app's threads, and which the user can start by
  its path (section 2). Which `codex` an app thread's queue takes is still open.

Read 2026-11-20 on the UTM Windows 11 ARM64 VM (build 26200), in the owned test user's console session (session 1).
Autologon had been set for the sign-in and removed afterwards (section 7). Every step ran there as a one-shot
interactive task under that user, through `session-run.ps1`, not over SSH. The run used a copy of it that waits 90 s,
not 20 s, for the task to start: the busy VM often missed 20 s. Nothing was signed in to, in any app. Window owners
were read with `EnumWindows`, `GetWindowThreadProcessId` and `QueryFullProcessImageNameW`. Screenshots were taken only
to see first-run screens; none left the Mac's ignored `.work` folder.

**The installs**, for the test user alone:
- ChatGPT: `winget install --source msstore --accept-package-agreements --accept-source-agreements --id 9PLM9XGG6VKS`,
  exit 0 ("Successfully installed", about 9 minutes on this VM).
- Claude: the msstore source has no Claude app. `winget search --source msstore` finds nothing for `Claude` or
  `Anthropic` (exit `0x8A150014`, "No package found matching input criteria"). It was installed from the winget source
  instead: `Anthropic.Claude` 4.29.0, Anthropic's own arm64 installer, with `--scope user`, exit 0. That is a Squirrel
  install for this user, not an MSIX:
  - `<profile>\AppData\Local\AnthropicClaude\claude.exe`: Squirrel's x86 stub, the target of the Start menu shortcut.
  - `app-<version>\claude.exe`: the arm64 app.
  - An HKCU uninstall entry, `AnthropicClaude`.

  During the run the app updated itself from `app-4.29.0` to `app-6.6395.0` and started again.
- Each app was started once and stays installed.

### 1. Window owners

Each app's visible, unowned, non-tool top-level window, and the image of the process that owns it:

| App | Started as | Owner (image) | Window class | Task 27 |
| --- | --- | --- | --- | --- |
| VS Code | `Code.exe --new-window <folder>` | `Code.exe` (the main process, `<profile>\AppData\Local\Programs\Microsoft VS Code\`) | `Chrome_WidgetWin_1` | same |
| Cursor | `Cursor.exe --new-window <folder>` | `Cursor.exe` (the main process) | `Chrome_WidgetWin_1` | same |
| Orca | `Orca.exe` | `Orca.exe` (install root) | `Chrome_WidgetWin_1` | same |
| Claude app | its Start menu shortcut's target (the stub) | `claude.exe` (`…\AnthropicClaude\app-<version>\claude.exe`, arm64) | `Chrome_WidgetWin_1` | same: `Claude.exe`, matched without case |
| ChatGPT app | the link `codex://harness-test` | `ChatGPT.exe` (`<package>\app\ChatGPT.exe`, arm64) | `Chrome_WidgetWin_1` | same |
| WezTerm | `wezterm-gui.exe start`, with `--config prefer_egl=true` (below) | `wezterm-gui.exe` | `org.wezfurlong.wezterm` | same |
| Warp | `warp.exe` | `warp.exe` (the main process) | `Window Class` | same |
| Alacritty | `alacritty.exe` | `alacritty.exe` | `Window Class` | same |

- Each app had one such window, apart from Cursor's dialogs below.
- Other processes with the same image names owned no visible window:
  - each Chromium-based app's helpers (`--type=renderer` and the rest);
  - Warp's second `warp.exe` (`--parent-handle=…`);
  - the Claude Code CLI's `claude.exe`, which ran beside the Claude app. It was the editor extension's
    `resources\native-binary\claude.exe`, a child of the extension host.

  `pick` passes them over.
- Cursor: each `cursor://` link started `Cursor.exe --open-url -- "<link>"`, which forwards the link to the running
  Cursor. Twice, that process left a visible, unowned task dialog "Cursor": "Another instance of Cursor is running but
  not responding. Please close all other instances and try again." It stayed until it was closed. The running Cursor
  had taken the link: it was asking "Allow … to open this URI?" (section 3). The cause is not known: the slow VM, or
  that question holding Cursor's answer. Here the dialogs came after Cursor's main window in `EnumWindows` order. Above
  it, `raise --exe Cursor.exe` would pick a dialog.
- The VM has no OpenGL 3. Its display-only GPU driver (Red Hat VirtIO GPU DOD) is not enough for either terminal.
  - WezTerm exits with `Failed to create window: The OpenGL implementation is too old to work with glium`. It ran with
    `--config prefer_egl=true`, which uses the ANGLE it ships.
  - Alacritty exits 1 with `Render(Other("OpenGL error requesting shader version: invalid enum"))`. For this check it
    ran with WezTerm's bundled Mesa `opengl32.dll` placed beside it, removed afterwards.

  Neither changes a window's owner or a shell's environment. Task 1's "exits 1 in session 0" for both was this.

### 2. The ChatGPT app

- **Its program is `ChatGPT.exe`.** The Store's "ChatGPT" (`9PLM9XGG6VKS`, publisher OpenAI, publisher URL
  `https://openai.com/codex/`) is package `OpenAI.Codex` 26.1117.3838.0 Arm64, family `OpenAI.Codex_2p2nqsd0c76g0`,
  display name ChatGPT.
  - Its manifest's application `App` is `app/ChatGPT.exe`. That file's version resource says product "Codex", original
    file name `chrome.exe`: a Chromium-based app.
  - It registers the protocol `codex` (`--single-argument %1`).
  - Its aliases are `chatgpt-desktop.exe`, `codex-chrome-native-host.exe` and `codex-core-command-runner.exe`, all in
    `%LOCALAPPDATA%\Microsoft\WindowsApps`. None is `codex`.
  - It has a startup task, disabled.
- **The Codex desktop app is not a separate install.** `winget search --source msstore Codex` finds nothing by name.
  `OpenAI` finds two apps, by family name: this one and "ChatGPT (Beta)" (`9N8CJ4W95TBZ`, `OpenAI.CodexBeta_…`). The
  old chat app's id `9NT1R1C2HH7J`: "No package found".
- **It holds a Codex of its own:** `<package>\app\resources\codex.exe`, arm64, `codex-cli 0.171.0-alpha.13`. Here
  `<package>` is `%ProgramFiles%\WindowsApps\OpenAI.Codex_<version>_arm64__2p2nqsd0c76g0`, a folder named for each
  version.
  - The app runs it as `codex.exe -c features.code_mode_host=true app-server`, a child of `ChatGPT.exe`. Its environment
    has no `CODEX_HOME`, so it uses the default `<profile>\.codex`, as the npm `codex` does.
  - The test user can start it by that path: `--version` and `queue --help` exit 0, and `codex queue [OPTIONS] --thread
    <THREAD> --message <TEXT>` is there.
  - The PATH `codex` is still the npm shim, `codex-cli 0.170.0`, with the same `queue`. No alias puts the app's copy on
    PATH.
  - `app\Codex.exe` (20 KB) is the app's update trampoline (its pdb is `windows_update_trampoline.pdb`), not a CLI.
- **Whether a thread started in the app takes `codex queue` from the PATH `codex`: Open.** A thread needs a sign-in,
  which this run never does. So the stop condition is not decided either way. What is known: the app's threads run on
  the app's own Codex, a newer build than the PATH one, and both use the same default home.

### 3. Link handlers

Read in the session with `AssocQueryStringW` and `ASSOCF_IS_PROTOCOL`, read only.

| Scheme | Before the two apps | After |
| --- | --- | --- |
| `claude` | none: `0x80070483` (`ERROR_NO_ASSOCIATION`) for every kind asked | `HKCU\Software\Classes\claude`. `COMMAND` was `"<profile>\AppData\Local\AnthropicClaude\app-4.29.0\claude.exe" "%1"`; after the app's own update it is `"…\app-6.6395.0\claude.exe" -- "%1"`. `FRIENDLYAPPNAME` is `Claude`, `PROGID` is `claude` |
| `codex` | none: `0x80070483` | packaged. `COMMAND` and `EXECUTABLE` still give `0x80070483`. `FRIENDLYAPPNAME` is `ChatGPT`, `PROGID` is an `AppX…` id, and `APPID` is `OpenAI.Codex_2p2nqsd0c76g0!App` |
| `vscode`, `cursor` | as Task 1 §8 | unchanged |

**Contradicts Task 26.** Task 26 is not on this branch, so the call it specifies was made directly in the session:
`ShellExecuteExW` with verb `open`, `SEE_MASK_FLAG_NO_UI` and `codex://harness-test`, while a hook on
`EVENT_OBJECT_SHOW` recorded each window shown.
- With no handler, it returned TRUE (`hInstApp` 42) in 0.7 s. `OpenWith.exe` showed a window, "Pick an app" (class
  `Open With Dummy Window Class For Interim Dialog`, minimized, a new taskbar button).
- `claude://harness-test` did the same in 0.95 s.
- A second call made while the first picker was still open did not return within 120 s.

`open-link` would print `opened`, and a window shows. A check before the call can tell: `AssocQueryStringW`'s `PROGID`
gives `0x80070483` when no handler is registered, and answers for a classic handler and a packaged one alike.
`COMMAND` and `EXECUTABLE` give `0x80070483` for the registered packaged `codex` too.

Other links, the same call:
- `codex://harness-test`, with the ChatGPT app installed: TRUE, and the app's window came (`ChatGPT.exe`,
  `Chrome_WidgetWin_1`). The app's process was `ChatGPT.exe --single-argument codex://harness-test/`, with a slash
  added.
- `cursor://anthropic.claude-code/open`, with Cursor running: TRUE. Cursor then asked "Allow 'Claude Code for VS Code'
  extension to open this URI?", with Open and Cancel and a box "Do not ask me again for this extension". After Open,
  Claude Code's panel started a session.

### 4. Cursor's shells, and VS Code's panel

How it was read:
- Claude Code's extension, 2.1.329 `win32-arm64`, was installed in VS Code and in Cursor by each editor's own CLI:
  `--install-extension anthropic.claude-code`, exit 0 for both (Cursor's gallery has it). It was uninstalled afterwards.
- Each editor was started on a throwaway folder from a shell that read the test key into its own environment, as The
  VM says: `ANTHROPIC_BASE_URL` OpenRouter, `ANTHROPIC_AUTH_TOKEN` from the file, no `ANTHROPIC_API_KEY`,
  `ANTHROPIC_MODEL=deepseek/deepseek-v4.1-flash`, and `CLAUDE_CONFIG_DIR` a throwaway folder.
- The folder's settings turned on `claudeCode.disableLoginPrompt` and `claudeCode.hideOnboarding`. No login screen
  showed.
- The throwaway config's one `SessionStart` hook ran a probe that writes names and shapes only. The hook fires when the
  panel opens; no prompt was sent.
- Where no hook could run, another process's environment was read from its environment block, read only, for the same
  names.

**Cursor's first-run screen was not passed.** It offers "Log In" and "Sign Up" ("Cursor's AI features require you to be
logged in") and has no skip. Closing it quits Cursor, Escape does nothing, and UI Automation sees no control in it. Both
halves were still read behind it:
- the panel, opened by Claude Code's own link (`cursor://anthropic.claude-code/open`, section 3);
- an integrated terminal that Cursor opened behind the screen, once the folder's `claudeCode.useTerminal` was on and the
  link was opened again. It is `powershell.exe -noexit -command "try { . <shell integration> …"`, a child of Cursor's
  pty host. Its environment block was read.

| Where | `VSCODE_PID` (its row) | `VSCODE_IPC_HOOK` | `VSCODE_GIT_ASKPASS_NODE` | `TERM_PROGRAM` | Task 30 |
| --- | --- | --- | --- | --- | --- |
| VS Code, Claude Code's panel (the hook) | set, `Code.exe` | `\\.\pipe\<hex>-<n>.<n>.<n>-main-sock` | unset | unset | same |
| Cursor, Claude Code's panel (the hook) | set, `Cursor.exe` | the same shape; not VS Code's value | unset | unset | same |
| Cursor, extension host (its environment block) | set, `Cursor.exe` | the same value as Cursor's panel | unset | unset | same |
| Cursor, integrated terminal (its environment block) | unset | unset | `<profile>\AppData\Local\Programs\cursor\Cursor.exe` | `vscode` | same |

- Both editors' `VSCODE_IPC_HOOK` match `^\\\\\.\\pipe\\[^\\]{1,200}$`, and their values differ. The first 16 hex digits
  of each value's SHA-256 were compared; neither is written here. So a reused pid's kept answer cannot cross editors.
- Both panels set `CLAUDE_CODE_ENTRYPOINT=claude-vscode` (Cursor too, so it does not tell them apart),
  `ELECTRON_RUN_AS_NODE=1` and `TERM=xterm-256color`.
- The hook's chain, in both editors: the hook's program < `bash.exe` < `bash.exe` < `claude.exe` (the extension's
  `resources\native-binary\claude.exe`) < `Code.exe` or `Cursor.exe` (the extension host) < `Code.exe` or `Cursor.exe`
  (the main process). The hook ran under Git Bash.
- Cursor's extension host also has `VSCODE_CRASH_REPORTER_PROCESS_TYPE=extensionHost`,
  `CURSOR_EXTENSION_HOST_ROLE=user`, `CURSOR_LAYOUT`, `CURSOR_WORKSPACE_LABEL` and `VSCODE_PROCESS_TITLE`.
- Cursor's terminal also has `VSCODE_GIT_ASKPASS_MAIN`, `VSCODE_GIT_IPC_HANDLE`, `VSCODE_INJECTION` and
  `VSCODE_STABLE`. Its `TERM_PROGRAM=vscode` is the same as in VS Code's terminal (Task 1 §6). Only
  `VSCODE_GIT_ASKPASS_NODE` tells the two terminals apart.
- VS Code was passed with "Continue without Signing In". The folder was trusted twice: once in VS Code's Restricted Mode
  page, then in Claude Code's own "Trust this folder in Claude Code?".

### 5. The terminals' shells

Read from the environment block of the shell each terminal starts by default:

| Terminal (shell) | `WEZTERM_PANE` | `TERM_PROGRAM` | `ALACRITTY_LOG` | Task 30 |
| --- | --- | --- | --- | --- |
| WezTerm (`cmd.exe`) | set, digits | `WezTerm` | unset | same |
| Warp (`powershell.exe`) | unset | `WarpTerminal` | unset | same |
| Alacritty (`powershell.exe`) | unset | unset | set: `%TEMP%\Alacritty-<pid>.log`, the profile written in its 8.3 short form | same |

- WezTerm's shell also has `WEZTERM_EXECUTABLE`, `WEZTERM_EXECUTABLE_DIR`, `WEZTERM_UNIX_SOCKET` and
  `COLORTERM=truecolor`.
- Warp's has `WARP_IS_LOCAL_SHELL_SESSION`, `WARP_TERMINAL_SESSION_UUID`, `WARP_CLIENT_VERSION`, `WARP_FOCUS_URL` and
  other `WARP_*` names, and no `COLORTERM`.
- Warp's first run was passed with no account: "Get started", then two pages of Next, then "Create an account": Skip,
  then "Continue without signing in?": Skip for now.
- Alacritty's shell has `ALACRITTY_LOG` and no other name of its own, and `COLORTERM=truecolor`. It is set whether
  Alacritty starts with `-v` or without.

### 6. The key

`findstr /L /M /G:<the key file> <these notes>` prints nothing. It ran as the test user, which reads the key from its
own file. Nothing the run wrote held the key: the editors' probes print names, and values only as shapes.

### 7. Autologon

Autologon was set for this task's sign-in and removed afterwards. The main session read the four Winlogon values, set
them for the test user (the password on stdin), restarted the VM, and removed them once the session was up. It read
them back to check: `AutoAdminLogon`, `DefaultUserName`, `DefaultDomainName` and `DefaultPassword` absent,
`AutoLogonSID` as it was. This run read them again before its first step and found the same. The console session stayed
signed in throughout.

The run removed what it made:
- Claude Code's extension in both editors, and their `extensions` folders, which did not exist before;
- the throwaway folders and config;
- Alacritty's borrowed `opengl32.dll`;
- winget's downloaded Claude installer;
- its probes and screenshots in `e2e`;
- the processes it started.

The key file, the test user and the two apps stay.
