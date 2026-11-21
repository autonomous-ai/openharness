/** Bounded reconnect for the two fixed component roles. No polling while idle or disabled. */
import { watch, type FSWatcher } from 'node:fs'
import { basename } from 'node:path'
import type { WebSocket } from 'ws'
import { connectDevicePeer, devicePeerRecord, readDevicePeerEndpoint, type DevicePeerFailure } from './peerEndpoint.js'
import { DEVICE_PEER_DRAIN_MS, type DevicePeerRole } from './peerProtocol.js'

type PhysicalPeer = { socket: WebSocket; closed: Promise<void> }

export function devicePeerConnection(options: {
  dataDir: string; port: number; key: Buffer | null; role: DevicePeerRole
  connected(socket: WebSocket, current: () => boolean): void
  failed(code: DevicePeerFailure): void
}) {
  let running = false, generation = 0, retries = 0, epoch: string | undefined
  let watcher: FSWatcher | undefined, retry: ReturnType<typeof setTimeout> | undefined
  // One physical socket, including a logically replaced connection still closing.
  let physical: PhysicalPeer | null = null
  const cancelRetry = (): void => { if (retry) clearTimeout(retry); retry = undefined }
  const later = (): void => {
    if (!running || retry || physical || retries >= 5) return
    retry = setTimeout(() => { retry = undefined; attempt() }, [250, 500, 1000, 2000, 5000][retries++]).unref()
  }
  const attempt = (): void => {
    if (!running || physical || !options.key) return
    const target = connectDevicePeer(options)
    if (!target) { later(); return }
    epoch = target.epoch
    const original = generation
    const { socket } = target
    const own: PhysicalPeer = { socket, closed: new Promise<void>(resolve => {
      socket.once('close', () => {
        if (physical === own) physical = null
        resolve()
        if (!running) return
        if (generation !== original) attempt()
        else later()
      })
    }) }
    physical = own
    const current = (): boolean => running && generation === original && physical === own
    socket.once('open', () => {
      if (!current()) { socket.terminate(); return }
      try { options.connected(socket, current) } catch { options.failed('PEER_UNAVAILABLE'); socket.terminate() }
    })
    socket.on('error', () => { if (current()) options.failed('PEER_UNAVAILABLE') })
  }
  return {
    start() {
      if (running) return
      if (!options.key) { options.failed('PEER_AUTH_UNAVAILABLE'); return }
      running = true; generation++; retries = 0
      try {
        const name = basename(devicePeerRecord(options.dataDir, options.port))
        const ownWatcher = watch(options.dataDir, (_event, changed) => {
          if (!running || watcher !== ownWatcher || (changed !== null && changed.toString() !== name)) return
          const next = readDevicePeerEndpoint(options.dataDir, options.port)?.epoch
          if (!next || next === epoch) return
          epoch = next; generation++; retries = 0; cancelRetry()
          if (physical) physical.socket.terminate()
          else attempt()
        })
        watcher = ownWatcher
        ownWatcher.on('error', () => {
          if (watcher !== ownWatcher) return
          ownWatcher.close(); watcher = undefined; options.failed('PEER_UNAVAILABLE')
        })
        ownWatcher.unref()
      } catch { options.failed('PEER_UNAVAILABLE') }
      attempt()
    },
    async stop() {
      running = false; generation++; cancelRetry(); watcher?.close(); watcher = undefined
      if (!physical) return
      const original = physical
      original.socket.terminate()
      let deadline: ReturnType<typeof setTimeout> | undefined
      await Promise.race([original.closed, new Promise<void>(resolve => {
        deadline = setTimeout(() => { options.failed('PEER_DRAIN_DEADLINE'); resolve() }, DEVICE_PEER_DRAIN_MS).unref()
      })])
      if (deadline) clearTimeout(deadline)
      // A deadline never releases the physical slot. A later start waits for actual close.
    },
  }
}
