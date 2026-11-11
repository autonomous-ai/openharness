/**
 * A Swarm v4 team's assignment problem as GitHub and the Swarm say it now (docs/design/2026-11-09-swarm-v4-assignment.md):
 * its tasks are the repository's open issues the PM labelled, its builders the project's agents, its machines and
 * subscriptions what each machine last reported. The solver (search.ts) plans it; this file reads it in and picks what each
 * builder starts next. Pure: githubAssign.ts reads GitHub and the Swarm and applies the picks.
 */
import type { Account, Builder, Machine, Plan, Problem, QuotaWindow, Task } from './model.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const GiB = 1024 ** 3

/**
 * What a task of each size takes until finished tasks teach better (the design's Next 2): minutes of work, what it holds of
 * its machine while it runs, and the percent of a 5-hour window it spends. A weekly window is spent a fifth as fast.
 */
export const SIZES: Record<'s' | 'm' | 'l', { minutes: number; cpu: number; ram: number; disk: number; spend: number }> = {
  s: { minutes: 30, cpu: 1, ram: 2 * GiB, disk: 1 * GiB, spend: 3 },
  m: { minutes: 90, cpu: 2, ram: 4 * GiB, disk: 2 * GiB, spend: 10 },
  l: { minutes: 240, cpu: 4, ram: 8 * GiB, disk: 4 * GiB, spend: 25 },
}
/** A priority's weight in the plan: a p0 waiting a minute counts as a p2 waiting four. */
export const WEIGHTS: Record<string, number> = { p0: 8, p1: 4, p2: 2 }
/** The percent of each window its person keeps for their own work: Swarm work never spends it (AGENTS.md, contributed
 *  capacity: "their quota is never drained without them knowing"). */
export const RESERVE = 20
/** Cores a machine is planned with when its daemon reports none (one before 0.5.86): two large tasks at once. */
export const CORES = 8
/** Of a machine's memory, what Swarm work may hold: its person keeps the rest. */
export const MEMORY_SHARE = 0.75
/** Disk its person keeps free whatever the Swarm does. */
export const DISK_KEPT = 10 * GiB
/** How deep each builder's list is kept (PM_BASICS: "keep every builder's list two deep"): what it works on and what is next. */
export const DEEP = 2
/** A builder's time in an area its person says it works on: half, so it gets those tasks first, and another builder takes
 *  one only when it is well behind (anh Dee, 2026-11-09: "do you assign agents to their area of expertise?"). */
export const FOCUS = 0.5
/** And in an area it does not work on, once its person named some: it takes other work only when its own has none. */
const AWAY = 1.5

/** One of the project's agents that builds, as the PM's read of the Swarm names it, with the areas its instructions say it
 *  works on in this project ([worksOnOf]; empty for anything, absent when unread or unsaid). */
export interface CrewBuilder { id: string; name: string; label: string; machineId: string; engine: string; model?: string | null
  worksOn?: string[] | null }
/** A machine a builder runs on, with its last report (backend machines.ts machineObservationSchema). */
export interface CrewMachine { machineId: string; name?: string; observation?: Json }
/** A builder of the team that cannot work now: its person is stopping it, its machine has been down since [since], or its
 *  subscription has no room until [until] (minutes from now). */
export interface AwayBuilder { name: string; label: string; why: 'stopping' | 'down' | 'quota' | 'paused'; since?: string; until?: number }
export interface Crew { builders: CrewBuilder[]; machines: CrewMachine[]; away?: AwayBuilder[] }

/** How long a builder's machine is down before its queued tasks go to others, and before the ones it took do too: a sleep
 *  or a restart is back well within the first; a task taken may have work on that machine, so it waits longer. */
export const QUEUED_AWAY_MS = 30 * 60_000, TAKEN_AWAY_MS = 3 * 60 * 60_000
/** A subscription with less room than a small task until a reset further off than this keeps no queued tasks. */
export const QUOTA_WAIT_MINUTES = 120
/** A task taken and quiet this long (no comment, no change to its pull request) gets one ask of its builder; quiet this long
 *  after the ask, it goes to another. Agents post when they start, open a pull request and answer reviews, so four quiet
 *  hours is rare for one at work. */
export const QUIET_ASK_MS = 4 * 60 * 60_000, QUIET_BACK_MS = 8 * 60 * 60_000

