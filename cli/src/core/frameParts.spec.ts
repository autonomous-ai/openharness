import { describe, expect, it, vi } from 'vitest'
import { FRAME_PART_BYTES, type ServiceHostSpec } from '../harnessd/services.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createAgentLife } from './agentLife.js'
import type { AgentView } from './api.js'
import { createFrameParts } from './frameParts.js'

const row = (agentId = 'a'): RegisteredSession => ({ agentId, sessionId: 's', registeredAt: 1, dsh: 'saved', active: true }) as RegisteredSession
function setup() {
  const rows = new Map([['a', row()]])
  const hub = createAgentLife({ live: () => [...rows.values()], notify: () => true, hears: {} })
  const core = fakeCore({ agents: { byAgent: id => rows.get(id), terminalAvailable: () => true, follow: hub.follow } })
  const log = vi.fn()
  const parts = createFrameParts({ core, epoch: hub.frameEpoch, log })
  const followed = () => (hub.followed('viewers', { frames: true }).agents as AgentView[])[0]!
  const view = followed()
  const publish = (service: string, fields: unknown, given = view, current = true) =>
    parts.answer(service, 'frame_part', { agentId: given.agentId, frameEpoch: given.frameEpoch, fields }, () => current)
  return { rows, hub, core, log, parts, view, followed, publish }
}

