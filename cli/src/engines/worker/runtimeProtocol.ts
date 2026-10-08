/** Private runtime-profile reads and reductions. No registry or terminal capabilities cross this link. */
import { isAbsolute } from 'node:path'
import type { RuntimeCatalogModel, RuntimeContext, RuntimeControl, RuntimeModelOption, RuntimeRecord, RuntimeSession, RuntimeState } from '../facets/runtime.js'
import { encodeRuntimeProfile } from '../kit/runtime.js'
import { record, type ReaderEngine } from './protocol.js'

export const RUNTIME_VERSION = 1
export const RUNTIME_READ = 'engine_runtime_read'
export const RUNTIME_CAPABILITIES = 'engine_runtime_capabilities'
export const RUNTIME_WAIT_MS = 5_000
export const RUNTIME_IN_FLIGHT = 2
export const RUNTIME_REQUEST_BYTES = 1024 * 1024
export const RUNTIME_REPLY_BYTES = 1024 * 1024
export const RUNTIME_RECORDS = 512

export type RuntimeOperation =
  | { kind: 'records'; records: RuntimeRecord[] }
  | { kind: 'pane'; text: string }
  | { kind: 'config' | 'models' | 'catalog' | 'describe' }
  | { kind: 'effort'; model: string; effort: string; listed: string[] | null }

export interface RuntimeAnswer {
  state: RuntimeState
  cliVersion: string | null
  control: RuntimeControl | null
  selectedModel: string | null
  supportsControl: boolean
  models?: RuntimeModelOption[]
  catalog?: RuntimeCatalogModel[]
  effortAllowed?: boolean
}

const text = (value: unknown, max = 2_000): value is string => typeof value === 'string' && value.length <= max
const nullable = (value: unknown): value is string | null => value === null || text(value)
const label = (value: unknown): value is string => text(value, 200) && value.length > 0
const path = (value: unknown): value is string => text(value, 32_768) && !value.includes('\0') && isAbsolute(value)
const fields = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key))

export function runtimeState(value: unknown): value is RuntimeState {
  return record(value) && nullable(value.model) && nullable(value.effort) && nullable(value.cliVersion)
    && ['unknown', 'default', 'plan'].includes(value.mode as string)
    && (value.observedAt === null || (typeof value.observedAt === 'number' && Number.isFinite(value.observedAt) && Math.abs(value.observedAt) <= 8.64e15))
}

function controlOf(value: unknown, session: RuntimeSession): RuntimeControl | undefined | null {
  if (value === undefined || value === null) return undefined
  if (!session.sessionId || !record(value) || !record(value.target) || typeof value.modelConfirmed !== 'boolean' || typeof value.effortConfirmed !== 'boolean'
    || (value.before !== null && !text(value.before, 32_768))) return null
  const target = value.target
  // Older clients encoded the conversation id; core's controller still accepts that bound alias.
  if ((target.sessionId !== session.agentId && target.sessionId !== session.sessionId) || target.engine !== session.engine || !text(target.model) || !target.model || !label(target.effort)
    || target.id !== encodeRuntimeProfile({ sessionId: target.sessionId, engine: session.engine, model: target.model, effort: target.effort })) return null
  return { target: { id: target.id, sessionId: target.sessionId, engine: session.engine, model: target.model, effort: target.effort },
    before: value.before, modelConfirmed: value.modelConfirmed, effortConfirmed: value.effortConfirmed }
}

