import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSheetsViewer } from '../viewer/viewer.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sheet = {
  title: 'Practice workshop', description: 'Fictional support messages', context: 'Hosting support',
  demo: false, concurrency: 1, columns: [{ id: 'urgent', header: 'Urgent?' }],
  rows: [{ id: 'a', text: 'Our production site is down.' }, { id: 'b', text: 'Please send a receipt, no rush.' }]
}
async function until(read, predicate) {
  for (let i = 0; i < 100; i++) {
    const value = await read()
    if (predicate(value)) return value
    await sleep(30)
  }
  assert.fail('Timed out waiting for practice state')
}
async function fixture(t, offline, status = 200) {
  const workspace = mkdtempSync(join(tmpdir(), 'jev-practice-'))
  const file = join(workspace, 'sheet.json')
  const requests = []
  const provider = createServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body)
    requests.push(input)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(status === 200 ? {
      answers: Object.fromEntries(Object.keys(input.questions).map((id) => [id, { noul: 0.99 }])),
      usage: { input_tokens: 1 }, model: 'local-test-model'
    } : { error: 'fixture out of credit' }))
  })
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const changes = {
    JEV_OFFLINE: '0', JEV_LIVE_TESTS: '1', TYPESAFE_API_KEY: 'local-test-key',
    TYPESAFE_API_URL: `http://127.0.0.1:${provider.address().port}`,
    TYPESAFE_CREDENTIALS: join(workspace, 'no-credentials')
  }
  const prior = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]))
  Object.assign(process.env, changes)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, ...options) => {
    assert.equal(new URL(typeof input === 'string' ? input : input.url).hostname, '127.0.0.1', 'tests must never contact a real provider')
    return originalFetch(input, ...options)
  }
  let viewer
  t.after(async () => {
    await viewer?.close()
    provider.closeAllConnections()
    await new Promise((resolve) => provider.close(resolve))
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(workspace, { recursive: true, force: true })
  })
  writeFileSync(file, JSON.stringify({ ...sheet, offline }))
  viewer = await startSheetsViewer({ workspace, port: 0, paceMs: 0 })
  const state = async () => (await fetch(viewer.url + '/state')).json()
  const ctl = async (cmd, body = {}) => (await (await fetch(viewer.url + '/control', {
    method: 'POST', body: JSON.stringify({ cmd, ...body })
  })).json())
  const verdict = async () => {
    try { return JSON.parse(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8')) } catch { return {} }
  }
  return { workspace, file, requests, state, ctl, viewer, verdict }
}

test('project practice fills cells and Question Lab offline despite a configured live provider; saved packets reopen offline', async (t) => {
  const v = await fixture(t, true, 402)
  const s = await until(v.state, (s) => s.stats.cellsFilled === 2)
  assert.equal(s.client, 'mock')
  assert.equal(s.offline, true)
  assert.equal(v.requests.length, 0)
  const token = s.questionLabToken
  const preview = await v.ctl('labPreview', { token, column: 'urgent', count: 10 })
  assert.equal(preview.draft.offline, true)
  const start = await v.ctl('labStart', { token, draft: preview.draft.id, header: 'Production is down?' })
  const trial = (await until(() => v.ctl('labGet', { token, id: start.trial.id }), (r) => r.trial.status === 'complete')).trial
  assert.deepEqual(trial.summary.providers, ['mock'])
  await v.ctl('labKeep', { token, id: trial.id })
  const packet = JSON.parse(readFileSync(join(v.workspace, '.harness/question-trials', trial.id, 'sheet.json')))
  assert.equal(packet.offline, true)
  assert.equal(v.requests.length, 0)
  const saved = await v.ctl('labApply', { token, id: trial.id })
  assert.equal(saved.ok, true, saved.error)
  assert.equal(JSON.parse(readFileSync(v.file)).offline, true)
  const report = await until(v.verdict, (r) => r.ready)
  assert.equal(report.sheet.offline, true)
  assert.match(report.summary, /Offline practice/)
})

test('switching practice and live modes recomputes cells rather than reusing answers from the other route', async (t) => {
  const v = await fixture(t, false)
  await until(v.state, (s) => s.stats.cellsFilled === 2)
  assert.equal(v.requests.length, 2)
  writeFileSync(v.file, JSON.stringify({ ...sheet, offline: true }))
  let s = await until(v.state, (s) => s.offline && s.stats.cellsFilled === 2)
  assert.equal(s.client, 'mock')
  assert.notEqual(s.cells.a.urgent.p, 0.99)
  assert.equal(v.requests.length, 2)
  writeFileSync(v.file, JSON.stringify({ ...sheet, offline: false }))
  s = await until(v.state, (s) => !s.offline && s.stats.cellsFilled === 2)
  assert.equal(v.requests.length, 4)
  assert.equal(s.client, 'typesafe')
  assert.equal(s.cells.a.urgent.p, 0.99)
})

test('a provider error writes a failed fill promptly, and switching to practice recovers without credentials changes', async (t) => {
  const v = await fixture(t, false, 402)
  const failed = await until(v.verdict, (r) => r.phases?.[1]?.state === 'failed')
  assert.equal(failed.ready, false)
  assert.equal(failed.phases[1].name, 'Answers unavailable')
  assert.match(failed.summary, /out of credit/)
  assert.equal(failed.findings.find((f) => f.kind === 'jev').severity, 'error')
  writeFileSync(v.file, JSON.stringify({ ...sheet, offline: true }))
  const s = await until(v.state, (s) => s.offline && s.stats.cellsFilled === 2)
  assert.equal(s.jevError, null)
  await until(v.verdict, (r) => r.ready && r.sheet.offline)
  assert.equal(process.env.TYPESAFE_API_KEY, 'local-test-key')
})

test('an invalid practice flag is reported without sending rows to the configured provider', async (t) => {
  const v = await fixture(t, 'true')
  const s = await until(v.state, (s) => !!s.error)
  assert.match(s.error, /offline must be true or false/)
  assert.equal(s.client, 'mock')
  assert.equal(v.requests.length, 0)
})

test('an offline preview stays offline after the project switches, and cannot be applied as live evidence', async (t) => {
  const v = await fixture(t, true)
  const s = await until(v.state, (s) => s.stats.cellsFilled === 2)
  const token = s.questionLabToken
  const { draft } = await v.ctl('labPreview', { token, column: 'urgent', count: 10 })
  writeFileSync(v.file, JSON.stringify({ ...sheet, offline: false }))
  await until(v.state, (s) => !s.offline && s.stats.cellsFilled === 2)
  const { trial: started } = await v.ctl('labStart', { token, draft: draft.id, header: 'Production is down?' })
  const { trial } = await until(() => v.ctl('labGet', { token, id: started.id }), (r) => r.trial.status === 'complete')
  assert.deepEqual(trial.summary.providers, ['mock'])
  assert.equal(trial.stale, true)
  assert.equal(v.requests.length, 2, 'only the sheet made live calls; the frozen practice trial did not')
  await v.ctl('labKeep', { token, id: trial.id })
  assert.equal((await v.ctl('labApply', { token, id: trial.id })).ok, false)
})
