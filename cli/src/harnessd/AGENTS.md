# harnessd's master

The process `harness start` launches (or launchd or systemd, once `harness service install` opted in).
It keeps the core and the services running, and nothing else.

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
5. **Platform supervision is opt-in** (`platform.ts`, `harness service install`): launchd or systemd runs
   the master in the foreground, and the CLI starts and stops it through the platform, never beside it.
   Under systemd, never stop the unit with a stop job (`systemctl stop`, `restart`, `disable --now`):
   tmux built with systemd support makes every pane PartOf the unit that started its server, so a stop
   job ends every agent. `stop()` signals the master instead. The desktop app does not use it yet.
