Optional launch settings extraction: proposed second slice; no runtime edits yet

Source facts
- engines/launches.ts imports kit/attribution.ts (JSON/TOML settings interpretation) and kit/statusLine.ts (settings interpretation, bundled script loading, script publication, Windows quoting).
- lib/agentAttribution.ts is the sole production agentInstructionArgs caller. It always supplies prLine:null. attributionArgs has no production caller. Saved pullRequestLine is explicitly ignored already; do not remove compatibility data storage as part of this extraction.
- Live behavior: readAgentSettings(...).agentsStartAgents legacy instruction text; Codex preserves existing developer_instructions and declines override where workspace/ancestor configs set it; Claude appends the text. Claude also wraps the person's statusLine in hook/statusline.mjs so quota reports remain live. Do not confuse this with dead PR branding.
- Existing prepareFiles talks to engineSetup using bounded input/commit and returns file contents indexed against owner-selected destinations. NativeHookInput currently only represents hook installation; NativeHookCandidate currently has only files. It cannot return declarative launch values without a typed extension. Writing an extra --settings file would change precedence and is not proposed.

Boundary proposal
1. Remove dead PR-setting/instruction branches, their declarations and test-only attributionArgs public helper in the same change; preserve existing old-setting persistence and no-branding tests. Rename the surviving Codex instruction declaration to describe developer instructions rather than attribution. Keep the same declared literal argv templates.
2. Extend the existing setup file-preparation protocol with a discriminated launch-settings input, independently requested from required hook preparation. Reuse setup_files_prepare/commit, their existing admission/deadline/ownership machinery and indexed file publication; no new RPC command/broker, arbitrary argv result, file destination result, executable choice, queue or registry record. An old/unavailable setup reply makes optional launch values empty; it must not hold a native launch whose required preparation succeeded.
3. The core selects the script destination (<data>/statusline/statusline.mjs) and captures bounded immutable text inputs for the declared engine settings files and agent-settings.json. It supplies the already selected environment/home, cwd and platform/quoting facts from launch authority, plus the exact output slot. Codex ancestor lookup is owner-selected and capped at the same physical path-depth bound used by NativePaths (256); total captured content remains within the existing 2 MiB payload budget, per file 1 MiB. Any unavailable/over-limit optional capture omits only optional settings. The worker reads no personal source file independently.
4. engineSetup alone loads the legacy instruction text, agent-settings parser, vendor JSON/TOML parsing, statusline script bytes and value rendering. Existing tests for user/project/local precedence, Codex ancestor overrides, Windows Git Bash/PowerShell and preserved statusline properties move with that implementation. It returns at most two bounded value slots (instruction value and settings JSON value, each <=64 KiB) and at most one indexed script content entry. Core uses source-declared templates to place each value: no returned flag or argv array can authorize anything. Keep inline --settings JSON and its existing position/merging semantics.
5. Keep only the small existing pure argv-composition mechanics in core: applying literal declared templates, joining repeated append-system-prompt values, and merging declared inline --settings objects (already needed when grid/DSH args share that flag). Split those mechanics from statusLine.ts so core loads no script renderer, filesystem publication or vendor settings-source parser. This is session argv construction, not a generic new command broker.
6. The existing native publisher owns final script publication and indexed-path validation. Recheck the current launch/environment and captured-source proofs after worker awaits and immediately before publication. Cancellation, executable/home replacement, wrong indices, unknown keys, oversized replies or changed sources discard the optional candidate, never publish elsewhere or revive an old launch. Required hook preparation stays separate so optional feature failure cannot veto a healthy session. Final caller handling must omit an optional candidate whose proof is lost rather than inject stale settings.
7. Each final launch owner awaits this preparation once after its last required native preparation and selected environment, before final argv construction. The base buildLaunchOverrides does not prepare optional values. Production always has NativeLaunch after slice 1; no fallback imports old in-core implementation. Explicit inline/no-master uses the same service preparation implementation through its existing door.

Design checklist
No new stored schema, endpoint, account, credentials, timer, success cache or persistent optional state. File path is the same existing script path; input data and old configuration stay private under the same login. Outside settings content is data. Existing error omission semantics remain: optional quota/instructions absence must leave the user's own status line/instructions intact and session launch available. One bounded setup round trip per eligible launch, existing concurrency bound; measure exact added capture/IPC cost after source freeze before accepting this path.

