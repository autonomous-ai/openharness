import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type CorePorts, type TurnDelivery } from '../core/api.js'
import type { InstalledDsh } from '../dsh/installed.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { OrchestratorDependencies } from '../orchestrator/service.js'
import { fakeCore } from '../testing/fakeCore.js'

/** The dependencies each service was built with: what the socket used to hand it, now the core's API. */
const built = vi.hoisted(() => [] as OrchestratorDependencies[])
vi.mock('../orchestrator/service.js', async (original) => {
  const actual = await original<typeof import('../orchestrator/service.js')>()
  return {
    ...actual,
    OrchestratorService: class extends actual.OrchestratorService {
      constructor(deps: OrchestratorDependencies) { super(deps); built.push(deps) }
    },
  }
})
const { startOrchestrator, ORCHESTRATOR_REQUESTS } = await import('./orchestrator.js')

const owner = { local: true, owner: true }
const agent = (agentId: string, over: Partial<RegisteredSession> = {}) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/w', ...over }) as RegisteredSession
const harness = (id: string, manifest: Record<string, unknown>, source = 'https://example.invalid/x') =>
  ({ id, source, manifest: { name: id, ...manifest } }) as unknown as InstalledDsh

describe('the orchestrator, as a service', () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'orchestrator-service-'))
    built.length = 0
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const start = (over: Parameters<typeof fakeCore>[0] = {}, options: Parameters<typeof startOrchestrator>[2] = {}) => {
    const listeners: Array<(event: TurnDelivery) => void> = []
    const stopHearing = vi.fn()
    const core = fakeCore({
      dataDir,
      ...over,
      turns: { onDelivery: vi.fn((listener: (event: TurnDelivery) => void) => { listeners.push(listener); return stopHearing }), ...over.turns },
    })
    const ports: CorePorts = emptyPorts()
    const requests = startOrchestrator(core, ports, { workspaceDir: join(dataDir, 'work'), ...options })
    return { core, ports, port: ports.orchestrator!, requests, listeners, stopHearing }
  }

  it('declares the one request it answers, and makes its projects\' workspaces under the home by default', async () => {
    expect(ORCHESTRATOR_REQUESTS).toEqual(['orchestrator'])
    const { requests } = start({}, { workspaceDir: undefined })
    await requests.orchestrator({ action: 'list' }, owner)
    expect(built[0].workspaceDir).toBe(join(homedir(), 'harnesses', 'orchestrated'))
  })

  it('answers a turn end "no role" without building itself on a machine that has no project', () => {
    // Asked at every turn's end. Building the service makes its folder and parses every saved run, and
    // from then on every frame sent is handed to it.
    const { port } = start()
    expect(port.roleOf('agent-1')).toBeNull()
    expect(port.roleOf('agent-2')).toBeNull()
    expect(existsSync(join(dataDir, 'orchestrator'))).toBe(false)
    expect(built).toHaveLength(0)
    // Not built, it reads no frame.
    expect(port.frame({ type: 'turn_started', agentId: 'agent-1' })).toBeUndefined()
  })

  it('answers a turn end from a project an earlier run of the daemon saved', () => {
    const stateDir = join(dataDir, 'orchestrator')
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const id = 'a'.repeat(32)
    const task = { id: 'part', title: 'Part', harness: 'cad', prompt: 'Draw the part', dependsOn: [], state: 'running', attempt: 1, agentId: 'agent-worker', cwd: stateDir, summary: '', error: null, uncertain: false, artifacts: [], inputs: {} }
    writeFileSync(join(stateDir, `${id}.json`), JSON.stringify({
      version: 1, id, fingerprint: 'f', prompt: 'Build the robot', engine: 'claude', bypassPermission: false, parallelism: 3,
      root: stateDir, directorId: 'agent-director', directorWorking: false, state: 'active', error: null,
      tasks: [task], messages: [], revision: 1, createdAt: 1, updatedAt: 1,
    }), { mode: 0o600 })
    const { port } = start()
    expect(port.roleOf('agent-worker')).toEqual({ role: 'worker' })
    expect(port.roleOf('agent-director')).toEqual({ role: 'director', busy: true })
    expect(port.roleOf('agent-other')).toBeNull()
  })

  it('leaves an orchestrator folder it cannot list to the service to report, as before', () => {
    writeFileSync(join(dataDir, 'orchestrator'), 'not a folder')
    const { port } = start()
    expect(() => port.roleOf('agent-1')).toThrow()
  })

  it('answers an owner\'s requests, refuses anyone else\'s, and answers a request that fails outright as failed', async () => {
    const { requests } = start()
    expect(await requests.orchestrator({ action: 'list' }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
    expect(await requests.orchestrator({ action: 'list' }, owner)).toEqual({ projects: [] })
    const failing = start({}, { request: async () => { throw new Error('boom') } })
    expect(await failing.requests.orchestrator({ action: 'list' }, owner)).toEqual({ error: 'ORCHESTRATOR_FAILED' })
  })

  it('once built, reads the frames and the deliveries the core says, and stops with the core', async () => {
    const { port, requests, listeners, stopHearing } = start()
    const event: TurnDelivery = { deliveryId: 'd1', sessionId: 'agent-1', state: 'started' }
    // Not built: nothing to tell.
    for (const listener of listeners) listener(event)
    await requests.orchestrator({ action: 'list' }, owner)
    const service = built.length
    expect(service).toBe(1)
    for (const listener of listeners) listener(event)
    expect(port.frame({ type: 'turn_started', agentId: 'agent-1' })).toBeUndefined()
    port.stop()
    expect(stopHearing).toHaveBeenCalledOnce()
    // Stopped before it was built: nothing to stop but the hearing.
    const idle = start()
    idle.port.stop()
    expect(idle.stopHearing).toHaveBeenCalledOnce()
  })

  it('gives the service what the socket gave it, from the core\'s API', async () => {
    const live = new Map([['agent-1', agent('agent-1', { launch: { state: 'failed', error: 'E_LAUNCH', detail: 'it would not start' } } as never)], ['agent-2', agent('agent-2', { launch: { state: 'failed', error: 'E_ONLY' } } as never)], ['agent-3', agent('agent-3')]])
    const deliver = vi.fn()
    const cancelDelivery = vi.fn(() => true)
    const stop = vi.fn()
    const windows = vi.fn()
    const create = vi.fn(async () => ({ ok: true as const, agentId: 'made' }))
    const probe = vi.fn(async (engines?: readonly string[]) => (engines ?? []).map((engine) => ({ engine, installed: engine === 'claude' })))
    const { requests } = start({
      agents: {
        resolve: (id: string) => live.get(id),
        dsh: (session: RegisteredSession) => (session.agentId === 'agent-3' ? { viewerUrl: 'http://127.0.0.1:9/', viewerName: 'CAD' } as never : null),
        create,
      },
      turns: { deliver, cancelDelivery, stop },
      clients: { windows },
      daemon: { command: `'/usr/bin/node' '/app/cli.js'`, port: 18473, machineId: () => "it's" },
    }, {
      probe: probe as never,
      installed: () => [
        harness('cad', { engine: 'claude', description: 'Parts', viewer: { command: 'x' } }),
        harness('plain', { engine: 'codex' }),
        harness('viewer-only', { engine: 'claude', kind: 'viewer' }),
        harness('no-engine', {}),
        harness('hidden', { engine: 'claude' }, 'builtin:pair'),
      ],
    })
    await requests.orchestrator({ action: 'list' }, owner)
    const deps = built[0]
    expect(deps.stateDir).toBe(join(dataDir, 'orchestrator'))
    expect(deps.workspaceDir).toBe(join(dataDir, 'work'))
    // The command the agents it runs reach this daemon with, its machine quoted for the shell.
    expect(deps.command).toBe(`'/usr/bin/node' '/app/cli.js' orchestrator --port 18473 --machine 'it'"'"'s'`)
    expect(deps.catalog()).toEqual([
      { id: 'cad', name: 'cad', description: 'Parts', engine: 'claude', viewer: true },
      { id: 'plain', name: 'plain', description: '', engine: 'codex', viewer: false },
    ])
    expect(deps.supportsEngine('claude')).toBe(true)
    expect(deps.supportsEngine('no-such-engine')).toBe(false)
    const request = { engine: 'claude' as const, cwd: '/w', dsh: null, prompt: 'Plan it', name: 'Director', bypassPermission: false }
    expect(await deps.create(request)).toEqual({ agentId: 'made' })
    expect(create).toHaveBeenCalledWith(request)
    await expect(deps.create({ ...request, engine: 'codex' })).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED' })
    create.mockResolvedValueOnce({ ok: false, error: 'CREATE_FAILED', detail: 'no room' } as never)
    await expect(deps.create(request)).rejects.toMatchObject({ code: 'CREATE_FAILED', message: 'no room' })
    create.mockResolvedValueOnce({ ok: false, error: 'CREATE_FAILED' } as never)
    await expect(deps.create(request)).rejects.toMatchObject({ code: 'CREATE_FAILED', message: 'CREATE_FAILED' })
    deps.send('agent-1', 'Go', 'm1')
    deps.send('agent-1', 'Go again')
    expect(deliver.mock.calls).toEqual([['agent-1', 'Go', 'm1'], ['agent-1', 'Go again', '']])
    expect(() => deps.send('nobody', 'Go', 'm2')).toThrow('not available to receive a message')
    expect(deps.cancelDelivery!('m1')).toBe(true)
    deps.cancel('agent-1')
    expect(stop).toHaveBeenCalledWith('agent-1')
    expect(deps.agent('nobody')).toBeNull()
    expect(deps.agent('agent-1')).toEqual({ viewerUrl: undefined, viewerName: undefined, error: 'it would not start' })
    expect(deps.agent('agent-2')).toEqual({ viewerUrl: undefined, viewerName: undefined, error: 'E_ONLY' })
    expect(deps.agent('agent-3')).toEqual({ viewerUrl: 'http://127.0.0.1:9/', viewerName: 'CAD', error: null })
    deps.changed!('p1', 4)
    expect(windows).toHaveBeenCalledWith({ type: 'orchestrator_changed', payload: { id: 'p1', revision: 4 } })
  })
})
