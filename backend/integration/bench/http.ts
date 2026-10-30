import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify'
import type { AuthUser } from '../../src/lib/ssoAuth.js'
import { registerCpuKinds } from '../../src/lib/selfProfile.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import type { Reply } from './driver.js'

/** The bench's accounts sign in with their id as the bearer token, as in integration/superTabs.test.ts: external SSO is
 *  replaced, and every permission and transaction behind the routes is real. */
export async function benchApp(users: () => readonly AuthUser[], routes: FastifyPluginAsync): Promise<FastifyInstance> {
  const app = Fastify()
  app.setErrorHandler(errorHandler)
  registerCpuKinds(app)
  app.addHook('onRequest', async (request, reply) => {
    const user = users().find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!user) return reply.code(401).send({ success: false })
    request.user = user
  })
  await app.register(routes)
  await app.ready()
  return app
}

export type Call = <T>(user: AuthUser, method: 'GET' | 'POST', url: string, body?: unknown) => Promise<Reply<T>>

/** One HTTP call in process, read the way clients read it: `{ success, data }` or `{ success: false, error: { code } }`. */
export function caller(app: FastifyInstance): Call {
  return async <T>(user: AuthUser, method: 'GET' | 'POST', url: string, body?: unknown) => {
    const response = await app.inject({ method, url, headers: { authorization: `Bearer ${user.sub}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) })
    const parsed = parse(response.body)
    const ok = response.statusCode < 400 && parsed?.success === true
    return { status: response.statusCode, bytes: response.rawPayload.byteLength,
      code: ok ? null : parsed?.error?.code ?? `HTTP_${response.statusCode}`, data: ok ? (parsed!.data as T) : null }
  }
}

function parse(body: string): { success?: boolean; data?: unknown; error?: { code?: string } } | null {
  try { return JSON.parse(body) } catch { return null }
}
