/** One devices-side FIFO: replay borrows retained payloads and consumes physical slots only at handoff. */
import { DEVICE_PEER_DRAIN_MS, DEVICE_PEER_MESSAGE_BYTES, type DevicesGatewayFrame, type DevicePeerWriteLease } from './peerProtocol.js'
import { devicePeerFrameBytes, encodeDevicePeerFrame } from './peerJson.js'
import type { DevicePeerBudgets, DevicePeerChannel, DevicePeerPressure } from './peerChannel.js'
import type { AutonomousDeviceFrame } from './service.js'

type Route = { readonly connId: string; readonly identity: string; readonly incarnation: string; readonly epoch: string }
type FrameRecord = { bytes: number; wire: string } | { bytes: number; frame: DevicesGatewayFrame; event?: Readonly<AutonomousDeviceFrame> }
interface Job {
  epoch: string
  records: Array<FrameRecord | null>
  index: number
  replay: boolean
  references: number
  lease: DevicePeerWriteLease
  current(): boolean
  allowed?(event: Readonly<AutonomousDeviceFrame>): boolean
  ready: boolean
}
const REPLAY_JOBS = 64, REPLAY_REFERENCES = 64 * 513, ORDINARY_JOBS = 256

export function devicePeerWriter(options: {
  budgets: DevicePeerBudgets
  channel(): DevicePeerChannel | null
  maySend?(): boolean
  failed(code: DevicePeerPressure): void
}) {
  const queue: Job[] = []
  let replayJobs = 0, ordinaryJobs = 0, references = 0, draining = false, drainAgain = false
  let deadline: ReturnType<typeof setTimeout> | undefined
  const clearDeadline = (): void => {
    if (queue.length || !deadline) return
    clearTimeout(deadline); deadline = undefined
  }
  const discardRecord = (job: Job, record: FrameRecord): void => {
    job.lease.discard(record.bytes)
    if ('event' in record && record.event) { job.references--; references-- }
  }
  const remove = (index = 0): void => {
    const job = queue.splice(index, 1)[0]!
    for (let i = job.index; i < job.records.length; i++) {
      const record = job.records[i]
      if (record) discardRecord(job, record)
      job.records[i] = null
    }
    job.records.length = 0
    job.lease.discard()
    if (job.replay) replayJobs--; else ordinaryJobs--
    clearDeadline()
  }
  const discard = (): void => { while (queue.length) remove() }
  const discardEpoch = (epoch: string): void => {
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index]!.epoch === epoch) remove(index)
  }
  const startDeadline = (): void => {
    deadline ??= setTimeout(() => {
      deadline = undefined
      if (!queue.length) return
      const epoch = queue[0]!.epoch, expired = options.channel()
      // External callbacks may install another generation. Discard first and close only this capture.
      discardEpoch(epoch)
      options.failed('PEER_DRAIN_DEADLINE')
      if (expired?.epoch() === epoch) expired.close()
    }, DEVICE_PEER_DRAIN_MS).unref()
  }
  const drain = (): void => {
    if (draining) { drainAgain = true; return }
    draining = true
    try {
      while (queue.length) {
        const job = queue[0]!, channel = options.channel()
        if (!channel || channel.epoch() !== job.epoch || !job.current()) { remove(); continue }
        if (!job.ready) return
        if (options.maySend && !options.maySend()) return
        const record = job.records[job.index]
        if (!record) { remove(); continue }
        if ('event' in record && record.event && !job.allowed!(record.event)) {
          discardRecord(job, record); job.records[job.index++] = null; continue
        }
        if (!channel.canSend(record.bytes, true)) return
        const wire = 'wire' in record ? record.wire : encodeDevicePeerFrame(record.frame)
        if (wire === null || Buffer.byteLength(wire) !== record.bytes) {
          discardEpoch(job.epoch); options.failed('PEER_PROTOCOL_INVALID'); channel.close(); return
        }
        // Retained references end at handoff. The channel owns their exact byte credit until settlement.
        job.records[job.index++] = null
        if ('event' in record && record.event) { job.references--; references-- }
        const before = job.lease.remaining()
        const sent = channel.send(wire, job.lease)
        if (job.lease.remaining() === before) job.lease.discard(record.bytes)
        if (sent !== 'sent') { discardEpoch(job.epoch); return }
      }
    } finally {
      draining = false; clearDeadline()
      if (drainAgain) { drainAgain = false; drain() }
    }
  }
  const enqueue = (job: Job): (() => void) => {
    queue.push(job)
    if (job.replay) replayJobs++; else ordinaryJobs++
    references += job.references
    startDeadline()
    return () => { job.ready = true; drain() }
  }
  return {
    drain, discard,
    send(frame: DevicesGatewayFrame, current: () => boolean): boolean {
      if (!current() || options.channel()?.epoch() !== frame.epoch) return false
      if (ordinaryJobs >= ORDINARY_JOBS) { options.failed('PEER_WRITE_BACKPRESSURE'); return false }
      const wire = encodeDevicePeerFrame(frame)
      if (wire === null) { options.failed('PEER_FRAME_OVERSIZED'); return false }
      const bytes = Buffer.byteLength(wire), lease = options.budgets.outgoing.lease(bytes)
      if (!lease) { options.failed('PEER_WRITE_BACKPRESSURE'); return false }
      enqueue({ epoch: frame.epoch, records: [{ wire, bytes }], index: 0, replay: false, references: 0, lease, current, ready: false })()
      return true
    },
    /** Synchronous all-or-nothing admission; the service invokes the returned drain after committing IDs. */
    replay(original: Route, frames: readonly Readonly<AutonomousDeviceFrame>[], current: () => boolean,
      allowed: (event: Readonly<AutonomousDeviceFrame>) => boolean, helloReply?: Record<string, unknown>): (() => void) | null {
      const route: Route = { connId: original.connId, identity: original.identity, incarnation: original.incarnation, epoch: original.epoch }
      if (!current() || options.channel()?.epoch() !== route.epoch) return null
      if (replayJobs >= REPLAY_JOBS || frames.length > 513) { options.failed('PEER_WRITE_BACKPRESSURE'); return null }
      const records: Array<FrameRecord | null> = []
      const availableBytes = DEVICE_PEER_MESSAGE_BYTES - options.budgets.outgoing.snapshot().bytes
      let bytes = 0, count = 0
      const add = (frame: DevicesGatewayFrame, event?: Readonly<AutonomousDeviceFrame>): boolean => {
        const size = devicePeerFrameBytes(frame, availableBytes - bytes)
        if (size === null) return false
        bytes += size
        records.push({ frame, bytes: size, ...(event ? { event } : {}) })
        if (event) count++
        return true
      }
      if (!add({ type: 'hello', ...route, hello: true })
        || (helloReply && !add({ type: 'send', ...route, frameType: 'autonomous_device_result', payload: helloReply }))) {
        options.failed('PEER_WRITE_BACKPRESSURE'); return null
      }
      for (const event of frames) if (allowed(event) && !add({ type: 'send', ...route, frameType: 'autonomous_device_event', payload: event }, event)) {
        options.failed('PEER_WRITE_BACKPRESSURE'); return null
      }
      if (helloReply && !add({ type: 'joined', ...route })) { options.failed('PEER_WRITE_BACKPRESSURE'); return null }
      if (count > REPLAY_REFERENCES - references) { options.failed('PEER_WRITE_BACKPRESSURE'); return null }
      const lease = options.budgets.outgoing.lease(bytes)
      if (!lease) { options.failed('PEER_WRITE_BACKPRESSURE'); return null }
      return enqueue({ epoch: route.epoch, records, index: 0, replay: true, references: count, lease, current, allowed, ready: false })
    },
  }
}
