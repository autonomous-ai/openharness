// The front door: a person brings their own file to the pane, asks, filters, and takes the answers away.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startSheetsViewer } from '../viewer/viewer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(join(HERE, '../template/sheet.json'), 'utf8')

async function fresh() {
  const ws = mkdtempSync(join(tmpdir(), 'jev-sheets-own-'))
  writeFileSync(join(ws, 'sheet.json'), TEMPLATE)
  const viewer = await startSheetsViewer({ workspace: ws, port: 0, autostart: false })
  const state = async () => (await fetch(`${viewer.url}/state`)).json()
  const ctl = async (cmd, body = {}) => (await fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...body }) })).json()
  const upload = async (name, body, headers = {}) => fetch(`${viewer.url}/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body, headers })
  return { ws, viewer, state, ctl, upload }
}

const REVIEWS = 'id,stars,review\n1,1,"The app crashes when I paste an image, please fix"\n2,5,Best notes app I have used\n3,2,"Too expensive, the price doubled"\n4,1,It crashes on launch since the update\n'

test('a dropped file becomes the sheet: saved in the workspace, sheet.json points at it, the sample is kept', async () => {
  const v = await fresh()
  try {
    assert.equal((await v.state()).own, false, 'it opens on the made-up sample')
    const r = await (await v.upload('My Reviews (Q3).csv', REVIEWS)).json()
    assert.deepEqual(r, { ok: true, file: 'My-Reviews-Q3.csv', rows: 4, total: 4, textColumn: 'review' })
    assert.equal(readFileSync(join(v.ws, 'My-Reviews-Q3.csv'), 'utf8'), REVIEWS)
    const marker = JSON.parse(readFileSync(join(v.ws, 'sheet.json'), 'utf8'))
    assert.equal(marker.source, 'My-Reviews-Q3.csv')
    assert.equal(marker.demo, false, 'the ghost typist never spends money on a person\'s own rows')
    assert.deepEqual(marker.columns, [])
    assert.ok(existsSync(join(v.ws, 'sheet.sample.json')), 'the sample is kept for the way back')
    const s = await v.state()
    assert.equal(s.own, true)
    assert.equal(s.source.name, 'My-Reviews-Q3.csv')
    assert.equal(s.rows.length, 4)
    assert.equal(s.rows[0].meta.stars, 1, 'the other columns ride along as context')
    assert.equal(s.columns.length, 0, 'the sample\'s questions do not follow the person\'s file')
    assert.equal(s.ghost.enabled, false)
  } finally { await v.viewer.close() }
})

test('ask, count, filter, and take the answers away', async () => {
  const v = await fresh()
  try {
    await v.upload('reviews.csv', REVIEWS)
    assert.equal((await v.ctl('addColumn', { header: 'Topic: crash = crashes or freezing | price = cost or too expensive | praise = happy, best app' })).ok, true)
    await v.ctl('drain')
    let s = await v.state()
    const dist = s.colStats.topic.dist
    assert.equal(dist.length, 3)
    assert.equal(dist.reduce((a, b) => a + b, 0), 4, 'every row is counted once')
    // The counts are the cells, counted. (What the offline stand-in answers is not the point here.)
    const byValue = [0, 1, 2].map((i) => s.rows.filter((r) => s.cells[r.id].topic.v === i).map((r) => r.id))
    assert.deepEqual(dist, byValue.map((ids) => ids.length))
    const pick = byValue.findIndex((ids) => ids.length > 0)
    // click that bar: only those rows
    assert.deepEqual((await v.ctl('filter', { col: 'topic', v: pick })).filter, { col: 'topic', v: pick })
    s = await v.state()
    assert.deepEqual(s.order, byValue[pick])
    await v.ctl('filter', { col: 'topic', v: pick }) // the same click again clears it
    await v.ctl('filter', { col: 'topic', v: 0 })
    // the same click again clears it; a removed column clears it too
    assert.equal((await v.ctl('filter', { col: 'topic', v: 0 })).filter, null)
    assert.equal((await v.state()).order.length, 4)
    await v.ctl('filter', { col: 'topic', v: 1 })
    await v.ctl('removeColumn', { id: 'topic' })
    s = await v.state()
    assert.equal(s.filter, null)
    assert.equal(s.order.length, 4)
    // the download is the answers file
    await v.ctl('addColumn', { header: 'Complaint?' })
    await v.ctl('drain')
    const res = await fetch(`${v.viewer.url}/download/answers.csv`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-disposition'), /attachment; filename="answers\.csv"/)
    const csv = await res.text()
    assert.match(csv.split('\n')[0], /^row,review,id_,stars,Complaint,Complaint confidence$/)
    assert.equal(csv.trim().split('\n').length, 5)
    assert.equal((await fetch(`${v.viewer.url}/download/sheet.json`)).status, 404, 'only the answers can be downloaded')
    assert.equal((await fetch(`${v.viewer.url}/download/..%2Fsheet.json`)).status, 404)
  } finally { await v.viewer.close() }
})

test('a file that cannot be read changes nothing, and says why', async () => {
  const v = await fresh()
  try {
    const before = readFileSync(join(v.ws, 'sheet.json'), 'utf8')
    for (const [name, body, why] of [
      ['notes.pdf', '%PDF-1.4', /\.csv/],
      ['empty.csv', '', /empty/],
      ['header-only.csv', 'review\n', /header row and at least one data row/],
      ['broken.json', '{nope', /could not be parsed/],
      ['../../escape.csv', REVIEWS, null], // the name is reduced to its last part: it lands inside the workspace
    ]) {
      const r = await (await v.upload(name, body)).json()
      if (why) { assert.equal(r.ok, false, name); assert.match(r.error, why, name) } else assert.equal(r.file, 'escape.csv')
    }
    assert.ok(!existsSync(join(v.ws, 'notes.pdf')) && !existsSync(join(v.ws, 'header-only.csv')) && !existsSync(join(v.ws, 'broken.json')), 'a refused file is not left behind')
    assert.deepEqual(readdirSync(dirname(v.ws)).filter((f) => f === 'escape.csv'), [], 'nothing is written outside the workspace')
    // a reserved name is never overwritten by an upload
    const r = await (await v.upload('sheet.json', JSON.stringify(['one row', 'two rows']))).json()
    assert.equal(r.file, 'my-sheet.json')
    assert.notEqual(readFileSync(join(v.ws, 'sheet.json'), 'utf8'), JSON.stringify(['one row', 'two rows']))
    assert.ok(before.length > 0)
  } finally { await v.viewer.close() }
})

test('rows pasted from a spreadsheet arrive as one JSON string per line', async () => {
  const v = await fresh()
  try {
    const r = await (await v.upload('pasted.jsonl', '"Sync lost my notes"\n"Love it"\n"Refund please"\n')).json()
    assert.equal(r.rows, 3)
    assert.deepEqual((await v.state()).rows.map((x) => x.text), ['Sync lost my notes', 'Love it', 'Refund please'])
  } finally { await v.viewer.close() }
})

test('back to the sample restores the made-up sheet', async () => {
  const v = await fresh()
  try {
    await v.upload('reviews.csv', REVIEWS)
    assert.equal((await v.ctl('useSample')).sample, true)
    const s = await v.state()
    assert.equal(s.own, false)
    assert.equal(s.rows.length, 60)
    assert.equal(s.columns.length, 3)
    assert.equal(JSON.parse(readFileSync(join(v.ws, 'sheet.json'), 'utf8')).source, undefined)
    assert.ok(existsSync(join(v.ws, 'reviews.csv')), 'the person\'s file stays where it is')
  } finally { await v.viewer.close() }
})

test('a page on another site cannot upload, control or connect', async () => {
  const v = await fresh()
  try {
    const evil = { origin: 'https://evil.example' }
    assert.equal((await v.upload('x.csv', REVIEWS, evil)).status, 403)
    assert.equal((await fetch(`${v.viewer.url}/control`, { method: 'POST', headers: { ...evil, 'content-type': 'application/json' }, body: '{"cmd":"reset"}' })).status, 403)
    assert.equal((await fetch(`${v.viewer.url}/connect`, { method: 'POST', headers: { ...evil, 'content-type': 'application/json' }, body: '{"key":"sk-or-v1-aaaaaaaaaaaaaaaa"}' })).status, 403)
    assert.equal((await fetch(`${v.viewer.url}/control`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{"cmd":"reset"}' })).status, 403)
    // the pane itself is fine
    assert.equal((await v.upload('x.csv', REVIEWS, { origin: v.viewer.url })).status, 200)
    assert.equal((await v.state()).own, true)
  } finally { await v.viewer.close() }
})

test('a key pasted in the pane lands in the credentials file, chmod 600, and is never echoed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-cred-'))
  const credFile = join(dir, 'nested', 'credentials')
  const old = process.env.TYPESAFE_CREDENTIALS
  process.env.TYPESAFE_CREDENTIALS = credFile
  const v = await fresh()
  try {
    const connect = async (key) => (await fetch(`${v.viewer.url}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })).json()
    assert.equal((await (await fetch(`${v.viewer.url}/jev`)).json()).canConnect, true)
    const bad = await connect('short')
    assert.equal(bad.ok, false)
    assert.ok(!existsSync(credFile), 'a string that is not a key is never written')
    const KEY = 'sk-or-v1-' + 'a1b2c3d4'.repeat(6)
    const ok = await connect(KEY)
    assert.equal(ok.ok, true)
    assert.equal(ok.provider, 'openrouter')
    assert.equal(ok.probed, false, 'under node --test nothing is called')
    assert.ok(!JSON.stringify(ok).includes(KEY), 'the key is never echoed back')
    assert.equal(readFileSync(credFile, 'utf8'), `OPENROUTER_API_KEY=${KEY}\n`)
    if (process.platform !== 'win32') assert.equal(statSync(credFile).mode & 0o777, 0o600)
    // a second key of another kind is added; the same kind is replaced, never duplicated
    await connect('ts_live_' + 'z9'.repeat(12))
    await connect('sk-or-v1-' + 'ffff0000'.repeat(6))
    const lines = readFileSync(credFile, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(lines.filter((l) => l.startsWith('OPENROUTER_API_KEY=')).length, 1)
    assert.ok(lines.some((l) => l.startsWith('TYPESAFE_API_KEY=ts_live_')))
  } finally {
    await v.viewer.close()
    if (old === undefined) delete process.env.TYPESAFE_CREDENTIALS; else process.env.TYPESAFE_CREDENTIALS = old
  }
})

