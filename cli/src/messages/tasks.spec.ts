import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The default runner is tried through a fake `execFile`: no test here ever starts the real `gh`.
const child = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: child.execFile }))

import { markerLabel, markerName } from './sharedDirectory.js'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskReader, findGh, resetGhPath, TASKS_FAILED_MS, TASKS_FRESH_MS, type Run } from './tasks.js'

/** A folder holding an executable named gh, which nothing runs: the tests read where it is, never start it. */
function ghFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gh-'))
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(dir, 'gh'), 0o755)
  return dir
}

const ID = 'a'.repeat(24)
const OTHER = 'b'.repeat(24)
const mark = (id = ID, assignee = '') => `<!-- harness-tab:${id}${assignee ? ` assignee:${assignee}` : ''} -->`
const issue = (n: number, over: Record<string, unknown> = {}) => ({ number: n, title: `Issue ${n}`, state: 'open', url: `https://github.com/o/r/issues/${n}`,
  repository: { nameWithOwner: 'o/r' }, body: `${mark()}\nwork`, updatedAt: `2026-10-0${n}T00:00:00Z`, ...over })
const pr = (n: number, closes: number, over: Record<string, unknown> = {}) => ({ number: n, state: 'open', url: `https://github.com/o/r/pull/${n}`,
  repository: { nameWithOwner: 'o/r' }, body: `${mark()}\nCloses #${closes}`, isDraft: false, ...over })

/** A fake gh: the searches answer from `issues` and `prs`, a `pr view` from `views` by URL. Records every call. */
function gh(issues: unknown, prs: unknown = [], views: Record<string, unknown> = {}) {
  const calls: string[][] = []
  const run: Run = async (args) => {
    calls.push(args)
    if (args[1] === 'issues') return { stdout: JSON.stringify(issues) }
    if (args[1] === 'prs') return { stdout: JSON.stringify(prs) }
    const view = views[args[2]]
    if (view instanceof Error) throw view
    if (view === null) return { stdout: 'null' }
    return { stdout: JSON.stringify(view ?? { statusCheckRollup: [], state: 'OPEN', isDraft: false, mergedAt: null }) }
  }
  return { run, calls }
}
const failing = (error: unknown): Run => async () => { throw error }
const reason = async (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: string; message: string }) => `${e.code}: ${e.message}`)

