import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cloneFailure, otherGitHubTransport, parseProjectFolder, prepareProjectFolder, ProjectFolderError, projectsRoot, repositoryIdentity, RepositoryAccessError,
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
    for (const diagnostic of ['fatal: unable to access: Could not resolve host: github.com', 'Host key verification failed.', '']) {
      const error = cloneFailure(diagnostic)
      expect(error, diagnostic).not.toBeInstanceOf(RepositoryAccessError)
      expect(error).toMatchObject({ code: 'CLONE_FAILED', message: 'Could not clone the repository. Check the URL and connection, then retry.' })
    }
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
    await expect(prepareProjectFolder(project, { root, clone })).rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
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

// The OS chooses a familiar project root without changing other hn installations.
it('uses lowercase projects only in the explicit Harness OS environment', () => {
  try {
    vi.stubEnv('HARNESS_OS', '1')
    expect(projectsRoot('/home/me')).toBe('/home/me/projects')
    vi.stubEnv('HARNESS_OS', '')
    expect(projectsRoot('/Users/me')).toBe('/Users/me/harnesses')
  } finally { vi.unstubAllEnvs() }
})
