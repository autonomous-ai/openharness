/**
 * What harnessd's master and its core say to each other over the spawn channel (Node IPC).
 *
 * Small on purpose. The core says when it is bound, when it is ready and that it is alive; the master
 * tells it its own status. Everything else the daemon does goes through the core's local API, never
 * through here.
 *
 * Messages are only ever added, and a side ignores what it does not know: during an update an older
 * master supervises a newer core, and after a rollback a newer master supervises an older one. Each
 * core states its protocol in `bound`, and the master holds it to what that version can say — a
 * protocol 1 core has no `ready`.
 */
import type { SupervisorStatus } from './supervisor.js'

/** 2: `ready`, the event-loop delay on the heartbeat, and the exit-code contract below. */
export const HARNESSD_PROTOCOL = 2

/** The exit code a core uses to be restarted at once on the bundle now on disk (a staged update). */
export const CORE_EXIT_UPDATE = 75

/**
 * The exit code a core uses to stop for good — this computer was removed from its account, or it is
 * connected from another one — so the master stops with it. Any other exit is a crash, 0 included: Node
 * also exits 0 when its event loop runs out of work, and a SIGTERM from outside must not take the daemon
 * down. (Protocol 1 cores stopped for good with 0.)
 */
export const CORE_EXIT_STOP = 78

export type CoreMessage =
  /** The control port is bound: from here on the daemon answers, though start-up is not done. */
  | { type: 'harnessd:bound'; protocol: number; port: number }
  /** Start-up is done and requests are being served (protocol 2) — or, with `safeMode`, start-up gave
   *  way to safe mode: the updater alone runs, waiting for a fix. */
  | { type: 'harnessd:ready'; safeMode?: string }
  /** Sent every few seconds; a core that stops sending is hung. `loopDelayMs`: the longest the event
   *  loop was held since the last one (protocol 2). */
  | { type: 'harnessd:heartbeat'; rssBytes: number; heapUsedBytes: number; loopDelayMs?: number }

export type MasterMessage =
  | { type: 'harnessd:status'; status: SupervisorStatus }

export function isCoreMessage(value: unknown): value is CoreMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  switch (message.type) {
    case 'harnessd:bound':
      return Number.isInteger(message.protocol) && Number.isInteger(message.port)
    case 'harnessd:ready':
      return message.safeMode === undefined || typeof message.safeMode === 'string'
    case 'harnessd:heartbeat':
      return typeof message.rssBytes === 'number' && typeof message.heapUsedBytes === 'number'
        && (message.loopDelayMs === undefined || typeof message.loopDelayMs === 'number')
    default:
      return false
  }
}

export function isMasterMessage(value: unknown): value is MasterMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return message.type === 'harnessd:status' && !!message.status && typeof message.status === 'object'
}
