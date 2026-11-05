import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { readReleases, watchReleases, type GitHubGet, type ReleaseReader } from './releaseWatch.js'
import type { ReleaseFacts, ReleaseLedger } from './releases.js'
import { componentNamed } from './releases.js'

const REPO = { owner: 'acme', name: 'app', fullName: 'acme/app' }
const T = Date.UTC(2026, 10, 6, 4, 0)
const run = (over: Record<string, unknown> = {}) => ({ head_branch: 'v1.3.78_desktop', head_sha: 'd1', event: 'push', conclusion: 'success',
  run_started_at: new Date(T).toISOString(), created_at: new Date(T).toISOString(), ...over })

/** A fake GitHub answering [routes] by path prefix; it records each path asked. */
function github(routes: Record<string, { status: number; body: unknown; next?: string }>) {
  const asked: string[] = []
  const get: GitHubGet = async (_repository, path) => {
    asked.push(path)
    const hit = Object.keys(routes).find(key => path === key || path.startsWith(`${key}?`) || (key.endsWith('/') && path.startsWith(key)))
    return hit ? routes[hit]! : { status: 404, body: {} }
  }
  return { get, asked }
}
const repo = { status: 200, body: { default_branch: 'main' } }
const onMain = (committed: number, status = 'ahead') => ({ status: 200, body: { status, base_commit: { commit: { committer: { date: new Date(committed).toISOString() } } } } })

describe('readReleases.latest', () => {
  it('takes the newest successful tag push of the component\'s own workflow, on main, with its commit\'s time', async () => {
    const g = github({
      '/repos/acme/app/actions/workflows/release-desktop.yml/runs': { status: 200, body: { workflow_runs: [
        run({ head_branch: 'main', event: 'schedule' }), run({ head_branch: 'v1.3.78_desktop-candidate' }), run(), run({ head_branch: 'v1.3.77_desktop', head_sha: 'd0' })] } },
      '/repos/acme/app/compare/d1...main': onMain(T - 60_000),
      '/repos/acme/app': repo,
    })
    expect(await readReleases(g.get).latest(REPO, componentNamed('desktop'))).toEqual({ tag: 'v1.3.78_desktop', sha: 'd1', at: T, committedAt: T - 60_000 })
    expect(g.asked[0]).toBe('/repos/acme/app/actions/workflows/release-desktop.yml/runs?event=push&status=success&per_page=30')
  })

  it('says none for a repository without that workflow or any release, and for a tag not on main', async () => {
    expect(await readReleases(github({ '/repos/acme/app': repo }).get).latest(REPO, componentNamed('cli'))).toBeUndefined()
    const empty = github({ '/repos/acme/app/actions/workflows/release.yml/runs': { status: 200, body: { workflow_runs: [] } }, '/repos/acme/app': repo })
    expect(await readReleases(empty.get).latest(REPO, componentNamed('cli'))).toBeUndefined()
    const off = github({ '/repos/acme/app/actions/workflows/release-desktop.yml/runs': { status: 200, body: { workflow_runs: [run()] } },
      '/repos/acme/app/compare/d1...main': onMain(T, 'diverged'), '/repos/acme/app': repo })
    expect(await readReleases(off.get).latest(REPO, componentNamed('desktop'))).toBeUndefined()
  })

  it('says it cannot tell (null) when GitHub fails, so nothing is marked on a guess', async () => {
    const down = github({ '/repos/acme/app/actions/workflows/release-desktop.yml/runs': { status: 502, body: {} }, '/repos/acme/app': repo })
    expect(await readReleases(down.get).latest(REPO, componentNamed('desktop'))).toBeNull()
    const compare = github({ '/repos/acme/app/actions/workflows/release-desktop.yml/runs': { status: 200, body: { workflow_runs: [run()] } },
      '/repos/acme/app/compare/': { status: 500, body: {} }, '/repos/acme/app': repo })
    expect(await readReleases(compare.get).latest(REPO, componentNamed('desktop'))).toBeNull()
  })
})

