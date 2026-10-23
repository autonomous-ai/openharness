/** Super Tab routing v1, the pure half (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md), ordered by
 * strength, quota fit and effective cost since phase 1 (docs/plans/2026-10-21-swarm-routing-phase1.md).
 * The system removes what cannot run the task or breaks one of the owner's hard rules, and the first in a fixed order
 * (the owner's soft rules, then the policy order) is the pick (docs/plans/2026-10-22-swarm-rules-routing.md). Jev chose
 * among the candidates until 2026-10-22, when the Lead overrode it about half the time because it did not know the rules. */
import { isAbsolute } from 'node:path'
import { claudeAliasForModel } from '../engines/claude/runtimeProfile.js'

export type Level = 'low' | 'medium' | 'high'
export type Size = 'small' | 'medium' | 'large'
/** `kind` is a word the Lead may give (`ui`, `docs`) for the owner's preferred-engine rules; a review group's is `review`. */
export interface Assessment { difficulty: Level; risk: Level; size: Size; why: string; kind?: string; needs: { tools: string[]; devices: string[]; cwd?: string } }
/** The owner's rules as the backend keeps them (backend/src/superTabs/rules.ts); only the rule and its words are read here. */
export type Rule =
  | { kind: 'forbidModel'; engine?: string; model: string }
  | { kind: 'machines'; machineIds: string[] }
  | { kind: 'minEffort'; engine?: string; effort: string }
  | { kind: 'preferEngine'; taskKind: string | null; engine: string }
  | { kind: 'preferIdle' }
export interface SwarmRule { rule: Rule; text: string }
export interface PolicyModel { engine: 'claude' | 'codex'; model: string; effort: string; quality: number; cost: number; enabled: boolean }
export interface Policy { version: 1; models: PolicyModel[]; floor: Record<Level, number>; quotaReserve: number; notes: string }
/** One usage window, named by the reader (`5-hour`, `weekly`); `leftPercent` is what remains of it. */
export interface QuotaWindow { name: string | null; leftPercent: number; resetsAt: number | null }
/** `leftPercent` and `resetsAt` are the tightest window's; `windows` is every window. `account` is the reading's hashed
 * account key, which models on one subscription share. */
export interface Quota { known: boolean; leftPercent: number | null; resetsAt: number | null; windows?: QuotaWindow[]; account?: string }
/** The task's folder as the Lead's machine sees it. `unknown` means it could not be read, `none` that it is not a repository,
 * `missing` that the Lead's machine has no such folder (a member elsewhere may). */
export interface TaskFolder { cwd: string; kind: 'git' | 'none' | 'missing' | 'unknown'; name: string | null; root: string | null; remote: string | null }
/** What a member's `agents_list` frame says it is working on; every field is null when the frame does not say. */
export interface MemberFrame { title: string | null; project: string | null; cwd: string | null; root: string | null; remote: string | null; branch: string | null; updatedAt: number | null }
/** What a machine offers a new agent. Each field is null when it could not be read. */
export interface MachineLoad { agents: number | null; freeMemoryBytes: number | null; hasFolder: boolean | null }
export interface Probe {
  kind: 'member' | 'new'; agentId?: string; name?: string; machineId: string; machineName: string
  engine: 'claude' | 'codex'; model: string; effort: string; quality: number; cost: number
  quota: Quota; activity: string; known: boolean; refusals: string[]
  /** Members: the frame (null when it could not be read), whether the member is in the task's repository, and its earlier work in this Super Tab. */
  frame?: MemberFrame | null; repo?: 'same' | 'different' | 'unknown'; earlier?: Array<{ group: string; outcome: string }>
  terminalUnverified?: boolean
  /** New agents: what the machine has. */
  load?: MachineLoad
}
export interface Attempt { agent: string; outcome: string; result?: string }
export interface RecentRoute { title: string; via?: string; outcome: string | null }
type Window = '5-hour' | 'weekly'
/** How a candidate's account would carry the task, as the decision log keeps it. */
export interface Fit { status: 'fits' | 'unknown' | 'short'; coverage: number | null; effectiveCost: number; expiring: number; spend: Record<Window, number>; account: string }
/** A pick still at work: it holds part of its account's quota until its run time is over. */
export interface Commitment { account: string; spend: Partial<Record<Window, number>>; size: Size; createdAt: number }
export interface Shown extends Probe { id: string; title: string; label: string; fit: Fit }
/** `short` is set when no candidate is expected to cover the task, to tell the Lead. */
export interface Choice { shown: Shown[]; excluded: Array<{ title: string; reason: string }>; floor: number; belowFloor: boolean; short?: string }
export interface Verdict { pick: Shown; via: 'order' | 'only'; p: null; why: string }

