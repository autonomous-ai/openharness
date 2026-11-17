/** The preparer's entire authority is one fixed-shape request from its actual parent. */
import { isAbsolute } from 'node:path'
import { artifactMetadata, createExecutionArtifacts } from './executionArtifacts.js'

export const PREPARATION_DATA_BYTES = 16 * 1024
export const PREPARATION_REPLY_BYTES = 4 * 1024
export interface PreparationRequest { originalScript: string; expected: string; directory: string; parentPid: number; keepMasterEntry?: string }

export function preparationRequest(value: unknown, parentPid: number): value is PreparationRequest {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > PREPARATION_DATA_BYTES) return false
    const input = value as Record<string, unknown>
    const path = (item: unknown): item is string => typeof item === 'string' && !item.includes('\0') && isAbsolute(item)
    return Object.keys(input).every(key => ['originalScript', 'expected', 'directory', 'parentPid', 'keepMasterEntry'].includes(key))
      && path(input.originalScript) && path(input.directory) && typeof input.expected === 'string' && /^[0-9a-f]{64}$/.test(input.expected)
      && Number.isSafeInteger(input.parentPid) && input.parentPid === parentPid && parentPid > 0
      && (input.keepMasterEntry === undefined || path(input.keepMasterEntry))
  } catch { return false }
}

export function prepareArtifact(value: unknown, parentPid = process.ppid): object {
  if (!preparationRequest(value, parentPid)) return { ok: false, code: 'worker_artifact_request_refused' }
  try {
    const owner = createExecutionArtifacts({ directory: value.directory, pid: parentPid, keepMasterEntry: value.keepMasterEntry })
    return { ok: true, artifact: artifactMetadata(owner.prepare(value.originalScript, value.expected)) }
  } catch (error) {
    const code = error instanceof Error && /^worker_artifact_(source_unavailable|source_changed|source_close_unsettled|reserved_name|publish_failed|cleanup_unsettled)$/.test(error.message)
      ? error.message : 'worker_artifact_cleanup_unsettled'
    return { ok: false, code }
  }
}
