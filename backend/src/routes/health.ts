import type { FastifyInstance } from 'fastify'
import type { ReadinessReport } from '../lib/readiness.js'

export async function healthRoutes(app: FastifyInstance, opts: { readiness: { probe(): Promise<ReadinessReport> } }): Promise<void> {
  // Public release coordinates only. Deployment verification must not rely on an image build
  // succeeding while the live API still runs an older image, or expose arbitrary environment text.
  const version = process.env.BUILD_TAG ?? '', sha = process.env.BUILD_SHA ?? ''
  const build = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(_backend)?$/.test(version)
    && /^[a-f0-9]{40}$/.test(sha) ? { version, sha } : null
  // Liveness: the process answers. No dependency calls, so an outage never makes the orchestrator restart pods.
  app.get('/api/health', async () => ({
    success: true,
    data: { status: 'ok', build },
  }))
  // Readiness: send this process traffic only while Mongo and Redis answer and it is not shutting down (lib/readiness.ts).
  app.get('/api/ready', async (_request, reply) => {
    const { ready, draining, checks } = await opts.readiness.probe()
    reply.header('Cache-Control', 'no-store')
    if (ready) return { success: true, data: { status: 'ready', checks } }
    return reply.code(503).send({ success: false, data: { status: draining ? 'draining' : 'not_ready', checks } })
  })
}
