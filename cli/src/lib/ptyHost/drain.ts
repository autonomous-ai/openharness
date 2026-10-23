/**
 * The hosts of one home: the target's makes new panes, and every other drains.
 *
 * Each host build is its own instance (`p<protocol>-<version>`, or `p<protocol>` for a host from before that,
 * instance.ts): its own discovery file, endpoint, lock and pane ids. The target is the build this daemon would start
 * (launch.ts `targetHost`, read once as the core starts). An update leaves the previous build's host running with the
 * person's panes in it, as a tmux server of an older tmux keeps running. This daemon reaches it too, as a drain
 * backend (ptyHostBackend.ts): its panes are listed, streamed and controlled, their registry rows keep their
 * `ptyhost:<instance>` runtimes, and the route keys name the instance, so every host's panes are reached at once.
 * Nothing new goes to it. Once it has no pane on two reconcile passes in a row it is shut down (protocol 2 on, and only
 * when `mayShutDown`: never a host newer than a dev build's target, nor any with no target; an older protocol's host,
 * which has no `shutdown`, is left running idle, ptyHostBackend.ts `shutdownHost`), and the backend leaves the daemon's
 * backends (`TerminalBackendCoordinator.replaceBackends`). A drain host proven to have exited (the process table) is
 * gone, its panes with it: its inventory is then empty for certain, so the reconciler counts its rows' runtimes
 * missing, and the backend leaves once no row names its instance. Then the runtime's host binaries no running host
 * uses are deleted (launch.ts `removeUnusedPtyVersions`, which keeps every folder newer than `current-pty`). No drain
 * host is shut down while the create backend has no host of its own (`createAvailable`): it may be the only one left.
 *
 * While a host is on probation (`ptyHostOnProbation`), the core is ready only once the create backend is attached to it
 * (`untilHostAttached`): the master's probation judges the core's ready, and so the host's.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { TerminalBackend } from '../terminalBackend.js'
import { terminalInstanceId } from '../terminalRuntime.js'
import type { TerminalRuntimeRef } from '../terminalTypes.js'
import { PtyHostBackend, type PtyHostBackendOptions } from '../ptyHostBackend.js'
import { instanceProtocol } from './instance.js'
import { listDiscoveries, type PtyHostTarget } from './launch.js'
import { SUPPORTED_PTY_PROTOCOLS } from './protocol.js'

/** How many reconcile passes in a row must find a drain host with no pane before it is shut down. */
export const EMPTY_PASSES = 2

export interface PtyHostBackends {
  /** The target's host: new panes go there, and it is started when there is none. */
  create: PtyHostBackend
  /** Every other host's, oldest first, then those only registry rows name. */
  drain: PtyHostBackend[]
}

export interface PtyHostBackendsOptions extends Omit<PtyHostBackendOptions, 'home' | 'instance' | 'target'> {
  /** The daemon's target host (`targetHost`); null when it cannot be known. */
  target?: PtyHostTarget | null
  /**
   * The `ptyhost:<instance>` instances registry rows name (`rowInstancesOf`): a drain backend is made for one with no
   * discovery file too, so those rows go gone rather than stay on no backend.
   */
  rowInstances?: () => string[]
}

const PTYHOST = 'ptyhost:'

/** Whether [instance] is a host instance of a protocol this daemon speaks. */
function supported(instance: string): boolean {
  const protocol = instanceProtocol(instance)
  return protocol !== null && SUPPORTED_PTY_PROTOCOLS.includes(protocol)
}

/**
 * One backend per host instance of [home]: the create backend for the target, and a drain backend for each other
 * instance of a supported protocol that has a discovery file, or rows still on it. With no target, every discovered
 * host is a drain backend's, including the one the create backend will take (`withoutCreateHost` drops that one once
 * they are prepared).
 */
