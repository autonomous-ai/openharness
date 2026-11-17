# Engine setup files: bounded preparation boundary

Status: narrow first slice approved by the parent coordinator; no runtime changes yet. Base:
`eecac6575464119147cf140cdb177cf8a63eccec`. This continues package 8 of
[the core plan](2026-11-15-core-plan.md), after
[installation and probe isolation](2026-11-15-engine-setup-process.md).

## Current boundary

Hook admission, exact session/process binding, delegated-session refusal, transcript correction, hook
authentication, hook route publication and turn closing are core authority. They must work while setup
is off, disconnected, slow or dead. Hook/plugin installation, native configuration parsing, vendor hook
templates, hook review hashing and automatic folder trust are launch preparation, not hook admission.

The default core still imports the latter through four edges:

| Edge | Implementations reached | Caller behavior |
|---|---|---|
| `engines/hooks.ts` imports `kit/hookSettings.ts` | JSON hook merge, Codex TOML review, Messages script and command rules | The same composed object exposes mandatory admission and optional installation. |
| `core/engines/hooks.ts` imports `engines/nativeHooks.ts` | All native JSON/YAML hooks and plugin templates | Boot refresh and home adoption; OpenCode before spawn. |
| `engines/nativeLaunch.ts` imports both of those | The selected engine's installation | Before create/relaunch, under the current launch owner, with retained file proofs. |
| `engines/launchPrep.ts` imports `kit/folderTrust.ts` and `kit/inheritedMcp.ts` | JSON/TOML trust and ancestor MCP parsing/writes | Create, project preparation, worktree inheritance and Store materialization. |

`core/main.ts` also imports `hermesRecordSeen` from `nativeHooks.ts`; this maintenance notification
alone keeps the whole native installer module in core. It must become a setup notification while the
small record observation remains authoritative in its current owner.

Vendor `contract.ts` files also mix mandatory session/launch metadata with optional plugin source:
Pi's session header sits beside `PI_EXTENSION`; OpenCode version/control data sits beside both
OpenCode plugin templates. These optional declarations need separate worker-only files. Removing
`nativeHooks.ts` alone would leave their complete source strings in the default core closure.

Selected implementation sizes at the base, counted directly from these files (not exclusive closure):

| Files | Lines |
|---|---:|
| `hookSettings`, `hookReview`, `nativeHookSettings`, `nativeHookYaml`, `nativePlugin` | 1,166 |
| `messagesHook`, `notifyHooks`, `nativeHookHomes`, `nativeHooks` | 709 |
| `folderTrust`, `inheritedMcp` | 217 |
| Generic `nativeHookFiles` publication/proof primitive | 459 |
| Mixed `hooks`, `launchPrep`, `nativeLaunch` composition | 382 |

An independent measurement on the clean base confirms default closure 539 files / 90,847 lines, and
opened engine doors 652 / 107,819. Cutting `nativeHooks.ts` and `hookSettings.ts` alone removes 15 exclusive
files / 2,210 lines before adding the boundary code or extracting embedded templates. The shared publication
primitive is also used by non-hook native configuration, so removing an installer import does not imply
that all of its file machinery leaves core.

## Existing safety that must survive

`nativeHookFiles` limits a file to 1 MiB, resolves bounded native paths, verifies owner/type/mode and
leaf identity, preserves symlinks, holds reservations until actual I/O settles, bounds pending jobs and
flushes, checks the current owner after every wait, and keeps file proofs through final pane dispatch.
The immutable preparation identity includes the port, selected executable, command and complete
destination set. Required Codex hooks and their review destination are inspected before publication.

This is stronger revocation than the installation worker's commit. An executable installer already
authorized to start may finish after cancellation; its former launch still cannot spawn. A hook writer
finishing after cancellation can instead overwrite the successor daemon's port or approve stale hook
bytes. The existing installer commit cannot authorize worker writes to final hook/trust destinations.

There are also gaps that cannot be moved unchanged:

- `folderTrust` uses unbounded synchronous reads and a predictable temporary name, with no native
  version fence or current-owner callback. Its callers contain the authority to trust an empty folder
  or inherit an already trusted source; an asynchronous call must retain that evidence across the wait.
- `launchPrep.record` also scans ancestor MCP files and writes project settings. Moving only the
  obvious trust file would leave these reads/writes in core and omit dependencies from the proof.
