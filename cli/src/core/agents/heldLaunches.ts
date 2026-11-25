/**
 * Agents held until the service their launch asks is ready (docs/design/2026-10-08-launch-port.md, "Held").
 *
 * A launch that asks a service for its part (a grid's or a saved API's, from models) is never waited on before the
 * core is ready: the boot's restore holds the agent in a pane that says what it waits for (lib/restoreAgents.ts
 * `defer`), and the pass here launches it into that pane once the core is up. A service that cannot be asked then
 * keeps it held while sibling agents continue. Held is never failed and never retired: discovery sees
 * its pane alive, and every later pass tries again. A pass runs:
 *
 * - once the core is ready, for every held agent;
 * - each time a service connects (a restarted one too), for the agents held for it;
 * - when a person restarts a held agent, for that one.
 *
 * A separate flight for each agent, after the boot: two passes never dispatch the same agent twice. An agent
 * the person stopped or closed meanwhile is no longer held, and is left alone.
 *
 * A launch the native guard held (`guardHeld`: its executable or hooks changed in the rc window) is one nothing else
 * wakes, so it has attempts of its own, seen at run time (`startAgain`) or met by a pass: attempt n at least
 * `heldRetryMs(n)` after the one before, whichever pass or timer comes, and a dispatch held again is the next attempt.
 * So no attempt comes more often than that (each runs a login shell in its pane: 2026-10-15's 27,491 attempts a day).
 * And they end: a guard that keeps failing for a reason the fresh inspection does not see would show "Starting" for
 * good, so 10 dispatches held again, or 15 minutes held for native before dispatch, fail the row with the words a
 * person acts on. Held for another service, it waits as any row held for that service does. In memory: a core restart
 * starts them again.
 */
import { codeOrLength, errorKind, sid } from '../../lib/log.js'
import { windowsHeldPaneArgv } from '../../lib/windows/engineStart.js'
import { guardHeld, type registry, type RegisteredSession } from '../../lib/registry.js'
import { DID_NOT_START, type RestoreSummary } from '../../lib/restoreAgents.js'

/** How long a hold waits before the next timer pass: 2 s, doubling with each pass that launched nothing, at most
 *  30 s; and a launch the guard held, after each of its attempts. An engine that becomes available is still picked
 *  up within half a minute without anyone asking. */
export function heldRetryMs(quietPasses: number): number {
  return Math.min(2_000 * 2 ** quietPasses, 30_000)
}

/** Dispatches the guard held again before a launch it held fails: about 5 minutes of attempts. */
const GUARD_HOLDS = 10
/** How long attempts held for native before dispatch (its evidence still changing: brew mid-install) go on. */
const UNSETTLED_MS = 15 * 60_000

/** A launch the guard held: its attempts, how long it has been held for native (`unsettled`, as of `seen`), and the
 *  launch its last attempt dispatched, whose hold is the next attempt rather than a new count. */
interface Attempts { made: number; heldAgain: number; due: number; unsettled: number; seen: number; dispatched?: string }

/** The service a row is held for, or null. */
export function heldFor(row: Pick<RegisteredSession, 'launch'> | undefined): string | null {
  return row?.launch?.state === 'held' ? row.launch.service : null
}

export interface HeldLaunchesDeps {
  registry: Pick<typeof registry, 'list' | 'byAgent' | 'setLaunch'>
  /** The boot's restore, of exactly these agents, outside the registry's transaction (lib/restoreAgents.ts `only`). */
  restore: (only: ReadonlySet<string>, current: () => boolean) => Promise<RestoreSummary>
  /** A row a bound failed, to every client. */
  announce: (session: RegisteredSession) => void
  log: (line: string) => void
  /** Monotonic milliseconds; `performance.now()` unless a test gives its own. A wall-clock step (sleep, NTP) neither
   *  stalls nor bursts attempts. */
  now?: () => number
}

export type HeldRestart =
  | { ok: true; session: RegisteredSession; resumed: boolean }
  | { ok: false; error: string; detail?: string }

/** The token a launch runs or waits under, if it has one. */
function tokenOf(row: RegisteredSession | undefined): string | undefined {
  const launch = row?.launch
  return launch?.state === 'held' || launch?.state === 'starting' ? launch.nativeToken : undefined
}

