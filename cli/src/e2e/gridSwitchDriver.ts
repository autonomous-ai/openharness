/**
 * GridSwitchDriver — an E2E driver that talks to the harness daemon the SAME way the desktop
 * app does, so it can be used to reproduce the real value / step flow of switching an agent
 * between a private grid and its own vendor login, without a human clicking the UI.
 *
 * Transport: a plain WebSocket to the daemon's local socket (`<origin>/api/local-ws`, the
 * `LOCAL_WS_PATH` the app connects to via `ws_conn.request`). The protocol is:
 *   client -> { type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }
 *   client <- { type: 'connected',      payload: { machineId, transport: 'local', e2ee: false } }
 *   client -> { type: <cmd>, payload: { ...cmd args, requestId } }
 *   client <- { type: <cmd>, payload: { requestId, ...result } }   (errors carry { error, detail? })
 *
 * The commands replayed here are the exact ones the app sends (`desktop/lib/state/app_state.dart`):
 *   - `grid_models_list`                 -> models/grids/gridName for the pane header picker
 *   - `agent_retarget` (grid)            -> { agentId, gridModel, gridName? }  move ONTO a grid
 *   - `agent_retarget` (clearGrid)       -> { agentId, clearGrid: true }       move back to own login
 *
 * Every reply is threaded back by matching `requestId`, and each exchange is recorded into a
 * `GridSwitchTrace` — the step/value log that answers "khi tôi thao tác nó làm gì, value nào".
 */
import { WebSocket } from 'ws'

export const LOCAL_WS_PATH = '/api/local-ws'
export const LOCAL_WS_PROTOCOL_VERSION = 1

/** One recorded exchange in the trace. */
export interface GridSwitchTraceStep {
  step: string
  /** The frame the driver (acting as the app) sent. */
  request: Record<string, unknown>
  /** The daemon's reply, already decoded. */
  reply: Record<string, unknown>
}

export interface GridModel {
  id: string
  node: string
  grid?: string
}

export interface GridSection {
  name: string
  own: boolean
  models: GridModel[]
}

export interface GridModelsAnswer {
  gridName: string | null
  models: GridModel[]
  grids: GridSection[]
  localModelEngines: Set<string> | null
}

/** The full grid object `agent_retarget` accepts in place of a picker model id. */
export interface GridOverride {
  networkId: string
  networkName: string
  baseUrl: string
  apiKey: string
}

export interface GridSwitchResult {
  ok: boolean
  retargeted: boolean
  error?: string
  detail?: string
}

/** A tiny request/reply WS client matching the backend frame convention. */
export class LocalWsClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>()
  private idSeq = 0
  /** Events the daemon pushes without a matching request (e.g. `connected`, `announce`). */
  private pushes: ((frame: Record<string, unknown>) => void) | null = null

  onPush(cb: ((frame: Record<string, unknown>) => void) | null): void {
    this.pushes = cb
  }

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws
      ws.on('open', () => resolve())
      ws.on('error', (err) => reject(err))
      ws.on('message', (raw) => {
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(raw.toString()) as Record<string, unknown>
        } catch {
          return
        }
        this.dispatch(frame)
      })
      ws.on('close', () => {
        for (const [, { reject }] of this.pending) reject(new Error('socket closed'))
        this.pending.clear()
      })
    })
  }

  private dispatch(frame: Record<string, unknown>): void {
    const payload = (frame.payload ?? {}) as Record<string, unknown>
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : undefined
    if (requestId !== undefined && this.pending.has(requestId)) {
      const entry = this.pending.get(requestId)!
      this.pending.delete(requestId)
      entry.resolve(payload)
      return
    }
    if (this.pushes) this.pushes(frame)
  }

  /** Send a command with a fresh requestId and await the matching reply. */
  request(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = `req-${++this.idSeq}`
    const full = { ...payload, requestId }
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('socket not open'))
        return
      }
      this.pending.set(requestId, { resolve, reject })
      this.ws.send(JSON.stringify({ type, payload: full }))
    })
  }

  /**
   * Send a command whose ack is delivered as an UNREQUESTED push rather than a requestId reply
   * (`machine_select` -> the server's own `connected` frame). Resolves with the pushed payload.
   */
  sendAndAwaitPush(type: string, payload: Record<string, unknown>, awaitType: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('socket not open'))
        return
      }
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${awaitType}`)), 8000)
      const prev = this.pushes
      this.pushes = (frame) => {
        if (frame.type === awaitType) {
          clearTimeout(timer)
          this.pushes = prev
          const p = (frame.payload ?? {}) as Record<string, unknown>
          resolve(p)
        }
        prev?.(frame)
      }
      this.ws.send(JSON.stringify({ type, payload }))
    })
  }

  close(): void {
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }
}

/**
 * The driver. `daemonUrl` is the local socket the real daemon listens on, e.g.
 * `ws://127.0.0.1:${hookPort}/api/local-ws`. Point it at any running daemon, or at a
 * spec's in-process server.
 */
