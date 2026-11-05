/**
 * A verdict counts only at the pull request head it read (Dee, task #3394): a newer head stops it counting unless the pull
 * request's own patch is the same (a plain rebase, or a main merge that leaves the PR's diff unchanged).
 */
import { describe, expect, it } from 'vitest'
import { deriveCheck, recordCheckVerdict, refreshChecks, verdictCounts, type PullRequestHeads } from './checkVerdicts.js'
import type { Check, CheckVerdict } from './model.js'

const PR = 'https://github.com/acme/app/pull/7'
const A = 'aaaaaaa1111111111111111111111111111111aa', B = 'bbbbbbb2222222222222222222222222222222bb'
const check = (): Check => ({ id: 'c', description: 'Signs in offline', independent: false, evidence: null, passedBy: null })
const verdict = (by: string, passed: boolean, head: string | undefined, patch?: string): CheckVerdict =>
  ({ by, passed, evidence: `${by} read it`, at: 1, ...head ? { pullRequest: PR, head } : {}, ...patch ? { patch } : {} })
const at = (head: string, patch: string | null): PullRequestHeads => ({ [PR]: { head, patch, at: 1 } })

describe('a verdict at a head', () => {
  it('counts at its head, or a longer spelling of it', () => {
    expect(verdictCounts(verdict('r', true, A), at(A, 'p1'))).toBe(true)
    expect(verdictCounts(verdict('r', true, A.slice(0, 7)), at(A, 'p1'))).toBe(true)
  })

  it('stops counting at a newer head with another patch, or a patch nobody could read', () => {
    expect(verdictCounts(verdict('r', true, A, 'p1'), at(B, 'p2'))).toBe(false)
    expect(verdictCounts(verdict('r', true, A, 'p1'), at(B, null))).toBe(false)
    expect(verdictCounts(verdict('r', true, A), at(B, 'p1'))).toBe(false)
  })

  it('keeps counting at a newer head with the same patch', () => {
    expect(verdictCounts(verdict('r', true, A, 'p1'), at(B, 'p1'))).toBe(true)
  })

  it('counts as before with no head, or no head watched for its pull request', () => {
    expect(verdictCounts(verdict('r', true, undefined), at(B, 'p2'))).toBe(true)
    expect(verdictCounts(verdict('r', true, A, 'p1'), undefined)).toBe(true)
    expect(verdictCounts(verdict('r', true, A, 'p1'), { 'https://github.com/acme/app/pull/8': { head: B, patch: 'p2', at: 1 } })).toBe(true)
  })
})

describe('a check of verdicts at heads', () => {
  it('passes on a pass at the head, and reads not passed once that head is replaced', () => {
    const c = check()
    recordCheckVerdict(c, verdict('agent:r', true, A, 'p1'), undefined, at(A, 'p1'))
    expect(c).toMatchObject({ passedBy: 'agent:r', evidence: 'agent:r read it' })
    deriveCheck(c, at(B, 'p2'))
    expect(c).toMatchObject({ passedBy: null, evidence: null })
    expect(c.verdicts![0]!.stale).toBe(B)
    // Back at the head it read (a force-push back), it counts again.
    deriveCheck(c, at(A, 'p1'))
    expect(c.passedBy).toBe('agent:r')
    expect(c.verdicts![0]!.stale).toBeUndefined()
  })

  it('a failure at an old head no longer fails the check; a pass at the new head passes it', () => {
    const c = check()
    recordCheckVerdict(c, verdict('agent:t', false, A, 'p1'), undefined, at(A, 'p1'))
    expect(c).toMatchObject({ passedBy: null, evidence: 'agent:t read it' })
    recordCheckVerdict(c, verdict('agent:r', true, B, 'p2'), undefined, at(B, 'p2'))
    expect(c).toMatchObject({ passedBy: 'agent:r', evidence: 'agent:r read it' })
    expect(c.verdicts!.map(v => v.stale)).toEqual([B, undefined])
  })

  it('a failure at the head still wins over a pass', () => {
    const c = check()
    recordCheckVerdict(c, verdict('agent:t', false, B, 'p2'), undefined, at(B, 'p2'))
    recordCheckVerdict(c, verdict('agent:r', true, B, 'p2'), undefined, at(B, 'p2'))
    expect(c).toMatchObject({ passedBy: null, evidence: 'agent:t read it' })
  })

  it('verdicts with no head behave as they did', () => {
    const c = check()
    recordCheckVerdict(c, verdict('agent:r', true, undefined))
    expect(c).toMatchObject({ passedBy: 'agent:r', evidence: 'agent:r read it' })
    expect(c.verdicts![0]).not.toHaveProperty('stale')
  })
})

describe('a new head', () => {
  it('learns the patch of verdicts given before it was read, then keeps those with the same patch', () => {
    const c = check()
    // Recorded before the watch had read A's patch.
    recordCheckVerdict(c, verdict('agent:r', true, A), undefined, at(A, null))
    const changed = refreshChecks([c], PR, { head: A, patch: 'p1', at: 1 }, at(B, 'p1'))
    expect(c.verdicts![0]!.patch).toBe('p1')
    expect(c.passedBy).toBe('agent:r')
    expect(changed).toEqual([])
  })

  it('names the checks that stopped passing', () => {
    const c = check(), other = { ...check(), id: 'd' }
    recordCheckVerdict(c, verdict('agent:r', true, A, 'p1'), undefined, at(A, 'p1'))
    const changed = refreshChecks([c, other], PR, { head: A, patch: 'p1', at: 1 }, at(B, 'p2'))
    expect(changed).toEqual([c])
    expect(c.passedBy).toBeNull()
  })
})
