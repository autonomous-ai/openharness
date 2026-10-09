/**
 * Bring registered agents back after their tmux panes died with the daemon down — a reboot, a
 * `tmux kill-server`, a pane closed by hand.
 *
 * The registry outlives the tmux server: it still knows each agent's id, engine, cwd, session and
 * launch shape. This recreates a pane for every agent whose pane is gone, launches the same engine
 * there — resuming its engine session when it has one — and keeps the SAME agentId, so a desktop
 * tile that remembered the agent attaches to it again without anyone recreating anything.
 *
 * Dependency-injected like restartAgent.ts: cli.ts owns the tmux, registry and reconciler wiring,
 * and this owns the ordering, which is the part worth testing without a daemon:
 *
 *   1. Missing panes are allocated as waiting shells, then their routes commit synchronously together.
 *      A new tmux server hands out
 *      pane ids from `%0` again, so a restored pane's id can equal another stale row's dead pane —
 *      and `registry.save()` evicts whichever row loses that collision. Deferring the save until
 *      safe route assignments have been checked is what keeps the second row alive. Failed allocations
 *      never make another row surrender its route; all such conversations remain held.
 *   2. The new route is HELD in the reconciler until the engine process is bound here. Otherwise the
 *      reconciler's discovery half sees an unclaimed engine process and mints a fresh agentId for it.
 *   3. The row keeps `launch: starting` and only gets its process identity from here. The reconcile
 *      pass after the release then matches the process, sees a launch in progress, and does the
 *      full ready → attach → announce sequence it already does for `agent_create`.
 *
 * A grid agent comes back onto its grid: the registry kept the launch it was created or retargeted
 * with (`gridLaunch`, credential included), and `buildLaunch` turns that back into the same env and
 * argv `agent_create` used. A row that only knows WHERE it pointed (`grid` without `gridLaunch`,
 * written before the credential was persisted) is not relaunched — on the engine's own login it would
 * spend the wrong account while looking identical — and is marked so the app can say why.
 *
 * A launch that asks a service for its part (`needs`: a grid's or a saved API's, from models) is never waited
 * on at boot (`defer`): the agent is HELD, in a pane of its own that says what it waits for, and a later pass
 * (`only`, core/agents/heldLaunches.ts) launches it there once the core is up and the service can be asked. A
 * service that cannot be asked holds the agent the same way, and every agent after it in that pass that
 * needs the same service, unasked: one pass waits on a service at most once. Held is never failed: the next
 * restore tries again, and discovery keeps the agent, whose pane is alive.
 */

import { isTerminalEngine, type AgentEngine } from '../engines/types.js'
import type { AgentLaunch, ProcessIdentity, RegisteredSession } from './registry.js'
import type { TerminalDispatchControl, TerminalRuntimeRef, TmuxRuntimeRef } from './terminalTypes.js'
import { terminalRouteKey } from './terminalRuntime.js'
import { resumesConversation } from './resumeCapability.js'

export interface RestoreLaunch {
  argv: string[]
  env?: Record<string, string>
}

/** The launch, why there is none, or the service its launch asks that could not be asked (`held`). */
export type RestoreLaunchResult = RestoreLaunch | { cancelled: true } | { error: string; detail: string } | { held: string; detail?: string; holdScope?: 'workspace' }

/** What a held agent's row says: the service it waits for, and why, in the words its pane shows. */
export function heldLaunch(service: string, label = service === 'models' ? 'the models service' : service === 'store' ? 'the Store' : service): AgentLaunch {
  return { state: 'held', service, detail: `Waiting for ${label}. This harness starts by itself once ${label} is running.` }
}

/** The row knows it was on a grid but not how to get back there. */
export const GRID_CREDENTIAL_REQUIRED = 'GRID_CREDENTIAL_REQUIRED'

export interface RestoreAgentsDeps {
  /** Fresh inventory for each boot/held pass; no tmux snapshot survives a restore. */
  survey?: () => Pick<RestoreAgentsDeps, 'livePane' | 'liveProcess'>
  /** Stop/restart own the agent from the moment their job begins, before the registry changes. */
  cancelled?: (agentId: string) => boolean
  revision?: (agentId: string) => number
  /** Stop joins only this short dispatch/commit phase. Never wrap service preparation in it. */
  paneOperation?: <T>(agentId: string, operation: () => Promise<T>) => Promise<T>
  /** A missing-pane group reserves every possible stale route owner until its synchronous commit. */
  paneBusy?: (agentId: string) => boolean
  paneAllocations?: <T>(agentIds: readonly string[], operation: () => Promise<T>) => Promise<T>
  retainStopped?: (entry: RegisteredSession, paneAlive: boolean) => void
  /** Keeps a conversation the restore had to leave for a new one as a stopped harness (keepAbandonedConversation.ts). */
  keepAbandoned?: (left: RegisteredSession) => void