- Messages `hook.mjs` and Codex `harness.rules` use their own unguarded writes after the required
  settings writes. They must enter the same bounded publication protocol or remain explicitly out of
  the first slice; their current behavior is not a safe worker commit contract.
- Atomic rename is atomic publication of one file, not a portable compare-and-swap against an unrelated
  native editor. Current metadata checks catch changes observed before publication; they cannot exclude
  another process writing between the final check and rename. Process-local reservations do not solve
  that external-writer race. No implementation or test may claim stronger isolation than it provides.

## Approved smallest split

Keep one generic core publisher; move vendor preparation into the existing `engineSetup` process.
Do not create a new process, a worker-to-core filesystem RPC interpreter, a general transaction manager,
or per-engine state machines in core.

1. Separate the mandatory `EngineHooks` lookup from installation composition. Its imports retain only
   admission/transcript/turn rules. Startup and launch use an explicit setup capability; no missing or
   failed setup capability calls an inline installer implicitly. Split optional plugin templates and
   installation declarations out of mixed vendor contracts so importing session identity does not
   import plugin implementation bytes.
2. Reuse setup's bounded prepare/commit lifetime. Add distinct private file preparation operations
   with a versioned candidate while preserving existing installation requests. Core captures the engine,
   explicit locations, current port/executable identity, owner and exact allowed destination manifest.
   The worker cannot select a different profile or destination from a late ambient environment.
3. Core captures bounded native input under its existing path/owner/version discipline. The worker
   parses those immutable inputs and builds vendor-specific replacement bytes. It does not read,
   rename, unlink, chmod or create final native configuration destinations. The result contains only
   indexed candidate bytes; original source facts/versions remain in core.
4. Core validates the complete manifest and native dependencies, retains the launch owner, and
   publishes only through the existing generic current-owner/version-fenced primitive. Staging and
   parsing failures cause no final mutation. Worker death revokes unaccepted candidates. After
   acceptance, the core's own owner and destination fences govern each effect, including retries.
   A worker success boolean is never a file proof or permission to spawn.
5. Keep credential creation, authentication and hook server publication in core. The worker receives
   only the paths/port already embedded in hook commands, never the hook credential bytes. It gets no
   terminal writer, registry or account credential. Existing private service authentication applies.

Approved first slice: return bounded output bytes and retain existing core staging/publication. There
is no worker-owned artifact adoption and no worker write to a final native file. Core captures the
native inputs under its existing reservation, the worker parses and renders a candidate, then core
checks its owner and original native evidence before publication. This removes vendor parsing and
templates; it does **not** finish blocking I/O isolation. Moving bounded capture/staging I/O is later
work and cannot be claimed complete by this slice.

At most four destinations belong to a preparation: Codex's hooks, reviews, rules and the shared Messages
script are the largest set; OpenCode and one Hermes home each need two. Hermes home maintenance stays
one pair per preparation. Keep the existing 1 MiB per-file ceiling, add a 2 MiB aggregate UTF-8 candidate
ceiling and a 4 MiB full serialized reply ceiling, including protocol metadata. The measured Hermes
configuration documented in `nativeHookYaml.ts` is 134 KB; 2 MiB gives that real configuration over 10×
headroom. The checked-in golden corpora contain maximum UTF-8 strings of 5,558 bytes (Claude/Codex hook installers), 11,155 bytes (other hooks) and 3,871 bytes (native-version selection), measured without regenerating them. Reuse the existing
eight admissions and deadline; do not add a second core queue or timer. An oversize candidate leaves
the original files intact and names the held preparation.

The wire reserves 4,096 bytes within the serialized ceiling for the service envelope and request
metadata. Input metadata is checked before dispatch too: only the existing launch-location variable
allowlist, 65,536 UTF-8 bytes of environment, typed optional flags, and one declared auxiliary directory.
No worker may add a path or an output field to an indexed candidate.

Messages' `hook.mjs` is one shared artifact across profiles. Including it in every profile's exclusive
destination set would make unrelated healthy launches revoke each other. Publish that artifact through
the **existing** `runHookPreparation`, keyed by its exact candidate bytes, and retain its exact file proof.
Then publish the profile's own files under their existing reservation. Check the original caller/owner
before and after both awaits; sharing artifact work grants no authority over another profile and cannot
restore a cancelled caller. An incomplete shared publication supplies no launch proof. This adds no
queue or reservation family. The parent approved this amendment before core wiring.
Profile joins include the complete captured preparation input alongside any caller identity: an explicit
identity cannot erase differences in `createMissing`, auxiliary directories, port or environment. The
Hermes startup/launch regression first returned success for both differing requests; the corrected key
refuses that overlap and lets a fresh authorized preparation proceed.

