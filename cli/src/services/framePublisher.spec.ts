import { FRAME_PART_BYTES } from '../harnessd/services.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLife, AgentView } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createFramePublisher } from './framePublisher.js'

const active = (agentId = 'a', frameEpoch: string | undefined = 'core:1') => ({ agentId, frameEpoch }) as AgentView
const cleanup: Array<() => void> = []
afterEach(() => { for (const end of cleanup.splice(0)) end(); vi.useRealTimers() })
function setup() {
  let heard!: (event: AgentLife) => void
  const log = vi.fn()
  const legacy = vi.fn((session: Pick<AgentView, 'agentId'>, fields: Readonly<Record<string, unknown>>) => ({ query: 'old', payload: { agentId: session.agentId, ...fields } }))
  const publisher = createFramePublisher(legacy, log)
  const api = publisher.scope(fakeCore({ agents: { follow: listener => { heard = listener; return () => {} } } }))
  api.agents.follow!(() => {})
  const query = vi.fn(async (_name: string, _payload?: Record<string, unknown>): Promise<Record<string, unknown>> => ({ ok: true }))
  publisher.connected({ query })
  const running = (session = active()) => { heard({ kind: 'running', session }); return session }
  cleanup.push(publisher.disconnected)
  return { publisher, api, log, legacy, query, running, heard }
}

