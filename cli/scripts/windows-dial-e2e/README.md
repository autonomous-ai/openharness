# The dial's desk on Windows

Hand checks of the dial on Windows (docs/plans/2026-11-19-dial-windows-plan.md, Task 24), on the VM and on the x64 test
PC (the Dell):

- `desk.mts`: a daemon of the branch on a stand-in dial or on the real one, or a read-only look at the real dial.
- `console.ps1`: runs a script in this account's console session from SSH, which a desk needs to see the screen the
  person sees.
- `bundle.mjs`: the desk and the CLI it runs, built as plain JavaScript for a machine that runs only signed programs.

## Smart App Control

The Dell has Smart App Control on, and it stays on: Windows runs no unsigned program there, so neither esbuild (tsx, the
CLI's build) nor a branch build of `harness-serial.exe` or `harness-pty.exe` runs. So:

- the desk and the CLI are built on the Mac, `cd cli && node scripts/windows-dial-e2e/bundle.mjs <out>` (`<out>` empty
  or new), and `<out>` is copied over whole. The desk is then `<out>\scripts\windows-dial-e2e\desk.mjs`, which needs no
  `node_modules` and starts the `cli.js` beside it;
- they run under the installed release's own signed programs, in `%USERPROFILE%\.harness\runtime`: the `node.exe` that
  `current-node` names, and the `harness-serial.exe` and `harness-pty.exe` in `pty\<the folder current-pty names>`
  (release 0.6.22 or later). `--serial-bin` names that `harness-serial.exe`, and `HARNESS_PTY_BIN` that
  `harness-pty.exe`.

The release's `harness-pty.exe` has no `raise` (Task 26), so on such a machine a tap's raise is not checked.

A script for `console.ps1` that runs the desk so, `run-desk.ps1` beside `desk.mjs`:

```powershell
$runtime = Join-Path $env:USERPROFILE '.harness\runtime'
$pty = Join-Path $runtime ('pty\' + (Get-Content (Join-Path $runtime 'pty\current-pty') -TotalCount 1).Trim())
$env:HARNESS_PTY_BIN = Join-Path $pty 'harness-pty.exe'
& (Get-Content (Join-Path $runtime 'current-node') -TotalCount 1).Trim() (Join-Path $PSScriptRoot 'desk.mjs') @args
exit $LASTEXITCODE
```

The signed `harness-serial.exe` is then `<that pty folder>\harness-serial.exe`, given whole as `--serial-bin`.

## The desk's modes

A desk's first line is `{"desk":{"dataDir":…,"port":…,"root":…}}`, so a shell started for herdr or a hand-run hook can
name them. It names local paths: it stays on the machine.

- **The stand-in, sealed**: `desk.mjs --sealed [--port <n>] [--quit-on <file>]`. Task 23's daemon, sealed in a
  throwaway root, on a stand-in dial that greets as the firmware does. stdin takes one command a line: `list` (the
  rows of the last list), `tap <row>`, `rest <row>` (the dial turns to the row), `say <row> <text>` (the dial sends the
  text, `turn.send`), `pick <app>` (`app.pick`, a host id), `quit`. Each message the daemon sends the dial is printed
  as one JSON line, its keepalive pings aside.
- **The stand-in, the account's own**: the same without `--sealed`. It uses the engines, editors and apps of the account
  it runs as, and sets their hooks up, with Harness's folders in `%USERPROFILE%\.harness-dial-check`, kept after
  `quit`. **Only the VM's test user, never a person's own account.**
- **The look**: `desk.mjs --dial-read <COMn> --out <file> --serial-bin <exe> [--against <first read>]`. It opens the
  port with `harness-serial.exe open`, waits up to 20 s for the dial's own `hello` (a dial in a session greets every
  15 s, alone every 2 s), writes not one byte to the port and closes it. It writes `<file>` whole and owner-only:
  `{"settings":{…},"pets":<n>,"petIds":[…],"at":<ms>}`, with no serial and no mac, and prints `pets: <n>` and the
  settings' field names, never their values. With `--against`, it prints `settings: unchanged` or
  `settings: changed (<fields>)`, and `pets: unchanged` or `pets: changed`.
- **The real dial**: `desk.mjs --dial <COMn> --speech <text> --first-read <file> --pets-from <dir> --serial-bin <exe>
  [--port <n>] [--quit-on <file>]`. A daemon sealed as Task 23 seals it (nothing of the account is set up or read),
  on the real dial through the signed helper, with `CABLE_FW_DISABLE=true`, which no flag turns off: the dial is never
  flashed. It is signed in to a FakeBackend on 127.0.0.1 alone, which hears every recording as `--speech` (at most 200
  characters). It prints the daemon's `[device]` and `cable:` lines, with a mac or a serial cut to its last 4
  characters. stdin takes `list` (how many rows the daemon last sent the dial), `pane <name>` and `quit`; the dial's
  presses are the person's. `pane` is not on Windows: the e2e's stand-in engine starts through a Unix wrapper, and the
  only way Windows' program resolver runs a script engine is an npm shim, a batch file. So the dial's words reach an
  agent only through herdr or another app here; on the VM they are checked with the engines of the test user.

