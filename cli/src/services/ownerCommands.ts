import { errorKind } from '../lib/log.js'
import type { Asker, RouteAnswer, SendResult } from '../core/api.js'
import { ROUTE_COMMAND_TYPES } from '../lib/relayFrames.js'

const UNAVAILABLE = { error: 'COMMAND_UNAVAILABLE', detail: 'This machine could not complete the command. Try again.' }

/** The paired owner's task routing belongs to the devices. Admission survives a closed connection until actual
 * settlement: timing out a classifier must not make room for an unbounded number of classifiers still running. */
export function createOwnerCommands(deps: {
  task(text: string): Promise<RouteAnswer>
  send(agentId: string, text: string): Promise<SendResult>
  log(line: string): void
}) {
  const pending = new Set<{ connection?: string }>()
  return async (type: string, payload: Record<string, unknown>, asker: Asker, closed?: AbortSignal): Promise<Record<string, unknown>> => {
    if (!asker.owner || asker.guest !== undefined) return { error: 'OWNER_REQUIRED' }
    if (closed?.aborted) return { ...UNAVAILABLE }
    if (!ROUTE_COMMAND_TYPES.has(type)) return { error: 'UNSUPPORTED' }
    if (pending.size >= 8 || (asker.connection !== undefined && [...pending].filter(row => row.connection === asker.connection).length >= 2)) return { error: 'BUSY' }
    const active = { connection: asker.connection }
    pending.add(active)
    try {
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (!text || text.length > 16_000) return { error: 'INVALID_REQUEST' }
      if (type === 'route_task') return { ...await deps.task(text) }
      const agentId = payload.agentId
      if (typeof agentId !== 'string' || !agentId.length || agentId.length > 160) return { error: 'INVALID_REQUEST' }
      return await deps.send(agentId, text)
    } catch (caughtFailure) {
      deps.log(('[devices] owner command COMMAND_UNAVAILABLE') + ' · ' + errorKind(caughtFailure))
      return { ...UNAVAILABLE }
    } finally { pending.delete(active) }
  }
}
