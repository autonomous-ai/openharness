/**
 * `harness uninstall` ends every agent (spec section 5): through the running daemon, as Stop Harness does, because the
 * daemon knows which process is each harness's and checks its identity before it ends one. Done first, while there is a
 * daemon to ask. A harness it would not stop is reported; on Windows the terminal host's step then ends its pane.
 */
import type { Daemon } from '../../agentClient/daemon.js'

export const AGENT_STOP_TIMEOUT_MS = 60_000
/** As many at once as hermes' hook homes are prepared (nativeHookYaml.ts): enough to be quick, few enough not to pile up. */
export const AGENTS_AT_ONCE = 4

export interface AgentsStopped { stopped: number; failed: Array<{ name: string; error: string }>; unreachable?: string }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const label = (agent: Record<string, unknown>): string => (typeof agent.name === 'string' && agent.name ? agent.name : String(agent.id).slice(0, 8))

export async function stopEveryAgent(open: () => Promise<Daemon>): Promise<AgentsStopped> {
  let daemon: Daemon
  try { daemon = await open() } catch (error) { return { stopped: 0, failed: [], unreachable: message(error) } }
  try {
    const listed = await daemon.request('agents_list', { includeStopped: false })
    if (listed.error) {
      const detail = typeof listed.detail === 'string' && listed.detail ? `: ${listed.detail}` : ''
      return { stopped: 0, failed: [], unreachable: `it refused to list them: ${String(listed.error)}${detail}` }
    }
    const agents = (Array.isArray(listed.agents) ? listed.agents as Array<Record<string, unknown>> : []).filter((a) => typeof a.id === 'string')
    let stopped = 0
    const failed: AgentsStopped['failed'] = []
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < agents.length) {
        const agent = agents[next++]
        // A request that times out may still finish later in the daemon; ending the terminal host is the backstop.
        try {
          const reply = await daemon.request('agent_delete', { agentId: agent.id }, AGENT_STOP_TIMEOUT_MS)
          if (reply.error) failed.push({ name: label(agent), error: `${reply.error}${typeof reply.detail === 'string' && reply.detail ? `: ${reply.detail}` : ''}` })
          else stopped++
        } catch (error) {
          failed.push({ name: label(agent), error: message(error) })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(AGENTS_AT_ONCE, agents.length) }, worker))
    return { stopped, failed }
  } catch (error) {
    return { stopped: 0, failed: [], unreachable: message(error) }
  } finally {
    daemon.close()
  }
}
