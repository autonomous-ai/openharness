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
 *   1. Every missing pane is recreated inside ONE registry transaction. A new tmux server hands out
 *      pane ids from `%0` again, so a restored pane's id can equal another stale row's dead pane —
 *      and `registry.save()` evicts whichever row loses that collision. Deferring the save until
 *      every row holds its new pane is what keeps the second row alive.
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
 */

import { isTerminalEngine, type AgentEngine } from '../engines/types.js'
import type { AgentLaunch, ProcessIdentity, RegisteredSession } from './registry.js'
import type { TerminalRuntimeRef, TmuxRuntimeRef } from './terminalTypes.js'
import { terminalRouteKey } from './terminalRuntime.js'
import { resumesConversation } from './resumeCapability.js'

export interface RestoreLaunch {
  argv: string[]
  env?: Record<string, string>
}

export type RestoreLaunchResult = RestoreLaunch | { error: string; detail: string }

/** The row knows it was on a grid but not how to get back there. */
export const GRID_CREDENTIAL_REQUIRED = 'GRID_CREDENTIAL_REQUIRED'

export interface RestoreAgentsDeps {
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
  livePane?: (runtime: TmuxRuntimeRef) => Promise<boolean | 'unknown'>
  /** The engine process still running in this row's pane, or null when tmux does not know the pane
   *  at all — including when no tmux server is running — or the pane has become something else.
   *  `'unknown'` when tmux or `ps` could not be asked. */
  liveProcess: (entry: RegisteredSession, runtime: TmuxRuntimeRef) => Promise<ProcessIdentity | null | 'unknown'>
  /** The pane's launch — engine argv plus whatever puts it back on its grid / profile. A grid the
   *  machine cannot honour (unsupported engine, tmux too old, config dir unwritable) is a refusal. */
  buildLaunch: (entry: RegisteredSession, opts: { resumeSessionId?: string }) => Promise<RestoreLaunchResult>
  createPane: (entry: RegisteredSession, launch: RestoreLaunch) => Promise<
    | { ok: true; runtime: TmuxRuntimeRef }
    | { ok: false; reason: string }
  >
  /** `tmux respawn-pane` over the restored pane — the resume → fresh fallback. */
  respawn: (runtime: TmuxRuntimeRef, launch: RestoreLaunch) => Promise<{ ok: boolean; reason?: string }>
  /** A pane was rebuilt on this conversation: its engine is a new one (core/transcripts/relaunch.ts). */
  engineStarted?: (sessionId: string) => void
  /** One probe of the pane for a recognizable engine process. */
  probeProcess: (runtime: TmuxRuntimeRef, engine: AgentEngine) => Promise<ProcessIdentity | null>
  /** `'gone'` when tmux no longer knows the pane, `'unknown'` when it could not be asked (`tmuxPaneState`).
   *  `engineExit` set: the engine left and the pane is a shell now (`ENGINE_EXIT_PANE_OPTION`), which for
   *  a restore is the same news as `dead`. */
  paneState: (runtime: TmuxRuntimeRef) => Promise<{ dead: boolean; engineExit?: number | null } | 'gone' | 'unknown'>
  clearRemainOnExit: (runtime: TmuxRuntimeRef) => Promise<void>
  holdRoute: (routeKey: string, autoReleaseMs: number) => void
  releaseRoute: (routeKey: string) => void
  triggerHint: (runtime: TmuxRuntimeRef, engine: AgentEngine) => Promise<void>
  log: (message: string) => void
  /** How long a restored pane may take to show an engine process. Default matches `agent_create`. */
  budgetMs?: number
  /** How long the engine must stay up after appearing before the pane is handed over. */
  settleMs?: number
  /** The waits between asking a survey probe again (`SURVEY_RETRY_MS`). */
  surveyRetryMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}

