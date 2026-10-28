# The core

The part of the daemon that must never go down: agents, terminals, transcripts, turns, input and
questions. Everything else is a service ([../services/AGENTS.md](../services/AGENTS.md)).

## Rules for a core module

1. **One factory per module, explicit dependencies:** `createX(deps)` returns the module's functions.
   Dependencies are passed in, never imported as live state, so the module is tested without a daemon.
2. **Only what every session needs.** A feature a session can run without belongs in a service. Ask
   before growing the core; the answer is usually a service and, at most, a new `CoreApi` member.
3. **Never import a service, `cli.ts` or `backendSocket.ts`,** except types
   (`import type { BackendSocket }`). The core calls services only through `CorePorts`, and every call
   has a fallback (`api.ts`). `src/architecture.spec.ts` checks it.
4. **Never wait on anything slow in line.** A request handler that reads a large file, runs a
   subprocess or calls the network must be bounded in time and memory: the October 3 crash was an
   attach that read an 803 MB transcript whole.
5. **100% coverage, per file** (`npm run test:core`), and an end-to-end test (`../../e2e/`) for any
   behaviour a person can see. The end-to-end suite has found every race fixed here so far: run it.
6. **The Swarm is a subsystem the core runs without.** `HARNESS_SWARM=off` (harnessd/swarmSwitch.ts, on by default)
   leaves the Super Tab service off and loads none of the Swarm's code, in the core or any service. So no core file
   imports anything of `../superTabs/` or `../lib/swarm*`, not even types. What the core needs of it is typed in
   `api.ts` (`SuperTabsCore`, `SuperTabsPort`, `SwarmAgents`, `SwarmLaunch`, `AdoptSwarmSkill`) and handed in by
   `main.ts` from `../superTabs/inCore.ts`; the services that act on it get their side from `../superTabs/inServices.ts`
   (`serviceProcess.ts`, or `main.ts` when they run here). Both are imported dynamically and only while it is on.
   Every such dependency is optional, and absent is exactly the daemon without the Swarm. `src/architecture.spec.ts`
   holds every import of its code to those doors and walks each process's imports; `src/leanEntry.spec.ts` checks the
   shipped build, and `e2e/swarmSwitch.e2e.ts` what each process loads.
7. **Evidence must be newer than the state it contradicts.** A scan, probe or read that began before
   a change must not be used to undo that change (see `terminalAgentReconciler.ts` `probedAs`,
   `routeTouched`, and `transcripts/relaunch.ts`). Most of the races found end to end were this.

## Where things are

- `agents/`: create, fork, restart, retarget, stop, resume, close, discovery, adoption, binding, the list.
  `agents/cloud.ts`: agents a service owns, the cloud agents: listed with the rest from what the cloud
  service publishes, their questions shown as a pane's are, the dial's turn cards made from what changes
  (working, then what it said), and New Harness, words, an answer, a rename and Stop Harness for one handed
  to its port (`cloudLink.ts` when it runs in its own process).
- `transcripts/`: attach (bounded reads from the end), ingest, live tail, relaunch marks, normalizers.
  Claude Code/Codex live interpretation is injected through `Engine.live`; core keeps parser handles
  and immutable turn snapshots, never edits their engine state. Supervised Claude Code/Codex parsers
  run in workers through [the live transport](../../../docs/design/2026-10-07-engine-streams.md).
- `turns/`: working/idle, the event funnel, cancel, heartbeats, hooks, and `recaps.ts`, the core's whole
  side of the recaps: the turn lifecycle it tells them, and what it reads back.
- `terminals/`: who controls a pane (the control lease), opening a terminal with a literal argv (`open.ts`),
  and the requests about a terminal itself (`requests.ts`: `terminal_info`, `theme_set`).
- `engines/`: hook coordination, reader ports and live worker coordination. Claude Code/Codex
  history, last-turn reads, live parsing, runtime profiles/catalogs and screen interpretation run in supervised workers; core passes snapshots,
  validates bounded replies, retains acknowledged cursors and owns binding/turn state. The explicit
  inline/older-master compatibility path is the only live parser or runtime profile implementation
  composition in core. Screen reads are bounded and fenced to the worker connection and session binding
  ([screen boundary](../../../docs/design/2026-10-08-engine-screen.md)). Core keeps accepted profiles and control authority; native model drivers run in workers through [revocable control grants](../../../docs/design/2026-10-08-engine-model-control.md), and so does question navigation ([question control](../../../docs/design/2026-10-08-engine-question-control.md)). Whether a typed prompt was taken is read there too: core keeps the writer, every Enter and the verdict ([submission](../../../docs/design/2026-10-08-engine-submission.md)). Codex's shared app-server is spoken to from its worker under a stop grant; core keeps the process table, identity and the stop's decisions ([native control](../../../docs/design/2026-10-08-engine-native-control.md)). Their hooks never go to a worker: each engine declares them as data, and core applies the declaration in line with `engines/kit` mechanics (installing settings, refusing a delegated session, correcting a transcript, closing a turn on Stop; [hooks](../../../docs/design/2026-10-08-engine-hooks.md)). Nor does their launch: Codex's startup probe and retry, its own-login provider, folder trust and the resume repair are declared data too, which core applies in the pane's argv and script and in the engines' files before a spawn ([launch](../../../docs/design/2026-10-08-engine-launch.md)). See [runtime profiles](../../../docs/design/2026-10-08-engine-runtime.md).
