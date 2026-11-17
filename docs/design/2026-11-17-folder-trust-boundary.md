# Folder-trust preparation outside the core

Package 8, step 3 of the daemon core plan. The core currently imports the JSON/TOML
folder-trust implementation and the inherited-MCP walker through `launchPrep.ts`.
Both run on its event loop. The optional engineSetup component will own their
interpretation. This increment keeps the existing generic native-file reservation,
capture and checked publication in core; it does not claim all filesystem work or
the final synchronous rename has moved out.

## Design

Prepared for root review before product edits, 17 November 2026.

1. Growth: no new durable record, process, cache, background task or timer. Trust
   preparations use engineSetup's existing eight reservations and deadline. Their
   lifetime ends at actual preparation settlement or connection revocation. At most
   two fixed destinations are retained per request: the engine's declared trust
   file and, for Claude Code, its declared workspace MCP settings file. Each is at
   most 1 MiB; replies use the existing indexed, bounded native-file candidate.
2. Concurrency: trust cannot write directly in the worker. Codex's `config.toml`
   is also a destination of core's native hook publisher, so worker-local
   serialization would introduce a lost-update race with those writes. The same
   existing `runHookPreparation` reservation therefore owns trust and hook writes,
   by resolved destination. Captured versions and alias routes are checked before
   publication; a stale candidate is refused, never merged over newer contents.
   Worker replies carry indexed bytes only, never additional paths or commands.
   Timeout revokes publication; the existing reservation survives actual pending
   descriptor work. The pre-existing check/rename race with noncooperating external
   editors and partial multi-file publication remain explicit limitations.
3. Read cost: the worker parses the captured trust/settings bytes and walks the
   inherited MCP/source-repository evidence. An ancestor walk is bounded to 64
   folders, its captured text to 4 MiB total and each file to 1 MiB. At most 256
   inherited server names are considered. Oversized, malformed or unreadable
   optional evidence leaves the engine's own prompt. Core still captures the
   selected output files through its existing bounded generic native-file code;
   no trust or MCP parser remains in its default import closure. For inherited
   trust, bounded generic path metadata retains the declared repository-boundary
   markers up the source's ancestry. Fixed user-settings metadata/version is also
   retained through publication, so an MCP decision made during the service wait
   rejects the old candidate. These metadata checks remain a core filesystem
   residual; no read-only evidence paths are accepted from a worker reply.
4. Scale: no idle work or scan of agents. Ten times simultaneous launches still
   uses the existing preparation/admission limits. Named unavailable/busy/expired
   results and fixed failure logs expose saturation. Measure the same private
   trust workload before/after, with core and worker CPU, memory and caller delay
   separated. The generic publisher's durability cost is measured, not assumed
   free; the current synchronous trust rewrite does not itself fsync.
5. Compatibility: public create/fork/resume inputs and disk formats are unchanged.
   Distinct internal `setup_trust_prepare` and `setup_trust_commit` names prevent an
   older worker from interpreting trust as installation. Old/off/failing workers
   do not block ordinary launch: a fixed log says preparation was not confirmed,
   and the engine uses its native folder/MCP prompt. The explicit inline/old-master
   composition uses the same preparer through its existing dynamic component door.
   An old core still uses its old path and does not ask the new operations.
6. Migration and rollback: none. Existing JSON/TOML and inherited-MCP files keep
   their formats, existing entries and unrelated settings. Symlinked configuration
   is published through the captured target, preserving the symlink. Reverting
   restores the former preparation owner. No rollback overwrites newer user data.
7. Audience: only authenticated core-origin service requests may prepare or commit;
   client-routed requests are rejected. The request is bounded before parsing.
   Worker candidates can change only the core-selected declared destinations,
   through the existing indexed-file validation. No API key, path, server name or
   file content appears in new logs, metrics or errors.
8. Identity and eligibility: core retains its existing decision to ask for trust:
   a folder Harness made empty, a local empty workspace under its project root, or a worktree
   under Harness's worktree root whose source is already trusted. No clone,
   arbitrary user folder or remote client's plain cwd gains trust. Core captures
   the launch's selected engine/profile/native homes and workspace identity before
   awaiting preparation, then checks its current authority and workspace evidence
   again before publication. For an empty folder, unchanged emptiness is required.
   Store currently reports only a template-copy label, not final-content authority;
   another writer can add files while its optional init command awaits. Therefore
   a materialized template now keeps the engine's native trust prompt and emits
   `TEMPLATE_TRUST_UNCONFIRMED`. This is an intentional compatibility change: the
   former pre-empty plus template-label rule could trust unrelated arrivals. No
   template attestation, manifest parser or content framework is added here.
   Worktree-source trust is interpreted from the captured
   engine config in the worker; changed config invalidates the candidate.