describe('frame publication in a service process', () => {
  it('publishes a bounded historical projection larger than sixteen KiB without trimming it', () => {
    const { api, query, running } = setup()
    const fields = { gitContext: { history: { branches: Array.from({ length: 128 }, (_, i) => ({ cwd: `/fixture/${i}`, branch: 'b'.repeat(400) })) } } }
    api.agents.publishFrame!(running(), fields)
    expect(query).toHaveBeenCalledWith('frame_part', { agentId: 'a', frameEpoch: 'core:1', fields })
  })
  it.each(['core:1', undefined])('publishes only changed acknowledged fields across repeated observations (%s)', async epoch => {
    vi.useFakeTimers()
    const { api, query, running } = setup()
    const observe = () => running({ ...active(), frameEpoch: epoch })
    if (!epoch) query.mockImplementation(async name => name === 'frame_part' ? { error: 'UNKNOWN_QUERY' } : { ok: true })
    const sent = epoch ? 1 : 2
    api.agents.publishFrame!(observe(), { browser: { state: 'ready' } })
    await vi.advanceTimersByTimeAsync(0)
    api.agents.publishFrame!(observe(), { browser: { state: 'ready' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(sent)
    api.agents.publishFrame!(observe(), {})
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(sent * 2)
    api.agents.publishFrame!(observe(), {})
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(sent * 2)
  })

  it('republishes the same fields after a new run, reconnect or rejected reply', async () => {
    vi.useFakeTimers()
    const { api, query, running, heard, publisher } = setup()
    const fields = { browser: { state: 'ready' } }
    api.agents.publishFrame!(running(), fields)
    await vi.advanceTimersByTimeAsync(0)
    heard({ kind: 'ended', agentId: 'a' })
    api.agents.publishFrame!(running(active('a', 'core:2')), fields)
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(2)
    publisher.disconnected()
    const next = vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true }))
    next.mockResolvedValueOnce({ error: 'FRAME_PART_UNAVAILABLE' })
    publisher.connected({ query: next })
    const session = running(active('a', 'core:2'))
    api.agents.publishFrame!(session, fields)
    await vi.advanceTimersByTimeAsync(0)
    api.agents.publishFrame!(session, fields)
    await vi.advanceTimersByTimeAsync(0)
    expect(next).toHaveBeenCalledTimes(2)
    api.agents.publishFrame!(session, fields)
    await vi.advanceTimersByTimeAsync(0)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('keeps a reversion to acknowledged fields behind an in-flight change', async () => {
    vi.useFakeTimers()
    const { api, query, running } = setup()
    const session = running(), first = { browser: { state: 'ready' } }
    api.agents.publishFrame!(session, first)
    await vi.advanceTimersByTimeAsync(0)
    let answer!: (value: Record<string, unknown>) => void
    query.mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    api.agents.publishFrame!(session, { browser: { state: 'stopped' } })
    api.agents.publishFrame!(session, first)
    expect(query).toHaveBeenCalledTimes(2)
    answer({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(3)
    expect(query).toHaveBeenLastCalledWith('frame_part', { agentId: 'a', frameEpoch: 'core:1', fields: first })
  })

  it('does not acknowledge a new lifecycle with an old fallback reply', async () => {
    vi.useFakeTimers()
    const { api, query, running, heard } = setup()
    query.mockImplementation(async name => name === 'frame_part' ? { error: 'UNKNOWN_QUERY' } : { ok: true })
    let answer!: (value: Record<string, unknown>) => void
    query.mockResolvedValueOnce({ error: 'UNKNOWN_QUERY' }).mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    const first = { agentId: 'a' } as AgentView, fields = { browser: { state: 'ready' } }
    api.agents.publishFrame!(running(first), fields)
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(2)
    heard({ kind: 'ended', agentId: 'a' })
    const next = running({ agentId: 'a' } as AgentView)
    answer({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    api.agents.publishFrame!(next, fields)
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(4)
  })

  it('publishes captured JSON and coalesces one pending update per live agent', async () => {
    const { api, query, running } = setup()
    const session = running()
    let answer!: (value: Record<string, unknown>) => void
    query.mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    const fields = { browser: { state: 'starting' } }
    api.agents.publishFrame!(session, fields)
    fields.browser.state = 'changed afterwards'
    api.agents.publishFrame!(session, { browser: { state: 'ready' } })
    api.agents.publishFrame!(session, {})
    expect(query).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledWith('frame_part', { agentId: 'a', frameEpoch: 'core:1', fields: { browser: { state: 'starting' } } })
    answer({ ok: true })
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
    expect(query).toHaveBeenLastCalledWith('frame_part', { agentId: 'a', frameEpoch: 'core:1', fields: {} })
  })

  it('an old lifecycle result cannot replace a queued new run, even under the same agent id', async () => {
    const { api, query, running, heard, log } = setup()
    const old = running()
    let answer!: (value: Record<string, unknown>) => void
    query.mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    api.agents.publishFrame!(old, { browser: { state: 'starting' } })
    heard({ kind: 'ended', agentId: 'a' })
    const next = running(active('a', 'core:2'))
    api.agents.publishFrame!(next, { browser: { state: 'ready' } })
    api.agents.publishFrame!(old, { browser: { state: 'failed' } })
    expect(log).toHaveBeenLastCalledWith('[frames] FRAME_PART_STALE')
    answer({ ok: true })
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
    expect(query).toHaveBeenLastCalledWith('frame_part', { agentId: 'a', frameEpoch: 'core:2', fields: { browser: { state: 'ready' } } })
  })

  it('captures publication authority before queuing, even if its caller mutates a retained view', async () => {
    const { api, query, running, heard, log } = setup()
    const old = running()
    let answer!: (value: Record<string, unknown>) => void
    query.mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    api.agents.publishFrame!(old, { browser: { state: 'starting' } })
    api.agents.publishFrame!(old, { browser: { state: 'failed' } })
    heard({ kind: 'ended', agentId: 'a' })
    running(active('a', 'core:2'))
    Object.assign(old, { frameEpoch: 'core:2' })
    answer({ ok: true })
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[frames] FRAME_PART_STALE'))
    expect(query).toHaveBeenCalledOnce()
  })

  it('never borrows a later connection for a fallback, and learns leases again after reconnect', async () => {
    const { api, query, running, publisher, legacy } = setup()
    const old = running()
    let answer!: (value: Record<string, unknown>) => void
    query.mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    api.agents.publishFrame!(old, {})
    publisher.disconnected()
    api.agents.publishFrame!(old, {})
    const nextQuery = vi.fn(async () => ({ ok: true }))
    publisher.connected({ query: nextQuery })
    api.agents.publishFrame!(old, {})
    expect(nextQuery).not.toHaveBeenCalled()
    answer({ error: 'UNKNOWN_QUERY' })
    await Promise.resolve()
    expect(legacy).not.toHaveBeenCalled()
    const next = running(active('a', 'new-core:1'))
    api.agents.publishFrame!(next, {})
    expect(nextQuery).toHaveBeenCalledWith('frame_part', { agentId: 'a', frameEpoch: 'new-core:1', fields: {} })
  })

  it('does not send a legacy fallback after the originating lifecycle ended', async () => {
    const { api, query, running, heard, legacy } = setup()
    let answer!: (value: Record<string, unknown>) => void
    query.mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    const old = running({ agentId: 'a' } as AgentView)
    api.agents.publishFrame!(old, { browser: { state: 'ready' } })
    heard({ kind: 'ended', agentId: 'a' })
    running({ agentId: 'a' } as AgentView)
    answer({ error: 'UNKNOWN_QUERY' })
    await Promise.resolve(); await Promise.resolve()
    expect(legacy).not.toHaveBeenCalled()
  })

  it('falls back only for explicit UNKNOWN_QUERY and keeps the original service-owned data', async () => {
    const { api, query, running, legacy, log } = setup()
    const session = running({ agentId: 'a' } as AgentView)
    query.mockResolvedValueOnce({ error: 'UNKNOWN_QUERY' }).mockResolvedValueOnce({ ok: true })
    api.agents.publishFrame!(session, { browser: { state: 'ready' } })
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith('old', { agentId: 'a', browser: { state: 'ready' } }))
    expect(legacy).toHaveBeenCalledOnce()
    query.mockResolvedValueOnce({ error: 'FRAME_PART_STALE' })
    api.agents.publishFrame!(running(active('b')), {})
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[frames] FRAME_PART_UNAVAILABLE'))
    expect(legacy).toHaveBeenCalledOnce()
  })

  it('a timed-out connection accepts no more work until reconnection', async () => {
    vi.useFakeTimers()
    const { api, query, running, publisher, log } = setup()
    const session = running()
    query.mockReturnValue(new Promise(() => {}))
    api.agents.publishFrame!(session, {})
    api.agents.publishFrame!(session, { browser: { state: 'ready' } })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(log).toHaveBeenCalledWith('[frames] FRAME_PART_UNAVAILABLE')
    api.agents.publishFrame!(session, {})
    expect(query).toHaveBeenCalledOnce()
    const next = vi.fn(async () => ({ ok: true }))
    publisher.connected({ query: next })
    api.agents.publishFrame!(running(), {})
    expect(next).toHaveBeenCalledOnce()
  })

  it('says named failures without a supplied logger, and ignores a failed old connection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let heard!: (event: AgentLife) => void
    const publisher = createFramePublisher(() => ({ query: 'old', payload: {} }))
    const api = publisher.scope(fakeCore({ agents: { follow: listener => { heard = listener; return () => {} } } }))
    api.agents.follow!(() => {})
    let reject!: (error: Error) => void
    const query = vi.fn(() => new Promise<Record<string, unknown>>((_resolve, fail) => { reject = fail }))
    publisher.connected({ query })
    api.agents.publishFrame!(active(), {})
    expect(warn).toHaveBeenCalledWith('[frames] FRAME_PART_STALE')
    const row = { agentId: 'old' } as AgentView
    heard({ kind: 'running', session: row })
    api.agents.publishFrame!({ ...row }, {})
    expect(query).not.toHaveBeenCalled()
    api.agents.publishFrame!(row, {})
    heard({ kind: 'purged', agentId: 'old', sessionIds: [] })
    heard({ kind: 'stopped', agentId: 'old' })
    publisher.disconnected()
    reject(new Error('old connection gone'))
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('bounds live identities and queued bytes, and rejects malformed JSON before querying', () => {
    vi.useFakeTimers()
    const { api, query, running, log } = setup()
    query.mockReturnValue(new Promise(() => {}))
    const session = running()
    api.agents.publishFrame!(session, { browser: 'x'.repeat(FRAME_PART_BYTES) })
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    api.agents.publishFrame!(session, cyclic)
    expect(query).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([['[frames] FRAME_PART_LIMIT'], ['[frames] FRAME_PART_INVALID']])
    for (let i = 0; i < 300; i++) api.agents.publishFrame!(running(active(`big-${i}`)), { browser: 'x'.repeat(16_000) })
    expect(query.mock.calls.length).toBeLessThan(300)
    for (let i = 0; i < 4096; i++) running(active(`small-${i}`))
    expect(log).toHaveBeenLastCalledWith('[frames] FRAME_PART_LIMIT')
  })
})
