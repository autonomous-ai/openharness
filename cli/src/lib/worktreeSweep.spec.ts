import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sweepOne, WorktreeKept } from './worktreeSweep.js'

const exec = promisify(execFile)
/** Folders the sweep's own check reads as writable whatever their mode. */
const writable = vi.hoisted(() => ({ folders: new Set<string>() }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, access: (file: string, mode?: number) => writable.folders.has(file) ? Promise.resolve() : fs.access(file, mode) }
})
// Real Git, several worktrees a test: slower than the default 5s under a full, parallel run.
describe('removing one worktree Harness made, as the Swarm asks', { timeout: 30_000 }, () => {
  let root: string, repo: string, home: string
  const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd,
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args])).stdout.trim()
  const later = () => Date.now() + 8 * 24 * 3600_000
  const WEEK = 7 * 24 * 3600_000
  /** Whether [path] went, idle for a week as of [now]. */
  const removes = (path: string, now = later()) => sweepOne(path, now, WEEK)
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

  // The Swarm's removal ran git as the repository configures it: the program its config names (`core.fsmonitor`, which
  // lib/gitProject.ts turns off too) and its hooks (which lib/worktreeDeletion.ts turns off too); and with
  // `status.showUntrackedFiles=no` a worktree holding new work read as clean, and `git worktree remove` removed it, new work and
  // all (review of the allocator's package 6, 12 November).
  it.runIf(process.platform !== 'win32')('runs no fsmonitor program or hook the repository names, and keeps new files whatever status.showUntrackedFiles says', async () => {
    const clean = await add('clean', 'harness/clean')
    const fresh = await add('fresh', 'harness/fresh')
    await writeFile(join(fresh, 'new-work.md'), 'not added yet')
    const ran = join(root, 'ran'), program = join(root, 'program'), hook = join(repo, '.git', 'hooks', 'reference-transaction')
    for (const file of [program, hook]) {
      await writeFile(file, `#!/bin/sh\necho "$0" >> "${ran}"\nexit 1\n`)
      await chmod(file, 0o755)
    }
    await git(repo, 'config', 'core.fsmonitor', program)
    await git(repo, 'config', 'status.showUntrackedFiles', 'no')
    expect(await removes(fresh), 'a worktree holding new work').toBe(false)
    expect(await readFile(join(fresh, 'new-work.md'), 'utf8')).toBe('not added yet')
    expect(await removes(clean)).toBe(true)
    expect(await branches()).toEqual(['harness/fresh', 'main'])
    expect(await readFile(ran, 'utf8').catch(() => ''), 'a program or hook the repository names').toBe('')
  })

  // #4199: with `core.ignoreStat=true`, git marks each file a checkout writes "assume unchanged" and takes it as unchanged
  // from then on, so an edit to a tracked file read as clean and `git worktree remove` removed it, edit and all. A
  // `core.excludesFile` the repository names hid a new file from both the same way, as an ignored file that goes with it.
  it('keeps an edit git was told to assume unchanged and says why, and a new file the repository\'s excludesFile names', async () => {
    await git(repo, 'config', 'core.ignoreStat', 'true')
    const edited = await add('edited', 'harness/edited')
    await writeFile(join(edited, 'file'), 'edited, never committed')
    await expect(removes(edited)).rejects.toEqual(new WorktreeKept('WORKTREE_ASSUMED_UNCHANGED'))
    expect(await readFile(join(edited, 'file'), 'utf8')).toBe('edited, never committed')
    await git(repo, 'config', 'core.ignoreStat', 'false')
    const excludes = join(root, 'excludes')
    await writeFile(excludes, '*.md\n')
    await git(repo, 'config', 'core.excludesFile', excludes)
    const fresh = await add('fresh', 'harness/fresh')
    await writeFile(join(fresh, 'new-work.md'), 'not added yet')
    expect(await removes(fresh), 'a worktree holding a new file').toBe(false)
    expect(await readFile(join(fresh, 'new-work.md'), 'utf8')).toBe('not added yet')
    expect(await branches()).toEqual(['harness/edited', 'harness/fresh', 'main'])
  })

  // A file list past the 1 MiB a git answer is read into: the mark on its last file is still found, and the worktree kept.
  it('finds a file marked assume unchanged at the end of a large repository\'s list', async () => {
    const name = (n: number) => `${String(n).padStart(5, '0')}-${'x'.repeat(200)}`
    await Promise.all(Array.from({ length: 5_500 }, (_, n) => writeFile(join(repo, name(n)), '')))
    await git(repo, 'add', '.')
    await git(repo, 'commit', '--quiet', '-m', 'many files')
    const path = await add('large', 'harness/large')
    const list = (await exec('git', ['-C', path, 'ls-files', '-v'], { maxBuffer: 8 * 1024 * 1024 })).stdout
    expect(list.length, 'a list past 1 MiB').toBeGreaterThan(1024 * 1024)
    await git(path, 'update-index', '--assume-unchanged', name(5_499))
    await writeFile(join(path, name(5_499)), 'edited, never committed')
    await expect(removes(path)).rejects.toEqual(new WorktreeKept('WORKTREE_ASSUMED_UNCHANGED'))
    expect(await readFile(join(path, name(5_499)), 'utf8')).toBe('edited, never committed')
  })

  it.runIf(process.platform !== 'win32')('keeps a worktree whose file list git could not give', async () => {
    const path = await add('unlisted', 'harness/unlisted')
    const bin = join(root, 'bin'), real = (await exec('sh', ['-c', 'command -v git'])).stdout.trim()
    await mkdir(bin)
    await writeFile(join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = ls-files ] && exit 128; done\nexec "${real}" "$@"\n`)
    await chmod(join(bin, 'git'), 0o755)
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    try {
      await expect(removes(path)).rejects.toThrow('git ls-files exited 128')
    } finally { vi.unstubAllEnvs() }
    expect(await exists(path)).toBe(true)
  })

  it('removes a clean, idle, unused worktree and the harness branch that has nothing of its own', async () => {
    const path = await add('brave-otter', 'harness/brave-otter')
    expect(await removes(path)).toBe(true)
    expect(await exists(path)).toBe(false)
    expect(await branches()).toEqual(['main'])
  })

  it('keeps a worktree in use, a recently touched one, and uncommitted work', async () => {
    const used = await add('used', 'harness/used')
    const recent = await add('recent', 'harness/recent')
    const dirty = await add('dirty', 'harness/dirty')
    await writeFile(join(dirty, 'draft'), 'not committed')
    const old = new Date(Date.now() - 30 * 24 * 3600_000)
    for (const path of [used, dirty]) await utimes(path, old, old)
    expect(await sweepOne(used, later(), WEEK, () => false)).toBe(false)
    expect(await removes(dirty)).toBe(false)
    expect(await removes(recent, Date.now())).toBe(false)
    for (const path of [used, dirty, recent]) expect(await exists(path)).toBe(true)
  })

  it('removes a branch Harness marked in the config, whatever its name', async () => {
    const path = await add('quiet-owl', 'deehw/quiet-owl')
    await git(repo, 'config', 'branch.deehw/quiet-owl.harness', 'placeholder')
    expect(await removes(path)).toBe(true)
    expect(await branches()).toEqual(['main'])
  })

  it('keeps branches with commits of their own, and branches Harness did not name', async () => {
    const own = await add('own', 'harness/own')
    await writeFile(join(own, 'file'), 'two')
    await git(own, 'commit', '--quiet', '-am', 'work')
    await git(repo, 'branch', 'topic')
    const topic = join(home, 'app', 'topic')
    await git(repo, 'worktree', 'add', '--quiet', topic, 'topic')
    expect(await removes(own)).toBe(true)
    expect(await removes(topic)).toBe(true)
    expect(await branches()).toEqual(expect.arrayContaining(['harness/own', 'topic', 'main']))
  })

  it('keeps a detached worktree holding a commit no branch has', async () => {
    const detached = join(home, 'app', 'detached')
    await git(repo, 'worktree', 'add', '--quiet', '--detach', detached, 'main')
    await writeFile(join(detached, 'file'), 'lost?')
    await git(detached, 'commit', '--quiet', '-am', 'only here')
    expect(await removes(detached)).toBe(false)
    expect(await exists(detached)).toBe(true)
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
    expect(await removes(path)).toBe(true)
    expect(await exists(path)).toBe(false)
  })

  // Review of #2266: the upgraded rule names only Harness's own file; an ignore file someone added deeper is still work.
  it('upgrades the older ignore file to a rule that still shows an ignore file someone added deeper', async () => {
    const path = await add('nested-ignore', 'harness/nested-ignore')
    await withHarnessFolder(path, OLDER)
    await mkdir(join(path, '.harness', 'mine'))
    await writeFile(join(path, '.harness', 'mine', '.gitignore'), 'scratch/\n')
    expect(await removes(path)).toBe(false)
    expect(await readFile(join(path, '.harness', '.gitignore'), 'utf8')).toBe(`${OLDER}/.gitignore\n`)
  })

  it('keeps a worktree whose ignore file someone edited, and leaves that file as it was', async () => {
    const path = await add('edited-ignore', 'harness/edited-ignore')
    await withHarnessFolder(path, `${OLDER}mine/\n`)
    expect(await removes(path)).toBe(false)
    expect(await readFile(join(path, '.harness', '.gitignore'), 'utf8')).toBe(`${OLDER}mine/\n`)
  })

  it('never rewrites a committed ignore file, which would be a change of its own', async () => {
    await mkdir(join(repo, '.harness'))
    await writeFile(join(repo, '.harness', '.gitignore'), OLDER)
    await git(repo, 'add', '.')
    await git(repo, 'commit', '--quiet', '-m', 'ignore file committed by an earlier git add -A')
    const path = await add('committed-ignore', 'harness/committed-ignore')
    await writeFile(join(path, 'draft'), 'not committed')
    expect(await removes(path)).toBe(false)
    expect(await readFile(join(path, '.harness', '.gitignore'), 'utf8')).toBe(OLDER)
  })

  it('never writes through a Harness folder that points elsewhere', async () => {
    const path = await add('linked-ignore', 'harness/linked-ignore')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, '.gitignore'), OLDER)
    await symlink(outside, join(path, '.harness'))
    expect(await removes(path)).toBe(false)
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
      await expect(removes(path)).rejects.toEqual(new WorktreeKept('WORKTREE_UNWRITABLE'))
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
    writable.folders.add(folder)
    try {
      await expect(sweepOne(path, later(), 0)).rejects.toEqual(new WorktreeKept('WORKTREE_NOT_REMOVED'))
      expect(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'git still works in what is left').toBe('harness/half-removed')
      expect(await git(path, 'rev-parse', '--git-dir')).toContain('/.git/worktrees/')
      expect(await branches()).toContain('harness/half-removed')
    } finally { writable.folders.clear(); await chmod(folder, 0o755) }
  })

  // Security review 1 of #2417: git empties the folder in directory order, so its .git file often went before git reached
  // what it could not delete (8 of 30 trials), and the record alone written back left nothing pointing to it.
  it.runIf(permissions)('puts the .git file and the record back whichever folder git stops at', async () => {
    const held: string[] = []
    // Beside .git at the top, where the order of a folder's entries decides which goes first (on this Mac's APFS, stop-long
    // came before .git; on ext4 the order is the filesystem's own); ignored, so nothing reads as work.
    await writeFile(join(repo, '.git', 'info', 'exclude'), '/stop-*/\n')
    try {
      for (const name of ['stop-a', 'stop-g', 'stop-m', 'stop-s', 'stop-z', 'stop-0', 'stop-9', 'stop-_', 'stop-~', 'stop-long']) {
        const path = await add(`stops-${held.length}`, `harness/stops-${held.length}`)
        const folder = join(path, name)
        await mkdir(folder, { recursive: true })
        await writeFile(join(folder, 'held'), 'held')
        await chmod(folder, 0o555)
        held.push(folder); writable.folders.add(folder)
        await expect(sweepOne(path, later(), 0)).rejects.toEqual(new WorktreeKept('WORKTREE_NOT_REMOVED'))
        expect(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), `git still works when it stopped at ${name}`).toBe(`harness/stops-${held.length - 1}`)
      }
    } finally { writable.folders.clear(); for (const folder of held) await chmod(folder, 0o755) }
  })

  // The same review: a locked file passes a check of folder permissions, and git stops at it.
  it.runIf(process.platform === 'darwin' && process.getuid?.() !== 0)('keeps a worktree, still one, when git stops at a locked file', async () => {
    const path = await add('locked', 'harness/locked')
    await mkdir(join(path, 'src'))
    await writeFile(join(path, 'src', 'kept'), 'locked')
    await git(path, 'add', '.')
    await git(path, 'commit', '--quiet', '-m', 'locked file')
    await exec('chflags', ['uchg', join(path, 'src', 'kept')])
    try {
      await expect(sweepOne(path, later(), 0)).rejects.toEqual(new WorktreeKept('WORKTREE_NOT_REMOVED'))
      expect(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('harness/locked')
      expect(await branches()).toContain('harness/locked')
    } finally { await exec('chflags', ['nouchg', join(path, 'src', 'kept')]) }
  })

  // Security review 2 of #2417: the record also holds the refs only this worktree has.
  it.runIf(permissions)('writes back the refs only the worktree held with its record', async () => {
    const path = await add('own-refs', 'harness/own-refs')
    await git(path, 'update-ref', 'refs/worktree/mark', 'HEAD')
    await git(path, 'update-ref', 'refs/bisect/bad', 'HEAD')
    const before = await git(path, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/worktree', 'refs/bisect')
    await withHarnessFolder(path, '/*\n')
    const folder = join(path, '.harness', 'late')
    await mkdir(folder)
    await writeFile(join(folder, 'held'), 'held')
    await chmod(folder, 0o555)
    writable.folders.add(folder)
    try {
      await expect(sweepOne(path, later(), 0)).rejects.toEqual(new WorktreeKept('WORKTREE_NOT_REMOVED'))
      expect(await git(path, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/worktree', 'refs/bisect')).toBe(before)
    } finally { writable.folders.clear(); await chmod(folder, 0o755) }
  })

  it('leaves a worktree alone that came into use while it was being checked', async () => {
    const path = await add('opened', 'harness/opened')
    expect(await sweepOne(path, later(), 0, () => false)).toBe(false)
    expect(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('harness/opened')
    expect(await exists(join(path, 'file'))).toBe(true)
  })

  it('leaves a checkout that is not a linked worktree', async () => {
    const clone = join(home, 'clone')
    await git(repo, 'clone', '--quiet', repo, clone)
    expect(await removes(clone)).toBe(false)
    expect(await exists(clone)).toBe(true)
  })
})
