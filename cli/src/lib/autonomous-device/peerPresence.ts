/** Recaps sees only current Wi-Fi audience facts, never device identities, requests or content. */
import { devicePeerConnection } from './peerConnection.js'
import { devicePeerBudgets, devicePeerChannel, type DevicePeerChannel } from './peerChannel.js'

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
