// cli/src/superTabs/machineFit.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { START_REQUIREMENTS, startRequirements } from './capacity.js'
import { CI_LIMIT, CI_READ_MS, CI_RETRY_MINUTES, CI_UNCHECKED, ciHold, ciLoadOf, floorOf, heavyNeed, MACHINE_FIT_MAKER, machineFit, PLACED_RECENT_MS, placedHeavyWork,
  type CiLoad } from './machineFit.js'
import { choose, parseAssessment, type Assessment, type Catalog, type Probe } from './route.js'
import { ROUTE_PLUGIN_MAKERS, type PluginInput } from './routePlugins.js'

const GB = 1e9, NOW = 1_000_000_000, M = 60_000
const catalog: Catalog = { grid: { strength: 1, models: [] }, models: [
  { engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
  { engine: 'claude', model: 'sonnet', effort: 'medium', strength: 2, cost: 2, offered: true },
] }
const a = (needs: Partial<Assessment['needs']> = {}): Assessment => ({ difficulty: 'medium', risk: 'low', size: 'medium', why: 'Desktop build.', needs: { tools: [], devices: [], ...needs } })
/** A new agent on [machine] with [free] memory and disk, in GB. */
const on = (machine: string, free: { memory: number | null; disk: number | null; cpu?: number }, patch: Partial<Probe> = {}): Probe => ({
  kind: 'new', machineId: machine, machineName: machine, engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3,
  quota: { known: true, leftPercent: null, resetsAt: null, metered: true }, activity: 'new agent', known: true, refusals: [], notes: [],
  load: { agents: 0, freeMemoryBytes: free.memory === null ? null : free.memory * GB, hasFolder: true, freeDiskBytes: free.disk === null ? null : free.disk * GB,
    ...(free.cpu === undefined ? {} : { cpuPercent: free.cpu }) }, ...patch })
const ok = (r: ReturnType<typeof choose>) => { if ('error' in r) throw new Error(JSON.stringify(r)); return r }
const route = (probes: Probe[], task: Assessment, plugin = machineFit()) => choose(probes, catalog, task, NOW, [], [], [], [plugin])
/** A start as the route's hint makes it: its requirements, and the heavy work it declared in its own field. */
const heavyStart = (machineId: string, at: number, heavy: Assessment['needs']['heavy'] = ['build'], patch: Record<string, unknown> = {}) =>
  ({ request: { machineId, requirements: startRequirements({ tools: [], devices: [], heavy }), ...(heavy?.length ? { heavy } : {}) }, requestedAt: at, ...patch })

describe('the task says its heavy work and its CI', () => {
  it('parses heavy work and the CI jobs it starts, and leaves both out when not given', () => {
    const base = { difficulty: 'low', risk: 'low', why: 'x' }
    expect(parseAssessment({ ...base, needs: { heavy: ['build', 'e2e', 'build'], ci: { jobs: 4, macos: 2 } } }))
      .toMatchObject({ needs: { tools: [], devices: [], heavy: ['build', 'e2e'], ci: { jobs: 4, macos: 2 } } })
    expect(parseAssessment({ ...base, needs: { ci: { jobs: 1 } } })).toMatchObject({ needs: { ci: { jobs: 1, macos: 0 } } })
    // An empty list says nothing, and a request without either answers exactly as before.
    expect(parseAssessment({ ...base, needs: { heavy: [] } })).toEqual({ ...base, size: 'medium', needs: { tools: [], devices: [] } })
    expect(parseAssessment({ ...base, needs: {} })).toEqual({ ...base, size: 'medium', needs: { tools: [], devices: [] } })
  })
  it('explains what is wrong with them', () => {
    const base = { difficulty: 'low', risk: 'low', why: 'x' }
    for (const heavy of ['build', ['compile'], [1]]) expect(parseAssessment({ ...base, needs: { heavy } })).toContain('needs.heavy')
    for (const ci of [true, {}, { jobs: 0 }, { jobs: 1.5 }, { jobs: 101 }, { jobs: 2, macos: 3 }, { jobs: 2, macos: -1 }, { jobs: '2' }]) {
      expect(parseAssessment({ ...base, needs: { ci } })).toContain('needs.ci')
    }
  })
  it('takes the largest need of its kinds, and none without heavy work', () => {
    expect(heavyNeed({})).toBeNull()
    expect(heavyNeed({ heavy: [] })).toBeNull()
    expect(heavyNeed({ heavy: ['e2e'] })).toEqual({ memoryBytes: 6 * GB, diskBytes: 10 * GB, words: 'end-to-end tests' })
    expect(heavyNeed({ heavy: ['e2e', 'build'] })).toEqual({ memoryBytes: 8 * GB, diskBytes: 30 * GB, words: 'end-to-end tests and a heavy build' })
  })
  it('a heavy task\'s start asks its machine for half the need, so a machine ranked later still admits it; any other start asks what it always did', () => {
    expect(startRequirements({ tools: [], devices: [] })).toEqual(START_REQUIREMENTS)
    expect(startRequirements({ tools: [], devices: [], heavy: ['build'] })).toMatchObject({ memoryBytes: 4 * GB, diskBytes: 15 * GB })
    // End-to-end's half of the disk is less than any start asks, so the start's own stays.
    expect(startRequirements({ tools: [], devices: [], heavy: ['e2e'] })).toMatchObject({ memoryBytes: 3 * GB, diskBytes: START_REQUIREMENTS.diskBytes })
    expect(floorOf({ memoryBytes: 8 * GB, diskBytes: 30 * GB })).toEqual({ memoryBytes: 4 * GB, diskBytes: 15 * GB })
  })
})

describe('machine fit', () => {
  it('a heavy build avoids a low-memory machine: the one that has what it needs ranks first, and the other says why', () => {
    const choice = ok(route([on('small', { memory: 5, disk: 100 }), on('big', { memory: 16, disk: 100 })], a({ heavy: ['build'] })))
    expect(choice.shown.map(s => s.machineId)).toEqual(['big', 'small'])
    expect(choice.shown[1]!.notes).toEqual(['Machine fit: Short of free memory for a heavy build: it needs 8 GB memory and 30 GB disk free, '
      + 'so equally strong candidates that have it rank first.'])
    expect(choice.shown[0]!.notes).toEqual([])
    // Without heavy work the same machines rank as they always did, by title.
    expect(ok(route([on('small', { memory: 5, disk: 100 }), on('big', { memory: 16, disk: 100 })], a())).shown.map(s => s.machineId)).toEqual(['big', 'small'])
    expect(ok(route([on('a-small', { memory: 5, disk: 100 }), on('big', { memory: 16, disk: 100 })], a())).shown.map(s => s.machineId)).toEqual(['a-small', 'big'])
    expect(ok(route([on('a-small', { memory: 5, disk: 100 }), on('big', { memory: 16, disk: 100 })], a({ heavy: ['build'] }))).shown.map(s => s.machineId)).toEqual(['big', 'a-small'])
  })
  it('short of disk counts like short of memory', () => {
    const choice = ok(route([on('a-full', { memory: 16, disk: 20 }), on('b', { memory: 16, disk: 100 })], a({ heavy: ['build'] })))
    expect(choice.shown.map(s => s.machineId)).toEqual(['b', 'a-full'])
    expect(choice.shown[1]!.notes[0]).toMatch(/^Machine fit: Short of free disk for a heavy build:/)
  })
  it('never passes over a stronger model for a machine: a short machine still ranks above a weaker model that fits', () => {
    const choice = ok(route([on('short', { memory: 5, disk: 100 }), on('big', { memory: 16, disk: 100 }, { model: 'sonnet', effort: 'medium', quality: 2, cost: 2 })],
      a({ heavy: ['build'] })))
    expect(choice.shown.map(s => `${s.machineId} ${s.model}`)).toEqual(['short opus', 'big sonnet'])
    // What the candidate is shown and recorded as stays as measured.
    expect(choice.shown[0]!.quality).toBe(3)
  })
  it('below half the need the machine cannot run the work: left out with why, and none left is no candidate', () => {
    const choice = ok(route([on('tiny', { memory: 3, disk: 100 }), on('big', { memory: 16, disk: 100 })], a({ heavy: ['build'] })))
    expect(choice.shown.map(s => s.machineId)).toEqual(['big'])
    expect(choice.excluded).toEqual([{ title: 'New agent · Claude opus high · tiny', machine: 'tiny',
      reason: 'Machine fit: Too little free memory for a heavy build: it needs 8 GB memory and 30 GB disk free, and at least half to run at all.' }])
    expect(route([on('tiny', { memory: 16, disk: 10 })], a({ heavy: ['build'] }))).toMatchObject({ error: 'NO_CANDIDATE' })
    // Exactly half is enough to run.
    expect(ok(route([on('half', { memory: 4, disk: 15 })], a({ heavy: ['build'] }))).shown).toHaveLength(1)
  })
  it('says an unknown reading and ranks it after a machine known to fit, never leaving it out', () => {
    const choice = ok(route([on('a-unread', { memory: null, disk: 100 }), on('b', { memory: 16, disk: 100 })], a({ heavy: ['e2e'] })))
    expect(choice.shown.map(s => s.machineId)).toEqual(['b', 'a-unread'])
    expect(choice.shown[1]!.notes).toEqual(['Machine fit: Free memory unknown here; end-to-end tests: it needs 6 GB memory and 10 GB disk free.'])
    const both = ok(route([on('blind', { memory: null, disk: null })], a({ heavy: ['e2e'] })))
    expect(both.shown[0]!.notes).toEqual(['Machine fit: Free memory and disk unknown here; end-to-end tests: it needs 6 GB memory and 10 GB disk free.'])
    expect(ok(route([on('d', { memory: 16, disk: null })], a({ heavy: ['e2e'] }))).shown[0]!.notes)
      .toEqual(['Machine fit: Free disk unknown here; end-to-end tests: it needs 6 GB memory and 10 GB disk free.'])
    // A short machine whose disk is unknown is short: what is known decides.
    expect(ok(route([on('x', { memory: 5, disk: null })], a({ heavy: ['build'] }))).shown[0]!.notes[0]).toMatch(/^Machine fit: Short of free memory for a heavy build:/)
    // A probe with no machine reading at all is unknown too.
    expect(ok(route([on('none', { memory: 16, disk: 100 }, { load: undefined })], a({ heavy: ['build'] }))).shown[0]!.notes[0]).toContain('Free memory and disk unknown here')
  })
  it('a busy CPU ranks a machine later among equals, never leaving it out, and is said', () => {
    const choice = ok(route([on('a-busy', { memory: 16, disk: 100, cpu: 92.4 }), on('b', { memory: 16, disk: 100, cpu: 30 })], a({ heavy: ['build'] })))
    expect(choice.shown.map(s => s.machineId)).toEqual(['b', 'a-busy'])
    expect(choice.shown[1]!.notes).toEqual(['Machine fit: Its CPU is busy; it has what a heavy build needs.'])
    expect(ok(route([on('s', { memory: 5, disk: 100, cpu: 99 })], a({ heavy: ['build'] }))).shown[0]!.notes[0]).toMatch(/rank first\. Its CPU is busy\.$/)
    expect(ok(route([on('u', { memory: null, disk: 100, cpu: 99 })], a({ heavy: ['build'] }))).shown[0]!.notes[0]).toMatch(/free\. Its CPU is busy\.$/)
  })
  it('a member is judged by its machine\'s reading too', () => {
    const member = on('small', { memory: 5, disk: 100 }, { kind: 'member', agentId: 'ag1', name: 'Builder', repo: 'same' })
    const choice = ok(route([member, on('big', { memory: 16, disk: 100 })], a({ heavy: ['build'] })))
    expect(choice.shown.map(s => s.kind)).toEqual(['new', 'member'])
  })
  it('says nothing at all for work that is not heavy and starts no CI', () => {
    const plain = choose([on('small', { memory: 1, disk: 1 })], catalog, a(), NOW, [], [], [], [machineFit()])
    expect(ok(plain).adjusted).toBeUndefined()
    expect(ok(plain).shown[0]!.notes).toEqual([])
  })
})

describe('heavy work placed but not yet in the reading', () => {
  it('subtracts only heavy starts from the last 15 minutes: an agent running longer already shows in the free memory', () => {
    const starts = [heavyStart('studio', NOW - 3 * 60 * M, ['build'], { harnessId: 'h-old' }), heavyStart('studio', NOW - 5 * M, ['build'], { harnessId: 'h-new' })]
    expect(placedHeavyWork(starts, NOW)).toEqual(new Map([['studio', { memoryBytes: 8 * GB, diskBytes: 30 * GB, agents: 1 }]]))
  })
  it('counts heavy starts only: not a failed one, an ordinary one, one with no time or machine, or one at the edge of the window', () => {
    const starts = [
      heavyStart('m', NOW - M, ['build'], { error: 'Refused.' }),
      heavyStart('m', NOW - M, []),
      { request: { machineId: 'm', requirements: startRequirements({ tools: [], devices: [] }) }, requestedAt: NOW - M },
      // Asking as much memory as heavy work does not make a start heavy: only its own field does.
      { request: { machineId: 'm', requirements: { ...startRequirements({ tools: [], devices: [] }), memoryBytes: 16 * GB } }, requestedAt: NOW - M },
      { request: { machineId: 'm', heavy: 'build' }, requestedAt: NOW - M },
      { request: { machineId: 'm', heavy: ['compile', 3] }, requestedAt: NOW - M },
      { request: { heavy: ['build'] }, requestedAt: NOW - M },
      { request: { machineId: 'm', heavy: ['build'] } },
      heavyStart('m', NOW - PLACED_RECENT_MS),
      heavyStart('m', NOW + 2 * M),
      // An ordinary Builder's start asks 4 GB, under every heavy need.
      { request: { machineId: 'm', requirements: { ...startRequirements({ tools: [], devices: [] }), memoryBytes: 4 * 2 ** 30 } }, requestedAt: NOW - M },
    ]
    expect(placedHeavyWork(starts, NOW).size).toBe(0)
    // Its kind is read back from the memory its start asked for, and a start known only by its dispatch time counts too.
    const e2e = { request: { machineId: 'm', requirements: startRequirements({ tools: [], devices: [], heavy: ['e2e'] }), heavy: ['e2e'] }, dispatchedAt: NOW - M }
    expect(placedHeavyWork([e2e, heavyStart('m', NOW - M)], NOW).get('m')).toEqual({ memoryBytes: 14 * GB, diskBytes: 40 * GB, agents: 2 })
    // A start stamped up to a minute ahead of this clock counts.
    expect(placedHeavyWork([heavyStart('m', NOW + 50_000)], NOW).get('m')).toMatchObject({ agents: 1 })
  })
  it('a Harness Team account\'s start counts on its Mac, whose memory it shares', () => {
    const hostOf = (id: string) => id === 'team' ? 'mac' : id
    expect([...placedHeavyWork([heavyStart('team', NOW - M), heavyStart('mac', NOW - M)], NOW, hostOf)]).toEqual([['mac', { memoryBytes: 16 * GB, diskBytes: 60 * GB, agents: 2 }]])
  })
  it('a machine that fits by its reading is short, or left out, once the heavy work just started there is counted, and says so', () => {
    const plugin = (starts: Array<Record<string, unknown>>) => machineFit({ placed: placedHeavyWork(starts, NOW) })
    const probes = [on('studio', { memory: 14, disk: 100 }), on('z-other', { memory: 16, disk: 100 })]
    expect(ok(route(probes, a({ heavy: ['build'] }), plugin([]))).shown.map(s => s.machineId)).toEqual(['studio', 'z-other'])
    const one = ok(route(probes, a({ heavy: ['build'] }), plugin([heavyStart('studio', NOW - 5 * M), heavyStart('studio', NOW - 4 * 60 * M)])))
    expect(one.shown.map(s => s.machineId)).toEqual(['z-other', 'studio'])
    expect(one.shown[1]!.notes[0]).toBe('Machine fit: Short of free memory for a heavy build, counting heavy work started there in the last 15 minutes: '
      + 'it needs 8 GB memory and 30 GB disk free, so equally strong candidates that have it rank first.')
    const three = ok(route(probes, a({ heavy: ['build'] }), plugin([1, 2, 3].map(i => heavyStart('studio', NOW - i * M)))))
    expect(three.shown.map(s => s.machineId)).toEqual(['z-other'])
    expect(three.excluded[0]!.reason).toBe('Machine fit: Too little free memory and disk for a heavy build, counting heavy work started there in the last 15 minutes: '
      + 'it needs 8 GB memory and 30 GB disk free, and at least half to run at all.')
  })
})

describe('the CI jobs limit', () => {
  const load = (running: number, queued = 0, macosRunning = 0, macosQueued = 0): CiLoad => ({ running, queued, macosRunning, macosQueued })
  it('holds work that starts CI past the account\'s limit, counting queued jobs, with a time to route it again', () => {
    expect(ciHold({ ci: { jobs: 4, macos: 0 } }, load(16))).toBeNull()
    expect(ciHold({ ci: { jobs: 4, macos: 0 } }, load(16, 1))).toBe(`This repository's CI jobs are at the account's limit: 17 running or queued against the account's limit of ${CI_LIMIT.jobs}, `
      + `0 on macOS against ${CI_LIMIT.macos}, and this task starts 4 more. Route it again in ${CI_RETRY_MINUTES} minutes.`)
    // The macOS runners have their own, smaller limit.
    expect(ciHold({ ci: { jobs: 2, macos: 2 } }, load(4, 0, 3, 0))).toBeNull()
    expect(ciHold({ ci: { jobs: 2, macos: 2 } }, load(4, 0, 3, 1))).toContain('4 on macOS against 5, and this task starts 2 more (2 on macOS).')
  })
  it('never holds work that declares no CI of its own, nor when the load is unknown', () => {
    expect(ciHold({}, load(40, 10, 5, 5))).toBeNull()
    expect(ciHold({ ci: { jobs: 4, macos: 4 } }, null)).toBeNull()
  })
  it('a held task has no candidate: every one is left out with the hold\'s reason', () => {
    const held = route([on('a', { memory: 16, disk: 100 }), on('b', { memory: 16, disk: 100 })], a({ ci: { jobs: 3, macos: 0 } }), machineFit({ ci: load(19) }))
    expect(held).toMatchObject({ error: 'NO_CANDIDATE' })
    expect('error' in held && held.excluded.map(e => e.reason)).toEqual(['a', 'b'].map(() => `Machine fit: ${ciHold({ ci: { jobs: 3, macos: 0 } }, load(19))}`))
    // Under the limit the CI says nothing, and heavy work is judged as before.
    expect(ok(route([on('a', { memory: 16, disk: 100 })], a({ ci: { jobs: 3, macos: 0 } }), machineFit({ ci: load(2) }))).shown[0]!.notes).toEqual([])
  })
  it('a task that starts CI is told when the limit could not be checked, beside its fit', () => {
    expect(ok(route([on('a', { memory: 16, disk: 100 })], a({ ci: { jobs: 1, macos: 0 } }))).shown[0]!.notes).toEqual([`Machine fit: ${CI_UNCHECKED}`])
    expect(ok(route([on('a', { memory: 5, disk: 100 })], a({ ci: { jobs: 1, macos: 0 }, heavy: ['build'] }))).shown[0]!.notes[0]).toMatch(/rank first\. This repository's running CI jobs could not be read/)
  })
})

describe('its maker', () => {
  const input = (assessment: Assessment, state: Record<string, unknown>): PluginInput => ({ conversationId: 'g1', assessment, read: { tab: { state } },
    catalog, history: Promise.resolve(null), request: async () => ({}) })
  it('is on the route\'s list of makers', () => { expect(ROUTE_PLUGIN_MAKERS).toContain(MACHINE_FIT_MAKER) })
  it('has nothing to say for work that is not heavy and starts no CI', async () => {
    expect(await MACHINE_FIT_MAKER.make(input(a(), {}))).toBeNull()
  })
  it('reads the heavy work just started off the route\'s own read, a Harness Team account\'s on its Mac', async () => {
    const now = Date.now()
    const state = { machines: [{ machineId: 'team', hostMachineId: 'mac' }, { machineId: 'mac' }],
      starts: [{ request: { machineId: 'team', requirements: startRequirements({ tools: [], devices: [], heavy: ['build'] }), heavy: ['build'] }, requestedAt: now - M }] }
    const plugin = (await MACHINE_FIT_MAKER.make(input(a({ heavy: ['build'] }), state)))!
    const choice = ok(choose([on('mac', { memory: 12, disk: 100 }), on('z', { memory: 12, disk: 100 })], catalog, a({ heavy: ['build'] }), now, [], [], [], [plugin]))
    expect(choice.shown.map(s => s.machineId)).toEqual(['z', 'mac'])
    expect(choice.shown[1]!.notes[0]).toContain('counting heavy work started there in the last 15 minutes')
    // A tab read with no machines or starts reads as nothing placed.
    const bare = (await MACHINE_FIT_MAKER.make(input(a({ heavy: ['build'] }), {})))!
    expect(ok(choose([on('mac', { memory: 12, disk: 100 })], catalog, a({ heavy: ['build'] }), now, [], [], [], [bare])).shown).toHaveLength(1)
    // A CI read the server does not answer leaves the limit unchecked, which a task that starts CI hears.
    const ci = (await MACHINE_FIT_MAKER.make(input(a({ ci: { jobs: 1, macos: 0 } }), {})))!
    expect(ok(choose([on('mac', { memory: 12, disk: 100 })], catalog, a({ ci: { jobs: 1, macos: 0 } }), now, [], [], [], [ci])).shown[0]!.notes).toEqual([`Machine fit: ${CI_UNCHECKED}`])
  })
})

describe('the server\'s CI read', () => {
  const read = (load: Record<string, unknown>) => ({ ok: true, value: { state: 'read', load } })
  const full = { running: 19, queued: 0, macosRunning: 0, macosQueued: 0 }
  it('takes the counts of a read, and nothing from any other answer', () => {
    expect(ciLoadOf(read(full))).toEqual(full)
    for (const answer of [null, {}, { ok: false, value: { state: 'read', load: full } }, { ok: true, value: { state: 'not-approved' } },
      read({ ...full, running: -1 }), read({ ...full, queued: 1.5 }), read({ ...full, macosQueued: '1' }), { error: 'NOT_FOUND' }]) expect(ciLoadOf(answer)).toBeNull()
  })
  it('the maker asks for the group\'s own project, and a task past the limit is held; under it, or unread, it is not', async () => {
    const asked: Array<Record<string, unknown>> = []
    const make = async (answer: () => Promise<Record<string, unknown>>, conversationId = 'g2') => MACHINE_FIT_MAKER.make({ conversationId, assessment: a({ ci: { jobs: 2, macos: 0 } }),
      read: { tab: { state: { conversations: [{ id: 'g2', projectId: 'p7' }] } } }, catalog, history: Promise.resolve(null),
      request: async payload => { asked.push(payload); return answer() } })
    const judge = async (plugin: Awaited<ReturnType<typeof make>>) => choose([on('m', { memory: 16, disk: 100 })], catalog, a({ ci: { jobs: 2, macos: 0 } }), NOW, [], [], [], [plugin!])
    expect(await judge(await make(async () => read(full)))).toMatchObject({ error: 'NO_CANDIDATE', excluded: [{ reason: `Machine fit: ${ciHold({ ci: { jobs: 2, macos: 0 } }, full)}` }] })
    expect(asked).toEqual([{ action: 'ciLoad', projectId: 'p7' }])
    expect(ok(await judge(await make(async () => read({ ...full, running: 3 })))).shown[0]!.notes).toEqual([])
    expect(ok(await judge(await make(async () => ({ ok: true, value: { state: 'unknown' } })))).shown[0]!.notes).toEqual([`Machine fit: ${CI_UNCHECKED}`])
    expect(ok(await judge(await make(async () => { throw new Error('socket') }))).shown[0]!.notes).toEqual([`Machine fit: ${CI_UNCHECKED}`])
    // A group the read does not list is the Lead's project's.
    await make(async () => read(full), 'gone')
    expect(asked.at(-1)).toEqual({ action: 'ciLoad', projectId: 'lead' })
  })
  it('a read slower than its limit leaves the CI unchecked rather than the plug-in skipped', async () => {
    vi.useFakeTimers()
    try {
      const made = MACHINE_FIT_MAKER.make({ conversationId: 'g', assessment: a({ ci: { jobs: 1, macos: 0 } }), read: {}, catalog, history: Promise.resolve(null),
        request: () => new Promise(() => {}) })
      await vi.advanceTimersByTimeAsync(CI_READ_MS)
      const plugin = (await made)!
      expect(ok(choose([on('m', { memory: 16, disk: 100 })], catalog, a({ ci: { jobs: 1, macos: 0 } }), NOW, [], [], [], [plugin])).shown[0]!.notes).toEqual([`Machine fit: ${CI_UNCHECKED}`])
    } finally { vi.useRealTimers() }
  })
})