The authenticated service transport accepts at most
6 MiB + 4,096 bytes (`localWsServer.ts`, `lib/terminalBinary.ts`), while ordinary clients retain their
512 KiB limit. Bound both aggregate output and serialized reply size below that ceiling; JSON escaping
can expand text. A 32-file × 1 MiB reply cannot fit. Do not enlarge the shared transport for this feature.

Folder trust remains explicitly the next slice of package 8, not part of this implementation. It follows
the same publisher but is a separate behavior change: it becomes
asynchronous, carries source-trust and workspace identity/emptiness evidence, bounds ancestor reads,
and includes inherited MCP dependencies. Only core can decide that a workspace qualifies. An unavailable
worker leaves trust unrecorded, with a named diagnostic and the engine's ordinary trust question; it must
never answer an unknown workspace question on the worker's assertion.

## Design checklist

- Growth: reuse eight setup admissions and thirty-second preparation expiry. Bound files and aggregate
  bytes before allocation. Accepted/expired/disconnected candidates are removed; actual outstanding I/O
  continues to own its slot. No new persistent journal or successful-result cache.
- Concurrency: retain canonical destination reservations and every caller's alias facts through actual
  completion. Reject changed source or destination versions. Do not retry a stale whole-file edit over
  a newer external version. External writers do not honor Harness locks; the final check/rename race
  remains an explicit design limit, not solved by worker isolation.
- Read cost: bounded selected files only; no polling or home scans added. Hermes's existing home discovery
  must be bounded and moved with the preparation it serves.
- Scale: cap concurrent preparation, file bytes, ancestor/path depth and actual outstanding flushes.
  Existing named busy/held outcomes report exhaustion without content, paths or account identifiers in
  metrics. Compare default-core loaded files, memory and owner/terminal responsiveness on the same workload.
- Compatibility: distinct private `setup_files_prepare` / `setup_files_commit` operations share the
  existing preparation map, deadline and actual-settlement admission. Merely adding `kind: files` to the
  old installation operation was unsafe: the red-first service test showed the old handler ignored it
  and entered executable installation. A capability preflight would still race worker replacement.
  Unknown operation names are safely refused by an old worker, including replacement between calls;
  the original installation requests remain unchanged. New core with an old setup worker gets a
  held/unavailable preparation, never implicit inline fallback. Preserve the
  existing explicit old-master/debug composition through its documented 2026-12-15 date. Backend/public
  client contracts do not change; clients from the prior thirty days retain the same launch hold outcomes.
- Migration/rollback: no native file schema migration, no new durable state. Generated bytes and file modes
  stay compatible with older releases. Abandoned staging artifacts cannot become authority on restart.
- Audience/identity: only authenticated local owner calls without a client connection reach setup. Core
  selects the executable, profile and destination; callbacks retain the original launch's owner. No work
  runs under another account and the worker holds no account credential.
- Failure: worker errors, malformed replies, busy/timeout, disconnect, changed source/alias or stale owner
  hold required preparation visibly. Optional startup maintenance reports its failure and cannot stop
  existing sessions. Multi-file hooks/review cannot be atomically renamed together: an incomplete pair
  must never produce a launch proof. Do not roll back over a newer external writer. This is fail-closed
  launch authority, not a claim of a multi-file filesystem transaction.
- Platforms: macOS/Linux/Windows; keep existing symlink/mode semantics and Windows rename retry checks.
  No new subprocess launcher is needed. Windows file identities and ctime behavior require native evidence,
  not tests that only substitute `process.platform`.

## Review and proof before implementation

The parent approved bounded byte transfer and the honest external-writer/multi-file limits before
runtime changes. Preserve existing fixture
coverage for JSON/TOML/YAML, custom homes, foreign hooks, review hashes and optional Messages/rules.
Add red-first tests for stale owner, worker death/reconnect, oversized/malformed proposal, path/alias/
destination substitution, changed input, unavailable setup and old protocol. Exercise actual process
isolation after focused tests. Parent owns full coverage gates, independent review, same-workload
performance comparison, final closure measurement, push, PR and merge.

## Implementation evidence and limits

