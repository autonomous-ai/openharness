/** The routing plug-ins' makers (route.ts RoutePlugin). Scholes's goals, pieces 3 to 6 (measured cost and results, more model
 *  candidates, machine fit, window pull), each add one line to [ROUTE_PLUGIN_MAKERS] rather than all four editing the route's
 *  call (piece 3's builder, 10-31). A maker does its piece's outside read and returns a pure plug-in holding what it read;
 *  routeTask starts every maker together with the machine probes, so a maker's read costs no time of its own. */
import { pluginSkipped, type Assessment, type Catalog, type RoutePlugin } from './route.js'
import type { ScopedRequest } from './start.js'
import { windowPullMaker } from './windowPull.js'

type Json = Record<string, unknown>

/** What a maker gets. `read`: the route's backend read (the Super Tab state this agent may read, the policy and catalog, the
 *  machines). `history`: the group's route history (`decisions`, `attempts`) once read, null when it could not be, shared so no
 *  maker reads it again. `request`: this agent's own backend request, for a read the route does not make; it carries the
 *  agent's access, never more. */
export interface PluginInput {
  readonly conversationId: string
  readonly assessment: Assessment
  readonly read: Json
  readonly catalog: Catalog
  readonly history: Promise<Json | null>
  readonly request: ScopedRequest
}
/** Makes one plug-in for one route, or null when it has nothing to say this time (no data yet). */
export interface PluginMaker { readonly name: string; make(input: PluginInput): Promise<RoutePlugin | null> }

/** The makers, in the order their plug-ins run. One line per piece. */
export const ROUTE_PLUGIN_MAKERS: readonly PluginMaker[] = [
  windowPullMaker(),
]

/** As long as the route's other context reads wait (wire.ts within): a maker's read is context too, never worth holding the
 *  route for. */
export const MAKER_TIMEOUT_MS = 3000

const isPlugin = (p: unknown): p is RoutePlugin => {
  const v = (p && typeof p === 'object' ? p : {}) as Json
  return typeof v.name === 'string' && !!v.name && (v.candidates === undefined || typeof v.candidates === 'function')
    && (v.adjust === undefined || typeof v.adjust === 'function')
}

/** Every maker's plug-in, in the makers' order whatever order they finish in. A maker that throws, rejects, answers what is not
 *  a plug-in, or has not answered in [ms] is left out and named in `warnings`, with no error text; what it answers later is
 *  dropped, so a route already ranked never changes. */
export async function makePlugins(makers: readonly PluginMaker[], input: PluginInput, ms = MAKER_TIMEOUT_MS): Promise<{ plugins: RoutePlugin[]; warnings: string[] }> {
  const made = await Promise.all(makers.map(async maker => {
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<'late'>(resolve => { timer = setTimeout(resolve, ms, 'late') })
    try {
      const answer = await Promise.race([Promise.resolve().then(() => maker.make(input)), late])
      if (answer === 'late') return { why: `its maker took longer than ${ms / 1000} s`, name: maker.name }
      if (answer === null) return {}
      return isPlugin(answer) ? { plugin: answer } : { why: 'its maker failed', name: maker.name }
    } catch { return { why: 'its maker failed', name: maker.name } } finally { clearTimeout(timer) }
  }))
  return { plugins: made.flatMap(m => 'plugin' in m && m.plugin ? [m.plugin] : []),
    warnings: made.flatMap(m => 'why' in m && m.why ? [pluginSkipped(m.name!, m.why)] : []) }
}
