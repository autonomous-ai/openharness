import assert from 'node:assert/strict'
import { test } from 'node:test'
import { footer, glyph, painter, planLines, receiptLine, table } from '../lib/format.mjs'
import { normalizePolicy, decide } from '../lib/policy.mjs'
import { summarize } from '../lib/inventory.mjs'
import { DAY, HOUR, row } from './fixtures.mjs'

const rows = [
  row({ id: 'a', name: 'widgets', title: 'Fix the reconciler', idleMs: 2 * 60_000, working: true }),
  row({ id: 'b', name: 'gadgets', title: 'Ship the thing', idleMs: 2 * DAY, rssBytes: 1.4 * 1024 ** 3 }),
  row({ id: 'c', name: 'old', state: 'paused', idleMs: 20 * DAY, rssBytes: 0, machine: 'studio', local: false }),
]

test('without a terminal listening there are no escape codes anywhere', () => {
  const text = [table(rows), footer(summarize(rows), normalizePolicy({})), receiptLine({ ok: true, action: 'pause', name: 'x', detail: 'done' })].join('\n')
  assert.equal(/\u001b\[/.test(text), false)
})

test('with a terminal listening, colour is added and the columns still line up', () => {
  const plain = table(rows, { tty: false, columns: 140 }).split('\n')
  const painted = table(rows, { tty: true, columns: 140 }).split('\n')
  assert.ok(/\u001b\[/.test(painted.join('')))
  for (let i = 0; i < plain.length; i += 1) {
    assert.equal(painted[i].replace(/\u001b\[[0-9;]*m/g, ''), plain[i], `row ${i} shifted when painted`)
  }
})

test('a narrow pane keeps state, idle, engine and memory and drops the rest', () => {
  const narrow = table(rows, { columns: 60 })
  assert.equal(narrow.includes('PROJECT'), false)
  assert.equal(narrow.includes('MODEL'), false)
  assert.match(narrow, /IDLE/)
  assert.match(narrow, /MEM/)
  assert.match(narrow, /Fix the reconciler/)
})

test('a machine column appears only when there is more than one machine', () => {
  assert.match(table(rows, { columns: 140 }), /MACHINE/)
  assert.equal(table(rows.slice(0, 2), { columns: 140 }).includes('MACHINE'), false)
})

test('every state has its own glyph, and waiting beats all of them', () => {
  const c = painter({})
  const seen = new Set(['running', 'paused', 'terminal', 'gone'].map((state) => glyph(row({ state }), c).trim()))
  assert.equal(seen.size, 4)
  assert.equal(glyph(row({ state: 'running', working: true }), c).trim(), '◐')
  assert.equal(glyph(row({ state: 'running', needsInput: true }), c).trim(), '!')
})

test('the footer says what the fleet is and what the policy is', () => {
  const line = footer(summarize(rows), normalizePolicy({ pauseAfterIdle: '8h' }), { problems: [{ machine: 'studio', error: 'asleep' }] })
  assert.match(line, /3 harnesses/)
  assert.match(line, /2 running/)
  assert.match(line, /1 paused/)
  assert.match(line, /pause after 8h/)
  assert.match(line, /studio: asleep/)
})

test('a plan reads as one line per row, with nothing to do said plainly', () => {
  const plan = decide(rows, { runningCeiling: 12 })
  const lines = planLines(plan.entries)
  assert.match(lines, /pause\s+gadgets/)
  assert.equal(lines.includes('widgets'), false)
  assert.match(planLines(decide([rows[0]], {}).entries), /Nothing to do/)
})

test('a receipt shows what happened, including what was refused', () => {
  assert.match(receiptLine({ ok: true, action: 'pause', name: 'x', detail: 'engine stopped', freed: 4e8 }), /✓ pause x \(\+381 MB\)/)
  assert.match(receiptLine({ ok: false, refused: true, action: 'pause', name: 'y', detail: 'pinned' }), /· pause y/)
  assert.match(receiptLine({ ok: true, already: true, action: 'pause', name: 'z', detail: 'already paused' }), /= pause z/)
})
