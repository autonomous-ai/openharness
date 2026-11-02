import type { FastifyCorsOptions } from '@fastify/cors'

/**
 * The control API's CORS (server.ts). Allow all origins (reflect the request origin so credentialed requests work too).
 * Methods + headers are reflected (allowedHeaders omitted → echoes Access-Control-Request-Headers), so any client header
 * (Authorization, x-api-key, …) passes preflight. A browser keeps a preflight's answer for 10 minutes (the most Safari
 * keeps): the web signs every Swarm call with Authorization, which would otherwise cost a preflight per call.
 */
export const CORS_OPTIONS: FastifyCorsOptions = {
  origin: true,
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  maxAge: 600,
}
