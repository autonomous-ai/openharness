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

/**
 * The handler for the server's handlers object, on Windows only. Elsewhere `harness stop` signals the master (the
 * pid file), and the core serves no such route: hookServer.ts registers it only when the handler is given.
 */
export function daemonStopRoute(deps: DaemonStopDeps, platform: NodeJS.Platform = process.platform): { onDaemonStop?: () => Promise<DaemonStopAnswer> } {
  return platform === 'win32' ? { onDaemonStop: daemonStopHandler(deps) } : {}
}
