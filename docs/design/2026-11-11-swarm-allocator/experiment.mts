// The first experiment of the allocator's redesign (README.md beside this file). One claim: does the planned search
// (the product's solver, run each minute, lists two deep as the allocator kept them until BUILD.md's package 2) finish work
// sooner than a rule that decides only when a builder is free? A model, not a measurement: its numbers are only as good as
// the assumptions in `world` below. One is measured: a builder takes 1.12 times as long outside its own area as in it, as
// lampOS's record has it for an area it had landed nothing in against one it had (0.85 to 1.49 times:
// docs/research/2026-11-12-area-worth). Until 12 November this assumed twice as long. The solver's "fixed" plan still
// guesses half the time in a builder's area and half as long again elsewhere, the product's guess for an area a person
// names (FOCUS and AWAY in assign/crew.ts), which the study could not test.
//
// Run from cli/:  npx tsx ../docs/design/2026-11-11-swarm-allocator/experiment.mts
//   SEEDS=1,2,3            the days' seeds
//   BUDGET=250             the solver's milliseconds a solve (the product gives it 1,000)
//   CASES=0.7:0.3:80,...   noise (sigma of a lognormal) : share of labels a size off : tasks in the day
//   ONLY=fifo,priced0      the policies to run; the solver's rows take minutes, the others seconds
//   CORES=8                a machine's cores (6 by default)
//   AWAY=1.2               a task's minutes outside a builder's area, as a factor on its size, where inside it is 0.6: 0.672,
//                          the default, is 1.12 times as long, as measured; 1.2 twice, as assumed until 12 November; 0.9 one
//                          and a half times; 0.6 no more
//   SUBS=6                 subscriptions the builders share evenly (6: one a machine, as the product reads them), each with a
//                          5-hour window; without it nobody's work spends anything, as in the README's tables
//   SPEND=0.4              the spend of a size, as a factor on the table's: at 1 a large task is 25% of a window, so three fill
//                          its room after the reserve; at 0.4 it is 10%, and eight do
//   GATE=1                 a builder starts a task only when its window has room for it after the reserve (the check package 16
//                          gives its daemon); without it a task starts when it is given, as today
//   HAND=1                 a task in hand counts for half its spend against its window, in the plan and in GATE's check;
//                          without it for nothing, as today
//   TOLD=1                 the plan and the check are told every window's use at every pass; without it only within an hour
//                          of a reply since its reset, as Claude's is known
// The README's tables: SEEDS=1,2,3 CASES=0:0:80,0.7:0.3:80,1:0.3:80,0:0:160,0.7:0.3:160 ONLY=fifo,solver,solver1,priced0
// (and CORES=8 for the second); the default is five seeds of four cases. The solver's rows vary a little with the
// computer: its search stops on a wall clock (BUDGET). With a budget large enough that its steps run out first
// (BUDGET=600000: %-of-search-steps-run says 100), they are the same on any computer, however loaded. A task starts the
// minute it is given: the model has no assigner's pass and no GitHub news between the two.
//
// Subscriptions (SUBS) are a model too. Assumed: a window refills to 100 every 300 minutes from a start of its own; its
// person spends nothing of it; a task spends its true size's percent (the table's, by SPEND, by the task's own noise) evenly
// over its minutes, whoever builds it; at nothing left its tasks stop until the reset. As the product: the plan is told a
// window's use only within an hour of a reply since its reset (Claude's is known no other way), and holds one it is not told
// to nothing; it counts a size's spend from the table, by the task's label, and nothing for a task in hand. The solver
// prices a window from what the plan is told of it (cli/src/superTabs/assign/schedule.ts priceOf): with HAND that is the
// room less its tasks in hand, so there the price does move when a task starts or ends. window-price.mts beside this
// file runs the critique's case for the price alone.
//
// Policies: fifo (first come, any free builder); solver (the allocator before package 2: a list two deep, its picks kept
// in this script as `twoDeep`); solver1 (the allocator since package 2, by the product's own `nextPicks`: a list one deep, a
// task is given only to a builder with nothing); dispatch (the most weight for its minutes, and
// nothing else); priced0 (the same, but a task another kind of builder does faster is left for one unless waiting costs more
// than the extra work: "the rule" of the README); priced4 (a builder-minute also costs 4, in a task's weight); queue (it
// costs what the builder's own area's queue loses meanwhile). Info: fixed (today's table of sizes and its guess of an
// area's speed), learned (the labels' real mean and the real speed), oracle (the minutes a task will really take).
import { solve } from '../../../cli/src/superTabs/assign/search.ts'
import { nextPicks, RESERVE, SIZES } from '../../../cli/src/superTabs/assign/crew.ts'
import type { Choice, Plan, Problem, Task as PlanTask } from '../../../cli/src/superTabs/assign/model.ts'