const LEVELS: Level[] = ['low', 'medium', 'high']
/** Run time and spend per window by task size, for a policy row of cost 2 (owner's table, 2026-10-21); not in the policy yet. */
const SIZES: Record<Size, { minutes: number; spend: Record<Window, number> }> = {
  small: { minutes: 20, spend: { '5-hour': 10, weekly: 1 } },
  medium: { minutes: 60, spend: { '5-hour': 30, weekly: 4 } },
  large: { minutes: 180, spend: { '5-hour': 50, weekly: 8 } },
}
const WINDOWS: Window[] = ['5-hour', 'weekly']
const MAX_SHOWN = 12
const ENGINE = { claude: 'Claude', codex: 'Codex' } as const
const cut = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** `default` and `auto` say nothing about the effort, so they never meet a minimum. */
const rank = (effort: string) => EFFORTS.indexOf(effort)
const applies = (rule: { engine?: string }, engine: string) => !rule.engine || rule.engine === engine
const FAMILY = /haiku|sonnet|opus|fable/
/** The backend's `modelMatches`: `haiku` matches every Haiku id, `claude-haiku-4-5` also the `haiku` alias, and nothing
 * matches `default`, which is not known. */
function modelMatches(ruleModel: string, model: string): boolean {
  const rule = ruleModel.toLowerCase(), target = model.toLowerCase()
  return target !== 'default' && (target.includes(rule) || (FAMILY.exec(target)?.[0] === target && FAMILY.exec(rule)?.[0] === target))
}

/** The backend's check (backend/src/superTabs/rules.ts `broken`), so a pick shown here is never refused when it is
 * started, assigned or recorded. */
export function breaks(rules: SwarmRule[], p: { machineId: string; engine: string; model: string; effort: string }): string | null {
  const out = rules.find(({ rule }) => rule.kind === 'forbidModel' ? applies(rule, p.engine) && modelMatches(rule.model, p.model)
    : rule.kind === 'machines' ? !rule.machineIds.includes(p.machineId)
    : rule.kind === 'minEffort' && applies(rule, p.engine) && rank(p.effort) < rank(rule.effort))
  return out ? `Breaks the owner's rule: ${out.text}` : null
}
/** A new agent whose policy row leaves the effort to the engine starts at the owner's minimum instead (Lead, 2026-10-22), so
 * a minimum does not rule out the Codex `default` row. */
function lifted(rules: SwarmRule[], p: Probe): Probe {
  if (p.kind !== 'new' || rank(p.effort) >= 0) return p
  const least = Math.max(-1, ...rules.flatMap(({ rule }) => rule.kind === 'minEffort' && applies(rule, p.engine) ? [rank(rule.effort)] : []))
  return least < 0 ? p : { ...p, effort: EFFORTS[least] }
}
/** The soft rules for this task: the engine preferred for its kind (a rule for the kind before one for every task), and
 * whether idle agents come first. */
interface Soft { engine: string | null; idle: boolean }
function softOf(rules: SwarmRule[], kind: string | undefined): Soft {
  const prefer = rules.flatMap(({ rule }) => rule.kind === 'preferEngine' ? [rule] : [])
  const engine = (prefer.find(r => kind && r.taskKind === kind) ?? prefer.find(r => r.taskKind === null))?.engine ?? null
  return { engine, idle: rules.some(r => r.rule.kind === 'preferIdle') }
}

