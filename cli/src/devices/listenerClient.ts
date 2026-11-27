/**
 * One message from a tool on this computer to the devices' own listener (services/devicesListener.ts): `POST /` on its
 * socket, or on Windows its pipe, the message as JSON; for an ask's message the JSON object it answers, and for a
 * stream's message the stream it answers. What is sent can say which app is in front, or which tab, so it goes only
 * where this account's devices alone can answer: a socket that is this account's own, checked before a byte goes
 * (fetchOverSocket), or the pipe `devices.json` names while its process runs, each request proving `devices-token` and
 * each answer taken only when it proves it back (fetchOverPipe, listenerPipe.ts).
 */
import { existsSync } from 'node:fs'
import { fetchOverPipe, fetchOverSocket, socketIsPrivate } from '../lib/localTransport.js'
import { PipeUnproven } from '../lib/windows/pipeClient.js'
import { devicesTarget } from './listenerPath.js'
import { devicesProof, type DevicesProof } from './listenerPipe.js'

interface SendOptions {
  platform?: NodeJS.Platform
  fetch?: typeof fetch
  /** Where the recorded devices process stands proven: this process's `devicesProof` by default. */
  proof?: DevicesProof
}

/**
 * `fetch` to the devices of [dataDir], or why there is none to use: nothing to reach, or a socket not this account's
 * own. An injected [SendOptions.fetch] is handed every send, whatever is at the socket's path. Over the pipe, a send that fails (nothing listens,
 * an answer without the token's proof, none in time) drops the proof held for the recorded process, so the next one
 * proves it by the process table before it sends: its pid may have gone to another process inside the minute a proof
 * holds (listenerPipe.ts PROOF_MAX_AGE_MS).
 */
async function devicesFetch(dataDir: string, options: SendOptions): Promise<typeof fetch | 'no listener' | 'unproven'> {
  const proof = options.proof ?? devicesProof
  const target = await devicesTarget(dataDir, { platform: options.platform, proof })
  if (!target) return 'no listener'
  if ('socket' in target) {
    if (options.fetch) return options.fetch
    if (!existsSync(target.socket)) return 'no listener'
    return socketIsPrivate(target.socket) ? fetchOverSocket(target.socket) : 'unproven'
  }
  const send = options.fetch ?? fetchOverPipe(() => target)
  return async (input, init) => {
    try {
      return await send(input, init)
    } catch (error) {
      proof.forget(dataDir)
      throw error
    }
  }
}

/**
 * The bound on an answer of the devices, [ms] from now, with [outer] aborting it too. Its timer aborts only from a
 * `setImmediate`, so the loop reads its sockets once in between: Node runs a timer that expired while the loop was held
 * before it reads an answer that arrived meanwhile. Run 45948212750: the devices logged `shown` at 06:06:58.843, and
 * the CLI printed `no dial` about 5 s later. An answer that comes after the bound, the loop free, is still none in time.
 */
function answerBound(ms: number, outer?: AbortSignal): { signal: AbortSignal; clear(): void } {
  const bound = new AbortController()
  let turn: NodeJS.Immediate | undefined
  const timer = setTimeout(() => { turn = setImmediate(() => bound.abort()) }, ms)
  return {
    signal: outer ? AbortSignal.any([outer, bound.signal]) : bound.signal,
    clear: () => {
      clearTimeout(timer)
      clearImmediate(turn)
    },
  }
}

/** True when the listener took [message] (a 2xx). False, never a throw, for no listener, one not this account's own, any other answer or none in time. */
export async function tellDevices(
  dataDir: string, message: { type: string } & Record<string, unknown>,
  options: SendOptions & { timeoutMs?: number } = {},
): Promise<boolean> {
  const send = await devicesFetch(dataDir, options)
  if (typeof send !== 'function') return false
  const bound = answerBound(options.timeoutMs ?? 2000)
  try {
    const answer = await send('http://devices.invalid/', { method: 'POST', body: JSON.stringify(message), signal: bound.signal })
    // Unread, an answer would hold its connection, and the listener takes only 16.
    await answer.body?.cancel()
    return answer.ok
  } catch { return false } finally { bound.clear() }
}

