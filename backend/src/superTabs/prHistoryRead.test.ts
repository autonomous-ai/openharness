import { describe, expect, it, vi } from 'vitest'
import { readPrHistory } from './prHistoryRead.js'
import { githubRepository } from '../github/repository.js'

const repository = githubRepository('https://github.com/acme/app')!
const sha = (n: number) => n.toString(16).padStart(40, '0')
const file = (filename: string, additions = 1) => ({ filename, additions, deletions: 0, status: 'added' })
const files = [file('docs/plans/example-plan.md'), file('src/a.test.ts'), file('src/a.ts', 4)]
function fixture() {
  const get = vi.fn(async (path: string, _token: string): Promise<{ status: number; body: unknown; next?: string }> => {
    if (path === '/repos/acme/app/pulls/7') return { status: 200, body: { head: { sha: sha(3) }, commits: 3, changed_files: 3 } }
    if (path === '/repos/acme/app/pulls/7/commits?per_page=100&page=1') return { status: 200,
      body: files.map((_, n) => ({ sha: sha(n + 1), parents: [{ sha: sha(n) }] })) }
    if (path === '/repos/acme/app/pulls/7/files?per_page=100&page=1') return { status: 200, body: files }
    const match = /^\/repos\/acme\/app\/commits\/([a-f0-9]{40})\?per_page=100&page=1$/.exec(path)
    if (match) { const n = Number.parseInt(match[1]!, 16); return { status: 200, body: { sha: sha(n), files: [files[n - 1]] } } }
    throw new Error('Unexpected endpoint')
  })
  return { get, run: () => readPrHistory(get, repository, 7, 'private-token', sha(3)) }
}

describe('Ready reads bounded history facts', () => {
  it('computes a report from GitHub commit ancestry and net PR counts', async () => {
    expect(await fixture().run()).toMatchObject({ head: sha(3), planFirst: 'pass', testBeforeCode: 'pass', productionLines: 4 })
  })

  it.each([
    { head: { sha: sha(9) }, commits: 3, changed_files: 3 },
    { head: { sha: sha(3) }, commits: 51, changed_files: 3 },
    { head: { sha: sha(3) }, commits: 3, changed_files: 301 },
    { head: { sha: sha(3) }, commits: 4, changed_files: 3 },
    { head: { sha: sha(3) }, commits: 3, changed_files: 4 },
  ])('marks a different head, excessive or incomplete list unknown', async meta => {
    const f = fixture(), original = f.get.getMockImplementation()!
    f.get.mockImplementation(async (path, token) => path.endsWith('/pulls/7') ? { status: 200, body: meta } : original(path, token))
    expect(await f.run()).toMatchObject({ planFirst: 'unknown', testBeforeCode: 'unknown', productionLines: null })
  })

  it('rejects incomplete commit files and reports API errors without including their contents', async () => {
    const f = fixture(), original = f.get.getMockImplementation()!
    f.get.mockImplementation(async (path, token) => path.includes('/commits/000') ? { status: 200,
      body: { sha: sha(1), files: Array.from({ length: 100 }, () => files[0]) }, next: '/untrusted' } : original(path, token))
    expect(await f.run()).toMatchObject({ planFirst: 'unknown' })
    f.get.mockRejectedValue(new Error('private-token'))
    expect(JSON.stringify(await f.run())).not.toContain('private-token')
  })

  it('does not start any read once the read budget is exhausted', async () => {
    const f = fixture()
    expect(await readPrHistory(f.get, repository, 7, 'private-token', sha(3), 0)).toMatchObject({ planFirst: 'unknown' })
    expect(f.get).not.toHaveBeenCalled()
  })
})


it('paginates through fixed paths, ignoring an untrusted next URL', async () => {
  const f = fixture(), original = f.get.getMockImplementation()!
  const docs = Array.from({ length: 101 }, (_, n) => file(`docs/page-${n}.md`))
  f.get.mockImplementation(async (path, token) => {
    if (path.endsWith('/pulls/7')) return { status: 200, body: { head: { sha: sha(3) }, commits: 3, changed_files: 101 } }
    if (path.includes('/pulls/7/files?')) return path.endsWith('page=1')
      ? { status: 200, body: docs.slice(0, 100), next: 'https://untrusted.invalid/private-token' }
      : { status: 200, body: docs.slice(100) }
    if (path.includes(`/commits/${sha(1)}?`)) return path.endsWith('page=1')
      ? { status: 200, body: { sha: sha(1), files: docs.slice(0, 100) }, next: 'https://untrusted.invalid/private-token' }
      : { status: 200, body: { sha: sha(1), files: docs.slice(100) } }
    return original(path, token)
  })
  expect(await f.run()).toMatchObject({ planFirst: 'fail', testBeforeCode: 'pass', totalLines: 101 })
  expect(f.get.mock.calls.every(([path]) => path.startsWith('/repos/acme/app/'))).toBe(true)
  expect(f.get).toHaveBeenCalledWith(`/repos/acme/app/commits/${sha(1)}?per_page=100&page=2`, 'private-token')
})

it('rejects malformed commit details rather than reporting a partial pass', async () => {
  const f = fixture(), original = f.get.getMockImplementation()!
  f.get.mockImplementation(async (path, token) => path.includes(`/commits/${sha(3)}?`)
    ? { status: 200, body: { sha: sha(3), files: [{ ...file('src/a.ts'), additions: -1 }] } } : original(path, token))
  expect(await f.run()).toMatchObject({ planFirst: 'unknown', productionLines: null })
})
