import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { ProjectFolderError, RepositoryAccessError } from '../lib/projectFolder.js'
import { prepareSwarmProject } from './projectFolder.js'

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