Default source closure is 530 files / 88,397 lines, versus integrated parent
`8a8ea5f037ac33eecf496438862fdaaec7c72a72` at 539 / 90,914.
The same walk with legacy engine doors open (still excluding services/inline) is 674 / 108,486,
versus that parent's 652 / 107,886; its growth includes both retained explicit legacy installation and the new
boundary. The default core retains only small argument quoting, hook-script identity/refusal state,
mandatory admission data, destination coordination and the generic publisher. Architecture assertions
reject mixed hook contracts and vendor parser/template imports from default core.

Red-first checks exposed the old-operation executable-install skew, null metadata throwing, loss of
missing-script diagnosis, and a null shared artifact incorrectly counting as complete publication.
Focused checks cover worker replacement/operation mismatch, owner/input/alias changes, exact shared
artifact joining and proof invalidation, partial publication without stale rollback, wire byte limits,
and all thirteen native hook families. Historical byte/mode/foreign-content goldens stay on explicit
legacy installer composition; native-version goldens and the thirteen-family integration exercise
the new preparation/publication boundary without regenerating golden data.

This is an integration checkpoint, not a full-gate, runtime-isolation, performance or signed Windows
acceptance claim. Those checks and independent review belong to the final parent source. Folder trust,
inherited MCP and remaining core filesystem I/O remain separate unfinished work.


## Native acceptance amendments (2026-11-16)

The first real bundled process run failed seven of eight cases (the explicit inline case passed).
It exposed a packaging error: the extracted lean service entry has no `notify.mjs` beside it, and
unlike core it did not know the original CLI. Reuse the master-owned `HARNESSD_CORE_SCRIPT` field
(`LEAN_CORE_SCRIPT_ENV`) for lean service children, only while they run the master's verified lean
bundle. Consume and remove it in `leanEntry` before importing service code and change only argv[1];
keep the service command/name tail. This extends the existing original-CLI identity protocol, adds
no filesystem RPC, lookup fallback or worker-selected path, and leaves old masters without the field
on their existing behavior. Current-build/CLI fallback children receive no lean identity. A rollback
keeps existing native bytes and no durable migration; older service entries safely ignore the extra
private metadata, which existing harnessd environment holding removes. Focused entry/master tests
and the actual bundled worker must prove helper resolution and unchanged role dispatch.

Independent review also found startup launched all thirteen families into the existing eight setup
slots at once. Five could get `SETUP_BUSY` during a cold import and never refresh. Sequence the
existing bounded startup pass, preserve each family's own failure handling, and keep the controller
immediate: neither readiness nor unrelated launches wait for maintenance. Shutdown revokes the current
attempt and prevents later ones; no new queue, admission family, capacity increase or retry loop.
A caller regression uses the real bounded setup link with rendering held, then released, and requires
all thirteen selected families to succeed. Adopted-home coordination retains its existing independent
bounded mechanism. The on-demand installation fixture explicitly disables startup hooks; file tests
keep them enabled and prove actual setup-files routing. No failed native attempt is treated as passing.

Remove the unused predictable-temp `writeMessagesHook` implementation with this extraction; its only
remaining caller was a test fixture. Runtime publication already uses the fenced generic publisher.
The Messages execution fixture writes the unchanged source directly and retains behavior coverage.

The historical startup golden changed only the independent login-shell home's interleaving with the
sequential default pass. Keep the checked-in golden bytes unchanged and compare each dispatch stream's
order and exact arguments separately. Native settings/template byte goldens remain exact. The bundled
closure assertion now requires Amp's plugin template outside default core, while still present in the
complete bundle for setup and explicit compatibility composition.

The second bundled run passed six of eight cases, including real file-operation kill/freeze/malformed
isolation and native bytes. The off fixture raced the worker's reconnect after releasing its hold; its
recovery now waits for both the replacement PID and the observed connection. An existing cold-launch
case also hit conflicting startup preparation. A separate focused red established that reversed
property ordering alone made identical environment records conflict; order is canonicalized before
forming the complete input. Keys/values, opaque caller identity, flags and arrays remain intact. This
ordering correction is not, by itself, proof of the cold-launch failure's cause or its resolution.

## Cold launch reservation handoff (approved before runtime edit)

The deterministic caller regression runs actual `installEngineHooks` maintenance against actual
`NativeLaunch.prepareHooks` with different captured locations and held rendering. Both were refused:
revoking startup did not wait for its actual release. The diagnostic native rerun passing does not
resolve this regression. Preserve each input's meaning; absent shell locations are never filled from
startup defaults and different snapshots never join.