  registry: {
    list(): RegisteredSession[]
    byAgent(agentId: string): RegisteredSession | undefined
    transaction<T>(apply: () => T | Promise<T>): Promise<T>
    clearProcessIdentity(agentId: string): boolean
    updateRuntimes(agentId: string, runtimes: readonly TerminalRuntimeRef[], primaryRuntimeKey?: string): boolean
    setLaunch(agentId: string, launch: AgentLaunch): RegisteredSession | null
    beginExternalDispatch?(agentId: string): RegisteredSession | null
    updateProcessIdentity(agentId: string, processIdentity: ProcessIdentity): boolean
    unbindSession(sessionId: string): boolean
    inheritName(fromSessionId: string, toSessionId: string): void
    /** A terminal's adopted engine is gone: back to a shell (registry.ts). */
    releaseEngine(agentId: string): RegisteredSession | null
  }
  /**
   * Whether the row's PANE is still there — a live pane in a session this daemon created. Every
   * pane is a shell with the engine inside it, so a pane can outlive its engine: that is a terminal
   * (a bare one has no engine process to find at all), not a pane to rebuild. Optional so a caller
   * without tmux inventory (tests) treats a pane with no engine process as gone. `'unknown'` when the
   * inventory could not be read.
   */
  waitingPane?: (runtime: TmuxRuntimeRef, token: string) => Promise<boolean | 'unknown'>
  livePane?: (runtime: TmuxRuntimeRef) => Promise<boolean | 'unknown'>
  /** The engine process still running in this row's pane, or null when tmux does not know the pane
   *  at all — including when no tmux server is running — or the pane has become something else.
   *  `'unknown'` when tmux or `ps` could not be asked. */
  liveProcess: (entry: RegisteredSession, runtime: TmuxRuntimeRef) => Promise<ProcessIdentity | null | 'unknown'>
  /** The pane's launch — engine argv plus whatever puts it back on its grid / profile. A grid the
   *  machine cannot honour (unsupported engine, tmux too old, config dir unwritable) is a refusal. */
  buildLaunch: (entry: RegisteredSession, opts: { resumeSessionId?: string; current(): boolean }) => Promise<RestoreLaunchResult>
  createPane: (entry: RegisteredSession, launch: RestoreLaunch, control?: TerminalDispatchControl) => Promise<
    | { ok: true; runtime: TmuxRuntimeRef }
    | { ok: false; reason: string }
  >
  /** `tmux respawn-pane` over the restored pane — the resume → fresh fallback. */
  respawn: (runtime: TmuxRuntimeRef, launch: RestoreLaunch, control?: TerminalDispatchControl) => Promise<{ ok: boolean; reason?: string }>
  /** A pane was rebuilt on this conversation: its engine is a new one (core/transcripts/relaunch.ts). */
  engineStarted?: (sessionId: string) => void
  /** One probe of the pane for a recognizable engine process. */
  probeProcess: (runtime: TmuxRuntimeRef, engine: AgentEngine) => Promise<ProcessIdentity | null>
  /** `'gone'` when tmux no longer knows the pane, `'unknown'` when it could not be asked (`tmuxPaneState`).
   *  `engineExit` set: the engine left and the pane is a shell now (`ENGINE_EXIT_PANE_OPTION`), which for
   *  a restore is the same news as `dead`. */
  paneState: (runtime: TmuxRuntimeRef) => Promise<{ dead: boolean; engineExit?: number | null } | 'gone' | 'unknown'>
  clearRemainOnExit: (runtime: TmuxRuntimeRef) => Promise<void>
  holdRoute: (routeKey: string, autoReleaseMs: number) => void | (() => void)
  releaseRoute: (routeKey: string) => void
  triggerHint: (runtime: TmuxRuntimeRef, engine: AgentEngine) => Promise<void>
  log: (message: string) => void
  /** The service a launch of this row asks for its part (a grid's or a saved API's: `models`), or null. */
  needs?: (entry: RegisteredSession) => string | readonly string[] | null
  /** Boot: hold every row whose launch asks a service rather than ask it now (`heldLaunch`). */
  defer?: boolean
  /** Restore only these agents, every other row as it is: a pass over the held ones. */
  only?: ReadonlySet<string>
  /** What a held agent's pane runs while it waits: the reason, and nothing else. */
  waitingLaunch?: (entry: RegisteredSession, launch: Extract<AgentLaunch, { state: 'held' }>) => RestoreLaunch
  /** Close a held agent's pane whose launch then failed: it would otherwise go on saying it waits. */
  killPane?: (runtime: TmuxRuntimeRef) => Promise<void>
  /** How long a restored pane may take to show an engine process. Default matches `agent_create`. */
  budgetMs?: number
  /** How long the engine must stay up after appearing before the pane is handed over. */
  settleMs?: number
  /** The waits between asking a survey probe again (`SURVEY_RETRY_MS`). */
  surveyRetryMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}

export interface RestoreSummary {
  /** Core contention, not a service outage: retry after a short delay without another ready notice. */
  retry?: true
  /** Agents whose pane was recreated; their engine process is bound in the background. */
  restored: string[]
  skipped: Array<{ agentId: string; reason: string }>
  failed: Array<{ agentId: string; reason: string }>
  /** Agents held for a service their launch asks (`heldLaunch`), each in a pane that says so. */
  held: string[]
  /** Agents left as they were because tmux or `ps` could not say whether their pane or engine lives.
   *  Discovery must not retire them this boot: a pane restore never looked at is not one that closed. */
  unsurveyed: string[]
}

/** The waits between asking again when the survey's probes could not answer: about 8 s in all, the
 *  longest a held event loop is expected to keep their answers unread (e2e/stall.e2e.ts). */
export const SURVEY_RETRY_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000]

class Unsurveyed extends Error {}

/** A probe asked again while it answers `'unknown'`; still unknown after the last wait, the row is left
 *  alone. Restore is the one place a wrong "gone" is paid for at once: it archives a running agent,
 *  or opens a second pane resuming the conversation the first is still in. The waits are spent once
 *  per restore: tmux or `ps` still failing after them is broken, not held, and every row asked after
 *  that is left alone at once rather than holding the app's "starting" screen for 8 s a row. */
