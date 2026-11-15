# Agent Browser out of the daemon core: notes to finish it

Package: take the Agent Browser out of the daemon core (anh Dee 2026-11-14: "move agent browser to a regular pane. but
again it's a subcompoennt not part of daemon core"). Read first: the plan's rules and lessons
([../2026-11-15-core-plan.md](../2026-11-15-core-plan.md)), AGENTS.md, cli/AGENTS.md ("Protect the core"), cli/src/core/AGENTS.md, cli/src/services/AGENTS.md,
docs/design/2026-11-12-core-audit.md (security item 1, the browser stream line).

- Branch `core-browser-out`, worktree `.claude/worktrees/core-browser-out`, based on
  origin/main d50957ac3c. cli deps installed there (`npm ci`). Pushed as a WIP commit, no PR.
- Desktop keeps today's wire (another agent builds the Browser as a regular pane in Desktop, branch
  `desktop-browser-pane`, Desktop only). Keep byte for byte: the `agent_browser_*` requests, the agent frame's `browser`
  field `{state, step?, error?}`, the stream (`agent_browser_open` -> `agent_browser_open_result {requestId, streamId|error}`,
  `agent_browser_ack {streamId, bytes}`, `agent_browser_close {streamId, reason}`, kind-8 binary frames both ways), and
  `harness browser`'s `agent_browser_run {pane, ancestors, command, args}`.
- Fact found: no released Desktop can reach the Browser now. Its only button was in the Swarm chat (deleted 11-15).
  Desktops 1.4.30-1.4.38 (11-10/11) sent `agent_create {browser: true}` only from the Swarm's New agent.

## Design decided (the lead chose B for both PRs)

Rule 7 bars a core mechanism only one component uses. A generic shape is fine once it replaces per-service ports. So:

- **PR 1 (lifecycle + flag):** one generic agent-lifecycle shape, `follow_agents`, used by the browser AND the viewers
  (their attach/detach), the agent cleanup (`closed`) and search (`deleteHistory`). Delete `ViewersPort.attach/detach`,
  `AgentCleanupPort.closed`, `SearchPort.deleteHistory` and `AgentBrowserPort`'s lifecycle members. The browser keeps whose
  Browser is on in its own state file. Counters and the pane proof go generic.
- **PR 2 (frames + stream):** generic per-agent *frame parts*: `ViewersPort.frameContext` (the dsh context) and
  `AgentBrowserPort.frameContext` both move onto it, the old members deleted (the git agent will later put frames' git
  facts on the same shape: it waits for this). Then the stream: make `core/viewerStreams.ts` a generic client-stream relay
  that the viewers and the browser both use; `core/agentBrowserLink.ts` and `core/browserStreams.ts` then go entirely.
- Golden tests the lead asked for: the viewers' frames and the dsh fields byte for byte before and after; plus the
  viewers' e2e (`viewersProcess.e2e.ts`, `viewersOnDemand.e2e.ts`) and `serviceProcesses.e2e.ts`.

### The generic shape (PR 1), as built

