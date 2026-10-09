import type { FastifyInstance, FastifyReply } from 'fastify'
import { callback, disconnect, GatewayError, list, poll, refresh, start } from '../lib/connectorGateway.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { logger } from '../utils/logger.js'

/**
 * The connector gateway (lib/connectorGateway.ts): sign-in to GitHub, Slack, Google and the other
 * services that let no computer register its own OAuth client, for `harness connections` and the
 * desktop app's Settings ▸ Connectors.
 *
 *   GET  /api/connectors             (signed in)  the services that sign in here, with this account's state
 *   POST /api/connectors/start       (signed in)  {connector} → {authorize_url, pickup_code, …}
 *   POST /api/connectors/poll        (signed in)  {pickup_code} → {status, …token once ready}
 *   POST /api/connectors/refresh     (signed in)  {connector} → a new token, renewed with the one kept here
 *   POST /api/connectors/disconnect  (signed in)  {connector} → forget the account's sign-in here
 *   POST /api/connectors/callback    (no auth)    {code, state} from the Autonomous web callback page
 */
export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof GatewayError) return sendError(reply, error.message, error.code, error.status)
    logger.error('connector gateway failed', { error: String(error) })
    return sendError(reply, 'Connections are unavailable. Try again.', 'CONNECTORS_FAILED', 503)
  }
  type Body = Record<string, unknown> | undefined

  app.get('/api/connectors', async (req, reply) => {
    try { sendSuccess(reply, { connectors: await list(req.user!.sub) }) } catch (error) { fail(reply, error) }
  })

  app.post<{ Body: Body }>('/api/connectors/start', async (req, reply) => {
    try { sendSuccess(reply, await start(req.user!.sub, req.body?.connector)) } catch (error) { fail(reply, error) }
  })

  app.post<{ Body: Body }>('/api/connectors/poll', async (req, reply) => {
    try { sendSuccess(reply, await poll(req.user!.sub, req.body?.pickup_code)) } catch (error) { fail(reply, error) }
  })

  app.post<{ Body: Body }>('/api/connectors/refresh', async (req, reply) => {
    try { sendSuccess(reply, await refresh(req.user!.sub, req.body?.connector)) } catch (error) { fail(reply, error) }
  })

  app.post<{ Body: Body }>('/api/connectors/disconnect', async (req, reply) => {
    try { sendSuccess(reply, await disconnect(req.user!.sub, req.body?.connector)) } catch (error) { fail(reply, error) }
  })

  // Unauthenticated by design: the browser that brings the code is anonymous to Harness. The state
  // (minted by start, one use, ten minutes) is the ticket, and the answer never carries a token.
  app.post<{ Body: Body }>('/api/connectors/callback', async (req, reply) => {
    try { sendSuccess(reply, await callback(req.body ?? {})) } catch (error) { fail(reply, error) }
  })
}
