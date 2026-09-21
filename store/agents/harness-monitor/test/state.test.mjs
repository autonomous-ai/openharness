import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAY, row } from './fixtures.mjs'
import { stripJsonc, updateConfig } from '../lib/config.mjs'
import { EMPTY_STATE, clearPaused, forget, gb, markPaused, pin, readLog, readState, record, writeState, writeVerdict } from '../lib/state.mjs'
import { decide } from '../lib/policy.mjs'

const workspace = () => mkdtemp(join(tmpdir(), 'hps-state-'))

/** Each test its own machine: its own rules file and ticket book, never the real ones. */
async function machine() {
  const dir = await mkdtemp(join(tmpdir(), 'hps-machine-'))
  return { dir, env: { ...process.env, HARNESS_MONITOR_CONFIG: join(dir, 'config', 'policy.jsonc'), HARNESS_MONITOR_STATE: join(dir, 'state') } }
}

test('a machine with no rules file gets the commented default, and reads it', async () => {
  const { env } = await machine()
  const state = await readState(null, env)
  assert.equal(state.policy.runningCeiling, EMPTY_STATE.policy.runningCeiling)
  assert.equal(state.policy.pauseAfterIdle, '1d')
  const text = await readFile(env.HARNESS_MONITOR_CONFIG, 'utf8')
  assert.match(text, /\/\/ Most engines running at once/, 'the file explains itself')
  assert.match(text, /hps pause --policy/, 'and says how to preview a change')
})

test('a rules file with a typo in it names the file it is in', async () => {
  const { env } = await machine()
  await mkdir(join(env.HARNESS_MONITOR_CONFIG, '..'), { recursive: true })
  await writeFile(env.HARNESS_MONITOR_CONFIG, '{ "pauseAfterIdle": "whenever" }')
  await assert.rejects(() => readState(null, env), /policy\.jsonc: Not a duration/)
  await writeFile(env.HARNESS_MONITOR_CONFIG, '{ "pauseAfterIdle": ')
  await assert.rejects(() => readState(null, env), /policy\.jsonc: not valid JSON/)
})

test('comments, trailing commas and slashes inside strings all survive the reader', () => {
  const text = `{
    // a comment
    "a": "http://example.com/x", /* another */
    "b": [1, 2,],
  }`
  assert.deepEqual(JSON.parse(stripJsonc(text)), { a: 'http://example.com/x', b: [1, 2] })
})

test('changing a value leaves every comment in the person\'s file exactly where it was', async () => {
  const { env } = await machine()
  await readState(null, env)
  const before = await readFile(env.HARNESS_MONITOR_CONFIG, 'utf8')
  await updateConfig({ pauseAfterIdle: '3d', runningCeiling: 30 }, env)
  const after = await readFile(env.HARNESS_MONITOR_CONFIG, 'utf8')
  assert.equal(after.split('//').length, before.split('//').length, 'no comment was lost')
  assert.match(after, /"pauseAfterIdle": "3d"/)
  assert.match(after, /"runningCeiling": 30/)
  assert.equal((await readState(null, env)).policy.pauseAfterIdle, '3d')
})

test('tickets and pins are written where the program keeps them, and read back', async () => {
  const { env } = await machine()
  const state = await readState(null, env)
  await writeState(null, { ...state, pins: ['a1'], paused: { a2: { sessionId: 'sess-0123456789ab', engine: 'claude' } } }, env)
  const back = await readState(null, env)
  assert.deepEqual(back.pins, ['a1'])
  assert.equal(back.paused.a2.sessionId, 'sess-0123456789ab')
  assert.match(await readFile(env.HARNESS_MONITOR_CONFIG, 'utf8'), /"pins": \["a1"\]/)
})

