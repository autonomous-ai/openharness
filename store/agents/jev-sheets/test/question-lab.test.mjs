import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createQuestionLab,
  selectTrialRows,
  trialAnswer,
  trialHash
} from '../viewer/question-lab.mjs'
import { parseHeader } from '../viewer/grammar.mjs'
import { questionForColumn } from '../viewer/questions.mjs'
import { toWire } from '../toolchain/jev.mjs'
import { startSheetsViewer } from '../viewer/viewer.mjs'
import { createServer } from 'node:http'
import { evaluate } from '../toolchain/jev.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const column = parseHeader('Urgent?').column
function makeSnapshot(n = 20) {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: `r${i + 1}`,
    n: i + 1,
    text:
      i % 2
        ? 'No rush, but I need a refund.'
        : 'The app is broken. Production is down now!',
    meta: { channel: 'support', account: `A${i}` }
  }))
  return {
    title: 'Original support fixture (fictional)',
    source: 'tickets.csv',
    context: 'Decide the next action for these support messages.',
    columns: [column],
    rows,
    order: rows.map((r) => r.id),
    confidences: {
      urgent: Object.fromEntries(rows.map((r, i) => [r.id, (i + 1) / (n + 1)]))
    },
    dataSha: trialHash(rows)
  }
}
function fresh(options = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'question-lab-'))
  let data = makeSnapshot(options.n || 20)
  const applied = []
  const lab = createQuestionLab({
    workspace,
    snapshot: () => data,
    apply: (trial) => {
      applied.push(trial)
      return { id: 'trial' }
    },
    ...options
  })
  const ctl = async (cmd, body = {}) => ({
    ok: true,
    ...(await lab.control(cmd, { token: lab.token, ...body }))
  })
  const start = async (header = 'Refund?', body = {}) => {
    const preview = await ctl('labPreview', {
      column: 'urgent',
      count: 10,
      ...body
    })
    assert.equal(preview.ok, true, preview.error)
    const started = await ctl('labStart', { draft: preview.draft.id, header })
    assert.equal(started.ok, true, started.error)
    return started.trial
  }
  const untilDone = async (id) => {
    for (let i = 0; i < 100; i++) {
      const res = await ctl('labGet', { id })
      if (res.trial.status !== 'running') return res.trial
      await sleep(5)
    }
    assert.fail('trial did not finish')
  }
  return {
    workspace,
    lab,
    ctl,
    start,
    untilDone,
    applied,
    data: () => data,
    change: (next) => {
      data = next
    }
  }
}

test('challenge selection pins a row, includes low-confidence rows and spreads the remainder without duplicates', () => {
  const s = makeSnapshot()
  const rows = selectTrialRows(s, column, { count: 10, pinned: ['r20'] })
  assert.equal(rows.length, 10)
  assert.equal(rows[0].id, 'r20')
  assert.equal(new Set(rows.map((r) => r.id)).size, 10)
  assert.deepEqual(
    rows.slice(1, 6).map((r) => r.id),
    ['r1', 'r2', 'r3', 'r4', 'r5']
  )
  assert.ok(
    rows.slice(6).every((r) => r.selectedBecause === 'spread across the sheet')
  )
  s.rows[0].text = 'changed'
  assert.notEqual(rows[1].text, s.rows[0].text)
})

test('visible selection respects filter/sort, supports a pin outside the filter and has explicit bounds', () => {
  const s = makeSnapshot()
  s.order = ['r8', 'r3', 'r9']
  assert.deepEqual(
    selectTrialRows(s, column, {
      count: 10,
      method: 'visible',
      pinned: ['r17']
    }).map((r) => r.id),
    ['r17', 'r8', 'r3', 'r9']
  )
  for (const count of [0, 41, -1, 2.5, NaN])
    assert.throws(() => selectTrialRows(s, column, { count }))
  assert.throws(() => selectTrialRows(s, column, { pinned: ['missing'] }))
  assert.throws(() => selectTrialRows(s, column, { pinned: ['r1', 'r1'] }))
  s.order = []
  assert.throws(() => selectTrialRows(s, column, { method: 'visible' }))
})