type Size = 's' | 'm' | 'l'
interface Task { id: string; arrive: number; label: Size; truth: Size; w: number; part: string; deps: string[]; noise: number
  builder?: string; given?: number; start?: number; end?: number }
interface Builder { id: string; machine: string; home: string; current: Task | null; queue: Task[]; sub: Sub | null }
/** A subscription's 5-hour window: the percent left, the minute it refills, and the last minute a reply told its use. */
interface Sub { id: string; left: number; reset: number; reply: number }
type Info = 'fixed' | 'learned' | 'oracle'
type Policy = 'solver' | 'solver1' | 'dispatch' | 'fifo' | 'priced0' | 'priced4' | 'queue'

const PARTS = ['api', 'desktop', 'cli', 'docs'], MIX: Record<Size, number> = { s: 0.5, m: 0.35, l: 0.15 }
// CORES=8 lets two large tasks share a machine, as the product does: it plans with a machine's cores (8 when unreported) but
// checks none when a task is taken, so at 6 this model holds the solver's builder to a rule the product does not enforce.
const CORES = Number(process.env.CORES ?? 6), TRUE_HOME = 0.6, TRUE_AWAY = Number(process.env.AWAY ?? 0.672)
const SUBS = Number(process.env.SUBS ?? 0), SPEND = Number(process.env.SPEND ?? 1), EVERY = 300, TOLD_FOR = 60
const GATE = process.env.GATE === '1', HAND = process.env.HAND === '1', TOLD = process.env.TOLD === '1'

function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
const normal = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
const pick = <T,>(r: () => number, table: Array<[T, number]>): T => { let x = r(); for (const [v, p] of table) { if ((x -= p) < 0) return v } return table.at(-1)![0] }

function world(seed: number, sigma: number, mislabel: number, n: number, hours = 10) {
  const r = rng(seed)
  // Their windows start at minutes of their own, from another generator: the day's tasks are the same with and without them.
  const starts = rng(seed + 7919)
  const subs: Sub[] = Array.from({ length: SUBS }, (_, i) => ({ id: `s${i}`, left: 100, reset: 1 + Math.floor(starts() * EVERY), reply: -Infinity }))
  const builders: Builder[] = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, machine: `m${i >> 1}`, home: PARTS[i % 4]!, current: null, queue: [],
    sub: subs[Math.floor(i * SUBS / 12)] ?? null }))
  const tasks: Task[] = []
  let at = 0
  for (let i = 0; i < n; i++) {
    at += -Math.log(1 - r()) * (hours * 60 / n)
    const truth = pick<Size>(r, [['s', MIX.s], ['m', MIX.m], ['l', MIX.l]])
    const off = r() < mislabel
    const label: Size = !off ? truth : truth === 's' ? 'm' : truth === 'l' ? 'm' : r() < 0.5 ? 's' : 'l'
    const deps = i > 0 && r() < 0.1 ? [`#${1 + Math.floor(r() * i)}`] : []
    tasks.push({ id: `#${i + 1}`, arrive: Math.floor(at), label, truth, w: pick(r, [[8, 0.05], [4, 0.25], [2, 0.4], [1, 0.3]]), part: PARTS[Math.floor(r() * 4)]!, deps,
      noise: Math.exp(sigma * normal(r) - sigma * sigma / 2) })
  }
  return { builders, tasks, subs }
}

/** The allocator's picks before package 2, kept to compare with: what each builder starts next among the [free] tasks, in
 *  the plan's order, while it [held] fewer than two. */
function twoDeep(plan: Plan, free: Set<string>, held: Map<string, number>) {
  const count = new Map(held)
  return [...plan.placements].sort((a, b) => a.start - b.start || a.task.localeCompare(b.task)).filter(p => {
    if (!free.has(p.task) || count.get(p.builder)! >= 2) return false
    count.set(p.builder, count.get(p.builder)! + 1)
    return true
  })
}

/** What a labelled size means in minutes once the labels' errors are learned: the mean true size of tasks so labelled. */
function learnedMinutes(mislabel: number): Record<Size, number> {
  const to = (truth: Size, label: Size) => truth === label ? 1 - mislabel : truth === 's' || truth === 'l' ? (label === 'm' ? mislabel : 0) : mislabel / 2
  const out = {} as Record<Size, number>
  for (const label of ['s', 'm', 'l'] as Size[]) {
    let mass = 0, sum = 0
    for (const truth of ['s', 'm', 'l'] as Size[]) { const p = MIX[truth] * to(truth, label); mass += p; sum += p * SIZES[truth].minutes }
    out[label] = sum / mass
  }
  return out
}

