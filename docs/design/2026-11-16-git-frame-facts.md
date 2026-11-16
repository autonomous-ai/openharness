# Git facts outside the core

Package 4, step 2 of the daemon-core plan. A frame currently calls `agentProject`,
`describeScmProject`, `sessionGitContext` and `sessionGitHistory` in the core.
The workspaces service will compute the same display facts and publish `project`
and `gitContext` through the shared frame parts introduced by package 2. This
step depends on that package's reviewed implementation; it adds no second core
cache or service-specific frame port.

## Design

- Growth and deletion: reuse the existing bounded project reader (1,024 cached
  directories), Git-context reader (512 entries) and history store (128 branches
  and 128 pull requests per history). The service owns in-flight work and captured
  publication leases; end, purge, disconnect replacement and stop revoke stale
  work. Bound the service's pending agent set and concurrent inspections before
  implementation. No new persisted format or retained customer data is needed.
- Concurrency: a result belongs to the exact followed agent view and lease that
  requested it. A changed directory, conversation or lease invalidates earlier
  async results. Keep `SessionGitContextReader`'s newest-observation ordering and
  monotonic display versions. Preserve repository mutation serialization already
  used for create, rename and purge.
- Read cost: use `follow({each:true, frames:true})` and the existing observation
  cadence, with service-side changed-input and freshness checks. Preserve the
  project's 15-second refresh and 60-second full refresh rules. Reuse the existing
  `CoreApi.usage` aggregate snapshot for observed work; never add a transcript
  read or a new core query just for Git. Push only changed display facts.
- Scale: the existing Git reader limits subprocess concurrency and output; the
  new service work queue must also remain bounded. Measure ten-agent list/push
  work with the prepared native rig, including core CPU, memory, latency and
  subprocess parent IDs. Core must start no Git or SSH process for these facts.
- Compatibility: retain the existing `project` and `gitContext` wire shapes and
  the plain-folder placeholder from the plan. A valid directory must retain its
  `project.cwd` before the service reports, so Fork/Clone still work. Stopped rows
  have no live publication lease: document and test their placeholder rather than
  pretending a missing report is a fresh Git observation. Use the existing dated
  old-core process adapter; do not weaken current-core lease checks.
- Migration and rollback: history stays in the same files and format. Moving its
  reader/writer to workspaces changes ownership, not storage. Old and new builds
  must not concurrently write a history during handover; validate the supported
  service stop/restart order. Rollback resumes the old reader on the same files.
- Audience: publications use the authenticated workspaces connection and its
  declared fields. Existing frame authorization remains the boundary to clients.
  The service uses only followed views and the existing metadata APIs.
- Identity: Git/SSH metadata probes stay under this daemon owner's existing
  account. No credentials, repository contents or personal paths enter metrics.
- Failure: missing/hung/killed workspaces cannot block frame construction, input
  or unrelated agents. Retain last known display parts only for the current live
  lease; use the specified placeholder otherwise. Record named, content-free
  refusals and retain the existing query/subprocess deadlines.
- Platforms: shared TypeScript on macOS, Linux and Windows. Preserve hidden
  process starts and the existing bounded Git/SSH implementations. Native proof
  uses private homes/repositories and fake engines; platform coverage is recorded
  explicitly.

## Boundary changes

Move frame composition into workspaces, retaining existing readers and version
semantics. Split `validGitPath` and `validProjectCwd` from subprocess-owning
modules. Split the pure SCM launch/instruction contract from the implementation
registry so launch does not eagerly load `GitScmProject`. Remove the core's
`forgetAgentProject` callback and the branch-reading half of agent naming when
their callers use the reported facts. Delete every newly unreachable line from
`architecture.coreFiles.txt`; report the exact import closure before and after.

## Bounds decided before runtime changes

The existing shared publisher's 16 KiB / 512-value ceiling cannot carry the
published Git contract. A diagnostic using the actual `sessionGitContext` at
`70b1cdb402ebc520c63439a707417e52b394f394`, private fixtures and fake probes measured:

| Projection | JSON bytes | JSON values | Depth |
| --- | ---: | ---: | ---: |
| Plain checkout, empty history | 599 | 34 | 4 |
| 128 ordinary historical branches and 128 pull requests | 53,283 | 2,338 | 6 |
| 524,287-byte valid persisted history and 261,988-byte accepted observed work | 819,459 | 2,770 | 6 |

Use shared generic constants of 2 MiB and 16,384 values per part. Keep the existing
4 MiB total, 4,096 entries, depth eight, 512 array/object members and 32 declared
top-level fields. The persisted-history reader admits 512 KiB, usage admits
256 KiB, and context probes at most eight additional locations. Project probes
already cap each command's output at 16 KiB; the extra budget accommodates their
repeated project descriptions without reducing history's existing 128/128 limits.
The measured largest projection uses 39.1% of the part budget. This is an explicit
publication bound, not a claim that legacy in-memory writers were all bounded:
an oversized part or exhausted total budget is refused by name and retains the
previous current-lease result; it never silently drops history to fit.

Authenticated service messages already use the local socket's 6 MiB + 4,096-byte
transport ceiling (`localWsServer.ts`), bypassing its ordinary 512 KiB client JSON
limit only after service authentication. The 2 MiB part and query envelope fit
without widening transport admission.

Keep at most 512 scheduled/cached agent observations and four running inspections,
matching the Git reader's existing subprocess concurrency. Coalesce each agent's
latest followed view, evict only settled observations, and report queue exhaustion
without increasing pending work. Lease, cwd and conversation changes revoke an
older result before it writes history or publishes. A branch rename invalidates
the service's refresh time. The core wires its cached usage reader before creating
the inline service scope, because that scope copies the API's top-level fields.

## Validation selected before implementation

First record public frame byte goldens for plain directories, repositories,
worktrees, detached heads, SSH aliases, observed work and history, plus the
planned missing/stopped placeholders. Establish the prepared native rig's RED:
the current core starts Git/SSH on frame construction. Add service lifecycle
controls for stale async results, changed directories, lease renewal, process
loss/reconnect and bounded queues. Preserve rename refresh and history/usage
semantics. Run exact import closure, architecture/lean-entry checks, affected
per-file coverage, typecheck, mapped local gates and private native tests.
Freeze a matched before/after cost workload only on final reviewed source; root
coordinates quiet with the other core work. No acceptance claim follows from a
source-size reduction alone.
