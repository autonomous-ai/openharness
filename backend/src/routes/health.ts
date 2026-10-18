import type { FastifyInstance } from 'fastify'

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Public release coordinates only. Deployment verification must not rely on an image build
  // succeeding while the live API still runs an older image, or expose arbitrary environment text.
  const version = process.env.BUILD_TAG ?? '', sha = process.env.BUILD_SHA ?? ''
  const build = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(_backend)?$/.test(version)
    && /^[a-f0-9]{40}$/.test(sha) ? { version, sha } : null
  app.get('/api/health', async () => ({
    success: true,
    data: { status: 'ok', build },
  }))
}
