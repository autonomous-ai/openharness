import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { ProjectFolderError, RepositoryAccessError } from '../lib/projectFolder.js'
import { prepareEmptyProjectFolder, prepareSwarmProject, prepareSwarmStart } from './projectFolder.js'

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
    run: () => prepareSwarmProject(core, row, start, prepare, empty) }
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
  // A Product Manager the Swarm starts here (backend leadStart.ts placeLead) is recorded as the project's folder on this machine: this
  // machine, and its own Swarm folder for the project. That folder is a clone Harness makes, not its owner's checkout. Taken for the
  // owner's, it was never cloned, and the PM's worktree was asked of an empty folder (the rehearsal, 2026-11-11).
  it('clones the project into its Swarm folder here though the project names that folder as its own', async () => {
    const f = fixture()
    f.repository.machineId = f.core.daemon.machineId()
    f.repository.cwd = f.start.request.cwd
    await f.run()
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith({
      source: 'remote', repositoryUrl: 'https://github.com/example/project.git', name: 'project-a',
    }, { root: f.root })
  })
  // Task #4698: a Member starts in its person's own chat, which is in no project's list, and names the project it sets up.
  it('finds a Member\'s project by the project its start names, and only one this machine was told of', async () => {
    const f = fixture()
    Object.assign(f.start.request, { conversationId: 'person-chat', member: { projectId: 'project-a' } })
    await f.run()
    expect(f.prepare).toHaveBeenCalledOnce()
    Object.assign(f.start.request, { member: { projectId: 'project-b' } })
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

/** A queued start on a Swarm folder, readied with the fixture's [prepare] and [empty]. */
function readied(request: Record<string, unknown> = {}, scope = 'swarm') {
  const f = fixture()
  f.row.machine.scope = scope
  Object.assign(f.start.request, request)
  return { ...f, ready: () => prepareSwarmStart(f.core, f.row, f.start, { prepare: f.prepare, empty: f.empty }) }
}
const CLONE = { source: 'remote', repositoryUrl: 'https://github.com/example/project.git', name: 'project-a' }

describe('preparing a queued start', () => {
  it('clones the project into the Swarm folder with this machine\'s own login', async () => {
    const f = readied({ worktree: true })
    expect(await f.ready()).toBeUndefined()
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith(CLONE, { root: f.root })
    expect(f.empty).not.toHaveBeenCalled()
  })

  // The Harness GitHub App is gone: a row that still says the server has it is prepared as any other, and asks for no token.
  it('prepares a start whose row still names the GitHub App as any other', async () => {
    const f = readied({ worktree: true })
    Object.assign(f.row, { githubApp: true })
    expect(await f.ready()).toBeUndefined()
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith(CLONE, { root: f.root })
  })

  it('prepares nothing for a Regular agent, which starts in no project', async () => {
    const f = readied({ regular: true })
    await f.ready()
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.empty).not.toHaveBeenCalled()
  })

  // Task #4698: a Member's start is a Regular agent's in its person's chat, but it sets a project up: cloned.
  it('prepares a Member\'s project though its start is a Regular agent\'s', async () => {
    const f = readied({ regular: true, conversationId: 'person-chat', member: { projectId: 'project-a' } })
    await f.ready()
    expect(f.prepare).toHaveBeenCalledOnce()
  })

  it('leaves a contribution that is not a Swarm folder as it is', async () => {
    const f = readied({ cwd: '/repo' }, '')
    await f.ready()
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.empty).not.toHaveBeenCalled()
  })

  // Task #3211: a project with no repository has nothing to clone: its own empty folder, whoever the account.
  it('makes a project with no repository its own empty folder, and clones nothing', async () => {
    const f = readied()
    f.repository.repositoryUrl = null as unknown as string
    f.prepare.mockImplementation(async () => { throw new Error('nothing to clone') })
    await f.ready()
    expect(f.empty).toHaveBeenCalledExactlyOnceWith(f.root, 'project-a')
  })
})

describe('a project\'s own empty folder, for a project with no repository (#3211)', () => {
  const withRoot = async (body: (root: string) => Promise<void>) => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'swarm-empty-folder-')))
    try { await body(join(scratch, 'swarm-projects', 'tab')) } finally { await rm(scratch, { recursive: true, force: true }) }
  }
  it('makes it once, its owner\'s alone, as a git folder with no remote and no commit, and finds it again', async () => withRoot(async root => {
    const folder = await prepareEmptyProjectFolder(root, 'project-a')
    expect(folder).toBe(join(root, 'project-a'))
    // Its owner's alone, as the work in it is (security review 1 of #3137, Minor).
    expect((await lstat(folder)).mode & 0o777).toBe(0o700)
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
