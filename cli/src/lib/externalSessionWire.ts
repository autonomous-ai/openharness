/** Search supplies bounded observations. Core alone reserves, admits, signals and launches. */
import { isAbsolute } from 'node:path'
import { EXTERNAL_ENGINES, type ExternalEngine, type ExternalSession } from './sessionSearch/externals/types.js'
import type { SessionOwner } from './sessionSearch/external.js'

export interface ExternalSessionRequest { sessionId: string; engine: ExternalEngine }
export type ExternalSessionFact = Omit<ExternalSession, 'readHistory'>
export interface ExternalSessionObservation {
  ok: true
  request: ExternalSessionRequest
  session: ExternalSessionFact | null
  owner: SessionOwner | null
  /** A process generation read with ownership evidence, never a bare PID grant. */
  generation: string | null
  busy: boolean
}
export interface ExternalSessionUnavailable {
  ok: false
  error: 'SEARCH_UNAVAILABLE'
  detail: string
}
export type ExternalSessionAnswer = ExternalSessionObservation | ExternalSessionUnavailable
export const externalUnavailable = (detail = 'Waiting for the search service to verify this conversation.'): ExternalSessionUnavailable =>
  ({ ok: false, error: 'SEARCH_UNAVAILABLE', detail })

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const id = (value: unknown): value is string => text(value, 200) && value.length > 0
const engine = (value: unknown): value is ExternalEngine => typeof value === 'string' && EXTERNAL_ENGINES.includes(value as ExternalEngine)
const path = (value: unknown): value is string => text(value, 4096) && isAbsolute(value)
const strings = (value: unknown, count: number, max: number): value is string[] => Array.isArray(value) && value.length <= count && value.every(item => text(item, max))

export function externalSessionRequest(value: unknown): ExternalSessionRequest | null {
  return object(value) && id(value.sessionId) && engine(value.engine) ? { sessionId: value.sessionId, engine: value.engine } : null
}

/** Copy only metadata; no history reader or native database can cross the boundary. */
export function externalSessionFact(value: unknown): ExternalSessionFact | null {
  if (!object(value) || !id(value.sessionId) || !engine(value.engine) || !path(value.cwd)
    || !['terminal', 'editor', 'app', 'claude-app', 'codex-app'].includes(String(value.origin))
    || !text(value.title, 4096) || typeof value.mtime !== 'number' || !Number.isFinite(value.mtime) || value.mtime < 0
    || !(value.transcriptPath === null || path(value.transcriptPath))
    || !(value.aliases === undefined || strings(value.aliases, 256, 200) && value.aliases.every(id))
    || !(value.launchArgs === undefined || strings(value.launchArgs, 64, 4096))
    || !(value.archived === undefined || value.archived === true)) return null
  return {
    sessionId: value.sessionId, engine: value.engine, cwd: value.cwd, origin: value.origin as ExternalSessionFact['origin'],
    title: value.title, mtime: value.mtime, transcriptPath: value.transcriptPath,
    ...(value.aliases ? { aliases: [...value.aliases as string[]] } : {}),
    ...(value.launchArgs ? { launchArgs: [...value.launchArgs as string[]] } : {}),
    ...(value.archived ? { archived: true } : {}),
  }
}

export function externalSessionOwner(value: unknown): SessionOwner | null {
  if (!object(value) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || (value.pid as number) > 0x7fffffff
    || !engine(value.engine) || !text(value.record, 4096) || !(value.tty === null || path(value.tty) && value.tty.startsWith('/dev/'))
    || !['harness', 'fromArgs', 'unverified'].every(key => value[key] === undefined || value[key] === true)) return null
  return { pid: value.pid as number, engine: value.engine, record: value.record, tty: value.tty,
    ...(value.harness ? { harness: true } : {}), ...(value.fromArgs ? { fromArgs: true } : {}),
    ...(value.unverified ? { unverified: true } : {}) }
}

/** A reply belongs to this exact request. Invalid/oversize/unavailable never means missing or free. */
export function externalSessionAnswer(value: unknown, request: ExternalSessionRequest): ExternalSessionAnswer {
  try {
    if (!object(value) || Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) return externalUnavailable()
    if (value.ok === false) return externalUnavailable(text(value.detail, 4096) ? value.detail : undefined)
    const target = externalSessionRequest(value.request)
    if (value.ok !== true || !target || target.sessionId !== request.sessionId || target.engine !== request.engine
      || typeof value.busy !== 'boolean' || !(value.generation === null || text(value.generation, 200) && value.generation.length > 0)) return externalUnavailable()
    const session = value.session === null ? null : externalSessionFact(value.session)
    const owner = value.owner === null ? null : externalSessionOwner(value.owner)
    if (value.session !== null && !session || value.owner !== null && !owner
      || session && session.sessionId !== request.sessionId && !session.aliases?.includes(request.sessionId)
      || owner && (!session || owner.engine !== session.engine)
      || !owner && (value.generation !== null || value.busy)) return externalUnavailable()
    return { ok: true, request: target, session, owner, generation: value.generation as string | null, busy: value.busy }
  } catch { return externalUnavailable() }
}
