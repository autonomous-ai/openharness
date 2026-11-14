import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { apnsSender, http2Transport, type ApnsAnswer, type ApnsRequest } from './apns.js'
import type { PushDevice } from './devices.js'
import { swarmNoticeId, type PhoneNotice } from './sender.js'

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const sandboxKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
// Apple's keys are per environment: the production key is refused on the sandbox host and the other way round (Ken, 11-05).
const keys = { teamId: 'TEAM123456', topic: 'ai.autonomous.harness.ios', production: { keyId: 'ABC123DEFG', privateKey },
  sandbox: { keyId: '5UTFPCN7LP', privateKey: sandboxKey } }
const productionOnly = { ...keys, sandbox: null }
const device: PushDevice = { id: 'd1', userId: 'u1', platform: 'ios', token: 'ab'.repeat(32), sandbox: false }
const notice: PhoneNotice = { personId: 'u1', key: 'reply:tab:row', title: 'Mia replied in a thread', subtitle: 'openharness',
  body: 'Open Harness to read it.', link: 'swarm:tab/conv/message/m/thread/root', slot: 'thread:tab:conv:root' }
const NOW = Date.UTC(2026, 10, 5, 9)

/** A transport that answers each request in turn and remembers what it was asked. */
function scripted(...answers: Array<ApnsAnswer | 'hang'>) {
  const asked: ApnsRequest[] = []
  const transport = (request: ApnsRequest) => {
    asked.push(request)
    const answer = answers.shift() ?? { status: 200, reason: null }
    return answer === 'hang' ? new Promise<ApnsAnswer>(() => {}) : Promise.resolve(answer)
  }
  return { asked, transport }
}
const jwtOf = (request: ApnsRequest) => request.headers.authorization!.replace(/^bearer /, '')
const part = (jwt: string, i: number) => JSON.parse(Buffer.from(jwt.split('.')[i]!, 'base64url').toString())

describe('APNs sender (task #2905)', () => {
  it('sends an alert for the app\'s topic, signed with the team\'s key, that says who and where and nothing written', async () => {
    const { asked, transport } = scripted({ status: 200, reason: null })
    expect(await apnsSender(keys, { transport, now: () => NOW }).send(device, notice)).toEqual({ outcome: 'sent' })
    const [request] = asked
    expect(request).toMatchObject({ sandbox: false, path: `/3/device/${device.token}` })
    expect(request!.headers).toMatchObject({ 'apns-topic': 'ai.autonomous.harness.ios', 'apns-push-type': 'alert', 'apns-priority': '10',
      'apns-collapse-id': String(swarmNoticeId('thread:tab:conv:root')) })
    expect(JSON.parse(request!.body)).toEqual({
      aps: { alert: { title: notice.title, subtitle: notice.subtitle, body: notice.body }, sound: 'default', 'thread-id': 'swarm-needs-you', category: 'swarm-needs-you' },
      key: notice.key, link: notice.link, slot: notice.slot,
    })
    const jwt = jwtOf(request!)
    expect(part(jwt, 0)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' })
    expect(part(jwt, 1)).toEqual({ iss: 'TEAM123456', iat: NOW / 1000 })
    const [head, claims, signature] = jwt.split('.')
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true)
  })

  it('signs again only after 50 minutes', async () => {
    let now = NOW
    const { asked, transport } = scripted()
    const sender = apnsSender(keys, { transport, now: () => now })
    await sender.send(device, notice)
    now += 49 * 60_000
    await sender.send(device, notice)
    now += 2 * 60_000
    await sender.send(device, notice)
    expect(jwtOf(asked[1]!)).toBe(jwtOf(asked[0]!))
    expect(jwtOf(asked[2]!)).not.toBe(jwtOf(asked[0]!))
  })

  it('calls a token Apple no longer knows gone', async () => {
    for (const answer of [{ status: 410, reason: 'Unregistered' }, { status: 400, reason: 'DeviceTokenNotForTopic' }]) {
      const { transport } = scripted(answer)
      expect(await apnsSender(keys, { transport }).send(device, notice)).toEqual({ outcome: 'gone', reason: answer.reason })
    }
  })

  it('tries a development build\'s token on the sandbox host once, signed with the sandbox key, and says so when it is taken there', async () => {
    const { asked, transport } = scripted({ status: 400, reason: 'BadDeviceToken' }, { status: 200, reason: null })
    expect(await apnsSender(keys, { transport }).send(device, notice)).toEqual({ outcome: 'sandbox' })
    expect(asked.map(r => r.sandbox)).toEqual([false, true])
    expect(part(jwtOf(asked[0]!), 0).kid).toBe('ABC123DEFG')
    expect(part(jwtOf(asked[1]!), 0).kid).toBe('5UTFPCN7LP')
    const [head, claims, signature] = jwtOf(asked[1]!).split('.')
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: createPublicKey(sandboxKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true)
  })

  it('without a sandbox key, never sends to the sandbox host: a production BadDeviceToken is skipped, and the token kept', async () => {
    const { asked, transport } = scripted({ status: 400, reason: 'BadDeviceToken' })
    expect(await apnsSender(productionOnly, { transport }).send(device, notice)).toEqual({ outcome: 'unconfigured', reason: 'no APNs sandbox key' })
    expect(asked.map(r => r.sandbox)).toEqual([false])
  })

  it('without a sandbox key, sends nothing for a token known to be a sandbox one', async () => {
    const { asked, transport } = scripted()
    expect(await apnsSender(productionOnly, { transport }).send({ ...device, sandbox: true }, notice)).toEqual({ outcome: 'unconfigured', reason: 'no APNs sandbox key' })
    expect(asked).toEqual([])
  })

  it('calls a token neither host takes gone', async () => {
    const { transport } = scripted({ status: 400, reason: 'BadDeviceToken' }, { status: 400, reason: 'BadDeviceToken' })
    expect(await apnsSender(keys, { transport }).send(device, notice)).toEqual({ outcome: 'gone', reason: 'BadDeviceToken' })
  })

  it('sends a sandbox token to the sandbox host alone, signed with the sandbox key', async () => {
    const { asked, transport } = scripted({ status: 200, reason: null })
    expect(await apnsSender(keys, { transport }).send({ ...device, sandbox: true }, notice)).toEqual({ outcome: 'sent' })
    expect(asked.map(r => r.sandbox)).toEqual([true])
    expect(part(jwtOf(asked[0]!), 0)).toEqual({ alg: 'ES256', kid: '5UTFPCN7LP' })
  })

  it('fails on Apple\'s error, a broken connection, or no answer in time', async () => {
    expect(await apnsSender(keys, { transport: scripted({ status: 500, reason: 'InternalServerError' }).transport }).send(device, notice))
      .toEqual({ outcome: 'failed', reason: 'InternalServerError' })
    expect(await apnsSender(keys, { transport: () => Promise.reject(new Error('ECONNRESET')) }).send(device, notice))
      .toEqual({ outcome: 'failed', reason: 'ECONNRESET' })
    expect(await apnsSender(keys, { transport: scripted('hang').transport, timeoutMs: 20 }).send(device, notice))
      .toEqual({ outcome: 'failed', reason: 'timeout' })
  })
})