describe('readReleases.files', () => {
  it('reads every page of a pull request\'s files, renames by both names', async () => {
    const g = github({
      '/repos/acme/app/pulls/7/files?per_page=100&page=2': { status: 200, body: [{ filename: 'cli/src/b.ts' }] },
      '/repos/acme/app/pulls/7/files': { status: 200, body: [{ filename: 'desktop/lib/a.dart', previous_filename: 'desktop/lib/old.dart' }], next: '/repos/acme/app/pulls/7/files?per_page=100&page=2' },
    })
    expect(await readReleases(g.get).files(REPO, 7)).toEqual(['desktop/lib/a.dart', 'desktop/lib/old.dart', 'cli/src/b.ts'])
    expect(await readReleases(github({}).get).files(REPO, 8)).toBeNull()
  })
})

describe('watchReleases', () => {
  const ledger = (over: Partial<ReleaseLedger> = {}): ReleaseLedger => ({ pending: [
    { groupId: 'g1', url: 'https://github.com/acme/app/pull/7', mergedAt: T - 1 },
    { groupId: 'g2', url: 'https://github.com/acme/app/pull/8', mergedAt: T - 1, components: ['backend'] },
    { groupId: 'g3', url: 'https://github.com/acme/app/pull/9', mergedAt: T - 1 },
  ], ...over })
  function scene(releases: ReleaseLedger | undefined, reader: Partial<ReleaseReader> = {}) {
    const head = { deleted: false, data: { projects: [
      { id: 'p1', leadConversationId: 'lead', repository: { machineId: 'm', cwd: '/r', repositoryUrl: 'https://github.com/acme/app' }, ...releases ? { releases } : {} },
      { id: 'p2', leadConversationId: 'lead2' }] } }
    const db = {
      superTabModelEvidence: { aggregateRaw: async () => [{ _id: { tabId: 'tab', projectId: 'p1' } }, { _id: { tabId: 'tab', projectId: 'p2' } }] },
      swarmHead: { findUnique: async () => head },
    } as unknown as PrismaClient
    const settled: Array<{ tabId: string; projectId: string; facts: ReleaseFacts }> = []
    const store = { settleReleases: async (tabId: string, projectId: string, facts: ReleaseFacts) => { settled.push({ tabId, projectId, facts }); return { messages: [], shipped: [], opened: null, dropped: [] } } }
    const read: string[] = []
    const fake: ReleaseReader = {
      files: async (_repo, number) => { read.push(`files ${number}`); return number === 7 ? ['desktop/lib/a.dart'] : null },
      latest: async (_repo, component) => { read.push(`latest ${component.id}`); return component.id === 'backend' ? { tag: 'v1.4.17_backend', sha: 'b', at: T, committedAt: T } : null },
      done: async () => { read.push('done') },
      ...reader,
    }
    return { db, store, settled, read, fake }
  }

  it('reads each new entry\'s files once, only the components something waits for, and settles with what it read', async () => {
    const s = scene(ledger())
    await watchReleases(s.db, s.store, s.fake, T, { warn: () => {}, info: () => {} })
    expect(s.read).toEqual(['files 7', 'files 9', 'latest backend', 'latest desktop', 'latest web', 'done'])
    expect(s.settled).toEqual([{ tabId: 'tab', projectId: 'p1', facts: {
      components: [{ groupId: 'g1', url: 'https://github.com/acme/app/pull/7', components: ['desktop', 'web'] }],
      releases: { backend: { tag: 'v1.4.17_backend', sha: 'b', at: T, committedAt: T } } } }])
  })

  it('reads an open step\'s component too, and nothing for a project with nothing to settle', async () => {
    const s = scene({ pending: [], steps: { cli: { groupId: 's', at: T } } })
    await watchReleases(s.db, s.store, s.fake, T, { warn: () => {}, info: () => {} })
    expect(s.read).toEqual(['latest cli', 'done'])
    const quiet = scene({ pending: [] })
    await watchReleases(quiet.db, quiet.store, quiet.fake, T, { warn: () => {}, info: () => {} })
    expect(quiet.settled).toEqual([])
  })

  it('says each project it could not read, and goes on', async () => {
    const warned: string[] = []
    const s = scene(ledger(), { files: async () => { throw new Error('boom') } })
    await watchReleases(s.db, s.store, s.fake, T, { warn: message => { warned.push(message) }, info: () => {} })
    expect(warned).toEqual(['[swarm-releases] project skipped'])
    expect(s.read.at(-1)).toBe('done')
  })
})
