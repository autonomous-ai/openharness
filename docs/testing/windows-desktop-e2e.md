# Windows desktop end-to-end results

Status: **in progress**, 20 October 2026. This is the C5.2 acceptance record for
[`feat/windows-desktop`](../superpowers/plans/2026-10-18-windows-desktop.md#task-c52-the-seven-scenarios-on-the-vm-and-docstestingwindows-desktop-e2emd).
The seven scenarios are defined in the [Windows desktop design, §4.4](../superpowers/specs/2026-10-18-windows-desktop-design.md#44-end-to-end-on-the-windows-11-arm64-vm).
Desktop **1.0.0**, **1.0.1**, **1.0.2**, and uninstall-fix **1.0.3** were published to staging
for ARM64 and x64. An earlier ARM64 **1.0.1-rc1** ZIP and local x64
Debug/Release builds were used for diagnosis; those were not the staging N1.
The ARM VM now has staging CLI `0.4.21-dev.win1` and PTY `0.4.19`. The x64 VM
has the same staging CLI and PTY files. Its test-only PTY `0.4.18` host was
retired after the update checks, and a published `0.4.19` host started in a
different Windows session. No PR, merge, or production release is part of this
record.

## Summary

| # | Scenario | Result at this snapshot | Driver |
| --- | --- | --- | --- |
| 1 | First install, sign-in, same-version launch | Partial: N installed and same-version launch converged to one installed window. Mark-of-the-Web launch and SmartScreen behavior unresolved. | Script, visual automation; sign-in authorized through existing account session |
| 2 | This computer, terminal, Add Phone, remote Mac | Partial: owned terminal creation, `WIN_42` output, two HTTP 200 handoffs across daemon recovery and remote row observed. ARM RC1 Ctrl+C failed; patched host passed with local x64 Release and published x64 N1 apps. Published PTY 0.4.19 GUI Ctrl+C remains unverified because the serving ARM host is still 0.4.18. | Visual automation, Script |
| 3 | Notifications, tray, links, paste and font | Partial: tray/links/font and local x64 composer paste observed. One N1 hidden-app Kilo turn stalled while the backend was offline, so completed-turn toast/click and full tray working row remain unverified. | Visual automation, Script |
| 4 | Staging updates and broken-build rollback | Partial: real 1.0.0 → 1.0.1 GUI update passed on both VMs. The 1.0.1 → 1.0.2 update kept the ARM counter rising and repaired Settings `DisplayVersion` on both VMs. Fake-CDN broken-build rollback remains unverified. | Script, visual automation |
| 5 | Uninstall through Windows Settings | Passed on 1.0.3 after a 1.0.2 timing failure was fixed: holding the final dialog open over three minutes did not start cleanup early; after OK, the app folder and registrations disappeared while CLI, daemon and agents stayed. | UI Automation |
| 6 | x64 desktop on ARM64 | Partial: published x64 1.0.3 installed and rendered under emulation; tray and Settings uninstall passed. Add Phone returned 502 while the backend was offline, so its HTTP 200 criterion remains unverified. | Script, visual automation, UI Automation |
| 7 | Install desktop by one PowerShell command | Partial: the staging one-liner installed ARM64 1.0.3 with no observed SmartScreen prompt or downloaded-file markers, and Settings uninstall preserved the CLI and agents. Its first-run client area was white; rendered UI and full console completion copy remain unverified. | Script, visual automation, UI Automation |
| — | Windows PC controlled from the Mac desktop | Pending owner check. | Person |

The [Windows Desktop workflow run 39298570517](https://github.com/autonomous-ai/openharness/actions/runs/39298570517)
passed its x64 and ARM64 test jobs at code commit `290ce5e83`; that is build and
test evidence, not a pass for the remaining live scenarios. The staging-trigger
commit immediately after it had the same source tree. The first CLI/PTY staging
attempt for newer versions stopped at a Windows-only test-fixture error before
publication. The corrected [CLI/PTY run 39309042273](https://github.com/autonomous-ai/openharness/actions/runs/39309042273)
published CLI `0.4.21-dev.win1` and PTY `0.4.19-dev.win1`, with served bytes
verified. The [Desktop N1 run 39309318609](https://github.com/autonomous-ai/openharness/actions/runs/39309318609)
published x64 and ARM64 `1.0.1` ZIPs and verified the served manifest and
artifacts. The real N → N1 updates described below add live evidence; the
broken-build rollback remains open and the one-command installer is partial.
The [full Windows run 39313769196](https://github.com/autonomous-ai/openharness/actions/runs/39313769196)
passed both x64 and ARM64 jobs with the Settings-version launcher fix at
`147ca03bd`, including the one-command installer specs. The [1.0.2 staging run 39323499313](https://github.com/autonomous-ai/openharness/actions/runs/39323499313)
built both packages and passed the served-byte checks. The [Windows run 39330487316](https://github.com/autonomous-ai/openharness/actions/runs/39330487316)
passed both architectures at the uninstall-dialog fix `826608097`. The
[1.0.3 staging run 39338310778](https://github.com/autonomous-ai/openharness/actions/runs/39338310778)
built both packages and verified served bytes; the CDN manifest names 1.0.3
on both architectures. The 1.0.3 ARM Settings retest below passed after the
1.0.2 timing failure. The [staging app-installer run 39343243147](https://github.com/autonomous-ai/openharness/actions/runs/39343243147)
published `desktop/install.ps1` and verified its served staging lines. The
served file's SHA-256 matched the local `--app --print` output:
`a6309048b7987a1c0062b4a77fa364bf0bd1f25afa11a454475cb51e1921ae09`.
The [full Windows run 39343243094](https://github.com/autonomous-ai/openharness/actions/runs/39343243094)
then passed its x64 and ARM64 build, Rust, full Flutter, trusted-pipe,
single-instance and one-command installer jobs at `4ba0c9359`. Subsequent
commits changed only the Desktop workflow trigger, its focused test and this
E2E record; no runtime source changed. The trigger removal passed its focused
Vitest test and `actionlint`.

## Setup and evidence

The ARM64 Windows 11 VM was exercised in a dedicated standard-user desktop
session, using the C5.1 one-shot interactive-session runner, Windows UI
Automation where it exposed controls, screenshot-grounded visual automation
for Flutter controls, and the owned CLI/PTY driver for read-only terminal
observations. The driver was changed to a passive screen reader after its
earlier screen command was found to take terminal control from Desktop. A
separate Windows x64 VM was used for local Debug/Release checks. Both VMs had
owned test terminals; existing unrelated panes were left untouched.

The detailed receipts and screenshots remain in the ignored C5.2 execution
scratchpad, not in this public document. They include account or pane content
in some captures. No screenshot is included here until it has been reviewed and
masked. Test account names, machine identifiers, QR codes, credentials,
private clipboard contents and unrelated terminal content are omitted here.
The setup's full preflight, autologon restoration and final cleanup still need
one consolidated acceptance receipt; their completion is not inferred from a
rendered app window.

## Scenario results

### 1. First install

The staging ARM64 N ZIP was extracted into a path containing Vietnamese
letters, spaces and shell punctuation. Its launcher installed the desktop for
the owned user and a signed-in session was observed. Launching the same N ZIP
again resolved to one window running from the installed path. A later local
reinstall of N after a diagnostic build opened one installed window in **14.7
seconds**; this measures that reinstall only, not the first-install journey.

The Mark-of-the-Web copy carried a downloaded-file marker. Its first launch
timed out after 45 seconds. A bounded retry returned after roughly 51 seconds,
but the existing installed process and launcher log did not change, and no
SmartScreen prompt was visible. Execution of that marked launcher is therefore
unproved. The first cold start also showed a temporary computer-check timeout;
the later signed-in state does not establish a clean first-run sign-in path.

### 2. This computer

The app's **File → New Harness** composer created an active Terminal harness
in an owned folder on the ARM VM. In the installed RC1 after relaunch, visual
typing of `Write-Output WIN_42` and physical Enter produced `WIN_42` plus a
returned PowerShell prompt in both the GUI and a passive PTY read. A later
single physical printable key was seen in the correct owned pane; this does
not prove cold first-key reliability. Earlier first-launch attempts had missed
printable input, and their lifecycle cause remains unknown.

The ARM RC1 GUI started `ping -t 127.0.0.1`, but three Ctrl+C input variants did
not stop it. The exact owned process was stopped separately for cleanup. A
Windows PTY host fix was verified with a failing-then-passing ARM regression
and the full Windows PTY suite. A local x64 Release desktop using that patched
test host then sent Ctrl+C through GUI → daemon → PTY, stopped its owned ping,
and returned to the prompt. The published x64 N1 desktop later repeated the
GUI Ctrl+C check on that same test-only patched PTY host: an owned `ping -t`
child exited, `Control-C` and the prompt appeared, and the app and host PIDs
stayed running. This proves the N1 GUI path with the patched host, while the
published PTY 0.4.19 runtime still needs an integrated live check. The local
x64 Release also passed Ctrl+Shift+V paste and Ctrl+Shift+C copy of a
synthetic marker. That local clipboard result does not validate staging N1.

Add Phone returned HTTP **200** before and after the owned daemon restarted.
The app discovered a changed trusted pipe; the observed recovery took about
**91 seconds**, not the plan's sample 20-second wait. The remote Mac row was
visible and untouched. ARM clipboard checks were held because the shared
pasteboard could not be safely restored by the test helper. The x64 local
Release clipboard result does not substitute for ARM staging acceptance.

### 3. Native Windows behavior

On ARM RC1, hide-to-tray and restore kept a single app process; the tray menu
showed Open and Quit. Edge's native protocol prompt opened an owned terminal,
a shell fork link reached the app's message flow, and a link into a closed app
opened one window in roughly **2.5 seconds**. Two shortcut launches **300 ms**
apart converged to one process and window. The notification link had no clear
dispatch log, so exactly-once delivery is not proved. The font picker visibly
listed Cascadia Code variants.

On local x64 Release, first hide showed the Windows “still running in the tray”
toast, second hide did not repeat it, and the tray icon restored the same
window. Bitmap, PNG and file-drop clipboard representations each attached one
synthetic image in the New Harness composer. A test-helper clipboard restore
error was diagnosed and corrected for the synthetic text baseline; arbitrary
pre-existing clipboard formats were not proved restorable.

An owned Kilo turn on hidden staging N1 also did not complete: the backend
was offline before the turn and then reset the connection. The counter pane
continued to advance, and the N1 window restored from its tray icon without
changing app, daemon or PTY PIDs. The product's completed-turn toast and its
click target remain unverified. An
interactive native probe showed that Windows could post a generic toast, but
the product's permission check had returned HRESULT `0x80070490` earlier;
the probe is not product-toast evidence. The working-agent tray row was also
not demonstrated. These findings keep the scenario partial.

### 4. Update and rollback

On the x64 VM, the installed N binary and launcher matched the published N
ZIP. Its signed-in UI offered 1.0.1. Clicking Update showed installation
progress, then changed `current` to 1.0.1 and `previous` to 1.0.0. One N1
window opened; its executable and launcher matched the published N1 ZIP. The
PTY host PID and all six owned Node PIDs were unchanged. About showed 1.0.1;
the old and new app folders remained, with no staging folder. This was a real
staging GUI update, but the bounded GUI attempts to start a long-running
terminal command on N yielded only blank prompts, so a live counter was not
established there. After the update, a bounded physical-key and GUI check on
the same owned terminal executed a synthetic `Write-Output` marker and showed
the expected output and a new prompt; the input failure did not recur in N1.

On ARM64, the owned user installed staging CLI `0.4.21-dev.win1` and PTY
`0.4.19` first. This intentionally restarted that user's daemon; its new
master/core PIDs were recorded before the app update. N offered 1.0.1 through
the real staging manifest. After Update, `current=1.0.1`,
`previous=1.0.0`, one N1 window rendered, and About showed 1.0.1. The N1 ZIP
matched the manifest's size and SHA-256. The master, core and PTY host PIDs
stayed unchanged across the app update. A corrected, credential-aware passive
E2E driver then listed the same five owned agent IDs as before the CLI and app
updates. A scoped quit and shortcut start left one rendered N1 window, only
the N and N1 app folders, and no staging folder. The footer visibly separated
words and counts; the terminal font was compact and unclipped in the normal
pane. A new owned terminal counter rose from `COUNT_14` to `COUNT_31` before
the next update and later to `COUNT_2862`; continuity across this first
N → N1 update cannot be claimed.

The x64 VM then upgraded its owned CLI to staging `0.4.21-dev.win1` and
installed PTY `0.4.19`; the new PTY executable matched the published hash.
Its previously running test-only `0.4.18` PTY host remained alive and served
even a newly created GUI Terminal, so the x64 GUI Ctrl+C checks cannot be
attributed to the published PTY. The old terminal reported `offline ready`
after the daemon restarted, despite its PowerShell and host processes staying
alive; the cause remains unproved. The new owned Terminal was active and
passed GUI ping/Ctrl+C on that old host. The x64 N1 app stayed signed in.

After the x64 N1→N2 continuity checks, both owned test agents were stopped
through the Harness API and their two pane processes ended. The idle patched `0.4.18`
host was then stopped with an exact process-owner and image guard. A new host
started from the published `0.4.19` executable, whose hash matched the served
artifact, but another daemon in Windows session 0 won the shared-home startup
race. The GUI and owned test daemon were in session 1. No GUI terminal was
opened against the session-0 host, so the published-host GUI Ctrl+C path is
still unverified.

A later read-only ARM check found its rendered 1.0.3 app and serving PTY host
both in Windows session 2, but the host process still ran from the `0.4.18`
runtime path. The installed `0.4.19` file had a different hash and was not the
serving process. No new terminal or Ctrl+C attempt was made on that host; its
seven existing agents were left running.

Both VMs then offered the published 1.0.2 update in their installed N1 GUIs.
On x64, Update changed `current/previous` to `1.0.2/1.0.1`, wrote `.started`,
removed temporary staging folders, and opened one signed-in 1.0.2 window.
The app executable and launcher matched the verified x64 ZIP. About and the
Windows uninstall entry both showed 1.0.2, including after one scoped quit
and Start-shortcut relaunch. Daemon and PTY PIDs and both owned agent IDs and
statuses survived. The old test-only PTY host still served the terminals.

On ARM64, Update also changed `current/previous` to `1.0.2/1.0.1`, wrote
`.started`, removed temporary staging folders, and rendered one signed-in
1.0.2 window. About and the uninstall entry showed 1.0.2. The same owned
counter pane advanced from `COUNT_4108` before Update to `COUNT_4403` after
it; daemon, core, worker and PTY host PIDs stayed unchanged. A GUI Quit later
hid the window and removed the tray icon, but the app process remained alive
for at least 47 seconds and exited by itself within 4 minutes 38 seconds.
No process was killed. A subsequent installed-shortcut launch started one
rendered, signed-in 1.0.2 window. The pointer and registry stayed at 1.0.2;
the same seven agent IDs remained and the counter rose from `COUNT_4940` to
`COUNT_5094` after that launch. The daemon, core, worker and PTY host kept
their original PIDs and start times.

Both VMs still had `DisplayVersion=1.0.0` in their Windows uninstall registry
entry after N1 was running. The updater swaps the installed files and pointer
without calling the install path that writes that value. A launcher fix in
`147ca03bd` now refreshes the existing entry from the version it opens. Its
focused Rust desktop suite passed 97/97, and the published 1.0.2 GUI update
confirmed the corrected registry value on both VMs. The malformed, unpublished broken-build variants
have not run: their planned fake HTTPS CDN needs machine-wide hosts and
certificate changes, which were not made on the shared ARM VM. Unit tests of
corrupt ZIP and rollback states are separate evidence.

### 5. Uninstall; 6. x64 on ARM; 7. One-command install

Windows Settings found the installed Harness 1.0.2 row, opened its menu, and
invoked both Uninstall controls through UI Automation. The installed-app count
fell from 43 to 42. Harness showed the final sentence that its command line
and agents stay on the PC. The protocol and uninstall registry entries and
Start shortcut disappeared; the same daemon PID, seven agent IDs and rising
counter remained. But `app/1.0.2` and the install folder still existed after
the final dialog closed. The cleanup script's own log said it left the folder
because its launcher was still running. Its failure timestamp preceded the
final OK click: the script's roughly two-minute wait expired while the modal
dialog kept the launcher alive. This is a failed full-uninstall check, not a
successful Settings uninstall. The partial state was preserved for a fix and
retest. Commit `826608097` moves script startup after the modal closes and
adds a regression for that order. Windows CI passed.

The published 1.0.3 ARM64 ZIP matched the staging manifest's SHA-256
`f754c3fd976647a83ef13db18095885ab18e5bf1dc7085358ea74f00c15082af`
and 103046548-byte size. Its launcher installed over the partial 1.0.2 state
without manual cleanup: `current=1.0.3`, `previous=1.0.2`, Settings version,
shortcut and protocol registration were restored, and one signed-in window
rendered. The seven agent IDs and their daemon/PTY PIDs stayed intact.

Windows Settings then invoked Uninstall for 1.0.3. The final Harness dialog
stayed open for over three minutes; before OK, no new cleanup script, task
file or failure log existed. After the exact OK click at 23:21:48 UTC, the
install root was absent by 23:22:15. Registry entries, shortcut and desktop
app state were absent; no desktop process remained. The CLI daemon/core/worker
and PTY host kept their original PIDs and start times, the same seven agent IDs
remained, and the owned counter advanced from `COUNT_11929` to `COUNT_11966`.
The new cleanup script removed itself without leaving a failure log. This
passes Scenario 5 on the fixed staging build.

The published x64 1.0.3 ZIP matched the staging manifest's 104011999-byte
size and SHA-256
`d22a129e40dcb43918f7449456181f54b9b81b79903480e326a24983bd34cf26`.
Its launcher installed the x64 app under ARM64 emulation. One signed-in window
rendered with This Computer visible; the native tray icon existed. Add Phone
opened its dialog, but `/api/auth/handoff` repeatedly returned HTTP 502 while
the daemon reported backend offline and connection resets. No HTTP 200 was
observed, so this does not prove the x64 FFI/pipe handoff criterion. A later
read-only check still found 30-second `ECONNRESET` retries, while DNS, TCP 443
and unauthenticated TLS/HTTP to the backend succeeded; the authenticated
WebSocket path remained unhealthy. Settings
then uninstalled the app through its final dialog. The install root, registry
entries, shortcut and app state disappeared; no desktop process remained. The
CLI stayed signed in with the same seven agents and unchanged daemon/core/worker
and PTY host PIDs; the owned counter advanced to `COUNT_12973`. Scenario 6 is
partial, with its cleanup criterion passed.

The staging `desktop/install.ps1` served the staging manifest base and enabled
app installation. Its real `irm …/staging/desktop/install.ps1 | iex` command ran
in the owned user's GUI PowerShell session. After **53.7 seconds**, one installed
ARM64 1.0.3 app process and window appeared. The version pointer, `.started`,
Settings version, protocol and Start shortcut matched 1.0.3. No SmartScreen
prompt was observed during the watched interval. Installed files had **zero**
`Zone.Identifier` streams, and **zero** staging temp folders remained. A single
same-version rerun showed part of the expected completion copy and the `still
here` sentinel; the app obscured the full text before the console closed. The
first-install screenshot showed a **white client area**, so a rendered signed-in
UI was not established by the process and file checks.

Settings then uninstalled 1.0.3 through the native final dialog. The install
root, registry entries and shortcut disappeared, with no desktop process left.
The CLI remained signed in with the same seven agents and original daemon/core/
worker and PTY host PIDs; the owned counter advanced from `COUNT_12973` to
`COUNT_14102`. Scenario 7's install and cleanup checks passed, but its first
render and full completion-copy checks remain unverified, so the scenario is
**partial**.

A later diagnostic install from the already verified ARM64 ZIP started one
1.0.3 app process. Its first screenshot had Windows Settings in front, so it
could not establish whether the app client was white. Bringing that same app
window forward without resizing showed the signed-in home UI. The Flutter
child window had a normal nonzero client rectangle; the available app log had
backend connection warnings but no renderer error. No resize was applied.
This confirms that a later direct launch rendered, but does not establish why
the one-command first-run capture was white. The diagnostic app remains
installed for the owner's Mac-to-VM check.

### The Windows PC seen from the Mac

Pending the owner at their signed-in Mac desktop. The VM app showed the remote
Mac row; the reverse view and `Write-Output MAC_42` from Mac to the owned VM
terminal have not been checked. No test operated the Mac's real Harness app,
CLI, daemon or `~/.harness`.

## Findings and fixes

| ID | Finding | Current evidence and impact |
| --- | --- | --- |
| G1 | ARM RC1 GUI Ctrl+C did not interrupt an owned PowerShell child. | Isolated PTY host inherited Ctrl+C ignore from its process group. A Windows regression failed before the host fix and passed after it; the full Windows PTY suite passed. Local x64 Release and staging N1 passed GUI Ctrl+C with the patched test host. The published PTY 0.4.19 binary started on x64 after a scoped host retirement, but GUI Ctrl+C on it remains unverified because it belonged to another Windows session. ARM still serves its live agents from 0.4.18 despite having 0.4.19 installed; no host replacement was attempted. |
| G2 | Printable terminal input depended on launch/relaunch state. | ARM RC1 failed early input attempts, then `WIN_42` passed after relaunch. The exact lifecycle cause and cold-start reliability remain open. |
| G3 | The ARM client area turned black/white during RC1, N and one-command 1.0.3 sessions. | The process stayed responsive at the OS level. N did not repaint after one app restart, but one scoped window-size change restored its UI; the surface went black again after the CLI restart and another scoped size change restored it. The GPU accepted D3D feature level 12_1. N1, N2 and x64-on-ARM 1.0.3 rendered in other launches; the one-command ARM64 1.0.3 first-run capture was white. A later direct ARM64 ZIP launch rendered after focus without a resize. The cause and first-render reliability remain unproved. |
| G4 | Notification permission gate reported unavailable while a native probe could post a toast. | The first-toast `Setting()` error is handled in N1 source, but no completed agent turn occurred on the hidden staging N1 app because the backend was offline/reset. Product completion toast and click remain unverified. |
| G5 | Published N footer joined its words and counts. | Staging N1 on both x64 and ARM64 visibly separates the words and counts. |
| G6 | Windows Settings uninstall entry kept the old version after a successful in-app update. | Both staging 1.0.0 → 1.0.1 updates left `DisplayVersion=1.0.0` while About showed 1.0.1. Launcher fix `147ca03bd` has a failing-then-passing regression; live 1.0.1 → 1.0.2 updates on both VMs now show `DisplayVersion=1.0.2`. |
| G7 | An x64 owned terminal reported `offline ready` after the staging CLI upgrade. | The old PowerShell and test-only PTY host stayed alive, while the restarted daemon saw the host and reopened its stream. A new owned terminal worked on the same host. Exact cause and recovery of the old agent remain unproved. |
| G8 | ARM 1.0.2 Quit took more than 47 seconds. | The menu Quit removed the tray icon and hid the window, but its process remained alive on two checks and exited by itself within 4 minutes 38 seconds. The native teardown boundary is suspected, not proved; no forced termination or source fix was made. |
| G9 | Settings uninstall left the installed files. | The hidden cleanup script started before the final modal dialog, exhausted its launcher-exit wait while that dialog remained open, and logged that the launcher was still running. Registry and shortcut were already removed. Commit `826608097` fixes the order; Windows CI passed and the 1.0.3 ARM Settings retest passed after a >3-minute dialog hold. |

## Timing, limits and safety

The live observations span 18–20 October 2026. Measured intervals above are
per-operation only. Implementation, validation, CI waiting, VM waiting, and
document-writing durations were not captured as a reliable common ledger, so
no total is claimed. No merge or production publication occurred. C5.2's
remaining scenario timings will be recorded when those scenarios run.

On ARM64, only the dedicated standard user's app, daemon, agents, terminals
and scratch folders were changed. The separate x64 checks used only their
owned app, terminal and scratch. `C:\work\e2e`, other users' agents and
terminals, and the Mac's Harness home were not accessed. No global fake CDN
route, hosts change or CA installation was made during these live checks. QR
codes, account details and private screenshots stay outside tracked evidence.
The ARM user's 1.0.3 Settings uninstalls after Scenarios 5, 6 and 7 finished
cleanly; a later diagnostic ARM64 1.0.3 app is installed and running for the
owner's Mac-to-VM check. The separate x64 VM
retains staging 1.0.2; its two owned test
panes and patched PTY host were retired after their continuity checks. Final
account, artifact and VM cleanup is pending the remaining scenarios and will
be recorded separately.
