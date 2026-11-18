/** Physical ownership for the fixed device peer; admission is shared across socket replacements. */
import { WebSocket, type RawData } from 'ws'
import { devicePeerBudget, devicesGatewayFrame, gatewayDeviceFrame, DEVICE_PEER_DRAIN_MS, DEVICE_PEER_MESSAGE_BYTES, DEVICE_PEER_FRAMES,
  type DevicePeerFrame, type DevicePeerRole, type DevicePeerWriteLease } from './peerProtocol.js'

export type DevicePeerPressure = 'PEER_FRAME_OVERSIZED' | 'PEER_WRITE_BACKPRESSURE' | 'PEER_READ_BACKPRESSURE'
  | 'PEER_PROTOCOL_INVALID' | 'PEER_HANDLER_FAILED' | 'PEER_DRAIN_DEADLINE' | 'PEER_UNAVAILABLE'
export function devicePeerBudgets() { return { incoming: devicePeerBudget(), outgoing: devicePeerBudget() } }
export type DevicePeerBudgets = ReturnType<typeof devicePeerBudgets>

export interface DevicePeerChannel {
  /** JSON already passed the caller's bounded, getter-free encoder. There is no second pending-send queue. */
  send(wire: string, lease?: DevicePeerWriteLease): 'sent' | 'unavailable' | 'oversized' | 'backpressure'
  /** The one held/presence owner may wait for physical credit without making another write queue. */
  canSend(bytes: number, leased?: boolean): boolean
  close(): void
  epoch(): string | null
}

export function devicePeerChannel(socket: WebSocket, options: {
  role: DevicePeerRole
  side: 'gateway' | 'component'
  /** Gateway assigns it; a component accepts it only from its first authenticated snapshot/presence. */
  epoch: string | null
  budgets: DevicePeerBudgets
  current(): boolean
  receive(frame: DevicePeerFrame): void | Promise<void>
  failed(code: DevicePeerPressure): void
  gone(): void
  /** Shared queue owner across replacements, notified even when an old socket returns credit. */
  writable?(): void
}): DevicePeerChannel {
  let live = true, ended = false, epoch = options.epoch
  let drain: ReturnType<typeof setTimeout> | undefined
  const writes = new Set<() => void>()
  const available = (): boolean => live && options.current() && socket.readyState === WebSocket.OPEN
  const end = (): void => {
    live = false
    if (!ended) { ended = true; options.gone() }
  }
  const close = (): void => { end(); socket.terminate() }
  const fail = (code: DevicePeerPressure): void => {
    const notify = live
    // Reentrant failure observers cannot admit another write under this failed channel's authority.
    end()
    if (notify) options.failed(code)
    socket.terminate()
  }
  const drained = (): void => {
    if (!writes.size && drain) { clearTimeout(drain); drain = undefined }
  }
  socket.on('close', () => {
    end()
    // The OS/socket owns these writes until callback or physical close, even after logical replacement.
    for (const release of writes) release()
    writes.clear()
    drained()
  })
  socket.on('error', () => fail('PEER_UNAVAILABLE'))
  socket.on('message', (raw: RawData, binary: boolean) => {
    if (!available()) { close(); return }
    // Text messages arrive as a Buffer. Reject binary/fragment arrays without concatenating them.
    if (binary || !Buffer.isBuffer(raw)) { fail('PEER_PROTOCOL_INVALID'); return }
    if (raw.byteLength > DEVICE_PEER_MESSAGE_BYTES) { fail('PEER_FRAME_OVERSIZED'); return }
    const release = options.budgets.incoming.reserve(raw.byteLength)
    if (!release) { fail('PEER_READ_BACKPRESSURE'); return }
    let frame: DevicePeerFrame | null
    try {
      const value: unknown = JSON.parse(raw.toString('utf8'))
      frame = options.side === 'gateway' ? devicesGatewayFrame(value) : gatewayDeviceFrame(value, options.role)
      if (!frame || (options.side === 'gateway' && options.role !== 'devices')) throw new Error()
      if (epoch === null) {
        if (frame.type !== (options.role === 'devices' ? 'snapshot' : 'presence')) throw new Error()
        epoch = frame.epoch
      }
      if (frame.epoch !== epoch) throw new Error()
    } catch { release(); fail('PEER_PROTOCOL_INVALID'); return }
    try {
      const settling = options.receive(frame)
      // A closed/replaced socket cannot free work that is still running in a component.
      if (settling) void Promise.resolve(settling).catch(() => fail('PEER_HANDLER_FAILED')).finally(release)
      else release()
    } catch { release(); fail('PEER_HANDLER_FAILED') }
  })
  return {
    close, epoch: () => epoch,
    canSend(bytes, leased = false) {
      const held = options.budgets.outgoing.snapshot()
      return available() && Number.isSafeInteger(bytes) && bytes >= 0 && held.frames < DEVICE_PEER_FRAMES
        && (leased || bytes <= DEVICE_PEER_MESSAGE_BYTES - held.bytes) && bytes <= DEVICE_PEER_MESSAGE_BYTES - socket.bufferedAmount
    },
    send(wire, lease) {
      if (!available()) return 'unavailable'
      const bytes = Buffer.byteLength(wire)
      if (bytes > DEVICE_PEER_MESSAGE_BYTES) { options.failed('PEER_FRAME_OVERSIZED'); return 'oversized' }
      if (socket.bufferedAmount > DEVICE_PEER_MESSAGE_BYTES - bytes) { fail('PEER_WRITE_BACKPRESSURE'); return 'backpressure' }
      const credit = lease ? lease.take(bytes) : options.budgets.outgoing.reserve(bytes)
      if (!credit) {
        if (!lease) fail('PEER_WRITE_BACKPRESSURE')
        return 'backpressure'
      }
      const release = (): void => {
        if (!writes.delete(release)) return
        credit(); drained(); options.writable?.()
      }
      writes.add(release)
      drain ??= setTimeout(() => fail('PEER_DRAIN_DEADLINE'), DEVICE_PEER_DRAIN_MS).unref()
      try {
        socket.send(wire, error => {
          if (error) fail('PEER_UNAVAILABLE')
          release()
        })
      } catch { fail('PEER_UNAVAILABLE'); release(); return 'unavailable' }
      return live ? 'sent' : 'unavailable'
    },
  }
}
