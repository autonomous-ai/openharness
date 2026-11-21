/** The paste service receives bytes, never terminal authority. There is no upload queue or map here. */
import { randomUUID } from 'node:crypto'
import type { PasteBegin, PastePort, PasteResult } from './api.js'
import type { ServiceLinks } from './serviceLinks.js'

export const PASTE_LINK_BYTES = 36 * 1024 * 1024
const CONTROL_BYTES = 2048
type Link = Pick<ServiceLinks, 'call' | 'notify' | 'notifyBinary' | 'buffered'>

export function createPasteLink(link: Link): PastePort {
  const event = (payload: Record<string, unknown>) => link.notify('paste', { type: 'service_event', payload })
  const cancel = (generation: string | null) => { event({ kind: 'cancel', generation }) }
  const result = (answer: Record<string, unknown>): PasteResult => {
    if (answer.ignored === true) return { ignored: true }
    if (typeof answer.error === 'string') return { error: /^PASTE_[A-Z_]{1,40}$/.test(answer.error) ? answer.error : 'PASTE_UNAVAILABLE' }
    if (!Number.isSafeInteger(answer.bytesWritten) || !Number.isSafeInteger(answer.totalBytes)
      || Number(answer.bytesWritten) < 0 || Number(answer.totalBytes) <= 0 || Number(answer.bytesWritten) > Number(answer.totalBytes)
      || Number(answer.totalBytes) > 20 * 1024 * 1024) return { error: 'PASTE_INVALID_RESULT' }
    const artifact = answer.artifact as Record<string, unknown> | undefined
    if (artifact && (answer.bytesWritten !== answer.totalBytes || typeof artifact.name !== 'string' || Buffer.byteLength(artifact.name) > 200
      || typeof artifact.version !== 'string' || artifact.version.length > 200)) return { error: 'PASTE_INVALID_RESULT' }
    return { bytesWritten: Number(answer.bytesWritten), totalBytes: Number(answer.totalBytes),
      ...(artifact ? { artifact: { name: artifact.name as string, version: artifact.version as string } } : {}) }
  }
  return {
    async begin(request: PasteBegin) {
      const { kind, ...upload } = request
      const payload = { kind: 'begin', ...upload, uploadKind: kind, deadline: Date.now() + 8_000 }
      if (Buffer.byteLength(JSON.stringify(payload)) > CONTROL_BYTES - 256
        || link.buffered('paste') + CONTROL_BYTES > PASTE_LINK_BYTES
        || !event(payload)) return { error: 'PASTE_UNAVAILABLE' }
      const answer = await link.call('paste', 'begin', { generation: request.generation }, 8_000)
      if (answer.accepted === true) return { accepted: true }
      cancel(request.generation)
      return { error: typeof answer.error === 'string' && /^PASTE_[A-Z_]{1,40}$/.test(answer.error) ? answer.error : 'PASTE_UNAVAILABLE' }
    },
    async chunk(request, bytes) {
      const operation = randomUUID()
      const payload = { kind: 'chunk', ...request, operation, length: bytes.byteLength, deadline: Date.now() + 30_000 }
      // Both sends and the RPC registration are synchronous. Another chunk cannot interleave its header/body.
      if (bytes.byteLength > 256 * 1024 || Buffer.byteLength(JSON.stringify(payload)) > CONTROL_BYTES - 256
        || link.buffered('paste') + bytes.byteLength + CONTROL_BYTES > PASTE_LINK_BYTES
        || !event(payload)) return { error: 'PASTE_UNAVAILABLE' }
      if (!link.notifyBinary('paste', bytes)) { cancel(request.generation); return { error: 'PASTE_UNAVAILABLE' } }
      const answer = result(await link.call('paste', 'chunk', { operation }, 30_000))
      if ('error' in answer) cancel(request.generation)
      return answer
    },
    async clipboard(request) {
      const payload = { ...request, corePid: process.pid, deadline: Date.now() + 30_000 }
      if (Buffer.byteLength(JSON.stringify(payload)) > CONTROL_BYTES - 256
        || link.buffered('paste') + CONTROL_BYTES > PASTE_LINK_BYTES) return { state: 'unavailable', reason: 'PASTE_UNAVAILABLE' }
      const answer = await link.call('paste', 'clipboard', payload, 30_000)
      if (answer.state === 'written') return { state: 'written' }
      return { state: answer.state === 'failed' ? 'failed' : 'unavailable',
        reason: typeof answer.reason === 'string' && /^PASTE_[A-Z_]{1,40}$/.test(answer.reason) ? answer.reason : 'PASTE_UNAVAILABLE' }
    },
    releaseClipboard: (generation) => { event({ kind: 'clipboard_release', generation, corePid: process.pid }) },
    cancel,
    stop: () => { event({ kind: 'stop' }) },
  }
}
