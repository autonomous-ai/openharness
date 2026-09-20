// toolchain/count.mjs: the one tested reader of answers.csv that findings rest on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const COUNT = join(dirname(fileURLToPath(import.meta.url)), '../toolchain/count.mjs')

// A header with a comma and a quote in it, and a review with a comma, a quote and a line break:
// the things a hand-written parser gets wrong.
const ANSWERS = [
  'row,review,id_,stars,Topic,Topic confidence,"Says they will cancel, or switch",' + '"Says they will cancel, or switch confidence"',
  '1,"Too expensive, ""way"" too expensive",a1,1,price,0.97,yes,0.91',
  '2,It crashes on launch,a2,2,crash,0.99,no,0.88',
  '3,"Crashes when I paste\nan image",a3,1,crash,0.58,yes,0.52',
  '4,Best notes app,a4,5,praise,0.95,no,0.97',
  '5,The price doubled,a5,2,price,0.93,yes,0.61',
  '6,Still waiting for an answer,a6,3,,,,',
].join('\n') + '\n'

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'jev-sheets-count-'))
  writeFileSync(join(ws, 'answers.csv'), ANSWERS)
  writeFileSync(join(ws, 'sheet.json'), JSON.stringify({ source: 'x.csv', columns: [{ id: 'topic', header: 'Topic: price = cost | crash = crashes | praise = happy' }, { id: 'leaving', header: 'Says they will cancel, or switch?' }] }))
  mkdirSync(join(ws, '.harness'))
  writeFileSync(join(ws, '.harness/verdict.json'), JSON.stringify({ sheet: { reviewBelow: 0.65 } }))
  return ws
}
const run = (ws, ...args) => spawnSync('node', [COUNT, ...args], { encoding: 'utf8', env: { ...process.env, HARNESS_WORKSPACE: ws } })
const json = (ws, ...args) => { const r = run(ws, ...args, '--json'); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout) }

test('every question: counts, shares and unsure cells, with an unanswered row left out', () => {
  const ws = workspace()
  const out = json(ws)
  assert.equal(out.rows, 6)
  assert.deepEqual(out.questions.Topic, { id: 'topic', answered: 5, unsure: 1, averageConfidence: 0.884, counts: { price: 2, crash: 2, praise: 1 } })
  const leaving = out.questions['Says they will cancel, or switch']
  assert.equal(leaving.id, 'leaving')
  assert.deepEqual(leaving.counts, { yes: 3, no: 2 })
  assert.equal(leaving.unsure, 2)
  const text = run(ws).stdout
  assert.match(text, /Topic\s+\[topic\]\s+·\s+5 of 6 rows answered\s+·\s+1 under 0\.65 \(20\.0%\)/)
  assert.match(text, /price\s+2\s+40\.0%/)
})

test('a cross-cut, by id, by name or by the start of either, and over the file\'s own columns', () => {
  const ws = workspace()
  const cross = json(ws, '--by', 'topic', '--and', 'leaving').cross
  assert.deepEqual(cross.values, ['yes', 'no', '(no answer yet)'])
  assert.deepEqual(cross.table.find((r) => r[0] === 'price'), ['price', 2, '2 (100.0%)', '0 (0.0%)', '0 (0.0%)'])
  assert.deepEqual(cross.table.find((r) => r[0] === 'crash'), ['crash', 2, '1 (50.0%)', '1 (50.0%)', '0 (0.0%)'])
  assert.deepEqual(json(ws, '--by', 'Top').counts, { Topic: { price: 2, crash: 2, praise: 1, '(no answer yet)': 1 } })
  assert.deepEqual(json(ws, '--where', 'stars<=2', '--by', 'says').counts, { 'Says they will cancel, or switch': { yes: 3, no: 1 } })
})

test('the rows behind a number, a word search, and the least sure rows', () => {
  const ws = workspace()
  const behind = json(ws, '--where', 'topic=crash', '--where', 'leaving=yes', '--rows', '5')
  assert.equal(behind.matched, 1)
  assert.deepEqual(behind.sample.map((r) => [r.row, r.text]), [[3, 'Crashes when I paste\nan image']])
  const found = json(ws, '--find', 'EXPENSIVE')
  assert.equal(found.matched, 1)
  const unsure = json(ws, '--unsure', 'leaving', '--rows', '5').unsure
  assert.deepEqual(unsure.map((r) => [r.row, r.answer, r.confidence]), [[3, 'yes', 0.52], [5, 'yes', 0.61]])
  assert.equal(json(ws, '--unsure', 'leaving', '--below', '0.55').unsure.length, 1)
})

test('it says plainly what is wrong', () => {
  const ws = workspace()
  assert.match(run(ws, '--by', 'nothing').stderr, /no column called "nothing"\. Questions: topic = "Topic", leaving = /)
  assert.match(run(ws, '--where', 'topic').stderr, /--where wants column=value/)
  assert.match(run(mkdtempSync(join(tmpdir(), 'jev-sheets-count-'))).stderr, /answers\.csv is not there yet/)
})
