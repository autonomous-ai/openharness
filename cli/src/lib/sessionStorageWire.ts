/** Private session image protocol. Public agent views never contain its credential references. */
import type { GridLaunchOverride } from './gridLaunchWire.js'
import type { BigIntStats } from 'node:fs'

export const SESSION_STORAGE_FRAME_BYTES = 1024 * 1024
export const SESSION_STORAGE_PAGE_CHARS = 64 * 1024
export const SESSION_STORAGE_QUEUE = 64
export const SESSION_STORAGE_REQUEST_MS = 5_000

export function sessionFileIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs,
    stat.mode, stat.uid, stat.gid, stat.nlink].join(':')
}

/** Intermediate read fences compare the same fields without repeatedly formatting ten big integers. */
export function sameSessionFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.birthtimeNs === right.birthtimeNs
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
}

export type SessionDocument = { kind: 'registry' } | { kind: 'legacy-registry' } | { kind: 'names' }
  | { kind: 'stopped' | 'superseded'; agentId: string }

/** Exact byte digest and file metadata have different jobs; timestamps never prove byte equality. */
export interface SessionImageProof {
  document: SessionDocument
  identity: string
  bytes: number
  sha256: string
}

export interface CredentialRow {
  agentId: string
  registeredAt: number | null
}

export interface SessionCredentialReference {
  version: 1
  binding: string
  row: CredentialRow
  source: { kind: 'image'; proof: SessionImageProof } | { kind: 'import'; lease: string }
}

export type StoredGridLaunch = Omit<GridLaunchOverride, 'apiKey'> & { credential: SessionCredentialReference }

export const SESSION_STORAGE_SYSTEM_FAILURES = ['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM'] as const

export type SessionStorageFailure = 'missing' | 'unsafe' | 'changed' | 'invalid' | 'busy' | 'expired'
  | 'disconnected' | 'cleanup-unconfirmed' | typeof SESSION_STORAGE_SYSTEM_FAILURES[number]

export class SessionStorageUnavailable extends Error {
  constructor(readonly code: SessionStorageFailure) {
    super(`Session storage unavailable: ${code}`)
    this.name = 'SessionStorageUnavailable'
  }
}

/** A finite code preserves disk-vs-build decisions without carrying paths or operating-system error text. */
export function sessionStorageFailureCode(error: unknown): SessionStorageFailure {
  if (error instanceof SessionStorageUnavailable) return error.code
  const code = (error as NodeJS.ErrnoException | null)?.code
  return SESSION_STORAGE_SYSTEM_FAILURES.find(known => code === known) ?? 'unsafe'
}

export type SessionImage = { state: 'missing' }
  | { state: 'image'; proof: SessionImageProof; json: false }
  | { state: 'image'; proof: SessionImageProof; json: true; value: unknown }

export type SessionPreparedImage = {
  temporary: string
  proof: SessionImageProof
} & ({ projection: 'value'; value: unknown }
  | { projection: 'registry-credentials'; credentials: SessionCredentialReference[] })

export interface SessionImageReservation { temporary: string; identity: string }

export type StoppedArchiveQuery =
  | { kind: 'conversations'; ids: string[]; exceptAgentId?: string; exceptAgentIds?: string[]; scope?: { engine: string; codexHome: string | null }; reservations: boolean }
  | { kind: 'folder'; root: string; exceptAgentId: string }
  | { kind: 'owners'; keys: string[]; defaultCodexHome: string; exceptAgentId?: never }
export interface StoppedArchiveAnswer { witness: string; matches: boolean[]; selected?: SessionImage[] }
export const STOPPED_LIST_ROWS = 64
export const STOPPED_LIST_BYTES = 256 * 1024
export interface StoppedListPage {
  cursor: string
  offset: number
  next: number
  total: number
  images: SessionImage[]
  done: boolean
}

export type SessionStorageOperation =
  | { kind: 'stopped-list-page'; cursor: string | null }
  | { kind: 'stopped-list-close'; cursor: string }
  | { kind: 'creation-ensure'; id: string }
  | { kind: 'creation-page'; cursor: string | null }
  | { kind: 'creation-close'; cursor: string }
  | { kind: 'stopped-query'; query: StoppedArchiveQuery }
  | { kind: 'read'; document: SessionDocument; retain?: string }
  | { kind: 'equal'; proof: SessionImageProof }
  | { kind: 'import'; lease: string; row: CredentialRow; override: GridLaunchOverride }
  | { kind: 'release'; lease: string }
  | { kind: 'resolve'; reference: StoredGridLaunch }
  | { kind: 'prepare'; document: SessionDocument; source: SessionImageProof | null; value: unknown; reservation: SessionImageReservation; rawSource?: SessionImageProof }
  | { kind: 'discard'; temporary: string; identity: string }

export function sessionDocument(value: unknown): value is SessionDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.kind === 'registry' || row.kind === 'legacy-registry' || row.kind === 'names'
    || (row.kind === 'stopped' || row.kind === 'superseded') && typeof row.agentId === 'string'
      && /^[a-zA-Z0-9_-]{1,128}$/.test(row.agentId)
}

export function sessionImageProof(value: unknown): value is SessionImageProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return sessionDocument(row.document) && typeof row.identity === 'string' && /^[0-9:.-]{1,512}$/.test(row.identity)
    && Number.isSafeInteger(row.bytes) && (row.bytes as number) >= 0
    && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256)
}

export function sessionCredentialReference(value: unknown): value is SessionCredentialReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as SessionCredentialReference
  return ref.version === 1 && typeof ref.binding === 'string' && /^[a-f0-9]{64}$/.test(ref.binding)
    && !!ref.row && typeof ref.row.agentId === 'string' && ref.row.agentId.length > 0
    && (ref.row.registeredAt === null || Number.isFinite(ref.row.registeredAt))
    && !!ref.source && (ref.source.kind === 'image' ? sessionImageProof(ref.source.proof)
      : ref.source.kind === 'import' && typeof ref.source.lease === 'string' && /^[a-f0-9-]{36}$/.test(ref.source.lease))
}

export function storedGridLaunch(value: unknown): value is StoredGridLaunch {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, 'apiKey')) return false
  const row = value as StoredGridLaunch
  return typeof row.networkId === 'string' && !!row.networkId && typeof row.networkName === 'string' && !!row.networkName
    && typeof row.baseUrl === 'string' && !!row.baseUrl && sessionCredentialReference(row.credential)
}

/** Image witnesses change after unrelated writes. Only the row-bound binding participates in equality. */
export function credentialEquality(value: unknown): unknown {
  if (!storedGridLaunch(value)) return value
  const { credential, ...metadata } = value
  return { ...metadata, credential: { version: credential.version, binding: credential.binding, row: credential.row } }
}
