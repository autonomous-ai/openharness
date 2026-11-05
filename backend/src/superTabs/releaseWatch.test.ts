import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { batchLookupDue, readReleases, watchReleases, type GitHubGet, type ReleaseReader } from './releaseWatch.js'
import type { ReleaseFacts, ReleaseLedger } from './releases.js'
import { componentNamed, pendingKey } from './releases.js'

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
  it('takes the highest successful tag push of the component\'s own workflow, on main', async () => {
    const g = github({
      '/repos/acme/app/actions/workflows/release-desktop.yml/runs': { status: 200, body: { workflow_runs: [
        run({ head_branch: 'main', event: 'schedule' }), run({ head_branch: 'v1.3.78_desktop-candidate' }),
        // A re-run of an older tag's workflow, listed first: the higher version still wins.
        run({ head_branch: 'v1.3.77_desktop', head_sha: 'd0', run_started_at: new Date(T + 60_000).toISOString() }), run()] } },
      '/repos/acme/app/compare/d1...main': onMain(T - 60_000),
      '/repos/acme/app': repo,
    })
    expect(await readReleases(g.get).latest(REPO, componentNamed('desktop'))).toEqual({ tag: 'v1.3.78_desktop', sha: 'd1', at: T })
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

describe('readReleases.mergeCommit and contains', () => {
  it('takes a merged pull request\'s own merge commit', async () => {
    const g = github({ '/repos/acme/app/pulls/7': { status: 200, body: { merged_at: new Date(T).toISOString(), merge_commit_sha: 'm7' } } })
    expect(await readReleases(g.get).mergeCommit(REPO, 7, T)).toBe('m7')
  })

  it('finds the batch commit on main that closed an original pull request, the oldest one naming it', async () => {
    const g = github({
      '/repos/acme/app/pulls/7': { status: 200, body: { merged_at: null, state: 'closed' } },
      '/repos/acme/app/commits': { status: 200, body: [
        { sha: 'later', commit: { message: 'Fix the follow-up of #7' } },
        { sha: 'other', commit: { message: 'Merge batch i1: #70 #71 (#80)' } },
        { sha: 'batch', commit: { message: 'Merge batch i0: #6 #7 (#79)' } }] },
      '/repos/acme/app': repo,
    })
    expect(await readReleases(g.get).mergeCommit(REPO, 7, T)).toBe('batch')
    expect(g.asked.at(-1)).toBe(`/repos/acme/app/commits?sha=main&since=${new Date(T - 6 * 3_600_000).toISOString()}&until=${new Date(T + 3_600_000).toISOString()}&per_page=100`)
    expect(await readReleases(github({ '/repos/acme/app/pulls/7': { status: 502, body: {} } }).get).mergeCommit(REPO, 7, T)).toBeNull()
  })

  // Review 2 of #3228: on main, squash titles carry task numbers ("… (#3159)") and batch bodies name other pull requests.
  it('takes only a batch title naming the original, never a task number in another title or a mention in a batch\'s body', async () => {
    const g = github({
      '/repos/acme/app/pulls/7': { status: 200, body: { merged_at: null, state: 'closed' } },
      '/repos/acme/app/commits': { status: 200, body: [
        { sha: 'real', commit: { message: 'Merge batch i2: #6 #7 (#80)' } },
        { sha: 'mention', commit: { message: 'Merge batch i1: #5 (#79)\n\nIncludes the fix #7 needed.' } },
        { sha: 'task', commit: { message: 'The board says so (#7)' } }] },
      '/repos/acme/app': repo,
    })
    expect(await readReleases(g.get).mergeCommit(REPO, 7, T)).toBe('real')
    const none = github({ '/repos/acme/app/pulls/7': { status: 200, body: { merged_at: null } }, '/repos/acme/app': repo,
      '/repos/acme/app/commits': { status: 200, body: [{ sha: 'task', commit: { message: 'The board says so (#7)' } }, { sha: 'b', commit: { message: 'Merge batch i3: #70 (#81)' } }] } })
    expect(await readReleases(none.get).mergeCommit(REPO, 7, T)).toBeNull()
  })

  it('looks for a batch every pass in the merge\'s first hour, then every 30 minutes, then every 2 hours after a day', () => {
    const HOUR = 3_600_000, half = 30 * 60_000, at = 100 * 24 * HOUR
    expect(batchLookupDue(at, at + 10 * 60_000 + 7)).toBe(true)
    expect(batchLookupDue(at, at + 3 * HOUR)).toBe(true)
    expect(batchLookupDue(at, at + 3 * HOUR + 5 * 60_000)).toBe(false)
    expect(batchLookupDue(at, at + 2 * 24 * HOUR)).toBe(true)
    expect(batchLookupDue(at, at + 2 * 24 * HOUR + half)).toBe(false)
  })

  it('says a tag contains a merge when main\'s history from the merge reaches the tag', async () => {
    const answer = (status: string) => github({ '/repos/acme/app/compare/m7...t1': { status: 200, body: { status } } }).get
    expect(await readReleases(answer('identical')).contains(REPO, 'm7', 't1')).toBe(true)
    expect(await readReleases(answer('ahead')).contains(REPO, 'm7', 't1')).toBe(true)
    expect(await readReleases(answer('behind')).contains(REPO, 'm7', 't1')).toBe(false)
    expect(await readReleases(github({}).get).contains(REPO, 'm7', 't1')).toBeNull()
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
      latest: async (_repo, component) => { read.push(`latest ${component.id}`); return component.id === 'backend' ? { tag: 'v1.4.17_backend', sha: 'b', at: T } : null },
      mergeCommit: async (_repo, number) => { read.push(`merge ${number}`); return `m${number}` },
      contains: async (_repo, base, head) => { read.push(`contains ${base} ${head}`); return true },
      done: async () => { read.push('done') },
      ...reader,
    }
    return { db, store, settled, read, fake }
  }

  it('reads each new entry\'s files once, only the components something waits for, and settles with what it read', async () => {
    const s = scene(ledger())
    await watchReleases(s.db, s.store, s.fake, T, { warn: () => {}, info: () => {} })
    expect(s.read).toEqual(['files 7', 'merge 7', 'merge 8', 'files 9', 'latest backend', 'contains m8 b', 'latest desktop', 'latest web', 'done'])
    expect(s.settled).toEqual([{ tabId: 'tab', projectId: 'p1', facts: {
      // g1's merge commit waits for Desktop and Web, which GitHub could not read: it is found again next pass.
      resolved: [{ groupId: 'g1', url: 'https://github.com/acme/app/pull/7', components: ['desktop', 'web'] },
        { groupId: 'g2', url: 'https://github.com/acme/app/pull/8', sha: 'm8' }],
      releases: { backend: { tag: 'v1.4.17_backend', sha: 'b', at: T, carries: [pendingKey({ groupId: 'g2', url: 'https://github.com/acme/app/pull/8' })] } } } }])
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

  it('compares again only for a new tag or a newly resolved merge, and leaves out a release whose comparison GitHub could not answer', async () => {
    const known = { pending: [{ groupId: 'g2', url: 'https://github.com/acme/app/pull/8', mergedAt: T - 1, components: ['backend' as const], sha: 'm8' }],
      last: { backend: { tag: 'v1.4.17_backend', sha: 'b', at: T } } }
    const same = scene(known)
    await watchReleases(same.db, same.store, same.fake, T, { warn: () => {}, info: () => {} })
    expect(same.read).toEqual(['latest backend', 'done'])
    const unsure = scene({ ...known, last: {} }, { contains: async () => null })
    await watchReleases(unsure.db, unsure.store, unsure.fake, T, { warn: () => {}, info: () => {} })
    expect(unsure.settled[0]!.facts.releases).toEqual({})
  })

  // Review of #3228: the merge is recorded 20 s after its commit landed, and the CLI release is tagged on that very commit.
  it('ships a merge recorded after its commit landed, in the release tagged on that commit', async () => {
    const commitAt = T, recordedAt = T + 20_000
    const g = github({
      '/repos/acme/app/pulls/7': { status: 200, body: { merged_at: new Date(commitAt).toISOString(), merge_commit_sha: 'm7' } },
      '/repos/acme/app/actions/workflows/release.yml/runs': { status: 200, body: { workflow_runs: [run({ head_branch: 'v0.5.55_cli', head_sha: 'm7',
        run_started_at: new Date(T + 5 * 60_000).toISOString() })] } },
      '/repos/acme/app/compare/m7...main': { status: 200, body: { status: 'identical' } },
      '/repos/acme/app/compare/m7...m7': { status: 200, body: { status: 'identical' } },
      '/repos/acme/app': repo,
    })
    const s = scene({ pending: [{ groupId: 'g1', url: 'https://github.com/acme/app/pull/7', mergedAt: recordedAt, components: ['cli'] }] },
      { ...readReleases(g.get), done: async () => {} })
    await watchReleases(s.db, s.store, s.fake, T + 6 * 60_000, { warn: () => {}, info: () => {} })
    expect(s.settled[0]!.facts.releases.cli).toEqual({ tag: 'v0.5.55_cli', sha: 'm7', at: T + 5 * 60_000,
      carries: [pendingKey({ groupId: 'g1', url: 'https://github.com/acme/app/pull/7' })] })
  })

  // Review 2 of #3228: a merge commit found in a pass whose comparison GitHub could not answer is found again, so the tag
  // already settled is still compared with it.
  it('keeps no merge commit found in a pass whose comparison was unsure', async () => {
    const s = scene({ pending: [{ groupId: 'g2', url: 'https://github.com/acme/app/pull/8', mergedAt: T - 1, components: ['backend'] }],
      last: { backend: { tag: 'v1.4.17_backend', sha: 'b', at: T } } }, { contains: async () => null })
    await watchReleases(s.db, s.store, s.fake, T, { warn: () => {}, info: () => {} })
    expect(s.read).toContain('merge 8')
    expect(s.settled[0]!.facts).toEqual({ resolved: [], releases: {} })
  })
})
