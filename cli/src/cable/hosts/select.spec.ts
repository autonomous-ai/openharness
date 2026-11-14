import { describe, expect, it } from 'vitest'
import { AppRings, DialRing, RING_PLACES } from './select.js'
import type { HostAgent } from './types.js'

function agent(id: string, over: Partial<HostAgent> = {}): HostAgent {
  return {
    id,
    engine: 'claude',
    name: id,
    host: 'terminal', app: 'terminal',
    state: 'idle',
    lastActivityAt: 0,
    unseenDone: false,
    ...over,
  }
}

const ids = (rows: HostAgent[]) => rows.map((a) => a.id)

/** `a1`…`an` (or from another number): each one's last activity is its number, so a1 is idle the longest. */
const row = (n: number, prefix = 'a', from = 1): HostAgent[] =>
  Array.from({ length: n }, (_, i) => agent(`${prefix}${from + i}`, { lastActivityAt: from + i }))
const needs = (a: HostAgent): HostAgent => ({ ...a, state: 'needs-you' })
const working = (a: HostAgent): HostAgent => ({ ...a, state: 'working' })

describe('DialRing', () => {
  it('an agent keeps its place whatever its state and activity do', () => {
    const ring = new DialRing()
    const [a, b, c, d] = row(4)
    expect(ids(ring.select([a, b, c, d]).rows)).toEqual(['a1', 'a2', 'a3', 'a4'])
    // What used to move an agent: a question, a turn, an answer not yet seen, fresh activity. And the registry's order.
    const moved: HostAgent[] = [{ ...working(d), lastActivityAt: 99 }, { ...c, state: 'done', unseenDone: true }, needs(b), a]
    const again = ring.select(moved)
    expect(ids(again.rows)).toEqual(['a1', 'a2', 'a3', 'a4'])
    // The rows are this pass's own objects: the host reads each one's source by it.
    expect(again.rows[1]).toBe(moved[2])
  })

  it('a new agent enters at the end', () => {
    const ring = new DialRing()
    ring.select(row(2))
    expect(ids(ring.select([agent('n', { lastActivityAt: 99 }), ...row(2)]).rows)).toEqual(['a1', 'a2', 'n'])
  })

  it('an agent that ends leaves and the others close up; under a new id it is a new agent', () => {
    const ring = new DialRing()
    const [a, b, c, d] = row(4)
    ring.select([a, b, c, d])
    expect(ids(ring.select([a, c, d]).rows)).toEqual(['a1', 'a3', 'a4'])
    expect(ids(ring.select([a, agent('a3b'), d]).rows)).toEqual(['a1', 'a4', 'a3b'])
  })

  it('sixteen places, the firmware\'s; total is every agent', () => {
    expect(RING_PLACES).toBe(16)
    const first = new DialRing().select(row(20))
    expect(first.rows).toHaveLength(16)
    expect(first.total).toBe(20)
  })

  it('the first ring: the registry\'s order, cut to those that need the person, then the most recent activity', () => {
    const list = row(18)
    list[0] = needs(list[0])
    // a1 is idle the longest and waits on the person: it stays. a2 and a3 are cut.
    expect(ids(new DialRing().select(list).rows)).toEqual(['a1', ...ids(row(15, 'a', 4))])
  })

  it('a full ring: a new agent takes the place of the one idle the longest, and goes to the end', () => {
    const ring = new DialRing()
    const held = row(16)
    ring.select(held)
    const next = ring.select([...held, agent('n')])
    expect(ids(next.rows)).toEqual([...ids(row(15, 'a', 2)), 'n'])
    expect(next.total).toBe(17)
  })

  it('a full ring: an agent with no known activity counts from when it entered, not as idle the longest', () => {
    let now = 100
    const ring = new DialRing(() => now)
    const observed = agent('o', { host: 'observed', lastActivityAt: 50 })
    const busy = row(14).map(working)
    ring.select([observed, ...busy])
    now = 200
    // A Harness agent whose activity nobody has reported yet: 0 says nothing about how long it has rested.
    const harness = agent('h', { host: 'harness' })
    ring.select([observed, ...busy, harness])
    now = 300
    expect(ids(ring.select([observed, ...busy, harness, agent('n', { lastActivityAt: 250 })]).rows)).toEqual([...ids(busy), 'h', 'n'])
  })

  it('a full ring: an agent with no known activity keeps its entry time while it stays, and gets a new one when it comes back', () => {
    const observed = agent('o', { host: 'observed', lastActivityAt: 150 })
    const busy = row(14).map(working)
    const harness = agent('h', { host: 'harness' })
    const newcomer = agent('n', { lastActivityAt: 250 })
    const pass = (leaves: boolean) => {
      let now = 100
      const ring = new DialRing(() => now)
      ring.select([observed, ...busy, harness])
      now = 160
      if (leaves) ring.select([observed, ...busy])
      ring.select([observed, ...busy, harness])
      now = 300
      return ids(ring.select([observed, ...busy, harness, newcomer]).rows)
    }
    // It stayed since 100, before o's last activity at 150: it is the one idle the longest.
    expect(pass(false)).toEqual(['o', ...ids(busy), 'n'])
    // It ended and came back at 160, after o's last activity: o goes.
    expect(pass(true)).toEqual([...ids(busy), 'h', 'n'])
  })

  it('a full ring: an agent seen before stays outside until it needs the person', () => {
    const ring = new DialRing()
    const list = row(17)
    ring.select(list)
    const inRing = ids(row(16, 'a', 2))
    const withFirst = (a1: HostAgent): HostAgent[] => [a1, ...list.slice(1)]
    expect(ids(ring.select(withFirst({ ...working(list[0]), lastActivityAt: 999 })).rows)).toEqual(inRing)
    expect(ids(ring.select(withFirst({ ...list[0], state: 'done', unseenDone: true, lastActivityAt: 999 })).rows)).toEqual(inRing)
    expect(ids(ring.select(withFirst(needs(list[0]))).rows)).toEqual([...ids(row(15, 'a', 3)), 'a1'])
  })

  it('a ring agent that needs the person is never replaced', () => {
    const ring = new DialRing()
    const held = row(16)
    held[0] = needs(held[0])
    ring.select(held)
    expect(ids(ring.select([...held, agent('n')]).rows)).toEqual(['a1', ...ids(row(14, 'a', 3)), 'n'])
  })

  it('a working ring agent is never replaced, however long it has been silent; an answer not yet seen is idle', () => {
    const ring = new DialRing()
    const held = row(16)
    held[0] = working(held[0])
    held[1] = { ...held[1], state: 'done', unseenDone: true }
    ring.select(held)
    // a1 has the oldest activity of all and is mid-turn: it stays. a2, done, is the one idle the longest.
    expect(ids(ring.select([...held, agent('n')]).rows)).toEqual(['a1', ...ids(row(14, 'a', 3)), 'n'])
  })

  it('no ring agent is idle: a newcomer waits outside, and is no longer new', () => {
    const ring = new DialRing()
    const held = row(16).map((a, i) => (i % 2 ? needs(a) : working(a)))
    ring.select(held)
    const n = agent('n', { lastActivityAt: 99 })
    expect(ids(ring.select([...held, n]).rows)).toEqual(ids(held))
    // One that needs the person waits too: nobody in the ring may go.
    expect(ids(ring.select([...held, needs(n)]).rows)).toEqual(ids(held))
    // a5's turn ended. The newcomer has been seen: being there takes no place.
    const rested = held.map((a): HostAgent => (a.id === 'a5' ? { ...a, state: 'done' } : a))
    expect(ids(ring.select([...rested, n]).rows)).toEqual(ids(held))
    // Once it needs the person it takes the one place that may go.
    expect(ids(ring.select([...rested, needs(n)]).rows)).toEqual([...ids(held).filter((id) => id !== 'a5'), 'n'])
  })

  it('a free place goes to one that needs the person, before the most recent activity', () => {
    const ring = new DialRing()
    const list = row(19)
    ring.select(list)
    // a1, a2 and a3 were cut. a16 ends as a1 starts to wait: a1 takes its place, and nobody is replaced for it.
    const next = list.filter((a) => a.id !== 'a16').map((a) => (a.id === 'a1' ? needs(a) : a))
    expect(ids(ring.select(next).rows)).toEqual([...ids(row(12, 'a', 4)), 'a17', 'a18', 'a19', 'a1'])
  })

  it('with nobody waiting, a free place goes to the most recent activity', () => {
    const ring = new DialRing()
    const list = row(19)
    ring.select(list)
    expect(ids(ring.select(list.filter((a) => a.id !== 'a16')).rows)).toEqual([...ids(row(12, 'a', 4)), 'a17', 'a18', 'a19', 'a3'])
  })

  it('an id is forgotten once its source stops listing it: back again, it is new', () => {
    const ring = new DialRing()
    const list = row(17)
    ring.select(list)
    ring.select(list.slice(1))
    expect(ids(ring.select(list).rows)).toEqual([...ids(row(15, 'a', 3)), 'a1'])
  })

  it('several enter in one pass: they go to the end in the registry\'s order', () => {
    const ring = new DialRing()
    const [a, b] = row(2)
    ring.select([a, b])
    const pass = [agent('x', { lastActivityAt: 1 }), a, needs(agent('y')), b, agent('z', { lastActivityAt: 9 })]
    expect(ids(ring.select(pass).rows)).toEqual(['a1', 'a2', 'x', 'y', 'z'])
  })

  it('more new agents than places in one pass: the ring changes once, and no further on the next pass', () => {
    const ring = new DialRing()
    const held = row(16)
    held[0] = needs(held[0])
    ring.select(held)
    // Twenty sessions a scan found together. Fifteen places may go: the one that needs the person takes the first,
    // old as its activity is, and the fourteen most recent the rest. Nobody that entered is replaced; a1 still waits.
    const scan = row(20, 's', 101)
    scan[0] = needs(scan[0])
    const after = ['a1', 's101', ...ids(row(14, 's', 107))]
    expect(ids(ring.select([...held, ...scan]).rows)).toEqual(after)
    // s102 to s106 found no place and are no longer new: the same list again moves nobody.
    expect(ids(ring.select([...held, ...scan]).rows)).toEqual(after)
  })

  it('equal activity: the place nearest the front goes, and the registry\'s order says who enters', () => {
    const level = (list: HostAgent[]): HostAgent[] => list.map((a) => ({ ...a, lastActivityAt: 5 }))
    const ring = new DialRing()
    const held = level(row(16))
    ring.select(held)
    expect(ids(ring.select([...held, agent('n')]).rows)).toEqual([...ids(held).slice(1), 'n'])
    expect(ids(new DialRing().select(level(row(18))).rows)).toEqual(ids(row(16)))
  })

  it('an empty list, and an input left as it was', () => {
    expect(new DialRing().select([])).toEqual({ rows: [], total: 0 })
    const input = [agent('b', { lastActivityAt: 1 }), agent('a', { lastActivityAt: 2 })]
    new DialRing().select(input)
    expect(ids(input)).toEqual(['b', 'a'])
  })
})