test('both typed questions use the same exact context, rows and native client; repeated start is idempotent', async () => {
  const v = fresh()
  try {
    const t = await v.start(
      'Action: refund = return a payment | fix = repair broken behavior'
    )
    const repeated = await v.ctl('labStart', {
      draft: t.id,
      header: t.candidate.header
    })
    assert.equal(repeated.trial.id, t.id)
    const trial = await v.untilDone(t.id)
    assert.equal(trial.status, 'complete')
    assert.equal(trial.calls, 10)
    assert.equal(trial.summary.answered, 10)
    assert.deepEqual(
      trial.questions,
      toWire({
        original: questionForColumn(column, v.data().context),
        candidate: questionForColumn(trial.candidate, v.data().context)
      })
    )
    for (const row of trial.rows) {
      assert.equal(row.provenance.client, 'mock')
      assert.match(row.provenance.model, /mock/)
      assert.ok(['yes', 'no'].includes(row.original.shown))
      assert.ok(['refund', 'fix'].includes(row.candidate.shown))
      assert.ok(row.candidate.answer.probabilities)
      assert.equal(row.truth, undefined)
    }
    assert.equal(
      (await v.ctl('labStart', { draft: t.id, header: 'Spam?' })).ok,
      false
    )
  } finally {
    v.lab.close()
  }
})

test('a preview freezes row text and context across file changes, and stale trials cannot apply', async () => {
  const v = fresh()
  try {
    const preview = await v.ctl('labPreview', { column: 'urgent', count: 3 })
    const original = structuredClone(preview.draft)
    const changed = makeSnapshot()
    changed.rows[0].text = 'new'
    changed.context = 'Changed context'
    changed.dataSha = trialHash(changed.rows)
    v.change(changed)
    const started = await v.ctl('labStart', {
      draft: original.id,
      header: 'Refund?'
    })
    const t = await v.untilDone(started.trial.id)
    assert.equal(t.context, original.context)
    assert.equal(t.rows[0].text, original.rows[0].text)
    assert.equal(t.stale, true)
    await v.ctl('labKeep', { id: t.id })
    const applied = await v.ctl('labApply', { id: t.id })
    assert.equal(applied.ok, false)
    assert.match(applied.error, /changed/)
    assert.equal(v.applied.length, 0)
  } finally {
    v.lab.close()
  }
})

test('review notes and exact artifacts survive restart and deletion of the source data; saved files are immutable', async () => {
  const v = fresh()
  let restarted
  try {
    const t = await v.untilDone((await v.start()).id)
    const note =
      '=HYPERLINK("https://example.test","not executed")\nA better action for this case.'
    await v.ctl('labReview', {
      id: t.id,
      row: t.rows[0].id,
      vote: 'candidate',
      note
    })
    const kept = await v.ctl('labKeep', { id: t.id })
    assert.equal(kept.ok, true)
    assert.equal(kept.trial.kept, true)
    const dir = join(v.workspace, '.harness/question-trials', t.id)
    const bytes = readFileSync(join(dir, 'trial.json'))
    assert.equal((await v.ctl('labKeep', { id: t.id })).trial.id, t.id)
    assert.deepEqual(readFileSync(join(dir, 'trial.json')), bytes)
    assert.equal(
      (
        await v.ctl('labReview', {
          id: t.id,
          row: t.rows[0].id,
          vote: 'original'
        })
      ).ok,
      false
    )
    const sheet = JSON.parse(readFileSync(join(dir, 'sheet.json')))
    assert.equal(sheet.rows.length, 10)
    assert.equal(sheet.context, t.context)
    assert.equal(sheet.demo, false)
    assert.ok(
      readFileSync(join(dir, 'comparison.csv'), 'utf8').includes("'=HYPERLINK")
    )
    assert.match(
      readFileSync(join(dir, 'review.md'), 'utf8'),
      /OFFLINE STAND-IN/
    )
    const checks = JSON.parse(readFileSync(join(dir, 'checksums.json')))
    for (const [name, hash] of Object.entries(checks))
      assert.equal(trialHash(readFileSync(join(dir, name), 'utf8')), hash)
    assert.equal(
      readFileSync(join(dir, 'trial.zip')).readUInt32LE(0),
      0x04034b50
    )
    v.lab.close()
    restarted = createQuestionLab({
      workspace: v.workspace,
      snapshot: () => ({
        ...makeSnapshot(),
        rows: [],
        columns: [],
        dataSha: 'gone'
      }),
      apply: () => {}
    })
    const reopened = await restarted.control('labGet', {
      token: restarted.token,
      id: t.id
    })
    assert.equal(reopened.trial.rows[0].review.note, note)
    assert.equal(reopened.trial.stale, true)
    assert.equal(
      (await restarted.control('labKeep', { token: restarted.token, id: t.id }))
        .trial.kept,
      true
    )
    assert.equal(Object.keys(restarted.downloads()).length, 1)
  } finally {
    v.lab.close()
    restarted?.close()
  }
})

