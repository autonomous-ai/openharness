// `harness dsh install` on real (local) git repositories: a harness that uses a viewer package
// installs the viewer too, and narrates the viewer's phases under its own id.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { DOCTOR_TIMEOUT_MS, installDsh, isTransientGitFailure, removeDsh, resolveInstallSource, runDshDoctor, type DshInstallProgress } from './install.js'
import { dshInstallDir, installedDsh, invalidateInstalledDsh, listInstalledDsh, readInstalledIndex, type InstalledDsh } from './installed.js'
import { HARNESS_MONOREPO, type DshRegistryEntry } from './registry.js'

function gitRepo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    // a script is committed executable, the way a real repo carries it; a clone keeps the bit
    writeFileSync(join(dir, name), body, { mode: name.endsWith('.sh') ? 0o755 : 0o644 })
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'fixture')
  return dir
}

describe('installDsh with a used viewer', () => {
  let root: string
  let savedDshDir: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-install-'))
    savedDshDir = env.DSH_DIR
    env.DSH_DIR = join(root, 'installed')
    invalidateInstalledDsh()
  })
  afterEach(() => {
    env.DSH_DIR = savedDshDir
    invalidateInstalledDsh()
    rmSync(root, { recursive: true, force: true })
  })

  it('installs the viewer package the harness uses, from the registry, and narrates it under the harness', async () => {
    const viewerRepo = gitRepo(join(root, 'src', 'viewer'), {
      'harness.json': JSON.stringify({ spec: 1, kind: 'viewer', id: 'acme/viewer', name: 'Viewer', toolchain: { doctor: './doctor.sh' }, viewer: { command: './viewer.sh', url: 'http://127.0.0.1:${port}/?file=${artifact}', artifactExtensions: ['.step'] } }),
      'doctor.sh': '#!/bin/sh\necho "ok   viewer"\n',
      'viewer.sh': '#!/bin/sh\nsleep 1000\n',
    })
    const harnessRepo = gitRepo(join(root, 'src', 'thing'), {
      'harness.json': JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude', agent: { instructions: 'AGENTS.md' }, viewer: { use: 'acme/viewer' } }),
      'AGENTS.md': '# Thing\n',
    })
    const registry = (id: string): DshRegistryEntry | undefined => (id === 'acme/viewer' ? { id, kind: 'viewer', name: 'Viewer', repo: viewerRepo, tier: 2 } : undefined)
    const frames: DshInstallProgress[] = []
    const result = await installDsh({ source: harnessRepo, registry, onProgress: (p) => frames.push(p) })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    // both are installed, each under its own id
    expect(listInstalledDsh().map((d) => d.id).sort()).toEqual(['acme/thing', 'acme/viewer'])
    expect(installedDsh('acme/viewer')?.manifest.kind).toBe('viewer')
    // every frame the dialog sees carries the harness's id; the viewer's phases ride in the detail
    expect(frames.every((f) => f.id === null || f.id === 'acme/thing'), JSON.stringify(frames)).toBe(true)
    const viewerFrames = frames.filter((f) => f.detail?.startsWith('viewer acme/viewer'))
    expect(viewerFrames.map((f) => f.phase)).toEqual(expect.arrayContaining(['clone', 'doctor', 'setup']))
    expect(viewerFrames.some((f) => f.detail?.includes('installed'))).toBe(true)
    // the harness's own done is the last word
    expect(frames.at(-1)).toMatchObject({ id: 'acme/thing', phase: 'done' })
  })

  it('a used viewer that is already installed is not installed again', async () => {
    const viewerRepo = gitRepo(join(root, 'src', 'viewer'), {
      'harness.json': JSON.stringify({ spec: 1, kind: 'viewer', id: 'acme/viewer', name: 'Viewer', viewer: { command: './viewer.sh', url: 'http://127.0.0.1:${port}/' } }),
      'viewer.sh': '#!/bin/sh\nsleep 1000\n',
    })
    const first = await installDsh({ source: viewerRepo })
    expect(first.ok).toBe(true)
    const harnessRepo = gitRepo(join(root, 'src', 'thing'), {
      'harness.json': JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude', viewer: { use: 'acme/viewer' } }),
    })
    let asked = 0
    const result = await installDsh({ source: harnessRepo, registry: () => { asked++; return undefined } })
    expect(result.ok).toBe(true)
    expect(asked).toBe(0)
  })

  it('can install a whole repository at the published commit after its branch advances', async () => {
    const repo = gitRepo(join(root, 'pinned'), { 'harness.json': JSON.stringify({ spec: 1, id: 'acme/pinned', name: 'Published', engine: 'claude' }) })
    const ref = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    writeFileSync(join(repo, 'harness.json'), JSON.stringify({ spec: 1, id: 'acme/pinned', name: 'Unpublished', engine: 'claude' }))
    execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qam', 'later version'])
    const result = await installDsh({ source: repo, ref, expectedId: 'acme/pinned' })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(installedDsh('acme/pinned')?.commit).toBe(ref)
    expect(installedDsh('acme/pinned')?.manifest.name).toBe('Published')
  })

  it('rejects a mismatched catalog identity before installing or running setup', async () => {
    const repo = gitRepo(join(root, 'wrong-id'), {
      'harness.json': JSON.stringify({ spec: 1, id: 'acme/surprise', name: 'Wrong', engine: 'claude', toolchain: { setup: './setup.sh' } }),
      'setup.sh': '#!/bin/sh\ntouch did-run\n',
    })
    expect(await installDsh({ source: repo, expectedId: 'acme/expected' })).toMatchObject({ ok: false, error: 'PACKAGE_ID_MISMATCH' })
    expect(listInstalledDsh()).toEqual([])
    expect(readdirSync(env.DSH_DIR).filter(name => name.startsWith('.tmp-'))).toEqual([])
  })

  it('a used viewer that is neither installed nor in the registry is said, and the harness still installs', async () => {
    const harnessRepo = gitRepo(join(root, 'src', 'thing'), {
      'harness.json': JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude', viewer: { use: 'acme/missing' } }),
    })
    const lines: string[] = []
    const result = await installDsh({ source: harnessRepo, registry: () => undefined, onLine: (l) => lines.push(l) })
    expect(result.ok).toBe(true)
    expect(lines.join('\n')).toContain('viewer acme/missing is not installed and not in the registry')
  })
})

