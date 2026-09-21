// The pane's server, run as Harness runs it: a real process on a loopback port over a scratch workspace.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOLCHAIN, delay, startViewer } from './support/viewer.mjs'

const body = 'A body with several words in it.'
const DECK = `---\nmarp: true\n---\n# Talk\n\n![bg](assets/bg.svg)\n\n${body}\n\n---\n\n## A\n\n${body}\n\n---\n\n## B\n\n${body}\n`

let root, ws, viewer
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'marp-viewer-'))
  ws = join(root, 'ws')
  mkdirSync(join(ws, 'assets'), { recursive: true })
  mkdirSync(join(ws, 'folder.md'))                     // a directory that looks like a deck
  writeFileSync(join(ws, 'deck.md'), DECK)
  writeFileSync(join(ws, 'README.md'), '# Readme\n')
  writeFileSync(join(ws, 'assets', 'bg.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(ws, 'assets', 'growth 50%.png'), 'png')
  writeFileSync(join(ws, 'notes.xyz'), 'plain')
  writeFileSync(join(root, 'secret.txt'), 'outside the workspace')
  mkdirSync(join(root, 'ws-sibling'))
  writeFileSync(join(root, 'ws-sibling', 'deck.md'), '# Not this workspace\n')
  viewer = await startViewer(ws)
})
after(async () => {
  await viewer?.stop()
  rmSync(root, { recursive: true, force: true })
})

test('says where it listens', () => {
  assert.match(viewer.output(), new RegExp(`\\[marp:viewer\\] listening on http://127\\.0\\.0\\.1:${viewer.port}/ \\(workspace: `))
})

test('serves the page and its files, never a path outside viewer/', async () => {
  const page = await viewer.get('/')
  assert.equal(page.status, 200)
  assert.equal(page.type, 'text/html; charset=utf-8')
  assert.equal(page.cache, 'no-store')
  assert.match(page.body, /<script src="\/viewer\/app\.js"><\/script>/)
  assert.equal((await viewer.get('/viewer/app.js')).type, 'text/javascript; charset=utf-8')
  assert.equal((await viewer.get('/viewer/app.css')).type, 'text/css; charset=utf-8')
  assert.equal((await viewer.get('/viewer/nope.js')).status, 404)
  assert.equal((await viewer.get('/viewer/app.js.map')).status, 404, 'the page folder serves only html, js and css')
  assert.equal((await viewer.get('/viewer/')).status, 404, 'the folder itself is not a file')
  const escape = await viewer.get('/viewer/..%2F..%2Fviewer.mjs')
  assert.equal(escape.status, 404)
})

test('serves marp-core\'s browser script', async () => {
  const script = await viewer.get('/marp-browser.js')
  assert.equal(script.status, 200)
  assert.equal(script.type, 'text/javascript')
  assert.equal(script.body, readFileSync(join(TOOLCHAIN, 'node_modules/@marp-team/marp-core/lib/browser.js'), 'utf8'))
})

test('deck.json renders the deck and rewrites the verdict', async () => {
  rmSync(join(ws, '.harness'), { recursive: true, force: true })
  const deck = (await viewer.get('/deck.json')).json()
  assert.equal(deck.deck, 'deck.md')
  assert.equal(deck.missing, false)
  assert.equal(deck.html.length, 3)
  assert.equal(deck.slides[0].title, 'Talk')
  assert.ok(deck.css.length > 0)
  assert.equal(deck.verdict.ready, true)
  const written = JSON.parse(readFileSync(join(ws, '.harness', 'verdict.json'), 'utf8'))
  assert.equal(written.summary, deck.verdict.summary)
  assert.deepEqual((await viewer.get('/deck.json?file=%2Fdeck.md')).json().deck, 'deck.md', 'a leading slash is the workspace root')
})

