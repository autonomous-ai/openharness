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
/** `local`: a person asked for a local model by hand, so only models served on the Swarm's grid are considered and the
 * quality floor does not apply (docs/plans/2026-10-23-swarm-local-models.md). */
/** `model`: a model a person named, in their words ("deepseek 4.1 flash"); only candidates running it are considered,
 * whatever their strength (owner, 2026-10-23: a Builder on a named API model was ranked below Opus and never offered). */
export interface Assessment { difficulty: Level; risk: Level; size: Size; why: string; kind?: string; local?: boolean; model?: string; needs: { tools: string[]; devices: string[]; cwd?: string } }
/** The owner's rules as the backend keeps them (backend/src/superTabs/rules.ts); only the rule and its words are read here. */
export type Rule =
  | { kind: 'forbidModel'; engine?: string; model: string }
  | { kind: 'machines'; machineIds: string[] }
  | { kind: 'minEffort'; engine?: string; effort: string }
  | { kind: 'preferEngine'; taskKind: string | null; engine: string }
  | { kind: 'preferIdle' }
  | { kind: 'noGridFirst' }
export interface SwarmRule { rule: Rule; text: string }
export interface PolicyModel { engine: 'claude' | 'codex'; model: string; effort: string; quality: number; cost: number; enabled: boolean }
export interface Policy { version: 1; models: PolicyModel[]; floor: Record<Level, number>; quotaReserve: number; notes: string;
  /** How strong a model served on the Swarm's grid counts ([gridQuality]); absent from a backend before it, which serves
   *  none, and `models` from one before per-model rows. */
  localModels?: { quality: number; enabled: boolean; models?: Array<{ model: string; quality: number }> } }
/** One usage window, named by the reader (`5-hour`, `weekly`); `leftPercent` is what remains of it. */
export interface QuotaWindow { name: string | null; leftPercent: number; resetsAt: number | null }
/** `leftPercent` and `resetsAt` are the tightest window's; `windows` is every window. `account` is the reading's hashed
 * account key, which models on one subscription share. `metered` is an engine on an API key or gateway: known, with no
 * usage window to run out. */
export interface Quota { known: boolean; leftPercent: number | null; resetsAt: number | null; windows?: QuotaWindow[]; account?: string; metered?: true }
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
  /** A new agent on a model served on the Swarm's grid: free, reached through the grid relay, `model`/`effort` `default`.
   *  [gridKind]: a member's engine (`local`), a member's API (`api`), or a model shared with this machine's owner. */
  gridModel?: string; gridName?: string; gridLabel?: string; gridKind?: 'local' | 'api' | 'shared'
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
export interface Choice { shown: Shown[]; excluded: Array<{ title: string; reason: string }>; floor: number; belowFloor: boolean; short?: string
  /** Every candidate left runs on an account the route was asked to avoid (`choose` `avoid`). */
  avoided?: string }
export interface Verdict { pick: Shown; via: 'order' | 'only'; p: null; why: string }

const LEVELS: Level[] = ['low', 'medium', 'high']
/** Run time and spend per window by task size, for a policy row of cost 2 (owner's table, 2026-10-21); not in the policy yet. */
export const SIZES: Record<Size, { minutes: number; spend: Record<Window, number> }> = {
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
  // The same probe when nothing is lifted: `choose` tells a lifted row from its original by identity.
  const effort = p.kind === 'new' ? liftEffort(rules, p.engine, p.effort) : p.effort
  return effort === p.effort ? p : { ...p, effort }
}
/** The effort a new agent on this row starts at: the row's own, or the owner's minimum when the row leaves it to the engine. */
export function liftEffort(rules: SwarmRule[], engine: string, effort: string): string {
  if (rank(effort) >= 0) return effort
  const least = Math.max(-1, ...rules.flatMap(({ rule }) => rule.kind === 'minEffort' && applies(rule, engine) ? [rank(rule.effort)] : []))
  return least < 0 ? effort : EFFORTS[least]
}
/** The soft rules for this task: the engine preferred for its kind (a rule for the kind before one for every task),
 * whether idle agents come first, and whether a model on the Swarm's grid comes first. */
