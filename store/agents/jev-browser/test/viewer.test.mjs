// Jev Browser: the job file, the page reader, the guards, and a whole run against a real Chrome
// over a real HTTP site served on the loopback. Chrome-dependent tests skip where there is no Chrome.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeJob, listQuestions, itemQuestions, rowFrom, pickLinks, proposeJob, THINGS, VALUE_KINDS, LIMITS } from '../viewer/crawl.mjs'
import { readPage, blockOptions, blockText, canonical, pageState, wallReason, findSearchBox } from '../viewer/page.mjs'
import { openChrome, findChrome, checkUrl, Refused } from '../toolchain/chrome.mjs'
import { startDemoSite } from '../viewer/demosite.mjs'
import { startBrowserViewer } from '../viewer/viewer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(HERE, '../template')
const noChrome = findChrome() ? false : 'Google Chrome is not on this machine'
process.env.JEV_BROWSER_HEADLESS = '1'

/** fetch will not send a foreign Host header, so the loopback guard is tested over a raw socket. */
const rawGet = (base, path, host) => new Promise((resolve, reject) => {
  const socket = connect(Number(new URL(base).port), '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
  let data = ''
  socket.on('data', (c) => { data += c })
  socket.on('error', reject)
  socket.on('end', () => resolve(Number(data.slice(9, 12))))
})

const browser = async (allowedHosts = ['127.0.0.1', 'localhost']) =>
  openChrome({ profileDir: mkdtempSync(join(tmpdir(), 'jev-browser-test-')), show: false, allowedHosts })

test('the job file: what it fills in, and what it says is wrong', () => {
  const { job, errors } = normalizeJob(JSON.parse(readFileSync(join(TEMPLATE, 'browse.json'), 'utf8')))
  assert.deepEqual(errors, [])
  assert.equal(job.fields.length, 6)
  assert.deepEqual(job.fields.map((f) => f.type), ['pick', 'pick', 'pick', 'pick', 'pick', 'yesno'])
  assert.equal(job.sameSiteOnly, true)

  const bare = normalizeJob({})
  assert.match(bare.errors.join(' '), /no "start"/)
  // No columns is not a mistake: Jev reads the page and proposes them.
  const noColumns = normalizeJob({ start: 'https://example.com/all', want: 'what each one costs' })
  assert.deepEqual(noColumns.errors, [])
  assert.deepEqual(noColumns.job.fields, [])
  assert.equal(noColumns.job.want, 'what each one costs')

  const messy = normalizeJob({
    start: 'https://shop.example.com/all', item: 'a product', alsoVisit: ['https://cdn.example.org/x'],
    fields: ['the price', { ask: 'the name' }, { id: 'the price', ask: 'again' }, { ask: 'how new', type: 'score', levels: ['old'] }, { type: 'pick' }],
    maxItems: 99999, maxPages: 0,
  })
  assert.deepEqual(messy.job.fields.map((f) => f.id), ['the_price', 'the_name'])
  assert.match(messy.errors.join(' '), /both called "the_price"/)
  assert.match(messy.errors.join(' '), /needs at least two levels/)
  assert.match(messy.errors.join(' '), /a field needs "ask"/)
  assert.equal(messy.job.maxItems, LIMITS.maxItems)      // clamped, not obeyed
  assert.equal(messy.job.maxPages, 1)
  assert.deepEqual(messy.job.hosts, ['shop.example.com', 'cdn.example.org'])
})

test('an address is checked before anything opens it', () => {
  assert.equal(checkUrl('https://example.com/a?b=1', ['example.com']), 'https://example.com/a?b=1')
  assert.equal(checkUrl('https://shop.example.com/a', ['example.com']), 'https://shop.example.com/a', 'a subdomain of a named site is the same site')
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'not a url']) {
    assert.throws(() => checkUrl(bad, []), Refused, bad)
  }
  assert.throws(() => checkUrl('https://evil.example/x', ['example.com']), /not one of the sites this job named/)
  assert.throws(() => checkUrl('https://notexample.com/x', ['example.com']), /not one of the sites/, 'a host that merely ends in the name is not the site')
})

