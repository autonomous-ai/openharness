/**
 * `harness stop` as the core hears it on Windows: POST /api/daemon/stop, on the daemon's pipe only (hookServer.ts).
 * Windows has no signals, so the CLI cannot ask the master as it does on a Mac (SIGTERM to the pid in the pid file);
 * it asks the core, which asks its master (`harnessd:stop`, harnessd/protocol.ts), which stops the services and
 * this core in order (`harnessd:shutdown`) and exits. A core no master runs stops itself.
 */
export interface DaemonStopDeps {
  /** Ask the master to stop everything (harnessd/coreLink.ts `stopAll`); false when there is none. */
  askMaster(): boolean
  /** This core's own stop, for a core no master runs. */
  stopHere(): void
  /** Run after the answer has gone out: the stop closes the server that carries it. */
  defer?: (run: () => void) => void
}

/** What the route answers: hookServer.ts `PairOutcome`'s shape, kept here so the core imports no server type. */
export interface DaemonStopAnswer { status: number; body: Record<string, unknown> }

export function daemonStopHandler(deps: DaemonStopDeps): () => Promise<DaemonStopAnswer> {
  const defer = deps.defer ?? ((run: () => void) => { setImmediate(run) })
  return async () => {
    defer(() => { if (!deps.askMaster()) deps.stopHere() })
    return { status: 202, body: { ok: true } }
  }
}

export interface EarlyLeaveDeps {
  /** Let go of the pid file if it names this process (lib/daemonLaunch.ts `removePidFileIf`). */
  removePidFile(): void
  log(line: string): void
  exit(code: number): void
}

/**
 * A core's own stop before its start-up has built `shutdown`: the route is served from the moment the hook server is
 * bound, and in safe mode after a start-up that never got as far. Nothing has been started that needs stopping in
 * order, so the process leaves. core/main.ts holds it in `daemonBoot.stopHere` until `runForeground`, and then
 * safe mode, put their own in.
 */
export function leaveBeforeStartUp(deps: EarlyLeaveDeps): (why: string) => void {
  return (why) => {
    deps.removePidFile()
    deps.log(`[cli] ${why} — leaving before start-up finished`)
    deps.exit(0)
  }
}

/**
 * The handler for the server's handlers object, on Windows only. Elsewhere `harness stop` signals the master (the
 * pid file), and the core serves no such route: hookServer.ts registers it only when the handler is given.
 */
export function daemonStopRoute(deps: DaemonStopDeps, platform: NodeJS.Platform = process.platform): { onDaemonStop?: () => Promise<DaemonStopAnswer> } {
  return platform === 'win32' ? { onDaemonStop: daemonStopHandler(deps) } : {}
}
