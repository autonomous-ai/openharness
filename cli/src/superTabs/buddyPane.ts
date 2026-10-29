/**
 * Whether `harness send`, `new`, `tell` or `close` may run here: never from a Buddy's pane.
 *
 * Security review of #2087: a Buddy brainstorms with its owner and does no project work, yet its pane could reach the
 * person's other sessions with these. The pane is the one the command runs in (callerPane.ts), and its role is the
 * Swarm's own answer for that harness now (host.ts swarmRoleFor), which the daemon reads from the live roster. Whether a
 * running Swarm cannot say in time is not taken as "no Buddy": the command is refused and may be tried again. A daemon
 * with the Swarm off, or from before it, has no Buddies, and nothing changes there.
 */
import { openDaemon, whereFor, type Where } from '../agentClient/daemon.js'
import { callerOf, type Frame } from '../agentClient/model.js'
import { runningPane, type PaneProbe } from './callerPane.js'

const BUDDY = 'A Buddy talks with its owner in its own chat: it may not send to, start, tell or close other sessions.'
const UNSURE = 'Harness could not confirm this harness\'s Swarm role just now, so it did not run this. Try again in a moment.'

export async function buddyRefusal(deps: {
  pane?: string; probe?: PaneProbe; env?: NodeJS.ProcessEnv; where?: () => Where; open?: typeof openDaemon
} = {}): Promise<string | null> {
  const running = 'pane' in deps ? { pane: deps.pane } : runningPane(deps.env ?? process.env, deps.probe)
  if (running.refused) return running.refused
  const pane = running.pane
  if (!pane) return null
  const where = (deps.where ?? (() => whereFor(pane)))()
  let daemon: Awaited<ReturnType<typeof openDaemon>> | null = null
  try {
    daemon = await (deps.open ?? openDaemon)(where)
    const listed = await daemon.request('agents_list')
    const caller = callerOf(Array.isArray(listed.agents) ? listed.agents as Frame[] : [], pane, where.machineId)
    if (!caller) return null
    const answer = await daemon.request('super_tabs', { action: 'swarmRole', harnessId: caller.agentId }, 10_000)
    // The Swarm off on this computer (core/serviceHost.ts leaveOff), or a daemon that has none.
    if (answer.error === 'UNSUPPORTED' || answer.error === 'SERVICE_UNAVAILABLE' && answer.retryable === false) return null
    // A lookup past its deadline answers with no role (service.ts swarmRole).
    if (answer.ok !== true || !('role' in answer)) return UNSURE
    return answer.role === 'buddy' ? BUDDY : null
  } catch { return UNSURE } finally { daemon?.close() }
}
