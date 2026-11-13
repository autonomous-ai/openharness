// The dial's list with no window: this computer's agents, the ones that need the person first.
import type { HostAgent } from './types.js'

// The bound is on the rows, not on name lengths, so a computer with 60 sessions cannot repeat the 78-agent reconnect
// (`listAgentSnapshot`'s comment in cableHost.ts). 10 is to be tuned on a dial.
const MAX_ROWS = 10

function group(a: HostAgent): number {
  if (a.state === 'needs-you') return 0
  if (a.state === 'working') return 1
  if (a.state === 'done' && a.unseenDone) return 2
  return 3
}

/** needs-you, working, done and unseen, then the rest; most recent first within each. `total` counts every agent. */
export function selectForDial(agents: HostAgent[], max = MAX_ROWS): { rows: HostAgent[]; total: number } {
  const rows = [...agents].sort((a, b) => group(a) - group(b) || b.lastActivityAt - a.lastActivityAt).slice(0, max)
  return { rows, total: agents.length }
}
