/**
 * A request moved out of the socket's switch answers a throw as the switch did: INTERNAL, logged under its
 * type. The service host would answer SERVICE_FAILED and count it, switching the service off after five
 * in a minute (core/serviceHost.ts): a full disk under a profile link would take grid and the pickers
 * with it (docs/design/2026-10-06-core-boundary-next.md, step 4).
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
