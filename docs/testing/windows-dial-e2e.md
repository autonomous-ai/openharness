# Windows dial end-to-end report

**Status: E5.2 COMPLETE WITH LIMITS; CLEANUP WAIVED BY OWNER on 2026-10-20.**
Report updated `2026-10-20T14:59:04Z`. Code implementation and whole/scoped review
are complete, with I1/M1 resolved. All eleven scenario verdicts are recorded
with their limits; missing physical/user-switch/unplugged checks remain NOT RUN,
S7 remains partial, and S11 SSH uninstall remains FAIL/partial.

All E-owned runtime processes/tasks were stopped. The owner waived the failed
account/path cleanup and directed no further cleanup, reboot, unload or deletion
attempts. Two test profiles, test keys, portable E root, shared scratch and
positive ownership receipts remain. Final baseline comparison remains NOT PASS
with six unexplained shared-state differences; no global preservation or product
uninstall PASS is claimed. Cleanup is no longer a completion blocker under the
owner's decision. Root will close E5.3 after documentation commit and review.

The acceptance target is the Harness desktop app, E's CLI and native serial
helper together on the x64 Windows test PC with a real round Harness device
(called the dial below). Arm64 hardware acceptance is outside this report.

## Source and build provenance

The owner authorized integrating C into E for combined desktop/device testing.
The integration reviewed and locally validated was
`3426d9c8511469e555da7903f248272afbf3f3ba`, combining E parent
`d67bd9698feb52b3d2b1e6933d08674aa859af73` and C parent
`87779178ea5d119dff43d7bea6f03c1dd76fd02b`. The original combined hardware-run
source is `4c3def3cccaf0e820de63aeeb742a9852c6ce95a`. The core coverage correction has
passed its required gate. All four jobs of the exact-source native run and both
architectures of the combined desktop build succeeded. The isolated portable
profile ran in the owner account's visible Windows session and has
completed its normal QR login. The original hardware receipts, including the
S8 failure, use product input `4c3def3c`; their local head was `030ba49cf` after
test-kit fix `23bba54ed` and shipping documentation. The first completion-hook
change `c95e86208dafb484ee9a662972b7a196bffaa6d3` failed its decisive hardware
rerun. Round 2 `4fe12de12d7e1d8695bae0b01529a432fec28a17` passed native
bundle-entry, CLI3 selection and decisive normal-CLI recovery. Current repository
HEAD is `444139f69e9aa8b2dd92503702bb8bfedf35c99e`, the eight-path final I1/M1
fix wave; its scoped rereview PASS resolved I1/M1 with no new findings. No new GUI binary or hardware result
is associated with that final wave.
Current private CLI selection is `4fe12de12`; app/native remain `4c3def3c`,
and the separately hashed PowerShell flasher is unchanged.
The private `0.9.0-dev.dial2` upgrade completed at
`2026-10-20T11:16:27.2047485Z`; native checks verified configuration/current
version/helper pins and an unchanged before/after persisted-verdict file hash.
The earlier dev2 hardware run had mixed provenance: app/native artifacts remain
`4c3def3c`, while CLI/PowerShell inputs are `c95e86208`. No receipt establishes
that the whole runtime is `c95e86208`. A flash/reattachment observer passed,
but its baseline dial was already attached; it does not decisively rerun the
original negative-verdict recovery failure. A later genuine mid-write
cancellation and direct recovery rerun did reproduce the failure on this mixed
`c95e86208` CLI/PowerShell runtime (scenario 8).