export function createHeldLaunches({ registry, restore, announce, log, now = () => performance.now() }: HeldLaunchesDeps) {
  let opened!: () => void
  const ready = new Promise<void>(done => { opened = done })
  let closed = false
  // Closing revokes preparations already waiting on hooks or a service, too.
  const current = () => !closed
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  // Timer passes in a row that launched nothing. A hold nothing else wakes (native: an engine's search path that
  // cannot be confirmed) was retried every 2 s for good: measured 2026-10-15, one held Codex had been tried 27,491
  // times in a day, each pass running about four login shells (`zsh -lic`, the launch environment) from the core,
  // whose synchronous spawns held the event loop the terminals' keystrokes wait on.
  let quietPasses = 0
  let lastPass = ''
  const lastCode = new Map<string, string>()
  const active = new Map<string, Promise<RestoreSummary>>()
  let nextAgent = 0
  // Each launch the guard held, and the one timer for the earliest due of them.
  const attempts = new Map<string, Attempts>()
  let attemptTimer: ReturnType<typeof setTimeout> | undefined
  const empty = (): RestoreSummary => ({ restored: [], skipped: [], failed: [], held: [], unsurveyed: [] })
  // Why an agent stays held, once until it changes: it was dropped, so eight agents waited with nothing to say why.
  const because = (agentId: string, said: string): void => {
    if (lastCode.get(agentId) === said) return
    lastCode.set(agentId, said)
    log(`[restore] ${sid(agentId)} · could not launch from held · ${said}`)
  }
  /** A launch the guard held, from its first hold now: its first attempt [wait] later. */
  const begin = (agentId: string, wait: number): Attempts => {
    const at = now(), record = { made: 0, heldAgain: 0, due: at + wait, unsettled: 0, seen: at }
    attempts.set(agentId, record)
    return record
  }
  /** A bound reached: the failed state whose words say what to do. Its pane, the held shell, is kept. */
  const fail = (row: RegisteredSession, why: string, code: string): void => {
    attempts.delete(row.agentId)
    announce(registry.setLaunch(row.agentId, { state: 'failed', ...DID_NOT_START })!)
    log(`[restore] ${row.engine} · agent ${sid(row.agentId)} · ${row.sessionId ? 'relaunch' : 'first launch'} ${why} · ${code}`)
  }
  /** An attempt's end: the launch it dispatched, whose hold is its next attempt; or held before dispatch, why, and past
   *  the bound the failed state. */
  const settle = (agentId: string, record: Attempts, summary: RestoreSummary): void => {
    const row = registry.byAgent(agentId)
    if (!guardHeld(row)) {
      // Failed by it (its request unreadable, its pane gone or not its held shell, its build refused): its pane is
      // kept, so discovery says nothing of it, and every client hears it here. `arm` then forgets it.
      if (row?.launch?.state === 'failed') announce(row)
      // Dispatched: starting under its new token, one tmux may have run after its journal too (the watch follows it,
      // and the summary has it failed). Or ready or gone, which `arm` forgets.
      else record.dispatched = tokenOf(row)
      return
    }
    // Only a hold for native counts toward its bound: held for another service it waits as any row held for that
    // service does. The time since the attempt before goes to the hold this one ended in.
    const at = now()
    if (heldFor(row) === 'native') record.unsettled += at - record.seen
    record.seen = at
    if (record.unsettled >= UNSETTLED_MS) { fail(row!, 'held 15 minutes', 'NATIVE_EVIDENCE_UNSETTLED'); return }
    // The restore says nothing of it (lib/restoreAgents.ts `hold`): its failure's code, or the service it is held for
    // again, a word of the core's own.
    const failed = summary.failed.find((entry) => entry.agentId === agentId)
    if (failed) because(agentId, codeOrLength(failed.code))
    else if (summary.held.includes(agentId)) because(agentId, heldFor(row)!)
  }
  /** The one timer, set for the earliest due launch the guard held that can fly. One no longer held nor its recovery
   *  starting (ready, failed, stopped or gone) is forgotten: a later hold of it starts again at 2 s. */
  const arm = (): void => {
    clearTimeout(attemptTimer)
    attemptTimer = undefined
    if (closed) return
    const at = now()
    let next = Infinity
    for (const [agentId, record] of attempts) {
      const row = registry.byAgent(agentId)
      if (!guardHeld(row)) {
        // Its recovery starting: the guard's next word on it (`startAgain`) or its start says what comes next.
        if (row?.launch?.state !== 'starting' || !row.launch.nativeToken) attempts.delete(agentId)
        continue
      }
      // In flight, or due while all four flights are taken: a flight's end arms again, so nothing spins.
      if (active.has(agentId) || (active.size >= 4 && record.due <= at)) continue
      next = Math.min(next, record.due)
    }
    if (next === Infinity) return
    attemptTimer = setTimeout(runDue, Math.max(0, next - at))
    attemptTimer.unref?.()
  }
  /** The timer's attempts: the launches due now alone, never a pass over every held agent. */
  const runDue = (): void => {
    attemptTimer = undefined
    void ready.then(() => {
      const at = now()
      for (const [agentId, record] of attempts) {
        if (record.due > at || !guardHeld(registry.byAgent(agentId))) continue
        restoreOne(agentId).catch((error) => because(agentId, errorKind(error)))
      }
      arm()
    })
  }
  const retryContention = (summary: RestoreSummary): void => {
    if (summary.restored.length) quietPasses = 0
    if (closed || retryTimer || (!summary.retry && !summary.held.length)) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (!summary.retry) quietPasses++
      void restoreHeld(undefined, false).catch(error => {
        log(`[restore] core contention retry failed: ${errorKind(error)}`)
        retryContention({ ...empty(), retry: true })
      })
    }, summary.retry ? 500 : heldRetryMs(quietPasses))
    retryTimer.unref?.()
  }
  // One flight per agent, four across the core. A stalled native home or service
  // cannot serialize every sibling behind it. Additional callers join the same
  // observation; a later timer retries failures with fresh registry ownership.
  const restoreOne = (agentId: string): Promise<RestoreSummary> => {
    const existing = active.get(agentId)
    if (existing) return existing
    const row = registry.byAgent(agentId)
    if (closed || !heldFor(row)) return Promise.resolve(empty())
    // A launch the guard held met with no record (held before a core restart): this is its first attempt.
    const record = guardHeld(row) ? attempts.get(agentId) ?? begin(agentId, 0) : undefined
    if (active.size >= 4) {
      // Turned away, a launch the guard held made no attempt: it stays due, and a flight's end tries it (`arm`).
      if (record) return Promise.resolve({ ...empty(), held: [agentId] })
      const summary: RestoreSummary = { ...empty(), held: [agentId], retry: true }
      retryContention(summary)
      return Promise.resolve(summary)
    }
    if (record) record.due = now() + heldRetryMs(++record.made)
    // A launch the guard held keeps its own schedule: neither its dispatch nor its hold moves the shared one.
    const flight = Promise.resolve().then(() => closed ? empty() : restore(new Set([agentId]), current)).then(summary => {
      active.delete(agentId)
      if (record) settle(agentId, record, summary)
      else retryContention(summary)
      arm()
      return summary
    }, error => {
      active.delete(agentId)
      if (record) settle(agentId, record, empty())
      else retryContention({ ...empty(), retry: true })
      arm()
      throw error
    })
    active.set(agentId, flight)
    return flight
  }
  const restoreHeld = async (service?: string, joinRunning = true): Promise<RestoreSummary | null> => {
    await ready
    if (closed) return null
    // Asked from outside the timer (a service connected, the core became ready): something changed, so wait less.
    if (joinRunning) quietPasses = 0
    const at = now()
    const guarded = new Set<string>()
    const held = registry.list().filter(row => {
      const holder = heldFor(row)
      if (holder === null || (service !== undefined && holder !== service) || (!joinRunning && active.has(row.agentId))) return false
      if (!guardHeld(row)) return true
      // A launch the guard held is tried only once its own attempt is due, whichever pass this is.
      guarded.add(row.agentId)
      return (attempts.get(row.agentId)?.due ?? at) <= at
    }).map(row => row.agentId)
    if (!held.length) return null
    const offset = nextAgent % held.length
    const ordered = [...held.slice(offset), ...held.slice(0, offset)]
    nextAgent = (offset + 4) % held.length
    const summary = empty()
    const outcomes = await Promise.allSettled(ordered.map(restoreOne))
    let failure: unknown, rejected = false
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') { failure = outcome.reason; rejected = true; summary.retry = true; continue }
      const result = outcome.value
      for (const key of ['restored', 'skipped', 'failed', 'held', 'unsurveyed'] as const) (summary[key] as unknown[]).push(...result[key])
      if (result.retry) summary.retry = true
    }
    retryContention({ ...summary, restored: summary.restored.filter(id => !guarded.has(id)), held: summary.held.filter(id => !guarded.has(id)) })
    if (rejected) throw failure
    // Why one stays held, by its failure's code; one the pass failed the restore has said, once. A launch's own error
    // code is typed a string, so one that is not a code is said by its length.
    for (const { agentId, code } of summary.failed) if (heldFor(registry.byAgent(agentId))) because(agentId, codeOrLength(code))
    // A pass runs every 500 ms while the flights are full: on Windows, 2026-11-04, that was two lines a second for good.
    const pass = `${service ?? 'every service'} · launched ${summary.restored.length} of ${held.length}`
    if (pass !== lastPass || summary.restored.length) {
      lastPass = pass
      log(`[restore] held · ${pass}` + (summary.held.length ? ` · ${summary.held.length} still waiting` : ''))
    }
    return summary
  }

  /** A person's restart of a held agent: launched as a pass would, or why not. Null for an agent that is not held,
   *  which a restart handles as it always has. */
  const restartHeld = (agentId: string): Promise<HeldRestart> | null => {
    if (!heldFor(registry.byAgent(agentId))) return null
    return ready.then(async () => {
      // Asked again in turn: a pass before this one may have launched it, or the person closed it.
      const before = registry.byAgent(agentId)
      if (!before || closed) return { ok: false, error: 'AGENT_NOT_FOUND' }
      if (!heldFor(before)) return { ok: true, session: before, resumed: !!before.sessionId }
      // A launch the guard held: an attempt now, which counts, on its own schedule. Any other is news the shared one hears.
      const guard = guardHeld(before)
      if (!guard) quietPasses = 0
      const summary = await restoreOne(agentId)
      if (!guard) retryContention(summary)
      const after = registry.byAgent(agentId)
      if (!after) return { ok: false, error: 'AGENT_NOT_FOUND' }
      if (summary.restored.includes(agentId)) {
        log(`[restart] ${sid(agentId)} launched from held`)
        return { ok: true, session: after, resumed: !!after.sessionId }
      }
      const launch = after.launch
      if (launch?.state === 'failed') return { ok: false, error: launch.error, ...(launch.detail ? { detail: launch.detail } : {}) }
      // Held again before dispatch by changing evidence, or its pane not read: it starts by itself, as the person asked.
      // Held for another service, its wait is that service's: answered as any row held for it.
      if (guard && !(launch?.state === 'held' && launch.service !== 'native')) return { ok: true, session: after, resumed: !!after.sessionId }
      if (launch?.state === 'held') return { ok: false, error: 'SERVICE_UNAVAILABLE', detail: launch.detail }
      return { ok: false, error: 'RESTART_FAILED', detail: summary.failed.find((row) => row.agentId === agentId)?.reason ?? 'The harness could not be launched.' }
    })
  }

  /** The guard held this agent's launch, seen at run time (lib/restoreAgents.ts, newPane.ts, restart.ts): its first
   *  attempt 2 s after that hold. A hold of the launch its last attempt dispatched is its next attempt, never a new
   *  count, and the 10th fails it; any other (another launch of it, after it was ready or failed) starts again at 2 s. */
  const startAgain = (agentId: string): void => {
    const row = registry.byAgent(agentId)
    if (closed || !guardHeld(row)) return
    const record = attempts.get(agentId)
    if (record && record.dispatched === tokenOf(row)) {
      delete record.dispatched
      if (++record.heldAgain >= GUARD_HOLDS) { fail(row!, `held again ${GUARD_HOLDS} times`, 'NATIVE_GUARD_REPEATED'); return }
    } else begin(agentId, heldRetryMs(0))
    arm()
  }

  return {
    /** The boot's restore, before any pass here: they wait for it, whether it restores, fails or has nothing to do. */
    boot: async <T>(run: (current: () => boolean) => Promise<T>): Promise<T> => {
      try { return await run(current) } finally { opened() }
    },
    restoreHeld,
    restartHeld,
    startAgain,
    close: () => { closed = true; clearTimeout(retryTimer); clearTimeout(attemptTimer); opened() },
  }
}

/**
 * What a held agent's pane runs while it waits: the reason, and nothing to type into. It survives the interrupt a
 * person might send it, and the agent's launch takes the pane over (`respawn`) once the service is ready. Windows has
 * no `/bin/sh`: the daemon's Node waits there instead (lib/windows/engineStart.ts).
 */
export function heldPaneArgv(detail: string, token?: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return windowsHeldPaneArgv(detail, token)
  return ['/bin/sh', '-c', 'trap "" INT QUIT TSTP; printf "%s\\n" "$1"; while :; do sleep 3600; done', 'harness-held', detail, ...(token ? [token] : [])]
}