async function surveyed<T>(deps: RestoreAgentsDeps, patience: { left: boolean }, probe: () => Promise<T | 'unknown'>): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep
  let answer = await probe()
  for (const ms of patience.left ? deps.surveyRetryMs ?? SURVEY_RETRY_MS : []) {
    if (answer !== 'unknown') return answer
    await sleep(ms)
    answer = await probe()
  }
  if (answer !== 'unknown') return answer
  patience.left = false
  throw new Unsurveyed('tmux or ps could not say whether its pane or engine is alive')
}

/**
 * The survey's two questions, asked of tmux: one pane listing for the whole survey, read again only
 * after a read that failed, and the engine in a pane as `lookupPaneEngineProcess` finds it.
 */
export function tmuxSurvey(
  listPanes: () => Promise<{ ok: true; panes: Array<{ tmuxPane: string }> } | { ok: false }>,
  lookup: (pane: string, engine: AgentEngine) => Promise<{ ok: true; identity: ProcessIdentity } | { ok: false; unknown: boolean }>,
): Pick<RestoreAgentsDeps, 'livePane' | 'liveProcess'> {
  let inventory: ReturnType<typeof listPanes> | null = null
  return {
    livePane: async (runtime) => {
      // One inventory for the whole restore, not one `tmux list-panes` per row: this runs between the
      // control port binding and the first reconcile pass, i.e. on the app's "starting" screen.
      inventory ??= listPanes()
      const read = await inventory
      if (!read.ok) { inventory = null; return 'unknown' }
      // Only a harness pane counts (the inventory is already that whitelist): a new tmux server hands
      // out `%N` from zero again, and a stale id can name somebody's own shell.
      return read.panes.some((pane) => pane.tmuxPane === runtime.paneId)
    },
    liveProcess: async (entry, runtime) => {
      const found = await lookup(runtime.paneId, entry.engine)
      return found.ok ? found.identity : found.unknown ? 'unknown' : null
    },
  }
}

const DEFAULT_BUDGET_MS = 10 * 60_000
const DEFAULT_SETTLE_MS = 10_000
const SETTLE_POLL_MS = 500
const HOLD_SLACK_MS = 30_000

function tmuxRuntime(entry: RegisteredSession): TmuxRuntimeRef | null {
  const runtime = entry.runtimes.find((candidate): candidate is TmuxRuntimeRef => candidate.backend === 'tmux')
  return runtime ?? null
}

/** A service or tmux answer cannot act on a newer binding, launch, route or in-progress Stop. */
function restoreOwner(deps: RestoreAgentsDeps, entry: RegisteredSession, committing = false): () => boolean {
  const identity = (row: RegisteredSession | undefined) => row && JSON.stringify([
    row.registeredAt, row.boundAt, row.sessionId, row.engine, row.cwd, row.dsh, row.dshRuntime,
    row.runtimes.map(terminalRouteKey).sort(), row.launch, row.externalResume,
  ])
  const owned = identity(entry)
  const revision = deps.revision?.(entry.agentId)
  return () => identity(deps.registry.byAgent(entry.agentId)) === owned
    && (committing || (!deps.cancelled?.(entry.agentId) && deps.revision?.(entry.agentId) === revision))
}

