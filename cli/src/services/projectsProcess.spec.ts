import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { PROJECTS_REQUESTS } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { runProjectsService } from './projectsProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const agent = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/work/${agentId}` }) as RegisteredSession
const ASKER = { local: true, owner: true }

describe('the project readers in their own process', () => {
  afterEach(() => vi.clearAllMocks())

  const setup = () => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    /** What each reader saw of the live agents when it was asked. */
    const seen: string[][] = []
    runProjectsService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return { stop: vi.fn() } },
      start: (core) => {
        api = core
        return { git_project_info: (payload, asker) => { seen.push(core.agents.live().map((session) => session.agentId)); return { path: payload.path, owner: asker.owner } } }
      },
    })
    return { options: options!, api: api!, seen }
  }

  it('reads the live agents from the core as each request starts, and answers as the core\'s readers do', async () => {
    const { options, api, seen } = setup()
    expect(options).toMatchObject({ name: 'projects', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    // Before a core has connected: the agents it last said, which is none.
    expect(await options.requests.git_project_info!({ path: '/work' }, ASKER)).toEqual({ path: '/work', owner: true })
    let answer: Record<string, unknown> = { agents: [agent('a1')] }
    const query = vi.fn(async (_name: string) => answer)
    options.onConnected!({ query } satisfies CoreConnection)
    await options.requests.git_project_info!({ path: '/work' }, ASKER)
    expect(query).toHaveBeenLastCalledWith('live')
    answer = { agents: [agent('a1'), agent('a2')] }
    await options.requests.git_project_info!({ path: '/work' }, ASKER)
    // A core that cannot say leaves what it said last.
    answer = { error: 'UNKNOWN_QUERY' }
    await options.requests.git_project_info!({ path: '/work' }, ASKER)
    query.mockRejectedValueOnce(new Error('the core went away'))
    await options.requests.git_project_info!({ path: '/work' }, ASKER)
    expect(seen).toEqual([[], ['a1'], ['a1', 'a2'], ['a1', 'a2'], ['a1', 'a2']])
    expect(api.agents.resolve('s-a2')).toEqual(agent('a2'))
  })

  it('runs as a real service by default, answering every request the core routes to the readers', () => {
    runProjectsService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    expect(options.name).toBe('projects')
    expect(Object.keys(options.requests).sort()).toEqual([...PROJECTS_REQUESTS].sort())
  })
})
