import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { ProjectFolderError, RepositoryAccessError } from '../lib/projectFolder.js'
import { PrepareRetryError, prepareEmptyProjectFolder, prepareSwarmProject, prepareSwarmStart, startGitHub } from './projectFolder.js'
import { SuperTabHostError } from './wire.js'

function fixture() {
  const core = fakeCore({ dataDir: '/isolated-project-fixture' })
  const root = join(core.dataDir, 'swarm-projects', 'tab')
  const repository = { machineId: 'other', cwd: '/other/repo', repositoryUrl: 'https://github.com/example/project' }
  const row = { tabId: 'tab', machine: { scope: 'swarm', cwd: root },
    projects: [{ id: 'project-a', repository, conversationIds: ['work'] }] }
  const start = { dispatched: false, request: { conversationId: 'work', cwd: join(root, 'project-a') } }
  const prepare = vi.fn(async () => start.request.cwd)
  const empty = vi.fn(async (folderRoot: string, projectId: string) => join(folderRoot, projectId))
  return { core, root, repository, row, start, prepare, empty,
    run: () => prepareSwarmProject(core, row, start, prepare, undefined, empty) }
}

describe('per-project checkouts on a contributed swarm machine', () => {
  it('prepares the exact project checkout and leaves unrelated projects alone', async () => {
    const f = fixture()
    await f.run()
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith({
      source: 'remote', repositoryUrl: 'https://github.com/example/project.git', name: 'project-a',
    }, { root: f.root })
    f.start.dispatched = true
    await f.run()
    expect(f.prepare).toHaveBeenCalledTimes(1)
  })
  it('uses a project already on this host without cloning it', async () => {
    const f = fixture()
    f.repository.machineId = f.core.daemon.machineId()
    f.start.request.cwd = f.repository.cwd
    await f.run()
    expect(f.prepare).not.toHaveBeenCalled()
  })
  it('finds a project session of a person\'s one Buddy chat by the project it names, as that chat is in no project\'s list', async () => {
    const f = fixture()
    Object.assign(f.start.request, { conversationId: 'swarm-buddy-chat', buddySession: { thread: 'root', projectId: 'project-a' } })
    await f.run()
    expect(f.prepare).toHaveBeenCalledOnce()
    // Its project alone: a session naming a project this machine was not told of prepares nothing, whatever its chat.
    Object.assign(f.start.request, { conversationId: 'work', buddySession: { thread: 'root', projectId: 'project-b' } })
    await expect(f.run()).rejects.toThrow('no authorized project')
    expect(f.prepare).toHaveBeenCalledOnce()
  })
  it('does not widen a legacy contribution or substitute a different filesystem path', async () => {
    const f = fixture()
    f.row.machine.scope = ''
    await f.run()
    expect(f.prepare).not.toHaveBeenCalled()
    f.row.machine.scope = 'swarm'
    f.row.machine.cwd = '/unrelated'
    await expect(f.run()).rejects.toThrow('authorize its swarm workspace')
    f.row.machine.cwd = f.root
    f.start.request.cwd = join(f.root, 'project-b')
    await expect(f.run()).rejects.toThrow('outside this project')
    f.start.request.conversationId = 'unknown'
    await expect(f.run()).rejects.toThrow('no authorized project')
  })
  // Task #3211: a project recorded without a repository address has nothing to clone; its work runs here in its own empty folder.
  it('starts a project with no repository in its own empty folder here, without cloning anything', async () => {
    const f = fixture()
    f.repository.repositoryUrl = null as unknown as string
    await f.run()
    expect(f.empty).toHaveBeenCalledExactlyOnceWith(f.root, 'project-a')
    expect(f.prepare).not.toHaveBeenCalled()
  })
  it('refuses a worktree start of a project with no repository, and a folder that is not the project\'s', async () => {
    const f = fixture()
    f.repository.repositoryUrl = null as unknown as string
    Object.assign(f.start.request, { worktree: true })
    await expect(f.run()).rejects.toThrow(/no repository.*without a worktree/)
    Object.assign(f.start.request, { worktree: false, cwd: join(f.root, 'project-b') })
    await expect(f.run()).rejects.toThrow('outside this project')
    Object.assign(f.start.request, { cwd: join(f.root, 'project-a') })
    f.empty.mockResolvedValueOnce('/elsewhere')
    await expect(f.run()).rejects.toThrow('does not match')
    expect(f.empty).toHaveBeenCalledOnce()
    expect(f.prepare).not.toHaveBeenCalled()
  })
  it('keeps cloning a project with a repository, and says to move aside a folder left from before it was shared', async () => {
    const f = fixture()
    await f.run()
    expect(f.prepare).toHaveBeenCalledOnce()
    expect(f.empty).not.toHaveBeenCalled()
    f.prepare.mockRejectedValueOnce(new ProjectFolderError('PROJECT_EXISTS', '“project-a” already exists. Select that folder from your projects.'))
    await expect(f.run()).rejects.toMatchObject({ code: 'PROJECT_EXISTS',
      message: expect.stringMatching(/already has a folder for this project.*before its repository was shared.*Move it aside/) })
  })
  it('clones over SSH when GitHub refuses this machine over the shared HTTPS address, and the reverse', async () => {
    const refused = () => new RepositoryAccessError('CLONE_FAILED', 'Could not access this repository.')
    for (const [shared, first, second] of [
      ['https://github.com/example/project', 'https://github.com/example/project.git', 'git@github.com:example/project.git'],
      ['git@github.com:example/project.git', 'git@github.com:example/project.git', 'https://github.com/example/project.git'],
    ]) {
      const f = fixture()
      f.repository.repositoryUrl = shared!
      f.prepare.mockRejectedValueOnce(refused())
      await f.run()
      expect(f.prepare.mock.calls.map(call => (call as unknown[])[0])).toEqual([
        { source: 'remote', repositoryUrl: first, name: 'project-a' },
        { source: 'remote', repositoryUrl: second, name: 'project-a' },
      ])
    }
  })
  it('does not switch transport for a failure other than refused access', async () => {
    for (const failure of [new ProjectFolderError('CLONE_FAILED', 'Could not clone the repository.'),
      new ProjectFolderError('CLONE_TIMEOUT', 'Cloning took too long.'), new Error('disk full')]) {
      const f = fixture()
      f.prepare.mockRejectedValueOnce(failure)
      await expect(f.run()).rejects.toBe(failure)
      expect(f.prepare).toHaveBeenCalledOnce()
    }
  })
  it('says what the machine owner needs when neither transport can reach the repository', async () => {
    for (const second of [new RepositoryAccessError('CLONE_FAILED', 'Could not access this repository.'),
      new ProjectFolderError('CLONE_FAILED', 'Host key verification failed.'), new ProjectFolderError('CLONE_TIMEOUT', 'Cloning took too long.')]) {
      const f = fixture()
      f.prepare.mockRejectedValueOnce(new RepositoryAccessError('CLONE_FAILED', 'Could not access this repository.')).mockRejectedValueOnce(second)
      await expect(f.run()).rejects.toMatchObject({ code: 'CLONE_FAILED',
        message: expect.stringMatching(/over HTTPS or SSH.*gh auth login and gh auth setup-git.*SSH key/) })
      expect(f.prepare).toHaveBeenCalledTimes(2)
    }
    // Anything else on the second attempt is that failure, such as a folder created meanwhile.
    const f = fixture(), exists = new ProjectFolderError('PROJECT_EXISTS', '“project-a” already exists.')
    f.prepare.mockRejectedValueOnce(new RepositoryAccessError('CLONE_FAILED', 'Could not access this repository.')).mockRejectedValueOnce(exists)
    await expect(f.run()).rejects.toBe(exists)
  })
  it('refuses missing or unsafe repositories and a mismatched prepared checkout', async () => {
    const f = fixture()
    for (const url of ['file:///private/repo', 'https://secret@github.com/example/project', 'ext::command']) {
      f.repository.repositoryUrl = url as string
      await expect(f.run()).rejects.toThrow()
    }
    expect(f.prepare).not.toHaveBeenCalled()
    f.repository.repositoryUrl = 'https://github.com/example/project'
    f.prepare.mockResolvedValueOnce('/different')
    await expect(f.run()).rejects.toThrow('does not match')
  })
})

