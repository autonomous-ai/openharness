/**
 * The core's half of harnessd's spawn channel (see ./protocol.ts and ./supervisor.ts).
 *
 * Inert unless a harnessd master started this process: a core run on its own (`harness __run`, the
 * test harness) behaves exactly as before.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { HARNESSD_PROTOCOL, isMasterMessage, type CoreMessage } from './protocol.js'
import type { SupervisorStatus } from './supervisor.js'

/** How much the event loop was held since the last beat: the longest pause, in ms. */
export interface LoopDelay {
  /** The longest the loop was held since the last call, and start counting again. */
  take(): number
  stop(): void
}

/** The event-loop delay monitor this process runs while it beats. */
export function processLoopDelay(): LoopDelay {
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  return {
    take: () => {
      // Nanoseconds; 0 before the first sample.
      const longest = Math.round(histogram.max / 1e6)
      histogram.reset()
      return longest
    },
    stop: () => histogram.disable(),
  }
}

/** How often a core tells its master it is alive. The master's patience is several of these. */
export const HEARTBEAT_INTERVAL_MS = 5_000

export interface MasterChannel {
  send?: (message: CoreMessage) => unknown
  once(event: 'disconnect', listener: () => void): unknown
  on(event: 'message', listener: (message: unknown) => void): unknown
  memoryUsage(): { rss: number; heapUsed: number }
  /** The process that started this one: the master, when it holds the channel. */
  readonly parentPid: number
}

export interface CoreLink {
  /** Started by a master, with the channel to it still open. */
  readonly supervised: boolean
  /** The master's pid, as the pid file names the daemon; null without one. Read once, at start: a
   *  core whose master died is handed to launchd, and must not then name it as its master. */
  readonly masterPid: number | null
  /** The control port is bound: the master may now tell everyone the daemon is up. */
  bound(port: number): void
  /** Start-up is done and requests are served — or it gave way to safe mode, and why: the master stops
   *  waiting for it either way, and rolls back an update whose first core ends up in safe mode. */
  ready(safeMode?: string): void
  /** Tell the master, every `HEARTBEAT_INTERVAL_MS`, that this core is alive and how big it is. */
  startHeartbeat(): void
  /** The master is gone. A core without one stops, so nothing is left holding the port. */
  onMasterGone(listener: () => void): void
  /** What the master last said about itself (restarts, the last exit), for `/api/status`. */
  status(): SupervisorStatus | null
  close(): void
}

/** This process's own channel: present only when it was spawned with one (`stdio` 'ipc'). */
export const processChannel: MasterChannel = {
  send: process.send?.bind(process),
  once: process.once.bind(process),
  on: process.on.bind(process),
  memoryUsage: () => process.memoryUsage(),
  parentPid: process.ppid,
}

export function connectToMaster(
  channel: MasterChannel = processChannel,
  env: NodeJS.ProcessEnv = process.env,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  loopDelay: () => LoopDelay = processLoopDelay,
): CoreLink {
  const supervised = env.HARNESSD_SUPERVISED === '1' && typeof channel.send === 'function'
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let delay: LoopDelay | null = null
  let status: SupervisorStatus | null = null
  // A send on a channel the master closed throws; the master is gone and `onMasterGone` says so.
  const send = (message: CoreMessage): void => {
    if (!supervised) return
    try { channel.send!(message) } catch { /* closing */ }
  }
  if (supervised) {
    channel.on('message', (message) => { if (isMasterMessage(message)) status = message.status })
  }
  return {
    supervised,
    masterPid: supervised ? channel.parentPid : null,
    bound: (port) => send({ type: 'harnessd:bound', protocol: HARNESSD_PROTOCOL, port }),
    ready: (safeMode) => send(safeMode === undefined ? { type: 'harnessd:ready' } : { type: 'harnessd:ready', safeMode }),
    startHeartbeat: () => {
      if (!supervised || heartbeat) return
      delay = loopDelay()
      const monitor = delay
      const beat = (): void => {
        const usage = channel.memoryUsage()
        send({ type: 'harnessd:heartbeat', rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, loopDelayMs: monitor.take() })
      }
      beat()
      heartbeat = setInterval(beat, intervalMs)
      heartbeat.unref()
    },
    onMasterGone: (listener) => { if (supervised) channel.once('disconnect', listener) },
    status: () => status,
    close: () => {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      delay?.stop()
      delay = null
    },
  }
}