RED tests before edits
- Default core closure excludes attribution.ts and statusLine.ts implementation and the bundled statusline script; engines/launches.ts no longer depends on agent-settings parsing. The core experiment owner still uses agentSettings.ts, so that module remains in the closure. Pure argv composition retains exact repeated-flag bytes.
- Worker values cannot choose argv flags, executable or publication path; unknown fields/indices/over-limit values rejected.
- Current executable/home/launch/source mutation at every await/publication boundary leaves user files untouched and produces no stale optional values.
- Setup absent/timeout/old protocol + required native ready launches successfully with user's settings unchanged.
- Claude user/project/local statusLine precedence, preserved properties and exact original command survive wrapping; Win32 with own PowerShell statusline remains untouched; Git Bash paths keep exact escaping.
- Codex own/workspace/ancestor developer_instructions and existing legacy instruction toggles are preserved byte-for-byte; old pullRequestLine true still adds no PR branding.
- Create/fork/resume/restart/restore all consume prepared values through their existing native launch authority; no duplicate feature fallback.

Coordinator decision before runtime edits
The boundary is approved after this Design and RED tests, with these concrete requirements:
- The two optional value slots are exact (no unknown keys, NUL or value over 64 KiB). The settings slot parses as an object containing only the declared top-level statusLine key; preserve the nested user properties. No permissions or unrelated CLI settings can be smuggled through --settings.
- Ordinary hook input/reply limits and the four-file rules do not change. Read-only source samples/ancestors are a separate bounded collection, never publication indices. Settings-only/Codex zero-output preparation uses no dummy file or relaxed ordinary hook validator.
- At most one owner-selected script output. Optional source/proof loss discards optional values and does not attach a required native hold. Recheck the optional proof at final argv use as well as after worker awaits/publication.
- publishNativeFiles currently rejects all-shared destinations. The statusline-only script owns its one actual file reservation; do not relax required hook publication or invent a generic all-shared bypass.
- Keep inline --settings precedence and the existing prepare/commit admission boundary. Send the exact protocol/publication diff for review before broad validation. Freeze and measure the added capture/IPC path after implementation.

RED before runtime edits
`engineSetup.launchSettings.spec.ts`: 3 intended failures and 7 passes, actual 1 (`/tmp/core-launch-settings-red.log`). Existing file preparation refuses both declared-value replies and the Codex zero-output candidate; no infrastructure failure. Ordinary hooks still reject zero-output input.

The captured agent-settings source also needs the current sign-in's existing non-secret account/machine/epoch identity. Its owner check must match readAgentSettings, be rechecked at final optional value use, and never pass authentication tokens to setup. Source snapshots may use the existing bounded native-file evidence; read-only files never become publication destinations.

### Protocol and publication checkpoint

The settings variant now uses the existing file preparation/commit operations with a `launchSettings` purpose bound
through commit. Its reply has exactly `instructions` and `settings` nullable string slots, each at most 64 KiB; the
settings object may contain only the engine's declared `statusLine` key. Nested user status-line properties are kept.
Codex publishes no file. Claude's one script is the ordinary owner of its own existing publication reservation, so
`publishNativeFiles` and required hook input/reply limits are unchanged. Sources are bounded read-only observations,
not output indices. Optional proof invalidation omits values and does not enter `NativeLaunch.current()`.

Protocol RED (`/tmp/core-launch-settings-red.log`): 3 intended failures and 7 passes, actual 1. Protocol GREEN
(`/tmp/core-launch-settings-protocol-green.log`): 10 passes, actual 0. Publication behavior RED
(`/tmp/core-launch-settings-publication-red2.log`): 3 failures and 3 passes, actual 1 (the preceding initial diagnostic
failed on the not-yet-created module). Publication GREEN (`/tmp/core-launch-settings-publication-green.log`): 6 passes,
actual 0. Final literal-argv composition RED (`/tmp/core-launch-settings-values-red.log`): 2 failures and 1 pass,
actual 1; GREEN (`/tmp/core-launch-settings-values-green.log`): 3 passes, actual 0.

A single five-second optional preparation/commit deadline matches existing optional trust preparation. Settings
work may occupy at most seven of the existing eight preparation and request slots, leaving admission for required
installation/hook work even when canceled optional work has not settled. Actual work keeps its slot until settlement.
Native preparation revision, selected environment object and non-secret sign-in identity must be bound in the
optional proof. Final dispatch selects that proof once for command and terminal argv, after instruction and receipt
awaits. Added capture, IPC and proof cost remains to be measured after caller migration/source freeze.

