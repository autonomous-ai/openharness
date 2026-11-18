/** Remaining mixed-host desk doors. Create and presentation are shared or component-owned. */
import type { BackendSocket } from '../backendSocket.js'
import type { CoreApi, DevicesPort } from './api.js'

export interface WifiDoorsDeps {
  /** The socket, once it exists: the windows on this computer. */
  socket(): Pick<BackendSocket, 'hasLocalClient'> | null
  /** The dials' walk along the desk and their stroke, which the device borrows. */
  devices(): Pick<DevicesPort, 'stepFocus' | 'scroll'> | null
}

/** The doors the Wi-Fi device's service reaches the core through (`CoreApi.wifi`), each the one call it
 *  made when it ran in the core's process. */
export function wifiDoors(deps: WifiDoorsDeps): CoreApi['wifi'] {
  const { socket } = deps
  const hasWindow = (): boolean => !!socket()?.hasLocalClient()
  return {
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
