import { describe, expect, it, vi } from 'vitest'
import { ciCounts, type Run } from './github.js'
import { createPullRequestsStatusReader, ghAccount, PULL_REQUESTS_FRESH_MS, PULL_REQUESTS_MAX } from './pullRequestsStatus.js'

const url = (n = 1) => `https://github.com/o/r/pull/${n}`
const view = (over = {}) => ({ title: 'Fix reconnect', state: 'OPEN', isDraft: false, mergedAt: null, closedAt: null,
  updatedAt: '2026-10-22T07:00:00Z', additions: 32, deletions: 6, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
  autoMergeRequest: null, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], ...over })
const runner = (over = {}) => vi.fn<Run>(async () => ({ stdout: JSON.stringify(view(over)) }))

describe('linked pull requests read directly from GitHub', () => {
  it('reads by URL and retains title, change counts, times and merge/review inputs', async () => {
    const run = runner(), read = createPullRequestsStatusReader(run, () => 0)
    expect(await read([url()])).toEqual({ checkedAt: '1970-01-01T00:00:00.000Z', account: expect.stringMatching(/^[0-9a-f]{16}$/), rows: [{
      url: url(), status: 'found', title: 'Fix reconnect', state: 'Open', mergedAt: '', closedAt: '',
      updatedAt: '2026-10-22T07:00:00Z', additions: 32, deletions: 6, ci: 'passing',
      checks: { passed: 1, failed: 0, pending: 0, total: 1 }, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', autoMerge: false,
    }] })
    expect(run).toHaveBeenCalledWith(['pr', 'view', url(), '--json',
      'title,state,isDraft,mergedAt,closedAt,updatedAt,additions,deletions,statusCheckRollup,reviewDecision,mergeStateStatus,autoMergeRequest'])
  })

  it.each([
    [{ isDraft: true }, 'Draft'], [{}, 'Open'], [{ state: 'MERGED' }, 'Merged'],
    [{ state: 'CLOSED', mergedAt: '2026-10-22T06:00:00Z' }, 'Merged'], [{ state: 'CLOSED', closedAt: '2026-10-21T06:00:00Z' }, 'Closed'],
  ])('reports the GitHub state from %o', async (over, state) => {
    expect((await createPullRequestsStatusReader(runner(over))([url()])).rows[0]).toMatchObject({ state })
  })

  it.each(['DIRTY', 'BEHIND', 'BLOCKED', 'DRAFT', 'HAS_HOOKS', 'UNSTABLE', 'CLEAN'])('preserves merge state %s', async mergeStateStatus => {
    const read = createPullRequestsStatusReader(runner({ mergeStateStatus }))
    expect((await read([url()])).rows[0].mergeStateStatus).toBe(mergeStateStatus)
  })
  it.each(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'])('preserves review decision %s', async reviewDecision => {
    expect((await createPullRequestsStatusReader(runner({ reviewDecision }))([url()])).rows[0].reviewDecision).toBe(reviewDecision)
  })
  it('preserves auto-merge and sanitizes unexpected values and display text', async () => {
    const read = createPullRequestsStatusReader(runner({ title: '\u202E' + 'x'.repeat(600), additions: -1, deletions: '2',
      reviewDecision: 'new', mergeStateStatus: 'new', updatedAt: null, autoMergeRequest: {} }))
    expect((await read([url()])).rows[0]).toMatchObject({ title: 'x'.repeat(512), additions: 0, deletions: 0,
      reviewDecision: '', mergeStateStatus: 'UNKNOWN', updatedAt: '', autoMerge: true })
  })

  it('counts both check runs and commit statuses; skips neutral/skipped and keeps unknown checks pending', () => {
    expect(ciCounts([null, 1, { conclusion: 'SUCCESS' }, { state: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' },
      { conclusion: 'FAILURE' }, { state: 'ERROR' }, { conclusion: 'TIMED_OUT' }, { conclusion: 'CANCELLED' },
      { conclusion: 'STARTUP_FAILURE' }, { conclusion: 'ACTION_REQUIRED' }, { status: 'IN_PROGRESS' }, { status: 'QUEUED' },
      { status: 'COMPLETED', conclusion: 'FUTURE_VALUE' }])).toEqual({ passed: 2, failed: 6, pending: 3, total: 11 })
    expect(ciCounts(undefined)).toEqual({ passed: 0, failed: 0, pending: 0, total: 0 })
  })
  it.each([
    [[], 'none', 0], [[{ conclusion: 'FAILURE' }], 'failing', 1], [[{ status: 'IN_PROGRESS' }], 'pending', 1],
  ])('retains the shared CI summary for %o', async (statusCheckRollup, ci, total) => {
    expect((await createPullRequestsStatusReader(runner({ statusCheckRollup }))([url()])).rows[0]).toMatchObject({ ci, checks: { total } })
  })

  it.each([undefined, null, {}, 'url', [url(), 3], ['http://github.com/o/r/pull/1'], ['https://evil.com/o/r/pull/1'],
    ['https://github.com@evil.com/o/r/pull/1'], ['https://github.com/o/r/pull/1?q=1'], ['https://github.com/o/r/pull/0'],
    ['https://github.com/o/r/pull/9007199254740992'], ['https://github.com/o/r/pull/1/../2'], Array(PULL_REQUESTS_MAX + 1).fill(url())])(
    'refuses malformed or excessive URLs before invoking gh: %o', async urls => {
      const run = runner()
      expect(await createPullRequestsStatusReader(run)(urls)).toMatchObject({ error: 'INVALID_URLS', rows: [] })
      expect(run).not.toHaveBeenCalled()
    })
  it('answers an empty list and deduplicates a valid one', async () => {
    const run = runner(), read = createPullRequestsStatusReader(run)
    expect((await read([])).rows).toEqual([])
    expect((await read([url(), url()])).rows).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('one inaccessible repository does not hide readable PRs or become a machine failure', async () => {
    const run = vi.fn<Run>(async args => {
      if (args[2] === url(2)) throw { stderr: "GraphQL: Could not resolve to a Repository with the name 'o/private'." }
      return { stdout: JSON.stringify(view()) }
    })
    expect(await createPullRequestsStatusReader(run)([url(), url(2)])).toMatchObject({ rows: [
      { status: 'found', title: 'Fix reconnect' }, { url: url(2), status: 'no_access' },
    ] })
    expect((await createPullRequestsStatusReader(run)([url(2)])).error).toBeUndefined()
  })
  it.each(['HTTP 403: Resource protected by organization SAML enforcement', 'HTTP 403: Resource not accessible by integration'])('keeps a repository access refusal apart: %s', async stderr => {
    const read = createPullRequestsStatusReader(async () => { throw { stderr } })
    expect(await read([url()])).toMatchObject({ rows: [{ status: 'no_access' }] })
    expect((await read([url()])).error).toBeUndefined()
  })
  it('still treats a 403 with rate-limit wording as a whole-machine rate limit', async () => {
    const read = createPullRequestsStatusReader(async () => { throw { stderr: 'HTTP 403: secondary rate limit' } })
    expect(await read([url()])).toMatchObject({ error: 'RATE_LIMITED' })
  })

  it.each([
    [{ code: 'ENOENT' }, 'GH_MISSING'], [{ stderr: 'To get started run gh auth login' }, 'GH_SIGNED_OUT'],
    [{ stderr: 'API rate limit exceeded' }, 'RATE_LIMITED'], [{ killed: true }, 'TIMEOUT'], [{ stderr: 'bad gateway' }, 'GH_FAILED'],
  ])('returns a machine problem once with unavailable rows: %o', async (error, code) => {
    const run: Run = async () => { throw error }
    expect(await createPullRequestsStatusReader(run)([url(), url(2)])).toMatchObject({ error: code, rows: [
      { url: url(), status: 'unavailable', error: code }, { url: url(2), status: 'unavailable', error: code },
    ] })
  })
  it.each(['null', '[]', '{', '{"state":"FUTURE","title":"x"}', '{"state":"OPEN"}'])('treats malformed JSON as a failed read: %s', async stdout => {
    expect(await createPullRequestsStatusReader(async () => ({ stdout }))([url()])).toMatchObject({ error: 'GH_FAILED', rows: [{ status: 'unavailable' }] })
  })

  it('one flight per URL across callers, preserving their order', async () => {
    let release!: (value: { stdout: string }) => void
    const run = vi.fn<Run>(() => new Promise(resolve => { release = resolve }))
    const read = createPullRequestsStatusReader(run)
    const a = read([url()]), b = read([url()])
    // Each read first asks which account gh reads as, so the flight starts a moment later; it is still one.
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    release({ stdout: JSON.stringify(view()) })
    expect(await a).toEqual(await b)
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('caches final states permanently, open/no-access briefly, and failures for five seconds', async () => {
    let now = 0
    const run = vi.fn<Run>(async args => {
      const n = Number(args[2].split('/').at(-1))
      if (n === 4) throw { stderr: 'HTTP 404: Not Found' }
      if (n === 5) throw { killed: true }
      return { stdout: JSON.stringify(view({ state: n === 1 ? 'MERGED' : n === 2 ? 'CLOSED' : 'OPEN' })) }
    })
    const read = createPullRequestsStatusReader(run, () => now), urls = [1, 2, 3, 4, 5].map(url)
    await read(urls); await read(urls)
    expect(run).toHaveBeenCalledTimes(5)
    now = 5_000; await read(urls)
    expect(run).toHaveBeenCalledTimes(6)
    now = PULL_REQUESTS_FRESH_MS; await read(urls)
    expect(run).toHaveBeenCalledTimes(9)
    now += 365 * 86400_000; await read(urls)
    expect(run).toHaveBeenCalledTimes(12)
  })
  it('forgets every answer, final ones too, when the GitHub account changes or signs out', async () => {
    let account: string | null = 'ada', answer: 'merged' | 'hidden' | 'signed-out' = 'merged'
    const run = vi.fn<Run>(async () => {
      if (answer === 'hidden') throw { stderr: 'HTTP 404: Not Found' }
      if (answer === 'signed-out') throw { stderr: 'To get started run gh auth login' }
      return { stdout: JSON.stringify(view({ state: 'MERGED', title: 'Private fix' })) }
    })
    const read = createPullRequestsStatusReader(run, () => 0, async () => account)
    expect((await read([url()])).rows[0]).toMatchObject({ status: 'found', title: 'Private fix', state: 'Merged' })
    expect((await read([url()])).rows[0]).toMatchObject({ title: 'Private fix' })
    expect(run).toHaveBeenCalledTimes(1)
    account = 'grace'; answer = 'hidden'
    expect((await read([url()])).rows[0]).toEqual({ url: url(), status: 'no_access' })
    account = null; answer = 'signed-out'
    expect(await read([url()])).toMatchObject({ error: 'GH_SIGNED_OUT', rows: [{ status: 'unavailable' }] })
  })
  it('names the account every answer was read as, so a switch shows even when the reads then fail', async () => {
    let account: string | null = 'ada', fail = false
    const run = vi.fn<Run>(async () => {
      if (fail) throw { killed: true }
      return { stdout: JSON.stringify(view({ title: 'Private fix' })) }
    })
    const read = createPullRequestsStatusReader(run, () => 0, async () => account)
    const ada = await read([url()])
    expect(ada.account).toMatch(/^[0-9a-f]{16}$/)
    expect((await read([url()])).account).toBe(ada.account)
    account = 'grace'; fail = true
    const grace = await read([url()])
    expect(grace).toMatchObject({ error: 'TIMEOUT', rows: [{ status: 'unavailable' }] })
    expect(grace.account).toMatch(/^[0-9a-f]{16}$/)
    expect(grace.account).not.toBe(ada.account)
    account = null
    const none = await read([url()])
    expect([none.account, none.account === grace.account]).toEqual([expect.stringMatching(/^[0-9a-f]{16}$/), false])
    expect(none.account).not.toContain('ada')
  })
  it('reads the account as a hash of the token gh holds, and none without one', async () => {
    const tokens = vi.fn<Run>(async () => ({ stdout: 'gho_secret\n' }))
    const id = await ghAccount(tokens)()
    expect(tokens).toHaveBeenCalledWith(['auth', 'token'])
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(id).not.toContain('gho_secret')
    expect(await ghAccount(async () => { throw { stderr: 'no oauth token found' } })()).toBeNull()
    expect(await ghAccount(async () => ({ stdout: '  ' }))()).toBeNull()
  })
  it('caps simultaneous subprocesses across overlapping lists', async () => {
    let active = 0, peak = 0
    const run: Run = async () => {
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 1)); active--
      return { stdout: JSON.stringify(view()) }
    }
    const read = createPullRequestsStatusReader(run)
    const a = Array.from({ length: PULL_REQUESTS_MAX }, (_, i) => url(i + 1))
    const b = Array.from({ length: PULL_REQUESTS_MAX }, (_, i) => url(i + 51))
    const result = await Promise.all([read(a), read(b)])
    expect(peak).toBe(4)
    expect(result.map(r => r.rows.map(row => row.url))).toEqual([a, b])
  })
})
