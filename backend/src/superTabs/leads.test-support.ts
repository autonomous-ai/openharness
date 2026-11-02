import type { SuperTabState } from './model.js'

/** Stores the Leads conversation an older Swarm still has (model.ts leadsRemoved), as syncLeads made it before the removal:
 *  the one way a test reaches it now. */
export function storeOldLeads(state: SuperTabState, agentIds: string[] = [], id = 'old-leads'): string {
  state.leadsConversationId = id
  state.conversations.push({ id, kind: 'leads', title: 'Leads', leadId: null, agentIds, archived: false, brief: '', checks: [],
    assignment: null, lastMessageSequence: 0 })
  return id
}