### Earlier dispatch selection (superseded by the publication correction below)

The caller audit found two later waits: registration retry after pane cleanup, and terminal backends awaiting
`onDispatch` receipt publication. Optional values cannot change identity, cwd, env, Windows handoff or held-token
facts, so the existing callback now may return only an owner-owned `() => string[]` command factory. The backend
awaits the existing publication, rechecks required owner/host/client authority, invokes that factory once, rechecks
required authority, then serializes and sends with no intervening await. Throwing refuses with `not_started`.
Literal callers still return void and keep the same command bytes. No worker supplies a command or callback.
Create already forwards this callback on each retry; restore composes it after its receipt control, and swap passes
the original accepted launch options through the same final command builder. Optional proof is checked inside that
last synchronous builder, after all dispatch waits. This narrow extension was explicitly reviewed before runtime edits.

Backend RED (`/tmp/core-launch-settings-backends-red.log`): 8 intended failures, 174 skipped, actual 1, on the real
TmuxBackend with a recording fixture executable and PtyHostBackend with a captured client frame. Initial retry RED
(`/tmp/core-launch-settings-retry-red.log`): 2 failures, actual 1, used an earlier full-launch fixture, superseded by
the approved command-only existing callback. Final dispatch checks (`/tmp/core-launch-settings-dispatch-green3.log`):
14 passed, 243 skipped, actual 0. Restart factory forwarding had 2 RED before implementation
(`/tmp/core-launch-settings-restart-red.log`). Restore forwarding's negative control (original control-only forwarding)
had 2 failures (`/tmp/core-launch-settings-restore-red.log`) before restoring the composed callback. Restore's two
production controls publish receipts and return void (`restoreAgents.ts`); host move supplies no separate control.
The final factory is invoked only once after publication, including registration retries. Typecheck
`/tmp/core-launch-settings-types4.log` found one test-only optional-command type, corrected for the next run.

### One optional preparation per final owner

Source review found that preparing values inside `buildLaunchOverrides` then re-preparing after fork's final native
environment would add two optional capture/IPC waits. The approved correction removes preparation from the base
override builder, without adding a flag or cache. Each final launch owner prepares once after its last required native
environment is selected: create after `prepareHooks` and profile synchronization; fork after its combined DSH/native
`prepareNative`; Resume after relaunch preparation and before its final argv; restart and retarget after base native
preparation and before stopping the old process; restore after the native override/permission checks and before building
the launch. Host move reuses restore's captured values through deferred preparation and fallback. Retries recheck the
same captured proof at the final command factory; they never re-request optional settings. Required hook ordering is
unchanged. The optional prepare+commit pair has one 5 s deadline per launch attempt.

The first combined Resume/restore validation under the sandbox hit the already documented registry EPERM restriction.
The authorized bounded rerun with isolated fixtures (`/tmp/core-launch-settings-resume-restore-owned.log`) passed
283/283, actual 0, 72.10 s, with zero remaining owned process-group members. The failed sandbox receipt is retained
in `/tmp/core-launch-settings-owner-checks3.log`. No installed daemon, personal home or global tmux was used.

### Final selected validation

The one-preparation regression first failed at each intended owner (5 failures, 212 skipped, actual 1,
`/tmp/core-launch-settings-once-red.log`). Final selected coverage passed 425/425 tests across 14 files, actual 0
(`/tmp/core-launch-settings-coverage2.log`): all nine changed covered runtime files have 100% statements, branches,
functions and lines. The six core files are create, fork, restart, retarget, swap and restoreLaunch; the three service
files are engineSetup, nativeSetup and nativeLaunchSettings. Coverage outputs are retained in
`/tmp/core-launch-settings-coverage2/`.

The affected helper, architecture and argv checks passed 150/150 across 11 files, actual 0
(`/tmp/core-launch-settings-affected-final.log`). The launch argv golden file was unchanged. Backend compatibility
passed 168 tests with 16 native connection cases deliberately excluded from this selected gate, actual 0
(`/tmp/core-launch-settings-backend-compat-final.log`); native gates remain the coordinator's separate validation.
The final Resume rerun passed 175/175, actual 0, 67.02 s, with zero owned process-group members left
(`/tmp/core-launch-settings-resume-final-owned.log`). Its authorized isolated process wrapper used no personal home
or installed daemon. The earlier combined Resume/restore 283/283 result above remains the restore evidence.

