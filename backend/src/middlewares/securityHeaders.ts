import type { FastifyInstance } from 'fastify'
import { env } from '../config/env.js'

/**
 * The headers every answer carries. Header-only onSend hooks stay synchronous (`done`): with two async ones, an async
 * handler that sends without returning its reply is still being sent when it returns, and Fastify sends it again
 * ("Cannot write headers after they are sent to the client", the community feed, 2026-10-28).
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    if (env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    done(null, payload)
  })
}
