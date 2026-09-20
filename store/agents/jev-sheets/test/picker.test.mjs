// The pane's own file chooser. The Harness desktop pane is a web view that never opens the system
// file dialog, so the viewer lists the person's files itself, inside their home folder only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPicker } from '../viewer/picker.mjs'
import { startSheetsViewer } from '../viewer/viewer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CSV = 'id,review\n1,It crashes on launch\n2,Best notes app\n'

/** A made-up home folder: recent spreadsheets, other files, a hidden folder, and a secret outside it. */
function home() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jev-sheets-home-')))
  const h = join(root, 'me')
  for (const d of ['Downloads/exports', 'Desktop', 'Documents/deep/deeper', '.ssh', 'Library/Mail', 'Projects/data']) mkdirSync(join(h, d), { recursive: true })
  const put = (rel, body, ageDays) => { const f = join(h, rel); writeFileSync(f, body); const t = Date.now() / 1000 - ageDays * 86400; utimesSync(f, t, t); return f }
  put('Downloads/reviews q3.csv', CSV, 1)
  put('Downloads/exports/survey.xlsx', 'PK-not-really', 3)
  put('Desktop/tickets.jsonl', '"one"\n"two"\n', 2)
  put('Documents/deep/deeper/too-deep.csv', CSV, 0)
  put('Downloads/photo.png', 'x', 0)
  put('Downloads/empty.csv', '', 0)
  put('Downloads/notes.txt', 'a\nb\n', 0)
  put('Projects/data/leads.tsv', 'name\tnote\nAna\tcall back\n', 9)
  put('.ssh/keys.csv', CSV, 0)
  put('Library/Mail/mail.csv', CSV, 0)
  writeFileSync(join(root, 'outside.csv'), CSV)
  symlinkSync(join(root, 'outside.csv'), join(h, 'Downloads', 'link-out.csv'))
  return { root, h }
}

test('recent: the newest readable spreadsheets in Downloads, Desktop and Documents, one folder deep', () => {
  const { h } = home()
  const got = createPicker({ home: h }).recent()
  // newest first; a link is not a file, so the link that points outside home is not even listed
  assert.deepEqual(got.files.map((f) => f.name), ['reviews q3.csv', 'tickets.jsonl', 'survey.xlsx'])
  assert.ok(!got.files.some((f) => ['photo.png', 'empty.csv', 'notes.txt', 'too-deep.csv', 'keys.csv', 'mail.csv', 'leads.tsv'].includes(f.name)))
  const reviews = got.files.find((f) => f.name === 'reviews q3.csv')
  assert.equal(reviews.folder, '~/Downloads')
  assert.equal(reviews.size, CSV.length)
  assert.equal(got.denied, false)
})

test('browse: folders and readable files, never hidden ones, never outside home', () => {
  const { h, root } = home()
  const p = createPicker({ home: h })
  const top = p.browse('')
  assert.equal(top.shown, '~')
  assert.equal(top.parent, null, 'home is the top')
  assert.deepEqual(top.folders.map((f) => f.name), ['Desktop', 'Documents', 'Downloads', 'Projects'])
  const data = p.browse(join(h, 'Projects', 'data'))
  assert.equal(data.shown, '~/Projects/data')
  assert.equal(data.parent, join(h, 'Projects'))
  assert.deepEqual(data.files.map((f) => f.name), ['leads.tsv'])
  assert.equal(p.browse('~/Downloads').shown, '~/Downloads')
  for (const bad of [root, '/', join(h, '.ssh'), join(h, 'Library'), join(h, 'Downloads', '..', '..')]) assert.equal(p.browse(bad).ok, false, bad)
  assert.match(p.browse(join(h, 'nope')).error, /not there/)
})

