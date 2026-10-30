import { describe, expect, it } from 'vitest'
import { currentAssignment, staleAssignmentHint, wantsCurrent, withCurrentAssignment } from './assignmentIds.js'

const state = { conversations: [{ id: 'g1', assignment: { id: '58c2d5f2bdc100771bc57de7', agentId: 'builder' } }, { id: 'g2' }] }

describe('assignment ids', () => {
  it('reads the group\'s active assignment', () => {
    expect(currentAssignment(state, 'g1')).toEqual({ id: '58c2d5f2bdc100771bc57de7', agentId: 'builder' })
    expect(currentAssignment(state, 'g2')).toBeNull()
    expect(currentAssignment(null, 'g1')).toBeNull()
  })

  it('fills "current" or a missing id with the assignment the agent holds', () => {
    for (const assignmentId of ['current', undefined, null, '']) {
      expect(withCurrentAssignment({ type: 'work.status', conversationId: 'g1', assignmentId, status: 'done' }, state, 'builder'))
        .toMatchObject({ assignmentId: '58c2d5f2bdc100771bc57de7', status: 'done' })
    }
  })

  it('never reports on another agent\'s task, but lets the Lead cancel it by "current"', () => {
    const status = { type: 'work.status', conversationId: 'g1', assignmentId: 'current', status: 'done' }
    expect(withCurrentAssignment(status, state, 'lead')).toBe(status)
    expect(withCurrentAssignment({ type: 'work.cancel', conversationId: 'g1', assignmentId: 'current' }, state, 'lead'))
      .toMatchObject({ assignmentId: '58c2d5f2bdc100771bc57de7' })
  })

  it('leaves an explicit id, another command, or a group with no task as sent', () => {
    const named = { type: 'work.status', conversationId: 'g1', assignmentId: '9887f5667a24ace0b589b7ff' }
    expect(wantsCurrent(named)).toBe(false)
    expect(withCurrentAssignment(named, state, 'builder')).toBe(named)
    expect(wantsCurrent({ type: 'message.send', conversationId: 'g1' })).toBe(false)
    const none = { type: 'work.status', conversationId: 'g2', assignmentId: 'current' }
    expect(withCurrentAssignment(none, state, 'builder')).toBe(none)
  })

  it('fills a missing group for a status or check from the one task the agent holds', () => {
    const two = { conversations: [...state.conversations, { id: 'g3', assignment: { id: 'a3', agentId: 'builder', status: 'working' } }] }
    const ended = { conversations: [state.conversations[0], { id: 'g3', assignment: { id: 'a3', agentId: 'builder', status: 'done' } }] }
    const check = { type: 'work.check', assignmentId: 'current', checkId: 'c1', passed: true }
    expect(withCurrentAssignment(check, state, 'builder')).toEqual({ ...check, conversationId: 'g1', assignmentId: '58c2d5f2bdc100771bc57de7' })
    expect(withCurrentAssignment(check, ended, 'builder')).toMatchObject({ conversationId: 'g1' })
    expect(withCurrentAssignment(check, two, 'builder')).toBe(check)
    expect(withCurrentAssignment(check, state, 'lead')).toBe(check)
    const cancel = { type: 'work.cancel', assignmentId: 'current' }
    expect(withCurrentAssignment(cancel, state, 'builder')).toBe(cancel)
  })

  it('names the id to use when a stale one is refused', () => {
    const stale = { type: 'work.status', conversationId: 'g1', assignmentId: '9887f5667a24ace0b589b7ff' }
    expect(staleAssignmentHint(stale, state, 'builder')).toContain('"assignmentId": "58c2d5f2bdc100771bc57de7"')
    expect(staleAssignmentHint(stale, state, 'other')).toMatch(/another agent's/)
    expect(staleAssignmentHint({ ...stale, conversationId: 'g2' }, state, 'builder')).toMatch(/no active assignment/)
  })
})