Only actual NativeLaunch preparation enables bounded conflict settlement. Reuse the existing pending
reservation's actual-settlement promise and sixteen-waiter limit, revoke obsolete work, and wait once
within the original overall five-second budget. A timed-out reply is not settlement and cannot release
its descriptor or reservation. Retain the original caller/owner and path-route evidence through that
wait, then recapture file contents for one fresh reservation. If another writer won, return held; there
is no retry loop or additional queue. Legacy/direct installer conflict behavior stays unchanged.
Maintenance, including adopted homes, uses existing `retainConflicts`: a conflicting attempt cannot
revoke a live launch or wait behind it as a deferred publisher. Existing adopted-home retry scheduling
remains independent; this change adds no delayed maintenance work. Equal complete inputs retain the existing join with each original
caller's checks. Caller cancellation, changed aliases, deadline expiry and occupied waiters remain held.

The native fault fixture uses a second fixture-owned client for the held create, leaving the original
turn and terminal on their own connection. For a frozen worker, both must finish while create is still
pending. This distinguishes core isolation from existing per-connection request serialization. The off
case waits for actual reconnection as well as replacement PID. All process operations remain confined
to the fixture-owned service and disposable daemon homes.


At the next frozen checkpoint, the deterministic cold caller regression and the five original settlement
reds pass. The focused launch/startup/attempt batch passed 138 tests; the final affected publisher/files/
startup-golden batch passed 71 tests in five files, including inverse overlap and shared total-deadline
checks. TypeScript passed. Earlier unchanged entry/master checks passed four/two focused cases, and
architecture passed 25. The corrected off native case passed; its accompanying cold rerun remains
explicitly diagnostic. Final bundled acceptance of the new handoff and second-client pending assertion,
full gates and performance evidence remain for the integrated checkpoint. No signed Windows claim.


Review of the frozen handoff found that releasing a waiter's slot at its reply deadline left the
callback on hung actual work uncharged. Keep that same existing slot until the underlying promise
settles: actual I/O for conflict handoff, or the original bounded reply for a same-input join. A caller's
shorter deadline ends only its reply. One settlement continuation releases the slot, so repeated expired
requests cannot accumulate callbacks beyond the existing sixteen-waiter bound. Capacity recovers when
that underlying promise settles. This changes neither publication authority nor the overall deadline.

The two retention regressions failed with the seventeenth request reaching its own deadline instead
of being admission-held. After charging callbacks through settlement, the affected attempts/publication/
cold-caller batch passed 47 tests in three files and TypeScript passed. Final native/full/performance
acceptance remains open on the corrected frozen source.

## Remaining maintenance admission corrections (approved before runtime edit)

The integrated `8d26b8c7404d4eb138f5701e7604023e773e94f3` bundle passed all eight native
cases, including the second-client off/freeze pending checks. Its CLI SHA-256 was
`4eba247bdee260fdaea112b9e7e6ad1d5bed6913d920f47daa2825ca79519d6f`; the result is scoped
to that source. Root's official gates were interrupted after two independent review findings and are
incomplete, not passing evidence.

OpenCode has an existing coordinator above generic disk publication. Honor maintenance's
`retainConflicts` before changing an occupied group's current installation, users or version probe.
A competing optional refresh returns false immediately; it neither cancels a captured native launch
nor waits behind it to publish older-version bytes. The actual startup-versus-NativeLaunch inverse
overlap test first failed with the launch refused. No snapshot/default/identity semantics change.

The adopted-home controller also had its own fan-out: eight saved homes occupied every setup slot and
three default families were skipped in the bounded-link caller red. Drain at most one asynchronous
home through its existing installs/inFlight/failures maps. Completion immediately advances to the next
eligible home; failed entries retain their visible reason and retry eligibility in that same failure
map until the existing retry tick. A failed home cannot spin or block later homes. No new queue or
capacity increase, no default-family retry loop, and no catalog read unless restoration is needed.
Closing revokes current ownership and prevents later homes starting. All native/full acceptance after
these corrections remains source-scoped and must be selected again by the parent.

Both new caller regressions are green. The maintenance/startup/adoption/version-golden batch passed
92 tests in five files; the unchanged legacy OpenCode preparation/overlap checks passed 46 tests;
TypeScript passed. Failure fairness retains its named reason through recovery, retries after the
existing backoff, and shutdown while one home is held starts no queued home. The next checkpoint
changes only these two reviewed maintenance paths and their evidence, not the native fault fixture.