These changes affect macOS, Linux and Windows launch composition. Selected macOS tests cover Windows argv refusal
and literal settings behavior through existing platform seams; they are not native Windows or Linux runs. Added
capture, prepare/commit IPC and final proof selection cost is still unmeasured at this checkpoint. The approved
separate cost packet will use the frozen runtime commit and preserve full-daemon and native validation as separate
scopes. No performance improvement is claimed from the dependency inventory shrinking by one file.

Final TypeScript validation passed, actual 0, 5.995 s, with zero owned process-group members left
(`/tmp/core-launch-settings-types9.log` and `/tmp/core-launch-settings-types9-receipt.json`). The prior typecheck8
log is empty but its terminal exit was lost across context compaction, so it is retained as exit-unknown and is not
counted as a pass. No runtime source changed while typecheck9 ran.

### Generic route contract review

A mixed generic/alias regression confirms that public `setup_prepare` and `setup_commit` force installation kind and
refuse the optional settings purpose; only the file aliases accept it. With seven unsettled alias renderers, generic
settings are refused, another optional alias is busy, and required setup remains admitted. The settings service file
passes 17/17, actual 0 (`/tmp/core-launch-settings-generic-guard-green.log`). No runtime correction was necessary.
A separate negative control temporarily removed the two existing kind-forcing wrappers and failed the new generic
commit assertion (`/tmp/core-launch-settings-generic-guard-red.log`); the original runtime was restored byte-for-byte.
That result demonstrates the existing guard, not a new failing-product regression or implementation fix.

### Dispatch publication correction (approved before runtime edits)

Cost-packet source review found that the initial literal launch argv publishes a one-time POSIX script, while the
new callback publishes a second final script. The first is never executable by that dispatch. The correction keeps
one command mechanism: `TerminalCreateRequest.command` and `TerminalRespawnRequest.command` accept either literal
argv or an owner-only synchronous argv factory. `onDispatch` returns to publication-only void. Backends preserve the
existing literal snapshot, await receipt publication, recheck required authority and host identity, then invoke a
factory once, recheck and serialize/send without another await. Workers cannot supply a function or command.

Create/fork/Resume/restore/restart pass their final argv builder through that command field instead of publishing a
POSIX script before dispatch. CreateAgentPane and RestoreLaunch forward the same type; restore has no other argv
reader. Windows uses the existing pure Windows launch branch for refusal and held identity before any pane; an exact
held literal remains literal, including its token and afterExit facts. No preview flag, placeholder command or generic
suppression option is added. Required checks and cwd/env/afterExit stay where they were. Every registration retry
selects a fresh command only after its own gates. RED coverage will assert zero files on pre-dispatch refusal, one
script per dispatch, and no unused script per retry, through actual publication and terminal backend code.

The first real-IPC semantic smoke remains failed fixture evidence, with zero completed/timed samples. Its router
omitted the existing setup_probe route used during untimed NativeLaunch inspection. Receipt
`/tmp/core-launch-settings-cost-v1-smoke-outer.json`: actual 1, 6.779 s; child actual 1, both EOFs, guardian/group gone,
private home/node roots removed. No timing was performed on the superseded publication behavior.

Correction RED: 19 failures, 2 existing refusal passes, 531 skipped, actual 1, 4.332 s, no remaining owned processes
(`/tmp/core-launch-settings-lazy-red.log` and its receipt). The same focused packet passed 21/21, actual 0, 5.407 s
(`/tmp/core-launch-settings-lazy-green1.log`). Real one-time script publication is exercised through
PtyHostBackend, createAndRegisterPane and buildEngineLaunchArgv: no script before selection on refusal/cancellation,
one per executable attempt, and only the two selected scripts on a registration retry. A required-authority change
inside a synchronous builder still refuses the terminal effect at the final check.

Final coverage: 433/433 across the same 14 files, actual 0, 9.34 s; all nine covered runtime modules remain at 100%
statements/branches/functions/lines (`/tmp/core-launch-settings-lazy-coverage2.log` and coverage output folder).
Literal/factory backend, retry, external-held, architecture and launch-golden compatibility passed 293 tests, with
16 separately coordinated native connection cases excluded, actual 0, 53.64 s
(`/tmp/core-launch-settings-lazy-compat1.log`). No launch or control golden bytes were changed.

