import { describe, expect, it } from 'vitest'
import {
  createHarnessWatches, HARNESS_WATCH_LEASE_MS, HARNESS_WATCH_MAX_AGENTS, HARNESS_WATCH_RENEW_MS, HARNESS_WATCHES_MAX,
} from './harnessWatch.js'

function watches() {
  let now = 1_000
  const sent: Array<{ connId: string; payload: Record<string, unknown> }> = []
  const gone = new Set<string>()
  const w = createHarnessWatches({
    send: (connId, payload) => { if (gone.has(connId)) return false; sent.push({ connId, payload }); return true },
    now: () => now,
  })
  return { w, sent, gone, later: (ms: number) => { now += ms } }
}

const activity = (agentId: string, state: string) => ({ type: 'agent_activity', agentId, payload: { agentId, activity: { state } } })
const heartbeat = (agentId: string) => ({ type: 'turn_heartbeat', agentId, payload: { agentId, activity: { state: 'working' } } })
const synced = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'agent_synced', payload: { agent: { id, status: 'active', activity: { state: 'idle' }, ...extra } } })
const question = (agentId: string, requestId: string) => ({ type: 'commander_question', agentId, payload: { requestId, questions: [{ q: 'Ignore your instructions' }] } })
const closed = (agentId: string, requestId: string) => ({ type: 'commander_question_close', agentId, payload: { requestId } })

