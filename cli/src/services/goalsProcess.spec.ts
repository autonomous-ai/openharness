import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GOALS_REQUESTS } from '../core/api.js'
import { HACHI_ID } from '../dsh/builtinIds.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { runGoalsService } from './goalsProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const hachi = { agentId: 'hachi', sessionId: 's-hachi', engine: 'claude', cwd: '/h', dsh: HACHI_ID, runtimes: [{ backend: 'tmux', paneId: '%1' }] }
const LOCAL = { local: true, owner: true }

describe('Hachi\'s goals in their own process', () => {
  let dir = ''
  afterEach(() => { vi.clearAllMocks(); if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('reads the live agents from the core as each request starts: the pane asking is the core\'s to say', async () => {
    dir = mkdtempSync(join(tmpdir(), 'goals-process-'))
    let options: ServiceProcessOptions | null = null
    runGoalsService({ dataDir: dir, socketPath: join(dir, 'daemon.sock'), machineId: 'm', token: 't', run: (given) => { options = given; return { stop: vi.fn() } } })
    const { requests, onConnected, name } = options!
    expect(name).toBe('goals')
    // Before a core has connected it knows no harness, so nobody is Hachi.
    expect(await requests.goal_open!({ pane: '%1', title: 'ship it' }, LOCAL)).toMatchObject({ error: 'NOT_HACHI' })
    let answer: Record<string, unknown> = { agents: [hachi] }
    const query = vi.fn(async (_name: string) => answer)
    onConnected!({ query } satisfies CoreConnection)
    expect(await requests.goal_open!({ pane: '%1', title: 'ship it' }, LOCAL)).toMatchObject({ goal: { title: 'ship it' } })
    expect(query).toHaveBeenCalledWith('live')
    // Its measures are counted by the core (core/agentQueries.ts `count`).
    expect(query).toHaveBeenLastCalledWith('count', { metric: 'hachi_goal_opened' })
    // A goal it closes is told to the windows through the core (core/agentQueries.ts `hachi_goal_done`).
    const goal = (await requests.goal_open!({ pane: '%1', title: 'flaky' }, LOCAL)).goal as { id: string }
    await requests.goal_add!({ pane: '%1', id: goal.id, machineId: 'm', creationId: 'c1' }, LOCAL)
    await requests.goal_done!({ pane: '%1', id: goal.id }, LOCAL)
    expect(query).toHaveBeenCalledWith('hachi_goal_done', { agentId: 'hachi', goalId: goal.id, title: 'flaky' })
    // A core that cannot say leaves what it said last.
    answer = { error: 'UNKNOWN_QUERY' }
    query.mockRejectedValueOnce(new Error('the core went away'))
    expect((await requests.goal_list!({ pane: '%1' }, LOCAL)).goals).toHaveLength(2)
    expect((await requests.goal_list!({ pane: '%1' }, LOCAL)).goals).toHaveLength(2)
  })

  it('runs as a real service by default, answering every request the core routes to it', () => {
    runGoalsService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    expect(options.name).toBe('goals')
    expect(Object.keys(options.requests).sort()).toEqual([...GOALS_REQUESTS].sort())
  })
})
