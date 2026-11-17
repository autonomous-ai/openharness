# Store package facts outside the core

Package 7, step 2 of the daemon core plan. The Store in the viewers process owns
installed-index, manifest, compatibility and executable package parsing. The core
keeps only bounded facts for the launch presently being prepared. Existing viewers
frame parts already carry package display facts; there is no second core cache.

## Design

Reviewed direction: root, 2026-11-17, before implementation.

1. Growth: no new disk records, cache, timer or index in core. A package description
   lives only for its request and leaves on completion/cancellation. It contains a
   canonical id, name, permission choice and compatibility refusal, each bounded;
   no manifest, aliases, package environment or argument list crosses this read.
2. Concurrency: existing launch/receipt ownership is rechecked after asynchronous
   package reads. Store's existing preparation lock and atomic runtime/index writes
   remain authoritative. A description is a captured observation, never permission
   to publish after the launch owner or workspace changes.
   Consumer-local builtin setup introduces concurrent different-package writers.
   installed.json therefore gains one transient directory lock around the complete
   read/modify/atomic-rename operation, reusing the package lock's ownership and
   stale-owner recovery. Busy is an immediate named refusal; the next actual
   consumer request retries preparation. No timer, sleep or background retry is
   added. Successful, failed and cancelled writes release it in finally; a killed
   writer is recovered by the existing dead-owner check. Old versions ignore the
   new lock, so this protects same-version writers, not a simultaneous old CLI
   mutation; the existing per-package lock still covers their same-package work.
3. Read cost: ordinary engine launches and frame reads perform no package disk
   reads. A package admission asks one bounded description through the existing
   Store deadline; preparation can refresh that observation. The Store's existing
   installed cache owns disk parsing. Display facts use the existing frame-part
   budget and invalidation/agent lifecycle; Wi-Fi reads those same facts.
4. Scale: ten times the retained agents creates no installed-package cache in core.
   Description fields are at most 4 KiB, ids retain the public owner/name grammar,
   and the fixed reply has no package-sized arrays. Existing service deadlines and
   fixed malformed-reply logs expose unavailable/oversized facts. Timed comparisons
   require a coordinated quiet window and are not inferred from source size.
5. Compatibility: public create/resume/fork frames, receipt fingerprints and runtime
   snapshots retain their formats. Alias canonicalization still precedes new
   receipt fingerprints. Matching canonical-id receipts remain recoverable after
   package removal; a former-name retry needs Store to resolve its identity, while
   the independent creation-status request does not. A supported old Store lacking the new internal description answers
   unavailable for an affected package request, never a plain-engine launch.
   Inline/no-master mode supplies the same port from its dynamic component load.
6. Migration/rollback: no disk migration. Existing installed.json and runtime.json
   remain readable by the previous release. Old snapshot package directories are
   retained; they are never rewritten to the currently installed package directory.
7. Audience: existing owner/client checks and authenticated service registration
   remain the audience boundary. Only the launch's short package facts are retained;
   no credentials, manifest contents, package scripts or personal paths are logged.
8. Identity: workspace, runtime destination key, account and current owner are
   captured independently by core before awaiting a launch. A new create retains
   its canonical package id. Historical aliases/snapshots remain Store-declared
   package authority: another reply from the same Store is not independent proof
   of that identity. No reply alias list expands core authority. Packages remain
   trusted executable code with their published arbitrary uppercase env/argv
   contract, including PATH/HOME/loaders/hooks.
9. Failure: unavailable, killed, hung or malformed Store answers hold/refuse only
   package launches, before pane creation. Ordinary agents continue. Removing the
   boot index scan does not make viewers always-on: first package admission wakes
   Store. Models and Memories prepare their bundled package at their existing
   outside-core first use with the same locked/atomic installer; failure remains
   visible instead of silently dropping the bundled feature.
   Each consumer retains successful first-use readiness for that process, so later
   requests do not rehash bundle contents. Only incomplete/failed preparation is
   retried by the next actual request; a component restart loads a new release.
   Store invalidates readiness when optional Hachi changes, without preparing while
   it is off. Both process and explicit inline descriptions announce recovered
   readiness to waiting launches.
10. Platforms: shared TypeScript on macOS/Linux/Windows. No new process mechanism,
    dependency, OS account or platform-specific shell. Paths use native path APIs;
    fixtures cover symlinked workspace, renamed package and old install directory.

## Selected validation

Test first at actual create/request/fork/resume callers and the process port. Prove
no eager index read, malformed/off/old service isolation, captured owner/workspace,
legacy aliases and concurrent builtin preparation. Run source types, architecture,
affected files, required core/resume/portability gates and private native Store
flows, at most two test workers. Parent coordinates timing, integration and release.

`lib/apiConnectionMetadata.ts` remains another default-core zod import until its
separate extraction integrates. This task removes the Store path, not that path.

## Combined-source review

Merged main `e9670ffd23` into extraction head `f8f2e159fc`. The only textual
conflict was the Registry import in resumeAgentService: retain its new launch
publication/authority helpers while removing installedDsh. Registry's pending
admission and persisted receipt fences remain intact.

The program-harness delta from `88dd98d1a8` to `e9670ffd23` changes no core create,
fork, launch, Registry, stopped-record or resume module. Its new token ownership
remains in the CLI, and its input acknowledgement wiring is retained in main.
`ensure` only replaces work after AGENT_NOT_FOUND/RESUME_UNAVAILABLE; preserved
INVALID_DSH and Store-unavailable answers therefore cannot become a fresh
conversation. Package create payloads, canonical receipt fingerprints and runtime
keys retain their formats. Ordinary engine ensure never asks Store.

