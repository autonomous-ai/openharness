import { describe, expect, it, vi } from 'vitest'
import { projectPullRequestFiles, type PullRequestFilesApp } from './pullRequestFiles.js'

function fakeApp(files: Record<number, string[] | null>, heads: Record<number, string> = {}) {
  const app: PullRequestFilesApp = {
    resolve: vi.fn(async repository => ({ installation: 1, repository })),
    createToken: vi.fn(async () => ({ token: 'read-token', expiresAt: '' })),
    revoke: vi.fn(async () => {}),
    watchPullRequest: vi.fn(async (_repository, number) => heads[number] ? { head: heads[number]! } as never : null),
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
    expect(read).toEqual({ urls: [`${REPO}/pull/7`, `${REPO}/pull/8`], head: 'abc1234', files: ['a.ts', 'b.ts', 'c.ts'] })
    expect(app.pullRequestFiles).toHaveBeenCalledTimes(2)
    expect(app.revoke).toHaveBeenCalledWith('read-token')
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
