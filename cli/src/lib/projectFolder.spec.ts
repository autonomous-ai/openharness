import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cloneFailure, cloneRepository, otherGitHubTransport, parseProjectFolder, prepareProjectFolder, ProjectFolderError, projectsRoot, repositoryIdentity, RepositoryAccessError, RepositoryHostKeyError,
} from './projectFolder.js'

/** A checkout at [folder] whose origin is [origin] (none when null), made by the real git, with no network. */
function checkout(folder: string, origin: string | null): void {
  execFileSync('git', ['init', '-q', folder])
  if (origin !== null) execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', origin])
}

describe('project folder preparation', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'harness-project-test-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('accepts the existing GitHub forms and rejects credentials, helpers and ambiguous source choices', () => {
    expect(parseProjectFolder({})).toBeNull()
    expect(parseProjectFolder({ projectSource: 'new' })).toEqual({ source: 'new' })
    for (const url of ['owner/repo', 'https://github.com/owner/repo.git', 'git@github.com:owner/repo']) {
      expect(parseProjectFolder({ projectSource: 'remote', repositoryUrl: url })).toMatchObject({ source: 'remote', name: 'repo' })
    }
    for (const url of ['ext::bad', '/tmp/repo', '--upload-pack=bad', 'https://user:secret@github.com/owner/repo', 'owner/repo;command', 'https://github.com/owner/repo?token=secret']) {
      expect(() => parseProjectFolder({ projectSource: 'remote', repositoryUrl: url })).toThrow(ProjectFolderError)
    }
    expect(() => parseProjectFolder({ projectSource: 'new', repositoryUrl: 'owner/repo' })).toThrow(ProjectFolderError)
  })

  const now = () => new Date(2026, 8, 3, 9, 5, 7)

  it('names a new project after its agent and the time, every part two digits so folders sort', async () => {
    expect(await prepareProjectFolder({ source: 'new' }, { root, label: 'Codex', now })).toBe(join(root, 'codex-2026-09-03-09-05'))
    expect(await prepareProjectFolder({ source: 'new' }, { root, label: 'Autonomous Circuit', now })).toBe(join(root, 'autonomous-circuit-2026-09-03-09-05'))
    expect(await prepareProjectFolder({ source: 'new' }, { root, label: '  ', now })).toBe(join(root, 'harness-2026-09-03-09-05'))
    expect(await prepareProjectFolder({ source: 'new' }, { root, label: '!!', now })).toBe(join(root, 'harness-2026-09-03-09-05-07'))
  })

  it('gives a named new project that folder, slugged again here, and never a changed name', async () => {
    expect(parseProjectFolder({ projectSource: 'new', projectName: 'My Game! v2' })).toEqual({ source: 'new', name: 'My-Game-v2' })
    // A name is a path segment: nothing that climbs or hides survives, and nothing usable is no name.
    expect(parseProjectFolder({ projectSource: 'new', projectName: '../../etc' })).toEqual({ source: 'new', name: 'etc' })
    expect(parseProjectFolder({ projectSource: 'new', projectName: ' .. ' })).toEqual({ source: 'new' })
    expect(parseProjectFolder({ projectSource: 'new', projectName: 7 })).toEqual({ source: 'new' })
    expect(await prepareProjectFolder({ source: 'new', name: 'My-Game-v2' }, { root, label: 'Codex', now })).toBe(join(root, 'My-Game-v2'))
    // Asking again is refused rather than answered with "My-Game-v2-2": the folder is theirs to pick.
    await expect(prepareProjectFolder({ source: 'new', name: 'My-Game-v2' }, { root, label: 'Codex', now }))
      .rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
    expect(await readdir(root)).toEqual(['My-Game-v2'])
  })

  it('names the folder a typed name found, so an app can offer it, and no folder when what is there is a file', async () => {
    await mkdir(join(root, 'payments'))
    await expect(prepareProjectFolder({ source: 'new', name: 'payments' }, { root, label: 'Codex', now }))
      .rejects.toMatchObject({ code: 'PROJECT_EXISTS', folder: join(root, 'payments') })
    await writeFile(join(root, 'notes'), 'a file, not a project')
    const refusal = await prepareProjectFolder({ source: 'new', name: 'notes' }, { root, label: 'Codex', now }).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'PROJECT_EXISTS' })
    expect((refusal as ProjectFolderError).folder).toBeUndefined()
    expect(await readFile(join(root, 'notes'), 'utf8')).toBe('a file, not a project')
  })

  it('numbers a suggested name past a folder that exists, instead of refusing it', async () => {
    expect(parseProjectFolder({ projectSource: 'new', projectName: 'robot-noi-chuyen', projectNameMode: 'suggested' }))
      .toEqual({ source: 'new', name: 'robot-noi-chuyen', suggested: true })
    // Any other mode is an ordinary chosen name.
    expect(parseProjectFolder({ projectSource: 'new', projectName: 'robot', projectNameMode: 'mine' }))
      .toEqual({ source: 'new', name: 'robot' })
    const suggested = { source: 'new', name: 'robot-noi-chuyen', suggested: true } as const
    await writeFile(join(root, 'robot-noi-chuyen-2'), 'a file takes the name too')
    expect(await prepareProjectFolder(suggested, { root, label: 'Codex', now })).toBe(join(root, 'robot-noi-chuyen'))
    expect(await prepareProjectFolder(suggested, { root, label: 'Codex', now })).toBe(join(root, 'robot-noi-chuyen-3'))
  })

  it('gives two projects in the same minute the seconds, then a suffix, and never takes a file’s name', async () => {
    await writeFile(join(root, 'codex-2026-09-03-09-05'), 'keep')
    const folders = await Promise.all([1, 2, 3].map(() => prepareProjectFolder({ source: 'new' }, { root, label: 'Codex', now })))
    expect(new Set(folders)).toEqual(new Set([
      join(root, 'codex-2026-09-03-09-05-07'), join(root, 'codex-2026-09-03-09-05-07-2'), join(root, 'codex-2026-09-03-09-05-07-3'),
    ]))
    expect(await readFile(join(root, 'codex-2026-09-03-09-05'), 'utf8')).toBe('keep')
    expect(await readdir(root)).toHaveLength(4)
  })

  it('uses the clock when no time is given', async () => {
    const folder = await prepareProjectFolder({ source: 'new' }, { root, label: 'Pi' })
    expect(folder).toMatch(/\/pi-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/)
  })

  it('publishes a complete clone and never replaces existing files or starts a second clone', async () => {
    const project = parseProjectFolder({ projectSource: 'remote', repositoryUrl: 'owner/repo' })!
    const clone = vi.fn(async (url: string, destination: string) => {
      expect(url).toBe('https://github.com/owner/repo.git')
      await mkdir(destination)
      await writeFile(join(destination, 'README.md'), 'saved checkout')
    })
    const folder = await prepareProjectFolder(project, { root, clone })
    expect(folder).toBe(join(root, 'repo'))
    expect(await readFile(join(folder, 'README.md'), 'utf8')).toBe('saved checkout')
    expect(await readdir(root)).toEqual(['repo'])
    await expect(prepareProjectFolder(project, { root, clone })).rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
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
      expect(error).toMatchObject({ code: 'CLONE_FAILED', message: 'Could not clone the repository. Check the URL and connection, then retry.' })
    }
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

  it('names the same GitHub repository over the other transport, and nothing for another address', () => {
    expect(otherGitHubTransport('https://github.com/owner/repo.git')).toBe('git@github.com:owner/repo.git')
    expect(otherGitHubTransport('git@github.com:owner/repo.git')).toBe('https://github.com/owner/repo.git')
    for (const url of ['owner/repo', 'https://gitlab.com/owner/repo.git', 'https://github.com/owner/repo/extra', 'ssh://git@github.com/owner/repo', '']) {
      expect(otherGitHubTransport(url), url).toBeNull()
    }
    // Both forms parseProjectFolder makes round-trip to each other.
    for (const url of ['https://github.com/owner/repo', 'git@github.com:owner/repo']) {
      const parsed = parseProjectFolder({ projectSource: 'remote', repositoryUrl: url })
      if (parsed?.source !== 'remote') throw new Error('expected a remote project')
      const other = otherGitHubTransport(parsed.repositoryUrl)!
      expect(otherGitHubTransport(other)).toBe(parsed.repositoryUrl)
      expect(repositoryIdentity(other)).toBe(repositoryIdentity(parsed.repositoryUrl))
    }
  })

  it('starts in a checkout of the same repository already at the destination, and never clones it again', async () => {
    const clone = vi.fn(async () => { throw new Error('must not clone') })
    // The address asked for and the origin git keeps, in each other's spellings.
    for (const [asked, origin] of [['owner/repo', 'https://github.com/owner/repo.git'], ['https://github.com/Owner/repo/','git@github.com:owner/repo.git'],
      ['git@github.com:owner/repo', 'https://github.com/owner/repo'], ['https://github.com/owner/repo.git', 'ssh://git@GitHub.com/owner/repo/']] as const) {
      const at = await mkdtemp(join(root, 'root-'))
      checkout(join(at, 'repo'), origin)
      await writeFile(join(at, 'repo', 'work.txt'), 'local changes')
      const project = parseProjectFolder({ projectSource: 'remote', repositoryUrl: asked })!
      expect(await prepareProjectFolder(project, { root: at, clone }), asked).toBe(join(at, 'repo'))
      expect(await readFile(join(at, 'repo', 'work.txt'), 'utf8')).toBe('local changes')
      expect(await readdir(at)).toEqual(['repo'])
    }
    expect(clone).not.toHaveBeenCalled()
  })

  it('still refuses a destination holding another repository, a checkout without origin, or a folder inside a checkout', async () => {
    const clone = vi.fn(async () => { throw new Error('must not clone') })
    const project = parseProjectFolder({ projectSource: 'remote', repositoryUrl: 'owner/repo' })!
    checkout(join(root, 'repo'), 'https://github.com/owner/other.git')
    await expect(prepareProjectFolder(project, { root, clone }))
      .rejects.toMatchObject({ code: 'PROJECT_EXISTS', message: '“repo” already exists. Select that folder from your projects.' })
    await rm(join(root, 'repo'), { recursive: true })
    checkout(join(root, 'repo'), 'https://gitlab.com/owner/repo.git')
    await expect(prepareProjectFolder(project, { root, clone, resolveHost: async () => null })).rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
    await rm(join(root, 'repo'), { recursive: true })
    checkout(join(root, 'repo'), null)
    await expect(prepareProjectFolder(project, { root, clone })).rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
    await rm(join(root, 'repo'), { recursive: true })
    // The projects folder is itself that repository's checkout: `repo` inside it is a plain folder, not the checkout.
    checkout(root, 'https://github.com/owner/repo.git')
    await mkdir(join(root, 'repo'))
    const refusal = await prepareProjectFolder(project, { root, clone }).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'PROJECT_EXISTS' })
    // A clone's refusal names no folder to start in: only a typed name's does.
    expect((refusal as ProjectFolderError).folder).toBeUndefined()
    expect(clone).not.toHaveBeenCalled()
  })

  it('takes the checkout of the same repository another start made while this one cloned, and leaves no staging', async () => {
    const project = parseProjectFolder({ projectSource: 'remote', repositoryUrl: 'owner/repo' })!
    const folder = await prepareProjectFolder(project, { root, clone: async (_, destination) => {
      await mkdir(destination)
      checkout(join(root, 'repo'), 'git@github.com:owner/repo.git')
    } })
    expect(folder).toBe(join(root, 'repo'))
    expect(await readdir(root)).toEqual(['repo'])
  })

  it('cleans only its private staging on failure and preserves a concurrently created destination', async () => {
    const project = parseProjectFolder({ projectSource: 'remote', repositoryUrl: 'owner/repo' })!
    await expect(prepareProjectFolder(project, { root, clone: async (_, destination) => {
      await mkdir(destination)
      throw new ProjectFolderError('CLONE_FAILED', 'Could not clone')
    } })).rejects.toMatchObject({ code: 'CLONE_FAILED' })
    expect(await readdir(root)).toEqual([])
    await expect(prepareProjectFolder(project, { root, clone: async (_, destination) => {
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
  const remote = (url: string) => parseProjectFolder({ projectSource: 'remote', repositoryUrl: url })!

  it('tries the other transport, then the computer\'s GitHub aliases, and says which alias worked', async () => {
    const { clone, tried } = git('git@gh-b:owner/repo.git')
    const aliases = vi.fn(async () => ['gh-a', 'gh-b'])
    const onCloned = vi.fn()
    const folder = await prepareProjectFolder(remote('https://github.com/owner/repo'), { root, clone, cloneFallback: true, githubAliases: aliases, onCloned })
    expect(folder).toBe(join(root, 'repo'))
    expect(tried).toStrictEqual(['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'git@gh-a:owner/repo.git', 'git@gh-b:owner/repo.git'])
    expect(aliases).toHaveBeenCalledOnce()
    expect(onCloned).toHaveBeenCalledWith({ url: 'git@gh-b:owner/repo.git', alias: 'gh-b' })
    expect(await readdir(root)).toStrictEqual(['repo'])
  })

  it('reads no aliases when the first address works, and names no alias for a transport switch', async () => {
    const aliases = vi.fn(async () => ['gh-a'])
    const first = git('https://github.com/owner/repo.git'), onCloned = vi.fn()
    await prepareProjectFolder(remote('owner/repo'), { root, clone: first.clone, cloneFallback: true, githubAliases: aliases, onCloned })
    expect(first.tried).toHaveLength(1)
    expect(aliases).not.toHaveBeenCalled()
    expect(onCloned).toHaveBeenCalledWith({ url: 'https://github.com/owner/repo.git' })
    await rm(join(root, 'repo'), { recursive: true })
    const second = git('https://github.com/owner/repo.git')
    await prepareProjectFolder(remote('git@github.com:owner/repo'), { root, clone: second.clone, cloneFallback: true, githubAliases: async () => [], onCloned })
    expect(onCloned).toHaveBeenLastCalledWith({ url: 'https://github.com/owner/repo.git' })
  })

  it('stays refused once every way in is, and leaves no staging behind', async () => {
    const { clone, tried } = git(null)
    await expect(prepareProjectFolder(remote('owner/repo'), { root, clone, cloneFallback: true, githubAliases: async () => ['gh-a'] }))
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
      await prepareProjectFolder(remote('owner/repo'), { root, clone, cloneFallback: true, githubAliases: async () => ['gh-a'] })
      expect(tried).toStrictEqual(['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'git@gh-a:owner/repo.git'])
    })

    it('says so when nothing got in, rather than calling it no access', async () => {
      const { clone, tried } = gitWithoutKnownHost(null)
      await expect(prepareProjectFolder(remote('owner/repo'), { root, clone, cloneFallback: true, githubAliases: async () => [] }))
        .rejects.toBeInstanceOf(RepositoryHostKeyError)
      expect(tried).toHaveLength(2)
      expect(await readdir(root)).toStrictEqual([])
    })

    it('says so even when a later way in was refused', async () => {
      const refusedLast = vi.fn(async (url: string) => { throw url === 'git@github.com:owner/repo.git' ? untrusted() : refused() })
      await expect(prepareProjectFolder(remote('git@github.com:owner/repo'), { root, clone: refusedLast, cloneFallback: true, githubAliases: async () => [] }))
        .rejects.toBeInstanceOf(RepositoryHostKeyError)
      expect(refusedLast).toHaveBeenCalledTimes(2)
    })
  })

  it('stops at a failure other than a refusal: another way in would fail the same', async () => {
    for (const failure of [() => new ProjectFolderError('CLONE_TIMEOUT', 'Cloning took too long.'), () => new ProjectFolderError('CLONE_FAILED', 'Could not resolve host'), () => new Error('disk full')]) {
      const { clone, tried } = git(null, failure)
      const aliases = vi.fn(async () => ['gh-a'])
      await expect(prepareProjectFolder(remote('owner/repo'), { root, clone, cloneFallback: true, githubAliases: aliases })).rejects.toBeTruthy()
      expect(tried).toHaveLength(1)
      expect(aliases).not.toHaveBeenCalled()
    }
  })

  it('tries one address only when not asked for more, as a Swarm start is', async () => {
    const { clone, tried } = git('git@github.com:owner/repo.git')
    await expect(prepareProjectFolder(remote('owner/repo'), { root, clone })).rejects.toBeInstanceOf(RepositoryAccessError)
    expect(tried).toStrictEqual(['https://github.com/owner/repo.git'])
  })

  it('clones a pasted alias first, and refuses one that is not a GitHub host here', async () => {
    const { clone, tried } = git('git@gh-work:owner/repo.git')
    const resolveHost = vi.fn(async (alias: string) => alias === 'gh-work' ? 'github.com' : 'gitlab.com')
    const project = remote('git@gh-work:owner/repo.git')
    expect(project).toStrictEqual({ source: 'remote', repositoryUrl: 'git@gh-work:owner/repo.git', name: 'repo' })
    await prepareProjectFolder(project, { root, clone, resolveHost, cloneFallback: true })
    expect(tried).toStrictEqual(['git@gh-work:owner/repo.git'])
    await expect(prepareProjectFolder(remote('git@gitlab-work:owner/repo'), { root, clone, resolveHost, cloneFallback: true }))
      .rejects.toMatchObject({ code: 'INVALID_REPOSITORY', message: '“gitlab-work” isn\'t a GitHub host on this machine.' })
    expect(clone).toHaveBeenCalledOnce()
  })

  it('refuses an alias in a start that is not the owner\'s own, without asking ssh which aliases exist', async () => {
    // A Swarm Lead or a contribution names the address of a project that starts on someone else's computer.
    const { clone } = git('git@gh-work:owner/repo.git')
    const resolveHost = vi.fn(async () => 'github.com')
    for (const url of ['git@gh-work:owner/repo.git', 'git@no-such-alias:owner/repo.git']) {
      await expect(prepareProjectFolder(remote(url), { root, clone, resolveHost }))
        .rejects.toMatchObject({ code: 'INVALID_REPOSITORY', message: 'Enter a GitHub HTTPS or SSH URL, or owner/repository.' })
    }
    expect(resolveHost).not.toHaveBeenCalled()
    expect(clone).not.toHaveBeenCalled()
  })

  it('starts in a checkout cloned through an alias when the browser link asks for the same repository', async () => {
    checkout(join(root, 'repo'), 'git@gh-work:Owner/repo.git')
    const clone = vi.fn()
    const folder = await prepareProjectFolder(remote('https://github.com/owner/repo'), { root, clone, resolveHost: async alias => alias === 'gh-work' ? 'github.com' : null })
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
  })

  /** A stand-in for git at [root]/fake-git: [body] runs for `clone`; `config` succeeds. Its pid is written to [root]/pid. */
  async function fakeGit(body: string): Promise<string> {
    const path = join(root, 'fake-git')
    await writeFile(path, `#!/bin/sh\necho $$ > '${join(root, 'pid')}'\n[ "$1" = clone ] || exit 0\n${body}\n`, { mode: 0o755 })
    return path
  }
  const running = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

  it('gives up on a clone that stops making progress, and stops its git', async () => {
    const git = await fakeGit("echo 'Receiving objects:   1%' >&2\nexec sleep 30")
    const started = Date.now()
    const failure = await cloneRepository('https://github.com/owner/repo', join(root, 'checkout'), process.env, { git, stallMs: 300 })
      .then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ProjectFolderError)
    expect(failure).toMatchObject({ code: 'CLONE_TIMEOUT', message: 'Cloning stopped making progress. Check the connection and retry.' })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(running(Number(await readFile(join(root, 'pid'), 'utf8')))).toBe(false)
  })

  it('never cuts off a slow clone that keeps making progress', async () => {
    // Five times the window, a line every 100 ms: the receiving part of a big clone on a slow connection.
    const git = await fakeGit("i=0\nwhile [ $i -lt 15 ]; do echo \"Receiving objects: $i%\" >&2; sleep 0.1; i=$((i+1)); done\nexit 0")
    const started = Date.now()
    await expect(cloneRepository('https://github.com/owner/repo', join(root, 'checkout'), process.env, { git, stallMs: 300 })).resolves.toBeUndefined()
    expect(Date.now() - started).toBeGreaterThan(1200)
  })
})

// The OS chooses a familiar project root without changing other hn installations.
it('uses lowercase projects only in the explicit Harness OS environment', () => {
  try {
    vi.stubEnv('HARNESS_OS', '1')
    expect(projectsRoot('/home/me')).toBe('/home/me/projects')
    vi.stubEnv('HARNESS_OS', '')
    expect(projectsRoot('/Users/me')).toBe('/Users/me/harnesses')
  } finally { vi.unstubAllEnvs() }
})
