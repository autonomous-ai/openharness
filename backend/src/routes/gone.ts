import type { FastifyInstance, FastifyReply } from 'fastify'
import { sendError } from '../utils/response.js'

/**
 * What Harness took out, answered plainly for the clients released before it that still ask: the Swarm went, its routes and its
 * data (anh Dee, 2026-11-14). A 410 before the body is read, with no read of the database or Redis beyond the sign-in every route
 * takes; an older client takes it as a failure and backs off, as it does for any refusal. Counted by route like every other
 * (lib/routeLatency.ts), so how many still ask shows. Goes once no supported client calls these, on or after 2026-12-14.
 */
export const GONE_ROUTES = ['/api/super-tabs', '/api/super-tabs/*'] as const

/** Sent, then the reply itself, which tells Fastify the request is answered: no body parse, no handler. */
const gone = async (_request: unknown, reply: FastifyReply): Promise<FastifyReply> => {
  sendError(reply, 'Swarms were removed from Harness.', 'SWARMS_REMOVED', 410)
  return reply
}

export async function goneRoutes(app: FastifyInstance): Promise<void> {
  for (const url of GONE_ROUTES) app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], url, onRequest: gone, handler: gone })
}