- Types in `core/api.ts`: `AgentLife` =
  `running {session}` (every look at a live agent: create, fork, resume, a start's restore, every scan) |
  `ended {agentId}` (stopped running: a stop, any forget, an engine's own exit; told to a follower told it running) |
  `stopped {agentId}` (a person's or an agent's stop, once done) |
  `purged {agentId, sessionIds}` (deleted for good, every conversation) |
  `taken {from, to, guest?}` (a new agent took the pane `from` ended in: decision 19).
  `FollowOptions` = `{ each?: boolean (every look, else once per run), having?: string[] (row fields that must be set,
  max FOLLOW_HAVING_MAX=4), running?: boolean (false: never told running/ended) }`.
  `CoreApi.agents.follow?(listener, options) => unsubscribe`. `VIEWERS_FOLLOW = { each: true, having: ['dsh'] }`.
  `HeldAgentLife = 'stopped' | 'purged' | 'taken'` is defined in harnessd/services.ts and re-exported by api.ts (the
  master may import nothing but its own folder).
- Hub `core/agentLife.ts` (new, no spec yet): `createAgentLife({ live, notify, hears, log })` with
  `running/ended/stopped/purged/taken`, `follow` (in-process: catch-up told at once, listener guarded by try/catch),
  `followed(service, payload)` (a process's `follow_agents` query: validates options with `followOptions`, keeps one
  subscription per service, answers `{agents}` catch-up), `disconnected(service)`. Per follower a `told` set (agents told
  running, bounded; pruned to live past TOLD_PRUNE_AT=4096). running: skip if `running===false` or `having` not matched;
  once-mode skips agents already told. stopped/purged/taken: to every in-process listener, and `notify(..., {untilDelivered})`
  to each out-of-process service whose `hears` names the kind.
- Static held kinds, in `harnessd/services.ts` SERVICE_HOSTS `hears` (deleted with "its process"): search
  `{ search: ['purged'] }`, edge `{ agentCleanup: ['stopped'] }`, agentBrowser `{ agentBrowser: ['purged', 'taken'] }`.
  The viewers need none: their catch-up finds a missed end.
- Process side `services/followLink.ts` (new, no spec yet): `followLink(options)` gives `follow` (CoreApi shape), `heard(payload)`
  (an `agent` service_event), `connected(query)` (asks `follow_agents` unless `running:false`, catch-up diff with a
  `heard` set exactly as viewersProcess did), `disconnected()`, `ready(ms)` (first catch-up of this connection in).
- Why `each` exists: the viewers' attach must stay "every look" (a look may first find an agent's dsh; a viewer restarts
  on a harness update because `DshViewerManager.start` keys on dsh+viewer+workspace). The browser uses once-per-run so an
  idle daemon's 5 s scans cost it nothing.

### The browser's own state (PR 1)

- `agent-browser.json` gets `on: Record<agentId, true>` (Start sets, Stop clears) and `adopted: Record<agentId, true>`.
- Migration, once per agent, lazily: every `running` event whose row still carries the legacy `browser: true` is taken
  in once (`adopt`: `on[id]=true`, `adopted[id]=true`). This also keeps the old Desktop `agent_create {browser: true}`
  working (the core still writes the legacy row field at create only). Dated: delete on/after 2026-12-18 with the row field.
- The registry keeps the legacy `browser` field: parsed, carried by the bind, written only at an old Desktop's create,
  never set or cleared otherwise (`setBrowser` deleted; `evicted.browser` deleted; `releaseEngine` still drops it from the
  shell under a new id). Rollback: an older build finds every row flag as it was at the update; Starts/Stops made under the
  new build are not in the rows.
- Service (`services/agentBrowser.ts`): follows agents (`core.agents.follow(heard)`): running -> `live.set`, `adopt`,
  `startFor` (not a guest's, on, not yet started); ended -> `notices.ended`, stop if started; purged -> delete (or `forget`
  on/adopted); taken -> `notices.ended(from)`, move unless guest or `to` is on. Start: shown? retry/ok; else await
  `followed()` (not caught up -> `{error:'SERVICE_UNAVAILABLE', retryable:true}`, never read as "not running"), `live.get` ->
  NOT_RUNNING / NOT_ALLOWED (guest), `setOn(true)`, counts, `startFor`. Stop: stop line, `setOn(false)` (a write failure is
  logged, the browser still stops), stop. `byPerson` removed. Options `followed` and `everyAgent` (in its process:
  `follow.ready(10 s)` and the generic `agents` query). `begin()` finishes recorded purges, sweeps unlisted containers
  without deleting volumes, then `browsers.stopAllBut(attached || live&&on)` stops a browser left running for an agent
  that ended while both processes restarted. A readable agent list cannot authorize deleting an omitted profile.
- `browsers.ts`: `move` also moves `on[from] -> on[to]` and marks `adopted[from]`; `remove` drops `on`/`adopted`;
  new `stopAllBut(wanted)`.
- Process (`agentBrowserProcess.ts`): `followLink({})`; queries now only `browser_state`, `streams` (kept for PR 2),
  `agent_of_pane`, `count`, `agents` (all generic, answered by `core/agentQueries.ts`); removed `agent_ids`, `set_browser`,
  `move_browser` and the old events from the current protocol. A dated process-only adapter still accepts an older
  core's `attached/stopped/deleted/moved`, including its `move_browser` handshake after a move.
- Core link (`core/agentBrowserLink.ts`, until PR 2): only frame states + streams. It follows the hub in-process
  (`agentBrowserLink.follow()`, called in main.ts when the browser runs out of process): keeps states only for live
  agents; an `ended` drops the state and re-syncs the frame. Its unknown queries fall through to `answerAgentQuery`.
  `wakeAgentBrowser` still there (PR 2: make it generic, e.g. a `SERVICE_HOSTS` wake-state field fed to `wakeExperiments`).

### Generic queries / counters (PR 1)

- `core/agentQueries.ts` now answers `agent_of_pane` (moved from the link) and a generic `count` checked against
  `SERVICE_METRICS` in `lib/serviceMetrics.ts` (git mv of `lib/hachiMetrics.ts`: Hachi's daemon metrics + the browser's).
  Say in the PR: the browser's counter names stay in the product-usage vocabulary, which the audit's vocabulary row
  moves to the gateway.

### Viewers, cleanup, search on the shape (PR 1)

- viewers: `ViewersPort` lost attach/detach; `VIEWERS_FALLBACKS` updated. `startViewers` follows with `VIEWERS_FOLLOW`
  (running -> attachDsh, ended -> detachDsh; stop() unfollows). viewersLink: `follow()` (called in main.ts when out of
  process) keeps `attached`/`known` and wakes the viewers' process on a dsh agent; its `agents` answer is gone.
  viewersProcess: asks `follow_agents {each:true, having:['dsh']}` at connect (catch-up as before), handles
  `{kind:'agent', event}` running/ended; `viewersCoreApi(..., follow)` hands the service's listener to the process.
- cleanup: `AgentCleanupPort.closed` gone; `createAgentCleanup` follows `{running:false}` and closes on `stopped`;
  agentCleanupLink no longer sends `closed`; agentCleanupProcess uses `followLink({running:false})` + dated shim
  translating an old core's `closed` event (delete on/after 2026-12-18).
- search: `SearchPort.deleteHistory` gone; `startSearch` follows `{running:false}` and deletes each purged session id;
  searchProcess uses `followLink({running:false})` + dated shim translating an old core's `deleteHistory` event.
  lifecycle.ts no longer takes `sessionSearch`; `purged(agentId, sessionIds)`.

## PR 1: done (branch `core-browser-2`)

Everything above, finished: `core/agents/discovery.ts` on `attach` and `taken`; `heldAgentLife()` in
`harnessd/services.ts`; `lib/agentTmp.ts` out of the core (`tempRoots` beside its one reader, `lib/mediaPreview.ts`; the
agent browser sweeps `agent-tmp` as it begins and as an agent runs a command); specs at 100% (`core/agentLife.spec.ts`,
`services/followLink.spec.ts`, and every spec that named a removed member); the docs. Found on the way and fixed:

- `follow_agents` is answered after Agent Messages' own answers, so it reads no more than it did (`live` rows).
- A purge of an agent whose browser was starting (attached, not yet in the state file) deleted nothing: the browser is
  deleted when it was started, or when the file cannot be read (the delete says why).
- A purge of an agent that never had a Browser wrote the state file, which then started the process at every start.
- `agent_browser_enabled` is counted at an agent's first start again (the old Desktop's create included).
- The process is still asked for by an agent whose row carries the flag from before (an old Desktop's create, a row not
  yet taken in): `core/agentBrowserLink.ts` `want`, dated 2026-12-18. **PR 2 must keep it** when that file goes (or drop
  it after the date).