test('the reader: links, values, and none of the page furniture', { skip: noChrome }, async () => {
  const site = await startDemoSite()
  const chrome = await browser()
  try {
    await chrome.go(site.url)
    const list = await readPage(chrome)
    assert.ok(list.links.length > 10)
    assert.ok(list.links.some((l) => /\/job\/\d+/.test(l.path)), 'the job links are there')
    assert.equal(new Set(list.links.map((l) => l.url)).size, list.links.length, 'one row per address')
    assert.ok(!list.blocks.some((b) => /None of these roles exist/.test(b.text)), 'the footer is not offered as a value')
    assert.ok(!list.blocks.some((b) => b.text === 'Fernhill Jobs'), 'the header is not offered as a value')

    const job = list.links.find((l) => /\/job\/\d+/.test(l.path))
    await chrome.go(job.url)
    const page = await readPage(chrome)
    const mashed = page.blocks.find((b) => b.parts.length)
    assert.ok(mashed, 'a line that holds two values is also offered in parts')
    assert.equal(mashed.parts.length, 2)
    const options = blockOptions(page)
    assert.equal(options[`b${mashed.n}p0`], mashed.parts[0])
    assert.equal(blockText(page, `b${mashed.n}p1`), mashed.parts[1])
    assert.equal(blockText(page, `b${mashed.n}`), mashed.text)
    // Nothing can come back that was not on the page.
    for (const made of ['none', 'b99999', 'b1p9', 'whatever', '', null]) assert.equal(blockText(page, made), '', String(made))
    const state = pageState(page)
    assert.ok(state.page_text.length > 40 && state.page_text.length <= 2500)
  } finally { await chrome.close(); await site.close() }
})

test('the guards: it will not submit, will not press a danger word, will not type a secret', { skip: noChrome }, async () => {
  const site = await startDemoSite()
  const chrome = await browser()
  try {
    await chrome.go(new URL('/login', site.url).toString())
    const page = await readPage(chrome)
    const submit = page.controls.find((c) => /sign in/i.test(c.label) && c.tag === 'button')
    assert.ok(submit, 'the sign-in button is on the page')
    await assert.rejects(() => chrome.click(submit.css, submit.label), /submits a form/)
    // A danger word is refused on its own, before the page is even touched.
    await chrome.evaluate(`(() => { const b = document.createElement('button'); b.textContent = 'Delete account'; b.setAttribute('data-jev-n', '900'); document.body.append(b) })()`)
    await assert.rejects(() => chrome.click('[data-jev-n="900"]', 'Delete account'), /looks like it does something for real/)
    await assert.rejects(() => chrome.click('[data-jev-n="900"]', 'Pay now'), Refused)
    const password = page.controls.find((c) => c.type === 'password')
    await assert.rejects(() => chrome.type(password.css, 'hunter2'), /never types those/)
    const email = page.controls.find((c) => (c.label || '').toLowerCase().includes('email'))
    assert.equal(await chrome.type(email.css, 'someone@example.com'), true, 'an ordinary field is fine')
    // Off-site is refused even when asked directly.
    await assert.rejects(() => chrome.go('https://example.com/'), /not one of the sites/)
    await assert.rejects(() => chrome.open('file:///etc/passwd'), Refused)
  } finally { await chrome.close(); await site.close() }
})

