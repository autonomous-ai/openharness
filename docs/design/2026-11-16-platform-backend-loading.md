# Load the terminal host only when selected

Package 13 of [the core plan](2026-11-15-core-plan.md), following the
[loaded-code audit](2026-11-12-core-audit.md). This changes loading, not terminal
authority or the host protocol. The lazy boundary is implemented with focused caller and bundle checks; final
integration, native matrix, platform proof and matched cost remain open.

## Design

The normal macOS/Linux core uses tmux, but its static imports evaluate the PTY
client, launcher, drains and host moves. The same closure also arrives indirectly:
Windows process/account helpers import the launcher's binary locator; lifecycle
modules import the whole move implementation for one warning line. Cutting only
the direct imports would leave the implementation loaded.

Use one exact dynamic import from `core/main.ts` to a PTY composition module. Its
typed exports are the existing backend, drain, move and guest-host operations.
Open it when the configured backend names include `ptyhost`, not merely when
`process.platform` is Windows. Default macOS/Linux stays tmux; explicit PTY on
either remains supported; Windows still defaults to PTY. A Windows guest launch
may open the same door even when the owner explicitly chose tmux. The guest still
runs on its own account's host. An unavailable backend reports its existing
unavailable state; there is no fallback to another person's host.

Keep `MoveGate` and bounded handover flushing in the eager core: input is still
queued, released exactly once, and flushed before teardown. Move the lightweight
held warning and handover routine out of the implementation that performs moves.
Keep the host quiet clock behind the PTY door and preserve its input/activity
notifications whenever PTY is selected. Preserve preparation order, selected
create backend, drain attachment, orphan cleanup before adoption, move admission,
restart cancellation, probation readiness and disposal. Inline/Harness OS and
supervised callers use the same selection and existing contracts.

Extract the existing binary locator, version pointer reader and version-directory
validation into one shared `lib/ptyHost/binary.ts`. Keeping it beside `launch.ts`
preserves the source and bundled `import.meta.url` lookup location. All callers
use that one implementation; there is no second locator or altered search order.
Instance identity and generic input coordination remain eager. The host frame
codec and protocol implementation have no remaining cold value consumer and
load behind the same host door.

- Growth: no new persistent data, timers, queues or per-agent caches. The ESM
  loader caches one module; existing hosts and move queues retain their limits.
- Concurrency: selection stays in startup; existing backend preparation, per-agent
  restart locks, `MoveGate` and one-at-a-time host moves keep their authority.
  Guest connection promises remain one per account with failed entries removed.
- Read cost: no new scans. Binary lookup and host discovery run on their existing
  paths only; unrelated core imports no longer evaluate the host implementation.
- Scale: at 10x, backend/agent behavior is unchanged. Startup CPU/RSS and terminal
  echo latency are the first regression measures; source size is informational.
- Compatibility: no wire, storage or published contract changes. Keep all existing
  configured backend combinations, explicit PTY off Windows, old-host drains,
  current and older master behavior, inline mode and Harness OS support.
- Migration and rollback: none; reverting the import boundary restores eager
  loading without changing stored sessions, host instances or panes.
- Audience: unchanged core/backend checks. A module becoming lazy grants no new
  access; owner and guest hosts remain separated by the existing account checks.
- Identity: no launch/account change. Windows installed binary lookup still
  rejects caller-provided overrides where its current callers require that.
- Failure: existing named startup/unavailable, move/hold, guest and probation
  errors remain visible. No swallowed import error or silent backend substitution.
- Platforms: macOS/Linux default tmux and explicit PTY; Windows default PTY,
  explicit configured order and guest hosts. Native Windows acceptance requires
  the signed build and interactive-session window recording, not SSH alone.

## Enforcement and validation

Before runtime edits, add a genuine module-evaluation test importing the public
`runCoreInForeground` entry with forwarding mocks that record evaluation of the
real PTY launcher/drain/mover/guest implementation. The entry must be callable
without those modules evaluated; a direct PTY import is a positive control.
Vitest's existing isolated home/data/runtime setup applies; the test never starts
a daemon or opens a terminal. Add an architecture RED asserting the default
closure excludes the eleven implementation files while retaining gate, instance
and protocol contracts. Both fail against the original runtime.