/** The problem, and what the picks and their reasons need to know of it. */
export interface Read {
  problem: Problem
  /** Each builder's tasks open now: in progress and queued, by builder id. */
  open: Map<string, number>
  /** The tasks no builder holds, which this may give. */
  free: Set<string>
  /** Each builder's finished tasks by part, from the closed issues its label was on. */
  done: Map<string, Map<string, number>>
  /** The builders by id, for their names and labels. */
  builders: Map<string, CrewBuilder>
}

/** One name however it is written: as an agent signs it ("Pip Two"), as its builder label has it (`pip-two`), or cased
 *  otherwise. Without it, "pip two" and "pip-two" were two people, so an agent with a two-word name read its own pull request
 *  and the merger merged it (found by the Q3 tester, 2026-11-09). Readers are kept and skipped by it (githubMerge.ts, readerFor). */
export const sameKey = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/ς/g, 'σ').replace(/[^\p{L}\p{N}]/gu, '')

/** A reader as the merger and the readers' count keep it: its `sameKey`, or a name of no letters or digits as written. */
export const readerKey = (name: string): string => sameKey(name) || name.toLowerCase()

/** The label a builder's tasks carry: builder:pip for Pip, as githubMentions.ts builderLabel. */
export const labelOf = (name: string): string => `builder:${name.trim().toLowerCase().replace(/\s+/g, '-')}`

/** The labels of a project's team: its builders' (away ones too) and its PM's. Harness asks readers for, and merges, only
 *  the team's own pull requests: a person's, or anyone's in a shared repository, is theirs (openharness has dozens open at a
 *  time, by people and their own agents). */
export const teamOf = (crew: Crew, pm: string): Set<string> =>
  new Set([...crew.builders.map(b => b.label), ...(crew.away ?? []).map(a => a.label), labelOf(pm)])

