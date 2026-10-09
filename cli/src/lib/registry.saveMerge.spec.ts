import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergedForSave, saveMergeHelpers, strictPersistedRow } from './registry.js'
import { sameProcessIdentity, terminalRouteKey } from './terminalRuntime.js'

// A save merges this view's changed rows into the file's. It used to compare each changed row with every
// row in the file, which made the first start on a fully legacy registry quadratic (20.7 s for 2,000
// rows, 122 s for 5,000, measured 2026-10-08). The merge now finds a row's rivals by key. These cases hold
// it to the scan it replaced, kept below as it was, on the same inputs: what it returns, in what order,
// field by field, is what the file is written from.

type Row = Record<string, unknown>
const { threeWayRow, withIntended, normalizedRuntimes, rowFingerprint } = saveMergeHelpers

/** The merge as it was before 2026-10-08, verbatim but for the counters, which say what each case exercised. */
function scanMerge(
  latest: ReadonlyMap<string, Row>,
  currentRows: ReadonlyMap<string, Row>,
  persistedBaseline: ReadonlyMap<string, string>,
  intents: ReadonlyMap<string, ReadonlySet<string>>,
  seen = { claimed: 0, carried: 0, readded: 0, intended: 0 },
): Map<string, Row> {
  const merged = new Map(latest)
  for (const baselineId of persistedBaseline.keys()) {
    if (!currentRows.has(baselineId)) merged.delete(baselineId)
  }
  for (const [agentId, current] of currentRows) {
    const baseline = persistedBaseline.get(agentId)
    const intended = intents.get(agentId)
    if (baseline === rowFingerprint(current) && (!intended || !latest.has(agentId))) continue
    let candidate = latest.has(agentId)
      ? threeWayRow(baseline, current, latest.get(agentId)!)
      : current
    if (intended) { candidate = withIntended(candidate, current, intended); seen.intended++ }
    const process = strictPersistedRow(candidate)?.processIdentity
    const engine = candidate.engine
    const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId : ''
    const routes = new Set(normalizedRuntimes(candidate.runtimes, candidate.tmuxPane).map(terminalRouteKey))
    for (const [otherId, other] of [...merged]) {
      if (otherId === agentId) continue
      const otherRow = strictPersistedRow(other)
      if (!otherRow) continue
      const sameProcess = otherRow.engine === engine && sameProcessIdentity(process, otherRow.processIdentity)
      const sameSession = !!sessionId && otherRow.sessionId === sessionId
      const sameRoute = otherRow.runtimes.some((runtime) => routes.has(terminalRouteKey(runtime)))
      if (!sameProcess && !sameSession && !sameRoute) continue
      if (sameProcess && !candidate.sessionId && otherRow.sessionId) {
        seen.carried++
        candidate = {
          ...candidate,
          sessionId: otherRow.sessionId,
          boundAt: otherRow.boundAt,
          transcriptPath: otherRow.transcriptPath,
          source: otherRow.source,
          lastHookAt: otherRow.lastHookAt,
        }
      }
      seen.claimed++
      merged.delete(otherId)
    }
    if (baseline !== undefined && !latest.has(agentId)) seen.readded++
    merged.set(agentId, candidate)
  }
  return merged
}

