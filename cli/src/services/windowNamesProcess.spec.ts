import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { WINDOW_NAMES_REQUESTS } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { runWindowNamesService } from './windowNamesProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const agent = (agentId: string, displayName: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/work/${agentId}`, displayName }) as RegisteredSession & { displayName: string }
const ASKER = { local: true, owner: true }

describe('the window names in their own process', () => {
  afterEach(() => vi.clearAllMocks())

  const setup = () => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    /** The names the window names saw for the agents when they were asked. */
    const seen: string[][] = []
    runWindowNamesService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return { stop: vi.fn() } },
      start: (core) => {
        api = core
        return { window_name: (payload, asker) => { seen.push(core.agents.live().map((session) => core.agents.displayName(session))); return { ids: payload.agentIds, owner: asker.owner } } }
      },
    })
    return { options: options!, api: api!, seen }
  }

  it('reads the agents and the names the apps show from the core as each request starts', async () => {
    const { options, api, seen } = setup()
    expect(options).toMatchObject({ name: 'windowNames', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    // Before a core has connected: the agents it last said, which is none.
    expect(await options.requests.window_name!({ agentIds: ['a1'] }, ASKER)).toEqual({ ids: ['a1'], owner: true })
    let answer: Record<string, unknown> = { agents: [agent('a1', 'TUI layout spacing consistency')] }
    const query = vi.fn(async (_name: string) => answer)
    options.onConnected!({ query } satisfies CoreConnection)
    await options.requests.window_name!({}, ASKER)
    // `agents`, not `live`: it carries the name each agent is shown by, which a window is named from.
    expect(query).toHaveBeenLastCalledWith('agents')
    answer = { error: 'UNKNOWN_QUERY' }
    await options.requests.window_name!({}, ASKER)
    query.mockRejectedValueOnce(new Error('the core went away'))
    await options.requests.window_name!({}, ASKER)
    expect(seen).toEqual([[], ['TUI layout spacing consistency'], ['TUI layout spacing consistency'], ['TUI layout spacing consistency']])
    expect(api.agents.byAgent('a1')?.agentId).toBe('a1')
  })

  it('runs as a real service by default, answering every request the core routes to it', () => {
    runWindowNamesService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    expect(options.name).toBe('windowNames')
    expect(Object.keys(options.requests)).toEqual([...WINDOW_NAMES_REQUESTS])
  })
})
