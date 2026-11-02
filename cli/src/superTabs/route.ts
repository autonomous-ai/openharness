/** Super Tab routing, the pure half (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md), ordered by
 * strength, effective cost and quota fit since phase 1 (docs/plans/2026-10-21-swarm-routing-phase1.md).
 * Since the project instructions (docs/plans/2026-10-30-project-instructions-design.md, Routing) the route is advice: it
 * leaves out only what cannot run (an offline or paused machine, an engine signed out, a model not served) and ranks every
 * other candidate by strength, price, quota fit and idle members. The owner's rules, floors, review and build limits are
 * gone; what the route knows beside the facts (a lost task, a stalled machine, a catalog note) is a note on the candidate,
 * and the project's instructions say how to choose. */
import { isAbsolute } from 'node:path'
import { claudeAliasForModel } from '../engines/claude/runtimeProfile.js'

type Json = Record<string, unknown>
export type Level = 'low' | 'medium' | 'high'
export type Size = 'small' | 'medium' | 'large'
/** `kind` is a word the agent may give (`ui`, `docs`), recorded so attempts can be compared by the kind of job they were. */
/** `local`: a person asked for a local model by hand, so only models served on the Swarm's grid are considered
 * (docs/plans/2026-10-23-swarm-local-models.md). */
/** `model`: a model a person named, in their words ("deepseek 4.1 flash"); only candidates running it are considered,
 * whatever their strength (owner, 2026-10-23: a Builder on a named API model was ranked below Opus and never offered). */
/** `needs.heavy`: the work runs a heavy build or end-to-end tests on its machine, so it needs more free memory and disk than a
 * start (machineFit.ts). `needs.ci`: the CI jobs the work starts at once, and how many of them on macOS runners, held against
 * the account's running-jobs limit. Both are left out when not given, so a request without them answers as before. */
export type HeavyWork = 'build' | 'e2e'
export interface Needs { tools: string[]; devices: string[]; cwd?: string; heavy?: HeavyWork[]; ci?: { jobs: number; macos: number } }
export interface Assessment { difficulty: Level; risk: Level; size: Size; why: string; kind?: string; local?: boolean; model?: string; needs: Needs }
/** A model of the reviewed catalog (backend superTabs/catalog.ts): how strong it is, what it costs, and whether it is offered
 * when nobody names it. */
export interface CatalogModel { engine: 'claude' | 'codex'; model: string; effort: string; strength: number; cost: number; offered: boolean; note?: string }
/** The catalog's models and how strong the models served on the Swarm's grid count: the first named row whose every word is
 * in a model's name, else `strength`. */
export interface Catalog { models: CatalogModel[]; grid: { strength: number; models: Array<{ model: string; strength: number }> } }
/** One usage window, named by the reader (`5-hour`, `weekly`); `leftPercent` is what remains of it. */
export interface QuotaWindow { name: string | null; leftPercent: number; resetsAt: number | null }
/** `leftPercent` and `resetsAt` are the tightest window's; `windows` is every window. `account` is the reading's hashed
 * account key, which models on one subscription share. `metered` is an engine on an API key or gateway: known, with no
 * usage window to run out. */
export interface Quota { known: boolean; leftPercent: number | null; resetsAt: number | null; windows?: QuotaWindow[]; account?: string; metered?: true
  /** Why an unknown allowance could not be read, as its machine said (cli superTabs/capacity.ts quotaUnknownReason). */
  why?: string
  /** The machine this reading is from, when it is not the candidate's own: a Harness Team account's Mac, whose subscription
   *  the account spends (routeCommand.ts relayedReadings). */
  from?: string }
/** The task's folder as the routing agent's machine sees it. `unknown` means it could not be read, `none` that it is not a
 * repository, `missing` that this machine has no such folder (a member elsewhere may). */
export interface TaskFolder { cwd: string; kind: 'git' | 'none' | 'missing' | 'unknown'; name: string | null; root: string | null; remote: string | null }
/** What a member's `agents_list` frame says it is working on; every field is null when the frame does not say. */
export interface MemberFrame { title: string | null; project: string | null; cwd: string | null; root: string | null; remote: string | null; branch: string | null; updatedAt: number | null }
/** What a machine offers an agent. Each field is null when it could not be read; `freeDiskBytes` (the project's disk) and
 * `cpuPercent` are absent where the probe did not read them. */