function run(seed: number, sigma: number, mislabel: number, n: number, policy: Policy, info: Info, budgetMs: number) {
  const { builders, tasks, subs } = world(seed, sigma, mislabel, n)
  const backs = new Set<string>()
  const byId = new Map(tasks.map(t => [t.id, t])), learned = learnedMinutes(mislabel)
  const truly = (t: Task, b: Builder) => Math.max(1, Math.round(SIZES[t.truth].minutes * (t.part === b.home ? TRUE_HOME : TRUE_AWAY) * t.noise))
  const minutes = (t: Task) => info === 'fixed' ? SIZES[t.label].minutes : learned[t.label]
  const factor = (t: Task, b: Builder) => info === 'fixed' ? (t.part === b.home ? 0.5 : 1.5) : (t.part === b.home ? TRUE_HOME : TRUE_AWAY)
  const expected = (t: Task, b: Builder) => info === 'oracle' ? truly(t, b) : minutes(t) * factor(t, b)
  const done = (t: Task, now: number) => t.end !== undefined && t.end <= now
  const eligible = (t: Task, now: number) => t.arrive <= now && !t.builder && t.deps.every(d => done(byId.get(d)!, now))
  const used = (machine: string) => builders.filter(b => b.machine === machine && b.current).reduce((sum, b) => sum + SIZES[b.current!.label].cpu, 0)
  const fits = (t: Task, b: Builder) => used(b.machine) + SIZES[t.label].cpu <= CORES
  // What a task spends of a window: in truth, and as the plan counts it (the table, by its label).
  const spends = (t: Task) => SIZES[t.truth].spend * SPEND * t.noise, counted = (t: Task) => SIZES[t.label].spend * SPEND
  const told = (s: Sub, now: number) => TOLD || now - s.reply <= TOLD_FOR
  // What a subscription's tasks in hand are counted to spend yet before its reset (HAND): half of each, as the plan counts
  // half their minutes, nobody knowing how far they are.
  const inHand = (s: Sub, now: number) => !HAND ? 0 : builders.filter(b => b.sub === s && b.current)
    .reduce((sum, b) => sum + counted(b.current!) * Math.min(1 / 2, (s.reset - now) / expected(b.current!, b)), 0)
  // The daemon's check as a task is taken (GATE): the window has room, after the reserve, for what the task spends before
  // its reset, as the plan counts it. A window it is not told is not checked.
  const room = (t: Task, b: Builder, now: number) => !GATE || !b.sub || !told(b.sub, now)
    || b.sub.left - RESERVE - inHand(b.sub, now) >= counted(t) * Math.min(1, (b.sub.reset - now) / expected(t, b))
  let last: Choice | undefined, solves = 0, idle = 0, now = 0, steps = 0, asked = 0, heldMinutes = 0, moved = 0, compared = 0
  let planned = new Map<string, string>()
  const lapsed: number[] = [], held = new Set<string>()
  for (; tasks.some(t => !done(t, now)) && now < 60 * 24 * 7; now++) {
    for (const s of subs) if (s.reset <= now) { lapsed.push(s.left); s.left = 100; s.reset += EVERY; s.reply = -Infinity }
    for (const b of builders) if (b.current && b.current.end! <= now) b.current = null
    const open = tasks.filter(t => eligible(t, now))
    // solver1 holds one task ahead of each builder instead of two (found by the design's first review; the product's rule
    // since package 2). The model has no reads, so all a builder holds is what it builds.
    const deep = policy === 'solver1' ? 1 : 2
    if (policy === 'solver' || policy === 'solver1') {
      // As today (githubAssign.ts openWaiting): a task given ten minutes ago and not started goes back, once a task and builder,
      // while a builder that could take it has nothing given or in hand.
      for (const b of builders) for (const t of [...b.queue]) {
        if (now - t.given! < 10 || backs.has(`${t.id}:${b.id}`) || !builders.some(o => o !== b && !o.current && !o.queue.length)) continue
        backs.add(`${t.id}:${b.id}`); b.queue.splice(b.queue.indexOf(t), 1); delete t.builder; delete t.given; open.push(t)
      }
      if (open.length && builders.some(b => (b.current ? 1 : 0) + b.queue.length < deep)) {
        const plan = (t: Task, pinned?: string): PlanTask => ({ id: t.id, minutes: Math.ceil(minutes(t)), needs: { cpu: SIZES[t.label].cpu, ram: 0, disk: 0 },
          spend: subs.length ? { five_hour: counted(t) } : {}, floor: 0, kind: 'build',
          part: t.part, weight: t.w, ready: 0, deps: [], independentOf: [], notBuilders: [], files: [], ...(pinned ? { pinned, queuedOn: pinned } : {}) })
        const problem: Problem = { now: 0, objective: 'weighted', switchCost: 30,
          accounts: subs.map(s => ({ id: s.id, reserve: RESERVE, windows: told(s, now) ? [{ name: 'five_hour', left: Math.max(0, s.left - inHand(s, now)), resetsAt: s.reset - now, every: EVERY }] : [] })),
          machines: [...new Set(builders.map(b => b.machine))].map(id => ({ id, capacity: { cpu: CORES, ram: 1, disk: 1 } })),
          // As today: a task in hand keeps its builder busy for half its size, however long it has run.
          builders: builders.map(b => ({ id: b.id, machine: b.machine, busyUntil: b.current ? Math.ceil(minutes(b.current) / 2) : 0,
            modes: [{ model: 'x', family: 'anthropic', speed: 1, cost: 2, quality: { default: 1 }, account: b.sub?.id ?? null }],
            context: Object.fromEntries(PARTS.map(p => [p, info === 'fixed' ? (p === b.home ? 0.5 : 1.5) : (p === b.home ? TRUE_HOME : TRUE_AWAY)])) })),
          tasks: [...open.map(t => plan(t)), ...builders.flatMap(b => b.queue.map(t => plan(t, b.id)))] }
        const solved = solve(problem, { budgetMs, iterations: Math.min(200_000, 400 * problem.tasks.length), seed: 1, ...(last ? { start: last } : {}) })
        last = solved.choice; solves++; steps += solved.iterations; asked += Math.min(200_000, 400 * problem.tasks.length)
        // Plans that churn: of the tasks still free since the last plan, those this one puts on another builder.
        const places = new Map(solved.plan.placements.map(p => [p.task, p.builder]))
        for (const t of open) { const was = planned.get(t.id), is = places.get(t.id); if (was && is) { compared++; if (was !== is) moved++ } }
        planned = places
        const held = new Map(builders.map(b => [b.id, (b.current ? 1 : 0) + b.queue.length]))
        const read = { problem, open: held, building: held, free: new Set(open.map(t => t.id)),
          builders: new Map(builders.map(b => [b.id, { id: b.id, name: b.id, label: b.id, machineId: b.machine, engine: 'claude' }])) }
        for (const p of deep === 1 ? nextPicks(solved.plan, read as never) : twoDeep(solved.plan, read.free, held)) { const t = byId.get(p.task)!, b = builders.find(x => x.id === p.builder)!; t.builder = b.id; t.given = now; b.queue.push(t) }
      }
      for (const b of builders) {
        if (b.current || !b.queue.length) continue
        const t = b.queue[0]!
        if (!fits(t, b)) continue
        if (!room(t, b, now)) { held.add(t.id); heldMinutes++; continue }
        b.queue.shift(); b.current = t; t.start = now; t.end = now + truly(t, b)
      }
    } else {
      const free = builders.filter(b => !b.current)
      // Priced: a builder takes a task another kind of builder does in less time only when waiting for one of those costs
      // more than the extra work, at a price c on a builder-minute (what tokens cost, in the units of a task's weight):
      // w x wait > (w + c) x extra. The wait is read from what those builders hold and what is ahead of the task in its part.
      const price = policy === 'priced0' || policy === 'queue' ? 0 : policy === 'priced4' ? 4 : null
      const worth = (t: Task, b: Builder) => {
        if (price === null) return true
        const best = Math.min(...builders.map(x => expected(t, x))), extra = expected(t, b) - best
        if (extra <= 0) return true
        const own = builders.filter(x => expected(t, x) === best)
        const ahead = open.filter(o => o !== t && o.part === t.part && o.w / expected(o, own[0]!) >= t.w / best)
        const wait = (own.reduce((s, x) => s + (x.current ? expected(x.current, x) / 2 : 0), 0) + ahead.reduce((s, o) => s + expected(o, own[0]!), 0)) / own.length
        // Queue: what a minute away costs the builder's own part, from what waits there now: each waiting task is held up
        // by that minute, shared among the part's builders. Nothing when its own part has nothing waiting.
        const home = policy === 'queue' ? open.filter(o => o.part === b.home).reduce((s, o) => s + o.w, 0) / builders.filter(x => x.home === b.home).length : 0
        return t.w * wait > (t.w + price) * extra + home * expected(t, b)
      }
      const pairs = free.flatMap(b => open.filter(t => fits(t, b) && worth(t, b)).map(t => ({ b, t, score: policy === 'fifo' ? -t.arrive : t.w / expected(t, b) }))).sort((x, y) => y.score - x.score)
      for (const { b, t } of pairs) {
        if (b.current || t.builder || !fits(t, b)) continue
        t.builder = b.id; b.current = t; t.start = now; t.end = now + truly(t, b)
      }
    }
    // A builder with nothing in hand while a task it could start waits.
    const waiting = tasks.filter(t => t.arrive <= now && t.start === undefined && t.deps.every(d => done(byId.get(d)!, now)))
    idle += builders.filter(b => !b.current && waiting.some(t => (!t.builder || t.builder === b.id) && fits(t, b))).length
    // A minute of work spends each task's window, and tells its use; with nothing left the task stops until the reset.
    for (const b of builders) {
      const t = b.current, s = b.sub
      if (!t || !s) continue
      if (s.left <= 0) { t.end!++; held.add(t.id); heldMinutes++ } else { s.left = Math.max(0, s.left - spends(t) / truly(t, b)); s.reply = now }
    }
  }
  const weight = tasks.reduce((s, t) => s + t.w, 0)
  return { weighted: tasks.reduce((s, t) => s + t.w * (t.end! - t.arrive), 0) / weight, mean: tasks.reduce((s, t) => s + t.end! - t.arrive, 0) / tasks.length,
    p0: avg(tasks.filter(t => t.w === 8).map(t => t.end! - t.arrive)), idle, last: Math.max(...tasks.map(t => t.end!)), solves,
    work: tasks.reduce((s, t) => s + t.end! - t.start!, 0), searched: asked ? 100 * steps / asked : 0,
    // Of a window at its reset: the percent left, and what was spent of its person's reserve. Tasks held for a reset (not
    // started for want of room, or stopped with nothing left), and their minutes. And the plans' churn.
    unspent: avg(lapsed), reserve: avg(lapsed.map(left => Math.max(0, RESERVE - left))), held: held.size, heldMinutes,
    churn: compared ? 100 * moved / compared : 0 }
}
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0

