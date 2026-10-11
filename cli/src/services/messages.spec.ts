import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, MESSAGES_REQUESTS } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'

/**
 * Agent Messages in the core's process: the service is messages/service.ts's to prove (messages/service.spec.ts);
 * here, that it starts and keeps its contract with the core.
 */
const made = vi.hoisted(() => ({ calls: [] as string[], options: [] as unknown[] }))
vi.mock('../messages/service.js', () => ({
  startAgentMessages: (_core: unknown, options: unknown) => {
    made.options.push(options)
    return {
      requests: { agent_messages: async () => ({ ok: true }) },
      canWrite: (id: string) => id === 'team:msg:yes',
      start: () => made.calls.push('start'),
      stop: () => made.calls.push('stop'),
    }
  },
}))

import { MESSAGES_REQUESTS as REEXPORTED, startMessagesInCore } from './messages.js'

describe('Agent Messages in the core\'s process', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'messages-')); made.calls.length = 0; made.options.length = 0 })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('answers the one request the core routes to it', () => {
    expect(MESSAGES_REQUESTS).toEqual(['agent_messages'])
    expect(REEXPORTED).toBe(MESSAGES_REQUESTS)
  })

  it('starts at once with the options it was given, and answers whether a delivery may be written', async () => {
    const ports = emptyPorts()
    const requests = startMessagesInCore(fakeCore({ dataDir: dir }), ports)
    expect(made.calls).toEqual(['start'])
    expect(made.options).toEqual([{}])
    expect(await requests.agent_messages!({ action: 'history' }, { local: true, owner: true })).toEqual({ ok: true })
    expect(ports.messages!.canWrite('team:msg:yes')).toBe(true)
    expect(ports.messages!.canWrite('team:msg:no')).toBe(false)
    ;(ports.messages as unknown as { stop(): void }).stop()
    expect(made.calls).toEqual(['start', 'stop'])
    startMessagesInCore(fakeCore({ dataDir: dir }), emptyPorts(), { dataDir: dir })
    expect(made.options.at(-1)).toEqual({ dataDir: dir })
  })
})