const TOKEN = `ghs_${'f'.repeat(36)}`
/** A queued start on a host whose server has the Harness GitHub App, and what the backend answers for its token. */
function hosted(answer: unknown = { github: true, token: TOKEN, repository: 'example/project', requestedBy: { name: 'Olive', email: 'olive@example.com' } }) {
  const f = fixture()
  const row = { ...f.row, githubApp: true }
  const start = { ...f.start, id: 'start-1', request: { ...f.start.request, worktree: true } }
  const backend = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
    if (answer instanceof Error) throw answer
    return answer
  })
  const fetch = vi.fn(async (_cwd: string, _env: NodeJS.ProcessEnv) => true)
  const revoke = vi.fn(async (_token: string) => {})
  return { ...f, row, start, backend, fetch, revoke,
    ready: (team = false) => prepareSwarmStart(f.core, row, start, { backend, team, prepare: f.prepare, fetch, revoke }) }
}

describe('preparing another person\'s start with the Harness GitHub App', () => {
  it('asks the backend for the start\'s token, clones over https with it alone, and fetches the default branch with it', async () => {
    const f = hosted()
    f.repository.repositoryUrl = 'git@github.com:example/project.git'
    expect(await f.ready()).toEqual({ requester: 'olive@example.com' })
    expect(f.backend).toHaveBeenCalledWith(f.core, 'POST', `/api/super-tabs/hosts/${f.core.daemon.machineId()}/starts/tab/start-1/github-token`, {})
    const [project, options] = f.prepare.mock.calls[0] as unknown as [Record<string, unknown>, { root: string; gitEnv: NodeJS.ProcessEnv }]
    expect(project).toEqual({ source: 'remote', repositoryUrl: 'https://github.com/example/project.git', name: 'project-a' })
    expect(options.root).toBe(f.root)
    expect(options.gitEnv).toMatchObject({ HARNESS_SWARM_GIT_TOKEN: TOKEN, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
    expect(f.fetch).toHaveBeenCalledWith(f.start.request.cwd, options.gitEnv)
  })

  it('fetches the branch a start names, not only the default branch: a single-branch clone has no other', async () => {
    const f = hosted()
    ;(f.start.request as Record<string, unknown>).branchRef = 'refs/remotes/origin/feature'
    await f.ready()
    expect(f.fetch).toHaveBeenCalledWith(f.start.request.cwd, expect.objectContaining({ HARNESS_SWARM_GIT_TOKEN: TOKEN }), 'refs/remotes/origin/feature')
  })

  it('leaves the machine owner\'s own project, and a server without the app, to the owner\'s login as before', async () => {
    const own = hosted({ github: false })
    expect(await own.ready()).toBeNull()
    expect(own.prepare).toHaveBeenCalledWith({ source: 'remote', repositoryUrl: 'https://github.com/example/project.git', name: 'project-a' }, { root: own.root })
    expect(own.fetch).not.toHaveBeenCalled()
    const noApp = hosted()
    delete (noApp.row as { githubApp?: boolean }).githubApp
    expect(await noApp.ready()).toBeNull()
    expect(noApp.backend).not.toHaveBeenCalled()
  })

  it('prepares nothing for a person\'s one Buddy, which has no project: no token, no clone, no fetch', async () => {
    // 2026-11-02: the token call was refused with "This start has no project folder to prepare", which failed the start.
    const app = hosted(new SuperTabHostError('NOT_FOUND', 'This start has no project folder to prepare.', 404))
    Object.assign(app.start.request, { buddyScope: 'swarm', buddyOf: { personId: 'owner', generation: 'g' } })
    expect(await app.ready()).toBeNull()
    expect(app.backend).not.toHaveBeenCalled()
    expect(app.prepare).not.toHaveBeenCalled()
    expect(app.fetch).not.toHaveBeenCalled()
    // Without the app it failed too, as a start of no project this machine was authorized for.
    delete (app.row as { githubApp?: boolean }).githubApp
    expect(await app.ready()).toBeNull()
    expect(app.prepare).not.toHaveBeenCalled()
  })

  it('in a team account, always asks for a token, and fails without one rather than using any other login', async () => {
    const team = hosted()
    expect(await team.ready(true)).toEqual({ requester: 'olive@example.com' })
    expect(team.backend.mock.calls[0]![3]).toEqual({ always: true })
    const noApp = hosted()
    delete (noApp.row as { githubApp?: boolean }).githubApp
    await expect(noApp.ready(true)).rejects.toThrow('no GitHub App, and a Harness Team account has no git login')
    expect(noApp.prepare).not.toHaveBeenCalled()
    await expect(hosted({ github: false }).ready(true)).rejects.toThrow('answered without a GitHub token')
  })

  it('fails the start when the backend refuses a token, and never prepares it with the owner\'s login instead', async () => {
    for (const answer of [new SuperTabHostError('GITHUB_APP_NOT_INSTALLED', 'The Harness GitHub App is not installed on example/project.', 409), { github: true }, { github: true, token: TOKEN, repository: 'x', requestedBy: {} }, 'nonsense']) {
      const f = hosted(answer)
      await expect(f.ready()).rejects.toThrow(answer instanceof Error ? answer.message : 'answered without a GitHub token')
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.fetch).not.toHaveBeenCalled()
    }
    const noIds = hosted()
    ;(noIds.start as { id?: string }).id = undefined
    await expect(noIds.ready()).rejects.toThrow('cannot be prepared')
  })

  // Diego's Mac, 2026-10-30: a backend timeout on the token call failed the start at once. Only an answer the backend decided
  // (a 4xx, or no app on the server: github.ts `decided`) is a refusal; anything else is for the host to try again.
  it('tells a token call the backend decided from one that got no answer, which is tried again, and prepares nothing', async () => {
    const retried = [new SuperTabHostError('BACKEND_TIMEOUT', 'The Harness server did not answer in time.', 504), new SuperTabHostError('BACKEND_UNAVAILABLE', 'Bad gateway.', 502),
      new Error('fetch failed')]
    for (const error of retried) {
      const f = hosted(error)
      const thrown = await f.ready(true).catch(caught => caught)
      expect([thrown instanceof PrepareRetryError, thrown.message]).toEqual([true,
        `This machine could not get a Harness GitHub App token for this project, so it was not prepared with its owner's own GitHub login either: ${error.message}${error instanceof SuperTabHostError ? ` (${error.code})` : ''}`])
      expect([f.prepare.mock.calls.length, f.fetch.mock.calls.length, f.revoke.mock.calls.length]).toEqual([0, 0, 0])
    }
    for (const error of [new SuperTabHostError('FORBIDDEN', 'Not this machine\'s start.', 403), new SuperTabHostError('UPDATE_REQUIRED', 'Update Harness.', 426),
      new SuperTabHostError('GITHUB_APP_NOT_CONFIGURED', 'No GitHub App.', 503), new SuperTabHostError('GITHUB_APP_MISCONFIGURED', 'GitHub refused the app.', 503)]) {
      const thrown = await hosted(error).ready(true).catch(caught => caught)
      expect([thrown instanceof PrepareRetryError, thrown.message]).toEqual([false,
        `This machine could not get a Harness GitHub App token for this project, so it was not prepared with its owner's own GitHub login either: ${error.message}`])
    }
  })

  // Security review of #2390: an answer with a token but no repository or requester failed the start and left the token good
  // for its hour. A token in an answer that is not used is revoked, never logged, and the start still fails.
  it('revokes a token the server sent in an answer it cannot use, and still fails the start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const answer of [{ github: true, token: TOKEN, repository: 'example/project', requestedBy: {} }, { github: true, token: TOKEN, requestedBy: { email: 'olive@example.com' } },
      { github: 'yes', token: TOKEN, repository: 'example/project', requestedBy: { email: 'olive@example.com' } }]) {
      const f = hosted(answer)
      await expect(f.ready(true)).rejects.toThrow('answered without a GitHub token')
      expect([f.revoke.mock.calls, f.prepare.mock.calls.length, f.fetch.mock.calls.length]).toEqual([[[TOKEN]], 0, 0])
    }
    // The owner's own project with a token beside its answer: prepared with the owner's login, the token revoked.
    const own = hosted({ github: false, token: TOKEN })
    expect(await own.ready()).toBeNull()
    expect(own.revoke.mock.calls).toEqual([[TOKEN]])
    // A revocation GitHub refuses still fails the start for its answer, and says so without the token.
    const refused = hosted({ github: true, token: TOKEN })
    refused.revoke.mockRejectedValueOnce(new Error('GitHub answered 500 to revoking the token'))
    await expect(refused.ready(true)).rejects.toThrow('answered without a GitHub token')
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual(['[super-tabs] could not revoke the clone token: GitHub answered 500 to revoking the token'])
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
    // No token in it: nothing to revoke.
    const none = hosted({ github: true })
    await expect(none.ready(true)).rejects.toThrow('answered without a GitHub token')
    expect(none.revoke).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // Kept out of this change by its Lead (10-30): a default branch that could not be fetched never fails or holds a start; the
  // worktree starts from what the checkout has, as before.
  it('starts from what the checkout has when the default branch could not be fetched', async () => {
    const f = hosted()
    f.fetch.mockResolvedValueOnce(false)
    expect(await f.ready(true)).toEqual({ requester: 'olive@example.com' })
    expect(f.revoke.mock.calls).toEqual([[TOKEN]])
  })

  it('a clone the token cannot make says so, and is not tried again another way', async () => {
    const f = hosted()
    f.prepare.mockRejectedValueOnce(new RepositoryAccessError('CLONE_FAILED', 'Could not access this repository.'))
    await expect(f.ready()).rejects.toThrow("could not clone the project repository with the Harness GitHub App's token")
    expect(f.prepare).toHaveBeenCalledTimes(1)
    f.prepare.mockRejectedValueOnce(new ProjectFolderError('PROJECT_EXISTS', 'taken'))
    // A folder already in the clone's place is named, with what to do (#3211), and not tried again either.
    await expect(f.ready()).rejects.toMatchObject({ code: 'PROJECT_EXISTS', message: expect.stringContaining('Move it aside') })
    expect(f.prepare).toHaveBeenCalledTimes(2)
  })

  // Local Team account run, 2026-10-28: the read-only token for the clone was never revoked and stayed good for its hour.
  it('revokes the read-only token once the clone and the fetch are done, and when they fail', async () => {
    const f = hosted()
    f.fetch.mockImplementationOnce(async () => { expect(f.revoke).not.toHaveBeenCalled(); return true })
    await f.ready(true)
    expect(f.revoke.mock.calls).toEqual([[TOKEN]])
    const failed = hosted()
    failed.prepare.mockRejectedValueOnce(new RepositoryAccessError('CLONE_FAILED', 'Could not access this repository.'))
    await expect(failed.ready(true)).rejects.toThrow('could not clone')
    expect(failed.revoke.mock.calls).toEqual([[TOKEN]])
    // A revocation GitHub refuses fails nothing: the token still expires within the hour.
    const refused = hosted()
    refused.revoke.mockRejectedValueOnce(new Error('GitHub did not answer'))
    expect(await refused.ready(true)).toEqual({ requester: 'olive@example.com' })
    // The owner's own login prepares the owner's own project: there is no token to revoke.
    const own = hosted({ github: false })
    await own.ready()
    expect(own.revoke).not.toHaveBeenCalled()
  })

  it('fetches into a project already on this host, and into a contribution that is not a Swarm folder, with the token', async () => {
    const f = hosted()
    f.repository.machineId = f.core.daemon.machineId()
    f.start.request.cwd = f.repository.cwd
    await f.ready()
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.fetch).toHaveBeenCalledWith('/other/repo', expect.objectContaining({ HARNESS_SWARM_GIT_TOKEN: TOKEN }))
    const legacy = hosted()
    legacy.row.machine.scope = ''
    legacy.start.request.cwd = '/repo'
    await legacy.ready()
    expect(legacy.prepare).not.toHaveBeenCalled()
    expect(legacy.fetch).toHaveBeenCalledWith('/repo', expect.objectContaining({ HARNESS_SWARM_GIT_TOKEN: TOKEN }))
    const folder = hosted()
    folder.start.request.worktree = false
    await folder.ready()
    expect(folder.fetch).not.toHaveBeenCalled()
  })

  it('startGitHub reads nothing it need not', async () => {
    const f = hosted()
    expect(await startGitHub(f.core, f.row, f.start, { backend: f.backend, team: false })).toEqual({ token: TOKEN, repository: 'example/project', requester: 'olive@example.com' })
  })
})