The combined Resume/restore/control-golden run had 285 passes and two old eager-argv fixture assertions fail
(`/tmp/core-launch-settings-lazy-resume-restore1.log`); restore and control golden completed successfully. After those
assertions were corrected, the full Resume file passed 177 cases and failed only a new Windows test whose global
platform seam had incorrectly selected Windows ACL checks for its real Mac fixture registry
(`/tmp/core-launch-settings-lazy-resume-final.log`, actual 1). The platform seam now covers only the pure command and
metadata turn. That single corrected case passes, actual 0, 1.862 s, with 177 unchanged cases skipped
(`/tmp/core-launch-settings-lazy-resume-held.log`); the unchanged 177 passes are reused, not represented as a new full
file actual-0 run. Every owned group in these receipts is clean. Final typecheck passes, actual 0, 6.582 s
(`/tmp/core-launch-settings-lazy-types4.log` and its receipt).

Windows tests preserve the exact held array and token, omit engine afterExit for that held command, and keep ordinary
cwd/env/afterExit unchanged. The superseded callback-return command mechanism has been removed. The next cost
packet must use this corrected runtime and explicitly exclude permission-probe runtime from its untimed native
inspection fixture; the measured optional service prepare/commit and final publication remain real production paths.


### Routed envelope correction

The v3 real-process semantic smoke exposed a product integration failure before any timed candidate sample:
`serviceLinks` adds `requestId` to every routed payload, and `runServiceProcess` passes that envelope to the handler.
The settings handler stripped its operation `kind` and `request` but validated the remaining envelope as a strict
settings DTO, rejecting the transport ID. The existing direct handler tests had omitted that metadata.

The correction strips only the documented transport `requestId`, alongside `kind` and the operation request, before
validating the settings DTO. No settings key, output, authority, timeout or admission rule changes. A regression will
join the actual native setup link, service router, serialized service-process envelope and setup handlers through an
in-memory socket, for both zero-file Codex and one-file Claude results. It also keeps unknown settings fields rejected
and generic installation handlers unable to accept settings work. RED must be collected before the runtime edit.

v2 remains failed output-framing evidence: its baseline child completed three operations and full custody, but its
outer parser did not allow the existing terminal availability log. v3 declared that exact log and one marked JSON
result without changing product logging. v3 baseline passed; candidate's first optional preparation returned null.
Outer actual 1, 11.314 s; both groups, guardians and EOFs settled and both private roots/node copies were removed.
The candidate worker was drained by the guardian after caller failure, so no successful worker shutdown receipt is
claimed. Frozen v2/v3 inputs and failed smoke receipts remain unchanged; no timed measurement ran.


Routed-envelope RED: both Claude and Codex returned null through the actual production routers, 2 failures and
17 skipped, actual 1, 0.928 s (`/tmp/core-launch-settings-transport-red.log`). After stripping only requestId at the
settings boundary, those same two cases pass, actual 0, 0.908 s (`/tmp/core-launch-settings-transport-green.log`).
All three affected engineSetup suites pass 49/49, actual 0, 1.684 s; engineSetup.ts remains 100% statements
(171), branches (196), functions (35) and lines (104), including the unknown-field and generic reservation controls
(`/tmp/core-launch-settings-transport-coverage-run.log`, `/tmp/core-launch-settings-transport-coverage/`). Final types
pass, actual 0, 7.243 s (`/tmp/core-launch-settings-transport-types.log`). Every command has a persisted receipt
with actual exit and no remaining owned-group members. No new semantic smoke or timing has run on this correction.


### Corrected real-process semantic validation

The v4 packet freezes baseline 9a2ae217cf and corrected candidate b8ef4c2dd0 across 791 source/tool/fixture inputs
and all eight declared ABBA arms: manifest SHA256
`f4346e8bbf7a5978d4e1799e3dba862a4dc3e056a7587d4c0af8437cc37422cb`.
Its single semantic smoke passes, outer actual 0, 12.115 s
(`/tmp/core-launch-settings-cost-v4-smoke/manifest.json`, `/tmp/core-launch-settings-cost-v4-smoke-outer-receipt.json`).
Both arms complete three operations with identical normalized final command, terminal frame and one-time script,
and identical statusline bytes (`2c99b4365b491f013195f59f960c525128001322f973344d36dc510a80a7fb23`). Both leave
zero unused launch scripts; the candidate invokes exactly three final factories. Both setup workers, environment
capture children and sample processes exit 0 with close/stdout EOF/stderr EOF receipts; groups and guardians settle,
both sockets and private roots/node copies are removed, and all frozen hashes are checked again. This is functional
validation only; smoke latency is not performance acceptance. Permission-probe runtime and cold service startup stay
outside this packet; optional settings preparation/commit crosses the actual worker socket and uses real indexed
publication. Earlier failed packets remain unchanged.


