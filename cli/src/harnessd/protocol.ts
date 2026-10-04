/**
 * What harnessd's master and its core say to each other over the spawn channel (Node IPC).
 *
 * Small on purpose. The core says when it is bound and that it is alive; the master tells it its own
 * status. Everything else the daemon does goes through the core's local API, never through here.
 * A change to these shapes bumps `HARNESSD_PROTOCOL`.
 */
import type { SupervisorStatus } from './supervisor.js'

export const HARNESSD_PROTOCOL = 1

/** The exit code a core uses to be restarted at once on the bundle now on disk (a staged update). */
export const CORE_EXIT_UPDATE = 75

export type CoreMessage =
  /** The control port is bound: from here on the daemon answers. */
  | { type: 'harnessd:bound'; protocol: number; port: number }
  /** Sent every few seconds; a core that stops sending is hung. */
  | { type: 'harnessd:heartbeat'; rssBytes: number; heapUsedBytes: number }

export type MasterMessage =
  | { type: 'harnessd:status'; status: SupervisorStatus }

export function isCoreMessage(value: unknown): value is CoreMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  switch (message.type) {
    case 'harnessd:bound':
      return Number.isInteger(message.protocol) && Number.isInteger(message.port)
    case 'harnessd:heartbeat':
      return typeof message.rssBytes === 'number' && typeof message.heapUsedBytes === 'number'
    default:
      return false
  }
}

export function isMasterMessage(value: unknown): value is MasterMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return message.type === 'harnessd:status' && !!message.status && typeof message.status === 'object'
}
