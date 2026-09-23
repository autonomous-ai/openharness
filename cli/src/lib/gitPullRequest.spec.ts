import { describe, it, expect, vi } from 'vitest'
import { createPullRequestReader, githubRepository } from './gitPullRequest.js'
const row = (extra = {}) => ({ number: 12, html_url: 'https://github.com/acme/repo/pull/12', state: 'open', draft: false, merged_at: null, head: { ref: 'feature', repo: { full_name: 'acme/repo' } }, ...extra })
function fixture(rows: unknown = [row()]) {
  let branch = 'feature'
  const run = vi.fn(async (cmd: string, args: string[]) => cmd === 'git'
    ? args[0] === 'symbolic-ref' ? branch : 'git@github.com:acme/repo.git'
    : JSON.stringify(rows))
  return { run, read: createPullRequestReader(run), branch: (b: string) => { branch = b } }
}
describe('worktree PR status', () => {
  it.each([['https://github.com/acme/repo.git', 'acme/repo'], ['git@github.com:acme/repo.git', 'acme/repo'], ['https://token@github.com/acme/repo', null], ['https://example.com/acme/repo', null]])('validates repository %s', (remote, expected) => expect(githubRepository(remote!)).toBe(expected))
  it.each([['Open', {}], ['Draft', { draft: true }], ['Closed', { state: 'closed' }], ['Merged', { state: 'closed', merged_at: '2026-09-23' }]])('reports %s', async (state, extra) => {
    expect(await fixture([row(extra)]).read('/worktree')).toMatchObject({ status: 'found', state })
  })
  it('distinguishes no PR from missing auth/tool/network', async () => {
    expect(await fixture([]).read('/worktree')).toEqual({ status: 'none' })
    expect(await createPullRequestReader(async () => { throw Error('auth') })('/worktree')).toEqual({ status: 'unavailable' })
  })
  it('prefers an open PR, filters fork collisions, and refuses untrusted URLs', async () => {
    expect(await fixture([row({ state: 'closed', merged_at: 'date' }), row({ draft: true })]).read('/worktree')).toMatchObject({ state: 'Draft' })
    expect(await fixture([row({ head: { ref: 'feature', repo: { full_name: 'other/repo' } } })]).read('/worktree')).toEqual({ status: 'none' })
    expect(await fixture([row({ html_url: 'https://evil.example/pull/12' })]).read('/worktree')).toEqual({ status: 'unavailable' })
  })
  it('coalesces lookups and invalidates when the checked-out branch changes', async () => {
    const f = fixture()
    await Promise.all([f.read('/worktree'), f.read('/worktree')])
    expect(f.run.mock.calls.filter(([cmd]) => cmd === 'gh')).toHaveLength(1)
    f.branch('another')
    await f.read('/worktree')
    expect(f.run.mock.calls.filter(([cmd]) => cmd === 'gh')).toHaveLength(2)
  })
  it('does not execute anything for invalid paths', async () => {
    const f = fixture()
    expect(await f.read('relative')).toEqual({ status: 'unavailable' })
    expect(f.run).not.toHaveBeenCalled()
  })
})
