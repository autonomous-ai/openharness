# Checked launch contributions

Package 6, step 4. Starting source: `3bde21130396d338645e7589cb8ceab640564b53`.
Models, the Store and shared machines already contribute to launches. Their current
core links accept strings of arbitrary length and, for Models/guests, arbitrary
keys, flags, file names and executable wrappers. This change checks the authority
already lent to those services before core writes a generated file or opens a pane.
It adds no feature, queue, cache, process, setting or runtime dependency.

## Existing producer contracts

- Models has seven grid-capable engines. `gridLaunchWire.ts` already declares
  their environment names; `gridLaunch.ts` is the service-owned implementation.
  Configurations are one of five declared single-file shapes: Codex's
  `model-catalog.json`, OpenCode's `opencode.json`, Pi's `grid-provider.ts`, Hermes's
  `config.yaml`, or Grok's `config.toml`. Only Grok borrows a directory, `sessions`,
  from the native Grok home captured by the core in the request. Its flags have
  declared names; Codex `-c` accepts only the existing provider/model/web/MCP keys.
  This does not parse or duplicate each vendor's configuration implementation.
- Store spec 1 deliberately accepts package-defined uppercase environment names
  and up to 64 extra arguments. Its engine adapter may append context/environment
  arguments. The current catalog has 113 distinct environment names, at most 19
  on one package, and one package with 12 extra arguments. KiCad deliberately
  supplies Codex hook commands; four packages use `PYTHONPATH`. These remain
  supported package authority, not an accidental service-wide engine allowlist.
  Only the six existing `HARNESS_*` session fields belong to Harness itself.
  The published contract also permits package-defined `PATH`, `HOME`, `NODE_OPTIONS`,
  `BASH_ENV` and loader variables; these are not newly granted by this guard.
  Installed packages are trusted executable code, and sandboxing their commands or
  interpreting nested vendor configuration is outside this boundary task.
- Shared machines emits one fixed POSIX helper wrapper, with the guest identity
  derived from the requested email, the requested engine/permission flags/prompt,
  and TERM/COLORTERM/LANG. An unshared requested folder deliberately falls back
  to the derived guest workspace; a shared folder uses its normalized request path. Windows emits the same requested engine argv directly,
  with an empty environment and the derived guest host user. No arbitrary shell
  program from the reply is part of this contract.
- Inline callers require the same checks. Models passes through `gridLaunchThrough`,
  Store through `dshThrough`; the guest creator must check before choosing the
  backend or starting installation. A checked link alone would miss these paths.

## Design

- Growth: no persistent data. One reply is bounded to 1 MiB of accepted text,
  256 environment entries and 1,024 argv items; a string is at most 64 KiB and
  contains no NUL. The argument bound includes Codex's two arguments per package
  variable plus the manifest's 64 arguments. Models' much smaller declarations
  further constrain its keys, flags and one generated file. Oversized arrays are refused before copying; map inspection stops at the first
  exceeded bound, without allocating an unbounded entry list. No value is truncated.
- Concurrency: no new lock or state. Request authority is captured before a service
  await, and existing launch owner/workspace checks still fence the subsequent
  publication and pane creation. Accepted arrays/maps are copied so a later
  mutation by an inline implementation cannot change the admitted contribution.
- Read cost: bounded in-memory checks on the reply. Models/guest declarations need
  no filesystem read. Store reserved-field checks must reuse already captured
  installed-package identity; they must not add a synchronous index read or cache.
  Workspace alias resolution, if needed, is asynchronous, bounded by the existing
  launch deadline and followed by the caller's current-authority check.
- Scale: bounds apply before every reply is consumed, including inline mode. The
  current catalog's largest environment count is more than 10x below 256. This
  is not a new total-daemon or per-account capacity claim. Invalid reply refusal
  and the existing service-unavailable state are the signal; logs contain no
  paths, arguments, configuration contents or credentials.
- Compatibility: backend and public client schemas do not change. The current and
  supported old service output shapes remain valid if within their declared
  authority. Unknown unrelated reply fields are projected away. A malformed
  contribution becomes unavailable rather than an empty launch. Store snapshots
  retain former package IDs, and symlinked workspaces retain their canonical
  runtime paths; these are legitimate identities, not spoofing cases.
- Migration/rollback: no on-disk rewrite. Existing Store runtime snapshots, Grid
  registry records and guest accounts remain unchanged. Reverting restores the
  previous permissive receiver against the same data. No published tag is moved.
