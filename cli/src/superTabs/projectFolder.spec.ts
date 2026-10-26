import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { ProjectFolderError, RepositoryAccessError } from '../lib/projectFolder.js'
import { prepareSwarmProject, prepareSwarmStart, startGitHub } from './projectFolder.js'

function fixture() {
  const core = fakeCore({ dataDir: '/isolated-project-fixture' })
  const root = join(core.dataDir, 'swarm-projects', 'tab')
  const repository = { machineId: 'other', cwd: '/other/repo', repositoryUrl: 'https://github.com/example/project' }
  const row = { tabId: 'tab', machine: { scope: 'swarm', cwd: root },
    projects: [{ id: 'project-a', repository, conversationIds: ['work'] }] }
  const start = { dispatched: false, request: { conversationId: 'work', cwd: join(root, 'project-a') } }
  const prepare = vi.fn(async () => start.request.cwd)
  return { core, root, repository, row, start, prepare,
    run: () => prepareSwarmProject(core, row, start, prepare) }
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
  it('tells the lead how to share a project recorded without a repository address', async () => {
    const f = fixture()
    f.repository.repositoryUrl = null as unknown as string
    await expect(f.run()).rejects.toThrow(/Share a GitHub repository.*project\.repository command/)
    expect(f.prepare).not.toHaveBeenCalled()
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
    for (const url of [undefined, 'file:///private/repo', 'https://secret@github.com/example/project', 'ext::command']) {
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
  return { ...f, row, start, backend, fetch,
    ready: (team = false) => prepareSwarmStart(f.core, row, start, { backend, team, prepare: f.prepare, fetch }) }
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
    for (const answer of [new Error('The Harness GitHub App is not installed on example/project.'), { github: true }, { github: true, token: TOKEN, repository: 'x', requestedBy: {} }, 'nonsense']) {
      const f = hosted(answer)
      await expect(f.ready()).rejects.toThrow(answer instanceof Error ? answer.message : 'answered without a GitHub token')
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.fetch).not.toHaveBeenCalled()
    }
    const noIds = hosted()
    ;(noIds.start as { id?: string }).id = undefined
    await expect(noIds.ready()).rejects.toThrow('cannot be prepared')
  })

  it('a clone the token cannot make says so, and is not tried again another way', async () => {
    const f = hosted()
    f.prepare.mockRejectedValueOnce(new RepositoryAccessError('CLONE_FAILED', 'Could not access this repository.'))
    await expect(f.ready()).rejects.toThrow("could not clone the project repository with the Harness GitHub App's token")
    expect(f.prepare).toHaveBeenCalledTimes(1)
    f.prepare.mockRejectedValueOnce(new ProjectFolderError('PROJECT_EXISTS', 'taken'))
    await expect(f.ready()).rejects.toThrow('taken')
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
