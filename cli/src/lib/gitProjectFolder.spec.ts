import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneFailure, cloneRepository, prepareGitFolder, RepositoryAccessError, RepositoryHostKeyError } from './gitProjectFolder.js'
import { repositoryIdentity } from './githubRepository.js'
import { parseProjectFolder, ProjectFolderError, type GitProjectFolder } from './projectFolder.js'
import { writeExecutable } from '../testing/executableFixture.js'

/** A checkout at [folder] whose origin is [origin] (none when null), made by the real git, with no network. */
function checkout(folder: string, origin: string | null): void {
  execFileSync('git', ['init', '-q', folder])
  if (origin !== null) execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', origin])
}

/** A clone, as the core parses its request: the workspaces service makes its folder. */
const remoteFolder = (repositoryUrl: string) => parseProjectFolder({ projectSource: 'remote', repositoryUrl }) as GitProjectFolder

describe('a clone\'s project folder', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'harness-project-test-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('publishes a complete clone and never replaces existing files or starts a second clone', async () => {
    const project = remoteFolder('owner/repo')
    const clone = vi.fn(async (url: string, destination: string) => {
      expect(url).toBe('https://github.com/owner/repo.git')
      await mkdir(destination)
      await writeFile(join(destination, 'README.md'), 'saved checkout')
    })
    const folder = await prepareGitFolder(project, { root, clone })
    expect(folder).toBe(join(root, 'repo'))
    expect(await readFile(join(folder, 'README.md'), 'utf8')).toBe('saved checkout')
    expect(await readdir(root)).toEqual(['repo'])
    await expect(prepareGitFolder(project, { root, clone })).rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
    expect(clone).toHaveBeenCalledTimes(1)
    expect(await readFile(join(folder, 'README.md'), 'utf8')).toBe('saved checkout')
  })

  it('knows one repository however git spells it, and nothing that names no host', () => {
    for (const address of ['https://github.com/owner/repo.git', 'https://github.com/owner/repo', 'https://github.com/owner/repo/',
      'https://GitHub.com/Owner/Repo.git', 'http://github.com/owner/repo', 'https://x-access-token:secret@github.com/owner/repo.git',
      'git@github.com:owner/repo.git', 'git@github.com:Owner/repo', 'ssh://git@github.com/owner/repo.git', 'ssh://git@github.com:22/owner/repo',
      'git://github.com/owner/repo.git', '  https://github.com/owner/repo.git\n']) {
      expect(repositoryIdentity(address), address).toBe('github.com/owner/repo')
    }
    expect(repositoryIdentity('https://github.com/owner/other.git')).toBe('github.com/owner/other')
    expect(repositoryIdentity('https://gitlab.com/owner/repo.git')).toBe('gitlab.com/owner/repo')
    for (const address of ['/srv/git/repo.git', './repo', 'file:///srv/git/repo.git', 'not a url', '', 'https://github.com/']) {
      expect(repositoryIdentity(address), address).toBeNull()
    }
  })

  it('tells a refused clone from one that failed for another reason, keeping the code the apps know', () => {
    for (const diagnostic of [
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'ERROR: Repository not found.\nfatal: Could not read from remote repository.',
      'git@github.com: Permission denied (publickey).',
      'remote: Invalid username or token. Password authentication is not supported.\nfatal: Authentication failed',
    ]) {
      const error = cloneFailure(diagnostic)
      expect(error, diagnostic).toBeInstanceOf(RepositoryAccessError)
      expect(error.code).toBe('CLONE_FAILED')
      expect(error.message).toContain('GitHub access on the selected machine')
    }
    for (const diagnostic of ['fatal: unable to access: Could not resolve host: github.com', '']) {
      const error = cloneFailure(diagnostic)
      expect(error, diagnostic).not.toBeInstanceOf(RepositoryAccessError)
      expect(error).toMatchObject({ code: 'CLONE_FAILED' })
    }
    expect(cloneFailure('').message).toBe('Could not clone the repository. Check the URL and connection, then retry.')
  })

  // Six first starts failed on 11-05 with "Could not clone the repository" and nothing else to go on.
  it('names git\'s own reason in a failed clone, without a credential', () => {
    expect(cloneFailure('Cloning into \'x\'...\nfatal: unable to access \'https://github.com/o/r/\': Could not resolve host: github.com\n').message)
      .toBe('Could not clone the repository (git said: unable to access \'https://github.com/o/r/\': Could not resolve host: github.com). Check the URL and connection, then retry.')
    const leaked = cloneFailure('fatal: unable to access \'https://x-access-token:ghs_abcdefghijklmnop1234@github.com/o/r/\': The requested URL returned error: 500').message
    expect(leaked).toContain('returned error: 500')
    expect(leaked).not.toMatch(/ghs_|x-access-token/)
    expect(cloneFailure(`error: ${'a'.repeat(900)}`).message.length).toBeLessThan(400)
    // A progress line is no reason: the last error line is.
    expect(cloneFailure('error: RPC failed; HTTP 502\nfatal: early EOF\nReceiving objects: 40%\n').message).toContain('git said: early EOF')
  })

  it('names an untrusted host key, which is no refusal: GitHub was never asked', () => {
    const error = cloneFailure('Host key verification failed.\nfatal: Could not read from remote repository.')
    expect(error).toBeInstanceOf(RepositoryHostKeyError)
    expect(error).not.toBeInstanceOf(RepositoryAccessError)
    expect(error.code).toBe('CLONE_FAILED')
    expect(error.message).toContain('ssh -T git@github.com')
    // A changed key's warning mentions authentication: it is still the key, and never "No access".
    expect(cloneFailure('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nPassword authentication is disabled to avoid man-in-the-middle attacks.\nHost key verification failed.'))
      .toBeInstanceOf(RepositoryHostKeyError)
  })

  it('starts in a checkout of the same repository already at the destination, and never clones it again', async () => {
    const clone = vi.fn(async () => { throw new Error('must not clone') })
    // The address asked for and the origin git keeps, in each other's spellings.
    for (const [asked, origin] of [['owner/repo', 'https://github.com/owner/repo.git'], ['https://github.com/Owner/repo/','git@github.com:owner/repo.git'],
      ['git@github.com:owner/repo', 'https://github.com/owner/repo'], ['https://github.com/owner/repo.git', 'ssh://git@GitHub.com/owner/repo/']] as const) {
      const at = await mkdtemp(join(root, 'root-'))
      checkout(join(at, 'repo'), origin)
      await writeFile(join(at, 'repo', 'work.txt'), 'local changes')
      const project = remoteFolder(asked)
      expect(await prepareGitFolder(project, { root: at, clone }), asked).toBe(join(at, 'repo'))
      expect(await readFile(join(at, 'repo', 'work.txt'), 'utf8')).toBe('local changes')
      expect(await readdir(at)).toEqual(['repo'])
    }
    expect(clone).not.toHaveBeenCalled()
  })

  it('still refuses a destination holding another repository, a checkout without origin, or a folder inside a checkout', async () => {
    const clone = vi.fn(async () => { throw new Error('must not clone') })
    const project = remoteFolder('owner/repo')
    checkout(join(root, 'repo'), 'https://github.com/owner/other.git')
    await expect(prepareGitFolder(project, { root, clone }))
      .rejects.toMatchObject({ code: 'PROJECT_EXISTS', message: '“repo” already exists. Select that folder from your projects.' })
    await rm(join(root, 'repo'), { recursive: true })
    checkout(join(root, 'repo'), 'https://gitlab.com/owner/repo.git')
    await expect(prepareGitFolder(project, { root, clone, resolveHost: async () => null })).rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
    await rm(join(root, 'repo'), { recursive: true })
    checkout(join(root, 'repo'), null)
    await expect(prepareGitFolder(project, { root, clone })).rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
    await rm(join(root, 'repo'), { recursive: true })
    // The projects folder is itself that repository's checkout: `repo` inside it is a plain folder, not the checkout.
    checkout(root, 'https://github.com/owner/repo.git')
    await mkdir(join(root, 'repo'))
    const refusal = await prepareGitFolder(project, { root, clone }).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'PROJECT_EXISTS' })
    // A clone's refusal names no folder to start in: only a typed name's does.
    expect((refusal as ProjectFolderError).folder).toBeUndefined()
    expect(clone).not.toHaveBeenCalled()
  })

  it('takes the checkout of the same repository another start made while this one cloned, and leaves no staging', async () => {
    const project = remoteFolder('owner/repo')
    const folder = await prepareGitFolder(project, { root, clone: async (_, destination) => {
      await mkdir(destination)
      checkout(join(root, 'repo'), 'git@github.com:owner/repo.git')
    } })
    expect(folder).toBe(join(root, 'repo'))
    expect(await readdir(root)).toEqual(['repo'])
  })

  it('cleans only its private staging on failure and preserves a concurrently created destination', async () => {
    const project = remoteFolder('owner/repo')
    await expect(prepareGitFolder(project, { root, clone: async (_, destination) => {
      await mkdir(destination)
      throw new ProjectFolderError('CLONE_FAILED', 'Could not clone')
    } })).rejects.toMatchObject({ code: 'CLONE_FAILED' })
    expect(await readdir(root)).toEqual([])
    await expect(prepareGitFolder(project, { root, clone: async (_, destination) => {
      await mkdir(destination)
      await mkdir(join(root, 'repo'))
      await writeFile(join(root, 'repo', 'draft'), 'keep me')
    } })).rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
    expect(await readFile(join(root, 'repo', 'draft'), 'utf8')).toBe('keep me')
    expect(await readdir(root)).toEqual(['repo'])
  })
})

