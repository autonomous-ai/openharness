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
import { resetGridModels, type GridModelsService } from './lib/gridModels.js'

const OWN = 'mine', OWN_ID = 'net-own'
const OVERVIEW = '/relay/v1/grid/overview'

let server: Server, base: string, seen: Array<{ path: string; headers: IncomingHttpHeaders }>
let overview: { status: number; body: unknown }
let root: string, gridHome: string, previousData: string, grid: FakeGrid, service: GridModelsService, clock: number
let socket: BackendSocket, frames: Array<{ type: string; payload: Record<string, unknown> }>

function plan(status: string | null = 'running'): FakeGridPlan {
  return {
    ls: { stdout: JSON.stringify([{ grid: OWN, id: OWN_ID, type: 'permissioned-public' }]) },
    [`info ${OWN}`]: { stdout: JSON.stringify({ grid: OWN, status, grid_url: `${base}/g/${OWN_ID}` }) },
  }
}

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
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers })
    const found = req.url === `/g/${OWN_ID}${OVERVIEW}` ? overview : { status: 404, body: {} }
    res.writeHead(found.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(found.body))
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
  service = resetGridModels({ now: () => clock, dataDir: () => join(root, 'data'), gridHome: () => gridHome, email: () => null })
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

describe('agent_retarget', () => {
  it('moves an agent onto a grid model without reading the grid at all', async () => {
    const answers = fakeGridAnswers()
    grid.replan(answers.plan)
    socket.onRetargetAgent = vi.fn(async () => ({ ok: true as const }))

    const reply = await ask('agent_retarget', { agentId: 'agent-1', gridModel: 'GLM-4.7-Flash', gridName: answers.gridName })

    expect(reply).toMatchObject({ retargeted: true })
    expect(seen).toEqual([])
  })
})
