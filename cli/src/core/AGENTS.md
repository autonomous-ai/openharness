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
6. **Evidence must be newer than the state it contradicts.** A scan, probe or read that began before
   a change must not be used to undo that change (see `terminalAgentReconciler.ts` `probedAs`,
   `routeTouched`, and `transcripts/relaunch.ts`). Most of the races found end to end were this.

## Where things are

- `agents/`: create, fork, restart, retarget, stop, resume, close, discovery, adoption, binding, the list.
- `transcripts/`: attach (bounded reads from the end), ingest, live tail, relaunch marks, normalizers.
- `turns/`: working/idle, the event funnel, cancel, heartbeats, hooks, and `recaps.ts`, the core's whole
  side of the recaps: the turn lifecycle it tells them, and what it reads back.
- `terminals/`: who controls a pane (the control lease), opening a terminal with a literal argv (`open.ts`),
  and the requests about a terminal itself (`requests.ts`: `terminal_info`, `theme_set`).
- `engines/`: the engines' hooks.
- `input.ts`, `questions.ts`: messages into a pane; an agent's question and its answer.
  `deviceInput.ts`: the pane writer lock every write takes, and a device's queued turns behind it.
  `cardText.ts`: an engine's error, rewritten for a device's card.
- `deliveries.ts`: delivered turns, the Wi-Fi device's, a team's and the orchestrator's: text written into an
  agent under a delivery id of its maker's, and what became of it, told back to that maker in its process.
- `updateHandoff.ts`: the core handing over to a build the updater staged (exit 75, when the master asks),
  and a core with no master handing itself to one. `updaterBeside.ts`: the updater started beside a core whose
  master is too old to run it, still in its own process.
- `stall.ts`: a test-only fault that holds the core's event loop still (`HARNESSD_TEST_FAULTS=core.stall:…`).
- `main.ts`: the core's entry (`harness __run`) and composition root, `runForeground`: it builds these
  modules, starts the services through `serviceHost` and wires the socket. The one core file that imports
  services and the socket, and the one outside the 100% coverage: wiring only, run end to end. The
  services that run in their own processes by default it imports only dynamically, through
  `../services/inline.ts`, and only when one runs in this process instead.
- `api.ts`: the contract with services, their ports, fallbacks and requests. `serviceHost.ts`: services
  in this process. `serviceLinks.ts`: services in their own processes. `viewersLink.ts`: what the core
  keeps of the viewers when they run in theirs. `viewerStreams.ts`: a client's viewer stream and rendered
  frames, handed to the viewers, and refused at once while they are down. `workspacesLink.ts`: what the core tells workspaces in
  theirs. `teamsLink.ts`: every change to the teams' prompt scopes, kept until their process has it once Tab
  collaboration is on, which of its deliveries may be written, and the scopes' own two questions.
  `monitorLink.ts`: the monitor's port, asked of its process. `recapsLink.ts`: the recaps in their process,
  told each turn's lifecycle and never waited on, and read back from what they last said
  (`turns/recaps.ts` is the core's whole side of them). `storeLink.ts`: what the Store in its
  process tells the core. `modelsLink.ts`: what the core keeps of models in its process for frames and
  keystrokes, and how it asks it the rest. `agentQueries.ts`: what a service in its own process may ask of the agents;
  `accountQueries.ts`: of the account (a token, and the fleet's lane's sealing), so it holds no credential.
  `experimentQueries.ts`: what an experiment acts on the core through; `experiments.ts`: which are on as the
  core starts; `orchestratorLink.ts`: what the core keeps of the orchestrator in its own process;
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
  anything paired here.