The final architecture gate admits only `core/main.ts` → `core/ptyHost.ts` as
a dynamic edge;
static imports, imports from another caller and imports of another target remain
visible. Check the exact implementation closure reached after opening it, and
retain local-only network checks on that warmed closure. Update the exact cold
file inventory from the source graph, never by broad folder exemption. Exercise
real configured selection, default Windows, explicit PTY on macOS/Linux, mixed
backend order and Windows guests independently of the cold-entry assertion.

Root schedules all execution. Initial RED command from `cli/`:

```sh
node node_modules/vitest/vitest.mjs run src/core/platformBackendLoading.spec.ts src/architecture.spec.ts --maxWorkers=1 --reporter=verbose
```

After implementation: typecheck; affected binary locator/caller/peer-account and
Windows process tests; host/client/drain/quiet/move and generic gate/handover tests;
backend selection/recovery/coordinator and guest tests; core coverage and required
CLI gates selected from the final changed paths. Run terminal contracts and the
relevant private-daemon integration matrix. Independent review checks authority,
cancellation, input delivery and exact loading guards. No claim of platform
acceptance without that platform's evidence.

## Bounded baseline profile and workload

Freeze source, Node, dependencies and PTY binary hashes before collecting data.
The root has the original `ae81a1f077cd0567fb46a35eb21460d5e1a28d11`
shipping bundle at `/tmp/core-main-ae81-bundle/cli.js` and its build receipt at
`/tmp/core-main-ae81-build-receipt.json`. Compare that source to the reviewed
package head with the same bundle configuration and fixture input. Measure each
backend separately; never compare tmux against PTY as if it were before/after.

Each run uses a disposable home/data/runtime/auth/engine fixture, private daemon
endpoint and private tmux socket or PTY discovery directory. It must name and
clean only its recorded child PIDs/panes; inherited tmux/daemon/session variables
are cleared. Use the existing fixture helpers and bounded request deadlines.
Do not launch a real lab account or touch the person's daemon.

1. Before runtime edits, profile one real import of main's callable entry from
   the frozen source, without starting a daemon. The fixture at
   `.harness/validation/platform-backend-loading/baseline-v1/` builds a thin split
   ESM entry, pins source/Node/tool/artifact hashes, uses an isolated child with
   process/network tripwires, and records actual exit, EOF and owned-root cleanup.
   The inspector covers import only, with a 30-second child deadline. This is an
   import diagnostic; native startup/echo remain separate acceptance below.
2. For each backend, run one fixed ABBA block (base, candidate, candidate, base),
   exactly four runs total, one fresh start per run and two runs per side, with a
   30-second startup deadline
   and a bounded 10-second idle sample after ready. Report every run and medians;
   do not rerun selectively or claim statistical confidence from a small sample.
3. On one started fixture per side/backend, perform 64 sequential terminal echo
   request/acknowledgement cycles, deadline 5 seconds each, identical fixed-size
   content; record p50/p95/max, CPU/RSS, delivery count and ordered output. Close
   the terminal and stop the private daemon, each with a 10-second deadline.
4. Functional matrix (separate from timing): default tmux, explicit PTY, both
   configured orders, missing chosen host, recovery, old-host drain plus held
   input/cancel/stop, handover during a hold, and the existing inline/Harness OS
   modes. Reuse unchanged native receipts only for the source they cover.
5. Windows signed build: default PTY readiness and terminal I/O, explicit order,
   owner/guest account isolation, binary locator and process-start proof,
   host replacement/drain/cancel/handover, missing-host visible failure, disposal,
   and no unsolicited windows recorded in the person's interactive session.

Root ran the initial RED on 2026-11-16: two intended failures and 24 passing tests
in 11.51 seconds (`/tmp/core-platform-loading-red.log`). The actual core import
evaluated all four real implementation probes; the architecture closure reached
all eleven target files. The recorded baseline and fixture remain unchanged. Subsequent implementation
and evidence are recorded below; none establishes native platform acceptance.


## Implemented boundary and current evidence

