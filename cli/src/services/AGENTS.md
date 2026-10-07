# Services

A service is a feature the core can run without. It may fail; the core may not. These rules are what
let several people build features at once without touching the core or each other.

## Adding a service

1. **Write `start<Name>(core: CoreApi, ports: CorePorts)` in `src/services/<name>.ts`.** Read the core
   only through `core` (`src/core/api.ts`). If `CoreApi` lacks something you need, add it to `CoreApi`
   in a separate, reviewed change; never import a core module, the registry, `cli.ts` or
   `backendSocket.ts`.
2. **If the apps call it, declare its requests and answer them from start.** Declare the frame types in
   `src/core/api.ts`, `export const <NAME>_REQUESTS = ['<name>_list', …] as const`, re-export them from
   your module, and return their handlers from start: `{ <name>_list: (payload, asker) => reply }`. The
   core routes them from that list alone, so a service in its own process is never loaded into the
   core's to learn them. A handler returns the reply (or a promise of it); the core routes the request
   to it, replies under the asker's request id, and never waits in line for it. Never add a case to
   `backendSocket.ts`'s switch or a slot to `BackendSocket`.
   - Trust `asker`, never the payload: `if (!asker.owner) return { error: 'OWNER_REQUIRED' }`.
   - While the service is off, its requests are answered `SERVICE_UNAVAILABLE`, never `UNSUPPORTED`
     (the apps read that as "update the CLI"). That is why the types are declared up front.
   - A handler that throws or rejects is answered `SERVICE_FAILED` and counts against the service.
   - Work that belongs to the connection that asked (a limit on how many at once per connection, work to
     stop when the asker goes) is keyed by `asker.connection` and stops on `closed`, the handler's third
     argument: it is aborted when that connection closes, or when the core that routed it goes, wherever
     the service runs (`serviceHost.closeConnection`, `serviceLinks.closeConnection`, `process.ts`). A
     request held while an experiment's process starts is never sent once its connection has closed.
3. **If the core must call the service, give it a port.** Add `<Name>Port` and its fallbacks
   (`<NAME>_FALLBACKS`) to `src/core/api.ts`. A fallback is what the core does while the service is
   off or failing: `undefined` for nothing, a value, or `FAIL` to answer that one request
   `SERVICE_UNAVAILABLE`. The core only ever calls the port, never the service. Most features need no
   port: only the apps call them.
4. **Start it in `src/core/main.ts` through the host, never directly:**
   `serviceHost.serve('<name>', start<Name>, coreApi, <NAME>_REQUESTS)` for a service with no port, or
   `serviceHost.start('<name>', start<Name>, coreApi, <NAME>_FALLBACKS, <NAME>_REQUESTS)` for one with a
   port. The host leaves a service off when its start throws, guards every call and request, and
   switches it off after five failures in a minute.
5. **Test it to 100%** with `fakeCore()` (`src/testing/fakeCore.ts`); `npm run test:core` covers this
   folder. Prove failure isolation end to end with `HARNESSD_TEST_FAULTS=<name>` (its start fails),
   `<name>.<member>` (one port call fails) and `<name>.<request type>` (one request fails); see
   `e2e/services.e2e.ts`. The same names work in a service's own process, where `<name>.<event kind>`
   fails an event; `<name>.crash` and `<name>.leak` exist only there (`src/services/process.ts`).

`store.ts` (the Harness Store: no port, four requests) is the example to copy for a feature;
`search.ts` for a service the core also calls.

## Running in its own process

A service that can crash natively, hang or leak should run in a process of its own, where it costs only
that process. A process per risk, not per feature (`SERVICE_HOSTS` in `src/harnessd/services.ts`):

