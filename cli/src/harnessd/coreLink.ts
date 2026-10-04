/**
 * The core's half of harnessd's spawn channel (see ./protocol.ts and ./supervisor.ts).
 *
 * Inert unless a harnessd master started this process: a core run on its own (`harness __run`, the
 * test harness) behaves exactly as before.
 */
import { HARNESSD_PROTOCOL, isMasterMessage, type CoreMessage } from './protocol.js'
import type { SupervisorStatus } from './supervisor.js'

/** How often a core tells its master it is alive. The master's patience is several of these. */
export const HEARTBEAT_INTERVAL_MS = 5_000

export interface MasterChannel {
  send?: (message: CoreMessage) => unknown
  once(event: 'disconnect', listener: () => void): unknown
  on(event: 'message', listener: (message: unknown) => void): unknown
  memoryUsage(): { rss: number; heapUsed: number }
}

export interface CoreLink {
  /** Started by a master, with the channel to it still open. */
  readonly supervised: boolean
  /** The control port is bound: the master may now tell everyone the daemon is up. */
  bound(port: number): void
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
}

export function connectToMaster(
  channel: MasterChannel = processChannel,
  env: NodeJS.ProcessEnv = process.env,
  intervalMs = HEARTBEAT_INTERVAL_MS,
): CoreLink {
  const supervised = env.HARNESSD_SUPERVISED === '1' && typeof channel.send === 'function'
  let heartbeat: ReturnType<typeof setInterval> | null = null
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
    bound: (port) => send({ type: 'harnessd:bound', protocol: HARNESSD_PROTOCOL, port }),
    startHeartbeat: () => {
      if (!supervised || heartbeat) return
      const beat = (): void => {
        const usage = channel.memoryUsage()
        send({ type: 'harnessd:heartbeat', rssBytes: usage.rss, heapUsedBytes: usage.heapUsed })
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
    },
  }
}