test('the agent saves sheet.json atomically, again and again, and every save is seen', async () => {
  // Editors and coding agents write a temp file and rename it over the target. A watcher on the
  // file itself goes deaf after the first such save. The drop itself is one, so this broke for real.
  const v = await fresh()
  try {
    await v.upload('reviews.csv', REVIEWS) // the viewer's own write of sheet.json is an atomic save
    const marker = join(v.ws, 'sheet.json')
    const save = (obj) => { writeFileSync(marker + '.agent', JSON.stringify(obj)); renameSync(marker + '.agent', marker) }
    const until = async (pred) => { const end = Date.now() + 5000; for (;;) { const s = await v.state(); if (pred(s)) return s; if (Date.now() > end) assert.fail('the viewer never saw the save'); await new Promise((r) => setTimeout(r, 50)) } }
    const base = JSON.parse(readFileSync(marker, 'utf8'))
    save({ ...base, columns: ['Complaint?'] })
    await until((s) => s.columns.length === 1)
    save({ ...base, columns: ['Complaint?', 'Anger: calm < annoyed < furious'] })
    await until((s) => s.columns.length === 2)
    save({ ...base, context: 'Each row is one review.', columns: ['Mentions a crash?'] })
    const s = await until((x) => x.columns.length === 1 && x.columns[0].id === 'mentions_a_crash')
    assert.equal(s.own, true)
    // the person's file is watched the same way
    writeFileSync(join(v.ws, 'reviews.csv.new'), REVIEWS + '5,4,A brand new review about the editor\n'); renameSync(join(v.ws, 'reviews.csv.new'), join(v.ws, 'reviews.csv'))
    await until((x) => x.rows.length === 5)
  } finally { await v.viewer.close() }
})