test('an old per-workspace file is carried forward once: its data yes, its stricter policy no', async () => {
  const { env } = await machine()
  const workspace = await mkdtemp(join(tmpdir(), 'hps-old-workspace-'))
  await writeFile(join(workspace, 'monitor.json'), JSON.stringify({
    policy: { pauseAfterIdle: '4h', runningCeiling: 12 },
    pins: ['keep-me'],
    paused: { p1: { sessionId: 'sess-0123456789ab', engine: 'claude' }, p2: { sessionId: 'sess-abcdef012345', engine: 'codex' } },
  }))
  const state = await readState(workspace, env)
  assert.equal(Object.keys(state.paused).length, 2, 'every paused harness is still resumable')
  assert.deepEqual(state.pins, ['keep-me'])
  assert.equal(state.policy.pauseAfterIdle, '1d', 'the old 4h did not come along')
  const marker = JSON.parse(await readFile(join(workspace, 'monitor.json'), 'utf8'))
  assert.equal(marker.migrated, true)
  const again = await readState(workspace, env)
  assert.equal(Object.keys(again.paused).length, 2, 'running it twice does not double anything')
})

test('pin and the resume ticket are the only edits, and each is reversible', () => {
  let state = { ...EMPTY_STATE }
  state = pin(state, 'a1', true)
  assert.deepEqual(state.pins, ['a1'])
  state = pin(state, 'a1', true)
  assert.deepEqual(state.pins, ['a1'], 'pinning twice is still one pin')
  state = markPaused(state, row(), { sessionId: 'sess-0123456789ab', engine: 'claude' })
  assert.equal(state.paused.a1.sessionId, 'sess-0123456789ab')
  state = clearPaused(state, 'a1')
  assert.equal(state.paused.a1, undefined)
  state = forget(markPaused(pin(state, 'a1', true), row(), { sessionId: 'sess-0123456789ab', engine: 'claude' }), 'a1')
  assert.deepEqual(state.pins, [])
  assert.equal(state.paused.a1, undefined)
})

test('every action leaves a receipt, newest first', async () => {
  const dir = await workspace()
  await record(dir, { action: 'pause', id: 'a1', name: 'widgets', ok: true, detail: 'engine stopped' })
  await record(dir, { action: 'resume', id: 'a1', name: 'widgets', ok: true, detail: 'resumed' })
  const log = await readLog(dir)
  assert.equal(log.length, 2)
  assert.equal(log[0].action, 'resume')
  assert.ok(log[0].at)
})

test('a log that cannot be written does not undo the action', async () => {
  await record('/nope/not/a/place', { action: 'pause', ok: true })
})

test('the pane header is ready only when the fleet is inside its policy', async () => {
  const dir = await workspace()
  const tidy = [row({ idleMs: 60_000 })]
  const tidyPlan = decide(tidy, { runningCeiling: 12 })
  const good = await writeVerdict(dir, { summary: { total: 1, running: 1, paused: 0, held: 0, needsInput: 0 }, rows: tidy, plan: tidyPlan.entries })
  assert.equal(good.ready, true)

  const messy = [row({ id: 'a', idleMs: 9 * DAY }), row({ id: 'b', idleMs: 40 * DAY })]
  const messyPlan = decide(messy, { runningCeiling: 12 })
  const bad = await writeVerdict(dir, { summary: { total: 2, running: 2, paused: 0, held: 8e8, needsInput: 1 }, rows: messy, plan: messyPlan.entries, problems: [{ machine: 'studio', error: 'asleep' }] })
  assert.equal(bad.ready, false)
  assert.ok(bad.findings.some((finding) => finding.kind === 'idle'))
  assert.ok(bad.findings.some((finding) => finding.kind === 'attention'))
  assert.ok(bad.findings.some((finding) => finding.kind === 'machine' && finding.severity === 'error'))
  assert.match(bad.summary, /held/)
})

test('bytes are reported in the units a header can fit', () => {
  assert.equal(gb(2 * 1024 ** 3), '2.0 GB')
  assert.equal(gb(400 * 1024 ** 2), '400 MB')
  assert.equal(gb(900), '1 KB')
})
