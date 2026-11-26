# Windows: a running VS Code agent is found again after a restart (2026-11-26)

## The report

Ken's VM, 2026-11-26: Windows 11 ARM64, CLI 0.6.89, harness-pty 0.6.87, VS Code 1.148 ARM64, Claude Code in VS Code's
integrated terminal, desk from main 75052a7d84. After the daemon restarts, the dial does not show that Claude Code again.
Its row comes back only at its next hook (Stop, say). On macOS and Linux the open scan finds it at once.

## How the open scan works today

1. The dial attaches, and then every 60 s, the devices run the open scan (`services/devices.ts` `scanOpen`, then
   `cable/hosts/observed.ts` `scanOnce`).
2. `OpenSessions.owners()` (`lib/sessionSearch/external.ts`) asks each engine's provider which process holds which
   session. For Claude Code that is `recordOwners` (`engines/kit/adoption.ts`). It reads `<home>/sessions/<pid>.json`,
   then keeps the record only when that pid is alive, is a Claude Code process in the process table (`claude.exe`
   scores 3, `lib/windows/engineProcessMatch.spec.ts`), and did not start after the record's `startedAt`. On Windows
   the table is harness-pty's (`lib/windows/processTable.ts`), and `processTtys` answers no tty, so the owner's `tty`
   is null. The scan lists the owner anyway: `scanOnce` does not filter on the tty.
3. `SessionRows.find` reads the transcript row (`projects/<folder>/<id>.jsonl`), and the session is listed as an
   observed entry with its pid.
4. **The app.** `observed.ts` `appsOf` calls `learnApps` (`cable/hosts/scannedApp.ts` `scannedApps`). It walks the
   agent's parent chain to the first listed app: on macOS the `.app` bundle (`Visual Studio Code.app` gives `vscode`,
   `scannedApp.spec.ts:82-86`), on Linux the process name (`code` gives `vscode`, `scannedApp.spec.ts:266-269`). **On
   Windows it learns nothing and reads nothing** (`scanLearnsApps`, `platform === 'darwin' || platform === 'linux'`,
   and the spec "on Windows nothing is learned and nothing is read", `scannedApp.spec.ts:305`).
5. **The pane.** VS Code's adapter gives an agent a terminal pane `term:<pid>` only when `place.app === 'vscode'`
   (`cable/hosts/vscode.ts` `paneOf`). `services/devices.ts:2272` tells `vscodeTerminals.agents()` only the pids of
   agents with such a pane. Only those get a parent chain read and a match to the shell a VS Code window reports
   (`cable/hosts/vscodeTerminals.ts`).

## Why Windows misses it

There are two gates on Windows. Ken's VM run of 2026-11-26 (steps 1 to 3 below) showed the first: the record
`.claude\sessions\<n>.json` is there and `claude` stays alive, yet after the restart no `[observed] scan ·` line is
logged at all (0 found), and no page lists the agent.

### Gate 1, the main cause: a Windows folder is not a folder

`absoluteFolder` (`lib/sessionSearch/externals/support.ts:106`) accepts only a value that starts with `/`.
`readAdoptedHead` (`engines/kit/adoption.ts:54`) takes the transcript's `cwd` through it and returns no head without
one. Claude Code on Windows writes `cwd` as `C:\...`, so step 3 finds no row for any Windows session. Step 2 still
finds the owner, and `scanOnce` drops a session with no row (`rows.has(sessionId)`). The look ends with `listed` at 0,
before its log line. A scratch run of the real `OpenSessions` and `SessionRows` over a Windows-shaped home (record
`sessions/5160.json`, a `claude.exe` row in the view) gave 1 owner and 0 rows with `cwd: "C:\\work\\dial"`. With
`/work/dial` it gave 1 owner and 1 row. Before the restart the agent was listed only because its hooks made the row,
and they need no transcript head.

The same helper reads the folder of Devin, Cursor, OpenClaw, opencode and Hermes sessions, and the same provider
serves ⌘P and the welcome page (`search` service). So on Windows none of them ever listed a session from outside
Harness. Fixing it there, as the fix below does, makes ⌘P and the welcome page on Windows start listing those
sessions too (PM, 2026-11-26: accepted; the PR says so). A Windows owner has no tty (`processTtys`), so it reads as an
app's (`OpenIn` `app`) and a take-over never stops its process.

### Gate 2: the scan learns no app on Windows

Past gate 1, step 4 gives no app on Windows, so the entry stays `appPending` on the unknown app's page (Other). It gets no `term:`
pane in step 5, so no VS Code window is ever matched to it. On VS Code's page, and in the ring of a dial that filters by
the app in front (VS Code), the agent is not there. The next hook carries `TERM_PROGRAM=vscode` and the editor's
`VSCODE_GIT_ASKPASS_NODE` (`docs/plans/2026-11-19-dial-windows-vm-notes.md` §6). That gives `app: vscode`, the pane
follows, and the row is back: what Ken saw.

