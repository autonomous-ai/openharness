import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFY, NOTIFY_LEVELS } from './chatSettings.js'

describe('a chat\'s notification default (task #3607, Tony 2026-11-06)', () => {
  it('is Mentions only; All new messages only when the person turns it on', () => {
    expect(DEFAULT_NOTIFY).toBe('mentions')
    expect(NOTIFY_LEVELS).toEqual(['all', 'mentions', 'muted'])
    expect(NOTIFY_LEVELS.filter(level => level === DEFAULT_NOTIFY)).toEqual(['mentions'])
  })
})
