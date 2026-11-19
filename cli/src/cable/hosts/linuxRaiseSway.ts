/**
 * The raise on sway (docs/plans/2026-11-19-dial-linux-design.md § 2.3): the window of the first of the agent's chain
 * that owns one, else the first window of the app's classes. Every command runs with no shell, each value one argument,
 * and only a pid or node id checked as a whole number reaches sway's criteria.
 */
import { isAgentPid } from './linuxDesktop.js'
import type { RaiseBackend, RaiseRun } from './linuxRaise.js'
import { RUN_TIMEOUT_MS } from './orca.js'

// A desktop's tree is a few hundred nodes, a handful of levels deep: the bounds cap what a broken answer costs.
const MAX_NODES = 4096
const MAX_DEPTH = 32

interface SwayWindow { id: unknown; pid: number; class: unknown }

/** The nodes that carry a pid, in the tree's order. */
function windowsOf(tree: unknown): SwayWindow[] {
  const windows: SwayWindow[] = []
  let seen = 0
  const walk = (node: unknown, depth: number) => {
    if (seen >= MAX_NODES || depth > MAX_DEPTH || typeof node !== 'object' || node === null) return
    seen++
    const { id, pid, app_id: appId, window_properties: properties, nodes, floating_nodes: floating } = node as Record<string, unknown>
    // An XWayland window has no app_id: its X11 class names its app (RECORDED_SWAY.tree).
    if (typeof pid === 'number') windows.push({ id, pid, class: appId ?? (properties as { class?: unknown } | null | undefined)?.class })
    for (const children of [nodes, floating]) {
      if (!Array.isArray(children)) continue
      for (const child of children) {
        if (seen >= MAX_NODES) return
        walk(child, depth + 1)
      }
    }
  }
  walk(tree, 0)
  return windows
}

const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

export function createSwayRaise(deps: RaiseRun, socket: string): RaiseBackend {
  return {
    async raise({ pids, classes }) {
      const swaymsg = deps.onPath('swaymsg')
      if (!swaymsg) return false
      const run = (args: string[]) => deps.run(swaymsg, ['-s', socket, ...args], RUN_TIMEOUT_MS).catch(() => ({ code: null, stdout: '' }))
      const listing = await run(['-t', 'get_tree'])
      if (listing.code !== 0) return false
      let tree: unknown
      try {
        tree = JSON.parse(listing.stdout)
      } catch {
        return false
      }
      const windows = windowsOf(tree)
      const pid = pids.find((p) => isAgentPid(p) && windows.some((window) => window.pid === p))
      if (pid !== undefined) return (await run([`[pid=${pid}] focus`])).code === 0
      const wanted = new Set(classes.map((name) => name.toLowerCase()))
      const byClass = windows.find((window) => isId(window.id) && typeof window.class === 'string' && wanted.has(window.class.toLowerCase()))
      if (byClass === undefined) return false
      return (await run([`[con_id=${byClass.id}] focus`])).code === 0
    },
  }
}