describe('Tasks search', () => {
  beforeEach(() => { child.execFile.mockReset(); vi.stubEnv('VITEST', ''); resetGhPath() })
  afterEach(() => { vi.unstubAllEnvs() })

  it('runs gh for the tab\'s issues and pull requests with the brief\'s arguments, the tab id one argument, then each linked PR\'s CI', async () => {
    const { run, calls } = gh([issue(1)], [pr(5, 1)])
    await createTaskReader(run)(ID)
    expect(calls).toContainEqual(['search', 'issues', `harness-tab:${ID}`, '--match', 'body', '--limit', '100', '--json', 'number,title,state,url,repository,body,updatedAt'])
    expect(calls).toContainEqual(['search', 'prs', `harness-tab:${ID}`, '--match', 'body', '--limit', '100', '--json', 'number,state,url,repository,body,isDraft'])
    expect(calls).toContainEqual(['pr', 'view', 'https://github.com/o/r/pull/5', '--json', 'statusCheckRollup,state,isDraft,mergedAt,autoMergeRequest,mergeStateStatus'])
  })

  // gh checks `--json` fields before it asks GitHub anything, and refuses the whole command for one it does not know
  // (`Unknown JSON field: "isInMergeQueue"`, exit 1: every pull request read failed that way before the final review).
  // The lists are gh 2.95.0's own, printed by `gh <command> --json` with no fields, offline.
  const GH_JSON_FIELDS: Record<string, string[]> = {
    'search issues': ['assignees', 'author', 'authorAssociation', 'body', 'closedAt', 'commentsCount', 'createdAt', 'id', 'isLocked', 'isPullRequest', 'labels',
      'number', 'repository', 'state', 'title', 'updatedAt', 'url'],
    'search prs': ['assignees', 'author', 'authorAssociation', 'body', 'closedAt', 'commentsCount', 'createdAt', 'id', 'isDraft', 'isLocked', 'isPullRequest',
      'labels', 'number', 'repository', 'state', 'title', 'updatedAt', 'url'],
    'pr view': ['additions', 'assignees', 'author', 'autoMergeRequest', 'baseRefName', 'baseRefOid', 'body', 'changedFiles', 'closed', 'closedAt',
      'closingIssuesReferences', 'comments', 'commits', 'createdAt', 'deletions', 'files', 'fullDatabaseId', 'headRefName', 'headRefOid', 'headRepository',
      'headRepositoryOwner', 'id', 'isCrossRepository', 'isDraft', 'labels', 'latestReviews', 'maintainerCanModify', 'mergeCommit', 'mergeStateStatus',
      'mergeable', 'mergedAt', 'mergedBy', 'milestone', 'number', 'potentialMergeCommit', 'projectCards', 'projectItems', 'reactionGroups', 'reviewDecision',
      'reviewRequests', 'reviews', 'state', 'statusCheckRollup', 'title', 'updatedAt', 'url'],
  }

  it('asks gh only for JSON fields gh has, and the pull request view for exactly the six it reads', async () => {
    const { run, calls } = gh([issue(1)], [pr(5, 1)])
    await createTaskReader(run)(ID)
    expect(calls.map((args) => args.slice(0, 2).join(' ')).sort()).toEqual(['pr view', 'search issues', 'search prs'])
    for (const args of calls) {
      const fields = args[args.indexOf('--json') + 1].split(',')
      expect(fields.filter((f) => !GH_JSON_FIELDS[args.slice(0, 2).join(' ')].includes(f)), args.join(' ')).toEqual([])
    }
    const view = calls.find((args) => args[0] === 'pr')!
    expect(view[view.indexOf('--json') + 1].split(',').sort()).toEqual(['autoMergeRequest', 'isDraft', 'mergeStateStatus', 'mergedAt', 'state', 'statusCheckRollup'])
  })

  it('reads the marker with and without an assignee, and keeps the issue\'s fields', async () => {
    const { run } = gh([issue(1, { body: mark(ID, 'bob-1/api.v2') }), issue(2)])
    const { rows, truncated, checkedAt } = await createTaskReader(run, () => Date.UTC(2026, 9, 15))(ID)
    expect(rows).toEqual([
      { repo: 'o/r', issue: 2, title: 'Issue 2', url: 'https://github.com/o/r/issues/2', state: 'open', assignee: null, pr: null, updatedAt: '2026-10-02T00:00:00Z' },
      { repo: 'o/r', issue: 1, title: 'Issue 1', url: 'https://github.com/o/r/issues/1', state: 'open', assignee: { account: 'bob-1', harness: 'api.v2' }, pr: null, updatedAt: '2026-10-01T00:00:00Z' },
    ])
    expect(truncated).toBe(false)
    expect(checkedAt).toBe('2026-10-15T00:00:00.000Z')
  })

  it('parses back the assignee a note tells an agent to write, whatever the address: the label round-trips through the marker', async () => {
    for (const email of ['a+b@x.com', 'first.last+x@y.io', 'Ünï cødé@y.io', '+++@y.io', `${'x'.repeat(80)}@y.io`]) {
      const label = markerLabel(email)
      const { run } = gh([issue(1, { body: mark(ID, `${label}/api`) })])
      expect((await createTaskReader(run)(ID)).rows[0].assignee).toEqual({ account: label, harness: 'api' })
    }
  })

  it('parses back the harness a note names, whatever its display name: the marker name round-trips through the marker', async () => {
    for (const name of ['Fix login test', 'app (1a2b)', 'api.v2', 'Ünï cødé', '(((', '', 'x'.repeat(80), 'b\u202Eo\u0007b']) {
      const harness = markerName(name)
      const { run } = gh([issue(1, { body: mark(ID, `${markerLabel('a+b@x.com')}/${harness}`) })])
      expect((await createTaskReader(run)(ID)).rows[0].assignee, name).toEqual({ account: 'a-b', harness })
    }
  })

  it('ignores a marker for another tab, a malformed one, a missing body, and takes only the first marker', async () => {
    const { run } = gh([
      issue(1, { body: mark(OTHER) }), issue(2, { body: '<!-- harness-tab:' + ID + ' assignee:bob -->' }), issue(3, { body: null }),
      issue(4, { body: `see ${mark(ID, 'x/y')} ${mark(ID, 'z/w')}` }), issue(5, { body: `<!-- harness-tab:${ID}x -->` }), 'junk', null,
    ])
    const { rows } = await createTaskReader(run)(ID)
    expect(rows.map((r) => [r.issue, r.assignee])).toEqual([[4, { account: 'x', harness: 'y' }]])
  })

  it('drops an issue with no usable repository, number or URL, and any URL not on github.com', async () => {
    const { run } = gh([
      issue(1, { repository: null }), issue(2, { repository: { nameWithOwner: 'no slash' } }), issue(3, { number: 'x' }),
      issue(4, { url: 'http://github.com/o/r/issues/4' }), issue(5, { url: 'https://evil.example/o/r/issues/5' }),
      issue(6, { url: 'https://github.com/o/r/issues/6?x=1' }), issue(7, { url: 7 }), issue(8, { url: 'https://github.com/o/r/issues/8/../9' }), issue(9),
    ])
    expect((await createTaskReader(run)(ID)).rows.map((r) => r.issue)).toEqual([9])
  })

  it('links a PR by "Closes #N" in the same repository only, with the same marker, and drops a PR with a bad URL or no marker', async () => {
    const { run, calls } = gh([issue(1), issue(2), issue(3, { repository: { nameWithOwner: 'o/other' }, url: 'https://github.com/o/other/issues/3' })], [
      pr(10, 1), pr(11, 2, { body: `${mark(OTHER)} Closes #2` }), pr(12, 2, { body: 'Closes #2' }), pr(13, 3), pr(14, 2, { url: 'https://evil.example/pull/14' }),
      pr(15, 2, { repository: null }), pr(16, 2, { number: 'x' }), pr(17, 2, { body: `${mark()} Closes #20 and closes #2` }), 'junk',
    ])
    const { rows } = await createTaskReader(run)(ID)
    const by = (n: number) => rows.find((r) => r.issue === n)!.pr
    expect(by(1)).toMatchObject({ number: 10 })
    expect(by(2)).toBeNull()
    expect(by(3)).toBeNull()
    expect(calls.filter((c) => c[0] === 'pr')).toHaveLength(1)
  })

  it('a row without a PR is shown with pr null', async () => {
    expect((await createTaskReader(gh([issue(1)]).run)(ID)).rows[0].pr).toBeNull()
  })

  it('picks the newest open PR first, then merged, then closed, and takes a PR that closes several issues for each', async () => {
    const { run } = gh([issue(1), issue(2), issue(3), issue(4)], [
      pr(20, 1, { state: 'closed' }), pr(21, 1, { state: 'merged' }), pr(22, 1), pr(23, 1, { isDraft: true }),
      pr(30, 2, { state: 'closed' }), pr(31, 2, { state: 'MERGED' }), pr(32, 2, { state: 'closed' }),
      pr(40, 3, { state: 'closed' }), pr(41, 3, { state: 'closed' }),
      pr(50, 4, { body: `${mark()} Closes #4 Closes #3` }),
    ], { 'https://github.com/o/r/pull/23': { state: 'OPEN', isDraft: true }, 'https://github.com/o/r/pull/31': { state: 'MERGED' } })
    const { rows } = await createTaskReader(run)(ID)
    const by = (n: number) => rows.find((r) => r.issue === n)!.pr
    expect(by(1)).toMatchObject({ number: 23, state: 'Draft' })
    expect(by(2)).toMatchObject({ number: 31, state: 'Merged' })
    expect(by(3)).toMatchObject({ number: 50, state: 'Open' })
    expect(by(4)).toMatchObject({ number: 50 })
  })

  it('orders open issues before closed, the latest update first, and maps closed and unknown issue states', async () => {
    const { run } = gh([issue(1, { state: 'closed', updatedAt: '2026-12-01' }), issue(2, { updatedAt: '2026-10-01' }), issue(3, { updatedAt: '2026-11-01' }),
      issue(4, { state: 'CLOSED', updatedAt: '2026-12-01' }), issue(5, { updatedAt: 5 })])
    const { rows } = await createTaskReader(run)(ID)
    expect(rows.map((r) => [r.issue, r.state])).toEqual([[3, 'open'], [2, 'open'], [5, 'open'], [1, 'closed'], [4, 'closed']])
    expect(rows.find((r) => r.issue === 5)!.updatedAt).toBe('')
  })

  it.each([
    ['no checks', [], 'none'],
    ['a missing rollup', undefined, 'none'],
    ['all passing, skipped and neutral counted', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }, { state: 'SUCCESS' }, 'junk', null], 'passing'],
    ['one failing among passing', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }], 'failing'],
    ['a failed commit status', [{ state: 'ERROR' }], 'failing'],
    ['one still running', [{ status: 'IN_PROGRESS', conclusion: '' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }], 'pending'],
    ['a pending commit status', [{ state: 'PENDING' }], 'pending'],
    ['failing beats pending', [{ status: 'QUEUED' }, { conclusion: 'TIMED_OUT' }], 'failing'],
    ['a check with nothing known', [{}], 'pending'],
  ])('CI: %s is %s', async (_name, rollup, ci) => {
    const { run } = gh([issue(1)], [pr(5, 1)], { 'https://github.com/o/r/pull/5': { statusCheckRollup: rollup, state: 'OPEN', isDraft: false } })
    expect((await createTaskReader(run)(ID)).rows[0].pr).toEqual({ number: 5, url: 'https://github.com/o/r/pull/5', state: 'Open', ci, autoMerge: false, mergeState: 'UNKNOWN', mergedAt: '' })
  })

  it('takes the PR\'s state as GitHub says now: merged, closed, draft or open', async () => {
    const urls = [5, 6, 7, 8, 9].map((n) => `https://github.com/o/r/pull/${n}`)
    const { run } = gh([1, 2, 3, 4, 5].map((n) => issue(n)), [5, 6, 7, 8, 9].map((n, i) => pr(n, i + 1)), {
      [urls[0]]: { state: 'MERGED', mergedAt: null }, [urls[1]]: { state: 'OPEN', mergedAt: '2026-10-01T00:00:00Z' }, [urls[2]]: { state: 'CLOSED' },
      [urls[3]]: { state: 'OPEN', isDraft: true }, [urls[4]]: { state: 'OPEN' } })
    const { rows } = await createTaskReader(run)(ID)
    expect(rows.map((r) => [r.issue, r.pr!.state]).sort()).toEqual([[1, 'Merged'], [2, 'Merged'], [3, 'Closed'], [4, 'Draft'], [5, 'Open']])
  })

  it.each([
    ['a merged PR\'s time', { state: 'MERGED', mergedAt: '2026-10-01T00:00:00Z' }, '2026-10-01T00:00:00Z'],
    ['none for an open PR', { state: 'OPEN', mergedAt: null }, ''],
    ['not text', { state: 'MERGED', mergedAt: 7 }, ''],
    ['cut and cleaned', { state: 'MERGED', mergedAt: `2026-10-01T00:00:00Z\u0007${'9'.repeat(60)}` }, `2026-10-01T00:00:00Z${'9'.repeat(20)}`],
  ])('mergedAt: %s', async (_name, view, mergedAt) => {
    const { run } = gh([issue(1)], [pr(5, 1)], { 'https://github.com/o/r/pull/5': { statusCheckRollup: [], ...view } })
    expect((await createTaskReader(run)(ID)).rows[0].pr!.mergedAt).toBe(mergedAt)
  })

  it('a PR whose view fails keeps the search\'s state and no CI, and the others are still read', async () => {
    const { run } = gh([issue(1), issue(2)], [pr(5, 1), pr(6, 2, { state: 'closed' })], {
      'https://github.com/o/r/pull/5': new Error('boom'), 'https://github.com/o/r/pull/6': null })
    const { rows } = await createTaskReader(run)(ID)
    expect(rows.map((r) => r.pr)).toEqual(expect.arrayContaining([
      { number: 5, url: 'https://github.com/o/r/pull/5', state: 'Open', ci: 'none', autoMerge: false, mergeState: 'UNKNOWN', mergedAt: '' },
      { number: 6, url: 'https://github.com/o/r/pull/6', state: 'Closed', ci: 'none', autoMerge: false, mergeState: 'UNKNOWN', mergedAt: '' }]))
  })

  it.each([
    ['auto-merge on, clean', { autoMergeRequest: { enabledAt: '2026-10-01T00:00:00Z' }, mergeStateStatus: 'CLEAN' }, true, 'CLEAN'],
    ['no auto-merge, blocked', { autoMergeRequest: null, mergeStateStatus: 'BLOCKED' }, false, 'BLOCKED'],
    ['an unknown merge state word', { mergeStateStatus: 'SOMETHING_NEW' }, false, 'UNKNOWN'],
    ['a merge state that is not text', { mergeStateStatus: 7, autoMergeRequest: 'on' }, false, 'UNKNOWN'],
    ['a lower-case known word', { mergeStateStatus: 'behind' }, false, 'BEHIND'],
  ])('merge fields: %s', async (_name, fields, autoMerge, mergeState) => {
    const { run } = gh([issue(1)], [pr(5, 1)], { 'https://github.com/o/r/pull/5': { statusCheckRollup: [], state: 'OPEN', isDraft: false, ...fields } })
    const read = (await createTaskReader(run)(ID)).rows[0].pr!
    expect(read).toMatchObject({ autoMerge, mergeState })
    expect(read).not.toHaveProperty('inQueue')
  })

  it('a pull request beyond the 20 read keeps the merge defaults while the others carry GitHub\'s word', async () => {
    const n = Array.from({ length: 21 }, (_, i) => i + 1)
    const base = gh(n.map((i) => issue(i, { updatedAt: `2026-10-${String(i).padStart(2, '0')}` })), n.map((i) => pr(100 + i, i)))
    const run: Run = async (args) => args[0] === 'pr' ? { stdout: JSON.stringify({ statusCheckRollup: [], state: 'OPEN', mergeStateStatus: 'CLEAN' }) } : base.run(args)
    const { rows } = await createTaskReader(run)(ID)
    expect(rows.filter((r) => r.pr!.mergeState === 'UNKNOWN').map((r) => r.issue)).toEqual([1])
    expect(rows.filter((r) => r.pr!.mergeState === 'CLEAN')).toHaveLength(20)
  })

  it('reads CI for at most 20 PRs a refresh, four at a time', async () => {
    const n = Array.from({ length: 25 }, (_, i) => i + 1)
    let active = 0, peak = 0, views = 0
    const base = gh(n.map((i) => issue(i, { updatedAt: `2026-10-${String(i).padStart(2, '0')}` })), n.map((i) => pr(100 + i, i)))
    const run: Run = async (args) => {
      if (args[0] !== 'pr') return base.run(args)
      views++; active++; peak = Math.max(peak, active)
      await new Promise((done) => setImmediate(done))
      active--
      return { stdout: JSON.stringify({ statusCheckRollup: [], state: 'OPEN' }) }
    }
    const { rows } = await createTaskReader(run)(ID)
    expect(rows).toHaveLength(25)
    expect(views).toBe(20)
    expect(peak).toBe(4)
  })

  it('strips control and format characters from a title and cuts it to 512 characters', async () => {
    const { run } = gh([issue(1, { title: `\x1b[2Jfix‮​ it\n${'x'.repeat(600)}` }), issue(2, { title: 7 })])
    const { rows } = await createTaskReader(run)(ID)
    const title = rows.find((r) => r.issue === 1)!.title
    expect(title.startsWith('[2Jfix it')).toBe(true)
    expect(title).toHaveLength(512)
    expect(title).not.toMatch(/[\p{Cc}\p{Cf}]/u)
    expect(rows.find((r) => r.issue === 2)!.title).toBe('')
  })

  it('says it was truncated when a search reached 100, issues or PRs', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => issue(i + 1))
    expect((await createTaskReader(gh(hundred).run)(ID)).truncated).toBe(true)
    expect((await createTaskReader(gh([issue(1)], Array.from({ length: 100 }, (_, i) => pr(i + 1, 1))).run)(ID)).truncated).toBe(true)
    expect((await createTaskReader(gh(hundred.slice(1)).run)(ID)).truncated).toBe(false)
  })

  describe('errors', () => {
    it.each([
      ['gh is not installed', { code: 'ENOENT', stderr: '' }, 'GH_MISSING'],
      ['not signed in (gh auth login)', { code: 1, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }, 'GH_SIGNED_OUT'],
      ['not signed in (not logged in)', { stderr: 'You are not logged into any GitHub hosts' + ' not logged in' }, 'GH_SIGNED_OUT'],
      ['bad authentication', { stderr: 'authentication required' }, 'GH_SIGNED_OUT'],
      ['rate limit', { stderr: 'API rate limit exceeded' }, 'RATE_LIMITED'],
      ['secondary rate limit', { stderr: 'You have exceeded a secondary rate limit' }, 'RATE_LIMITED'],
      ['HTTP 403', { stderr: 'HTTP 403: Forbidden' }, 'RATE_LIMITED'],
      ['HTTP 429', { stderr: 'HTTP 429' }, 'RATE_LIMITED'],
      ['killed by the timeout', { killed: true, stderr: '' }, 'TIMEOUT'],
      ['SIGKILL', { signal: 'SIGKILL', stderr: '' }, 'TIMEOUT'],
    ])('%s is %s', async (_name, error, code) => {
      expect((await reason(createTaskReader(failing(error))(ID))).startsWith(`${code}: `)).toBe(true)
    })

    it('any other failure is GH_FAILED with the first 200 characters of stderr, cleaned', async () => {
      const text = await reason(createTaskReader(failing({ code: 1, stderr: `\x1b[31mbad${'y'.repeat(300)}` }))(ID))
      expect(text).toBe(`GH_FAILED: [31mbad${'y'.repeat(193)}`)
      expect(await reason(createTaskReader(failing({ code: 1, stderr: '' }))(ID))).toBe('GH_FAILED: gh failed.')
      expect(await reason(createTaskReader(failing({ code: 1 }))(ID))).toBe('GH_FAILED: gh failed.')
      expect(await reason(createTaskReader(failing(undefined))(ID))).toBe('GH_FAILED: gh failed.')
    })

    it('a search that answers with something that is not a list of rows is GH_FAILED', async () => {
      expect(await reason(createTaskReader(async () => ({ stdout: 'not json' }))(ID))).toMatch(/^GH_FAILED: /)
      expect(await reason(createTaskReader(async () => ({ stdout: '{"a":1}' }))(ID))).toMatch(/^GH_FAILED: /)
    })

    it('an id that is not 24 hex is refused as NOT_SHARED before gh is asked', async () => {
      const { run, calls } = gh([])
      for (const id of ['', 'A'.repeat(24), 'a'.repeat(23), `${ID}\n--help`, 'a b']) expect(await reason(createTaskReader(run)(id))).toMatch(/^NOT_SHARED: /)
      expect(calls).toEqual([])
    })
  })

  describe('cache', () => {
    it('keeps an answer 30 s and asks again after', async () => {
      let t = 1_000
      const { run, calls } = gh([issue(1)])
      const read = createTaskReader(run, () => t)
      await read(ID)
      const first = calls.length
      t += TASKS_FRESH_MS - 1
      await read(ID)
      expect(calls).toHaveLength(first)
      t += 1
      await read(ID)
      expect(calls.length).toBe(first * 2)
    })

    it('keeps a failure 5 s, then tries again', async () => {
      let t = 1_000, down = true
      const { run, calls } = gh([issue(1)])
      const read = createTaskReader(async (args) => { if (down) throw { code: 1, stderr: 'boom' }; return run(args) }, () => t)
      expect(await reason(read(ID))).toMatch(/^GH_FAILED/)
      await Promise.resolve()
      down = false
      t += TASKS_FAILED_MS - 1
      expect(await reason(read(ID))).toMatch(/^GH_FAILED/)
      expect(calls).toEqual([])
      t += 1
      expect((await read(ID)).rows).toHaveLength(1)
    })

    it('callers that arrive while a refresh runs share its one flight, and each tab has its own', async () => {
      let release!: () => void
      const gate = new Promise<void>((done) => { release = done })
      const { run, calls } = gh([issue(1)])
      const read = createTaskReader(async (args) => { await gate; return run(args) })
      const first = read(ID), second = read(ID), other = read(OTHER)
      release()
      const [a, b] = await Promise.all([first, second, other])
      expect(a).toBe(b)
      expect(calls.filter((c) => c[1] === 'issues')).toHaveLength(2)
    })
  })

  it('the default runner starts gh by its full path with a timeout, SIGKILL, a 1 MiB buffer and no prompts, the arguments untouched', async () => {
    const dir = ghFolder()
    vi.stubEnv('PATH', dir)
    child.execFile.mockImplementation((...all: unknown[]) => { const done = all.at(-1) as (e: unknown, r: { stdout: string; stderr: string }) => void
      done(null, { stdout: '[]', stderr: '' })
    })
    await createTaskReader()(ID)
    const [command, args, options] = child.execFile.mock.calls[0]
    expect(command).toBe(join(dir, 'gh'))
    expect(args.slice(0, 3)).toEqual(['search', 'issues', `harness-tab:${ID}`])
    expect(options).toMatchObject({ timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } })
    expect(child.execFile.mock.calls.every(([c]) => c === join(dir, 'gh'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds gh off the daemon\'s PATH: in the usual install folders, then on the login shell\'s PATH, and the shell only when needed', async () => {
    // A daemon started by launchd has the bare system PATH: Homebrew's gh was "not installed" beside a working one (2026-10-17).
    const onPath = ghFolder(), installed = ghFolder(), inShell = ghFolder(), empty = mkdtempSync(join(tmpdir(), 'nogh-'))
    const shell = vi.fn(async () => inShell)
    expect(await findGh({ PATH: onPath }, [installed], shell)).toBe(join(onPath, 'gh'))
    expect(await findGh({ PATH: empty }, [empty, installed], shell)).toBe(join(installed, 'gh'))
    expect(shell).not.toHaveBeenCalled()
    expect(await findGh({ PATH: empty }, [empty], shell)).toBe(join(inShell, 'gh'))
    expect(await findGh({}, [], async () => undefined)).toBeNull()
    expect(await findGh({ PATH: empty }, [empty], async () => empty)).toBeNull()
    for (const dir of [onPath, installed, inShell, empty]) rmSync(dir, { recursive: true, force: true })
  })

  it('the default runner refuses to start gh under a test runner, whatever the caller', async () => {
    vi.stubEnv('VITEST', 'true')
    expect(await reason(createTaskReader()(ID))).toMatch(/^GH_FAILED: The real gh is not run in tests\./)
    expect(child.execFile).not.toHaveBeenCalled()
  })

  it('too large a result is GH_FAILED, not a timeout, even though the child was killed', async () => {
    expect(await reason(createTaskReader(failing({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, stderr: '' }))(ID))).toBe('GH_FAILED: GitHub returned too many or too large results.')
  })

  it('the default runner reports a missing gh as GH_MISSING', async () => {
    child.execFile.mockImplementation((_c: string, _a: string[], _o: unknown, done: (e: unknown) => void) => done(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })))
    expect(await reason(createTaskReader()(ID))).toMatch(/^GH_MISSING: /)
  })
})
