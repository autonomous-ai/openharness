/**
 * The daemon's grid RPCs as a desktop drives them — `grid_models_list`, the Model Manager's
 * `grid_fleet_models_list` and `agent_retarget` — against a fake relay that records every request it
 * receives, and a fake `grid` first on PATH (grid-reads-without-waking issue 02).
 *
 * The relay is the spy: nothing here recomputes what the daemon sends, it reads what arrived.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendSocket } from './backendSocket.js'
import { env } from './config/env.js'
import { fakeGridAnswers, installFakeGrid, type FakeGrid, type FakeGridPlan } from './lib/__fixtures__/fakeGrid.js'
import { clearGridMcpUrlCache } from './lib/gridMcpUrl.js'
import { observeMachineList, resetGridModels, type GridModelsService } from './lib/gridModels.js'

const OWN = 'mine', OWN_ID = 'net-own'
const OVERVIEW = '/relay/v1/grid/overview'

let server: Server, base: string, seen: Array<{ path: string; headers: IncomingHttpHeaders }>
let overview: { status: number; body: unknown }
/** The relay's signed-in `/models` — what a person's act reads, held as long as a test says. */
let modelsDelayMs: number
let root: string, gridHome: string, previousData: string, grid: FakeGrid, service: GridModelsService, clock: number
let socket: BackendSocket, frames: Array<{ type: string; payload: Record<string, unknown> }>

const TOKEN = fakeGridAnswers().token

function plan(status: string | null = 'running'): FakeGridPlan {
  return {
    ls: { stdout: JSON.stringify([{ grid: OWN, id: OWN_ID, type: 'permissioned-public' }]) },
    [`info ${OWN}`]: { stdout: JSON.stringify({ grid: OWN, status, grid_url: `${base}/g/${OWN_ID}` }) },
    [`info ${OWN} --env`]: { stdout: `export OPENAI_BASE_URL="${base}/g/${OWN_ID}/relay/v1"\nexport OPENAI_API_KEY="${TOKEN}"\n` },
    mcp: fakeGridAnswers().plan.mcp!,
  }
}

const modelReads = (): Array<{ path: string; headers: IncomingHttpHeaders }> => seen.filter((r) => r.path === `/g/${OWN_ID}/relay/v1/models`)

/** What `GET /api/machines` answers, with `studio` offline. */
const studioOffline = { success: true, data: { machines: [{ machineId: 'studio-id', computerId: 'studio-id', hostname: 'studio', name: 'Studio', status: 'offline' }] } }

async function ask(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const requestId = `${type}-${frames.length}`
  socket.handleLocalFrame('local:grid-reads', { type, payload: { ...payload, requestId } })
  await vi.waitFor(() => expect(frames.some((f) => f.payload.requestId === requestId)).toBe(true), { timeout: 10_000 })
  return frames.find((f) => f.payload.requestId === requestId)!.payload
}

function expectNoCredential(): void {
  for (const request of seen) {
    expect(request.headers.authorization).toBeUndefined()
    expect(request.headers['x-api-key']).toBeUndefined()
  }
}

beforeEach(async () => {
  seen = []
  overview = { status: 200, body: { nodes: [{ name: 'mac', engine: 'llama.cpp', models: ['small-q4'], online: true }], models: [{ id: 'Small-Q4' }] } }
  modelsDelayMs = 0
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers })
    const models = req.url === `/g/${OWN_ID}/relay/v1/models`
    const found = req.url === `/g/${OWN_ID}${OVERVIEW}` ? overview : models ? { status: 200, body: { data: [] } } : { status: 404, body: {} }
    const timer = setTimeout(() => {
      res.writeHead(found.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(found.body))
    }, models ? modelsDelayMs : 0)
    res.on('close', () => clearTimeout(timer))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  root = mkdtempSync(join(tmpdir(), 'grid-reads-rpc-'))
  gridHome = join(root, 'grid-home')
  mkdirSync(gridHome, { recursive: true })
  vi.stubEnv('GRID_HOME', gridHome)
  previousData = env.ADAPTER_DATA_DIR
  env.ADAPTER_DATA_DIR = join(root, 'data')
  clock = Date.parse('2026-09-24T10:00:00Z')
  // Before the socket, which subscribes to the service it finds for its `grid_models_changed` push.
  service = resetGridModels({
    now: () => clock, dataDir: () => join(root, 'data'), gridHome: () => gridHome, email: () => null,
    // An explicit wake's 3 s pauses move the clock instead of the test.
    sleep: async (ms) => { clock += ms },
  })
  grid = installFakeGrid(plan())
  socket = new BackendSocket('token')
  socket.setHarnessGridName(OWN)
  frames = []
  socket.registerLocalClient('local:grid-reads', { sendFrame: (frame) => { frames.push(frame as typeof frames[number]); return true }, sendBinary: () => true })
})

