# Harness Team account on Windows: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Starts after** the Linux plan (`docs/superpowers/plans/2026-10-28-harness-team-account-linux.md`) has merged, and
> after `harness.exe`, `harness-launch.exe`, `harness-pty.exe` and `harness-serial.exe` are code-signed. Smart App
> Control blocks those unsigned files at random (DESKTOP-0TFH0OJ, 2026-10-28). A team daemon that nobody watches cannot
> recover from a blocked terminal host.

**Goal:** On Windows, `harness team setup` and Desktop's offer make the same Harness Team account a Mac gets: a separate
standard local user, `harnessteam`, whose own daemon runs teammates' Swarm agents and cannot read the owner's files.

**Architecture:** The same shared code as the Mac and Linux accounts: the config, the observer, the relay, the engines
report, `team __handoff` / `team __start`, `TeamAutoSetup`, the dialog and the backend. Add `teamLayout('win32')` and a
PowerShell setup/remove script built like the POSIX ones. Every value is checked, then single-quoted (`'…'`, with `'`
doubled). The script runs elevated behind User Account Control (UAC), which shows Windows PowerShell's own signed
prompt. The team daemon runs as a scheduled task at startup, as `harnessteam`, whether or not anyone is signed in. That
is the Windows form of the LaunchDaemon, and `harnessd/platform.ts` already drives Task Scheduler.

**Tech stack:** TypeScript (cli, vitest), Windows PowerShell 5.1, Dart/Flutter (desktop).

**Spec:** `docs/plans/2026-10-24-swarm-team-account.md` (the Mac design). The Linux plan supplies `teamLayout`.

## Global constraints