### Frozen v4 cost result — acceptance held

The approved unchanged two-cycle ABBA completed once, outer actual 0, 53.024 s. Each of the eight children completed
one first publication, five warmups and fifty measured sequential operations. All 448 final command/frame/script
checks match, no unused launch script remains, and candidate factories ran exactly 56 times per child. Every sample,
worker and capture child exited 0 with close and both EOF receipts. All 32 recorded sample/guardian/worker/capture
PIDs, eight sample groups and sockets, and sixteen private home/Node roots were independently checked gone. The outer
group is empty; every arm rechecked frozen input hashes. Results: `/tmp/core-launch-settings-cost-v4-abba/manifest.json`;
outer receipt: `/tmp/core-launch-settings-cost-v4-abba-outer-receipt.json`; complete arm/range/paired summary:
`/tmp/core-launch-settings-cost-v4-summary.json`. No samples were dropped or retried.

| Arm | First publication ms | Warm p50 ms | Warm p95 ms | Core CPU ms/op | Worker CPU ms/op | Combined CPU ms/op |
|---|---:|---:|---:|---:|---:|---:|
| 0-A | 3.856 | 0.851 | 1.205 | 0.983 | 0.263 | 1.247 |
| 1-B | 105.688 | 41.147 | 60.023 | 24.322 | 1.101 | 25.423 |
| 2-B | 103.298 | 40.679 | 61.407 | 24.219 | 1.108 | 25.328 |
| 3-A | 3.855 | 0.840 | 0.963 | 0.941 | 0.237 | 1.177 |
| 4-A | 3.852 | 0.884 | 1.056 | 0.990 | 0.240 | 1.230 |
| 5-B | 110.376 | 41.084 | 88.396 | 23.783 | 1.107 | 24.890 |
| 6-B | 115.285 | 41.883 | 78.859 | 24.030 | 1.125 | 25.155 |
| 7-A | 3.843 | 0.881 | 1.010 | 0.980 | 0.242 | 1.222 |

Mean arm p50 increased from 0.864 to 41.198 ms; p95 from 1.058 to 72.171 ms. Core CPU increased from 0.973 to
24.089 ms/op and combined core/worker CPU from 1.219 to 25.199 ms/op. All four paired deltas have the same direction.
Mean post-batch core RSS increased by 16.235 MiB and worker RSS by 4.369 MiB. Retained core heap growth during the
fifty-operation batch is similar (0.181 versus 0.177 MiB); worker retained growth changes from -0.015 to 0.104 MiB.
These are this fixture's process measurements, not whole-daemon memory. Common semantic checks are included in both
latencies; worker CPU includes its ending GC snapshot. First publication is separate and excludes cold worker startup.

This material regression is not accepted. The next reviewed diagnostic separates an untouched-source CPU profile
from exact proof/Node filesystem API-call counters on an instrumented copy, with the same workload and semantics.
No runtime optimization or cache is justified by static suspicion alone; final owner authority, source freshness and
indexed output proof must remain intact. The old caller-v3 results remain limited to their caller-only scope, and
this packet still excludes slice1's extra model-preflight capture and full daemon/native launch cost.


### Read an existing optional artifact without republishing it

The fixed two-child diagnostic completed actual 0, 17.518 s, with all 56 operations and v4 semantics in each role,
zero unused scripts, and all owned processes/groups/sockets/private roots removed. Frozen input SHA256 is
`37b48692ce66fe0198e4866b914c66854021f078fae6390e115b53a1a92cf16d`; CPU profile SHA256 is
`a96d40d6cbc551bcb7379d6ab089240a51b9cbacd7a39690768328fd8fb03862`. The untouched-source CPU role spends
40.460 of 42.039 ms/op in optional preparation. The separate counting copy observes 4,091 lstatSync, 67 native
current/optionalCurrent, 66 source verify, 286 file verify and seven fsync calls per warm preparation. These are exact
named Node API calls, not a one-to-one claim about kernel syscalls. Repeated path walks dominate sampled active CPU;
unchanged optional scripts unnecessarily enter the required-hook durable flush path.

