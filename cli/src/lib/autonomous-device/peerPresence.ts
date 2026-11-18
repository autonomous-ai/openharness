/** Recaps sees current audience only, and publishes its own captured cards; no device authority. */
import { devicePeerConnection } from './peerConnection.js'
import { devicePeerBudgets, devicePeerChannel, type DevicePeerChannel } from './peerChannel.js'
import { encodeDevicePeerFrame } from './peerJson.js'
import type { DeviceRecapFrame } from './peerProtocol.js'

export function devicePeerPresence(options: {
  dataDir: string; port: number; key: Buffer | null
  changed(watching: boolean, joined: boolean): void
  failed(code: string): void
}) {
  const budgets = devicePeerBudgets()
  let running = false, channel: DevicePeerChannel | null = null
  const connection = devicePeerConnection({ ...options, role: 'recaps', connected(socket, current) {
    const own = devicePeerChannel(socket, { role: 'recaps', side: 'component', epoch: null, budgets,
      current: () => running && channel === own && current(), failed: options.failed,
      receive(frame) {
        if (frame.type !== 'presence') return
        options.changed(frame.watching, frame.joined)
      },
      gone() { if (channel === own) { channel = null; options.changed(false, false) } },
    })
    channel = own
  } })
  return {
    card(frame: DeviceRecapFrame['frame'], fullText?: string): boolean {
      const own = channel, epoch = own?.epoch()
      if (!running || !own || !epoch) { options.failed('PEER_RECAP_UNAVAILABLE'); return false }
      const wire = encodeDevicePeerFrame({ type: 'recap', epoch, frame, fullText: fullText ?? null })
      if (wire === null) { options.failed('PEER_FRAME_OVERSIZED'); return false }
      const sent = own.send(wire) === 'sent'
      if (!sent) options.failed('PEER_RECAP_UNAVAILABLE')
      return sent
    },
    start() { if (running) return; running = true; connection.start() },
    async stop() {
      running = false
      const previous = channel
      channel = null
      previous?.close()
      options.changed(false, false)
      await connection.stop()
    },
  }
}
