import type { AppCounts } from './appFilter.js'
import { APP_IDS, UNKNOWN_APP } from './hostDetect.js'
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

interface AppRing {
  ring: DialRing
  rows: HostAgent[]
  waiting: number
}

/** The app whose page an agent is on: an app outside the set is the unknown one, so there are never more than APP_IDS. */
const pageOf = (a: HostAgent): string => (APP_IDS.includes(a.app) ? a.app : UNKNOWN_APP)

/**
 * One `DialRing` per app, for the dial that shows one app at a time. The apps keep the order they appeared in, so the
 * dial's list of apps holds still as the rings do. An app with no agents left loses its ring: back again, it starts a
 * new one, as an agent back under its id is new.
 */
export class AppRings {
  /** Each app's ring, in the order the apps appeared. */
  private rings = new Map<string, AppRing>()
  private sizes = new Map<string, number>()

  update(agents: HostAgent[]): void {
    const byApp = new Map<string, HostAgent[]>()
    for (const a of agents) {
      const app = pageOf(a)
      const list = byApp.get(app)
      if (list) list.push(a)
      else byApp.set(app, [a])
    }
    for (const app of this.rings.keys()) if (!byApp.has(app)) this.rings.delete(app)
    for (const [app, list] of byApp) {
      const entry = this.rings.get(app) ?? { ring: new DialRing(), rows: [], waiting: 0 }
      entry.rows = entry.ring.select(list).rows
      entry.waiting = list.filter(needsYou).length
      this.rings.set(app, entry)
    }
    this.sizes = new Map([...this.rings.keys()].map((app) => [app, byApp.get(app)!.length]))
  }

  apps(): Array<{ id: string; count: number; waiting: number }> {
    return [...this.rings].map(([id, r]) => ({ id, count: this.sizes.get(id)!, waiting: r.waiting }))
  }

  ring(app: string): { rows: HostAgent[]; total: number } {
    return { rows: this.rings.get(app)?.rows ?? [], total: this.sizes.get(app) ?? 0 }
  }

  /** Each app's agents among these, and of those the ones whose app is known, by the page each is on. Counted from the
   *  agents given, not the last update: the filter decides a settle or a pick between two list reads on the agents there
   *  now. */
  counts(agents: readonly HostAgent[]): AppCounts {
    const all = new Map<string, number>()
    const known = new Map<string, number>()
    for (const a of agents) {
      const app = pageOf(a)
      all.set(app, (all.get(app) ?? 0) + 1)
      if (!a.appPending) known.set(app, (known.get(app) ?? 0) + 1)
    }
    return { all, known }
  }
}