Compatibility decided: a service of this build under a core from before (a newer master after a rollback) keeps
working: the viewers (`agents` and `attach`/`detach`), the cleanup (`closed`), search (`deleteHistory`) and the agent
browser (`attached`, `stopped`, `deleted`, `moved`), each dated 2026-12-18; only a new Start answers
`SERVICE_UNAVAILABLE` there (no released Desktop reaches it). A core of this build under services from before needs a
master that does not stop its services at an update, one from before 2026-10-05 (#791 re-executes the master with its
services stopped first), outside the 30 days: not handled.

From `/code-review high`, fixed: the browser's process waits for its catch-up before it asks which agents are here (as
it started it asked before connecting, which was no answer, and kept gone agents' browsers); a stopped agent's flag from
before goes with its pane (`move` takes it in first); a follower in the core's process that fails 5 times is dropped,
said once; the browser's link answers only the generic questions its process uses; unused exports. Left, said why in
the PR: `agent_of_pane` and the counters are generic (no data `live` does not give, and counters are measures); the
state file read per new run (in the browser's own process by default); the old row flag still asks for the process
until 2026-12-18 (a state file would anyway); `viewersProcess.ts` keeps its own catch-up beside `followLink.ts`: **PR 2
moves it onto `followLink`**, with the viewers' e2e as the proof.

## PR 2, after PR 1 merges

- Frame parts: a generic per-agent part a service sets (in-process call / `service_query` from its process), bounded,
  only fields its SERVICE_HOSTS entry declares, kept only for live agents (drop on `ended`, as viewersLink and the
  browser link do now), merged into `lib/agentFrame.ts` frames. Move `ViewersPort.frameContext` (dsh context -> dsh,
  dshName, viewerUrl, viewerName, verdict, with today's null fallbacks byte for byte) and `AgentBrowserPort.frameContext`
  onto it; delete both members and `browserFrameRef` in main.ts. Golden frame tests first.
- Stream: generalize `core/viewerStreams.ts` into a relay both use, keeping the browser's guarantees from
  `core/browserStreams.ts`: answers only to a connection with that pending open or holding that stream; screen bytes routed
  by the stream id in the frame, never by a connection the service names; the core's own bounds (open unanswered 10 s ->
  NOT_READY, >1 MiB unacked -> close `backlog`, a failed input ends the stream `agent`, all closed when the service goes);
  frames passed unread (measure the core's CPU per byte before/after: the first move cost +80% by re-framing).
  The gateway's `browserRoute/browserRouteLost/browserTransportError` (`GatewayEvents`, core/gatewayLink.ts) must leave the
  core too: e.g. the gateway sends them as stream frames on the stream's connection (and refuses that type from clients),
  which the relay passes on. Then delete `core/agentBrowserLink.ts`, `core/browserStreams.ts`, `AgentBrowserPort`,
  `BrowserRoute`, `mayOpenBrowser` (the open's asker check can move to the service: it gets the asker), the browser bits
  of `backendSocket.ts`, `CoreApi.clients.browserFrame/browserBytes`, and make `wakeAgentBrowser` generic.
- Keep: `core/terminals/browser.ts`, `lib/browserShim.ts` (the sign-in BROWSER shim, not the Agent Browser).

## Continuation, 15 November (Codex)

PR #4320 is being completed from `codex/core-browser-continue` in an isolated worktree. Main `aad8dcd535` is integrated:
the discovery and resume conflicts keep both the generic lifecycle and main's removal of process-environment reads.

CI run 43679841924 failed because the startup spec rejected a read-only `podman ps` call if it arrived before the
assertion. The spec now waits for that listing, permits exactly it, and still rejects any unrequested change to a
browser or profile. Waiting without changing the assertion reproduces the failure; the corrected test passes.

Review also found that `followLink` retained ended agent ids until the next connection. Only an outstanding catch-up
now keeps the ids needed to protect its answer from newer events. The core's scan callback is allocated once, and
an agent already known to a follower is not reinserted or pruned at each look.

Remaining before merge: final coverage receipts, integration checks, the exact-head CI run and the performance
comparison. The earlier isolated scan measurement was slower than main; a full isolated-daemon comparison is being
recorded as well. Package 2's frame parts and stream work remain step 2.

## Review corrections, 2026-11-15

Design before code:

- Growth/deletion: a readable agent list is not a complete identity inventory: corrupt saved records are omitted.
  Startup finishes only deletions already recorded in the Browser state file; an explicit purge still removes the
  profile. A profile whose purge notice was lost across a full daemon outage is retained, rather than guessing that
  its omitted record was deleted. Running containers without a live owner are stopped, retaining their volumes.
  This intentionally favors preserving logins over reclaiming an uncertain orphan; no new core inventory or port.
- Concurrency: pending Starts carry per-request identity, invalidated by a later Stop/end/purge. A person's Start or
  Stop also completes legacy flag adoption, so a late row cannot reverse that choice. Both agents' move queues are
  reserved before the migration lookup; consecutive pane changes stay ordered.
- Read cost/scale: startup no longer queries/parses all agent rows to decide deletion. Pending intent is retained only
  during the bounded catch-up wait. The existing per-agent queues serialize work; no poll or global lock is added.
- Compatibility/migration/rollback: the dated old-core move adapter carries destination/on data and completes the
  `move_browser` handshake before restoring the destination. It lives solely in the Browser service/process and can
  go on 2026-12-18. Existing Browser state schema and older-build rollback stay unchanged.
- Audience/identity: existing owner and guest checks remain authoritative. No credential or login is copied.
- Failure: an unavailable legacy core leaves the moved profile stored and logs the existing named move failure.
  Corrupt saved-agent metadata cannot trigger volume deletion.
- Platforms: macOS/Linux Browser service; Windows remains unsupported. Isolated fake Podman/service fixtures cover
  the races; bundled daemon e2e and core coverage are required before merge.

Validation of these review corrections (before the parent's next main integration):

- Node 24.22.2, macOS, isolated fake Podman/service fixtures. The five new regression cases failed on
  `b9359d3ac9025838c2700f6a4cd2394b5fac7db2`: missing-profile deletion, Start/Stop, late legacy adoption, consecutive
  pane moves, and the old-core move handshake. Raw red output: `/tmp/core-browser-review-red.log`.
- Green: 218 tests in `agentBrowser.spec.ts`, `agentBrowserProcess.spec.ts`, `agentBrowser/browsers.spec.ts`, and
  `agentBrowser/containers.spec.ts`; all four implementation files at 100% statements/branches/functions/lines
  (934 statements, 570 branches, 224 functions, 709 lines). Raw output: `/tmp/core-browser-review-coverage.log`.
  These include cancellation on end/purge/pane takeover/service stop, two pending Starts, malformed legacy moves,
  unavailable/refused/timed-out/stale core replies, and keeping an off profile without starting it.
- Node 24.22.2 typecheck passed; no core file or import was added. No full-suite receipt or final-head e2e is claimed:
  the parent must integrate current main, review the combined change, and run the remaining required acceptance.
- A second ordering issue exposed by the consecutive-move regression is fixed too: a queued Start for B, not yet
  published as state, is cancelled when B's profile moves to C; it cannot recreate B after the move.


## Stop during a pending move, 16 November

Design before correction: a move may wait for the legacy flag lookup or the old container to stop. A Stop of its
destination during either wait must remain off after the profile moves. Keep the profile transfer and its ordered
queues; transfer the source's on flag only while the destination's existing start generation is current. A Stop
also reaches a queued browser operation even before that operation has published a browser state. Reuse the existing
queue and generation maps; add no retained intent table, timer, stored field or core mechanism. The later Stop stays
in the existing state file, so older-build rollback sees it too. Owner/guest checks, private profile ownership,
process boundaries and macOS/Linux support are unchanged. Test both waits with explicit barriers before changing
production code; existing move/Stop coverage and required gates must pass. This fixes the extraction's cancellation
boundary; it adds no Browser feature. No new read, poll or frame-path work is introduced.


The two destination-Stop regressions failed against c7a8992f99 (3.51 s): both waits restored `on.b1` after Stop.
The correction reuses the destination generation and notices queued work before state exists. Native targeted
validation passes all 220 cases across the same four files at 100% coverage (937 statements, 573 branches,
225 functions, 711 lines); Node 24.22.2 typecheck passes. The first broader attempt was sandbox-invalid: four
loopback proxy fixtures received `listen EPERM`; its 216 passes and four failures remain in
`/tmp/core-browser-destination-stop-green.log`. The corrected native run is
`/tmp/core-browser-destination-stop-native-green.log`, and the true behavior red is
`/tmp/core-browser-destination-stop-red.log`. Current-main integration and final gates remain with the coordinator.

## Credential boundary integration, 16 November

The metadata projection in #4349 replaces Browser/viewer attach calls that this extraction removes. Keep the
generic lifecycle instead: project matching catch-up rows and each emitted running event through `agentView`,
after the existing known/filter checks. Authoritative input rows stay unchanged. A follower receives a copy even
when the row has no key yet, so a later saved credential cannot enter its retained metadata. Unobserved scans,
known once-only followers and excluded rows perform no projection. `taken` already carries only ids and an
optional guest flag. Main's direct viewer frame-context callback also retains its projection.

This combines the existing custody Design without adding storage, ports, timers or migration. Inline and process
catch-up regressions failed first (2 failed, 1 unchanged scan case passed, 0.86 seconds). The resulting five-file
integration selection passes 116 tests in 2.61 seconds; Node 24.22.2 typecheck passes. Two intermediate runs exposed
obsolete test calls to the removed Browser reconnect and viewer agents-query adapters; both fixtures now exercise
the generic follow path, with all output assertions retained. Logs: `/tmp/core-browser-custody-red.log`,
`/tmp/core-browser-custody-green-combined.log`, `/tmp/core-browser-custody-typecheck-final.log`.

The bundled credential test now subscribes through `follow_agents` and verifies the replacement running event and
reconnect catch-up. Its combined-source native run, independent review of the coordinator's changes, full required
gates and updated performance comparison remain pending. Earlier #4349 native evidence covers its original direct
attach path, not this replacement path.
