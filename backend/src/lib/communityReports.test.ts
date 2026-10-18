import { afterEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  communityReport: { create: vi.fn(), count: vi.fn() },
  communityHidden: { findUnique: vi.fn(), upsert: vi.fn() },
}))
vi.mock('./prisma.js', () => ({ prisma: db }))
vi.mock('../config/env.js', () => ({ env: { COMMUNITY_REPORTS_WEBHOOK_URL: 'https://hooks.slack.example/T/B/X' } }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { fileReport } from './communityReports.js'

const report = { autonomousEnv: 'prod', targetType: 'comment' as const, targetId: 'c1', harnessId: 'h1', userId: 'carol', reason: 'harassment' }
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('fileReport', () => {
  it('tells the reviewers once reports hide a comment, naming it but never its words', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response('ok')); vi.stubGlobal('fetch', fetcher)
    db.communityHidden.findUnique.mockResolvedValue(null); db.communityReport.count.mockResolvedValue(3)
    await fileReport(report)
    expect(db.communityHidden.upsert).toHaveBeenCalledOnce()
    const body = JSON.parse(String(fetcher.mock.calls[0][1].body))
    expect(body.text).toContain('comment (c1)')
    expect(body.text).toContain('/hub/reports')
  })
  it('hides nothing and tells no one below three reports, or for a repeat of one already filed', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    db.communityHidden.findUnique.mockResolvedValue(null); db.communityReport.count.mockResolvedValue(2)
    await fileReport(report)
    db.communityReport.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))
    await fileReport(report)
    expect(db.communityHidden.upsert).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect(db.communityReport.count).toHaveBeenCalledOnce()
  })
})
