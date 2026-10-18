import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, MESSAGES_REQUESTS } from '../core/api.js'
import { createMessagesLink } from '../core/messagesLink.js'
import type { TabFrame } from '../core/api.js'
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
      settingsChanged: () => made.calls.push('settings'),
      start: () => made.calls.push('start'),
      stop: () => made.calls.push('stop'),
    }
  },
}))

import { MESSAGES_REQUESTS as REEXPORTED, startMessagesInCore } from './messages.js'
import * as inline from './inline.js'

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
    ports.messages!.settingsChanged()
    ;(ports.messages as unknown as { stop(): void }).stop()
    expect(made.calls).toEqual(['start', 'settings', 'stop'])
    startMessagesInCore(fakeCore({ dataDir: dir }), emptyPorts(), { dataDir: dir })
    expect(made.options.at(-1)).toEqual({ dataDir: dir })
  })

  it('hears shared tabs\' frames in the core\'s process (HARNESSD_SERVICES=none), from the listeners the socket\'s tabFrame feeds', () => {
    // core/main.ts starts it as `inline.startMessagesInCore(core, ports, { onTabFrame: messagesLink.onTabFrame })` and
    // sets the socket's `onTabFrame` to `messagesLink.tabFrame`: the same seam, end to end in e2e/sharedTabs.e2e.ts.
    const link = createMessagesLink({ core: fakeCore({ dataDir: dir }), notify: () => false })
    inline.startMessagesInCore(fakeCore({ dataDir: dir }), emptyPorts(), { onTabFrame: link.onTabFrame })
    const { onTabFrame } = made.options.at(-1) as { onTabFrame: (listener: (event: TabFrame) => void) => () => void }
    const heard: TabFrame[] = []
    const stop = onTabFrame((event) => heard.push(event))
    const event: TabFrame = { sharedTabId: 'a1b2c3d4e5f6a1b2c3d4e5f6', from: { machineId: 'alice-mac', userId: 'u' }, payload: { kind: 'knock' } }
    link.tabFrame(event)
    stop()
    link.tabFrame({ sharedTabId: event.sharedTabId, ready: true })
    expect(heard).toEqual([event])
  })
})