The macOS and Linux claim holds in code and tests: the same steps run there with step 4 learning `vscode`
(`scannedApp.spec.ts:82-86`, `:266-269`). `observed.spec.ts:976` shows that a scanned session under a listed app is on
that app's page and known from its first listing. `vscode.spec.ts:218-224` shows that an agent with `app: vscode`, a pid
and no extension-tab entrypoint gets `term:<pid>`.

Why Windows was left out: #4513 (2026-11-20) turned the walk off there because "a dead parent's pid can be another
process's there" (Windows reuses pids and never reparents). #4525 (2026-11-21) then added the guard: `parentChain` ends
at a parent whose `w:<FILETIME>` start is after its child's (`startedAfter`). The reason for turning the walk off is
gone. The walk itself was never written for Windows: `learnApps` reads `ps`, which Windows does not have.

The same cause hides every app on Windows from the scan until its next hook: Codex as well as Claude Code, Cursor as
well as VS Code, and an agent in an Orca terminal (`orca.exe`), WezTerm or the ChatGPT app. The fix covers them all.

The owner side was ruled out on the VM and in the scratch run: the record is there, and `recordOwners` accepts it with
a live `claude.exe` (`engineProcessMatch` scores it 3, `lib/windows/engineProcessMatch.spec.ts`).

## The fix

### Gate 1: `absoluteFolder` accepts a Windows folder

