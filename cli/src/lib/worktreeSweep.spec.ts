import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildOutputIn, sweepOne, sweepWorktrees, WorktreeKept } from './worktreeSweep.js'

const exec = promisify(execFile)
/** Folders the sweep's own check reads as writable whatever their mode. */
const writable = vi.hoisted(() => ({ folders: new Set<string>() }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, access: (file: string, mode?: number) => writable.folders.has(file) ? Promise.resolve() : fs.access(file, mode) }
})
// Real Git, several worktrees a test: slower than the default 5s under a full, parallel run.
describe('sweeping unused worktrees', { timeout: 30_000 }, () => {
  let root: string, repo: string, home: string
  const gitWith = async (env: NodeJS.ProcessEnv, cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd,
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { env })).stdout.trim()
  const git = (cwd: string, ...args: string[]) => gitWith(process.env, cwd, ...args)
  const later = () => Date.now() + 8 * 24 * 3600_000
  /** A sweep a week from now, of worktrees no harness is in unless the test names one. */
  const sweep = (over: { inUse?: Array<string | null>; live?: string[]; now?: number } = {}) =>
    sweepWorktrees({ root: join(root, 'harnesses'), inUse: [], live: [], now: later(), ...over })
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
    expect(await sweep()).toEqual({ removed: [path], freed: [], stuck: [] })
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
    const { removed } = await sweep({ inUse: [join(used, 'src'), null] })
    expect(removed).toEqual([recent])
    expect((await sweep({ inUse: [used], now: Date.now() })).removed).toEqual([])
    expect(await exists(used)).toBe(true)
    expect(await exists(dirty)).toBe(true)
  })

  it('removes a branch Harness marked in the config, whatever its name', async () => {
    const path = await add('quiet-owl', 'deehw/quiet-owl')
    await git(repo, 'config', 'branch.deehw/quiet-owl.harness', 'placeholder')
    expect((await sweep()).removed).toEqual([path])
    expect(await branches()).toEqual(['main'])
  })

  it('keeps branches with commits of their own, and branches Harness did not name', async () => {
    const own = await add('own', 'harness/own')
    await writeFile(join(own, 'file'), 'two')
    await git(own, 'commit', '--quiet', '-am', 'work')
    await git(repo, 'branch', 'topic')
    const topic = join(home, 'app', 'topic')
    await git(repo, 'worktree', 'add', '--quiet', topic, 'topic')
    const { removed } = await sweep()
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
    expect((await sweep()).removed).toEqual([flat])
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
    expect((await sweep()).removed).toEqual([path])
    expect(await exists(path)).toBe(false)
  })

  // Review of #2266: the upgraded rule names only Harness's own file; an ignore file someone added deeper is still work.
  it('upgrades the older ignore file to a rule that still shows an ignore file someone added deeper', async () => {
    const path = await add('nested-ignore', 'harness/nested-ignore')
    await withHarnessFolder(path, OLDER)
    await mkdir(join(path, '.harness', 'mine'))
    await writeFile(join(path, '.harness', 'mine', '.gitignore'), 'scratch/\n')
    expect((await sweep()).removed).toEqual([])
    expect(await readFile(join(path, '.harness', '.gitignore'), 'utf8')).toBe(`${OLDER}/.gitignore\n`)
  })

  it('keeps a worktree whose ignore file someone edited, and leaves that file as it was', async () => {
    const path = await add('edited-ignore', 'harness/edited-ignore')
    await withHarnessFolder(path, `${OLDER}mine/\n`)
    expect((await sweep()).removed).toEqual([])
    expect(await readFile(join(path, '.harness', '.gitignore'), 'utf8')).toBe(`${OLDER}mine/\n`)
  })

  it('never rewrites a committed ignore file, which would be a change of its own', async () => {
    await mkdir(join(repo, '.harness'))
    await writeFile(join(repo, '.harness', '.gitignore'), OLDER)
    await git(repo, 'add', '.')
    await git(repo, 'commit', '--quiet', '-m', 'ignore file committed by an earlier git add -A')
    const path = await add('committed-ignore', 'harness/committed-ignore')
    await writeFile(join(path, 'draft'), 'not committed')
    expect((await sweep()).removed).toEqual([])
    expect(await readFile(join(path, '.harness', '.gitignore'), 'utf8')).toBe(OLDER)
  })

  it('never writes through a Harness folder that points elsewhere', async () => {
    const path = await add('linked-ignore', 'harness/linked-ignore')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, '.gitignore'), OLDER)
    await symlink(outside, join(path, '.harness'))
    expect((await sweep()).removed).toEqual([])
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
      expect((await sweep()).removed).toEqual([])
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

  // The allocator's package 6, 11-11. One Mac held 29 worktrees Harness made, 21.6 GB. A stopped harness kept 22 of them and
  // uncommitted work 10, so their checkouts stay; 4.7 GB of them was what an install or a build makes again.
  describe('freeing build output in the worktrees that stay', () => {
    const DAY = 24 * 3600_000
    const put = async (folder: string, ...files: string[]) => {
      for (const file of files) {
        await mkdir(dirname(join(folder, file)), { recursive: true })
        await writeFile(join(folder, file), file)
      }
    }
    const under = (tree: string, ...folders: string[]) => folders.map(folder => join(tree, folder))
    /** Git with the clock a reflog line is stamped from set to [at]. */
    const gitAt = (at: Date, cwd: string, ...args: string[]) => gitWith({ ...process.env, GIT_COMMITTER_DATE: at.toISOString() }, cwd, ...args)
    const gitDirOf = (tree: string) => git(tree, 'rev-parse', '--absolute-git-dir')
    beforeEach(async () => {
      await writeFile(join(repo, '.gitignore'), 'node_modules/\n.dart_tool/\nbuild/\n/web/.next/\ndist/\n.env\n.harness/\n*.log\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '--quiet', '-m', 'what this project ignores')
    })

    it('frees node_modules, .dart_tool, build and .next where a stopped harness is, and keeps the checkout and all else', async () => {
      const tree = await add('stopped', 'harness/stopped')
      await put(tree, 'node_modules/pkg/index.js', 'app/.dart_tool/package_config.json', 'app/build/app.bin', 'web/.next/cache/page',
        '.env', '.harness/evidence/run.txt', 'dist/bundle.js', 'notes.md')
      await writeFile(join(tree, 'file'), 'not committed')
      const swept = await sweep({ inUse: [tree] })
      for (const gone of under(tree, 'node_modules', 'app/.dart_tool', 'app/build', 'web/.next')) expect(await exists(gone), gone).toBe(false)
      expect(swept).toEqual({ removed: [], freed: under(tree, 'app/.dart_tool', 'app/build', 'node_modules', 'web/.next'), stuck: [] })
      for (const kept of under(tree, '.env', '.harness/evidence/run.txt', 'dist/bundle.js', 'notes.md')) expect(await exists(kept), kept).toBe(true)
      expect(await readFile(join(tree, 'file'), 'utf8')).toBe('not committed')
      expect(await git(tree, 'status', '--porcelain')).toBe('M file\n?? notes.md')
      expect(await branches()).toContain('harness/stopped')
    })

    it('frees it in a worktree nothing uses that stays for a commit only it has', async () => {
      const tree = join(home, 'app', 'detached')
      await git(repo, 'worktree', 'add', '--quiet', '--detach', tree, 'main')
      await writeFile(join(tree, 'file'), 'only here')
      await git(tree, 'commit', '--quiet', '-am', 'only here')
      await put(tree, 'node_modules/pkg/index.js')
      expect(await sweep()).toEqual({ removed: [], freed: under(tree, 'node_modules'), stuck: [] })
      expect(await git(tree, 'log', '-1', '--format=%s')).toBe('only here')
    })

    it('frees nothing where a harness is running, in the worktree or in a folder of it', async () => {
      const top = await add('running', 'harness/running')
      const inside = await add('inside', 'harness/inside')
      await put(top, 'node_modules/pkg/index.js')
      await put(inside, 'cli/node_modules/pkg/index.js')
      const cwds = [top, join(inside, 'cli')]
      expect(await sweep({ inUse: cwds, live: cwds })).toEqual({ removed: [], freed: [], stuck: [] })
      expect(await exists(join(top, 'node_modules', 'pkg', 'index.js'))).toBe(true)
      expect(await exists(join(inside, 'cli', 'node_modules', 'pkg', 'index.js'))).toBe(true)
    })

    it('frees it beside a worktree with a running harness whose name only begins the same', async () => {
      const stopped = await add('calm-river', 'harness/calm-river')
      const running = await add('calm-river-2', 'harness/calm-river-2')
      await put(stopped, 'node_modules/pkg/index.js')
      await put(running, 'node_modules/pkg/index.js')
      expect(await sweep({ inUse: [stopped, running], live: [running] })).toEqual({ removed: [], freed: under(stopped, 'node_modules'), stuck: [] })
      expect(await exists(join(running, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    })

    // A worktree of a bare repository is not one Harness made: the sweep never removes it, and frees nothing in it.
    it('leaves a checkout alone that is not a linked worktree of a repository with files', async () => {
      const bare = join(root, 'bare.git'), tree = join(home, 'app', 'of-bare')
      await git(root, 'clone', '--quiet', '--bare', repo, bare)
      await git(bare, 'worktree', 'add', '--quiet', '-b', 'harness/of-bare', tree, 'main')
      await put(tree, 'node_modules/pkg/index.js')
      expect(await sweep()).toEqual({ removed: [], freed: [], stuck: [] })
      expect(await exists(join(tree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    })

    it.each<[string, (tree: string, recent: Date) => Promise<unknown>]>([
      ['something was made at its top', (tree, recent) => utimes(tree, recent, recent)],
      ['its index was written', async (tree, recent) => utimes(join(await gitDirOf(tree), 'index'), recent, recent)],
      ['its HEAD was written', async (tree, recent) => utimes(join(await gitDirOf(tree), 'HEAD'), recent, recent)],
      // `git reset --soft` and a ref moved by hand write neither HEAD nor the index: only the reflog says HEAD moved.
      ['its HEAD moved', (tree, recent) => gitAt(recent, tree, 'commit', '--quiet', '--allow-empty', '-m', 'yesterday')],
    ])('frees nothing in a worktree used within the week: %s', async (_what, use) => {
      const tree = await add('used', 'harness/used')
      await put(tree, 'node_modules/pkg/index.js')
      await use(tree, new Date(later() - DAY))
      expect(await sweep({ inUse: [tree] })).toEqual({ removed: [], freed: [], stuck: [] })
      expect(await exists(join(tree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    })

    it('keeps a build folder written within the week, and frees the others beside it', async () => {
      const tree = await add('installed', 'harness/installed')
      await put(tree, 'node_modules/pkg/index.js', 'app/build/app.bin')
      const recent = new Date(later() - DAY)
      await utimes(join(tree, 'node_modules'), recent, recent)
      expect(await sweep({ inUse: [tree] })).toEqual({ removed: [], freed: under(tree, 'app/build'), stuck: [] })
      expect(await exists(join(tree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    })

    /** A worktree where every time the sweep reads is a month old, as when nobody has worked there since. */
    const monthOld = async (name: string, ...files: string[]) => {
      const tree = join(home, 'app', name), old = new Date(Date.now() - 30 * DAY)
      await gitAt(old, repo, 'worktree', 'add', '--quiet', '-b', `harness/${name}`, tree, 'main')
      await put(tree, ...files)
      const gitDir = await gitDirOf(tree)
      for (const file of [...under(tree, ...files.map(file => file.split('/')[0]!)), tree, join(gitDir, 'HEAD'), join(gitDir, 'index')]) await utimes(file, old, old)
      return tree
    }

    // One Mac, 11-10: `git gc`, which git runs by itself after fetches, wrote the reflog of 15 worktrees of one repository again
    // in one second, and of 85 of another's 88. Read as use, that restarted the idle week for every worktree, worked in or not.
    it('frees build output though git gc wrote the reflog again today', async () => {
      const tree = await monthOld('collected', 'node_modules/pkg/index.js')
      await git(repo, 'gc', '--quiet')
      expect(await sweep({ inUse: [tree], now: Date.now() })).toEqual({ removed: [], freed: under(tree, 'node_modules'), stuck: [] })
    })

    it('keeps a folder with a tracked file in it, one git does not ignore, a link, and one holding a checkout of its own', async () => {
      const tree = await add('guarded', 'harness/guarded')
      const outside = join(root, 'shared-modules')
      await put(outside, 'pkg/index.js')
      await put(tree, 'tracked/build/kept.txt', 'tracked/build/out.o', 'docs/.next/draft.md', 'cloned/build/dep/src.c', 'plain/node_modules/pkg/index.js')
      await git(tree, 'add', '-f', 'tracked/build/kept.txt')
      await git(tree, 'commit', '--quiet', '-m', 'a file kept in a build folder')
      await mkdir(join(tree, 'linked'))
      await symlink(outside, join(tree, 'linked', 'node_modules'))
      await git(join(tree, 'cloned', 'build', 'dep'), 'init', '--quiet')
      expect(await sweep({ inUse: [tree] })).toEqual({ removed: [], freed: under(tree, 'plain/node_modules'), stuck: [] })
      for (const kept of [...under(tree, 'tracked/build/kept.txt', 'tracked/build/out.o', 'docs/.next/draft.md', 'cloned/build/dep/src.c', 'linked/node_modules'), join(outside, 'pkg', 'index.js')]) {
        expect(await exists(kept), kept).toBe(true)
      }
    })

    // Git names a folder that only holds ignored files, and then what is in it: once the folder went, those are gone too.
    it('frees a build folder once when git lists what is in it as well, and goes on to the next', async () => {
      const tree = await add('listed-twice', 'harness/listed-twice')
      await put(tree, 'gen/.next/run.log', 'gen/.next/web/node_modules/pkg/index.js', 'node_modules/pkg/index.js')
      expect(await sweep({ inUse: [tree] })).toEqual({ removed: [], freed: under(tree, 'gen/.next', 'node_modules'), stuck: [] })
    })

    it.runIf(permissions)('leaves a build folder whole when a folder in it could not be emptied', async () => {
      const tree = await add('held', 'harness/held')
      await put(tree, 'node_modules/a/index.js', 'node_modules/z/held/file')
      const folder = join(tree, 'node_modules', 'z', 'held')
      await chmod(folder, 0o555)
      try {
        expect(await sweep({ inUse: [tree] })).toEqual({ removed: [], freed: [], stuck: [] })
        expect(await exists(join(tree, 'node_modules', 'a', 'index.js')), 'nothing in it was deleted').toBe(true)
      } finally { await chmod(folder, 0o755) }
    })

    it.runIf(permissions)('says which build folder it began to remove and could not finish, and frees the rest', async () => {
      const tree = await add('late', 'harness/late')
      await put(tree, 'node_modules/late/held', 'web/.next/cache/page')
      // A folder that turns read-only while it is removed: the check before reads it as writable.
      const folder = join(tree, 'node_modules', 'late')
      await chmod(folder, 0o555)
      writable.folders.add(folder)
      try {
        expect(await sweep({ inUse: [tree] })).toEqual({ removed: [], freed: under(tree, 'web/.next'), stuck: under(tree, 'node_modules') })
        expect(await exists(join(folder, 'held'))).toBe(true)
      } finally { writable.folders.clear(); await chmod(folder, 0o755) }
    })

    // Git writes its paths with a slash on every platform; the folder is the platform's own. No Windows computer runs this
    // suite, so its paths are checked here.
    it('finds build output in git\'s listing on Windows as on a Mac or Linux', () => {
      const listing = ['cli/node_modules/', 'desktop/.dart_tool/', 'desktop/build/', 'web/.next/', '.env', 'dist/', '.harness/', 'cli/node_modules', 'gen/build/out.o', 'my build/', ''].join('\0')
      expect(buildOutputIn('C:\\h\\worktrees\\app\\calm-river', listing, win32.join)).toEqual([
        'C:\\h\\worktrees\\app\\calm-river\\cli\\node_modules', 'C:\\h\\worktrees\\app\\calm-river\\desktop\\.dart_tool',
        'C:\\h\\worktrees\\app\\calm-river\\desktop\\build', 'C:\\h\\worktrees\\app\\calm-river\\web\\.next',
      ])
      expect(buildOutputIn('/h/worktrees/app/calm-river', listing, posix.join)).toEqual([
        '/h/worktrees/app/calm-river/cli/node_modules', '/h/worktrees/app/calm-river/desktop/.dart_tool',
        '/h/worktrees/app/calm-river/desktop/build', '/h/worktrees/app/calm-river/web/.next',
      ])
    })
  })

  it('ignores a missing worktrees folder and checkouts that are not worktrees', async () => {
    expect(await sweepWorktrees({ root: join(root, 'nothing'), inUse: [], live: [] })).toEqual({ removed: [], freed: [], stuck: [] })
    await mkdir(join(home, 'app', 'plain'), { recursive: true })
    await git(repo, 'clone', '--quiet', repo, join(home, 'clone'))
    expect((await sweep()).removed).toEqual([])
  })
})
