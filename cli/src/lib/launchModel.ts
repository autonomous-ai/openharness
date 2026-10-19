/**
 * The model and effort a new agent is launched with, for that session only (`EngineLaunch.modelArgs`). A routed
 * Super Tab start used to type `/model` into the new pane, which Claude Code saves as the person's default model
 * in their own settings.json (manual run 2, 2026-10-19). A flag on the command line is not saved anywhere.
 */
import { fill } from '../engines/kit/launchArgs.js'
import { engineLaunches, launchContract } from '../engines/launches.js'

export interface LaunchModel { model: string | null; effort: string | null }

export type ParsedLaunchModel =
  | { state: 'absent' }
  | { state: 'ok'; launchModel: LaunchModel }
  | { state: 'invalid'; detail: string }
  | { state: 'unsupported'; detail: string }

// One word, as the engines name models: an alias, a full name, `claude-opus-5[1m]`. A flag, a space or a shell
// character never fits, and it travels as its own argv item besides, so it is never read by a shell.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,63}$/
const EFFORT = /^[a-z]{1,16}$/
const SHAPE = 'model and effort must each be a short word'

/** `default` keeps what the engine would launch with, and `auto` is no level of its own: neither is a flag. */
const named = (value: string, none: readonly string[]) => none.includes(value) ? null : value

/** Reads `model` and `effort` of an `agent_create` payload. Absent when nothing remains to launch with. */
export function parseLaunchModel(engine: string, payload: Record<string, unknown>): ParsedLaunchModel {
  const fields: Array<['model' | 'effort', unknown]> = [['model', payload.model], ['effort', payload.effort]]
  const read: LaunchModel = { model: null, effort: null }
  for (const [field, raw] of fields) {
    if (raw === undefined || raw === null) continue
    const value = typeof raw === 'string' ? raw.trim() : null
    if (value === null || !(field === 'model' ? MODEL : EFFORT).test(value)) return { state: 'invalid', detail: SHAPE }
    read[field] = named(value, field === 'model' ? ['default'] : ['default', 'auto'])
  }
  if (!read.model && !read.effort) return { state: 'absent' }
  const contract = launchContract(engine)?.modelArgs
  if (!contract) return { state: 'unsupported', detail: `${engine} cannot be launched with a model; it takes one after it starts.` }
  if (read.effort && !contract.efforts.includes(read.effort)) {
    return { state: 'invalid', detail: `${engine} takes an effort of ${contract.efforts.join(', ')}` }
  }
  return { state: 'ok', launchModel: read }
}

/** The argv for `launchModel`, nothing for `default` or for an engine that declares no flags. */
export function launchModelArgs(engine: string, launchModel: LaunchModel): string[] {
  const contract = launchContract(engine)?.modelArgs
  if (!contract) return []
  const model = launchModel.model && named(launchModel.model, ['default'])
  const effort = launchModel.effort && named(launchModel.effort, ['default', 'auto'])
  return [
    ...(model ? contract.model.map((arg) => fill(arg, 'value', model)) : []),
    ...(effort ? contract.effort.map((arg) => fill(arg, 'value', effort)) : []),
  ]
}

/** The engines that take a launch model: what `super_tabs capacity` tells a Lead's machine. */
export function launchModelEngines(): string[] {
  return Object.entries(engineLaunches).filter(([, launch]) => launch.modelArgs).map(([name]) => name)
}
