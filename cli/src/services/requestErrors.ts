/**
 * A request that moved out of the socket's switch into a service answers its failures as the switch did.
 *
 * The switch caught what a handler threw and answered INTERNAL, logging the failure under its type. The
 * service host answers a throw SERVICE_FAILED and counts it against the service, switching the service
 * off after five in a minute (core/serviceHost.ts). For a request that had no catch of its own, a full
 * disk under a profile link or an unreadable folder would then take the whole service with it (models:
 * grid and the pickers). So each handler moved from the switch keeps the switch's answer
 * (docs/design/2026-10-06-core-boundary-next.md, step 4).
 */
import type { ServiceRequest } from '../core/api.js'

export function internalOnThrow(type: string, handler: ServiceRequest): ServiceRequest {
  return async (payload, asker) => {
    try {
      return await handler(payload, asker)
    } catch (error) {
      console.error(`[backend] dispatch ${type} failed:`, error)
      return { error: 'INTERNAL' }
    }
  }
}