test('the questions: one call holds every link and every field', { skip: noChrome }, async () => {
  const site = await startDemoSite()
  const chrome = await browser()
  try {
    const { job } = normalizeJob({ ...JSON.parse(readFileSync(join(TEMPLATE, 'browse.json'), 'utf8')), start: site.url })
    await chrome.go(site.url)
    const list = await readPage(chrome)
    const { questions, links } = listQuestions(list, job)
    assert.equal(Object.keys(questions).length, links.length + 2, 'one question per link, plus the kind and the next page')
    assert.ok(links.length > 10)
    assert.match(questions[`l${links[0].n}`].instructions, /is the text of a link on this page/)
    // A made-up set of answers turns into the right links, in page order.
    const answers = { nextpage: { choice: `l${links[links.length - 1].n}` } }
    for (const [i, l] of links.entries()) answers[`l${l.n}`] = { noul: i % 2 ? 0.9 : 0.1 }
    const got = pickLinks(links, answers)
    assert.equal(got.items.length, Math.floor(links.length / 2))
    assert.deepEqual(got.items.map((l) => l.n), [...got.items.map((l) => l.n)].sort((a, b) => a - b))
    assert.equal(got.next.n, links[links.length - 1].n)
    assert.equal(pickLinks(links, { nextpage: { choice: 'none' } }).next, null)

    await chrome.go(links.find((l) => /\/job\//.test(l.path)).url)
    const item = await readPage(chrome)
    const iq = itemQuestions(item, job)
    assert.equal(Object.keys(iq.questions).length, job.fields.length + 1)
    const pick = item.blocks[0]
    const made = { kind: { choice: 'item' }, f_title: { choice: `b${pick.n}`, confidence: 0.9 }, f_remote: { noul: 0.8 } }
    const row = rowFrom(item, job, made)
    assert.equal(row.fields.title, pick.text, 'the cell holds the exact text from the page')
    assert.equal(row.fields.remote, 'yes')
    assert.equal(row.confidence.remote, 0.8)
    assert.equal(row.fields.salary, '', 'a field with no answer stays empty')
  } finally { await chrome.close(); await site.close() }
})

test('a whole run: rows land in results.csv, the verdict says what happened', { skip: noChrome }, async () => {
  process.env.JEV_OFFLINE = '1'
  const site = await startDemoSite()
  const ws = mkdtempSync(join(tmpdir(), 'jev-browser-run-'))
  cpSync(TEMPLATE, ws, { recursive: true })
  const cfg = JSON.parse(readFileSync(join(ws, 'browse.json'), 'utf8'))
  writeFileSync(join(ws, 'browse.json'), JSON.stringify({ ...cfg, start: site.url, maxItems: 5, maxPages: 2 }))
  const v = await startBrowserViewer({ workspace: ws, port: 0 })
  const ctl = async (cmd, body = {}) => (await fetch(`${v.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...body }) })).json()
  try {
    const before = await (await fetch(`${v.url}/state`)).json()
    assert.equal(before.phase, 'idle')
    assert.equal(before.client, 'mock')
    assert.equal(before.chrome.found, true)
    const run = await ctl('run')
    assert.equal(run.phase, 'done')
    assert.equal(run.rows, 5, 'it stops at maxItems')

    const s = await (await fetch(`${v.url}/state`)).json()
    assert.equal(s.rows.length, 5)
    assert.ok(s.progress.links > 10, 'it judged every link on the list page')
    assert.equal(s.progress.calls, 6, 'one call for the list page, one for each of the five items')
    assert.ok(s.progress.questions > s.progress.calls * 3)
    assert.equal(s.progress.errors, 0)
    assert.ok(s.links.length > 10 && s.links.every((l) => l.p >= 0 && l.p <= 1))
    for (const r of s.rows) assert.match(r.url, /\/job\/\d+$/, 'every row is one of the things, not a menu page')
    assert.equal(new Set(s.rows.map((r) => r.url)).size, 5, 'no page is collected twice')

    const csv = readFileSync(join(ws, 'results.csv'), 'utf8').trim().split('\n')
    assert.equal(csv.length, 6)
    assert.match(csv[0], /^item,page title,address,Job title,Job title confidence,/)
    const verdict = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(verdict.ready, true)
    assert.equal(verdict.run.rows, 5)
    assert.equal(verdict.run.client, 'mock')
    assert.equal(verdict.run.fields.length, 6)
    assert.ok(verdict.findings.some((f) => /offline stand-in/.test(f.message)), 'it says the rows are not Jev\'s judgement')

    // The download and the same-origin guard.
    const dl = await fetch(`${v.url}/download/results.csv`)
    assert.equal(dl.status, 200)
    assert.equal((await dl.text()).split('\n').length, 7)
    assert.equal((await fetch(`${v.url}/download/browse.json`)).status, 404)
    assert.equal((await fetch(`${v.url}/control`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"cmd":"start"}' })).status, 403)

    // Reset clears the rows and reads the job again.
    assert.equal((await ctl('reset')).phase, 'idle')
    assert.equal((await (await fetch(`${v.url}/state`)).json()).rows.length, 0)
    assert.equal(readFileSync(join(ws, 'results.csv'), 'utf8').trim().split('\n').length, 1)

    // The pane's address bar obeys the same rules as everything else.
    const off = await ctl('openHere', { url: 'https://example.com/' })
    assert.equal(off.ok, false)
    assert.match(off.error, /not one of the sites/)
  } finally { await v.close(); await site.close(); delete process.env.JEV_OFFLINE }
})

test('a broken job file keeps the pane alive and says what to fix', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'jev-browser-bad-'))
  writeFileSync(join(ws, 'browse.json'), '{ "fields": ["the price"] }')   // no "start"
  const v = await startBrowserViewer({ workspace: ws, port: 0 })
  try {
    const s = await (await fetch(`${v.url}/state`)).json()
    assert.match(s.error, /no "start"/)
    const start = await (await fetch(`${v.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"cmd":"start"}' })).json()
    assert.equal(start.ok, false, 'it will not run a job it cannot read')
    const verdict = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(verdict.ready, false)
    assert.ok(verdict.findings.some((f) => f.severity === 'error'))
  } finally { await v.close() }
})

test('the pane files are served, and nothing else', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'jev-browser-files-'))
  cpSync(TEMPLATE, ws, { recursive: true })
  const v = await startBrowserViewer({ workspace: ws, port: 0 })
  try {
    for (const name of ['', 'studio.js', 'studio.css', 'base.css', 'jev-hud.js']) assert.equal((await fetch(`${v.url}/${name}`)).status, 200, name)
    for (const name of ['viewer.mjs', 'crawl.mjs', 'page.mjs', '../toolchain/jev.mjs', 'demosite.mjs']) assert.equal((await fetch(`${v.url}/${name}`)).status, 404, name)
    assert.equal(await rawGet(v.url, '/', 'example.com'), 403, 'a page on another name cannot reach this server')
    assert.equal(await rawGet(v.url, '/', '127.0.0.1'), 200)
    assert.equal((await (await fetch(`${v.url}/jev`)).json()).canConnect, true)
  } finally { await v.close() }
})

