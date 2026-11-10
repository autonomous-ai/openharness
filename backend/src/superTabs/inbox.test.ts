/**
 * The PM's inbox (task #3403, anh Dee's Swarm redesign, 11-05): people's new messages and its crew's needs, each with where to
 * answer it, before the notices.
 */
import { describe, expect, it } from 'vitest'
import type { Command } from './commands.js'
import { digestText } from './noticeDigest.js'
import { crewNeedLine, gathersForInbox, INBOX_CAPABILITY, inboxSection, personLine } from './inbox.js'
import type { Author } from './model.js'
import { CREW_NEED_KIND } from './crewNeeds.js'
import { projectsOf } from './projects.js'
import { owner, stepsFixture } from './steps.test-support.js'
import { swarmUsernames } from './usernames.js'

function setup() {
  const f = stepsFixture()
  const ask = (text: string) => f.run({ type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [] } as Command, owner).result.messageId as string
  const project = () => projectsOf(f.state)[0]!
  return { f, ask, project }
}


// Task #3545 (follow-up of #3403): the PM's inbox lists, in this order, people's new messages, its crew's needs and then the
// results and notices, each section left out when empty.
describe('the sections of the PM\'s inbox', () => {
  const since = new Date('2026-11-06T09:00:00Z')

  it('lists people\'s messages, crew needs and results in that order, leaving out empty ones', () => {
    const text = digestText(since, ['- #12: Done (message d in t)'], 0, false,
      { people: ['- ken: Is it out? (message p in lead)'], crew: ['- Dev needs ken: Which port? (message c in lead)'] })
    expect(text.split('\n')).toEqual([
      'New from people (1). Answer each once, in its place: harness super-tab answer GROUP MESSAGE_ID TEXT OPERATION_ID.', '- ken: Is it out? (message p in lead)', '',
      'Crew needs (1). Ask the person yourself and bring the answer back to the agent.', '- Dev needs ken: Which port? (message c in lead)', '',
      'Notices since 09:00 UTC (1). Read one in full: harness super-tab message GROUP MESSAGE_ID.', '- #12: Done (message d in t)'])
    // No results: no notices header; no people or crew: no such section.
    expect(digestText(since, [], 0, false, { people: ['- ken: Hi (message p in lead)'] }).split('\n')).toEqual([
      'New from people (1). Answer each once, in its place: harness super-tab answer GROUP MESSAGE_ID TEXT OPERATION_ID.', '- ken: Hi (message p in lead)'])
  })

  it('puts a person\'s own message under people, a crew need under crew needs, and anything else under results', () => {
    const person = { kind: 'person', id: 'owner' } as Author, agent = { kind: 'agent', id: 'dev' } as Author
    expect(inboxSection({ author: person, source: null })).toBe('people')
    expect(inboxSection({ author: agent, source: { kind: CREW_NEED_KIND, crewNeed: { agentId: 'dev', personIds: ['owner'], messageId: 'm', conversationId: 'g' } } })).toBe('crew')
    expect(inboxSection({ author: agent, source: { kind: 'system', status: 'needs_human', crewNeed: { agentId: 'dev', personIds: [], messageId: 'm', conversationId: 'g' } } })).toBe('crew')
    expect(inboxSection({ author: agent, source: { kind: 'system', status: 'done' } })).toBe('results')
    expect(inboxSection({ author: agent, source: null })).toBe('results')
  })

  it('writes a crew need with its question, its options and the one recommended', () => {
    const { f } = setup()
    const line = crewNeedLine(f.state, { conversationId: f.task, messageId: 'c1' }, { agentId: f.dev, personIds: ['owner'], messageId: 'm', conversationId: f.task,
      question: 'Which port should the parser use?', options: ['8080', '9090'], recommended: 1 }, 'ignored words')
    const name = swarmUsernames(f.state).get('owner')!, dev = f.state.agents.find(a => a.id === f.dev)!, agentName = dev.displayName ?? dev.name
    expect(line).toContain(`${agentName} needs ${name}: Which port should the parser use? Options: 8080 / 9090 (recommended)`)
    expect(line).toMatch(/\(message c1 in [0-9a-f]+\)$/)
    // With no question of its own, the agent's words are the need.
    expect(crewNeedLine(f.state, { conversationId: f.task, messageId: 'c2' }, { agentId: f.dev, personIds: [], messageId: 'm', conversationId: f.task }, 'Please approve the spend.'))
      .toContain(`${agentName} needs a person: Please approve the spend.`)
  })

  // Relay's review of #3278: a routed tag's crew-need row starts with its own lead-in, which the line drops.
  it('drops the crew-need row\'s lead-in from a need with no question of its own', () => {
    const { f } = setup()
    const line = crewNeedLine(f.state, { conversationId: f.task, messageId: 'c3' }, { agentId: f.dev, personIds: ['owner'], messageId: 'm', conversationId: f.task },
      'Crew need for owner, through you (people talk only to the PM):\n\nCan I merge the hotfix tonight?')
    expect(line).toContain(': Can I merge the hotfix tonight?')
    expect(line).not.toContain('through you')
  })

  it('keeps a person\'s message whole up to 1000 characters, by username', () => {
    const { f } = setup()
    const long = 'x'.repeat(900)
    expect(personLine(f.state, { conversationId: 'lead', messageId: 'p1' }, long, 'owner')).toContain(long)
    expect(personLine(f.state, { conversationId: 'lead', messageId: 'p1' }, 'y'.repeat(2000), 'owner').length).toBeLessThanOrEqual(1000)
  })

  it('batches crew needs but delivers people immediately even to a turn-aware PM', () => {
    const { f } = setup()
    const pm = f.state.agents.find(a => a.id === f.lead)!, dev = f.state.agents.find(a => a.id === f.dev)!
    const person = { author: { kind: 'person', id: 'owner' } as Author, source: undefined }
    const need = { author: { kind: 'agent', id: f.dev } as Author, source: { kind: CREW_NEED_KIND, crewNeed: { agentId: f.dev, personIds: ['owner'], messageId: 'm', conversationId: f.task } } }
    const post = { author: { kind: 'agent', id: f.dev } as Author, source: undefined }
    // An older host, which reports no such capability: everything goes at once, as before.
    expect(gathersForInbox(f.state, pm, person)).toBe(false)
    f.state.machines = [{ machineId: pm.machineId, observation: { capabilities: [INBOX_CAPABILITY] } } as never]
    expect(gathersForInbox(f.state, pm, person)).toBe(false)
    expect(gathersForInbox(f.state, pm, need)).toBe(true)
    expect(gathersForInbox(f.state, pm, post)).toBe(false)
    // Never for an agent that is not the PM.
    expect(gathersForInbox(f.state, dev, person)).toBe(false)
  })
})
