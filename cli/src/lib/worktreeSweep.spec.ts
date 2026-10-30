import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sweepWorktrees } from './worktreeSweep.js'

const exec = promisify(execFile)
// Real Git, several worktrees a test: slower than the default 5s under a full, parallel run.
describe('sweeping unused worktrees', { timeout: 30_000 }, () => {
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

  it('removes a branch Harness marked in the config, whatever its name', async () => {
    const path = await add('quiet-owl', 'deehw/quiet-owl')
    await git(repo, 'config', 'branch.deehw/quiet-owl.harness', 'placeholder')
    expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })).toEqual([path])
    expect(await branches()).toEqual(['main'])
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

  // Lead, 10-30 (#2266): before Harness's ignore file ignored itself, it was untracked in every worktree, so none ever read as
  // clean; 19 piled up on one Mac. The exact file an older Harness wrote is upgraded first; anything else stays as it is.
  const OLDER = 'runtime/\nlegacy-AGENTS.md\n'
  const withHarnessFolder = async (path: string, ignore: string) => {
    await mkdir(join(path, '.harness', 'runtime'), { recursive: true })
    await writeFile(join(path, '.harness', 'runtime', 'SKILL.md'), 'session skill')
    await writeFile(join(path, '.harness', '.gitignore'), ignore)
  }

  it('removes an idle worktree whose only untracked file is the ignore file an older Harness wrote', async () => {
    const path = await add('older-ignore', 'harness/older-ignore')
    await withHarnessFolder(path, OLDER)
    expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })).toEqual([path])
    expect(await exists(path)).toBe(false)
  })

  it('keeps a worktree whose ignore file someone edited, and leaves that file as it was', async () => {
    const path = await add('edited-ignore', 'harness/edited-ignore')
    await withHarnessFolder(path, `${OLDER}mine/\n`)
    expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })).toEqual([])
    expect(await readFile(join(path, '.harness', '.gitignore'), 'utf8')).toBe(`${OLDER}mine/\n`)
  })

  it('never rewrites a committed ignore file, which would be a change of its own', async () => {
    await mkdir(join(repo, '.harness'))
    await writeFile(join(repo, '.harness', '.gitignore'), OLDER)
    await git(repo, 'add', '.')
    await git(repo, 'commit', '--quiet', '-m', 'ignore file committed by an earlier git add -A')
    const path = await add('committed-ignore', 'harness/committed-ignore')
    await writeFile(join(path, 'draft'), 'not committed')
    expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })).toEqual([])
    expect(await readFile(join(path, '.harness', '.gitignore'), 'utf8')).toBe(OLDER)
  })

  it('never writes through a Harness folder that points elsewhere', async () => {
    const path = await add('linked-ignore', 'harness/linked-ignore')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, '.gitignore'), OLDER)
    await symlink(outside, join(path, '.harness'))
    expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })).toEqual([])
    expect(await readFile(join(outside, '.gitignore'), 'utf8')).toBe(OLDER)
  })

  it('ignores a missing worktrees folder and checkouts that are not worktrees', async () => {
    expect(await sweepWorktrees({ root: join(root, 'nothing'), inUse: [] })).toEqual([])
    await mkdir(join(home, 'app', 'plain'), { recursive: true })
    await git(repo, 'clone', '--quiet', repo, join(home, 'clone'))
    expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })).toEqual([])
  })
})