export interface RestoreSummary {
  /** Agents whose pane was recreated; their engine process is bound in the background. */
  restored: string[]
  skipped: Array<{ agentId: string; reason: string }>
  failed: Array<{ agentId: string; reason: string }>
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

/**
 * Recreate every missing pane, then return. Binding each pane's engine process continues in the
 * background; the summary says which agents that is happening for.
 */
export async function restoreAgents(deps: RestoreAgentsDeps): Promise<RestoreSummary> {
  const summary: RestoreSummary = { restored: [], skipped: [], failed: [], unsurveyed: [] }
  const patience = { left: true }
  const missing: Array<{ entry: RegisteredSession; runtime: TmuxRuntimeRef }> = []

  // Per row, because a survey that gives up on the first bad one gives up on every row behind it —
  // one pane whose `tmux list-panes` timed out, or one archive that could not be written, and the
  // whole desk comes back empty. A row that cannot be surveyed is reported and the rest go on.
  for (const entry of deps.registry.list()) {
   try {
    const runtime = tmuxRuntime(entry)
    if (!runtime) { summary.skipped.push({ agentId: entry.agentId, reason: 'no tmux pane' }); continue }
    if (entry.launch?.state === 'failed') { summary.skipped.push({ agentId: entry.agentId, reason: 'last launch failed' }); continue }
    // A pane is alive as long as tmux has it, whatever runs in it: every pane is a shell with the
    // engine inside, so an engine that exited while the daemon was down left a shell at its prompt
    // — exactly the exit the reconciler would have caught — and the row is put back to a terminal
    // here rather than a second pane being opened beside the first. A bare terminal has no engine
    // process to look for at all.
    const paneAlive = deps.livePane ? await surveyed(deps, patience, () => deps.livePane!(runtime)) : false
    if (paneAlive) {
      const engineLive = isTerminalEngine(entry.engine) ? null : await surveyed(deps, patience, () => deps.liveProcess(entry, runtime))
      if (engineLive) {
        // Still running. A row that lost its identity without losing its pane (a reboot the boot
        // clock misread; a tmux server that outlived the daemon) is re-identified right here, so the
        // reconciler adopts it by process instead of treating it as an unbound route.
        if (!entry.processIdentity) deps.registry.updateProcessIdentity(entry.agentId, engineLive)
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
    if (entry.resumeOnly && entry.launch?.state !== 'ready' && deps.retainStopped) {
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
      missing.push({ entry: deps.registry.byAgent(entry.agentId) ?? entry, runtime })
      continue
    }
    const live = await surveyed(deps, patience, () => deps.liveProcess(entry, runtime))
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
    missing.push({ entry, runtime })
   } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (error instanceof Unsurveyed) summary.unsurveyed.push(entry.agentId)
    else summary.failed.push({ agentId: entry.agentId, reason })
    deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · could not be surveyed · ${reason}`)
   }
  }
  if (!missing.length) return summary

  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS
  const watches: Array<() => Promise<void>> = []
  await deps.registry.transaction(async () => {
    for (const { entry, runtime: dead } of missing) {
      // No process survives its pane; clear it now or discovery would refuse to adopt the new one
      // into this agent (route adoption requires either no identity or a matching pid).
      deps.registry.clearProcessIdentity(entry.agentId)
      const resumeSessionId = entry.sessionId || undefined
      if (entry.resumeOnly && !resumeSessionId && !isTerminalEngine(entry.engine)) {
        const reason = 'The saved conversation is no longer available. Start a new conversation separately.'
        summary.failed.push({ agentId: entry.agentId, reason })
        deps.registry.setLaunch(entry.agentId, { state: 'failed', error: 'RESUME_UNAVAILABLE', detail: reason })
        continue
      }
      const launch = await deps.buildLaunch(entry, resumeSessionId ? { resumeSessionId } : {})
      if ('error' in launch) {
        summary.failed.push({ agentId: entry.agentId, reason: launch.detail })
        deps.registry.setLaunch(entry.agentId, { state: 'failed', error: launch.error, detail: launch.detail })
        deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · could not build its launch · ${launch.detail}`)
        continue
      }
      const created = await deps.createPane(entry, launch)
      if (!created.ok) {
        summary.failed.push({ agentId: entry.agentId, reason: created.reason })
        deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · could not open a pane · ${created.reason}`)
        continue
      }
      // A new engine on the conversation: a turn it left open is over (core/transcripts/relaunch.ts).
      if (resumeSessionId) deps.engineStarted?.(resumeSessionId)
      const key = terminalRouteKey(created.runtime)
      // A terminal is up the moment its pane is — no engine to wait for, no route to hold.
      if (isTerminalEngine(entry.engine)) {
        deps.registry.updateRuntimes(entry.agentId, [created.runtime], key)
        deps.registry.setLaunch(entry.agentId, { state: 'ready' })
        await deps.clearRemainOnExit(created.runtime)
        summary.restored.push(entry.agentId)
        deps.log(`[restore] terminal · agent ${entry.agentId} · pane ${dead.paneId} → ${created.runtime.paneId}`)
        continue
      }
      deps.holdRoute(key, budgetMs + HOLD_SLACK_MS)
      deps.registry.updateRuntimes(entry.agentId, [created.runtime], key)
      deps.registry.setLaunch(entry.agentId, { state: 'starting' })
      summary.restored.push(entry.agentId)
      // The grid is named because the pane gives nothing away: the engine looks exactly like one on
      // its own login. The key is never printed.
      deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · pane ${dead.paneId} → ${created.runtime.paneId}`
        + (resumeSessionId ? ` · resuming ${resumeSessionId.slice(0, 8)}` : ' · fresh session')
        + (entry.gridLaunch ? ` · grid ${entry.gridLaunch.networkName}` : ''))
      watches.push(() => watchRestoredPane(deps, entry, created.runtime, !!resumeSessionId, budgetMs))
    }
  })
  for (const watch of watches) void watch()
  return summary
}