## Captured Claude transcript location correction (approved before runtime edit)

The exact-461 core gate exposed stale test composition: refusal tests mocked the former mixed
notify module instead of the consumed hookScript leaf, and the explicitly local NativeLaunch fixture
provided executable probes but no bounded file renderer. Correct all three stale refusal mocks and
compose the existing real renderer explicitly in that fixture. Production unavailable-worker behavior
stays held, and dispatch/owner assertions and checked-in golden bytes remain unchanged. The four core
failures reproduced first; after these test-only corrections they pass.

The expanded fixture consumers then exposed a separate runtime regression. Passing Claude's captured
default settings home through the new boundary synthesized CLAUDE_CONFIG_DIR, changing a separately
captured CLAUDE_PROJECTS_DIR to the default projects folder. Preserve the captured absent or empty
CLAUDE_CONFIG_DIR when the selected home equals its captured settings home; only a different explicit
home overrides it. Other engines, explicit profile authority, candidate bounds, complete-input join
identity and publication checks remain unchanged. The original archive assertion fails for both absent
and empty config values; the explicit-profile counterpart already passes. This changes no wire schema,
durable data, capacity, lock, audience or retry behavior, and rollback needs no migration. It applies to
all platforms' native launch preparation; focused evidence is macOS on pinned Node 24.22.2. Native and
full-gate evidence is retained only for the source it previously covered.

The affected launch/refusal/fixture and hook-publication caller batch passes 235 tests in ten files,
including both archive regressions, explicit profile routing and startup/launch overlap; TypeScript
passes. Golden files are unchanged. The only remaining notifyHooks mock intentionally exercises the
legacy installers' re-export; the Windows real-engine fixture is opt-in and was not run on macOS.
The earlier four-failure core gate and intermediate 213-pass/one-failure batch remain failed evidence,
not passing receipts. Full gates, native acceptance selection and performance remain parent-owned.

## Worker boundary coverage acceptance

The exact-491 core run passed all 4,690 tests but failed its per-file coverage gate in engineSetup,
hookCandidates, nativeSetup and nativeSetupFiles; it is not a passing core receipt. The isolated
seven-file service run reproduced those gaps with 33 tests passing. Existing all-family checks outside
the core suite did not cover this service-owned gate.

Add service-owned tests of real bounded rendering for every supported family, unchanged-byte replay,
OpenCode version migration and foreign-plugin refusal, Hermes record/TUI/alias cleanup and platform
command selection, cancellation after rendering and missing notify artifacts. Collector tests cover
exclusive creation, aliased removal, modes, observations, exact directory authority and input/output
bounds. Private worker requests now exercise preserved optional semantics, refused commits, malformed
or late candidates and content-free failure reports; local composition proves rendering neither loads
installers nor writes native files. No runtime edits, coverage exclusions or golden changes.

The focused gate passes 61 tests in seven files with all four runtime files at 100% statements,
branches, functions and lines (298/298, 232/232, 75/75 and 199/199); TypeScript passes. A new fixture initially omitted
captured HOME and failed; correcting that fixture input produced the passing run. Earlier source-scoped
native evidence is unchanged; the parent's exact-source full gates remain authoritative.

## Repeated publication proof correction (2026-11-17)

The combined engine comparison found six cached launches performing 81,150 `lstatSync` calls,
versus 5,874 before extraction. The intrusive attribution run locates repeated native-file and
executable proof walks; it is not a latency acceptance result. A publisher-only control at
`38f9eba9e0b7af74071602dd94f38acfbaa2168b` performs 12,206 metadata reads while confirming one
unchanged profile and its unchanged shared artifact. Its worker authority callback alone reads
those leaves 12 and 6 times, independently of ancestor depth.

Design: `HookPreparationAttempt.verify()` already checks the original owner both before and after
its route and observation reads. The publisher's authority callback can return true after that
verification instead of traversing the same owner a third time. After the worker reply, keep the
single full verification after bounded candidate validation and before preflight/effects; remove
the immediately preceding duplicate. No proof is retained across an await, and no reservation,
flush, final publication, alias, executable, cancellation or deadline check is removed. The shared
folder-trust publisher follows the same path. Growth, identity, schema, migration and rollback are
unchanged: no new state, cache, setting, files, credentials, or worker operation. The existing
Design checklist and external-writer race limit above remain applicable on macOS, Linux and Windows.