test('one address, one row: the same page under two names is not collected twice', () => {
  assert.equal(canonical('https://a.com/x/?utm_source=z#frag'), 'https://a.com/x')
  assert.equal(canonical('https://a.com/x'), canonical('https://a.com/x/'))
  assert.equal(canonical('https://a.com/x?page=2'), 'https://a.com/x?page=2')
})

test('a label keeps its value, and a number in a sentence is offered on its own', { skip: noChrome }, async () => {
  // The demo site prints its details as <dt>Salary</dt><dd>£35,000 - £55,000</dd>. Each distinct
  // string is offered once, so without pairing the value is dropped as a repeat of the one on the
  // list page and the label is left alone, looking like the page never said it.
  const site = await startDemoSite()
  const chrome = await browser()
  try {
    await chrome.go(new URL('/job/1000', site.url).toString())
    const page = await readPage(chrome)
    const texts = page.blocks.map((b) => b.text)
    assert.ok(!texts.includes('Salary'), 'a label is never offered on its own')
    const salary = page.blocks.find((b) => /^Salary: /.test(b.text))
    assert.ok(salary, `the label and its value are one block: ${JSON.stringify(texts)}`)
    assert.match(salary.parts[0], /^£[\d,]+ - £[\d,]+$/, 'the value alone is the first part')
    const posted = page.blocks.find((b) => /^Posted: /.test(b.text))
    assert.ok(posted && posted.parts.some((p) => /^\d{1,2} \w+ \d{4}$/.test(p)), 'the date alone is offered')
    // A number inside a sentence is offered on its own, so a column can be sorted.
    await chrome.evaluate(`(() => { const p = document.createElement('p'); p.textContent = 'In stock (19 available)'; document.querySelector('main').append(p) })()`)
    const again = await readPage(chrome)
    const stock = again.blocks.find((b) => b.text === 'In stock (19 available)')
    assert.ok(stock, 'the sentence is offered')
    assert.ok(stock.parts.includes('19'), `and the number on its own: ${JSON.stringify(stock.parts)}`)
    assert.equal(blockText(again, `b${stock.n}p${stock.parts.indexOf('19')}`), '19')
    // A choice takes at most 255 options, and parts push the count up.
    assert.ok(Object.keys(blockOptions(again)).length <= 250)
  } finally { await chrome.close(); await site.close() }
})

