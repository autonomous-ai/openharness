# Services

A service is a feature the core can run without. It may fail; the core may not. These rules are what
let several people build features at once without touching the core or each other.

## Adding a service

1. **Write `start<Name>(core: CoreApi, ports: CorePorts)` in `src/services/<name>.ts`.** Read the core
   only through `core` (`src/core/api.ts`). If `CoreApi` lacks something you need, add it to `CoreApi`
   in a separate, reviewed change; never import a core module, the registry, `cli.ts` or
   `backendSocket.ts`.
2. **If the core must call the service, give it a port.** Add `<Name>Port` and its fallbacks
   (`<NAME>_FALLBACKS`) to `src/core/api.ts`. A fallback is what the core does while the service is
   off or failing: `undefined` for nothing, a value, or `FAIL` to answer that one request
   `SERVICE_UNAVAILABLE`. The core only ever calls the port, never the service.
3. **Start it in `src/cli.ts` with `serviceHost.start('<name>', start<Name>, coreApi, <NAME>_FALLBACKS)`.**
   Never call `start<Name>` directly: the host leaves a service off when its start throws, guards every
   call, and switches it off after five failures in a minute.
4. **Test it to 100%** with `fakeCore()` (`src/testing/fakeCore.ts`); `npm run test:core` covers this
   folder. Prove failure isolation end to end with `HARNESSD_TEST_FAULTS=<name>` (its start fails) and
   `<name>.<member>` (one call fails); see `e2e/services.e2e.ts`.

## Running in its own process

A service that can crash natively, hang or leak should run in its own process, where it costs only
itself. Search does: `HARNESSD_SERVICES=search`.

- `src/harnessd/services.ts` runs it (`KNOWN_SERVICES`, with its memory budget) and lists the
  requests it answers (`SERVICE_REQUESTS`).
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
