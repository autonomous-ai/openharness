/**
 * The `ptyhost` terminal backend: panes held by the Harness PTY host (`pty/`, `harness-pty serve`), reached
 * over its control connection (ptyHost/client.ts). It mirrors `TmuxBackend` op for op, so an agent on
 * either backend is created, read, typed into, held and restarted the same way.
 *
 * Its streams (`openStream`) are `PtyHostStream`s (ptyHost/stream.ts), one stream connection each, whose keyframes
 * are tmux's.
 *
 * The connection: when the host ends it (it exited, or dropped this daemon), the backend is unavailable (`inventory`
 * says so, and never lists nothing) and reconnects, through `ensurePtyHost`, after 1 s, then 2 s, 4 s … at most 30 s
 * apart; the delays start again from 1 s only for a connection that had stayed up 30 s. A host with another pid is another host: its predecessor's panes are gone, and `onHostReplaced` says so,
 * so the reconciler sees them absent and the resume path takes over. `dispose` drops the connection alone.
 *
 * One backend per host instance (ptyHost/instance.ts, ptyHost/drain.ts). The create backend makes new panes on the
 * target's host (launch.ts `targetHost`: the build this daemon would start), and starts it when there is none; it is
 * never connected to another build's host. With no target it takes the newest running host of `PTY_PROTOCOL` and stays
 * on that instance until that host is proven dead. Every other host is a drain backend's: it reaches a host still running from before an update and
 * never starts one, lists, streams and controls its panes, refuses `create`, and shuts the host down once it has none
 * (`shutdownHost`) when it may (`mayShutDown`). A drain host that exits is gone for good (`hostGone`): its inventory is
 * then authoritative and empty, so its panes' runtimes go gone through the reconciler's normal misses.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { env } from '../config/env.js'
import type { AgentEngine } from '../engines/types.js'
import { harnessPaneOwner } from './harnessSessionLabel.js'
import { isHeldStartCommand } from './nativePaneHold.js'
import { lookupPaneEngineProcess } from './paneEngineProcess.js'
import { comparableStartMarker, processRows, setProcessTableSource, type ProcessRow } from './processTable.js'
import { setAgentSignaller, type AgentSignal } from './processSignals.js'
import type { PtyHostCallResult, PtyHostClient } from './ptyHost/client.js'
import { discoveryFileName, instanceProtocol } from './ptyHost/instance.js'
import {
  compareVersions, discoveredHostDead, ensurePtyHost, forgetExitedHost, pidAlive, reachPtyHost, readInstanceDiscovery,
  type EnsurePtyHostResult, type HostLiveness, type PtyHostTarget, type PtyHostUnavailable, type PtyHostUnreached, type ReachPtyHostResult,
} from './ptyHost/launch.js'
import { PTY_PROTOCOL, SEED_FEATURE, SHUTDOWN_PROTOCOL, type PtyEvent } from './ptyHost/protocol.js'
import { PtyHostStream } from './ptyHost/stream.js'
import { submitContent, submitSettleMs } from './submitTiming.js'
import type { TerminalBackend, TerminalBackendPrepared } from './terminalBackend.js'
import { TMUX_KEYS } from './terminalKeys.js'
import { processIdentityOf, sameProcessIdentity, terminalRouteKey } from './terminalRuntime.js'
import { windowsProcessRows } from './windows/processTable.js'
import { defaultWindowsShell } from './windows/shell.js'
import { endProcessTree, processTreeKillDeps, type TreeKillOutcome } from './windows/treeKill.js'
import {
  TERMINAL_ACTION_SUCCEEDED,
  terminalActionNotStarted,
  terminalActionPossiblyExecuted,
  terminalEnterWithheld,
  type ProcessIdentity,
  type PtyRuntimeRef,
  type RuntimeValidation,
  type SubmitOptions,
  type TerminalActionResult,
  type TerminalBackendCapabilities,
  type TerminalCaptureOptions,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  type TerminalInventoryResult,
  type TerminalLogicalKey,
  type TerminalPaneInfo,
  type TerminalPaneRead,
  type TerminalProcessExpectation,
  type TerminalReadResult,
  type TerminalRespawnRequest,
  type TerminalStreamHandle,
  type TerminalStreamSink,
  type TerminalStreamSize,
} from './terminalTypes.js'

/** A new pane's size until a viewer resizes it to itself: a wide screen, so an engine's first frame wraps little. */
const CREATE_COLS = 200
const CREATE_ROWS = 50
/** How long a killed pane's process group is given after SIGHUP before the host escalates. */
const KILL_GRACE_MS = 2000
/** The first reconnect after the host connection ended, doubled after each failed one up to the last. */
const RECONNECT_FIRST_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/**
 * How long a connection must have stayed up for its loss to start the delays again from the first: a host that
 * dies soon after each start keeps the growing delay, rather than being restarted every second.
 */
const RECONNECT_STABLE_MS = 30_000
/** How long a drained host is given to exit after its `shutdown`. */
const HOST_EXIT_WAIT_MS = 3_000

export interface PtyHostBackendOptions {
  /** The host's `--home` (`HARNESS_PTY_DIR`): its discovery file and logs live there. */
  home: string
  /** A drain backend's host instance (`p2-0.4.20`, a legacy `p1`): set, the backend is a drain backend. */
  instance?: string
  /**
   * The daemon's target host (`targetHost`, read once as the core starts). A create backend makes panes on its
   * instance alone; a drain backend weighs its own host's version against it (`mayShutDown`). Null or absent: unknown.
   */
  target?: PtyHostTarget | null
  /** Reach or start the host (`ensurePtyHost`; a drain backend's only reaches it, `reachPtyHost`); a seam for tests. */
  launch?: (home: string) => Promise<EnsurePtyHostResult | ReachPtyHostResult>
  /** Whether a pid runs (`pidAlive`), and the process table (`processRows`) a drain host's death is proven in; a seam
   *  for tests. */
  hostProcess?: { alive: (pid: number) => boolean; rows: () => Promise<ProcessRow[] | null> }
  /** The tag this daemon's panes carry, read at every create and inventory, as `TmuxBackend` reads it. */
  owner?: () => string
  /** The platform it runs on (`process.platform`); a seam for the Windows wiring's tests. */
  platform?: NodeJS.Platform
  /** End a process and its descendants (windows/treeKill.ts `endProcessTree`); a seam for tests. */
  endTree?: (pid: number) => Promise<TreeKillOutcome>
}

