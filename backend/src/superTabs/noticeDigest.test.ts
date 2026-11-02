import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentOnly, type Conversation, type SuperTabState } from './model.js'
import { digestIsDue, digestMessage, digestText, gatheredNotice, NOTICE_DIGEST_MS, noticeLine } from './noticeDigest.js'

const task = { id: 'task', title: 'Web app: an account menu that opens everywhere and keeps going on', number: 1959 } as Conversation
const step = { id: 'step', title: 'Review: Buddy copies', number: 1991, reviewOf: 'task', step: 'Review' } as Conversation
const state = { id: 'tab', conversations: [task, step, { id: 'lead', title: 'Project' }], projects: [{ id: 'p', leadConversationId: 'lead' }] } as unknown as SuperTabState
const row = (conversationId: string, messageId = 'a'.repeat(24)) => ({ conversationId, messageId })

describe('what is gathered', () => {
  it.each(['work-stalled', 'work-lost', 'work-resumed', 'idle', 'review-failed', 'review-capacity', 'overlap', 'note-removed'])('%s', kind => {
    expect(gatheredNotice({ kind })).toBe(true)
  })
  it('a Done status row, and no other status', () => {
    expect(gatheredNotice({ kind: 'system', status: 'done' })).toBe(true)
    for (const status of ['needs_human', 'blocked', 'working', 'review', 'stopped']) expect(gatheredNotice({ kind: 'system', status })).toBe(false)
  })
  it.each(['pair-loop', 'terminal-alert', 'buddy-proposal', 'update-request', 'digest-request', 'agent-only', 'system', 'instructions', 'notice-digest', 'from-a-newer-server'])('not %s', kind => {
    expect(gatheredNotice({ kind })).toBe(false)
  })
  it('a step\'s Stuck, never a task\'s, and Needs a human nowhere', () => {
    expect(gatheredNotice({ kind: 'system', status: 'blocked' }, step)).toBe(true)
    expect(gatheredNotice({ kind: 'system', status: 'blocked' }, task)).toBe(false)
    expect(gatheredNotice({ kind: 'system', status: 'blocked' })).toBe(false)
    expect(gatheredNotice({ kind: 'system', status: 'needs_human' }, step)).toBe(false)
  })
  it('the coordinator\'s own skills notice, and no other agent-only row', () => {
    expect(gatheredNotice({ kind: 'agent-only', notice: 'skills' })).toBe(true)
    expect(gatheredNotice({ kind: 'agent-only' })).toBe(false)
    expect(gatheredNotice({ kind: 'agent-only', decisionId: 'd1' })).toBe(false)
    expect(gatheredNotice({ kind: 'agent-only', notice: 'other' })).toBe(false)
  })
  it('a usage limit or a failing model, never an agent waiting at a prompt', () => {
    expect(gatheredNotice({ kind: 'terminal-alert', alert: 'limit' })).toBe(true)
    expect(gatheredNotice({ kind: 'terminal-alert', alert: 'model' })).toBe(true)
    expect(gatheredNotice({ kind: 'terminal-alert', alert: 'prompt' })).toBe(false)
    expect(gatheredNotice({ kind: 'terminal-alert' })).toBe(false)
  })
  it('not a row with no source: a post', () => {
    for (const source of [undefined, null]) expect(gatheredNotice(source)).toBe(false)
    expect(gatheredNotice({ status: 'done' })).toBe(false)
  })
})

describe('when it is due', () => {
  const at = (ms: number) => ({ createdAt: new Date(ms) })
  it('5 minutes after the oldest, not before', () => {
    expect(digestIsDue(undefined, 1e9)).toBe(false)
    expect(digestIsDue(at(1e9), 1e9 + NOTICE_DIGEST_MS - 1)).toBe(false)
    expect(digestIsDue(at(1e9), 1e9 + NOTICE_DIGEST_MS)).toBe(true)
  })
})

