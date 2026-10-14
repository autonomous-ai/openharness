/** The original saved Resume owns one live visit, even when later Cancel or
 * Restart replaces its rearm request. This link grants no launch permission. */
export interface NativeArchiveLink {
  readonly version: 1
  readonly agentId: string
  readonly requestId: string
  readonly launchToken: string
  readonly target: string
}

/** The archive retains its old snapshot as history while this exact live visit
 * owns control. Registry absence cannot turn it back into a saved owner. */
export interface NativeArchiveTransfer {
  readonly version: 1
  readonly link: NativeArchiveLink
  readonly pendingTarget: string
  readonly processKey: string
  readonly pane: string
}

/** `returning` is still live-owned. `saved` is the durable receipt for that
 * closed visit, retained while later saved edits change the session itself. */
export interface NativeArchiveReturn {
  readonly version: 1
  readonly phase: 'returning' | 'saved'
  readonly link: NativeArchiveLink
  readonly sourceTarget: string
  readonly controlFingerprint: string
  readonly checkpoint: string
  readonly savedTarget: string
}

/** A cancelled Resume can retire its pending route before saved ownership ever
 * transfers. Persist that provenance: a missing normal return is not an abort. */
export interface NativeArchiveRetirement extends NativeArchiveReturn {
  readonly pendingAbort?: Readonly<{
    kind: 'untransferred'
    priorRole: string
    pendingControl: string
    requestFingerprint: string
  }>
}

/** Produced after exact engine termination and original allocation accounting.
 * Cancellation or an empty Registry lookup is not a stopped-process proof.
 * Its evidence survives the intentional Registry rename; that source file's
 * separate proof belongs to Registry, not to verifyStopped. */
export interface NativeArchiveStopProof {
  readonly source: Readonly<{ target: string; controlFingerprint: string }>
  verifyStopped(): void
  current(): void
}

export type NativeArchiveEnvelope = { version: 1; session: unknown }
  | { version: 2; session: unknown; nativeTransfer: NativeArchiveTransfer }
  | { version: 3; session: unknown; nativeReturn: NativeArchiveReturn }

/** Both the daemon and the pre-exec witness read these roles. An older version
 * must never turn transferred or returning history into saved authority. */
export function parseNativeArchiveEnvelope(value: unknown): NativeArchiveEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.version === 1 && !Object.hasOwn(raw, 'nativeTransfer') && !Object.hasOwn(raw, 'nativeReturn')) {
    return { version: 1, session: raw.session }
  }
  if (raw.version === 2 && Object.keys(raw).sort().join(',') === 'nativeTransfer,session,version') {
    const nativeTransfer = parseNativeArchiveTransfer(raw.nativeTransfer)
    if (nativeTransfer) return { version: 2, session: raw.session, nativeTransfer }
  }
  if (raw.version === 3 && Object.keys(raw).sort().join(',') === 'nativeReturn,session,version') {
    const nativeReturn = parseNativeArchiveReturn(raw.nativeReturn)
    if (nativeReturn) return { version: 3, session: raw.session, nativeReturn }
  }
  return null
}

export function parseNativeArchiveLink(value: unknown): NativeArchiveLink | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'agentId,launchToken,requestId,target,version' || row.version !== 1
    || typeof row.agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.agentId)
    || typeof row.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,96}$/.test(row.requestId)
    || typeof row.launchToken !== 'string' || !/^[a-zA-Z0-9_-]{16,96}$/.test(row.launchToken)
    || typeof row.target !== 'string' || !/^[a-f0-9]{64}$/.test(row.target)) return null
  return Object.freeze({ version: 1, agentId: row.agentId, requestId: row.requestId, launchToken: row.launchToken, target: row.target })
}

export function parseNativeArchiveTransfer(value: unknown): NativeArchiveTransfer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>, link = parseNativeArchiveLink(row.link)
  if (Object.keys(row).sort().join(',') !== 'link,pane,pendingTarget,processKey,version' || row.version !== 1 || !link
    || typeof row.pendingTarget !== 'string' || !/^[a-f0-9]{64}$/.test(row.pendingTarget)
    || typeof row.processKey !== 'string' || !row.processKey || row.processKey.length > 512
    || typeof row.pane !== 'string' || !/^%\d{1,20}$/.test(row.pane)) return null
  return Object.freeze({ version: 1, link, pendingTarget: row.pendingTarget, processKey: row.processKey, pane: row.pane })
}

export function parseNativeArchiveReturn(value: unknown): NativeArchiveReturn | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>, link = parseNativeArchiveLink(row.link)
  if (Object.keys(row).sort().join(',') !== 'checkpoint,controlFingerprint,link,phase,savedTarget,sourceTarget,version'
    || row.version !== 1 || (row.phase !== 'returning' && row.phase !== 'saved') || !link
    || ![row.sourceTarget, row.controlFingerprint, row.checkpoint, row.savedTarget].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) return null
  return Object.freeze({ version: 1, phase: row.phase, link, sourceTarget: row.sourceTarget as string,
    controlFingerprint: row.controlFingerprint as string, checkpoint: row.checkpoint as string, savedTarget: row.savedTarget as string })
}

export function parseNativeArchiveRetirement(value: unknown): NativeArchiveRetirement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!Object.hasOwn(value, 'pendingAbort')) return parseNativeArchiveReturn(value)
  const { pendingAbort, ...rest } = value as Record<string, unknown>, role = parseNativeArchiveReturn(rest)
  if (!role || role.phase !== 'returning' || !pendingAbort || typeof pendingAbort !== 'object' || Array.isArray(pendingAbort)) return null
  const abort = pendingAbort as Record<string, unknown>
  if (Object.keys(abort).sort().join(',') !== 'kind,pendingControl,priorRole,requestFingerprint' || abort.kind !== 'untransferred'
    || ![abort.priorRole, abort.pendingControl, abort.requestFingerprint].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) return null
  return Object.freeze({ ...role, pendingAbort: Object.freeze({ kind: 'untransferred', priorRole: abort.priorRole as string,
    pendingControl: abort.pendingControl as string, requestFingerprint: abort.requestFingerprint as string }) })
}