afterEach(async () => {
  await service.settled()
  await socket.unregisterLocalClient('local:grid-reads')
  await socket.stop()
  grid.dispose()
  clearGridMcpUrlCache()
  env.ADAPTER_DATA_DIR = previousData
  vi.unstubAllEnvs()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

describe('grid_models_list', () => {
  it('answers in the old shape with the three new fields, and reads the grid with no credential', async () => {
    const reply = await ask('grid_models_list')

    expect(reply).toMatchObject({ gridName: OWN, models: [{ id: 'Small-Q4', node: 'mac' }] })
    expect(reply.grids).toEqual([{
      name: OWN, type: 'permissioned-public', own: true, models: [{ id: 'Small-Q4', node: 'mac' }],
      state: 'awake', seenAt: new Date(clock).toISOString(), lastKnownAge: 0,
    }])
    expect(seen.map((r) => r.path)).toEqual([`/g/${OWN_ID}${OVERVIEW}`])
    expectNoCredential()
  })

  it('pushes grid_models_changed when a read it did not wait for changes the list', async () => {
    await ask('grid_models_list')
    clock += 20_000
    overview = { status: 200, body: { nodes: [{ name: 'mac', engine: 'llama.cpp', models: ['small-q4', 'big-q8'] }], models: [] } }

    const reply = await ask('grid_models_list')
    // Answered at once from the picture; the read it started lands behind it and is pushed.
    expect((reply.models as unknown[]).length).toBe(1)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'grid_models_changed')).toBe(true), { timeout: 5_000 })

    const pushed = frames.find((f) => f.type === 'grid_models_changed')!.payload
    expect(pushed).not.toHaveProperty('requestId')
    expect(pushed).toMatchObject({ gridName: OWN, models: [{ id: 'Small-Q4', node: 'mac' }, { id: 'big-q8', node: 'mac' }], supportsModelLaunch: true })
    // Two overview reads, and one of provider discovery: `big-q8` had no spelling from any other source.
    expect(seen.map((r) => r.path)).toEqual([`/g/${OWN_ID}${OVERVIEW}`, `/g/${OWN_ID}${OVERVIEW}`, `/g/${OWN_ID}/nodes/discover`])
    expectNoCredential()
  })
})

describe('grid_fleet_models_list (the Model Manager) on a sleeping own grid', () => {
  it('is not an inventory error, keeps Start and Pause enabled, and reports a parked engine running', async () => {
    grid.replan(plan('asleep'))
    overview = { status: 503, body: { detail: 'resting', code: 'grid_asleep' } }
    const records = join(gridHome, 'run', 'engines', OWN_ID)
    mkdirSync(records, { recursive: true })
    writeFileSync(join(records, 'remote.json'), JSON.stringify({
      node_id: 'node-1', meta_name: 'mac', pid: process.pid, engines: [{ endpoint_url: null, models: ['Small-Q4.gguf'] }], advertise_as: [],
    }))

    const reply = await ask('grid_fleet_models_list', { refresh: true })

    expect(reply.error).not.toBe('Running models could not be checked. Try again.')
    expect(reply.models).toEqual([expect.objectContaining({ id: 'local:Small-Q4.gguf', state: 'running', gridAsleep: true, canStop: true })])
    expect(seen.map((r) => r.path)).toEqual([`/g/${OWN_ID}${OVERVIEW}`])
    expectNoCredential()
    // The owner status is asked once and remembered, not asked on every tick.
    await ask('grid_fleet_models_list', { refresh: true })
    await ask('grid_fleet_models_list', { refresh: true })
    expect(grid.calls().filter((argv) => argv.includes('info'))).toHaveLength(1)
    expect(grid.calls().some((argv) => argv.includes('engines'))).toBe(false)
  })
})

describe('grid_models_list — a person\'s explicit wake (issue 03)', () => {
  it('answers "waking" at once — well inside the app\'s timeout — while its one credentialed read is still held', async () => {
    overview = { status: 503, body: { detail: 'resting', code: 'grid_asleep' } }
    await ask('grid_models_list')
    // The proxy holds a signed-in read of a sleeping grid while its master boots; nothing may wait on it.
    modelsDelayMs = 20_000

    const started = Date.now()
    const reply = await ask('grid_models_list', { wake: [OWN], rowState: true })

    expect(Date.now() - started).toBeLessThan(5_000)
    expect((reply.grids as Array<Record<string, unknown>>)[0]).toMatchObject({ name: OWN, state: 'waking' })
    await vi.waitFor(() => expect(modelReads()).toHaveLength(1), { timeout: 5_000 })
    expect(modelReads()[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(modelReads()[0]!.headers['user-agent']).toMatch(/^autonomous-harness\/\S+ \(wake\)$/)
    // It ends, and says so to the window without being asked.
    await service.settled()
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'grid_models_changed'
      && (f.payload.grids as Array<Record<string, unknown>>)[0]?.wakeOutcome === 'not_started')).toBe(true), { timeout: 5_000 })
  })
})

