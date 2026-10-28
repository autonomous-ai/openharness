import { describe, expect, it } from 'vitest'
import { createSuperTab, syncLeads, type Agent, type SuperTabState } from './model.js'

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) }
  return value
}

describe('syncLeads', () => {
  it('lists the Leads in the Leads conversation without changing the conversation it was given', () => {
    const base = createSuperTab('tab1', 'Pilot', { id: 'u1', email: 'owner@example.com' }, 'prod')
    syncLeads(base)
    const lead = base.conversations.find(c => !c.kind)!
    lead.leadId = 'a1'
    base.agents.push({ id: 'a1' } as Agent)
    const stored = deepFreeze(structuredClone(base))
    // A read's state is a new object over frozen stored records (parts/shape.ts reassemble with `share`).
    const state: SuperTabState = { ...stored, conversations: [...stored.conversations] }
    syncLeads(state)
    expect(state.conversations.find(c => c.kind === 'leads')!.agentIds).toEqual(['a1'])
    expect(stored.conversations.find(c => c.kind === 'leads')!.agentIds).toEqual([])
  })
})
