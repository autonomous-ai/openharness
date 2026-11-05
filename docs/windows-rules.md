# Windows rules

Everything here cost real time on a real Windows computer. Read it before you change code that starts a
process, runs a script, or shows text on Windows, and before you test anything there. A person on Windows
must see what a person on a Mac sees: the app, and nothing else.

## 1. Harness never opens a window the person did not ask for

On a Mac a background program has no window. On Windows a console program started by a process that has no
console gets a new console, and that window flashes up and closes. The person sees it every time, and they
cannot tell what it was.

Measured on Windows 11 with Windows Terminal as the default terminal (2026-11-05). A Node parent with a hidden
console, as the daemon has, starts `cmd`, and `cmd` starts `ping` and `powershell`:

| Node `spawn` options | A window flashes? |
|---|---|
| `detached: true` | **Yes** |
| `detached: true, windowsHide: true` | **Yes** |
| none | No |
| `windowsHide: true` | No |

Why: libuv turns `detached` into `DETACHED_PROCESS`, so the child has no console at all, and each console
program it starts then gets a new one. `CREATE_NO_WINDOW` is ignored beside `DETACHED_PROCESS`, so
`windowsHide` cannot rescue it. It looks hidden in a quick test when the child itself starts nothing.

The rules:

- **CLI (Node): never `detached: true` on Windows for a program that starts other programs.** Use
  `ownProcessGroup()` from `cli/src/lib/windows/noWindow.ts`: its own process group on macOS and Linux, a hidden
  console on Windows. `cli/src/lib/windows/noWindow.spec.ts` fails on a new `detached: true` anywhere in `cli/src`
  unless that file lists it with the reason.
- **A process that must outlive Node** (Node ends a child that is not detached when Node exits) starts through
  `bin\harness-launch.exe` (`cli/src/lib/windows/launcher.ts`), which uses `CREATE_NO_WINDOW`, or through a small
  detached runner that starts the real work hidden (`cli/src/engines/kit/windowsInstall.ts`).
- **Desktop (Dart): use `startHidden` and `runHidden`** (`desktop/lib/core/hidden_process.dart`). Plain
  `Process.start` and `Process.run` in normal mode are hidden too. `ProcessStartMode.detached` is only for a GUI
  program (`explorer.exe`, the launcher). `inheritStdio` and `runInShell` are not for a console program.
- **Rust:** `CREATE_NO_WINDOW`, never with `DETACHED_PROCESS` (`pty/src/launcher.rs`).
- **A scheduled task** runs a GUI-subsystem program (`harness-launch.exe`), never `powershell.exe` or `cmd.exe` in
  the person's session. `powershell -WindowStyle Hidden` still flashes before it hides.
- **Test helpers follow the same rule.** A script that runs on someone's computer through a scheduled task must run
  hidden (WScript `Run line, 0, True`). A window from a test looks exactly like a window from the product.

Prove it by recording, not by watching: list the visible windows of class `ConsoleWindowClass`,
`CASCADIA_HOSTING_WINDOW_CLASS` and `PseudoConsoleWindow` every 40 ms through the flow you changed, with each owner's
command line. A person's eye misses most of them, and a run over SSH sees none, because SSH lands in session 0.

Sources: [Node `child_process`](https://nodejs.org/api/child_process.html) (`windowsHide` defaults to `false`
everywhere), [Process Creation Flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags),
[Creation of a Console](https://learn.microsoft.com/en-us/windows/console/creation-of-a-console), Dart SDK
[`process_win.cc`](https://github.com/dart-lang/sdk/blob/main/runtime/bin/process_win.cc).

## 2. Starting processes

- A **detached PowerShell has no console, exits 0, and runs nothing.** A zero exit from it proves nothing: check the
  result the script should have made.
- Node ends a child that is not detached when Node exits (a kill-on-close job). Only that direct child: what the child
  starts in turn is outside the job.
- SSH sessions and scheduled tasks end their children too. A survival test run through either one tells you nothing about
  a person's computer. Test from the app.
- `-EncodedCommand` makes PowerShell write CLIXML to stderr. Use `-Command` when anyone reads the error.
  Inside `-Command`, `-ErrorAction Stop` needs `try`/`catch` for the script to end.

- **A paste can arrive as keys.** The Mac gets one paste event, so Enter after it is safe. Codex on Windows gets a stream of key
  presses, and an Enter within 120 ms of the last becomes a newline in the paste (codex-rs `paste_burst.rs`): the message stays in
  the composer and every later one waits behind that "draft". Wait for the paste to show on screen (`lib/pasteOnScreen.ts`), not a
  fixed time.

## 3. Files

- **A file's change time moves when its last handle closes**, after a rename that published it. Measured 2026-11-05: `ctimeNs`
  differed before and after `close`. Do not compare it across a close: three plugins were written and then reported as failed
  (`hookFileVersion` in `cli/src/engines/kit/nativeHookFiles.ts`).
- **A rename over a read-only file fails with `EPERM`.** A file we write read-only stops every later refresh unless it is made
  writable first (`writeCopies` in `cli/src/superTabs/buddyHome.ts`).
- **There is no `ps`.** Read the process table through `lib/windows/processTable.ts`. A check that treats a failed `ps` as "gone"
  quietly does nothing on Windows: viewers piled up for that reason (`dsh/viewerLedger.ts`).
- **What Git Bash runs has a parent that has gone.** Walking Windows' parent links does not reach it (`lib/windows/gitBashTree.ts`).

## 4. Screens a person sees

- **A mouse has no sideways scroll.** Anything that overflows sideways needs arrows and the wheel, or what falls off the end looks
  deleted (`scrollsTabsByMouse` in `desktop/lib/widgets/workspace_tab_scroller.dart`).
- **A window that nobody asked for is rule 1.** A prompt nobody can answer in a hidden pane is its sibling: answer the exact screen
  safely or fail the start with a reason (`cli/src/superTabs/startScreen.ts`).

## 5. Testing on Windows

- Test in the person's session (session 1) and in the signed build. Windows behaves differently in session 0 and for an
  unsigned file.
- `SendKeys` Ctrl+Shift chords do not reach the app. That is the test's fault. Send real key events (`keybd_event`).
- Claude Code on Windows takes a pasted image on Alt+V, not Ctrl+V.
- Check the machine chip says This Computer before you start anything: a new Harness can default to another machine.
- Files and secrets: read a config file by key name. Never print `config.toml` or similar: it can hold a plain API key.

## 6. Words

Windows people read "Windows" or "this computer", never "Mac", "Finder", "Terminal.app" or `~/`. Text shared by all
platforms says "this computer". See the [Naming System](naming-system.md).

## When you find a new one

Add it here in the same change as the fix: what happened, what was measured, the rule. Add a test that fails if it comes
back, where a test can catch it. A note alone did not stop the last one.
