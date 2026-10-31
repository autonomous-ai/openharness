import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sweepOne, sweepWorktrees, WorktreeKept } from './worktreeSweep.js'

const exec = promisify(execFile)
/** A folder the sweep's own check reads as writable whatever its mode. */
const writable = vi.hoisted(() => ({ folder: null as string | null }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, access: (file: string, mode?: number) => file === writable.folder ? Promise.resolve() : fs.access(file, mode) }
})
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

  // Review of #2266: the upgraded rule names only Harness's own file; an ignore file someone added deeper is still work.
  it('upgrades the older ignore file to a rule that still shows an ignore file someone added deeper', async () => {
    const path = await add('nested-ignore', 'harness/nested-ignore')
    await withHarnessFolder(path, OLDER)
    await mkdir(join(path, '.harness', 'mine'))
    await writeFile(join(path, '.harness', 'mine', '.gitignore'), 'scratch/\n')
    expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })).toEqual([])
    expect(await readFile(join(path, '.harness', '.gitignore'), 'utf8')).toBe(`${OLDER}/.gitignore\n`)
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

  // One Mac, 10-28: a stopped worker's worktree held a skill folder its agent had copied in read-only. git deleted a third of
  // the folder, stopped there, and deleted the worktree's record anyway, so git and gh failed in what was left.
  // Folder permissions do not stop root or Windows from deleting.
  const permissions = process.platform !== 'win32' && process.getuid?.() !== 0
  const withReadOnlyFolder = async (path: string) => {
    await withHarnessFolder(path, '/*\n')
    const folder = join(path, '.harness', 'tools', 'skills', 'copied')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'SKILL.md'), 'copied in read-only')
    await chmod(folder, 0o555)
    return folder
  }

  it.runIf(permissions)('keeps, untouched and still a worktree, one holding a folder git could not empty', async () => {
    const path = await add('read-only', 'harness/read-only')
    const folder = await withReadOnlyFolder(path)
    try {
      expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })).toEqual([])
      expect(await exists(join(path, 'file')), 'nothing in it was deleted').toBe(true)
      expect(await git(path, 'status', '--porcelain')).toBe('')
      expect(await git(path, 'rev-parse', '--git-dir')).toContain('/.git/worktrees/')
      await expect(sweepOne(path, later(), 0)).rejects.toEqual(new WorktreeKept('WORKTREE_UNWRITABLE'))
    } finally { await chmod(folder, 0o755) }
  })

  it.runIf(permissions)('puts the record back when git began removing the worktree and could not finish', async () => {
    const path = await add('half-removed', 'harness/half-removed')
    // A folder that turns read-only while the worktree is removed: the check above reads it as writable.
    await withHarnessFolder(path, '/*\n')
    const folder = join(path, '.harness', 'late')
    await mkdir(folder)
    await writeFile(join(folder, 'held'), 'held')
    await chmod(folder, 0o555)
    writable.folder = folder
    try {
      await expect(sweepOne(path, later(), 0)).rejects.toEqual(new WorktreeKept('WORKTREE_NOT_REMOVED'))
      expect(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'git still works in what is left').toBe('harness/half-removed')
      expect(await git(path, 'rev-parse', '--git-dir')).toContain('/.git/worktrees/')
      expect(await branches()).toContain('harness/half-removed')
    } finally { writable.folder = null; await chmod(folder, 0o755) }
  })

  it('ignores a missing worktrees folder and checkouts that are not worktrees', async () => {
    expect(await sweepWorktrees({ root: join(root, 'nothing'), inUse: [] })).toEqual([])
    await mkdir(join(home, 'app', 'plain'), { recursive: true })
    await git(repo, 'clone', '--quiet', repo, join(home, 'clone'))
    expect(await sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], now: later() })).toEqual([])
  })
})