/** Copy only the facts an engine needs. Workers cannot mutate core's caller-owned snapshot. */
export function runtimeContext(value: unknown, engine: ReaderEngine): RuntimeContext | null {
  if (!record(value) || !record(value.session) || !runtimeState(value.state)) return null
  const s = value.session
  // Catalogs can be requested before a conversation binds. Core never caches conversation state at ''.
  if (s.engine !== engine || !label(s.agentId) || !text(s.sessionId, 200) || !nullable(s.model) || !nullable(s.cliVersion)
    || (s.transcriptPath !== null && !path(s.transcriptPath)) || (s.cwd !== null && !path(s.cwd))
    || (s.codexHome != null && !path(s.codexHome))) return null
  const session: RuntimeSession = { agentId: s.agentId, sessionId: s.sessionId, engine, model: s.model, cliVersion: s.cliVersion,
    cwd: s.cwd, transcriptPath: s.transcriptPath, ...(s.codexHome === undefined ? {} : { codexHome: s.codexHome }) }
  const control = controlOf(value.control, session)
  if (control === null) return null
  const { model, effort, mode, cliVersion, observedAt } = value.state
  return { session, state: { model, effort, mode, cliVersion, observedAt }, ...(control ? { control } : {}) }
}

export function runtimeRecord(value: unknown): value is RuntimeRecord {
  return record(value) && Object.keys(value).length <= 16
    && Object.entries(value).every(([key, v]) => label(key) && (v === null || typeof v === 'boolean' || text(v, 32_768)))
}

export function runtimeOperation(value: unknown): RuntimeOperation | null {
  if (!record(value)) return null
  if (value.kind === 'records' && fields(value, ['kind', 'records']) && Array.isArray(value.records)
    && value.records.length <= RUNTIME_RECORDS && value.records.every(runtimeRecord)) {
    return { kind: value.kind, records: value.records.map(r => ({ ...r })) }
  }
  if (value.kind === 'pane' && fields(value, ['kind', 'text']) && text(value.text, 256 * 1024)) return { kind: value.kind, text: value.text }
  if (['config', 'models', 'catalog', 'describe'].includes(value.kind as string) && fields(value, ['kind'])) return { kind: value.kind as 'config' | 'models' | 'catalog' | 'describe' }
  if (value.kind === 'effort' && fields(value, ['kind', 'model', 'effort', 'listed']) && label(value.model) && label(value.effort)
    && (value.listed === null || (Array.isArray(value.listed) && value.listed.length <= 64 && value.listed.every(label)))) {
    return { kind: value.kind, model: value.model, effort: value.effort, listed: value.listed === null ? null : [...value.listed] }
  }
  return null
}

export function runtimeAnswer(value: unknown, context: RuntimeContext, operation: RuntimeOperation): value is RuntimeAnswer {
  const prefix = `runtime-v1:${encodeURIComponent(context.session.agentId)}:${context.session.engine}:`
  const profile = (id: unknown): boolean => {
    if (!text(id, 32_768) || !id.startsWith(prefix)) return false
    const split = id.lastIndexOf('@')
    if (split <= prefix.length || !/^[a-z0-9_-]+$/.test(id.slice(split + 1))) return false
    try {
      const model = decodeURIComponent(id.slice(prefix.length, split))
      return !!model && id === encodeRuntimeProfile({ sessionId: context.session.agentId, engine: context.session.engine, model, effort: id.slice(split + 1) })
    } catch { return false }
  }
  if (!record(value) || !runtimeState(value.state) || !nullable(value.cliVersion) || typeof value.supportsControl !== 'boolean'
    || (value.selectedModel !== null && !profile(value.selectedModel)) || (value.control !== null && !record(value.control))) return false
  const control = controlOf(value.control, context.session)
  if (control === null || !!control !== !!context.control
    || (control && (control.target.id !== context.control!.target.id || control.before !== context.control!.before))) return false
  if (operation.kind === 'models') return Array.isArray(value.models) && value.models.every(m => record(m) && profile(m.id) && text(m.displayName, 32_768))
  if (operation.kind === 'catalog') return Array.isArray(value.catalog) && value.catalog.every(m => record(m) && label(m.slug)
    && text(m.displayName) && typeof m.listed === 'boolean' && text(m.defaultEffort) && Array.isArray(m.efforts) && m.efforts.every(label))
  return operation.kind !== 'effort' || typeof value.effortAllowed === 'boolean'
}
