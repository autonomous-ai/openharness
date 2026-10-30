// A contributed Windows machine's swarm checkout on any OS: node:path is win32's, as it is there. The Lead and the
// backend build the requested folder as `${pool.cwd}/${projectId}` (routeCommand.ts, backend machines.ts), so it
// reaches this machine as C:\…\swarm-projects\TAB/PROJECT, the same folder as the C:\…\TAB\PROJECT it expects.
import * as nodePath from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { prepareSwarmProject } from './projectFolder.js'

vi.mock('node:path', async (original) => {
  const real = await original<typeof nodePath>()
  return { ...real, ...real.win32, default: real.win32, win32: real.win32, posix: real.posix }
})
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => 'C:\\Users\\dev' }))

function fixture() {
  const core = fakeCore({ dataDir: 'C:\\Users\\dev\\.harness\\cli\\data' })
  const root = 'C:\\Users\\dev\\.harness\\cli\\data\\swarm-projects\\tab'
  const repository = { machineId: 'other', cwd: '/other/repo', repositoryUrl: 'https://github.com/example/project' }
  const row = { tabId: 'tab', machine: { scope: 'swarm', cwd: root },
    projects: [{ id: 'project-a', repository, conversationIds: ['work'] }] }
  const start = { dispatched: false, request: { conversationId: 'work', cwd: `${root}/project-a` } }
  const prepare = vi.fn(async () => `${root}\\project-a`)
  return { core, root, repository, row, start, prepare, run: () => prepareSwarmProject(core, row, start, prepare) }
}

describe('per-project checkouts on a contributed Windows swarm machine', () => {
  it('accepts the project folder the Lead and the backend join with a forward slash', async () => {
    const f = fixture()
    await f.run()
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith({
      source: 'remote', repositoryUrl: 'https://github.com/example/project.git', name: 'project-a',
    }, { root: f.root })
  })
  it('accepts the visible Swarm root with mixed Windows separators', async () => {
    const f = fixture(), root = 'C:\\Users\\dev\\harnesses\\swarms\\tab'
    f.row.machine.cwd = root
    f.start.request.cwd = `${root}/project-a`
    f.prepare.mockResolvedValueOnce(`${root}\\project-a`)
    await f.run()
    expect(f.prepare).toHaveBeenCalledWith(expect.anything(), { root })
  })
  it('accepts a repository already on this host however its separators are written', async () => {
    const f = fixture()
    f.repository.machineId = f.core.daemon.machineId()
    f.repository.cwd = 'C:\\src\\project'
    f.start.request.cwd = 'C:/src/project'
    await f.run()
    expect(f.prepare).not.toHaveBeenCalled()
  })
  it('still refuses another project or a folder outside the workspace', async () => {
    const f = fixture()
    f.start.request.cwd = `${f.root}/project-b`
    await expect(f.run()).rejects.toThrow('outside this project')
    f.start.request.cwd = `${f.root}/project-a/..\\project-b`
    await expect(f.run()).rejects.toThrow('outside this project')
    expect(f.prepare).not.toHaveBeenCalled()
  })
})