| E5 input / candidate | Recorded value |
| --- | --- |
| Original hardware-run source commit and tree | Commit `4c3def3cccaf0e820de63aeeb742a9852c6ce95a`; tree `2671233afc41a1485a56e4ce41f146f8f569ddd5` |
| Tested round-2 CLI source | `4fe12de12d7e1d8695bae0b01529a432fec28a17`; independent scoped review PASS, local selected suite 103/103 + typecheck PASS; CLI3 selected with verdict bytes preserved; native entry fixture and decisive normal-CLI hardware recovery PASS |
| Final I1/M1 source / native PS1 fixture | `444139f69e9aa8b2dd92503702bb8bfedf35c99e`; scoped rereview PASS (I1/M1 resolved, no new findings); native PowerShell 5.1 function-only fixtures 7/7 PASS, no new GUI hardware run |
| Final PS1 source checksum | SHA-256 `07d51c80b43799aeef0948677ff3f14a0015c4e6b9576577e8e7ba502998aad8`; actual hardware receipts still use earlier `c95e86208` PS1 |
| Tested CLI3 bundle checksum | SHA-256 `8cacd1f7cb52228cf356d47ba7e2cda90530cb1ab93901af6d85a87ad856199b` |
| Current tested mixed inputs | CLI `0.9.0-dev.dial3` / `4fe12de12`, PowerShell `c95e86208`, app/native `4c3def3c`; decisive normal-CLI recovery PASS; earlier dev2 hardware failure retained, no new dev3 GUI flash |
| Historical dev2 CLI bundle checksum | SHA-256 `af87a5d0e61f23f2be2ee3dd2528eab41dbe63aa883721d4985748646104e6a5` |
| Recovery PowerShell flasher checksum | SHA-256 `681b96cea559a301189223ed629b15f9b729932ea3f85cc00e8dc1db9da6847f` |
| First recovery-change native workflow (historical validation) | [39412223533](https://github.com/autonomous-ai/openharness/actions/runs/39412223533), exact `c95e86208` source; all four jobs SUCCESS; each architecture: contract tests 739 passed/56 skipped, flasher 31/31 plus official `0.0.92` no-flash, exact watch install and clean uninstall |
| Relevant fix commits since the integration above | `ddee034120a436d742c4c5bd255ea9bdd7444989`: PowerShell 5.1 fixture; `4c3def3cccaf0e820de63aeeb742a9852c6ce95a`: device-service coverage correction |
| Original `windows.yml` run URL and native x64/arm64 results | [39390890060](https://github.com/autonomous-ai/openharness/actions/runs/39390890060), exact final source; all four jobs SUCCESS, including x64/ARM64 watch startup and clean uninstall |
| x64 `harness-pty-windows-x64` artifact ID and digest | `12250700212`; SHA-256 `ac3a85be12c52ad234a28ea00f41114bc952f1d929a9d3a64b615d32ae23bd1b` |
| Installed `harness-serial.exe` checksum | SHA-256 `d6e881453d4215ba404804c05ab1f5714b96c5ab716a3c073b6fed6b1f2af11c`, exact artifact match; selected PTY version `0.1.0` |
| CLI development version and bundle | `0.9.0-dev.dial1`; bundle from `4c3def3c` PASS in 15.7 s; installed version confirmed |
| Local install manifest checksum | SHA-256 `7cc3983d536e76fac804c6e620948d3705d8e56986db0175364fd8cea53ffd83` |
| Local install zip checksum | SHA-256 `4bef2f380471f3d11e65f104a505e79930766b33369835b26060871d0752b402` |
| Combined Windows desktop run, artifact, version and checksum | [39393250390](https://github.com/autonomous-ai/openharness/actions/runs/39393250390), both architectures SUCCESS; x64 zip `1.0.4-dev.dial1`, 6,187 entries, SHA-256 `5c2491e8197b310b809be2f744badb2787f4792b72600e32e4fa957139c4f4b6` |
| Windows and PowerShell versions | Windows `10.0.26200.0`; native Windows PowerShell `5.1.26100.9711` |
| Starting firmware, older test firmware and target firmware versions | Started `0.0.92`; actual CLI flash to older `0.0.91` and cable update back to `0.0.92` completed (Script PASS). Older selected from read-only official listing (92 versions); official HTTPS latest metadata: 3,360,672 bytes, SHA-256 `eadb3846a6658026048418804a60341adc45fdb24793ebc9cabd782def0c8458` |
| Redacted CLI install evidence | [Setup record](../../desktop/scripts/windows-e2e/evidence/dial-e5-setup.log): installer exit 0, version and installed helper confirmed |
| Combined portable app and signed-in workspace evidence | Exact staged executable visible in Session 1 at `2026-10-20T09:11:49.6111191Z`, private profile verified; QR claim and local runtime identity checks succeeded; [curated visible record](../../desktop/scripts/windows-e2e/evidence/dial-e5-visible.log) |

The CLI bundle and native x64 payload above were previously installed into E's
owned standard-user profile over SSH. No daemon was started in that historical
setup: the installer creates a desktop sign-in task, and Task Scheduler does not
start the daemon over SSH. The combined desktop build is now complete with
`DRY_RUN=1`: GCP authentication was skipped and there were no bucket reads or
writes. This artifact-build result does not establish app or device acceptance.

C's earlier staging desktop app and completed owner-account setup are historical
context. They do not prove E4.3's final combined dialog, lease or cancellation
behavior. Use the combined desktop artifact above for E's run and retain its
exact source identity.
A read-only comparison of latest C `38dde` against the tested C parent `87779178`
found no delta in serial, flash, native or CLI-runner inputs; the later shortcut
and clipboard changes were not merged here. This does not change the tested
artifact provenance.
The desktop zip and E's manifest-built CLI installation are separate inputs;
the desktop artifact alone does not establish that E's CLI or serial helper is
installed. Keep the tested development CLI from being replaced by an updater.

Per the owner's 2026-10-20 update, E ships in the combined Windows
[PR #1457](https://github.com/autonomous-ai/openharness/pull/1457),
`feat/windows-desktop` → `main`. When E5.2, E5.3 and the final review are done,
report back; the owner's session will merge `feat/windows-dial` into
`feat/windows-desktop`. Do not perform that merge yourself. This report performs
no merge, publication, deployment or release.

## Evidence already available

The committed [E1.3 serial measurement record](../../desktop/scripts/windows-e2e/evidence/dial-e1.3-serial-check.log)
is automated hardware evidence from an isolated x64 test-PC measurement. It is
not a completed E5 scenario:

- Asserted DTR/RTS attempts failed the banner predicate. The released-lines
  fallback's first open also contained `ESP-ROM:` and failed; preserve that
  result.
- The next three consecutive opens on the unchanged fallback binary were
  banner-free. Each held the port for 10 seconds, exited 0 at stdin end and kept
  the USB attachment session unchanged. The measured binary came from source
  `86398c252ab16ad285120f9a0b0303c2922ff7a1`, Actions run
  [39383869283](https://github.com/autonomous-ai/openharness/actions/runs/39383869283),
  with SHA-256
  `3efe833879dcc25de881fd945a3c7b7152e29308eb88ec3c0c42992a0342c035`.
- The initial banner's origin and exact reset edge remain unproven. An unchanged
  USB session alone does not prove that the firmware did not reboot. Person
  screen observation and protocol/heartbeat continuity were **NOT RUN** in E1.3
  and remain required in E5.
- E1.3 preserved all five preexisting process identities, removed its scratch
  and left no E-owned processes. It installed no SSH key. These are historical
  cleanup results, not a substitute for a new E5 cleanup audit.

The local integration reports in the plan workspace record the following for
the frozen integration source above. They are local test evidence, not native
Windows or real-login/device acceptance:

| Prerequisite check | Recorded result | Wall time |
| --- | --- | --- |
| CLI typecheck | PASS | 20.266 s |
| Focused CLI cable/devices/scripts/architecture tests | PASS; 975 passed, 40 skipped | 178.528 s |
| Required CLI core/services coverage gate | FAIL; 2,902 assertions passed, required per-file coverage failed in `devices.ts` | 130.761 s |
| Desktop dependency resolution with enforced lock | PASS | 2.024 s |
| Selected seven-file desktop VM suite | PASS; 100 passed, none skipped | 61.300 s |
| Scoped desktop analyzer | FAIL; 17 inherited diagnostics: 14 style infos and 3 unused-import warnings | 15.740 s |

The CLI validation window was 178.528 seconds because its checks ran together;
do not add their durations. The desktop validator's dependency-start through
VM-receipt interval was 86.398 seconds. Neither is total request-to-completion
time. The integration review found no blocking issue in its scoped C/E merge
contracts, and recorded an inherited summary-ordering follow-up. It did not
review all incoming C code or exercise hardware.

The original failed coverage gate above is retained as history. On final source
`4c3def3cccaf0e820de63aeeb742a9852c6ce95a`, the corrected core/services gate
**PASS** covered 198 files and 2,904 tests, with **100% statements, branches,
functions and lines**, in **111.447 seconds**. Final TypeScript typecheck also
**PASS** in **4.137 seconds**. The reviewed inputs were unchanged during these
checks. All scoped reviews passed; that does not expand their scope to hardware
acceptance or erase the inherited analyzer diagnostics.

Old native run [39387636051](https://github.com/autonomous-ai/openharness/actions/runs/39387636051)
is terminal **FAIL**: both architectures failed the same PowerShell 5.1 fixture;
the recorded result was 738 passed and 56 skipped, with installation skipped.
The fixture correction is in `ddee034120a436d742c4c5bd255ea9bdd7444989`.
Replacement native run 39390890060 targets the exact final source. Its x64 job
`118521849703` succeeded: Windows CLI tests recorded **739 passed, 56 skipped**
(58 files passed, one skipped); flasher tests recorded **18/18 passed**, and
the real public-manifest `--no-flash` check for **0.0.92** passed. This is native
x64 prerequisite evidence. The completed run now has all four jobs successful
across x64 and ARM64, including actual watch startup and clean uninstall. These
native checks do not establish real-dial flashing or complete E3 acceptance.
The 40 Mac-skipped CLI cases are not Windows passes, and the
failed analyzer remains visible as a validation limitation. No claim that all
validation passes is made.

## Setup and isolation recipe

This is a run recipe, not an execution transcript. Follow the
[design's testing contract](../superpowers/specs/2026-10-19-windows-dial-design.md#5-testing)
and the E5.2 task brief, with the current ownership facts and build requirements
in this report taking precedence over obsolete setup assumptions.

The [historical E5 setup record](../../desktop/scripts/windows-e2e/evidence/dial-e5-setup.log)
captures the owned standard profile `hxdial`: CLI install exit 0, version/helper
hash confirmed, no daemon started, and a `console=false` COM3 watch that exited
0 within 5 seconds after stdin closed. The post-install audit preserved all 5/5
preexisting PID/name/creation identities with zero additional processes.
`hxdial2` is also an E-owned standard profile, but has no CLI installation.
Loopback assets passed hash, native PowerShell and Node syntax checks; the server
was OFF and no hosts/certificate changes were made. Initial setup command
timestamps were **not captured**; the record's
`2026-10-20T08:19:12.446341+00:00` curation timestamp is not a run duration.

The owner has changed the visible E5 run to the **owner account**'s existing
active Windows desktop. Assemble a private portable E profile under E-owned
temporary storage, using process-local `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`
and `TEMP`, with separate CLI/auth/data/computer identity. Give the app a unique
`HARNESS_DESKTOP_INSTANCE`, set `HARNESS_DESKTOP_INSTALL_ROOT` to the owned app
stage and launch its executable directly. Preserve the owner account's actual
PATH, tasks, registry and installation state, including C's app. The private
assembler passed native Windows PowerShell 5.1 parsing for all 11 files. The
exact staged app executable was then verified visible in Session 1 with its
private profile at `2026-10-20T09:11:49.6111191Z`. This proves the isolated
launch, not completion of the eleven scenarios.

Use the dedicated private Limited/Interactive task driver, which checks the
intended session and default desktop and retains positive owned-root/task
receipts outside the repository. Public kit new-user guards remain intact; they
were neither weakened nor adopted for the owner account. Use only the role label
"owner account" publicly: never retain its actual identifier, address, password
or SID, including in ignored repository notes. Raw inventories, credentials,
full device identities and full local paths also stay outside the repository.

Authentication completed through the normal new-Windows QR claim, approved
using the existing Mac SSO bearer held only in memory through the supported
backend. Mac authentication files were not copied. The target's claim succeeded;
the expected account, its own authentication with method `qr`, and its separate
computer identity were verified privately. A backend HTTP response or the
initial Node login child's exit alone is not the claim proof. No credential,
QR code or account identifier is retained here, and the Mac daemon was not
mutated.

Before device operations, the authenticated local WebSocket probe verified the
E runtime's computer identity, data/auth directories, core PID and daemon record,
then targeted only its own machine. It found one attached USB dial on firmware
`0.0.92`, 14 reported setting names, and two owned serial helpers (watch plus
open). E actions targeted only its owned runtime; no action against C was
authorized or performed. The final shared-state comparison below is NOT PASS
and does not certify unchanged C state.

Use the exact native/desktop artifacts above, verify their hashes and the
portable runtime's identities, and capture reviewed redacted visible app
evidence. Serve the branch flasher only from E-owned loopback assets when
needed; no deployment is required. Run the planned order 1, 3, 2, 4, 5, 6, 7,
8, 9, 10, 11 and target only E-owned processes. Quit the owned app during the
stop/hold-port scenarios so supervision cannot invalidate them. Fresh baseline
and final audits must preserve preexisting work; never assume a zero-process
machine.

The procedures below preserve the original acceptance requirements as reference.
For the current automated run, record actual Script/UIA observations and mark
physical Person-only screen, cable-pull or user-switch observations **NOT RUN**
unless they really occur. Never infer a physical action from software state.
Scenario 1 has attached-state prerequisite evidence; scenario 2's Script
portion passed, and scenario 3 has partial evidence recorded below. Their full
acceptance verdicts remain open. Scenario 5 passed its Script-only acceptance
case; scenario 6's Script portion passed, with Person update-screen observation
still NOT RUN. Scenario 7 has partial visible flash-success evidence, with
return timing/session comparison open. Scenario 8's first cancellation was
before observed byte writing, and the subsequent successful flash failed to
restore attachment. A later genuine mid-write cancellation and direct Try again
rerun also failed recovery on `c95e86208`. Round 2 has local code evidence,
with native entry/upgrade and decisive normal-CLI recovery PASS. This combines
the proven GUI cancellation with normal CLI recovery; a new dev3 GUI flash was
not run. S11's standard-user SSH uninstall failed after partial cleanup. S4's
PnP simulation is blocked and S10 plugged metrics have verified derived postprocessing; the remaining
scenarios are **NOT RUN**.

## Observation and timing rules

| Label | What it can establish |
| --- | --- |
| Script | Timestamped command results, device protocol fields, logs, file checks and owned process identities. A script cannot establish what a person saw on the dial. |
| UIA | An actual named desktop control action and its observed app state, supported by a reviewed screenshot. Record unavailable controls and a Person fallback explicitly. |
| Guarded visible automation | Foreground/PID/session-checked coordinate input followed by a reviewed screenshot and independent state read. This is the current Devices/brightness evidence; it does not establish semantic UIA control coverage. |
| Person | The owner physically observes the dial screen, pulls/replugs the cable or switches Windows users. Record the requested action, actual report and timestamp; do not infer a report from logs. |

Use helper `stamp` timestamps for each action start/end, and capture the actual
event used for a latency calculation (plug, port release, cancel or user switch).
Report UTC wall-clock start/end and elapsed seconds, including time waiting for
a Person separately. An unreceived Person observation stays **NOT RUN**.

For each scenario retain: final source/artifact identity, start/end, action time,
observed completion time, elapsed time, Script/UIA/Person observations, redacted
evidence paths, verdict, findings, and any owning fix commit plus rerun evidence.
Evidence filenames below are planned names unless explicitly linked. Review
and mask every screenshot before adding it to the repository. The current raw
screenshots contain full device identity and private workspace information and
remain private; no publishable image is available yet. The reviewed screenshot
at `2026-10-20T09:38:12.0207855Z` has SHA-256
`f1575a6704cdfa9fcf61a3d1bede2280e58dbaa9ea48fd95dd26015d0b0a8e57`.
It was retrieved through the private allowlisted copy path and visually inspected;
its hash identifies private evidence, not an attached public screenshot.

## Acceptance summary

| # | Scenario and acceptance | Required observation | Result | Timing / evidence |
| --- | --- | --- | --- | --- |
| 1 | Plug into a running daemon: `attached`, `fw`, `id` within 5 s; dial shows this PC's agents | Script + Person photo | NOT RUN for timed physical hotplug; attached-state prerequisite observed | One attached dial, `fw=0.0.92`; no hand-replug event, latency or Person photo; second dial NOT RUN |
| 2 | Opening does not reset; heartbeat uptime grows through two daemon restarts | Script + Person screen observation | Script PASS; Person screen observation NOT RUN; full scenario incomplete | Uptime `8112 → 8172 → 8232`, same dial attached after both actual restarts; 205.618 s, ended `2026-10-20T09:52:19.4693671Z`; original private baseline failure retained |
| 3 | Devices tab Connected; settings and pet changes acknowledged and visible | Script + visible automation + Person + screenshot | PARTIAL; Connected and brightness verified; pet/physical screen NOT RUN | Private reviewed UI shows 35% then 80%; fresh own-machine probe confirms 80 and attached; curated visible record |
| 4 | Device restart and physical replug change attachment session; reconnect within 5 s; hard reset keeps attachment session | Script + Person | BLOCKED: PnP simulation returned reboot-required 3010; not a product reconnect FAIL | At `13:51:26.1423Z`, monitor `ADMIN_RESTART_NOT_PASSED`, session unchanged; no reboot/retry, physical replug or hard-reset acceptance |
| 5 | Busy port is left alone with one warning; reconnect within 10 s of release | Script | PASS | Separate owned .NET SerialPort held COM3 for 20 s; attached count 0 while held, exactly one warning; same dial attached 2.636 s after release; 32.725 s total |
| 6 | Older firmware flashes, newest is offered/transferred over cable, dial reconnects on newest | Script + Person | Script PASS; Person update-screen observation NOT RUN; full scenario incomplete | CLI `0.0.91` flash exit 0; own-daemon `0.0.91 → updating 0.0.92 → 0.0.92` and complete protocol evidence; 111.333 s |
| 7 | App detects port and flashes newest; `running <v> ✓`; daemon/device return | Script + visible automation/Person + screenshots | PARTIAL; original GUI success and later fixed mixed-input flash observed; required CLI-return timing not established | Original run: `0.0.92`, app 1:01, later attached probe. Fixed mixed run: actual 27.5% writing, fresh hello/attached and unchanged watch session; native-writer-exit metric 21.3845 s, not the CLI-return acceptance metric |
| 8 | Cancel during write; daemon back within 10 s; subsequent flash succeeds | Script + visible automation/Person + screenshots | Scoped PASS: actual GUI mid-write Stop + normal CLI3 recovery; new dev3 GUI flash NOT RUN | Writers gone in 1.317 s; daemon open activity 4.615 s (first IPC unmeasured); decisive CLI3 exit 0, negative verdict cleared, same dial reattached 2.7990 s after CLI exit |
| 9 | Fast user switching transfers the dial to the standard console user and back within 10 s | Script + Person | NOT RUN | Owner active in visible Session 1 with C/shared tests; autonomous user switching was unsafe |
| 10 | Ten-minute idle CPU/RSS measurements with and without the dial, per daemon/helper | Script + Person for cable action | PARTIAL: plugged derived metrics verified; original collector postprocessing FAIL retained; unplugged NOT RUN | Same 5 stable pairs; total CPU 20.953125 s including test loopback server, core 20.8125 s/serials 0.0625 s; snapshot wall 601.3578848 s; stopwatch-at-failure 601.7609357 s includes final probe/postprocessing |
| 11 | Owned uninstall leaves no helper processes/files; dial returns to waiting screen | Script + Person | FAIL for attempted standard-user SSH uninstall; cleanup partial | Exit 1 after stopping own scheduled daemon/removing PATH; helper cleanup AccessDenied under standard SSH; later owned inventory: 0 processes, 1 serial file, launcher present; desktop completion/waiting screen not done |

## Scenario procedure and result fields

The procedures remain the acceptance recipe. Only the partial observations
explicitly recorded below have run; unrecorded historical result/timing fields are labeled Not recorded.

### 1. Plug in with the daemon already running

Person unplugs the dial. Record the owned daemon's running state and no attached
device, then Person plugs it in and supplies the event time. Poll device state
and measure first `attached` with firmware and ID against the 5-second limit.
Retain a Devices screenshot and a Person photo showing this PC's agents on the
dial. Planned evidence: `dial-s1-before.log`, `dial-s1-after.log`,
`dial-s1-devices.png` and a redacted dial photo. A second dial is a separate
optional fleet check; record availability and outcome without treating one dial
as multi-device evidence.

Current partial observation: the owned runtime reports one attached dial with
firmware `0.0.92`, and the reviewed Devices UI shows one Connected card. No
physical unplug/replug, arrival timestamp, five-second measurement or dial-screen
photo has been recorded. Scenario 1 and the second-dial check remain NOT RUN.

### 2. Opening does not reset

Carry E1.3's failed first fallback open and three subsequent banner-free opens
with their exact source limits. Obtain the missing Person screen observation.
With the owned app quit and the dial attached, capture `alive up=<s>` heartbeat
lines before and after each of two owned-daemon stop/start cycles. Allow enough
time for the minute heartbeat and record reattachment each time. Uptime must
increase across both restarts; unchanged USB session alone is insufficient.
Planned evidence: `dial-s2.log`, redacted heartbeat excerpts and a timestamped
Person report.

Current partial observation: before any restart test, firmware heartbeat uptimes
were `6244, 6304, 6364, 6424, 6484, 6545, 6605` seconds, strictly increasing.
The E app was quit through its own Harness menu at
`2026-10-20T09:43:25.4972147Z`; only that app was verified absent and the owned
daemon still reported the dial attached. The first private restart-test attempt
failed its baseline predicate after 241 ms, before any stop/start: PowerShell
5.1 returned a singleton device object whose scalar `.Count` was null. Native
inspection confirmed one attached device with an ID; array normalization fixed
only the private test predicate. The original failed receipt was preserved.
The corrected native private test then completed two actual owned-daemon
restarts: baseline uptime `8112`, first-restart uptime `8172`, second-restart
uptime `8232` seconds. The same owned USB dial was attached (count 1) after each
restart, and the own endpoint identity was verified before each stop/read.
Four checkpoints completed, with recovery-daemon verification true. The full
private JSON receipt was downloaded and read by the coordinator. The test
finished at `2026-10-20T09:52:19.4693671Z` in 205.618 seconds.

This is **Script PASS** for two-restart continuity and recovery. The earlier
pre-test heartbeats alone did not establish that result. Person observation of
the physical dial screen is still NOT RUN, so the full scenario remains
incomplete.

### 3. Devices tab

Open Devices using UIA where named controls exist, otherwise Person. Check
Connected, change a setting reported by the dial and apply a pet. Capture the
returned settings/device state and a screenshot with Windows-appropriate copy.
Person confirms the setting and pet on the dial itself. Planned evidence:
`dial-s3.log`, `dial-s3-devices.png` and the Person observation.

Current partial observation: a reviewed private Devices screenshot shows one
Connected card. The detail screenshot at `2026-10-20T09:35:03.3470782Z` shows
Connected, firmware `0.0.92` and brightness 35%. A protocol operation changed
brightness 80 → 35. A guarded foreground/PID/session coordinate interaction
then moved the actual UI slider 35 → 80; a fresh own-machine firmware probe
confirmed brightness 80 and `attached=true`. The visually inspected private
screenshot at `2026-10-20T09:38:12.0207855Z` shows 80%. There were 14 reported
setting names. No pet change or Person confirmation on the dial has run.

UIA exposed only two root nodes, so these actions are recorded as guarded
visible automation, not named-control UIA coverage. A private legacy tool
observer timed out because broadcasts skip tools; a fresh reconnect read of 35
confirmed the native setting write. The private observer was changed to use a
correlated own-machine RPC. This was an observation-harness issue, not a
recorded product failure.

### 4. Unplug, replug and reset

Privately identify only the test dial's composite USB device. Capture a redacted
attachment session before and after a targeted device restart; never issue a
broad device restart. Measure reconnect against 5 seconds and confirm the owned
daemon stays responsive. Repeat for a Person's physical unplug/replug. Verify
that an esptool hard reset/reflash retains the attachment session during scenario
7 and cross-reference that evidence here. Planned evidence: `dial-s4.log`,
event timestamps and scenario 7's session comparison. Keep full instance IDs
outside repository output.

Current result: **BLOCKED**. A fresh CLI3 monitor ran, but the targeted PnP
simulation returned `PNPUTIL_REBOOT_REQUIRED_3010` / exit 3010 at
`2026-10-20T13:51:26.1423Z`. The monitor reported
`ADMIN_RESTART_NOT_PASSED` and attachment session unchanged. No reboot or retry
was performed. Physical hand replug and hard-reset acceptance did not run;
this blocked script cannot establish a product serial-reconnect failure.

### 5. Port held by another program

With the owned app quit, stop only its daemon and use the owned port holder to
hold the confirmed dial port. Start the owned daemon. Verify exactly one busy
warning and no attached connection while held. Record actual release time and
reattachment within 10 seconds. Planned evidence: `dial-s5-held.log`,
`dial-s5-free.log` and redacted warning/timing excerpts. Clean up only the owned
holder, even if the test fails.

Result: **PASS**. A separate owned .NET SerialPort held COM3 for 20 seconds.
While held, attached count was 0 and the owned daemon identity was verified;
exactly one busy report was emitted. After release, the same owned physical
dial reattached (count 1) within 2,636 ms, below the 10-second requirement.
The busy-report count stayed at one, and recovery-daemon verification was true.
All 12 command exits were zero. The coordinator downloaded and read the private
JSON receipt. Start: `2026-10-20T09:56:35.3556648Z`; end:
`2026-10-20T09:57:08.0729145Z`; recorded duration: 32.725 seconds. This scenario
has no additional Person predicate.

### 6. Firmware over the cable

Record the public manifest's newest firmware and a verified older release.
With the owned app quit, flash that older
release through the owned CLI, then observe `fw=<older>`, the newest cable update
and `fw=<newest>` with attachment restored. Retain cable transfer logs and
Person's update observation. Planned evidence: `dial-s6.log` and a redacted
firmware/version record. A flash failure remains a failure until the owning fix
and a successful rerun are recorded.

Current preparation: a read-only official firmware listing returned 92 versions;
`0.0.91` was selected as the previous release. Live official metadata retrieved
through HTTPS identifies latest `0.0.92`, size 3,360,672 bytes, SHA-256
`eadb3846a6658026048418804a60341adc45fdb24793ebc9cabd782def0c8458`.
The optional no-flash prefetch ended with a private PowerShell 5.1
`NativeCommandError` while handling expected older-version stderr. No board
write occurred and no cache images were found; no prefetch rerun is planned.
This preparation-harness failure is separate from a product flash outcome.
The private S6 runner's per-dial proof matching was corrected before the actual
run below. The earlier prefetch failure does not establish a product failure.

Result: **Script PASS** on source `4c3def3c`. The owned CLI
`flash --version 0.0.91 --yes` exited 0 in 85.468 seconds, reported the older
version running and emitted the expected unverified-old-version warning.
Fresh own-daemon samples recorded:

| UTC | Attached | Firmware | Updating |
| --- | --- | --- | --- |
| `2026-10-20T10:13:49.4747816Z` | true | `0.0.91` | — |
| `2026-10-20T10:13:58.9149062Z` | true | `0.0.91` | `0.0.92` |
| `2026-10-20T10:14:11.0768362Z` | true | `0.0.92` | — |

Fresh per-dial protocol evidence contained the old-version hello, the `0.0.92`
offer (3,360,672 bytes), the complete installed acknowledgement
(3,360,672/3,360,672 bytes) and the new `0.0.92` hello. Protocol completeness
and observed-transition predicates passed. All probe commands exited 0; the
owned recovery daemon was verified and no manual recovery was attempted.
Polling took 24.4006 seconds. Start: `2026-10-20T10:12:20.4135623Z`; end:
`2026-10-20T10:14:11.7465309Z`; elapsed approximately 111.333 seconds.
Only allowlisted result fields were read from the private JSON receipt; raw
protocol lines contain full device identity and are not copied here.

Person observation of the physical update screen is NOT RUN, so the full
scenario remains incomplete. Scenario 7's separate partial GUI result is below;
scenario 8's cancellation observation and subsequent recovery failure are below.

### 7. Flash from the app

Start the combined owned app. Record attachment session, open Flash firmware
and capture detection, active writing and completion. Check that detection finds
the confirmed dial port, the flash identifies ESP32-S3, writes newest and reports
`running <v> ✓`. Check daemon/device recovery within 15 seconds and the wording
"this computer". Compare attachment session before/after the hard reset and
reflash. Planned evidence: `dial-s7.log`, `dial-s7-probe.png`,
`dial-s7-flashing.png`, `dial-s7-done.png` and a Person report.

Current result: **PARTIAL**. The exact staged app on source `4c3def3c` was
re-launched visibly in its private profile, PID 2000 / Session 1, at
`2026-10-20T10:15:31.1528052Z`. Before the flash click, its actual native GUI
probe showed COM3 ready. The private screenshot at
`2026-10-20T10:20:37.0310449Z` shows Flasher targeting `0.0.92 → COM3`, with
actual write progress at 21%. The coordinator reviewed the completion
screenshot: title "circle 0.0.92 is on the dial", board COM3, flashed version
`0.0.92`, and "Took 1:01". Its output contains `running 0.0.92 ✓` and
`starting Harness again`. Screenshots and their metadata remain private.

This first attempt did not measure the <=15-second daemon-return bound or
capture attachment-session identity before/after. A fresh own-runtime read-only
probe started at `2026-10-20T10:24:15.041Z` returned code `OK`, verified the
owned daemon and found one attached dial on firmware `0.0.92`. This later
recovery observation does not measure the <=15-second return bound. The visible
success and the app's duration display alone do not complete scenario 7 or
establish those missing predicates. Physical dial observation is also NOT RUN.

Fixed mixed-input observation: after the verified private upgrade, a new
actual GUI flash ran with app/native source `4c3def3c` and CLI/PowerShell source
`c95e86208`. A reviewed private image showed 27.5% actual writing. Its read-only
observer passed, observed a fresh protocol hello and attachment, and reported
unchanged before/after watch attachment session. The native writer exited at
`2026-10-20T12:38:32.3713346Z`; the completed fresh query observed attachment at
`2026-10-20T12:38:53.7558803Z`, a difference of 21,384.5457 ms. The observer
ran from `2026-10-20T12:37:37.5504048Z` to
`2026-10-20T12:38:54.0641423Z`. This metric starts at the OS native-writer exit,
not CLI completion: it establishes neither PASS nor FAIL for the required
15-second CLI-return criterion. The completion image at
`2026-10-20T12:41:32.0356658Z` was reviewed (SHA-256
`4cd0c3c718e1234b51967d7cee4df2eab537a60f112433c0bf227dbdc7146318`);
the own query at `2026-10-20T12:41:13.843Z` returned OK, signed in, daemon
verified, `dev.dial2` and one attached dial.

The fixed-run baseline was already attached, with a different core PID from the
original failure; why the old unattached state ceased is unproven. This flash
does not establish the decisive scenario 8 regression result. The owner changed
the network endpoint, with SSH host-key continuity verified for the same test PC.
The first window-preparation timeout after that transition was preserved;
second preparation and fresh screenshot passed, requiring no UIA fix. No
endpoint address, host-key fingerprint or raw private image is included.

Historical M1 observation: this app artifact displayed `flash-circle.sh` while
running PowerShell `flash-circle.ps1`. Source fix `444139f69` later passed widget
checks and scoped rereview; that does not update the earlier GUI artifact/image.

### 8. Cancel a flash

Start another app flash and cancel during `write app`, recording the cancel
event time. Check cancellation within 2 seconds, daemon back within 10 seconds
and, at 15 seconds, no owned esptool process and only expected owned daemon
serial helpers. The binding spec requires the daemon back; the plan's extra
immediate `attached=true` requirement conflicts with its allowance for a torn
firmware image and does not govern this cancellation step. Record daemon-log
activity separately from the first successful IPC response. A cancelled write
may leave no runnable image;
perform a second app flash and verify success on newest firmware with Person
confirmation. Planned evidence: `dial-s8-cancelled.png`, recovery timestamps,
owned process audit and second-flash evidence. No cancellation success is
inferred from a unit-test result.

First cancellation observation: **PARTIAL**, not a confirmed mid-byte-write
cancellation. At
`2026-10-20T10:27:40.9299071Z`, the guarded click targeted Stop while two exact
owned COM3 `write_flash` processes existed. Both were gone at
`2026-10-20T10:27:41.4869419Z`, with recorded disappearance latency 559 ms;
zero owned esptool processes remained at `2026-10-20T10:27:56.1025101Z`.
The private watcher completed without an error. Its process checks do not by
themselves establish when the UI cancellation completed or the daemon returned.

The coordinator-reviewed private screenshot shows "Flash failed",
"Stopped. Harness has been started again." and a cancellation error in the output.
It also shows esptool at `Connecting...`: byte writing was not observed before
the click. This attempt therefore does not satisfy the during-write predicate.
The subsequent Try again recovery flash completed successfully in the actual
GUI: `running 0.0.92` and "Took 0:59". **Recovery result: FAIL.** Fresh
identity-verified, read-only queries at 10:31 and 10:34 UTC still reported
attached count 0 and firmware null. Successful flashing did not restore the
device connection.

At 10:37:34 UTC, private diagnostics found no active flashing or cancellation
marker, only the E-owned serial watch process (no open helper or esptool).
The owned per-dial log opened at `2026-10-20T10:27:45.425Z` and closed for
silence at `2026-10-20T10:28:05.520Z`. E's persisted `data/dial-ports.json`
held one foreign-port verdict dated `2026-10-20T10:28:05.505Z`, tied to the
unchanged USB attachment session. No new hello had appeared since
`2026-10-20T10:21:21.245Z`, and no busy-to-free recovery line was present.
No full device identity or raw protocol line is retained here.

Source diagnosis confirmed that the new daemon reloads this six-hour foreign
verdict and skips the port. It was off during the successful reflash and missed
the busy-to-free transition; the unchanged USB attachment did not invalidate
the verdict. This is a product recovery failure, separate from the earlier
private observation/preparation-harness failures.

The first scoped CLI completion-hook code change was implemented at
`c95e86208dafb484ee9a662972b7a196bffaa6d3`: after a successful write and
running-version verification, before PowerShell restarts the daemon, it was
intended to clear only the chosen port's verdict while preserving siblings. Cancelled, failed,
no-flash and unverified-running paths retain their verdicts. The task's scoped
review is clean. Local CLI checks passed 73/73 plus TypeScript typecheck;
actual native test-PC PowerShell 5.1 fixtures passed 13/13 with no hardware or
network operations. These checks establish code/fixture behavior, not recovery
of the original failure. Native workflow 39412223533 now has all four jobs
SUCCESS: each architecture passed 739 contract tests (56 skipped), 31/31
flasher checks plus official `0.0.92` no-flash, exact watch installation and
clean uninstall.

The private CLI upgrade passed native configuration/current-version/helper-pin
checks, preserving the before/after verdict file hash. App/native artifacts
remain `4c3def3c`; CLI/PowerShell are `c95e86208`. The later fixed-build flash
observer is documented under scenario 7. Its baseline already showed the same
dial attached and a different core PID from the original failure; the earlier
unattached state had ceased before that write, for an unproven reason. The
unchanged verdict hash and successful ordinary flash therefore do not prove
that the S8 negative-verdict recovery failure is fixed in hardware.

The prior `4c3def3c` failure remains recorded (failure-receipt local head
`030ba49cf`). Earlier S2, S5 and S6 receipts retain their original source scope.
An intermediate private v2 watcher missed the write window, performed no Stop
and rejected a stale arm request; that is a preserved harness attempt, not a
product failure.

The later timed cancellation is genuine: the reviewed pre-click image at
`2026-10-20T13:01:49.3269075Z` shows Writing 17.0%, 212,992/1,249,692 compressed
bytes. Stop occurred at `2026-10-20T13:01:50.3652759Z` with two exact owned
writers. Both were gone at `2026-10-20T13:01:51.6806950Z`, recorded latency
1,317 ms (within 2 seconds); zero remained at
`2026-10-20T13:02:05.4872051Z`. The watcher completed without error. A reviewed
post-cancel UI image at 13:04:10.9447 UTC shows Stopped/Harness started again,
a cancellation error, and last Writing progress 19.7%.

The owned per-dial log opened at `2026-10-20T13:01:54.980Z`, 4.615 seconds after
Stop, then closed for silence at `2026-10-20T13:02:15.066Z`. This proves daemon
activity at 4.615 seconds, not the time of its first IPC response. Post-cancel
unattachment is expected for a torn image and is not itself the recovery
failure. The negative-verdict receipt records one verdict at
`2026-10-20T13:02:15.055Z`, the same USB attachment session and false markers.

The decisive direct Try again recovery used that unattached baseline and made
no new detection, cache clear or PnP intervention. It started at
`2026-10-20T13:08:18.839Z`; the native writer exited at
`2026-10-20T13:09:12.6776Z`. At 13:10:36.69 UTC, the old negative verdict still
persisted, with no new open or hello. The actual completion UI reviewed at
13:12 UTC reports `running 0.0.92 ✓`, "Took 0:59" and no callback warning, but
the dial remains unattached. **The `c95e86208` hardware recovery result is FAIL.**
The prior ordinary fixed-build flash, whose baseline was already attached,
remains noncausal evidence.

Round 2 is committed at `4fe12de12d7e1d8695bae0b01529a432fec28a17` and passed
independent scoped review with no new breakage found. The lifetime regression
using the actual watch and short-lived Node process recorded RED: 3 failed,
9 passed; the final selected suite recorded GREEN: 103/103, with TypeScript
typecheck PASS. Actual Windows PowerShell 5.1 bundle-entry fixture V2 passed:
the old dev2 exited 0 with both verdicts unchanged and no fake start (not a full
watch RED); CLI3's 500 ms snapshot showed only selected A removed, B unchanged,
exit 0 and its helper gone within 5 seconds. CLI3 selection upgrade also passed,
with verdict bytes and the same 13:02 foreign fixture unchanged. Its bundle
checksum is recorded above. The subsequent decisive normal-CLI hardware
recovery passed as recorded below. Historical
13/13 fixtures and green CI remain scoped to the first revision and do not erase
the hardware failure. A private orchestration v1 failed after starting only the
read-only observer, on a PowerShell 5.1 `File.Replace` null-backup issue. A
read-only partial receipt confirmed no flash request, zero writers, false
markers, an unattached baseline and the same single negative verdict. The private helper v2 correction was still being prepared at that point; this
superseded attempt is not a product failure and performed no CLI3 hardware flash. The later normal
CLI recovery below did run; the later blocked S4 and verified derived S10 results
are recorded in their own sections.

Decisive CLI3 recovery result: **PASS** on app/native `4c3def3c`, CLI
`4fe12de12` / `0.9.0-dev.dial3` (bundle `8cacd1f7…`) and PowerShell `c95e86208`.
The observer baseline was unattached with the unchanged 13:02 negative verdict.
There was no preparatory detection, cache clear, PnP operation or GUI action.
The normal product command `flash --yes --port COM3` ran in Limited Session 1
while the existing app remained on Done, avoiding a new GUI probe.

The product CLI started at `2026-10-20T13:42:28.9149Z`, exited at
`2026-10-20T13:43:31.8549Z` with exit 0 in 62.960 seconds, and reported
`running 0.0.92` with no completion warning. Driver time was 64.775 seconds.
The selected negative verdict count became 0, both markers were false, the
same app stayed alive, and a fresh hello/attachment was observed with the same
USB attachment session. Native writer exit was
`2026-10-20T13:43:14.0166159Z`; attachment was observed at
`2026-10-20T13:43:34.6539207Z`. That is 20.6373 seconds from native writer exit,
and **2.7990 seconds from product CLI exit**, the comparable 15-second return
metric. The observer ended at `2026-10-20T13:43:34.9449923Z` with PASS.

This is causal hardware recovery evidence for round 2 from the preserved
negative state; the earlier already-attached ordinary flash was not. S8's
recorded scope combines the prior real GUI cancellation at Writing 17% with
this normal-CLI recovery. A new dev3 GUI flash was not performed and no such
image is claimed. First IPC response after cancellation remains unmeasured;
the recorded 4.615-second open proves daemon activity only. Earlier failed
attempts stay visible above.

### 9. Two users

Create a second owned standard profile only if needed and record that ownership
privately. Person uses fast user switching to put it at the console; install and
start only its E test runtime. Capture both owned users' states: the active
console user attaches and the other releases with the expected ownership log.
Person switches back and the direction reverses. Measure each transfer against
10 seconds. Planned evidence: `dial-s9-second.log`, `dial-s9-back.log` and
timestamped Person reports. The existing setup performed no desktop switch and
cannot satisfy this scenario. It was not run because the owner's visible
Session 1 also hosts C/shared tests, making an autonomous user switch unsafe.
Do not switch, stop or alter a preexisting user.

### 10. Idle cost

With the owned app quit, record daemon and helper identities, CPU seconds and
working set/RSS at the start and end of a 600-second interval with the dial.
Repeat without the dial after Person confirms unplugging. Attribute each sample
to the same owned process identity; report restarts rather than subtracting
counters from different processes. Report CPU delta and memory samples per
process for both intervals; there is no acceptance threshold. Investigate an
unexpected number before declaring the measurement complete. Planned evidence:
`dial-s10.log` and the table below.

Current status: the app was quit normally and the private E backend remained.
The plugged snapshots captured the same five stable process pairs at
`2026-10-20T13:53:12.1757386Z` and `2026-10-20T14:03:13.5336234Z`, a wall
interval of 601.3578848 seconds. The original
collector **FAILED postprocessing** on `Measure-Object` comparison of an
OrderedDictionary. That receipt is preserved unchanged, SHA-256
`f7cd287039026718a92275840d1fa2f3bee73cc59c9241ec2669be2b378f62b1`;
it is not relabeled PASS.

Separate strict native postprocessing of those same captured vectors **PASS**:
the derived receipt reports `verified=true`, `postprocessing_only=true` and
unchanged source data. Verified total CPU delta is 20.953125 seconds, including
the test loopback server; core delta is 20.8125 seconds and the two serial
helpers total 0.0625 seconds. The pinned collector initially assigns elapsed
before its final probe, but its catch block overwrites elapsed after the failed
comparison. Thus 601.7609357 seconds is **stopwatch elapsed at failure**, including
the final probe and failed postprocessing, not the clean snapshot interval.
The final probe ran `14:03:13.5616602Z` → `14:03:13.7529415Z`; the collector
ended at `14:03:13.9389074Z`. The derived receipt explicitly sets
`elapsed_at_failure_includes_final_probe_and_postprocessing=true`.
No clock-adjustment explanation is inferred. No 600-second rerun occurred;
there is no performance threshold and no unplugged sample.

| Dial state | Process role | Start UTC | End UTC | Snapshot wall s | Verified CPU delta s | RSS start/end bytes | Finding |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Connected | Core | `13:53:12.1757386Z` | `14:03:13.5336234Z` | 601.3578848 | 20.8125 | 93790208 → 78700544 | Verified derived, same stable pair |
| Connected | Master | `13:53:12.1757386Z` | `14:03:13.5336234Z` | 601.3578848 | 0.078125 | 27111424 → 15917056 | Verified derived, same stable pair |
| Connected | Serial helper A | `13:53:12.1757386Z` | `14:03:13.5336234Z` | 601.3578848 | 0.046875 | 5238784 → 5165056 | Verified derived, same stable pair |
| Connected | Serial helper B | `13:53:12.1757386Z` | `14:03:13.5336234Z` | 601.3578848 | 0.015625 | 6103040 → 5918720 | Verified derived, same stable pair |
| Connected | Test loopback server | `13:53:12.1757386Z` | `14:03:13.5336234Z` | 601.3578848 | 0 | 13942784 → 14012416 | Included in total 20.953125 s |
| Disconnected | No sample | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | NOT RUN |

### 11. Uninstall

Run uninstall only in each E-owned test profile. Verify successful exit, zero
owned `harness-serial` processes and no helper files in that owned installation.
Person observes the dial's waiting screen. Planned evidence: `dial-s11.log`,
owned file/process audit and a Person report. Preserve preexisting Harness
installations, including C's installation; global process-name checks cannot
justify removing them.

Current result: **FAIL for the standard-user SSH attempt; cleanup partial.**
The actual uninstall exited 1. It stopped its own scheduled daemon and removed
its PATH entry, then refused helper cleanup with AccessDenied under the
documented standard-SSH restriction. A private diagnostic directs uninstall
from the Windows desktop. No uninstall replay has been attempted. A later administrator read-only
ownership and inventory audit completed: that installed test profile has zero owned processes,
one serial-helper file and a launcher still present, confirming incomplete
removal. The second, tools-only profile has zero owned processes, zero serial
files and no launcher: its read-only inventory passed, but no uninstall ran
there because no product was installed. Both profile-removal attempts later stopped at the Loaded guard with no
account/profile deletion; ownership receipts and shared scratch remain retained
under the owner cleanup waiver. The physical dial waiting-screen observation and owner-E product uninstall are NOT
RUN; its separate process/task teardown is recorded below.

An earlier private invocation was blocked by PowerShell ExecutionPolicy before
any uninstall action. Process-only Bypass corrected that harness invocation;
it is separate from the subsequent actual uninstall failure above.

## Findings, fixes and limits

| Item | Status / required follow-up |
| --- | --- |
| Core per-file coverage gate | Initial failure retained; corrected final gate PASS, 198 files / 2,904 tests, all four coverage metrics 100%, 111.447 s |
| Final TypeScript typecheck | PASS on unchanged reviewed final inputs, 4.137 s |
| Earlier scoped reviews | PASS within their original scopes; whole final review returned with fixes below |
| Native PowerShell fixture / final native CI | Old run 39387636051 terminal FAIL; fixture corrected in `ddee0341`; final run 39390890060 all four jobs SUCCESS across x64/ARM64 |
| Final CLI bundle and installation | `4c3def3c` bundle PASS in 15.7 s; owned SSH install exit 0/version/helper hash confirmed; no daemon started |
| Combined desktop artifact | Run 39393250390 both architectures SUCCESS, dry run only; isolated visible app and QR claim verified; eleven-scenario acceptance incomplete |
| E5 setup watch | `console=false`, COM3; stdin-close exit 0 within 5 s; no COM open/probe and no acceptance conclusion |
| Historical loopback asset setup | At initial setup, hash/native parse/Node checks passed with server OFF and no hosts/certificate changes; later test server is included in idle inventory and its stop passed; only profile/file cleanup was blocked and is now owner-waived |
| Desktop analyzer | 17 inherited diagnostics recorded; analyzer failed |
| Final review I2 | Inherited Important summary ordering in `cli/src/services/devices.ts:309-319`, outside E/nonblocking for E; remains open for notification/C owner and is carried to the owner final report |
| E1.3 first released-lines banner | Failed measurement retained; reset origin unproven |
| Person screen/heartbeat proof | Two actual restarts: Script PASS, uptime `8112 → 8172 → 8232`, attached after each; Person physical screen observation NOT RUN |
| Private observation harness | Legacy tool observer timeout and singleton `.Count` baseline failure preserved; corrected privately, neither establishes a product failure |
| Firmware scenario 6 | Script PASS: actual CLI older `0.0.91` flash, observed cable transition to `0.0.92`, complete offer/installed/new-hello proof, owned daemon recovered without manual intervention; Person screen observation NOT RUN |
| Historical optional firmware prefetch | Private PowerShell stderr handling error; prefetch made no board write and found no cache images; no prefetch rerun planned; separate from the successful S6 run |
| Devices UI and settings | Connected and brightness 35 → 80 verified in actual UI and fresh own-machine state; pet and physical confirmation NOT RUN |
| Devices chat panel | Shows not ready because backend chat could not start; observed separate issue, root cause unresolved |
| Busy-port scenario 5 | PASS; held 20 s, exactly one warning, attached 0 while held, same dial reattached 2.636 s after release; recovery verified; 12 command exits zero |
| App flash scenario 7 | Original GUI success remains partial. Fixed mixed-input run: actual writing, fresh hello/attachment and unchanged watch session; 21.3845 s measured from native writer exit is a different metric from required CLI-return timing; reviewed completion image and own query confirm signed-in `dev.dial2`/verified daemon/attached 1 |
| Cancellation/recovery scenario 8 | Scoped PASS: real GUI cancellation + decisive normal CLI3 recovery from preserved negative state, cleared verdict and same-session fresh hello/attachment 2.7990 s after CLI exit. Dev3 GUI flash NOT RUN; earlier `4c3def3c`/`c95e86208` failures retained |
| First recovery change / round 2 | `c95e86208` native fixtures/CI passed but hardware recovery FAILED. Round 2 `4fe12de12`: actual-watch/short-lived Node RED 3 failed/9 passed; final suite 103/103 + typecheck PASS; independent review PASS; native entry/upgrade and decisive normal-CLI hardware recovery PASS; dev3 GUI flash NOT RUN |
| Standard-user SSH uninstall / inventories | Actual exit 1; later complete read-only audit: installed profile has 0 owned processes, 1 serial file and launcher present. Tools-only profile inventory PASS (0/0/no launcher), with no uninstall. Both profiles retained; owner-E phase removed no paths or installation |
| S4 PnP simulation | Blocked by native reboot-required exit 3010; monitor did not pass; no reboot/retry or physical acceptance; no product reconnect failure inferred |
| Whole-implementation final review / I1 | Original review at `4fe12de12` returned with Important cancellation/restart blocker. I1/M1 committed in eight paths at `444139f69`; scoped rereview PASS resolved I1/M1 with no new findings. Native PS5.1 function-only fixtures 7/7 PASS; no new GUI hardware result |
| Final-wave focused validation | 84 passed/1 existing skip assembled from two receipts: final flasher 23/23 plus five completed files 61 passed/1 skip; not an uninterrupted six-file passing run. Scoped analyzer, CLI wrapper and website checks passed within report scopes |
| Final-wave compatibility limit | New app with an older cached PS1 conservatively retains that script's legacy shared marker after forced retirement; the old 10-minute suppression can remain. No mixed-version forced-recovery claim |
| Final review M2 | `serial/tests/windows.rs:24-25` unbounded initial read remains deferred to combined Windows owner by recorded ruling; passing native runs do not resolve this test-robustness follow-up |
| Final review M1: Windows flasher header | Source now uses the platform script name at `444139f69`; widget checks and scoped rereview PASS; I1/M1 resolved with no new findings. The actual app artifact remains `4c3def3c`, with no new GUI validation |
| E5 scenario outcomes and owning fixes | Scenario 5 PASS; S2/S6 Script PASS; S7 partial; S8 scoped GUI-cancel/normal-CLI3 recovery PASS, earlier failures retained; S11 SSH uninstall FAIL/partial; header source fix reviewed; other full acceptance open |
| Second-dial fleet check | NOT RUN; only one attached dial observed |
| Arm64 real hardware | Not covered by this x64 hardware report |

Any discovered fix belongs to its owning task/file, with a meaningful regression
check and scenario rerun. Record the original failure as well as the replacement
evidence; do not overwrite a failed run with a passing label.

## Cleanup and final safety audit

**Cleanup outcome: WAIVED BY OWNER on 2026-10-20.** The failed account/path
cleanup is accepted as a recorded limit; no further cleanup, reboot, hive unload
or deletion attempts will run. Retain both test profiles, test keys, portable
E root, shared scratch and positive ownership receipts. The cost is retained
test accounts/files and disk space, with possible later manual cleanup.
Historical outcomes follow. The owner-E v4 process/task teardown **PASS**:
normal private CLI3 stop, exact held PTY and server stops, and 24 completed
owned NoWait tasks unregistered. Final owned-root process and task counts were
0. This ran `2026-10-20T14:35:20.8387298Z` →
`2026-10-20T14:37:27.2000336Z`, with receipt elapsed 126.472 seconds; receipt
SHA-256 `0a3b13b17ea4bbfcd57ae33e784746e1bea597bdfc7f6b98bd345ecb7f53ed68`.
No path deletion, product uninstall or owner-profile change occurred in that
phase. Earlier cleanup guard/preflight failure, including v3, performed zero
actions and is preserved separately. Both tools-only and installed-profile cleanup attempts ended **BLOCKED by the
Loaded guard**. Each found 0 owned processes and performed no account/profile
deletion; ownership receipts remain. Exact-profile read-only audits passed: each took 31 snapshots (20.988 and
20.919 seconds), verified exact owned identity/path, found Loaded=true and
Special=false with both hives present, and could not determine RefCount. No
exact-identity logon or WTS session was present, so no safe owned session logoff
was available. No hive unmount has been performed. Removal attempts were BLOCKED; the owner has waived further cleanup. Loader/handle provenance is unproved; no direct hive unload, global
service restart or reboot was performed in this run. The prepared
remover was not executed. Shared scratch remains retained under the owner waiver.

The five-proof native ZIP was built after the owner-E process stop and before
any path deletion. The preexisting private Mac proof manifest preceded the stop. Native archive and
download checks passed; ZIP SHA-256
`b9dd06eecfe2348b65076dd3e998421c0657f0775906f5937e6acddc11963fe9`,
11,830 bytes, five source files. On the Mac, whole-ZIP hash, all five entry
hashes and CRC were verified. This archive contains no authentication files,
screenshots, configuration, profiles or raw command logs. Existing private
scenario JSON/images/command proofs were already manifested before teardown;
none of that raw content is copied here.
The fresh read-only public-preflight comparison against the original baseline
is **NOT PASS**: baseline 5 process identities/2 tasks; 3 old process identities
are absent and 3 old listeners are absent (6 differences), while task differences
are 0 and both tasks remain. Cause is unproven; C/shared work occurred
concurrently. No E action against C was authorized or performed, and no baseline
rewrite or C restoration was attempted. This does not certify full C state or
establish that E caused the changes. It is separate from the guarded owner-E
process/task teardown PASS.

Native inventory V2 completed with 12 owned processes, 109 task receipts
and 0 inventory issues; this is inventory, not cleanup. The first inventory hit
its 55-second deadline before enumeration, so its zero process count was not a
measured zero. Owned paths remain retained; native function fixtures and owner-E process/task teardown are complete, remaining account/path cleanup was blocked by Loaded profiles and is now owner-waived. Preserve
the private ownership ledger until cleanup is verified. Stop/remove only E-owned processes, loopback server, scheduled tasks,
temporary files, installations, test users and newly created profiles. Remove
only the dedicated test key from the owned profile and remove its private local
copy through the private workflow. No administrator key was installed, so the
historical task-brief command editing the administrator authorized-keys file
does not apply. Never edit a preexisting key file on that assumption.

Compare the final private audit with the fresh E5 baseline. Confirm every
preexisting process identity and C installation is preserved, all owned scratch,
tasks/users/profiles/keys are removed, and no owned processes remain. Do not
delete an object merely because its name matches a test name; verify ownership
first. Preserve reviewed redacted evidence only. Record actual cleanup findings
and any remaining owned objects rather than reporting a clean machine from a
zero-count assumption.

| Cleanup check | Result |
| --- | --- |
| Original baseline comparison | NOT PASS: 3/5 old process identities and 3 old listeners absent; 6 differences. Task diff 0, original 2/2 tasks retained. Historical initial setup 5/5 receipt remains separate; cause unproven |
| C/shared-state preservation | Not certified by final comparison; concurrent C/shared work occurred, no E action against C authorized/performed, and no causal attribution or restoration |
| E-owned processes / loopback server / tasks removed | Owner-E v4 PASS: normal CLI3/exact PTY/server stop; 24 completed owned tasks removed; final owned-root processes/tasks 0. This is not a global system zero or uninstall result |
| E-owned files / test installations / scratch retained | Standard-user uninstall removed PATH entry then helper cleanup AccessDenied/exit 1; later audit confirms 1 serial file and launcher remain there; tools-only profile has 0 serial files/no launcher; owner-E phase removed no paths or installation |
| E-owned users and newly created profiles removed | Both attempts historically BLOCKED by Loaded guard; owner waived further cleanup, each with 0 owned processes; no account/profile deletion; ownership receipts retained; exact-profile audits PASS but Loaded=true/no owned logon or WTS session, so no safe session logoff |
| Dedicated test keys | Retained with ownership receipts under owner waiver; no removal claimed |
| Reviewed, redacted cleanup evidence | Owner-E teardown receipt PASS retained; both Loaded-blocked account receipts retained; final baseline comparison NOT PASS; remaining cleanup open |

## Elapsed-time record

Record the user's request start and completion in addition to individual command
times. Keep implementation, validation, integration/merge, CI/build waiting,
Person waiting, report writing and publication separate. Overlapping work must
not be summed as elapsed total. Existing prerequisite check durations above are
not timings for the current E5 acceptance. Initial setup command start/end
times were not captured; do not substitute the curated evidence timestamp or
invent an elapsed duration. Recorded point observations below are not a total run duration. The verified
ledger execution start is separate from the unrecorded original user-request
time. Phases overlap, so net waiting cannot be reconstructed; private wrapper
receipts retain individual action timings.

| Phase | Start UTC | End UTC | Wall time / waiting time | Status |
| --- | --- | --- | --- | --- |
| Original user request timing | Not recorded | Not recorded | Original request total cannot be reconstructed | Ledger start is not substituted for the original request timestamp |
| Tracked ledger execution window | `2026-10-20T02:57:34.449628Z` | `2026-10-20T14:59:04Z` | 12 h 1 min 29.550372 s (43289.550372 s) | Ledger start → report update, not original user-request duration |
| Initial E5 account/CLI setup and installation | NOT CAPTURED | NOT CAPTURED | Not available | Historical owned CLI install confirmed; current visible profile/login verified separately |
| Final CLI bundle | Not recorded | Not recorded | 15.7 s | PASS from `4c3def3c` |
| Implementation / owning fixes | Not recorded | Not recorded | Not recorded | Original fixture/coverage fixes plus first recovery change `c95e86208` failed hardware rerun; round 2 `4fe12de12` locally tested/reviewed, native entry/CLI3 upgrade/normal-CLI recovery PASS; dev3 GUI flash NOT RUN |
| Final local validation | Not recorded | Not recorded | Core 111.447 s; typecheck 4.137 s; overlap/phase total not recorded | Both PASS; scoped reviews PASS |
| Final native validation | Not recorded | Not recorded | Not recorded | Run 39390890060 all four jobs SUCCESS; native x64/ARM64 checks and clean uninstall |
| Integration / merge | Not recorded | Not recorded | Not recorded | Historical C → E prerequisite recorded; E → C merge not performed; owner waiver removes cleanup blocker, E5.3 closure/owner integration remain separate |
| CI/build waiting | Not recorded | Not recorded | Net waiting not reconstructable from overlapping phases | Completed run receipts recorded separately |
| Visible exact staged app observation | `2026-10-20T09:11:49.6111191Z` | — | Point observation only | Visible Session 1; private profile verified |
| Devices brightness 80% screenshot | `2026-10-20T09:38:12.0207855Z` | — | Point observation only | Reviewed private image and fresh own-machine probe |
| E app quit | `2026-10-20T09:43:25.4972147Z` | — | Point observation only | Only E app absent; owned daemon remains attached |
| Scenario 2 corrected native restart check | Not recorded | `2026-10-20T09:52:19.4693671Z` | 205.618 s | Script PASS; Person screen observation NOT RUN |
| Scenario 5 busy-port check | `2026-10-20T09:56:35.3556648Z` | `2026-10-20T09:57:08.0729145Z` | 32.725 s | PASS; release-to-attachment 2.636 s |
| Scenario 6 flash and cable update | `2026-10-20T10:12:20.4135623Z` | `2026-10-20T10:14:11.7465309Z` | Approximately 111.333 s | Script PASS; CLI flash 85.468 s, polling 24.4006 s; Person screen observation NOT RUN |
| Scenario 7 flashing UI observation | `2026-10-20T10:20:37.0310449Z` | Not recorded | App completion displays 1:01; independent total and daemon-return timing not measured | PARTIAL actual GUI success; first-attempt session comparison not measured |
| Scenario 7 later recovery probe | `2026-10-20T10:24:15.041Z` | Not recorded | Probe observation only; return latency unmeasured | Own daemon verified, attached 1/fw `0.0.92` |
| Scenario 8 first cancellation | `2026-10-20T10:27:40.9299071Z` | `2026-10-20T10:27:56.1025101Z` | Writer disappearance 559 ms; zero writers at 15 s observation | First cancellation partial; screenshot shows Connecting |
| Scenario 8 recovery failure | Not recorded | Diagnostic at `2026-10-20T10:37:34Z` | App reports successful flash in 0:59; later 10:31/10:34 attachment checks fail | Prior FAIL retained; reviewed first change also failed hardware rerun; round-2 native entry/CLI3 upgrade/normal-CLI recovery PASS; dev3 GUI flash NOT RUN |
| Recovery-fix native fixtures / CI | Not recorded | Not recorded | Duration not recorded here | 13/13 actual native PowerShell 5.1 fixtures PASS, no hardware; CI 39412223533 all four SUCCESS |
| Private CLI upgrade completion | Not recorded | `2026-10-20T11:16:27.2047485Z` | Point receipt; total duration not recorded here | Native upgrade checks PASS; verdict hash preserved; mixed provenance |
| Fixed mixed-input flash observer | `2026-10-20T12:37:37.5504048Z` | `2026-10-20T12:38:54.0641423Z` | Writer exit → fresh attached query 21,384.5457 ms; different from CLI-return timing | Observer PASS; baseline already attached, so not decisive S8 regression proof |
| Scenario 8 genuine mid-write Stop | `2026-10-20T13:01:50.3652759Z` | `2026-10-20T13:02:05.4872051Z` | Writers gone 1.317 s; daemon open activity 4.615 s; zero writers at 15 s | Actual Writing progress verified; daemon activity is not first IPC-response timing |
| Scenario 8 direct recovery on `c95e86208` | `2026-10-20T13:08:18.839Z` | Negative verdict still present at `2026-10-20T13:10:36.69Z` | Native writer exit `13:09:12.6776Z`; app reports successful flash in 0:59 | FAIL: no new open/hello, remains unattached; round-2 native entry/CLI3 upgrade/normal-CLI recovery PASS; dev3 GUI flash NOT RUN |
| Round-2 lifetime regression / review | Not recorded | Not recorded | Duration not recorded here | RED 3 failed/9 passed, final GREEN 103/103 + typecheck, independent review PASS; native entry/CLI3 upgrade/normal-CLI recovery PASS; dev3 GUI flash NOT RUN |
| Scenario 11 standard-user SSH uninstall | Not recorded | Not recorded | Duration not recorded here | Exit 1/partial cleanup; desktop completion not run |
| Scenario 8 decisive normal-CLI3 recovery | `2026-10-20T13:42:28.9149Z` | Observer ended `2026-10-20T13:43:34.9449923Z` | Product CLI 62.960 s, driver 64.775 s; CLI-exit → attached 2.7990 s; native-writer-exit → attached 20.6373 s | PASS from preserved unattached/negative baseline; no new dev3 GUI flash |
| Scenario 10 plugged interval / derived verification | `2026-10-20T13:53:12.1757386Z` | `2026-10-20T14:03:13.5336234Z` | Snapshot wall 601.3578848 s; stopwatch-at-failure 601.7609357 s includes final probe/postprocessing | Same 5 stable pairs; original collector FAIL retained, separate native same-vector derived metrics verified; no repeat/unplugged sample |
| Final review / I1-M1 fix wave | Not recorded | Not recorded | Duration not recorded here | Source `444139f69` committed; focused composite checks and native function fixtures PASS; scoped rereview PASS (I1/M1 resolved, no new findings), no new GUI hardware run |
| Eleven hardware scenarios | Not recorded | Not recorded | Not recorded | All eleven verdicts recorded with limits; E5.2 documentation COMPLETE WITH LIMITS; cleanup owner-waived; physical/unplugged/GUI limits explicit |
| Person waiting | Not recorded | Not recorded | Not recorded | NOT RUN |
| Owner-E process/task teardown | `2026-10-20T14:35:20.8387298Z` | `2026-10-20T14:37:27.2000336Z` | Receipt elapsed 126.472 s | PASS; owned-root processes/tasks 0, no path deletion/uninstall/profile change |
| Account/path cleanup disposition | Not recorded | Owner waiver 2026-10-20 | Not applicable | Loaded-guard attempts blocked, then owner waived further cleanup; profiles/keys/portable root/shared scratch/receipts retained |
| Final baseline comparison | Not recorded | Not recorded | Not recorded | NOT PASS: 3 old identities + 3 old listeners absent; 2/2 original tasks retained; cause unproven, no E action against C |
| Report update / redaction | Not recorded | `2026-10-20T14:59:04Z` | Not recorded separately | E5.2 scenario/evidence documentation COMPLETE WITH LIMITS; root closes E5.3 after commit/review |
| Publication / release | — | — | Not applicable | Not performed by E; integration/release belongs to the owner after handoff conditions |

E5.2 scenario/evidence documentation is **COMPLETE WITH LIMITS** under the
owner's 2026-10-20 cleanup waiver. The owner directed no further cleanup,
reboot, hive unload or deletion attempts; no reboot approval question remains.
The prepared remover was not executed. Retain both test profiles, test keys,
portable E root, shared scratch and positive ownership receipts. Later manual
cleanup may be needed; it is not an active task in this run.

The waiver does not turn S11 uninstall into PASS, erase the six unexplained
baseline differences, certify global C preservation or invent missing physical,
user-switch, unplugged or new-GUI hardware acceptance. I2 remains an Important
notification/C-owner follow-up and M2 remains deferred to the combined Windows
owner. E5.3 closes through root after documentation commit/review. Merge and
publication were not performed; the owner's session owns later integration.

## Appendix: complete ledger rulings and recorded costs

These are all ledger `Ruling:` entries in ledger order at this refresh, preserved
with their recorded costs. Historical status/source statements inside a ruling
refer to its original time; the current evidence and owner integration policy
in the main report govern. A missing recorded cost is identified explicitly;
no cost or approval is invented. Ledger line numbers identify the source entry.
Current marker compatibility clarification: an updated PS1 plus a valid per-run
identity selects the per-run marker, even when an older CLI forwards that
identity. An old app/no identity or an old cached script uses the legacy marker;
CLI age alone does not determine it. The historical wording in ledger line 376
below is preserved, with this current clarification governing interpretation.

1. **Ledger line 77.** Ruling: Extract task briefs with a local Python heading parser after the skill's task-brief script rejected E1.1 — the script supports numeric headings only — cost if wrong: a task brief could omit text; each boundary is checked against the original plan.

2. **Ledger line 78.** Ruling: probe must configure the COM handle with the same DCB and timeouts as open before closing — spec section 1.3 overrides E1.2's code sample — cost if wrong: extra SetCommState call per probe, covered by the mandatory Dell non-reset measurement.

3. **Ledger line 79.** Ruling: Unknown Windows console state is false, and console() starts watch without granting USB ownership — spec section 2 overrides E2.1's true default; subsequent fleet scans consume the answer — cost if wrong: discovery delayed by one scan or a stuck watcher; cover startup and recovery tests.

4. **Ledger line 80.** Ruling: Do not push a deliberately uncompilable workflow solely for RED evidence; attempt Windows-target cargo check tests locally for RED, then push the implemented E1.2 once for native validation — bounded validation and handoff push budget take precedence over E1.2 Step 2 — cost if wrong: local compilation cannot establish Windows runtime behavior; both native CI rows remain required.

5. **Ledger line 81.** Ruling: Windows flasher marker must match the exact first line, not a prefix — spec section 3.2 overrides E4.2's startsWith sample — cost if wrong: rejects a malformed previously cached script; unit tests cover LF and CRLF.

6. **Ledger line 82.** Ruling: E5.3 status names feat/windows-dial until the owner agrees to integration — handoff branch ownership overrides the plan's premature feat/windows-desktop status — cost if wrong: documentation needs one status update on integration.

7. **Ledger line 109.** Ruling: E1.2 rejects SetupDiEnumDeviceInfo failures other than ERROR_NO_MORE_ITEMS and uses a dedicated stdin reader that exits the process at EOF independently of blocked serial writes — the provided cancellation/join sample can orphan a child and suppress enumeration errors, contrary to spec sections 1.1/1.2 — cost if wrong: EOF closes immediately rather than draining queued writes; the inter-thread input queue may grow under an unresponsive port, while current cable protocol bounds outstanding frames. Native EOF tests and Dell measurement remain required.

8. **Ledger line 122.** Ruling: E1.3 serial-check keeps the planned measurement sequence/output but bounds process reads/exits, cleans up owned children, redacts errors and returns nonzero for failed/missing measurement criteria; add a focused Windows-gated fake-native behavior test file — sample blocking reads and raw JSON failure text could hang or expose full serials, violating safe reliable measurement — cost if wrong: extra test/tool code and explicit failure for missing LastArrivalDate; actual Dell measurement still required.

9. **Ledger line 124.** Ruling: E1.3 put-admin resolves admin_root in its own checked assignment before copying, rather than nesting command substitution in put_files — the sample loses scratch-creation failure status and could copy without a valid owned destination — cost if wrong: one extra shell assignment; regression test pins refusal to copy on ownership/setup failure.

10. **Ledger line 160.** Ruling: Fix E1.2 native install evidence by authenticating only the CI OpenCode helper with the installed daemon existing local credential and retaining actual handshake errors, plus protected disposable-WebSocket regression tests — logs/source/reproduction establish inherited helper auth mismatch, not a missing daemon or serial failure — cost if wrong: helper install CI remains red; no daemon auth behavior or production runtime change. A single corrected push is authorized under failed-run fix policy; never rerun just to retrigger. Diagnosis: e1.2-arm-install-diagnosis.md. Implementation begins after current docs writer completes.

11. **Ledger line 181.** Ruling: complete the second nonintrusive automated Dell open under owner ack/current directive, and treat the spec automated DTR criteria as the E2 gate; record Person screen observation as NOT RUN and carry it to E5 rather than falsely claim it — owner directs continued execution; spec sections1.2/5.3 require session/open/banner evidence and E5 retains uptime verification — cost if wrong: a visible reset without emitted ESP-ROM or link/attachment change could escape this first gate; E5 heartbeat/screen acceptance remains required. No C process/UI/session/setting changes, flash/unplug or ARM64 VM authorization inferred.

12. **Ledger line 182.** Ruling: execute E4.1 and E4.3 concurrently with controller completing E1.3; their flasher marker/cancel contracts are already fixed by the approved spec and their file sets are disjoint. E4.1 alone owns windows.yml during this wave; E4.3 only Desktop Dart/tests — cost if wrong: cross-task contract integration rework, covered by tests and final branch review.

13. **Ledger line 185.** Ruling: E4.1 keeps esptool timeout/cancel monitoring active after pipe EOF and stops/disposes owned child before clearing reference; cleans owned flashing marker on stop failure, restarts Harness only if successfully stopped by this run — sample could orphan child or leave marker, violating cancellation/lifecycle contract — cost if wrong: regression in process/output handling; Windows-native fakeprocess tests added to existing spec/CIstep without additionaljobs.

14. **Ledger line 186.** Ruling: E4.3 preserves15s kill grace even on cancel-file write failure — spec says hardkill only after grace; sample catch immediately kills — cost if wrong: cancellation waits15s when file cannot be created; invalid-directory regression covers fallback timing.

15. **Ledger line 191.** Ruling: take planE1.3Step5 fallback DCB_RAW=1 (bothlinesreleased) after asserted-lines config produces ESP-ROM on both newattempt and controlledimmediaterepeat — no-reset requirement overrides unverified bitchoice, and approved plan explicitly supplies this fallback — cost if wrong: newlines mode may not carry cablebytes or stillreset; actualnewbinarymeasurement mandatory beforeE2, no hardwarepass claim until measured. Originalnativeworker owns Rustmodeltestchange, no remoteaccess; next reviewed E4.1push can also deliver fallbackartifact without extra speculativepush.

16. **Ledger line 201.** Ruling: E5.1 samples must propagate native installer/version/CLI failures, filter null device snapshots, and consume actual `[daemon]` dial-log events (CableSession strips `cable:` before writing) — otherwise kit can falsely report success or empty/miscounted evidence — cost if wrong: helper output differs from literal sample; mocked behavior tests and eventual nativeE5 gate verify actual interface. Raw unparseable devices output is suppressed to avoid leaking full ids/account info in evidence. No new installer wall-clock contract added beyond kit existing bounds.

17. **Ledger line 217.** Ruling: move existing Flasherwithoutboard step after Collectpayload+uploadartifact, retaining all stepconditions/content/jobs and install dependencies — native Rust/CLI-verified helperartifact is independent of websiteflasher and must be available for parallel E1.3 measurement even if flasherneedsmorefixes — cost if wrong: an artifact canexistfromanoverallfailednativejob; E1.3mustcheckexactsource+nativebuild/testsuccess and mustnotclaimflasher/jobacceptance. Releasepayloadcheckstillprecedesupload, releaseflasherstillconditional skip, no extra jobs/runs/tests skipped.

18. **Ledger line 232.** Ruling: same-owner-authorizedactiveisolateddiagnostic session runs2moreunchanged-binaryopens to determine whether repeatedreleasedopens staybannerfree; mixedfirstpaircannot establish resetedgeorclaimmodefailure/pass — costifwrong: bufferedoldbanneror delayedresetcouldconfoundfirstpair; consecutiveextraopens+E5heartbeatcheckkeepacceptancehonest. NoadditionalDCBguess, noCchanges.

19. **Ledger line 235.** Ruling: E2.1 andE2.2codeexecuteconcurrentlywithfixedbriefinterfaces; E2.1ownsnewmodule/fixture/spec, E2.2ownsserial/console/fleetadapters+integrationtests/workflow. E2.2mustwaitE2.1moduleAPIreadybeforefinaltestsandbothmustfreezesourcesbeforenativepush; commitsserialized. Costifwrong: integrationrework/testreceiptinvalidation, mitigatedbyjointaffectedtests+independentreviews.

20. **Ledger line 241.** Ruling: extendE2.2 with Windows-only core/devicesWake.start request for devicesoncebound, afterexisting outOfProcess/asked/cableDisabledguards — actualharnessdservices devicesisondemand anddialPortThereWindowsalwaysfalse, contradictingplan'sassumptiondevicesstartwithcore; withoutfixfreshWindowsdaemonneverstartshelperbeforeDevicesrequest, breakingplug-and-goandE3nativegate. Noedgeimports/architectureexceptions; macOS/Linux/disabled/inlinepathsunchanged. Costifwrong: Windowswithoutadialrunsdevicesprocess (~72MiBbaselineasdocumentedinservices.ts); specidlecosthasnothresholdbutmustmeasure/reportE5. CoreunitTDD+requiredtest:core100%gates/typecheck/architectureverification beforepush. Thisisaseparatefocusedfixcommittoexposeplanrepair; no startupbehaviorguessing/CI-redpush.

21. **Ledger line 273.** Ruling: E5mustexerciseunpublishedcurrentflash-circle.ps1withoutpublishingwebsite/stagingorrewritingglobalhosts/certificates. PrepareanE-ownedloopbackHTTPserverservingonlymeasuredPS1intheownedprofileandpassWEB_URLonlytoownedECLI/appenvironment;firmware/esptooldownloadsremainofficialhashchecked. CLIflashusesenv.WEB_URLandfetchesbeforecache,sooldCstagingwebsitecannotproveE4. Costifwrong: E5localserverenvironmentdiffersfromreleasedsite; recordtransportoverrideandexactscriptSHA, retainnativeCIrealfirmwaredownloadproof, donotclaimpublicendpointacceptance. No serverstarted/globalCDNchangesyet.

22. **Ledger line 291.** Ruling: ownerQR+ownerautomationdirectionauthorizestheseauth/sessionUIactions; keepallcredentials/QRtickets/rawprivateoutside repo, noMacdaemonconfig/restart/testmutation. **Cost: not recorded in this ledger entry.**

23. **Ledger line 300.** Ruling: C/main changed devices list to account trust records; adapt dial-state tooling to current hardware list hosts interface and preserve strict hosts parsing/ownership guards — obsolete plan namespace otherwise makes E5 observations fail; cost if wrong is helper compatibility, covered by real argv/shape behavioral fixture. Scope2files unstaged; RED2/GREEN50pass7nativeskips; independentreviewnext.

24. **Ledger line 328.** Ruling: extendE5.2 tofixconfirmed persistednegativeverdict recovery withCLI-owned scoped successcompletionhook afterwrite+verify BEFOREPSfinallyrestartsdaemon; keepallunrelatednon-dialverdicts, cancellation/failure/detect/noFlashunchanged, oldnewCLI/scriptcompat child-onlycapability env+private flash__completebranch. Costifwrong: incorrectly clearing a developerboard verdict or failedcompletion stillstrandingdial; meaningfulpersistedA+B/freshfleet/ambiguousselectedport/nativehookorderfixtures +actualunchangedliveforeignstateE2Erequired. Thisisnotpermissionforanymerge/publish/Cworktreechange. Designapproved; freshimplementerRED6fail23pass in flash.spec; nofixverificationyet. E5.3/finalreviewnotstarted, currentlocalHEAD030ba49cf.

25. **Ledger line 333.** Ruling: push reviewed recovery bug fix once at c95e86208 to obtain native CLI/PS1 evidence beyond scheduled plan pushes — real E5 regression changes relevant native inputs; cost if wrong: four heavy jobs; no active competing run before push, no retry-only push. Native run39412223533 in progress, exactheadc95, x64/ARM; no success claim. Owner Emergepolicy unchanged; root does not merge.

26. **Ledger line 348.** Ruling: remove controller-invented externalrootvisual-pre-arm gate; privatepreloadedhelperwillcaptureactualownappimageimmediatelybeforeoneGUICancelafter8sverifiedwriter, thenrootreviewsimageafter — useralreadyexplicitlyauthorizesautonomousactualflash/cancelE2E; rootroundtripadds34s beyondwritewindow, notspec/userpermission requirement — costifwrong: Connectingimageorendedwriter=>caseNOTPASSED; no extra boardoperationbeyondalready-authorizedGUIcancel, exactSID/path/session/foreground/PID/start/<=2writer/livepointguardskept, normalcancel-fileprotocolthroughappunchanged. Newtimedhelperonly, originalv2failurepreserved; no productchange.

27. **Ledger line 353.** Ruling: applyspecS8daemon-backcriterion independentlyofdial-attachedaftercancellation — binding spec5.3 saysdaemonbackwithin10s andsecondflashsucceeds, planadditionallyrequiresattachedtrueevenwhileacknowledgingtornimage; actualpartialwritecannotbootuntilrecovery — costifwrong: planextraattachedpredicateisunmetandexplicitlyreported; nofalsescreen/deviceattachmentclaim, requiredecisivesecondflash+freshsame-dialhello. Specdaemonactivitymeasuredbyownserialopenat4.615s, notdirectIPCfirstresponse.

28. **Ledger line 368.** Ruling: verify round2 causal recovery through normal CLI3 flash while unchanged owned app stays on prior Done modal — opening a new GUI flash dialog invokes detect and can clear the retained foreign fixture, masking the bug; actualCLI3runsproductionPS1successcallback+finally andappper-invocationmanagedcurrentresolvesnewCLI — costifwrong: newCLI3GUIlaunchisnotdirectlyrerun, explicitlyreported; priorGUI4c/dev2success+actualGUIcancel stillvalidunchangedappinputs, nativeactualentry/ownUItestscoverrouting.

29. **Ledger line 370.** Ruling: final E implementation review uses integrated C parent87779178 as base through frozenE4fe12 ratherthanrereviewing allincomingC fromoriginal8fbfork — isolatescompleteEdelta+integrationseams, CownerownsC broadreview; costifwrong: incomingC-onlydefectnotreassessedbyEreview. LatestC38dde shortcut/clipboarddeltas doNOTtouchserial/flash/runner/nativeinputs, read-onlyverified. Reviewrunswhilefinalidle/cleanupanddocreceiptsfinish; anynewcodechangeinvalidatesrelatedreceiptandgetsscopereview.

30. **Ledger line 374.** Ruling: defer M2 nativeWindows test initial-read timeout tocombinedWindowsowner — existingunchangedproduct/nativejobsPASSandtestrobustnessminor, focusfinalwaveonEblocker+relatedUIcopy; costifwrong: futurewatchregressioncanhangnativeCIuntiljobtimeout. InheritedI2remainsImportantownerfollowupnotEfixscope; no claimresolved.

31. **Ledger line 376.** Ruling: appWindowsflashusesrandomchild-onlyrunid andnewPS1creates timestampmarkerflashing.<stricthexrunid>, Dartleasehonorslegacyflashingandnewper-runmarkers; forcedcleanupremovesONLYthisrunfilenameafterkillFuture+parentexit. Standalone/no-capability/olderCLIretainlegacysharedmarker, cachedoldscriptconservativelyleftonforcedcancel; newownershipcapabilitymustnotleaktorestarteddaemon. Strongerthanmtime/sidecarwhichcanracewithanotherwriter. Costifwrong: additiveleaseprotocolconsumeromissionwouldallowprematuredaemonrestart; rootrgfindsDartSerialPortLeaseonlyconsumerbesidesPS1, focusedlegacy/newmarkersupervisiontestsandnativePS5fixturesrequired. NoBash/Unixflasherchange.

32. **Ledger line 393.** Ruling: Owner explicitly waived the blocked cleanup on 2026-10-20 (latest instruction: cleanup may be left if it cannot complete). Stop further cleanup, hive unload, reboot and deletion attempts. Close E5.2 as a completed scenario/evidence report with recorded limits and owner-waived residual cleanup, then E5.3 documentation; no successful uninstall, full baseline preservation, missing physical checks or new GUI artifact claim is inferred. Cost if wrong: two newly created test profiles, their dedicated keys, the isolated portable E root and marked shared scratch remain on the test PC, consuming disk and requiring later cleanup; all E-owned runtime processes and tasks have already been stopped/removed and evidence is preserved. Owner-only E-to-C integration remains unchanged.
