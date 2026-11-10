import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../lib/ssoAuth.js'
import { recordingDb } from '../lib/queryRecorder.test-support.js'
import { hostTab, type HostLookups } from './read/hostRows.js'
import { owner, swarm } from './read/fixture.test-support.js'
import { SuperTabStore } from './store.js'

// Task #4673 (anh Dee, 11-07: "a barebone you so I can understand exactly how you're reacting and tune you"): an agent reads
// its project's own instructions and the command manual, and nothing the Swarm adds. The coordinator's read carried two
// built-in sections ("Swarm process v2" and "Built-in PM schedule", about 1,200 words he never wrote); the scheduled wake
// says what each job is on its own.

const user = { sub: owner.userId, email: owner.email } as AuthUser
const lookups = (): HostLookups => ({ people: [{ id: owner.userId, email: owner.email }], confidential: new Set(), agentGrant: async () => {}, githubApp: false })

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
    // Swarm v4 (slice S7): no host installs project instructions, the coordinator's included.
    expect(row(lead).instructions).toBeNull()
    expect(row(worker).instructions).toBeNull()
  })
})
