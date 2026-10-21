import { describe, expect, it } from 'vitest'
import { holdNoticeText, holdReason } from './holdNotice.js'

describe('holdNoticeText', () => {
  it('says in plain words why a delivery waits, for every reason a host can report', () => {
    const lines = holdReason.options.map(reason => holdNoticeText('Lead', reason))
    expect(new Set(lines).size).toBe(holdReason.options.length)
    for (const line of lines) {
      expect(line).toMatch(/^A message for Lead is waiting\. .*It stays queued and goes in by itself as soon as that clears\.$/)
      expect(line).not.toMatch(/team_waiting|_/)
    }
    expect(holdNoticeText('Lead', 'team_waiting_draft')).toContain("There is unsent text in Lead's input box.")
  })

  it('rejects a reason it has no words for', () => {
    expect(holdReason.safeParse('team_waiting_busy').success).toBe(false)
  })
})
