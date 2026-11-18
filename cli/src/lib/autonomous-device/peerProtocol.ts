/** Private gateway/devices traffic. No terminal authority or general service routing travels here. */
import type { DeviceSessionProof } from './relay.js'

export const DEVICE_PEER_VERSION = 1
export const DEVICE_PEER_MESSAGE_BYTES = 16 * 1024 * 1024 + 4096
export const DEVICE_PEER_FRAMES = 256
export const DEVICE_PEER_HELD_BYTES = 16 * 1024 * 1024
export const DEVICE_PEER_HELD_MS = 30_000
export const DEVICE_PEER_READY_MS = 15_000
export const DEVICE_PEER_HANDSHAKE_MS = 10_000
export const DEVICE_PEER_DRAIN_MS = 2_000

export type DevicePeerRole = 'devices' | 'recaps'
export interface DevicePeerSession extends DeviceSessionProof {
  readonly connId: string
  readonly direct: boolean
  readonly hello: boolean
}
type Routed = DeviceSessionProof & { connId: string; epoch: string }
export type GatewayDeviceFrame =
  | { type: 'snapshot'; epoch: string; machineId: string; sessions: DevicePeerSession[] }
  | { type: 'session'; epoch: string; session: DevicePeerSession }
  | { type: 'drop'; epoch: string; connId: string; incarnation: string }
  | { type: 'revoked'; epoch: string; identity: string }
  | ({ type: 'request'; opened: Record<string, unknown> } & Routed)
  | { type: 'presence'; epoch: string; watching: boolean; joined: boolean }
export type DevicesGatewayFrame =
  | { type: 'ready'; epoch: string }
  | ({ type: 'send'; frameType: 'autonomous_device_result' | 'autonomous_device_event'; payload: Record<string, unknown> } & Routed)
  | ({ type: 'hello'; hello: boolean } & Routed)
  | ({ type: 'joined' | 'revoke' } & Routed)
export type DevicePeerFrame = GatewayDeviceFrame | DevicesGatewayFrame

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
/** Public connIds/identities are far shorter; this also bounds worst-case escaped private metadata. */
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
  let count = 0
  for (const key in value) if (++count > allowed.length || !allowed.includes(key) || !Object.hasOwn(value, key)) return false
  return count === allowed.length
}
const proof = (value: Record<string, unknown>): boolean => text(value.connId) && text(value.identity) && text(value.incarnation)
const session = (value: unknown): value is DevicePeerSession => object(value)
  && keys(value, ['connId', 'identity', 'incarnation', 'direct', 'hello']) && proof(value)
  && typeof value.direct === 'boolean' && typeof value.hello === 'boolean'

/** Called only after the raw frame byte admission; nested business content is checked by its owner. */
export function gatewayDeviceFrame(value: unknown, role: DevicePeerRole): GatewayDeviceFrame | null {
  if (!object(value) || !text(value.epoch)) return null
  if (role === 'recaps') return value.type === 'presence' && keys(value, ['type', 'epoch', 'watching', 'joined'])
    && typeof value.watching === 'boolean' && typeof value.joined === 'boolean' && (!value.joined || value.watching)
    ? value as GatewayDeviceFrame : null
  if (value.type === 'snapshot') return keys(value, ['type', 'epoch', 'machineId', 'sessions']) && text(value.machineId)
    && Array.isArray(value.sessions) && value.sessions.length <= 64 && value.sessions.every(session)
    && new Set(value.sessions.map(each => each.connId)).size === value.sessions.length ? value as GatewayDeviceFrame : null
  if (value.type === 'session') return keys(value, ['type', 'epoch', 'session']) && session(value.session) ? value as GatewayDeviceFrame : null
  if (value.type === 'drop') return keys(value, ['type', 'epoch', 'connId', 'incarnation']) && text(value.connId) && text(value.incarnation) ? value as GatewayDeviceFrame : null
  if (value.type === 'revoked') return keys(value, ['type', 'epoch', 'identity']) && text(value.identity) ? value as GatewayDeviceFrame : null
  if (value.type === 'request') return keys(value, ['type', 'epoch', 'connId', 'identity', 'incarnation', 'opened'])
    && proof(value) && object(value.opened) ? value as GatewayDeviceFrame : null
  return null
}

export function devicesGatewayFrame(value: unknown): DevicesGatewayFrame | null {
  if (!object(value) || !text(value.epoch)) return null
  if (value.type === 'ready') return keys(value, ['type', 'epoch']) ? value as DevicesGatewayFrame : null
  if (!proof(value)) return null
  if (value.type === 'send') return keys(value, ['type', 'epoch', 'connId', 'identity', 'incarnation', 'frameType', 'payload'])
    && ['autonomous_device_result', 'autonomous_device_event'].includes(String(value.frameType)) && object(value.payload)
    ? value as DevicesGatewayFrame : null
  if (value.type === 'hello') return keys(value, ['type', 'epoch', 'connId', 'identity', 'incarnation', 'hello'])
    && typeof value.hello === 'boolean' ? value as DevicesGatewayFrame : null
  if (value.type === 'joined' || value.type === 'revoke') return keys(value, ['type', 'epoch', 'connId', 'identity', 'incarnation']) ? value as DevicesGatewayFrame : null
  return null
}

/** Shared across physical socket generations. Logical replacement never returns a byte of credit. */
export interface DevicePeerWriteLease {
  remaining(): number
  /** Transfer bytes to one physical write, without returning them to shared admission. */
  take(size: number): (() => void) | null
  /** Only unsent, actually discarded references return their bytes here. */
  discard(size?: number): void
}
export function devicePeerBudget(maxBytes = DEVICE_PEER_MESSAGE_BYTES, maxFrames = DEVICE_PEER_FRAMES) {
  let bytes = 0, frames = 0
  const lease = (size: number): DevicePeerWriteLease | null => {
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes - bytes) return null
    bytes += size
    let remaining = size
    return {
      remaining: () => remaining,
      take(amount) {
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > remaining || frames >= maxFrames) return null
        remaining -= amount
        frames++
        let released = false
        return () => {
          if (released) return
          released = true
          bytes -= amount
          frames--
        }
      },
      discard(amount = remaining) {
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > remaining) throw new Error('Invalid device peer lease release')
        remaining -= amount
        bytes -= amount
      },
    }
  }
  return {
    lease,
    reserve(size: number): (() => void) | null {
      if (frames >= maxFrames) return null
      return lease(size)?.take(size) ?? null
    },
    snapshot: () => ({ bytes, frames }),
  }
}