| Process | Services | Why its own | Started |
|---|---|---|---|
| `search` | search | native `node:sqlite`, the index's memory | always |
| `viewers` | viewers, store | the viewer servers, the remote viewer streams and rendered surfaces, minutes-long installs | always |
| `edge` | workspaces, usage, monitor, projects, handoff, recaps, windowNames, shell | light pure-JS services: isolated from the core, not from each other | always |
| `gateway` | gateway | network, crypto and pure-JS WebRTC: the attack surface | on demand |
| `models` | models | grid's installs, downloads and commands | on demand |
| `devices` | devices, wifi | the dials' serial ports, the fleet's lane, the voice router's worker, the Wi-Fi device | on demand |
| `orchestrator` | orchestrator | an experiment | on demand |
| `teams` | teams, collaboration | an experiment: Tab collaboration beside the prompt scopes | on demand |
| `sharing` | sharing | an experiment: Share | on demand |
| `commandBar` | commandBar | an experiment: the command bar | on demand |

A fault in one of the edge host's services can cost the others in it, never the core. Every service in
`KNOWN_SERVICES` runs out of the core's process by default, unless `HARNESSD_SERVICES` names a subset, by
service (`search,usage`) or by process (`edge`). `HARNESSD_SERVICES=none` runs them all inside the core's
process (for debugging or a quick way back). The shell service runs in the edge host too.

The updater is not in `SERVICE_HOSTS`: the core neither routes to it nor runs it, and `HARNESSD_SERVICES` does
not turn it off. The master runs it (`UPDATER_HOST`, `src/services/updaterProcess.ts`) for the installed copy,
with updates on. It stages a new build and tells the master, which has the core hand over. A core under a
master too old to run it starts it beside itself, still in its own process (`src/core/updaterBeside.ts`).

- `src/harnessd/services.ts` runs it (`SERVICE_HOSTS`: each process, the services it hosts and its
  memory budget, one heartbeat for all of them). The core routes the requests it declared (its
  `<NAME>_REQUESTS`) to its process, and the same handlers answer them there.
- `src/serviceProcess.ts` starts it (`SERVICE_RUNNERS`, which must name every service in
  `KNOWN_SERVICES`): a process imports only the runners it is named (`__service workspaces,usage`), and
  a service whose start throws there is left off while the others in its process run. The core's
  in-process starts are in `inline.ts`, which the core loads only when a service runs in its process:
  a service in its own leaves the core's import closure (`src/architecture.spec.ts`). From a release,
  it runs on the lean bundle cli.js carries for the master and the services, built apart from the
  core's own entry (`src/harnessd/leanBundle.ts`, `src/leanCoreEntry.ts`), split so that a service
  loads its own code and nothing else: 61 to 77 MiB resident at idle (20 to 35 MiB physical
  footprint), against 118 to 131 (54 to 90) when each started on cli.js (2026-10-05). It is only an
  optimisation: the master starts a service from cli.js whenever the lean bundle cannot be used
  (`src/harnessd/leanServices.ts`), and the release script refuses one that does not load
  (`scripts/check-lean-bundle.mjs`).
- **What a service imports is what its process costs.** Import from small modules: one schema module
  pulled in for a constant brought zod to search and workspaces, 8 MiB each (`src/dsh/id.ts`). A
  failing import fails the service's start, loudly, and the master parks it. `src/leanEntry.spec.ts`
  holds each process to its own code, and the master, search, the updater and the edge host to no zod.
  It also keeps the native `node:sqlite` binding out of the edge host until a service there reads a store
  that opencode, kilo, hermes or devin keeps a conversation in. `lib/sqliteRead.ts` imports the binding
  (`lib/sqliteBuiltin.ts`) only at the first read, so import `sqliteReadAll` and never the binding itself.
- `src/services/process.ts` is the process's side: `hostServices` beats to the master and stops every
  service before the process exits; `runServiceProcess` is each service's own connection to the core,
  with the master's token, reconnecting after core restarts. `<host>.crash` and `<host>.leak`, or a
  service's own, crash or leak the whole process: it is one process.
- `src/core/serviceLinks.ts` is the core's side: it routes those requests to the process, answers
  `SERVICE_UNAVAILABLE` while it is down, and holds what the service must not miss.