test('another Markdown file renders but is never judged', async () => {
  rmSync(join(ws, '.harness'), { recursive: true, force: true })
  const readme = (await viewer.get('/deck.json?file=README.md')).json()
  assert.equal(readme.deck, 'README.md')
  assert.equal(readme.verdict, null)
  assert.equal(readme.slides[0].title, 'Readme')
  assert.equal(existsSync(join(ws, '.harness', 'verdict.json')), false)
})

test('deck.json falls back to deck.md for anything that is not a Markdown file in the workspace', async () => {
  for (const file of ['../ws-sibling/deck.md', 'notes.xyz', '..', '']) {
    assert.equal((await viewer.get(`/deck.json?file=${encodeURIComponent(file)}`)).json().deck, 'deck.md', file)
  }
})

test('deck.json says when the deck is missing, and reports a deck that cannot be read', async () => {
  assert.deepEqual((await viewer.get('/deck.json?file=talk.md')).json(), { html: [], css: '', slides: [], deck: 'talk.md', missing: true, verdict: null })
  const unreadable = await viewer.get('/deck.json?file=folder.md')
  assert.equal(unreadable.status, 200)
  assert.match(unreadable.json().error, /EISDIR/)
})

test('serves workspace files by the path the deck wrote, and nothing outside the workspace', async () => {
  const svg = await viewer.get('/assets/bg.svg')
  assert.equal(svg.status, 200)
  assert.equal(svg.type, 'image/svg+xml')
  assert.equal((await viewer.get('/assets/growth%2050%25.png')).body, 'png')
  assert.equal((await viewer.get('/notes.xyz')).type, 'application/octet-stream')
  assert.equal((await viewer.get('/assets/missing.png')).status, 404)
  assert.equal((await viewer.get('/assets')).status, 404, 'a folder is not a file')
  assert.equal((await viewer.get('/..%2Fsecret.txt')).status, 404)
  assert.equal((await viewer.get('/..%2Fws-sibling%2Fdeck.md')).status, 404, 'a sibling folder that shares the prefix is outside')
})

test('a malformed path is a bad request, not a crash', async () => {
  const bad = await viewer.get('/assets/growth%2050%.png')
  assert.equal(bad.status, 400)
  assert.equal((await viewer.get('/deck.json')).status, 200, 'the viewer is still up')
})

test('events: hello, a change per save naming the path, pings; state folders are not changes', async () => {
  const stream = await viewer.events()
  assert.equal(stream.status, 200)
  assert.equal(stream.type, 'text/event-stream')
  await stream.comment('hello')
  await stream.comment('ping')
  await delay(300)
  writeFileSync(join(ws, 'deck.md'), DECK + '\n')
  assert.deepEqual(await stream.next('change'), { path: 'deck.md' })
  writeFileSync(join(ws, 'assets', 'one.svg'), 'x')
  writeFileSync(join(ws, 'assets', 'two.svg'), 'x')
  assert.deepEqual(await stream.next('change'), { path: 'assets/two.svg' }, 'a burst of saves is one change naming the last')
  await delay(400)
  assert.equal(stream.seen.some((block) => block.startsWith('event: change')), false, 'and only one')
  for (const [ignored, noticed] of [['.harness/verdict.json', 'distribution.md'], ['dist/deck.pdf', 'dist-notes.md'], ['.git/HEAD', '.github.md'], ['node_modules/x.js', 'assets/chart.svg'], ['.claude/settings.json', '.harness-notes.md']]) {
    mkdirSync(join(ws, ignored, '..'), { recursive: true })
    writeFileSync(join(ws, ignored), 'x')
    await delay(400)
    writeFileSync(join(ws, noticed), 'x')
    assert.deepEqual(await stream.next('change'), { path: noticed }, `${ignored} is state; ${noticed} is a change`)
  }
  stream.close()
})

test('a workspace that cannot be watched still serves', async () => {
  const missing = join(root, 'not-yet')
  const lonely = await startViewer(missing)
  try {
    assert.match(lonely.output(), /\[marp\] cannot watch .*not-yet: /)
    assert.equal((await lonely.get('/deck.json')).json().missing, true)
  } finally {
    await lonely.stop()
  }
})