- Mac and Linux behave as before. Every existing team spec passes unchanged.
- Same account: `harnessteam`, full name `Harness Team`, a member of `Users` only (never `Administrators`), and listed
  on the sign-in screen (no `SpecialAccounts\UserList` hiding). On Windows, as on a Mac, a random password that nobody
  knows: 40 characters, made inside the elevated script, handed to Task Scheduler (stored as an LSA secret, as Windows
  stores a task's credentials) and to the one `-Credential` process that makes the profile, then cleared. It is never
  printed, logged, written to a file or put on a command line.
- No unsigned executable is started by setup or by the task. They start `powershell.exe` (Microsoft) and `node.exe`
  (OpenJS Foundation), and never `harness.exe` or `harness-launch.exe`.
- The team daemon port stays `18493`.

## Windows layout (`teamLayout('win32')`)

| What | Windows |
|---|---|
| Team home | `C:\Users\harnessteam` (the profile Windows makes) |
| Shared root (Administrators/SYSTEM full, Users read) | `C:\ProgramData\Harness` |
| Config | `C:\ProgramData\Harness\team.json` |
| Status dir (team account modify, Users read) | `C:\ProgramData\Harness\Team` |
| Service | scheduled task `\Harness\Harness Team`: trigger At startup, `RunLevel Limited`, password logon, `RestartCount 999` every 1 min, no time limit. Two actions run in order: `node.exe cli.js team __start <handoff>`, then `node.exe cli.js __harnessd`, both with stdout and stderr appended to the team log (through `cmd.exe /d /c`, Microsoft's) |
| Relay folder | `C:\ProgramData\Harness\team-relay-<owner>`. Inheritance removed (`icacls /inheritance:r`), owner full, `harnessteam` read, SYSTEM full |
| Admin prompt | `Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',<run.ps1>`. Cancel is Win32 error 1223 (`The operation was canceled by the user`) → `CANCELLED` |
| Terminal host | the team account's own pty payload (`lib/windows/ptyInstall.ts`), installed by its daemon into its own home, as tmux is on a Mac |
| gh | GitHub's `gh_<v>_windows_amd64.zip` / `_windows_arm64.zip`, pinned (GitHub signs `gh.exe`) |

## The privacy check on Windows: the sentinel is not world-readable

On macOS and Linux the sentinel is readable by everyone on purpose (`WRITE_PUBLIC`), so that only the home folder's own
mode protects it. Windows grants every account "Bypass traverse checking" (`SeChangeNotifyPrivilege`). A file that
grants Everyone read can therefore be opened by its full path even inside a folder the reader cannot list. So on
Windows the sentinel keeps the ACL it inherits from the owner's profile (owner, SYSTEM, Administrators). It proves that
inherited ACLs refuse the team account. That is the protection every file in the profile actually has. The probes,
which must all be refused for `harnessteam`:

| Item | Path under `%USERPROFILE%` |
|---|---|
| sentinel | `.harness-team-privacy` (inherited ACL) |
| home-listing | the profile folder |
| gitconfig | `.gitconfig` |
| ssh | `.ssh` |
| projects | `source\repos`, `code`, `Code`, `Projects`, `src`, `Documents` |
| credentials | `AppData\Roaming\Microsoft\Credentials`, `AppData\Local\Microsoft\Credentials` |
| chrome | `AppData\Local\Google\Chrome\User Data` |
| edge | `AppData\Local\Microsoft\Edge\User Data` |
| standard-user | `harnessteam` is not in the `Administrators` group (SID `S-1-5-32-544`) |

Setup also removes any explicit ACE on the profile folder that gives `Everyone`, `Users` or `Authenticated Users` read.
It lists each one removed in its output, so a person sees what changed.

## Review focus

1. **The owner signs in with a Microsoft account, or the profile folder is not `C:\Users\<name>`:** take the owner's
   home from `$env:USERPROFILE` of the owner's own process. Never build it from the user name.
2. **A domain-joined or Entra-joined PC where policy forbids local accounts:** `New-LocalUser` fails, and setup must exit
   `NO_LOCAL_ACCOUNTS` before it changes anything.
3. **The owner is a standard user:** UAC asks for another administrator, and the elevated script runs as that person.
   Everything owner-specific must come from the owner's own process: the profile path and SID before elevation, and
   the sign-in code after it (step 8). Test it with an admin and a standard owner on the PC.
4. **Removal while teammates' agents run:** end the task, stop every process whose owner is `harnessteam`
   (`Win32_Process.GetOwner`), then `Remove-LocalUser` and the profile (`Win32_UserProfile` `Remove-CimInstance`). When
   the profile is held, the task runs again and nothing is removed (`REMOVE_REFUSED`).
5. **Smart App Control:** the npm-installed Claude Code and Codex in the team home must run under SAC. Check them on
   DESKTOP-0TFH0OJ before Task 5, and stop if either is blocked.

---

### Task 1: `teamLayout('win32')` (`cli/src/team/layout.ts`)

**Files:** Modify `cli/src/team/layout.ts`. Test `cli/src/team/layout.spec.ts`.

**Interfaces:**
- Consumes: the Linux plan's `TeamLayout`.
- Produces: `TeamPlatform` gains `'win32'`. `service.kind` gains `'taskscheduler'`. Add
  `checkWindowsPath(path, what)`: an absolute `X:\…` path of plain characters, with no `..`, no `\\?\`, no UNC and no
  `'`.

- [ ] Write the failing tests: `teamLayout('win32') holds the table above`, and `checkWindowsPath refuses relative, UNC,
  .., quote and \\?\ paths`.
- [ ] Run `npx vitest run src/team/layout.spec.ts`. Expected: FAIL.
- [ ] Implement.
- [ ] Run `npx vitest run src/team`. Expected: PASS.
- [ ] Commit `feat(team): the Harness Team account's paths on Windows`.

### Task 2: The PowerShell setup and remove scripts (`cli/src/team/windowsScript.ts`, new)

**Files:** Create `cli/src/team/windowsScript.ts`. Test `cli/src/team/windowsScript.spec.ts`.

**Interfaces:**
- Produces: `ps(word: string): string` (PowerShell single quotes). `buildWindowsSetupScript(input: SetupScriptInput): string`.
  `buildWindowsRemoveScript(input: RemoveScriptInput): string`. `teamTaskXml(input: TeamPlistInput): string` (the task,
  registered with `Register-ScheduledTask -Xml`).

The steps, in the macOS script's order:
1. **Preflight.** Elevated (`[Security.Principal.WindowsPrincipal]` IsInRole Administrators) and Windows. The owner's
   profile exists and belongs to the owner (`(Get-Acl).Owner` is the owner's SID).
2. **Account.** When `harnessteam` exists, its profile must be `C:\Users\harnessteam`, else exit 4. When it does not:
   make a random 40-character password (`RandomNumberGenerator`), then `New-LocalUser … -PasswordNeverExpires
   -AccountNeverExpires`, then `Add-LocalGroupMember Users`. A failure there exits `NO_LOCAL_ACCOUNTS` (5).
   Remove it from `Administrators` if it is there. On a repair, set a new random password, because the old one is
   known to nobody and the task needs one.
3. **Profile.** Start `cmd.exe /d /c exit 0` once with `Start-Process -Credential -LoadUserProfile -Wait`, so Windows
   makes `C:\Users\harnessteam` with its own default ACL.
4. **Owner's profile private.** Remove the broad ACEs and list them. Write the sentinel as the owner, with an inherited
   ACL.
5. **Stop.** `Stop-ScheduledTask` and `Disable-ScheduledTask` for the team task.
6. **Runtime.** Stage the owner's Node runtime and CLI in a folder only Administrators can write. The team account
   copies them into its own home. Do it with a `-Credential` process running `TEAM_COPY`'s PowerShell twin (same
   targets: `.harness\runtime\<node>`, `current-node`, `.harness\cli\{cli.js,notify.mjs,package.json}`). Engines:
   `npm install --global --prefix %USERPROFILE%\.local …` as the team account.
7. **Shared files.** `C:\ProgramData\Harness` with its mark, `team.json` (Administrators and SYSTEM full, Users read),
   and the status dir (`harnessteam` modify).
8. **Sign-in handover folder.** Create `C:\ProgramData\Harness\Team\handoff`: inheritance removed, the owner's SID
   write (named by SID in `team.json`, taken from the owner's own process before elevation), `harnessteam` read and
   delete, SYSTEM full. The elevated script never mints the code. When the owner is a standard user, UAC runs it as
   *another* administrator, whose `team __handoff` would sign in the wrong person.
9. **Service.** `Register-ScheduledTask -Xml (teamTaskXml) -User harnessteam -Password <pw> -TaskPath '\Harness\'`.
   Clear the password variable. Do not start the task yet.

Then, after the elevated script returns, **as the owner** (`command.ts` setup, Task 4): mint with `mintTeamHandoff`.
Its 90 seconds start here, after the prompt. Write the code to the handover folder and `Start-ScheduledTask`, retried 5
times. `team __start` on Windows reads the code from the handover folder (deleting it), in place of
`.harness\team-handoff`.

Remove, in the macOS script's order: unregister the task, stop the `harnessteam` processes, `Remove-LocalUser`, then
the profile through `Win32_UserProfile`. When that fails, register the task again and exit 9. Then remove the shared
files when they are marked and empty, the relay folder and the sentinel, and print `team computer <id>`.

- [ ] Write the failing tests:
  - `a standard listed user, never an administrator`.
  - `the password is made in the script and never on a command line or in the output` (no `-Password '` literal, and
    the variable is cleared).
  - `an existing harnessteam with another profile exits 4`.
  - `the sentinel keeps an inherited ACL`.
  - `every interpolated value is single-quoted with ' doubled`.
  - `the task runs node.exe as harnessteam at startup, restarts on failure, and never names harness.exe`.
  - `remove registers the task again and exits 9 when the profile is held`.
  - The script parses: a spec step that runs `pwsh -NoProfile -Command [ScriptBlock]::Create(...)` where `pwsh` is
    present, else skipped.
- [ ] Run `npx vitest run src/team/windowsScript.spec.ts`. Expected: FAIL.
- [ ] Implement.
- [ ] Run again. Expected: PASS.
- [ ] Commit `feat(team): the Harness Team account's setup and removal scripts for Windows`.

### Task 3: UAC as the admin prompt (`cli/src/team/admin.ts`)

- [ ] Write the failing tests: `win32 prompt runs powershell -Verb RunAs on run.ps1`, `exit 1223 is CANCELLED`, and
  `the staging folder is the owner's alone` (`icacls` grants the owner, SYSTEM and Administrators only).
- [ ] Run, implement, run again. Expected: PASS.
- [ ] Commit `feat(team): ask for the administrator through User Account Control on Windows`.

### Task 4: `harness team setup | status | remove` on Windows (`command.ts`, `deps.ts`)

- `accountExists` reads `Get-LocalUser`. `jobState` reads `Get-ScheduledTask` / `Get-ScheduledTaskInfo` for
  `\Harness\Harness Team`. `madeLines` and `byHandLines` read the Windows layout (by hand: `Unregister-ScheduledTask`,
  `Remove-LocalUser`, the profile, `C:\ProgramData\Harness`).
- [ ] Write the failing tests, as the Linux plan's Task 4 does for Linux. Run, implement, run again. Expected: PASS.
- [ ] Commit `feat(team): harness team setup, status and remove on Windows`.

### Task 5: The team daemon on Windows (privacy, relay, engines, gh, terminal host)

- `privacyProbes(config, 'win32')`: the table above. `PrivacyItem` gains `'credentials'` and `'edge'`. A probe is passed
  only when Windows answers `EPERM` or `EACCES`.
- Relay: the folder from the layout. `icacls … /inheritance:r /grant:r "<owner>:(OI)(CI)F" "harnessteam:(OI)(CI)R"
  "SYSTEM:(OI)(CI)F"`. The team side checks that the folder's and the file's owners are the configured owner.
- gh: the pinned Windows zips. The terminal host: the team daemon runs `ensurePtyPayload` for its own home at start.
- [ ] Write the failing tests: `win32 probes name the Windows places`, `win32 relay ACL grants harnessteam read only`,
  `the team side refuses a relay folder another user owns`, `win32 gh build is the pinned zip`.
- [ ] Run, implement, run again. Expected: PASS.
- [ ] Commit `feat(team): the team daemon's privacy check, relay and gh on Windows`.

### Task 6: Desktop on Windows (`autoSetup.ts`, `app_state.dart`, `team_account_setup.dart`)

- `TeamAutoSetup.decide` accepts win32 through `teamLayout`. `_teamAccountHere` adds `Platform.isWindows`.
- The dialog: the Mac's three paragraphs. Paragraph 2 is `Windows asks for permission once (User Account Control).`
  Outcome `started`: `Windows is asking for permission. Setup then takes a minute or two. This computer's row updates
  when it is ready.`
- [ ] Write the failing tests: the offer and the dialog on Windows. Mac and Linux unchanged.
- [ ] Run, implement, run again. Expected: PASS.
- [ ] Commit `feat(desktop): the Harness Team account on Windows`.

### Task 7: Verify on DESKTOP-0TFH0OJ

- [ ] First put the PC back from whole-computer team work (converted by hand on 2026-10-28): run `harness team off`,
  then `harness login` in a browser on the PC.
- [ ] Desktop → join a Swarm. Expected: the dialog, then UAC. Then `harness team status` shows the account, the task
  running, signed in, Private ✓. `/api/machines` has `DESKTOP-0TFH0OJ · Team` with `hostMachineId` set to the PC's machine.
- [ ] As `harnessteam` (`Start-Process -Credential` is not possible, since the password is unknown. Use a team agent's
  shell instead): `type %OWNER%\.gitconfig`, `dir %OWNER%` and `type %OWNER%\.harness-team-privacy` are all refused.
- [ ] A teammate's Lead routes a Builder here on DeepSeek (grid autonomous.ai). Expected: it starts as `harnessteam` and
  answers.
- [ ] Reboot with nobody signed in. Expected: the team task runs and the machine shows online.
- [ ] Again with a standard-user owner, approving UAC with another administrator's password. Expected: the team
  account is signed in as the owner's Harness account, not the administrator's.
- [ ] `harness team remove`: the user, profile, task and shared files are gone.

## Not in this plan

- Code signing (its own work, which this plan waits for).
- Hiding the account. It stays visible on purpose, as on a Mac (`layout.ts`).
