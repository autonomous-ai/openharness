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

Default source closure is 530 files / 88,284 lines, down from the clean eec base's 539 / 90,847.
The same walk with legacy engine doors open (still excluding services/inline) is 674 / 108,384,
versus 652 / 107,819; its growth includes both retained explicit legacy installation and the new
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