test('cancel stops scheduling beyond the four in-flight native calls and preserves completed rows honestly', async () => {
  let release,
    started = 0
  const gate = new Promise((r) => {
    release = r
  })
  const v = fresh({
    evaluatePair: async () => {
      started++
      await gate
      return {
        client: 'test-fixture',
        model: 'controlled-contract',
        answers: { original: { noul: 0.1 }, candidate: { noul: 0.9 } },
        usage: { input_tokens: 27 },
        latencyMs: 4
      }
    }
  })
  try {
    const t = await v.start()
    assert.equal(started, 4)
    assert.equal((await v.ctl('labKeep', { id: t.id })).ok, false)
    const other = await v.ctl('labPreview', { column: 'urgent', count: 1 })
    assert.equal(
      (await v.ctl('labStart', { draft: other.draft.id, header: 'Spam?' })).ok,
      false
    )
    await v.ctl('labCancel', { id: t.id })
    release()
    const result = await v.untilDone(t.id)
    assert.equal(result.status, 'cancelled')
    assert.equal(started, 4)
    assert.equal(result.summary.answered, 4)
    assert.equal(result.summary.inputTokens, 108)
    assert.equal(result.rows.filter((r) => r.status === 'waiting').length, 6)
    assert.equal((await v.ctl('labKeep', { id: t.id })).ok, true)
    assert.equal((await v.ctl('labApply', { id: t.id })).ok, false)
  } finally {
    release()
    v.lab.close()
  }
})

test('invalid or failed provider responses stay failed, can be kept, and never turn into plausible answers', async () => {
  let i = 0
  const v = fresh({
    evaluatePair: async () => {
      if (i++ % 2) throw new Error('fixture provider unavailable')
      return { answers: { original: { noul: 1.2 }, candidate: { noul: 0.5 } } }
    }
  })
  try {
    const t = await v.untilDone((await v.start()).id)
    assert.equal(t.status, 'failed')
    assert.equal(t.summary.answered, 0)
    assert.equal(t.summary.errors, 10)
    assert.equal((await v.ctl('labKeep', { id: t.id })).ok, true)
    assert.equal((await v.ctl('labApply', { id: t.id })).ok, false)
  } finally {
    v.lab.close()
  }
})

test('archive write failures leave no partial packet and a retry can succeed', async () => {
  const { writeProjectZip } = await import('../viewer/trial-zip.mjs')
  let failWrite = true
  const v = fresh({
    writeZip: (...args) => {
      if (failWrite) throw new Error('fixture disk full')
      return writeProjectZip(...args)
    }
  })
  try {
    const t = await v.untilDone((await v.start()).id)
    assert.equal((await v.ctl('labKeep', { id: t.id })).ok, false)
    assert.deepEqual(
      readdirSync(join(v.workspace, '.harness/question-trials')),
      []
    )
    failWrite = false
    assert.equal((await v.ctl('labKeep', { id: t.id })).ok, true)
  } finally {
    v.lab.close()
  }
})

test('a page-scoped token, strict identifiers, bounded inputs and real directories protect new writes', async () => {
  const v = fresh()
  try {
    assert.equal(
      (await v.lab.control('labPreview', { column: 'urgent' })).code,
      'LAB_TOKEN'
    )
    assert.equal((await v.ctl('labGet', { id: '../sheet.json' })).ok, false)
    assert.equal(
      (await v.ctl('labPreview', { column: 'urgent', count: 41 })).ok,
      false
    )
    const preview = await v.ctl('labPreview', { column: 'urgent' })
    assert.equal(
      (await v.ctl('labStart', { draft: preview.draft.id, header: 'Urgent?' }))
        .ok,
      false
    )
    assert.equal(
      (
        await v.ctl('labStart', {
          draft: preview.draft.id,
          header: 'x'.repeat(20001)
        })
      ).ok,
      false
    )
    const t = await v.untilDone((await v.start()).id)
    assert.equal(
      (
        await v.ctl('labReview', {
          id: t.id,
          row: t.rows[0].id,
          vote: 'candidate',
          note: 'x'.repeat(801)
        })
      ).ok,
      false
    )
    const outside = mkdtempSync(join(tmpdir(), 'question-lab-outside-'))
    mkdirSync(join(v.workspace, '.harness'))
    symlinkSync(outside, join(v.workspace, '.harness/question-trials'))
    assert.equal((await v.ctl('labKeep', { id: t.id })).ok, false)
    assert.deepEqual(readdirSync(outside), [])
  } finally {
    v.lab.close()
  }
})

