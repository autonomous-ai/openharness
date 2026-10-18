import { describe, expect, it } from 'vitest'
import { formatNext } from './next.js'

describe('Next', () => {
  it('says one step on one line, with when to take it', () => {
    expect(formatNext([{ run: 'harness wait <name>', when: 'until it has answered' }])).toBe('Next: harness wait <name>  (until it has answered)')
  })
  it('gives the other steps as "or"', () => {
    expect(formatNext([{ run: 'harness show <name>', when: 'to read its answer' }, { run: 'harness wait <name>', when: 'until it stops working' }]))
      .toBe('Next: harness show <name>  (to read its answer)\n  or: harness wait <name>  (until it stops working)')
  })
  it('says a step that is not a command as it is', () => {
    expect(formatNext([{ tell: 'tell the person; only they answer it (a question or a permission).' }]))
      .toBe('Next: tell the person; only they answer it (a question or a permission).')
  })
  it('says nothing when there is nothing next', () => {
    expect(formatNext([])).toBeNull()
  })
})
