/** Shared wire limits prevent the client from retaining bytes core can never admit. */
import { ENGINES, type AgentEngine } from '../types.js'

const HOOK_BODY_FIELDS = new Set([
  'engine', 'launcherId', 'sessionId', 'transcriptPath', 'cwd', 'source', 'tmuxPane', 'title', 'model',
  'cliVersion', 'runtimeHints', 'callerPid', 'hookEvent', 'pluginVersion', 'reason', 'status', 'toolUseId',
  'toolName', 'input', 'prompt', 'nativeOrigin', 'generationId', 'responseText',
])

function optionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || value === null || (typeof value === 'string'
    && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value))
}

function optionalBoundedJson(value: unknown, max: number): boolean {
  if (value === undefined) return true
  try { return Buffer.byteLength(JSON.stringify(value)) <= max } catch { return false }
}

export function validNativeHookBody(value: unknown, native = false): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  if (body.generationId !== undefined && !native) return false
  if (body.responseText !== undefined && (!native || body.engine !== 'cursor' || body.hookEvent !== 'afterAgentResponse'
    || body.generationId === undefined || typeof body.responseText !== 'string' || Buffer.byteLength(body.responseText) > 128 * 1024)) return false
  if (body.prompt !== undefined && (typeof body.prompt !== 'string' || Buffer.byteLength(body.prompt) > 128 * 1024)) return false
  if (!optionalBoundedJson(body.nativeOrigin, 8_192)) return false
  if (Object.keys(body).some((field) => !HOOK_BODY_FIELDS.has(field))) return false
  if (body.engine !== undefined && (typeof body.engine !== 'string' || !ENGINES.includes(body.engine as AgentEngine))) return false
  if (!optionalBoundedString(body.launcherId, 200)
    || !optionalBoundedString(body.sessionId, 200)
    || !optionalBoundedString(body.generationId, 200)
    || !optionalBoundedString(body.transcriptPath, 4_096)
    || !optionalBoundedString(body.cwd, 4_096)
    || !optionalBoundedString(body.source, 1_000)
    || !optionalBoundedString(body.tmuxPane, 32)
    || !optionalBoundedString(body.title, 1_000)
    || !optionalBoundedString(body.model, 200)
    || !optionalBoundedString(body.cliVersion, 200)
    || !optionalBoundedString(body.hookEvent, 100)
    || !optionalBoundedString(body.pluginVersion, 100)
    || !optionalBoundedString(body.reason, 500)
    || !optionalBoundedString(body.status, 100)
    || !optionalBoundedString(body.toolUseId, 200)
    || !optionalBoundedString(body.toolName, 200)
    || !optionalBoundedJson(body.input, 128 * 1024)) return false
  if (body.callerPid !== undefined
    && (!Number.isSafeInteger(body.callerPid) || (body.callerPid as number) <= 0)) return false
  if (body.runtimeHints !== undefined) {
    if (!Array.isArray(body.runtimeHints) || body.runtimeHints.length > 4) return false
    for (const value of body.runtimeHints) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const hint = value as Record<string, unknown>
      if (hint.backend === 'tmux') {
        if (Object.keys(hint).some((field) => field !== 'backend' && field !== 'paneId')
          || typeof hint.paneId !== 'string' || !/^%\d+$/.test(hint.paneId)) return false
      } else if (hint.backend === 'herdr') {
        // A hook script installed by an earlier build still sends these from inside a Herdr pane. The
        // backend is retired and `normalizedRuntimeHints` drops the hint, but the rest of the body is
        // still good evidence, so the shape stays accepted rather than failing the whole request.
        if (Object.keys(hint).some((field) => !['backend', 'paneId', 'sessionName', 'socketPath'].includes(field))
          || !optionalBoundedString(hint.paneId, 200) || !hint.paneId
          || !optionalBoundedString(hint.sessionName, 64)
          || !optionalBoundedString(hint.socketPath, 4_096)) return false
      } else return false
    }
  }
  return true
}
