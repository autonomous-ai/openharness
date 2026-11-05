import { describe, expect, it, vi } from 'vitest'
import { appPullRequestMerges, pullRequestMerges, type PullGet } from './ruleMoves.js'
import { logger } from '../utils/logger.js'

// Task #3463: when a moved rule's task merged is GitHub's own date, read by the server (ruleMoves.ts).
describe('the merge times read on GitHub for a moved rule', () => {
  const answers: Record<string, { status: number; body: unknown }> = {
    'acme/app#7': { status: 200, body: { state: 'closed', merged_at: '2026-11-06T03:00:00Z' } },
    'acme/app#8': { status: 200, body: { state: 'closed', merged_at: null } },
    'acme/app#9': { status: 200, body: { state: 'open', merged_at: null } },
    'acme/app#10': { status: 502, body: null },
  }
  const asked: string[] = []
  const get: PullGet = async (repository, number) => {
    asked.push(`${repository.fullName}#${number}`)
    return answers[`${repository.fullName}#${number}`] ?? { status: 404, body: { message: 'Not Found' } }
  }

  it('takes GitHub\'s merge date, says not merged for a closed or open one, and leaves out what GitHub could not answer', async () => {
    const pr = (n: number) => `https://github.com/acme/app/pull/${n}`
    expect(await pullRequestMerges([pr(7), pr(8), pr(9), pr(10), pr(11), 'https://github.com/acme/app/issues/3'], get)).toEqual({
      [pr(7)]: Date.parse('2026-11-06T03:00:00Z'), [pr(8)]: null, [pr(9)]: null,
    })
    // A link that is no pull request is never asked about.
    expect(asked).not.toContain('acme/app#3')
  })
})

describe('the GitHub App reader of merge times', () => {
  it('uses one read-only token per repository, revokes it even when a read fails, and logs every read it could not make', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const app = {
      installation: vi.fn(async (repository: { fullName: string }) => repository.fullName === 'acme/app' ? 11 : null),
      createToken: vi.fn(async () => ({ token: 'secret-token' })),
      get: vi.fn(async (path: string) => {
        if (path.endsWith('/pulls/7')) return { status: 200, body: { merged_at: '2026-11-06T03:00:00Z' } }
        if (path.endsWith('/pulls/9')) return { status: 502, body: null }
        throw new Error('socket hang up')
      }),
      revoke: vi.fn(async () => {}),
    }
    const read = await appPullRequestMerges(app as never)(['https://github.com/acme/app/pull/7', 'https://github.com/acme/app/pull/8',
      'https://github.com/acme/app/pull/9', 'https://github.com/other/app/pull/1'])
    expect(read).toEqual({ 'https://github.com/acme/app/pull/7': Date.parse('2026-11-06T03:00:00Z') })
    expect(app.createToken).toHaveBeenCalledTimes(1)
    // Read-only: pull requests and metadata, nothing else.
    expect(app.createToken).toHaveBeenCalledWith(11, expect.objectContaining({ fullName: 'acme/app' }), { pull_requests: 'read', metadata: 'read' })
    expect(app.revoke).toHaveBeenCalledTimes(1)
    expect(app.revoke).toHaveBeenCalledWith('secret-token')
    // Each read it could not make says so, by repository, number and status, never with the token.
    const lines = warn.mock.calls.map(call => JSON.stringify(call))
    expect(lines.filter(line => line.includes('merge time not read'))).toHaveLength(3)
    expect(lines.some(line => line.includes('acme/app') && line.includes('"number":9') && line.includes('"status":502'))).toBe(true)
    expect(lines.some(line => line.includes('other/app') && line.includes('"number":1'))).toBe(true)
    expect(lines.some(line => line.includes('secret-token'))).toBe(false)
    warn.mockRestore()
  })
})

describe('a token the reader could not revoke', () => {
  it('says so, by repository, without the token', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const app = {
      installation: vi.fn(async () => 11),
      createToken: vi.fn(async () => ({ token: 'secret-token' })),
      get: vi.fn(async () => ({ status: 200, body: { merged_at: null } })),
      revoke: vi.fn(async () => { throw new Error('GitHub 500') }),
    }
    expect(await appPullRequestMerges(app as never)(['https://github.com/acme/app/pull/7'])).toEqual({ 'https://github.com/acme/app/pull/7': null })
    const lines = warn.mock.calls.map(call => JSON.stringify(call))
    expect(lines.some(line => line.includes('not revoked') && line.includes('acme/app'))).toBe(true)
    expect(lines.some(line => line.includes('secret-token'))).toBe(false)
    warn.mockRestore()
  })
})
