import { describe, expect, it, vi } from 'vitest'
import { CLOUD_DOWN } from './api.js'
import { createCloudLink } from './cloudLink.js'
import type { CloudHarness } from '../lib/cloudAgents.js'

describe('cloud agents in their own process, as the core reaches them', () => {
  it('carries prepared replies unchanged to the owner admission boundary', async () => {
    const reply = { prepared: 'wire data' }, before = { agentId: 'cloud_1' } as CloudHarness
    const call = vi.fn(async () => reply)
    const port = createCloudLink(call)
    expect(await port.create({ engine: 'fo' })).toBe(reply)
    expect(await port.answer('cloud_1', 'cloud_q_1', { answer: 'main' })).toBe(reply)
    expect(await port.rename('cloud_1', 'Trip', before)).toBe(reply)
    expect(await port.stopHarness('cloud_1')).toBe(reply)
    expect(call.mock.calls).toEqual([
      ['create', { engine: 'fo' }], ['answer', { agentId: 'cloud_1', questionId: 'cloud_q_1', answers: { answer: 'main' } }],
      ['rename', { agentId: 'cloud_1', name: 'Trip', before }], ['stopHarness', { agentId: 'cloud_1' }],
    ])
  })

  it('retains the existing typed delivery result and malformed fallback', async () => {
    const answers = [{ ok: true, detail: 'done' }, { ok: true }, { ok: false, error: 'BUSY', detail: 'wait' }, { ok: false, error: 'X' }, {}]
    const port = createCloudLink(async () => answers.shift()!)
    expect(await port.deliver('a', 'b')).toEqual({ ok: true, detail: 'done' })
    expect(await port.deliver('a', 'b')).toEqual({ ok: true })
    expect(await port.deliver('a', 'b')).toEqual({ ok: false, error: 'BUSY', detail: 'wait' })
    expect(await port.deliver('a', 'b')).toEqual({ ok: false, error: 'X' })
    expect(await port.deliver('a', 'b')).toEqual(CLOUD_DOWN)
  })
})
