/**
 * The Wi-Fi device's doors into the core (`CoreApi.wifi`), where the registry, the panes and the windows
 * are: its service runs with the dials, in the devices' process (services/wifi.ts). The agents as it
 * lists them, asked before each request it answers; an agent made for a Store harness; its prompts into
 * the panes; the window it moves. Moved as they were from the core's wiring and
 * lib/autonomous-device/storeRuntime.ts.
 */
import { realpathSync } from 'node:fs'
import { installedDsh } from '../dsh/installed.js'
import type { AutonomousDeviceAgent } from '../lib/autonomous-device/service.js'
import type { StoreAgent } from '../lib/autonomous-device/store.js'
import type { RegisteredSession, registry } from '../lib/registry.js'
import type { BackendSocket } from '../backendSocket.js'
import { adaptSlashCommand } from '../lib/goalCommand.js'
import type { CoreApi, DevicesPort, WifiView } from './api.js'
import type { AutonomousDeviceInput } from './deviceInput.js'
import type { WifiCoreDeps } from './wifi.js'

const canonicalPath = (path: string | null): string | null => {
  if (!path) return null
  try { return realpathSync(path) } catch { return path }
}

export interface WifiAgentsDeps {
  registry: Pick<typeof registry, 'list' | 'advertised' | 'terminalAvailable'>
  /** The account's id for this machine. */
  machineId(): string
  displayName(session: RegisteredSession): string
  /** Whether an engine session has a turn open: its agent is running. */
  running(sessionId: string): boolean
  hasWindow(): boolean
}

/** Every agent with the Store's evidence on it: which harness it runs, where, and whether its engine is up
 *  yet. A device's Store preparation reads it to find an agent already working in a folder. */
export function storeAgents(deps: Pick<WifiAgentsDeps, 'registry' | 'machineId'>): StoreAgent[] {
  const machineId = deps.machineId()
  return deps.registry.list().map(s => ({ agentId: s.agentId, machineId, packageId: s.dsh ? installedDsh(s.dsh)?.id ?? s.dsh : null,
    engine: s.engine, workspace: canonicalPath(s.cwd), state: s.active ? 'active' : 'inactive',
    runtime: !deps.registry.terminalAvailable(s.agentId) || s.launch?.state === 'failed' ? 'unavailable'
      : s.launch?.state === 'starting' ? 'starting' : s.active ? (s.launch?.state === 'ready' || s.sessionId || s.engine === 'terminal' ? 'ready' : 'starting') : 'unavailable',
    ...(s.launch?.state === 'failed' ? { error: s.launch.detail ?? s.launch.error } : {}) }))
}

export function wifiView(deps: WifiAgentsDeps): WifiView {
  const store = storeAgents(deps)
  const evidence = new Map(store.map(a => [a.agentId, a]))
  const agents: AutonomousDeviceAgent[] = deps.registry.advertised().map(s => ({ agentId: s.agentId, name: deps.displayName(s), engine: s.engine,
    packageId: evidence.get(s.agentId)?.packageId ?? null, workspace: evidence.get(s.agentId)?.workspace ?? s.cwd,
    runtime: evidence.get(s.agentId)?.runtime ?? 'unavailable',
    state: deps.running(s.sessionId) ? 'running' : 'idle' }))
  return { agents, store, hasWindow: deps.hasWindow() }
}

/** What a device's Store preparation launches with: the harness's own engine in the folder it prepared,
 *  never a bypass, a grid, another engine home, a first prompt, a name or a named agent. Fixed here, in the
 *  core, so no process but the core's decides how an agent starts. */