describe('a clone GitHub refuses', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'harness-clone-fallback-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const refused = () => new RepositoryAccessError('CLONE_FAILED', 'Could not access this repository.')
  /** A git that clones only [reachable], refusing every other address, and records what it was asked. */
  function git(reachable: string | null, failure: () => Error = refused) {
    const tried: string[] = []
    const clone = vi.fn(async (url: string, destination: string) => {
      tried.push(url)
      if (url !== reachable) throw failure()
      await mkdir(destination)
    })
    return { clone, tried }
  }
  const remote = remoteFolder

  it('tries the other transport, then the computer\'s GitHub aliases, and says which alias worked', async () => {
    const { clone, tried } = git('git@gh-b:owner/repo.git')
    const aliases = vi.fn(async () => ['gh-a', 'gh-b'])
    const onCloned = vi.fn()
    const folder = await prepareGitFolder(remote('https://github.com/owner/repo'), { root, clone, cloneFallback: true, githubAliases: aliases, onCloned })
    expect(folder).toBe(join(root, 'repo'))
    expect(tried).toStrictEqual(['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'git@gh-a:owner/repo.git', 'git@gh-b:owner/repo.git'])
    expect(aliases).toHaveBeenCalledOnce()
    expect(onCloned).toHaveBeenCalledWith({ url: 'git@gh-b:owner/repo.git', alias: 'gh-b' })
    expect(await readdir(root)).toStrictEqual(['repo'])
  })

  it('reads no aliases when the first address works, and names no alias for a transport switch', async () => {
    const aliases = vi.fn(async () => ['gh-a'])
    const first = git('https://github.com/owner/repo.git'), onCloned = vi.fn()
    await prepareGitFolder(remote('owner/repo'), { root, clone: first.clone, cloneFallback: true, githubAliases: aliases, onCloned })
    expect(first.tried).toHaveLength(1)
    expect(aliases).not.toHaveBeenCalled()
    expect(onCloned).toHaveBeenCalledWith({ url: 'https://github.com/owner/repo.git' })
    await rm(join(root, 'repo'), { recursive: true })
    const second = git('https://github.com/owner/repo.git')
    await prepareGitFolder(remote('git@github.com:owner/repo'), { root, clone: second.clone, cloneFallback: true, githubAliases: async () => [], onCloned })
    expect(onCloned).toHaveBeenLastCalledWith({ url: 'https://github.com/owner/repo.git' })
  })

  it('stays refused once every way in is, and leaves no staging behind', async () => {
    const { clone, tried } = git(null)
    await expect(prepareGitFolder(remote('owner/repo'), { root, clone, cloneFallback: true, githubAliases: async () => ['gh-a'] }))
      .rejects.toBeInstanceOf(RepositoryAccessError)
    expect(tried).toHaveLength(3)
    expect(await readdir(root)).toStrictEqual([])
  })

  describe('with a host key this computer does not trust', () => {
    const untrusted = () => new RepositoryHostKeyError('CLONE_FAILED', 'host key')
    /** HTTPS refused, as with no credential stored; ssh to github.com stopped by its host key; an alias [reachable]. */
    function gitWithoutKnownHost(reachable: string | null) {
      const tried: string[] = []
      const clone = vi.fn(async (url: string, destination: string) => {
        tried.push(url)
        if (url === reachable) return mkdir(destination)
        throw url.startsWith('https://') ? refused() : untrusted()
      })
      return { clone, tried }
    }

    it('still tries the aliases, one of which may reach it', async () => {
      const { clone, tried } = gitWithoutKnownHost('git@gh-a:owner/repo.git')
      await prepareGitFolder(remote('owner/repo'), { root, clone, cloneFallback: true, githubAliases: async () => ['gh-a'] })
      expect(tried).toStrictEqual(['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'git@gh-a:owner/repo.git'])
    })

    it('says so when nothing got in, rather than calling it no access', async () => {
      const { clone, tried } = gitWithoutKnownHost(null)
      await expect(prepareGitFolder(remote('owner/repo'), { root, clone, cloneFallback: true, githubAliases: async () => [] }))
        .rejects.toBeInstanceOf(RepositoryHostKeyError)
      expect(tried).toHaveLength(2)
      expect(await readdir(root)).toStrictEqual([])
    })

    it('says so even when a later way in was refused', async () => {
      const refusedLast = vi.fn(async (url: string) => { throw url === 'git@github.com:owner/repo.git' ? untrusted() : refused() })
      await expect(prepareGitFolder(remote('git@github.com:owner/repo'), { root, clone: refusedLast, cloneFallback: true, githubAliases: async () => [] }))
        .rejects.toBeInstanceOf(RepositoryHostKeyError)
      expect(refusedLast).toHaveBeenCalledTimes(2)
    })
  })

  it('stops at a failure other than a refusal: another way in would fail the same', async () => {
    for (const failure of [() => new ProjectFolderError('CLONE_TIMEOUT', 'Cloning took too long.'), () => new ProjectFolderError('CLONE_FAILED', 'Could not resolve host'), () => new Error('disk full')]) {
      const { clone, tried } = git(null, failure)
      const aliases = vi.fn(async () => ['gh-a'])
      await expect(prepareGitFolder(remote('owner/repo'), { root, clone, cloneFallback: true, githubAliases: aliases })).rejects.toBeTruthy()
      expect(tried).toHaveLength(1)
      expect(aliases).not.toHaveBeenCalled()
    }
  })

  it('tries one address only when not asked for more', async () => {
    const { clone, tried } = git('git@github.com:owner/repo.git')
    await expect(prepareGitFolder(remote('owner/repo'), { root, clone })).rejects.toBeInstanceOf(RepositoryAccessError)
    expect(tried).toStrictEqual(['https://github.com/owner/repo.git'])
  })

  it('clones a pasted alias first, and refuses one that is not a GitHub host here', async () => {
    const { clone, tried } = git('git@gh-work:owner/repo.git')
    const resolveHost = vi.fn(async (alias: string) => alias === 'gh-work' ? 'github.com' : 'gitlab.com')
    const project = remote('git@gh-work:owner/repo.git')
    expect(project).toStrictEqual({ source: 'remote', repositoryUrl: 'git@gh-work:owner/repo.git', name: 'repo' })
    await prepareGitFolder(project, { root, clone, resolveHost, cloneFallback: true })
    expect(tried).toStrictEqual(['git@gh-work:owner/repo.git'])
    await expect(prepareGitFolder(remote('git@gitlab-work:owner/repo'), { root, clone, resolveHost, cloneFallback: true }))
      .rejects.toMatchObject({ code: 'INVALID_REPOSITORY', message: '“gitlab-work” isn\'t a GitHub host on this machine.' })
    expect(clone).toHaveBeenCalledOnce()
  })

  it('refuses an alias in a start that is not the owner\'s own, without asking ssh which aliases exist', async () => {
    // Another person's start names the address of a project that starts on this computer.
    const { clone } = git('git@gh-work:owner/repo.git')
    const resolveHost = vi.fn(async () => 'github.com')
    for (const url of ['git@gh-work:owner/repo.git', 'git@no-such-alias:owner/repo.git']) {
      await expect(prepareGitFolder(remote(url), { root, clone, resolveHost }))
        .rejects.toMatchObject({ code: 'INVALID_REPOSITORY', message: 'Enter a GitHub HTTPS or SSH URL, or owner/repository.' })
    }
    expect(resolveHost).not.toHaveBeenCalled()
    expect(clone).not.toHaveBeenCalled()
  })

  it('starts in a checkout cloned through an alias when the browser link asks for the same repository', async () => {
    checkout(join(root, 'repo'), 'git@gh-work:Owner/repo.git')
    const clone = vi.fn()
    const folder = await prepareGitFolder(remote('https://github.com/owner/repo'), { root, clone, resolveHost: async alias => alias === 'gh-work' ? 'github.com' : null })
    expect(folder).toBe(join(root, 'repo'))
    expect(clone).not.toHaveBeenCalled()
  })
})

/** Real git with nothing of this machine's own config: no owner credential helper or url rewrite reaches these clones. */
const isolatedGit: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
  { cwd, env: isolatedGit, encoding: 'utf8' }).trim()

/** An origin that serves partial clones, with `main` and a `feature` branch, each holding a file of its own. */
async function originWithBranches(root: string): Promise<string> {
  const origin = join(root, 'origin')
  execFileSync('git', ['init', '-q', '-b', 'main', origin], { env: isolatedGit })
  for (const [key, value] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true']]) gitIn(origin, 'config', key!, value!)
  await writeFile(join(origin, 'main.txt'), 'first\n')
  gitIn(origin, 'add', '.'); gitIn(origin, 'commit', '-q', '-m', 'first')
  await writeFile(join(origin, 'main.txt'), 'first\nsecond\n')
  gitIn(origin, 'commit', '-q', '-am', 'second')
  gitIn(origin, 'checkout', '-q', '-b', 'feature')
  await writeFile(join(origin, 'feature.txt'), 'feature work\n')
  gitIn(origin, 'add', '.'); gitIn(origin, 'commit', '-q', '-m', 'feature')
  gitIn(origin, 'checkout', '-q', 'main')
  return origin
}

describe('the project clone of a large repository', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'harness-clone-test-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('clones only the default branch without file contents, and fetches another branch on demand', async () => {
    const origin = await originWithBranches(root)
    const dest = join(root, 'checkout')
    await cloneRepository(`file://${origin}`, dest, isolatedGit)
    expect(gitIn(dest, 'config', 'remote.origin.promisor')).toBe('true')
    expect(gitIn(dest, 'config', 'remote.origin.partialclonefilter')).toBe('blob:none')
    // Only the default branch came: lampOS has about 4,400.
    expect(gitIn(dest, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/')).not.toContain('feature')
    // A later fetch still sees every branch, as a full clone's would.
    expect(gitIn(dest, 'config', '--get-all', 'remote.origin.fetch')).toBe('+refs/heads/*:refs/remotes/origin/*')
    expect(gitIn(dest, 'log', '--format=%s')).toBe('second\nfirst')
    expect(gitIn(dest, 'blame', '--porcelain', 'main.txt')).toContain('summary first')
    gitIn(dest, 'fetch', '-q', 'origin', 'feature')
    gitIn(dest, 'checkout', '-q', 'feature')
    expect(await readFile(join(dest, 'feature.txt'), 'utf8')).toBe('feature work\n')
    // It runs a real git clone, which took over the default 5 s on a loaded CI runner.
  }, 60_000)

  /** A stand-in for git at [root]/fake-git: [body] runs for `clone`; `config` succeeds. Its pid is written to [root]/pid. */
  async function fakeGit(body: string): Promise<string> {
    const path = join(root, 'fake-git')
    writeExecutable(path, `#!/bin/sh\necho $$ > '${join(root, 'pid')}'\n[ "$1" = clone ] || exit 0\n${body}\n`)
    return path
  }
  const running = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

  it('gives up on a clone that stops making progress, and stops its git', async () => {
    const git = await fakeGit("echo 'Receiving objects:   1%' >&2\nexec sleep 30")
    const started = Date.now()
    const failure = await cloneRepository('https://github.com/owner/repo', join(root, 'checkout'), process.env, { git, stallMs: 1500 })
      .then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ProjectFolderError)
    expect(failure).toMatchObject({ code: 'CLONE_TIMEOUT', message: expect.stringContaining('Cloning stopped making progress') })
    expect((failure as Error).message).toContain('git\'s last words: Receiving objects:   1%')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(running(Number(await readFile(join(root, 'pid'), 'utf8')))).toBe(false)
  }, 20_000)

  // anh Dee, 2026-11-10, a project of lampOS on Mac 2: "Cloning stopped making progress (git's last words: Resolving deltas:
  // 100% (70463/70463), done.)". After its history a blob-less clone's checkout fetches the files in a fetch of its own, which
  // shows progress only to a terminal: git is quiet, and its pack grows.
  it('never cuts off a quiet clone whose pack keeps growing, as a blob-less checkout fetching its files', async () => {
    const git = await fakeGit([
      'dest="$7"; mkdir -p "$dest/.git/objects/pack"',
      "echo 'Resolving deltas: 100% (70463/70463), done.' >&2",
      // Over three times the window with nothing said, 4 KB more of the pack every 200 ms.
      'i=0; while [ $i -lt 25 ]; do head -c 4096 /dev/zero >> "$dest/.git/objects/pack/tmp_pack_x"; sleep 0.2; i=$((i+1)); done',
      'exit 0',
    ].join('\n'))
    const started = Date.now()
    await expect(cloneRepository('https://github.com/owner/repo', join(root, 'checkout'), process.env, { git, stallMs: 1500, lookMs: 300 }))
      .resolves.toBeUndefined()
    expect(Date.now() - started).toBeGreaterThan(4500)
  }, 20_000)

  it('still gives up on a quiet clone whose pack stopped growing', async () => {
    const git = await fakeGit([
      'dest="$7"; mkdir -p "$dest/.git/objects/pack"',
      'head -c 4096 /dev/zero > "$dest/.git/objects/pack/tmp_pack_x"',
      "echo 'Resolving deltas: 100% (70463/70463), done.' >&2",
      'exec sleep 30',
    ].join('\n'))
    const failure = await cloneRepository('https://github.com/owner/repo', join(root, 'checkout'), process.env, { git, stallMs: 1500, lookMs: 300 })
      .then(() => null, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'CLONE_TIMEOUT', message: expect.stringContaining('Resolving deltas: 100%') })
  }, 20_000)

  it('never cuts off a slow clone that keeps making progress', async () => {
    // Over three times the window, a line every 200 ms: the receiving part of a big clone on a slow connection.
    const git = await fakeGit("i=0\nwhile [ $i -lt 25 ]; do echo \"Receiving objects: $i%\" >&2; sleep 0.2; i=$((i+1)); done\nexit 0")
    const started = Date.now()
    await expect(cloneRepository('https://github.com/owner/repo', join(root, 'checkout'), process.env, { git, stallMs: 1500 })).resolves.toBeUndefined()
    expect(Date.now() - started).toBeGreaterThan(4500)
  }, 20_000)
})