/** An area as its `part:` label names it: "Mobile app" is mobile-app, "part:API" is api. */
export const areaOf = (word: string): string =>
  word.trim().toLowerCase().replace(/^part:/, '').replace(/[`*_"'.]/g, '').trim().replace(/\s+/g, '-')

/**
 * The areas an agent's instructions file says it works on in its project (agents/<Name>.md, which its person reads and
 * changes beside its chat): its `Works on:` line, one of the first lines, as areas ("Mobile, backend" is mobile and
 * backend). Empty for anything; null when the file says nothing, which is when its agent asks its person
 * (githubMentions.ts).
 */
export function worksOnOf(text: string | null | undefined): string[] | null {
  if (typeof text !== 'string') return null
  const line = text.split('\n').slice(0, 40).map(l => /^\s*(?:[-*>]\s*)?\**\s*works on\s*\**\s*:\s*\**\s*(.*?)\s*$/i.exec(l)).find(Boolean)
  if (!line) return null
  const areas = [...new Set(line[1]!.split(/,|;|\/|\band\b|&/i).map(areaOf).filter(Boolean))]
  return areas.length === 0 || areas.includes('anything') || areas.includes('everything') ? [] : areas
}

const labelsOf = (issue: Json): string[] =>
  (Array.isArray(issue.labels) ? issue.labels.map(object) : []).map(label => String(label.name ?? '')).filter(Boolean)
const valueOf = (labels: string[], prefix: string): string | undefined =>
  labels.find(label => label.startsWith(prefix) && label.length > prefix.length)?.slice(prefix.length)

/** The issues an issue's text says must end first: "after #12", "depends on #12", "blocked by #12". */
export function dependsOn(body: unknown): number[] {
  const found = new Set<number>()
  for (const match of String(body ?? '').matchAll(/\b(?:after|depends on|blocked by)\s+#(\d+)/gi)) found.add(Number(match[1]))
  return [...found]
}

/** Whether a machine has what a `needs:` label asks: a tool it reports, its system, or a GPU. */
export function machineHas(observation: Json | undefined, need: string): boolean {
  const tools = object(observation?.tools), resources = object(observation?.resources)
  if (tools[need] === true) return true
  const os = String(resources.os ?? '').toLowerCase()
  if (['macos', 'mac'].includes(need)) return os.includes('mac') || os.includes('darwin')
  if (need === 'linux' || need === 'windows') return os.includes(need)
  if (need === 'gpu') return typeof resources.gpuPercent === 'number'
  return false
}

/** Minutes from [now] to a reset as a machine reports it (ISO time or epoch ms), never before now; null when unknown. */
function minutesUntil(reset: unknown, now: number): number | null {
  const at = typeof reset === 'number' ? reset : typeof reset === 'string' ? Date.parse(reset) : NaN
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 60_000)) : null
}

/** How often a window refills, by its name as engines give it: five hours, a week, or unknown. */
function everyOf(name: string): number | null {
  if (/5\s*h|five|hour|primary/i.test(name)) return 300
  if (/week|7\s*d|seven|secondary/i.test(name)) return 7 * 24 * 60
  return null
}

/**
 * The problem as GitHub and the Swarm say it at [now]: the open issues the PM sized and nobody holds are free tasks; those
 * a builder holds are queued on it (pinned, so the plan sees its list), and the one it has taken keeps it busy for half
 * its size; an issue another label holds is not this team's to plan.
 */
export function readProblem(input: { now: number; issues: Json[]; closed: Json[]; crew: Crew; minutes?: Partial<Record<'s' | 'm' | 'l', number>> }): Read {
  const { now, crew } = input
  const byLabel = new Map(crew.builders.map(b => [b.label, b]))
  const machines = new Map(crew.machines.map(m => [m.machineId, m]))
  const open = new Map<string, number>(crew.builders.map(b => [b.id, 0]))
  const busy = new Map<string, number>()
  const free = new Set<string>()
  const done = new Map<string, Map<string, number>>()
  for (const issue of input.closed) {
    if (issue.pull_request) continue
    const labels = labelsOf(issue), part = valueOf(labels, 'part:')
    const builder = labels.map(label => byLabel.get(label)).find(Boolean)
    if (!builder || !part) continue
    const parts = done.get(builder.id) ?? new Map<string, number>()
    parts.set(part, (parts.get(part) ?? 0) + 1)
    done.set(builder.id, parts)
  }
  const tasks: Task[] = []
  const issues = input.issues.filter(issue => !issue.pull_request && Number.isSafeInteger(issue.number))
  const openNumbers = new Set(issues.map(issue => Number(issue.number)))
  const windowNames = new Set<string>()
  for (const machine of crew.machines) {
    for (const quota of Array.isArray(machine.observation?.quotas) ? machine.observation.quotas.map(object) : []) {
      for (const window of Array.isArray(quota.windows) ? quota.windows.map(object) : []) windowNames.add(String(window.name ?? ''))
    }
  }
  for (const issue of issues) {
    const labels = labelsOf(issue)
    const held = labels.filter(label => label.startsWith('builder:'))
    const holder = held.map(label => byLabel.get(label)).find(Boolean)
    // Held by a label that names no builder of this team, or taken with none (a person on it): someone else's to plan.
    if ((held.length && !holder) || (!holder && labels.includes('status:taken'))) continue
    // Nobody's, with pieces cut off it still open (its builder was stopped, or gave it back): others build those, and given
    // out whole it would be built beside them. It is planned once they are closed (third review of the split).
    if (!holder && openPieces(issue)) continue
    const sized = valueOf(labels, 'size:')
    const size = sized === 's' || sized === 'm' || sized === 'l' ? sized : undefined
    // Not sized: the PM has not made it a task yet. One a builder holds counts as a middle one.
    if (!size && !holder) continue
    // The time this project's finished tasks of the size took, once there are enough of them (learnedMinutes).
    const shape = { ...SIZES[size ?? 'm'], ...input.minutes?.[size ?? 'm'] ? { minutes: input.minutes[size ?? 'm']! } : {} }
    const id = `#${issue.number}`
    // Taken and waiting on pieces cut off it: others build those, so it holds no place in its builder's list and none of its
    // time. Counted, a builder with two such was given nothing more, and a team's one builder could never be given the pieces
    // (second review of the split).
    if (holder && labels.includes('status:taken') && openPieces(issue)) continue
    if (holder) open.set(holder.id, (open.get(holder.id) ?? 0) + 1)
    if (holder && labels.includes('status:taken')) {
      busy.set(holder.id, (busy.get(holder.id) ?? 0) + Math.ceil(shape.minutes / 2))
      continue
    }
    const needs = labels.filter(label => label.startsWith('needs:')).map(label => label.slice('needs:'.length))
    const unable = crew.builders.filter(b => needs.some(need => !machineHas(machines.get(b.machineId)?.observation, need))).map(b => b.id)
    const priority = labels.find(label => label in WEIGHTS)
    tasks.push({
      id, minutes: shape.minutes, needs: { cpu: shape.cpu, ram: shape.ram, disk: shape.disk },
      spend: Object.fromEntries([...windowNames].map(name => [name, everyOf(name) === 300 ? shape.spend : shape.spend / 5])),
      floor: 0, kind: 'build', part: valueOf(labels, 'part:'), weight: priority ? WEIGHTS[priority]! : 1, ready: 0,
      deps: dependsOn(issue.body).filter(n => openNumbers.has(n)).map(n => `#${n}`),
      independentOf: [], notBuilders: unable, ...unable.length ? { notWhy: `its builder's machine lacks one of: ${needs.join(', ')}` } : {}, files: [],
      ...(holder ? { pinned: holder.id, queuedOn: holder.id } : {}),
    })
    if (!holder) free.add(id)
  }
  // A dependency on a task this does not plan (taken, or someone else's) is not waited for here.
  const planned = new Set(tasks.map(task => task.id))
  for (const task of tasks) task.deps = task.deps.filter(dep => planned.has(dep))
  const parts = new Set([...tasks.map(task => task.part).filter((part): part is string => !!part), ...[...done.values()].flatMap(m => [...m.keys()])])
  const builders: Builder[] = crew.builders.map(b => ({
    id: b.id, machine: b.machineId, busyUntil: busy.get(b.id) ?? 0,
    modes: [{ model: b.model || b.engine, family: b.engine === 'codex' ? 'openai' : 'anthropic', speed: 1, cost: 2,
      quality: { default: 1 }, account: `${b.machineId}:${b.engine}` }],
    context: contextOf([...parts], done.get(b.id), b.worksOn),
  }))
  const problemMachines: Machine[] = [...new Set(crew.builders.map(b => b.machineId))].map(id => {
    const resources = object(machines.get(id)?.observation?.resources)
    const memory = typeof resources.memoryTotalBytes === 'number' ? resources.memoryTotalBytes * MEMORY_SHARE : 16 * GiB
    const free = typeof resources.projectDiskFreeBytes === 'number' ? resources.projectDiskFreeBytes
      : typeof resources.diskFreeBytes === 'number' ? resources.diskFreeBytes : 60 * GiB
    // Its cores as it reports them (a daemon since 0.5.86); an older one is planned as CORES.
    const cores = typeof resources.cpuCores === 'number' && Number.isSafeInteger(resources.cpuCores) && resources.cpuCores > 0 ? resources.cpuCores : CORES
    return { id, capacity: { cpu: cores, ram: memory, disk: Math.max(0, free - DISK_KEPT) } }
  })
  const accounts: Account[] = [...new Set(crew.builders.map(b => `${b.machineId}:${b.engine}`))].map(id => {
    const [machineId, engine] = id.split(':') as [string, string]
    const quota = (Array.isArray(machines.get(machineId)?.observation?.quotas) ? machines.get(machineId)!.observation!.quotas as unknown[] : [])
      .map(object).find(q => q.engine === engine && q.known === true)
    const windows: QuotaWindow[] = (Array.isArray(quota?.windows) ? quota.windows.map(object) : []).flatMap(window => {
      const used = typeof window.usedPercent === 'number' ? window.usedPercent : null
      const resetsAt = minutesUntil(window.resetsAt, now)
      return used === null || resetsAt === null ? [] : [{ name: String(window.name ?? ''), left: Math.max(0, 100 - used), resetsAt, every: everyOf(String(window.name ?? '')) }]
    })
    return { id, reserve: RESERVE, windows }
  })
  return { problem: { now: 0, machines: problemMachines, accounts, builders, tasks, objective: 'weighted', switchCost: 30 }, open, free, done,
    builders: new Map(crew.builders.map(b => [b.id, b])) }
}