export class GridSwitchDriver {
  readonly trace: GridSwitchTraceStep[] = []
  private client = new LocalWsClient()

  constructor(private readonly daemonUrl: string, private readonly machineId: string) {}

  private record(step: string, request: Record<string, unknown>, reply: Record<string, unknown>): void {
    this.trace.push({ step, request, reply })
  }

  /** 1. Open the socket + select this machine. The ack is the server's `connected` push frame. */
  async machineSelect(): Promise<Record<string, unknown>> {
    await this.client.connect(this.daemonUrl)
    const connected = await this.client.sendAndAwaitPush(
      'machine_select',
      { machineId: this.machineId, localProtocolVersion: LOCAL_WS_PROTOCOL_VERSION },
      'connected',
    )
    this.record('machine_select', { machineId: this.machineId }, connected)
    return connected
  }

  /** 2. Ask the daemon for the models its grid serves (the pane header picker). */
  async gridModels(): Promise<GridModelsAnswer> {
    const reply = await this.client.request('grid_models_list', {})
    this.record('grid_models_list', {}, reply)
    const models = ((reply.models as unknown) ?? []) as GridModel[]
    const grids = (((reply.grids as unknown) ?? []) as Array<Record<string, unknown>>).map((g) => ({
      name: g.name as string,
      own: g.own === true,
      models: ((g.models as unknown) ?? []) as GridModel[],
    }))
    const localEngines = reply.localModelEngines as unknown
    return {
      gridName: (reply.gridName as string) ?? null,
      models,
      grids,
      localModelEngines: Array.isArray(localEngines)
        ? new Set((localEngines as string[]).map((e) => e.toLowerCase()))
        : null,
    }
  }

  /**
   * 3. The app's picker choice: move the agent ONTO a grid model. With `override`, the full grid
   * object is sent instead (the daemon accepts both): a relay the daemon's own `grid` sign-in does
   * not know — a local relay checkout under test — with the key recorded out of the trace.
   */
  async retargetToGrid(agentId: string, gridModel: string, gridName?: string, override?: GridOverride): Promise<GridSwitchResult> {
    const payload: Record<string, unknown> = override ? { agentId, grid: { ...override, model: gridModel } } : { agentId, gridModel }
    if (gridName !== undefined && !override) payload.gridName = gridName
    const reply = await this.client.request('agent_retarget', payload)
    const recorded = override ? { ...payload, grid: { ...(payload.grid as object), apiKey: '<redacted>' } } : payload
    this.record('agent_retarget(grid)', recorded, reply)
    return normalizeResult(reply)
  }

  /** 4. The "put it back" action: return the agent to its own vendor login. */
  async clearGrid(agentId: string): Promise<GridSwitchResult> {
    const payload = { agentId, clearGrid: true }
    const reply = await this.client.request('agent_retarget', payload)
    this.record('agent_retarget(clear)', payload, reply)
    return normalizeResult(reply)
  }