/** A successful dispatch commits before a joining Stop captures its target. Other ownership changes still win. */
async function inPane<T>(deps: RestoreAgentsDeps, entry: RegisteredSession, current: () => boolean,
  work: (owns: () => boolean) => Promise<T>, cancelled: T): Promise<T> {
  const run = async () => {
    if (!current()) return cancelled
    return work(restoreOwner(deps, deps.registry.byAgent(entry.agentId)!, !!deps.paneOperation))
  }
  return deps.paneOperation ? deps.paneOperation(entry.agentId, run) : run()
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Whether tmux reported the pane's engine gone: the pane dead or forgotten, or its engine exited. A
 *  pane tmux could not read is not. */
function engineGone(state: Awaited<ReturnType<RestoreAgentsDeps['paneState']>>): boolean {
  if (state === 'unknown') return false
  return state === 'gone' || state.dead || state.engineExit != null
}

/** Watch a pane whose engine just appeared: 'settled' once it has stayed up for `settleMs`, 'gone' the
 *  moment tmux reports it dead or forgotten. A read that could not answer is no news: the relaunch it
 *  used to set off killed a resumed engine that was working, and started its conversation over. */
async function waitForSettle(deps: RestoreAgentsDeps, runtime: TmuxRuntimeRef, settleMs: number): Promise<'settled' | 'gone'> {
  const sleep = deps.sleep ?? defaultSleep
  const until = Date.now() + settleMs
  while (Date.now() < until) {
    await sleep(Math.min(SETTLE_POLL_MS, until - Date.now()))
    if (engineGone(await deps.paneState(runtime))) return 'gone'
  }
  return 'settled'
}

interface MissingPane {
  entry: RegisteredSession
  runtime: TmuxRuntimeRef
  alive?: true
  current: () => boolean
}

/** Allocate waiting shells before a held pass asks services. Recycled pane IDs are committed as one
 * synchronous set, never by saving a partial permutation over another row's stale route. */
async function allocateWaitingPanes(deps: RestoreAgentsDeps, missing: MissingPane[], summary: RestoreSummary): Promise<void> {
  const needed = missing.filter(item => !item.alive)
  if (!needed.length) return
  // An outside-selection row can still own a recycled ID. Stop and hook admission join the same
  // group for all these rows; unrelated durable registry writes are never held back while tmux runs.
  const ids: string[] = []
  for (const row of deps.registry.list()) {
    const runtime = tmuxRuntime(row)
    if (runtime && (!deps.livePane || await deps.livePane(runtime) !== true)) ids.push(row.agentId)
  }
  for (const item of needed) if (!ids.includes(item.entry.agentId)) ids.push(item.entry.agentId)
  if (ids.some(id => deps.paneBusy?.(id))) {
    summary.retry = true
    for (const item of needed) missing.splice(missing.indexOf(item), 1)
    return
  }
  const waiting = (entry: RegisteredSession): Extract<AgentLaunch, { state: 'held' }> => {
    if (entry.launch?.state === 'held') return entry.launch
    const needs = deps.needs?.(entry)
    const service = deps.defer ? typeof needs === 'string' ? needs : needs?.[0] : null
    return service ? heldLaunch(service) as Extract<AgentLaunch, { state: 'held' }>
      : { state: 'held', service: 'core', detail: 'Restoring this harness.' }
  }
  const work = async () => {
    const created = new Map<MissingPane, { runtime: TmuxRuntimeRef; owns: () => boolean }>()
    let next = 0
    const worker = async () => {
      while (next < needed.length) {
        // Stop bounds its join to commands already in flight, not N serial tmux timeouts.
        if (ids.some(id => deps.cancelled?.(id))) { summary.retry = true; return }
        const item = needed[next++]
        if (!item.current()) continue
        const owns = restoreOwner(deps, item.entry, true)
        const launch = waiting(item.entry)
        const allocated = await deps.createPane(item.entry, deps.waitingLaunch?.(item.entry, launch) ?? { argv: [] }, { current: item.current })
          .catch(error => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }))
        if (!allocated.ok) {
          if (owns()) summary.failed.push({ agentId: item.entry.agentId, reason: allocated.reason })
          continue
        }
        created.set(item, { runtime: allocated.runtime, owns })
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, needed.length) }, worker))
    const safe = new Map([...created].filter(([, result]) => result.owns()))
    // Fixed point: A cannot take B's old route when B cannot move because C's allocation failed.
    // Include outside-selection rows and duplicate replies; no asynchronous work follows this read.
    const rows = deps.registry.list()
    const proposed = [...safe.values()].map(value => terminalRouteKey(value.runtime))
    let changed = true
    while (changed) {
      changed = false
      for (const [item, result] of safe) {
        const key = terminalRouteKey(result.runtime)
        const duplicate = proposed.filter(route => route === key).length > 1
        const blocked = rows.some(row => row.agentId !== item.entry.agentId && row.runtimes.some(route => terminalRouteKey(route) === key)
          && ![...safe.keys()].some(other => other.entry.agentId === row.agentId))
        if (duplicate || blocked) { safe.delete(item); changed = true }
      }
    }
    await deps.registry.transaction(() => {
      for (const [item, result] of safe) {
        deps.registry.updateRuntimes(item.entry.agentId, [result.runtime], terminalRouteKey(result.runtime))
        deps.registry.setLaunch(item.entry.agentId, waiting(item.entry))
      }
    })
    for (const item of needed) {
      const accepted = safe.get(item)
      const row = deps.registry.byAgent(item.entry.agentId)
      if (accepted && row) {
        item.entry = { ...row }
        item.runtime = accepted.runtime
        item.alive = true
        item.current = restoreOwner(deps, item.entry)
      } else {
        const allocated = created.get(item)
        if (allocated) deps.log(`[restore] agent ${item.entry.agentId} · waiting pane ${allocated.runtime.paneId} could not be committed without changing another owner; left intact for review`)
        missing.splice(missing.indexOf(item), 1)
        if (item.current()) {
          const reason = allocated ? `Waiting for safe pane recovery. Pane ${allocated.runtime.paneId} could not be assigned without changing another harness; it was left intact for review.`
            : 'Waiting for pane recovery. The pane could not be allocated yet.'
          deps.registry.setLaunch(item.entry.agentId, { ...waiting(item.entry), detail: reason })
          summary.held.push(item.entry.agentId)
        }
      }
    }
  }
  if (deps.paneAllocations) await deps.paneAllocations(ids, work)
  else await work()
}

/**
 * Recreate every missing pane, then return. Binding each pane's engine process continues in the
 * background; the summary says which agents that is happening for.
 */
