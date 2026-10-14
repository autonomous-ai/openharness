import { expect, it } from 'vitest'
import { nativeHookTransport } from './testing/nativeHookTransport.js'

const body = { engine: 'codex', sessionId: '<session>', callerPid: 4100, tmuxPane: '%1' }

it('keeps a possibly delivered request out of offline fallback after a connection reset', async () => {
  const transport = nativeHookTransport('linux', [{ error: true, connected: true }])
  expect(await transport.post(19473, '/api/hook/session-start', body)).toBe('late')
})

it.each([401, 403, 409, 500, 503])('never treats an HTTP %s reply as an offline daemon', async status => {
  const transport = nativeHookTransport('linux', [{ status, body: '{"error":"fixture refusal"}' }])
  expect(await transport.post(19473, '/api/hook/session-start', body)).toBe('held')
})

it.each(['aborted', 'error', 'close'] as const)('retains a possibly delivered hook after its response is %s', async interrupted => {
  const transport = nativeHookTransport('linux', [{ status: 200, body: '{"ok":', interrupted }])
  const result = await Promise.race([
    transport.post(19473, '/api/hook/session-start', body),
    new Promise(resolve => setImmediate(() => resolve('unsettled'))),
  ])
  expect(result).toBe('late')
})

it('retains the old offline result only when the socket never connected', async () => {
  const transport = nativeHookTransport('linux', [{ error: true, connected: false }, { timeout: true, connected: false }])
  expect(await transport.post(19473, '/api/hook/session-start', body)).toBe(false)
  expect(await transport.post(19473, '/api/hook/session-start', body)).toBe(false)
})

it.each(['', '{}', 'null', '{"ok":', '[{"ok":true}]', JSON.stringify({ ok: true, detail: 'x'.repeat(16_384) })])(
  'does not acknowledge an absent, malformed or oversized reply: %#', async reply => {
    const transport = nativeHookTransport('linux', [{ status: 200, body: reply }])
    expect(await transport.post(19473, '/api/hook/session-start', body)).toBe('held')
  })

it('bounds a response that keeps sending bytes without completing an acknowledgement', async () => {
  const transport = nativeHookTransport('linux', [{ status: 200, body: '{"ok":true,"padding":"', unfinished: true }])
  const callbacks: unknown[] = []
  const pending = transport.post(19473, '/api/hook/session-start', body, reply => { callbacks.push(reply) })
  await Promise.resolve()
  transport.expire()
  expect(await Promise.race([pending, new Promise(resolve => setImmediate(() => resolve('unsettled')))])).toBe('late')
  expect(transport.destroyed).toBe(1)
  transport.endResponse('"}')
  expect(await pending).toBe('late')
  expect(callbacks).toEqual([])
})

it.each(['turn-stop', 'turn-start', 'tool-start', 'session-end'])('does not borrow a registration acknowledgement for %s', async path => {
  const transport = nativeHookTransport('linux', [{ status: 200, body: '{"ignored":true}' }])
  expect(await transport.post(19473, `/api/hook/${path}`, body)).toBe('held')
})

it.each([
  { ok: true, error: 'INTERNAL' }, { ok: true, pending: 'true' }, { ok: true, retry: 'false' },
  { ok: true, ignored: true }, { pending: true, duplicate: true }, { ignored: true, pending: true },
  { ok: true, pending: true }, { ok: false, duplicate: true },
])('holds contradictory or mistyped acknowledgements: %j', async reply => {
  const transport = nativeHookTransport('linux', [{ status: 200, body: JSON.stringify(reply) }])
  expect(await transport.post(19473, '/api/hook/turn-stop', body)).toBe('held')
})

it.each(['turn-start', 'tool-start', 'session-end'])('does not borrow a Stop acknowledgement for %s', async path => {
  const transport = nativeHookTransport('linux', [{ status: 200, body: '{"ok":true,"duplicate":true}' }])
  expect(await transport.post(19473, `/api/hook/${path}`, body)).toBe('held')
})

it.each([{ ignored: true }, { ok: true, duplicate: true }, { ok: true, pending: false, retry: false }])(
  'accepts a complete registration acknowledgement: %j', async reply => {
    const transport = nativeHookTransport('linux', [{ status: 200, body: JSON.stringify(reply) }])
    expect(await transport.post(19473, '/api/hook/session-start', body)).toBe(true)
  })
