import { describe, expect, it, vi } from 'vitest'
import { projectPullRequestFiles, type PullRequestFilesApp } from './pullRequestFiles.js'

function fakeApp(files: Record<number, string[] | null>, heads: Record<number, string> = {}) {
  const app: PullRequestFilesApp = {
    resolve: vi.fn(async repository => ({ installation: 1, repository })),
    createToken: vi.fn(async () => ({ token: 'read-token', expiresAt: '' })),
    revoke: vi.fn(async () => {}),
    watchPullRequest: vi.fn(async (_repository, number) => heads[number] ? { head: heads[number]!, base: 'main' } as never : null),
    pullRequestFiles: vi.fn(async (_repository, number) => files[number] === null ? null
      : (files[number] ?? []).map(filename => ({ filename, status: 'modified', sha: 'x' }))),
  }
  return app
}

const REPO = 'https://github.com/acme/app'

describe('projectPullRequestFiles', () => {
  it('reads the head and the file names of the project\'s own pull requests, then revokes its token', async () => {
    const app = fakeApp({ 7: ['a.ts', 'b.ts'], 8: ['b.ts', 'c.ts'] }, { 7: 'abc1234', 8: 'def5678' })
    const read = await projectPullRequestFiles(app)(REPO, [`${REPO}/pull/7`, `${REPO}/pull/8`, 'https://github.com/other/repo/pull/9'])
    expect(read).toMatchObject({ urls: [`${REPO}/pull/7`, `${REPO}/pull/8`], head: 'abc1234', files: ['a.ts', 'b.ts', 'c.ts'],
      heads: [{ url: `${REPO}/pull/7`, head: 'abc1234', base: 'main' }, { url: `${REPO}/pull/8`, head: 'def5678', base: 'main' }] })
    expect(app.pullRequestFiles).toHaveBeenCalledTimes(2)
    expect(app.revoke).toHaveBeenCalledWith('read-token')
  })

  it('attaches unknown history when it cannot be read, preserving the files and revoking the read-only token', async () => {
    const app = fakeApp({ 7: ['a.ts'] }, { 7: 'a'.repeat(40) })
    Object.assign(app, { get: vi.fn(async () => { throw new Error('history unavailable') }) })
    const read = await projectPullRequestFiles(app)(REPO, [`${REPO}/pull/7`])
    expect(read?.files).toEqual(['a.ts'])
    expect(read?.heads?.[0]?.history).toMatchObject({ head: 'a'.repeat(40), planFirst: 'unknown', productionLines: null })
    expect(app.createToken).toHaveBeenCalledWith(1, expect.anything(), expect.objectContaining({ contents: 'read', pull_requests: 'read' }))
    expect(app.revoke).toHaveBeenCalledWith('read-token')
  })

  it('reads the files nothing pushed over: a head that moved while they were listed reads as unreadable', async () => {
    const app = fakeApp({ 7: ['a.ts'] }, { 7: 'abc1234' })
    let reads = 0
    app.watchPullRequest = vi.fn(async () => ({ head: ++reads === 1 ? 'abc1234' : 'def5678' }) as never)
    expect((await projectPullRequestFiles(app)(REPO, [`${REPO}/pull/7`]))?.files).toBeNull()
  })

  // Security review 2 of #3227 (Elm): only the first five were read, so a sixth changing sign-in planned an ordinary review.
  it('plans as unread when a task links more of the project\'s pull requests than it reads', async () => {
    const urls = Array.from({ length: 6 }, (_, i) => `${REPO}/pull/${i + 1}`)
    const app = fakeApp(Object.fromEntries(urls.map((_, i) => [i + 1, ['docs/a.md']])), Object.fromEntries(urls.map((_, i) => [i + 1, 'abc1234'])))
    const read = await projectPullRequestFiles(app)(REPO, urls)
    expect(read?.files).toBeNull()
    expect(read?.urls).toEqual(urls)
    expect(app.pullRequestFiles).not.toHaveBeenCalled()
  })

  it('has nothing to read with no pull request of the project\'s repository', async () => {
    const app = fakeApp({})
    expect(await projectPullRequestFiles(app)(REPO, ['https://github.com/other/repo/pull/9'])).toBeNull()
    expect(await projectPullRequestFiles(app)(null, [`${REPO}/pull/7`])).toBeNull()
    expect(app.resolve).not.toHaveBeenCalled()
  })

  it('says it could not read the files when GitHub cannot, or the app is not installed, or a read throws', async () => {
    expect((await projectPullRequestFiles(fakeApp({ 7: null }, { 7: 'abc1234' }))(REPO, [`${REPO}/pull/7`]))?.files).toBeNull()
    const missing = fakeApp({ 7: ['a.ts'] })
    missing.resolve = vi.fn(async () => null)
    expect(await projectPullRequestFiles(missing)(REPO, [`${REPO}/pull/7`])).toEqual({ urls: [`${REPO}/pull/7`], head: null, files: null })
    const broken = fakeApp({ 7: ['a.ts'] }, { 7: 'abc1234' })
    broken.pullRequestFiles = vi.fn(async () => { throw new Error('socket hang up') })
    expect((await projectPullRequestFiles(broken)(REPO, [`${REPO}/pull/7`]))?.files).toBeNull()
    expect(broken.revoke).toHaveBeenCalled()
  })
})


function historyApp() {
  const h = (n: number) => String(n).repeat(40)
  const app = fakeApp({ 7: ['docs/a.md'], 8: ['src/a.ts'] }, { 7: h(7), 8: h(8) })
  app.get = vi.fn(async path => {
    const number = path.includes('/pulls/7') || path.includes(h(7)) ? 7 : 8
    const filename = number === 7 ? 'docs/a.md' : 'src/a.ts'
    const files = [{ filename, additions: number, deletions: 0, status: 'added' }]
    if (/\/pulls\/\d+$/.test(path)) return { status: 200, body: { head: { sha: h(number) }, commits: 1, changed_files: 1 } }
    if (path.includes('/pulls/') && path.includes('/commits?')) return { status: 200, body: [{ sha: h(number), parents: [] }] }
    if (path.includes('/pulls/')) return { status: 200, body: files }
    return { status: 200, body: { sha: h(number), files } }
  })
  return app
}

it('collects distinct complete history reports for multiple project PRs', async () => {
  const read = await projectPullRequestFiles(historyApp())(REPO, [`${REPO}/pull/7`, `${REPO}/pull/8`])
  expect(read?.heads).toMatchObject([
    { head: '7'.repeat(40), history: { head: '7'.repeat(40), planFirst: 'not-needed', productionLines: 0, totalLines: 7 } },
    { head: '8'.repeat(40), history: { head: '8'.repeat(40), planFirst: 'fail', productionLines: 8, totalLines: 8 } },
  ])
})

it.each(['head', 'base'])('invalidates complete history if the %s moves during collection', async field => {
  const app = historyApp()
  let watches = 0
  app.watchPullRequest = vi.fn(async () => ++watches === 1 ? { head: '7'.repeat(40), base: 'main' }
    : { head: field === 'head' ? '9'.repeat(40) : '7'.repeat(40), base: field === 'base' ? 'other' : 'main' })
  const read = await projectPullRequestFiles(app)(REPO, [`${REPO}/pull/7`])
  expect(app.get).toHaveBeenCalled()
  expect(read?.heads?.[0]?.history).toMatchObject({ planFirst: 'unknown', productionLines: null })
  if (field === 'head') expect(read?.files).toBeNull()
})
