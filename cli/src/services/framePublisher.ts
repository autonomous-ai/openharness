/** Bounded publication on one service connection; stale work never borrows a later run's authority. */
import { createHash } from 'node:crypto'
import type { AgentLife, AgentView, CoreApi } from '../core/api.js'
import { FRAME_PART_BYTES, FRAME_PART_ENTRIES, FRAME_PART_TOTAL_BYTES } from '../harnessd/services.js'
import type { CoreConnection } from './process.js'

type Fields = Readonly<Record<string, unknown>>
type Update = { source: AgentView; agentId: string; frameEpoch: string | undefined; fields: Fields; bytes: number; fingerprint: string }
type Pending = { next?: Update; bytes: number; cancel(): void }

export function createFramePublisher(
  legacy: (session: Pick<AgentView, 'agentId'>, fields: Fields) => { query: string; payload: Record<string, unknown> },
  log: (line: string) => void = line => console.warn(line),
) {
  let connection: CoreConnection | null = null, generation = 0, failed = false, heldBytes = 0
  const pending = new Map<string, Pending>()
  const live = new Map<string, { session: AgentView; frameEpoch: string | undefined; acknowledged?: string }>()
  const refused = (code = 'FRAME_PART_UNAVAILABLE'): void => log(`[frames] ${code}`)
  const heard = (event: AgentLife): void => {
    if (event.kind === 'running') {
      if (!live.has(event.session.agentId) && live.size >= FRAME_PART_ENTRIES) { refused('FRAME_PART_LIMIT'); return }
      const prior = live.get(event.session.agentId)
      live.set(event.session.agentId, { session: event.session, frameEpoch: event.session.frameEpoch,
        acknowledged: prior?.frameEpoch === event.session.frameEpoch ? prior?.acknowledged : undefined })
    } else if (event.kind === 'ended' || event.kind === 'purged') live.delete(event.agentId)
  }
  const owns = (agentId: string, frameEpoch: string | undefined, session: AgentView): boolean => {
    const owner = live.get(agentId)
    return !!owner && (frameEpoch ? owner.frameEpoch === frameEpoch : owner.session === session)
  }
  const publish = (session: AgentView, fields: Fields, captured?: Update): void => {
    if (!connection || failed) return
    const agentId = captured ? captured.agentId : session.agentId
    const frameEpoch = captured ? captured.frameEpoch : session.frameEpoch
    if (!owns(agentId, frameEpoch, session)) { refused('FRAME_PART_STALE'); return }
    let update: Update
    try {
      const wire = JSON.stringify(fields), bytes = Buffer.byteLength(wire)
      if (bytes > FRAME_PART_BYTES) { refused('FRAME_PART_LIMIT'); return }
      update = captured ?? { source: session, agentId, frameEpoch, fields: JSON.parse(wire) as Fields, bytes,
        fingerprint: createHash('sha256').update(wire).digest('hex') }
    } catch { refused('FRAME_PART_INVALID'); return }
    const before = pending.get(agentId)
    // Keep only a bounded digest per live agent, not another payload cache. An in-flight change may need undoing.
    if (!before && live.get(agentId)?.acknowledged === update.fingerprint) return
    if (heldBytes - (before?.next?.bytes ?? 0) + update.bytes > FRAME_PART_TOTAL_BYTES) { refused('FRAME_PART_LIMIT'); return }
    if (before) { heldBytes += update.bytes - (before.next?.bytes ?? 0); before.next = update; return }
    const mine = generation, source = connection
    let timer: ReturnType<typeof setTimeout>
    const slot: Pending = { bytes: update.bytes, cancel: () => clearTimeout(timer) }
    pending.set(agentId, slot)
    heldBytes += update.bytes
    const current = () => generation === mine && source === connection
    const work = async (): Promise<void> => {
      let answer = await source.query('frame_part', { agentId, frameEpoch, fields: update.fields })
      if (!current() || !owns(agentId, frameEpoch, session)) return
      // Published clients keep their fields; an older core receives its former query. Delete 2026-12-18.
      if (answer.error === 'UNKNOWN_QUERY') {
        const old = legacy({ agentId }, update.fields)
        answer = await source.query(old.query, old.payload)
      }
      if (current() && owns(agentId, frameEpoch, session)) {
        if (answer.error) refused()
        else live.get(agentId)!.acknowledged = update.fingerprint
      }
    }
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('frame publication deadline')), 10_000)
      timer.unref?.()
    })
    void Promise.race([work(), deadline]).catch(() => {
      // Stop asking this connection after a deadline; its unresolved query map cannot keep growing.
      if (current()) { failed = true; refused() }
    }).finally(() => {
      clearTimeout(timer)
      if (!current()) return
      pending.delete(agentId)
      heldBytes -= slot.bytes + (slot.next?.bytes ?? 0)
      if (slot.next) publish(slot.next.source, slot.next.fields, slot.next)
    })
  }
  const reset = (source: CoreConnection | null): void => {
    generation++; connection = source; failed = false
    for (const slot of pending.values()) slot.cancel()
    pending.clear(); live.clear(); heldBytes = 0
  }
  return {
    scope(core: CoreApi): CoreApi {
      return { ...core, agents: { ...core.agents, publishFrame: publish,
        follow: (listener, options) => core.agents.follow!((event) => { heard(event); listener(event) }, options),
      } }
    },
    connected: (source: CoreConnection): void => reset(source),
    disconnected: (): void => reset(null),
  }
}
