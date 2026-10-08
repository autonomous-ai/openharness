/** Private model-control messages. All terminal effects need a separate, revocable core grant. */
import type { ModelControlCheck, ModelControlInput, RuntimeProfileErrorCode } from '../facets/modelControl.js'
import type { RuntimeCatalogModel, RuntimeProfile, RuntimeSession } from '../facets/runtime.js'
import { record, type ReaderEngine } from './protocol.js'
import { runtimeContext } from './runtimeProtocol.js'
import { screenCapture } from './screenProtocol.js'

export const MODEL_CONTROL_VERSION = 1
export const MODEL_CONTROL_CAPABILITIES = 'engine_model_control_capabilities'
export const MODEL_CONTROL_VALIDATE = 'engine_model_control_validate'
export const MODEL_CONTROL_APPLY = 'engine_model_control_apply'
export const MODEL_CONTROL_HOST = 'engine.modelControl'
export const MODEL_CONTROL_WAIT_MS = 30_000
export const MODEL_CONTROL_CHECK_MS = 5_000
export const MODEL_CONTROL_QUERY_MS = 10_000
export const MODEL_CONTROL_IN_FLIGHT = 4
export const MODEL_CONTROL_QUERIES = 128
export const MODEL_CONTROL_WRITES = 32
export const MODEL_CONTROL_BYTES = 1024 * 1024
export const MODEL_CONTROL_ERRORS: readonly RuntimeProfileErrorCode[] = ['AGENT_NOT_FOUND', 'INVALID_RUNTIME_PROFILE', 'BUSY',
  'UNSUPPORTED_CLI_VERSION', 'MODEL_UNAVAILABLE', 'EFFORT_UNSUPPORTED', 'PLAN_SCOPE_AMBIGUOUS', 'CONFIRM_TIMEOUT', 'TMUX_FAILED']
const EMPTY_STATE = { model: null, effort: null, mode: 'unknown' as const, cliVersion: null, observedAt: null }
const fields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).every(key => names.includes(key))
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const label = (v: unknown): v is string => text(v, 2000) && !!v && !/[\x00-\x1f\x7f]/.test(v)
export const modelControlToken = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const modelControlSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= MODEL_CONTROL_BYTES

export function modelControlCatalog(value: unknown): value is RuntimeCatalogModel[] {
  return Array.isArray(value) && value.length <= 512 && value.every(m => record(m)
    && fields(m, ['slug', 'displayName', 'listed', 'defaultEffort', 'efforts']) && label(m.slug) && text(m.displayName, 2000)
    && typeof m.listed === 'boolean' && text(m.defaultEffort, 200) && Array.isArray(m.efforts) && m.efforts.length <= 64 && m.efforts.every(label))
}

function profile(value: unknown, session: RuntimeSession, engine: ReaderEngine): RuntimeProfile | null {
  const context = runtimeContext({ session, state: EMPTY_STATE,
    control: { target: value, before: null, modelConfirmed: false, effortConfirmed: false } }, engine)
  const target = context?.control?.target
  return target && label(target.model) && label(target.effort) ? target : null
}

export function modelControlInput(value: unknown, engine: ReaderEngine): ModelControlInput | null {
  if (!record(value) || !fields(value, ['session', 'target', 'current', 'options', 'catalog'])) return null
  const context = runtimeContext({ session: value.session, state: EMPTY_STATE }, engine)
  if (!context) return null
  const target = profile(value.target, context.session, engine)
  const current = value.current === null ? null : profile(value.current, context.session, engine)
  if (!target || !modelControlCatalog(value.catalog) || (value.current !== null && !current) || !Array.isArray(value.options) || value.options.length > 4096
    || !value.options.every(o => record(o) && fields(o, ['id', 'displayName']) && text(o.id, 32768) && text(o.displayName, 32768))) return null
  return { session: context.session, target, current, catalog: structuredClone(value.catalog), options: value.options.map(o => ({ id: o.id, displayName: o.displayName })) }
}

export function modelControlCheck(value: unknown, engine: ReaderEngine): ModelControlCheck | null {
  if (!record(value) || !fields(value, ['session', 'target', 'stage', 'state', 'catalog', 'pane'])
    || (value.stage !== 'target' && value.stage !== 'scope') || !modelControlCatalog(value.catalog)) return null
  const context = runtimeContext({ session: value.session, state: value.state }, engine)
  if (!context) return null
  const target = profile(value.target, context.session, engine)
  const pane = value.pane
  if (!target || (pane !== undefined && (!record(pane) || !fields(pane, ['idle', 'plan', 'dialog', 'draft'])
    || !['idle', 'plan', 'dialog', 'draft'].every(k => typeof pane[k] === 'boolean')))) return null
  return { session: context.session, state: context.state, target, stage: value.stage, catalog: structuredClone(value.catalog),
    ...(pane === undefined ? {} : { pane: { idle: pane.idle as boolean, plan: pane.plan as boolean, dialog: pane.dialog as boolean, draft: pane.draft as boolean } }) }
}

export type ModelControlAction =
  | { kind: 'catalog' }
  | { kind: 'capture'; lines: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'waitForModel'; ms: number }
  | { kind: 'waitForProfile'; ms: number }
  | { kind: 'confirmEffort'; effort: string }

export function modelControlAction(value: unknown): value is ModelControlAction {
  if (!record(value)) return false
  if (value.kind === 'catalog') return fields(value, ['kind'])
  if (value.kind === 'capture') return fields(value, ['kind', 'lines']) && Number.isInteger(value.lines) && Number(value.lines) >= 1 && Number(value.lines) <= 100
  if (value.kind === 'text') return fields(value, ['kind', 'text']) && label(value.text)
  if (value.kind === 'key') return fields(value, ['kind', 'key']) && typeof value.key === 'string' && /^(?:Enter|Escape|[1-9])$/.test(value.key)
  if (value.kind === 'confirmEffort') return fields(value, ['kind', 'effort']) && label(value.effort)
  return (value.kind === 'waitForModel' || value.kind === 'waitForProfile') && fields(value, ['kind', 'ms'])
    && Number.isInteger(value.ms) && Number(value.ms) > 0 && Number(value.ms) <= 8000
}

export function modelControlAnswer(action: ModelControlAction, value: unknown): boolean {
  if (action.kind === 'catalog') return modelControlCatalog(value)
  if (action.kind === 'capture') return value === null || screenCapture(value)
  return typeof value === 'boolean'
}

export function modelControlEnvelope(payload: Record<string, unknown>, names: string[]): boolean {
  return payload.version === MODEL_CONTROL_VERSION && fields(payload, ['version', 'requestId', ...names])
    && (payload.requestId === undefined || text(payload.requestId, 200)) && modelControlSize(payload)
}