Validation selected before implementation: a caller-level real-filesystem work budget fails at
12 profile-leaf reads against a budget of 10; retain mutation/refusal, shared artifact, reservation,
file durability, native launch, folder-trust, worker-service and type checks. Final combined native
acceptance and quiet CPU/memory/latency comparisons remain the integrating parent's responsibility.

The correction reduces that publisher-only control from 12,206 to 10,324 metadata reads (15.42%).
The separately counted worker authority check falls from 12/6 profile/artifact leaf reads to 10/4.
The control excludes that extra isolated authority-check probe from its publisher total in both
arms. These are operation counts on one macOS private fixture with pinned Node 24.22.2, not CPU,
RSS, latency, vendor-native or Linux/Windows acceptance. It is a partial correction: the remaining
combined launch regression still needs investigation and the parent's quiet comparison.

The original twelve-file focused run passed 235/236 tests. The legacy OpenCode older-caller test
failed its one-second wait for disk entry; the edited publisher is outside that legacy call path.
An isolated unmodified-publisher control passed and is retained as diagnosis, not a retry that
clears the failure. That test started both asynchronous version imports without first proving which
caller consumed its held probe. It now awaits the older probe's entry, awaits the older caller's
actual owner check while following the newer installation, and releases and settles both operations
in `finally`. No polling interval, sleep, or production timeout was increased. All 46 tests in that
changed file pass; the other 190 focused tests passed on unchanged source. Type checking passes.
The filesystem budget itself was red (12 reads exceeds 10), then green (10 and 4); existing checks
cover stale owners/files/aliases, failed durability, shared joining, all thirteen hook families,
launch authority, optional folder trust, and setup workers. Full integrated gates are still pending.

Both the first and last `check()` in `runHookPreparation.verify()` still traverse the outer current
proof. The first establishes authority before the attempt's own route and file-observation traversal;
establishing it also reads the outer proof paths. The last rejects authority, executable,
shared-file or deadline changes during those reads.
This correction leaves both phases intact; removing either would need a separate proof about which
reads and effects can occur under stale authority. There is no cross-await reuse.

## Retained route comparison (2026-11-17)

The remaining-cost review proposed comparing the original route with the verified fresh snapshot
already taken by `inspectHookFile.verify()` and `hookPreparationRoutes.verify()`. Their independent
old-fact stat pass both repeated filesystem work and left the fresh walk unrelated to the original
ancestor identities. This change is private to `nativeHookFiles.ts`; `NativePaths` and its public
fact verifier remain unchanged for all other consumers.

Design: each invocation walks and verifies a new `NativePaths` snapshot, then compares every retained
fact by its exact path, identity without device number, and original alias target/version. A missing
fact is refused without a filesystem fallback. The lookup map contains at most the original 256 facts;
fresh Windows snapshots may also contain the excluded writable leaf. Original invalid-path and empty
fact rules remain, including reservations' existing empty-list exception. Newly ordinary parents are
allowed; new aliases are refused separately for each destination. Canonical targets, final file-version
checks, both owner/deadline checks, observers, all fsyncs, and all after-await and publication fences stay
in place. No state, authority, cache, wire format, callback ordering or storage format is added.

The source-derived race was reproduced against `b3ac09ec336918852c0a353bd5992e3a8cb32772` using real
temporary directories: rename a parent aside, create its replacement and move the unchanged child
back, preserving the child inode and exact leaf version. File observation accepted this during its
first leaf or first child stat. Destination reservation accepted it during its first child stat;
it already refused the proposed first-leaf timing. The full publisher already refused the injected
race, kept original bytes and issued no confirmed proof. This is a standalone verifier correction,
not evidence of an exploitable end-to-end publication. The corrected public verifiers also refuse
the replacement made before verification begins.

The initial focused RED had seven failures and twelve passes: three ancestor races, two missing-fact
cases, and both real ancestor-read budgets (three reads against two). Tests retain alias target and
version checks, device-number semantics, path/fact bounds, empty facts, ordinary new parents, newly
inserted aliases, writable-leaf exclusion and mutation after the fresh walk. The eight selected suites
passed 186 tests; adding the two before-verification races and explicit fixture type annotations left
56 file tests passing. The publisher's fixed-depth fixture passes all 13 tests. The other 119 selected
tests are unchanged: native Windows path/executable fixtures, attempts, preparation, folder trust and
published grid configuration. Type checking passes after correcting only new test annotations.

