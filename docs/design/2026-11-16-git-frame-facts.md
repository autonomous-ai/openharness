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
without increasing pending work. The service checks its captured lease, cwd and
conversation before starting a history observation and again before publishing.
An observation already accepted may finish saving historical facts for its
captured conversation after that view changes; it grants no cleanup authority
and cannot publish into the replacement view. A branch rename invalidates
the service's refresh time. The core wires its cached usage reader before creating
the inline service scope, because that scope copies the API's top-level fields.
The publication lease names a running lifecycle, not every directory or
conversation revision. A changed followed identity immediately clears this
service's retained part before inspection. Display retention can therefore last
until the ordinary follow notification arrives; this step adds no Git-specific
core invalidation rule or broader lifecycle restart.

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

## Implementation evidence

- Public RED: the original core frame still called Git/SCM/history and did not
  provide an immediate directory-only placeholder. The shared publisher and
  cache refused full 128-entry history fixtures under their former bounds.
- Seven full-frame JSON goldens were captured using the original frame function
  from `70b1cdb402eb` and controlled probe/history inputs: plain folder, repository,
  worktree, detached head, SSH alias, observed work and historical branches/PRs.
  The extracted service producer matches those bytes. Only the process-random
  context version is normalized. These are wire-contract tests, not native Git
  or SSH process proof (`services/workspaces.frameBytes.spec.ts`).
- Active and stopped placeholders retain a valid `project.cwd`, use the planned
  plain-folder context, and perform no Git/SSH/history inspection. Invalid paths
  remain unavailable (`lib/agentFrame.gitFacts.spec.ts`).
- The exact import closure loses `agentProject`, `branchNaming`, `gitProject`,
  `sessionGitContext`, `sessionGitHistory`, `sshHosts`, Windows `noWindow`, and the
  two SCM implementation modules. It adds `projectPath` (pure launch-path
  validation) and `scm/launch` (the pure launch/instruction contract every launch
  uses): nine files removed, two added. The branch naming implementation also
  leaves `agentNames` for its service-only module.
- Typecheck, architecture checks and all 20 built lean-entry checks pass. The
  lean-entry test uses a private home; its system-uptime read required running
  outside the filesystem sandbox. Native process ownership, service kill/restart,
  cross-platform execution and matched cost acceptance remain the integrating
  parent's gates, not claims made by these unit checks.
- The focused service/core controls and seven byte goldens pass with 100%
  statements, branches, functions and lines for `frameParts`, `framePublisher`,
  `workspaceFrames`, `workspaces`, `workspacesProcess` and `workspacesLink`.
  This includes immediate clearing before a changed directory is inspected,
  captured inline leases, full history retention, failed/late work, reconnects,
  the 512-entry/four-inspection queue and the shared publication budgets.

The planned native process-ownership rig now runs from
`cli/e2e/workspacesGitFacts.e2e.ts`. Against the frozen pre-extraction `15dedd`
bundle, ten private fixture agents show the correct projects but the final
no-core-Git assertion fails (38.95 seconds). The failure is retained in
`/tmp/core-git-frame-native-red.log`; its latency samples were collected during
other functional work and are not performance acceptance. The POSIX ownership
shim explicitly skips Windows, bounds its fixture subprocess waits, and uses
private repositories, homes and tmux. Final extracted-source ownership and
kill/restart cases remain pending.

## Final combined acceptance, 16 November

The shared frame publisher and Git producer are accepted together. Clean source
`87973e8cb24807a16688e15f47060130b3343278` passed independent review, TypeScript,
the core (4,856), harnessd (371), portability (1,069), PTY (14) and Resume (484)
gates, with required per-file coverage at 100%. Existing skips remain reported.
There are 150 boundary/launch/frame checks and 29 passing native cases across
workspaces facts, process failures, folders, creation and forks. The original
parked-service assertion expected an obsolete core Git probe; its corrected
placeholder check also verifies the repository's actual branch is unchanged.
The original 28/29 run remains in the receipt. Two setup/cleanup fixture failures
were corrected with bounded asynchronous cleanup and a separate cold-import
deadline; no product deadline or behavior assertion was weakened.

