import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Builder, Choice, Mode, Problem, Task } from './model.js'
import { HORIZON_MINUTES, schedule } from './schedule.js'
import { criticalPath, mulberry32, solve } from './search.js'

const GB = 1024 ** 3
const roomy = { cpu: 64, ram: 512 * GB, disk: 4096 * GB }
const mode = (over: Partial<Mode> = {}): Mode => ({ model: 'opus', family: 'claude', speed: 1, cost: 3, quality: { default: 3 }, account: null, ...over })
const builder = (id: string, over: Partial<Builder> = {}): Builder => ({ id, machine: 'mac', modes: [mode()], context: {}, busyUntil: 0, ...over })
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, minutes: 60, needs: { cpu: 1, ram: GB, disk: GB }, spend: {}, floor: 1, kind: 'backend',
  weight: 1, ready: 0, deps: [], independentOf: [], notBuilders: [], files: [], ...over })
const problem = (over: Partial<Problem> = {}): Problem => ({ now: 0, machines: [{ id: 'mac', capacity: roomy }], accounts: [], builders: [builder('a')],
  tasks: [], ...over })
const choice = (order: string[], builders: Record<string, string>, modes: Record<string, number> = {}): Choice => ({ order, builder: builders, mode: modes })
const at = (plan: ReturnType<typeof schedule>, id: string) => plan.placements.find(p => p.task === id)!

describe('the schedule builder keeps every constraint (schedule.ts)', () => {
  it('runs one task at a time on a builder, after its work in progress', () => {
    const p = problem({ builders: [builder('a', { busyUntil: 30 })], tasks: [task('t1'), task('t2')] })
    const plan = schedule(p, choice(['t1', 't2'], { t1: 'a', t2: 'a' }))
    expect([at(plan, 't1').start, at(plan, 't2').start]).toEqual([30, 90])
  })

  it('starts a task after its dependencies, whatever the order', () => {
    const p = problem({ builders: [builder('a'), builder('b')], tasks: [task('build'), task('review', { deps: ['build'], minutes: 20 })] })
    const plan = schedule(p, choice(['review', 'build'], { build: 'a', review: 'b' }))
    expect(at(plan, 'review').start).toBe(at(plan, 'build').end)
  })

  it('never puts a machine past its memory, CPU or disk: the second build waits for the first', () => {
    const machine = { id: 'mac', capacity: { cpu: 8, ram: 16 * GB, disk: 50 * GB } }
    const heavy = { cpu: 2, ram: 10 * GB, disk: 10 * GB }
    const p = problem({ machines: [machine], builders: [builder('a'), builder('b')], tasks: [task('t1', { needs: heavy }), task('t2', { needs: heavy })] })
    const plan = schedule(p, choice(['t1', 't2'], { t1: 'a', t2: 'b' }))
    expect(at(plan, 't2').start).toBe(at(plan, 't1').end)
    const disk = problem({ machines: [machine], builders: [builder('a'), builder('b')], tasks: [task('t1', { needs: { ...heavy, ram: GB, disk: 30 * GB } }),
      task('t2', { needs: { ...heavy, ram: GB, disk: 30 * GB } })] })
    expect(at(schedule(disk, choice(['t1', 't2'], { t1: 'a', t2: 'b' })), 't2').start).toBe(60)
  })

  it('never runs two tasks that change the same file at once on two builders', () => {
    const p = problem({ builders: [builder('a'), builder('b')], tasks: [task('t1', { files: ['cli/src/route.ts'] }), task('t2', { files: ['cli/src/route.ts'] })] })
    expect(at(schedule(p, choice(['t1', 't2'], { t1: 'a', t2: 'b' })), 't2').start).toBe(60)
  })

  it('keeps a model to its limit across the team', () => {
    const local = mode({ model: 'local', family: 'local', limit: 1 })
    const p = problem({ builders: [builder('a', { modes: [local] }), builder('b', { modes: [local] })], tasks: [task('t1'), task('t2')] })
    expect(at(schedule(p, choice(['t1', 't2'], { t1: 'a', t2: 'b' })), 't2').start).toBe(60)
  })

  it('spends a 5-hour window only down to its person\'s reserve, and waits for its reset', () => {
    // 30% left, 10% reserved: one task spending 15% (cost 2) fits now, the second waits for the reset at minute 120.
    const account = { id: 'claude-1', reserve: 10, windows: [{ name: '5-hour', left: 30, resetsAt: 120, every: 300 }] }
    const sonnet = mode({ model: 'sonnet', cost: 2, account: 'claude-1' })
    const p = problem({ accounts: [account], builders: [builder('a', { modes: [sonnet] }), builder('b', { modes: [sonnet] })],
      tasks: [task('t1', { spend: { '5-hour': 15 } }), task('t2', { spend: { '5-hour': 15 } })] })
    const plan = schedule(p, choice(['t1', 't2'], { t1: 'a', t2: 'b' }))
    expect([at(plan, 't1').start, at(plan, 't2').start]).toEqual([0, 120])
  })

  it('never has a review read by its build\'s model family, nor by its author', () => {
    const p = problem({ builders: [builder('a'), builder('b', { modes: [mode({ model: 'codex', family: 'codex', cost: 2 })] })],
      tasks: [task('build'), task('review', { deps: ['build'], independentOf: ['build'], notBuilders: [] })] })
    expect(schedule(p, choice(['build', 'review'], { build: 'a', review: 'a' })).unplaced).toEqual([{ task: 'review', why: 'its build used this model family' }])
    expect(schedule(p, choice(['build', 'review'], { build: 'a', review: 'b' })).unplaced).toEqual([])
    const authored = problem({ builders: [builder('a')], tasks: [task('review', { notBuilders: ['a'] })] })
    expect(schedule(authored, choice(['review'], { review: 'a' })).unplaced[0]!.why).toBe('this builder is its author')
  })

  it('says why a task can never run: too big for the machine, below its floor, or no room in the horizon', () => {
    const p = problem({ tasks: [task('huge', { needs: { cpu: 1, ram: 1024 * GB, disk: GB } }), task('hard', { floor: 4 })] })
    expect(schedule(p, choice(['huge', 'hard'], { huge: 'a', hard: 'a' })).unplaced.map(u => u.why))
      .toEqual(['it needs more than this builder\'s machine has', 'no model of this builder is good enough for it'])
    const spent = problem({ accounts: [{ id: 'x', reserve: 10, windows: [{ name: 'weekly', left: 10, resetsAt: HORIZON_MINUTES * 2, every: null }] }],
      builders: [builder('a', { modes: [mode({ account: 'x' })] })], tasks: [task('t', { spend: { weekly: 5 } })] })
    expect(schedule(spent, choice(['t'], { t: 'a' })).unplaced[0]!.why).toBe('no room for it within 30 days')
  })

  it('takes a builder\'s context on a part: the builder that knows mobile/ does it faster', () => {
    const p = problem({ builders: [builder('a', { context: { mobile: 0.5 } })], tasks: [task('t', { part: 'mobile' })] })
    expect(at(schedule(p, choice(['t'], { t: 'a' })), 't').end).toBe(30)
  })
})