export function parseAssessment(value: unknown): Assessment | string {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (!LEVELS.includes(v.difficulty as Level)) return 'Set difficulty to low, medium or high.'
  if (!LEVELS.includes(v.risk as Level)) return 'Set risk to low, medium or high.'
  // Leads from before sizes send none; their tasks are taken for medium.
  const size = v.size ?? 'medium'
  if (!Object.hasOwn(SIZES, String(size))) return 'Set size to small, medium or large.'
  const why = typeof v.why === 'string' ? v.why.trim() : ''
  if (!why || why.length > 300) return 'Give why in 1 to 300 characters.'
  const needs = (v.needs && typeof v.needs === 'object' ? v.needs : {}) as Record<string, unknown>
  const list = (x: unknown) => Array.isArray(x) && x.every(i => typeof i === 'string') ? x as string[] : []
  const cwd = needs.cwd
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) return 'needs.cwd must be an absolute path.'
  if (v.kind !== undefined && (typeof v.kind !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(v.kind))) return 'Set kind to one lowercase word, such as ui or docs.'
  return { difficulty: v.difficulty as Level, risk: v.risk as Level, size: size as Size, why, ...(v.kind ? { kind: v.kind as string } : {}),
    needs: { tools: list(needs.tools), devices: list(needs.devices), ...(cwd ? { cwd } : {}) } }
}

export const floorFor = (policy: Policy, a: Assessment): number => Math.min(3, policy.floor[a.difficulty] + (a.risk === 'high' ? 1 : 0))

/** Claude sends ISO strings, Codex epoch seconds; anything above 1e10 is already milliseconds. */
function resetMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e10 ? value : value * 1000
  if (typeof value === 'string') { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null }
  return null
}
export function quotaOf2(q: { known: boolean; windows: Array<{ usedPercent: number; resetsAt: unknown; name?: string }>; account?: string | null }): Quota {
  const account = q.account ? { account: q.account } : {}
  if (!q.known || !q.windows.length) return { known: false, leftPercent: null, resetsAt: null, ...account }
  const tightest = q.windows.reduce((x, y) => y.usedPercent > x.usedPercent ? y : x)
  return { known: true, leftPercent: Math.max(0, 100 - tightest.usedPercent), resetsAt: resetMs(tightest.resetsAt),
    windows: q.windows.map(w => ({ name: w.name ?? null, leftPercent: Math.max(0, 100 - w.usedPercent), resetsAt: resetMs(w.resetsAt) })), ...account }
}

/** Whether a member's checkout is the task's repository: the same remote wherever it lives, else the same root on one
 * machine. Paths on two machines say nothing without a remote. Undefined when the Lead named no folder. */
export function repoMatch(folder: TaskFolder | null, frame: MemberFrame | null, sameMachine: boolean): Probe['repo'] | undefined {
  if (!folder) return undefined
  if (!frame || folder.kind === 'unknown') return 'unknown'
  if (folder.remote && frame.remote) return folder.remote === frame.remote ? 'same' : 'different'
  const theirs = frame.root ?? frame.cwd
  // A frame that names no checkout says nothing. The folder the Lead named is a path on the machine that will run the
  // task, so a member standing in exactly it is in it, wherever the Lead is.
  if (!theirs) return 'unknown'
  if (theirs === folder.cwd || frame.cwd === folder.cwd) return 'same'
  // Other paths on two machines say nothing without a remote.
  if (!sameMachine) return 'unknown'
  return (folder.root ?? folder.cwd) === theirs ? 'same' : 'different'
}

/** A member's model is what its engine reported after work: Claude's full id (`claude-opus-4-7`, `claude-sonnet-4-5[1m]`),
 * Codex's slug (`gpt-5.5`). The policy names Claude families and a Codex `default`, so the id is reduced to its family
 * first, and an id with no row of its own takes the engine's `default` row before the floor. */
export function rateFor(policy: Policy, engine: string, model: string | null, effort: string | null): { quality: number; cost: number } {
  const name = engine === 'claude' && model ? claudeAliasForModel(model.replace(/\[1m\]$/i, '')) ?? model : model ?? 'default'
  const row = policy.models.find(m => m.engine === engine && m.model === name && m.effort === (effort ?? 'default'))
    ?? policy.models.find(m => m.engine === engine && m.model === name)
    ?? policy.models.find(m => m.engine === engine && m.model === 'default')
  return row ? { quality: row.quality, cost: row.cost } : { quality: 1, cost: 1 }
}