9. Failure: missing, busy, dead, hung, old or malformed setup leaves no publication
   candidate. Core waits at most five seconds for this optional preparation and
   rechecks authority after each await. No automatic retry or second grant is
   added. A launch cancelled during preparation cannot publish its pane. Once a
   project execution has attempted trust or made its explicit prompt decision,
   an internal creator context suppresses a second attempt; this is never read
   from public input. Unavailable results also count as attempted. Direct local
   cwd requests retain their own single preparation. Once a valid native-file
   publication has committed, a later launch refusal does not
   remove the accepted trust entry, matching today's additive behavior. Inherited
   MCP preparation still records only the engine's default negative answer, keeps
   user decisions and never approves a server.
10. Platforms: shared TypeScript on macOS, Linux and Windows; existing native path,
    network-home rejection and symlink behavior are retained. No new process
    mechanism. Tests touch private fixture homes only. Local execution is macOS;
    Linux and interactive signed Windows evidence is reported only when run.

## Concrete boundary

The existing native-file publisher becomes a generic internal helper used by both
hook preparation and trust preparation; the old hook entry remains a thin typed
composition, with no duplicate publication implementation. NativeSetup gains an
optional bounded trust preparation method. Its worker side prepares an indexed
candidate with the existing prepare/commit reservation and never writes directly.

`create.ts` and `launches.ts` await that method through an injected preparer, retaining
the existing trust decisions and checking their current launch/workspace authority.
`repairedItemsName` moves beside the existing launch contract lookup so that one
inert resume label does not retain the trust implementation in core. Direct CLI
trust calls keep their existing behavior; the default core loads none of those
implementation files.

## Selected validation

Write and run failing tests at real create/project callers for deferred trust,
revocation and the absence of synchronous trust calls. Preserve the existing trust
and inherited-MCP golden matrix. Add worker/indexed-reply bounds, old/off/failing
service controls, current workspace/template/source checks and shared Codex
trust-versus-hook publication overlap with changed-input/symlink cases. Verify
unknown MCP input does not gain approval, all unrelated settings survive, and
duplicate commits do their work once.

Run source types, architecture and lean entry checks, affected unit tests and all
mapped local gates, then private real-terminal empty-project, template, worktree and
worker-failure flows using the fixture engines. These do not establish vendor-native
or signed Windows acceptance. Root coordinates quiet performance measurements,
integration, independent review and release. No test/build/benchmark starts during
root's quiet windows.

## Focused acceptance, 17 November 2026

Private source: `codex/core-folder-trust`, integrated base
`8509512526efe3c64597075e882b6f948c1429ee` (engine combined
`fbe9dde6df6b74535281cc323c35dea3677b9011` plus main
`e9670ffd23bf3ae145e56de003e6482aa289e26e`). All commands below ran in `cli/` with
one Vitest worker. No frozen engine source or bundle was modified. The later main
`1e17b388ced13fa2c56503c390c02bcd5c82032f` is not part of these receipts.

- Actual caller RED before product edits:
  `vitest run src/core/agents/create.spec.ts -t 'awaits optional folder-trust preparation' --maxWorkers=1`
  exited 1, two failures (expected preparation call, received none); the same test
  subsequently exited 0, two passed.
- Focused trust/publisher/wire/service/create/launch/golden/MCP selection: 12 files,
  281 tests. The initial attempt exited 1 with 11 failures. Corrections preserved
  TOML unreadable-file errors, retained absent ancestor metadata at the filesystem
  root, and moved an obsolete DSH inspection cancellation case to the actual
  materialization await. The affected four-file retry exited 0, 111 passed; the
  other eight files had passed, 170 tests. Subsequent affected checks are below.
- A native fixture revealed duplicate project preparation: the project executor
  attempted trust and the creator attempted again. Additional actual
  launchRequests-to-creator RED cases for unavailable and deferred trust both
  exited 1 (expected one call, received two), before the internal context fix.
  One earlier test-name filter skipped all cases and is not counted as RED.
  After the fix, `vitest run src/core/agents/nativeCreate.spec.ts src/core/agents/create.spec.ts src/core/agents/launches.spec.ts src/core/agents/launchRequests.golden.spec.ts --maxWorkers=1`
  exited 0, 206 passed, 30.91 s. This covers direct local/remote cwd, local/remote
  new project, unavailable/deferred optional preparation, ignored public context
  forgery, final hook proof and once-only dispatch. NativeCreate uses private
  native files and real preparation; its pane creation is stubbed.