`--quit-on <file>` (both desks): the desk quits once `<file>` exists, checked once a second. A desk in a `console.ps1`
task has no stdin to type into. `quit` stops the daemon; a sealed desk then deletes its root.

The real dial is left as the first look found it:

- **Pets.** Before the daemon starts, `--pets-from`, the owner's devices pets folder (`%USERPROFILE%\.harness\devices\pets`
  unless the owner set `HARNESS_DEVICES_DIR`), is copied into the desk's own devices folder, read and never written: its
  `<id>.hpet`, `<id>.png`, `<id>.json` and `pets.json`. The daemon's greeting then drops none of the dial's pets. The
  desk stops (exit 4) before the daemon starts, and nothing talks to the dial, when the dial holds pets and the folder
  cannot be copied, or `pets.json` does not name each pet the first look found. A folder that is not there, on a dial
  that holds no pet, is an empty copy.
- **Settings.** On `quit`, before the daemon stops: when the dial holds other values than the first look for the fields
  `settings.set` takes (brightness, character, muted, quiet, straightTitle, focusFace, scrollReversed, voiceLang, and
  uiSkin and followCompanion when the first look has them), one `dial_settings` writes the first look's values back for
  exactly those fields, and the dial's own answer is checked within 10 s. It prints `settings: unchanged`,
  `settings: restored (<fields>)` or `settings: not restored (…)`.
- **A last look.** Once the daemon has let the port go, the desk looks at the dial again and prints `pets: unchanged`
  or `pets: changed`.

Exit codes: 1 not on Windows, or the desk failed (it says what); 2 bad arguments, before anything starts; 3 a port is
busy (the daemon's `--port`, or the COM port still held after 10 s); 4 the dial must not be greeted (no `hello` in 20 s,
or pets the desk would drop); 5 the settings were not restored, or a look `--against` found them changed; 6 the dial's
pets changed. A desk refuses port 18473, the account's own daemon's.

## console.ps1

Run over SSH as the account whose console session it is, from the folder it is in:

- `console.ps1 -Script run-desk.ps1 -ArgsJson '["--dial-read","COM3","--out","C:\\…\\first-read.json","--serial-bin","C:\\…\\harness-serial.exe"]'`
  waits for the script (`-TimeoutSec`, 600 by default), prints its output and `exit <code>`, and exits with that code.
- `-NoWait` prints the task's name (`harness-dial-check-<32 hex>`) and returns; `<this folder>\<name>.log` grows as the
  script writes.
- `-Stop <name>` waits up to 90 s for the task to end (write the desk's `--quit-on` file first), ends what is left,
  prints the log and `exit <code>`, and deletes the task and its files.

It registers a one-shot task under this account with an interactive logon and no stored password, and starts the script
through Windows' own `conhost.exe --headless`, so no window shows and nothing is compiled. Exit 3: this account has no
console session. A task still running at its timeout is ended with everything it started.

## The VM

The VM's test user's session (`desktop/scripts/windows-e2e/desktop-e2e.sh run`), the bundle copied over, the stand-in
modes. The unsealed stand-in is for this user only.

## The Dell

Every step through `console.ps1`, in the owner's console session; SSH runs only what needs no desktop. Ports 18478 and
18479.

1. `harness status`: keep `running` or `stopped` and the version, nothing else.
2. If it runs, `harness stop`. Then the first look, `--dial-read COM3 --out <run>\first-read.json`, must exit 0; exit 3
   means something took `COM3` again (the owner's Harness Desktop may have started its daemon): stop the run.
3. The desks: the sealed stand-in (`--sealed --port 18479`) and the real dial (`--dial COM3 --speech <text>
   --first-read <run>\first-read.json --pets-from <the owner's pets folder> --port 18478 --quit-on <run>\quit`), each
   with `-NoWait`, then quit through its `--quit-on` file and `-Stop`. A real-dial desk that ends 4, 5 or 6 stops the
   run.
4. The last look, `--dial-read COM3 --out <run>\last-read.json --against <run>\first-read.json`: `settings: unchanged`
   and `pets: unchanged`.
5. If the daemon ran in 1: `harness start`, then `harness status` says running at the version kept in 1, and
   `--dial-read COM3 --out <run>\held.json` exits 3 and writes nothing. A daemon stopped in 1 is left so; the run checks
   only that `COM3` is free.
6. Clean up: stop the desks, `harness stop` on each root, delete the roots, the reads and the copied folder.

Nothing with a full serial, the owner's account name or a personal path leaves the Dell: the desks' first lines and the
reads stay there.
