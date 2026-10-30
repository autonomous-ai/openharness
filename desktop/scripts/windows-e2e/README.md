# Windows desktop E2E tools

Run from the Mac with Python 3 (standard library only), Bash, SSH/SCP, OpenSSL,
expect, Node, shellcheck, curl and gh. No Mac Harness installation is used.

```sh
export E2E_WORK=/private/tmp/my-owned-desktop-run
export E2E_VM_ROOT='C:/path/to/the/controllers/owned/scratch'
export E2E_USER=hxe2etool
D=desktop/scripts/windows-e2e/desktop-e2e.sh
$D preflight
$D user-add
$D ps parse-check.ps1
$D admin parse-check.ps1
```

`VM_HOST` defaults to `192.168.65.3`. `E2E_WORK` defaults to ignored `.work/`;
it contains private run/account receipts and passwords, never commit it.
`VM_ADMIN` names the administrator account (default `admin`, the ARM64 VM's). For the x64 test PC (sub-project E,
the dial) set `VM_HOST` and `VM_ADMIN` to the values the owner gives; they are never written in the repo.
`put-admin <file>` copies one file (`harness-serial.exe`) into this run's admin scratch folder.

After owner-approved access and confirming no other process holds the dial, use
`$D put-admin path/to/harness-serial.exe` and `$D admin serial-check.ps1 Port=COM3 Seconds=10`.
`WatchOnly=true` reports the attachment session without opening the port. The measurement
exits nonzero on a failed check, missing attachment session, or helper error/timeout;
serials are shortened and native diagnostics are redacted. `Seconds` accepts 1-300
(default 10); helper startup and exit waits each have a five-second deadline.

- `$D ps dial-state.ps1 Lines=8`: read host/device state, this user's serial-process count and recent dial heartbeats/cable events; identifiers are shortened and settings values omitted. A failed device query returns nonzero after the remaining diagnostics.
- `$D run hold-port.ps1 Port=COM3 Seconds=30`: hold a COM port for 1-300 seconds, then release it; an unavailable port exits 3.
- `$D ps install-build.ps1 'Zip=Downloads\dial-install.zip'`: unpack a manifest build with `install.ps1` at the zip root, install it into this owned profile with updates disabled, and print its version; installer/version failures return nonzero.
- `$D run harness-cli.ps1 'Arguments=["start"]'`: run `start`, `stop`, `flash` or `uninstall` in the owned active desktop session, print the exit code and last 15 output lines, and return that code; argument arrays also support `'Arguments=["flash","--version","0.0.70"]'`.

`EV` defaults to `$E2E_WORK/evidence`; inspect/redact screenshots before sharing.
`E2E_VM_ROOT` is an optional admin scratch parent (default: admin's TEMP).
The tools create a new `harness-desktop-e2e-<run-id>` child, never adopt an
existing directory without this run's receipt. B's user tools stay in the fresh
user's `e2e/` folder. `VM_KEY` is consumed by B's unchanged first-login helper.

`install-state.ps1` (sub-project F) says what an install left for the test user, read-only: the version folders,
the shortcut and keys, how many installed files carry a Zone.Identifier, the browser's mark on the downloaded
installer, the installer's temp folders and log.

Root must establish the fresh user's interactive console without reboot,
autologon, or signing admin out. `session-on` verifies the recorded SID/profile,
active console and accessible Default input desktop, starts an owned keep-awake
task, and takes a screenshot. It fails actionably if no suitable desktop exists.
Inspect the screenshot; parsing/local tests do not prove a visible GUI.
`session-off` stops only recorded keep-awake tasks and leaves the login intact.

Before `run selftest.ps1`, root must protect the host clipboard if SPICE shares it:
use the approved private in-memory snapshot and conditional owned-value restoration
transaction, without overwriting a later unrelated write. Supply a unique known
test value with `ClipboardMarker=HX_E2E_<unique-value>` if the transaction needs
an exact expected value. Unsupported clipboard formats leave that acceptance row
unverified. Selftest writes clipboard text, clicks at 40,40 and intentionally opens
a console positive control; never run it on admin's desktop. Expected output is
five `ok` checks, `probe: seen`, and `0 check(s) failed`.

`driver` builds/copies B's PTY driver. Each `e2e\driver.cmd` invocation reads
the new user's actual `daemon-18473.json` port and sets process-local `E2E_PORT`.
Missing/invalid records fail; there is no fallback to the shared 18473 listener.
Configured CLI `PORT` and Desktop's normal base remain 18473. B is unchanged.

`cleanup` requires the positive creation receipt/SID, records process identities,
and removes only that account's processes, recorded tasks and matching profile.
Failures retain recovery receipts/passwords. After the last account is removed,
the owned admin scratch and any owned local CDN process/CA are removed. Baseline
comparison reports disappeared preexisting processes/tasks/listeners for inspection;
it never tries to stop or restore unrelated work. Private logs/zips/receipts remain
for review. Do not delete `.work` until uncertain outcomes have been resolved.

`cdn-ca`, `cdn-stage`, `cdn-serve`, and `cdn-stop` manage only a marked local CDN
directory/process. `cdn-on`/`cdn-off` return unavailable on this shared environment:
no global hosts/DNS/LocalMachine CA mutation is performed. `winlogon.ps1` is a
read-only status diagnostic; enable/disable return unavailable. Root schedules any
separate environment transaction. There is no UTM power/input invocation here.

`fetch`, `put`, `variant`, `truncated`, `shot`, `state`, `logs`, `procs`, `kilo`,
`run`, `ps`, `admin`, `sh` and `sh-admin` follow the task brief's command forms.
`sh-admin` is an explicit root/operator escape hatch, not used by routine flows.
`RUN_TIMEOUT` defaults to 120 seconds. `E2E_RAW=1` is private unredacted output for
machine consumption; do not put it in public evidence. GUI tool parameters travel
as base64 JSON; PowerShell source travels as UTF-16LE EncodedCommand.

The bundle helpers require the icon and private `harness_pipe_io.dll` sibling.
Broken variants remove only the promised app executable or AOT snapshot.
`compare-runs` accepts complete JSON reporter logs or Desktop runner receipts;
empty/incomplete/orphan-error evidence and missing declared inventory fail,
while completed known-failing runs remain comparable. A verified loader retry
replaces its earlier attempt; Windows/Mac paths become desktop-relative paths.

Local checks:

```sh
python3 -m unittest discover -s desktop/scripts/windows-e2e -p 'test_*.py' -v
bash -n desktop/scripts/windows-e2e/desktop-e2e.sh
shellcheck desktop/scripts/windows-e2e/desktop-e2e.sh
```

Windows PowerShell 5.1 parsing, Add-Type/hxrun compilation, scheduled-task behavior,
screenshots/UIA/input/clipboard/console detection and owned cleanup still require
the root-owned native validation. No local test claims those checks passed.
`test_serial_check.py` runs the measurement script against a private fake executable
on Windows with Python and Windows PowerShell 5.1. It checks success, failure,
timeouts, redaction and child cleanup without opening a port; other hosts skip
these tests explicitly. Real dial measurements remain separate acceptance evidence.