test('the pane takes the job itself, writes browse.json, and starts', { skip: noChrome }, async () => {
  // Dee's screenshot: the pane said "Press Start" and showed nothing while something else thought.
  // A job set in the pane, or written by the agent, now runs without anyone pressing anything.
  process.env.JEV_OFFLINE = '1'
  const site = await startDemoSite()
  const ws = mkdtempSync(join(tmpdir(), 'jev-browser-front-'))
  writeFileSync(join(ws, 'browse.json'), '{}\n')
  const v = await startBrowserViewer({ workspace: ws, port: 0 })
  const ctl = async (cmd, body = {}) => (await fetch(`${v.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...body }) })).json()
  const state = async () => (await fetch(`${v.url}/state`)).json()
  const until = async (pred, ms = 40000) => { const end = Date.now() + ms; for (;;) { const s = await state(); if (pred(s)) return s; if (Date.now() > end) assert.fail(`timed out: ${s.phase} ${s.rows.length} rows`); await new Promise((r) => setTimeout(r, 120)) } }
  try {
    assert.equal((await state()).fields.length, 0, 'it opens with no job')
    const set = await ctl('setJob', { start: site.url, item: 'a job posting', columns: 'the job title\nthe pay or salary range\nCan it be done remotely?', maxItems: 3 })
    assert.equal(set.ok, true)
    assert.equal(set.fields, 3)
    // the form's words become the job file, and a question becomes a yes/no column
    const written = JSON.parse(readFileSync(join(ws, 'browse.json'), 'utf8'))
    assert.equal(written.start, site.url)
    assert.deepEqual(written.fields.map((x) => x.type ?? 'pick'), ['pick', 'pick', 'yesno'])
    // nobody pressed Start
    await until((s) => s.phase === 'running' || s.rows.length > 0)
    const done = await until((s) => s.phase === 'done')
    assert.equal(done.rows.length, 3)
    assert.equal(readFileSync(join(ws, 'results.csv'), 'utf8').trim().split('\n').length, 4)
    // a job that only changes its budget does not start all over again
    const calls = done.progress.calls
    await ctl('setJob', { start: site.url, item: 'a job posting', columns: 'the job title\nthe pay or salary range\nCan it be done remotely?', maxItems: 3 })
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal((await state()).progress.calls, calls, 'the same job is not run twice')
    // "autoStart": false gives the button back
    writeFileSync(join(ws, 'browse.json'), JSON.stringify({ ...written, item: 'a role', autoStart: false }))
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal((await state()).phase, 'done', 'it waits to be told')
  } finally { await v.close(); await site.close(); delete process.env.JEV_OFFLINE }
})

test('a search box is the one control it may work, and only a search box', { skip: noChrome }, async () => {
  const site = await startDemoSite()
  const chrome = await browser()
  try {
    await chrome.go(new URL('/login', site.url).toString())
    const page = await readPage(chrome)
    // The site keeps a search box in its header, so it is found even here. What matters is that it
    // is the search box that is found, and never the email or the password beside it.
    const onLogin = findSearchBox(page)
    assert.equal(onLogin?.type, 'search')
    assert.notEqual(onLogin.name, 'email')
    const email = page.controls.find((c) => (c.label || '').toLowerCase().includes('email'))
    await assert.rejects(() => chrome.search(email.css, 'anything'), /does not look like a search box/)
    const password = page.controls.find((c) => c.type === 'password')
    await assert.rejects(() => chrome.search(password.css, 'anything'), Refused)
    const button = page.controls.find((c) => c.tag === 'button')
    await assert.rejects(() => chrome.search(button.css, 'anything'), /only ever types into a search box/)
    // and typing in it really searches the site
    await chrome.go(site.url)
    const list = await readPage(chrome)
    const box = findSearchBox(list)
    assert.ok(box, 'the search box is found on the list page')
    const after = await chrome.search(box.css, 'python')
    assert.match(after.url, /q=python/, 'the words were searched for')
    const results = await readPage(chrome)
    assert.match(results.title + results.text, /python/i)
    assert.ok(results.links.some((l) => /\/job\/\d+/.test(l.path)), 'the results are still a list of things')
  } finally { await chrome.close(); await site.close() }
})

test('a site that serves a wall is named, not silently collected from', { skip: noChrome }, async () => {
  const walls = [
    { title: 'Sorry! Something went wrong!', text: 'Sorry! Something went wrong on our end.', links: [], blocks: [] },
    { title: 'Robot Check', text: 'Enter the characters you see below. Are you a robot?', links: [1, 2], blocks: [1] },
    { title: 'Just a moment', text: 'Checking your browser before accessing the site.', links: [], blocks: [] },
  ]
  for (const w of walls) assert.ok(wallReason(w), w.title)
  assert.equal(wallReason({ title: 'Open roles', text: 'x'.repeat(400), links: [1, 2, 3, 4], blocks: [1, 2, 3, 4, 5] }), null, 'a real page is not a wall')

  // end to end: a site that answers every address with a block page
  process.env.JEV_OFFLINE = '1'
  const { createServer } = await import('node:http')
  const blocker = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>Sorry! Something went wrong!</title></head><body><h1>Sorry! Something went wrong!</h1></body></html>') })
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r))
  const ws = mkdtempSync(join(tmpdir(), 'jev-browser-wall-'))
  writeFileSync(join(ws, 'browse.json'), JSON.stringify({ start: `http://127.0.0.1:${blocker.address().port}/list`, item: 'a product', fields: ['the name'], autoStart: false }))
  const v = await startBrowserViewer({ workspace: ws, port: 0 })
  try {
    await (await fetch(`${v.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"cmd":"run"}' })).json()
    const s = await (await fetch(`${v.url}/state`)).json()
    assert.equal(s.rows.length, 0)
    assert.match(s.walled, /block page/)
    const verdict = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(verdict.ready, false)
    assert.ok(verdict.findings.some((f) => f.kind === 'walled' && /refusing an automated browser|block page/.test(f.message)))
    assert.match(verdict.run.walled, /block page/)
  } finally { await v.close(); blocker.close(); delete process.env.JEV_OFFLINE }
})

test('Jev proposes the whole job from the page, and it then runs with no columns given', { skip: noChrome }, async () => {
  process.env.JEV_OFFLINE = '1'
  const site = await startDemoSite()
  const ws = mkdtempSync(join(tmpdir(), 'jev-browser-prop-'))
  // An address and a sentence, and no columns at all.
  writeFileSync(join(ws, 'browse.json'), JSON.stringify({ start: site.url, want: 'what each role pays and where it is', maxItems: 2, maxPages: 1, autoStart: false }))
  const v = await startBrowserViewer({ workspace: ws, port: 0 })
  const state = async () => (await fetch(`${v.url}/state`)).json()
  try {
    const before = await state()
    assert.deepEqual(before.fields, [], 'it starts with no columns')
    assert.equal(before.want, 'what each role pays and where it is')
    assert.equal(before.error, null, 'no columns is not an error any more')

    await (await fetch(`${v.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"cmd":"run"}' })).json()
    const s = await state()
    assert.ok(s.fields.length >= 1, `Jev proposed columns: ${JSON.stringify(s.fields.map((f) => f.name))}`)
    // What it worked out is written back, because browse.json is the recipe.
    const written = JSON.parse(readFileSync(join(ws, 'browse.json'), 'utf8'))
    assert.equal(written.fields.length, s.fields.length)
    assert.ok(written.fields.every((f) => f.id && f.name && f.ask))
    assert.equal(s.rows.length, 2, 'and then it collected with them')
    const csv = readFileSync(join(ws, 'results.csv'), 'utf8').trim().split('\n')
    assert.equal(csv.length, 3)
    assert.ok(csv[0].includes(s.fields[0].name))
  } finally { await v.close(); await site.close(); delete process.env.JEV_OFFLINE }
})

test("a proposed column is named off the page, and none of it is written", { skip: noChrome }, async () => {
  process.env.JEV_OFFLINE = '1'
  const site = await startDemoSite()
  const chrome = await browser()
  try {
    const { evaluate } = await import('../toolchain/jev.mjs')
    const got = await proposeJob({ chrome, ask: (x) => evaluate({ ...x, salt: 3 }), start: site.url, want: 'the pay' })
    assert.ok(Object.keys(THINGS).includes(got.kind))
    assert.ok(got.from.includes('/job/'), 'it opened one of the things to look at')
    assert.equal(new Set(got.columns.map((x) => x.id)).size, got.columns.length, 'no two columns share an id')
    for (const c of got.columns) {
      assert.ok(c.name && c.id && c.ask, JSON.stringify(c))
      // Every ask is either the page's own label or one of the fixed phrases. Nothing is invented.
      assert.ok(c.ask.startsWith('the ') || Object.values(VALUE_KINDS).includes(c.ask), c.ask)
      assert.ok(c.p >= 0.6 && c.p <= 1)
    }
  } finally { await chrome.close(); await site.close(); delete process.env.JEV_OFFLINE }
})
