import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fcmSender } from './fcm.js'
import type { PushDevice } from './devices.js'
import type { PhoneNotice } from './sender.js'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const account = { projectId: 'harness-push', clientEmail: 'push@harness-push.iam.gserviceaccount.com', privateKey, tokenUri: 'https://oauth2.googleapis.com/token' }
const device: PushDevice = { id: 'd1', userId: 'u1', platform: 'android', token: 'fcm:token_1', sandbox: false }
const notice: PhoneNotice = { personId: 'u1', key: 'mention:m1', title: 'Mia tagged you', subtitle: 'openharness',
  body: 'Open Harness to read it.', link: 'swarm:tab/conv/message/m', slot: 'mention:m1' }
const NOW = Date.UTC(2026, 10, 5, 9)

type Call = { url: string; init: RequestInit }
/** A fetch that answers Google's token endpoint with a one-hour token and FCM with `send` in turn. */
function google(...send: Array<{ status: number; body?: unknown } | 'hang'>) {
  const calls: Call[] = []
  let issued = 0
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url === account.tokenUri) return new Response(JSON.stringify({ access_token: `access-${++issued}`, expires_in: 3600, token_type: 'Bearer' }), { status: 200 })
    const answer = send.shift() ?? { status: 200, body: { name: 'projects/harness-push/messages/1' } }
    if (answer === 'hang') return await new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError'))))
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status })
  }) as unknown as typeof fetch
  return { calls, fetcher, sends: () => calls.filter(c => c.url !== account.tokenUri) }
}
const unregistered = { status: 404, body: { error: { code: 404, status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } } }

describe('FCM sender (task #2905)', () => {
  it('signs in as the service account and sends a notification that says who and where and nothing written', async () => {
    const { calls, fetcher } = google()
    expect(await fcmSender(account, { fetcher, now: () => NOW }).send(device, notice)).toEqual({ outcome: 'sent' })
    const [grant, send] = calls
    const form = new URLSearchParams(String(grant!.init.body))
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [head, claims, signature] = form.get('assertion')!.split('.')
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({ iss: account.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: account.tokenUri, iat: NOW / 1000, exp: NOW / 1000 + 3600 })
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), createPublicKey(privateKey), Buffer.from(signature!, 'base64url'))).toBe(true)
    expect(send!.url).toBe('https://fcm.googleapis.com/v1/projects/harness-push/messages:send')
    expect((send!.init.headers as Record<string, string>).authorization).toBe('Bearer access-1')
    expect(JSON.parse(String(send!.init.body))).toEqual({ message: {
      token: device.token,
      notification: { title: 'Mia tagged you', body: 'openharness · Open Harness to read it.' },
      android: { priority: 'high', notification: { channel_id: 'swarm-needs-you', tag: 'mention:m1', visibility: 'PRIVATE' } },
      data: { key: 'mention:m1', link: notice.link, slot: 'mention:m1' },
    } })
  })

  it('tags the notification with its slot, so a thread\'s replies share one, and sends a quiet one on the app\'s silent channel (task #3248)', async () => {
    const { fetcher, sends } = google()
    const reply = { ...notice, key: 'reply:tab:row2', slot: 'thread:tab:conv:root' }
    const sender = fcmSender(account, { fetcher, now: () => NOW })
    await sender.send(device, reply)
    await sender.send(device, { ...reply, quiet: true })
    const [loud, quiet] = sends().map(c => JSON.parse(String(c.init.body)).message)
    expect(loud.android.notification).toEqual({ channel_id: 'swarm-needs-you', tag: 'thread:tab:conv:root', visibility: 'PRIVATE' })
    expect(quiet.android.notification).toEqual({ channel_id: 'swarm-quiet', tag: 'thread:tab:conv:root', visibility: 'PRIVATE' })
    expect(quiet.data).toEqual({ key: 'reply:tab:row2', link: notice.link, slot: 'thread:tab:conv:root' })
  })

  it('keeps its access token until five minutes before it runs out', async () => {
    let now = NOW
    const { calls, fetcher } = google()
    const sender = fcmSender(account, { fetcher, now: () => now })
    await sender.send(device, notice)
    now += 54 * 60_000
    await sender.send(device, notice)
    now += 2 * 60_000
    await sender.send(device, notice)
    expect(calls.filter(c => c.url === account.tokenUri)).toHaveLength(2)
  })

  it('calls a token Firebase no longer knows gone', async () => {
    const { fetcher } = google(unregistered)
    expect(await fcmSender(account, { fetcher }).send(device, notice)).toEqual({ outcome: 'gone', reason: 'UNREGISTERED' })
  })

  it('signs in again after a refused access token, and fails that send', async () => {
    const { calls, fetcher } = google({ status: 401, body: { error: { status: 'UNAUTHENTICATED' } } })
    const sender = fcmSender(account, { fetcher })
    expect(await sender.send(device, notice)).toEqual({ outcome: 'failed', reason: 'UNAUTHENTICATED' })
    await sender.send(device, notice)
    expect(calls.filter(c => c.url === account.tokenUri)).toHaveLength(2)
  })

  it('fails on Google\'s error or no answer in time', async () => {
    expect(await fcmSender(account, { fetcher: google({ status: 503, body: { error: { status: 'UNAVAILABLE' } } }).fetcher }).send(device, notice))
      .toEqual({ outcome: 'failed', reason: 'UNAVAILABLE' })
    expect(await fcmSender(account, { fetcher: google('hang').fetcher, timeoutMs: 20 }).send(device, notice))
      .toEqual({ outcome: 'failed', reason: 'timeout' })
  })
})