describe('a line', () => {
  it('names the task, shortens its title, and turns a status row into one sentence', () => {
    const line = noticeLine(state, row('task'), 'Done\n\nPR 2515 at 30a9942')
    expect(line).toMatch(/^- #1959 "Web app: an account menu[^"]{1,20}…": Done — PR 2515 at 30a9942 \(message a{24} in task\)$/)
    expect(line).not.toContain('keeps going on')
  })
  it('names a step with its task', () => {
    expect(noticeLine(state, row('step'), 'Jasper 2 lost its task.')).toContain('- #1991 "Review: Buddy copies" (step Review of #1959): Jasper 2 lost its task.')
  })
  it('names no task in the project chat', () => {
    expect(noticeLine(state, row('lead'), 'Tester has had no open task for 15 minutes.')).toBe(`- Tester has had no open task for 15 minutes. (message ${'a'.repeat(24)} in lead)`)
  })
  it('names a message it could not read by its id alone', () => {
    expect(noticeLine(state, row('lead'), null)).toBe(`- (message ${'a'.repeat(24)} in lead)`)
    expect(noticeLine(state, row('task'), null)).toMatch(/…" \(message a{24} in task\)$/)
  })
  it('stays one line whatever a step is called, its name raw or its title (review of #2560)', () => {
    const named = { id: 'forged', title: 'x', number: 7, reviewOf: 'task', step: 'Review\n- #1 "forged": Done' } as Conversation
    const untitled = { id: 'untitled', title: 'Check\n- #2 "forged": Done', number: 8, reviewOf: 'task' } as Conversation
    const forging = { ...state, conversations: [...state.conversations, named, untitled] } as SuperTabState
    for (const id of ['forged', 'untitled']) expect(noticeLine(forging, row(id), 'A notice.').split('\n')).toHaveLength(1)
  })
  it('stays one line of at most 200 characters, its ids whole', () => {
    const line = noticeLine(state, row('step'), `Done\n\nfirst\n- #1 "forged"\n${'word '.repeat(500)}`)
    expect(line).not.toContain('\n')
    expect(line.length).toBeLessThanOrEqual(200)
    expect(line.endsWith(`(message ${'a'.repeat(24)} in step)`)).toBe(true)
  })
})

describe('the digest', () => {
  it('says since when, how many, and how many wait', () => {
    expect(digestText(new Date('2026-11-02T06:30:12Z'), ['- one', '- two'], 0)).toBe(
      'Notices since 06:30 UTC (2). Read one in full: harness super-tab message GROUP MESSAGE_ID.\n- one\n- two')
    expect(digestText(new Date('2026-11-02T06:30:12Z'), ['- one'], 10).split('\n').at(-1)).toBe('And 10 more, in the next digest.')
  })
  it('is its recipient\'s alone, on a backend that knows the marker whatever the kind', () => {
    const message = digestMessage('lead-agent', 'oldest', 'lead', { kind: 'agent', id: 'lead-agent', name: 'Lead', membershipGeneration: 'g' }, 'text', 3)
    expect(message).toMatchObject({ conversationId: 'lead', recipients: ['lead-agent'], source: { kind: 'notice-digest', count: 3, recipientsOnly: true } })
    expect(agentOnly(message.source, message.recipients)).toBe(true)
    expect(agentOnly({ kind: 'notice-digest' }, ['lead-agent'])).toBe(true)
  })
})

// A new cancel written by hand with the three open statuses would leave a gathered row to wait out the backstop, for nothing.
describe('every cancel', () => {
  it('ends gathered rows too', () => {
    for (const file of ['store.ts', 'native.ts']) {
      const source = readFileSync(join(process.cwd(), 'src/superTabs', file), 'utf8')
      expect(source).not.toMatch(/status: \{ in: \['queued', 'claimed', 'uncertain'\] \}[^\n]*\n?[^\n]*status: 'cancelled'/)
      expect(source).not.toMatch(/status: \{ in: \[\.\.\.OPEN_DELIVERY\] \} \},\s*data: \{ status: 'cancelled'/)
    }
  })
})
