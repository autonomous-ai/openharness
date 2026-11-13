import type { HostAgent } from './types.js'

// Lower is shown first. Done only outranks the rest while the dial has not shown it yet.
function group(a: HostAgent): number {
  if (a.state === 'needs-you') return 0
  if (a.state === 'working') return 1
  if (a.state === 'done' && a.unseenDone) return 2
  return 3
}

/** The rows the dial gets, bounded so a big fleet is never pushed whole. `total` is every agent. */
export function selectForDial(agents: HostAgent[], max = 10): { rows: HostAgent[]; total: number } {
  const rows = agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => group(x.a) - group(y.a) || y.a.lastActivityAt - x.a.lastActivityAt || x.i - y.i)
    .slice(0, Math.max(0, max))
    .map((x) => x.a)
  return { rows, total: agents.length }
}
