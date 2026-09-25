import type { AgentEngine } from '../engines/types.js'
import { gridCapableEngines, type GridLaunchOverride } from './gridLaunch.js'
import { forgetGridModels, listGridModels } from './gridModels.js'
import { resolveGridTarget } from './gridTarget.js'

export interface NewAgentModel { model: string; grid: string }

/** Model routing is resolved on the agent's machine; the model can live elsewhere.
 * Only the semantic choice goes into the creation receipt, never a rotating key. */
export function parseNewAgentModel(engine: AgentEngine, payload: Record<string, unknown>):
  { state: 'absent' } | { state: 'invalid'; detail: string } | { state: 'ok'; selection: NewAgentModel } {
  if (payload.gridModel === undefined && payload.gridName === undefined) return { state: 'absent' }
  const valid = (value: unknown): value is string => typeof value === 'string'
    && value.trim().length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value)
  if (!valid(payload.gridModel) || !valid(payload.gridName)) {
    return { state: 'invalid', detail: 'Choose a model and the grid serving it.' }
  }
  if (payload.grid !== undefined || payload.codexHome != null) {
    return { state: 'invalid', detail: 'A model selection cannot be combined with a grid credential or a subscription profile.' }
  }
  if (!gridCapableEngines().includes(engine)) {
    return { state: 'invalid', detail: `${engine} cannot use a model on your machines.` }
  }
  return { state: 'ok', selection: { model: payload.gridModel.trim(), grid: payload.gridName.trim() } }
}

export async function resolveNewAgentModel(selection: NewAgentModel): Promise<GridLaunchOverride | null> {
  // Refresh at launch: a model stopped after opening the picker must not silently
  // fall back to a subscription or to the grid's default router.
  forgetGridModels();
  const models = await listGridModels(selection.grid);
  if (!models.some((model) => model.id === selection.model)) return null;
  return resolveGridTarget(selection.grid, selection.model);
}