describe('the search finds the best plan (search.ts)', () => {
  it('matches the best plan of every choice there is, on small problems', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const random = mulberry32(seed)
      const p = smallProblem(random)
      expect(solve(p, { iterations: 1_500, budgetMs: 60_000, seed }).plan.score).toBe(bruteForce(p))
    }
  })

  it('gives a mobile task to the builder that knows mobile, and keeps both builders busy', () => {
    const p = problem({ builders: [builder('ios', { context: { mobile: 0.6 } }), builder('web')],
      tasks: [task('app', { part: 'mobile', minutes: 100 }), task('site', { part: 'web', minutes: 100 })] })
    const { plan } = solve(p)
    expect(at(plan, 'app').builder).toBe('ios')
    expect(at(plan, 'site').builder).toBe('web')
  })

  it('puts a p0 first when builders are short', () => {
    const p = problem({ tasks: [task('later', { weight: 1 }), task('now', { weight: 9 })] })
    const { plan } = solve(p)
    expect(at(plan, 'now').start).toBe(0)
  })

  it('moves queued work only for a real gain', () => {
    const p = problem({ builders: [builder('a'), builder('b')], switchCost: 15, tasks: [task('t1', { queuedOn: 'a' }), task('t2', { queuedOn: 'b' })] })
    const { plan } = solve(p)
    expect([at(plan, 't1').builder, at(plan, 't2').builder]).toEqual(['a', 'b'])
  })

  it('is the same plan for the same problem and seed', () => {
    const p = smallProblem(mulberry32(99))
    expect(solve(p, { seed: 7 }).choice).toEqual(solve(p, { seed: 7 }).choice)
  })
})

