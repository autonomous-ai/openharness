# harnessd's master

The process `harness start` launches. It keeps the core and the services running, and nothing else.

## Rules

1. **No feature code, no network, no sockets.** Everything here could otherwise fail, and the master is
   the one process that must not. Import only Node built-ins and the files in this folder (and the log
   trimmer); `src/architecture.spec.ts` checks it.
2. **Everything that touches the operating system is injected** (`SupervisorDeps`,
   `ServiceSupervisorDeps`), so every decision is a unit test with fake timers. 100% coverage per file
   (`npm run test:harnessd`).
3. **The spawn protocol only grows** (`protocol.ts`): messages are added, never changed or removed, and
   unknown ones are ignored, because during an update an older master supervises a newer core.
4. **The core is always restarted; a service may be parked.** Never let a failing service stop the
   core or the master.