test('archive tampering and symlinked ZIP files cannot be reopened or downloaded', async () => {
  const v = fresh()
  try {
    const t = await v.untilDone((await v.start()).id)
    await v.ctl('labKeep', { id: t.id })
    const dir = join(v.workspace, '.harness/question-trials', t.id)
    rmSync(join(dir, 'trial.zip'))
    symlinkSync(join(dir, 'trial.json'), join(dir, 'trial.zip'))
    assert.equal(Object.keys(v.lab.downloads()).length, 0)
    writeFileSync(join(dir, 'trial.json'), '{}')
    assert.equal((await v.ctl('labList')).kept.length, 0)
    assert.equal(Object.keys(v.lab.downloads()).length, 0)
  } finally {
    v.lab.close()
  }
})

test('score and choice result validation rejects unsupported outputs', () => {
  const score = parseHeader('Mood: low < medium < high').column
  assert.equal(
    trialAnswer(score, { score: 1.2, confidence: 0.7 }).shown,
    'medium'
  )
  assert.throws(() => trialAnswer(score, { score: 9 }))
  assert.throws(() =>
    trialAnswer(parseHeader('Topic: a | b').column, { choice: 'c' })
  )
  assert.throws(() =>
    trialAnswer(column, { noul: 0.5, probabilities: { yes: NaN } })
  )
})

test('note and preference patches preserve each other, including an intentionally cleared note', async () => {
  const v = fresh()
  try {
    const t = await v.untilDone((await v.start()).id),
      row = t.rows[0].id
    await v.ctl('labReview', { id: t.id, row, vote: 'candidate' })
    await v.ctl('labReview', { id: t.id, row, note: 'Read this carefully.' })
    let reviewed = (await v.ctl('labGet', { id: t.id })).trial.rows[0].review
    assert.deepEqual(reviewed, {
      vote: 'candidate',
      note: 'Read this carefully.'
    })
    await v.ctl('labReview', { id: t.id, row, vote: 'unsure' })
    reviewed = (await v.ctl('labGet', { id: t.id })).trial.rows[0].review
    assert.equal(reviewed.note, 'Read this carefully.')
    await v.ctl('labReview', { id: t.id, row, note: '' })
    reviewed = (await v.ctl('labGet', { id: t.id })).trial.rows[0].review
    assert.deepEqual(reviewed, { vote: 'unsure', note: '' })
  } finally {
    v.lab.close()
  }
})

test('authentication or exhausted-credit errors stop further rows after the bounded in-flight batch', async () => {
  let calls = 0
  const v = fresh({
    evaluatePair: async () => {
      calls++
      throw Object.assign(new Error('fixture account out of credit'), {
        status: 402
      })
    }
  })
  try {
    const t = await v.untilDone((await v.start()).id)
    assert.equal(calls, 4)
    assert.equal(t.status, 'failed')
    assert.match(t.haltReason, /out of credit/)
    assert.equal(t.rows.filter((r) => r.status === 'waiting').length, 6)
    assert.equal((await v.ctl('labKeep', { id: t.id })).ok, true)
  } finally {
    v.lab.close()
  }
})

test('the production HTTP client sends paired wire questions and preserves returned probabilities and usage', async () => {
  // Only a local protocol fixture is used. The explicit dummy key and isolated empty credential
  // file prevent any external API or user credential from being involved.
  const requests = []
  const server = createServer(async (req, res) => {
    let data = ''
    for await (const chunk of req) data += chunk
    requests.push(JSON.parse(data))
    assert.equal(
      req.headers.authorization,
      'Bearer question-lab-protocol-fixture'
    )
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        model: 'fixture-model-not-live-jev',
        usage: { input_tokens: 83 },
        answers: {
          original: { noul: 0.42 },
          candidate: { probabilities: { refund: 0.72, fix: 0.28 } }
        }
      })
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const oldUrl = process.env.TYPESAFE_API_URL,
    oldFile = process.env.TYPESAFE_CREDENTIALS
  const empty = mkdtempSync(join(tmpdir(), 'question-lab-creds-'))
  process.env.TYPESAFE_API_URL = `http://127.0.0.1:${server.address().port}/fixture`
  process.env.TYPESAFE_CREDENTIALS = join(empty, 'not-present')
  const v = fresh({
    evaluatePair: (options) =>
      evaluate({ ...options, key: 'question-lab-protocol-fixture' })
  })
  try {
    const t = await v.untilDone(
      (
        await v.start(
          'Action: refund = return a payment | fix = repair a fault',
          { count: 3 }
        )
      ).id
    )
    assert.equal(t.status, 'complete')
    assert.equal(requests.length, 3)
    assert.deepEqual(requests[0].questions, t.questions)
    assert.deepEqual(requests[0].state, {
      text: t.rows[0].text,
      ...t.rows[0].meta
    })
    for (const row of t.rows) {
      assert.equal(row.original.answer.noul, 0.42)
      assert.equal(row.candidate.shown, 'refund')
      assert.equal(row.candidate.confidence, 0.72)
      assert.equal(row.provenance.usage.input_tokens, 83)
      assert.equal(row.provenance.model, 'fixture-model-not-live-jev')
    }
    assert.equal(t.summary.inputTokens, 249)
  } finally {
    v.lab.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    if (oldUrl === undefined) delete process.env.TYPESAFE_API_URL
    else process.env.TYPESAFE_API_URL = oldUrl
    if (oldFile === undefined) delete process.env.TYPESAFE_CREDENTIALS
    else process.env.TYPESAFE_CREDENTIALS = oldFile
  }
})

