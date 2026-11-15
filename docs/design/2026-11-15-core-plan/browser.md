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
  `follow.ready(10 s)` and the generic `agents` query). `begin()` reconciles with `everyAgent` (deletes browsers of agents
  in neither list, as before) and then `browsers.stopAllBut(attached || live&&on)` (new: stops a browser left running for
  an agent that ended while both the process and the core restarted).
- `browsers.ts`: `move` also moves `on[from] -> on[to]` and marks `adopted[from]`; `remove` drops `on`/`adopted`;
  new `stopAllBut(wanted)`.
- Process (`agentBrowserProcess.ts`): `followLink({})`; queries now only `browser_state`, `streams` (kept for PR 2),
  `agent_of_pane`, `count`, `agents` (all generic, answered by `core/agentQueries.ts`); removed `agent_ids`, `set_browser`,
  `move_browser` and the old `attached/stopped/deleted/moved` events.
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
