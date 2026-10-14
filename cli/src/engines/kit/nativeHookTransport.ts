/** Bounded loopback transport for immutable native hook requests. HTTP success
 * alone is not ownership; the caller validates the exact protocol receipt. */
import http from 'node:http'
import type { Socket } from 'node:net'
import type { NativeHookClientRequest } from './nativeHookClient.js'
import { NATIVE_HOOK_ROUTE_PREFIX, nativeHookMutationRoute } from './nativeHookClientProtocol.js'

export async function sendNativeHookRequest(request: NativeHookClientRequest, credential: string, current: () => boolean,
  timeoutMs = 500,
): Promise<unknown> {
  // A background retry may spend the remainder of its original attempt here.
  // Short-lived hook clients retain the 500 ms default; neither gets a new
  // attempt deadline when a slow local receipt finally arrives.
  if (!Number.isFinite(timeoutMs)) return undefined
  const deadline = performance.now() + Math.max(1, Math.min(4500, timeoutMs))
  const active = () => current() && performance.now() < deadline
  if (!active() || !credential || !Number.isSafeInteger(request.port) || request.port < 1 || request.port > 65535
    || !Number.isSafeInteger(request.firedAt) || request.firedAt <= 0 || !/^[a-zA-Z0-9_-]{16,96}$/.test(request.id)
    || Buffer.byteLength(request.body) > 256 * 1024 || !request.path.startsWith(NATIVE_HOOK_ROUTE_PREFIX)) return undefined
  try {
    if (nativeHookMutationRoute('/api/hook/' + request.path.slice(NATIVE_HOOK_ROUTE_PREFIX.length)) !== request.path) return undefined
  } catch { return undefined }
  return new Promise(resolve => {
    let req: http.ClientRequest | undefined, response: http.IncomingMessage | undefined, socket: Socket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined, finished = false, requestClosed = false, socketClosed = false, outcome: unknown
    const cleanupComplete = () => { if (finished && requestClosed && (!socket || socketClosed)) resolve(outcome) }
    const finish = (value?: unknown) => {
      if (finished) return
      finished = true; outcome = value; clearTimeout(timer)
      response?.destroy(); req?.destroy()
      cleanupComplete()
    }
    try {
      req = http.request({ host: '127.0.0.1', port: request.port, path: request.path, method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(request.body),
          'x-harness-hook-token': credential, 'x-harness-hook-delivery-id': request.id,
          'x-harness-hook-fired-at': String(request.firedAt) },
      }, res => {
        response = res
        if (finished) { res.destroy(); return }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { finish(); return }
        const chunks: Buffer[] = []
        let bytes = 0
        res.on('data', (chunk: Buffer) => {
          if (finished) return
          bytes += chunk.length
          if (bytes > 16_384) { finish(); return }
          chunks.push(chunk)
        })
        res.once('error', () => finish()); res.once('aborted', () => finish())
        res.once('close', () => finish())
        res.once('end', () => {
          if (finished) return
          try {
            const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)))
            finish(active() ? value : undefined)
          } catch { finish() }
        })
      })
      req.once('socket', connected => {
        socket = connected
        connected.once('close', () => { socketClosed = true; cleanupComplete() })
        if (finished) connected.destroy()
      })
      req.once('close', () => { requestClosed = true; finish(); cleanupComplete() })
      req.once('error', () => finish())
      timer = setTimeout(() => finish(), Math.max(1, deadline - performance.now()))
      if (!active()) finish()
      else req.end(request.body)
    } catch {
      if (!req) { requestClosed = true; finish() }
      else finish()
    }
  })
}
