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
6. **The master replaces itself only in the gap before a core starts** (`reexec.ts`): no core running,
   services stopped and reaped first, in place so the pid stays. Never exec with a child running: it
   would lose its channel, and become an orphan or a zombie no one reaps. A master started on cli.js
   does it once more, before it has started anything: onto the lean bundle cli.js carries, so the
   master parses its own code and not the whole CLI's (`../masterProcess.ts`).
7. **The lean bundle is only ever an optimisation** (`leanBundle.ts`, `leanServices.ts`). A service is
   started from it only while its files are the ones its master started with and cli.js is the bundle
   they came from, and not after it died twice from it before beating; from cli.js otherwise. Other
   masters (another build, a second `harness start`) may share the data folder: each claims the folder
   it runs from, and one is removed only once no live master claims it. `lean-off` in the data folder
   turns it off for masters launchd or systemd start. Never exec onto a file without checking it is
   there: a failed exec cannot be caught (`reexec.ts`).
8. **Each process runs under its own name** (`processName.ts`): Activity Monitor and `top` name a process
   after the file exec'd, and the master, core and each service are started through a hard link of the
   managed node (`harnessd`, `harnessd-core`, `harnessd-<service>`), titled the same. The links live in
   `<runtime>/node-…/libexec/harnessd/` — never `bin/`, which agent panes get on PATH — are made only for
   the managed runtime's node, never a bare `harness` (the dial's `pgrep -x harness` means the app), and
   any failure runs the process as `node`. Children a process starts use `baseNode(process.execPath)`.
