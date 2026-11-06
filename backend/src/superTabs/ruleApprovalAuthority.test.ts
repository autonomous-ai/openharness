import { describe, expect, it } from 'vitest'
import { createSuperTab, type Author } from './model.js'
import { projectsOf } from './projects.js'
import { allowedDrops } from './ruleGuard.js'

// Task #3710: changing the guard to trust a name, a relayed message or an old approval must fail these tests.
const authority = { topDeciderId: 'dee', people: [{ name: 'Ken', accountIds: ['ken-a', 'ken-b'] }] }
const before = '# Rules\n\n- Always test before merging (Ken, 2026-11-04).'
const after = '# Rules\n'
const row = (id = 'yes', person = 'dee', extra = {}) => ({ id, author: { kind: 'person', id: person, name: person } as Author,
  source: false, createdAt: 900, conversationId: 'lead', ...extra })
function fixture() {
  const state = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
  const first = state.people[0]!
  state.people.push(...['dee', 'ken-a', 'ken-b', 'stranger'].map(id => ({ ...first, id, email: `${id}@example.com`, username: id, role: 'collaborator' as const })))
  const project = projectsOf(state)[0]!
  const check = (approvals = [row()], named = ['yes'], config: typeof authority | null = authority, sender = { kind: 'agent' as Author['kind'], id: 'pm' }, text = after) =>
    allowedDrops(state, project, before, text, sender, named, approvals, 500, {}, config)
  return { state, project, check }
}

describe('configured instruction approval authority', () => {
  it('accepts only the named decider’s own recent approval for another person’s removed or reworded rule', () => {
    const f = fixture()
    expect([...f.check().told.keys()]).toEqual(['dee'])
    expect(f.check([row()], ['yes'], authority, undefined, before.replace('before', 'after')).rules).toHaveLength(1)
    expect(() => f.check([], [])).toThrow(/dee/i)
    expect(() => f.check([row('yes', 'stranger')])).toThrow(/rules people gave/)
    expect(() => f.check([row()], ['yes'], null)).toThrow(/rules people gave/)
  })

  it.each(['ken-a', 'ken-b'])('accepts %s for the explicit Ken attribution and tells only the account that approved', id => {
    const f = fixture()
    expect([...f.check([row('yes', id)]).told.keys()]).toEqual([id])
    expect(f.check([], [], authority, { kind: 'person', id }).rules).toHaveLength(1)
  })

  it('never expands a similar display name into the explicit account group', () => {
    const f = fixture()
    f.state.people.find(p => p.id === 'stranger')!.name = 'Ken'
    expect(() => f.check([row('yes', 'stranger')])).toThrow(/rules people gave/)
    // An alias from a different project is not present here.
    expect(() => f.check([row('yes', 'ken-b')], ['yes'], null)).toThrow(/rules people gave/)
  })

  it.each([
    ['agent', row('yes', 'dee', { author: { kind: 'agent', id: 'dee', name: 'dee' } })],
    ['Buddy relay', row('yes', 'dee', { source: true })],
    ['old', row('yes', 'dee', { createdAt: 499 })],
    ['another project', row('yes', 'dee', { conversationId: 'elsewhere' })],
  ])('rejects a %s approval even when it carries the decider ID', (_name, approval) => {
    expect(() => fixture().check([approval])).toThrow(/rules people gave/)
  })

  it('rejects missing, unlisted and removed-member approvals', () => {
    const f = fixture()
    expect(() => f.check([], ['yes'])).toThrow(/rules people gave/)
    expect(() => f.check([row()], [])).toThrow(/rules people gave/)
    f.state.people = f.state.people.filter(p => p.id !== 'dee')
    expect(() => f.check()).toThrow(/rules people gave/)
    f.state.people = f.state.people.filter(p => p.id !== 'ken-b')
    expect(() => f.check([row('yes', 'ken-b')])).toThrow(/rules people gave/)
  })
})
