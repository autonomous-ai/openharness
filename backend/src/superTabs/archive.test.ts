import { describe, expect, it, vi } from 'vitest'
import { fakeApp, fakeGitHub, throwawayKey } from '../github/fakeGitHub.js'
import { appPullRequests, startSwarmArchive, unknownPullRequests } from './archive.js'

const key = throwawayKey()
const setup = () => {
  const github = fakeGitHub({ publicKey: key.publicKey, appId: '424242' })
  github.installed.set('acme/app', 77)
  github.pulls.set('acme/app#7', { state: 'closed', merged_at: '2026-10-27T08:00:00Z' })
  github.pulls.set('acme/app#8', { state: 'open', merged_at: null })
  return { github, prs: appPullRequests(fakeApp(key.privateKey, github)) }
}

describe('pull request states for archiving', () => {
  it('reads each with one read-only token per repository, revoked once the sweep is done', async () => {
    const { github, prs } = setup()
    expect(await prs.state('https://github.com/acme/app/pull/7')).toBe('merged')
    expect(await prs.state('https://github.com/acme/app/pull/8')).toBe('open')
    const minted = github.calls.filter(c => c.path.endsWith('/access_tokens'))
    expect(minted).toHaveLength(1)
    expect(minted[0]!.body).toMatchObject({ permissions: { pull_requests: 'read', metadata: 'read' } })
    await prs.done()
    expect(github.revoked).toEqual(['ghs_fixture_1'])
  })

  it('cannot say for a repository without the app, a link that is no pull request, or a token GitHub refuses', async () => {
    const { github, prs } = setup()
    expect(await prs.state('https://github.com/other/repo/pull/1')).toBeNull()
    expect(await prs.state('https://github.com/acme/app/issues/7')).toBeNull()
    github.control.tokenStatus = 500
    const refused = appPullRequests(fakeApp(key.privateKey, github))
    expect(await refused.state('https://github.com/acme/app/pull/7')).toBeNull()
    await refused.done()
    expect(github.revoked).toEqual([])
  })

  it('cannot say anything without the Harness GitHub App', async () => {
    expect(await unknownPullRequests.state('https://github.com/acme/app/pull/7')).toBeNull()
    await unknownPullRequests.done()
  })
})

describe('the archive pass in the worker', () => {
  it('runs at once and then on its interval, never two passes at the same time', async () => {
    vi.useFakeTimers()
    try {
      let release = () => {}
      const passes: number[] = []
      const db = { swarmGroup: { findMany: async () => { passes.push(passes.length); await new Promise<void>(r => { release = r }); return [] } } }
      const stop = startSwarmArchive(db as never, { archiveFinished: async () => false }, () => unknownPullRequests, 1_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(passes).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(passes).toHaveLength(1)
      release()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(passes).toHaveLength(2)
      stop()
      release()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(passes).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })
})
