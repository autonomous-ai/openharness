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
that process. A process per risk, not per feature: search (native `node:sqlite`), the viewers (their
servers), the teams' prompt scopes, and the edge host, one process for the light services that only
answer requests (workspaces, usage, the monitor, the project readers). A fault in one of the edge
host's services can cost the others in it, never the core. Every service in `KNOWN_SERVICES` runs out
of the core's process by default, unless `HARNESSD_SERVICES` names a subset, by service
(`search,usage`) or by process (`edge`), and `HARNESSD_SERVICES=none` runs them all inside the core's
process (for debugging or a quick way back).

- `src/harnessd/services.ts` runs it (`SERVICE_HOSTS`: each process, the services it hosts and its
  memory budget, one heartbeat for all of them). The core routes the requests it declared (its
  `<NAME>_REQUESTS`) to its process, and the same handlers answer them there.
- `src/serviceProcess.ts` starts it (`SERVICE_RUNNERS`, which must name every service in
  `KNOWN_SERVICES`): a process imports only the runners it is named (`__service workspaces,usage`), and
  a service whose start throws there is left off while the others in its process run. The core's
  in-process starts are in `inline.ts`, which the core loads only when a service runs in its process:
  a service in its own leaves the core's import closure (`src/architecture.spec.ts`). From a release,
  it runs on the lean bundle cli.js carries for the master and the services
  (`src/harnessd/leanBundle.ts`), split so that a service loads its own code and nothing else: 61 to 77
  MiB resident at idle (20 to 35 MiB physical footprint), against 118 to 131 (54 to 90) when each
  started on cli.js (2026-10-05). It is only an optimisation: the master starts a service from cli.js
  whenever the lean bundle cannot be used (`src/harnessd/leanServices.ts`), and the release script
  refuses one that does not load (`scripts/check-lean-bundle.mjs`).
- **What a service imports is what its process costs.** Import from small modules: one schema module
  pulled in for a constant brought zod to search and workspaces, 8 MiB each (`src/dsh/id.ts`). A
  failing import fails the service's start, loudly, and the master parks it. `src/leanEntry.spec.ts`
  holds each process to its own code, and the master, search and the edge host to no zod.
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
  `advertised`, `src/core/agentQueries.ts`; `src/services/processCoreApi.ts`).
- A port the core calls in line (while it builds a frame, say) cannot wait on another process. The
  viewers show how (`src/services/viewersProcess.ts`, `src/core/viewersLink.ts`): the process tells
  the core its answers whenever they change (a `service_query` kind the core answers), the core keeps
  the last ones and its port answers from them, or from the fallbacks before it has heard any. The
  process asks the core for everything it should hold each time it connects, which a restarted
  process needs anyway. `e2e/viewersProcess.e2e.ts` proves it with a real harness agent's viewer.
- A service the core only gives commands to needs nothing kept for it while it is down. Workspaces
  (`src/services/workspacesProcess.ts`, `src/core/workspacesLink.ts`) is told to name branches and
  when to sweep. A command that destroys something is never held or replayed, and what it must know
  (the folders in use) is asked for when it starts, never sent ahead where it could go stale.
  `e2e/workspacesProcess.e2e.ts` proves it.
- State built from every change must get every change exactly once. The teams show how
  (`src/services/teamsProcess.ts`, `src/core/teamsLink.ts`): the core numbers each change and keeps it
  until the process acknowledges it; on each connection the process says what it applied and gets
  what it lacks, or starts over. A value the core reads back synchronously is answered from what the
  process last reported, and is "unknown" (the fallback) while a change to it is on its way.
  `e2e/teamsProcess.e2e.ts` proves it.

## Do not

- Do not keep state the core needs. If the core would break without your data, it is not a service.
- Do not hold credentials. Ask `core.account`.
- Do not write to tmux, the registry or another service's files.
