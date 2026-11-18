/** Remaining Wi-Fi create and mixed-host desk doors. Presentation is component-owned. */
import { realpathSync } from 'node:fs'
import type { registry } from '../lib/registry.js'
import type { BackendSocket } from '../backendSocket.js'
import type { CoreApi, DevicesPort } from './api.js'

const canonicalPath = (path: string | null): string | null => {
  if (!path) return null
  try { return realpathSync(path) } catch { return path }
}

/** What a device's Store preparation launches with: the harness's own engine in the folder it prepared,
 *  never a bypass, a grid, another engine home, a first prompt, a name or a named agent. Fixed here, in the
 *  core, so no process but the core's decides how an agent starts. */
export type WifiCreateInput = Parameters<NonNullable<BackendSocket['onCreateAgent']>>[0]
export function wifiCreate(deps: {
  registry: Pick<typeof registry, 'list'>
  createAgent(): BackendSocket['onCreateAgent']
}): CoreApi['wifi']['create'] {
  return async (packageId, engine, cwd) => {
    // Checked again here, immediately before the agent is made: another agent working there is never retargeted.
    if (deps.registry.list().some(row => canonicalPath(row.cwd) === cwd)) return { ok: false, error: 'WORKSPACE_IN_USE' }
    const create = deps.createAgent()
    if (!create) return { ok: false, error: 'UNSUPPORTED' }
    const input: WifiCreateInput = { engine: engine as WifiCreateInput['engine'], cwd, dsh: packageId,
      bypassPermission: false, permissionMode: null, grid: null, codexHome: null, prompt: null, name: null, agent: null }
    const result = await create(input)
    return result.ok ? { ok: true, agentId: result.session.agentId } : { ok: false, error: result.error, ...(result.detail ? { detail: result.detail } : {}) }
  }
}

export interface WifiDoorsDeps {
  registry: Pick<typeof registry, 'list'>
  /** The socket, once it exists: the windows on this computer, and how an agent is created. */
  socket(): Pick<BackendSocket, 'hasLocalClient' | 'onCreateAgent'> | null
  /** The dials' walk along the desk and their stroke, which the device borrows. */
  devices(): Pick<DevicesPort, 'stepFocus' | 'scroll'> | null
}

/** The doors the Wi-Fi device's service reaches the core through (`CoreApi.wifi`), each the one call it
 *  made when it ran in the core's process. */
export function wifiDoors(deps: WifiDoorsDeps): CoreApi['wifi'] {
  const { registry, socket } = deps
  const hasWindow = (): boolean => !!socket()?.hasLocalClient()
  return {
    create: wifiCreate({ registry, createAgent: () => socket()?.onCreateAgent ?? null }),
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

  }
}
