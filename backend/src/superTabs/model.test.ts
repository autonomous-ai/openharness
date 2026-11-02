import { describe, expect, it } from 'vitest'
import { createSuperTab, visibleState, type SuperTabState } from './model.js'

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) }
  return value
}

describe('the removed Leads conversation', () => {
  it('is left out of a read over frozen stored records, which keep it unchanged', () => {
    const base = createSuperTab('tab1', 'Pilot', { id: 'u1', email: 'owner@example.com' }, 'prod')
    expect(base.conversations.some(c => c.kind === 'leads')).toBe(false)
    base.leadsConversationId = 'old-leads'
    base.conversations.push({ id: 'old-leads', kind: 'leads', title: 'Leads', leadId: null, agentIds: ['a1'], archived: false, brief: '',
      checks: [], assignment: null, lastMessageSequence: 3 })
    const stored = deepFreeze(structuredClone(base))
    // A read's state is a new object over frozen stored records (parts/shape.ts reassemble with `share`).
    const state: SuperTabState = { ...stored, conversations: [...stored.conversations] }
    const view = visibleState(state, { kind: 'person', userId: 'u1', email: 'owner@example.com' })
    expect(view.conversations.map(c => c.id)).toEqual(['lead'])
    expect(view).not.toHaveProperty('leadsConversationId')
    expect(stored.conversations.find(c => c.kind === 'leads')).toMatchObject({ agentIds: ['a1'], lastMessageSequence: 3 })
  })
})