/**
 * The team that builds a project, from its PM's read of the Swarm: its person's and their teammates' agents that may work
 * in it (a private project's own only), never the PM itself, one stopping or one whose machine is down, each with
 * the machine it runs on. Swarm v4 agents run Claude Code or Codex.
 */
export function crewOf(state: Json, project: { pmAgentId: string; projectId: string }): Crew {
  const agents = Array.isArray(state.agents) ? state.agents.map(object) : []
  const team = agents.filter(a => a.regular === true && typeof a.id === 'string' && a.id !== project.pmAgentId
    && typeof a.machineId === 'string' && (a.privateProjectId === undefined || a.privateProjectId === null || a.privateProjectId === project.projectId)
    && ['claude', 'codex'].includes(String(object(a.configuration).engine)))
  // Paused by its person or the Swarm's owner (backend agent.pause): given nothing and asked nothing, its pull requests still read
  // and merged, the tasks it took kept for it as one out of quota keeps them (takeBacks).
  const away: AwayBuilder[] = team.filter(a => a.workDecision === 'stop' || a.downSince || a.paused === true).map(a => {
    const name = String(a.displayName ?? a.name ?? a.id)
    return a.workDecision === 'stop' ? { name, label: labelOf(name), why: 'stopping' as const }
      : a.downSince ? { name, label: labelOf(name), why: 'down' as const, since: String(a.downSince) }
      : { name, label: labelOf(name), why: 'paused' as const }
  })
  const builders = team.filter(a => a.workDecision !== 'stop' && !a.downSince && a.paused !== true)
    .map(a => {
      const name = String(a.displayName ?? a.name ?? a.id)
      const model = object(a.configuration).model
      return { id: String(a.id), name, label: labelOf(name), machineId: String(a.machineId), engine: String(object(a.configuration).engine),
        model: typeof model === 'string' ? model : null }
    })
  const machines = (Array.isArray(state.machines) ? state.machines.map(object) : []).filter(m => typeof m.machineId === 'string')
    .map(m => ({ machineId: String(m.machineId), name: typeof m.name === 'string' ? m.name : undefined, observation: object(m.observation) }))
  return { builders, machines, away }
}