export type WifiCreateInput = Parameters<NonNullable<BackendSocket['onCreateAgent']>>[0]
export function wifiCreate(deps: Pick<WifiAgentsDeps, 'registry' | 'machineId'> & {
  createAgent(): BackendSocket['onCreateAgent']
}): CoreApi['wifi']['create'] {
  return async (packageId, engine, cwd) => {
    // Checked again here, immediately before the agent is made: another agent working there is never retargeted.
    if (storeAgents(deps).some(a => a.workspace === cwd)) return { ok: false, error: 'WORKSPACE_IN_USE' }
    const create = deps.createAgent()
    if (!create) return { ok: false, error: 'UNSUPPORTED' }
    const input: WifiCreateInput = { engine: engine as WifiCreateInput['engine'], cwd, dsh: packageId,
      bypassPermission: false, permissionMode: null, grid: null, codexHome: null, prompt: null, name: null, agent: null }
    const result = await create(input)
    return result.ok ? { ok: true, agentId: result.session.agentId } : { ok: false, error: result.error, ...(result.detail ? { detail: result.detail } : {}) }
  }
}

export interface WifiDoorsDeps extends Pick<WifiAgentsDeps, 'registry' | 'machineId' | 'displayName' | 'running'> {
  registry: WifiAgentsDeps['registry'] & Pick<typeof registry, 'resolve'>
  /** The socket, once it exists: the windows on this computer, and how an agent is created. */
  socket(): Pick<BackendSocket, 'hasLocalClient' | 'sendFirstLocal' | 'onCreateAgent'> | null
  /** The pane writer lock a device's prompts go through (core/deviceInput.ts). */
  deviceInput(): Pick<AutonomousDeviceInput, 'submit' | 'cancelDelivery' | 'onTurnStarted'>
  /** A device's answer to a question: never a permission dialog's. */
  answer(request: { agentId: string; requestId: string; answers: Record<string, string>; allowPermissions: false }): Promise<{ ok: boolean }>
  /** Stop a live agent's turn, as the stop button does. */
  stop(agentId: string): Promise<boolean>
  /** The dials' walk along the desk and their stroke, which the device borrows. */
  devices(): Pick<DevicesPort, 'stepFocus' | 'scroll'> | null
}

/** The doors the Wi-Fi device's service reaches the core through (`CoreApi.wifi`), each the one call it
 *  made when it ran in the core's process. */
export function wifiDoors(deps: WifiDoorsDeps): WifiCoreDeps['doors'] {
  const { registry, machineId, socket } = deps
  const hasWindow = (): boolean => !!socket()?.hasLocalClient()
  return {
    view: async () => wifiView({ ...deps, hasWindow }),
    submit: async (id, text, deliveryId) => {
      const session = registry.resolve(id)
      deps.deviceInput().submit(session?.agentId ?? id, adaptSlashCommand(text, session?.engine ?? 'claude'), deliveryId)
    },
    cancel: (deliveryId) => { deps.deviceInput().cancelDelivery(deliveryId) },
    started: (agentId, text) => deps.deviceInput().onTurnStarted(agentId, text),
    stop: (agentId) => deps.stop(agentId),
    answer: async (agentId, requestId, answers) => (await deps.answer({ agentId, requestId, answers, allowPermissions: false })).ok,
    create: wifiCreate({ registry, machineId, createAgent: () => socket()?.onCreateAgent ?? null }),
    // The dial's walk and stroke: `dial_focus` and `dial_scroll` to the window. Without a window the forward
    // is a no-op, so it says so up front; without the devices there is no desk to walk.
    stepFocus: async (direction, currentAgentId) => {
      if (!hasWindow()) return 'no_app'
      const devices = deps.devices()
      return devices ? devices.stepFocus(direction, currentAgentId) : 'no_agents'
    },
    scroll: (phase, dy, velocity) => {
      if (!hasWindow()) return false
      deps.devices()?.scroll(phase, dy, velocity)
      return true
    },
    focusApp: (agentId, expiresAt, focusRevision) =>
      !!socket()?.sendFirstLocal({ type: 'device_focus', payload: { machineId: machineId(), agentId, expiresAt, focusRevision } }),
    reveal: (operationId, agentId) => { socket()?.sendFirstLocal({ type: 'device_prepare_open', payload: { operationId, machineId: machineId(), agentId } }) },
  }
}
