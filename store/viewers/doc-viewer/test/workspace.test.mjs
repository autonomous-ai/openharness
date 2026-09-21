// The document state the pane is driven by: which PDF, and whether a compile is on its way or failed.
//
//   npm test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { docState, readVerdict, safeJoin, scan, snippet, stateKey } from '../lib/workspace.mjs'

const roots = []
function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'doc-viewer-'))
  roots.push(root)
  for (const [rel, { body = '', at }] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
    if (at) utimesSync(full, at, at)
  }
  return root
}
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const t = (s) => new Date(Date.UTC(2026, 8, 16, 12, 0, s))
const verdict = (v) => JSON.stringify({ spec: 1, ...v })

test('safeJoin keeps paths inside the workspace', () => {
  assert.equal(safeJoin('/ws', 'out/main.pdf'), '/ws/out/main.pdf')
  assert.equal(safeJoin('/ws', '../etc/passwd'), null)
  assert.equal(safeJoin('/ws', 'out/../../x'), null)
})

test('the newest PDF is shown when none is asked for; harness files and outputs are not sources', () => {
  const ws = workspace({
    'main.typ': { body: '= Hi', at: t(0) },
    'AGENTS.md': { body: 'x', at: t(50) },
    'out/old.pdf': { body: '%PDF', at: t(5) },
    'out/main.pdf': { body: '%PDF', at: t(10) },
    'out/preview.png': { body: 'png', at: t(40) },
    'node_modules/x/readme.md': { body: 'x', at: t(60) },
  })
  const s = docState(ws, '')
  assert.equal(s.file, 'out/main.pdf')
  assert.deepEqual(s.pdfs.map((p) => p.path), ['out/main.pdf', 'out/old.pdf'])
  assert.equal(s.source.path, 'main.typ')
  assert.equal(s.build, 'idle')
  assert.equal(scan(ws).pdfs.length, 2)
})

test('a source newer than the PDF and the verdict means a compile is on its way', () => {
  const ws = workspace({
    'out/main.pdf': { body: '%PDF', at: t(10) },
    '.harness/verdict.json': { body: verdict({ ready: true, artifact: 'out/main.pdf', findings: [] }), at: t(11) },
    'main.typ': { body: '= Hi', at: t(20) },
  })
  const s = docState(ws, 'out/main.pdf')
  assert.equal(s.build, 'building')
  assert.equal(s.since, t(20).getTime())
})

test('a failing verdict newer than the PDF is a failed compile, with the source lines around the error', () => {
  const ws = workspace({
    'main.typ': { body: 'a\nb\n#foo(1)\nc\n', at: t(20) },
    'out/main.pdf': { body: '%PDF', at: t(10) },
    '.harness/verdict.json': {
      body: verdict({ ready: false, artifact: 'out/main.pdf', findings: [{ severity: 'error', kind: 'typst', message: 'unknown variable: foo', ref: 'main.typ:3:1' }, { severity: 'warning', message: 'w' }] }),
      at: t(21),
    },
  })
  const s = docState(ws, 'out/main.pdf')
  assert.equal(s.build, 'failed')
  assert.equal(s.verdict.ready, false)
  const [error, warning] = s.verdict.findings
  assert.deepEqual(error.snippet, { file: 'main.typ', line: 3, col: 1, lines: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }, { n: 3, text: '#foo(1)' }, { n: 4, text: 'c' }] })
  assert.equal(warning.snippet, null)
})

test('a fixed source after a failure is building again, and a later good PDF clears the failure', () => {
  const failing = verdict({ ready: false, artifact: 'out/main.pdf', findings: [{ severity: 'error', message: 'x', ref: 'main.typ:1:0' }] })
  const edited = workspace({
    'out/main.pdf': { body: '%PDF', at: t(10) },
    '.harness/verdict.json': { body: failing, at: t(21) },
    'main.typ': { body: 'fixed', at: t(30) },
  })
  assert.equal(docState(edited, 'out/main.pdf').build, 'building')
  const rebuilt = workspace({
    'main.typ': { body: 'fixed', at: t(30) },
    '.harness/verdict.json': { body: failing, at: t(21) },
    'out/main.pdf': { body: '%PDF', at: t(31) },
  })
  assert.equal(docState(rebuilt, 'out/main.pdf').build, 'idle')
})