export function ptyHostBackends(home: string, options: PtyHostBackendsOptions = {}): PtyHostBackends {
  const { target = null, rowInstances, ...backendOptions } = options
  const discovered = listDiscoveries(home).map((discovery) => discovery.instance)
  const named = (rowInstances?.() ?? []).flatMap((id) => id.startsWith(PTYHOST) ? [id.slice(PTYHOST.length)] : [])
  // By instance, never by version: a folder `current-pty` names may hold a binary stamped otherwise, and the instance
  // is the name its host publishes (launch.ts `targetHost`).
  const instances = [...new Set([...discovered, ...named])].filter((instance) => supported(instance) && instance !== target?.instance)
  const drain = instances.map((instance) => new PtyHostBackend({ ...backendOptions, home, instance, target }))
  return { create: new PtyHostBackend({ ...backendOptions, home, target }), drain }
}

/** The `ptyhost:<instance>` instances [rows] have runtimes on, once each. */
export function rowInstancesOf(rows: ReadonlyArray<{ runtimes: readonly TerminalRuntimeRef[] }>): string[] {
  const instances = rows.flatMap((row) => row.runtimes.filter((runtime) => runtime.backend === 'ptyhost').map(terminalInstanceId))
  return [...new Set(instances)]
}

/**
 * [backends] without a drain backend on the host [create] reached, which is disposed (its connection only). Only with
 * no target can there be one: the create backend then took whichever host of `PTY_PROTOCOL` answered, which was a
 * drain backend's too. Two backends of one instance would list its panes twice, and the coordinator would route them to
 * the later one.
 */
export function withoutCreateHost(backends: readonly TerminalBackend[], create: PtyHostBackend): TerminalBackend[] {
  return backends.filter((backend) => {
    if (!isDrainBackend(backend) || backend.instanceId !== create.instanceId) return true
    backend.dispose()
    return false
  })
}

/** Whether [backend] is a drain backend: never the one new panes are made on (main.ts `createBackend`). */
export function isDrainBackend(backend: TerminalBackend): backend is PtyHostBackend {
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
  /** Whether the create backend is attached to its host. While it is not, no drain host is shut down: new panes have
   *  nowhere else to go, and a probation that rolls the target back needs a host to come back to. Left out, always. */
  createAvailable?: () => boolean
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
   * `shutdown`, or one it may not shut down (`mayShutDown`), stays running, idle, and only its backend leaves. A backend leaves once no row names its instance: a
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
    if (state === 'empty' && this.deps.createAvailable && !this.deps.createAvailable()) {
      this.empty.delete(backend)
      return
    }
    const passes = (this.empty.get(backend) ?? 0) + 1
    this.empty.set(backend, passes)
    if (passes < EMPTY_PASSES) return
    // A host it may not shut down (`mayShutDown`) stays running, as one without `shutdown` does; its backend leaves
    // all the same once no row names it.
    if (state === 'empty' && backend.mayShutDown) {
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

/** A host is on probation: `<runtime>/pty/pty-pending.json` (lib/windows/ptyInstall.ts `PTY_PENDING`) exists. */
export function ptyHostOnProbation(runtimeDir: string): boolean {
  return existsSync(path.join(runtimeDir, 'pty', 'pty-pending.json'))
}

/**
 * Wait until [attached] (the create backend reached the target's host, [instance]; null when there is no target), polled
 * every [pollMs]: how a core whose host is on probation holds back its ready (core/main.ts). The master judges the host
 * by that ready, and a version that says it runs proves nothing about serving. One that never attaches keeps the core
 * not ready for good: the master's ready timeout ends it, and its probation rolls the host back. Said once, if it waits.
 */
export async function untilHostAttached(attached: () => boolean, instance: string | null, log: (line: string) => void, pollMs = 250): Promise<void> {
  if (attached()) return
  const host = instance ?? 'no target'
  log(`[terminal] ptyhost: the host on probation (${host}) is not attached — not ready until it is; the master rolls it back if it never is`)
  while (!attached()) await new Promise((resolve) => setTimeout(resolve, pollMs))
  log(`[terminal] ptyhost: the host on probation (${host}) is attached`)
}