- `input.ts`, `questions.ts`: messages into a pane; an agent's question and its answer. Core matches an answer to the
  question on screen and holds the lease; Claude Code's and Codex's keys for each approved step come from their engine
  worker through a revocable grant (`engines/questionControls.ts`).
  `deviceInput.ts`: the pane writer lock every write takes, and a device's queued turns behind it.
  `cardText.ts`: an engine's error, rewritten for a device's card.
- `deliveries.ts`: delivered turns, the Wi-Fi device's, Agent Messages' and the orchestrator's: text written into an
  agent under a delivery id of its maker's, and what became of it, told back to that maker in its process.
- `updateHandoff.ts`: the core handing over to a build the updater staged (exit 75, when the master asks),
  and a core with no master handing itself to one. `updaterBeside.ts`: the updater started beside a core whose
  master is too old to run it, still in its own process.
- `stall.ts`: a test-only fault that holds the core's event loop still (`HARNESSD_TEST_FAULTS=core.stall:…`).
- `main.ts`: the core's entry (`harness __run`) and composition root, `runForeground`: it builds these
  modules, starts the services through `serviceHost` and wires the socket. While the Swarm is on it loads the Swarm's
  side of this process from `../superTabs/inCore.ts` (and `../superTabs/inServices.ts` for the services that act on it,
  when they run here) and hands it to the modules that take it; off, it leaves the
  Super Tab service off (`serviceHost.leaveOff`), whose requests are then answered `SERVICE_UNAVAILABLE`. The one core file that imports
  services and the socket, and the one outside the 100% coverage: wiring only, run end to end. The
  services that run in their own processes by default it imports only dynamically, through
  `../services/inline.ts`, and only when one runs in this process instead.
- `api.ts`: the contract with services, their ports, fallbacks and requests. `serviceHost.ts`: services
  in this process. `serviceLinks.ts`: services in their own processes. `viewersLink.ts`: what the core
  keeps of the viewers when they run in theirs. `viewerStreams.ts`: a client's viewer stream and rendered
  frames, handed to the viewers, refused at once while they are down, and held while they first start. `workspacesLink.ts`: what the core tells workspaces in
  theirs. `messagesLink.ts`: Agent Messages out of this process (the edge host): which of its deliveries may be
  written, as it last said, the few things it may ask (`MESSAGES_QUERIES`: the agents, this daemon, the account
  signed in here, the account's backend, its log's notice for the windows, shared tabs' keys and relay, whether its
  harnesses work (`activity`, with a one-line summary of what each does when asked), and that a
  roster changed), the desk's changes and changes to its switch (the account's, as the core keeps it), and the ask
  for it as the core starts. Its backend ask is held to `MESSAGES_BACKEND_ROUTES`, an allowlist of method and
  whole path (the tab listing and a tab's leader, and shared tabs' shares, rosters, invitations, members and moves): the process holds
  no credential, so every route listed there is a route that process could call as the account. `tab_key` and
  `tab_relay` pass one `TabKey` or `TabRelay` method a call to the gateway, which signs and seals and holds the
  sockets; `observers` hands a changed roster to Share (`harness_share_rosters`).
  `monitorLink.ts`: the monitor's port, asked of its process. `recapsLink.ts`: the recaps in their process,
  told each turn's lifecycle and never waited on, and read back from what they last said
  (`turns/recaps.ts` is the core's whole side of them). `storeLink.ts`: what the Store in its
  process tells the core. `agentCleanupLink.ts`: the agent cleanup in its process, told every stop and the person
  typing into a harness another agent started, and answered what it may close. `modelsLink.ts`: what the core keeps of models in its process for frames and
  keystrokes, and how it asks it the rest. `agentQueries.ts`: what a service in its own process may ask of the agents;
  `accountQueries.ts`: of the account (a token, and the fleet's lane's sealing), so it holds no credential.
  `experimentQueries.ts`: what an experiment acts on the core through; `experiments.ts`: which are on as the
  core starts, by their saved state, and the account's agent experiments kept for this computer's launches
  (`createAgentSettingsSync`, the one writer of `agent-settings.json`, which tells Agent Messages when its switch
  changes); `orchestratorLink.ts`: what the core keeps of the orchestrator in its own process;
  `sharingLink.ts`: Share's observers' frames to its process; `terminalWatch.ts`: a read-only view of the
  agents' terminals, which Share shows its observers. `conversationQueries.ts`: the conversation facts the
  change-agent handoff in the edge host asks for, one at a time.
  `gatewayLink.ts`: the relay and its E2EE in their own process (src/gateway/), as the core sees them:
  the link's state and the remote clients it reads in line, the frames it hands over in the clear, a
  window's sessions to another machine or a shared harness, and the fleet's lane's sealing
  (`core.account.lane`). `devicesLink.ts`: the devices in their own process (the dials, the window
  bridges, the fleet): what the core tells them, what it asks with a deadline and a fallback, and what it
  answers them. `wifi.ts`: the Wi-Fi device, as the core keeps it wherever its service runs (who said
  hello, which transcripts and streams it follows, the focus revision, and the check on every answer it
  sends a device); `wifiAgents.ts`: its doors into the core (the agents as it lists them, a prompt, an
  agent made for a Store harness); `wifiLink.ts`: its service in the devices' process. `devicesWake.ts`: when
  that process is asked for, once there is a device (a dial's port in /dev, a paired Wi-Fi device).
  `modelsWake.ts`: when models' process is asked for as the core starts, once grid is in use here.
  `gatewayWake.ts`: when the gateway's process is asked for as the core starts, before it binds: signed in, or
  anything paired here. `viewersWake.ts`: when the viewers' process (the viewers and the Store) is asked for: a
  harness here, or as the core starts, the release's own harnesses to put in place or viewer servers to stop.