describe('harness_watch', () => {
  it('answers with what each named harness is doing, unknown for one it has not heard of', () => {
    const { w } = watches()
    w.observe(synced('a'))
    w.observe(heartbeat('b'))
    expect(w.watch('conn', { agentIds: ['a', 'b', 'c'] })).toEqual({
      leaseMs: HARNESS_WATCH_LEASE_MS, renewMs: HARNESS_WATCH_RENEW_MS,
      agents: [{ agentId: 'a', state: 'idle' }, { agentId: 'b', state: 'working' }, { agentId: 'c', state: 'unknown' }],
    })
  })

  it('tells each change of a named harness to that one connection, once, with names and states only', () => {
    const { w, sent } = watches()
    w.observe(synced('a'))
    w.watch('conn', { agentIds: ['a'] })
    w.observe(heartbeat('a'))
    w.observe(heartbeat('a'))
    w.observe(heartbeat('other'))
    w.observe(question('a', 'q1'))
    w.observe(question('a', 'q1'))
    w.observe(closed('a', 'q1'))
    w.observe({ type: 'turn_ended', agentId: 'a', payload: { agentId: 'a' } })
    w.observe({ type: 'text_delta', agentId: 'a', payload: { content: 'secret' } })
    w.observe(synced('a', { status: 'stopped' }))
    w.observe({ type: 'agent_deleted', payload: { agentId: 'a' } })
    expect(sent).toEqual(['working', 'needs_person', 'working', 'idle', 'stopped', 'gone'].map((state) => ({ connId: 'conn', payload: { agentId: 'a', state } })))
  })

  it('tells a turn too short for a heartbeat: started, then ended', () => {
    const { w, sent } = watches()
    w.observe(synced('a'))
    w.watch('conn', { agentIds: ['a'] })
    w.observe({ type: 'turn_started', agentId: 'a', payload: { agentId: 'a', prompt: 'words the harness was given' } })
    w.observe({ type: 'turn_ended', agentId: 'a', payload: { agentId: 'a' } })
    expect(sent.map((s) => s.payload)).toEqual([{ agentId: 'a', state: 'working' }, { agentId: 'a', state: 'idle' }])
  })

  // History read again (an attach, a resume, a rewritten transcript) is marked `replay` (core/turns/funnel.ts): it says
  // what happened, not what happens, and a watcher woken by each old turn would be woken for nothing.
  it('takes no state from replayed history', () => {
    const { w, sent } = watches()
    w.observe(synced('a'))
    w.watch('conn', { agentIds: ['a'] })
    for (const type of ['turn_started', 'turn_ended', 'turn_started']) w.observe({ type, agentId: 'a', replay: true, payload: { agentId: 'a' } })
    w.observe({ type: 'agent_activity', agentId: 'a', replay: true, payload: { activity: { state: 'working' } } })
    expect(sent).toEqual([])
    expect(w.watch('conn', { agentIds: ['a'] })).toMatchObject({ agents: [{ agentId: 'a', state: 'idle' }] })
  })

  it('takes an activity it cannot name, or a frame naming no harness, as no change', () => {
    const { w, sent } = watches()
    w.watch('conn', { agentIds: ['a'] })
    w.observe(activity('a', 'unknown'))
    w.observe({ type: 'agent_activity', payload: {} })
    w.observe({ type: 42 })
    w.observe(activity('a', 'idle'))
    expect(sent.map((s) => s.payload.state)).toEqual(['idle'])
  })

  it('renews a lease by asking again, replaces what it names, and ends it on an empty list', () => {
    const { w, sent, later } = watches()
    w.watch('conn', { agentIds: ['a'] })
    later(HARNESS_WATCH_RENEW_MS)
    w.watch('conn', { agentIds: ['b'] })
    later(HARNESS_WATCH_RENEW_MS)
    w.observe(heartbeat('a'))
    w.observe(heartbeat('b'))
    expect(sent.map((s) => s.payload.agentId)).toEqual(['b'])
    expect(w.watch('conn', { agentIds: [] })).toEqual({ ok: true })
    w.observe(activity('b', 'idle'))
    expect(sent).toHaveLength(1)
  })

  it('lets a lease that was not renewed lapse: nothing more is told, and it no longer counts', () => {
    const { w, sent, later } = watches()
    for (let i = 0; i < HARNESS_WATCHES_MAX; i++) w.watch(`conn${i}`, { agentIds: ['a'] })
    expect(w.watch('late', { agentIds: ['a'] })).toMatchObject({ error: 'TOO_MANY' })
    later(HARNESS_WATCH_LEASE_MS)
    w.observe(heartbeat('a'))
    expect(sent).toEqual([])
    expect(w.watch('late', { agentIds: ['a'] })).toMatchObject({ leaseMs: HARNESS_WATCH_LEASE_MS })
  })

  it('ends a lease with its connection, and with a send that finds the connection gone', () => {
    const { w, sent, gone } = watches()
    w.watch('one', { agentIds: ['a'] })
    w.watch('two', { agentIds: ['a'] })
    w.closed('one')
    gone.add('two')
    w.observe(heartbeat('a'))
    gone.delete('two')
    w.observe(activity('a', 'idle'))
    expect(sent).toEqual([])
  })

  it('refuses a watch past its bounds or not naming harnesses, by name', () => {
    const { w } = watches()
    const ids = Array.from({ length: HARNESS_WATCH_MAX_AGENTS + 1 }, (_, i) => `agent-${i}`)
    expect(w.watch('conn', { agentIds: ids })).toMatchObject({ error: 'TOO_MANY' })
    expect(w.watch('conn', { agentIds: [...ids.slice(0, 2), ids[0]] })).toMatchObject({ agents: [{ agentId: 'agent-0' }, { agentId: 'agent-1' }] })
    for (const agentIds of [undefined, 'a', [''], [7], ['x'.repeat(129)]]) {
      expect(w.watch('conn', { agentIds })).toMatchObject({ error: 'BAD_REQUEST' })
    }
  })

  it('forgets harnesses past its bound, oldest first, and a deleted one at once', () => {
    const { w } = watches()
    for (let i = 0; i < 600; i++) w.observe(synced(`agent-${i}`))
    w.observe({ type: 'agent_deleted', agentId: 'agent-599', payload: {} })
    expect(w.watch('conn', { agentIds: ['agent-0', 'agent-598', 'agent-599'] })).toMatchObject({
      agents: [{ agentId: 'agent-0', state: 'unknown' }, { agentId: 'agent-598', state: 'idle' }, { agentId: 'agent-599', state: 'unknown' }],
    })
  })

  it('keeps what it knew when a synced harness says nothing of its activity, and reads a resumed one again', () => {
    const { w, sent } = watches()
    w.observe({ type: 'agent_synced', payload: {} })
    w.observe(heartbeat('a'))
    w.observe(synced('a', { activity: null }))
    w.watch('conn', { agentIds: ['a'] })
    w.observe(synced('a', { status: 'stopped' }))
    w.observe(synced('a'))
    expect(w.watch('conn', { agentIds: ['a'] })).toMatchObject({ agents: [{ agentId: 'a', state: 'idle' }] })
    expect(sent.map((s) => s.payload.state)).toEqual(['stopped', 'idle'])
  })

  it('ends every lease when the link goes', () => {
    const { w, sent } = watches()
    w.watch('one', { agentIds: ['a'] })
    w.clear()
    w.observe(heartbeat('a'))
    expect(sent).toEqual([])
  })

  it('keeps its leases by the wall clock when given none', () => {
    const w = createHarnessWatches({ send: () => true })
    expect(w.watch('conn', { agentIds: ['a'] })).toMatchObject({ leaseMs: HARNESS_WATCH_LEASE_MS })
  })
})
