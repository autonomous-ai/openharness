import { describe, expect, it, vi } from 'vitest'
import { createOrchestratorLink, DIRECTOR_FRAMES } from './orchestratorLink.js'

describe('the orchestrator in its own process, as the core sees it', () => {
  it('answers a role from the last report, none before the first, and keeps it while the process is down', () => {
    const link = createOrchestratorLink(vi.fn(() => true))
    expect(link.port.roleOf('agent-1')).toBeNull()
    expect(link.answer('roles', { roles: { 'agent-1': { role: 'worker' }, 'agent-2': { role: 'director', busy: true } } })).toEqual({})
    expect(link.port.roleOf('agent-1')).toEqual({ role: 'worker' })
    expect(link.port.roleOf('agent-2')).toEqual({ role: 'director', busy: true })
    // A new report replaces the last whole: an agent no longer in a project has no role.
    link.answer('roles', { roles: { 'agent-2': { role: 'director', busy: false } } })
    expect(link.port.roleOf('agent-1')).toBeNull()
    expect(link.port.roleOf('agent-2')).toEqual({ role: 'director', busy: false })
    expect(link.port.stop()).toBeUndefined()
  })

  it('takes no role it cannot read', () => {
    const link = createOrchestratorLink(vi.fn(() => true))
    link.answer('roles', { roles: { a: { role: 'director' }, b: { role: 'boss' }, c: null, d: 'worker', e: { role: 'worker' } } })
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => link.port.roleOf(id))).toEqual([null, null, null, null, { role: 'worker' }])
    link.answer('roles', {})
    expect(link.port.roleOf('e')).toBeNull()
  })

  it('hands its process only a Director\'s frames of the kinds a project reads', () => {
    const notify = vi.fn((_frame: unknown) => true)
    const link = createOrchestratorLink(notify)
    link.answer('roles', { roles: { director: { role: 'director', busy: true }, worker: { role: 'worker' } } })
    for (const type of DIRECTOR_FRAMES) link.port.frame({ type, agentId: 'director', payload: {} })
    link.port.frame({ type: 'agent_updated', agentId: 'director', payload: {} })
    link.port.frame({ type: 'text_delta', agentId: 'worker', payload: {} })
    link.port.frame({ type: 'text_delta', agentId: 'stranger', payload: {} })
    link.port.frame({ type: 'text_delta', payload: {} })
    expect(notify.mock.calls.map(([frame]) => (frame as { payload: { frame: { type: string } } }).payload.frame.type)).toEqual([...DIRECTOR_FRAMES])
    expect(notify).toHaveBeenCalledWith({ type: 'service_event', payload: { kind: 'frame', frame: { type: 'turn_started', agentId: 'director', payload: {} } } })
  })

  it('leaves every other query to whoever answers it', () => {
    expect(createOrchestratorLink(vi.fn(() => true)).answer('live', {})).toBeNull()
  })
})