export async function restoreAgents(input: RestoreAgentsDeps): Promise<RestoreSummary> {
  const deps = { ...input, ...input.survey?.() }
  const summary: RestoreSummary = { restored: [], skipped: [], failed: [], held: [], unsurveyed: [] }
  const patience = { left: true }
  /** `alive`: a held agent's waiting pane, which its launch goes into rather than a new one. */
  const missing: MissingPane[] = []

  // Per row, because a survey that gives up on the first bad one gives up on every row behind it —
  // one pane whose `tmux list-panes` timed out, or one archive that could not be written, and the
  // whole desk comes back empty. A row that cannot be surveyed is reported and the rest go on.
  for (const saved of deps.registry.list()) {
   const entry = { ...saved }
   if (deps.only && !deps.only.has(entry.agentId)) continue
   const current = restoreOwner(deps, entry)
   if (!current()) {
     if (entry.launch?.state === 'held') summary.retry = true
     continue
   }
   try {
    const runtime = tmuxRuntime(entry)
    if (entry.externalResume?.phase === 'cancelled') { summary.skipped.push({ agentId: entry.agentId, reason: 'external adoption cancelled' }); continue }
    if (!runtime) { summary.skipped.push({ agentId: entry.agentId, reason: 'no tmux pane' }); continue }
    if (entry.launch?.state === 'failed') { summary.skipped.push({ agentId: entry.agentId, reason: 'last launch failed' }); continue }
    // Held: its pane, alive, runs no engine on purpose, so it is neither a stopped engine nor a terminal. Its
    // launch goes into that pane, or a new one if the pane went (a reboot).
    if (entry.launch?.state === 'held') {
      const alive = deps.livePane ? await surveyed(deps, patience, () => deps.livePane!(runtime)) : false
      if (current()) missing.push({ entry, runtime, current, ...(alive ? { alive: true as const } : {}) })
      continue
    }
    // A pane is alive as long as tmux has it, whatever runs in it: every pane is a shell with the
    // engine inside, so an engine that exited while the daemon was down left a shell at its prompt
    // — exactly the exit the reconciler would have caught — and the row is put back to a terminal
    // here rather than a second pane being opened beside the first. A bare terminal has no engine
    // process to look for at all.
    const paneAlive = deps.livePane ? await surveyed(deps, patience, () => deps.livePane!(runtime)) : false
    if (!current()) continue
    if (paneAlive) {
      const engineLive = isTerminalEngine(entry.engine) ? null : await surveyed(deps, patience, () => deps.liveProcess(entry, runtime))
      if (!current()) continue
      if (engineLive) {
        // Still running. A row that lost its identity without losing its pane (a reboot the boot
        // clock misread; a tmux server that outlived the daemon) is re-identified right here, so the
        // reconciler adopts it by process instead of treating it as an unbound route.
        if (!entry.processIdentity) deps.registry.updateProcessIdentity(entry.agentId, engineLive)
      } else if (entry.externalResume?.phase === 'admitted' && entry.launch?.state === 'starting') {
        // The dispatch journal precedes tmux. If its exact waiting shell remains, no engine ran;
        // otherwise an installer/engine may still be starting: observe it, never respawn over it.
        const waiting = await deps.waitingPane?.(runtime, entry.externalResume.token)
        if (!current()) continue
        if (waiting === true) {
          const row = deps.registry.setLaunch(entry.agentId, { state: 'held', service: 'search', detail: 'Restoring this conversation.' })!
          const copy = { ...row }
          missing.push({ entry: copy, runtime, alive: true, current: restoreOwner(deps, copy) })
        } else {
          const route = terminalRouteKey(runtime)
          const release = deps.holdRoute(route, (deps.budgetMs ?? DEFAULT_BUDGET_MS) + HOLD_SLACK_MS) ?? (() => deps.releaseRoute(route))
          void watchRestoredPane(deps, entry, runtime, true, deps.budgetMs ?? DEFAULT_BUDGET_MS, current, release)
        }
      } else if (!isTerminalEngine(entry.engine)) {
        if (deps.retainStopped) deps.retainStopped(entry, true)
        else deps.registry.releaseEngine(entry.agentId)
        deps.log(`[restore] ${entry.engine} → terminal · agent ${entry.agentId} · its engine exited while the daemon was down`)
      }
      continue
    }
    // A strict-resume row that was never CONFIRMED (its launch still `starting` when the daemon
    // died) goes back to the archive for an explicit Open: nothing proved the engine ever loaded
    // that conversation, and this pass has no way to ask. One that was confirmed — hook received,
    // engine bound, `launch: ready` — was a live agent like any other on the desk, and its tile
    // comes back the same way the others do: the exact resume below, never the fresh fallback
    // (`relaunchFresh` refuses it for a resume-only row). Measured: a harness opened from the
    // catalog, then `harness stop` + `tmux kill-server` + app relaunch — every other tile came
    // back, this one sat on "no verified terminal pane" with nothing to press.
    if (entry.resumeOnly && !entry.externalResume && entry.launch?.state !== 'ready' && deps.retainStopped) {
      deps.retainStopped(entry, false)
      summary.skipped.push({ agentId: entry.agentId, reason: 'saved conversation awaits explicit Open' })
      continue
    }
    // A terminal whose pane is gone comes back as a terminal — unless the engine typed into it keeps
    // its conversation on disk under a recorded id. Then the session did NOT go with the pane, and
    // the engine comes back resuming it, in a shell pane as before (it drops to that shell on exit).
    // Measured on Harness OS: OpenCode, which its welcome flow types into a terminal, came back from
    // every reboot as a bare prompt with the conversation unbound, while Claude came back. A resume
    // the engine refuses falls back to the shell, never a fresh engine (`relaunchFresh`).
    if (entry.terminalHost && !resumesConversation(entry.engine, entry.sessionId)) {
      if (!isTerminalEngine(entry.engine)) deps.registry.releaseEngine(entry.agentId)
      const shell = deps.registry.byAgent(entry.agentId) ?? entry
      missing.push({ entry: { ...shell }, runtime, current: restoreOwner(deps, shell) })
      continue
    }
    const live = await surveyed(deps, patience, () => deps.liveProcess(entry, runtime))
    if (!current()) continue
    if (live) {
      // Still running. A row that lost its identity without losing its pane (a reboot the boot
      // clock misread; a tmux server that outlived the daemon) is re-identified right here, so the
      // reconciler adopts it by process instead of treating it as an unbound route.
      if (!entry.processIdentity) deps.registry.updateProcessIdentity(entry.agentId, live)
      continue
    }
    // A grid row without its launch: written before the credential was persisted, or a grid agent
    // discovery adopted from a pane the daemon never launched (it saw the endpoint, never the key).
    // Launching it on the engine's own login instead would spend the wrong account while looking
    // identical — refusing is the rule gridLaunch.ts already sets. Marked, not just skipped: the row
    // has no pane to come back to, and the app should be able to say why before discovery lets it go.
    if (entry.grid && !entry.gridLaunch) {
      const reason = 'grid agent; credential not persisted'
      summary.skipped.push({ agentId: entry.agentId, reason })
      deps.registry.setLaunch(entry.agentId, {
        state: 'failed',
        error: GRID_CREDENTIAL_REQUIRED,
        detail: `${entry.engine} was on a grid, but this machine no longer holds the credential to put it back there. Create it again from the app.`,
      })
      deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · skipped · ${reason}`)
      continue
    }
    missing.push({ entry, runtime, current })
   } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (error instanceof Unsurveyed) summary.unsurveyed.push(entry.agentId)
    else summary.failed.push({ agentId: entry.agentId, reason })
    deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · could not be surveyed · ${reason}`)
   }
  }
  if (!missing.length) return summary
  await allocateWaitingPanes(deps, missing, summary)

  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS
  const watches: Array<() => Promise<void>> = []
  /** The services this pass could not ask: every later agent that needs one is held without asking. */
  const unavailable = new Map<string, string | undefined>()
  /** Held in its waiting pane: the one it has, or a new one. False when no pane could be opened for it. */
  const hold = async (entry: RegisteredSession, runtime: TmuxRuntimeRef, alive: boolean, current: () => boolean, service: string, detail?: string): Promise<boolean> => inPane(deps, entry, current, async owns => {
    const launch = { ...heldLaunch(service), ...(detail ? { detail } : {}) } as Extract<AgentLaunch, { state: 'held' }>
    let pane = runtime
    if (!alive) {
      const created = await deps.createPane(entry, deps.waitingLaunch?.(entry, launch) ?? { argv: [] }, { current })
      if (!owns()) {
        if (created.ok) deps.log(`[restore] agent ${entry.agentId} · waiting pane ${created.runtime.paneId} allocated after ownership changed; left intact for review`)
        return false
      }
      if (!created.ok) {
        summary.failed.push({ agentId: entry.agentId, reason: created.reason })
        deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · could not open a pane to wait in · ${created.reason}`)
        return false
      }
      pane = created.runtime
      deps.registry.updateRuntimes(entry.agentId, [pane], terminalRouteKey(pane))
    } else if (entry.launch?.state === 'held' && entry.launch.detail !== launch.detail && deps.waitingLaunch) {
      // A grid harness can finish waiting for models and then wait for Store preparation. Its pane
      // must show the current reason as well as its row, including an unconfirmed workspace write.
      await deps.respawn(pane, deps.waitingLaunch(entry, launch), { current, ...(entry.externalResume ? { expectedHeldToken: entry.externalResume.token } : {}) })
      if (!owns()) return false
    }
    deps.registry.setLaunch(entry.agentId, launch)
    summary.held.push(entry.agentId)
    deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · held in pane ${pane.paneId} · waiting for ${service}`)
    return true
  }, false)
  // Waiting panes already own their committed routes. No service or engine preparation holds saves.
  {
    for (const { entry, runtime: dead, alive, current } of missing) {
      if (!current() || (deps.only && entry.launch?.state !== 'held')) continue
      // No process survives its pane; clear it now or discovery would refuse to adopt the new one
      // into this agent (route adoption requires either no identity or a matching pid).
      deps.registry.clearProcessIdentity(entry.agentId)
      const resumeSessionId = entry.sessionId || undefined
      if (entry.resumeOnly && !resumeSessionId && !isTerminalEngine(entry.engine)) {
        const reason = 'The saved conversation is no longer available. Start a new conversation separately.'
        summary.failed.push({ agentId: entry.agentId, reason })
        deps.registry.setLaunch(entry.agentId, { state: 'failed', error: 'RESUME_UNAVAILABLE', detail: reason })
        if (alive) await deps.killPane?.(dead)
        continue
      }
      // Never asked at boot, and asked at most once a pass: the core's readiness never waits on a service.
      const needed = deps.needs?.(entry) ?? []
      const services = typeof needed === 'string' ? [needed] : needed
      const waitingFor = deps.defer ? services[0] : services.find(service => unavailable.has(service))
      if (waitingFor) {
        await hold(entry, dead, !!alive, current, waitingFor, unavailable.get(waitingFor))
        continue
      }
      const launch = await deps.buildLaunch(entry, { ...(resumeSessionId ? { resumeSessionId } : {}), current })
      // Stop/close and a newer binding win over a preparation that was already in flight.
      if (!current() || 'cancelled' in launch) continue
      if ('held' in launch) {
        if (launch.holdScope !== 'workspace') unavailable.set(launch.held, launch.detail)
        await hold(entry, dead, !!alive, current, launch.held, launch.detail)
        continue
      }
      if ('error' in launch) {
        summary.failed.push({ agentId: entry.agentId, reason: launch.detail })
        deps.registry.setLaunch(entry.agentId, { state: 'failed', error: launch.error, detail: launch.detail })
        deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · could not build its launch · ${launch.detail}`)
        if (alive) await deps.killPane?.(dead)
        continue
      }
      await inPane(deps, entry, current, async initialOwner => {
        let owns = initialOwner
        const pane = dead
        const existing = !!alive
        const dispatchCurrent = () => owns() && !deps.cancelled?.(entry.agentId)
        if (!dispatchCurrent()) return
        let release: (() => void) | undefined
        if (existing && !isTerminalEngine(entry.engine)) {
          const route = terminalRouteKey(pane)
          release = deps.holdRoute(route, budgetMs + HOLD_SLACK_MS) ?? (() => deps.releaseRoute(route))
        }
        let watching = false
        try {
          const control = { current: dispatchCurrent, ...(entry.externalResume ? { expectedHeldToken: entry.externalResume.token } : {}), onDispatch: () => {
            if (entry.externalResume?.phase === 'admitted') {
              const committed = deps.registry.beginExternalDispatch?.(entry.agentId)
              if (!committed) throw new Error('External resume dispatch could not be committed')
              owns = restoreOwner(deps, committed, !!deps.paneOperation)
            }
            // Before the engine can hook/attach, not after tmux's asynchronous reply.
            if (resumeSessionId) deps.engineStarted?.(resumeSessionId)
          } }
          const created = await (existing
            ? deps.respawn(pane, launch, control).then(spawned => spawned.ok
              ? { ok: true as const, runtime: pane } : { ok: false as const, reason: spawned.reason ?? 'the pane could not be reused' })
            : deps.createPane(entry, launch, control)).catch(error => ({ ok: false as const, reason: String(error) }))
          if (!owns()) return
          if (!created.ok) {
            if (!dispatchCurrent()) return
            if (entry.externalResume) {
              const row = deps.registry.byAgent(entry.agentId)!
              if (row.launch?.state === 'held') summary.retry = true
              else {
                // A journaled dispatch can fail before or after tmux received it. Retry only while
                // its exact inert shell proves that no engine ran; otherwise observe the launch.
                const waiting = await deps.waitingPane?.(pane, entry.externalResume.token)
                if (!dispatchCurrent()) return
                if (waiting === true) {
                  deps.registry.setLaunch(entry.agentId, { state: 'held', service: 'search', detail: 'Waiting to restore this conversation’s terminal.' })
                  summary.retry = true
                } else {
                  const currentWatch = restoreOwner(deps, deps.registry.byAgent(entry.agentId)!)
                  const releaseWatch = release!
                  watching = true
                  watches.push(() => watchRestoredPane(deps, entry, pane, true, budgetMs, currentWatch, releaseWatch))
                }
              }
            }
            summary.failed.push({ agentId: entry.agentId, reason: created.reason })
            deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · could not open a pane · ${created.reason}`)
            return
          }
          const key = terminalRouteKey(created.runtime)
          if (!isTerminalEngine(entry.engine)) release ??= deps.holdRoute(key, budgetMs + HOLD_SLACK_MS) ?? (() => deps.releaseRoute(key))
          if (isTerminalEngine(entry.engine)) {
            deps.registry.setLaunch(entry.agentId, { state: 'ready' })
            await deps.clearRemainOnExit(created.runtime)
            summary.restored.push(entry.agentId)
            deps.log(`[restore] terminal · agent ${entry.agentId} · pane ${dead.paneId} → ${created.runtime.paneId}`)
            return
          }
          deps.registry.setLaunch(entry.agentId, { state: 'starting' })
          summary.restored.push(entry.agentId)
          deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · pane ${dead.paneId} → ${created.runtime.paneId}`
            + (resumeSessionId ? ` · resuming ${resumeSessionId.slice(0, 8)}` : ' · fresh session')
            + (entry.gridLaunch ? ` · grid ${entry.gridLaunch.networkName}` : ''))
          const currentWatch = restoreOwner(deps, deps.registry.byAgent(entry.agentId)!)
          const releaseWatch = release!
          watching = true
          watches.push(() => watchRestoredPane(deps, entry, created.runtime, !!resumeSessionId, budgetMs, currentWatch, releaseWatch))
        } finally { if (!watching) release?.() }
      }, undefined)
    }
  }
  for (const watch of watches) void watch()
  return summary
}

async function watchRestoredPane(
  deps: RestoreAgentsDeps,
  entry: RegisteredSession,
  runtime: TmuxRuntimeRef,
  resuming: boolean,
  budgetMs: number,
  current: () => boolean,
  release: () => void,
): Promise<void> {
  const { agentId, engine } = entry
  const key = terminalRouteKey(runtime)
  const sleep = deps.sleep ?? defaultSleep
  const fail = (error: string, detail: string): void => {
    if (!current()) return
    deps.registry.setLaunch(agentId, { state: 'failed', error, detail })
    deps.log(`[restore] ${engine} · agent ${agentId} · failed · ${detail}`)
  }
  /** Its fresh launch asks a service that could not be asked: held in this pane, never failed. */
  const holdHere = async ({ held: service, detail }: Extract<RestoreLaunchResult, { held: string }>): Promise<false> => inPane(deps, entry, current, async owns => {
    if (!current()) return false
    const launch = { ...heldLaunch(service), ...(detail ? { detail } : {}) } as Extract<AgentLaunch, { state: 'held' }>
    const spawned = await deps.respawn(runtime, deps.waitingLaunch?.(entry, launch) ?? { argv: [] }, { current })
      .catch(error => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
    if (!owns()) return false
    if (!spawned.ok) {
      const detail = `${launch.detail} Its waiting pane could not be shown: ${spawned.reason ?? 'unknown reason'}. Pane recovery is still pending.`
      deps.registry.setLaunch(agentId, { ...launch, detail })
      deps.log(`[restore] ${engine} · agent ${agentId} · held · ${detail}`)
      return false
    }
    deps.registry.setLaunch(agentId, launch)
    deps.log(`[restore] ${engine} · agent ${agentId} · held · waiting for ${service}`)
    return false as const
  }, false as const)
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS
  let mayRetryFresh = resuming
  /** The pane's engine is gone. True when a fresh relaunch is now under way, false when this is the end. */
  const relaunchFresh = async (): Promise<boolean> => {
    if (!current()) return false
    if (entry.resumeOnly) {
      fail('RESUME_FAILED', `${engine} could not resume the saved conversation. See the terminal output, or start a new conversation separately.`)
      return false
    }
    if (!mayRetryFresh) {
      fail('ENGINE_DID_NOT_START', `${engine} exited before its engine process became ready. See the terminal output for details.`)
      return false
    }
    // A terminal that was resuming an engine typed into it goes back to being that terminal: nobody
    // asked this pane for a new conversation. The one it held is kept as a stopped harness.
    if (entry.terminalHost) {
      mayRetryFresh = false
      deps.log(`[restore] ${engine} · agent ${agentId} · did not come back up resuming its session — back to the terminal`)
      const shell = { ...entry, engine: 'terminal' as const, sessionId: '', subscriptionModel: null }
      const launch = await deps.buildLaunch(shell, { current })
      if (!current() || 'cancelled' in launch) return false
      if ('held' in launch) return holdHere(launch)
      if ('error' in launch) {
        fail(launch.error, launch.detail)
        return false
      }
      return inPane(deps, entry, current, async () => {
        deps.keepAbandoned?.({ ...entry })
        deps.registry.releaseEngine(agentId)
        current = restoreOwner(deps, deps.registry.byAgent(agentId)!)
        const owns = restoreOwner(deps, deps.registry.byAgent(agentId)!, !!deps.paneOperation)
        const spawned = await deps.respawn(runtime, launch, { current })
        if (!owns()) return false
        if (!spawned.ok) {
          fail('ENGINE_DID_NOT_START', `The terminal could not be reopened: ${spawned.reason ?? 'unknown reason'}`)
          return false
        }
        deps.registry.setLaunch(agentId, { state: 'ready' })
        await deps.clearRemainOnExit(runtime)
        return false
      }, false)
    }
    // A resume id the engine no longer honours is not worth a dead agent: the row's name comes
    // along to the agent itself, the stale binding goes, and the engine gets one fresh start.
    mayRetryFresh = false
    deps.log(`[restore] ${engine} · agent ${agentId} · did not come back up resuming its session — retrying fresh`)
    const launch = await deps.buildLaunch(entry, { current })
    if (!current() || 'cancelled' in launch) return false
    if ('held' in launch) return holdHere(launch)
    if ('error' in launch) {
      fail(launch.error, launch.detail)
      return false
    }
    return inPane(deps, entry, current, async () => {
      // Preparation is confirmed before archiving or unbinding. A service outage preserves the
      // conversation held here, including when a refused resume falls back to a fresh launch.
      deps.keepAbandoned?.({ ...entry })
      deps.registry.inheritName(entry.sessionId, agentId)
      deps.registry.unbindSession(entry.sessionId)
      current = restoreOwner(deps, deps.registry.byAgent(agentId)!)
      const owns = restoreOwner(deps, deps.registry.byAgent(agentId)!, !!deps.paneOperation)
      // Renew before dispatch, so discovery cannot bind the new engine before its tmux reply.
      release = deps.holdRoute(key, budgetMs + HOLD_SLACK_MS) ?? (() => deps.releaseRoute(key))
      const spawned = await deps.respawn(runtime, launch, { current })
      if (!owns()) return false
      if (!spawned.ok) {
        fail('ENGINE_DID_NOT_START', `${engine} could not be relaunched fresh: ${spawned.reason ?? 'unknown reason'}`)
        return false
      }
      return true
    }, false)
  }
  try {
    const startedAt = Date.now()
    let delayMs = 50
    while (Date.now() - startedAt < budgetMs) {
      if (!current()) return
      const identity = await deps.probeProcess(runtime, engine)
      if (!current()) return
      if (identity) {
        deps.registry.updateProcessIdentity(agentId, identity)
        // A resume the engine rejects does not fail to start — it starts, prints why, and exits a
        // few seconds later. Keep the pane (and the fallback) for a settling window before handing
        // it over; a pane let go at first sight of the process vanished with the engine and took
        // the agent with it (measured: claude resuming a conversation another client still held).
        const settled = await waitForSettle(deps, runtime, settleMs)
        if (!current()) return
        if (settled === 'gone') {
          if (!await relaunchFresh()) return
          delayMs = 50
          continue
        }
        await deps.clearRemainOnExit(runtime)
        if (!current()) return
        // Release BEFORE the hint: the pass it triggers is the one that must see this route again.
        release()
        await deps.triggerHint(runtime, engine)
        deps.log(`[restore] ${engine} · agent ${agentId} · engine up · ${Date.now() - startedAt}ms`)
        return
      }
      const state = await deps.paneState(runtime)
      if (!current()) return
      if (state === 'gone') {
        fail('ENGINE_DID_NOT_START', `${engine}'s restored pane disappeared before its engine process became ready.`)
        return
      }
      // A pane tmux could not read is asked again, like one still starting.
      if (engineGone(state)) {
        if (!await relaunchFresh()) return
        delayMs = 50
        continue
      }
      await sleep(delayMs)
      delayMs = Math.min(delayMs * 2, 750)
    }
    fail('START_TIMEOUT', `${engine} did not expose an engine process within ${Math.round(budgetMs / 60_000)} minutes. The terminal remains available.`)
  } catch (error) {
    deps.log(`[restore] ${engine} · agent ${agentId} · watch failed · ${error instanceof Error ? error.message : error}`)
  } finally {
    release()
  }
}