interface Soft { engine: string | null; idle: boolean; grid: boolean }
/** Kinds of build a quality-2 grid model takes first at medium difficulty: docs, copy, tests, fixtures, a small specified fix,
 *  a mechanical refactor. */
export const CHEAP_KINDS = ['docs', 'copy', 'tests', 'fixtures', 'fix', 'refactor']
function softOf(rules: SwarmRule[], a: Assessment): Soft {
  const prefer = rules.flatMap(({ rule }) => rule.kind === 'preferEngine' ? [rule] : [])
  const engine = (prefer.find(r => a.kind && r.taskKind === a.kind) ?? prefer.find(r => r.taskKind === null))?.engine ?? null
  // Simple work goes to the free models first (roadmap, Dec: about 30% of work on cheaper models without lower quality).
  // A grid model counts as cost 1 like Haiku, so an expiring 5-hour window or an idle member ranked above it and it was
  // rarely picked. Reviews keep the other model family, and the owner can opt out.
  // Since 2026-10-29 (Ken) also medium work of a kind a strong grid model does well, which steps up when it fails (backend
  // superTabs/stepUp.ts); the floor still keeps a small model off it.
  const simple = a.difficulty === 'low' || (a.difficulty === 'medium' && CHEAP_KINDS.includes(a.kind ?? ''))
  const grid = simple && a.risk === 'low' && a.kind !== 'review' && !rules.some(r => r.rule.kind === 'noGridFirst')
  return { engine, idle: rules.some(r => r.rule.kind === 'preferIdle'), grid }
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
  if (v.local !== undefined && typeof v.local !== 'boolean') return 'Set local to true only when a person asked for a local model.'
  if (v.model !== undefined && (typeof v.model !== 'string' || !words(v.model).length || v.model.length > 200)) return 'Set model to the model a person named, in their words.'
  return { difficulty: v.difficulty as Level, risk: v.risk as Level, size: size as Size, why, ...(v.kind ? { kind: v.kind as string } : {}),
    ...(v.local === true ? { local: true } : {}), ...(typeof v.model === 'string' ? { model: v.model.trim() } : {}),
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
  if (!q.known) return { known: false, leftPercent: null, resetsAt: null, ...account }
  if (!q.windows.length) return { known: true, leftPercent: null, resetsAt: null, metered: true, ...account }
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

/** A repository's name for comparing two addresses of it: host and path, lowercase, without credentials, port or `.git`,
 * the same over HTTPS and SSH. Null for a folder on disk or an address it cannot read. A machine reports its checkouts'
 * origins this way (machines.ts readCheckouts), so no credential in an origin leaves it. */
export function repositoryKey(url: string): string | null {
  const text = url.trim()
  // Only the host and the path are kept: userinfo, a port, a query and a fragment can all carry what is not the repository's
  // name, a token among them (review of #1743).
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)([^?#]+)/.exec(text)
  let host: string | undefined, path: string | undefined
  if (scp) [, host, path] = scp
  else {
    try {
      const parsed = new URL(text)
      if (['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) [host, path] = [parsed.hostname, decodeURIComponent(parsed.pathname)]
    } catch { /* Not an address: a folder on disk, or nothing readable. */ }
  }
  const clean = path?.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  return host && clean ? `${host}/${clean}`.toLowerCase() : null
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

/** What a reviewed Builder ran: its engine, and the grid model its engine drove. */
export interface Reviewed { engine: string; gridModel?: string }
/** A model family: a grid model's own, else its engine's. */
const familyOf = (t: Reviewed) => t.gridModel ? `grid:${t.gridModel}` : t.engine
/** Why [p] may not review (Ken, 2026-10-29: a small model never reviews again): a model served on the Swarm's grid, one rated
 *  below 2, or the reviewed Builder's own model family while a strong Reviewer of another family can run here ([otherFamily]).
 *  With none, the Builder's own engine at its top tier (Lead, 2026-10-29). The server judges the same (backend
 *  superTabs/rules.ts reviewRefusal). */
export function reviewRefusals(p: Probe, builder: Reviewed | null, otherFamily: boolean): string[] {
  if (p.gridModel) return ['A review never runs on a model served on the Swarm\'s grid.']
  if (p.quality < 2) return [`A review needs a model of quality 2 or more, and ${ENGINE[p.engine]} ${p.model} is ${p.quality}.`]
  if (!builder || familyOf(builder) !== familyOf(p)) return []
  if (otherFamily) return [`A review runs on another engine than the reviewed Builder's, ${ENGINE[p.engine]}.`]
  return p.quality < 3 ? [`A review on the reviewed Builder's engine, ${ENGINE[p.engine]}, needs its top tier (quality 3): no Reviewer on another engine can run in this Swarm.`] : []
}
/** Whether a strong Reviewer of another family than [builder]'s can run: a candidate off the grid, rated 2 or more, of
 *  another family, wherever it is and whatever keeps it out now. */
export const otherFamilyReviews = (probes: Probe[], builder: Reviewed | null) =>
  !!builder && probes.some(p => !p.gridModel && p.quality >= 2 && familyOf(p) !== familyOf(builder))

/** A task that stepped up from a cheaper model takes no grid model and nothing below the step's floor; the server refuses
 *  the same (backend superTabs/stepUp.ts stepUpRefusal). */
export function stepUpRefusals(p: Probe, step: { floor: number } | null): string[] {
  return step && (p.gridModel || p.quality < step.floor)
    ? [`This task stepped up from a cheaper model: it runs on no model on the grid and nothing below quality ${step.floor}.`] : []
}

export const KIND_WORD = { local: 'local', api: 'API', shared: 'shared' } as const
const runs = (p: Probe) => p.gridModel ? `${ENGINE[p.engine]} on ${p.gridLabel ?? p.gridModel} (${KIND_WORD[p.gridKind ?? 'local']})` : `${ENGINE[p.engine]} ${p.model} ${p.effort}`
/** A name's words for matching: lowercase letters and digits, "4.1" read as "41". */
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9.]+/).map(w => w.replace(/\./g, '')).filter(Boolean)
/** How strong a grid model counts: the first of the policy's named rows whose every word is in its id or label (Kimi K3
 *  and DeepSeek v4.1 at 2 by default, backend superTabs/routingPolicy.ts gridQuality), else the policy's local quality. */
export function gridQuality(policy: Policy, model: string, label = ''): number {
  const name = words(`${model} ${label}`).join('')
  return policy.localModels?.models?.find(row => words(row.model).every(w => name.includes(w)))?.quality ?? policy.localModels?.quality ?? 1
}
/** Whether [p] runs the model a person named: every word of theirs is in its model's name. */
function runsNamed(p: Probe, named: string): boolean {
  const name = words([p.gridModel ?? p.model, p.gridLabel ?? '', ENGINE[p.engine]].join(' ')).join('')
  return words(named).every(w => name.includes(w))
}
const NAMED_NONE = (named: string) => `No candidate runs "${named}". Share it with the Swarm (Your models), or check its name.`

/** How many Builders may run on one API model a member shares: the share answers four requests at once
 * (cli/src/lib/swarmApiShares.ts CONCURRENCY), unlike a local engine, which answers one conversation at a time. */
export const API_BUILDERS = 4

/** A model served for the Swarm that takes no more Builders, and who is on it, or that Builders are never offered and why
 *  ([refused]: too small or too slow to drive a coding agent) (routeCommand.ts heldLocalModels). */
export interface HeldModel { model: string; label: string; kind: 'local' | 'api' | 'shared'; holders: string[]; refused?: string }

/** Why a held model is not offered, and what frees it: a model in use reads as unshared otherwise (owner, 2026-10-24). */
function heldReason(m: HeldModel): string {
  if (m.refused) return `"${m.label}" is shared with the Swarm, but Builders are not offered it: ${m.refused} Ask a member to run a larger model, or share an API (Your models).`
  const who = m.holders.length === 1 ? `Builder ${m.holders[0]} is on it` : `Builders ${m.holders.slice(0, -1).join(', ')} and ${m.holders.at(-1)} are on it`
  const limit = m.kind === 'api' ? `an API model takes ${API_BUILDERS} Builders at a time` : 'a local model serves one Builder at a time'
  return `"${m.label}" is shared with the Swarm, but ${who}: ${limit}. Assign the work to ${m.holders.length === 1 ? 'that Builder once it is free, or stop it' : 'one of them once it is free, or stop one'} to free the model.`
}
const titleOf = (p: Probe) => cut(`${p.kind === 'member' ? p.name ?? 'Member' : 'New agent'} · ${runs(p)} · ${p.machineName}`, 160)
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
  if (q.metered) return 'quota metered'
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
  p.kind === 'member' ? `Member ${cut(p.name ?? '', 40)}`.trim() : 'New agent', runs(p), `quality ${p.quality}, cost ${p.cost}`,
  p.text, cut(p.machineName, 40), p.activity, ...(p.kind === 'member' ? memberText(p, now) : p.load ? machineText(p.load) : []),
  ...(p.earlier?.length ? [`earlier here: ${p.earlier.slice(0, 3).map(e => `${cut(e.group, 40)} ${e.outcome}`).join('; ')}`] : []), quotaText(p.quota, now),
].join(' · '), 640)

interface Measured { name: Window; usable: number; needed: number; resetsIn: number | null }
/** A probe's fit, its tightest window (the one that runs out first) and the sentence the log keeps. */
interface Sized { fit: Fit; tight: Measured | null; text: string }
const pct = (n: number) => `${Math.round(n)}%`
const round = (n: number) => Math.round(n * 100) / 100

/** The account a probe's work spends: a local model's node, its quota reading's account, else its machine's engine. */
export function accountOf(p: Probe): string {
  return p.gridModel ? `local:${p.gridName ?? ''}:${p.gridModel}` : p.quota.account ?? `${p.machineId}:${p.engine}`
}

const AVOIDED = 'Its account lost this task before (a model that kept failing, a limit or a stall), and another account is free.'
const AVOIDED_ONLY = 'Every candidate runs on the account that lost this task before; check it is answering before you assign.'

/** How the probe's account would carry a task of this size (phase 1 §2–3). */
function sizeUp(p: Probe, policy: Policy, a: Assessment, now: number, open: Commitment[]): Sized {
  // A local model spends no subscription: it always fits, at its policy cost, and its node is its account.
  if (p.gridModel) {
    return { fit: { status: 'fits', coverage: null, effectiveCost: p.cost, expiring: 0, spend: { '5-hour': 0, weekly: 0 },
      account: accountOf(p) }, tight: null, text: 'fits: a local model on the Swarm\'s grid uses no subscription' }
  }
  const { minutes, spend: base } = SIZES[a.size], runMs = minutes * 60_000
  const account = accountOf(p)
  const spend = { '5-hour': base['5-hour'] * p.cost / 2, weekly: base.weekly * p.cost / 2 }
  if (p.quota.metered) return { fit: { status: 'fits', coverage: null, effectiveCost: p.cost, expiring: 0, spend, account }, tight: null, text: 'fits: metered, no usage window to run out' }
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
  // Every account has a weekly window; a Codex account may have no 5-hour one at all, reporting its weekly alone (2026-10-24),
  // and that reading is complete.
  const complete = windows.length === WINDOWS.length || (p.engine === 'codex' && windows.length === 1 && windows[0]!.name === 'weekly')
  const status = windows.some(w => w.usable < w.needed) ? 'short' : complete ? 'fits' : 'unknown'
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
export const LOCAL_NONE = 'No local model is being served on this Swarm\'s grid. Ask a member to run one or share an API (Your models, in the Swarm\'s sidebar).'

/** The fixed order: the owner's preferred engine, a model on the Swarm's grid for simple work, an idle member before a new
 * agent and a less busy machine first when the owner prefers idle agents; then the policy order: cheaper in effect,
 * stronger, a model that runs on a machine before one reached through a shared API or another grid, more room on the
 * tightest window, an idle member in the task's repository before a new agent, then by title. */
function compare(x: Probe & Sized, y: Probe & Sized, soft: Soft): number {
  const placed = (p: Probe) => p.kind === 'member' && (p.repo ?? 'same') === 'same' ? 0 : 1
  const preferred = (p: Probe) => soft.engine && p.engine !== soft.engine ? 1 : 0
  const subscription = (p: Probe) => soft.grid && !p.gridModel ? 1 : 0
  const fresh = (p: Probe) => soft.idle && p.kind === 'new' ? 1 : 0
  const busy = (p: Probe) => soft.idle && p.kind === 'new' ? p.load?.agents ?? 1000 : 0
  // On-machine first (owner, 2026-10-24): an API spends a member's key and credits, and a model shared on another grid is
  // someone else's machine; at equal cost and strength the Swarm's own engine goes first.
  const remote = (p: Probe) => p.gridModel && (p.gridKind === 'api' || p.gridKind === 'shared') ? 1 : 0
  return preferred(x) - preferred(y) || subscription(x) - subscription(y) || fresh(x) - fresh(y) || busy(x) - busy(y)
    || x.fit.effectiveCost - y.fit.effectiveCost
    || y.quality - x.quality
    || remote(x) - remote(y)
    || (y.tight?.usable ?? -Infinity) - (x.tight?.usable ?? -Infinity)
    || placed(x) - placed(y)
    || titleOf(x).localeCompare(titleOf(y))
}

/** The rows shown: each machine's best row first (the best-ranked machines, if there are more than the limit), then the rest by rank,
 * all in rank order, so the Lead can always choose another machine. */
function withEveryMachine<T extends { machineId: string }>(ranked: T[]): T[] {
  const firsts = new Set<T>(), seen = new Set<string>()
  for (const p of ranked) if (!seen.has(p.machineId)) { seen.add(p.machineId); firsts.add(p) }
  const keep = new Set([...firsts].slice(0, MAX_SHOWN))
  for (const p of ranked) if (keep.size < MAX_SHOWN) keep.add(p)
  return ranked.filter(p => keep.has(p))
}

/** `avoid`: accounts of agents that lost this task (a review's Reviewer whose model kept failing): any other account goes first. */
export function choose(probes: Probe[], policy: Policy, a: Assessment, now: number = Date.now(), open: Commitment[] = [], rules: SwarmRule[] = [], held: HeldModel[] = [],
  avoid: string[] = []): Choice | { error: 'NO_CANDIDATE'; excluded: Array<{ title: string; reason: string }> } {
  // A lifted row can equal another row on the same machine (Codex `default` lifted to high beside Codex high); one is kept.
  // A person asking for a local model considers local models alone, whatever their strength.
  if (a.local) probes = probes.filter(p => p.gridModel)
  // A person naming a model considers that model alone.
  const named = a.model
  if (named) probes = probes.filter(p => runsNamed(p, named))
  const raised = probes.map(p => lifted(rules, p)), key = (p: Probe) => `${p.kind}\0${p.machineId}\0${p.engine}\0${p.model}\0${p.effort}\0${p.gridModel ?? ''}`
  const ruled = raised.filter((p, i) => p === probes[i] || !raised.some((q, j) => j !== i && key(q) === key(p) && (q === probes[j] || j < i)))
    .map(p => { const why = breaks(rules, p); return why ? { ...p, refusals: [...p.refusals, why] } : p })
  const excluded = ruled.filter(p => p.refusals.length).map(p => ({ title: titleOf(p), reason: p.refusals.join(' ') }))
  const viable = ruled.filter(p => !p.refusals.length)
  // Nothing offered: a model that is served but taken says who has it, rather than reading as unshared.
  const heldNamed = named ? held.filter(m => words(named).every(w => words(`${m.model} ${m.label}`).join('').includes(w))) : []
  if (named && !probes.length) {
    if (heldNamed.length) excluded.push(...heldNamed.map(m => ({ title: 'Named model', reason: heldReason(m) })))
    else excluded.push({ title: 'Named model', reason: NAMED_NONE(named) })
  } else if (a.local && !probes.length) {
    if (held.length) excluded.push(...held.map(m => ({ title: 'Local models', reason: heldReason(m) })))
    else excluded.push({ title: 'Local models', reason: LOCAL_NONE })
  }
  if (!viable.length) return { error: 'NO_CANDIDATE', excluded }
  const floor = floorFor(policy, a)
  const meeting = a.local || named ? viable : viable.filter(p => p.quality >= floor)
  const byFloor = meeting.length ? meeting : viable
  // Strength beats fit (owner, 2026-10-21): a hard task never goes to a weaker model because the strong ones are short of quota.
  const top = Math.max(...byFloor.map(p => p.quality))
  const strongest = (a.difficulty === 'high' ? byFloor.filter(p => p.quality === top) : byFloor).map(p => ({ ...p, ...sizeUp(p, policy, a, now, open) }))
  // An account whose model kept failing this task waits while any other account is offered.
  const fresh = strongest.filter(p => !avoid.includes(p.fit.account))
  const sized = fresh.length ? fresh : strongest
  if (fresh.length) excluded.push(...strongest.filter(p => !fresh.includes(p)).map(p => ({ title: titleOf(p), reason: AVOIDED })))
  // Only the first group that has anyone is shown: those that fit, then those whose quota is not fully known, then the short.
  const status = (['fits', 'unknown', 'short'] as const).find(s => sized.some(p => p.fit.status === s))!
  excluded.push(...sized.filter(p => p.fit.status !== status).map(p => ({ title: titleOf(p), reason: p.fit.status === 'unknown' ? UNREAD : runsOut(p.tight!) })))
  // When every candidate is short, the one expected to get furthest goes first.
  const soft = softOf(rules, a)
  const set = sized.filter(p => p.fit.status === status).sort((x, y) => status === 'short' ? y.fit.coverage! - x.fit.coverage! || compare(x, y, soft) : compare(x, y, soft))
  const shown = withEveryMachine(set).map(({ tight, text, ...p }, i) => ({ ...p, id: `c${i}`, title: titleOf(p), label: labelOf({ ...p, tight, text }, now) }))
  const first = set[0].tight!
  return { shown, excluded, floor, belowFloor: !meeting.length, ...(avoid.length && !fresh.length && strongest.some(p => avoid.includes(p.fit.account)) ? { avoided: AVOIDED_ONLY } : {}), ...(status === 'short'
    ? { short: `No candidate is expected to cover this task; its ${first.name} quota is expected to run out partway${first.resetsIn === null ? '' : ` and resets in ${span(first.resetsIn)}`}.` } : {}) }
}

export function decide(choice: Choice): Verdict {
  const pick = choice.shown[0]
  return choice.shown.length === 1 ? { pick, via: 'only', p: null, why: 'Only candidate that can run this task.' }
    : { pick, via: 'order', p: null, why: "First by the owner's rules and the policy order." }
}

/** The record in the shape a backend takes: `current` with the job's kind (what attempts are compared by, backend costs/read.ts),
 *  `unkinded` for a backend from before kinds, and `v1` without size and fit too, for one from before phase 1. Each refuses the
 *  newer fields with its strict schema. */
export type RecordShape = 'current' | 'unkinded' | 'v1'
export function recordOf(choice: Choice, verdict: Verdict, a: Assessment, policy: Policy, shape: RecordShape = 'current'): Record<string, unknown> {
  const v1 = shape === 'v1'
  return {
    assessment: { difficulty: a.difficulty, risk: a.risk, why: a.why, ...(v1 ? {} : { size: a.size }), ...(shape === 'current' && a.kind ? { kind: a.kind } : {}) },
    candidates: choice.shown.map(s => ({ id: s.id, kind: s.kind, ...(s.agentId ? { agentId: s.agentId } : {}), machineId: s.machineId,
      engine: s.engine, model: s.model, effort: s.effort, quality: s.quality, cost: s.cost, title: s.title, label: s.label, ...(v1 ? {} : { fit: s.fit }),
      ...(s.gridModel && s.gridName ? { gridModel: s.gridModel, gridName: s.gridName } : {}) })),
    excluded: choice.excluded.slice(0, 200).map(e => ({ title: e.title, reason: cut(e.reason, 500) })),
    floor: choice.floor, notes: policy.notes.length > 0,
    pick: verdict.pick.id, via: verdict.via, p: verdict.p, belowFloor: choice.belowFloor, why: cut(verdict.why, 300),
  }
}