test('the verdict moves while a fill is still running, and says when sheet.json was loaded', async () => {
  const v = await fresh()
  try {
    const verdict = () => JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    const t0 = Date.now()
    await v.upload('reviews.csv', REVIEWS)
    await v.ctl('addColumn', { header: 'Complaint?' })
    await v.ctl('tick', { n: 2 }) // two of the four rows: the fill is NOT finished
    const end = Date.now() + 5000
    let got
    for (;;) { got = verdict(); if (got.sheet.cellsFilled === 2) break; if (Date.now() > end) assert.fail('the verdict never showed the fill in progress: ' + got.summary); await new Promise((r) => setTimeout(r, 100)) }
    assert.equal(got.ready, false)
    assert.equal(got.sheet.cellsTotal, 4)
    assert.equal(got.sheet.source, 'reviews.csv')
    assert.ok(Date.parse(got.sheet.loadedAt) >= t0 - 1000, 'loadedAt is the time this sheet was taken in')
    await v.ctl('drain')
    const until = Date.now() + 5000
    for (;;) { got = verdict(); if (got.ready) break; if (Date.now() > until) assert.fail('the verdict never became ready'); await new Promise((r) => setTimeout(r, 100)) }
    assert.equal(got.sheet.cellsFilled, 4)
    const weak = got.sheet.columns[0].weakest[0]
    if (weak) assert.equal(typeof weak.n, 'number', 'weakest rows carry the row number answers.csv uses')
  } finally { await v.viewer.close() }
})