describe('the real night of 2026-10-26 (42 tasks, 6 machines, 5 models, 7 accounts)', () => {
  it('reaches the proven best the v3 CP-SAT prototype found: 800 minutes, the critical path, within 3% of its cost', () => {
    const p = night({ fiveHour: false })
    const started = Date.now()
    const { plan, first } = solve(p, { iterations: 6_000, budgetMs: 20_000, seed: 1 })
    const took = Date.now() - started
    expect(plan.unplaced).toEqual([])
    expect(criticalPath(p)).toBe(800)
    expect(plan.makespan).toBe(800)
    expect(plan.cost).toBeLessThanOrEqual(7_440 * 1.03)
    expect(first.makespan).toBeGreaterThanOrEqual(plan.makespan)
    console.log(`night: first plan ${first.makespan} min at ${first.cost}, best ${plan.makespan} min at ${plan.cost}, ${took} ms`)
  })

  it('with 5-hour windows, which the prototype left out, every task still runs and no window is overspent', () => {
    const p = night({ fiveHour: true })
    const { plan } = solve(p, { iterations: 3_000, budgetMs: 20_000, seed: 1 })
    expect(plan.unplaced).toEqual([])
    console.log(`night with 5-hour windows: ${plan.makespan} min at ${plan.cost}`)
  })
})

/** Two to three builders on one machine, four tasks, one or two models each, maybe a dependency, a file, a quota window. */
function smallProblem(random: () => number): Problem {
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!
  const models = [mode(), mode({ model: 'codex', family: 'codex', cost: 2, speed: 1.25 }), mode({ model: 'sonnet', cost: 2, quality: { default: 2 }, speed: 1.5 })]
  const account = { id: 'acct', reserve: 10, windows: [{ name: '5-hour', left: 40 + Math.floor(random() * 40), resetsAt: 60 + Math.floor(random() * 120), every: 300 }] }
  const builders = Array.from({ length: 2 + Math.floor(random() * 2) }, (_, i) => builder(`b${i}`, {
    modes: random() < 0.5 ? [pick(models)] : [models[0]!, pick(models.slice(1))].map(m => ({ ...m, account: random() < 0.5 ? 'acct' : null })),
    busyUntil: random() < 0.3 ? 30 : 0, context: random() < 0.4 ? { ui: 0.7 } : {} }))
  const tasks = Array.from({ length: 4 }, (_, i) => task(`t${i}`, { minutes: pick([20, 60, 90]), floor: pick([1, 2, 3]), weight: pick([1, 3, 9]),
    part: pick(['ui', 'cli']), spend: { '5-hour': pick([0, 10, 30]) }, files: random() < 0.3 ? ['shared.ts'] : [], ready: pick([0, 0, 15]),
    needs: { cpu: pick([1, 4]), ram: pick([GB, 8 * GB]), disk: GB } }))
  if (random() < 0.5) tasks[3]!.deps = ['t0']
  return problem({ machines: [{ id: 'mac', capacity: { cpu: 6, ram: 12 * GB, disk: 100 * GB } }], accounts: [account], builders, tasks })
}

/** The least score over every order and every builder and model for every task. */
function bruteForce(p: Problem): number {
  const ids = p.tasks.map(t => t.id)
  const options = p.builders.flatMap(b => b.modes.map((_, mode) => ({ builder: b.id, mode })))
  let best = Infinity
  const orders = permutations(ids)
  const assign = (i: number, picked: Array<{ builder: string; mode: number }>): void => {
    if (i === ids.length) {
      const builders = Object.fromEntries(ids.map((id, k) => [id, picked[k]!.builder]))
      const modes = Object.fromEntries(ids.map((id, k) => [id, picked[k]!.mode]))
      for (const order of orders) best = Math.min(best, schedule(p, { order, builder: builders, mode: modes }).score)
      return
    }
    for (const option of options) assign(i + 1, [...picked, option])
  }
  assign(0, [])
  return best
}