- `src/services/searchProcess.ts` is the example to copy. `e2e/serviceProcesses.e2e.ts` is the proof
  to copy: killed, hung (SIGSTOP), leaking, crashing on every start.
- A port the core calls asynchronously, answered when it is read, can be a request to the process: the
  monitor shows how (`src/services/monitorProcess.ts`, `src/core/monitorLink.ts`). The core asks with
  `serviceLinks.call`, under types only it sends (the port's member names, so a test's fault names the
  same member either way), and reads an answer that does not come as the port's fallbacks. A light
  service that reads the agents asks for them as each request starts (`service_query live` or
  `advertised`, `src/core/agentQueries.ts`; `src/services/processCoreApi.ts`). The change-agent handoff
  asks for each conversation fact as it needs it (`core.conversations`, `src/core/conversationQueries.ts`,
  `src/services/handoffProcess.ts`) and keeps no copy of the registry.
- A port the core calls in line (while it builds a frame, say) cannot wait on another process. The
  viewers show how (`src/services/viewersProcess.ts`, `src/core/viewersLink.ts`): the process tells
  the core its answers whenever they change (a `service_query` kind the core answers), the core keeps
  the last ones and its port answers from them, or from the fallbacks before it has heard any. The
  process asks the core for everything it should hold each time it connects, which a restarted
  process needs anyway. `e2e/viewersProcess.e2e.ts` proves it with a real harness agent's viewer.
- Both at once, and a service that asks the core for what only the core holds: models
  (`src/services/modelsProcess.ts`, `src/core/modelsLink.ts`). What a frame and a keystroke read (an
  agent's grid note, whether its grid sleeps) is told to the core as a glance at every grid whenever it
  changes; grid's set-up and where an agent on a grid model sends its inference are asked when needed, each
  with a wait long enough for what it does (`LONG_ANSWERS` in `src/core/api.ts`: the half minute any other
  answer gets would cut a grid install short). Models asks the core for the sign-in each time it needs it,
  and work that belongs to one connection's request (a Grid harness's command) is keyed by the connection
  and request id the core gives every request (`Asker`). `e2e/serviceProcesses.e2e.ts` proves it: a create
  on a grid model while models is killed answers GRID_UNAVAILABLE, and every agent works on.
- A service the core only gives commands to needs nothing kept for it while it is down. Workspaces
  (`src/services/workspacesProcess.ts`, `src/core/workspacesLink.ts`) is told to name branches and
  when to sweep. A command that destroys something is never held or replayed, and what it must know
  (the folders in use) is asked for when it starts, never sent ahead where it could go stale.
  `e2e/workspacesProcess.e2e.ts` proves it.
- A service that is transport rather than requests: the gateway (src/gateway/gatewayProcess.ts,
  src/core/gatewayLink.ts) carries every remote client's traffic, so it tells the core without asking
  (`service_notice`) and carries terminal bytes as binary frames on its link. The core drops what would
  pile up on a gateway that reads nothing, and the gateway gone is the relay gone: every remote client
  with it, never a window on this computer. `e2e/gatewayProcess.e2e.ts` proves it, with a phone.
- The shell service (`shellProcess.ts`) owns validation, setup replies and durable creation receipts in
  the edge host. It asks the core to launch literal argv or read live terminal identity through
  `core.terminals` (`core/shellQueries.ts`). A lost launch reply leaves an unconfirmed receipt and is
  never retried as a new launch. `e2e/shell.e2e.ts` keeps an attached terminal working across an edge crash.
- The gateway owns account/backend HTTP and the single writer of `machines.json` (`gateway/accountHttp.ts`).
  The core retains its reported list for stale replies during a restart, bound to the current account.
  The Store prepares bundled harnesses before reporting `prepared`; the core waits at most five seconds
  before restore. The lean bundle shares one asset file, loaded by the Store and never by the core.
