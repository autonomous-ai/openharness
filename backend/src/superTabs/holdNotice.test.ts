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

  it('names the machine and its owner only for a question on screen, and only what is known', () => {
    const host = { machine: 'MacBookPro2021', owner: 'Huy' }
    expect(holdNoticeText('Release builder', 'team_waiting_user', host))
      .toContain('Release builder is on MacBookPro2021. Only Huy (owner of that machine) can answer it. It stays queued')
    expect(holdNoticeText('Release builder', 'team_waiting_user', { machine: null, owner: 'Huy' }))
      .toContain('waiting. Release builder is showing a question or menu that needs a person to answer it. Only Huy (owner of the machine it runs on) can answer it.')
    expect(holdNoticeText('Release builder', 'team_waiting_user', { machine: null, owner: null })).not.toContain('owner')
    expect(holdNoticeText('Release builder', 'team_waiting_user')).not.toContain(' on ')
    expect(holdNoticeText('Release builder', 'team_waiting_draft', host)).not.toContain('Huy')
  })

  it('rejects a reason it has no words for', () => {
    expect(holdReason.safeParse('team_waiting_busy').success).toBe(false)
  })
})