describe('service frame parts', () => {
  it('admits all 512 declared array members without charging its non-JSON length property', () => {
    const { publish, parts } = setup()
    const browser = Array(512).fill(null)
    expect(publish('agentBrowser', { browser })).toEqual({ ok: true })
    expect(parts.read('a')).toEqual({ browser })
    expect(publish('agentBrowser', { browser: [...browser, null] })).toEqual({ error: 'FRAME_PART_INVALID' })
    expect(publish('agentBrowser', { browser: Array.from({ length: 63 }, () => Array(256).fill(null)) })).toEqual({ ok: true })
    expect(publish('agentBrowser', { browser: Array.from({ length: 64 }, () => Array(256).fill(null)) })).toEqual({ error: 'FRAME_PART_INVALID' })
  })
  it('retains full bounded histories and observed work through the same generic part', () => {
    const { publish, parts } = setup()
    const history = { branches: Array.from({ length: 128 }, (_, i) => ({ cwd: `/fixture/${i}`, branch: 'b'.repeat(400), at: '2026-11-16' })),
      pullRequests: Array.from({ length: 128 }, (_, i) => ({ url: `https://github.com/example/repo/pull/${i}`, title: 't'.repeat(400), state: 'OPEN' })) }
    expect(publish('agentBrowser', { browser: { history } })).toEqual({ ok: true })
    expect(parts.read('a')).toEqual({ browser: { history } })
  })
  it('both existing services publish independently, replacing their own whole part', () => {
    const { publish, parts, core } = setup()
    expect(publish('viewers', { dsh: 'renamed', viewerUrl: null })).toEqual({ ok: true })
    expect(publish('agentBrowser', { browser: { state: 'ready' } })).toEqual({ ok: true })
    expect(parts.read('a')).toEqual({ dsh: 'renamed', viewerUrl: null, browser: { state: 'ready' } })
    expect(publish('viewers', { dsh: 'renamed' })).toEqual({ ok: true })
    expect(parts.read('a')).toEqual({ dsh: 'renamed', browser: { state: 'ready' } })
    core.agents.sync = vi.fn()
    publish('viewers', { dsh: 'renamed' })
    expect(core.agents.sync).not.toHaveBeenCalled()
    publish('agentBrowser', {})
    expect(parts.read('a')).toEqual({ dsh: 'renamed' })
    publish('viewers', {})
    expect(parts.read('a')).toEqual({})
    expect(publish('viewers', {})).toEqual({ ok: true })
  })

  it('captures the run before frame work and refuses old connection or lifecycle authority', () => {
    const { publish, parts, hub, followed, view } = setup()
    publish('agentBrowser', { browser: { state: 'ready' } })
    const before = parts.forFrame(row())
    expect(before()).toHaveProperty('browser')
    expect(publish('agentBrowser', { browser: { state: 'failed' } }, view, false)).toEqual({ error: 'FRAME_PART_STALE' })
    // A mere disconnect preserves what the service last said.
    hub.disconnected('viewers')
    expect(parts.read('a')).toHaveProperty('browser')
    hub.ended('a')
    expect(parts.read('a')).toEqual({})
    const next = followed()
    expect(next.frameEpoch).not.toEqual(view.frameEpoch)
    expect(publish('agentBrowser', { browser: { state: 'failed' } })).toEqual({ error: 'FRAME_PART_STALE' })
    expect(publish('agentBrowser', { browser: { state: 'starting' } }, next)).toEqual({ ok: true })
    expect(before()).toEqual({})
    expect(parts.forFrame(row())()).toEqual({ browser: { state: 'starting' } })
    expect(parts.forFrame(row('missing'))()).toEqual({})
  })

  it('purge invalidates a lease before notifying services, even while the row is still being removed', () => {
    const { publish, parts, hub, followed, view } = setup()
    publish('agentBrowser', { browser: { state: 'ready' } })
    hub.purged('a', ['s'])
    expect(hub.frameEpoch('a')).toBeUndefined()
    expect(publish('agentBrowser', { browser: { state: 'failed' } }, view)).toEqual({ error: 'FRAME_PART_STALE' })
    const next = followed()
    expect(publish('agentBrowser', { browser: { state: 'starting' } }, next)).toEqual({ ok: true })
    expect(parts.read('a')).toEqual({ browser: { state: 'starting' } })
  })

  it('leases are opt-in and stable across repeated observations', () => {
    const { hub, followed, view } = setup()
    expect((hub.followed('ordinary', {}).agents as AgentView[])[0]).not.toHaveProperty('frameEpoch')
    hub.running(row())
    expect(followed().frameEpoch).toBe(view.frameEpoch)
    expect(hub.followed('invalid', { frames: 'yes' })).toEqual({ error: 'INVALID_REQUEST' })
  })

  it('a core restart cannot reuse the prior core lease even for the first identical agent', () => {
    const old = setup(), next = setup()
    expect(old.view.frameEpoch).not.toBe(next.view.frameEpoch)
    expect(next.publish('agentBrowser', { browser: { state: 'ready' } }, old.view)).toEqual({ error: 'FRAME_PART_STALE' })
    expect(next.publish('agentBrowser', { browser: { state: 'starting' } })).toEqual({ ok: true })
  })

  it('bounds retained parts across agents and releases budget when an agent ends', () => {
    const { rows, hub, parts } = setup()
    for (let i = 0; i < 300; i++) rows.set(String(i), row(String(i)))
    const views = hub.followed('publisher', { frames: true }).agents as AgentView[]
    const write = (view: AgentView) => parts.answer('agentBrowser', 'frame_part', {
      agentId: view.agentId, frameEpoch: view.frameEpoch, fields: { browser: 'x'.repeat(16_000) },
    }, () => true)
    let refused: AgentView | undefined
    for (const view of views) if (write(view)?.error) { refused = view; break }
    expect(refused).toBeDefined()
    hub.ended('a')
    expect(write(refused!)).toEqual({ ok: true })
  })

  it('bounds entry count independently of bytes, and dropping a service frees its entries', () => {
    const { rows, hub, parts } = setup()
    for (let i = 0; i < 2050; i++) rows.set(String(i), row(String(i)))
    const views = hub.followed('publisher', { frames: true }).agents as AgentView[]
    let refused: AgentView | undefined
    for (const view of views) {
      const payload = { agentId: view.agentId, frameEpoch: view.frameEpoch, fields: { dsh: 'x' } }
      if (parts.answer('viewers', 'frame_part', payload, () => true)?.error) { refused = view; break }
      parts.answer('agentBrowser', 'frame_part', { ...payload, fields: { browser: {} } }, () => true)
    }
    expect(refused).toBeDefined()
    parts.disabled('agentBrowser')
    expect(parts.answer('viewers', 'frame_part', { agentId: refused!.agentId, frameEpoch: refused!.frameEpoch, fields: { dsh: 'x' } }, () => true)).toEqual({ ok: true })
  })

  it('bounds publication leases and prunes only agents no longer live', () => {
    const rows = Array.from({ length: 4096 }, (_, i) => row(String(i)))
    const log = vi.fn()
    const hub = createAgentLife({ live: () => rows, notify: () => true, hears: {}, log })
    hub.followed('publisher', { frames: true, each: true })
    hub.running(row('over'))
    expect(hub.frameEpoch('over')).toBeUndefined()
    expect(log).toHaveBeenCalledWith('[frames] FRAME_PART_LIMIT')
    rows.shift()
    hub.running(row('over'))
    expect(hub.frameEpoch('0')).toBeUndefined()
    expect(hub.frameEpoch('over')).toEqual(expect.any(String))
  })

  it('a service that fails during its start cannot leave a projection or publish during cleanup', () => {
    const { core, hub, view } = setup()
    let available = true
    const parts = createFrameParts({ core, epoch: hub.frameEpoch, available: () => available, log: () => {} })
    const scoped = parts.scope('agentBrowser', core)
    scoped.agents.publishFrame!(view, { browser: { state: 'ready' } })
    available = false
    scoped.agents.publishFrame!(view, { browser: { state: 'starting' } })
    expect(parts.read('a')).toEqual({})
    expect(parts.services).toEqual(['viewers', 'workspaces', 'agentBrowser'])
  })

  it('revokes inline authority and drops only the disabled service', () => {
    const { core, parts, view, publish } = setup()
    const first = parts.scope('viewers', core)
    first.agents.publishFrame!(view, { dshName: 'Drawing' })
    publish('agentBrowser', { browser: { state: 'ready' } })
    const second = parts.scope('viewers', core)
    first.agents.publishFrame!(view, { dshName: 'Old' })
    expect(parts.read('a').dshName).toBe('Drawing')
    second.agents.publishFrame!(view, { dshName: 'Current' })
    parts.disabled('unknown')
    parts.disabled('viewers')
    second.agents.publishFrame!(view, { dshName: 'Late' })
    expect(parts.read('a')).toEqual({ browser: { state: 'ready' } })
    parts.disabled('agentBrowser')
    expect(parts.read('a')).toEqual({})
  })

  it('retains detached immutable JSON and refuses any unowned or unsafe field', () => {
    const { publish, parts } = setup()
    const value = { browser: { state: 'ready', sizes: [1, null, true] } }
    publish('agentBrowser', value)
    value.browser.state = 'failed'
    expect(parts.read('a').browser).toEqual({ state: 'ready', sizes: [1, null, true] })
    expect(Object.isFrozen(parts.read('a'))).toBe(true)
    expect(Object.isFrozen(parts.read('a').browser)).toBe(true)
    for (const fields of [{ id: 'stolen' }, { viewerUrl: 'wrong owner' }, JSON.parse('{"__proto__":{"evil":true}}'),
      { browser: JSON.parse('{"constructor":"evil"}') }, { browser: new Date() }, null, [], 'wrong',
      { browser: { toJSON: () => ({}) } }, { browser: { bad: () => {} } }, { browser: NaN }, { browser: Symbol() }]) {
      expect(publish('agentBrowser', fields)).toEqual({ error: 'FRAME_PART_INVALID' })
    }
    expect(publish('unknown', {})).toEqual({ error: 'FRAME_PART_OWNER' })
    expect(publish('agentBrowser', new Proxy({}, { getPrototypeOf() { throw new Error('broken service object') } }))).toEqual({ error: 'FRAME_PART_INVALID' })
  })

  it('rejects hidden serialization hooks and unsafe keys without invoking service code', () => {
    const { publish, parts } = setup()
    const hook = vi.fn(() => ({ id: 'another-agent' }))
    const hidden = (value: object, key = 'toJSON') => Object.defineProperty(value, key, { value: hook })
    for (const fields of [hidden({ browser: null }), { browser: hidden({ state: 'ready' }) },
      { browser: hidden([]) }, hidden({ browser: null }, '__proto__'), hidden({ browser: null }, 'undeclared'),
      Object.defineProperty({ browser: null }, 'toJSON', { get: hook }),
      { browser: { [Symbol('hidden')]: true } }]) {
      expect(publish('agentBrowser', fields)).toEqual({ error: 'FRAME_PART_INVALID' })
    }
    expect(hook).not.toHaveBeenCalled()
    expect(parts.read('a')).toEqual({})
  })

  it('copies JSON array indices but omits hidden object values, without consulting hooks', () => {
    const { publish, parts } = setup()
    const values = new Array(2)
    Object.defineProperty(values, '0', { value: 'visible array index' })
    const browser = Object.create(null)
    Object.defineProperty(browser, 'hidden', { value: 'not serialized' })
    browser.values = values
    expect(publish('agentBrowser', { browser })).toEqual({ ok: true })
    expect(parts.read('a')).toEqual({ browser: { values: ['visible array index', null] } })
    expect(publish('agentBrowser', { browser: { ['x'.repeat(FRAME_PART_BYTES)]: null } })).toEqual({ error: 'FRAME_PART_INVALID' })
  })

  it('bounds bytes, depth, values and getters without reading their content', () => {
    const { publish } = setup()
    const getter = vi.fn()
    const value = Object.defineProperty({}, 'state', { enumerable: true, get: getter })
    const cyclic: Record<string, unknown> = {}; cyclic.again = cyclic
    let deep: unknown = {}; for (let i = 0; i < 9; i++) deep = { next: deep }
    for (const browser of [value, cyclic, deep, 'x'.repeat(FRAME_PART_BYTES + 1), Array(513).fill(0),
      Object.fromEntries(Array.from({ length: 513 }, (_, i) => [String(i), i])), '\u0000'.repeat(Math.ceil(FRAME_PART_BYTES / 6))]) {
      expect(publish('agentBrowser', { browser })).toEqual({ error: 'FRAME_PART_INVALID' })
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it('does not display a stopped, purged or non-harness agent using retained facts', () => {
    const { publish, parts, rows, hub, core, view } = setup()
    expect(parts.read('missing')).toEqual({})
    publish('viewers', { dshName: 'Drawing' })
    delete rows.get('a')!.dsh
    expect(parts.read('a')).toEqual({})
    expect(publish('viewers', { dshName: 'Late' })).toEqual({ error: 'FRAME_PART_STALE' })
    rows.get('a')!.dsh = 'saved'
    publish('viewers', { dshName: 'Current' })
    core.agents.terminalAvailable = () => false
    core.agents.sync = vi.fn()
    publish('agentBrowser', { browser: { state: 'ready' } })
    expect(core.agents.sync).not.toHaveBeenCalled()
    rows.delete('a')
    expect(parts.read('a')).toEqual({})
    expect(publish('agentBrowser', {})).toEqual({ error: 'FRAME_PART_STALE' })
    hub.purged('a', ['s'])
    hub.ended('unknown')
    hub.purged('unknown', [])
    expect(parts.answer('viewers', 'other', {}, () => true)).toBeUndefined()
    expect(publish('viewers', {}, { ...view, frameEpoch: undefined })).toEqual({ error: 'FRAME_PART_STALE' })
  })

  it('drops an older retained lifecycle and never syncs a row that has already disappeared', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let current: RegisteredSession | undefined = row(), epoch = 'first'
    const core = fakeCore({ agents: { byAgent: () => current, terminalAvailable: () => true } })
    core.agents.follow = undefined
    const parts = createFrameParts({ core, epoch: () => epoch })
    const write = () => parts.answer('agentBrowser', 'frame_part', { agentId: 'a', frameEpoch: epoch, fields: { browser: { state: 'ready' } } }, () => true)
    write()
    epoch = 'second'
    expect(parts.read('a')).toEqual({})
    write()
    current = undefined
    parts.disabled('agentBrowser')
    expect(parts.read('a')).toEqual({})
    expect(write()).toEqual({ error: 'FRAME_PART_STALE' })
    expect(warn).toHaveBeenCalledWith('[frames] FRAME_PART_STALE')
    warn.mockRestore()
  })

  it('does not copy inherited enumerable fields when a host prototype is polluted', () => {
    const { publish, parts } = setup()
    Object.defineProperty(Object.prototype, 'inheritedTestField', { value: 'ignored', enumerable: true, configurable: true, writable: true })
    try {
      expect(publish('agentBrowser', { browser: { state: 'ready' } })).toEqual({ ok: true })
      expect(Object.keys(parts.read('a'))).toEqual(['browser'])
    } finally { delete (Object.prototype as Record<string, unknown>).inheritedTestField }
  })

  it('rejects declared authority fields or competing owners before accepting any service', () => {
    const core = fakeCore()
    const host = (fields: string[], service = 'one'): ServiceHostSpec => ({ services: ['one'], heapLimitMiB: 1, rssLimitMiB: 1, frameParts: { [service]: { fields } } })
    for (const hosts of [{ a: host(['id']) }, { a: host(['__proto__']) }, { a: host(['']) }, { a: host(['x'.repeat(65)]) },
      { a: host([]) }, { a: host(Array(33).fill('field')) }, { a: host(['field'], 'other') },
      { a: host(['field']), b: host(['other']) },
      { a: host(['field']), b: { ...host(['field'], 'two'), services: ['two'] } }]) {
      expect(() => createFrameParts({ core, epoch: () => 'run-1', hosts: hosts as Record<string, ServiceHostSpec> })).toThrow('FRAME_PART_DECLARATION')
    }
  })
})
