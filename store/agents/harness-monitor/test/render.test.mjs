/**
 * The pane, rendered in a real browser.
 *
 * Every other test here checks the page's parts; this one runs it. It exists because the parts once all
 * passed while the page drew nothing at all — a missing import threw on the first render, and a stale handle
 * after a rename did it again. Headless Chrome loads the real page from the real server against a made-up
 * fleet, and the test fails if the rows do not appear or the page logs an error.
 *
 * Skipped, and says so, where no Chrome is installed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAY, HOUR, row } from './fixtures.mjs'
import { createViewer } from '../viewer.mjs'

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path))

const fleet = [
  row({ id: 'run-1', title: 'Fix the reconciler', idleMs: 5 * 60_000, rssBytes: 420 * 1024 ** 2, cpu: 3.2, resumeVia: 'daemon' }),
  row({ id: 'run-2', title: 'Plan the migration', engine: 'codex', idleMs: 2 * DAY, rssBytes: 310 * 1024 ** 2, resumeVia: 'daemon' }),
  row({ id: 'wait-1', title: 'Answer the trust prompt', idleMs: 3 * HOUR, needsInput: true, resumeVia: 'daemon' }),
  row({ id: 'paused-1', title: 'Old spike', state: 'paused', pane: null, idleMs: 3 * DAY, rssBytes: 0, resumeVia: 'daemon', saved: true }),
]

function render(url) {
  return new Promise((resolve) => {
    execFile(CHROME, ['--headless=new', '--disable-gpu', `--user-data-dir=${join(tmpdir(), `hm-render-${process.pid}-${Math.random()}`)}`,
      '--enable-logging=stderr', '--v=0', '--timeout=6000', '--window-size=1280,800', '--dump-dom', url],
    { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ dom: stdout, console: String(stderr).split('\n').filter((line) => line.includes('CONSOLE')) }))
  })
}

async function serve() {
  const workspace = await mkdtemp(join(tmpdir(), 'hm-render-'))
  const viewer = createViewer({ workspace, intervalMs: 60_000, collect: async () => ({ rows: fleet, machines: [], problems: [], observedAt: Date.now() }), scan: async () => '$ ' })
  const port = await viewer.start()
  await viewer.observed
  return { viewer, base: `http://127.0.0.1:${port}/` }
}

test('the table draws every harness, with no page errors', { skip: !CHROME && 'no Chrome on this machine', timeout: 60_000 }, async (t) => {
  const { viewer, base } = await serve()
  t.after(() => viewer.close())
  const { dom, console } = await render(base)
  assert.deepEqual(console, [], 'the page logged errors')
  for (const id of ['run-1', 'run-2', 'wait-1']) assert.match(dom, new RegExp(`<tr data-id="${id}"`), `${id} is not in the table`)
  assert.equal(/<tr data-id="paused-1"/.test(dom), true, 'a paused harness is part of All')
  assert.match(dom, /id="running-value"[^>]*>3 of 100</, 'the running meter counts this machine')
  assert.equal(/Nothing is running here yet|No harnesses\./.test(dom), false, 'the empty state must not show over real rows')
})

test('the timeline draws a chip per harness, with no page errors', { skip: !CHROME && 'no Chrome on this machine', timeout: 60_000 }, async (t) => {
  const { viewer, base } = await serve()
  t.after(() => viewer.close())
  const { dom, console } = await render(`${base}?view=lanes`)
  assert.deepEqual(console, [], 'the page logged errors')
  assert.ok((dom.match(/class="chip"/g) ?? []).length >= 3, 'the timeline drew no chips')
})

test('a deep link opens the inspector on that harness', { skip: !CHROME && 'no Chrome on this machine', timeout: 60_000 }, async (t) => {
  const { viewer, base } = await serve()
  t.after(() => viewer.close())
  const { dom, console } = await render(`${base}?scope=paused&inspect=paused-1`)
  assert.deepEqual(console, [], 'the page logged errors')
  assert.match(dom, /<aside class="sheet inspector" id="inspector"(?![^>]*hidden)/, 'the inspector did not open')
  assert.match(dom, /Old spike/)
})