const seeds = (process.env.SEEDS ?? '1,2,3,4,5').split(',').map(Number), budgetMs = Number(process.env.BUDGET ?? 250)
const cases = (process.env.CASES ?? '0:0:160,0.7:0.3:160,1:0.3:160,0.7:0.3:80').split(',').map(c => c.split(':').map(Number) as [number, number, number])
console.log(`12 builders on 6 machines of ${CORES} cores, away ${TRUE_AWAY}x, tasks arriving over 10 h, sizes ${JSON.stringify(MIX)}; solver budget ${budgetMs} ms; seeds ${seeds.join(',')}`
  + (SUBS ? `; ${SUBS} subscriptions, spend ${SPEND}x, ${GATE ? 'a task waits for room in its window' : 'a task starts when given'}${HAND ? ', tasks in hand counted' : ''}${TOLD ? ', every window told' : ''}` : ''))
console.log('noise  mislabel tasks policy    info     weighted-flow  mean-flow  p0-flow  idle-builder-min  last-end  work-min  solves  %-of-search-steps-run'
  + (SUBS ? '  %-left-at-reset  %-of-reserve-spent  tasks-held  held-min  %-of-plan-moved' : ''))
for (const [sigma, mislabel, n] of cases) {
  for (const [policy, info] of ([['fifo', 'fixed'], ['solver', 'fixed'], ['solver1', 'fixed'], ['dispatch', 'fixed'], ['priced0', 'fixed'], ['priced4', 'fixed'], ['queue', 'fixed'], ['solver', 'learned'], ['dispatch', 'learned'], ['priced0', 'learned'], ['priced4', 'learned'], ['queue', 'learned'], ['queue', 'oracle']] as Array<[Policy, Info]>).filter(([p]) => !process.env.ONLY || process.env.ONLY.split(',').includes(p))) {
    const runs = seeds.map(seed => run(seed, sigma, mislabel, n, policy, info, budgetMs))
    const m = (key: keyof ReturnType<typeof run>) => avg(runs.map(r => r[key])).toFixed(0).padStart(8)
    console.log(`${String(sigma).padEnd(6)} ${String(mislabel).padEnd(8)} ${String(n).padEnd(5)} ${policy.padEnd(9)} ${info.padEnd(8)} ${m('weighted')}       ${m('mean')}   ${m('p0')}   ${m('idle')}          ${m('last')}  ${m('work')}  ${m('solves')}  ${m('searched')}`
      + (SUBS ? `          ${m('unspent')}  ${m('reserve')}            ${m('held')}  ${m('heldMinutes')}  ${m('churn')}` : ''))
  }
}