describe('installDsh from one folder of a repo (the built-in shelf)', () => {
  let root: string
  let savedDshDir: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-install-path-'))
    savedDshDir = env.DSH_DIR
    env.DSH_DIR = join(root, 'installed')
    invalidateInstalledDsh()
  })
  afterEach(() => {
    env.DSH_DIR = savedDshDir
    invalidateInstalledDsh()
    rmSync(root, { recursive: true, force: true })
  })

  // A monorepo in miniature: an app beside the store, two packages that use each other.
  const monorepo = (): string => gitRepo(join(root, 'src', 'mono'), {
    'README.md': '# the monorepo\n',
    'cli/src/index.ts': 'export {}\n',
    'store/agents/thing/harness.json': JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude', agent: { instructions: 'AGENTS.md', skills: ['skills'] }, toolchain: { setup: './setup.sh' }, viewer: { use: 'acme/viewer' } }),
    'store/agents/thing/AGENTS.md': '# Thing\n',
    'store/agents/thing/skills/draw/SKILL.md': '---\nname: draw\n---\n',
    'store/agents/thing/setup.sh': '#!/bin/sh\ntouch set-up\n',
    'store/viewers/viewer/harness.json': JSON.stringify({ spec: 1, kind: 'viewer', id: 'acme/viewer', name: 'Viewer', viewer: { command: './viewer.sh', url: 'http://127.0.0.1:${port}/' } }),
    'store/viewers/viewer/viewer.sh': '#!/bin/sh\nsleep 1000\n',
  })

  it('installs only that folder, laid out like a whole-repo install, and records where it came from', async () => {
    const repo = monorepo()
    const registry = (id: string): DshRegistryEntry | undefined => (id === 'acme/viewer'
      ? { id, kind: 'viewer', name: 'Viewer', repo, ref: 'main', path: 'store/viewers/viewer' }
      : undefined)
    const frames: DshInstallProgress[] = []
    const result = await installDsh({ source: repo, ref: 'main', path: 'store/agents/thing', registry, onProgress: (p) => frames.push(p) })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    // the manifest sits at the install's root; nothing else of the monorepo came along, not even .git
    const dir = result.installed.realDir
    expect(readdirSync(dir).sort()).toEqual(['AGENTS.md', 'harness.json', 'set-up', 'setup.sh', 'skills'])
    expect(existsSync(join(dir, 'skills', 'draw', 'SKILL.md'))).toBe(true)
    // setup ran in the folder, and the script kept its executable bit through the sparse clone
    expect(existsSync(join(dir, 'set-up'))).toBe(true)
    // the viewer it uses came from ITS folder of the same repo
    expect(installedDsh('acme/viewer')?.manifest.kind).toBe('viewer')
    expect(readdirSync(installedDsh('acme/viewer')!.realDir).sort()).toEqual(['harness.json', 'viewer.sh'])
    const row = readInstalledIndex().find((r) => r.id === 'acme/thing')
    expect(row).toMatchObject({ source: repo, ref: 'main', path: 'store/agents/thing', linked: false })
    expect(row?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(frames[0]?.detail).toContain('store/agents/thing')
    // no temporary clone is left in the install root
    expect(readdirSync(env.DSH_DIR).filter((name) => name.startsWith('.tmp-'))).toEqual([])
  })

  it('a folder the repo does not have fails cleanly and leaves nothing behind', async () => {
    const repo = monorepo()
    const result = await installDsh({ source: repo, path: 'store/agents/nope' })
    expect(result).toMatchObject({ ok: false, error: 'CLONE_FAILED' })
    if (!result.ok) expect(result.detail).toContain('has no folder store/agents/nope')
    expect(listInstalledDsh()).toEqual([])
    expect(readdirSync(env.DSH_DIR).filter((name) => name.startsWith('.tmp-'))).toEqual([])
  })

  it('refuses a path that climbs out of the repo before cloning anything', async () => {
    for (const path of ['../elsewhere', '/abs', 'store/../..', 'store/agents/thing/']) {
      const result = await installDsh({ source: join(root, 'never-cloned'), path })
      expect(result, path).toMatchObject({ ok: false, error: 'INVALID_SOURCE' })
    }
  })
})

