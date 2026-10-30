/**
 * Whether `harness send`, `new`, `tell` or `close` may run here: never from a Buddy's pane.
 *
 * Security review of #2087: a Buddy brainstorms with its owner and does no project work, yet its pane could reach the
 * person's other sessions with these. The pane is the one the command runs in (callerPane.ts), and whether its harness is
 * a Buddy is this computer's own launch record (service.ts `buddyCheck`): the second review found a server read alone
 * missed its deadline 2 times in 3 under load, and refused everyone in an outage. In order:
 * - with the Swarm off, or a daemon from before the check, nothing changes, and no pane is looked at;
 * - a daemon that is not running is left to the command, which says so as it always has;
 * - Windows has no cheap check of a pty host pane, so while this computer runs a Buddy an agent's shell is refused.
 */
import { openDaemon, whereFor, type Where } from '../agentClient/daemon.js'
import { callerOf, outsideCaller, type Frame } from '../agentClient/model.js'
import { sendPane } from '../messages/command.js'
import { inDaemonPane, NOT_IN_PANE, runningPane, type PaneProbe } from './callerPane.js'

const BUDDY = 'A Buddy talks with its owner in its own chat: it may not send to, start, tell or close other sessions.'
const UNSURE = 'Harness could not confirm whether this harness is a Buddy just now, so it did not run this. Try again in a moment.'
export const WINDOWS_BUDDY = 'This Windows computer runs a Buddy, and Harness cannot tell its pane from this one, so an agent here may not do this '
  + 'while it runs. Run it from your own terminal.'

type DaemonLike = { request: (type: string, payload?: Record<string, unknown>, ms?: number) => Promise<Record<string, unknown>> }

export const SWARM_UNSURE = 'Harness could not reach this computer\'s Swarm just now, so it did not run this. Try again in a moment.'

/**
 * Whether this computer's Swarm knows of Buddies: null with the Swarm off (core/serviceHost.ts answers a service off for good
 * as unavailable, not to be retried) or a daemon from before `buddyCheck` (no Swarm service, or one that reads it as an agent's
 * request without a Swarm: invalid). Anything else, a failure or no answer in time, throws [SWARM_UNSURE]: read as "off", it
 * skipped the Buddy check and Windows' backstop (re-check 2 of #2093 at 0648a8690).
 */
export async function buddiesHere(daemon: DaemonLike): Promise<boolean | null> {
  const answer = await daemon.request('super_tabs', { action: 'buddyCheck' }, 10_000).catch(() => { throw new Error(SWARM_UNSURE) })
  if (answer.ok === true) return answer.buddiesHere === true
  if (answer.error === 'UNSUPPORTED' || answer.error === 'INVALID_REQUEST' || answer.error === 'SERVICE_UNAVAILABLE' && answer.retryable === false) return null
  throw new Error(SWARM_UNSURE)
}

/**
 * Whether the harness running in [pane] is a Buddy, by this computer's launch record (service.ts `buddyCheck`, what turns its
 * guard on): the one way this guard and the CLI's usage wording (command.ts `buddyHere`) ask it (review of #2379). With the
 * command's [ancestors], a harness whose own pane, as the daemon reads it, is not among them is never asked about. A request
 * that fails is thrown, for each caller to read as it does: this guard refuses, the wording takes it for no Buddy.
 */
export async function paneBuddy(daemon: DaemonLike, pane: string, machineId: string, ancestors?: number[])
  : Promise<'buddy' | 'not a buddy' | 'no harness' | 'not in its pane' | 'unsure'> {
  const listed = await daemon.request('agents_list')
  const caller = callerOf(Array.isArray(listed.agents) ? listed.agents as Frame[] : [], pane, machineId)
  if (!caller) return 'no harness'
  if (!await inDaemonPane(daemon, caller.agentId, ancestors)) return 'not in its pane'
  const answer = await daemon.request('super_tabs', { action: 'buddyCheck', harnessId: caller.agentId }, 10_000)
  if (answer.ok !== true || typeof answer.buddy !== 'boolean') return 'unsure'
  return answer.buddy ? 'buddy' : 'not a buddy'
}

/** An agent's shell on Windows, as it marks itself: its Harness pane, or the engine's own variables (`outsideCaller`). */
export const agentShell = (env: NodeJS.ProcessEnv): boolean => !!sendPane(env) || !!outsideCaller(env, '')

export async function buddyRefusal(deps: {
  probe?: PaneProbe; env?: NodeJS.ProcessEnv; where?: () => Where; open?: typeof openDaemon
} = {}, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const env = deps.env ?? process.env
  const where = (deps.where ?? (() => whereFor(sendPane(env))))()
  let daemon: Awaited<ReturnType<typeof openDaemon>>
  try { daemon = await (deps.open ?? openDaemon)(where) } catch { return null }
  try {
    let buddies: boolean | null
    try { buddies = await buddiesHere(daemon) } catch { return SWARM_UNSURE }
    if (buddies === null) return null
    if (platform === 'win32') return buddies && agentShell(env) ? WINDOWS_BUDDY : null
    const running = runningPane(env, deps.probe, platform)
    if (running.refused) return running.refused
    // Not shortcut on `buddies`: a harness an agent started with no Swarm record is asked about by itself (service.ts).
    if (!running.pane) return null
    const buddy = await paneBuddy(daemon, running.pane, where.machineId, running.ancestors)
    if (buddy === 'not in its pane') return NOT_IN_PANE
    // The Swarm answered it is on: one that then cannot say for this harness is no answer of "no Buddy" (re-check 1 of #2093).
    if (buddy === 'unsure') return UNSURE
    return buddy === 'buddy' ? BUDDY : null
  } finally { daemon.close() }
}
