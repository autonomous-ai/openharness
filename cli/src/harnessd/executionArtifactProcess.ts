/** Keep decoder allocation in a short-lived child; only claimed paths/hashes survive in the master. */
import { captureChild, type CaptureStart, type OwnedTask } from './childCapture.js'
import { adoptExecutionArtifact, type ExecutionArtifact } from './executionArtifacts.js'
import { preparationRequest, PREPARATION_REPLY_BYTES, type PreparationRequest } from './executionArtifactChild.js'
import { PROBE_TIMEOUT_MS } from './protocol.js'

declare const __WORKER_ARTIFACT_PREPARER__: string | undefined
export const PREPARATION_CODE_BYTES = 128 * 1024
export const embeddedPreparer = (): string | undefined => typeof __WORKER_ARTIFACT_PREPARER__ === 'undefined' ? undefined : __WORKER_ARTIFACT_PREPARER__

export function createArtifactPreparation(options: { directory: string; node: string; keepMasterEntry?: string; code?: string; start?: CaptureStart }) {
  let active = false, unsettled = false
  return { prepare(originalScript: string, expected: string): OwnedTask<ExecutionArtifact> {
    if (unsettled) throw new Error('worker_artifact_cleanup_unsettled')
    if (active) throw new Error('worker_artifact_in_use')
    const code = options.code ?? embeddedPreparer()
    const request: PreparationRequest = { originalScript, expected, directory: options.directory, parentPid: process.pid,
      ...(options.keepMasterEntry ? { keepMasterEntry: options.keepMasterEntry } : {}) }
    if (!code || Buffer.byteLength(code) > PREPARATION_CODE_BYTES || !preparationRequest(request, process.pid)) throw new Error('worker_artifact_request_refused')
    const input = `const __HARNESSD_PREPARATION_REQUEST__ = ${JSON.stringify(request)};\n${code}`
    // No login environment or feature state is needed to read and publish an owned code image.
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []))
    active = true
    const running = captureChild(options.node, ['--input-type=module'], env, PROBE_TIMEOUT_MS, options.start, input)
    return { cancel: running.cancel, result: running.result.then(result => {
      if (!result.started) { active = false; throw new Error('worker_artifact_source_unavailable') }
      // Until a complete typed reply proves otherwise, a candidate may have been published under our PID.
      unsettled = true
      if (result.failure || result.code !== 0 || result.err || Buffer.byteLength(result.out) > PREPARATION_REPLY_BYTES) throw new Error('worker_artifact_cleanup_unsettled')
      let reply: unknown
      try { reply = JSON.parse(result.out) } catch { throw new Error('worker_artifact_cleanup_unsettled') }
      if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('worker_artifact_cleanup_unsettled')
      const value = reply as Record<string, unknown>
      if (value.ok === false && Object.keys(value).every(key => ['ok', 'code'].includes(key))
        && typeof value.code === 'string' && /^worker_artifact_(request_refused|source_unavailable|source_changed|source_close_unsettled|cleanup_unsettled|reserved_name|publish_failed)$/.test(value.code)) {
        if (!value.code.endsWith('_unsettled')) { unsettled = false; active = false }
        throw new Error(value.code)
      }
      if (value.ok !== true || Object.keys(value).some(key => !['ok', 'artifact'].includes(key))) throw new Error('worker_artifact_cleanup_unsettled')
      const artifact = adoptExecutionArtifact(originalScript, expected, value.artifact, options)
      unsettled = false
      let released = false
      return { ...artifact, release: () => { if (!released) { artifact.release(); released = true; active = false } } }
    }) }
  } }
}
