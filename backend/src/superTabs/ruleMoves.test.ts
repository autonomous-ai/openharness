import { describe, expect, it } from 'vitest'
import { pullRequestMerges, type PullGet } from './ruleMoves.js'

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