- `vitest run src/services/engineSetup.spec.ts src/services/nativeSetup.spec.ts src/services/nativeSetupTrust.spec.ts --maxWorkers=1`
  with V8 coverage restricted to those three implementation files exited 0,
  40 passed, 1.51 s; each file reached 100% statements, branches, functions and
  lines (244 statements, 220 branches, 58 functions, 159 lines). Narrow coverage
  initially exposed four missing worker cases and four service branches; added
  meaningful absence, read-removal, final-revocation, Claude source and failure-log
  cases before this final result. This is not the broad core coverage gate.
- `vitest run src/architecture.spec.ts src/leanEntry.spec.ts src/leanEntry.identity.spec.ts --maxWorkers=1`:
  architecture and identity passed, 30 tests; sandbox `os.uptime` EPERM prevented
  lean-entry setup. Retrying only `src/leanEntry.spec.ts` with the pinned Node and
  escalation exited 0, 20 passed, 164.31 s. The inventory removes `launchPrep.ts`,
  `kit/folderTrust.ts`, `kit/inheritedMcp.ts` from the default closure and adds the
  core-selected `folderTrustPreparation.ts` boundary and inert `nativeTrustWire.ts`.
  The added boundary retains current launch authority and generic file proofs;
  it loads no trust parser or inherited-MCP implementation.
- Final `tsc --noEmit --incremental false` exited 0. `git diff --check` passed.

Bundled terminal checks used pinned Node 24.22.2
(`bdcd4500054d48c9ec6058706795d91cac83e3e3eaced218434294d8f2fbf7fa`), a private
Node copy, private homes/tmux, fresh bundle, and the reviewed owned-group guardian.
Every accepted receipt records actual test exit/close and stdout/stderr EOF, outer
group and guardian disappearance, each master exit 0/close/EOF, captured service
and tmux PID/group disappearance, private root/setup-folder removal, Node-copy
identity/hash and removal, unchanged bundle bytes, and unchanged source hashes.

- Initial two template checks reached both prompts but failed a fixture assertion
  that read `agent.cwd` instead of `agent.project.cwd`; exit 1. All owned processes
  and roots settled and the Node copy was removed. The first wrapper-only attempt
  also failed before starting any child because sparse-checkout-absent files were
  incorrectly read by the source hasher. Both attempts are retained at
  `/tmp/ftv-1lne7v`; neither is acceptance.
- `/tmp/ftv-mvsmm15z/receipt.json`: exit 0, 10 passed (39 skipped), 113.53 s.
  Selected cases: moved Claude/Codex homes and a Codex profile with empty new
  projects (3), template prompt/Enter/bound session/completed turn for both engines
  (2), inherited source trust for both engines' worktrees (2), and optional
  unavailable/late/malformed trust replies preserving the usable Claude prompt (3).
  Source manifest SHA-256 `693fb9b15ebf74d838293e6fd74f17bdb8d773b8f08ce446683635d452730e27`;
  bundle CLI SHA-256 `7cb124017217382288603ddad71191e920ab035e442628a453ebf5514a913603`.
  This precedes the once-only project correction.
- `/tmp/ftv-umc0tg1b/receipt.json`: final-source rerun of only the three affected
  optional fallback cases, exit 0, 3 passed (12 skipped), 49.33 s. Each observes
  exactly one prepare response, and only malformed-candidate mode observes a
  commit response; each then answers the native-style prompt and completes a turn.
  Source manifest SHA-256 `84f66057b0f79a02f49b7173d8b3c580cf16bd870ac5eef74223534fa7af33c3`;
  bundle CLI SHA-256 `6693ee1c87b7890615745898a01af0c77473f601d9abb44bff0268754cbc3c4f`.
  Only receipt prose changed afterward.

These are selected cases, not the full E2E files, and their engines are fixtures.
The shared publisher's hook behavior is covered by its existing focused unit
suite, both trust-versus-hook reservation orders, NativeCreate's real preparation
and final proof, and required hook preparation in these bundled terminal flows.
No vendor-native prompt, Linux, or signed interactive Windows execution is claimed.
No trust-workload CPU/RSS or owner-latency cost comparison is claimed: root owns
that acceptance, the combined mapped gates, current-main integration and release.
Generic capture/metadata/checked publication in core, partial multi-file publication,
and the noncooperating external check/rename race remain explicit residuals.
