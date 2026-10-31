// cli/src/superTabs/routeCheapFirst.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { choose, decide, recordOf, type Assessment, type Catalog, type Probe } from './route.js'
import { makePlugins, MAKER_TIMEOUT_MS } from './routePlugins.js'
import { CHEAP_FIRST, CHEAP_FIRST_MAKER, CHEAP_FIRST_MAKERS, cheapFirst, cheapTaskOf, EARLIER_UNREADABLE, GRID_LIMITS, GRID_LIMITS_MAKER, gridLimits, HISTORY_WAIT_MS, FIRST_ATTEMPT_ONLY, GRID_FIRST, MAX_OWNED, NEVER_REVIEWS, NEVER_SECURITY, type CheapTask } from './routeCheapFirst.js'

const NOW = 1_000_000_000, H = 3_600_000, D = 86_400_000
/** Today's catalog (backend superTabs/catalog.ts): Opus and Codex at 3, Kimi K3 and DeepSeek v4.1 at 2 on the grid. */
const catalog: Catalog = { grid: { strength: 1, models: [{ model: 'kimi k3', strength: 2 }, { model: 'deepseek v4.1', strength: 2 }] }, models: [
  { engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
  { engine: 'codex', model: 'default', effort: 'default', strength: 3, cost: 2, offered: true },
] }
const a = (patch: Partial<Assessment> = {}): Assessment => ({ difficulty: 'low', risk: 'low', size: 'small', why: 'Fix a typo in the docs.', needs: { tools: [], devices: [] }, ...patch })
const quota = { known: true, leftPercent: 80, resetsAt: null, windows: [{ name: '5-hour', leftPercent: 80, resetsAt: NOW + 3 * H }, { name: 'weekly', leftPercent: 90, resetsAt: NOW + 5 * D }] }
const opus: Probe = { kind: 'new', machineId: 'm1', machineName: 'remote-1', engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3,
  quota: { ...quota, account: 'acct' }, activity: 'new agent', known: true, refusals: [], notes: [] }
const codex: Probe = { ...opus, engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, quota: { ...quota, account: 'cx' } }
/** A new agent on a grid model, as routeCommand.ts localProbes makes one. */
const grid = (model: string, label: string, quality = 2): Probe => ({ ...opus, model: 'default', effort: 'default', quality, cost: 1,
  quota: { known: false, leftPercent: null, resetsAt: null }, gridModel: model, gridName: 'swarm-grid', gridLabel: label, gridKind: 'api' })
const kimi = grid('moonshotai/kimi-k3', 'Kimi K3'), deepseek = grid('deepseek/deepseek-v4.1', 'DeepSeek v4.1'), qwen = grid('qwen3:4b', 'Qwen 3', 1)
const first: CheapTask = { review: false, owned: 1, earlier: null }
const route = (task: CheapTask, assessment: Partial<Assessment> = {}, probes: Probe[] = [opus, codex, kimi, deepseek, qwen]) =>
  choose(probes, catalog, a(assessment), NOW, [], [], [], [gridLimits(task.review), cheapFirst(task)])
const ok = (r: ReturnType<typeof choose>) => { if ('error' in r) throw new Error(JSON.stringify(r)); return r }
const picks = (r: ReturnType<typeof choose>) => ok(r).shown.map(s => s.gridLabel ?? `${s.engine} ${s.model}`)
const reasons = (r: ReturnType<typeof choose>) => r.excluded.map(e => e.reason)

describe('cheap first: a small, low-risk build goes to a cheap grid model first', () => {
  it('ranks Kimi K3 and DeepSeek above Opus and Codex, says why on the candidate, and records it', () => {
    const r = ok(route(first))
    expect(picks(r)).toEqual(['DeepSeek v4.1', 'Kimi K3', 'codex default', 'claude opus', 'Qwen 3'])
    expect(r.shown[0]!.notes).toEqual([`${CHEAP_FIRST}: ${GRID_FIRST}`])
    expect(r.shown[0]!.label).toContain(GRID_FIRST)
    // Opus and Codex are not moved, and a grid model the catalog does not rate (Qwen, 1) is not either.
    expect(r.shown.find(s => s.model === 'opus')!.notes).toEqual([])
    expect(r.shown.find(s => s.gridLabel === 'Qwen 3')!.notes).toEqual([])
    const verdict = decide(r)
    const record = recordOf(r, verdict, a()) as { candidates: Array<{ gridModel?: string; quality: number; label: string }>; pick: string }
    // It is recorded as what it is: a grid model rated 2, with the reason people read.
    expect(record.candidates.find(c => c.gridModel === 'deepseek/deepseek-v4.1')).toMatchObject({ quality: 2 })
    expect(record.candidates[0]!.label).toContain(GRID_FIRST)
    expect(record.pick).toBe(r.shown[0]!.id)
  })

  it('keeps today\'s order unless the task is low risk, low difficulty and small in scope', () => {
    const today = picks(choose([opus, codex, kimi, deepseek, qwen], catalog, a(), NOW))
    expect(today[0]).toBe('codex default')
    for (const [task, assessment] of [
      [first, { difficulty: 'medium' }], [first, { risk: 'medium' }], [{ ...first, owned: 0 }, {}], [{ ...first, owned: MAX_OWNED + 1 }, {}],
    ] as Array<[CheapTask, Partial<Assessment>]>) {
      const r = ok(route(task, assessment))
      expect(picks(r)).toEqual(today)
      expect(r.adjusted).toBeUndefined()
    }
    expect(picks(route({ ...first, owned: MAX_OWNED }))[0]).toBe('DeepSeek v4.1')
  })

  it('never puts a review on a grid model, even one a person names or a local one asked for, and says why', () => {
    for (const task of [{ ...first, review: true }, first]) {
      const kind = task.review ? {} : { kind: 'review' }
      const r = ok(route(task, kind))
      expect(picks(r)).toEqual(['codex default', 'claude opus'])
      expect(reasons(r)).toEqual([`${GRID_LIMITS}: ${NEVER_REVIEWS}`, `${GRID_LIMITS}: ${NEVER_REVIEWS}`, `${GRID_LIMITS}: ${NEVER_REVIEWS}`])
      expect(route(task, { ...kind, model: 'kimi k3' })).toEqual({ error: 'NO_CANDIDATE', excluded: [{ title: expect.stringContaining('Kimi K3'), reason: `${GRID_LIMITS}: ${NEVER_REVIEWS}`, machine: 'remote-1' }] })
      expect(route(task, { ...kind, local: true })).toMatchObject({ error: 'NO_CANDIDATE' })
    }
  })

  it('never puts security-sensitive work on a grid model: a security kind, or high risk', () => {
    for (const assessment of [{ kind: 'security' }, { kind: 'auth' }, { kind: 'privacy' }, { kind: 'secrets' }, { risk: 'high' as const }]) {
      const r = ok(route(first, assessment))
      expect(r.shown.some(s => s.gridModel)).toBe(false)
      expect(new Set(reasons(r))).toEqual(new Set([`${GRID_LIMITS}: ${NEVER_SECURITY}`]))
      expect(route(first, { ...assessment, model: 'deepseek' })).toMatchObject({ error: 'NO_CANDIDATE' })
    }
  })

  it('steps up: a task with an earlier attempt routes without grid models, and says why', () => {
    const earlier = { ...first, earlier: 'Its first attempt ran on Kimi K3.' }
    const r = ok(route(earlier))
    expect(picks(r)).toEqual(['codex default', 'claude opus'])
    expect(new Set(reasons(r))).toEqual(new Set([`${CHEAP_FIRST}: ${FIRST_ATTEMPT_ONLY} Its first attempt ran on Kimi K3.`]))
    // A person who names a grid model for the next attempt still gets it, told that the task stepped up.
    const named = ok(route(earlier, { model: 'kimi' }))
    expect(picks(named)).toEqual(['Kimi K3'])
    expect(named.shown[0]!.notes).toEqual([`${CHEAP_FIRST}: ${FIRST_ATTEMPT_ONLY} Its first attempt ran on Kimi K3. A person named this model, so it is offered.`])
    // A review is never offered one, named or not, whatever came before.
    expect(route({ ...earlier, review: true }, { model: 'kimi' })).toMatchObject({ error: 'NO_CANDIDATE' })
  })

  it('adds no candidate: it only ranks and leaves out the grid models the route itself found served and rated', () => {
    // Grid candidates come only from routeCommand.ts localProbes: models a fresh reading says are served, rated from the catalog.
    expect(cheapFirst(first).candidates).toBeUndefined()
    expect(gridLimits(true).candidates).toBeUndefined()
    expect(ok(route(first)).shown).toHaveLength(5)
  })

  it('leaves subscription candidates and members alone in every case', () => {
    const member: Probe = { ...opus, kind: 'member', agentId: 'a1', name: 'Wren' }
    for (const task of [first, { ...first, review: true }, { ...first, earlier: 'x' }]) {
      const r = ok(route(task, {}, [opus, member]))
      expect(r.excluded).toEqual([])
      expect(r.adjusted).toBeUndefined()
    }
  })
})

describe('what the route reads of a task before it is ranked', () => {
  const group = (patch: Record<string, unknown> = {}) => ({ id: 'g1', task: { goal: 'Fix it', owns: ['docs/a.md'] }, checks: [{ id: 'c1' }], assignment: null, ...patch })
  const state = (patch: Record<string, unknown> = {}) => ({ agents: [], starts: [], ...patch })
  const history = { decisions: [], attempts: [] }

  it('a first attempt: no earlier assignment, start, routed pick or step-up', () => {
    expect(cheapTaskOf(group(), state(), history)).toEqual({ review: false, owned: 1, earlier: null })
    // A route nobody acted on is no attempt; another group's work is not this one's.
    expect(cheapTaskOf(group(), state({ starts: [{ request: { conversationId: 'g2', gridModel: 'k' } }] }),
      { decisions: [{ conversationId: 'g1', final: null }, { conversationId: 'g2', final: { kind: 'new' } }], attempts: [] }).earlier).toBeNull()
  })

  it('reads a review task, and counts owned code', () => {
    expect(cheapTaskOf(group({ reviewOf: 'g0' }), state(), history).review).toBe(true)
    expect(cheapTaskOf(group({ task: { owns: ['a', 'b', 7] } }), state(), history).owned).toBe(2)
    expect(cheapTaskOf(group({ task: undefined }), state(), history).owned).toBe(0)
    expect(cheapTaskOf(group({ task: { owns: 'a' } }), state(), history).owned).toBe(0)
  })

  it('finds any earlier attempt, naming the grid model it ran on when it was one', () => {
    const on = (patch: Record<string, unknown>) => cheapTaskOf(group(patch.group as never), state(patch.state as never), (patch.history as never) ?? history).earlier
    // The current or last assignment, or one the backend kept after work.define.
    expect(on({ group: { assignment: { id: 'w1', agentId: 'a1', status: 'working' } } })).toBe('It had an earlier attempt.')
    expect(on({ history: { decisions: [], attempts: [{ id: 'w0', agentId: 'a1' }] } })).toBe('It had an earlier attempt.')
    // A lost attempt, a routed pick that started or was assigned, or a start (even one that failed) for it.
    expect(on({ group: { lostAttempt: { id: 'w0', agentId: 'a9' } } })).toBe('It had an earlier attempt.')
    expect(on({ history: { decisions: [{ conversationId: 'g1', final: { kind: 'member', agentId: 'a1' } }], attempts: [] } })).toBe('It had an earlier attempt.')
    expect(on({ state: { starts: [{ request: { conversationId: 'g1' }, error: 'Codex is not signed in.' }] } })).toBe('It had an earlier attempt.')
    // On the grid: its model is named, whether its start failed or its agent worked on it.
    expect(on({ state: { starts: [{ request: { conversationId: 'g1', gridModel: 'moonshotai/kimi-k3' }, error: 'The grid host did not answer.' }] } }))
      .toBe('Its earlier attempt ran on moonshotai/kimi-k3 on the Swarm\'s grid.')
    expect(on({ group: { assignment: { id: 'w1', agentId: 'a1', status: 'working' } },
      state: { agents: [{ id: 'a1', harnessId: 'h1' }], starts: [{ harnessId: 'h1', request: { conversationId: 'g0', gridModel: 'deepseek/deepseek-v4.1' } }] } }))
      .toBe('Its earlier attempt ran on deepseek/deepseek-v4.1 on the Swarm\'s grid.')
    // A step-up the backend recorded (after a grid attempt's failed first review) says why, in its words.
    expect(on({ group: { stepUp: { attempt: 2, reason: 'Its first review said Ready no.' } } })).toBe('Its first review said Ready no.')
  })

  it('an earlier attempt it cannot rule out counts as one: unreadable history is no first attempt', () => {
    expect(cheapTaskOf(group(), state(), null).earlier).toBe(EARLIER_UNREADABLE)
    expect(cheapTaskOf(group(), state(), { decisions: null, attempts: [] }).earlier).toBe(EARLIER_UNREADABLE)
    expect(cheapTaskOf(group(), state(), { decisions: [], attempts: null }).earlier).toBe(EARLIER_UNREADABLE)
    // What the state shows still names the model.
    expect(cheapTaskOf(group(), state({ starts: [{ request: { conversationId: 'g1', gridModel: 'k' } }] }), null).earlier).toContain('ran on k')
    // Junk is read as nothing, never thrown on.
    expect(cheapTaskOf({ id: 'g1' }, { agents: 'x', starts: [null, 3, { request: null }] }, { decisions: [null], attempts: [7] }).earlier).toBeNull()
  })
})

describe('the maker', () => {
  const read = (conversations: unknown[] = [{ id: 'g1', task: { owns: ['docs/a.md'] } }]) => ({ tab: { state: { conversations, agents: [], starts: [] } } })
  const make = (history: Promise<Record<string, unknown> | null>, tab = read()) =>
    CHEAP_FIRST_MAKER.make({ conversationId: 'g1', assessment: a(), read: tab, catalog, history, request: async () => ({}) })
  const gridOut = async (made: ReturnType<typeof make>) => {
    const r = ok(choose([opus, kimi], catalog, a(), NOW, [], [], [], [(await made)!]))
    return r.shown.some(s => s.gridModel) ? null : r.excluded.map(e => e.reason)
  }

  it('makes the plug-in from the route\'s own reads: a first attempt when the history shows none', async () => {
    expect(await gridOut(make(Promise.resolve({ ok: true, value: { decisions: [], attempts: [] } })))).toBeNull()
    expect((await make(Promise.resolve({ ok: true, value: { decisions: [], attempts: [] } })))!.name).toBe(CHEAP_FIRST)
  })

  it('leaves the grid out rather than skip the rule when the history fails, is junk, or is later than it waits', async () => {
    const unread = [`${CHEAP_FIRST}: ${FIRST_ATTEMPT_ONLY} ${EARLIER_UNREADABLE}`]
    expect(await gridOut(make(Promise.resolve(null)))).toEqual(unread)
    expect(await gridOut(make(Promise.reject(new Error('socket closed'))))).toEqual(unread)
    expect(await gridOut(make(Promise.resolve({ ok: true, value: { decisions: 'x' } })))).toEqual(unread)
    expect(await gridOut(make(Promise.resolve({ error: 'BACKEND_UNAVAILABLE' })))).toEqual(unread)
    vi.useFakeTimers()
    try {
      const made = make(new Promise(() => {}))
      await vi.advanceTimersByTimeAsync(HISTORY_WAIT_MS)
      vi.useRealTimers()
      expect(await gridOut(made)).toEqual(unread)
    } finally { vi.useRealTimers() }
  })

  it('reads a group the tab does not list, or a tab it cannot read, as a task with nothing owned', async () => {
    const empty = { ok: true, value: { decisions: [], attempts: [] } }
    for (const tab of [read([]), {}, { tab: { state: 'x' } }]) {
      const r = ok(choose([opus, kimi], catalog, a(), NOW, [], [], [], [(await make(Promise.resolve(empty), tab as never))!]))
      // Nothing owned is no small task: today's order, the grid below the strong models.
      expect(r.shown.map(s => s.gridModel ?? s.model)).toEqual(['opus', 'moonshotai/kimi-k3'])
    }
    // A review the tab lists is read as one: the ranking leaves it to the guard.
    const listed = read([{ id: 'g1', reviewOf: 'g0' }])
    const guard = await GRID_LIMITS_MAKER.make({ conversationId: 'g1', assessment: a(), read: listed, catalog, history: Promise.resolve(empty), request: async () => ({}) })
    const review = ok(choose([opus, kimi], catalog, a(), NOW, [], [], [], [guard!, (await make(Promise.resolve(empty), listed))!]))
    expect(review.excluded.map(e => e.reason)).toEqual([`${GRID_LIMITS}: ${NEVER_REVIEWS}`])
  })

  it('a review or security route has no grid choice when the history is unreadable, slow, or the ranking is dropped', async () => {
    const review = read([{ id: 'g1', reviewOf: 'g0', task: { owns: ['docs/a.md'] } }])
    const gridIn = (plugins: Parameters<typeof choose>[7], assessment: Partial<Assessment> = {}) =>
      ok(choose([opus, kimi], catalog, a(assessment), NOW, [], [], [], plugins)).shown.some(s => s.gridModel)
    const input = (history: Promise<Record<string, unknown> | null>, tab = review) => ({ conversationId: 'g1', assessment: a(), read: tab, catalog, history, request: async () => ({}) })
    // The guard reads nothing: it is made before a history that never answers has done anything.
    let made = false
    void GRID_LIMITS_MAKER.make(input(new Promise(() => {}))).then(() => { made = true })
    await Promise.resolve(); await Promise.resolve()
    expect(made).toBe(true)
    vi.useFakeTimers()
    try {
      const hangs = () => new Promise<null>(() => {})
      for (const [history, tab, assessment] of [[hangs, review, {}], [() => Promise.reject(new Error('down')), review, {}],
        [hangs, read(), { kind: 'security' }], [() => Promise.resolve(null), read(), { risk: 'high' as const }]] as const) {
        const making = makePlugins(CHEAP_FIRST_MAKERS, input(history() as Promise<null>, tab))
        await vi.advanceTimersByTimeAsync(MAKER_TIMEOUT_MS)
        const { plugins, warnings } = await making
        expect(warnings).toEqual([])
        expect(plugins.map(p => p.name)).toEqual([GRID_LIMITS, CHEAP_FIRST])
        expect(gridIn(plugins, assessment)).toBe(false)
        // With the ranking dropped, as the hook drops a late maker, the guard alone still leaves the grid out.
        expect(gridIn([plugins[0]!], assessment)).toBe(false)
      }
      // A ranking whose maker never answers is dropped after the hook's limit; the guard's plug-in is there all the same.
      const hung = { name: CHEAP_FIRST, make: () => new Promise<never>(() => {}) }
      const making = makePlugins([GRID_LIMITS_MAKER, hung], input(Promise.resolve(null)))
      await vi.advanceTimersByTimeAsync(MAKER_TIMEOUT_MS)
      const dropped = await making
      expect(dropped.plugins.map(p => p.name)).toEqual([GRID_LIMITS])
      expect(dropped.warnings).toHaveLength(1)
      expect(gridIn(dropped.plugins)).toBe(false)
    } finally { vi.useRealTimers() }
    // A build with no such kind is not the guard's to touch.
    expect(gridIn([gridLimits(false)])).toBe(true)
  })
})
