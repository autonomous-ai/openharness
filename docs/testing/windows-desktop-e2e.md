# Windows desktop end-to-end results

Status: **functional acceptance and local VM cleanup complete; one backend cleanup restriction**, 20 October 2026. This is the C5.2 acceptance record for
[`feat/windows-desktop`](../superpowers/plans/2026-10-18-windows-desktop.md#task-c52-the-seven-scenarios-on-the-vm-and-docstestingwindows-desktop-e2emd).
The seven scenarios are defined in the [Windows desktop design, §4.4](../superpowers/specs/2026-10-18-windows-desktop-design.md#44-end-to-end-on-the-windows-11-arm64-vm).
Desktop **1.0.0**, **1.0.1**, **1.0.2**, uninstall-fix **1.0.3**, and first-key-fix **1.0.4** were published to staging
for ARM64 and x64. An earlier ARM64 **1.0.1-rc1** ZIP and local x64
Debug/Release builds were used for diagnosis; those were not the staging N1.
The final native ARM bootstrap provisioned staging CLI `0.4.21-dev.win1` and
PTY `0.4.19`; its dedicated Windows account was removed after testing.
The x64 VM retains the same staging CLI and PTY files with Desktop 1.0.4. Its test-only PTY `0.4.18` host was
retired after the update checks. After identifying and retiring an obsolete
test daemon, the published `0.4.19` host now serves the x64 GUI in the same
Windows session. No PR, merge, or production release is part of this
record.

## Summary

| # | Scenario | Result at this snapshot | Driver |
| --- | --- | --- | --- |
| 1 | First install, sign-in, same-version launch | Accepted across separate ARM/x64 runs: final ARM 1.0.4 provisioned missing Node/CLI/PTY and rendered Sign in in 160.404s; supported x64 test PC QR sign-in had already returned success and automatically signed in Desktop. Same-version launch converged to one installed window. Published x64 MOTW launch passed its observed Unknown Publisher warning. No fresh ARM sign-in or single uninterrupted journey is claimed. | Script, visual automation; supported QR sign-in |
| 2 | This computer, terminal, Add Phone, remote Mac | Passed: owned terminal creation, `WIN_42` output, HTTP 200 handoffs on ARM and real x64 test PC x64, and remote row observed. Published x64 1.0.3 and PTY 0.4.19 passed GUI ping/Ctrl+C and synthetic text copy/paste. Duplicate cursor replies caused a new terminal to lose its first key. The source fix passed clean x64 Debug checks and the published 1.0.4 retest: the first physical `a` appeared in a fresh GUI-created terminal and was independently confirmed in passive PTY output. The owner completed Mac → Windows control; passive VM output confirmed two `MAC_42` command/result pairs. | Visual automation, Script, Person |
| 3 | Notifications, tray, links, paste and font | Accepted with explicit combined evidence: tray/links/font observed; published x64 1.0.4 composer bitmap, raw PNG-only and file-drop paste passed. On published x64 1.0.3, a completed Kilo turn posted a native Finished notification; clicking its card restored the correct harness. The live tray menu showed the working Kilo row, Open Harness and Quit. Published 1.0.4 cold protocol launch rendered one installed window; both-architecture native tests prove exactly-once forwarding. Transient banner and live URL-specific delivery log/count remain unobserved; the release app has no such delivery log. | Visual automation, Script, native integration |
| 4 | Staging updates and broken-build rollback | Passed on real x64: real 1.0.0 → 1.0.1 GUI update passed on both VMs. The 1.0.1 → 1.0.2 update kept the ARM counter rising and repaired Settings `DisplayVersion` on both VMs; the x64 test PC then updated from 1.0.2 → 1.0.3 through the GUI and rendered signed in. Private fake-CDN truncated/no-executable packages were refused; a no-first-frame package rolled back to 1.0.3 after two failed starts. Counter and daemon/PTY processes survived. | Script, visual automation |
| 5 | Uninstall through Windows Settings | Passed on 1.0.3 after a 1.0.2 timing failure was fixed: holding the final dialog open over three minutes did not start cleanup early; after OK, the app folder and registrations disappeared while CLI, daemon and agents stayed. | UI Automation |
| 6 | x64 desktop on ARM64 | Passed across two runs of published x64 1.0.3: install, rendered window, tray and Settings uninstall passed; a later isolated x64 runtime returned HTTP 200 for Add Phone while the backend was connected. The installed ARM app and seven agents were restored afterward. | Script, visual automation, UI Automation |
| 7 | Install desktop by one PowerShell command | Passed on real x64: cold staging 1.0.3 install rendered immediately, console showed the full completion copy and `still here`, MOTW/temp counts were zero, and the subsequent Settings uninstall removed the app while preserving agents. A later cold ARM 1.0.4 install rendered at the first passive capture and showed the full completion copy; the earlier white 1.0.3 run is retained below. | Script, visual automation, UI Automation |
| — | Windows PC controlled from the Mac desktop | Passed: owner confirmation plus passive VM `MAC_42` output. | Person, passive Script |

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
broken-build rollback and the later one-command installer retests passed on real x64.
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
commits through `50cefaace` changed only the Desktop workflow trigger, its
focused test and this E2E record. The trigger removal passed its focused
Vitest test and `actionlint`. The later cursor-report fix `f6bceb53d` changes
runtime Dart code; its [Windows validation run](https://github.com/autonomous-ai/openharness/actions/runs/39369450568)
passed both architectures, including their builds, native integrations and
46/46 installer specs. Each full Flutter result contained 6,359 passes,
170 recorded baseline failures and zero new or mandatory-case failures.
The downloaded test artifacts matched their API SHA-256 digests.
The [1.0.4 staging run 39375401781](https://github.com/autonomous-ai/openharness/actions/runs/39375401781)
then built both packages, published only staging, and passed its served size
and SHA-256 checks. The x64 package used for the live retest additionally
matched its manifest hash after download.

## Windows shortcuts

Status: **8/8 delegated live checks passed using composed source-specific evidence; local repair not merged or published**,
20 October 2026. This is the acceptance record for the [Windows shortcut design](../superpowers/specs/2026-10-20-windows-shortcuts-design.md)
for CI/live candidate `38dde786ec6aecc2b071390d068b07f3e8116513` and local image-paste
repair `9fcc9f769fba61399430d412e75d4654b25649af` on `feat/windows-desktop`. The earlier
C5.2 results cover their recorded builds; they do not validate this shortcut change.

Mac evidence is composed across the reviewed source change:

- At frozen `c420c1bac63df3788d6239f04d4affd5f2ae748e`, the full VM suite passed
  uninterrupted: **7,533 passed, 41 skipped, 0 failed**, all 644 selected VM files,
  no loader failures or retries, in 855.811 seconds. Full analyze exited 1 with the
  same 46 baseline diagnostics (5 warnings, 41 infos, 0 errors), zero new normalized
  diagnostics and no warnings/errors in changed files. Analyze is a known failing
  baseline, not a passing check. The baseline at `87779178e` had 7,463 passes and
  the same 41 skips and 46 diagnostics.
- The reviewed correction from `c420c1bac` to `38dde786e` has **336 passing cases
  across 17 affected files**, composed of 250 passing cases in 14 unchanged files
  plus 86 passing cases in three corrected files. The first broad invocation had
  334 passes and four invalid Ctrl+K test assumptions; after correcting those
  tests, the three amended files passed. Production source stayed unchanged
  between those invocations. This is completed-file coverage, not one uninterrupted
  passing invocation. Final analysis of all 11 changed files reported no issues.
- Both Mac scopes used Flutter 3.47.5 / Dart 3.13.4 and the unchanged dependency
  lockfile. The integrated correction's file and log hashes were verified, and
  independent review approved all five Important fixes and the evidence composition.
  The full suite was not rerun on `38dde786e`; its unchanged coverage is reused
  with the scoped correction checks. VM tests do not establish physical Windows
  keyboard, IME, clipboard, or live-agent acceptance.

Exactly one dedicated [Windows Desktop run 39398347220](https://github.com/autonomous-ai/openharness/actions/runs/39398347220)
was dispatched at `38dde786e` and completed with **SUCCESS**. Both x64 and arm64
`build-test` jobs succeeded, including their final installer steps.
Both completed full VM test artifacts were downloaded and their SHA-256 digests
verified. Each architecture reports **6,473 passed, 99 skipped, and 170 recorded
known failures** (115 errors and 55 failures), with **zero new failures** against
`desktop/test/windows_known_failures.txt` and zero must-pass failures. All 150 cases
in the six affected shortcut, keymap editing/focus, clipboard, composer, and Edit
menu files passed on each architecture. Workflow success includes the recorded
known-failure baseline; it does not mean every VM test passed. Release jobs remain
**SKIPPED**, and no staging release is part of this shortcut record. This CI receipt
covers `38dde786e` only; it does not cover the later local image-paste repair.

Live screenshot paste failed on that CI build. Local correction `9fcc9f769` adds
native Windows local panes to the existing guarded clipboard-PNG/session image
route. The existing CLI fallback saves the PNG and pastes its file path when a
Windows clipboard writer is unavailable; no CLI or engine-specific change was
made. Scoped verification passed **105 cases across four files on macOS** and
**105 cases across the same four files on Windows**, with no Windows skips or
errors. The Windows scope used Flutter 3.47.2 / Dart 3.13.2 x64 under ARM64 emulation
with verified source hashes and the unchanged lockfile. Fresh analysis of the two
changed files reported no issues, and independent review approved the correction.
The changed-source local Windows x64 release build also **PASSED** with
`flutter build windows --release --no-pub`; its PE header confirms x64. This build
used the same x64 toolchain under ARM64 emulation. The running repaired release
bundle's executable, native DLL, and `app.so` hashes matched that completed build.
Actual Ctrl+V then showed an image attachment, and genuine Claude identified the
controlled screenshot's text and red rectangle. This live image retest **PASSED**
on `9fcc9f769`. The single full CI receipt remains limited to `38dde786e`.

The owner delegated live checks in Windows 11 ARM64 under UTM using this run's
exact x64 CI build under emulation. Initial checks used a separate standard-user
profile: cases 3 and 8 passed. Cases 1, 2, 4, and 7 also have passing receipts
from administrative-profile testing. The real remote-composer check also passed
on `38dde786e`. The image case passed on local repair `9fcc9f769`, bringing live
acceptance to 8/8. At the owner's request, live
testing has resumed in an existing administrative profile; the standard test
session was preserved. The exact x64 bundle was copied to a dedicated task folder
and its hashes matched the CI artifact. The owner completed fresh Harness login
in this profile; the exact candidate has a usable local workspace. Existing
provider sessions are used in place through their normal clients; credentials are
not copied. A genuine Claude Code session produced an actual text response.
Screenshot Ctrl+V produced no attachment on the CI build; that failure remains
recorded at `38dde786e`. Its retest passed on the verified local `9fcc9f769` bundle.
In the real remote Claude composer, Ctrl+W deleted a word and Ctrl+T opened a
persistent new tab with a free slot. The earlier unsuccessful attempt matched the
existing New Tab menu behavior; freeing an owned idle test tab allowed Ctrl+T to
create the tab. This checks the terminal composer, without substituting New Harness.
No native physical-x64 live acceptance is claimed;
the occupied physical PC console and its existing session remain undisturbed.
Keep machine addresses, accounts, private clipboard content, and screenshots with
private content out of this record.

Live acceptance combines cases 1–4 and 6–8 from `38dde786e` with the corrected
image case from `9fcc9f769`; it is not a full eight-case rerun on the later source.
The local repair has not been pushed, merged, or released. Merge and publication
remain outside this acceptance record.

| # | Delegated live check | Result | Driver |
| --- | --- | --- | --- |
| 1 | From the sidebar or New Harness composer, Ctrl+T opens a tab, Ctrl+W closes it, and Ctrl+N opens New Harness. | PASS — standard-profile Ctrl+T/W plus administrative-profile find-field Ctrl+N opened the New Harness form | Agent (owner delegated) |
| 2 | Inside the terminal view, Ctrl+R, Ctrl+W, and Ctrl+U reach the shell or agent. | PASS — Ctrl+R/W/U reached a real local PTY program | Agent (owner delegated) |
| 3 | Inside the terminal view, Ctrl+Shift+T opens a tab. | PASS — standard profile: from the real Claude Code terminal at provider onboarding, Ctrl+Shift+T opened a tab | Agent (owner delegated) |
| 4 | Ctrl+C with a terminal selection copies; without a selection it interrupts. | PASS — selected text copied without interrupt; unselected Ctrl+C interrupted actual Claude generation | Agent (owner delegated) |
| 5 | Ctrl+V pastes text, and a pasted screenshot reaches the agent. | PASS at9fcc — earlier source38 text response retained; repaired image attached and genuine Claude correctly described its controlled text/red rectangle; source38 image failure retained | Agent (owner delegated) |
| 6 | In the terminal composer, Ctrl+T opens a tab and Ctrl+W deletes a word. | PASS at source38 — real remote composer Ctrl+W deleted a word; with a free slot, Ctrl+T opened a persistent new tab | Agent (owner delegated) |
| 7 | The Edit menu's Cut, Copy, Paste, and Select All work in a text field; in a terminal, Cut is disabled and Copy, Paste, and Select All work. | PASS — all four field actions worked; terminal Cut disabled and Select All/Copy/Paste worked | Agent (owner delegated) |
| 8 | Holding Ctrl shows the tab numbers. | PASS — standard profile: holding physical Ctrl showed tab-number hints in UTM | Agent (owner delegated) |

Two reviewed limits remain explicit: the spec's Ctrl+backslash sidebar example is
excluded because no existing catalog command owns it, and removing an editor while
its Edit menu stays open can briefly leave enabled rows visible. Invoking such a
row revalidates the target and does nothing; reopening the menu updates availability.
That display issue is an accepted deferred Minor, not an unvalidated stale edit.

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
Tooling acceptance combines separate positive receipts for PS5 parsing, native
helpers, five real GUI checks including console detection, conditional text
clipboard restoration and an actual owned-account lifecycle cleanup. Initial
failed selftest/clipboard attempts remain recorded; no single all-green guarded
transaction or arbitrary-format clipboard restoration is claimed. Shared
Winlogon and unrelated sessions are preserved under the reviewed ownership
rules. Final C5.2 cleanup is recorded separately below.

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

A later published x64 1.0.3 ZIP matched the verified staging SHA-256. A
separate copy of the ZIP and all nine extracted `.exe`/`.dll` files were
marked `ZoneId=3`, in a folder containing Vietnamese letters, spaces, an
apostrophe, `&`, `%` and `!`. Shell launch displayed **Open File – Security
Warning**, **Unknown Publisher**, **Run** and **Cancel**. After a
screenshot-grounded click on Run, one installed 1.0.3 process opened and
rendered its existing workspace without a focus or resize workaround. The
“More info / Run anyway” SmartScreen screen did not appear. No trust or
SmartScreen settings were changed. The helper initially misread the Unicode
path until its PowerShell 5 script was encoded with a UTF-8 BOM; its launch
wait also timed out while the warning awaited input. These helper failures
are retained separately from the subsequent successful marked launch.

The final clean-state retest used the existing dedicated standard Windows user,
with its entire prior Harness home moved to an owned marked backup. The legacy
`.machine` home was absent. Desktop, registrations, CLI, managed Node, PTY and
auth/state paths were absent before launch; child environment overrides and
PATH fallbacks could not reuse the old install. This was clean **Harness
state**, rather than a newly created Windows profile or a reset OS.

The verified native ARM64 1.0.4 ZIP was freshly extracted into another
Vietnamese/metacharacter path. First launch at **06:28:28 UTC** provisioned the
missing components; the passive **06:31:08 UTC** capture showed the fully
rendered Sign in screen and green ready footer after **160.404 seconds**.
There was no Retry, relaunch, focus/resize workaround, CLI prewarming or auth
copy. The 300-second console watcher observed **zero console windows**.
Two observation commands hit a private helper's startup heuristic; extending
that helper's guard allowed capture without changing or relaunching the app.

Only afterward, managed Node answered **22.23.2**, CLI **0.4.21-dev.win1** and
PTY **0.4.19-dev.win1**, protocol 2; Desktop, Node and PTY were all ARM64.
Desktop was 1.0.4 with its first-frame marker, no staging directories and
`loggedIn=false`; no auth session file existed. Same-version relaunch briefly
created a windowless forwarding process, then settled to the original installed
process and one visible window. The installer streaming transcript was not
retained, so the actual rendered transition and resulting managed files/versions
are the bootstrap evidence.

Sign-in acceptance reuses the earlier real x64 test PC supported QR flow: approval
through the authorized Mac session returned `status: success`, restarted
harnessd on that account and automatically moved the still-running Desktop
from Sign in to its account and This Computer. This is separate x64 sign-in
evidence, **not a new ARM sign-in or one continuous first-install journey**.
The ordinary QR approval/confirmation flow remains supported by the final
source; intervening optional sign-in features do not make the entire CLI auth
implementation byte-identical.

### 2. This computer

The app's **File → New Harness** composer created an active Terminal harness
in an owned folder on the ARM VM. In the installed RC1 after relaunch, visual
typing of `Write-Output WIN_42` and physical Enter produced `WIN_42` plus a
returned PowerShell prompt in both the GUI and a passive PTY read. A later
single physical printable key was seen in the correct owned pane; this does
not prove cold first-key reliability. Earlier first-launch attempts had missed
printable input, and their lifecycle cause was unknown at that point; the later duplicate-cursor diagnosis below resolved the first-key loss.

The ARM RC1 GUI started `ping -t 127.0.0.1`, but three Ctrl+C input variants did
not stop it. The exact owned process was stopped separately for cleanup. A
Windows PTY host fix was verified with a failing-then-passing ARM regression
and the full Windows PTY suite. A local x64 Release desktop using that patched
test host then sent Ctrl+C through GUI → daemon → PTY, stopped its owned ping,
and returned to the prompt. The published x64 N1 desktop later repeated the
GUI Ctrl+C check on that same test-only patched PTY host: an owned `ping -t`
child exited, `Control-C` and the prompt appeared, and the app and host PIDs
stayed running. This proves the N1 GUI path with the patched host, while the
published PTY 0.4.19 runtime had not yet been checked at that point; the later
real x64 run below closes that gap. The local
x64 Release also passed Ctrl+Shift+V paste and Ctrl+Shift+C copy of a
synthetic marker. That local clipboard result does not validate staging N1.

Add Phone returned HTTP **200** before and after the owned daemon restarted.
The app discovered a changed trusted pipe; the observed recovery took about
**91 seconds**, not the plan's sample 20-second wait. The remote Mac row was
visible and untouched. ARM clipboard checks were held because the shared
pasteboard could not be safely restored by the test helper. The x64 local
Release clipboard result does not substitute for ARM staging acceptance.

A later real x64 check used installed staging **1.0.3** with the published
**0.4.19** PTY host, both in the same interactive session. Before moving the
empty host, an identity-guarded operation retired only an obsolete test CLI
master and its two children; the current daemon stayed alive. A GUI-created
Terminal printed `WIN_42`, then GUI Ctrl+C stopped its owned `ping -t` child,
showed `Control-C` and returned the prompt; a process query confirmed the
child exited. Ctrl+Shift+V executed a synthetic marker, and Ctrl+Shift+C copied
it with the previous clipboard restored. This passes the published x64
Ctrl+C and text clipboard path.

The first command in that fresh terminal lost its leading character. Physical
key injection reproduced the loss, while a temporary Debug trace showed the
character reaching the Desktop input queue. In an isolated published-host
experiment, a fresh PowerShell accepted its first `a`; injecting a duplicate
cursor-position reply before it made the same `a` disappear. Both isolated
panes were removed and that test host shut down. Commit `f6bceb53d` separates cursor reports from user input and consumes the
renderer duplicate while preserving other replies. Its regression first failed
with unwanted input frames; 153 related Mac Flutter tests, 129 Windows x64
tests, targeted analysis and independent review then passed. A GUI-created fresh terminal on the clean x64 Debug build then accepted
its first physical `a`; a passive PTY screen independently confirmed the
character. The full Windows CI subsequently passed both architectures. On published
x64 **1.0.4**, the GUI created another fresh Terminal harness against published
PTY 0.4.19. Its first single physical `a` appeared at the prompt without a
warm-up key; passive PTY output independently confirmed `PS C:\Users\<user>> a`.
This passes the published first-key retest.

### 3. Native Windows behavior

On ARM RC1, hide-to-tray and restore kept a single app process; the tray menu
showed Open and Quit. Edge's native protocol prompt opened an owned terminal,
a shell fork link reached the app's message flow, and a link into a closed app
opened one window in roughly **2.5 seconds**. Two shortcut launches **300 ms**
apart converged to one process and window. The notification link had no clear
dispatch log, so exactly-once delivery was not proved in that live run. The font picker visibly
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
changing app, daemon or PTY PIDs. At that point, the product's completed-turn
toast and its click target remained unverified. An
interactive native probe showed that Windows could post a generic toast, but
the product's permission check had returned HRESULT `0x80070490` earlier;
the probe is not product-toast evidence. The working-agent tray row had also
not been demonstrated; later x64 receipts below cover both paths.

With the backend connected, a later native ARM64 1.0.3 app had Desktop
Notifications enabled and was hidden while one owned Kilo turn ran. Its pane
returned the requested answer in **9.4 seconds**, and the app log received a
`turn_summary` notification with `kind=done`. A toast check about 46 seconds
later and a masked screenshot about 74 seconds later found no visible toast.
The toast may have expired before observation; its appearance and click target
were unverified in that ARM run. The test Kilo agent was deleted, the
original seven agents and rising counter remained available, and the native 1.0.3 window was
restored. Desktop Notifications remained enabled.

On published x64 1.0.3, a subsequent owned Kilo turn completed with Desktop
Notifications enabled and the app hidden. A native C++ WinRT history probe
returned `Setting=Enabled` and the product's own **C52 toast probe → Finished**
notification, including its protocol URL for the correct owned harness.
At **2026-10-20 05:16 UTC**, a same-session GUI worker opened Notification
Center and captured that card while Harness remained hidden. After reviewing
the screenshot, automation clicked the card with guards requiring unchanged
foreground and input state. The sole installed app process restored with
the correct Kilo harness focused; the app log independently recorded that
harness opening and becoming terminal-ready. This verifies native notification
delivery, visible Notification Center presentation and the product click path.
The short-lived banner was not captured. UI Automation did not expose the
notification card on this Windows build, so its earlier absence from an
automation search was insufficient evidence of missing delivery.

At **05:22 UTC**, a further real turn on that owned Kilo harness produced
a native tray menu showing **Working (1)**, **C52 toast probe** with **5s**
elapsed, **Open Harness** and **Quit** in the captured screenshot. The tray
selector excluded taskbar app buttons before opening the actual notification
area icon. This verifies the live working-row criterion.

On published x64 **1.0.4**, a final composer check separately attached a
blue bitmap, an orange PNG copied as an Explorer-style file drop, and a
green **PNG-only** clipboard payload. Each visible attachment was captured;
none was submitted to an agent. The raw PNG case advertised only `PNG`,
with a valid 190-byte PNG and its expected signature, so bitmap fallback
could not account for the result. The helper initially offered a managed
payload without getting an attachment, then prematurely disposed its raw
clipboard owner window. Keeping that private hidden owner alive through
the paste produced the green attachment. These failed helper attempts are
retained; no product change was needed. Every completed probe restored the
prior supported clipboard formats and text, and the synthetic attachments
and fresh first-key terminal were then removed.

At **06:25 UTC**, the installed published x64 1.0.4 app quit normally. With
zero Desktop processes, one shell invocation of an owned notification URI
started the installed app. After 16 seconds, the same-session probe saw one
process, one visible window and a rendered workspace. Process argv contained
the URI once, and the launcher recorded one start. The restored terminal tab
cannot independently prove which URI selected it, and a passive agent-sync
event is not a delivery log.

The acceptance ruling combines that actual release-app cold-launch evidence
with final-source x64 and ARM64 native integrations that assert exactly
`[cold, warm]` deliveries, including after settling and Quit. The C3.2 routing
contract says a cold notification opens the app before its workspace handler
listens. Production code has no URL-delivery log, so C5.2's sample log line
cannot be captured without adding new observability. Live URL-specific
multiplicity remains uninstrumented; it is not relabeled as an observed
exactly-once result. The separately observed warm notification-card activation
proves the real notification route. No duplicated or lost link was observed.

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
unverified at that point; the later same-session x64 run below passed.

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
confirmed the corrected registry value on both VMs.

On real x64, installed staging 1.0.3 then exercised three unpublished packages
through its actual update banner and a private fake HTTPS CDN. A half-downloaded
1.0.6 ZIP and a complete, hash-valid 1.0.4 ZIP without the app executable were
refused before changing `current`. A 1.0.5 package without `data/app.so` was
staged, exited twice before its first frame, and the installed launcher logged
the rollback to 1.0.3. The good app rendered again, `current` was 1.0.3,
the consumed `previous` pointer and bad app folders were absent, and the owned
counter advanced from `COUNT_1` to over `COUNT_450`. Daemon and PTY PIDs and
start times stayed unchanged. These versions were never published.

The fake-CDN transaction used a name-constrained CA, loopback-only listener
and reverse SSH forward, with a restoration watchdog registered first. After
testing, the hosts file was byte-identical to its original hash, the test CA
and watchdog were absent, the reverse forward and local server were stopped,
VM port 443 had no listener, and the real staging manifest again returned
1.0.3. No shared ARM hosts or trust settings changed.

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
WebSocket path remained unhealthy at that time. Settings
then uninstalled the app through its final dialog. The install root, registry
entries, shortcut and app state disappeared; no desktop process remained. The
CLI stayed signed in with the same seven agents and unchanged daemon/core/worker
and PTY host PIDs; the owned counter advanced to `COUNT_12973`.

After the backend recovered, the same published x64 1.0.3 runtime was copied
to an isolated folder outside the launcher's self-install layout. Its
executable hash matched the published ZIP. The installed ARM app quit, and
the x64 app ran as the sole desktop process under emulation, rendered the
signed-in UI, and opened Add Phone. One real Add Phone click produced
`POST /api/auth/handoff → 200` in its app log in **664 ms**. No QR image was
retained. The x64 app then quit, and the installed ARM 1.0.3 app was restored
as the sole desktop process with its registration and version pointer intact.
The same seven agent IDs, daemon/core/worker/PTY PIDs and process start times
remained; the owned counter continued rising through `COUNT_18687`. Together,
the two runs satisfy Scenario 6's x64 emulation, pipe handoff, tray and cleanup
criteria. The earlier 502 was a backend outage, not an x64 FFI failure.

The real x64 test PC was also checked after the user prioritized x64. Its
already signed-in, rendered 1.0.2 app ran in the active GUI session with the
staging 1.0.3 update banner. Clicking **Update** installed 1.0.3 and restarted
one app process in the same GUI session. Its home surface rendered signed in,
the installed `current` pointer read 1.0.3, and `harness status` remained
`backend connected` with zero available agents. On this x64 app, one actual
**Add Phone** click produced `POST /api/auth/handoff → 200` in **478 ms** in the
app log. The dialog was dismissed, the app remained at 1.0.3, and the daemon
kept its PID and connected status. No QR screenshot was retained. This is live
x64 GUI/update/FFI evidence; it does not establish published PTY 0.4.19 GUI
Ctrl+C because that host then ran in a different Windows session.

A bounded attempt to create one Terminal from the x64 test PC's 1.0.3 GUI did not
confirm a start; `harness ps` remained empty, so no input or Ctrl+C was sent.
The x64 test PC's GUI daemon logged `pty host is unavailable` and repeated attempts to
start a host despite an existing 0.4.19 host. Read-only probes found that host
alive in Session 0, its discovery file naming the same PID, and its pipe
connectable from both Session 0 and the limited GUI Session 1. However, the
Windows process-table scan from Session 1 reported the host row with an empty
creation marker; the Session 0 scan read the marker. The daemon drops rows
without that marker, so it cannot prove that the discovery file still names
the same process and will not trust the host. This bounds the failure to the
cross-session process-identity check, rather than a terminal input or Ctrl+C
result. A limited-session read-only follow-up could read the same creation
time through CIM, while a .NET process-handle start-time read failed. An
authenticated host inventory then confirmed **zero panes**. Its protocol
accepted a guarded shutdown, but a Session 0 process started the replacement
0.4.19 host before the limited Session 1 task did. The test stopped after that
single attempt. The x64 test PC remained signed in, backend connected, with the same
daemon and zero agents; the replacement host also had zero panes. At that point, published
0.4.19 GUI Ctrl+C still needed a host started in a compatible user context.
The later same-session x64 receipt in §2 passed that check.

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
`COUNT_14102`. Scenario 7's install and cleanup checks passed in that run, but its first
render and full completion-copy checks were unverified; that run was
**partial**. The later x64 and ARM retests below supersede that status.

A later diagnostic install from the already verified ARM64 ZIP started one
1.0.3 app process. Its first screenshot had Windows Settings in front, so it
could not establish whether the app client was white. Bringing that same app
window forward without resizing showed the signed-in home UI. The Flutter
child window had a normal nonzero client rectangle; the available app log had
backend connection warnings but no renderer error. No resize was applied.
This confirms that a later direct launch rendered, but does not establish why
the one-command first-run capture was white. The diagnostic app was left
installed at that point for the owner's Mac-to-VM check; later retests and
cleanup below supersede that state.

On real x64, a later cold one-command test began with the install root and
uninstall entry absent after an actual Settings uninstall. The visible
PowerShell ran the real staging one-liner and completed in about **98 seconds**,
including the CDN download. The sole installed 1.0.3 process rendered its
signed-in UI before any test focus or resize operation. The original console
remained open, displayed the full installed/opening sentence followed by
`still here`, and returned to the PowerShell prompt. Both sentences were
captured with the rendered app behind it. Download markers and staging temp
folders both counted **zero**; no SmartScreen prompt was observed.

The post-install Settings uninstall also passed: the root, uninstall/protocol
registry entries and Start shortcut were absent, no app process remained, and
the daemon/core/updater/PTY retained their exact PIDs and start times. The
unrelated OpenCode harness was preserved. This passes Scenario 7 on real x64;
it does not resolve the earlier ARM first-render observation.

A final cold ARM64 staging **1.0.4** one-command run started at
**2026-10-20 05:42:54 UTC** after the 1.0.3 root and registrations were
removed. The real staging `irm … | iex; Write-Host "still here"` completed
in about **49 seconds**. At **05:43:57 UTC**, the first passive screenshot
showed the signed-in composer rendered, before any app focus or resize.
The installed app was the sole native 1.0.4 process; installed MOTW and
staging-folder counts were zero. Its daemon, core, worker and PTY PIDs and
start times matched the pre-install state, and the seven original agents
were preserved. A later full console screenshot showed the complete
installed/opening sentence, Start-menu sentence, `still here` and the
PowerShell prompt. Focusing that console initially returned false in the
helper; hiding only the owned app exposed the console for the successful
capture, and also displayed the native first-hide toast. The installed
shortcut then restored the app, and only the completed installer shell
was stopped. The prior white 1.0.3 run did not recur here; this is a
successful retest, not a diagnosis or a claimed rendering fix. The earlier
post-uninstall receipts still cover the unchanged Rust uninstaller inputs.

### The Windows PC seen from the Mac

The owner confirmed Mac → Windows control was complete. A fresh passive VM
terminal read showed two `Write-Output MAC_42` commands, each followed by
`MAC_42` and a returned PowerShell prompt. The owner performed the Mac side;
this continuation did not operate the Mac's real Harness app, CLI, daemon or
`~/.harness`.

## Findings and fixes

| ID | Finding | Current evidence and impact |
| --- | --- | --- |
| G1 | ARM RC1 GUI Ctrl+C did not interrupt an owned PowerShell child. | Isolated PTY host inherited Ctrl+C ignore from its process group. A Windows regression failed before the host fix and passed after it; the full Windows PTY suite passed. Local x64 Release and staging N1 passed GUI Ctrl+C with the patched test host. A later real x64 1.0.3 GUI check passed Ctrl+C through published PTY 0.4.19 after a guarded same-session host setup. ARM preserved its live sessions on 0.4.18 until final cleanup; the final fresh bootstrap provisioned 0.4.19. |
| G2 | Printable terminal input depended on launch/relaunch state. | ARM RC1 failed early input attempts, then `WIN_42` passed after relaunch. An isolated published-host experiment proved a duplicate cursor-position reply causes the lost first key. Fix `f6bceb53d` suppresses only the renderer duplicate, preserving user input and other queries; 153 related Mac tests, 129 x64 Windows tests and independent review passed. The clean x64 Debug GUI accepted its first physical `a` in a fresh terminal; a passive PTY screen confirmed the character. Published x64 1.0.4 also accepted the first physical `a` in a new GUI-created terminal; passive PTY output confirmed it. |
| G3 | The ARM client area turned black/white during RC1, N and one-command 1.0.3 sessions. | The process stayed responsive at the OS level. N did not repaint after one app restart, but one scoped window-size change restored its UI; the surface went black again after the CLI restart and another scoped size change restored it. The GPU accepted D3D feature level 12_1. N1, N2 and x64-on-ARM 1.0.3 rendered in other launches; the one-command ARM64 1.0.3 first-run capture was white. A later direct ARM64 ZIP launch rendered after focus without a resize. The final cold ARM64 1.0.4 one-command run rendered in its first passive capture, without focus or resize. That retest passed; the earlier intermittent white surface is retained without claiming a root-cause fix. |
| G4 | Notification permission gate reported unavailable while a native probe could post a toast. | The first-toast `Setting()` error is handled in N1 source. Published x64 1.0.3 subsequently posted its own Finished notification, displayed it in Notification Center, and restored the correct harness when clicked. Transient banner presentation remains unverified. |
| G5 | Published N footer joined its words and counts. | Staging N1 on both x64 and ARM64 visibly separates the words and counts. |
| G6 | Windows Settings uninstall entry kept the old version after a successful in-app update. | Both staging 1.0.0 → 1.0.1 updates left `DisplayVersion=1.0.0` while About showed 1.0.1. Launcher fix `147ca03bd` has a failing-then-passing regression; live 1.0.1 → 1.0.2 updates on both VMs now show `DisplayVersion=1.0.2`. |
| G7 | An x64 owned terminal reported `offline ready` after the staging CLI upgrade. | The old PowerShell and test-only PTY host stayed alive, while the restarted daemon saw the host and reopened its stream. A new owned terminal worked on the same host. Exact cause and recovery of the old agent remain unproved. |
| G8 | ARM 1.0.2 Quit took more than 47 seconds. | The menu Quit removed the tray icon and hid the window, but its process remained alive on two checks and exited by itself within 4 minutes 38 seconds. The native teardown boundary is suspected, not proved; no forced termination or source fix was made. |
| G9 | Settings uninstall left the installed files. | The hidden cleanup script started before the final modal dialog, exhausted its launcher-exit wait while that dialog remained open, and logged that the launcher was still running. Registry and shortcut were already removed. Commit `826608097` fixes the order; Windows CI passed and the 1.0.3 ARM Settings retest passed after a >3-minute dialog hold. |

Functional acceptance uses **combined real x64 and ARM64 evidence**, following
the owner's x64 priority. The original spec names an ARM VM; Ctrl+C, completion
notification activation, final composer paste and bad-update rollback use the
explicitly labeled x64 receipts rather than fictional ARM passes. The clean ARM
bootstrap, separate supported x64 sign-in and combined cold-link ruling above
close the corresponding functional gates. Historical render/quit/old-terminal
findings and the live observability limits remain visible. Final Windows-account
cleanup and backend-record disposition are separate from those product results.

C5.3 local regression evidence reuses the complete Mac base comparison at
`866f9347f` and full suite at `290ce5e83`: **7,181 passes / 17 skips** versus
**7,437 passes / 41 skips**, with zero regressions. The newer runs used Homebrew
Flutter **3.47.5 / Dart 3.13.4**. After that full run, only three Desktop Dart
files changed for the cursor fix; the affected nine-file check passed 153 tests
and scoped analysis found no issues. Its raw logs do not retain a structured
historical toolchain/argv receipt, so no full Mac run at `f6bceb53d` is claimed.
Pubspec/lockfile and native macOS/Linux directories were unchanged across that
last change. The exact final Windows matrix supplies separate final-source
evidence. Temporary Desktop triggers were removed and focused workflow checks
passed. The standalone [Linux Desktop CI run](https://github.com/autonomous-ai/openharness/actions/runs/39382053035)
then passed all four shards and `ci/required` at docs-only head `c0d39cbcd`,
with the same runtime as `f6bceb53d`, using `scope=desktop`. Its four official
receipts cover **640/640 files, 7,431 passes and 50 skips**, with zero failed
tests or errors. Downloaded archives matched their API digests; source,
identity and raw-log hashes were verified. These are the same Linux shards
without opening a PR. Only the PR-specific external record remains deferred
by the owner's instruction.

## Timing, limits and safety

The live observations span 18–20 October 2026. Measured intervals above are
per-operation only. Implementation, validation, CI waiting, VM waiting, and
document-writing durations were not captured as a reliable common ledger, so
no total is claimed. No merge or production publication occurred. Bootstrap,
link launch and cleanup are timed separately from the completed CI runs.

On ARM64, only the dedicated standard user's app, daemon, agents, terminals
and scratch folders were changed. The separate x64 checks used only their
owned app, terminal and scratch. `C:\work\e2e`, other users' agents and
terminals, and the Mac's Harness home were not accessed. The later x64 rollback test temporarily changed only its fake-CDN hosts routes
and name-constrained trust; hosts were restored byte-for-byte, and the CA,
watchdog and reverse forward were removed. Its private CA keys were deleted
and the loopback server stopped. No ARM hosts or trust settings changed. QR
codes, account details and private screenshots stay outside tracked evidence.
The ARM user's earlier Settings uninstalls finished cleanly. After the final
clean bootstrap, the owned app quit and normal 1.0.4 uninstall completed;
final account/profile teardown completed successfully. The x64 VM retains installed
Desktop 1.0.4, its account/machine and shared CLI/core/updater/PTY. All nine
run-owned x64 agent rows are stopped with no panes; the unrelated OpenCode
harness retains its active pane. Ninety-eight selected test files/folders
were removed, followed by the cleanup helpers; final scratch count was zero.
Preserved shared process PIDs **and creation times** matched before and after,
including the unrelated terminal window.

The old run-owned ARM backend machine was identified through supported CLI
metadata with a process-local override to its marked backup, without reading
credentials. The supported machine list from the x64 test PC uniquely identified that
remote record with zero agents and proved it was not the x64 test PC's current machine.
Its exact-ID deletion returned **HTTP 403 / NEEDS_AUTONOMOUS_SIGN_IN** requiring
a Google or Apple sign-in. No successful deletion is claimed. Reauthenticating
the x64 test PC would disturb the preserved session, so it was left unchanged. Its
backend cleanup restriction is retained separately from the completed local
Windows-account removal.

Final ARM local cleanup completed with **exit 0 in 400.628 seconds**. The
initial 300-second wrapper had timed out and the original process later exited;
its retained mounted test-user hives prevented ordinary profile readiness.
After successful strict process ownership and recorded-task checks, the approved C5.1
exact-test-SID recovery was independently reviewed, parsed and compiled, then
executed **once**. Both exact owned hives disappeared and the non-special
profile explicitly reported unloaded. Native privilege state was restored;
no admin/shared hive, process, service or Winlogon setting was changed.

Ordinary cleanup then removed the owned profile, account, marked backup,
helpers and admin scratch. The complete preflight comparison confirmed
preexisting user, process, task and listener identities were preserved. A
separate postcheck verifies account/profile/directory/hives/scratch absence
and zero owned processes. The final local cleanup is complete; the failed
backend record deletion remains an explicit external authentication limit.

Final review found a separate CLI **at sign-in** task left after the normal
cleanup: the helper recognizes the main daemon task name, while this newer
logon task was outside its recorded task list. Its full principal SID, logon
trigger user, exact owned launcher path and arguments matched the removed
test profile; it was absent from the run-creation baseline. A guarded
follow-up removed that task. The final inventory also found three OneDrive and
three Windows SoftLanding tasks created for this new SID. All six were absent
from the creation baseline and were removed by exact task path/name and
principal, preserving the 247 other task identities. A fresh successful
Scheduler inventory confirmed **zero tasks for the owned SID/user**. These
manual supplements and the helper's task-coverage limit are retained; the
earlier preflight containing the orphan tasks is not used as proof that all
owned tasks were absent.
