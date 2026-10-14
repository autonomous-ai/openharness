/** Former healthy native-client wire behavior, before persistent delivery/retry. */
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, expect, it } from 'vitest'
import { nativeHookTransport } from './testing/nativeHookTransport.js'

const GOLDEN = new URL('./__fixtures__/hook-client-transport.golden.json', import.meta.url)
const RECORD = process.env.RECORD_HOOK_CLIENT_TRANSPORT_GOLDEN === '1'
const expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
const captured: Record<string, unknown> = {}

it.each(['linux', 'darwin'] as const)('preserves healthy native hook acknowledgement and immutable wire identity on %s', async platform => {
  // The VM pins process.platform, time and identity, and has no host binaries
  // or sockets. Keep native fault handling in separate regression tests.
  const replies = [
    { status: 200, body: '{"ok":true}' },
    { status: 200, body: '{"pending":true}' },
    { status: 202, body: '{"pending":false,"retry":true}' },
    { status: 429, body: '{"error":"HOOK_ADMISSION_BUSY"}' },
    { status: 200, body: '{"pending":true}' },
    { status: 200, body: '{"ok":true,"duplicate":true}' },
  ]
  const transport = nativeHookTransport(platform, replies), acknowledgements: unknown[] = [], callbacks: unknown[] = []
  for (let index = 0; index < 6; index++) {
    acknowledgements.push(await transport.post(19473, index < 4 ? '/api/hook/session-start' : '/api/hook/turn-stop',
      { engine: 'codex', sessionId: '<session>', callerPid: 4100, tmuxPane: '%1', prompt: 'é📘' },
      reply => { callbacks.push(reply) }))
  }
  captured[platform] = { acknowledgements, callbacks, requests: transport.requests }
  if (!RECORD) expect(captured[platform]).toEqual(expected[platform])
})

afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  else expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort())
})
