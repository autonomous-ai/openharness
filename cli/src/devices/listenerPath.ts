/**
 * Where the devices process listens for the watch (the app in front on the dial). The listener, the watch and `link`
 * find it here from the daemon's data folder, so they agree. Outside the core: the core never opens this socket.
 */
import { homedir } from 'node:os'
import { socketPathIn } from '../lib/localSocket.js'
import type { PipeTarget } from '../lib/windows/pipeClient.js'
import { devicesPipe, type DevicesProof } from './listenerPipe.js'

export const DEVICES_SOCKET = 'devices.sock'

/** The devices socket of this data folder, or null where there is none: Windows (the devices listen on a pipe there,
 *  devicesTarget), or a folder and a home both too long for a socket. */
export function devicesListenerPath(dataDir: string, platform: NodeJS.Platform = process.platform, home: string = homedir()): string | null {
  if (platform === 'win32') return null
  return socketPathIn(dataDir, DEVICES_SOCKET, home)
}

export type DevicesTarget = { socket: string } | PipeTarget

/** Where a client reaches the devices of this data folder: their socket, or on Windows their recorded pipe and its
 *  token (listenerPipe.ts). Null when there is nothing to reach. */
export async function devicesTarget(
  dataDir: string, options: { platform?: NodeJS.Platform; home?: string; proof?: DevicesProof } = {},
): Promise<DevicesTarget | null> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return devicesPipe(dataDir, options.proof)
  const socket = devicesListenerPath(dataDir, platform, options.home)
  return socket ? { socket } : null
}
