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

## Done (in the WIP commit)

api.ts types and port changes; core/agentLife.ts; harnessd/services.ts `hears` + `HeldAgentLife`; main.ts wiring (hub,
`attach` replaces attachDsh/attachBrowser at create, fork, resume, start loop; agentEnded; `follow` in coreApi;
`follow_agents` answer; `agentLife.disconnected`; lifecycle stopped/purged; search notice; viewersLink.follow();
agentBrowserLink.follow()); create.ts, fork.ts, resumeAgentService.ts, lifecycle.ts (createAgentBrowserLifecycle deleted);
registry.ts and stoppedAgents.ts; viewersLink.ts, viewers.ts, viewersProcess.ts; agentCleanup*.ts; search*.ts;
agentBrowser.ts, browsers.ts, stateFile.ts, agentBrowserProcess.ts, agentBrowserLink.ts; agentQueries.ts;
lib/serviceMetrics.ts; services/followLink.ts.

## Left for PR 1, step by step

1. `core/agents/discovery.ts`: deps `attachDsh`+`attachBrowser`+`moveBrowser` -> `attach(session)` and
   `taken(from, to: RegisteredSession)`. onDiscovered: `attach(opened.entry)` (not only with dsh), evicted:
   `if (opened.isNew) taken(opened.evicted.agentId, opened.entry)`. `paneTaken`: keep the resume-reserved and saved-record
   checks, then `taken(previous, adopted)` (no flag). onObserved: `if (live) attach(live)` replacing both lines.
   main.ts already passes `attach` and `taken: (from, to) => agentLife.taken(from, to)`.
2. `harnessd/services.ts`: add `export function heldAgentLife(outOfProcess)` (main.ts imports it): the `hears` of every
   SERVICE_HOSTS entry, only for services in `outOfProcess`. Spec it (`npm run test:harnessd` is 100% per file).
3. agentTmp out of the core: drop `sweepAgentTmpWhenDue()` from `core/agents/create.ts` and `lib/launchOverrides.ts`;
   move `tempRoots()` from `lib/pathContainment.ts` into `lib/mediaPreview.ts` (its only caller, edge host), so
   pathContainment no longer imports `lib/agentTmp.ts`; sweep `agent-tmp` from the agent browser service (at begin and
   daily: `sweepAgentTmpWhenDue` / `sweepTmpFolders`). Note for the PR: Swarm-era `agent-tmp/<id>` folders on a machine
   that never runs the browser are no longer swept.
4. `npx tsc --noEmit -p .` in cli/ until clean; fix every caller and test fake. The first run on the WIP commit
   (only the first 60 lines were kept) found, beside the specs below:
   - `core/main.ts`: the new `const attach = (s) => agentLife.running(s)` (about line 1066) collides with an existing
     `const attach` (about line 1340, the transcript attach that has `.holdInterpretation`). Rename the generic one (e.g.
     `agentHere`) and pass it as `attach: agentHere` to create, fork, the lifecycle (resume) and discovery, and in the
     start loop (`for (const session of registry.list()) agentHere(session)`).
   - `core/main.ts`: `heldAgentLife` not yet exported by harnessd/services.ts (step 2).
   - `core/agents/discovery.ts:148`: still reads `evicted.browser` (step 1).
   - Specs that name the removed members: core/agentBrowserLink.spec.ts (ids, want, attached/stopped/deleted/moved,
     setBrowser, moveBrowser), core/agentCleanupLink.spec.ts (closed), core/agents/create.spec.ts and nativeCreate.spec.ts
     (attachDsh, attachBrowser), core/agents/fork.spec.ts (attachDsh), core/agents/lifecycle.spec.ts
     (createAgentBrowserLifecycle, sessionSearch, attachDsh, attachBrowser), core/api.spec.ts (ids, setBrowser,
     moveBrowser), and more past the first 60 lines (run tsc again without `head`).
5. Specs (write the failing test first, show red then green): `core/agentLife.spec.ts`, `services/followLink.spec.ts`;
   update `core/agentBrowserLink.spec.ts`, `core/agentCleanupLink.spec.ts`, `core/agentQueries.spec.ts`,
   `core/viewersLink.spec.ts`, `core/agents/{lifecycle,create,discovery,fork}.spec.ts`, `lib/resumeAgentService.spec.ts`,
   `lib/registry*.spec.ts` (setBrowser gone), `lib/stoppedAgents.spec.ts`, `services/{agentBrowser,agentBrowserProcess,
   agentCleanup,agentCleanupProcess,search,searchProcess,viewers,viewersProcess}.spec.ts`,
   `services/agentBrowser/browsers.spec.ts` (move on/adopted, stopAllBut), `harnessd/services.spec.ts`,
   `testing/fakeCore.ts` if a spec needs `follow`. Golden: the viewers' frames and dsh fields byte for byte.
6. `src/architecture.coreFiles.txt`: + `core/agentLife.ts`, `lib/hachiMetrics.ts` -> `lib/serviceMetrics.ts`,
   - `lib/agentTmp.ts` once step 3 is done; run `src/architecture.spec.ts` and `src/leanEntry.spec.ts`.
   Core before: 543 files, 92,994 lines (count with `node docs/design/2026-11-15-core-plan/tools/coreCount.mjs cli/src`).
7. Gates: `npm run test:core`, `npm run test:harnessd`, `python3 scripts/local-checks.py --list <paths>`, then e2e (never
   against the person's daemon; no tsc/vitest/edits while an e2e runs): `e2e/agentBrowser.e2e.ts`,
   `viewersProcess.e2e.ts`, `viewersOnDemand.e2e.ts`, `serviceProcesses.e2e.ts` (+ a browser failure-isolation case copied
   from it: browser process killed/down -> agents, frames, other panes fine, Browser says off), `services.e2e.ts`, the
   cleanup's and search's e2e. Known main failures: `agentBrowser.e2e.ts` window size, `sandbox.e2e.ts`,
   `agentClient.e2e.ts` folder trust, `hermesAdmission.e2e.ts` (2).
8. Docs in the same PR: cli/src/services/AGENTS.md (the agentBrowser row, the "On demand" askedSince line, a line for
   following agents), cli/src/core/AGENTS.md (agentBrowserLink line; add agentLife.ts), cli/AGENTS.md process table
   agentBrowser line, the audit doc (security item 1 and the stream line are this package's), and fix the comment in
   `lib/productUsageSignals.ts` that points at core/agents/lifecycle.ts for the Browser's Start refusals.
9. `/code-review high` on the diff, fix, commit, `python3 scripts/local-checks.py --run --base origin/main`, draft PR with
   red/green, core files/lines before and after, receipts; ready; report to the lead (8 lines max). Lead merges, then PR 2.

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
