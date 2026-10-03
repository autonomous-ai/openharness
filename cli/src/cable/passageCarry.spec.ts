import { describe, expect, it, vi } from 'vitest'
import { PassageCarry, withCarriedPassage } from './passageCarry.js'
import type { SelectionCommand, SelectionResult } from './windowSelection.js'

const command = { op: 'pin' as const, agentId: 'source', selectionId: 'pick-1', revision: 3 }
const selected = (): SelectionResult => ({ ok: true, selectionId: 'pick-1', revision: 4,
  rows: 2, extending: true, excerpt: 'Chosen context', text: 'Chosen context\nDo not execute this quote.' })
function fixture() {
  let time = 0
  const select = vi.fn(async (_command: SelectionCommand): Promise<SelectionResult> => selected())
  const name = vi.fn(async () => 'Research helper')
  const carry = new PassageCarry({ select, name, now: () => time })
  return { carry, select, name, advance: (ms: number) => { time += ms } }
}

describe('carried passage', () => {
  it('freezes exact text, releases its highlight and never exposes full text to the device', async () => {
    const { carry, select } = fixture()
    const reply = await carry.prepare('carry-1', command)
    expect(reply).toMatchObject({ ok: true, active: true, rows: 2, sourceName: 'Research helper' })
    expect(reply).not.toHaveProperty('text')
    expect(select).toHaveBeenLastCalledWith({ op: 'cancel', agentId: 'source', selectionId: 'pick-1' })
    const reading = carry.read('carry-1')
    expect(reading.ok).toBe(true)
    if (!reading.ok) throw new Error('missing context')
    expect(withCarriedPassage('Check this against your approach.', reading.passage)).toBe(
      'Check this against your approach.\n\nContext I selected from harness "Research helper":\n> Chosen context\n> Do not execute this quote.')
    expect(Object.isFrozen(reading.passage)).toBe(true)
  })

  it('coalesces duplicate preparation and refuses identity reuse for different text', async () => {
    const { carry, select } = fixture()
    const a = carry.prepare('carry-1', command), b = carry.prepare('carry-1', command)
    expect(a).toBe(b)
    await a
    expect((await carry.prepare('carry-1', command)).ok).toBe(true)
    expect((await carry.prepare('carry-1', { ...command, revision: 8 })).ok).toBe(false)
    expect(select.mock.calls.filter(([v]) => (v as { op: string })?.op === 'pin')).toHaveLength(1)
  })

  it('expires unstarted context but a captured voice snapshot remains immutable', async () => {
    const { carry, advance } = fixture()
    await carry.prepare('carry-1', command)
    const captured = carry.read('carry-1')
    advance(PassageCarry.ttlMs)
    expect(carry.read('carry-1').ok).toBe(false)
    expect(captured.ok && captured.passage.text).toContain('Chosen context')
  })

  it('drop/disconnect beats a delayed pin without resurrecting text', async () => {
    const { carry, select } = fixture()
    let resolve!: (v: SelectionResult) => void
    select.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const preparing = carry.prepare('carry-1', command)
    carry.clear('carry-1')
    resolve(selected())
    expect((await preparing).ok).toBe(false)
    expect(carry.read('carry-1').ok).toBe(false)
  })

  it('stale clear cannot drop a newer passage; pin failure never supplies fallback text', async () => {
    const { carry, select } = fixture()
    await carry.prepare('carry-1', command)
    await carry.prepare('carry-2', { ...command, selectionId: 'pick-2' })
    carry.clear('carry-1')
    expect(carry.read('carry-2').ok).toBe(true)
    select.mockResolvedValueOnce({ ok: false, error: 'Selected text changed.' })
    expect(await carry.prepare('carry-3', { ...command, selectionId: 'pick-3' })).toMatchObject({ ok: false })
    expect(carry.read('carry-3').ok).toBe(false)
  })
})