async function watchRestoredPane(
  deps: RestoreAgentsDeps,
  entry: RegisteredSession,
  runtime: TmuxRuntimeRef,
  resuming: boolean,
  budgetMs: number,
): Promise<void> {
  const { agentId, engine } = entry
  const key = terminalRouteKey(runtime)
  const sleep = deps.sleep ?? defaultSleep
  const fail = (error: string, detail: string): void => {
    deps.registry.setLaunch(agentId, { state: 'failed', error, detail })
    deps.log(`[restore] ${engine} · agent ${agentId} · failed · ${detail}`)
  }
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS
  let mayRetryFresh = resuming
  /** The pane's engine is gone. True when a fresh relaunch is now under way, false when this is the end. */
  const relaunchFresh = async (): Promise<boolean> => {
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
      deps.keepAbandoned?.({ ...entry })
      deps.registry.releaseEngine(agentId)
      const launch = await deps.buildLaunch(deps.registry.byAgent(agentId) ?? { ...entry, engine: 'terminal' }, {})
      if ('error' in launch) {
        fail(launch.error, launch.detail)
        return false
      }
      const spawned = await deps.respawn(runtime, launch)
      if (!spawned.ok) {
        fail('ENGINE_DID_NOT_START', `The terminal could not be reopened: ${spawned.reason ?? 'unknown reason'}`)
        return false
      }
      deps.registry.setLaunch(agentId, { state: 'ready' })
      await deps.clearRemainOnExit(runtime)
      return false
    }
    // A resume id the engine no longer honours is not worth a dead agent: the row's name comes
    // along to the agent itself, the stale binding goes, and the engine gets one fresh start.
    mayRetryFresh = false
    deps.log(`[restore] ${engine} · agent ${agentId} · did not come back up resuming its session — retrying fresh`)
    // Unbound below and replaced by the fresh start's own, the conversation the agent was in is kept as
    // a stopped harness first, to read and to resume once the engine can again.
    deps.keepAbandoned?.({ ...entry })
    deps.registry.inheritName(entry.sessionId, agentId)
    deps.registry.unbindSession(entry.sessionId)
    const launch = await deps.buildLaunch(entry, {})
    if ('error' in launch) {
      fail(launch.error, launch.detail)
      return false
    }
    const spawned = await deps.respawn(runtime, launch)
    if (!spawned.ok) {
      fail('ENGINE_DID_NOT_START', `${engine} could not be relaunched fresh: ${spawned.reason ?? 'unknown reason'}`)
      return false
    }
    // The fresh start gets the full budget again; the hold's auto-release must outlast it.
    deps.holdRoute(key, budgetMs + HOLD_SLACK_MS)
    return true
  }
  try {
    const startedAt = Date.now()
    let delayMs = 50
    while (Date.now() - startedAt < budgetMs) {
      if (!deps.registry.byAgent(agentId)) return
      const identity = await deps.probeProcess(runtime, engine)
      if (identity) {
        deps.registry.updateProcessIdentity(agentId, identity)
        // A resume the engine rejects does not fail to start — it starts, prints why, and exits a
        // few seconds later. Keep the pane (and the fallback) for a settling window before handing
        // it over; a pane let go at first sight of the process vanished with the engine and took
        // the agent with it (measured: claude resuming a conversation another client still held).
        const settled = await waitForSettle(deps, runtime, settleMs)
        if (settled === 'gone') {
          if (!await relaunchFresh()) return
          delayMs = 50
          continue
        }
        await deps.clearRemainOnExit(runtime)
        // Release BEFORE the hint: the pass it triggers is the one that must see this route again.
        deps.releaseRoute(key)
        await deps.triggerHint(runtime, engine)
        deps.log(`[restore] ${engine} · agent ${agentId} · engine up · ${Date.now() - startedAt}ms`)
        return
      }
      const state = await deps.paneState(runtime)
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
    deps.releaseRoute(key)
  }
}
