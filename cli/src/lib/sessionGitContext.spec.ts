import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentProject } from './agentProject.js'
import { agentFrame } from './agentFrame.js'
import type { RegisteredSession } from './registry.js'
import { sessionGitContext, SessionGitContextReader } from './sessionGitContext.js'
import type { SessionWork } from './sessionWork.js'

const roots: string[] = []
const at = '2026-09-27T13:00:00.000Z'
const work = (paths: string[], extra: Partial<SessionWork> = {}): SessionWork => ({
  current: paths.map(cwd => ({ cwd, at })), locations: paths.map(cwd => ({ cwd, at })),
  pullRequests: [], uncertain: false, truncated: false, ...extra,
})
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('Git context from observed session work', () => {
  it('orders overlapping projections and keeps unchanged polling versions stable', async () => {
    const reader = new SessionGitContextReader()
    const old = await sessionGitContext(null)
    const next = { ...old, state: 'uncertain' as const }
    let finish!: (value: typeof old) => void
    const slow = reader.read('hn', () => new Promise(resolve => { finish = resolve }))
    const fast = await reader.read('hn', async () => next)
    finish(old)
    expect(await slow).toEqual(fast)
    expect(await reader.read('hn', async () => next)).toEqual(fast)
    const other = await reader.read('other-session', async () => old)
    expect(other.state).toBe('unavailable')
    expect(other.version?.revision).toBeGreaterThan(fast.version!.revision)
  })
  it('reads the actual branch of ship-hn while retaining silent-beacon for launch/resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-git-')); roots.push(root)
    const home = join(root, 'silent-beacon'), ship = join(root, 'ship-hn')
    await mkdir(home)
    const git = (...args: string[]) => execFileSync('git', ['-C', home, ...args], { stdio: 'pipe' })
    git('init', '-b', 'original')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial')
    git('worktree', 'add', '-b', 'hn/preview-fix', ship)
    await mkdir(join(ship, 'tui'))
    const observation = work([join(ship, 'tui')])
    const launch = await agentProject(home)
    const context = await sessionGitContext(launch, observation)
    expect(context).toMatchObject({ state: 'multiple', current: null })
    expect(context.checkouts?.map(p => p.branch)).toEqual(['original', 'hn/preview-fix'])
    expect(context.recentWork).toMatchObject({ project: { branch: 'hn/preview-fix' }, at })
    expect(launch?.branch).toBe('original')
    const session = { agentId: 'hn', sessionId: 's', engine: 'claude', cwd: home,
      registeredAt: 1, boundAt: 1, lastHookAt: 1, transcriptPath: null, runtimes: [],
      active: true, title: 'hn' } as unknown as RegisteredSession
    const frame = await agentFrame(session, { selectedModel: null, terminalAvailable: false,
      tokenUsage: { totalTokens: null, updatedAt: at, work: observation } })
    expect(frame.project?.branch).toBe('original')
    expect(frame.gitContext.checkouts?.map(p => p.branch)).toEqual(['original', 'hn/preview-fix'])
    expect(frame.gitContext.recentWork?.project.branch).toBe('hn/preview-fix')
    expect(session.cwd).toBe(home)
  })

  it('collapses different subfolders of one checkout without confusing two worktrees', async () => {
    const home = { name: 'app', cwd: '/home', root: '/home', branch: 'launch', remote: null }
    const read = async (cwd: string) => ({ ...home, cwd, root: cwd.startsWith('/one') ? '/one' : '/two', branch: 'topic' })
    expect(await sessionGitContext(null, work(['/one/src', '/one/test']), read))
      .toMatchObject({ state: 'observed', current: { cwd: '/one', branch: 'topic' }, locations: [{ cwd: '/one' }] })
    expect(await sessionGitContext(null, work(['/one/src', '/two/test']), read))
      .toMatchObject({ state: 'multiple', current: null })
  })

  it('resolves nested checkouts without replacing a fresh assigned-branch snapshot with a cached subfolder', async () => {
    const home = { name: 'app', cwd: '/home', root: '/home', branch: 'fresh', remote: 'github.com/acme/app' }
    const read = async (cwd: string) => cwd === '/home/nested'
      ? { ...home, cwd, root: cwd, branch: 'nested-topic' }
      : { ...home, cwd, branch: 'older-cache' }
    const context = await sessionGitContext(home, work(['/home/src', '/home/nested']), read)
    expect(context.state).toBe('multiple')
    expect(context.checkouts?.map(p => p.branch)).toEqual(['fresh', 'nested-topic'])
  })

  it('keeps absent, unreadable, uncertain and non-Git contexts distinct', async () => {
    const home = { name: 'app', cwd: '/home', root: '/home', branch: 'launch', remote: null }
    expect(await sessionGitContext(home)).toMatchObject({ state: 'workspace', current: home })
    const read = vi.fn(async () => null)
    expect(await sessionGitContext(home, work(['/gone']), read)).toMatchObject({ state: 'workspace', current: home })
    read.mockClear()
    expect(await sessionGitContext(home, work([], { uncertain: true }), read)).toMatchObject({ state: 'workspace', current: home })
    expect(read).not.toHaveBeenCalled()
    expect(await sessionGitContext(home, work(['/folder']), async () => ({ ...home, cwd: '/folder', root: null, branch: null })))
      .toMatchObject({ state: 'workspace', current: home })
  })

  it('reads associated Git branches independently of unresolved activity', async () => {
    const read = async (cwd: string) => ({ name: 'app', cwd, root: '/one', branch: 'topic', remote: null })
    const context = await sessionGitContext(null, work(['/one/src'], { uncertain: true,
      locations: [{ cwd: '/one/src', at }, { cwd: '/one/test', at }, { cwd: '/one-other', at }] }), read)
    expect(context).toMatchObject({ state: 'observed', current: { cwd: '/one', branch: 'topic' } })
    expect(context.locations.map(row => row.cwd)).toEqual(['/one', '/one-other'])
  })

  it('bounds Git work for a compound operation and preserves durable PR links without a checkout', async () => {
    const read = vi.fn(async () => null)
    const pullRequests = [{ url: 'https://github.com/acme/app/pull/12', cwd: '/gone', at }]
    const context = await sessionGitContext(null, work(Array.from({ length: 20 }, (_, i) => `/work/${i}`), { pullRequests }), read)
    expect(context).toMatchObject({ state: 'unavailable', current: null, truncated: true, pullRequests })
    expect(read).toHaveBeenCalledTimes(8)
  })

  it('retains recent Git work across unrelated non-Git activity without claiming parallel work has one branch', async () => {
    const home = { name: 'app', cwd: '/home', root: '/home', branch: 'original', remote: null }
    const read = async (cwd: string) => ({ ...home, cwd, root: cwd === '/notes' ? null : cwd,
      branch: cwd === '/notes' ? null : cwd === '/ship' ? 'shipping' : 'other' })
    const locations = [{ cwd: '/notes', at: '2026-09-28T01:00:00Z' }, { cwd: '/ship', at }]
    const recent = await sessionGitContext(home, work(['/notes'], { locations, uncertain: true }), read)
    expect(recent.recentWork).toMatchObject({ project: { branch: 'shipping' }, at })
    expect((await sessionGitContext(home, work(['/ship', '/other']), read)).recentWork).toBeUndefined()
    expect((await sessionGitContext(home, work(['/ship', '/missing']), async cwd => cwd === '/missing' ? null : read(cwd))).recentWork).toBeUndefined()
    expect((await sessionGitContext(home)).recentWork).toBeUndefined()
  })
})
