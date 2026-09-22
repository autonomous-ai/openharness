import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Frame, LocalClientSink } from '../backendSocket.js'
import { attachLocalWsServer, type LocalWsBackend, type LocalWsServer } from '../localWsServer.js'
import { GridSwitchDriver, LOCAL_WS_PATH, runGridSwitchFlow } from './gridSwitchDriver.js'

const machineId = 'machine-abc'
const agentId = 'session-1'
const GRID_MODEL = 'grid:gpt-5-mini' // a model id the daemon's grid_models_list would report

/**
 * A local backend that answers the SAME RPCs the real daemon answers, using the SAME frame
 * convention (`{ type, payload: { requestId, ...} }`). This is the seam the driver talks to —
 * in a live run it is the actual BackendSocket in the daemon; here it stands in so the test
 * is offline and costs $0, while still exercising the real WebSocket transport.
 */
class FakeDaemon implements LocalWsBackend {
  sink: LocalClientSink | null = null
  connId: string | null = null
  received: Array<{ type: string; payload: Record<string, unknown> }> = []
  retargetCalls: Array<{ clear: boolean; model?: string; gridName?: string }> = []

  registerLocalClient(connId: string, sink: LocalClientSink): boolean {
    this.connId = connId
    this.sink = sink
    return true
  }

  async unregisterLocalClient(connId: string): Promise<void> {
    this.received.push({ type: '__unregister', payload: { connId } })
  }

  send(type: string, payload: Record<string, unknown>): void {
    this.sink?.sendFrame({ type, payload } as Frame)
  }

  handleLocalFrame(_connId: string, frame: Frame): void {
    const type = frame.type as string
    const payload = (frame.payload as Record<string, unknown>) ?? {}
    this.received.push({ type, payload })
    const requestId = payload.requestId as string | undefined
    switch (type) {
      case 'machine_select': {
        this.send('connected', {
          requestId,
          machineId,
          transport: 'local',
          e2ee: false,
        } as unknown as Record<string, unknown>)
        break
      }
      case 'grid_models_list': {
        this.send('grid_models_list', {
          requestId,
          gridName: 'someone-7f3a91c4',
          models: [{ id: GRID_MODEL, node: 'node-x' }],
          grids: [
            {
              name: 'shared-lab',
              own: false,
              models: [{ id: 'shared:opus', node: 'node-y' }],
            },
          ],
          localModelEngines: ['codex', 'claude'],
          gridCli: { version: '1.0.0' },
        } as unknown as Record<string, unknown>)
        break
      }
      case 'agent_retarget': {
        const clear = payload.clearGrid === true
        const model = typeof payload.gridModel === 'string' ? payload.gridModel : undefined
        const gridName = typeof payload.gridName === 'string' ? payload.gridName : undefined
        this.retargetCalls.push({ clear, model, gridName })
        // Absent gridModel + clear==false is an invalid frame, exactly as the daemon refuses it.
        if (!clear && !model) {
          this.send('agent_retarget', { requestId, error: 'INVALID_GRID', detail: 'grid is required' })
          break
        }
        this.send('agent_retarget', { requestId, retargeted: true })
        break
      }
      default:
        this.send(type, { requestId, error: 'UNSUPPORTED' })
    }
  }

  async handleLocalBinary(): Promise<void> {}
}

describe('GridSwitchDriver (talks to the daemon like the app)', () => {
  let server: http.Server | null = null
  let local: LocalWsServer | null = null
  let daemon: FakeDaemon | null = null

  afterEach(async () => {
    await local?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
    local = null
    server = null
    daemon = null
  })

  async function startDaemon(): Promise<string> {
    daemon = new FakeDaemon()
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    local = attachLocalWsServer(server, { machineId, backend: daemon })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    return `ws://127.0.0.1:${port}${LOCAL_WS_PATH}`
  }

  it('performs the full app journey and records every value/step', async () => {
    const url = await startDaemon()
    const outcome = await runGridSwitchFlow(url, { machineId, agentId })

    // 1) Handshake completes over the real JSON frame.
    expect(outcome.connected).toMatchObject({ machineId, transport: 'local', e2ee: false })

    // 2) grid_models_list returns the picker values the app would render.
    expect(outcome.models.gridName).toBe('someone-7f3a91c4')
    expect(outcome.models.models[0].id).toBe(GRID_MODEL)
    expect(outcome.models.grids[0].name).toBe('shared-lab')
    expect(outcome.models.localModelEngines?.has('codex')).toBe(true)

    // 3) Default pick = first model; moving onto the grid succeeds.
    expect(outcome.ontoGrid.ok).toBe(true)
    expect(outcome.ontoGrid.retargeted).toBe(true)

    // 4) Coming back to own login succeeds.
    expect(outcome.backHome.ok).toBe(true)
    expect(outcome.backHome.retargeted).toBe(true)

    // 5) The daemon saw the EXACT payloads the desktop app sends.
    const retarget = daemon!.received.filter((r) => r.type === 'agent_retarget')
    expect(retarget).toHaveLength(2)
    expect(retarget[0].payload).toMatchObject({ agentId, gridModel: GRID_MODEL }) // onto grid
    expect(retarget[1].payload).toMatchObject({ agentId, clearGrid: true }) // back home
    expect(retarget[1].payload.gridModel).toBeUndefined()

    // 6) The trace is the human-readable step/value log asked for.
    const steps = outcome.trace.map((s) => s.step)
    expect(steps).toEqual(['machine_select', 'grid_models_list', 'agent_retarget(grid)', 'agent_retarget(clear)'])
  })

  it('replays an explicit grid name/model exactly as the app sends them', async () => {
    const url = await startDaemon()
    const driver = new GridSwitchDriver(url, machineId)
    try {
      await driver.machineSelect()
      await driver.gridModels()
      const res = await driver.retargetToGrid(agentId, 'shared:opus', 'shared-lab')
      expect(res.ok).toBe(true)
      const call = daemon!.retargetCalls.find((c) => !c.clear)!
      expect(call).toMatchObject({ model: 'shared:opus', gridName: 'shared-lab' })
    } finally {
      driver.close()
    }
  })

  it('surfaces a daemon refusal as an error result with detail', async () => {
    const url = await startDaemon()
    const driver = new GridSwitchDriver(url, machineId)
    try {
      await driver.machineSelect()
      // No gridModel, no clearGrid -> daemon refuses with INVALID_GRID.
      const res = await driver.retargetToGrid(agentId, '', undefined)
      expect(res.ok).toBe(false)
      expect(res.error).toBe('INVALID_GRID')
      expect(res.detail).toBe('grid is required')
    } finally {
      driver.close()
    }
  })
})
