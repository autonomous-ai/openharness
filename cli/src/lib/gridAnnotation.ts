/**
 * What an agent's frame says about the grid it is on (grid-reads-without-waking issue 03): that grid's
 * state, and a note when the agent's model will not answer, because every computer serving it seems
 * offline or the latest list no longer has it. And whether a keystroke to the agent should start its grid.
 *
 * Asked on every frame and every keystroke, so it is answered from memory: a glance at each grid the
 * models service tracks (`gridModels.ts`). In the core's process that is the service's own pictures; with
 * models in a process of its own, the glances it last told the core (core/modelsLink.ts), so a frame and
 * a keystroke never cross a process (docs/design/2026-10-06-core-boundary-next.md, step 7). One reading
 * of a glance serves both, here, in a module the core loads without the models' code.
 */

/**
 * `awake` — the last read answered. `asleep` — the platform says it is resting. `unknown` — the last
 * read failed any other way, or nothing has been read yet (the list shown, if any, is the last known).
 * `waking` — a person asked for it to start (issue 03's explicit wake; never set by a read).
 */
export type PictureState = 'awake' | 'asleep' | 'waking' | 'unknown'

/** Where an agent's inference goes (`gridAssignment.ts`) — all a prewarm or a note needs of it. */
export interface AgentGridTarget { baseUrl: string; model: string | null }

/** What is said about an agent already on a grid model (issue 03): that grid's state, and a note when its
 *  model will not answer — every computer serving it seems offline, or the latest list no longer has it. */
export interface GridNote { reason: 'offline' | 'not_served'; model: string; machine?: string }
export interface GridAnnotation { state: PictureState; note?: GridNote }

/** One grid as the models service last saw it: as much of it as an agent's frame and a keystroke read. */
export interface GridGlance {
  /** The grid's network id: a segment of the path of every relay that reaches it. */
  id: string
  /** What a picker was last told of it, or null before anyone was: its state, and the models it offers,
   *  each with the computer it waits for when every one serving it seems offline. */
  view: { state: PictureState; models: ReadonlyArray<{ id: string; unavailable?: { machine: string } }> } | null
  /** It has been listed at least once. "No longer lists" needs a list: a grid never read says nothing
   *  about any model. */
  listed: boolean
  /** Its picture says asleep and no wake is under way: a keystroke to an agent on it may start it. */
  asleep: boolean
}

/** A model id without case: how grids, records and pickers are joined. */
export const idKey = (id: string): string => id.trim().toLowerCase()

/** The grid an agent's inference goes to: the one whose id is a segment of its relay's path. */
export function glanceFor<T extends { id: string }>(glances: Iterable<T>, baseUrl: string): T | null {
  let segments: string[]
  try { segments = new URL(baseUrl).pathname.split('/').filter(Boolean) } catch { return null }
  for (const glance of glances) if (segments.includes(glance.id)) return glance
  return null
}

/** What an agent on `target` is told about its grid, from a glance at it; null for a grid nobody has
 *  shown a picker yet, or one not tracked at all. */
export function annotate(glance: GridGlance | null, target: AgentGridTarget): GridAnnotation | null {
  const view = glance?.view
  if (!glance || !view) return null
  if (!target.model || view.state === 'waking') return { state: view.state }
  const key = idKey(target.model)
  const row = view.models.find((model) => idKey(model.id) === key)
  if (row?.unavailable) return { state: view.state, note: { reason: 'offline', model: row.id, machine: row.unavailable.machine } }
  if (!row && glance.listed) return { state: view.state, note: { reason: 'not_served', model: target.model } }
  return { state: view.state }
}
