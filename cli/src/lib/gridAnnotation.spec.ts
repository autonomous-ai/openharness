import { describe, expect, it } from 'vitest'
import { annotate, glanceFor, idKey, type GridGlance } from './gridAnnotation.js'

const RELAY = 'https://fixture.invalid/g/net-own/relay/v1'
const glance = (over: Partial<GridGlance> = {}): GridGlance => ({
  id: 'net-own', view: { state: 'awake', models: [{ id: 'Small-Q4' }, { id: 'Big', unavailable: { machine: 'Studio' } }] }, listed: true, asleep: false, ...over,
})

describe('what an agent\'s frame says of its grid, read off a glance', () => {
  it('finds the grid an agent\'s inference goes to by its id in the relay\'s path, and none for an address it cannot read', () => {
    const own = glance()
    expect(glanceFor([glance({ id: 'other' }), own], RELAY)).toBe(own)
    expect(glanceFor([own], 'https://fixture.invalid/g/elsewhere/relay/v1')).toBeNull()
    expect(glanceFor([own], 'not a url')).toBeNull()
  })

  it('says the grid\'s state, and a note when the agent\'s model will not answer', () => {
    expect(annotate(glance(), { baseUrl: RELAY, model: ' small-q4 ' })).toEqual({ state: 'awake' })
    expect(annotate(glance(), { baseUrl: RELAY, model: 'big' })).toEqual({ state: 'awake', note: { reason: 'offline', model: 'Big', machine: 'Studio' } })
    expect(annotate(glance(), { baseUrl: RELAY, model: 'Gone' })).toEqual({ state: 'awake', note: { reason: 'not_served', model: 'Gone' } })
  })

  it('says nothing of a model a grid never listed, of an agent on the grid\'s default, or of a grid waking', () => {
    expect(annotate(glance({ listed: false }), { baseUrl: RELAY, model: 'Gone' })).toEqual({ state: 'awake' })
    expect(annotate(glance(), { baseUrl: RELAY, model: null })).toEqual({ state: 'awake' })
    expect(annotate(glance({ view: { state: 'waking', models: [] } }), { baseUrl: RELAY, model: 'Gone' })).toEqual({ state: 'waking' })
  })

  it('says nothing at all of a grid no picker was shown, or one not tracked', () => {
    expect(annotate(glance({ view: null }), { baseUrl: RELAY, model: 'Small-Q4' })).toBeNull()
    expect(annotate(null, { baseUrl: RELAY, model: 'Small-Q4' })).toBeNull()
  })

  it('joins ids without case or the spaces around them', () => {
    expect(idKey('  Qwen3-Coder  ')).toBe('qwen3-coder')
  })
})