/** mulberry32: the same cases on every run and every machine. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BASE = 1790900000000
const PLAN = { id: '12345678-1234-1234-1234-123456789012', identity: 'fixture-conversation', requestedAt: BASE, state: 'waiting' }

/** Rows drawn from small pools of pids, conversations and panes, so rows often share one. */
function generator(seed: number, size: number) {
  const r = random(seed)
  const pick = <T>(values: readonly T[]): T => values[Math.floor(r() * values.length)]
  const pool = Math.max(2, Math.ceil(size * 0.8))
  const process = (): Row | null => {
    if (r() < 0.3) return null
    const pid = 1000 + Math.floor(r() * pool)
    // Start ticks decide when both sides have them and the marker otherwise, so mix both.
    return {
      pid, executable: '/fixture/engine', startMarker: `marker-${pid}-${Math.floor(r() * 2)}`,
      ...(r() < 0.5 ? { startTicks: Math.floor(r() * 2) } : {}),
    }
  }
  const session = (): string => r() < 0.35 ? '' : `session-${Math.floor(r() * pool)}`
  const panes = (): string[] => {
    const first = Math.floor(r() * pool * 1.5)
    return r() < 0.2 ? [`%${first}`, `%${first + 1 + Math.floor(r() * 3)}`] : [`%${first}`]
  }
  /** A v2 row's runtimes and the pane it projects for older readers: its first tmux runtime, in key order. */
  const terminals = (): Row => {
    const runtimes = panes().map((paneId) => ({ backend: 'tmux' as const, paneId }))
      .sort((a, b) => terminalRouteKey(a).localeCompare(terminalRouteKey(b)))
    // A few rows name no primary pane: valid for a dormant row, refused for an active one.
    return { runtimes, tmuxPane: runtimes[0].paneId, primaryRuntimeKey: r() < 0.95 ? terminalRouteKey(runtimes[r() < 0.5 ? 0 : runtimes.length - 1]) : '' }
  }
  const v2 = (agentId: string): Row => {
    const sessionId = session()
    const raw: Row = {
      schemaVersion: 2, active: r() < 0.8, agentId, sessionId,
      boundAt: sessionId ? BASE + Math.floor(r() * 1000) : null,
      engine: pick(['claude', 'claude', 'codex']),
      transcriptPath: sessionId ? `/fixture/projects/${sessionId}.jsonl` : null,
      projectDir: 'fixture', cwd: `/fixture/${Math.floor(r() * 3)}`,
      ...terminals(),
      source: sessionId ? 'hook' : null, title: r() < 0.5 ? `title ${Math.floor(r() * 9)}` : null,
      model: null, cliVersion: null, processIdentity: process(),
      registeredAt: BASE, touchedAt: BASE + Math.floor(r() * 100),
      lastHookAt: BASE + Math.floor(r() * 100), lastTranscriptAt: BASE + Math.floor(r() * 100),
      ...(r() < 0.15 ? { closePlan: { ...PLAN } } : {}),
      ...(r() < 0.15 ? { launch: { state: pick(['starting', 'ready']) } } : {}),
    }
    const strict = strictPersistedRow(raw)
    return strict ? JSON.parse(JSON.stringify(strict)) as Row : raw
  }
  const legacy = (agentId: string): Row => ({
    ...(r() < 0.5 ? { agentId } : { launcherId: agentId }),
    engine: 'claude', tmuxPane: panes()[0], sessionId: session(), cwd: '/fixture/legacy',
    ...(r() < 0.5 ? { processIdentity: process() } : {}), registeredAt: BASE, updatedAt: BASE,
  })
  /** Another writer, or this view, changing a row: one or two fields, sometimes only the key order. */
  const edited = (row: Row): Row => {
    const next: Row = { ...row }
    for (let i = 0, edits = 1 + Math.floor(r() * 2); i < edits; i++) {
      switch (Math.floor(r() * 8)) {
        case 0: next.title = `edited ${Math.floor(r() * 9)}`; break
        case 1: {
          const sessionId = session()
          Object.assign(next, { sessionId, boundAt: sessionId ? BASE + 7 : null, transcriptPath: sessionId ? `/fixture/projects/${sessionId}.jsonl` : null, source: sessionId ? 'hook' : null })
          break
        }
        case 2: next.processIdentity = process(); break
        case 3: Object.assign(next, terminals()); break
        case 4: if (next.closePlan) delete next.closePlan; else next.closePlan = { ...PLAN, state: pick(['waiting', 'failed']) }; break
        case 5: next.active = !next.active; break
        case 6: next.lastHookAt = BASE + 500 + Math.floor(r() * 100); break
        default: return Object.fromEntries(Object.entries(next).reverse())
      }
    }
    return next
  }
  const shuffled = <T>(values: T[]): T[] => {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1))
      ;[values[i], values[j]] = [values[j], values[i]]
    }
    return values
  }
  return { r, pick, v2, legacy, edited, shuffled }
}

interface Case {
  latest: Map<string, Row>
  current: Map<string, Row>
  baselines: Map<string, string>
  intents: Map<string, Set<string>>
}

/**
 * One save: what this view last saved, what it holds now, and what the file says now, which another
 * process may have edited, emptied of a row, or added rows to (legacy ones too) since.
 */
