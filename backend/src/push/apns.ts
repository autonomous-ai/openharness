import { sign } from 'node:crypto'
import http2 from 'node:http2'
import type { ApnsKey, ApnsKeys } from './keys.js'
import type { PushDevice } from './devices.js'
import { SEND_TIMEOUT_MS, SWARM_CHANNEL, withTimeout, type PhoneNotice, type Sender, type SendResult } from './sender.js'

/** One request to Apple: to its production host, or to the sandbox host a development build's token needs. */
export interface ApnsRequest { sandbox: boolean; path: string; headers: Record<string, string>; body: string }
export interface ApnsAnswer { status: number; reason: string | null }
export type ApnsTransport = (request: ApnsRequest, timeoutMs: number) => Promise<ApnsAnswer>

/** Apple takes a token at most an hour old and refuses one renewed more often than every 20 minutes. */
const JWT_RENEW_MS = 50 * 60_000
/** Apple's answers for a token that is no longer this app's on any phone. */
const GONE = new Set(['Unregistered', 'DeviceTokenNotForTopic', 'BadDeviceToken'])

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

/**
 * Sends to iPhones through Apple's HTTP/2 API (task #2905), each host with a token signed by its own environment's key: Apple
 * refuses the production key on the sandbox host and the other way round (Ken, 11-05). An Xcode build's token is known only to
 * the sandbox host: production calls it bad, so it is tried there once, and the device is marked (`sandbox`). With no sandbox
 * key, nothing goes to the sandbox host: such a push is skipped (`unconfigured`) and the token kept.
 */
export function apnsSender(keys: ApnsKeys, options: { transport?: ApnsTransport; now?: () => number; timeoutMs?: number } = {}): Sender {
  const transport = options.transport ?? http2Transport(), now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS
  const jwts = new Map<ApnsKey, { value: string; at: number }>()
  const bearer = (key: ApnsKey) => {
    const at = now(), jwt = jwts.get(key)
    if (jwt && at - jwt.at < JWT_RENEW_MS) return jwt.value
    const signed = `${base64url(JSON.stringify({ alg: 'ES256', kid: key.keyId }))}.${base64url(JSON.stringify({ iss: keys.teamId, iat: Math.floor(at / 1000) }))}`
    const value = `${signed}.${base64url(sign('sha256', Buffer.from(signed), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }))}`
    jwts.set(key, { value, at })
    return value
  }
  const noSandboxKey: SendResult = { outcome: 'unconfigured', reason: 'no APNs sandbox key' }
  const ask = async (device: PushDevice, notice: PhoneNotice, sandbox: boolean): Promise<ApnsAnswer> => withTimeout(transport({
    sandbox, path: `/3/device/${device.token}`,
    headers: { authorization: `bearer ${bearer(sandbox ? keys.sandbox! : keys.production)}`, 'apns-topic': keys.topic, 'apns-push-type': 'alert', 'apns-priority': '10',
      'apns-expiration': String(Math.floor(now() / 1000) + 24 * 60 * 60) },
    body: JSON.stringify({ aps: { alert: { title: notice.title, subtitle: notice.subtitle, body: notice.body }, sound: 'default',
      'thread-id': SWARM_CHANNEL, category: SWARM_CHANNEL }, key: notice.key, link: notice.link }),
  }, timeoutMs), timeoutMs)
  const judged = (answer: ApnsAnswer, sandboxNow: boolean): SendResult => {
    if (answer.status === 200) return { outcome: sandboxNow ? 'sandbox' : 'sent' }
    if (answer.status === 410 || (answer.status === 400 && GONE.has(answer.reason ?? ''))) return { outcome: 'gone', reason: answer.reason ?? String(answer.status) }
    return { outcome: 'failed', reason: answer.reason ?? String(answer.status) }
  }
  return {
    async send(device, notice) {
      try {
        if (device.sandbox && !keys.sandbox) return noSandboxKey
        const answer = await ask(device, notice, device.sandbox)
        if (device.sandbox || answer.status !== 400 || answer.reason !== 'BadDeviceToken') return judged(answer, false)
        // Perhaps an Xcode build's token: only the sandbox host can say, with the sandbox key.
        if (!keys.sandbox) return noSandboxKey
        return judged(await ask(device, notice, true), true)
      } catch (error) {
        return { outcome: 'failed', reason: (error as Error).message === 'timeout' ? 'timeout' : (error as NodeJS.ErrnoException).code ?? (error as Error).message }
      }
    },
  }
}

/** Apple's two hosts, one HTTP/2 connection each, made when first needed and again once closed. */
export function http2Transport(origins = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' }): ApnsTransport & { close(): void } {
  const sessions = new Map<string, http2.ClientHttp2Session>()
  const sessionFor = (origin: string) => {
    const open = sessions.get(origin)
    if (open && !open.closed && !open.destroyed) return open
    const session = http2.connect(origin)
    // A connection that fails is dropped here; the request on it fails by itself, and the next one connects again.
    session.on('error', () => sessions.delete(origin))
    session.on('close', () => { if (sessions.get(origin) === session) sessions.delete(origin) })
    session.unref()
    sessions.set(origin, session)
    return session
  }
  const transport = (request: ApnsRequest, timeoutMs: number) => new Promise<ApnsAnswer>((resolve, reject) => {
    const stream = sessionFor(request.sandbox ? origins.sandbox : origins.production)
      .request({ ':method': 'POST', ':path': request.path, ...request.headers })
    stream.setTimeout(timeoutMs, () => stream.close(http2.constants.NGHTTP2_CANCEL))
    let status = 0, body = ''
    stream.on('response', headers => { status = Number(headers[':status']) })
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => { body += chunk })
    stream.on('end', () => {
      let reason: string | null = null
      try { reason = body ? (JSON.parse(body) as { reason?: string }).reason ?? null : null } catch { reason = null }
      resolve({ status, reason })
    })
    stream.on('error', reject)
    stream.on('close', () => { if (!status) reject(new Error('timeout')) })
    stream.end(request.body)
  })
  return Object.assign(transport, { close: () => { for (const session of sessions.values()) session.close(); sessions.clear() } })
}
