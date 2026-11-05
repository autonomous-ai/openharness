/**
 * A verdict counts only at the pull request head it read (Dee, task #3394): a newer head stops it counting unless the pull
 * request's own patch is the same (a plain rebase, or a main merge that leaves the PR's diff unchanged).
 */
import { describe, expect, it } from 'vitest'
import { HEADS_KEPT, deriveCheck, keepHead, recordCheckVerdict, refreshChecks, verdictCounts, type PullRequestHeads } from './checkVerdicts.js'
import type { Check, CheckVerdict } from './model.js'

const PR = 'https://github.com/acme/app/pull/7'
const A = 'aaaaaaa1111111111111111111111111111111aa', B = 'bbbbbbb2222222222222222222222222222222bb'
const check = (): Check => ({ id: 'c', description: 'Signs in offline', independent: false, evidence: null, passedBy: null })
const verdict = (by: string, passed: boolean, head: string | undefined, patch?: string): CheckVerdict =>
  ({ by, passed, evidence: `${by} read it`, at: 1, ...head ? { pullRequest: PR, head } : {}, ...patch ? { patch } : {} })
const at = (head: string, patch: string | null): PullRequestHeads => ({ [PR]: { head, patch, at: 1 } })

describe('a verdict at a head', () => {
  it('counts at its head, in either case', () => {
    expect(verdictCounts(verdict('r', true, A), at(A, 'p1'))).toBe(true)
    expect(verdictCounts(verdict('r', true, A.toUpperCase()), at(A, 'p1'))).toBe(true)
  })

  // Security review of #3218 (Warden2), Important 2: a commit ground to share a short head's characters kept the verdict.
  it('never counts a shortened head at a head that merely starts with it', () => {
    const ground = `${A.slice(0, 7)}${'f'.repeat(33)}`
    expect(verdictCounts(verdict('r', true, A.slice(0, 7), 'p1'), at(ground, 'p2'))).toBe(false)
    expect(verdictCounts(verdict('r', true, A.slice(0, 7)), at(A, 'p1'))).toBe(false)
  })

  it('stops counting at a newer head with another patch, or a patch nobody could read', () => {
    expect(verdictCounts(verdict('r', true, A, 'p1'), at(B, 'p2'))).toBe(false)
    expect(verdictCounts(verdict('r', true, A, 'p1'), at(B, null))).toBe(false)
    expect(verdictCounts(verdict('r', true, A), at(B, 'p1'))).toBe(false)
  })

  it('keeps counting at a newer head with the same patch', () => {
    expect(verdictCounts(verdict('r', true, A, 'p1'), at(B, 'p1'))).toBe(true)
  })

  it('counts while the task has no watched head', () => {
    expect(verdictCounts(verdict('r', true, A, 'p1'), undefined)).toBe(true)
    expect(verdictCounts(verdict('r', true, undefined), undefined)).toBe(true)
    expect(verdictCounts(verdict('r', true, undefined), {})).toBe(true)
  })

  // Review of #3218 (Ledger), Important 2 and 6: once the task's pull requests are watched, a verdict whose own one has no head
  // (not read yet, or dropped from the kept heads) is unverified, never valid for every head.
  it('does not count on a pull request with no watched head while another of the task has one', () => {
    expect(verdictCounts(verdict('r', true, A, 'p1'), { 'https://github.com/acme/app/pull/8': { head: A, patch: 'p1', at: 1 } })).toBe(false)
  })

  it('naming a head before the task linked a pull request, counts only at that head once one is watched', () => {
    const early: CheckVerdict = { by: 'r', passed: true, evidence: '', at: 1, head: A }
    expect(verdictCounts(early, undefined)).toBe(true)
    expect(verdictCounts(early, at(A, 'p1'))).toBe(true)
    expect(verdictCounts(early, at(B, 'p2'))).toBe(false)
  })

  // Security review of #3218 (Warden2), Important 3: a verdict naming no head was given the head watched last, which a push
  // during the review made code nobody read; and one from before heads counted at every head.
  it('naming no head, stops counting once a head is watched', () => {
    expect(verdictCounts(verdict('r', true, undefined), at(B, 'p2'))).toBe(false)
    expect(verdictCounts({ by: 'r', passed: true, evidence: '', at: 1, pullRequest: PR }, at(B, 'p2'))).toBe(false)
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

  it('verdicts with no head behave as they did while no head is watched, and are stale at the first', () => {
    const c = check()
    recordCheckVerdict(c, verdict('agent:r', true, undefined))
    expect(c).toMatchObject({ passedBy: 'agent:r', evidence: 'agent:r read it' })
    expect(c.verdicts![0]).not.toHaveProperty('stale')
    expect(refreshChecks([c], PR, undefined, at(A, 'p1'))).toEqual([c])
    expect(c.verdicts![0]!.stale).toBe(A)
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

// Review of #3218 (Ledger), Important 6: a task keeps the heads of the pull requests it links, at most HEADS_KEPT of them.
describe('the heads a task keeps', () => {
  const head = (n: number) => ({ head: n.toString(16).padStart(40, '0'), patch: null, at: n })
  const url = (n: number) => `https://github.com/acme/app/pull/${n}`

  it('keeps only pull requests it still links', () => {
    expect(Object.keys(keepHead({ [url(1)]: head(1), [url(2)]: head(2) }, url(3), head(3), [url(2), url(3)])).sort()).toEqual([url(2), url(3)])
  })

  it('keeps at most HEADS_KEPT, the most recently read', () => {
    let heads: PullRequestHeads = {}
    const links = Array.from({ length: HEADS_KEPT + 5 }, (_, i) => url(i + 1))
    for (let n = 1; n <= HEADS_KEPT + 5; n++) heads = keepHead(heads, url(n), head(n), links)
    expect(Object.keys(heads)).toHaveLength(HEADS_KEPT)
    expect(heads[url(1)]).toBeUndefined()
    expect(heads[url(HEADS_KEPT + 5)]).toBeDefined()
  })
})
