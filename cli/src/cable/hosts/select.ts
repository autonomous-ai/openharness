import type { HostAgent } from './types.js'

/** The firmware's `CABLE_MAX_AGENTS` (devices/harness-device/firmware/main/cable_client.h): the dial holds no more. */
export const RING_PLACES = 16

const needsYou = (a: HostAgent): boolean => a.state === 'needs-you'
/** Idle for the ring, wider than the state 'idle': done (seen or not) and error too, as nobody is following those. */
const idle = (a: HostAgent): boolean => a.state !== 'working' && !needsYou(a)

/**
 * This computer's agents in a fixed ring for the dial with no Harness window. The list used to be sorted again on every
 * change (65 pushes in one hour of Diego's log, 2026-11-14), so the agent a swipe landed on changed under the finger. The
 * firmware keeps the agent on screen by its id and walks the list it holds, so a fixed list is a fixed ring: an agent
 * keeps its place from when it enters, and a new one enters at the end. Only an idle agent gives up its place (Diego,
 * 2026-11-14): one that works or waits on the person is one the person is following. An agent with no known activity
 * (a Harness agent nobody has reported on yet) counts from when it entered: missing data is not rest (PM, 2026-11-14).
 */
export class DialRing {
  private ring: string[] = []
  /** When each ring id entered: the time of one with no known activity when choosing who goes. */
  private enteredAt = new Map<string, number>()
  /** The ids the last pass listed: one met before enters a full ring only when it needs the person. */
  private seen = new Set<string>()

  constructor(private readonly now: () => number = Date.now) {}

  select(agents: HostAgent[]): { rows: HostAgent[]; total: number } {
    const byId = new Map(agents.map((a) => [a.id, a]))
    const before = this.ring.filter((id) => byId.has(id))
    const inRing = new Set(before)
    const outside = agents
      .map((a, i) => ({ a, i }))
      .filter((x) => !inRing.has(x.a.id))
      .sort((x, y) => Number(needsYou(y.a)) - Number(needsYou(x.a)) || y.a.lastActivityAt - x.a.lastActivityAt || x.i - y.i)
      .map((x) => x.a)
    const entered = new Set<string>()
    const restedSince = (a: HostAgent): number => (a.lastActivityAt > 0 ? a.lastActivityAt : this.enteredAt.get(a.id)!)
    for (const a of outside) {
      if (inRing.size < RING_PLACES) {
        inRing.add(a.id)
        entered.add(a.id)
        continue
      }
      if (this.seen.has(a.id) && !needsYou(a)) continue
      // Only an agent that was in the ring before this pass may go, so none that just entered is replaced.
      let out: HostAgent | undefined
      for (const id of before) {
        const b = byId.get(id)!
        if (inRing.has(id) && idle(b) && (!out || restedSince(b) < restedSince(out))) out = b
      }
      if (!out) break
      inRing.delete(out.id)
      inRing.add(a.id)
      entered.add(a.id)
    }
    const rows = [...before.filter((id) => inRing.has(id)).map((id) => byId.get(id)!), ...agents.filter((a) => entered.has(a.id))]
    this.ring = rows.map((a) => a.id)
    const at = this.now()
    this.enteredAt = new Map(this.ring.map((id) => [id, this.enteredAt.get(id) ?? at]))
    this.seen = new Set(byId.keys())
    return { rows, total: agents.length }
  }
}