describe('APNs: one notification per slot, and quiet repeats (task #3248)', () => {
  it('collapses on the app\'s own id for the slot, so the app\'s notice and the push are one notification', () => {
    // mobile/test/notify/local_system_notices_test.dart pins the same ids.
    expect(swarmNoticeId('mention:m1')).toBe(1161357565)
    expect(swarmNoticeId('decision:d1')).toBe(15921470)
    expect(swarmNoticeId('work:s1:c1:a1:needs_human')).toBe(701122187)
    expect(swarmNoticeId('mention:é✓')).toBe(1555091707)
  })

  it('sends a quiet push with no sound and passive, so it only replaces what its slot showed', async () => {
    const { asked, transport } = scripted({ status: 200, reason: null })
    await apnsSender(keys, { transport, now: () => NOW }).send(device, { ...notice, quiet: true })
    const body = JSON.parse(asked[0]!.body)
    expect(body.aps).toEqual({ alert: { title: notice.title, subtitle: notice.subtitle, body: notice.body }, 'interruption-level': 'passive',
      'thread-id': 'swarm-needs-you', category: 'swarm-needs-you' })
    expect(asked[0]!.headers['apns-collapse-id']).toBe(String(swarmNoticeId(notice.slot)))
  })
})

describe('APNs over HTTP/2', () => {
  const seen: Array<{ headers: http2.IncomingHttpHeaders; body: string }> = []
  const server = http2.createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      seen.push({ headers: request.headers, body })
      if (request.headers['apns-topic'] === 'gone') {
        response.writeHead(410, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ reason: 'Unregistered', timestamp: 1 }))
      } else {
        response.writeHead(200, { 'apns-id': 'x' })
        response.end()
      }
    })
  })
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

  it('posts to the path with the headers, and reads Apple\'s reason', async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const transport = http2Transport({ production: origin, sandbox: origin })
    try {
      expect(await transport({ sandbox: false, path: '/3/device/abc', headers: { 'apns-topic': 'ok' }, body: '{"a":1}' }, 5_000)).toEqual({ status: 200, reason: null })
      expect(await transport({ sandbox: true, path: '/3/device/def', headers: { 'apns-topic': 'gone' }, body: '{}' }, 5_000)).toEqual({ status: 410, reason: 'Unregistered' })
    } finally {
      transport.close()
    }
    expect(seen.map(s => [s.headers[':method'], s.headers[':path'], s.body])).toEqual([['POST', '/3/device/abc', '{"a":1}'], ['POST', '/3/device/def', '{}']])
  })
})