test('real sheet integration caches candidate results, keeps the original, exports them, and refuses stale application', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'question-lab-viewer-')),
    data = makeSnapshot(12)
  writeFileSync(
    join(ws, 'sheet.json'),
    JSON.stringify({
      title: data.title,
      context: data.context,
      demo: false,
      columns: ['Urgent?'],
      rows: data.rows.map((r) => ({ id: r.id, text: r.text, ...r.meta }))
    })
  )
  let viewer = await startSheetsViewer({ workspace: ws, autostart: false })
  try {
    const state = async () => (await fetch(viewer.url + '/state')).json()
    let token = (await state()).questionLabToken
    const ctl = async (cmd, body = {}) =>
      (
        await fetch(viewer.url + '/control', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cmd, token, ...body })
        })
      ).json()
    await ctl('drain')
    const before = await state(),
      p = await ctl('labPreview', { column: 'urgent', count: 10 })
    let t = (
      await ctl('labStart', {
        draft: p.draft.id,
        header: 'Urgent: low < medium < high'
      })
    ).trial
    while (t.status === 'running') t = (await ctl('labGet', { id: t.id })).trial
    await ctl('labKeep', { id: t.id })
    const applied = await ctl('labApply', { id: t.id })
    assert.equal(applied.ok, true)
    assert.equal(applied.applied.reused, 10)
    assert.equal(
      (await ctl('labApply', { id: t.id })).applied.alreadyApplied,
      true
    )
    await ctl('drain')
    const after = await state()
    assert.equal(after.columns.length, 2)
    assert.equal(after.columns[0].header, 'Urgent?')
    assert.equal(
      after.stats.calls - before.stats.calls,
      2,
      'only the two untested rows need new sheet calls'
    )
    assert.equal(
      JSON.parse(readFileSync(join(ws, 'sheet.json'))).columns.length,
      2,
      'the chosen question is saved alongside the original'
    )
    assert.equal(
      (await fetch(viewer.url + `/download/question-trial-${t.id}.zip`)).status,
      200
    )
    assert.match(
      await (await fetch(viewer.url + '/download/answers.csv')).text(),
      /Urgent.*Urgent/s
    )
    assert.equal(applied.applied.persisted, true)
    await ctl('reset')
    assert.equal((await state()).columns.length, 2, 'an immediate reset retains the question')
    await viewer.close()
    viewer = await startSheetsViewer({ workspace: ws, autostart: false })
    token = (await state()).questionLabToken
    assert.equal((await state()).columns.length, 2, 'the question survives a process restart')
    assert.equal((await ctl('labApply', { id: t.id })).applied.alreadyApplied, true)
    assert.equal(JSON.parse(readFileSync(join(ws, 'sheet.json'))).columns.length, 2)
    await ctl('editRow', { id: 'r12', text: 'Different message' })
    assert.equal((await ctl('labApply', { id: t.id })).ok, false)
    assert.equal(
      (await ctl('labGet', { id: t.id, token: 'wrong' })).code,
      'LAB_TOKEN'
    )
    assert.equal(
      (
        await fetch(viewer.url + '/control', {
          method: 'POST',
          headers: { Origin: 'https://example.test' },
          body: '{}'
        })
      ).status,
      403
    )
  } finally {
    await viewer.close()
  }
})
