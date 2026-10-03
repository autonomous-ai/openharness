import { afterEach, expect, it, vi } from 'vitest'
import { opencodeRecallPluginSource } from './opencodeRecallPlugin.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers() })

// Hook and part shapes recorded by memory-native-opencode-recall-probe.mjs on 1.18.34.
function fixture() {
  vi.stubEnv('TMUX_PANE', '%42')
  let token = 'synthetic-hook-token'
  const context = 'Historical context: prefer a small reproducer for parser bugs.'
  const receipt = '77777777-7777-4777-8777-777777777777'
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => new Response(JSON.stringify(
    String(url).endsWith('memory-context') ? { additionalContext: context, memoryReceiptId: receipt } : { recorded: true })))
  const health = vi.fn(async () => ({ data: { version: '1.18.34' } }))
  const hooks = new Function('client', 'hookToken', `${opencodeRecallPluginSource(12345)};
    return { submitted: recallMessage, transform: recallTransform, compacting: recallCompacting, continuation: recallAutoContinue }`)(
    { _client: { get: health } }, () => token)
  const row = { info: { id: 'user-one', sessionID: 'native', role: 'user', agent: 'build' },
    parts: [{ id: 'part-one', sessionID: 'native', messageID: 'user-one', type: 'text', text: 'Review the parser bug.' }] }
  void hooks.submitted({ sessionID: 'native' }, { message: row.info, parts: row.parts })
  const output = { messages: [row] }
  return { ...hooks, output, row, context, receipt, fetch, health, disableToken: () => { token = '' } }
}

it('delivers shared context as an ephemeral user part and acknowledges without any provider credential', async () => {
  const f = fixture(), original = structuredClone(f.row.parts)
  await f.transform({}, f.output)
  expect(f.row.parts.slice(1)).toEqual(original)
  expect(f.row.parts[0]).toMatchObject({ type: 'text', text: f.context, synthetic: true, sessionID: 'native', messageID: 'user-one' })
  expect(JSON.parse(String(f.fetch.mock.calls[0][1]?.body))).toEqual({ engine: 'opencode', sessionId: 'native', callerPid: process.pid,
    tmuxPane: '%42', runtimeHints: [{ backend: 'tmux', paneId: '%42' }], cliVersion: '1.18.34', prompt: 'Review the parser bug.' })
  expect(String(f.fetch.mock.calls[1][0])).toMatch(/memory-emitted$/)
  expect(JSON.parse(String(f.fetch.mock.calls[1][1]?.body)).memoryReceiptId).toBe(f.receipt)
})

it('revalidates shared state on every request and removes old context after a clone and recall being turned off', async () => {
  const f = fixture()
  await f.transform({}, f.output)
  const copy = structuredClone(f.output)
  f.fetch.mockImplementation(async () => new Response('{"ok":true}'))
  await f.transform({}, copy)
  expect(copy.messages[0].parts).toHaveLength(1)
  expect(copy.messages[0].parts[0].text).toBe('Review the parser bug.')
  expect(f.health).toHaveBeenCalledOnce()
})

it('excludes compaction input even when recall is on, then recalls again for the native automatic continuation', async () => {
  const f = fixture()
  await f.compacting({ sessionID: 'native' })
  await f.transform({}, f.output)
  expect(f.fetch).not.toHaveBeenCalled()
  await f.continuation({ sessionID: 'native', agent: 'build', message: { agent: 'build' } })
  const resumed = { messages: [{ info: { ...f.row.info, id: 'native-continue' }, parts: [
    { ...f.row.parts[0], id: 'continue-part', messageID: 'native-continue', text: 'Continue if you have next steps.',
      synthetic: true, metadata: { compaction_continue: true } },
  ] }] }
  await f.transform({}, resumed)
  expect(resumed.messages[0].parts[0].text).toBe(f.context)
  expect(JSON.parse(String(f.fetch.mock.calls[0][1]?.body)).prompt).toBe('Review the parser bug.')
  await f.submitted({ sessionID: 'native' }, { message: { ...f.row.info, id: 'file-only' }, parts: [{ type: 'file' }] })
  f.fetch.mockClear()
  await f.transform({}, resumed)
  expect(f.fetch).not.toHaveBeenCalled()
  expect(resumed.messages[0].parts).toHaveLength(1)
})