Approved narrow correction: after actual worker prepare/commit and source/owner validation, an already captured
owner-selected output whose bytes equal the fully validated candidate is read, verified and retained through its
real output.verify closure. No publication, flush, reservation or durability-success claim is made for this branch.
It does not convert an uncertain publisher transaction into durable success, and it does not fabricate a
HookPreparationProof. An existing optional artifact is usable while its captured file and route remain current, as
an existing selected executable is; if it is missing on a later preparation, it is recreated normally.

Absent or different output bytes still use the unchanged indexed publisher and durability path. Required native
hooks and their unchanged-file flush rationale are untouched. There is no success cache or new core record. Final
argv selection still checks the captured owner/revision/account, every source file/ancestor, and the exact output
file/route. A same-byte replacement during the worker wait must invalidate the captured output and omit values.

RED coverage will use real files and Node fsync/write wrappers: first publication followed by an unchanged launch
performs no additional write or flush; a pre-existing read-only identical script also needs no publication; same-byte
replacement while setup answers is refused; source/output/ancestor/owner changes invalidate final literal arguments;
missing and different output are recreated/published through the existing path. No generic proof algorithm changes.
Cold-path duplicate checks remain held for separate review after this narrowly measured correction.


Read-existing RED: three intended failures, seven safety passes and nine skipped, actual 1, 2.270 s
(`/tmp/core-launch-settings-existing-red.log`). The unchanged and read-only fixtures each performed nine unwanted
flushes at their test-directory depth; same-byte replacement during the worker wait was incorrectly accepted.
The same ten selected cases pass after the correction, actual 0, 1.341 s
(`/tmp/core-launch-settings-existing-green.log`). Complete affected settings/value/native-owner/renderer checks pass
34/34 across four files, actual 0, 2.246 s (`/tmp/core-launch-settings-existing-affected.log`). Types pass, actual 0,
38.195 s (`/tmp/core-launch-settings-existing-types.log`). Every command has an actual-exit receipt and an empty
owned process group. No required hook implementation or caller changes were made. Corrected-source cost remains
unmeasured until a fresh matched packet is frozen and reviewed.


### Frozen v5 result: warm improvement, cost acceptance still held

The matched packet retains baseline 9a2ae217cf and changes only candidate source to e4739a1ed7. Its workload,
fixture, worker and custody helpers are byte-identical to v4; frozen manifest SHA256 is
`33febf07c8b7becf60b5639cea06537ee8bd33c86bcc1ae71d2dcace73249353` (791 inputs, all eight arms).
The one semantic smoke passes, outer actual 0, 12.131 s. The approved unchanged two-cycle ABBA completes once,
outer actual 0, 44.003 s. No sample was dropped or retried. Each arm again completes first publication, five warmups
and fifty measured operations; all 448 normalized command/frame/script checks match. No unused script remains,
and candidate factories run exactly 56 times per child. Sample/worker/capture actual exits and both EOFs are recorded;
all 32 PIDs, eight groups and sockets, sixteen private roots, and the outer group are independently checked clear.
Every arm rechecks the frozen hashes. Full receipts and all raw arms remain at
`/tmp/core-launch-settings-cost-v5-abba/manifest.json`; outer receipt is
`/tmp/core-launch-settings-cost-v5-abba-outer-receipt.json`. The unchanged v4 summarizer produces
`/tmp/core-launch-settings-cost-v5-summary.json`, including every arm, range and all four paired deltas.

| Arm | First publication ms | Warm p50 ms | Warm p95 ms | Core CPU ms/op | Worker CPU ms/op | Combined CPU ms/op |
|---|---:|---:|---:|---:|---:|---:|
| 0-A | 3.914 | 0.835 | 0.967 | 0.941 | 0.236 | 1.177 |
| 1-B | 104.502 | 5.482 | 6.891 | 6.043 | 0.959 | 7.003 |
| 2-B | 105.756 | 5.378 | 7.341 | 5.749 | 0.993 | 6.742 |
| 3-A | 3.954 | 0.854 | 0.985 | 0.951 | 0.240 | 1.191 |
| 4-A | 3.854 | 0.853 | 0.978 | 0.953 | 0.238 | 1.191 |
| 5-B | 126.325 | 5.340 | 6.835 | 5.613 | 0.992 | 6.605 |
| 6-B | 111.972 | 5.732 | 6.845 | 5.837 | 1.008 | 6.845 |
| 7-A | 3.992 | 0.919 | 1.456 | 1.040 | 0.242 | 1.282 |

