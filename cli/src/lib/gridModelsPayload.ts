/**
 * What `grid_models_list` answers (the models service, services/models.ts) and `grid_models_changed`
 * pushes (the socket, to the windows on this computer) — one shape, so a window parses both with one
 * reader. A pure function of the sections, here so the two build it the same way.
 */
import { gridCliPresence } from './gridExec.js'
import { gridCapableEngines } from './gridLaunch.js'
import { presentGridSections, type GridSection } from './gridModels.js'

/** `gridName` and `models` keep naming the own grid alone, for an app that predates `grids`; each
 *  section's `state`, `seenAt`, `lastKnownAge` and `wakeOutcome` are additive, and a row's offline label
 *  is `unavailable` for a window that asked for row state, its node text for one that did not
 *  (`presentGridSections`). */
export function gridModelsPayload(gridName: string | null, sections: GridSection[], rowState: boolean): Record<string, unknown> {
  const grids = presentGridSections(sections, { rowState })
  return {
    gridName,
    models: grids.find((g) => g.own)?.models ?? [],
    grids,
    // Which engines a Local model can be offered to at all. Static per CLI version — it is
    // the set of launch contracts in `gridLaunch.ts` — and answered here, beside the list,
    // so the picker can say "Cursor runs only on its own login" instead of offering a row
    // whose retarget the daemon would refuse. An older app ignores the field; an older
    // daemon omits it, which the app reads as "offer everything", as before.
    localModelEngines: gridCapableEngines(),
    supportsModelLaunch: true,
    // Whether this MACHINE has a `grid` to run at all — `managed`, `path` or `missing` —
    // as distinct from `gridName`, which is about the account. The Local model dialog was
    // gating on the account alone and starting an agent whose second step is `grid`; this
    // is what lets it, and the picker, say so first. An older app ignores the field.
    gridCli: gridCliPresence(),
  }
}
