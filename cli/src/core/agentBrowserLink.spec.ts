import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createAgentBrowserLink, wakeAgentBrowser } from './agentBrowserLink.js'

const row = (agentId: string, browser = true) => ({ agentId, sessionId: `s-${agentId}`, ...(browser ? { browser: true } : {}) }) as RegisteredSession

function setup(live: RegisteredSession[] = []) {
  const sync = vi.fn()
  const count = vi.fn()
  const ids = vi.fn(async () => ({ live: ['a1'], stopped: ['a2'] }))
  const ofPane = vi.fn(async (pane: string) => (pane === '%7' ? 'a1' : null))
  const core = fakeCore({ count, agents: { sync, ids, ofPane, live: () => live, byAgent: (agentId: string) => live.find(s => s.agentId === agentId) } })
  const notify = vi.fn(() => true)
  const want = vi.fn()
  const link = createAgentBrowserLink({ core, notify, want })
  return { link, core, sync, count, notify, want, ids, ofPane }
}

describe('the agent browser in its own process, as the core sees it', () => {
  it('tells the process of an agent with a browser, and asks for the process until it is there', () => {
    const { link, notify, want } = setup()
    link.port.attached(row('plain', false))
    expect(notify).not.toHaveBeenCalled()
    expect(want).not.toHaveBeenCalled()
    link.port.attached(row('a1'))
    expect(want).toHaveBeenCalledTimes(1)
    // An attach it misses is said again when it connects, so it is never held.
    expect(notify).toHaveBeenCalledWith({ type: 'service_event', payload: { kind: 'attached', session: row('a1') } }, undefined)
    link.connected()
    link.port.attached(row('a1'))
    expect(want).toHaveBeenCalledTimes(1)
    link.disconnected()
    link.port.attached(row('a1'))
    expect(want).toHaveBeenCalledTimes(2)
  })

  it('holds a stop and a delete until the process hears them', () => {
    const { link, notify } = setup()
    link.port.stopped('a1')
    link.port.deleted('a2')
    expect(notify.mock.calls).toEqual([
      [{ type: 'service_event', payload: { kind: 'stopped', agentId: 'a1' } }, { untilDelivered: true }],
      [{ type: 'service_event', payload: { kind: 'deleted', agentId: 'a2' } }, { untilDelivered: true }],
    ])
    expect(link.port.stop()).toBeUndefined()
  })

  it('says every agent with a browser again each time the process connects', () => {
    const { link, notify } = setup([row('a1'), row('plain', false)])
    link.connected()
    expect(notify.mock.calls).toEqual([[{ type: 'service_event', payload: { kind: 'attached', session: row('a1') } }, undefined]])
  })

  it('keeps what the process says of an attached agent\'s browser, for its frame, and sends the frame again', async () => {
    const { link, sync } = setup([row('a1')])
    link.port.attached(row('a1'))
    expect(await link.answer('browser_state', { agentId: 'a1', state: { state: 'setup', step: 'building' } })).toEqual({ ok: true })
    expect(link.port.frameContext('a1')).toEqual({ state: 'setup', step: 'building' })
    expect(sync).toHaveBeenCalledWith(row('a1'))
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'failed', error: 'podman_old', extra: 'dropped' } })
    expect(link.port.frameContext('a1')).toEqual({ state: 'failed', error: 'podman_old' })
    await link.answer('browser_state', { agentId: 'a1' })
    expect(link.port.frameContext('a1')).toBeUndefined()
    // What it says of an agent the core did not attach, or has since stopped, brings nothing back.
    await link.answer('browser_state', { agentId: 'other', state: { state: 'ready' } })
    expect(link.port.frameContext('other')).toBeUndefined()
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' } })
    link.port.stopped('a1')
    expect(link.port.frameContext('a1')).toBeUndefined()
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' } })
    expect(link.port.frameContext('a1')).toBeUndefined()
    link.port.attached(row('a1'))
    link.port.deleted('a1')
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' } })
    expect(link.port.frameContext('a1')).toBeUndefined()
    // A state that is no state is refused.
    link.port.attached(row('a1'))
    for (const state of [{ state: 'flying' }, 'ready', { state: 'setup', step: 7 }, { state: 'failed', error: null }]) {
      expect(await link.answer('browser_state', { agentId: 'a1', state }), JSON.stringify(state)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(await link.answer('browser_state', { state: { state: 'ready' } })).toEqual({ error: 'INVALID_REQUEST' })
    // An agent the registry no longer has gets no frame.
    const gone = setup([])
    gone.link.port.attached(row('a9'))
    await gone.link.answer('browser_state', { agentId: 'a9', state: { state: 'ready' } })
    expect(gone.sync).not.toHaveBeenCalled()
  })

  // A viewer's open is answered in line (core/browserStreams.ts), from what the process last said of the browser.
  it('streamCommand answers from the last state and command the process told', async () => {
    const { link } = setup([row('a1')])
    const argv = ['/opt/podman/bin/podman', 'exec', '-i', 'harness-browser-a1', 'socat', 'STDIO', 'TCP:127.0.0.1:5900']
    expect(link.port.streamCommand('a1')).toEqual({ error: 'NO_BROWSER' })
    link.port.attached(row('a1'))
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'starting' } })
    expect(link.port.streamCommand('a1')).toEqual({ error: 'NOT_READY' })
    // Ready without a command it can run is not ready.
    expect(await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' }, command: [1] })).toEqual({ error: 'INVALID_REQUEST' })
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' } })
    expect(link.port.streamCommand('a1')).toEqual({ error: 'NOT_READY' })
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' }, command: argv })
    expect(link.port.streamCommand('a1')).toEqual({ argv })
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'failed', error: 'browser_stopped' } })
    expect(link.port.streamCommand('a1')).toEqual({ error: 'NOT_READY' })
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' }, command: argv })
    link.port.stopped('a1')
    expect(link.port.streamCommand('a1')).toEqual({ error: 'NO_BROWSER' })
  })

  it('a stop and a delete close the browser\'s viewers at once', () => {
    const { link } = setup()
    const closed: string[] = []
    link.port.onCloseViewers(agentId => closed.push(agentId))
    link.port.stopped('a1')
    link.port.deleted('a2')
    expect(closed).toEqual(['a1', 'a2'])
  })

  it('answers the ids of its agents and the agent of a pane', async () => {
    const { link, ids, ofPane } = setup()
    expect(await link.answer('agent_ids', {})).toEqual({ live: ['a1'], stopped: ['a2'] })
    expect(ids).toHaveBeenCalled()
    expect(await link.answer('agent_of_pane', { pane: '%7' })).toEqual({ agentId: 'a1' })
    expect(await link.answer('agent_of_pane', { pane: '%9' })).toEqual({ agentId: null })
    expect(await link.answer('agent_of_pane', {})).toEqual({ error: 'INVALID_REQUEST' })
    expect(ofPane).toHaveBeenCalledTimes(2)
    expect(await link.answer('anything', {})).toEqual({ error: 'UNKNOWN_QUERY' })
    // A core without the calls has no answer to give.
    const bare = createAgentBrowserLink({ core: fakeCore(), notify: () => true, want: () => {} })
    expect(await bare.answer('agent_ids', {})).toEqual({ error: 'UNSUPPORTED' })
    expect(await bare.answer('agent_of_pane', { pane: '%7' })).toEqual({ agentId: null })
  })

  // The person's Start and Stop, from the agent browser's own process: the core sets the flag and tells the browser.
  it('set_browser sets the flag through the core and answers what it said; a payload without an id or a boolean is INVALID_REQUEST', async () => {
    const setBrowser = vi.fn((agentId: string, on: boolean) => Promise.resolve(agentId === 'a1'
      ? { ok: true as const, changed: on } : { error: 'NOT_RUNNING' as const }))
    const link = createAgentBrowserLink({ core: fakeCore({ agents: { setBrowser } }), notify: () => true, want: () => {} })
    expect(await link.answer('set_browser', { agentId: 'a1', on: true })).toEqual({ ok: true, changed: true })
    expect(await link.answer('set_browser', { agentId: 'a1', on: false })).toEqual({ ok: true, changed: false })
    expect(await link.answer('set_browser', { agentId: 'gone', on: true })).toEqual({ error: 'NOT_RUNNING' })
    for (const payload of [{ on: true }, { agentId: 7, on: true }, { agentId: 'a1' }, { agentId: 'a1', on: 'yes' }]) {
      expect(await link.answer('set_browser', payload), JSON.stringify(payload)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(setBrowser.mock.calls).toEqual([['a1', true], ['a1', false], ['gone', true]])
    // A core without the call has no answer to give.
    const bare = createAgentBrowserLink({ core: fakeCore(), notify: () => true, want: () => {} })
    expect(await bare.answer('set_browser', { agentId: 'a1', on: true })).toEqual({ error: 'UNSUPPORTED' })
  })

  it('hands on the agent browser\'s own counters, and no other', async () => {
    const { link, count } = setup()
    expect(await link.answer('count', { metric: 'agent_browser_failed_podman_old' })).toEqual({ ok: true })
    for (const metric of ['launch_started', 'agent_browser_made_up', 7]) expect(await link.answer('count', { metric })).toEqual({ error: 'INVALID_REQUEST' })
    expect(count.mock.calls).toEqual([['agent_browser_failed_podman_old']])
  })
})

describe('wakeAgentBrowser', () => {
  it('asks for the process as the core starts only when it runs out of the core and its state file is there', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-browser-wake-'))
    try {
      const want = vi.fn()
      wakeAgentBrowser({ outOfProcess: new Set(['agentBrowser']), dataDir, want })
      expect(want).not.toHaveBeenCalled()
      writeFileSync(join(dataDir, 'agent-browser.json'), '{}')
      wakeAgentBrowser({ outOfProcess: new Set(), dataDir, want })
      expect(want).not.toHaveBeenCalled()
      wakeAgentBrowser({ outOfProcess: new Set(['agentBrowser']), dataDir, want })
      expect(want).toHaveBeenCalledWith('agentBrowser')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