test('a verdict about another artifact does not mark this PDF failed', () => {
  const ws = workspace({
    'main.typ': { body: 'x', at: t(0) },
    'out/main.pdf': { body: '%PDF', at: t(10) },
    '.harness/verdict.json': { body: verdict({ ready: false, artifact: 'out/paper.pdf', findings: [{ severity: 'error', message: 'x' }] }), at: t(20) },
  })
  const s = docState(ws, 'out/main.pdf')
  assert.equal(s.build, 'idle')
  assert.deepEqual(s.verdict.findings, [])
})

test('no PDF yet: an error verdict fails, a lone source is building, nothing at all is idle', () => {
  const failed = workspace({
    'main.typ': { body: 'x', at: t(0) },
    '.harness/verdict.json': { body: verdict({ ready: false, artifact: null, findings: [{ severity: 'error', message: 'x' }] }), at: t(5) },
  })
  assert.equal(docState(failed, '').build, 'failed')
  assert.equal(docState(workspace({ 'main.typ': { body: 'x', at: t(0) } }), '').build, 'building')
  const empty = docState(workspace({}), '')
  assert.equal(empty.build, 'idle')
  assert.equal(empty.file, null)
})

test('snippet ignores refs that are not file:line:col or leave the workspace', () => {
  const ws = workspace({ 'main.typ': { body: 'one\ntwo' } })
  assert.equal(snippet(ws, 'U3.pin7'), null)
  assert.equal(snippet(ws, '../x.typ:1:0'), null)
  assert.equal(snippet(ws, 'main.typ:9:0'), null)
  assert.equal(snippet(ws, 'main.typ:2:0').lines.at(-1).text, 'two')
})

test('stateKey ignores the clock', () => {
  const ws = workspace({ 'out/main.pdf': { body: '%PDF', at: t(1) } })
  assert.equal(stateKey(docState(ws, '', 1)), stateKey(docState(ws, '', 2)))
})

test('the scan goes six folders deep and no deeper', () => {
  const ws = workspace({
    'a/b/c/d/e/f/deep.pdf': { body: '%PDF', at: t(1) },
    'a/b/c/d/e/f/g/deeper.pdf': { body: '%PDF', at: t(2) },
  })
  assert.deepEqual(scan(ws).pdfs.map((p) => p.path), ['a/b/c/d/e/f/deep.pdf'])
})

test('the scan stops after 20,000 entries', () => {
  // 10,002 folders of one PDF each: two entries apiece, so the 10,001st folder is the 20,001st entry,
  // whatever order the filesystem lists them in. Exactly 10,000 PDFs are seen.
  const ws = workspace({})
  for (let i = 0; i < 10_002; i++) {
    mkdirSync(join(ws, `d${i}`))
    writeFileSync(join(ws, `d${i}`, 'x.pdf'), '')
  }
  assert.equal(scan(ws).pdfs.length, 10_000)
})

test('files with no extension, special files and dangling links are neither PDFs nor sources', () => {
  const ws = workspace({ 'main.typ': { body: '= Hi', at: t(0) }, Makefile: { body: 'all:', at: t(30) } })
  symlinkSync(join(ws, 'nowhere.typ'), join(ws, 'gone.typ'))
  symlinkSync(join(ws, 'nowhere.pdf'), join(ws, 'gone.pdf'))
  assert.equal(spawnSync('mkfifo', [join(ws, 'pipe.typ')]).status, 0, 'mkfifo')
  const found = scan(ws)
  assert.equal(found.source.path, 'main.typ', 'the newer FIFO and link are not the source')
  assert.deepEqual(found.pdfs, [])
})