describe('AppRings', () => {
  const at = (app: string) => (a: HostAgent): HostAgent => ({ ...a, app })
  const ringIds = (rings: AppRings, app: string) => ids(rings.ring(app).rows)

  it('one ring per app, each over its own agents only', () => {
    const rings = new AppRings()
    const [a1, a2, a3, a4] = row(4)
    rings.update([at('ghostty')(a1), at('orca')(a2), at('ghostty')(a3), at('orca')(a4)])
    expect(ringIds(rings, 'ghostty')).toEqual(['a1', 'a3'])
    expect(ringIds(rings, 'orca')).toEqual(['a2', 'a4'])
    expect(rings.ring('vscode')).toEqual({ rows: [], total: 0 })
  })

  it('inside a ring the order is fixed: a state change moves nobody, a new agent goes to the end, an ended one closes up', () => {
    const rings = new AppRings()
    const [a, b, c] = row(3).map(at('ghostty'))
    const others = row(2, 'o').map(at('orca'))
    rings.update([a, b, c, ...others])
    rings.update([{ ...working(c), lastActivityAt: 99 }, needs(b), a, needs(others[1])])
    expect(ringIds(rings, 'ghostty')).toEqual(['a1', 'a2', 'a3'])
    rings.update([at('ghostty')(agent('n')), a, b, c, ...row(3, 'o').map(at('orca'))])
    expect(ringIds(rings, 'ghostty')).toEqual(['a1', 'a2', 'a3', 'n'])
    rings.update([at('ghostty')(agent('n')), a, c])
    expect(ringIds(rings, 'ghostty')).toEqual(['a1', 'a3', 'n'])
  })

  it('each ring holds at most 16; total is the app\'s count', () => {
    const rings = new AppRings()
    rings.update([...row(20).map(at('ghostty')), ...row(3, 'o').map(at('orca'))])
    expect(rings.ring('ghostty').rows).toHaveLength(RING_PLACES)
    expect(rings.ring('ghostty').total).toBe(20)
    expect(ringIds(rings, 'orca')).toEqual(['o1', 'o2', 'o3'])
    expect(rings.ring('orca').total).toBe(3)
  })

  it('a ring is dropped when its app empties, and the app starts a new ring when it comes back', () => {
    const rings = new AppRings()
    const [a, b] = row(2).map(at('ghostty'))
    const o = at('orca')(agent('o'))
    rings.update([a, b, o])
    rings.update([b, a, o])
    expect(ringIds(rings, 'ghostty')).toEqual(['a1', 'a2'])
    rings.update([o])
    expect(rings.ring('ghostty')).toEqual({ rows: [], total: 0 })
    // The old ring would keep a1 first: a new one takes the registry's order.
    rings.update([b, a, o])
    expect(ringIds(rings, 'ghostty')).toEqual(['a2', 'a1'])
  })

  it('the apps keep their order: a new app at the end, a gone app closes up', () => {
    const rings = new AppRings()
    const g = at('ghostty')(agent('g'))
    const o = at('orca')(agent('o'))
    const v = at('vscode')(agent('v'))
    const order = () => rings.apps().map((x) => x.id)
    rings.update([o, g])
    expect(order()).toEqual(['orca', 'ghostty'])
    rings.update([v, g, o])
    expect(order()).toEqual(['orca', 'ghostty', 'vscode'])
    rings.update([v, o])
    expect(order()).toEqual(['orca', 'vscode'])
    rings.update([g, v, o])
    expect(order()).toEqual(['orca', 'vscode', 'ghostty'])
  })

  it('count and waiting follow the agents', () => {
    const rings = new AppRings()
    const list = [...row(18).map(at('ghostty')), at('orca')(agent('o'))]
    list[0] = needs(list[0])
    list[17] = needs(list[17])
    rings.update(list)
    expect(rings.apps()).toEqual([
      { id: 'ghostty', count: 18, waiting: 2 },
      { id: 'orca', count: 1, waiting: 0 },
    ])
    expect([...rings.counts()]).toEqual([['ghostty', 18], ['orca', 1]])
    rings.update([needs(list[18]), list[1]])
    expect(rings.apps()).toEqual([
      { id: 'ghostty', count: 1, waiting: 0 },
      { id: 'orca', count: 1, waiting: 1 },
    ])
    expect([...rings.counts()]).toEqual([['ghostty', 1], ['orca', 1]])
  })

  it('an agent whose app changes leaves its ring and joins the other at the end', () => {
    const rings = new AppRings()
    const s = agent('s', { lastActivityAt: 50 })
    const t = agent('t')
    const [g1, g2] = row(2, 'g').map(at('ghostty'))
    // The open scan lists s in terminal until its first hook says it runs in Ghostty.
    rings.update([s, t, g1, g2])
    expect(ringIds(rings, 'terminal')).toEqual(['s', 't'])
    rings.update([at('ghostty')(s), t, g1, g2])
    expect(ringIds(rings, 'terminal')).toEqual(['t'])
    expect(ringIds(rings, 'ghostty')).toEqual(['g1', 'g2', 's'])
    expect(rings.apps()).toEqual([
      { id: 'terminal', count: 1, waiting: 0 },
      { id: 'ghostty', count: 3, waiting: 0 },
    ])
  })

  it('the map is bounded: 20 agents with 20 unknown app ids make one terminal ring', () => {
    const rings = new AppRings()
    rings.update(row(20).map((a, i) => at(`unknown-${i}`)(a)))
    expect(rings.apps()).toEqual([{ id: 'terminal', count: 20, waiting: 0 }])
    expect(rings.ring('terminal').rows).toHaveLength(RING_PLACES)
    expect(rings.ring('terminal').total).toBe(20)
    expect(rings.ring('unknown-0')).toEqual({ rows: [], total: 0 })
  })
})
