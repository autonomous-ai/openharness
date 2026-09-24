import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { keepTrialColumn } from '../viewer/kept-column.mjs'
import { normalizeSheet, parseHeader } from '../viewer/grammar.mjs'
import { trialHash } from '../viewer/question-lab.mjs'
import { loadSource } from '../viewer/source.mjs'

function fixture(t, overrides = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'jev-kept-question-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const file = join(workspace, 'sheet.json')
  const raw = { title: 'Fictional support', context: 'Support tickets', demo: false, columns: ['Urgent?'], rows: [{ id: 'r1', text: 'Please help now', channel: 'email' }], custom: { keep: 'this note' }, ...overrides }
  if (raw.source) writeFileSync(join(workspace, raw.source), 'message,channel\nPlease help now,email\n')
  writeFileSync(file, JSON.stringify(raw))
  const source = raw.source ? loadSource(workspace, raw.source) : null
  const sheet = normalizeSheet(source ? { ...raw, rows: source.rows } : raw)
  const rows = sheet.rows.map((r, i) => ({ id: r.id, n: i + 1, text: r.text, meta: r.meta }))
  const original = { ...sheet.columns[0], source: 'file' }
  const trial = { id: '7bd60d19-b1aa-4fe1-abd0-742889aa2df2', original, candidate: parseHeader('Urgent: low < high').column,
    datasetSha: trialHash({ context: sheet.context, source: source?.info.name || null, rows }) }
  return { workspace, file, raw, trial, columns: [original], read: () => JSON.parse(readFileSync(file)) }
}

test('adoption preserves unrelated edits and data, disambiguates the original and is idempotent', (t) => {
  const v = fixture(t)
  const edited = { ...v.raw, title: 'Agent updated title', suggestions: ['Refund?'] }
  writeFileSync(v.file, JSON.stringify(edited))
  const result = keepTrialColumn(v.workspace, v.trial, v.columns)
  assert.equal(result.id, 'urgent_v2')
  const saved = v.read()
  assert.deepEqual({ ...saved, columns: saved.columns.slice(0, 1) }, edited)
  assert.equal(saved.columns[1].questionTrial, v.trial.id)
  const bytes = readFileSync(v.file, 'utf8')
  assert.equal(keepTrialColumn(v.workspace, v.trial, v.columns).alreadyApplied, true)
  assert.equal(readFileSync(v.file, 'utf8'), bytes)
  assert.deepEqual(readdirSync(v.workspace), ['sheet.json'])
})

for (const change of ['rows', 'context', 'original', 'invalid']) test(`an unobserved ${change} edit cannot be overwritten by adoption`, (t) => {
  const v = fixture(t)
  const raw = v.raw
  if (change === 'rows') raw.rows[0].text = 'Different message'
  if (change === 'context') raw.context = 'Different purpose'
  if (change === 'original') raw.columns[0] = { id: 'urgent', header: 'Refund?' }
  const bytes = change === 'invalid' ? '{unfinished' : JSON.stringify(raw)
  writeFileSync(v.file, bytes)
  assert.throws(() => keepTrialColumn(v.workspace, v.trial, v.columns))
  assert.equal(readFileSync(v.file, 'utf8'), bytes)
  assert.deepEqual(readdirSync(v.workspace), ['sheet.json'])
})

test('a changed imported file is detected before its watcher notification', (t) => {
  const v = fixture(t, { source: 'tickets.csv', rows: [] })
  writeFileSync(join(v.workspace, 'tickets.csv'), 'message,channel\nNew message,email\n')
  const bytes = readFileSync(v.file, 'utf8')
  assert.throws(() => keepTrialColumn(v.workspace, v.trial, v.columns), /rows or context changed/)
  assert.equal(readFileSync(v.file, 'utf8'), bytes)
})

test('a question edited after adoption is not silently replaced or duplicated', (t) => {
  const v = fixture(t)
  keepTrialColumn(v.workspace, v.trial, v.columns)
  const saved = v.read()
  saved.columns[1].header = 'Needs a refund?'
  writeFileSync(v.file, JSON.stringify(saved))
  assert.throws(() => keepTrialColumn(v.workspace, v.trial, v.columns), /saved question was edited/)
  assert.deepEqual(v.read(), saved)
})

test('full projects and linked sheet files are unchanged on failure', (t) => {
  const v = fixture(t)
  const full = { ...v.raw, columns: ['Urgent?', ...Array.from({ length: 11 }, (_, i) => `Question ${i}?`)] }
  writeFileSync(v.file, JSON.stringify(full))
  assert.throws(() => keepTrialColumn(v.workspace, v.trial, v.columns), /12 columns/)
  assert.deepEqual(v.read(), full)
  const target = join(v.workspace, 'original.json')
  writeFileSync(target, JSON.stringify(v.raw))
  rmSync(v.file)
  symlinkSync(target, v.file)
  assert.throws(() => keepTrialColumn(v.workspace, v.trial, v.columns), /regular sheet.json/)
  assert.deepEqual(JSON.parse(readFileSync(target)), v.raw)
})