On macOS x64, pinned Node 24.22.2 and the unchanged lockfile, the complete unchanged profile plus shared
artifact publisher performs 10,324 -> 7,255 `lstatSync` calls (29.73% fewer). Its profile-directory reads
fall from 1,513 to 1,021. The separate extra worker-authority probe, excluded from that total in both
arms, reads the profile/artifact leaves 10/4 -> 9/4 times. Confirming the returned proof is outside the
publisher count. The macOS fixture owns a fixed-depth `/tmp` subtree and removes it afterward, so the
1,021 budget does not depend on the invoking suite's `TMPDIR`; leaf and isolated-verifier budgets run
on all platforms. Raw counts match before and after that fixture correction. An initial aggregate
assertion was off by one (1,020); its failed receipt is retained, and the final limit is the measured
1,021. This is a filesystem-work result only: combined quiet CPU, RSS and latency acceptance belongs
to the integrating parent. Linux and Windows native execution remain unverified here.

## Publication dependency checks around disk waits (2026-11-17)

The clean combined comparison still shows higher cached-launch cost. A separate diagnostic counts
5,685 -> 47,628 core native-path metadata reads over six cached launches. The nested shared artifact
uses the profile attempt's full `verify` as its `current` callback, so every fsync queue, dispatch and
completion check recursively walks the profile's routes and files. This is operation-count attribution;
the sanitized CPU profiles did not retain useful core module names and establish no stack attribution.

Keep the existing distinction between `check` (original owner, revocation and deadline) and `verify`
(all file/route dependencies). Add one internal dependency-verification callback to the preparation
options. Full verification invokes it before and after its own route and observation reads, preserving
both proof fences. The publisher composes its original caller's dependency callback with its routes
and accepted shared proofs. A shared artifact's owner callback checks the outer attempt's ownership;
its dependency callback performs the outer attempt's full verification. Worker authority requests stay
full verifications. Joining and conflict settlement check dependencies before and after their waits.

Only the checks surrounding fsync of an already owned descriptor become owner checks. No new bytes or
filename are published there. Every rename, link, removal, directory creation, subsequent publication,
proof capture and acknowledgement retains its full checks. The directory chain still verifies each
opened directory's identity before/after its flush, and ancestor substitution while it runs refuses
the final proof. A revoked/expired caller cannot dispatch a queued flush or receive success after an
in-flight flush settles. Descriptor and reservation lifetimes remain tied to actual completion.

Design: no new durable data, schema, wire contract, cache, timer, queue, retry, process, or dependency.
Growth remains the existing bounded attempts/observations plus one callback per attempt; concurrency
and audience remain the existing exact owner and destination reservation. Read cost changes only in
descriptor-durability intervals. No migration or rollback operation is needed. Failure uses the
existing held result and content-free log. macOS/Linux/Windows semantics and all directory/file
flushes remain; native platform acceptance belongs to the integrating parent. The old baseline wrote
the shared Messages artifact outside durable publication, so its lower directory-flush count is not
permission to remove the new durability work.

Selected validation: first observe the existing fixed-depth publisher exceeding a 600-read ancestor
budget and caller dependency guards refusing too late or not at all on unchanged production. Add
real file/parent/alias mutation during shared fsync, composed dependency, join/settle and final-fence
checks. Run the affected publication/attempt/path, launch, trust, setup and Windows-file unit fixtures
with at most two workers, then TypeScript. CPU/latency comparison and integrated native/full gates
remain root-scheduled; fewer metadata reads alone do not clear the performance hold.

Observed validation on macOS with Node 24.22.2: before the runtime change, the two focused suites
failed nine cases and passed 35, including the measured 1,021 ancestor reads above the new 600-read
budget. With the change, all 44 cases pass, including the unchanged worker-authority leaf budgets
and the file, ancestor, alias, owner, join/settle and directory-durability races. The passing test
records only the ancestor bound, so the exact after count remains pending the fixed comparison.
The unchanged caller batch passes 264 cases across 12 files; both test runs and TypeScript have
observed exit 0, and the diff check is clean. These are unit/caller results, including simulated
Windows paths, not native Linux/Windows or end-to-end CPU, RSS and latency acceptance. Raw RED,
GREEN, caller and typecheck receipts remain in the private integration evidence directory.
