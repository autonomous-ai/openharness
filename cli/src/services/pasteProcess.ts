/** Private ordered header/body bridge; all correlation and upload work stays in the edge process. */
import type { PasteBegin, PastePort, PasteResult, PasteUpload } from '../core/api.js'
import { createPasteFiles } from './paste.js'
import { runServiceProcess, type ServiceProcess } from './process.js'

export interface PasteProcessOptions {
  dataDir: string; socketPath: string; machineId: string; token: string
  run?: typeof runServiceProcess
  files?: PastePort
}
type Pending = { result: Promise<Record<string, unknown>>; timer: ReturnType<typeof setTimeout> }
type Header = PasteUpload & { seq: number; operation: string; length: number; deadline: number }
const unavailable = () => ({ error: 'PASTE_UNAVAILABLE' })

export function runPasteService(options: PasteProcessOptions): ServiceProcess {
  const files = options.files ?? createPasteFiles(options.dataDir)
  const results = new Map<string, Pending>()
  let header: Header | null = null
  let headerTimer: ReturnType<typeof setTimeout> | undefined
  const keep = (key: string, result: Promise<Record<string, unknown>>, generation: string): void => {
    // 32 begins plus 128 chunk operations: enough for every accepted upload's four-frame window.
    if (results.has(key) || results.size >= 160) { files.cancel(generation); return }
    const timer = setTimeout(() => { results.delete(key); files.cancel(generation) }, 30_000)
    timer.unref()
    results.set(key, { result, timer })
  }
  const take = async (key: string): Promise<Record<string, unknown>> => {
    const pending = results.get(key)
    if (!pending) return unavailable()
    // Delete at claim, not settlement: duplicate RPCs cannot replay an artifact.
    results.delete(key); clearTimeout(pending.timer)
    return pending.result
  }
  const clear = () => {
    header = null; clearTimeout(headerTimer)
    for (const entry of results.values()) clearTimeout(entry.timer)
    results.clear(); files.cancel(null)
  }
  const expireHeader = () => {
    // Every header removal clears its timer; direct callers check the header before expiring it.
    const expired = header!; header = null; clearTimeout(headerTimer)
    keep(expired.operation, Promise.resolve({ error: 'PASTE_UPLOAD_TIMEOUT' }), expired.generation)
    files.cancel(expired.generation)
  }
  const service = (options.run ?? runServiceProcess)({
    name: 'paste', socketPath: options.socketPath, machineId: options.machineId, token: options.token,
    requests: {
      begin: (payload) => take(`begin:${String(payload.generation)}`), chunk: (payload) => take(String(payload.operation)),
      clipboard: (payload) => {
        const artifact = payload.artifact as Record<string, unknown> | undefined
        if (typeof payload.generation !== 'string' || payload.generation.length !== 36
          || typeof payload.streamId !== 'string' || payload.streamId.length !== 36
          || typeof payload.connection !== 'string' || payload.connection.length > 512
          || !Number.isSafeInteger(payload.corePid) || Number(payload.corePid) < 1 || Number(payload.corePid) > 0x7fffffff
          || !artifact || typeof artifact.name !== 'string' || Buffer.byteLength(artifact.name) > 200
          || typeof artifact.version !== 'string' || artifact.version.length > 200
          || !Number.isSafeInteger(payload.deadline) || Number(payload.deadline) <= Date.now()) {
          return { state: 'unavailable', reason: 'PASTE_UPLOAD_UNAVAILABLE' }
        }
        return files.clipboard({ generation: payload.generation, streamId: payload.streamId, connection: payload.connection,
          artifact: { name: artifact.name, version: artifact.version }, corePid: Number(payload.corePid) })
      },
    },
    onEvent(payload) {
      if (payload.kind === 'clipboard_release') {
        if (typeof payload.generation === 'string' && Number.isSafeInteger(payload.corePid) && Number(payload.corePid) > 0
          && Number(payload.corePid) <= 0x7fffffff) files.releaseClipboard(payload.generation, Number(payload.corePid))
        return
      }
      if (payload.kind === 'cancel') {
        const generation = typeof payload.generation === 'string' ? payload.generation : null
        if (generation === null || header?.generation === generation) { header = null; clearTimeout(headerTimer) }
        files.cancel(generation); return
      }
      if (payload.kind === 'stop') { clear(); return }
      if (payload.kind === 'begin') {
        const request: PasteBegin = { generation: payload.generation as string, connection: payload.connection as string,
          streamId: payload.streamId as string, filename: payload.filename as string, totalBytes: payload.totalBytes as number,
          ...(payload.uploadKind !== undefined ? { kind: payload.uploadKind as PasteBegin['kind'] } : {}) }
        if (typeof request.generation !== 'string' || typeof request.connection !== 'string' || typeof request.streamId !== 'string'
          || typeof request.filename !== 'string' || !Number.isSafeInteger(payload.deadline)) return
        if (results.has(`begin:${request.generation}`)) return
        if (results.size >= 160) { files.cancel(request.generation); return }
        keep(`begin:${request.generation}`, Number(payload.deadline) <= Date.now()
          ? Promise.resolve({ error: 'PASTE_UPLOAD_TIMEOUT' }) : files.begin(request), request.generation)
      }
      if (payload.kind === 'chunk') {
        if (header) { keep(header.operation, Promise.resolve(unavailable()), header.generation); files.cancel(header.generation) }
        header = null; clearTimeout(headerTimer)
        if (typeof payload.generation !== 'string' || typeof payload.connection !== 'string' || typeof payload.streamId !== 'string'
          || typeof payload.operation !== 'string' || payload.operation.length > 36 || !Number.isSafeInteger(payload.seq)
          || !Number.isSafeInteger(payload.length) || Number(payload.length) < 1 || Number(payload.length) > 256 * 1024
          || !Number.isSafeInteger(payload.deadline)) return
        header = payload as unknown as Header
        if (header.deadline <= Date.now()) { expireHeader(); return }
        headerTimer = setTimeout(expireHeader, Math.min(30_000, header.deadline - Date.now()))
        headerTimer.unref()
      }
    },
    onBinary(bytes) {
      if (header && header.deadline <= Date.now()) { expireHeader(); return }
      const received = header; header = null; clearTimeout(headerTimer)
      if (!received) return
      if (results.size >= 160 || results.has(received.operation)) { files.cancel(received.generation); return }
      let result: Promise<PasteResult>
      if (bytes.byteLength !== received.length) {
        files.cancel(received.generation); result = Promise.resolve({ error: 'PASTE_INVALID_CHUNK' })
      } else result = files.chunk(received, bytes)
      keep(received.operation, result, received.generation)
    },
    onDisconnected: clear,
  })
  return { async stop() { clear(); const stopped = files.stop(); service.stop(); await stopped } }
}
