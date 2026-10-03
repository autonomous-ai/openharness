import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFile(join(PACKAGE, path), 'utf8')

/**
 * The pane is plain DOM with no build step, so the one class of bug a build would have caught — a script
 * reaching for an id the page does not have — is caught here instead.
 */
test('every id the script looks up exists in the page', async () => {
  const [html, js] = await Promise.all([read('viewer/index.html'), read('viewer/app.js')])
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))
  const wanted = [...js.matchAll(/\bel\('([^']+)'\)/g)].map((match) => match[1])
  assert.ok(wanted.length > 10, 'the script should be looking up the page')
  for (const id of wanted) assert.ok(ids.has(id), `index.html has no #${id}`)
})

test('every selector the script queries by id is in the page too', async () => {
  const [html, js] = await Promise.all([read('viewer/index.html'), read('viewer/app.js')])
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))
  for (const match of js.matchAll(/querySelector\('#([a-z-]+)/g)) assert.ok(ids.has(match[1]), `index.html has no #${match[1]}`)
})

test('the page carries the token placeholder the server fills in', async () => {
  const html = await read('viewer/index.html')
  assert.match(html, /name="hps-token" content="__HPS_TOKEN__"/)
  const server = await read('viewer.mjs')
  assert.match(server, /__HPS_TOKEN__/)
})

test('the page loads only files the server is willing to serve', async () => {
  const [html, server] = await Promise.all([read('viewer/index.html'), read('viewer.mjs')])
  const referenced = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1])
  for (const file of referenced) {
    assert.match(server, new RegExp(`'/${file.replace('.', '\\.')}'`), `viewer.mjs does not serve ${file}`)
  }
  for (const file of await readdir(join(PACKAGE, 'viewer'))) {
    assert.ok(['index.html', 'app.js', 'app.css', 'scale.js', 'table.js', 'icons'].includes(file), `unexpected file in viewer/: ${file}`)
  }
})

test('no inline script survives the CSP the server sends', async () => {
  const html = await read('viewer/index.html')
  assert.equal(/<script(?![^>]*\bsrc=)/.test(html), false, 'an inline <script> would be blocked')
  assert.match(html, /<script type="module" src="app\.js">/)
  const server = await read('viewer.mjs')
  assert.match(server, /script-src 'self'/)
  assert.equal(server.includes('unsafe-eval'), false)
})

test('the stylesheet defines dark in both the ways the app can ask for it', async () => {
  const css = await read('viewer/app.css')
  assert.match(css, /@media \(prefers-color-scheme: dark\)/)
  assert.match(css, /:root:not\(\[data-theme="light"\]\)/)
  assert.match(css, /:root\[data-theme="dark"\]/)
  assert.match(css, /body \{[^}]*background: var\(--bg\)/)
})

test('the verbs the pane offers are the verbs the server accepts', async () => {
  const [js, server] = await Promise.all([read('viewer/app.js'), read('viewer.mjs')])
  const allowed = new Set(server.match(/const VERBS = new Set\(\[([^\]]+)\]\)/)[1].match(/'[a-z-]+'/g).map((word) => word.slice(1, -1)))
  for (const match of js.matchAll(/\bverb:\s*'([a-z-]+)'/g)) {
    if (match[1] !== 'clear') assert.ok(allowed.has(match[1]), `the server does not accept ${match[1]}`)
  }
  for (const forbidden of ['kill', 'remove']) assert.equal(allowed.has(forbidden), false)
})

/**
 * A `dom.x` the script uses but never looked up is undefined at runtime, and the first time it is touched
 * the whole render throws. Two of those shipped unnoticed — `UNITS` after a refactor, `dom.ruleRetire` after
 * a rename — and each one blanked the pane while every other test here passed.
 */
test('every dom handle the script touches is one it looked up', async () => {
  const js = await read('viewer/app.js')
  const block = js.slice(js.indexOf('const dom = {'), js.indexOf('}', js.indexOf('const dom = {')))
  const defined = new Set([...block.matchAll(/(\w+):\s*el\(/g)].map((m) => m[1]))
  const used = new Set([...js.matchAll(/\bdom\.(\w+)/g)].map((m) => m[1]))
  assert.deepEqual([...used].filter((name) => !defined.has(name)), [])
})

test('engine images reuse the desktop assets', async () => {
  const icons = await readdir(join(PACKAGE, 'viewer/icons'))
  for (const file of icons.filter(file => file.endsWith('.png'))) {
    const source = file === 'claude.png' ? 'model-icons' : 'engine-icons'
    const original = await readFile(join(PACKAGE, '../../../desktop/assets', source, file))
    assert.deepEqual(await readFile(join(PACKAGE, 'viewer/icons', file)), original)
  }
})