- Audience: the existing local service registration and owner/guest access checks
  still apply. Store package execution remains the explicitly installed package's
  authority. This is not an OS sandbox against another process under the same user.
- Identity: Models cannot add an environment variable, switch a configuration
  pointer or escape the generated directory beyond its engine declaration. A
  guest reply must preserve the request's engine, permissions, prompt and exact
  derived guest account; Windows never falls back to the owner's host. Store
  reserved identity is bound to trusted request/package/runtime facts, not a
  self-asserted allowlist returned by the service.
- Failure: a failed check returns the existing Models/Store unavailable hold or
  `GUEST_UNAVAILABLE`, with a fixed content-free log reason. It happens before
  generated-file publication, guest installation, backend selection or pane open.
  Ordinary engines keep working. No retry or fallback to a different identity.
- Platforms: shared TypeScript, macOS/Linux/Windows. Path tests cover both path
  syntaxes; the guest wrapper is checked on POSIX and the guest host on Windows.
  Native validation uses isolated homes and tmux only; no real guest account is
  created and no process environment is read.

## Store identity prerequisite

The existing `DshThrough.nameOf` callback is currently used only for refusal copy.
It cannot be repurposed into a new synchronous index read on every successful
launch. Create already has `pinnedDsh`; restore/fork use persisted runtime keys.
The implementation must pass captured identity through those existing callers,
including canonical and former package IDs, without introducing a second index.
If an existing path cannot provide that authority, its exact identity enforcement
remains explicit follow-up rather than pretending a service-provided alias list
proves anything. Bounds and reserved-key restrictions can still cover every path.

## Selected validation

1. Caller RED cases for overlong/oversized contributions, undeclared Models
   environment/flags/config pointers/files/links, forged guest engine/account/
   helper wrapper/prompt, and Store reserved fields. Preserve valid controls.
2. Real Models producer matrix across all seven engines, with/without web tools,
   model/context hints, API refresh, OpenCode v1/v2 and pinned Hermes policy.
3. Real Store producer cases preserve package env/args, renamed package snapshots,
   symlinked workspace, Resume/Fork runtime identity and all engine adapters.
4. Complete affected caller/spec files with per-file core coverage; source types,
   architecture/lean checks, then the path mapper's required local gates.
5. Existing private Store/grid/guest native flows where they cover this boundary;
   targeted malformed-reply proof before any pane or generated-file effect.
6. Same-source/workload cost of admitted and refused contributions, scheduled by
   root after other execution settles. No performance result is inferred from
   source size. Root owns independent review, integration, CI and release.

## Implemented scope and acceptance

Create reuses its single installed-package lookup and the canonical directory from
its existing workspace observation. The captured package ID/former IDs, canonical
workspace and label-derived runtime paths bind Store's reserved identity fields.
The existing current-authority check remains immediately after the Store await.
Models and guest guards retain a detached pre-await request snapshot. Every
accepted launch contribution is detached before the inline caller can reuse it.

**Incomplete prerequisite:** Restore and fork do not yet provide independently
captured installed-package/workspace identity. They receive the same bounds,
reserved-name restrictions and request account check, but exact package/workspace/
runtime identity is not claimed there. Existing snapshots may retain an older
`HARNESS_DSH_DIR` after a package update; that field remains bounded Store/package
authority instead of being falsely equated with the current install directory.
Installed-index extraction must supply these facts before package 6 is complete.
No identity is inferred from aliases supplied in a launch reply.

Source-scoped checks before integration:

- Test-only source `f6cdab09e3`: 36 failing, 11 passing caller tests against the
  pre-implementation runtime; actual exit 1. Log `/tmp/harness-launch-boundary-red.log`.
- Selected implementation checks: 341 tests across 14 files; affected boundary
  files have 100% statements, branches, functions and lines (691/791/103/521).
  This includes all real Store adapters, rename/symlink snapshots, all seven
  Models producers, request identity, exact/over-limit sizes, guest no-effects
  refusal, native create composition and the real POSIX bootstrap shell fixture.
- Source TypeScript completed with exit 0. Architecture and Store launch goldens
  passed. Grid launch golden setup requires a private loopback server and was
  blocked by sandbox `listen EPERM`; rerun outside that restriction is required.
- The changed-path mapper selects `npm run test:core`. Full core acceptance and
  the loopback-dependent golden rerun are pending on the implementation commit.
- macOS execution is recorded here. Windows guest command/host forms are covered
  in fixtures; native Windows execution remains for the Windows release gate.
  No real guest account was created or used. No timed cost run has been made;
  root coordinates that separately from other validation load.
