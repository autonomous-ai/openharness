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
