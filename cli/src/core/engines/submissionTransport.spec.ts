import { afterEach, describe, expect, it, vi } from 'vitest'
import { engineSubmissionRequests } from '../../engines/worker/submissionRequests.js'
import { SUBMISSION_CAPABILITIES, SUBMISSION_ECHO, SUBMISSION_READ, SUBMISSION_REPLY_BYTES, SUBMISSION_TEXT_BYTES } from '../../engines/worker/submissionProtocol.js'
import { createSubmissionTransport, type SubmissionTransport } from './submissionTransport.js'

const capture = '────────────\n❯ hello\n────────────\n? for shortcuts'
const recorded = '<pasted_content id="ab">\nhello\n</pasted_content id="ab">'
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('submission transport', () => {
  it('negotiates each connection, and decodes the real worker\'s readings', async () => {
    const requests = engineSubmissionRequests('claude')
    let transport: SubmissionTransport
    const call = vi.fn(async (service: string, method: string, payload: Record<string, unknown>) => {
      if (call.mock.calls.length === 1) transport.connected(service)
      return await requests[method]({ ...payload, requestId: `core-route-${call.mock.calls.length}` }, { owner: true, local: true })
    })
    transport = createSubmissionTransport({ call })
    expect(await transport.read('claude', capture, 'hello')).toEqual({ draft: true, composer: true, nativeDraft: 'pending' })
    expect(await transport.echo('claude', recorded)).toEqual({ start: 25, end: 30 })
    expect(call.mock.calls.map(c => c[1])).toEqual([SUBMISSION_CAPABILITIES, SUBMISSION_READ, SUBMISSION_ECHO])
    transport.disconnected('engine-claude'); transport.connected('engine-claude')
    await transport.echo('claude', 'hello')
    expect(call.mock.calls.filter(c => c[1] === SUBMISSION_CAPABILITIES)).toHaveLength(2)
  })

  it('sends nothing past its bounds or for an engine with no worker', async () => {
    const call = vi.fn()
    const transport = createSubmissionTransport({ call }); transport.connected('engine-codex')
    await expect(transport.read('codex', 'x'.repeat(300_000), 'hello')).rejects.toThrow('ENGINE_INVALID_REQUEST')
    await expect(transport.read('codex', capture, 'x'.repeat(SUBMISSION_TEXT_BYTES + 1))).rejects.toThrow('ENGINE_INVALID_REQUEST')
    await expect(transport.echo('codex', 'x'.repeat(SUBMISSION_TEXT_BYTES + 1))).rejects.toThrow('ENGINE_INVALID_REQUEST')
    await expect(transport.echo('cursor', 'hello')).rejects.toThrow('ENGINE_INVALID_REQUEST')
    expect(call).not.toHaveBeenCalled()
  })

  it('takes no reading a worker could not have made: a span outside the text, malformed facts, an oversized reply', async () => {
    const capability = { version: 1, submission: 1, engine: 'codex' }
    for (const [method, answer] of [
      ['echo', { start: 0, end: 6 }], ['echo', { start: 3, end: 2 }], ['echo', { start: -1, end: 2 }], ['echo', { start: 0, end: 1.5 }],
      ['echo', { start: 0, end: 1, more: true }], ['read', { draft: true, composer: true }], ['read', { draft: 'yes', composer: true, nativeDraft: 'clear' }],
      ['read', { draft: true, composer: true, nativeDraft: 'gone' }], ['read', { draft: true, composer: true, nativeDraft: 'clear', note: 'x'.repeat(SUBMISSION_REPLY_BYTES) }],
    ] as const) {
      const transport = createSubmissionTransport({ call: async (_s, name) => name === SUBMISSION_CAPABILITIES ? capability : { version: 1, answer } })
      transport.connected('engine-codex')
      await expect(method === 'echo' ? transport.echo('codex', 'hello') : transport.read('codex', capture, 'hello')).rejects.toThrow('ENGINE_INVALID_REPLY')
    }
    // A screen worker is not a submission worker: its capability names no submission reader.
    const screen = createSubmissionTransport({ call: async () => ({ version: 1, screen: 1, engine: 'codex' }) })
    screen.connected('engine-codex')
    await expect(screen.read('codex', capture, 'hello')).rejects.toThrow('ENGINE_INVALID_REPLY')
  })
})