/** An open task to take back from a builder that cannot work: its label, whether it was taken, and why, in a few words. */
export interface TakeBack { number: number; label: string; taken: boolean; why: string }

/**
 * The open tasks of builders that cannot work, to give to others: all of one its person is stopping; of one whose machine
 * is down, the queued after [QUEUED_AWAY_MS] and the taken after [TAKEN_AWAY_MS]. A task a person set to that builder is
 * taken back too: the builder cannot do it.
 */
export function takeBacks(issues: Json[], away: AwayBuilder[], now: number): TakeBack[] {
  const byLabel = new Map(away.map(a => [a.label, a]))
  const out: TakeBack[] = []
  for (const issue of issues) {
    if (issue.pull_request || !Number.isSafeInteger(issue.number)) continue
    const labels = labelsOf(issue)
    const builder = labels.map(label => byLabel.get(label)).find(Boolean)
    if (!builder) continue
    const taken = labels.includes('status:taken')
    if (builder.why === 'down') {
      const since = Date.parse(builder.since ?? '')
      if (!Number.isFinite(since) || now - since < (taken ? TAKEN_AWAY_MS : QUEUED_AWAY_MS)) continue
    }
    // Out of quota, or paused: what it took it finishes; what waits for it goes to another.
    if ((builder.why === 'quota' || builder.why === 'paused') && taken) continue
    const down = builder.why === 'down' ? `${builder.name}'s machine has been down since ${new Date(Date.parse(builder.since!)).toISOString().slice(11, 16)} UTC`
      : builder.why === 'quota' ? `${builder.name}'s subscription has no room for ${Math.round((builder.until ?? 0) / 60)} h`
      : builder.why === 'paused' ? `${builder.name} is paused`
      : `${builder.name} is being stopped`
    out.push({ number: Number(issue.number), label: builder.label, taken, why: down })
  }
  return out
}

/**
 * How fast a builder is in each part, as a factor of its time: each task it finished there makes the next 15% quicker,
 * to 40% at most; an area its person says it works on halves it ([FOCUS]); once its person named some, any other area
 * takes it half as long again ([AWAY]).
 */
export function contextOf(parts: string[], done: Map<string, number> | undefined, worksOn: string[] | null | undefined): Record<string, number> {
  const context: Record<string, number> = {}
  for (const part of parts) {
    const learned = Math.max(0.6, 1 - 0.15 * (done?.get(part) ?? 0))
    const factor = !worksOn?.length ? learned : worksOn.includes(part) ? Math.min(learned, FOCUS) : learned * AWAY
    if (factor !== 1) context[part] = Math.round(factor * 1000) / 1000
  }
  return context
}

