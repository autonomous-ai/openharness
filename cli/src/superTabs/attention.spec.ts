import { describe, expect, it } from 'vitest'
import { attentionOf, attentionRequestId } from './attention.js'

const row = (over: Record<string, unknown> = {}, attention: Record<string, unknown> | null = { assignmentId: 'as-1', status: 'needs_human', result: 'Ship to everyone, or behind a flag?' }) =>
  ({ tabId: 'tab', tabName: 'Pilot', paused: false, attention, agent: { id: 'agent', harnessId: 'h1', machineId: 'm1' }, ...over })
const live = () => true

describe('the Super Tab members here that wait on a person', () => {
  it('reads a decision and a stuck agent off the host roster', () => {
    expect(attentionOf([row()], 'm1', live)).toEqual([{ agentId: 'h1', requestId: 'supertab:as-1:needs_human', superTab: 'Pilot',
      attention: 'decision', text: 'Ship to everyone, or behind a flag?' }])
    const stuck = row({ agent: { id: 'b', harnessId: 'h2', machineId: 'm1' } }, { assignmentId: 'as-2', status: 'blocked', result: '  No access to staging.  ' })
    expect(attentionOf([stuck], 'm1', live)).toEqual([{ agentId: 'h2', requestId: 'supertab:as-2:blocked', superTab: 'Pilot',
      attention: 'stuck', text: 'Stuck: No access to staging.' }])
  })

  it('says something even when the agent gave no reason, and names an unnamed tab', () => {
    expect(attentionOf([row({ tabName: ' ' }, { assignmentId: 'as-1', status: 'needs_human', result: null })], 'm1', live)[0])
      .toMatchObject({ superTab: 'Super Tab', text: 'Needs your decision' })
    expect(attentionOf([row({ tabName: 7 }, { assignmentId: 'as-1', status: 'blocked' })], 'm1', live)[0])
      .toMatchObject({ superTab: 'Super Tab', text: 'Stuck: needs help to go on' })
  })

  it('cuts a long name on a character and a long reason', () => {
    const [item] = attentionOf([row({ tabName: `${'a'.repeat(47)}é and more` }, { assignmentId: 'as-1', status: 'needs_human', result: 'x'.repeat(400) })], 'm1', live)
    expect(item.superTab).toBe('a'.repeat(47))
    expect(item.text).toHaveLength(300)
  })

  it('raises nothing for a paused tab, another machine, an agent not live here, another status or a malformed row', () => {
    const rows = [row({ paused: true }), row({ agent: { id: 'agent', harnessId: 'h1', machineId: 'm2' } }), row({ tabId: 'bad id' }),
      row({}, null), row({}, { assignmentId: 'as-1', status: 'working' }), row({}, { assignmentId: 'bad id', status: 'blocked' }), null, 'x']
    expect(attentionOf(rows, 'm1', live)).toEqual([])
    expect(attentionOf([row()], 'm1', () => false)).toEqual([])
  })

  it('keeps the first wait for an agent in two rows', () => {
    const second = row({ tabId: 'other' }, { assignmentId: 'as-9', status: 'blocked', result: 'x' })
    expect(attentionOf([row(), second], 'm1', live).map(i => i.requestId)).toEqual(['supertab:as-1:needs_human'])
  })

  it('makes one short id per assignment and status, which a Pro can close', () => {
    expect(attentionRequestId('as-1', 'blocked')).toBe('supertab:as-1:blocked')
    const long = attentionRequestId('x'.repeat(160), 'needs_human')
    expect(long).toMatch(/^supertab:[0-9a-f]{32}:needs_human$/)
    expect(Buffer.byteLength(long)).toBeLessThan(64)
    expect(attentionRequestId('x'.repeat(160), 'needs_human')).toBe(long)
  })
})