/**
 * What this backend knows of a pane it made or held. `hold` mirrors the host's: a held pane stays when its
 * process ends (`exited` is then its status), an unheld one is removed by the host, and so forgotten here.
 */
export interface PtyPaneRecord {
  hold: boolean
  /** The exit the host reported for a held pane; absent while its process runs. */
  exited?: number | null
}

/** The host's answer as a terminal action result: `rejected` and `not_started` keep the host's own reason. */
function actionOf(result: PtyHostCallResult<unknown>): TerminalActionResult {
  if (result.state === 'ok') return TERMINAL_ACTION_SUCCEEDED
  if (result.state === 'failed') return { state: 'failed', dispatch: result.dispatch, reason: result.reason }
  return terminalActionPossiblyExecuted(result.reason)
}

/**
 * What runs in a pane created with no command on [platform]: the user's shell, as tmux's `default-shell` is. On
 * Windows, PowerShell (lib/windows/shell.ts).
 */
function defaultCommand(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return defaultWindowsShell()
  return [process.env.SHELL || '/bin/sh']
}

/** `#{pane_current_command}`'s form of an argv: the program's file name. */
function commandName(argv: readonly string[]): string {
  const first = argv[0] ?? ''
  return first.slice(Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\')) + 1)
}

const UNAVAILABLE = 'pty host is unavailable'
const HOST_GONE = 'the pty host has exited'

/** `shutdownHost`'s outcome: the host has gone; it still has panes and stays; it could not be asked; or its protocol
 *  has no `shutdown` and it stays. */
export type PtyHostShutdown = 'exited' | 'refused' | 'failed' | 'unsupported'
/** `drainState`: the host has gone; it has no pane at all (any owner's); it has some; or it could not be asked. */
export type PtyHostDrainState = 'gone' | 'empty' | 'busy' | 'unknown'

export class PtyHostBackend implements TerminalBackend<PtyRuntimeRef> {
  readonly name = 'ptyhost' as const
  /** A backend for a host other than the target's: never made new panes on, shut down once it has none. */
  readonly draining: boolean

  private readonly home: string
  private readonly target: PtyHostTarget | null
  /** A drain host's version, from its discovery file, once read. */
  private hostVersion: string | null = null
  private readonly launch: (home: string) => Promise<EnsurePtyHostResult | ReachPtyHostResult>
  private readonly hostProcess: { alive: (pid: number) => boolean; rows: () => Promise<ProcessRow[] | null> }
  /** A drain backend's host has exited, and why: its panes are gone and nothing starts it again. */
  private gone: string | null = null
  /**
   * A drain backend's host process as the process table showed it once reached: its death is proven by that pid
   * leaving the table, or by another process (another start marker) having it. Null until read.
   */
  private hostIdentity: ProcessIdentity | null = null
  private readonly owner: () => string
  private readonly platform: NodeJS.Platform
  private readonly endTree: (pid: number) => Promise<TreeKillOutcome>
  /** Whether this backend set the process table source and the agent signaller (Windows), for `dispose`. */
  private windowsSeams = false
  private client: PtyHostClient | null = null
  private instance: string | null = null
  private readonly panes = new Map<string, PtyPaneRecord>()
  /** The current client's event and close subscriptions. */
  private subscriptions: Array<() => void> = []
  /** The pid of the last host reached: a reconnect to another is a host that died and was started again. */
  private hostPid: number | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelay = RECONNECT_FIRST_MS
  /** When the current connection was made. */
  private connectedAt = 0
  private disposed = false

  /** Called when a reconnect reached another host than before: every pane of the old one is gone. */
  onHostReplaced?: () => void

  constructor(options: PtyHostBackendOptions) {
    this.home = options.home
    this.target = options.target ?? null
    this.draining = options.instance !== undefined
    // A drain backend's instance is known before its host is reached: when it has gone, the rows still name it.
    const drainInstance = options.instance
    if (drainInstance !== undefined) this.instance = drainInstance
    this.hostProcess = options.hostProcess ?? { alive: pidAlive, rows: processRows }
    this.owner = options.owner ?? (() => harnessPaneOwner(env.ADAPTER_DATA_DIR))
    this.platform = options.platform ?? process.platform
    // A dead host's endpoint is never dialled (launch.ts `discoveredHostDead`). On Windows its pipe name can be
    // taken by anyone once the host is gone, so the process table is read for a pid since given to another process;
    // elsewhere the pid alone (a Unix socket lives in the owner-only run directory).
    const liveness: HostLiveness = this.platform === 'win32'
      ? { alive: (pid) => this.hostProcess.alive(pid), rows: () => this.hostProcess.rows() }
      : { alive: (pid) => this.hostProcess.alive(pid) }
    this.launch = options.launch ?? (drainInstance !== undefined
      ? ((home) => reachPtyHost(home, drainInstance, liveness))
      : (async (home) => ensurePtyHost(home, { target: await this.pinnedTarget(liveness), liveness })))
    this.endTree = options.endTree ?? ((pid) => this.endTreeOf(pid))
  }

  /**
   * The host the create backend reaches: the target's; with none, once it has been attached, the instance it took,
   * while that host is not proven dead. A reconnect while it only does not answer must not take another build's host
   * instead: that host's pid would read as a replaced host, and every pane of the one it was on as gone. Once it is
   * proven dead (its discovery file gone, or `discoveredHostDead`), its panes are gone anyway, and the reconnect takes
   * the newest host that answers or the one the binary starts, as with no pin; `onHostReplaced` then says so. The pin
   * names only the instance, which is all `ensurePtyHost` matches on.
   */
  private async pinnedTarget(liveness: HostLiveness): Promise<PtyHostTarget | null> {
    if (this.target || this.instance === null) return this.target
    const pin: PtyHostTarget = { protocol: instanceProtocol(this.instance) ?? PTY_PROTOCOL, version: '', instance: this.instance, features: [], source: 'binary' }
    const discovery = readInstanceDiscovery(this.home, this.instance)
    if (!discovery) {
      // A file caught mid-write is still there: no proof. A host takes its file down only as it exits.
      const file = discoveryFileName(this.instance)
      return file && existsSync(path.join(this.home, 'run', file)) ? pin : null
    }
    return await discoveredHostDead(this.home, discovery, liveness) ? null : pin
  }

  /**
   * Whether the drain may shut this backend's host down once it is empty (ptyHost/drain.ts). Never with no target:
   * the host may be the one the create backend took. Never for a host newer than a target the binary named (a dev
   * build's `HARNESS_PTY_BIN`): that newer host is the installed one's, and stays for its daemon. A newer host under an
   * installed target is a downgrade or a rollback, and goes like any other. A host whose version cannot be read is
   * not known to be older, so it stays too. Always false for the create backend.
   */
  get mayShutDown(): boolean {
    if (!this.draining || !this.target) return false
    if (this.target.source === 'installed') return true
    const version = this.drainHostVersion()
    return version !== null && compareVersions(version, this.target.version) <= 0
  }

  /** The drain host's version, from its discovery file: an instance is one build, so once read it is kept. */
  private drainHostVersion(): string | null {
    if (this.hostVersion === null && this.instance !== null) this.hostVersion = readInstanceDiscovery(this.home, this.instance)?.version ?? null
    return this.hostVersion
  }

  /** `ptyhost:<instance>`, the instance being the host's (ptyHost/instance.ts), known once `prepare` reached it. */
  get instanceId(): string {
    return `ptyhost:${this.instance ?? 'unprepared'}`
  }

  async prepare(context: { ownedPanes: ReadonlyMap<string, AgentEngine> }): Promise<TerminalBackendPrepared> {
    void context
    this.disposed = false
    this.cancelReconnect()
    // The process table and the signaller are the machine's, not a host's: the create backend's alone.
    if (this.platform === 'win32' && !this.draining) this.installWindowsSeams()
    if (this.gone) return { state: 'ready' }
    const reached = await this.launch(this.home)
    if (this.draining && 'unavailable' in reached) {
      const gone = await this.provenGone(reached)
      if (gone) {
        this.markGone(gone)
        return { state: 'ready' }
      }
    }
    // A drain host that does not answer yet, and is not proven gone, is still the one its panes are on: ready,
    // reconnecting, its inventory unavailable (so its panes are kept) until it answers or is proven gone.
    if (this.draining && !('client' in reached)) {
      console.error(`[terminal] ptyhost: draining ${this.instance} unavailable (${'incompatible' in reached ? reached.incompatible : reached.unavailable}); reconnecting`)
      this.scheduleReconnect()
      return { state: 'ready' }
    }
    if ('incompatible' in reached) {
      console.error(`[terminal] ptyhost: unavailable (${reached.incompatible})`)
      return { state: 'unavailable', code: 'PTY_HOST_UNAVAILABLE', reason: reached.incompatible }
    }
    if ('unavailable' in reached) {
      console.error(`[terminal] ptyhost: unavailable (${reached.unavailable})`)
      return { state: 'unavailable', code: reached.code, reason: reached.unavailable }
    }
    this.attach(reached.client)
    console.log(`[terminal] ptyhost: available (${this.instance}${this.draining ? ', draining' : ''})`)
    return { state: 'ready' }
  }

  /** A drain backend's host has exited, and why (null while it runs). */
  get hostGone(): string | null {
    return this.gone
  }

  /**
   * The drain host has exited for good: its panes are gone with it, and nothing starts it again. Its inventory is
   * from now on authoritative and empty, so the reconciler counts its panes' rows missing as it does any pane's.
   */
  private markGone(reason: string): void {
    if (this.gone) return
    this.gone = reason
    this.cancelReconnect()
    const client = this.client
    this.detach()
    client?.close()
    this.panes.clear()
    console.log(`[terminal] ptyhost: draining ${this.instance} has gone (${reason})`)
    this.onHostReplaced?.()
  }

  /**
   * Why the drain host that did not answer [reached] has gone, or null when that is not proven: its panes are kept
   * (unavailable) until it is. Proven only by the process table: the last host reached (or the one the discovery
   * file names) is not in it, or another process has its pid (another start marker than when it was reached). A
   * table that cannot be read, a pid that runs, a discovery file that cannot be read: no proof. One exception: no
   * discovery file at all and no host ever reached, which leaves no process to look for; a host keeps its file for
   * its life (protocol 2 on takes it down only as it exits).
   */
  private async provenGone(reached: PtyHostUnavailable & Partial<PtyHostUnreached>): Promise<string | null> {
    const pid = this.hostPid ?? reached.pid ?? null
    if (pid === null) return reached.missing === true ? reached.unavailable : null
    const rows = await this.hostProcess.rows().catch(() => null)
    if (!rows) return null
    const row = rows.find((candidate) => candidate.pid === pid)
    if (!row) return `the ${this.instance} host (pid ${pid}) has exited`
    if (this.hostIdentity && this.hostIdentity.pid === pid && !sameProcessIdentity(row, this.hostIdentity)) {
      return `the ${this.instance} host (pid ${pid}) has exited; another process has its pid`
    }
    return null
  }

  /** Read the drain host's identity from the process table, once reached: what `provenGone` compares against. */
  private async recordHostIdentity(client: PtyHostClient): Promise<void> {
    const rows = await this.hostProcess.rows().catch(() => null)
    const row = rows?.find((candidate) => candidate.pid === client.pid)
    // Still the host this backend reaches: a reconnect may have reached another meanwhile.
    if (row && this.client === client) this.hostIdentity = processIdentityOf(row)
  }

  /** Whether [runtime] is a pane of this backend's host that has gone. */
  private goneFor(runtime: PtyRuntimeRef): boolean {
    return this.gone !== null && runtime.instance === this.instance
  }

  /**
   * For the drain (ptyHost/drain.ts): whether the host has any pane at all, of any owner. A host another daemon
   * also makes panes on is not empty for this one's sake.
   */
  async drainState(): Promise<PtyHostDrainState> {
    if (this.gone) return 'gone'
    if (!this.client) return 'unknown'
    const result = await this.client.call({ op: 'inventory' })
    if (result.state !== 'ok') return 'unknown'
    return result.value.panes.length === 0 ? 'empty' : 'busy'
  }

  /**
   * End a drained host that has no pane, with the `shutdown` op (protocol 2 on): the host refuses it while it has one,
   * and once granted makes none, so no pane can be lost with it. The backend is then gone (`hostGone`).
   *
   * A host of an older protocol has no such op and is never ended (`unsupported`): nothing there stops a create
   * between an empty inventory and a signal, and `HARNESS_PTY_DIR` is the user's, so another daemon (another data
   * folder) may make a pane on it in that gap. It is left running, idle; only its backend leaves (ptyHost/drain.ts).
   */
  async shutdownHost(): Promise<PtyHostShutdown> {
    if (this.gone) return 'exited'
    const client = this.client
    if (!client) return 'failed'
    if (client.protocol < SHUTDOWN_PROTOCOL) return 'unsupported'
    const pid = client.pid
    const result = await client.call({ op: 'shutdown' })
    if (result.state === 'failed' && result.code === 'bad_request') return 'refused'
    if (result.state !== 'ok') return 'failed'
    const deadline = Date.now() + HOST_EXIT_WAIT_MS
    while (this.hostProcess.alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    if (this.hostProcess.alive(pid)) {
      console.error(`[terminal] ptyhost: the drained ${this.instance} host (pid ${pid}) has not exited`)
      return 'failed'
    }
    if (this.instance !== null) forgetExitedHost(this.home, this.instance, pid)
    this.markGone(`shut down with no panes left (pid ${pid})`)
    return 'exited'
  }

  /**
   * Close the connection to the host, as a daemon exiting does: the host and its panes are left running, for the
   * next daemon to reattach. No reconnect follows.
   */
  dispose(): void {
    this.disposed = true
    this.cancelReconnect()
    if (this.windowsSeams) {
      this.windowsSeams = false
      setProcessTableSource(null)
      setAgentSignaller(null)
    }
    const client = this.client
    this.detach()
    client?.close()
  }

  /**
   * Windows has no `ps` and no signals. The process table is the host's (windows/processTable.ts): asked of
   * whichever client is connected at each read, so a reconnect is followed, and of `harness-pty ps` while none
   * is. An agent's process is ended with its descendants by TerminateProcess (`signalProcess`).
   */
  private installWindowsSeams(): void {
    this.windowsSeams = true
    setProcessTableSource(() => windowsProcessRows(this.client))
    setAgentSignaller((pid, signal) => this.signalProcess(pid, signal))
  }

  /**
   * `process.kill` on Windows, for `signalAgentProcess`: [pid] and every process under it in the host's table end by
   * TerminateProcess, leaves first (windows/treeKill.ts), fire and forget, as a signal is. Its caller has just
   * checked [pid]'s identity (`terminateDeletedAgent`), and checks again for the outcome, escalating as it does on
   * Unix. Not `taskkill /T /F`: Windows refused it to a standard user in an SSH session (treeKill.ts).
   *
   * SIGTERM ends the tree too. Windows has no graceful signal for a console process: there is no window to ask to
   * close (all `taskkill` without /F does), and Node's own `process.kill` is TerminateProcess whatever the
   * signal.
   *
   * The pane is never closed here, even when [pid] is its root (the engine is, in a pty host pane). A restart or
   * a swap holds the pane open, ends its engine through this, then respawns in the same pane
   * (restartAgent.ts, core/agents/swap.ts); the host's `kill` op would remove the pane, and the respawn would
   * find none. Ending the root's tree leaves the held pane dead, as a SIGTERM leaves a tmux pane under
   * remain-on-exit.
   */
  signalProcess(pid: number, signal: AgentSignal): void {
    void this.endTree(pid).then((outcome) => {
      if (outcome === 'failed') console.error(`[terminal] ptyhost: could not end pid ${pid} (${signal})`)
    }).catch((error: unknown) => {
      console.error(`[terminal] ptyhost: could not ${signal} pid ${pid}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * `endProcessTree` over the connected host's table (`harness-pty ps` while none is). A descendant that would not
   * end is said here, as the walk goes on past it; one already gone is not.
   */
  private endTreeOf(pid: number): Promise<TreeKillOutcome> {
    const deps = processTreeKillDeps(this.client)
    return endProcessTree(pid, {
      ...deps,
      kill: (target) => {
        try {
          deps.kill(target)
        } catch (error) {
          if (target !== pid && (error as NodeJS.ErrnoException).code !== 'ESRCH') {
            console.error(`[terminal] ptyhost: could not end pid ${target}, under pid ${pid}: ${(error as Error).message}`)
          }
          throw error
        }
      },
    })
  }

  /** Make [client] this backend's connection, in place of any other. Whether it is another host than the last. */
  private attach(client: PtyHostClient): boolean {
    const previous = this.client
    this.detach()
    if (previous && previous !== client) previous.close()
    this.client = client
    this.instance = client.instance
    const replaced = this.hostPid !== null && this.hostPid !== client.pid
    this.hostPid = client.pid
    this.connectedAt = Date.now()
    // The panes recorded were the old host's.
    if (replaced) this.panes.clear()
    this.subscriptions.push(client.onEvent((event) => this.onEvent(event)))
    this.subscriptions.push(client.onClose(() => this.onConnectionLost(client)))
    if (this.draining) {
      if (this.hostIdentity?.pid !== client.pid) this.hostIdentity = null
      void this.recordHostIdentity(client)
      // Read while its discovery file is surely there: the host that file names has just answered.
      this.drainHostVersion()
    }
    return replaced
  }

  /** Forget the current client: its listeners are removed, and nothing is asked of it any more. */
  private detach(): void {
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
    this.client = null
  }

  private onConnectionLost(client: PtyHostClient): void {
    if (client !== this.client) return
    this.detach()
    console.error('[terminal] ptyhost: lost the connection to the host; reconnecting')
    if (Date.now() - this.connectedAt >= RECONNECT_STABLE_MS) this.reconnectDelay = RECONNECT_FIRST_MS
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  /**
   * One attempt: the host this backend is on, started again if it is not running (`ensurePtyHost`, pinned to the
   * instance by `pinnedTarget`; a drain backend's only reaches it).
   */
  private async reconnect(): Promise<void> {
    let reached: EnsurePtyHostResult | ReachPtyHostResult
    try {
      reached = await this.launch(this.home)
    } catch (error) {
      reached = { unavailable: (error as Error).message, code: 'PTY_HOST_UNAVAILABLE' }
    }
    if (this.disposed) {
      if ('client' in reached) reached.client.close()
      return
    }
    if (this.draining && 'unavailable' in reached) {
      const gone = await this.provenGone(reached)
      if (gone) {
        this.markGone(gone)
        return
      }
    }
    if (!('client' in reached)) {
      console.error(`[terminal] ptyhost: reconnect failed (${'incompatible' in reached ? reached.incompatible : reached.unavailable})`)
      this.scheduleReconnect()
      return
    }
    // Disposed meanwhile, or connected again by a `prepare`: this one is not needed.
    if (this.disposed || this.client) {
      reached.client.close()
      return
    }
    const replaced = this.attach(reached.client)
    console.log(`[terminal] ptyhost: reconnected (${this.instance}${replaced ? ', a new host: its panes are gone' : ''})`)
    if (replaced) this.onHostReplaced?.()
  }

  /** What this backend knows of [runtime]'s pane, for the host-death handling and its tests. */
  known(runtime: PtyRuntimeRef): Readonly<PtyPaneRecord> | undefined {
    return runtime.instance === this.instance ? this.panes.get(runtime.paneId) : undefined
  }

  private onEvent(event: PtyEvent): void {
    if (event.event !== 'exit') return
    const record = this.panes.get(event.pane)
    if (!record) return
    if (record.hold) record.exited = event.status
    else this.panes.delete(event.pane)
  }

  /** The client for [runtime], or null when the host is not reached or the pane is another host instance's. */
  private clientFor(runtime: PtyRuntimeRef): PtyHostClient | null {
    return this.client && runtime.instance === this.instance ? this.client : null
  }

  /** Always: the host takes a pane's environment at create, nothing ever puts it in an argv. */
  async capabilities(): Promise<TerminalBackendCapabilities> {
    return { sessionEnv: true }
  }

  /** Whether a host is attached now: false before `prepare` reached one, while a lost connection is reconnecting, and
   *  once disposed. With a target, the create backend attaches to the target's host alone. */
  get attached(): boolean {
    return this.client !== null && !this.disposed
  }

  /** Whether the host attached now lists `seed`; read live, as the client is replaced on reconnect. False when unattached. */
  get canSeed(): boolean {
    return this.client?.features.includes(SEED_FEATURE) ?? false
  }

  async create(request: TerminalCreateRequest): Promise<TerminalCreateResult<PtyRuntimeRef>> {
    if (this.draining) return terminalActionNotStarted(`the ${this.instance} pty host is draining: new panes go to the target host`)
    const client = this.client
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    // A pre-G host drops `seed` silently, which would look like a pane that kept its scrollback: refuse instead.
    if (request.seed !== undefined && !client.features.includes(SEED_FEATURE)) return terminalActionNotStarted('this host cannot seed a pane')
    if (request.current?.() === false) return terminalActionNotStarted('The harness changed before pane dispatch')
    request.onDispatch?.()
    // Held from the start, as tmux's remain-on-exit at create: an engine that exits at once still leaves
    // its error readable. The agent services release it once the pane is a real agent (`releaseHold`).
    const result = await client.call({
      op: 'create',
      command: request.command?.length ? request.command : defaultCommand(this.platform),
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.env && Object.keys(request.env).length ? { env: request.env } : {}),
      cols: CREATE_COLS,
      rows: CREATE_ROWS,
      owner: this.owner(),
      ...(request.label ? { label: request.label } : {}),
      hold: true,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      // Windows: the shell the pane becomes when its engine exits, made by the host (lib/windows/engineStart.ts).
      ...(request.afterExit ? { afterExit: { command: request.afterExit.command, ...(request.afterExit.env ? { env: request.afterExit.env } : {}) } } : {}),
      // Windows: what the pane must not inherit from the host's environment (a grid launch's provider keys).
      ...(request.clearInherited?.length ? { clearInherited: [...request.clearInherited] } : {}),
    })
    if (result.state !== 'ok') return actionOf(result) as TerminalCreateResult<PtyRuntimeRef>
    // Recorded here, before any other await: an exit that overtook this reply is released by the client
    // on the next turn (client.ts), and must find the pane known.
    this.panes.set(result.value.pane, { hold: true })
    return { state: 'succeeded', dispatch: 'executed', runtime: { backend: 'ptyhost', instance: client.instance, paneId: result.value.pane } }
  }

  async kill(runtime: PtyRuntimeRef, current?: () => boolean): Promise<TerminalActionResult> {
    // Its host has gone: the pane is closed already.
    if (this.goneFor(runtime)) return TERMINAL_ACTION_SUCCEEDED
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    if (current && !current()) return terminalActionNotStarted('The harness changed before pane close')
    const result = await client.call({ op: 'kill', pane: runtime.paneId, graceMs: KILL_GRACE_MS })
    // A pane the host does not have is closed already, as tmux's kill reads an authoritative absence.
    if (result.state === 'ok' || (result.state === 'failed' && result.code === 'no_pane')) {
      this.panes.delete(runtime.paneId)
      return TERMINAL_ACTION_SUCCEEDED
    }
    return actionOf(result)
  }

  async inventory(): Promise<TerminalInventoryResult> {
    // A drain host that has gone has no pane, for certain: an answer, not an outage.
    if (this.gone) return { state: 'available', roots: [] }
    if (!this.client) return { state: 'unavailable', reason: UNAVAILABLE }
    const instance = this.client.instance
    const result = await this.client.call({ op: 'inventory' })
    if (result.state !== 'ok') return { state: 'unavailable', reason: result.reason }
    const owner = this.owner()
    return {
      state: 'available',
      // This daemon's panes alone, as tmux's listing (`ownedHere`). A held pane whose process ended is
      // listed with its last pid, as tmux lists a dead pane's: a placement missing from inventory is
      // evicted after a few passes (terminalAgentReconciler.ts), and a failed create or restart must
      // keep its tile and its error on screen.
      roots: result.value.panes
        .filter((pane) => pane.owner === owner && pane.rootPid !== null)
        .map((pane) => ({
          runtime: { backend: 'ptyhost' as const, instance, paneId: pane.pane },
          rootPid: pane.rootPid!,
          cwd: pane.cwd,
          ...(pane.label ? { label: pane.label } : {}),
        })),
    }
  }

  async titles(): Promise<TerminalReadResult<Map<string, string>>> {
    if (this.gone) return { state: 'succeeded', value: new Map() }
    if (!this.client) return { state: 'failed', reason: UNAVAILABLE }
    const instance = this.client.instance
    const result = await this.client.call({ op: 'titles' })
    if (result.state !== 'ok') return { state: 'failed', reason: result.reason }
    return {
      state: 'succeeded',
      value: new Map(Object.entries(result.value.titles).map(([paneId, title]) => [terminalRouteKey({ backend: 'ptyhost', instance, paneId }), title])),
    }
  }

  /** `TmuxBackend.validate`, over this backend's root process; on Windows the engine must be in the pane's Job too. */
  async validate(runtime: PtyRuntimeRef, expected: TerminalProcessExpectation): Promise<RuntimeValidation> {
    return this.validateOn(this.platform, runtime, expected)
  }

  /**
   * `validate` as it runs on [platform]. On Windows the engine found under the pane's root must also be in the
   * pane's Job (`jobPids`): every process the root started is, unless it broke away, and nothing else is. A pid
   * the table shows under the root but the Job does not hold is another process that has its number. A failed
   * `jobPids` is `unknown`, never `gone`: no evidence either way.
   */
  async validateOn(platform: NodeJS.Platform, runtime: PtyRuntimeRef, expected: TerminalProcessExpectation): Promise<RuntimeValidation> {
    let found: Awaited<ReturnType<typeof lookupPaneEngineProcess>>
    try {
      found = await lookupPaneEngineProcess(this, runtime, expected.engine)
    } catch {
      return { state: 'unknown', reason: 'pty host runtime probe failed' }
    }
    if (!found.ok) return { state: found.unknown ? 'unknown' : 'gone', reason: found.reason }
    // A saved marker that can never equal one read today (see `TmuxBackend.validate`; a Windows `w:` marker
    // can): the pane still runs a matching engine, take it.
    const compared = expected.processIdentity && comparableStartMarker(expected.processIdentity.startMarker)
    if (compared && !sameProcessIdentity(expected.processIdentity, found.identity)) {
      return { state: 'gone', reason: 'process changed under ptyhost pane', replaced: true }
    }
    if (platform !== 'win32') return { state: 'alive' }
    const client = this.clientFor(runtime)
    if (!client) return { state: 'unknown', reason: UNAVAILABLE }
    const job = await client.call({ op: 'jobPids', pane: runtime.paneId })
    if (job.state !== 'ok') return { state: 'unknown', reason: `pty host could not list the pane job: ${job.reason}` }
    if (!job.value.pids.includes(found.identity.pid)) return { state: 'gone', reason: 'process is not in the pane job' }
    return { state: 'alive' }
  }

  /**
   * Exactly as `TmuxBackend.capture` hands the options to `tmuxCaptureArgs`: `visible` is the screen alone,
   * every other mode history bounded to 20–300 lines (100 by default), with colours unless asked for none.
   */
  async capture(runtime: PtyRuntimeRef, options: TerminalCaptureOptions = {}): Promise<TerminalReadResult<string>> {
    const client = this.clientFor(runtime)
    if (!client) return { state: 'failed', reason: this.goneFor(runtime) ? HOST_GONE : UNAVAILABLE }
    const visible = options.mode === 'visible'
    const result = await client.call({
      op: 'capture',
      pane: runtime.paneId,
      visible,
      ...(visible ? {} : { historyLines: Math.max(20, Math.min(300, Math.floor(options.historyLines ?? 100))) }),
      ansi: options.ansi !== false,
    })
    return result.state === 'ok' ? { state: 'succeeded', value: result.value.text } : { state: 'failed', reason: result.reason }
  }

  /** Typed as `tmux paste-buffer` without `-p` types it (sendLiteralToTmux): each newline a carriage return. */
  async typeLiteral(runtime: PtyRuntimeRef, text: string): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    return actionOf(await client.call({ op: 'paste', pane: runtime.paneId, text, bracketed: false }))
  }

  /**
   * `sendToTmux`'s submit: one bracketed paste (the host neutralizes its controls, term/src/paste.rs), the
   * settle a long or multi-line paste needs (submitTiming.ts), then `beforeEnter` and the authority fence,
   * then Enter.
   */
  async submitText(runtime: PtyRuntimeRef, text: string, options?: SubmitOptions): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    const content = submitContent(text)
    const settle = submitSettleMs(content)
    if (options?.allowed && !options.allowed()) return terminalActionNotStarted('terminal control revoked')
    const pasted = await client.call({ op: 'paste', pane: runtime.paneId, text: content, bracketed: true })
    if (pasted.state !== 'ok') return actionOf(pasted)
    if (settle) await new Promise((resolve) => setTimeout(resolve, settle))
    const withheld = options?.beforeEnter ? await options.beforeEnter() : null
    if (withheld) return terminalEnterWithheld(withheld)
    if (options?.allowed && !options.allowed()) return terminalEnterWithheld('terminal control revoked')
    return actionOf(await client.call({ op: 'key', pane: runtime.paneId, key: 'Enter' }))
  }

  /** The host's raw `write`: the bytes a stream's input frame carries, sent as they are. */
  async writeInput(runtime: PtyRuntimeRef, bytes: Uint8Array): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    return actionOf(await client.call({ op: 'write', pane: runtime.paneId, data: Buffer.from(bytes).toString('base64') }))
  }

  /** The host's bracketed `paste`, which brackets only when the program asked for it: what a stream's Paste
   *  frame writes (pty/src/stream.rs). */
  async pasteInput(runtime: PtyRuntimeRef, text: string): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    return actionOf(await client.call({ op: 'paste', pane: runtime.paneId, text, bracketed: true }))
  }

  async sendKey(runtime: PtyRuntimeRef, key: TerminalLogicalKey): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    return actionOf(await client.call({ op: 'key', pane: runtime.paneId, key: TMUX_KEYS[key] }))
  }

  async setTitle(runtime: PtyRuntimeRef, title: string): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    return actionOf(await client.call({ op: 'setTitle', pane: runtime.paneId, title: title.slice(0, 200) }))
  }

  /** Nothing to do: the host has no status line, and the daemon's own notifications already say it. */
  async notify(runtime: PtyRuntimeRef, title: string, body: string): Promise<TerminalActionResult> {
    void [runtime, title, body]
    return TERMINAL_ACTION_SUCCEEDED
  }

  /** Keep the pane when its process ends, ahead of killing that process for a restart (tmux's remain-on-exit). */
  async holdOpen(runtime: PtyRuntimeRef, current?: () => boolean): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    if (current?.() === false) return terminalActionNotStarted('The harness changed before retaining its pane')
    const result = await client.call({ op: 'holdOpen', pane: runtime.paneId })
    if (result.state === 'ok') {
      const record = this.panes.get(runtime.paneId)
      if (record) record.hold = true
      else this.panes.set(runtime.paneId, { hold: true })
    }
    return actionOf(result)
  }

  /**
   * tmux's `respawn-pane -k`: the host kills a process still running in the pane, then starts [request]'s in
   * the same pane and grid. With `expectedHeldToken`, only over the held shell under that token, checked on
   * the host in the same op (`heldPaneFormat`).
   */
  async respawn(runtime: PtyRuntimeRef, request: TerminalRespawnRequest): Promise<TerminalActionResult> {
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    if (request.expectedHeldToken && !/^[a-f0-9-]{36}$/.test(request.expectedHeldToken)) return terminalActionNotStarted('invalid waiting pane identity')
    if (request.current?.() === false) return terminalActionNotStarted('The harness changed before pane dispatch')
    request.onDispatch?.()
    const result = await client.call({
      op: 'respawn',
      pane: runtime.paneId,
      command: request.command,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.env && Object.keys(request.env).length ? { env: request.env } : {}),
      ...(request.expectedHeldToken ? { expectedHeldToken: request.expectedHeldToken } : {}),
      // The host keeps each pane's create env, as tmux keeps its session's: a respawn inherits it, less these.
      ...(request.clearEnv?.length ? { clearEnv: [...request.clearEnv] } : {}),
      // Windows: what this launch must not inherit from the host's environment, this launch alone.
      ...(request.clearInherited?.length ? { clearInherited: [...request.clearInherited] } : {}),
      ...(request.afterExit ? { afterExit: { command: request.afterExit.command, ...(request.afterExit.env ? { env: request.afterExit.env } : {}) } } : {}),
    })
    if (result.state === 'ok') {
      // The host absorbs the replaced process's exit; the pane runs again.
      const record = this.panes.get(runtime.paneId)
      if (record) delete record.exited
      return TERMINAL_ACTION_SUCCEEDED
    }
    // The host checked the token against the pane and replaced nothing, as tmux's `adoption-mismatch`.
    if (result.state === 'failed' && result.code === 'held_mismatch') return terminalActionNotStarted('The waiting pane changed')
    // Never sent, or no such pane: nothing was killed.
    if (result.state === 'failed' && result.dispatch === 'not_started') return terminalActionNotStarted(result.reason)
    // The old process may be gone though the new one never started (`-k`, as `TmuxBackend.respawn` says).
    return terminalActionPossiblyExecuted(`pty host could not respawn the pane: ${result.reason}`)
  }

  /**
   * Read only: the pane runs the held shell under [token], as tmux's `heldPaneFormat` reads the start
   * command. The respawn repeats the check on the host; this read grants no later write.
   */
  async isHeld(runtime: PtyRuntimeRef, token: string): Promise<boolean | 'unknown'> {
    if (!/^%\d+$/.test(runtime.paneId) || !/^[a-f0-9-]{36}$/.test(token)) return 'unknown'
    if (this.goneFor(runtime)) return false
    const client = this.clientFor(runtime)
    if (!client) return 'unknown'
    const result = await client.call({ op: 'paneState', pane: runtime.paneId })
    if (result.state !== 'ok') return 'unknown'
    const state = result.value.state
    return state !== 'gone' && !state.dead && isHeldStartCommand(state.startCommand, token)
  }

  /**
   * Close the pane only while it is the held shell under [token], dead or alive, as tmux's `heldPaneFormat` reads a
   * remain-on-exit pane: an adoption cancelled, or rolled back. Read, then closed, where tmux does both in one
   * `if-shell`. The gap cannot name another pane: a host never gives a pane id out twice for its home
   * (pty/src/pane_ids.rs). And nothing replaces a held shell here but the daemon's own respawn (the shell has no
   * tmux to replace itself with), which [current] fences.
   */
  async killHeld(runtime: PtyRuntimeRef, token: string, current: () => boolean): Promise<TerminalActionResult> {
    if (!/^%\d+$/.test(runtime.paneId) || !/^[a-f0-9-]{36}$/.test(token)) return terminalActionNotStarted('invalid waiting pane identity')
    if (this.goneFor(runtime)) return TERMINAL_ACTION_SUCCEEDED
    const client = this.clientFor(runtime)
    if (!client) return terminalActionNotStarted(UNAVAILABLE)
    const result = await client.call({ op: 'paneState', pane: runtime.paneId })
    if (result.state !== 'ok') return terminalActionNotStarted(result.reason)
    const state = result.value.state
    // Gone already: closed, as tmux reads an authoritative absence.
    if (state === 'gone') return TERMINAL_ACTION_SUCCEEDED
    if (!isHeldStartCommand(state.startCommand, token)) return terminalActionNotStarted('The waiting pane no longer has this adoption identity')
    if (!current()) return terminalActionNotStarted('Adoption changed before pane close')
    return this.kill(runtime, current)
  }

  async releaseHold(runtime: PtyRuntimeRef, current?: () => boolean): Promise<void> {
    const client = this.clientFor(runtime)
    if (!client || current?.() === false) return
    const result = await client.call({ op: 'releaseHold', pane: runtime.paneId })
    const record = this.panes.get(runtime.paneId)
    if (result.state !== 'ok' || !record) return
    // A pane whose process already ended is removed by the release itself.
    if (record.exited !== undefined) this.panes.delete(runtime.paneId)
    else this.panes.set(runtime.paneId, { hold: false })
  }

  async paneState(runtime: PtyRuntimeRef): Promise<TerminalPaneRead> {
    if (this.goneFor(runtime)) return 'gone'
    const client = this.clientFor(runtime)
    if (!client) return 'unknown'
    const result = await client.call({ op: 'paneState', pane: runtime.paneId })
    if (result.state !== 'ok') return 'unknown'
    const state = result.value.state
    if (state === 'gone') return 'gone'
    return { dead: state.dead, exitStatus: state.exitStatus, command: commandName(state.command), engineExit: state.engineExit }
  }

  async paneInfo(runtime: PtyRuntimeRef): Promise<TerminalPaneInfo | null> {
    const client = this.clientFor(runtime)
    if (!client) return null
    const result = await client.call({ op: 'paneInfo', pane: runtime.paneId })
    return result.state === 'ok' ? result.value.info : null
  }

  /**
   * The pane's root pid. `'missing'` for a pane the host does not have, and for a held pane whose process
   * ended: nothing runs there, which every caller reads as tmux's dead pane reads (no engine under it).
   */
  async rootProcess(runtime: PtyRuntimeRef): Promise<number | 'missing' | null> {
    // Its host has gone, and the pane with it: `validate` reads `gone`, as for a pane the host does not have.
    if (this.goneFor(runtime)) return 'missing'
    const client = this.clientFor(runtime)
    if (!client) return null
    const result = await client.call({ op: 'paneInfo', pane: runtime.paneId })
    if (result.state === 'failed' && result.code === 'no_pane') return 'missing'
    if (result.state !== 'ok') return null
    return result.value.info.pid ?? 'missing'
  }

  /**
   * A stream on the pane, over a stream connection of its own. As `TmuxBackend.openStream`, `expected` is not
   * checked: a pane whose engine has gone still shows why.
   */
  async openStream(
    runtime: PtyRuntimeRef,
    expected: TerminalProcessExpectation,
    size: TerminalStreamSize,
    sink: TerminalStreamSink,
    readOnly?: boolean,
  ): Promise<TerminalReadResult<TerminalStreamHandle<PtyRuntimeRef>>> {
    void expected
    const client = this.clientFor(runtime)
    if (!client) return { state: 'failed', reason: UNAVAILABLE }
    const connection = await client.openStream()
    if (!connection) return { state: 'failed', reason: 'pty host stream connection is unavailable' }
    return PtyHostStream.open(connection, runtime, size, sink, readOnly === true)
  }
}
