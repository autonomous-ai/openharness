import { describe, expect, it } from 'vitest'
import { createMessagesLink } from './messagesLink.js'

describe('Agent Messages in its own process, as the core keeps it', () => {
  it('says a delivery may be written only while the process last said so, and not past when it said', () => {
    let clock = 1_000
    const link = createMessagesLink(() => clock)
    expect(link.port.canWrite('team:d1')).toBe(false)
    expect(link.answer('writable', { deliveries: { 'team:d1': 1_000 + 3_000, 'team:d2': 'soon' } })).toEqual({})
    expect(link.port.canWrite('team:d1')).toBe(true)
    expect(link.port.canWrite('team:d2')).toBe(false)
    clock += 3_000
    expect(link.port.canWrite('team:d1')).toBe(false)
    link.answer('writable', { deliveries: { 'team:d1': 99_999 } })
    expect(link.port.canWrite('team:d1')).toBe(true)
    // A report replaces the last whole.
    link.answer('writable', {})
    expect(link.port.canWrite('team:d1')).toBe(false)
  })

  it('answers no other question, and reads the real clock by default', () => {
    const link = createMessagesLink()
    expect(link.answer('agents', {})).toEqual({ error: 'UNKNOWN_QUERY' })
    link.answer('writable', { deliveries: { 'team:d1': Date.now() + 60_000 } })
    expect(link.port.canWrite('team:d1')).toBe(true)
  })
})