test('a verdict that is not an object is no verdict; findings that are not a list, or not objects, are dropped', () => {
  assert.equal(readVerdict(workspace({ '.harness/verdict.json': { body: 'null' } })), null)
  assert.equal(readVerdict(workspace({ '.harness/verdict.json': { body: '3' } })), null)
  assert.deepEqual(readVerdict(workspace({ '.harness/verdict.json': { body: verdict({ findings: 'none' }) } })).findings, [])
  // A null finding used to reach `f.severity` in docState and throw, which took the server down.
  const ws = workspace({
    'out/main.pdf': { body: '%PDF', at: t(10) },
    '.harness/verdict.json': { body: verdict({ ready: false, findings: [null, 'text', { severity: 'error', message: 'real' }] }), at: t(20) },
  })
  const s = docState(ws, 'out/main.pdf')
  assert.deepEqual(s.verdict.findings.map((f) => f.message), ['real'])
  assert.equal(s.build, 'failed')
})

test('findings are normalised: no message is empty, hints are strings and at most five', () => {
  const ws = workspace({
    '.harness/verdict.json': { body: verdict({ ready: true, findings: [{ severity: 'info', hints: [1, 'two', true, 4, 5, 6] }] }) },
  })
  const [f] = docState(ws, '').verdict.findings
  assert.deepEqual(f, { severity: 'info', kind: null, message: '', ref: null, hints: ['1', 'two', 'true', '4', '5'], snippet: null })
})

test('snippet skips a file it cannot read and one over 2 MB', () => {
  const ws = workspace({ 'huge.typ': { body: 'x' }, 'small.typ': { body: 'one\ntwo' } })
  truncateSync(join(ws, 'huge.typ'), 2_000_001)
  assert.equal(snippet(ws, 'huge.typ:1:1'), null)
  assert.equal(snippet(ws, 'missing.typ:1:1'), null)
  assert.equal(snippet(ws, 'small.typ:0:1'), null, 'line 0 is not a line')
  assert.deepEqual(snippet(ws, 'small.typ:1:1', 0).lines, [{ n: 1, text: 'one' }, { n: 2, text: 'two' }], 'no context before, one line after')
})

test('a folder that cannot be listed is empty, not an error', () => {
  assert.deepEqual(scan(join(workspace({}), 'not-there')), { pdfs: [], source: null })
})

test('the verdict the pane shows: its summary, artifact and time, or empty ones', () => {
  const full = workspace({ '.harness/verdict.json': { body: verdict({ ready: true, summary: '12 pages', artifact: 'out/main.pdf', updatedAt: '2026-09-16T12:00:00Z', findings: [] }), at: t(5) } })
  assert.deepEqual(docState(full, '').verdict, { ready: true, summary: '12 pages', artifact: 'out/main.pdf', updatedAt: '2026-09-16T12:00:00Z', mtimeMs: t(5).getTime(), findings: [] })
  const bare = workspace({ '.harness/verdict.json': { body: verdict({ ready: 'yes', summary: 3 }), at: t(5) } })
  assert.deepEqual(docState(bare, '').verdict, { ready: false, summary: '', artifact: null, updatedAt: null, mtimeMs: t(5).getTime(), findings: [] })
})

test('the requested file: not a string is none, not written yet or a folder is no PDF', () => {
  const ws = workspace({ 'out/main.pdf': { body: '%PDF', at: t(10) } })
  assert.equal(docState(ws, null).file, 'out/main.pdf')
  assert.equal(docState(ws, 42).requested, '')
  const later = docState(ws, '/out/later.pdf')
  assert.equal(later.requested, 'out/later.pdf', 'leading slashes are dropped')
  assert.equal(later.file, 'out/later.pdf')
  assert.equal(later.pdf, null)
  const folder = docState(ws, 'out')
  assert.equal(folder.file, 'out')
  assert.equal(folder.pdf, null)
  assert.equal(docState(ws, '../elsewhere.pdf').file, 'out/main.pdf', 'a path outside is ignored')
})
