/** The built Cursor hook uses the same durable coordinator as core replay.
 * Native IDs are preserved; no transcript position can substitute for them. */
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeNotifyContext, NativeNotifyRuntime } from '../../../hook/notify.mjs'
import { prepareProcessImageHelper, type ProcessImageArtifact } from '../../lib/nativeProcessImageArtifact.js'
import { probeNativeProcessControl, type NativeControlHelpers } from '../../lib/nativeProcessControlProbe.js'
import { secureStateDirectory } from '../../lib/secureState.js'
import { parseNativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import { nativeAllocationIsInitial, parseNativeAllocation } from '../../lib/nativeAllocation.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { validNativeHookBody } from './nativeHookBody.js'
import { deliverNativeHookClient } from './nativeHookClient.js'
import { captureNativeHookClientOrigin } from './nativeHookOrigin.js'
import { openNativeHookStorage } from './nativeHookStorage.js'
import { sendNativeHookRequest } from './nativeHookTransport.js'

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)

/** Optional Cursor runtime evidence only restricts a fresh kernel observation.
 * An unreadable, oversized or ambiguous snapshot provides no runtime authority. */
export function nativeNotifyRuntime(dataDir: string, pane: string): NativeNotifyRuntime | undefined {
  let fd: number | undefined
  try {
    fd = openSync(join(dataDir, 'registry.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || stat.size > 4 * 1024 * 1024) return
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1)
    let used = 0
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, Math.min(65536, bytes.length - used), used)
      if (!count) break
      used += count
    }
    const after = fstatSync(fd)
    if (used > 4 * 1024 * 1024 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return
    const rows: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)))
    if (!Array.isArray(rows) || rows.length > 4096) return
    const candidates = rows.filter((row): row is NativeNotifyRuntime => (row?.schemaVersion === 2 && row.nativeControl === undefined && !Object.hasOwn(row, 'nativeAllocation')
      || row?.schemaVersion === 3 && !Object.hasOwn(row, 'nativeAllocation') && parseNativeTurnIntent(row.nativeControl) !== null
      || row?.schemaVersion === 4 && parseNativeTurnIntent(row.nativeControl) !== null
        && parseNativeAllocation(row.nativeAllocation)?.receipts.every(value => value.request.agentId === row.agentId)
      || row?.schemaVersion === 5 && row.nativeControl === undefined && (() => {
        const allocation = parseNativeAllocation(row.nativeAllocation)
        return !!allocation && nativeAllocationIsInitial(allocation) && allocation.receipts[0].request.agentId === row.agentId
      })()) && row.engine === 'cursor'
      && row.active === true && identifier(row.agentId) && row.processIdentity
      && Number.isSafeInteger(row.processIdentity.pid) && row.processIdentity.pid > 0
      && Array.isArray(row.runtimes) && row.runtimes.length <= 4
      && row.runtimes.some((route: { backend?: string; paneId?: string }) => route?.backend === 'tmux' && route.paneId === pane))
    if (candidates.length !== 1) return
    const { agentId, engine, active, processIdentity, runtimes, primaryRuntimeKey } = candidates[0]
    return structuredClone({ agentId, engine, active, processIdentity, runtimes, primaryRuntimeKey })
  } catch { return }
  finally { if (fd !== undefined) closeSync(fd) }
}

export function nativeCursorBody(context: NativeNotifyContext): Record<string, unknown> | undefined {
  const { input, event, tmuxPane, callerPid } = context
  // SessionEnd is a discovery hint, not turn or process-lifetime authority.
  if (event === 'sessionEnd') return
  if (!['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'afterAgentResponse', 'stop'].includes(event)) {
    throw Error('This Cursor hook event is unsupported; keeping the current turn.')
  }
  const sessionId = input.conversation_id ?? input.session_id
  if (!identifier(sessionId)) throw Error('The Cursor conversation ID is unavailable.')
  if (event !== 'sessionStart' && !identifier(input.generation_id)) {
    throw Error('This Cursor hook has no supported generation ID; waiting for a generation-aware hook.')
  }
  if (event === 'stop' && (typeof input.status !== 'string' || !['completed', 'aborted', 'error'].includes(input.status))) {
    throw Error('The Cursor Stop outcome is unavailable.')
  }
  if (event === 'afterAgentResponse' && (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 128 * 1024)) {
    throw Error('The complete Cursor response is unavailable or exceeds the retained response limit.')
  }
  const body = { engine: 'cursor', hookEvent: event, sessionId, tmuxPane,
    runtimeHints: [{ backend: 'tmux', paneId: tmuxPane }], callerPid,
    ...(event === 'sessionStart' ? {} : { generationId: input.generation_id }),
    ...(event === 'stop' ? { status: input.status } : {}),
    ...(event === 'afterAgentResponse' ? { responseText: input.text } : {}),
    ...(event === 'beforeSubmitPrompt' && typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
    ...(event === 'preToolUse' ? { toolUseId: input.tool_use_id, toolName: input.tool_name, input: input.tool_input } : {}),
    transcriptPath: input.transcript_path,
    cwd: Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : input.cwd,
    model: typeof input.model === 'string' ? input.model : undefined,
    cliVersion: input.cursor_version ?? input.version,
  }
  if (Buffer.byteLength(JSON.stringify(body)) > 240 * 1024) throw Error('The complete Cursor hook exceeds its retained delivery limit.')
  if (!validNativeHookBody(body, true)) throw Error('The complete Cursor hook has unsupported metadata or exceeds a field limit.')
  return body
}

export function createNativeNotifyCursor({ selfPid, artifact }: { selfPid: number; artifact?: ProcessImageArtifact }) {
  return async (input: NativeNotifyContext): Promise<void> => {
    const deadline = performance.now() + Math.max(0, input.timeoutMs)
    const context = structuredClone(input), body = nativeCursorBody(context)
    if (!body) return
    if (!context.credential) throw Error('The pane owner hook credential is unavailable.')
    // This snapshot predates stdin/routing. Never sample a replacement here.
    const runtime = context.runtime
    let prepared: Promise<{ path: string; key: string } | null> | undefined
    const helpers: NativeControlHelpers = {
      prepare: () => prepared ??= (async () => {
        if (!artifact) return null
        const path = await prepareProcessImageHelper(artifact, join(context.dataDir, 'native-hook-client-runtime'))
        return path ? { path, key: artifact.sha256 } : null
      })(),
      invalidate: () => { prepared = undefined },
    }
    const result = await deliverNativeHookClient({ id: context.id, firedAt: context.firedAt, port: context.port,
      phases: [{ name: 'registration', path: '/api/hook/session-start', body }],
    }, {
      timeoutMs: Math.max(0, deadline - performance.now()),
      captureOrigin: () => captureNativeHookClientOrigin(selfPid, context.callerPid,
        new NativeEvidenceBudget(Math.max(0, deadline - performance.now())),
        (pids, budget) => probeNativeProcessControl(pids, 0, budget, false, helpers), runtime),
      openStorage: async () => {
        secureStateDirectory(context.dataDir, false)
        const root = join(context.dataDir, 'native-hook-deliveries')
        secureStateDirectory(root)
        return openNativeHookStorage(root, helpers)
      },
      send: (request, current) => sendNativeHookRequest(request, context.credential, current,
        Math.max(1, deadline - performance.now())),
    })
    if (!result.owned) throw Error(result.reason ?? 'Waiting for confirmed native hook ownership.')
  }
}
