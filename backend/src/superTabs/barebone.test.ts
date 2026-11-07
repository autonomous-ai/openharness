import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../lib/ssoAuth.js'
import { recordingDb } from '../lib/queryRecorder.test-support.js'
import { scheduleRequest, SCHEDULE_SLOT_MS } from './pmSchedule.js'
import { latestProcessNote } from './processNotes.js'
import { hostTab, type HostLookups } from './read/hostRows.js'
import { owner, swarm } from './read/fixture.test-support.js'
import { SuperTabStore } from './store.js'

// Task #4673 (anh Dee, 11-07: "a barebone you so I can understand exactly how you're reacting and tune you"): an agent reads
// its project's own instructions and the command manual, and nothing the Swarm adds. The coordinator's read carried two
// built-in sections ("Swarm process v2" and "Built-in PM schedule", about 1,200 words he never wrote); the scheduled wake
// says what each job is on its own.

const user = { sub: owner.userId, email: owner.email } as AuthUser
const lookups = (): HostLookups => ({ people: [{ id: owner.userId, email: owner.email }], confidential: new Set(), agentGrant: async () => {}, teams: [], githubApp: false })

function withLead() {
  const s = swarm()
  const lead = s.add('lead-harness', 'lead', true, owner, 'host', owner.userId)
  const worker = s.add('worker-harness', s.group('Web'), false, owner, 'host', owner.userId)
  return { s, lead, worker }
}

describe('a barebone agent\'s reads (task #4673)', () => {
  it('gives the coordinator its project\'s instructions with no built-in text beside them', async () => {
    const { s, lead } = withLead()
    const state = s.state
    const revision = state.projects![0]!.instructionsRevision ?? 0
    const store = new SuperTabStore(recordingDb([], { 'superTabInstructions.findUnique': { revision, hash: 'h', text: 'Our own rules.' } }) as PrismaClient)
    Object.assign(store, { load: async () => ({ state }), actor: async () => ({ kind: 'agent', agentId: lead, machineOwnerId: owner.userId }) })
    const read = await store.instructions(user, 'tab', state.projects![0]!.id, lead)
    expect(revision).toBeGreaterThan(0)
    expect(read).toMatchObject({ revision, text: 'Our own rules.' })
    expect(read).not.toHaveProperty('builtIn')
  })

  it('names no built-in text for the coordinator\'s host to read again', async () => {
    const { s, lead, worker } = withLead()
    const rows = (await hostTab('tab', s.state, 'host', user, null, lookups())).roster.flatMap(r => 'agent' in r && 'instructions' in r ? [r] : [])
    const row = (id: string) => rows.find(r => r.agent.id === id)!
    expect(row(lead).lead).toBe(true)
    expect(row(lead).instructions).not.toBeNull()
    expect(row(lead).instructions).not.toHaveProperty('builtInHash')
    expect(row(worker).instructions).not.toHaveProperty('builtInHash')
  })

  it('says what the open-task sweep is in the wake itself, pointing at no built-in section', () => {
    const { s, lead } = withLead()
    s.edit(state => { state.projects![0]!.processNote = { confirmed: latestProcessNote()!.id } })
    const now = Date.UTC(2026, 10, 4, 3, 0)
    const wake = scheduleRequest(s.state, s.state.agents.find(a => a.id === lead)!, now)!
    expect(wake.slot).toBe(now / SCHEDULE_SLOT_MS)
    const text = wake.draft.text
    expect(text).not.toMatch(/built-in PM schedule|in your instructions\)/i)
    expect(text).toContain('Open-task sweep: every open task, unassigned ones included, ends with an owner working on it')
    expect(text).toContain('archive every finished task the Swarm left open with no pull request')
  })
})
