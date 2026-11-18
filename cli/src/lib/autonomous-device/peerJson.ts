import { boundedJsonBytes, BOUNDED_JSON_DEPTH } from '../boundedJsonBytes.js'
import { DEVICE_PEER_MESSAGE_BYTES } from './peerProtocol.js'

export const DEVICE_PEER_JSON_DEPTH = BOUNDED_JSON_DEPTH
export const devicePeerFrameBytes = (value: unknown, limit = DEVICE_PEER_MESSAGE_BYTES): number | null => boundedJsonBytes(value, limit)

export function encodeDevicePeerFrame(frame: unknown): string | null {
  if (devicePeerFrameBytes(frame) === null) return null
  try { return JSON.stringify(frame) } catch { return null }
}