describe('a project\'s own empty folder, for a project with no repository (#3211)', () => {
  const withRoot = async (body: (root: string) => Promise<void>) => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'swarm-empty-folder-')))
    try { await body(join(scratch, 'swarm-projects', 'tab')) } finally { await rm(scratch, { recursive: true, force: true }) }
  }
  it('makes it once, as a git folder with no remote and no commit, and finds it again', async () => withRoot(async root => {
    const folder = await prepareEmptyProjectFolder(root, 'project-a')
    expect(folder).toBe(join(root, 'project-a'))
    expect((await lstat(join(folder, '.git'))).isDirectory()).toBe(true)
    expect(execFileSync('git', ['remote'], { cwd: folder, encoding: 'utf8' })).toBe('')
    await writeFile(join(folder, 'notes.md'), 'kept')
    expect(await prepareEmptyProjectFolder(root, 'project-a')).toBe(folder)
    expect((await lstat(join(folder, 'notes.md'))).isFile()).toBe(true)
  }))
  it('refuses a link or a file where the folder goes, and never follows a link out of the Swarm\'s folder', async () => withRoot(async root => {
    await mkdir(root, { recursive: true })
    const outside = await mkdtemp(join(tmpdir(), 'swarm-outside-'))
    try {
      await symlink(outside, join(root, 'project-a'))
      await expect(prepareEmptyProjectFolder(root, 'project-a')).rejects.toThrow(/not this project's own folder/)
      await expect(lstat(join(outside, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(join(root, 'project-b'), 'a file')
      await expect(prepareEmptyProjectFolder(root, 'project-b')).rejects.toThrow(/not this project's own folder/)
    } finally { await rm(outside, { recursive: true, force: true }) }
  }))
})

describe('preparing a start of a project with no repository (#3211)', () => {
  it('asks for no GitHub token, on the owner\'s account or a Team account, as there is nothing to clone', async () => {
    for (const team of [false, true]) {
      const f = hosted()
      f.repository.repositoryUrl = null as unknown as string
      f.start.request.worktree = false
      f.prepare.mockImplementation(async () => { throw new Error('nothing to clone') })
      expect(await prepareSwarmStart(f.core, f.row, f.start, { backend: f.backend, team, prepare: f.prepare, fetch: f.fetch, revoke: f.revoke, empty: f.empty })).toBeNull()
      expect(f.backend).not.toHaveBeenCalled()
      expect(f.empty).toHaveBeenCalledExactlyOnceWith(f.root, 'project-a')
      expect(f.fetch).not.toHaveBeenCalled()
    }
  })
  it('still asks for a project with a repository', async () => {
    const f = hosted()
    await f.ready()
    expect(f.backend).toHaveBeenCalledOnce()
    expect(f.empty).not.toHaveBeenCalled()
  })
})