test('a changed context asks again; a changed title or suggestions does not', async () => {
  const v = await fresh()
  try {
    await v.upload('reviews.csv', REVIEWS)
    const marker = join(v.ws, 'sheet.json')
    const base = { ...JSON.parse(readFileSync(marker, 'utf8')), columns: ['Complaint?'] }
    const save = (obj) => { writeFileSync(marker + '.agent', JSON.stringify(obj)); renameSync(marker + '.agent', marker) }
    const settled = async (pred) => { const end = Date.now() + 5000; for (;;) { const s = await v.state(); if (pred(s)) return s; if (Date.now() > end) assert.fail('timed out: ' + JSON.stringify(s.stats)); await new Promise((r) => setTimeout(r, 50)) } }
    save({ ...base, context: 'Each row is one review of a notes app.' })
    await settled((s) => s.columns.length === 1)
    await v.ctl('drain')
    const first = (await v.state()).stats
    assert.equal(first.cellsFilled, 4)
    save({ ...base, context: 'Each row is one review of a notes app.', title: 'A new title', suggestions: ['Asks for a refund?'] })
    await settled((s) => s.title === 'A new title')
    await v.ctl('drain')
    assert.equal((await v.state()).stats.calls, first.calls, 'nothing is asked again for a title or suggestions')
    save({ ...base, context: 'Each row is one support ticket to a bank.', title: 'A new title' })
    await settled((s) => s.stats.cellsFilled === 0 || s.stats.calls > first.calls)
    await v.ctl('drain')
    const after = (await v.state()).stats
    assert.equal(after.cellsFilled, 4)
    assert.equal(after.calls, first.calls + 4, 'every row is asked again under the new context')
  } finally { await v.viewer.close() }
})
