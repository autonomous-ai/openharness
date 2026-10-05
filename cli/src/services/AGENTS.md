# Services

A service is a feature the core can run without. It may fail; the core may not. These rules are what
let several people build features at once without touching the core or each other.

## Adding a service

1. **Write `start<Name>(core: CoreApi, ports: CorePorts)` in `src/services/<name>.ts`.** Read the core
   only through `core` (`src/core/api.ts`). If `CoreApi` lacks something you need, add it to `CoreApi`
   in a separate, reviewed change; never import a core module, the registry, `cli.ts` or
   `backendSocket.ts`.
2. **If the apps call it, declare its requests and answer them from start.** Export the frame types,
   `export const <NAME>_REQUESTS = ['<name>_list', …] as const`, and return their handlers from start:
   `{ <name>_list: (payload, asker) => reply }`. A handler returns the reply (or a promise of it); the
   core routes the request to it, replies under the asker's request id, and never waits in line for it.
   Never add a case to `backendSocket.ts`'s switch or a slot to `BackendSocket`.
   - Trust `asker`, never the payload: `if (!asker.owner) return { error: 'OWNER_REQUIRED' }`.
   - While the service is off, its requests are answered `SERVICE_UNAVAILABLE`, never `UNSUPPORTED`
     (the apps read that as "update the CLI"). That is why the types are declared up front.
   - A handler that throws or rejects is answered `SERVICE_FAILED` and counts against the service.
3. **If the core must call the service, give it a port.** Add `<Name>Port` and its fallbacks
   (`<NAME>_FALLBACKS`) to `src/core/api.ts`. A fallback is what the core does while the service is
   off or failing: `undefined` for nothing, a value, or `FAIL` to answer that one request
   `SERVICE_UNAVAILABLE`. The core only ever calls the port, never the service. Most features need no
   port: only the apps call them.
4. **Start it in `src/cli.ts` through the host, never directly:**
   `serviceHost.serve('<name>', start<Name>, coreApi, <NAME>_REQUESTS)` for a service with no port, or
   `serviceHost.start('<name>', start<Name>, coreApi, <NAME>_FALLBACKS, <NAME>_REQUESTS)` for one with a
   port. The host leaves a service off when its start throws, guards every call and request, and
   switches it off after five failures in a minute.
5. **Test it to 100%** with `fakeCore()` (`src/testing/fakeCore.ts`); `npm run test:core` covers this
   folder. Prove failure isolation end to end with `HARNESSD_TEST_FAULTS=<name>` (its start fails),
   `<name>.<member>` (one port call fails) and `<name>.<request type>` (one request fails); see
   `e2e/services.e2e.ts`.

`store.ts` (the Harness Store: no port, four requests) is the example to copy for a feature;
`search.ts` for a service the core also calls.

## Running in its own process

A service that can crash natively, hang or leak should run in its own process, where it costs only
itself. Search does: `HARNESSD_SERVICES=search`.

- `src/harnessd/services.ts` runs it (`KNOWN_SERVICES`, with its memory budget). The core routes the
  requests it declared (its `<NAME>_REQUESTS`) to its process, and the same handlers answer them there.
- `src/services/process.ts` is the process's side: heartbeats to the master, the connection to the
  core with the master's token, reconnecting after core restarts.
- `src/core/serviceLinks.ts` is the core's side: it routes those requests to the process, answers
  `SERVICE_UNAVAILABLE` while it is down, and holds what the service must not miss.
- `src/services/searchProcess.ts` is the example to copy. `e2e/serviceProcesses.e2e.ts` is the proof
  to copy: killed, hung (SIGSTOP), leaking, crashing on every start.

## Do not

- Do not keep state the core needs. If the core would break without your data, it is not a service.
- Do not hold credentials. Ask `core.account`.
- Do not write to tmux, the registry or another service's files.