test('read: a typed, pasted, quoted or escaped path; refusals say why', () => {
  const { h, root } = home()
  const p = createPicker({ home: h, maxBytes: 100 })
  const want = join(h, 'Downloads', 'reviews q3.csv')
  for (const typed of [want, '~/Downloads/reviews q3.csv', `"${want}"`, want.replace(/ /g, '\\ '), `file://${want.replace(/ /g, '%20')}`, `  ${want}  `]) {
    const got = p.read(typed)
    assert.equal(got.error, undefined, typed)
    assert.equal(got.name, 'reviews q3.csv')
    assert.equal(got.buffer.toString(), CSV)
  }
  assert.match(p.read('').error, /path of a file/)
  assert.match(p.read(join(h, 'Downloads', 'missing.csv')).error, /no file at/)
  assert.match(p.read(join(root, 'outside.csv')).error, /inside your home folder/)
  assert.match(p.read(join(h, 'Downloads', 'link-out.csv')).error, /inside your home folder/, 'a link that points outside home is outside home')
  assert.match(p.read(join(h, '.ssh', 'keys.csv')).error, /inside your home folder/)
  assert.match(p.read(join(h, 'Library', 'Mail', 'mail.csv')).error, /inside your home folder/)
  assert.match(p.read(join(h, 'Downloads', 'photo.png')).error, /\.xlsx/)
  assert.match(p.read(join(h, 'Downloads', 'notes.txt')).error, /\.xlsx/)
  assert.match(p.read(join(h, 'Downloads')).error, /\.xlsx|folder/)
  writeFileSync(join(h, 'Downloads', 'big.csv'), 'x'.repeat(101))
  assert.match(p.read(join(h, 'Downloads', 'big.csv')).error, /over 0 MB|over \d+ MB/)
})

test('in the pane: list, browse, then open by path, and the file becomes the sheet', async () => {
  const { h } = home()
  const old = process.env.JEV_SHEETS_HOME
  process.env.JEV_SHEETS_HOME = h
  const ws = mkdtempSync(join(tmpdir(), 'jev-sheets-pick-'))
  writeFileSync(join(ws, 'sheet.json'), readFileSync(join(HERE, '../template/sheet.json')))
  const viewer = await startSheetsViewer({ workspace: ws, port: 0, autostart: false })
  const ctl = async (cmd, body = {}) => (await fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...body }) })).json()
  try {
    const recent = await ctl('recentFiles')
    assert.equal(recent.ok, true)
    const pick = recent.files.find((f) => f.name === 'reviews q3.csv')
    assert.ok(pick, 'the recent list has the reviews file')
    assert.deepEqual((await ctl('browse', { dir: '~/Desktop' })).files.map((f) => f.name), ['tickets.jsonl'])
    assert.deepEqual(await ctl('usePath', { path: pick.path }), { ok: true, file: 'reviews-q3.csv', rows: 2, total: 2, textColumn: 'review' })
    const s = await (await fetch(`${viewer.url}/state`)).json()
    assert.equal(s.own, true)
    assert.equal(s.source.name, 'reviews-q3.csv')
    assert.equal(readFileSync(join(ws, 'reviews-q3.csv'), 'utf8'), CSV, 'the picked file is copied into the workspace')
    const bad = await ctl('usePath', { path: '/etc/hosts' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /inside your home folder/)
    // a page on another site cannot list or open anything
    assert.equal((await fetch(`${viewer.url}/control`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"cmd":"recentFiles"}' })).status, 403)
  } finally {
    await viewer.close()
    if (old === undefined) delete process.env.JEV_SHEETS_HOME; else process.env.JEV_SHEETS_HOME = old
  }
})

test('the pane offers its own chooser and does not lean on the system dialog', () => {
  const html = readFileSync(join(HERE, '../viewer/index.html'), 'utf8')
  const js = readFileSync(join(HERE, '../viewer/studio.js'), 'utf8')
  for (const id of ['picker', 'tabRecent', 'tabBrowse', 'tabPaste', 'pathInput', 'pasteArea']) assert.ok(html.includes(`id="${id}"`), id)
  assert.match(js, /\$\('pickBtn'\)\.addEventListener\('click', openPicker\)/, '"Choose a file" opens the built-in chooser')
  assert.doesNotMatch(js, /navigator\.clipboard\.readText/, 'no clipboard read: web views block it')
})
