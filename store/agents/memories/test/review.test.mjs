/** Regressions from the first review of this package: each test names the failure it guards. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { firstHeading, frontmatter, sections } from '../lib/text.mjs'
import { parseAbout, writeAbout } from '../lib/about.mjs'
import { projectsFor } from '../lib/state.mjs'
import { parse } from '../viewer/markdown.js'
import { createViewer } from '../viewer.mjs'

const fast = (label, fn, budgetMs = 200) => {
  const started = performance.now()
  fn()
  const took = performance.now() - started
  assert.ok(took < budgetMs, `${label} took ${took.toFixed(0)} ms`)
}

test('a heading line of thousands of spaces parses in linear time (it once took 43 s)', () => {
  const line = '# a' + ' '.repeat(20_000) + 'b'
  fast('firstHeading', () => firstHeading(line))
  fast('sections', () => sections('## a' + ' '.repeat(20_000) + 'b\ntext'))
  fast('markdown', () => parse(line + '\n\n' + '`'.repeat(30_000)))
  fast('About You', () => parseAbout('## A\n- x' + ' '.repeat(30_000) + 'y [' + ' '.repeat(30_000)))
  assert.equal(firstHeading('## Title ##'), 'Title')
  assert.equal(firstHeading('#hashtag\n### C# tips'), 'C# tips')
})

test('thousands of nested quotes do not exhaust the stack', () => {
  assert.doesNotThrow(() => parse('>'.repeat(20_000) + ' deep'))
})

test('a front-matter key followed by indented text is a string, never "[object Object]"', () => {
  assert.deepEqual(frontmatter('---\ndescription:\n  Wants short\n  answers\nname: x\n---\n').data, { description: 'Wants short answers', name: 'x' })
  assert.deepEqual(frontmatter('---\ndescription: |\n  Block text\n---\n').data, { description: 'Block text' })
  assert.deepEqual(frontmatter('---\nempty:\nname: y\n---\n').data, { empty: '', name: 'y' })
})

test('each folder counts toward the closest project only; a project at home counts only home', () => {
  const home = '/h'
  const memories = [
    { id: 'a', project: { name: 'h', path: '/h' } },
    { id: 'b', project: { name: 'code', path: '/h/code' } },
    { id: 'c', project: { name: 'app', path: '/h/code/app' } },
  ]
  const folder = (cwd, sessions) => ({ cwd, sessions, asks: sessions, lastAt: 1, engines: { codex: sessions } })
  const projects = projectsFor(memories, [folder('/h', 1), folder('/h/code/app', 5), folder('/h/code/app/.claude/worktrees/x', 2), folder('/h/code/other', 3), folder('/w/worktrees/app/y', 4)], home)
  const by = Object.fromEntries(projects.map((p) => [p.name, p.sessions]))
  assert.deepEqual(by, { h: 1, code: 3, app: 11 })
})

test('About You never writes through a link planted at its file names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memories-link-'))
  const victim = join(mkdtempSync(join(tmpdir(), 'memories-victim-')), 'victim.txt')
  writeFileSync(victim, 'untouched')
  writeAbout(dir, '## A\n- one\n')
  symlinkSync(victim, join(dir, 'about-you.prev.md'))
  symlinkSync(victim, join(dir, `.about-you.md.${process.pid}.tmp`))
  writeAbout(dir, '## A\n- two\n')
  assert.equal(readFileSync(victim, 'utf8'), 'untouched')
  assert.match(readFileSync(join(dir, 'about-you.prev.md'), 'utf8'), /one/)
})

test('the streak counts calendar days across daylight-saving changes', () => {
  const heatmap = fileURLToPath(new URL('../viewer/heatmap.js', import.meta.url))
  const script = `
    const { streak, dayKey } = await import(${JSON.stringify(heatmap)})
    const days = (list) => new Map(list.map((d) => [d, { total: 1 }]))
    const spring = streak(days(['2027-03-12', '2027-03-13', '2027-03-14', '2027-03-15']), new Date('2027-03-15T00:30:00').getTime())
    const fall = streak(days(['2026-10-31', '2026-11-01']), new Date('2026-11-01T23:30:00').getTime())
    console.log(JSON.stringify([spring, fall]))`
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'America/New_York' } }).toString()
  assert.deepEqual(JSON.parse(out), [4, 2])
})

test('a request during the first read gets the snapshot, not an empty answer', async () => {
  let calls = 0
  const slow = async () => { calls++; await new Promise((ok) => setTimeout(ok, 150)); return { spec: 1, observedAt: Date.now(), memories: [{ id: 'x', title: 't', description: '', body: '', modified: 1, size: 1 }], agents: [], projects: [] } }
  const viewer = createViewer({ snapshot: slow, intervalMs: 60_000 })
  const port = await viewer.start()
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = ''; res.on('data', (c) => { body += c }); res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject).end()
  })
  try {
    const [a, b] = await Promise.all([get('/api/state'), get('/api/related?id=x')])
    assert.equal(a.status, 200)
    assert.equal(JSON.parse(a.body).memories[0].id, 'x')
    assert.equal(b.status, 200)
    assert.equal(calls, 1, 'concurrent callers share one read')
    assert.equal((await get('/api/state', { 'sec-fetch-site': 'cross-site' })).status, 403)
  } finally { await viewer.close() }
})

test('second review: full-path privacy skip, worktree beats parent, literal blocks, inline speed', async () => {
  const { resolveProject } = await import('../lib/sources.mjs')
  const { mkdirSync, mkdtempSync } = await import('node:fs')
  const home = mkdtempSync(join(tmpdir(), 'memories-dev-'))
  mkdirSync(join(home, 'dev', 'my-app'), { recursive: true })
  const found = resolveProject((home + '/dev/my-app').replace(/[^A-Za-z0-9]/g, '-'), { home })
  assert.equal(found.name, 'my-app', 'a folder named dev below the home folder is probed')

  const projects = projectsFor([{ id: 'r', project: { name: 'autonomous-harness', path: '/h/code/autonomous-harness' } }, { id: 'p', project: { name: 'harnesses', path: '/h/harnesses' } }],
    [{ cwd: '/h/harnesses/worktrees/autonomous-harness/x', sessions: 3, asks: 3, lastAt: 1, engines: {} }], '/h')
  assert.equal(projects.find((p) => p.name === 'autonomous-harness').sessions, 3)

  assert.deepEqual(frontmatter('---\ndescription: |\n  Triggers: build it\n  and more\nname: z\n---\n').data, { description: 'Triggers: build it and more', name: 'z' })
  fast('brackets', () => parse('['.repeat(20_000)))
  fast('backticks', () => parse('`'.repeat(8_000) + ' text'))
  assert.equal(parseAbout('## A\n-\titem\n').lines[0].text, 'item')
})