function saveCase(seed: number, size: number): Case {
  const g = generator(seed, size)
  const latestRows: Array<[string, Row]> = []
  const current: Array<[string, Row]> = []
  const baselines = new Map<string, string>()
  const intents = new Map<string, Set<string>>()
  for (let i = 0; i < size; i++) {
    const id = `agent-${i}`
    const role = g.pick(['unchanged', 'changed', 'changed', 'new', 'dropped', 'external', 'legacy', 'hooked'] as const)
    if (role === 'external') { latestRows.push([id, g.v2(id)]); continue }
    if (role === 'legacy') { latestRows.push([id, g.legacy(id)]); continue }
    if (role === 'hooked') {
      // A hook bound a conversation to a process while the daemon was down, under an id of its own, and
      // this view has just opened the same process with none: the binding is carried over.
      const opened: Row = { ...g.v2(id), sessionId: '', boundAt: null, transcriptPath: null, source: null }
      const hooked: Row = {
        ...g.v2(`hook-${i}`), engine: opened.engine, processIdentity: opened.processIdentity, sessionId: `hooked-${i}`,
        boundAt: BASE + 9, transcriptPath: `/fixture/projects/hooked-${i}.jsonl`, source: 'hook',
      }
      latestRows.push([`hook-${i}`, hooked])
      current.push([id, opened])
      continue
    }
    const saved = g.v2(id)
    if (role !== 'new') baselines.set(id, rowFingerprint(saved))
    if (role !== 'dropped') current.push([id, role === 'changed' ? g.edited(saved) : role === 'new' ? saved : { ...saved }])
    // The file: as saved, edited by another process, or without the row (another process removed it).
    const onFile = g.r()
    if (role === 'new') { if (onFile < 0.2) latestRows.push([id, g.v2(id)]) }
    else if (onFile < 0.55) latestRows.push([id, saved])
    else if (onFile < 0.85) latestRows.push([id, g.edited(saved)])
    if (role !== 'dropped' && g.r() < 0.2) {
      intents.set(id, new Set(g.shuffled(['closePlan', 'title', 'launch', 'sessionId', 'active']).slice(0, 1 + Math.floor(g.r() * 2))))
    }
  }
  return {
    latest: new Map(g.shuffled(latestRows)), current: new Map(g.shuffled(current)), baselines, intents,
  }
}

/** The merge's whole result as text: ids, order, every field and each object's key order. */
const text = (merged: Map<string, Row>): string => JSON.stringify([...merged])