Selected final checks: CLI types; core, harnessd, resume, portability and local-models
required gates; architecture and Store/Grid/native launch goldens; private Store
process kill/hang/restore and viewer scenarios; program ensure/newCommand specs and
programHarness private E2E for the merged source. No benchmark runs overlap them.

Targeted review validation: the inline recovery notification test failed first
(expected three notifications, observed two), then passed after the port fix.
The existing Hachi off/on control caught readiness retained across a disabled
interval; settings invalidation restored it. The final narrow run passed all 216
tests in eight Store, consumer, create and fork files, and CLI types passed. Full
required gates and private E2Es remain pending the parent's quiet-window release.

Integration review on 17 November caught a changed missing-package refusal in the
real Store fork golden. The fork now keeps its established `INVALID_DSH` wording
after the Store confirms removal, while unavailable Store replies stay unavailable.
It reads no installed index. The focused regression first failed one case with one
unavailability control passing; after correction, all 38 fork and Store launch
golden tests passed on macOS, and source types passed. Broad gates remain pending.

## Store boundary acceptance cases, 17 November

The integrated source `29a7ec4677` already returned the intended results, but its
Store-off description fallback and readiness paths lacked full acceptance coverage.
New assertions prove that an absent Store refuses package descriptions by name,
that exempting disabled Hachi does not announce the other bundled packages ready,
and that an unavailable description during partial preparation sends no `prepared`
notice. Existing malformed-request, recovery and disconnected-core controls remain.
No production code, data format or runtime behavior changes in this test slice.

The initial three-file baseline passed all 63 behavior tests but exited 1 at the
per-file coverage gate; this is coverage RED, not a claimed behavior failure.
The selected nine-file boundary check passed 147/147 tests in 10.76 seconds, with
`core/api.ts`, `services/store.ts` and `services/storeProcess.ts` each at 100% for
statements, branches, functions and lines. Its extra existing specs exercise the
other public API fallbacks and query contracts, rather than adding duplicate tests
solely for coverage. Logs and coverage are retained under
`/tmp/store-boundary-acceptance-{baseline,green}.log` and
`/tmp/store-boundary-acceptance-coverage/`.

Type checking also exited 0 (`/tmp/store-boundary-acceptance-types.log`).
Validation is local macOS on pinned Node 24.22.2, using the existing private fixture
setup. No native Windows/Linux or full-core acceptance is claimed here; the
coordinator owns combined gates, integration and release.

## Design: stable receipt identity while Store is unavailable

A package alias must be resolved before admitting a new durable create: the
receipt fingerprint has always used the canonical package id. If Store cannot
establish that identity, the caller may replay an existing receipt only when the
unchanged request fingerprint already matches. Otherwise it returns the existing
Store refusal without admitting a receipt or claiming a changed request. When
Store recovers, the original alias resolves to the same fingerprint and replay
returns the original result; a genuinely changed request still conflicts.

This changes no persistent schema, fingerprint, authority, cache or migration.
An old fingerprint alone cannot prove which former package name produced it, so
legacy alias replay while Store is down conservatively returns Store unavailable;
`agent_create_status` remains independent of Store. Canonical-id replay still
works when its fingerprint matches, including pending and cancelled intents.
No alias is inferred from a current agent or substituted into an old receipt.

The extra point lookup is limited to a package request whose Store description
failed; ordinary launches and healthy package requests keep their existing work.
No new list, scan, timer, lock or fan-out is introduced. Existing authenticated
caller/receipt ownership, guest routing, deadlines and named Store refusal remain.
Shared TypeScript affects macOS, Linux and Windows; local fixtures use private
receipt folders and synthetic package names. Rollback reads the unchanged records.
Selected evidence: actual-create red/green cases for replay, unavailable admission,
recovery, changed input, pending/cancelled receipts; the complete launches suite,
changed-file coverage and CLI types. Broad/native checks remain root-owned.

Correction evidence on macOS x64 / Node 24.22.2: the new actual-request matrix
failed first in nine cases, with four controls passing and 111 unrelated cases
skipped (`/tmp/store-alias-receipt-red.log`, actual exit 1). It covered completed
legacy/native alias replay, new legacy/native/model admission, pending/cancelled
receipts, absent Store ports and receipt-storage errors.

The first complete launches run passed 123/124; its remaining fixture assumed a
missing package could be admitted before model resolution. It now makes the
package available at admission and removes it during model resolution, preserving
the intended refusal check. The next launches/golden run passed 126/126 but failed
coverage (99% statements, 99.2% branches). Actual project requests now also prove
revocation after description/folder waits and incompatibility before receipt
admission. The unreachable second-description fallback in validateInstalled was
removed: all three callers already pass their captured description.

Final launches plus request-golden validation passed 129/129, with launches.ts at
100% statements (500), branches (628), functions (45) and lines (359), actual exit
0. Types also exited 0. Final logs are `/tmp/store-alias-receipt-green-complete.log`
and `/tmp/store-alias-receipt-types-complete.log`; coverage is retained under
`/tmp/store-alias-receipt-coverage-complete`. This adds no Store lookup to a healthy
request, and no new receipt on the unavailable-identity path. Broad integrated
coverage, native platform checks and release remain coordinator-owned.
