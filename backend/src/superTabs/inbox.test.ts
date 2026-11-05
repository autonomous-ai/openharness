/**
 * The PM's inbox (task #3403, anh Dee's Swarm redesign, 11-05): its digest starts with what it owes people, oldest first, each
 * with where to answer it, before the notices.
 */
import { describe, expect, it } from 'vitest'
import type { Command } from './commands.js'
import { digestText } from './noticeDigest.js'
import { OWED_LINES_MAX, owedLines } from './inbox.js'
import { projectsOf } from './projects.js'
import { owner, stepsFixture } from './steps.test-support.js'
import { swarmUsernames } from './usernames.js'

const MINUTE = 60_000

function setup() {
  const f = stepsFixture()
  const ask = (text: string) => f.run({ type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [] } as Command, owner).result.messageId as string
  const project = () => projectsOf(f.state)[0]!
  return { f, ask, project }
}

describe('the owed asks at the top of the PM\'s inbox', () => {
  it('lists each ask oldest first, who asked, how long ago and where, with how to answer it', () => {
    const { f, ask, project } = setup()
    const first = ask('Is the release out?')
    f.tick(10 * MINUTE)
    const second = ask('And the hotfix?')
    f.tick(2 * MINUTE)
    const lines = owedLines(f.state, project(), f.now)
    expect(lines[0]).toBe('Owed asks (2, oldest 12m). Answer each once, in its place: harness super-tab answer GROUP MESSAGE_ID TEXT OPERATION_ID.')
    const name = swarmUsernames(f.state).get('owner')!
    expect(lines.slice(1)).toEqual([`- from ${name}, 12m ago (message ${first} in lead)`, `- from ${name}, 2m ago (message ${second} in lead)`])
    expect(lines.join('\n')).not.toContain('@example.com')
  })

  it('is empty when nothing is owed', () => {
    const { f, project } = setup()
    expect(owedLines(f.state, project(), f.now)).toEqual([])
  })

  it('names at most OWED_LINES_MAX asks and says how many more', () => {
    const { f, ask, project } = setup()
    for (let i = 0; i < OWED_LINES_MAX + 3; i++) ask(`Ask ${i}`)
    const lines = owedLines(f.state, project(), f.now)
    expect(lines).toHaveLength(OWED_LINES_MAX + 2)
    expect(lines.at(-1)).toBe('And 3 more owed: the board lists them all.')
  })

  it('comes before the notices in the digest', () => {
    const text = digestText(new Date('2026-11-05T15:00:00Z'), ['- #12: Done'], 0, false, ['Owed asks (1, oldest 3m). Answer…', '- from ken, 3m ago (message m in lead)'])
    expect(text.split('\n')).toEqual(['Owed asks (1, oldest 3m). Answer…', '- from ken, 3m ago (message m in lead)', '',
      'Notices since 15:00 UTC (1). Read one in full: harness super-tab message GROUP MESSAGE_ID.', '- #12: Done'])
  })
})