Fixed costs compare Browser/input baseline `ab5e73f1` with runtime `13b2766e`.
Final `87973e8c` changes only three fixtures and history Design wording. Integration
of Browser `63003849` changes only a trailing blank line and documentation plus
main's already-validated Windows fixture. No production behavior changes after
the frozen cost source. The shared frame foundation's earlier CPU/RSS regression
remains recorded; these results accept the coherent frame/Git extraction, not
that foundation alone.

All 48 micro samples pass: eight pairs at each of 32, 128 and 512 rows, 100,000
complete projections after 10,000 warmups. Every pair's bytes/digest match.
Median paired projection CPU falls 54.6%, 56.4% and 56.3%; natural peak RSS falls
25.1%, 41.0% and 51.0%. These use cheap warmed probe/history stubs and exclude
process launch, filesystem, IPC and history serialization; they are not whole
daemon cost measurements.

Four native ABBA runs each use ten private agents and 60 list requests, with
stable process identities, output drainage and awaited cleanup. All pass:

| Native metric | Baseline median | Extracted median |
| --- | ---: | ---: |
| Core CPU | 865 ms | 765 ms |
| Edge CPU | 20 ms | 70 ms |
| Core + edge CPU | 885 ms | 835 ms |
| Core sampled peak RSS | 144.09 MiB | 138.18 MiB |
| Core + edge sampled peak RSS | 219.59 MiB | 215.25 MiB |
| List p50 / p95 | 3 / 28 ms | 3 / 3 ms |
| Tracked Git/SSH children, core / edge | 32 / 0 | 0 / 32 |

No retries or forced GC were used. CPU names only core/edge, excluding child
tools and other services. Two runs per side on this workload do not establish a
universal latency claim. Native proof is macOS x64 / Node 24.22.2; the ownership
shim skips Windows, and native Linux/Windows remain unverified. Automatic Linux
PR checks and final merge are still required. Receipt:
`/tmp/core-git-frame-final-acceptance.json`, SHA-256
`fcc840738a8c43180c59fe905aa3bc9dce6b4567f6ce1888e0634247cd6532a4`.
This closes the frame/Git implementation step after CI/merge; Browser streams,+wake policy and harness-index/manifest extraction remain separate work.


## Final CI fixture composition correction (2026-11-17)

Automatic CI `44014141479` failed seven `sessionGitPullRequest.spec.ts` cases.
The fixture still called the core's bare frame builder and expected it to inspect
Git and observe branch history. That call now correctly gives the documented
folder placeholder until workspaces publishes facts. The same seven failures
reproduce locally, with three other cases passing, in
`/tmp/core-git-frame-ci-session-pr-red.log` (4.70 seconds).

Compose the real `startWorkspaceFrames` producer in that existing fixture, retain
it across frame requests so display versions remain monotonic, and wait for its
bounded publication before building the frame. It reads the fixture's real Git
repositories, usage cache and history store. All existing branch, PR, history,
restart, moved-work and version assertions are unchanged. The producer stops
before fixture stores and roots are removed. No runtime, storage, contract,
capacity, deadline or golden bytes change.

The corrected PR/history/context/frame selection passes 36 tests in five files
(11.95 seconds), and TypeScript passes. Receipts:
`/tmp/core-git-frame-ci-session-pr-green.log` and
`/tmp/core-git-frame-ci-session-pr-types.log`. This is macOS x64 on pinned Node
24.22.2; the next automatic Linux PR run remains required. Prior runtime and
performance evidence is unchanged. The separate workspaces owner/lifecycle
selection passes 18 tests in 3.94 seconds (`/tmp/core-git-frame-ci-workspace-owner-green.log`).
No manual CI run or full-suite retry was made.