Mean warm p50 is 0.865 versus 5.483 ms, p95 1.096 versus 6.978 ms, core CPU 0.971 versus 5.811 ms/op,
and combined CPU 1.210 versus 6.799 ms/op. Candidate warm latency and CPU improve substantially from v4, but
remain above the unchanged baseline in every pair. First publication remains 3.929 versus 112.139 ms; its
mean core CPU is 4.244 versus 61.368 ms. Post-batch core RSS differs by 8.271 MiB and worker RSS by 4.195 MiB;
core retained heap growth is 0.179 versus 0.212 MiB and worker growth -0.015 versus 0.104 MiB.

This accepts the read-existing correction as a scoped warm improvement, not the extraction's cost. Cold publication
and overall cost acceptance remain held. The same workload exclusions and process-memory scope as v4 apply.
Existing diagnostics already counted the unchanged first-publication path: 83 native-current calls, 82 source
verifications, 5,296 lstatSync calls and seven fsync calls in optional preparation. The next source proposal separates
owner/revision admission from full file freshness at effects, acknowledgement and final dispatch; no cache or generic
required-hook algorithm change is proposed, and no additional cold profile is needed before that review.


### Separate optional admission from fresh file evidence

Approved next correction, with RED before runtime changes: only nativeLaunch.ts and nativeLaunchSettings.ts change.
The helper receives the unchanged NativeLaunch.current separately as nativeCurrent. Its current callback retains
valid/not-preparing state, the exact captured preparation revision and environment object, original caller owner,
and freshly read account/sign-in identity. Resume's original owner still verifies its transcript; this admission is
cheaper, not universally filesystem-free. An initial nativeCurrent check precedes optional source capture. Full
verification is owner admission, native proof, every captured source proof, then owner admission again.

First commit: the cold publisher receives admission as current and full verification as verify. The existing hook
publisher, flush implementation, deadlines, required hooks and output proof remain unchanged. Full attempt.verify
still fences directory creation, publication, post-staging/pre-rename, every existing rename retry, post-directory
durability, both sides of proof capture and acknowledgement. A file changing while an owned descriptor flushes may
finish that harmless flush; it cannot authorize the next rename or a successful optional result. A post-rename
change may leave the optional artifact but cannot acknowledge stale values. Final PreparedLaunchSettings.current
still verifies native/source/output and owner proof; the final command factory and backend checks are unchanged.

Separate second commit: optional worker prepare/commit receives admission, since it only returns bounded declarative
candidates and writes no owner files. Complete file verification remains after capture and after the full awaited
worker result, before any publication/returned values, and at final argv. Source/native changes between prepare and
commit discard the candidate before effects. Owner/revision/account changes still send allowed=false. No link,
protocol, reservation, timeout, required native proof, cache or generic publication algorithm changes.

Selected acceptance checks: real NativeLaunch composition with counted native/source-leaf operations; real staged
and directory fsync callbacks mutating source, native executable, retained dependency, ancestor, owner and account;
initial native refusal before capture; full proof after a receipt wait; real routed prepare/commit mutation cases;
existing same-byte/read-only/missing/changed outputs and A→B→A revision tests. Each source change gets its selected
RED/GREEN and affected types; cold and warm commits stay separate. One matched benchmark follows final source review.

Cold RED: 1 intended failure and 17 safety passes, actual 1, 2.354 s. The unchanged implementation performs 91
selected-native proof calls in the fixed real-file test, above the bound of 32
(`/tmp/core-launch-settings-fences-cold-red.log`). After the two-file admission/full-proof split, all 39 cases in the
three selected settings suites pass, actual 0, 3.032 s. The seven affected launch/native-file/publication/value suites
pass 176/176 with coverage, actual 0, 10.182 s (`/tmp/core-launch-settings-fences-cold-coverage.log`).
nativeLaunch.ts coverage is 94% statements, 92% branches, 88.88% functions, 96.99% lines;
nativeLaunchSettings.ts is 93.75% statements, 85.29% branches, 100% functions and lines. These are scoped engine-suite
measurements, not a claim of complete coverage. Initial types found an inferred literal-true type in the new test
fixture (actual 2); after its explicit boolean annotation, final types pass actual 0, 6.413 s
(`/tmp/core-launch-settings-fences-cold-types2.log`). All actual-exit receipts show empty owned process groups.
Warm transport admission has not changed in this commit; no new cost measurement has run.