- A service that writes turns into agents (a team's question, the orchestrator's guidance) delivers each
  under an id of its own through `core.turns.deliver`, hears what became of it through `onDelivery`, and
  takes one back with `cancelDelivery` (core/deliveries.ts). In its own process `services/turnsLink.ts`
  asks the core over its link, in order, and hears only its own deliveries; the core lets a process deliver
  only when it is an experiment (below).
- A service that drives hardware: the devices (src/services/devicesProcess.ts, src/core/devicesLink.ts).
  The dial reads a dozen facts in line while it builds each frame, so the process keeps a copy of what it
  reads (this computer's agents, its name, the sign-in, whether a window is there), asked of the core as
  the dial's tick or ⌘K builds a list; the core keeps what the windows said and says it again each time
  the process connects, and a dial attaching is shown the open questions and the working tiles. Inside,
  one device failing is that device's alone: its session's faults and a flood on its port drop it, and
  its port is looked at again later (src/cable/cableFleet.ts). `e2e/devicesProcess.e2e.ts` proves it,
  with fake dials on pseudo-terminals. The Wi-Fi device runs beside them on a link of its own
  (src/services/wifiProcess.ts, src/core/wifiLink.ts): its sessions are the gateway's, so the core hands
  their requests on in order and checks where each answer goes, and keeps what it reads in line of the
  service (who said hello, which transcripts and streams it follows, the focus revision) from what the
  service tells it (src/core/wifi.ts). `e2e/wifiDevice.e2e.ts` proves it, with a fake device on the relay.
  Their process runs only once there is a device (`onDemand`, asked for since protocol 4): a dial's port in
  /dev, a paired Wi-Fi device or its session, or a request for them (src/core/devicesWake.ts);
  what a Wi-Fi device sends while it starts is held by the core. `e2e/devicesOnDemand.e2e.ts` proves it.
- A service the core tells what happens and never waits on: the recaps (`src/services/recapsProcess.ts`,
  `src/core/recapsLink.ts`) hear each turn's lifecycle as a notification, and one they miss costs that
  turn its recap, nothing else; what would pile up on a hung process is dropped. What they put in front
  of a person goes back as a notice the core checks the type of (`clients.turnCard`, `turnSummary`), and
  what the core reads back in line it reads from what they last said of each session.
  `e2e/recapsProcess.e2e.ts` proves turns end on time with them killed, hung or slow, and
  `e2e/recapsCompat.e2e.ts` that the dial and the windows hear the same cards and recaps as before.
- State built from every change must get every change exactly once. The teams show how
  (`src/services/teamsProcess.ts`, `src/core/teamsLink.ts`): the core numbers each change and keeps it
  until the process acknowledges it; on each connection the process says what it applied and gets
  what it lacks, or starts over. A value the core reads back synchronously is answered from what the
  process last reported, and is "unknown" (the fallback) while a change to it is on its way.
  `e2e/teamsProcess.e2e.ts` proves it.

## On demand

A process with `onDemand: true` in `SERVICE_HOSTS` is not started with the others. The master starts it when
the core asks for one of its services (`harnessd:want`, sent by `coreLink.want`), and then keeps it running
like any other. Named in `HARNESSD_SERVICES`, it starts with the others.

- **What asks.** A request for a service that has not connected yet (`serviceLinks` `onDemand`, in
  `src/core/main.ts`) asks for it and waits for it, within the request's own wait. The service is welcomed
  before its queued requests are delivered. Each experiment with saved state in the data folder is
  asked for as the core starts (`src/core/experiments.ts`). The devices are asked for once there is a device:
  a dial's port in /dev, a paired Wi-Fi device, or its session (`src/core/devicesWake.ts`). Models is asked
  for as the core starts when grid is in use here: a managed grid, whose pin it follows, saved grid pictures,
  which agents' grid notes are read from, or local models (`src/core/modelsWake.ts`); otherwise its first
  request asks for it. The gateway is asked for as the core starts, before it binds, when this machine is
  signed in or has anything paired or linked directly (`src/core/gatewayWake.ts`), so the relay comes up
  beside the core as before; otherwise by what needs it (`src/core/gatewayLink.ts`): a pairing, a window's
  E2EE request or session to another machine, which wait for its first start, a key or device command, or
  the Wi-Fi device's service. `/api/status` never starts it.
- **Older cores.** `askedSince` is the core protocol (`HARNESSD_PROTOCOL`, `src/harnessd/protocol.ts`) from
  which a core asks for this process. A core that speaks an older one never asks, so the master starts the
  process as that core binds (`ServiceSupervisor.unasked`). It is 3 by default, the experiments'; the
  devices, models and the gateway became on demand at protocol 4, which may also ask before it binds. Making another process on demand needs a protocol bump, and that
  number in its `askedSince`.
- **Proof.** `e2e/experiments.e2e.ts`, `e2e/devicesOnDemand.e2e.ts`, `e2e/modelsOnDemand.e2e.ts` and
  `e2e/gatewayOnDemand.e2e.ts`: off, it has no process; asked for, it starts and answers.

## Experiments

An experiment (the orchestrator, Tab collaboration, Share, the command bar) is a service that costs nothing
until it is on: its own process, which the master starts only when the core asks for it (`want`), when one of
its requests arrives or, as the core starts, when its saved state is in the data folder. Off, nothing of it runs or
is loaded anywhere; one failing costs its own process and nothing else. `e2e/experiments.e2e.ts` proves it:
off, on by request, on by saved state, killed, hung and crashing on every start.

To add one:

1. Its service, `start<Name>(core, ports)` in `src/services/<name>.ts`, returning its requests' handlers, and
   its process's runner (`src/services/<name>Process.ts`, `run<Name>Service`; copy
   `src/services/orchestratorProcess.ts`). Its `CoreApi` in its process is `processCoreApi` with `ask`, which
   gives it what an experiment acts on the core through (`src/core/experimentQueries.ts`): the agents as the
   apps are shown them, creating an agent, stopping a turn, delivering turns (`services/turnsLink.ts`), a
   change notice for the windows (`<name>_changed`) and how an agent's shell reaches this daemon; Share
   also reads the backend as the account (`core.account.backend`) and has its welcomes signed by the gateway
   (`core.account.observerKey`), so it holds no credential, and watches terminals read-only
   (`core.terminals.watch`, `services/watchLink.ts`).
