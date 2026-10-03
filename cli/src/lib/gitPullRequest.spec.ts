import { describe, it, expect, vi } from 'vitest'
import { boundedPullRequestRunner, createPullRequestReader, createPullRequestUrlReader, githubRepository } from './gitPullRequest.js'
const row = (extra = {}) => ({ number: 12, html_url: 'https://github.com/acme/repo/pull/12', state: 'open', draft: false, merged_at: null, head: { ref: 'feature', repo: { full_name: 'acme/repo' } }, ...extra })
function fixture(rows: unknown = [row()]) {
  let branch = 'feature'
  const run = vi.fn(async (cmd: string, args: string[]) => cmd === 'git'
    ? args[0] === 'symbolic-ref' ? branch : 'git@github.com:acme/repo.git'
    : JSON.stringify(args.at(-1)?.includes('/pulls?') ? rows : { full_name: 'acme/repo' }))
  return { run, read: createPullRequestReader(run), branch: (b: string) => { branch = b } }
}
describe('worktree PR status', () => {
  it('keeps GitHub lifecycle dates separate from lookup time and discards malformed dates', async () => {
    const run = vi.fn(async () => JSON.stringify(row({ state: 'closed',
      created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-26T11:00:00Z',
      merged_at: '2026-09-24T12:00:00Z', closed_at: 'not a timestamp' })))
    const read = createPullRequestUrlReader(run, () => Date.parse('2026-09-28T12:00:00Z'))
    const result = await read('https://github.com/acme/repo/pull/12')
    expect(result).toMatchObject({ state: 'Merged', createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-26T11:00:00.000Z', mergedAt: '2026-09-24T12:00:00.000Z',
      checkedAt: '2026-09-28T12:00:00.000Z' })
    expect(result).not.toHaveProperty('closedAt')
    expect(run.mock.calls[0]).toBeDefined()
  })
  it('retains the original GitHub check time when serving cached history', async () => {
    let now = Date.parse('2026-09-27T13:00:00Z')
    const run = vi.fn(async () => JSON.stringify(row()))
    const read = createPullRequestUrlReader(run, () => now)
    const first = await read('https://github.com/acme/repo/pull/12')
    now += 30_000
    expect(await read('https://github.com/acme/repo/pull/12')).toEqual(first)
    now += 31_000
    expect(await read('https://github.com/acme/repo/pull/12')).toMatchObject({ checkedAt: new Date(now).toISOString() })
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('bounds concurrent processes and rejects excess queued work', async () => {
    let active = 0, maximum = 0
    const completions: Array<() => void> = []
    const run = boundedPullRequestRunner(async () => {
      maximum = Math.max(maximum, ++active)
      await new Promise<void>(resolve => completions.push(resolve))
      active--; return 'ok'
    }, 2, 1)
    const pending = [run('gh', [], '/tmp'), run('gh', [], '/tmp'), run('gh', [], '/tmp')]
    await expect(run('gh', [], '/tmp')).rejects.toThrow('busy')
    completions.shift()!(); await pending[0]
    completions.shift()!(); await pending[1]
    completions.shift()!(); await pending[2]
    expect(maximum).toBe(2)
  })
  it('follows a recorded PR through a GitHub repository rename to its canonical URL', async () => {
    const read = createPullRequestUrlReader(async () => JSON.stringify(row()))
    expect(await read('https://github.com/acme/old-name/pull/12')).toMatchObject({
      status: 'found', url: 'https://github.com/acme/repo/pull/12', number: 12,
    })
    expect(await read('https://github.com/acme/old-name/pull/13')).toEqual({ status: 'unavailable' })
  })
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
    const queries = () => f.run.mock.calls.filter(([cmd, args]) => cmd === 'gh' && args.at(-1)?.includes('/pulls?'))
      .map(([, args]) => new URLSearchParams(args.at(-1)!.split('?')[1]))
    expect(queries().map(q => q.get('state')).sort()).toEqual(['closed', 'open'])
    f.branch('another')
    await f.read('/worktree')
    expect(queries().filter(q => q.get('head') === 'acme:another').map(q => q.get('state')).sort()).toEqual(['closed', 'open'])
    expect(f.run.mock.calls.some(([cmd, args]) => cmd === 'gh' && args.at(-1)?.includes('head=acme%3Aanother'))).toBe(true)
  })
  it('uses canonical repository identity after an origin rename', async () => {
    const calls: string[][] = []
    const read = createPullRequestReader(async (cmd, args) => {
      if (cmd === 'git') return args[0] === 'symbolic-ref' ? 'feature' : 'https://github.com/acme/old-name.git'
      calls.push(args)
      return JSON.stringify(args.at(-1)?.includes('/pulls?') ? [row()] : { full_name: 'acme/repo' })
    })
    expect(await read('/worktree')).toMatchObject({ status: 'found', url: 'https://github.com/acme/repo/pull/12' })
    expect(calls[1].at(-1)).toContain('repos/acme/repo/pulls?')
  })
  it('resolves fork-to-parent PRs by head repository as well as branch name', async () => {
    const read = createPullRequestReader(async (command, args) => {
      if (command === 'git') return args[0] === 'symbolic-ref' ? 'feature' : 'https://github.com/alice/repo'
      const path = args.at(-1)!
      if (!path.includes('/pulls?')) return JSON.stringify({ full_name: 'alice/repo', fork: true, parent: { full_name: 'acme/repo' } })
      if (path.startsWith('repos/alice/')) return '[]'
      return JSON.stringify([
        row({ number: 13, html_url: 'https://github.com/acme/repo/pull/13', head: { ref: 'feature', repo: { full_name: 'another/repo' } } }),
        row({ title: 'Fix preview', head: { ref: 'feature', repo: { full_name: 'alice/repo' } }, base: { ref: 'main' } }),
      ])
    })
    expect(await read('/worktree')).toMatchObject({ status: 'found', number: 12, headRepository: 'alice/repo', headBranch: 'feature', baseBranch: 'main' })
  })
  it('does not execute anything for invalid paths', async () => {
    const f = fixture()
    expect(await f.read('relative')).toEqual({ status: 'unavailable' })
    expect(f.run).not.toHaveBeenCalled()
  })
  it('rejects a badge request for an obsolete checkout identity', async () => {
    const f = fixture()
    expect(await f.read('/worktree', { branch: 'old', remote: 'github.com/acme/repo' })).toEqual({ status: 'unavailable' })
    expect(f.run.mock.calls.some(([cmd]) => cmd === 'gh')).toBe(false)
  })
  it('discards a PR if the branch switches while GitHub is replying', async () => {
    let branch = 'feature'
    const read = createPullRequestReader(async (command, args) => {
      if (command === 'git') return args[0] === 'symbolic-ref' ? branch : 'https://github.com/acme/repo'
      if (args.at(-1)?.includes('/pulls?')) { branch = 'next-task'; return JSON.stringify([row()]) }
      return JSON.stringify({ full_name: 'acme/repo' })
    })
    expect(await read('/worktree')).toEqual({ status: 'unavailable' })
  })
  it('resolves a saved PR URL without its deleted branch or directory', async () => {
    const run = vi.fn(async () => JSON.stringify(row({ state: 'closed', merged_at: '2026-09-27' })))
    const read = createPullRequestUrlReader(run)
    expect(await read('https://github.com/acme/repo/pull/12')).toMatchObject({ status: 'found', state: 'Merged' })
    expect(run.mock.calls).toHaveLength(1)
    await read('https://github.com/acme/repo/pull/12')
    expect(run.mock.calls).toHaveLength(1)
    expect(await read('https://github.com/../repo/pull/12')).toEqual({ status: 'unavailable' })
    expect(await read('https://github.com/acme/../pull/12')).toEqual({ status: 'unavailable' })
    expect(run.mock.calls).toHaveLength(1)
  })
})