/** The builders whose subscription has less room than a small task until a reset more than [QUOTA_WAIT_MINUTES] away, with
 *  that reset: their queued tasks would wait for it. */
export function outOfQuota(read: Read): AwayBuilder[] {
  const out: AwayBuilder[] = []
  for (const builder of read.problem.builders) {
    const account = read.problem.accounts.find(a => a.id === builder.modes[0]?.account)
    const crew = read.builders.get(builder.id)
    if (!account || !crew) continue
    // A weekly window is spent a fifth as fast as a 5-hour one (readProblem's spend).
    const blocked = account.windows.filter(w => w.left - account.reserve < SIZES.s.spend / (w.every === 300 ? 1 : 5) && w.resetsAt > QUOTA_WAIT_MINUTES)
    if (blocked.length) out.push({ name: crew.name, label: crew.label, why: 'quota', until: Math.max(...blocked.map(w => w.resetsAt)) })
  }
  return out
}

/** A task a builder of the team took, and when it was last touched: its issue, or a pull request for it. */
export interface Taken { number: number; label: string; name: string; touched: number }

/** The tasks a pull request is for: the issues it closes, and its builder's branch for one (`pip/14`). */
export function tasksOf(pull: Json): number[] {
  const branch = /^[^/]+\/(\d+)$/.exec(String((pull.head as Json | undefined)?.ref ?? ''))?.[1]
  const closes = [...String(pull.body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map(m => Number(m[1]))
  return [...new Set([...closes, ...branch ? [Number(branch)] : []])]
}

/** How many pieces cut off a task are still open (githubSplit.ts), as GitHub counts its sub-issues. A task with some waits
 *  on them: it holds no place in its builder's list, and its builder is neither idle on it nor quiet. One nobody builds is
 *  the PM's to see: unsized, it is in the PM's numbers; sized and unplaced, its PM is told why. */
export const openPieces = (issue: Json): number => {
  const summary = object(issue.sub_issues_summary), total = Number(summary.total), completed = Number(summary.completed)
  return Number.isSafeInteger(total) && Number.isSafeInteger(completed) ? Math.max(0, total - completed) : 0
}

/** The tasks builders of the team took, each with its last touch: a comment or label on the issue, or a change to a pull
 *  request for it (tasksOf). Not one that waits on its pieces (openPieces). */
export function takenTasks(issues: Json[], pulls: Json[], builders: CrewBuilder[]): Taken[] {
  const byLabel = new Map(builders.map(b => [b.label, b]))
  const touched = new Map<number, number>()
  for (const pull of pulls) {
    const at = Date.parse(String(pull.updated_at ?? ''))
    if (!Number.isFinite(at)) continue
    for (const number of tasksOf(pull)) touched.set(number, Math.max(touched.get(number) ?? 0, at))
  }
  const out: Taken[] = []
  for (const issue of issues) {
    if (issue.pull_request || !Number.isSafeInteger(issue.number)) continue
    const labels = labelsOf(issue)
    const builder = labels.map(label => byLabel.get(label)).find(Boolean)
    if (!builder || !labels.includes('status:taken') || openPieces(issue)) continue
    const own = Date.parse(String(issue.updated_at ?? ''))
    const number = Number(issue.number)
    out.push({ number, label: builder.label, name: builder.name, touched: Math.max(Number.isFinite(own) ? own : 0, touched.get(number) ?? 0) })
  }
  return out
}

/** Finished tasks of a size needed before their time replaces the size's guess, and the bounds kept on it. */
export const LEARN_MIN = 3, LEARNED_FLOOR = 10, LEARNED_CEILING = 24 * 60

/** When a closed task's work began: its builder's "taken by" comment (githubClaim.ts), else Harness's word giving it. */
export function startedAt(comments: Json[]): number | null {
  for (const comment of comments) {
    const first = String(comment.body ?? '').split('\n').find(line => line.trim()) ?? ''
    if (/\btaken by\b/i.test(first) || /^Harness, \d\d:\d\d: for \*\*/.test(first)) {
      const at = Date.parse(String(comment.created_at ?? ''))
      if (Number.isFinite(at)) return at
    }
  }
  return null
}

/** The minutes each size took in this project, from its finished tasks: the median of [took] by size, once a size has
 *  [LEARN_MIN] of them, kept between [LEARNED_FLOOR] and [LEARNED_CEILING]. A median, as one task left open over a weekend
 *  must not move the rest. */
export function learnedMinutes(took: Array<{ size: string; minutes: number }>): Partial<Record<'s' | 'm' | 'l', number>> {
  const out: Partial<Record<'s' | 'm' | 'l', number>> = {}
  for (const size of ['s', 'm', 'l'] as const) {
    const all = took.filter(t => t.size === size && t.minutes > 0).map(t => t.minutes).sort((a, b) => a - b)
    if (all.length < LEARN_MIN) continue
    const middle = all.length % 2 ? all[(all.length - 1) / 2]! : (all[all.length / 2 - 1]! + all[all.length / 2]!) / 2
    out[size] = Math.round(Math.min(LEARNED_CEILING, Math.max(LEARNED_FLOOR, middle)))
  }
  return out
}

/** One task to give: its builder, and the minute the plan starts it. */
export interface Pick { task: string; builder: string; start: number }

/** What each builder starts next among the free tasks, in the plan's order, while its list is under [deep]. */
export function nextPicks(plan: Plan, read: Read, deep = DEEP): Pick[] {
  const picks: Pick[] = []
  const placements = [...plan.placements].sort((a, b) => a.start - b.start || a.task.localeCompare(b.task))
  const count = new Map(read.open)
  for (const placement of placements) {
    if (!read.free.has(placement.task)) continue
    const has = count.get(placement.builder) ?? 0
    if (has >= deep) continue
    count.set(placement.builder, has + 1)
    picks.push({ task: placement.task, builder: placement.builder, start: placement.start })
  }
  return picks
}

/** Why a builder got a task, in a few words: when it starts it, and what it has done in its part. */
export function reasonOf(pick: Pick, read: Read): string {
  const task = read.problem.tasks.find(t => t.id === pick.task)
  const when = pick.start <= 0 ? 'it can start now' : `it can start in ${pick.start < 90 ? `${pick.start} min` : `${Math.round(pick.start / 60)} h`}`
  const part = task?.part
  const count = part ? read.done.get(pick.builder)?.get(part) ?? 0 : 0
  const focus = part && read.builders.get(pick.builder)?.worksOn?.includes(part)
  return [when, focus ? `it works on ${part}` : '', count ? `it finished ${count} part:${part} ${count === 1 ? 'task' : 'tasks'}` : '']
    .filter(Boolean).join(', ').replace(/, ([^,]*)$/, ', and $1')
}

/**
 * Who reads a pull request next (Swarm v4: "a review is never read by its build's model family", design 2026-11-09): a
 * builder of the team that is not its author and not asked already, of another model family than its author's when one
 * is free to, then the one holding the fewest tasks. Null when nobody can.
 */
export function readerFor(read: Read, author: string | null, skip: ReadonlySet<string>): CrewBuilder | null {
  const builders = [...read.builders.values()]
  const own = builders.find(b => author !== null && b.label === labelOf(author))
  const family = (b: CrewBuilder) => b.engine === 'codex' ? 'openai' : 'anthropic'
  const candidates = builders.filter(b => b !== own && !skip.has(b.id) && !skip.has(readerKey(b.name)))
  candidates.sort((a, b) => Number(own && family(a) === family(own)) - Number(own && family(b) === family(own))
    || (read.open.get(a.id) ?? 0) - (read.open.get(b.id) ?? 0) || a.name.localeCompare(b.name))
  return candidates[0] ?? null
}

/** Harness's ask to read a pull request (githubAssign.ts ask): "Harness, 14:20, to **Juno**: please read this pull request, then run
 *  `harness super-tab read ok owner/repo#24 f6edb44 …`": the reader it names, and the head it is asked to read. An ask from before
 *  the verdict was a command named the head after "READ-OK", and is on open pull requests still: that form can go after
 *  2026-12-10. The assigner finds its own asks by it, and GitHub news keeps each agent's as owed (githubMentions.ts). */
export const ASKED = /^Harness, \d\d:\d\d, to \*\*([^*]+)\*\*: [^\n]*?please read[^\n]*?(?:super-tab read ok \S+|READ-OK) ([0-9a-f]{7,40})/
