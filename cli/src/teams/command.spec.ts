import { describe, expect, it, vi } from 'vitest'
import { parseTeamArgs, waitForTeamAnswer } from './command.js'

describe('team agent command interface', () => {
  it('resolves current task context on the session’s machine without selecting a swarm', () => {
    expect(parseTeamArgs(['context', '--agent', 'session-a', '--machine', 'remote'], { port: 18473, machineId: 'host' }))
      .toMatchObject({ machineId: 'remote', payload: { action: 'context', agentId: 'session-a' } })
  })
  it('keeps quoted questions and retry identities without shell interpretation', () => {
    const parsed = parseTeamArgs(['--team', 'a'.repeat(32), '--member-key', 'b'.repeat(64), 'ask', 'daemons', 'Explain `$(not-a-command)`', '--id', 'c'.repeat(32), '--json'], { port: 18473, machineId: 'host' })
    expect(parsed).toMatchObject({ json: true, payload: { action: 'ask', text: 'Explain `$(not-a-command)`', to: 'daemons', id: 'c'.repeat(32) } })
  })
  it('bounds waits and requires a real daemon address', () => {
    expect(() => parseTeamArgs(['wait', 'a'.repeat(32), '--seconds', '3600'], { port: 18473, machineId: 'host' })).toThrow('1 and 60')
    expect(() => parseTeamArgs(['list'], { port: 0, machineId: '' })).toThrow('Choose the team machine')
  })
  it('breaks a mutual wait with incoming questions before sleeping', async () => {
    const call = vi.fn(async (p: Record<string, unknown>) => p.action === 'status'
      ? { exchange: { id: 'question-a', state: 'pending' } }
      : { questions: [{ id: 'question-b', text: 'I need your version first' }], answers: [] })
    const sleep = vi.fn(async () => {})
    expect(await waitForTeamAnswer({}, 30, call, { now: () => 1000, sleep })).toMatchObject({ wait: 'incoming_questions', questions: [{ id: 'question-b' }] })
    expect(sleep).not.toHaveBeenCalled()
  })
  it('a timed-out observation leaves the question active and never resends or cancels', async () => {
    let now = 0
    const call = vi.fn(async (p: Record<string, unknown>) => p.action === 'status' ? { exchange: { state: 'pending' } } : { questions: [], answers: [] })
    const result = await waitForTeamAnswer({}, 2, call, { now: () => now, sleep: async ms => { now += ms } })
    expect(result).toMatchObject({ wait: 'timeout', exchange: { state: 'pending' } })
    expect(call.mock.calls.every(([p]) => ['status', 'inbox'].includes(String(p.action)))).toBe(true)
  })
})