  /**
   * 0. New Harness: create a fresh agent for this run, the way the app's "New agent" does
   * (`agent_create` with an engine and an absolute cwd). The test never borrows someone's pane.
   */
  async createAgent(engine: string, cwd: string, name: string): Promise<{ ok: true; agentId: string; pane: string | null } | { ok: false; error: string; detail?: string }> {
    const payload = { engine, cwd, name }
    const reply = await this.client.request('agent_create', payload)
    this.record('agent_create', payload, reply)
    if (reply.error) return { ok: false, error: reply.error as string, detail: reply.detail as string | undefined }
    const agent = reply.agent as { id?: string; tmuxPane?: string } | undefined
    if (!agent?.id) return { ok: false, error: 'NO_AGENT_ID', detail: 'agent_create replied without agent.id' }
    // The row already names its pane (`tmuxPane: "%N"`); the registry is only a fallback.
    const pane = typeof agent.tmuxPane === 'string' && /^%\d+$/.test(agent.tmuxPane) ? agent.tmuxPane : null
    return { ok: true, agentId: agent.id, pane }
  }

  /** 5. Clean up: delete the agent this run created (its pane goes with it). */
  async deleteAgent(agentId: string): Promise<boolean> {
    const payload = { agentId }
    const reply = await this.client.request('agent_delete', payload)
    this.record('agent_delete', payload, reply)
    return reply.deleted === true
  }

  close(): void {
    this.client.close()
  }
}

function normalizeResult(payload: Record<string, unknown>): GridSwitchResult {
  if (payload.error) {
    return { ok: false, retargeted: false, error: payload.error as string, detail: payload.detail as string | undefined }
  }
  return { ok: true, retargeted: payload.retargeted === true }
}

/**
 * Which grid model to move onto: the SMALLEST one served on any grid the daemon lists (own grid
 * first), so the real switch costs as little as possible. `models` at the top level is only the own
 * grid's list and is often empty — the models people actually share live under `grids[]`.
 */
export function pickGridModel(answer: GridModelsAnswer): { model: string; gridName: string } | null {
  // The own grid first: the top-level `models` (its list, under `gridName`), then every section
  // flagged `own`, then the rest. Ties on size keep the earlier one.
  const own: GridSection[] = answer.gridName ? [{ name: answer.gridName, own: true, models: answer.models }] : []
  const sections = [...own, ...answer.grids.filter((g) => g.own), ...answer.grids.filter((g) => !g.own)]
  let best: { model: string; gridName: string; size: number } | null = null
  for (const g of sections) {
    for (const m of g.models) {
      const size = paramsB(m.id)
      if (!best || size < best.size) best = { model: m.id, gridName: g.name, size }
    }
  }
  return best ? { model: best.model, gridName: best.gridName } : null
}

/** Parameter count in billions parsed from a model id (`Qwen3.8-27B` → 27, `…-35B-A3B` → 35); unknown → Infinity. */
function paramsB(id: string): number {
  const m = /(\d+(?:\.\d+)?)B(?![A-Za-z])/i.exec(id)
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY
}

/** Run the whole flow in one go and hand back the trace + results. */
export interface GridFlowOutcome {
  connected: Record<string, unknown>
  models: GridModelsAnswer
  ontoGrid: GridSwitchResult
  backHome: GridSwitchResult
  trace: GridSwitchTraceStep[]
}

/**
 * Replay the full app journey against a daemon URL:
 *   machine_select -> grid_models_list -> agent_retarget(onto grid) -> agent_retarget(clear)
 * `agentId` and `machineId` are whatever agent/session the caller wants to move.
 */
export async function runGridSwitchFlow(
  daemonUrl: string,
  opts: { machineId: string; agentId: string; gridModel?: string; gridName?: string },
): Promise<GridFlowOutcome> {
  const driver = new GridSwitchDriver(daemonUrl, opts.machineId)
  try {
    const connected = await driver.machineSelect()
    const models = await driver.gridModels()
    const picked = pickGridModel(models)
    const pick = opts.gridModel ?? picked?.model ?? models.models[0]?.id
    const ontoGrid = await driver.retargetToGrid(opts.agentId, pick, opts.gridName ?? (opts.gridModel ? undefined : picked?.gridName))
    const backHome = await driver.clearGrid(opts.agentId)
    return { connected, models, ontoGrid, backHome, trace: driver.trace }
  } finally {
    driver.close()
  }
}