describe('grid_models_list — computers of mine that seem offline (issue 03)', () => {
  async function studioServingThenAsleep(): Promise<void> {
    overview = { status: 200, body: { nodes: [{ name: 'studio', engine: 'llama.cpp', models: ['big-model'] }], models: [] } }
    await ask('grid_models_list')
    clock += 125_000
    overview = { status: 503, body: { detail: 'resting', code: 'grid_asleep' } }
    await ask('grid_models_list')
    await service.settled()
  }
  const rows = (payload: Record<string, unknown>) => (payload.grids as Array<{ models: unknown[] }>)[0]!.models

  it('labels the row as `unavailable` for a window that asks for row state, and in the node text for one that does not', async () => {
    await studioServingThenAsleep()
    observeMachineList(studioOffline, 'computer-here')
    clock += 60_000
    observeMachineList(studioOffline, 'computer-here')

    expect(rows(await ask('grid_models_list', { rowState: true }))).toEqual([
      { id: 'big-model', node: 'studio', unavailable: { reason: 'offline', machine: 'Studio', since: new Date(clock - 60_000).toISOString() } },
    ])
    expect(rows(await ask('grid_models_list'))).toEqual([{ id: 'big-model', node: 'Studio · seems offline' }])
  })

  it('pushes each window the form it asked for', async () => {
    await studioServingThenAsleep()
    const old: typeof frames = []
    socket.registerLocalClient('local:old-build', { sendFrame: (frame) => { old.push(frame as typeof frames[number]); return true }, sendBinary: () => true })
    await ask('grid_models_list', { rowState: true })
    frames.length = 0

    observeMachineList(studioOffline, 'computer-here')
    clock += 60_000
    observeMachineList(studioOffline, 'computer-here')

    await vi.waitFor(() => expect(frames.some((f) => f.type === 'grid_models_changed')).toBe(true), { timeout: 5_000 })
    await vi.waitFor(() => expect(old.some((f) => f.type === 'grid_models_changed')).toBe(true), { timeout: 5_000 })
    expect(rows(frames.find((f) => f.type === 'grid_models_changed')!.payload)).toEqual([expect.objectContaining({ node: 'studio', unavailable: expect.anything() })])
    expect(rows(old.find((f) => f.type === 'grid_models_changed')!.payload)).toEqual([{ id: 'big-model', node: 'Studio · seems offline' }])
    await socket.unregisterLocalClient('local:old-build')
  })
})

describe('agent_retarget', () => {
  beforeEach(() => { socket.onRetargetAgent = vi.fn(async () => ({ ok: true as const })) })

  it('onto a grid that is asleep, starts it with one credentialed read marked (prewarm) — and the move does not wait on it', async () => {
    overview = { status: 200, body: { nodes: [{ name: 'mac', engine: 'llama.cpp', models: ['small-q4'] }], models: [{ id: 'Small-Q4' }] } }
    await ask('grid_models_list')
    clock += 125_000
    overview = { status: 503, body: { detail: 'resting', code: 'grid_asleep' } }
    await ask('grid_models_list')
    await service.settled()
    modelsDelayMs = 20_000
    seen.length = 0

    const started = Date.now()
    const reply = await ask('agent_retarget', { agentId: 'agent-1', gridModel: 'Small-Q4', gridName: OWN })

    expect(reply).toMatchObject({ retargeted: true })
    expect(Date.now() - started).toBeLessThan(5_000)
    await vi.waitFor(() => expect(modelReads()).toHaveLength(1), { timeout: 5_000 })
    expect(modelReads()[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(modelReads()[0]!.headers['user-agent']).toMatch(/^autonomous-harness\/\S+ \(prewarm\)$/)
  })

  it('onto a grid seen awake a moment ago, reads nothing at all', async () => {
    await ask('grid_models_list')
    await service.settled()
    seen.length = 0
    clock += 10_000

    const reply = await ask('agent_retarget', { agentId: 'agent-1', gridModel: 'Small-Q4', gridName: OWN })

    expect(reply).toMatchObject({ retargeted: true })
    // The move is a person's act and may wake a grid — this one needs no waking, and the context window
    // comes from the picture, so nothing at all reaches the grid.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(seen).toEqual([])
  })

  it('a move that is refused starts nothing', async () => {
    overview = { status: 503, body: { detail: 'resting', code: 'grid_asleep' } }
    await ask('grid_models_list')
    await service.settled()
    socket.onRetargetAgent = vi.fn(async () => ({ ok: false as const, error: 'ENGINE_NOT_CAPABLE' }))
    seen.length = 0

    expect(await ask('agent_retarget', { agentId: 'agent-1', gridModel: 'Small-Q4', gridName: OWN })).toMatchObject({ error: 'ENGINE_NOT_CAPABLE' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(modelReads()).toEqual([])
  })
})
