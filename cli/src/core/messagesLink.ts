/**
 * Agent Messages in its own process, as the core sees it (`HARNESSD_SERVICES=messages`; the process's side is
 * services/messagesProcess.ts): which of its typed deliveries may be written now.
 *
 * The core asks in line, as it writes a `team:` delivery into an idle agent's pane (core/input.ts), and never
 * calls into the process or waits on it for that. The process tells the core instead (`writable`): each
 * delivery it still wants written, until a deadline a few seconds off, told again while it may. A process that
 * stops telling, hung or gone, leaves none writable, and a delivery waits rather than being written against
 * its mailbox's word.
 */
import type { MessagesPort } from './api.js'

export function createMessagesLink(now: () => number = Date.now) {
  /** Each delivery the process says may be written now, and until when. */
  let writable = new Map<string, number>()
  const port: MessagesPort = { canWrite: (deliveryId) => (writable.get(deliveryId) ?? 0) > now() }
  return {
    port,
    /** The core's answers to the process's questions (core/serviceLinks.ts `answer`, for `messages`). */
    answer(query: string, payload: Record<string, unknown>): Record<string, unknown> {
      if (query !== 'writable') return { error: 'UNKNOWN_QUERY' }
      const reported = payload.deliveries && typeof payload.deliveries === 'object' ? payload.deliveries as Record<string, unknown> : {}
      writable = new Map(Object.entries(reported).flatMap(([id, until]) => (typeof until === 'number' ? [[id, until] as const] : [])))
      return {}
    },
  }
}
