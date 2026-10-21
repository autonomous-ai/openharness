/**
 * Hosts across a protocol bump: the newest protocol's host makes new panes, and the one before drains.
 *
 * A host's protocol is fixed at its build (pty/src/protocol.rs `PROTOCOL`), and each protocol is its own instance,
 * `p<protocol>`: its own discovery file, endpoint, lock and pane ids. An update that bumps the protocol leaves the old
 * host running with the person's panes in it, as a tmux server of an older tmux keeps running. This daemon reaches
 * it too, as a drain backend (ptyHostBackend.ts): its panes are listed, streamed and controlled, their registry rows
 * keep their `ptyhost:p<old>` runtimes, and the route keys name the instance, so both hosts' panes are reached at
 * once. Nothing new goes to it. Once it has no pane on two reconcile passes in a row it is shut down (protocol 2 on;
 * an older host, which has no `shutdown`, is left running idle, ptyHostBackend.ts `shutdownHost`), and the backend
 * leaves the daemon's backends (`TerminalBackendCoordinator.replaceBackends`). A drain host proven to have exited (the
 * process table) is gone, its panes with it: its inventory is then empty for certain, so the reconciler counts its
 * rows' runtimes missing, and the backend leaves once no row names its instance. Then the runtime's host binaries no
 * running host uses are deleted (launch.ts `removeUnusedPtyVersions`).
 */
import type { TerminalBackend } from '../terminalBackend.js'
import { terminalInstanceId } from '../terminalRuntime.js'
import type { TerminalRuntimeRef } from '../terminalTypes.js'
import { PtyHostBackend, type PtyHostBackendOptions } from '../ptyHostBackend.js'
import { readDiscovery } from './launch.js'
import { PTY_PROTOCOL, SUPPORTED_PTY_PROTOCOLS } from './protocol.js'

/** How many reconcile passes in a row must find a drain host with no pane before it is shut down. */
export const EMPTY_PASSES = 2

export interface PtyHostBackends {
  /** This daemon's protocol's host: new panes go there, and it is started when there is none. */
  create: PtyHostBackend
  /** Older protocols' hosts, oldest first. */
  drain: PtyHostBackend[]
}

export interface PtyHostBackendsOptions extends Omit<PtyHostBackendOptions, 'home' | 'protocol'> {
  /** Whether a registry row has a runtime on [instanceId] (`ptyhost:p<protocol>`): a drain backend is made for
   *  an older protocol with no discovery file too, so those rows go gone rather than stay on no backend. */
  rowsOn?: (instanceId: string) => boolean
}

/**
 * One backend per host instance of [home]: the create backend for `PTY_PROTOCOL`, and a drain backend for each
 * older supported protocol that has a discovery file, or rows still on it.
 */
export function ptyHostBackends(home: string, options: PtyHostBackendsOptions = {}): PtyHostBackends {
  const { rowsOn, ...backendOptions } = options
  const drain = SUPPORTED_PTY_PROTOCOLS
    .filter((protocol) => protocol < PTY_PROTOCOL)
    .filter((protocol) => readDiscovery(home, protocol) !== null || rowsOn?.(`ptyhost:p${protocol}`) === true)
    .map((protocol) => new PtyHostBackend({ ...backendOptions, home, protocol }))
  return { create: new PtyHostBackend({ ...backendOptions, home }), drain }
}

/** Whether [backend] is a drain backend: never the one new panes are made on (main.ts `createBackend`). */
export function isDrainBackend(backend: TerminalBackend): boolean {
  return backend instanceof PtyHostBackend && backend.draining
}

/** Whether any of [rows] has a runtime on [instanceId]. */
export function rowsOnInstance(rows: ReadonlyArray<{ runtimes: readonly TerminalRuntimeRef[] }>, instanceId: string): boolean {
  return rows.some((row) => row.runtimes.some((runtime) => terminalInstanceId(runtime) === instanceId))
}

export interface PtyHostDrainDeps {
  /** The drain backends that are among [backends]. */
  drain: readonly PtyHostBackend[]
  /** The daemon's ready backends: the very list the reconciler and the probe read, a drained one taken out of it. */
  backends: TerminalBackend[]
  coordinator: { replaceBackends(backends: readonly TerminalBackend[]): void }
  /** Whether a registry row still has a runtime on [instanceId] (`rowsOnInstance`). */
  inUse: (instanceId: string) => boolean
  /** After a drained host has gone and its backend left: `removeUnusedPtyVersions`. */
  cleanup?: () => void
}

/** The drain, one `step` after each reconcile pass (main.ts `onReconciled`). */
export class PtyHostDrain {
  private readonly deps: PtyHostDrainDeps
  private readonly draining: PtyHostBackend[]
  private readonly empty = new Map<PtyHostBackend, number>()
  private stepping = false

  constructor(deps: PtyHostDrainDeps) {
    this.deps = deps
    this.draining = [...deps.drain]
  }

  /** The drain backends not yet removed. */
  get pending(): readonly PtyHostBackend[] {
    return this.draining
  }

  /**
   * One pass's look at each drain host. An empty one (no pane of any owner) on `EMPTY_PASSES` passes in a row is
   * shut down; a host that refuses (a pane came meanwhile) starts the count again. One of a protocol without
   * `shutdown` stays running, idle, and only its backend leaves. A backend leaves once no row names its instance: a
   * gone host's rows go gone through the reconciler first, which a backend taken out early would strand on no
   * backend. A step while one runs is skipped: the count is of passes.
   */
  async step(): Promise<void> {
    if (this.stepping) return
    this.stepping = true
    try {
      for (const backend of [...this.draining]) await this.look(backend)
    } finally {
      this.stepping = false
    }
  }

  private async look(backend: PtyHostBackend): Promise<void> {
    const state = await backend.drainState().catch(() => 'unknown' as const)
    if (state === 'busy' || state === 'unknown') {
      this.empty.delete(backend)
      return
    }
    const passes = (this.empty.get(backend) ?? 0) + 1
    this.empty.set(backend, passes)
    if (passes < EMPTY_PASSES) return
    if (state === 'empty') {
      const shutdown = await backend.shutdownHost().catch(() => 'failed' as const)
      if (shutdown === 'refused') this.empty.delete(backend)
      // `unsupported`: the host stays, never signalled; its backend leaves all the same.
      if (shutdown !== 'exited' && shutdown !== 'unsupported') return
    }
    if (this.deps.inUse(backend.instanceId)) return
    this.remove(backend)
  }

  private remove(backend: PtyHostBackend): void {
    this.draining.splice(this.draining.indexOf(backend), 1)
    this.empty.delete(backend)
    const at = this.deps.backends.indexOf(backend)
    if (at >= 0) this.deps.backends.splice(at, 1)
    this.deps.coordinator.replaceBackends(this.deps.backends)
    backend.dispose()
    console.log(`[terminal] ptyhost: ${backend.instanceId} drained and removed (${backend.hostGone ?? 'its host is idle and left running'})`)
    try {
      this.deps.cleanup?.()
    } catch (error) {
      console.error(`[terminal] ptyhost: cleanup after the drain failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Drop every drain backend's connection, as the daemon exiting does: the hosts and their panes stay. */
  dispose(): void {
    for (const backend of this.draining) backend.dispose()
  }
}