export interface MachineLoad { agents: number | null; freeMemoryBytes: number | null; hasFolder: boolean | null; freeDiskBytes?: number | null; cpuPercent?: number | null }
export interface Probe {
  kind: 'member' | 'new'; agentId?: string; name?: string; machineId: string; machineName: string
  /** `quality` is the catalog's strength, 1 for a model it does not rate (`unrated`). */
  engine: 'claude' | 'codex'; model: string; effort: string; quality: number; cost: number
  quota: Quota; activity: string; known: boolean
  /** What makes it unable to run: it is left out with these. */
  refusals: string[]
  /** What the agent choosing should know of it (a lost task, a stalled machine, the catalog's note): shown, never a filter. */
  notes: string[]
  /** A model the catalog does not rate: a person named it, or a member runs it. */
  unrated?: true
  /** Members: the frame (null when it could not be read), whether the member is in the task's repository, and its earlier work in this Super Tab. */
  frame?: MemberFrame | null; repo?: 'same' | 'different' | 'unknown'; earlier?: Array<{ group: string; outcome: string }>
  terminalUnverified?: boolean
  /** What the machine has: for new agents, and for members where their machine's reading is known. */
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
/** A candidate left out and why; [machine] names its machine, absent for a model that is not offered anywhere. */
export interface Excluded { title: string; reason: string; machine?: string }
/** `floor` and `belowFloor` are what the decision log still takes (backend routeRecord.ts): there is no floor, so 1 and false.
 *  `short` says when the pick is not expected to cover the task on its quota. `adjusted`: a plug-in moved a candidate or left
 *  one out ([RoutePlugin]). `warnings`: the plug-ins that failed and were left out of this route. */
export interface Choice { shown: Shown[]; excluded: Excluded[]; floor: 1; belowFloor: false; short?: string; adjusted?: true; warnings?: string[] }
export type NoCandidate = { error: 'NO_CANDIDATE'; excluded: Excluded[]; warnings?: string[] }

/** What a plug-in sees of the route it ranks: the task, the time, the catalog, and the picks still at work. */
export interface RouteContext { readonly assessment: Assessment; readonly now: number; readonly catalog: Catalog; readonly open: readonly Commitment[] }
/** A plug-in's word on one candidate. `strength` and `cost` shift the two terms the order ranks by (stronger first, then
 *  cheaper in effect), in the catalog's units: +0.5 strength or -1 cost moves it up. Neither changes what the candidate is
 *  shown and recorded as (its strength, cost and fit stay as measured). `refuse` leaves it out, only for a fact that it cannot
 *  run there. `reason` is what people read, on the candidate's notes as "name: reason", so it holds only what every reader of
 *  the Swarm's route log may see: never one member's raw usage or anything private to a person or chat. */
export interface Adjustment { reason: string; strength?: number; cost?: number; refuse?: true }
/** One piece of the ranking that is not the route's own (Scholes's goals, pieces 3 to 6: measured cost and results, more model
 *  candidates, machine fit, window pull). Plug-ins run in their list's order: each `candidates` call sees the probes so far,
 *  earlier plug-ins' among them, and returns more, which every rule of [choose] then treats like the others; `adjust` judges
 *  each candidate that can run, after its quota fit is known. A plug-in must be pure and synchronous: what it needs from
 *  outside is read before the route and given to it when it is made. One that throws, or answers what cannot be ranked, is
 *  left out of the whole route, so it never judges some candidates and not others, and the answer names it. */
export interface RoutePlugin {
  readonly name: string
  candidates?(probes: readonly Probe[], context: RouteContext): Probe[]
  adjust?(candidate: Readonly<Probe & { fit: Fit }>, context: RouteContext): Adjustment | null
}
/** The order's two adjustable terms for one candidate ([compare]); with no plug-in they are its strength and effective cost. */
interface Ranked { strength: number; cost: number }
/** How long one plug-in may take over a route's candidates, per step. Plug-ins are pure and synchronous, so a route of a few
 *  dozen candidates takes them well under a millisecond; one over this is doing work it should have done before the route
 *  (Lead, 10-31: a plug-in that runs too long is skipped). A plug-in that never returns cannot be stopped from inside: that is
 *  why they must be synchronous and read nothing. */
export const PLUGIN_BUDGET_MS = 200
export const pluginSkipped = (name: string, why: string) => `The routing plug-in "${cut(name, 80)}" was skipped: ${why}. The route is ranked without it.`
const FAILED = 'it failed', SLOW = `it took longer than ${PLUGIN_BUDGET_MS} ms`
/** Runs [step] for one plug-in, timed: its answer, or why it is skipped. Its error text is never kept, since it may hold
 *  anything (a path, a token). */
function timed<T>(step: () => T, valid: (answer: T) => boolean): { answer: T } | { why: string } {
  const started = performance.now()
  try {
    const answer = step()
    if (performance.now() - started > PLUGIN_BUDGET_MS) return { why: SLOW }
    return valid(answer) ? { answer } : { why: FAILED }
  } catch { return { why: FAILED } }
}
const isProbe = (p: unknown): p is Probe => {
  const v = object(p)
  return typeof v.machineId === 'string' && typeof v.machineName === 'string' && ENGINES.includes(String(v.engine)) && typeof v.model === 'string'
    && typeof v.effort === 'string' && finite(v.quality) && finite(v.cost) && Array.isArray(v.refusals) && Array.isArray(v.notes) && !!v.quota
}
const baseKey = (p: Pick<Probe, 'machineId' | 'engine'>) => `${p.machineId}\0${p.engine}`
/** A plug-in's candidate as the route may consider it: a new agent standing on a machine and engine the route probed itself
 *  ([bases]), with that probe's refusals, notes, load and quota reading (a model on the grid keeps its own quota, as
 *  routeCommand.ts localProbes does), so it can never bring back a choice the route rules out. Otherwise why it is left out. */
function anchored(added: Probe, bases: Map<string, Probe>, name: string): Probe | Excluded {
  const out = (reason: string): Excluded => ({ title: titleOf(added), reason: `${cut(name, 80)}: ${reason}`, machine: added.machineName })
  if (added.kind !== 'new') return out('a plug-in adds new agents only; it adjusts the agents the route found.')
  const base = bases.get(baseKey(added))
  if (!base) return out(`this route offers no new agent on ${ENGINE[added.engine]} on ${added.machineName}, so one added there is left out.`)
  const { agentId: _a, name: _n, frame: _f, repo: _r, earlier: _e, terminalUnverified: _t, ...own } = added
  const more = (theirs: string[], ours: string[]) => [...theirs, ...ours.filter(x => !theirs.includes(x))]
  return { ...own, kind: 'new', machineName: base.machineName, activity: base.activity, known: base.known, ...(base.load ? { load: base.load } : {}),
    quota: added.gridModel ? added.quota : base.quota, refusals: more(base.refusals, added.refusals), notes: more(base.notes, added.notes) }
}
/** The probes with each plug-in's added candidates ([anchored]), in the plug-ins' order, and those left out. A plug-in whose
 *  answer is not a list of probes, or that runs too long, adds nothing and is named in [warnings]. */
function withPluginCandidates(given: Probe[], plugins: readonly RoutePlugin[], context: RouteContext, warnings: string[]): { probes: Probe[]; out: Excluded[] } {
  const bases = new Map<string, Probe>()
  for (const p of given) if (p.kind === 'new' && !p.gridModel && !bases.has(baseKey(p))) bases.set(baseKey(p), p)
  let probes = given
  const out: Excluded[] = []
  for (const plugin of plugins) {
    if (!plugin.candidates) continue
    const run = timed(() => plugin.candidates!(probes, context) as unknown, added => Array.isArray(added) && added.every(isProbe))
    if ('why' in run) { warnings.push(pluginSkipped(plugin.name, run.why)); continue }
    const placed = (run.answer as Probe[]).map(p => anchored(p, bases, plugin.name))
    probes = [...probes, ...placed.filter((p): p is Probe => 'engine' in p)]
    out.push(...placed.filter((p): p is Excluded => !('engine' in p)))
  }
  return { probes, out }
}
const validAdjustment = (x: Adjustment | null): x is Adjustment | null => x === null || (typeof x === 'object' && typeof x.reason === 'string'
  && !!x.reason.trim() && (x.strength === undefined || finite(x.strength)) && (x.cost === undefined || finite(x.cost))
  && (x.refuse === undefined || x.refuse === true))
/** Every plug-in's adjustments of [ranked], plug-in by plug-in in the list's order: one that throws, runs too long or answers
 *  what cannot be ranked for any candidate is dropped for all of them and named in [warnings]. */
function pluginAdjustments<T extends Probe & { fit: Fit }>(ranked: T[], plugins: readonly RoutePlugin[], context: RouteContext,
  warnings: string[]): Array<Array<{ name: string; adjustment: Adjustment }>> {
  const each = ranked.map(() => [] as Array<{ name: string; adjustment: Adjustment }>)
  for (const plugin of plugins) {
    if (!plugin.adjust) continue
    const run = timed(() => ranked.map(p => plugin.adjust!(p, context)), answers => answers.every(validAdjustment))
    if ('why' in run) { warnings.push(pluginSkipped(plugin.name, run.why)); continue }
    run.answer.forEach((adjustment, i) => { if (adjustment) each[i]!.push({ name: plugin.name, adjustment }) })
  }
  return each
}
export interface Verdict { pick: Shown; via: 'order' | 'only'; p: null; why: string }

const LEVELS: Level[] = ['low', 'medium', 'high']
const HEAVY_WORK: unknown[] = ['build', 'e2e'] satisfies HeavyWork[]
/** Run time and spend per window by task size, for a catalog row of cost 2 (owner's table, 2026-10-21). */
export const SIZES: Record<Size, { minutes: number; spend: Record<Window, number> }> = {
  small: { minutes: 20, spend: { '5-hour': 10, weekly: 1 } },
  medium: { minutes: 60, spend: { '5-hour': 30, weekly: 4 } },
  large: { minutes: 180, spend: { '5-hour': 50, weekly: 8 } },
}
const WINDOWS: Window[] = ['5-hour', 'weekly']
const MAX_SHOWN = 12
const ENGINE = { claude: 'Claude', codex: 'Codex' } as const
const ENGINES = Object.keys(ENGINE)
const cut = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`
const object = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The catalog the tab's routing read serves beside its policy (backend superTabs/catalog.ts catalogRead), or, from an older
 * backend that serves only the policy, the same models read off it: a row's quality is its strength and `enabled` whether it
 * is offered. A row of another engine (OpenCode, Kilo) or of no shape is dropped; nothing readable is an empty catalog. */
export function catalogFrom(effective: Json): Catalog {
  const catalog = object(effective.catalog), policy = object(effective.policy)
  const served = Array.isArray(catalog.models)
  const rows = (served ? catalog.models : Array.isArray(policy.models) ? policy.models : []) as unknown[]
  const models = rows.map(object).flatMap((m): CatalogModel[] => {
    const strength = served ? m.strength : m.quality, offered = served ? m.offered : m.enabled
    if (!ENGINES.includes(String(m.engine)) || typeof m.model !== 'string' || typeof m.effort !== 'string' || !finite(strength) || !finite(m.cost)) return []
    return [{ engine: m.engine as CatalogModel['engine'], model: m.model, effort: m.effort, strength, cost: m.cost, offered: offered === true,
      ...(served && typeof m.note === 'string' && m.note ? { note: m.note } : {}) }]
  })
  const grid = served ? object(catalog.grid) : object(policy.localModels)
  const gridRows = (Array.isArray(grid.models) ? grid.models : []) as unknown[]
  return { models, grid: { strength: finite(served ? grid.strength : grid.quality) ? (served ? grid.strength : grid.quality) as number : 1,
    models: gridRows.map(object).flatMap(r => { const s = served ? r.strength : r.quality; return typeof r.model === 'string' && finite(s) ? [{ model: r.model, strength: s }] : [] }) } }
}

export function parseAssessment(value: unknown): Assessment | string {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (!LEVELS.includes(v.difficulty as Level)) return 'Set difficulty to low, medium or high.'
  if (!LEVELS.includes(v.risk as Level)) return 'Set risk to low, medium or high.'
  // Agents from before sizes send none; their tasks are taken for medium.
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
  const heavy = needs.heavy
  if (heavy !== undefined && (!Array.isArray(heavy) || !heavy.every(h => HEAVY_WORK.includes(h)))) return 'Set needs.heavy to a list of build and e2e.'
  const ci = needs.ci === undefined ? undefined : object(needs.ci)
  const count = (n: unknown, max: number) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max
  if (ci && (!count(ci.jobs, 100) || (ci.jobs as number) < 1 || (ci.macos !== undefined && !count(ci.macos, ci.jobs as number)))) {
    return 'Set needs.ci to the CI jobs the work starts, as {"jobs": 1 to 100, "macos": how many of them run on macOS}.'
  }
  return { difficulty: v.difficulty as Level, risk: v.risk as Level, size: size as Size, why, ...(v.kind ? { kind: v.kind as string } : {}),
    ...(v.local === true ? { local: true } : {}), ...(typeof v.model === 'string' ? { model: v.model.trim() } : {}),
    needs: { tools: list(needs.tools), devices: list(needs.devices), ...(cwd ? { cwd } : {}),
      ...(Array.isArray(heavy) && heavy.length ? { heavy: [...new Set(heavy as HeavyWork[])] } : {}),
      ...(ci ? { ci: { jobs: ci.jobs as number, macos: (ci.macos as number | undefined) ?? 0 } } : {}) } }
}

/** Claude sends ISO strings, Codex epoch seconds; anything above 1e10 is already milliseconds. */
function resetMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e10 ? value : value * 1000
  if (typeof value === 'string') { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null }
  return null
}
export function quotaOf2(q: { known: boolean; windows: Array<{ usedPercent: number; resetsAt: unknown; name?: string }>; account?: string | null; why?: string | null }): Quota {
  const account = q.account ? { account: q.account } : {}
  if (!q.known) return { known: false, leftPercent: null, resetsAt: null, ...account, ...(q.why ? { why: q.why } : {}) }
  if (!q.windows.length) return { known: true, leftPercent: null, resetsAt: null, metered: true, ...account }
  const tightest = q.windows.reduce((x, y) => y.usedPercent > x.usedPercent ? y : x)
  return { known: true, leftPercent: Math.max(0, 100 - tightest.usedPercent), resetsAt: resetMs(tightest.resetsAt),
    windows: q.windows.map(w => ({ name: w.name ?? null, leftPercent: Math.max(0, 100 - w.usedPercent), resetsAt: resetMs(w.resetsAt) })), ...account }
}

/** Whether a member's checkout is the task's repository: the same remote wherever it lives, else the same root on one
 * machine. Paths on two machines say nothing without a remote. Undefined when no folder was named. */
export function repoMatch(folder: TaskFolder | null, frame: MemberFrame | null, sameMachine: boolean): Probe['repo'] | undefined {
  if (!folder) return undefined
  if (!frame || folder.kind === 'unknown') return 'unknown'
  if (folder.remote && frame.remote) return folder.remote === frame.remote ? 'same' : 'different'
  const theirs = frame.root ?? frame.cwd
  // A frame that names no checkout says nothing. The folder named is a path on the machine that will run the task, so a
  // member standing in exactly it is in it, wherever the routing agent is.
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
 * Codex's slug (`gpt-5.5`). The catalog names Claude families and a Codex `default`, so the id is reduced to its family
 * first. Its row: the exact one, else the model's at another effort, else the engine's `default` row when the agent was
 * launched on the engine's own model ([engineDefault]) and is no small variant; otherwise none, so a small Codex variant is
 * never taken for a strong one (review of #2137). */
export function catalogRow(c: Catalog, engine: string, model: string | null, effort: string | null, engineDefault = false): CatalogModel | null {
  const name = engine === 'claude' && model ? claudeAliasForModel(model.replace(/\[1m\]$/i, '')) ?? model : model ?? 'default'
  const rowOf = (named: string) => c.models.find(m => m.engine === engine && m.model === named && m.effort === (effort ?? 'default'))
    ?? c.models.find(m => m.engine === engine && m.model === named)
  // A small model it reports is never promoted by its launch (review of ee4ee6c9a).
  return rowOf(name) ?? (engineDefault && !SMALL.test(model ?? '') ? rowOf('default') : undefined) ?? null
}
/** How strong the catalog rates a model ([catalogRow]), or null when it does not. */
export const strengthOf = (c: Catalog, engine: string, model: string | null, effort: string | null, engineDefault = false): number | null =>
  catalogRow(c, engine, model, effort, engineDefault)?.strength ?? null
/** A small variant by its name: a mini or a nano (backend superTabs/rules.ts). */
const SMALL = /(^|[^a-z0-9])(mini|nano)([^a-z0-9]|$)/i

export const KIND_WORD = { local: 'local', api: 'API', shared: 'shared' } as const
const runs = (p: Probe) => p.gridModel ? `${ENGINE[p.engine]} on ${p.gridLabel ?? p.gridModel} (${KIND_WORD[p.gridKind ?? 'local']})` : `${ENGINE[p.engine]} ${p.model} ${p.effort}`
/** A name's words for matching: lowercase letters and digits, "4.1" read as "41". */
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9.]+/).map(w => w.replace(/\./g, '')).filter(Boolean)
/** How strong a grid model counts: the first of the catalog's named grid rows whose every word is in its id or label (Kimi K3
 *  and DeepSeek v4.1 at 2), else the grid's own strength. */
export function gridStrength(c: Catalog, model: string, label = ''): number {
  const name = words(`${model} ${label}`).join('')
  return c.grid.models.find(row => words(row.model).every(w => name.includes(w)))?.strength ?? c.grid.strength
}
/** Whether [p] runs the model a person named: every word of theirs is in its model's name. */
function runsNamed(p: Pick<Probe, 'engine' | 'model' | 'gridModel' | 'gridLabel'>, named: string): boolean {
  const name = words([p.gridModel ?? p.model, p.gridLabel ?? '', ENGINE[p.engine]].join(' ')).join('')
  return words(named).every(w => name.includes(w))
}
const NAMED_NONE = (named: string) => `No candidate runs "${named}". Share it with the Swarm (Your models), or check its name.`
/** Whether a person's words name [model]: every word of theirs is in its name, or every word of its name is in theirs
 *  ("Kimi" and "moonshotai/kimi-k3" both name the grid row "kimi k3"). */
function names(model: string, named: string): boolean {
  const ours = words(model), theirs = words(named)
  return !!ours.length && (theirs.every(w => ours.join('').includes(w)) || ours.every(w => theirs.join('').includes(w)))
}
/** A named model the catalog does not list is offered unrated, on Claude Code when its name says Claude, else on Codex
 *  (project instructions, phase 4, decision 15). A third-party model behind Claude Code gets Codex; it can still be started
 *  by hand. */
const CLAUDE_NAMES = /claude|opus|sonnet|haiku|fable/i
export const UNRATED = 'The catalog does not rate this model.'

/** How many agents may run on one API model a member shares: the share answers four requests at once
 * (cli/src/lib/swarmApiShares.ts CONCURRENCY), unlike a local engine, which answers one conversation at a time. */
export const API_BUILDERS = 4

/** A model served for the Swarm that takes no more agents, and who is on it (routeCommand.ts heldLocalModels). */
export interface HeldModel { model: string; label: string; kind: 'local' | 'api' | 'shared'; holders: string[] }

/** Why a held model is not offered, and what frees it: a model in use reads as unshared otherwise (owner, 2026-10-24). */
function heldReason(m: HeldModel): string {
  const who = m.holders.length === 1 ? `${m.holders[0]} is on it` : `${m.holders.slice(0, -1).join(', ')} and ${m.holders.at(-1)} are on it`
  const limit = m.kind === 'api' ? `an API model takes ${API_BUILDERS} agents at a time` : 'a local model serves one agent at a time'
  return `"${m.label}" is shared with the Swarm, but ${who}: ${limit}. Assign the work to ${m.holders.length === 1 ? 'that agent once it is free, or stop it' : 'one of them once it is free, or stop one'} to free the model.`
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
  if (!q.known || q.leftPercent === null) return q.why ? `quota unknown (${q.why})` : 'quota unknown'
  if (q.from) return `quota read on ${cut(q.from, 40)}, whose subscription this account spends: ${quotaText({ ...q, from: undefined }, now).replace(/^quota /, '')}`
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
/** The most telling parts come first and the least last, because the log's limit cuts the end. The notes come right after
 *  the fit: they are what a ranking alone does not say. */
const labelOf = (p: Probe & Sized, now: number) => cut([
  p.kind === 'member' ? `Member ${cut(p.name ?? '', 40)}`.trim() : 'New agent', runs(p), `${p.unrated ? 'unrated' : `strength ${p.quality}`}, cost ${p.cost}`,
  p.text, ...p.notes.map(n => cut(n, 200)), cut(p.machineName, 40), p.activity, ...(p.kind === 'member' ? memberText(p, now) : p.load ? machineText(p.load) : []),
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

/** A member builds in its own worktree, so one in another repository would build there (Diego, 2026-10-30, #2377). Both
 *  checkouts are compared as host and path (repoMatch), so the same repository over SSH and HTTPS is not "different". */
export const OTHER_REPOSITORY = 'It works in another repository, so it would build this in that repository\'s worktree. A new agent starts in this one.'

/** How the probe's account would carry a task of this size (phase 1 §2–3). Nothing is held in reserve: quota is
 *  information, so all that is left counts. */
function sizeUp(p: Probe, a: Assessment, now: number, open: Commitment[]): Sized {
  // A local model spends no subscription: it always fits, at its catalog cost, and its node is its account.
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
    return [{ name, usable: w.leftPercent - committed(name), resetsIn,
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
export const LOCAL_NONE = 'No local model is being served on this Swarm\'s grid. Ask a member to run one or share an API (Your models, in the Swarm\'s sidebar).'

const FIT_ORDER = { fits: 0, unknown: 1, short: 2 } as const
/** The order: a member in another repository last; then stronger, cheaper in effect (price, less with a 5-hour window that
 *  would otherwise go unused), a better quota fit, an idle member in the task's repository before a new agent, then by title
 *  (project instructions, phase 4). */
function compare(x: Probe & Sized & { rank: Ranked }, y: Probe & Sized & { rank: Ranked }): number {
  // A member in another repository tied a new agent and its name decided whether it took the task (Diego, 2026-10-30, #2377);
  // ranked only after a new agent, a cheaper model or more quota still won it. The route no longer tells a build from a
  // review, which needs no worktree, so it is shown last with OTHER_REPOSITORY as a note (choose), never left out.
  const elsewhere = (p: Probe) => p.kind === 'member' && p.repo === 'different' ? 1 : 0
  const placed = (p: Probe) => p.kind === 'member' && (p.repo ?? 'same') === 'same' ? 0 : 1
  return elsewhere(x) - elsewhere(y)
    || y.rank.strength - x.rank.strength
    || x.rank.cost - y.rank.cost
    || FIT_ORDER[x.fit.status] - FIT_ORDER[y.fit.status]
    || placed(x) - placed(y)
    || titleOf(x).localeCompare(titleOf(y))
}

/** The rows shown: each machine's best row first (the best-ranked machines, if there are more than the limit), then the rest by rank,
 * all in rank order, so the agent choosing can always choose another machine. */
function withEveryMachine<T extends { machineId: string }>(ranked: T[]): T[] {
  const firsts = new Set<T>(), seen = new Set<string>()
  for (const p of ranked) if (!seen.has(p.machineId)) { seen.add(p.machineId); firsts.add(p) }
  const keep = new Set([...firsts].slice(0, MAX_SHOWN))
  for (const p of ranked) if (keep.size < MAX_SHOWN) keep.add(p)
  return ranked.filter(p => keep.has(p))
}

/** One unrated new agent per machine of the named model's engine, on that machine's first row of the engine, which carries
 *  its facts and its quota ([CLAUDE_NAMES]). The person's words are the model's id, in lowercase with no spaces. */
function unratedProbes(probes: Probe[], named: string): Probe[] {
  const engine = CLAUDE_NAMES.test(named) ? 'claude' : 'codex', model = named.trim().toLowerCase().replace(/\s+/g, '-')
  const bases = new Map<string, Probe>()
  for (const p of probes) if (p.kind === 'new' && !p.gridModel && p.engine === engine && !bases.has(p.machineId)) bases.set(p.machineId, p)
  return [...bases.values()].map(base => ({ ...base, model, effort: 'default', quality: 1, cost: 1, unrated: true as const, notes: [...base.notes, UNRATED] }))
}

/** The candidates that can run the task, ranked ([compare]), and those that cannot, with why. A catalog row not offered by
 *  default (Sonnet, Haiku) is offered when a person names it; its note goes with it, and with a member already on it.
 *  `held`: models served for the Swarm that take no more agents, to say who holds a named or local model none offers.
 *  `offline`: models a host now offline served (routeCommand.ts offlineModels), by name. `plugins`: [RoutePlugin]; with none
 *  the answer is exactly what it was before plug-ins existed (route.spec.ts, route answers without plug-ins). */
export function choose(given: Probe[], catalog: Catalog, a: Assessment, now: number = Date.now(), open: Commitment[] = [], held: HeldModel[] = [],
  offline: Array<{ title: string; reason: string }> = [], plugins: readonly RoutePlugin[] = []): Choice | NoCandidate {
  const named = a.model
  const context: RouteContext = { assessment: a, now, catalog, open }, warnings: string[] = []
  const { probes, out: addedOut } = withPluginCandidates(given, plugins, context, warnings)
  const warned = () => warnings.length ? { warnings } : {}
  const noted = probes.flatMap(p => {
    const row = p.gridModel ? null : p.kind === 'new' ? catalog.models.find(m => m.engine === p.engine && m.model === p.model && m.effort === p.effort) ?? null
      : catalogRow(catalog, p.engine, p.model, p.effort)
    if (row && !row.offered && p.kind === 'new' && !(named && runsNamed(p, named))) return []
    const rated = row?.note && !p.notes.includes(row.note) ? { ...p, notes: [...p.notes, row.note] } : p
    if (p.kind !== 'member' || p.repo !== 'different') return [rated]
    // The task names a repository this member does not work in: it cannot run there, a fact, so it is left out with why.
    if (a.needs.cwd) return [{ ...rated, refusals: [...rated.refusals, OTHER_REPOSITORY] }]
    // No repository named: the coordinator knows whether the task needs a worktree, so it is ranked last with a note.
    return [{ ...rated, notes: [...rated.notes, OTHER_REPOSITORY] }]
  })
  // A person asking for a local model considers local models alone, whatever their strength.
  let considered = a.local ? noted.filter(p => p.gridModel) : noted
  // A person naming a model considers that model alone; one the catalog does not list is offered unrated.
  const heldNamed = named ? held.filter(m => words(named).every(w => words(`${m.model} ${m.label}`).join('').includes(w))) : []
  if (named) considered = considered.filter(p => runsNamed(p, named))
  // A model of the grid (a catalog grid row, or one a host now offline served) is no unknown model to try on Codex: nothing
  // serves it now, which the answer says, rather than "Codex kimi-k3" unrated (final review).
  const ofGrid = !!named && (catalog.grid.models.some(row => names(row.model, named)) || offline.some(m => names(m.title, named)))
  if (named && !considered.length && !heldNamed.length && !a.local && !ofGrid) considered = unratedProbes(probes, named)
  const excluded: Excluded[] = [...considered.filter(p => p.refusals.length).map(p => ({ title: titleOf(p), reason: p.refusals.join(' '), machine: p.machineName })), ...addedOut]
  const viable = considered.filter(p => !p.refusals.length)
  // Nothing offered: a model that is served but taken says who has it, rather than reading as unshared.
  if (named && !considered.length) {
    if (heldNamed.length) excluded.push(...heldNamed.map(m => ({ title: 'Named model', reason: heldReason(m) })))
    else excluded.push({ title: 'Named model', reason: NAMED_NONE(named) })
  } else if (a.local && !considered.length) {
    if (held.length) excluded.push(...held.map(m => ({ title: 'Local models', reason: heldReason(m) })))
    else excluded.push({ title: 'Local models', reason: LOCAL_NONE })
  }
  if (!viable.length) return { error: 'NO_CANDIDATE', excluded, ...warned() }
  const sized = viable.map(p => ({ ...p, ...sizeUp(p, a, now, open) }))
  const adjustments = pluginAdjustments(sized, plugins, context, warnings)
  const adjusted = adjustments.some(list => list.length)
  const ranked = sized.flatMap((p, i) => {
    const mine = adjustments[i]!, rank = { strength: p.quality, cost: p.fit.effectiveCost }
    if (!mine.length) return [{ ...p, rank }]
    const reasons = mine.map(({ name, adjustment }) => `${name}: ${adjustment.reason.trim()}`)
    if (mine.some(m => m.adjustment.refuse)) {
      excluded.push({ title: titleOf(p), reason: reasons.filter((_, j) => mine[j]!.adjustment.refuse).join(' '), machine: p.machineName })
      return []
    }
    for (const { adjustment } of mine) { rank.strength += adjustment.strength ?? 0; rank.cost += adjustment.cost ?? 0 }
    return [{ ...p, notes: [...p.notes, ...reasons], rank }]
  }).sort(compare)
  if (!ranked.length) return { error: 'NO_CANDIDATE', excluded, ...warned() }
  const shown = withEveryMachine(ranked).map(({ tight, text, rank: _rank, ...p }, i) => ({ ...p, id: `c${i}`, title: titleOf(p), label: labelOf({ ...p, tight, text }, now) }))
  const first = ranked[0]!
  return { shown, excluded, floor: 1, belowFloor: false, ...(first.fit.status === 'short' ? { short: shortOf(first, ranked) } : {}),
    ...(adjusted ? { adjusted: true as const } : {}), ...warned() }
}

/** What the agent choosing is told when the pick is not expected to cover the task on its quota: a candidate further down
 *  may, or none does. */
function shortOf(first: Probe & Sized, ranked: Array<Probe & Sized>): string {
  const w = first.tight!, resets = w.resetsIn === null ? '' : ` and resets in ${span(w.resetsIn)}`
  const fitting = ranked.find(p => p.fit.status === 'fits')
  return fitting ? `The first candidate's ${w.name} quota is expected to run out partway${resets}; ${titleOf(fitting)} fits.`
    : `No candidate is expected to cover this task; its ${w.name} quota is expected to run out partway${resets}.`
}

