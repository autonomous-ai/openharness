import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sweepWorktrees } from './worktreeSweep.js'

const exec = promisify(execFile)
describe('sweeping unused worktrees', () => {
  let root: string, repo: string, home: string
  const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd,
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args])).stdout.trim()
  const later = () => Date.now() + 8 * 24 * 3600_000
  const add = async (name: string, branch: string, from = 'main') => {
    const path = join(home, 'app', name)
    await git(repo, 'worktree', 'add', '--quiet', '-b', branch, path, from)
    return path
  }
  const exists = (path: string) => stat(path).then(() => true, () => false)
  const branches = async () => (await git(repo, 'branch', '--format=%(refname:short)')).split('\n')
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-sweep-'))
    repo = join(root, 'app')
    home = join(root, 'harnesses', 'worktrees')
    await mkdir(repo)
    await git(repo, 'init', '--quiet', '-b', 'main')
    await writeFile(join(repo, 'file'), 'one')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '--quiet', '-m', 'initial')
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('removes a clean, idle, unused worktree and the harness branch that has nothing of its own', async () => {
    const path = await add('brave-otter', 'harness/brave-otter')
    expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })).toEqual([path])
    expect(await exists(path)).toBe(false)
    expect(await exists(join(home, 'app')), 'the repository folder goes with its last worktree').toBe(false)
    expect(await exists(home), 'the worktrees folder stays').toBe(true)
    expect(await branches()).toEqual(['main'])
  })

  it('keeps worktrees a live or stopped harness uses, recently touched ones, and uncommitted work', async () => {
    const used = await add('used', 'harness/used')
    const recent = await add('recent', 'harness/recent')
    const dirty = await add('dirty', 'harness/dirty')
    await writeFile(join(dirty, 'draft'), 'not committed')
    const old = new Date(Date.now() - 30 * 24 * 3600_000)
    for (const path of [used, dirty]) await utimes(path, old, old)
    const removed = await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [join(used, 'src'), null], now: later() })
    expect(removed).toEqual([recent])
    expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [used], now: Date.now() })).toEqual([])
    expect(await exists(used)).toBe(true)
    expect(await exists(dirty)).toBe(true)
  })

  it('keeps branches with commits of their own, and branches Harness did not name', async () => {
    const own = await add('own', 'harness/own')
    await writeFile(join(own, 'file'), 'two')
    await git(own, 'commit', '--quiet', '-am', 'work')
    await git(repo, 'branch', 'topic')
    const topic = join(home, 'app', 'topic')
    await git(repo, 'worktree', 'add', '--quiet', topic, 'topic')
    const removed = await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })
    expect(removed.sort()).toEqual([own, topic].sort())
    expect(await branches()).toEqual(expect.arrayContaining(['harness/own', 'topic', 'main']))
  })

  it('keeps a detached worktree holding a commit no branch has, and sweeps the flat layout older builds made', async () => {
    const detached = join(home, 'app', 'detached')
    await git(repo, 'worktree', 'add', '--quiet', '--detach', detached, 'main')
    await writeFile(join(detached, 'file'), 'lost?')
    await git(detached, 'commit', '--quiet', '-am', 'only here')
    const flat = join(home, 'app-claude-2026-09-22-11-36-13-abcdef')
    await git(repo, 'worktree', 'add', '--quiet', '-b', 'harness/app-claude-2026-09-22-11-36-13-abcdef', flat, 'main')
    expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })).toEqual([flat])
    expect(await exists(detached)).toBe(true)
    expect(await exists(home)).toBe(true)
  })

  it('ignores a missing worktrees folder and checkouts that are not worktrees', async () => {
    expect(await sweepWorktrees({ root: join(root, 'nothing'), inUse: [] })).toEqual([])
    await mkdir(join(home, 'app', 'plain'), { recursive: true })
    await git(repo, 'clone', '--quiet', repo, join(home, 'clone'))
    expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })).toEqual([])
  })
})