describe('installDsh, every way it can go', () => {
  let root: string
  let savedDshDir: string
  let savedPath: string | undefined
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-install-each-'))
    savedDshDir = env.DSH_DIR
    savedPath = process.env.PATH
    env.DSH_DIR = join(root, 'installed')
    invalidateInstalledDsh()
  })
  afterEach(() => {
    vi.useRealTimers()
    process.env.PATH = savedPath
    env.DSH_DIR = savedDshDir
    invalidateInstalledDsh()
    rmSync(root, { recursive: true, force: true })
  })

  const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  /** Put a `git` first on PATH that runs `script` (sh), which may hand anything on to the real git. */
  const stubGit = (script: string): void => {
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nREAL_GIT='${REAL_GIT}'\n${script}\n`, { mode: 0o755 })
    process.env.PATH = `${bin}:${savedPath}`
  }
  const leftovers = (): string[] => (existsSync(env.DSH_DIR) ? readdirSync(env.DSH_DIR).filter((name) => name.startsWith('.tmp-')) : [])
  const thing = (extra: Record<string, unknown> = {}, files: Record<string, string> = {}): string => gitRepo(join(root, 'src', 'thing'), {
    'harness.json': JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude', ...extra }),
    ...files,
  })

  describe('resolveInstallSource', () => {
    it('a registry id is its repo, ref and folder; a URL or path is itself; an empty or control-character source is nothing', () => {
      const entries: Record<string, DshRegistryEntry> = {
        'acme/whole': { id: 'acme/whole', name: 'Whole', repo: 'https://example.com/whole.git', ref: 'v1', engine: 'claude' },
        'acme/folder': { id: 'acme/folder', name: 'Folder', repo: HARNESS_MONOREPO, ref: 'main', path: 'store/agents/folder', engine: 'claude' },
      }
      const registry = (id: string): DshRegistryEntry | undefined => entries[id]
      expect(resolveInstallSource('acme/whole', registry)).toEqual({ source: 'https://example.com/whole.git', ref: 'v1', id: 'acme/whole' })
      expect(resolveInstallSource('acme/folder', registry)).toEqual({ source: HARNESS_MONOREPO, ref: 'main', path: 'store/agents/folder', id: 'acme/folder' })
      expect(resolveInstallSource('/Users/example/code/thing', registry)).toEqual({ source: '/Users/example/code/thing' })
      expect(resolveInstallSource('', registry)).toBeNull()
      expect(resolveInstallSource('https://example.com/x', registry)).toBeNull()
    })
  })

  describe('--link', () => {
    it('links a checkout in place, records it as linked with its commit, and a second link replaces the first', async () => {
      const repo = thing()
      const frames: DshInstallProgress[] = []
      const result = await installDsh({ source: repo, link: true, onProgress: (p) => frames.push(p) })
      expect(result.ok, JSON.stringify(result)).toBe(true)
      expect(frames[0]).toEqual({ id: null, phase: 'clone', detail: `linking ${repo}` })
      const dir = dshInstallDir('acme/thing')
      expect(lstatSync(dir).isSymbolicLink()).toBe(true)
      const row = readInstalledIndex()[0]
      expect(row).toMatchObject({ id: 'acme/thing', dir, source: repo, ref: null, linked: true })
      expect(row).not.toHaveProperty('path')
      expect(row.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(result.ok && result.installed.realDir).toBe(realpathSync(repo))
      const again = await installDsh({ source: repo, link: true, path: 'ignored/for/a/link' })
      expect(again.ok).toBe(true)
      expect(readInstalledIndex()).toHaveLength(1)
    })

    it('a folder that is not a git checkout links with no commit', async () => {
      const plain = join(root, 'plain')
      mkdirSync(plain)
      writeFileSync(join(plain, 'harness.json'), JSON.stringify({ spec: 1, id: 'acme/plain', name: 'Plain', engine: 'codex' }))
      const result = await installDsh({ source: plain, link: true })
      expect(result.ok).toBe(true)
      expect(readInstalledIndex()[0]?.commit).toBeNull()
    })

    it('a git that answers rev-parse with nothing is no commit, not an empty one', async () => {
      const repo = thing()
      stubGit('if [ "$3" = "rev-parse" ]; then exit 0; fi\nexec "$REAL_GIT" "$@"')
      expect((await installDsh({ source: repo, link: true })).ok).toBe(true)
      expect(readInstalledIndex()[0]?.commit).toBeNull()
    })

    it('refuses a relative path, a path that does not exist, and a folder with no manifest, before touching anything', async () => {
      const frames: DshInstallProgress[] = []
      expect(await installDsh({ source: 'relative/thing', link: true, onProgress: (p) => frames.push(p) }))
        .toEqual({ ok: false, error: 'INVALID_SOURCE', detail: '--link needs an absolute path to a checkout' })
      expect(frames.at(-1)).toEqual({ id: null, phase: 'failed', detail: '--link needs an absolute path to a checkout', error: 'INVALID_SOURCE' })
      expect(await installDsh({ source: join(root, 'nope'), link: true })).toEqual({ ok: false, error: 'SOURCE_NOT_FOUND', detail: `${join(root, 'nope')} does not exist` })
      mkdirSync(join(root, 'empty'))
      expect(await installDsh({ source: join(root, 'empty'), link: true })).toMatchObject({ ok: false, error: 'INVALID_MANIFEST' })
      expect(existsSync(env.DSH_DIR)).toBe(false)
    })

    it('refuses to link the installed copy onto itself, which would delete it first', async () => {
      // Found by this spec: placing the link clears the install directory, so linking a clone that is
      // already installed (or a folder inside it) deleted the only copy and left a link to nothing.
      const repo = thing({}, { 'AGENTS.md': '# mine\n' })
      expect((await installDsh({ source: repo })).ok).toBe(true)
      const installed = dshInstallDir('acme/thing')
      writeFileSync(join(installed, 'notes.md'), 'work in progress\n')
      expect(await installDsh({ source: installed, link: true })).toMatchObject({ ok: false, error: 'INVALID_SOURCE' })
      mkdirSync(join(installed, 'nested'))
      writeFileSync(join(installed, 'nested', 'harness.json'), readFileSync(join(installed, 'harness.json')))
      expect(await installDsh({ source: join(installed, 'nested'), link: true })).toMatchObject({ ok: false, error: 'INVALID_SOURCE' })
      expect(lstatSync(installed).isDirectory()).toBe(true)
      expect(readFileSync(join(installed, 'notes.md'), 'utf8')).toBe('work in progress\n')
      expect(readInstalledIndex()[0]).toMatchObject({ id: 'acme/thing', linked: false })
    })

    it('linking a checkout elsewhere replaces an installed clone of the same id', async () => {
      const repo = thing()
      expect((await installDsh({ source: repo })).ok).toBe(true)
      expect(lstatSync(dshInstallDir('acme/thing')).isDirectory()).toBe(true)
      expect((await installDsh({ source: repo, link: true })).ok).toBe(true)
      expect(lstatSync(dshInstallDir('acme/thing')).isSymbolicLink()).toBe(true)
      expect(readInstalledIndex()[0]).toMatchObject({ id: 'acme/thing', linked: true })
    })
  })

  describe('cloning', () => {
    it('clones a whole repo at a ref, replacing an earlier install of the same id', async () => {
      const repo = thing()
      execFileSync('git', ['-C', repo, 'branch', 'v2'])
      expect((await installDsh({ source: repo })).ok).toBe(true)
      writeFileSync(join(dshInstallDir('acme/thing'), 'stale.txt'), 'from the first install')
      const result = await installDsh({ source: repo, ref: 'v2' })
      expect(result.ok, JSON.stringify(result)).toBe(true)
      expect(existsSync(join(dshInstallDir('acme/thing'), 'stale.txt'))).toBe(false)
      expect(readInstalledIndex()[0]).toMatchObject({ ref: 'v2', linked: false })
      expect(leftovers()).toEqual([])
    })

    it('a repo that cannot be cloned, or has no manifest, fails with what git or the manifest said', async () => {
      const missing = await installDsh({ source: join(root, 'no-such-repo') })
      expect(missing).toMatchObject({ ok: false, error: 'CLONE_FAILED' })
      expect(!missing.ok && missing.detail).toMatch(/^git clone exited 128: .*no-such-repo/)
      const bare = gitRepo(join(root, 'src', 'bare'), { 'README.md': '# no manifest\n' })
      const noManifest = await installDsh({ source: bare })
      expect(noManifest).toMatchObject({ ok: false, error: 'INVALID_MANIFEST' })
      expect(!noManifest.ok && noManifest.detail).toMatch(/^no harness\.json in /)
      const sparse = await installDsh({ source: join(root, 'no-such-repo'), ref: 'main', path: 'store/agents/x' })
      expect(sparse).toMatchObject({ ok: false, error: 'CLONE_FAILED' })
      expect(leftovers()).toEqual([])
    })

    it('a folder the repo lacks at a ref is said with the ref; a path that is a file fails at the sparse checkout', async () => {
      const repo = gitRepo(join(root, 'src', 'mono'), { 'store/agents/file': 'not a folder\n' })
      expect(await installDsh({ source: repo, ref: 'main', path: 'store/agents/nope' }))
        .toEqual({ ok: false, error: 'CLONE_FAILED', detail: `${repo} at main has no folder store/agents/nope` })
      const file = await installDsh({ source: repo, path: 'store/agents/file' })
      expect(file).toMatchObject({ ok: false, error: 'CLONE_FAILED' })
      expect(!file.ok && file.detail).toMatch(/^git sparse-checkout exited 128: .*not a directory/)
      expect(leftovers()).toEqual([])
    })

    it('streams git\'s lines as they land, and reports the last three that are not progress', async () => {
      stubGit([
        `printf 'Cloning into x...\\n\\n' >&2`,
        `i=0; while [ $i -lt 25 ]; do printf 'remote: Counting objects: %s\\r' $i >&2; i=$((i+1)); done`,
        `printf '\\nReceiving objects: 100%%\\r\\n' >&2`,
        `printf 'fatal: first\\nfatal: second\\nfatal: third\\nfatal: no newline' >&2`,
        'exit 128',
      ].join('\n'))
      const lines: string[] = []
      const result = await installDsh({ source: 'https://example.com/thing.git', onLine: (line) => lines.push(line) })
      expect(result).toEqual({ ok: false, error: 'CLONE_FAILED', detail: 'git clone exited 128: fatal: second · fatal: third · fatal: no newline' })
      expect(lines[0]).toBe('Cloning into x...')
      expect(lines.filter((line) => line.startsWith('remote: Counting objects'))).toHaveLength(25)
      expect(lines.slice(-4)).toEqual(['fatal: first', 'fatal: second', 'fatal: third', 'fatal: no newline'])
      expect(lines).not.toContain('')
    })

    it('when git said nothing but progress, the last progress line is the detail', async () => {
      stubGit(`printf 'Receiving objects: 10%%\\rReceiving objects: 20%%\\r' >&2\nexit 1`)
      expect(await installDsh({ source: 'https://example.com/thing.git' })).toEqual({ ok: false, error: 'CLONE_FAILED', detail: 'git clone exited 1: Receiving objects: 20%' })
    })

    it('no git at all is a failed clone that says so', async () => {
      const empty = join(root, 'empty-bin')
      mkdirSync(empty)
      process.env.PATH = empty
      const result = await installDsh({ source: 'https://example.com/thing.git' })
      expect(result).toMatchObject({ ok: false, error: 'CLONE_FAILED' })
      expect(!result.ok && result.detail).toContain('ENOENT')
    })

    it('a clone still running after ten minutes is stopped, and said to have been', async () => {
      stubGit('echo "Cloning into x..." >&2\nexec sleep 30')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let said!: () => void
      const saidSomething = new Promise<void>((resolve) => { said = resolve })
      const pending = installDsh({ source: 'https://example.com/thing.git', onLine: () => said() })
      await saidSomething
      vi.advanceTimersByTime(10 * 60_000)
      vi.useRealTimers()
      expect(await pending).toEqual({ ok: false, error: 'CLONE_FAILED', detail: 'git clone was still running after 10 min: Cloning into x...' })
    })

    it('a fetch that failed the way a bad connection fails is tried again, from nothing, and the retry is narrated', async () => {
      const repo = thing()
      const marker = join(root, 'attempts')
      // The first clone stalls out the way curl reports it; every later call is the real git.
      stubGit(`if [ "$1" = clone ] && [ ! -e '${marker}' ]; then touch '${marker}'; printf 'Cloning into x...\\nerror: RPC failed; curl 28 Operation too slow. Less than 1024 bytes/sec transferred the last 60 seconds\\nfatal: early EOF\\n' >&2; exit 128; fi\nexec "$REAL_GIT" "$@"`)
      const lines: string[] = []
      const frames: DshInstallProgress[] = []
      const result = await installDsh({ source: repo, cloneRetryDelaysMs: [0, 0], onLine: (line) => lines.push(line), onProgress: (p) => frames.push(p) })
      expect(result.ok, JSON.stringify(result)).toBe(true)
      expect(lines.find((line) => line.startsWith('fetch failed'))).toBe('fetch failed · git clone exited 128: Cloning into x... · error: RPC failed; curl 28 Operation too slow. Less than 1024 bytes/sec transferred the last 60 seconds · fatal: early EOF · retrying (2/3)')
      expect(frames.map((f) => f.phase)).toEqual(['clone', 'doctor', 'done'])
      expect(leftovers()).toEqual([])
    })

    it('a connection that never recovers is given up after three attempts, and said to have been', async () => {
      stubGit(`printf 'fatal: unable to access https://example.com/thing.git/: Could not resolve host: example.com\\n' >&2\nexit 128`)
      const lines: string[] = []
      const frames: DshInstallProgress[] = []
      const result = await installDsh({ source: 'https://example.com/thing.git', cloneRetryDelaysMs: [0, 0], onLine: (line) => lines.push(line), onProgress: (p) => frames.push(p) })
      expect(result).toEqual({ ok: false, error: 'CLONE_FAILED', detail: 'git clone exited 128: fatal: unable to access https://example.com/thing.git/: Could not resolve host: example.com · gave up after 3 attempts' })
      expect(lines.filter((line) => line.startsWith('fetch failed')).map((line) => line.slice(-'retrying (2/3)'.length))).toEqual(['retrying (2/3)', 'retrying (3/3)'])
      expect(frames.at(-1)).toMatchObject({ phase: 'failed', error: 'CLONE_FAILED', detail: expect.stringContaining('gave up after 3 attempts') })
      expect(leftovers()).toEqual([])
    })

    it('a repository that is not there is not tried again', async () => {
      const marker = join(root, 'attempts')
      stubGit(`echo x >> '${marker}'\nprintf 'remote: Repository not found.\\nfatal: repository https://example.com/thing.git/ not found\\n' >&2\nexit 128`)
      const lines: string[] = []
      const result = await installDsh({ source: 'https://example.com/thing.git', cloneRetryDelaysMs: [0, 0], onLine: (line) => lines.push(line) })
      expect(result).toEqual({ ok: false, error: 'CLONE_FAILED', detail: 'git clone exited 128: fatal: repository https://example.com/thing.git/ not found' })
      expect(readFileSync(marker, 'utf8')).toBe('x\n')
      expect(lines.some((line) => line.startsWith('fetch failed'))).toBe(false)
    })

    it('git is run with a stall limit and no credential prompt, on top of the daemon\'s environment', async () => {
      stubGit(`printf 'env %s %s %s %s\\n' "$GIT_HTTP_LOW_SPEED_LIMIT" "$GIT_HTTP_LOW_SPEED_TIME" "$GIT_TERMINAL_PROMPT" "$DSH_SPEC_MARK" >&2\nexit 1`)
      process.env.DSH_SPEC_MARK = 'still-here'
      try {
        const lines: string[] = []
        await installDsh({ source: 'https://example.com/thing.git', onLine: (line) => lines.push(line) })
        expect(lines).toContain('env 1024 60 0 still-here')
      } finally {
        delete process.env.DSH_SPEC_MARK
      }
    })

    it('isTransientGitFailure: the network is, the repository and our own stop are not', () => {
      for (const said of [
        'git clone exited 128: error: RPC failed; curl 28 Operation too slow',
        'git clone exited 128: fatal: early EOF',
        'git fetch exited 128: fatal: the remote end hung up unexpectedly',
        'git clone exited 128: fatal: unable to access https://x/: Could not resolve host: x',
        'git clone exited 128: fatal: unable to access https://x/: Failed to connect to x port 443: Connection refused',
        'git clone exited 128: error: The requested URL returned error: 502',
        'git clone exited 128: fatal: unable to access https://x/: GnuTLS recv error (-110)',
        'git clone exited 128: fatal: unable to access https://x/: OpenSSL SSL_read: Connection reset by peer, errno 104',
      ]) expect(isTransientGitFailure(said), said).toBe(true)
      for (const said of [
        'git clone was still running after 10 min: Receiving objects: 40%',
        'git clone exited 128: fatal: repository https://x/ not found',
        'git clone exited 128: error: RPC failed; curl 22 The requested URL returned error: 404',
        'git clone exited 128: error: RPC failed; HTTP 401 curl 22 The requested URL returned error: 401',
        'git clone exited 128: fatal: Authentication failed for https://x/',
        'git clone exited 128: git@x: Permission denied (publickey). · fatal: Could not read from remote repository.',
        'git clone exited 128: fatal: could not read Username for https://x: terminal prompts disabled',
        'git clone exited 128: fatal: Remote branch nope not found in upstream origin',
        'https://x at main has no folder store/agents/nope',
        'git clone exited 2',
      ]) expect(isTransientGitFailure(said), said).toBe(false)
    })

    it('a git that fails without a word is reported by how it ended alone, a code or a signal', async () => {
      stubGit('exit 2')
      expect(await installDsh({ source: 'https://example.com/thing.git' })).toEqual({ ok: false, error: 'CLONE_FAILED', detail: 'git clone exited 2' })
      stubGit('kill -KILL $$')
      expect(await installDsh({ source: 'https://example.com/thing.git' })).toEqual({ ok: false, error: 'CLONE_FAILED', detail: 'git clone exited SIGKILL' })
    })
  })

  describe('setup, the used viewer, and the doctor', () => {
    it('a bare script name is the harness\'s own script, as `harness dsh check` reads it, not a PATH lookup', async () => {
      // Found by this spec: `"setup": "setup.sh"` (the shape spec/README.md shows for a viewer package)
      // passed the check, which looks for the file, and then failed install with "command not found".
      const repo = thing({ toolchain: { setup: 'setup.sh', doctor: 'doctor.sh' } }, {
        'setup.sh': '#!/bin/sh\ntouch set-up\n',
        'doctor.sh': '#!/bin/sh\necho "ok   bare doctor ran"\n',
      })
      const result = await installDsh({ source: repo })
      expect(result.ok, JSON.stringify(result)).toBe(true)
      expect(result.ok && result.doctor.lines).toContain('ok   bare doctor ran')
      expect(existsSync(join(dshInstallDir('acme/thing'), 'set-up'))).toBe(true)
    })

    it('a setup that fails says how, with its last five lines', async () => {
      const repo = thing({ toolchain: { setup: 'setup.sh' } }, { 'setup.sh': '#!/bin/sh\nfor l in l1 l2 l3 l4 l5 l6; do echo $l; done\nexit 2\n' })
      const frames: DshInstallProgress[] = []
      const result = await installDsh({ source: repo, onProgress: (p) => frames.push(p) })
      expect(result).toMatchObject({ ok: false, error: 'SETUP_FAILED' })
      expect(!result.ok && result.detail).toMatch(/^setup exited 2 · (.* · )?l2 · l3 · l4 · l5 · l6$/)
      expect(frames.map((f) => f.phase)).toEqual(['clone', 'setup', 'failed'])
      expect(readInstalledIndex()).toEqual([])
    })

    it('a setup killed by a signal, or past its timeout, says that instead', async () => {
      const killed = await installDsh({ source: thing({ toolchain: { setup: 'kill -KILL $$' } }) })
      expect(!killed.ok && killed.detail).toMatch(/^setup exited SIGKILL · /)
      rmSync(join(root, 'src'), { recursive: true, force: true })
      const slow = await installDsh({ source: thing({ toolchain: { setup: 'sleep 30' } }), setupTimeoutMs: 300 })
      expect(slow).toEqual({ ok: false, error: 'SETUP_FAILED', detail: 'setup timed out' })
    })

    it('a used viewer that fails to install fails the harness, said once and under the harness', async () => {
      const repo = thing({ viewer: { use: 'acme/viewer' } })
      const registry = (id: string): DshRegistryEntry | undefined => (id === 'acme/viewer' ? { id, kind: 'viewer', name: 'Viewer', repo: join(root, 'no-viewer-repo') } : undefined)
      const frames: DshInstallProgress[] = []
      const lines: string[] = []
      const result = await installDsh({ source: repo, registry, onProgress: (p) => frames.push(p), onLine: (line) => lines.push(line) })
      expect(result).toMatchObject({ ok: false, error: 'CLONE_FAILED' })
      expect(!result.ok && result.detail).toMatch(/^viewer acme\/viewer · git clone exited 128: /)
      expect(frames.filter((f) => f.phase === 'failed')).toEqual([{ id: 'acme/thing', phase: 'failed', detail: !result.ok && result.detail, error: 'CLONE_FAILED' }])
      expect(frames.every((f) => f.id === null || f.id === 'acme/thing')).toBe(true)
      expect(lines).toContain('viewer acme/viewer · installing')
      expect(readInstalledIndex()).toEqual([])
    })

    it('a used viewer the bundled registry does not know is said, and the harness still installs', async () => {
      const lines: string[] = []
      const result = await installDsh({ source: thing({ viewer: { use: 'acme/nowhere-to-be-found' } }), onLine: (line) => lines.push(line) })
      expect(result.ok).toBe(true)
      expect(lines).toContain('miss viewer acme/nowhere-to-be-found is not installed and not in the registry · install it first')
    })

    it('a doctor that fails still records the install, and names what is missing', async () => {
      const repo = thing({ toolchain: { doctor: 'doctor.sh' } }, { 'doctor.sh': '#!/bin/sh\necho "ok   git"\necho "miss typst on PATH"\necho "miss fonts"\nexit 1\n' })
      const frames: DshInstallProgress[] = []
      const result = await installDsh({ source: repo, onProgress: (p) => frames.push(p) })
      expect(result).toEqual({ ok: false, error: 'DOCTOR_FAILED', detail: 'doctor failed · miss typst on PATH · miss fonts' })
      expect(frames.at(-1)).toEqual({ id: 'acme/thing', phase: 'failed', detail: 'doctor failed · miss typst on PATH · miss fonts', error: 'DOCTOR_FAILED' })
      expect(readInstalledIndex().map((row) => row.id)).toEqual(['acme/thing'])
    })

    it('a doctor that fails without a miss line is reported by its last three lines', async () => {
      const repo = thing({ toolchain: { doctor: 'doctor.sh' } }, { 'doctor.sh': '#!/bin/sh\nfor l in a b c d; do echo "$l"; done\nexit 3\n' })
      const result = await installDsh({ source: repo })
      expect(!result.ok && result.detail).toMatch(/^doctor failed · .*b · c · d$/)
    })

    it('runDshDoctor: no doctor is ready; one still running after five minutes is stopped and said to be', async () => {
      const base = { id: 'acme/thing', dir: root, realDir: root, source: root, ref: null, commit: null, linked: true, installedAt: 0 }
      const none: InstalledDsh = { ...base, manifest: { spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude' } }
      expect(await runDshDoctor(none)).toEqual({ ok: true, lines: [] })
      const slow: InstalledDsh = { ...base, manifest: { ...none.manifest, toolchain: { doctor: 'echo "ok   started"; sleep 30' } } }
      const said = 'miss doctor still running after 5 min — stopped; run `harness dsh doctor acme/thing` again'
      const seen: string[] = []
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const pending = runDshDoctor(slow, (line) => seen.push(line))
      vi.advanceTimersByTime(DOCTOR_TIMEOUT_MS)
      vi.useRealTimers()
      const result = await pending
      expect(result.ok).toBe(false)
      expect(result.lines.at(-1)).toBe(said)
      expect(seen.at(-1)).toBe(said)
      // and with no one listening for lines
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const quiet = runDshDoctor(slow)
      vi.advanceTimersByTime(DOCTOR_TIMEOUT_MS)
      vi.useRealTimers()
      expect((await quiet).lines.at(-1)).toBe(said)
    })
  })

  describe('removeDsh', () => {
    it('removes a clone and its row; a link, never the checkout it points at; a row whose folder is already gone', async () => {
      expect(removeDsh('acme/thing')).toEqual({ ok: false, error: 'NOT_INSTALLED', detail: 'acme/thing is not installed' })
      const repo = thing()
      await installDsh({ source: repo })
      expect(removeDsh('acme/thing')).toEqual({ ok: true })
      expect(existsSync(dshInstallDir('acme/thing'))).toBe(false)
      expect(readInstalledIndex()).toEqual([])

      await installDsh({ source: repo, link: true })
      expect(removeDsh('acme/thing')).toEqual({ ok: true })
      expect(existsSync(dshInstallDir('acme/thing'))).toBe(false)
      expect(existsSync(join(repo, 'harness.json'))).toBe(true)

      await installDsh({ source: repo })
      rmSync(dshInstallDir('acme/thing'), { recursive: true })
      expect(removeDsh('acme/thing')).toEqual({ ok: true })
      expect(readInstalledIndex()).toEqual([])
    })

    it('a folder that cannot be removed is a failure that keeps the row', async () => {
      await installDsh({ source: thing() })
      const owner = join(env.DSH_DIR, 'acme')
      chmodSync(owner, 0o500)
      try {
        const result = removeDsh('acme/thing')
        expect(result).toMatchObject({ ok: false, error: 'REMOVE_FAILED' })
        expect(!result.ok && result.detail).toContain('EACCES')
        expect(readInstalledIndex().map((row) => row.id)).toEqual(['acme/thing'])
      } finally {
        chmodSync(owner, 0o700)
      }
    })
  })
})
