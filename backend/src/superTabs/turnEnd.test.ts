import { describe, expect, it } from 'vitest'
import { agent, type MessageDraft } from './model.js'
import { stepsFixture } from './steps.test-support.js'
import { waitsForTurnEnd } from './turnEnd.js'

/** A post's author and source, as the delivery write reads them. */
const by = (kind: 'agent' | 'person', id: string, source?: MessageDraft['source']) =>
  ({ author: { kind, id, name: id, membershipGeneration: 'g' }, source }) as Pick<MessageDraft, 'author' | 'source'>

describe('what waits for its recipient\'s turn to end', () => {
  // Nothing is typed into a busy agent (task #3403). Since the PM's inbox went (Swarm v4), a crew member's post to the PM
  // waits for the PM's turn to end as it does for anyone else's.
  it('a crew member\'s post, to the PM as to another agent', () => {
    const f = stepsFixture()
    const other = f.add('other', f.task)
    expect(waitsForTurnEnd(f.state, agent(f.state, f.lead), by('agent', f.dev))).toBe(true)
    expect(waitsForTurnEnd(f.state, agent(f.state, other), by('agent', f.dev))).toBe(true)
  })

  it('never a person\'s message, the PM\'s own post, a system row or an agent\'s post to itself', () => {
    const f = stepsFixture()
    const pm = agent(f.state, f.lead), dev = agent(f.state, f.dev)
    expect(waitsForTurnEnd(f.state, pm, by('person', 'owner'))).toBe(false)
    expect(waitsForTurnEnd(f.state, dev, by('agent', f.lead))).toBe(false)
    expect(waitsForTurnEnd(f.state, pm, by('agent', f.dev, { kind: 'system' }))).toBe(false)
    expect(waitsForTurnEnd(f.state, dev, by('agent', f.dev))).toBe(false)
  })
})