function permutations<T>(list: T[]): T[][] {
  if (list.length <= 1) return [list]
  return list.flatMap((item, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map(rest => [item, ...rest]))
}

/** The night's instance as the v3 prototype read it (tools/scheduler, removed in #3621): each machine's slots are its builders,
 *  each with every model of its engines; the shared API spends no subscription; no machine limit on CPU, memory or disk. */
function night(options: { fiveHour: boolean }): Problem {
  type Raw = { instance: { tasks: Array<{ id: string; minutes: number; floor: number; kind: string; spend: Record<string, number>; deps: string[]
    independent_of: string[] }>; machines: Array<{ id: string; slots: number; engines: string[] }>; models: Array<{ id: string; engine: string; cost: number
    quality: Record<string, number>; concurrency?: number; subscription?: boolean; family?: string }>; accounts: Array<{ id: string; members: string[][]
    reserve: number; windows: Array<{ name: string; left: number; resets_in: number | null }> }> } }
  const here = dirname(fileURLToPath(import.meta.url))
  const { instance } = JSON.parse(readFileSync(join(here, 'fixtures/2026-10-26-night.json'), 'utf8')) as Raw
  const accountOf = (machine: string, engine: string) => instance.accounts.find(a => a.members.some(([m, e]) => m === machine && e === engine))?.id ?? null
  const unlimited = { cpu: 1e9, ram: 1e18, disk: 1e18 }
  return {
    now: 0, objective: 'makespan',
    machines: instance.machines.map(m => ({ id: m.id, capacity: unlimited })),
    accounts: instance.accounts.map(a => ({ id: a.id, reserve: a.reserve, windows: a.windows.filter(w => options.fiveHour || w.name !== '5-hour')
      .map(w => ({ name: w.name, left: w.left, resetsAt: w.resets_in ?? HORIZON_MINUTES * 2, every: w.resets_in === null ? null : w.name === '5-hour' ? 300 : 10_080 })) })),
    builders: instance.machines.flatMap(machine => Array.from({ length: machine.slots }, (_, i) => builder(`${machine.id}#${i}`, {
      machine: machine.id,
      modes: instance.models.filter(m => machine.engines.includes(m.engine)).map(m => mode({ model: m.id, family: m.family ?? m.engine, cost: m.cost,
        quality: m.quality, account: m.subscription === false ? null : accountOf(machine.id, m.engine), ...(m.concurrency ? { limit: m.concurrency } : {}) })),
    }))),
    tasks: instance.tasks.map(t => task(t.id, { minutes: t.minutes, floor: t.floor, kind: t.kind, spend: t.spend, deps: t.deps, independentOf: t.independent_of,
      needs: { cpu: 0, ram: 0, disk: 0 } })),
  }
}

// Benchmark of 2026-11-09: at team scale the search's second ran out inside its first chain, still hot, and the other
// chains never ran; a plan of 50 tasks gained 1.7% on the first, where with each chain given its share of the time and
// cooling by it, it gains 18%. A clock of one tick a read makes this the same on any machine.
describe('a search its time cuts short', () => {
  function team(tasks: number, builders: number, machines: number, seed: number): Problem {
    const random = mulberry32(seed), GiB = 1024 ** 3
    const sizes = [{ minutes: 30, cpu: 1, ram: 2 }, { minutes: 90, cpu: 2, ram: 4 }, { minutes: 240, cpu: 4, ram: 8 }]
    const parts = ['mobile', 'api', 'ui', 'data', 'infra']
    const boxes = Array.from({ length: machines }, (_, i) => ({ id: `m${i}`, capacity: { cpu: 8, ram: 24 * GiB, disk: 200 * GiB } }))
    return {
      now: 0, objective: 'weighted', switchCost: 30, machines: boxes,
      accounts: boxes.flatMap(m => ['claude', 'codex'].map(engine => ({ id: `${m.id}:${engine}`, reserve: 20, windows: [
        { name: 'five_hour', left: 60 + Math.floor(random() * 40), resetsAt: 1 + Math.floor(random() * 299), every: 300 },
        { name: 'seven_day', left: 50 + Math.floor(random() * 50), resetsAt: 1 + Math.floor(random() * 10079), every: 10080 }] }))),
      builders: Array.from({ length: builders }, (_, i): Builder => {
        const machine = boxes[i % machines]!, engine = i % 3 === 2 ? 'codex' : 'claude'
        return { id: `b${i}`, machine: machine.id, busyUntil: Math.floor(random() * 60),
          modes: [{ model: engine, family: engine === 'codex' ? 'openai' : 'anthropic', speed: 1, cost: 2, quality: { default: 1 }, account: `${machine.id}:${engine}` }],
          context: Object.fromEntries(parts.filter(() => random() < 0.3).map(part => [part, random() < 0.5 ? 0.5 : 0.85])) }
      }),
      tasks: Array.from({ length: tasks }, (_, i): Task => {
        const size = sizes[Math.floor(random() * 3)]!
        return { id: `t${i}`, minutes: size.minutes, needs: { cpu: size.cpu, ram: size.ram * GiB, disk: GiB },
          spend: { five_hour: size.minutes / 10, seven_day: size.minutes / 50 }, floor: 0, kind: 'build', part: parts[Math.floor(random() * parts.length)],
          weight: [8, 4, 2, 1][Math.floor(random() * 4)]!, ready: 0, deps: i > 3 && random() < 0.15 ? [`t${Math.floor(random() * i)}`] : [],
          independentOf: [], notBuilders: [], files: [] }
      }),
    }
  }

  it('gives every chain its share and still cools, so a team of 50 tasks gains on the first plan', () => {
    let tick = 0
    const solved = solve(team(50, 10, 5, 7), { budgetMs: 4_000, iterations: 1_000_000, seed: 1, now: () => tick++ })
    expect(solved.plan.score).toBeLessThan(solved.first.score * 0.92)
  })
})