it('does not infer continuation from synthetic text, another agent or an unknown message', async () => {
  const f = fixture()
  for (const info of [{ ...f.row.info, id: 'unobserved' }, { ...f.row.info, agent: 'compaction' }]) {
    await f.transform({}, { messages: [{ info, parts: f.row.parts }] })
  }
  await f.transform({}, { messages: [{ info: f.row.info, parts: [{ ...f.row.parts[0], synthetic: true }] }] })
  expect(f.fetch).not.toHaveBeenCalled()
})

it('recalls for a native overflow replay only when its origin matches the last submitted request in this session', async () => {
  const f = fixture()
  const row = { info: { ...f.row.info, id: 'native-replay' }, parts: [{ ...f.row.parts[0], id: 'replayed-part',
    metadata: { harness_submission: { v: 1, sessionID: 'foreign', messageID: 'user-one' } } }] }
  await f.transform({}, { messages: [row] })
  expect(f.fetch).not.toHaveBeenCalled()
  row.parts[0].metadata.harness_submission.sessionID = 'native'
  await f.transform({}, { messages: [row] })
  expect(row.parts[0].text).toBe(f.context)
  const replay = row.parts[1]
  replay.metadata.harness_submission.messageID = 'an-earlier-user'
  f.fetch.mockClear()
  await f.transform({}, { messages: [row] })
  expect(row.parts).toHaveLength(1)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('keeps simultaneous sessions separate and ignores a late reply for a replaced user turn', async () => {
  const f = fixture()
  let resolve!: (response: Response) => void
  f.fetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
  const running = f.transform({}, f.output)
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  await f.submitted({ sessionID: 'native' }, { message: { ...f.row.info, id: 'next-user' }, parts: f.row.parts })
  resolve(new Response(JSON.stringify({ additionalContext: 'stale context' })))
  await running
  expect(f.row.parts).toHaveLength(1)
  await f.transform({}, { messages: [{ info: { ...f.row.info, sessionID: 'foreign' }, parts: f.row.parts }] })
  expect(f.fetch).toHaveBeenCalledOnce()
})

it('bounds a hung host and cannot mutate the request after the deadline', async () => {
  vi.useFakeTimers()
  const f = fixture()
  let resolve!: (response: Response) => void
  f.fetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
  const running = f.transform({}, f.output)
  await vi.advanceTimersByTimeAsync(700)
  await running
  expect(f.row.parts).toHaveLength(1)
  resolve(new Response(JSON.stringify({ additionalContext: 'too late' })))
  await vi.advanceTimersByTimeAsync(1)
  expect(f.row.parts).toHaveLength(1)
})

it.each(['wrong-version', 'no-token', 'no-pane', 'unavailable', 'oversized-context', 'oversized-body'])(
  'continues without context for %s', async reason => {
    const f = fixture()
    if (reason === 'wrong-version') f.health.mockResolvedValue({ data: { version: '2.0.0' } })
    if (reason === 'no-token') f.disableToken()
    if (reason === 'no-pane') vi.stubEnv('TMUX_PANE', '')
    if (reason === 'unavailable') f.fetch.mockResolvedValue(new Response('', { status: 403 }))
    if (reason === 'oversized-context') f.fetch.mockResolvedValue(new Response(JSON.stringify({ additionalContext: 'x'.repeat(8001) })))
    if (reason === 'oversized-body') f.fetch.mockResolvedValue(new Response('x'.repeat(64001)))
    await f.transform({}, f.output)
    expect(f.row.parts).toHaveLength(1)
    if (reason.startsWith('no-')) expect(f.health).not.toHaveBeenCalled()
  })