export function decide(choice: Choice): Verdict {
  const pick = choice.shown[0]!
  return choice.shown.length === 1 ? { pick, via: 'only', p: null, why: 'Only candidate that can run this task.' }
    : { pick, via: 'order', p: null, why: choice.adjusted ? 'First by strength, then price and quota fit, with the plug-ins\' adjustments in each candidate\'s notes.'
      : 'First by strength, then price and quota fit.' }
}

/** The record in the shape a backend takes: `current` with the job's kind (what attempts are compared by, backend costs/read.ts),
 *  `unkinded` for a backend from before kinds, and `v1` without size and fit too, for one from before phase 1. Each refuses the
 *  newer fields with its strict schema. There is no floor and no policy notes: `floor` 1, `belowFloor` and `notes` false.
 *  The server stamps the instructions' revision the decision relied on (phase 4, decision 12). */
export type RecordShape = 'current' | 'unkinded' | 'v1'
export function recordOf(choice: Choice, verdict: Verdict, a: Assessment, shape: RecordShape = 'current'): Record<string, unknown> {
  const v1 = shape === 'v1'
  return {
    assessment: { difficulty: a.difficulty, risk: a.risk, why: a.why, ...(v1 ? {} : { size: a.size }), ...(shape === 'current' && a.kind ? { kind: a.kind } : {}),
      ...(shape === 'current' && a.local ? { local: true } : {}), ...(shape === 'current' && a.model ? { model: a.model } : {}) },
    candidates: choice.shown.map(s => ({ id: s.id, kind: s.kind, ...(s.agentId ? { agentId: s.agentId } : {}), machineId: s.machineId,
      engine: s.engine, model: s.model, effort: s.effort, quality: s.quality, cost: s.cost, title: s.title, label: s.label, ...(v1 ? {} : { fit: s.fit }),
      ...(s.gridModel && s.gridName ? { gridModel: s.gridModel, gridName: s.gridName } : {}) })),
    excluded: choice.excluded.slice(0, 200).map(e => ({ title: e.title, reason: cut(e.reason, 500) })),
    floor: 1, notes: false,
    pick: verdict.pick.id, via: verdict.via, p: verdict.p, belowFloor: false, why: cut(verdict.why, 300),
  }
}