export const ASK_ANSWER_MAX = 1024

/** One message the listener answers with a JSON object: that object. The status of any answer but a 200, its body
 *  unread: a caller tells the listener's own rate (429) from a refusal. Null, never a throw, for no listener, one not
 *  this account's own, a 200 whose body is not a JSON object of at most ASK_ANSWER_MAX bytes, or no answer in time.
 *
 *  With a null, [why] hears which, once, in fixed words that carry nothing of an error's message, the answer or a path:
 *  `no listener`, `unproven`, `timeout before headers (<n> ms)`, `timeout in the body (<n> ms)` (n: from the send to the
 *  abort, so a held event loop shows apart from a slow listener), `too big`, `not json`, `not an object`, `error <CODE>`
 *  or `error`. Run 45948212750 printed `no dial` after the devices had logged `shown`, with nothing to say which null
 *  it was. */
export async function askDevices(
  dataDir: string, message: { type: string } & Record<string, unknown>,
  options: SendOptions & { timeoutMs?: number; why?: (reason: string) => void } = {},
): Promise<Record<string, unknown> | number | null> {
  const nothing = (reason: string) => {
    options.why?.(reason)
    return null
  }
  const send = await devicesFetch(dataDir, options)
  if (typeof send !== 'function') return nothing(send)
  // The bound covers the body as well as the headers: the signal aborts a read still under way.
  const bound = answerBound(options.timeoutMs ?? 2000)
  const { signal } = bound
  const sent = performance.now()
  let abortedAt = 0
  signal.addEventListener('abort', () => { abortedAt = performance.now() }, { once: true })
  let headers = false
  try {
    const answer = await send('http://devices.invalid/', { method: 'POST', body: JSON.stringify(message), signal })
    headers = true
    // Read or cancelled, never left: an unread answer would hold its connection, and the listener takes only 16.
    if (answer.status !== 200) {
      await answer.body?.cancel()
      return answer.status
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const data of answer.body ?? []) {
      size += data.byteLength
      // Leaving the loop cancels the rest of the body.
      if (size > ASK_ANSWER_MAX) return nothing('too big')
      chunks.push(Buffer.from(data))
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString())
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : nothing('not an object')
  } catch (error) {
    if (signal.aborted) return nothing(`timeout ${headers ? 'in the body' : 'before headers'} (${Math.round(abortedAt - sent)} ms)`)
    if (error instanceof PipeUnproven) return nothing('unproven')
    if (error instanceof SyntaxError) return nothing('not json')
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code
    if (code === 'ECONNREFUSED' || code === 'ENOENT') return nothing('no listener')
    return nothing(typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code) ? `error ${code}` : 'error')
  } finally { bound.clear() }
}

/**
 * A message the listener answers with a stream (`tabs`): each chunk of a `200` answer's body is handed on as it comes.
 * True once that body has ended, however it ended: the stream had opened. False, never a throw, for no listener, one not
 * this account's own, any other answer, or no answer's headers in [timeoutMs] (2 s by default). An abort ends it and
 * lets its connection go.
 */
export async function streamDevices(
  dataDir: string, message: { type: string }, chunk: (data: Buffer) => void,
  options: SendOptions & { signal: AbortSignal; timeoutMs?: number },
): Promise<boolean> {
  const send = await devicesFetch(dataDir, options)
  if (typeof send !== 'function') return false
  // Only the answer's headers are bounded: the body is the stream, open for as long as the listener holds it.
  const bound = answerBound(options.timeoutMs ?? 2000, options.signal)
  let answer: Response
  try {
    answer = await send('http://devices.invalid/', { method: 'POST', body: JSON.stringify(message), signal: bound.signal })
    if (answer.status !== 200) {
      await answer.body?.cancel()
      return false
    }
  } catch { return false } finally { bound.clear() }
  try {
    for await (const data of answer.body ?? []) chunk(Buffer.from(data))
  } catch { /* the listener closed the connection, or the abort let it go: the stream has ended either way */ }
  return true
}
