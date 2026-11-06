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

  it('never follows a supplied next URL or continues once the read budget is exhausted', async () => {
    const f = fixture()
    expect(await readPrHistory(f.get, repository, 7, 'private-token', sha(3), 0)).toMatchObject({ planFirst: 'unknown' })
    expect(f.get).not.toHaveBeenCalled()
  })
})