2. Its entry in `EXPERIMENTS` (`src/core/api.ts`): its requests and its saved state.
3. Its process in `SERVICE_HOSTS` (`src/harnessd/services.ts`) with `onDemand: true`, and its runner in
   `SERVICE_RUNNERS` (`src/serviceProcess.ts`).
4. Its start for the core's own process, in `services/inline.ts`, and one line in `core/main.ts` that starts
   it there when `HARNESSD_SERVICES` keeps it in (`serviceHost.serve`, or `start` with a port).

Removing one is deleting those. A port the core calls in line (the orchestrator's `roleOf`) is answered
from what the process last reported (`src/core/orchestratorLink.ts`), as the viewers' are. Tab collaboration
(`src/services/collaboration.ts`, beside the prompt scopes in the teams' process) shows the rest: whether a
team's turn may still be written, which the core asks as it writes it, is reported for a few seconds at a
time, so a process that stops reporting leaves none writable (`collaborationProcess.ts`, `core/teamsLink.ts`);
a cancel its mailbox reads in line is asked of the core first (`takingBack`); and the core keeps nothing for
the scopes until the experiment is on.

## Do not

- Do not keep state the core needs. If the core would break without your data, it is not a service.
- Do not hold credentials. Ask `core.account`: a token (`accessToken`, with one forced refresh after a
  401) or, to seal for one of the owner's other machines, the gateway's session with it (`lane`, as the
  fleet's lane does: `src/device/deviceLink.ts`). This machine's E2EE identity is the gateway's alone.
- Do not write to tmux, the registry or another service's files.
