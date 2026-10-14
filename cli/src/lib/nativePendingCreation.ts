/** A claimed first launch owns its identity before its pane or engine exists.
 * Recovery may account for that allocation; it never repeats the claimed work. */
import { creationFingerprint, type NativeCreationRequest } from './agentCreationReceipt.js'
import { nativeCreateFingerprint, parseNativeCreateRequest } from './nativeCreateRequest.js'
import { parseNativeLaunchPlacement, type NativeLaunchAllocation } from './nativeLaunchAllocation.js'
import type { RegisteredSession } from './registry.js'

export interface NativePendingCreation {
  readonly version: 1
  readonly receipt: NativeCreationRequest
  readonly revoked: boolean
  /** Only the original claimed callback can fill the prepared image once. */
  readonly prepared: boolean
  readonly metadata: string
  /** A pane ID alone cannot distinguish a restarted server or reused route. */
  readonly placement?: NativeLaunchAllocation
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',')

/** These are the resolved choices the one pane actually receives. A later
 * service answer or generic observation cannot rewrite its launch metadata. */
export const nativeCreationMetadataKeys = ['agentId', 'registeredAt', 'engine', 'cwd', 'grid', 'gridLaunch', 'gridWebSearch',
  'scmLaunch', 'codexHome', 'hermesHome', 'dsh', 'dshRuntime', 'agent', 'permissionMode', 'bypassPermission',
  'defaultName', 'startedBy', 'parentAgentId'] as const
export function nativeCreationMetadata(row: Partial<RegisteredSession>): string {
  return creationFingerprint(nativeCreationMetadataKeys.map(key => row[key] ?? null))
}

export function parseNativePendingCreation(value: unknown): NativePendingCreation | null {
  if (!object(value) || !exact(value, ['version', 'receipt', 'revoked', 'prepared', 'metadata',
    ...(Object.hasOwn(value, 'placement') ? ['placement'] : [])]) || value.version !== 1
    || typeof value.revoked !== 'boolean' || typeof value.prepared !== 'boolean'
    || typeof value.metadata !== 'string' || !/^[a-f0-9]{64}$/.test(value.metadata)
    || !object(value.receipt) || !exact(value.receipt, ['fingerprint', 'request'])) return null
  const request = parseNativeCreateRequest(value.receipt.request)
  const placement = Object.hasOwn(value, 'placement') ? parseNativeLaunchPlacement(value.placement) : undefined
  if (!request || value.receipt.fingerprint !== nativeCreateFingerprint(request)
    || placement === null || placement && (!value.prepared || placement.token !== request.launchToken)) return null
  return Object.freeze({ version: 1, receipt: Object.freeze({ fingerprint: value.receipt.fingerprint as string, request }),
    revoked: value.revoked, prepared: value.prepared, metadata: value.metadata, ...(placement ? { placement } : {}) })
}

export function nativePendingCreationRow(row: Partial<RegisteredSession>, pending: NativePendingCreation): boolean {
  const placement = pending.placement
  return row.schemaVersion === 6 && row.engine === 'cursor' && row.agentId === pending.receipt.request.agentId
    && row.active === false && row.sessionId === '' && row.boundAt === null && row.processIdentity === null
    && row.transcriptPath === null && row.launch?.state === 'held' && row.launch.service === 'native'
    && !row.externalResume && !row.nativeArchive && !row.nativeRetirement && !row.nativeAllocation && !row.resumeOnly
    && (pending.revoked ? !!row.nativeControl && !row.nativeControl.rearm && row.nativeControl.cancel.processKey === null
      && row.nativeControl.cancel.request.agentId === row.agentId && row.nativeControl.cancel.request.conversationId === '' : !row.nativeControl)
    && Array.isArray(row.runtimes) && (placement
      ? row.runtimes.length === 1 && row.runtimes[0].backend === 'tmux' && row.runtimes[0].paneId === placement.pane
        && row.primaryRuntimeKey === `tmux\0${placement.pane}` && row.tmuxPane === placement.pane
      : row.runtimes.length === 0 && row.primaryRuntimeKey === '' && (row.tmuxPane === undefined || row.tmuxPane === ''))
    && pending.metadata === nativeCreationMetadata(row)
}
