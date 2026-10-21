import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
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