On win32, `absoluteFolder` also accepts a drive path (`X:\...`, `X:/...`, the drive root `X:\`). It still rejects UNC
(`\\server\share`), `\\?\`, `\\.\` and `//server`, as `homeIsNetworkOrDevice` (`engines/kit/homeAdoption.ts:48`) rejects
them for an engine home. A transcript's folder is later resolved and walked (`sameProject`, `gitCommonDir`), and opening
a UNC path can reach another computer over SMB. It also rejects a drive-relative `C:foo`. macOS and Linux are
unchanged. The platform is a parameter, defaulting to the running one, so the specs run on every OS.

### Gate 2: the scan learns the app on Windows

Make the scan learn a session's app on Windows, from the same harness-pty table the rest of the Windows dial reads, with
the pid-reuse guard. Everything else stays as it is. (Since #4629 the walk is main's `windowsPtyMaker` and the table
reader its `readWindowsProcesses`; this branch reuses both.)

1. `cable/hosts/scannedApp.ts`:
   - `scannedApps` gets a `win32` branch. For each pid it finds the **maker** the way `windowsPtyOwner` already does:
     the nearest parent that is not a shell (`pwsh`, `powershell`, `bash`, `sh`), not `cmd`, and not a launcher of the
     agent's own image or `node` before any shell. If an engine's own image or `node` sits above a shell, another agent
     ran this one (`claude -p` from Claude Code's tool), so the answer is none. The walk is `parentChain` over the
     table, so a parent that started after its child ends it. The maker's image goes through `frontAppId` (`Code.exe`
     gives `vscode`, `Cursor.exe` gives `cursor`, `orca.exe` gives `orca`, `ChatGPT.exe` gives `codex`) and is kept
     only when `listed`. Anything else is none, as today: the first hook decides.
   - The maker walk is main's `windowsPtyMaker` (#4629), which `windowsPtyOwner` and herdr's lookup use too (one way
     to walk). The nested-agent rule above is added there. It changes nothing for those two, whose host table names
     neither `node` nor an engine.
   - `scanLearnsApps` stays `darwin || linux`. It also gates the tmux, herdr and Zellij lookups (`ps`, `lsof`,
     `devices.ts:910`, `:2371`), which have no Windows form. Only its comment changes.
2. `learnApps` (`cable/hosts/scannedApp.ts`) on `win32` reads the table through `processRows()` (harness-pty's, the one
   `readProcessParents` uses) and keeps pid, parent, image and start marker, never arguments. A failed read rejects, so
   `appsOf` logs `[observed] scan · apps not read · <kind>` and lists the session not known yet, as on Unix.
3. Nothing else: once `app: vscode` is known, the existing `term:<pid>` pane, the chain read and the window match do
   the rest on every OS (step 5).

Cost: one more read of the process table per scan, only when the scan lists a new session (it is skipped when `listing`
is empty) and only on Windows. It is the read `readProcessParents` already makes per new VS Code agent. No new state,
no new log content (`scan · N found · M app known` already counts it), no core file.

Platforms: Windows changes. macOS and Linux run the same code paths as before; their specs stay green.

## Tests (red first)

Gate 1:
- `lib/sessionSearch/externals/support.spec.ts`: on win32, `absoluteFolder` accepts `C:\work\dial`, `c:/work` and
  `D:\`, and rejects `\\server\share\x`, `\\?\C:\x`, `\\.\pipe\x`, `//server/share`, `C:work` and `work`. On Linux and
  macOS it still rejects `C:\work` and accepts `/work`.
- On win32, a Claude provider over a temp home whose transcript says `cwd: "C:\\work\\dial"` lists the session. A real
  `OpenSessions` and `SessionRows` pass, with a Windows-shaped record and a `claude.exe` view row, gives one owner and
  one row. Red today: 0 rows.

Gate 2:

1. `cable/hosts/scannedApp.spec.ts`: replace "on Windows nothing is learned and nothing is read" with a fake Windows
   table (`w:<FILETIME>` markers, start times rising down the tree):
   - `claude.exe` → `pwsh.exe` → `Code.exe` → `Code.exe` gives `vscode`; the same under `Cursor.exe` gives `cursor`;
     Codex's npm chain `codex.exe` → `node.exe` → `cmd.exe` → `pwsh.exe` → `Code.exe` gives `vscode`.
   - A parent whose start is after its child's (a reused pid) gives none.
   - `claude.exe` (`claude -p`) → `bash.exe` → `claude.exe` → `pwsh.exe` → `Code.exe` gives none.
   - `claude.exe` → `pwsh.exe` → `explorer.exe` gives none, and so does `WindowsTerminal.exe` (`frontAppId` names it
     the unknown app, `terminal`, which `listed` drops: it stays on Other's page).
   Red today: the map is empty.
2. `cable/hosts/observed.spec.ts`, the layer where the behavior lives: on `win32`, a scan whose owners come from a real
   `OpenSessions` over a temp Claude home (a fake transcript `projects/<p>/<id>.jsonl` and a fake `sessions/<pid>.json`)
   and a fake Windows process tree. With `apps` as `learnApps` over that tree, the listed entry has `app: 'vscode'`, no
   `appPending`, and `paneOf(id, 'vscode') === 'term:<pid>'`. Red today: the entry is on Other's page with no pane.

Local gates: the specs above and `npm run test:core` (it covers `src/services`). Ask the PM for a Mac slot before
running it.

## VM steps for Ken (through the PM)

Build: the PR's head, installed on the VM as usual. Steps 1 to 3 can also run on today's 0.6.89 to confirm the cause
before the fix.

**Ken's run on 0.6.89 (2026-11-26).** He used the repo's stand-in dial against the release daemon, restarting with
`harness start -f`, since a background `harness start` drops the `HARNESSD_*` variables the stand-in needs.
1. The agent was on VS Code's page.
2. The record was there.
3. After the restart, at 70 s and at 3.5 min, no page listed it, with no `[observed] scan ·` line, and `claude` was still
   running. That is gate 1, not the expected `1 found · 0 app known`.

1. Plug in the dial. In VS Code, open an integrated terminal (PowerShell) and start `claude`. Send one prompt and wait
   for it to finish. The dial shows it on VS Code's page.
2. Check the record: `dir $env:USERPROFILE\.claude\sessions`. Report only whether a `<number>.json` file is there
   (yes/no), not its contents.
3. Restart the daemon (`harness stop`, then `harness start`). Do not touch the Claude Code terminal. Wait 70 s. Report:
   - what the dial shows, on VS Code's page and on Other's;
   - the devices' log line `[observed] scan · N found · M app known · …` (counts only).
   Before the fix: no line and no row (gate 1, as Ken saw).
4. With the fix: repeat 1 and 3 (restart with `harness start -f` while the stand-in dial is used). Expected: one
   `[observed] scan · 1 found · 1 app known · …` line within 70 s, and the agent on VS Code's page before any hook.
   `1 found · 0 app known` means gate 1 is fixed and gate 2 is not; no line means gate 1 is not fixed.
5. Tap it on the dial. VS Code comes forward and shows that terminal. Turn the dial: the terminal scrolls.
6. Say a short prompt to it on the dial. It is typed into that terminal and submitted.
7. Repeat 3 to 5 with Codex in a VS Code terminal (`codex`), and once with Claude Code in Windows Terminal. Windows
   Terminal's agent is now listed after the restart (gate 1), on Other's page, since no app is learned for it.
8. ⌘P in Harness on the VM (if the app is installed there) now lists that outside Claude Code session. This is new on
   Windows and expected.

## Size

Small: one component (`cli`), two code files (`cable/hosts/scannedApp.ts`, `lib/sessionSearch/externals/support.ts`),
under 150 lines without tests (PM, 2026-11-26: tell the PM if it passes that). Nothing stored, synced or exposed, no new screen, no new end-to-end check (the VM
steps are the PM's).