const titleOf = (p: Probe) => cut(`${p.kind === 'member' ? p.name ?? 'Member' : 'New agent'} · ${ENGINE[p.engine]} ${p.model} ${p.effort} · ${p.machineName}`, 160)
/** A reset or a last activity is told as how far away it is, which reads the same whenever the log is opened. */
function span(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`
  // Under ten hours, half an hour decides whether a task fits before the reset, so it keeps its minutes (4h30).
  if (ms < 10 * 3_600_000) {
    const tens = Math.round(ms / 600_000), h = Math.floor(tens / 6), m = tens % 6
    return m ? `${h}h${m}0` : `${h}h`
  }
  if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)} days`
}
const resetsIn = (resetsAt: number, now: number) => span(Math.max(0, resetsAt - now))
function quotaText(q: Quota, now: number): string {
  if (!q.known || q.leftPercent === null) return 'quota unknown'
  if (q.windows?.length) {
    return `quota ${q.windows.map(w => `${w.name ?? 'window'} ${Math.round(w.leftPercent)}% left${w.resetsAt === null ? '' : ` (resets in ${resetsIn(w.resetsAt, now)})`}`).join(', ')}`
  }
  if (q.resetsAt === null) return `quota ${Math.round(q.leftPercent)}% left`
  return `quota ${Math.round(q.leftPercent)}% left, resets in ${resetsIn(q.resetsAt, now)}`
}
const bytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`
/** What a member is doing and has done, or one phrase saying it is not known. */
function memberText(p: Probe, now: number): string[] {
  const f = p.frame
  const repo = p.repo ? [p.repo === 'unknown' ? 'repo unknown' : `${p.repo} repo`] : []
  if (!f) return [...repo, 'activity unknown']
  const where = [f.project && cut(f.project, 40), f.branch && `branch ${cut(f.branch, 40)}`].filter(Boolean).join(', ')
  return [...repo, ...(f.title ? [`on "${cut(f.title, 80)}"`] : []), ...(where ? [f.project ? `in ${where}` : where] : []),
    f.updatedAt === null ? 'last active unknown' : `last active ${span(Math.max(0, now - f.updatedAt))} ago`]
}
function machineText(load: MachineLoad): string[] {
  return [...(load.hasFolder === null ? [] : [load.hasFolder ? 'has the task folder' : 'no task folder']),
    load.agents === null ? 'agents running unknown' : `${load.agents} ${load.agents === 1 ? 'agent' : 'agents'} running`,
    load.freeMemoryBytes === null ? 'free memory unknown' : `${bytes(load.freeMemoryBytes)} memory free`]
}
/** The most telling parts come first and the least last, because the log's limit cuts the end. */
const labelOf = (p: Probe & Sized, now: number) => cut([
  p.kind === 'member' ? `Member ${cut(p.name ?? '', 40)}`.trim() : 'New agent', `${ENGINE[p.engine]} ${p.model} ${p.effort}`, `quality ${p.quality}, cost ${p.cost}`,
  p.text, cut(p.machineName, 40), p.activity, ...(p.kind === 'member' ? memberText(p, now) : p.load ? machineText(p.load) : []),
  ...(p.earlier?.length ? [`earlier here: ${p.earlier.slice(0, 3).map(e => `${cut(e.group, 40)} ${e.outcome}`).join('; ')}`] : []), quotaText(p.quota, now),
].join(' · '), 640)

interface Measured { name: Window; usable: number; needed: number; resetsIn: number | null }
/** A probe's fit, its tightest window (the one that runs out first) and the sentence the log keeps. */
interface Sized { fit: Fit; tight: Measured | null; text: string }
const pct = (n: number) => `${Math.round(n)}%`
const round = (n: number) => Math.round(n * 100) / 100

/** How the probe's account would carry a task of this size (phase 1 §2–3). */
function sizeUp(p: Probe, policy: Policy, a: Assessment, now: number, open: Commitment[]): Sized {
  const { minutes, spend: base } = SIZES[a.size], runMs = minutes * 60_000
  const account = p.quota.account ?? `${p.machineId}:${p.engine}`
  const spend = { '5-hour': base['5-hour'] * p.cost / 2, weekly: base.weekly * p.cost / 2 }
  // Picks still at work hold what they were expected to spend, less the part of their run time already over.
  const committed = (name: Window) => open.filter(c => c.account === account)
    .reduce((sum, c) => sum + (c.spend[name] ?? 0) * Math.max(0, 1 - (now - c.createdAt) / (SIZES[c.size].minutes * 60_000)), 0)
  const windows = WINDOWS.flatMap((name): Measured[] => {
    const w = p.quota.windows?.find(w => w.name === name)
    if (!w) return []
    const resetsIn = w.resetsAt === null ? null : Math.max(60_000, w.resetsAt - now)
    // A window that refills mid-task carries only the part of the task before its reset.
    return [{ name, usable: w.leftPercent - policy.quotaReserve - committed(name), resetsIn,
      needed: resetsIn !== null && resetsIn < runMs ? spend[name] * resetsIn / runMs : spend[name] }]
  })
  const status = windows.some(w => w.usable < w.needed) ? 'short' : windows.length === WINDOWS.length ? 'fits' : 'unknown'
  const tight = windows.length ? windows.reduce((x, y) => y.usable / y.needed < x.usable / x.needed ? y : x) : null
  const five = windows.find(w => w.name === '5-hour'), week = windows.find(w => w.name === 'weekly')
  // A 5-hour window that resets before the task ends, or soon after, loses what is left of it: spending it costs nothing.
  const expiring = five && five.resetsIn !== null && five.resetsIn <= runMs + 3_600_000 ? Math.min(1, Math.max(0, five.usable) / five.needed) : 0
  let effectiveCost = p.cost * (1 - expiring)
  // The weekly window has to last until it resets, so work that is not hard pays for taking more than a day's share of it.
  const dayBudget = week ? week.usable / Math.max(1, (week.resetsIn ?? 0) / 86_400_000) : 0
  if (week && a.difficulty !== 'high' && dayBudget > 0 && week.needed > dayBudget) effectiveCost += p.cost * week.needed / dayBudget
  const text = `${status}: ${five ? `needs about ${pct(five.needed)} of the 5-hour window (${pct(five.usable)} left${five.resetsIn === null ? '' : `, resets in ${span(five.resetsIn)}`}${expiring ? ', otherwise unused' : ''})` : '5-hour window unknown'}`
    + `; weekly ${week ? `${pct(week.needed)} of ${pct(week.usable)}` : 'unknown'}`
  return { fit: { status, coverage: tight && round(tight.usable / tight.needed), effectiveCost: round(effectiveCost), expiring: round(expiring), spend, account }, tight, text }
}
const WAY = ['right away', 'about a quarter of the way in', 'about halfway', 'about three quarters of the way in', 'near the end']
const runsOut = (w: Measured) => `The ${w.name} window is expected to run out ${WAY[Math.round(Math.max(0, w.usable / w.needed) * 4)]}${w.resetsIn === null ? '' : `; resets in ${span(w.resetsIn)}`}.`
const UNREAD = 'Its quota could not be read in full, and another candidate\'s quota fits this task.'

/** The fixed order: the owner's preferred engine, an idle member before a new agent and a less busy machine first when the
 * owner prefers idle agents; then the policy order: cheaper in effect, stronger, more room on the tightest window, an idle
 * member in the task's repository before a new agent, then by title. */
function compare(x: Probe & Sized, y: Probe & Sized, soft: Soft): number {
  const placed = (p: Probe) => p.kind === 'member' && (p.repo ?? 'same') === 'same' ? 0 : 1
  const preferred = (p: Probe) => soft.engine && p.engine !== soft.engine ? 1 : 0
  const fresh = (p: Probe) => soft.idle && p.kind === 'new' ? 1 : 0
  const busy = (p: Probe) => soft.idle && p.kind === 'new' ? p.load?.agents ?? 1000 : 0
  return preferred(x) - preferred(y) || fresh(x) - fresh(y) || busy(x) - busy(y)
    || x.fit.effectiveCost - y.fit.effectiveCost
    || y.quality - x.quality
    || (y.tight?.usable ?? -Infinity) - (x.tight?.usable ?? -Infinity)
    || placed(x) - placed(y)
    || titleOf(x).localeCompare(titleOf(y))
}

export function choose(probes: Probe[], policy: Policy, a: Assessment, now: number = Date.now(), open: Commitment[] = [], rules: SwarmRule[] = []): Choice | { error: 'NO_CANDIDATE'; excluded: Array<{ title: string; reason: string }> } {
  // A lifted row can equal another row on the same machine (Codex `default` lifted to high beside Codex high); one is kept.
  const raised = probes.map(p => lifted(rules, p)), key = (p: Probe) => `${p.kind}\0${p.machineId}\0${p.engine}\0${p.model}\0${p.effort}`
  const ruled = raised.filter((p, i) => p === probes[i] || !raised.some((q, j) => j !== i && key(q) === key(p) && (q === probes[j] || j < i)))
    .map(p => { const why = breaks(rules, p); return why ? { ...p, refusals: [...p.refusals, why] } : p })
  const excluded = ruled.filter(p => p.refusals.length).map(p => ({ title: titleOf(p), reason: p.refusals.join(' ') }))
  const viable = ruled.filter(p => !p.refusals.length)
  if (!viable.length) return { error: 'NO_CANDIDATE', excluded }
  const floor = floorFor(policy, a)
  const meeting = viable.filter(p => p.quality >= floor)
  const byFloor = meeting.length ? meeting : viable
  // Strength beats fit (owner, 2026-10-21): a hard task never goes to a weaker model because the strong ones are short of quota.
  const top = Math.max(...byFloor.map(p => p.quality))
  const sized = (a.difficulty === 'high' ? byFloor.filter(p => p.quality === top) : byFloor).map(p => ({ ...p, ...sizeUp(p, policy, a, now, open) }))
  // Only the first group that has anyone is shown: those that fit, then those whose quota is not fully known, then the short.
  const status = (['fits', 'unknown', 'short'] as const).find(s => sized.some(p => p.fit.status === s))!
  excluded.push(...sized.filter(p => p.fit.status !== status).map(p => ({ title: titleOf(p), reason: p.fit.status === 'unknown' ? UNREAD : runsOut(p.tight!) })))
  // When every candidate is short, the one expected to get furthest goes first.
  const soft = softOf(rules, a.kind)
  const set = sized.filter(p => p.fit.status === status).sort((x, y) => status === 'short' ? y.fit.coverage! - x.fit.coverage! || compare(x, y, soft) : compare(x, y, soft))
  const shown = set.slice(0, MAX_SHOWN).map(({ tight, text, ...p }, i) => ({ ...p, id: `c${i}`, title: titleOf(p), label: labelOf({ ...p, tight, text }, now) }))
  const first = set[0].tight!
  return { shown, excluded, floor, belowFloor: !meeting.length, ...(status === 'short'
    ? { short: `No candidate is expected to cover this task; its ${first.name} quota is expected to run out partway${first.resetsIn === null ? '' : ` and resets in ${span(first.resetsIn)}`}.` } : {}) }
}

export function decide(choice: Choice): Verdict {
  const pick = choice.shown[0]
  return choice.shown.length === 1 ? { pick, via: 'only', p: null, why: 'Only candidate that can run this task.' }
    : { pick, via: 'order', p: null, why: "First by the owner's rules and the policy order." }
}

/** `v1` leaves out size and fit, for a backend from before phase 1, whose strict schema refuses them. */
export function recordOf(choice: Choice, verdict: Verdict, a: Assessment, policy: Policy, v1 = false): Record<string, unknown> {
  return {
    assessment: { difficulty: a.difficulty, risk: a.risk, why: a.why, ...(v1 ? {} : { size: a.size }) },
    candidates: choice.shown.map(s => ({ id: s.id, kind: s.kind, ...(s.agentId ? { agentId: s.agentId } : {}), machineId: s.machineId,
      engine: s.engine, model: s.model, effort: s.effort, quality: s.quality, cost: s.cost, title: s.title, label: s.label, ...(v1 ? {} : { fit: s.fit }) })),
    excluded: choice.excluded.slice(0, 200).map(e => ({ title: e.title, reason: cut(e.reason, 500) })),
    floor: choice.floor, notes: policy.notes.length > 0,
    pick: verdict.pick.id, via: verdict.via, p: verdict.p, belowFloor: choice.belowFloor, why: cut(verdict.why, 300),
  }
}
