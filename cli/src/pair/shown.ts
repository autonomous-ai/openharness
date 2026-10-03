/**
 * Which window was shown which line (daemons/BRAIN.md, "Security"): a key on a daemon's line — `daemon_act`,
 * `daemon_confirm` — counts only when THIS connection received that line and acknowledged it as displayed
 * (`daemon_shown { id }`), at least ARM_MS before the key. A process that never drew the line (a script that
 * opened the socket and replays ids) has nothing to acknowledge; one that acknowledges and keys in the same
 * breath is too soon. The line's own lifetime (its ttl, a proposal's, a brief's) still decides when its keys
 * stop working: that is checked by whoever owns the line.
 *
 * Every pair frame that carries a keyed id goes out through `sender()`, which records who it went to:
 *   daemon_say { id }, daemon_state { needs[].id, asks[].id, confirms[].id }, daemon_brief { items[].id }.
 */

/** A key arms this long after its line was acknowledged as displayed. */
export const ARM_MS = 400
/** Lines remembered at once; the oldest are forgotten first (their keys stop working long before). */
const REMEMBER_MAX = 2_000

export type ShownRefusal = 'NOT_SHOWN' | 'TOO_SOON'

type Frame = Record<string, unknown>

/** The keyed ids a local frame carries. */
export function keyedIds(frame: Frame): string[] {
  const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload as Frame : null
  if (!payload) return []
  const idsOf = (rows: unknown): string[] => Array.isArray(rows)
    ? rows.flatMap((row) => row && typeof row === 'object' && typeof (row as Frame).id === 'string' ? [(row as Frame).id as string] : [])
    : []
  switch (frame.type) {
    case 'daemon_say': return typeof payload.id === 'string' ? [payload.id] : []
    case 'daemon_state': return [...idsOf(payload.needs), ...idsOf(payload.asks), ...idsOf(payload.confirms)]
    case 'daemon_brief': return idsOf(payload.items)
    default: return []
  }
}

export class ShownLines {
  /** id → connection → when it was acknowledged as displayed (null: received, not yet shown). */
  private readonly lines = new Map<string, Map<string, number | null>>()

  constructor(private readonly now: () => number = Date.now) {}

  /** These connections received these ids. */
  offer(ids: readonly string[], connIds: Iterable<string>): void {
    const conns = [...connIds]
    if (!conns.length) return
    for (const id of ids) {
      let seen = this.lines.get(id)
      if (!seen) {
        seen = new Map()
        this.lines.set(id, seen)
        if (this.lines.size > REMEMBER_MAX) this.lines.delete(this.lines.keys().next().value as string)
      }
      for (const conn of conns) if (!seen.has(conn)) seen.set(conn, null)
    }
  }

  /** Wrap a local send so every keyed id it carries is recorded against the connections it reaches. */
  sender(send: (frame: Frame) => void, connIds: () => Iterable<string>): (frame: Frame) => void {
    return (frame) => {
      this.offer(keyedIds(frame), connIds())
      send(frame)
    }
  }

  senderTo(send: (connId: string, frame: Frame) => boolean): (connId: string, frame: Frame) => boolean {
    return (connId, frame) => {
      this.offer(keyedIds(frame), [connId])
      return send(connId, frame)
    }
  }

  /** `daemon_shown { id }` from this connection. Only a line it received can be shown on it. */
  shown(connId: string, id: string): boolean {
    const seen = this.lines.get(id)
    if (!seen || !seen.has(connId)) return false
    if (seen.get(connId) === null) seen.set(connId, this.now())
    return true
  }

  /** Why a key from this connection on this line does not count yet, or null when it does. */
  check(connId: string, id: string): ShownRefusal | null {
    const at = this.lines.get(id)?.get(connId)
    if (at === undefined || at === null) return 'NOT_SHOWN'
    return this.now() - at < ARM_MS ? 'TOO_SOON' : null
  }

  /** A connection went away: nothing it was shown counts for anyone else. */
  detach(connId: string): void {
    for (const [id, seen] of this.lines) {
      seen.delete(connId)
      if (!seen.size) this.lines.delete(id)
    }
  }
}