The cold graph at base `ae81a1f077cd0567fb46a35eb21460d5e1a28d11`
has 541 files and 92,752 lines. The implemented cold graph has **530 files and
88,748 lines**, a reduction of 11 files and 4,004 lines. These are source graph
counts, not CPU or retained-memory measurements.

Fourteen original files leave that graph: the eleven initial implementation
targets, plus `lib/ptyHost/protocol.ts`, `lib/guestRunner.ts` and
`lib/terminalEnvironment.ts`. The initial test assumed the protocol file still
had a cold consumer. Inspection and the exact closure showed that its frame
reader/encoder is used only by the host implementation; retaining it would add
an otherwise unused import. The guest command runner and environment scrubber
leave transitively. No identity or protocol contract changes. Three small
shared helpers replace the former eager imports: the unchanged binary locator,
held-agent warning and bounded input handover. No old forwarding export remains.

Opening the host door adds exactly those fourteen files and `core/ptyHost.ts`
to the cold graph, giving 545 files and 92,774 lines. The test enumerates all fifteen, rejects
static access or a dynamic edge from another importer/target, and checks the
local-only network rule across both the cold and warmed graphs. Configured
startup retains the same backend preparation/selection, drain, orphan cleanup,
restore, move and probation behavior. The first Windows guest can open the same
door even with an owner using tmux; import or preparation failure reports the
existing unavailable state and evicts its failed per-account cache entry.

Before runtime edits, the frozen baseline import diagnostic passed on macOS
x64, Node 24.22.2. Manifest
`/tmp/core-platform-import-baseline-v1/manifest.json`, SHA-256
`9f0203426a3f231bb3bf2aa592d8847ef8e6ae48901586104a7925169a806319`.
The callable entry imported once in 109.544 ms wall time and 124.339 ms CPU;
RSS was 57,978,880 bytes before and 90,013,696 after. The CPU profile's largest
self-time was ESM compilation (52.483 ms); inspector work and module
initialization also appear. There were zero process/network tripwire attempts,
and child exit, output EOF, PID/group absence and private-root cleanup passed.
This single profiled import is diagnostic only, not a before/after performance
comparison or native startup proof. Its historical eleven-target manifest is
not rewritten to match the final fourteen-file closure.

Validation retained under `/tmp/`:

- Original actual RED: two intended failures, 24 controls passing in 11.51 s,
  `core-platform-loading-red.log`.
- The first extraction checks passed real entry loading but failed on the
  initial protocol assumption and the still-unupdated inventory. One inventory
  update command also used the wrong working-directory-relative path. Both
  partial failures are retained as `core-platform-loading-green-first.log`
  and `core-platform-loading-green.log`; no passing result is claimed for them.
- Corrected source graph and entry check: 26 passed in 7.51 s,
  `core-platform-loading-green-final.log`.
- Focused controls first ran in the sandbox. Private socket binds failed with
  `EPERM`; peer lookup cases then reached their 30-second deadlines. The exact
  owned Vitest process was interrupted, its log owner disappeared and its
  private run root was removed. `core-platform-focused.log` retains the failure.
  Four completed files retained 170 passing cases (external resume 39,
  lifecycle 47, restart 52, updater 32); they were not rerun.
- Only the other 26 blocked/unstarted files ran natively, with one worker and
  a 300-second outer deadline: **556 passed, four existing skips, 33.36 s**,
  `core-platform-focused-native.log` and `.json`. Together the focused controls
  cover 726 passing cases and four skips across 30 files. This is combined
  evidence after an environment failure, not an uninterrupted passing run.
- TypeScript found one missed qualification of the moved drain predicate in
  restore wiring (`core-platform-types.log`). The selected-module call was
  corrected; TypeScript then passed (`core-platform-types-final.log`).
- Final entry/architecture and five new shipping-bundle checks: **31 passed**
  in 33.41 s, `core-platform-loading-bundle.log` and `.json`. The 20 unrelated
  lean-entry cases were deliberately not selected, so this is not a full
  lean-entry suite pass. Each host implementation marker is present in the
  shipped bundle but absent from the cold core's actual bundle import graph;
  the positive source control opens the actual `core/ptyHost.ts` door.

