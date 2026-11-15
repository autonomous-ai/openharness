/**
 * Where the devices process listens for the watch (the app in front on the dial). The listener, the watch and `link`
 * find it here from the daemon's data folder, so they agree. Outside the core: the core never opens this socket.
 */
import { homedir } from 'node:os'
import { socketPathIn } from '../lib/localSocket.js'

export const DEVICES_SOCKET = 'devices.sock'

/** The devices socket of this data folder, or null where there is none: Windows (no listener there yet), or a folder
 *  and a home both too long for a socket. */
export function devicesListenerPath(dataDir: string, platform: NodeJS.Platform = process.platform, home: string = homedir()): string | null {
  if (platform === 'win32') return null
  return socketPathIn(dataDir, DEVICES_SOCKET, home)
}
