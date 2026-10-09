import { createHash } from 'node:crypto'
import type { AgentFrame } from '../../lib/agentFrame.js'

type Snapshot = { scope: string; rows: Map<string, string>; bytes: number }
const MAX_SNAPSHOTS = 8
const MAX_ROWS = 8192
const MAX_BYTES = 1024 * 1024
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** M2's 358 stopped panes made every minute's inventory nearly a megabyte. Retain only
 * fingerprints; clients explicitly opt into deltas and keep their own complete snapshot.
 * A revision is a comparison token, never authority to see a row: every reply starts from
 * the current authorized projection, including on a cache hit. */
export function createAgentInventory() {
  const snapshots = new Map<string, Snapshot>()
  let rows = 0, bytes = 0
  return (agents: AgentFrame[], request: Record<string, unknown>, scope: string): Record<string, unknown> => {
    const sync = request.sync
    if (!sync || typeof sync !== 'object' || Array.isArray(sync) || (sync as Record<string, unknown>).version !== 1) return { agents }
    const since = (sync as Record<string, unknown>).since
    const fingerprints = new Map(agents.map(agent => [agent.id, digest(agent)]))
    const revision = digest([1, scope, [...fingerprints]])
    const previous = typeof since === 'string' ? snapshots.get(since) : undefined
    const base = previous?.scope === scope ? previous : undefined
    const size = [...fingerprints].reduce((n, [id, hash]) => n + Buffer.byteLength(id) + hash.length + 64, Buffer.byteLength(scope) + 128)
    if (!snapshots.has(revision) && fingerprints.size <= MAX_ROWS && size <= MAX_BYTES) {
      snapshots.set(revision, { scope, rows: fingerprints, bytes: size })
      rows += fingerprints.size; bytes += size
      while (snapshots.size > MAX_SNAPSHOTS || rows > MAX_ROWS || bytes > MAX_BYTES) {
        const oldest = snapshots.keys().next().value!
        const removed = snapshots.get(oldest)!
        snapshots.delete(oldest)
        rows -= removed.rows.size; bytes -= removed.bytes
      }
    }
    if (since === revision) return { agents: [], sync: { version: 1, base: since, revision } }
    if (!base) return { agents, sync: { version: 1, revision } }
    return {
      agents: agents.filter(agent => base.rows.get(agent.id) !== fingerprints.get(agent.id)),
      sync: { version: 1, base: since, revision, order: [...fingerprints.keys()] },
    }
  }
}