No full local coverage gate, native default-tmux/explicit-PTY daemon matrix,
matched startup/idle/echo performance comparison, Linux execution or signed
interactive Windows proof has run for this implementation. Current-main
integration and independent review remain required before a PR can be ready.
The core plan and closure-count helper now recognize this exact door; they do
not exempt a whole folder or all imports from `core/main.ts`.

## Integration on 18 November

The session integration reuses `b7cf2daa4d55d7a9eea28ddc1e44549e58a39197`,
the actual extraction commit behind the later `adff953838` merge. It keeps the
newer shared-input cancellation rules: the moved handover helper still refuses
remaining input through `MoveGate.refuseAll`, and the core retains its existing
refusal callback, restart cancellation and terminal-control invalidation. It also
keeps the integrated launch settings, service metrics and Browser lifecycle
boundaries. No old implementation is reintroduced to resolve the conflicts.

The earlier validation section records the original extraction only. Subsequent
macOS extended-echo evidence exists at `/tmp/core-platform-extended-v1/summary.json`
for `cd93` versus `adff`, with eight completed runs and recorded cleanup. All
1,024 echoes per run completed. Tmux p95 was 8.706/8.747 ms for the baseline
and 7.523/7.950 ms for the candidate, but the first candidate retained a
107.189 ms maximum. PTY p95 was 5.450/5.349 versus 5.488/5.379 ms. Startup wall
time increased by 3.531–50.521 ms across the four pairs; the PTY CPU results
were mixed. These source-scoped results do not clear the cost hold, do not
cover this combined source, and do not provide Linux or signed Windows proof.

Combined source/bundle loading, host move refusal/cancellation, lifecycle,
backend and locator callers, and TypeScript checks are selected before running.
Their receipts will be recorded here; none has passed on this integration yet.

The first combined run at `60b8cc2929` passed 762 affected cases (four existing
skips), TypeScript and the full release-bundle file, including its real service
loading and broken-artifact controls. The overall receipt failed because two
architecture assertions still listed `lib/windows/treeKill.ts` as eagerly loaded.
Its remaining value consumer is now the selected PTY implementation; the current
launch extraction had removed the other eager route. The exact warmed list gains
that file and the cold inventory loses it. This is an inventory correction with
no further runtime change. The failed receipt is retained at
`.harness/validation/20261117T233634.407396Z-47883/receipt.json`; only architecture
needs a follow-up run.

## Complete backend selection in both directions

The combined default entry still evaluates `lib/tmuxBackend.ts` even when only
PTY is configured. That implementation has one production value importer in
core: `main.ts`. Use a second exact dynamic edge from that existing composition
point to the backend module, opened only when the configured list includes
`tmux`. Keep the same backend instance, preparation order, recovery callback and
selected-backend test. Do not add a wrapper module, configuration flag or runtime
factory. Existing shared tmux mechanics still used by core stay eager; this
change does not claim that all tmux-related helpers disappear on Windows.

This extends the existing design without storage, wire, audience, identity,
retention or rollback changes. Import failure retains startup failure behavior;
there is no fallback to an unselected backend. The platform and cost acceptance
requirements above still apply. Add an actual module-evaluation RED for tmux
before changing runtime, then extend exact source and shipping-bundle boundaries.

The expanded real module-evaluation test failed before this change: the core
entry evaluated `tmux` (one intended failure, actual exit 1, 13.0 seconds).
Receipt: `.harness/validation/20261117T234109.225140Z-52390/receipt.json`.
The runtime edit only selects the existing tmux module at configured startup;
its backend implementation and shared helpers are unchanged. The cold closure
now also omits the backend, stream, history rewrap and SGR carry modules. The
PTY door retains the last three because it uses their shared snapshot helpers;
this does not claim that the PTY implementation loads no tmux code. The final
selected-backend checks are running; no new native or cost pass is implied.

The selected-backend follow-up passed 77 caller/loading checks, all seven
selected bundle boundaries and TypeScript. Three architecture assertions still
omitted the terminal key table and cell-width helper from the newly lazy
closure. Those exact two transitive files are now listed with both selected
backends and removed from the cold inventory; runtime is unchanged. The failed
receipt remains `.harness/validation/20261117T234312.940268Z-54184/receipt.json`.
A final architecture run is pending the coordinated quiet benchmark slot.