beforeEach(() => {
  // A row missing a timestamp gets the time of the save; frozen, both merges see the same one.
  vi.useFakeTimers()
  vi.setSystemTime(BASE)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the save merge, against the scan of every pair it replaced', () => {
  it('writes the same rows, in the same order, field for field, on 3,000 generated saves', () => {
    const seen = { claimed: 0, carried: 0, readded: 0, intended: 0 }
    for (let seed = 1; seed <= 3000; seed++) {
      const save = saveCase(seed, 1 + (seed % 48))
      const expected = scanMerge(save.latest, save.current, save.baselines, save.intents, seen)
      const actual = mergedForSave(save.latest, save.current, save.baselines, save.intents)
      if (text(actual) !== text(expected)) expect.fail(`seed ${seed}: ${text(actual)}\n!==\n${text(expected)}`)
    }
    // Not a vacuous match: rows claimed one another's process, conversation or pane, carried a binding
    // over, came back after another process removed them, and were written as intended.
    expect(seen.claimed).toBeGreaterThan(1000)
    expect(seen.carried).toBeGreaterThan(50)
    expect(seen.readded).toBeGreaterThan(1000)
    expect(seen.intended).toBeGreaterThan(500)
  }, 60_000)

  it('writes the same rows as the scan for a fully legacy registry, every row changed', () => {
    const g = generator(7, 400)
    const latest = new Map<string, Row>()
    const current = new Map<string, Row>()
    const baselines = new Map<string, string>()
    for (let i = 0; i < 400; i++) {
      const id = `agent-${i}`
      const before = g.legacy(id)
      latest.set(id, before)
      baselines.set(id, rowFingerprint(before))
      current.set(id, g.v2(id))
    }
    const expected = scanMerge(latest, current, baselines, new Map())
    expect(text(mergedForSave(latest, current, baselines, new Map()))).toBe(text(expected))
  })

  describe('a binding carried over comes from the first row in the merge\'s order, as in the scan', () => {
    // Two rows can both be a process a third row opened while not being the same process as each other:
    // start ticks decide when both sides have them, the `ps` marker otherwise. Which one's conversation
    // is carried over then depends only on the order the rows are met in.
    const row = (agentId: string, pane: string, sessionId: string, identity: Row): Row => JSON.parse(JSON.stringify(strictPersistedRow({
      schemaVersion: 2, active: true, agentId, sessionId, boundAt: sessionId ? BASE : null, engine: 'claude',
      transcriptPath: sessionId ? `/fixture/projects/${sessionId}.jsonl` : null, projectDir: 'fixture', cwd: '/fixture',
      runtimes: [{ backend: 'tmux', paneId: pane }], tmuxPane: pane, primaryRuntimeKey: `tmux\u0000${pane}`,
      source: sessionId ? 'hook' : null, title: null, model: null, cliVersion: null,
      processIdentity: { pid: 7, executable: '/fixture/claude', ...identity },
      registeredAt: BASE, touchedAt: BASE, lastHookAt: BASE, lastTranscriptAt: BASE,
    })))
    const opened = row('opened', '%3', '', { startMarker: 'm1', startTicks: 1 })
    const merge = (latest: Row[], current: Row[], saved: Row[]) => {
      const args = [
        new Map(latest.map((r) => [r.agentId as string, r])), new Map(current.map((r) => [r.agentId as string, r])),
        new Map(saved.map((r) => [r.agentId as string, rowFingerprint(r)])), new Map(),
      ] as const
      const expected = scanMerge(...args)
      const actual = mergedForSave(...args)
      expect(text(actual)).toBe(text(expected))
      return actual
    }

    it('a row this save changed keeps its place in the file', () => {
      const first = row('first', '%1', 'first-session', { startMarker: 'm0', startTicks: 1 })
      const second = row('second', '%2', 'second-session', { startMarker: 'm1' })
      const merged = merge([first, second], [{ ...first, title: 'renamed' }, opened], [first])
      expect([...merged.keys()]).toEqual(['opened'])
      expect(merged.get('opened')?.sessionId).toBe('first-session')
    })

    it('a row claimed and then written again goes last', () => {
      const reclaimed = row('reclaimed', '%1', 'reclaimed-session', { startMarker: 'm0', startTicks: 1 })
      const held = row('held', '%2', 'held-session', { startMarker: 'm1' })
      const sharer = row('sharer', '%1', '', { startMarker: 'other', startTicks: 2 })
      const merged = merge([reclaimed, held], [sharer, { ...reclaimed, title: 'renamed' }, opened], [reclaimed])
      // The opened process claims both rows, and is written in their place.
      expect([...merged.keys()]).toEqual(['opened'])
      expect(merged.get('opened')?.sessionId).toBe('held-session')
    })
  })

  it('leaves the file as it is when no row changed', () => {
    const g = generator(11, 30)
    const rows = Array.from({ length: 30 }, (_, i) => g.v2(`agent-${i}`))
    const latest = new Map(rows.map((row) => [row.agentId as string, row]))
    const baselines = new Map(rows.map((row) => [row.agentId as string, rowFingerprint(row)]))
    const merged = mergedForSave(latest, new Map(latest), baselines, new Map())
    expect(text(merged)).toBe(text(latest))
  })

  it('merges 5,000 changed rows in linear time', () => {
    // 122 s for 5,000 rows before (the first start on a legacy registry, measured 2026-10-08), under
    // 1 s after on the same machine. The bound is far from both, so only a return to comparing every
    // pair fails it.
    vi.useRealTimers()
    const g = generator(13, 5000)
    const latest = new Map<string, Row>()
    const current = new Map<string, Row>()
    const baselines = new Map<string, string>()
    for (let i = 0; i < 5000; i++) {
      const id = `agent-${i}`
      const before = g.legacy(id)
      latest.set(id, before)
      baselines.set(id, rowFingerprint(before))
      current.set(id, g.v2(id))
    }
    const started = performance.now()
    const merged = mergedForSave(latest, current, baselines, new Map())
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(merged.size).toBeGreaterThan(0)
  })
})
