// A bounded pairwise question trial. Rows and context are frozen before any model call.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { evaluate, toWire } from '../toolchain/jev.mjs'
import { parseHeader, columnKey, confidenceOf, levelOf } from './grammar.mjs'
import { questionForColumn } from './questions.mjs'
import { sheetMock } from './mock.mjs'
import { writeProjectZip } from './trial-zip.mjs'

export const TRIAL_LIMITS = {
  rows: 40,
  header: 4000,
  bytes: 2 * 1024 * 1024,
  active: 8,
  concurrency: 4
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const terminal = (trial) =>
  ['complete', 'cancelled', 'failed'].includes(trial.status)
const clone = (v) => JSON.parse(JSON.stringify(v))
export const trialHash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
const fail = (message) => {
  throw new Error(message)
}
const bounded = (value, max, label) => {
  if (typeof value !== 'string' || value.length > max)
    fail(`${label} must be text of at most ${max} characters`)
  return value.trim()
}
const csv = (value) => {
  let s = String(value ?? '')
  if (/^[=+@\-\t\r]/.test(s)) s = `'${s}`
  return `"${s.replaceAll('"', '""')}"`
}
const rowState = (row) => ({ text: row.text, ...row.meta })

export function trialAnswer(column, answer) {
  if (!answer || answer.ok === false)
    fail('Jev did not return an answer for both questions')
  let shown
  if (column.type === 'noul') {
    if (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
      fail('Invalid yes/no probability')
    shown = answer.noul >= 0.5 ? 'yes' : 'no'
  } else if (column.type === 'choice') {
    if (!column.options.includes(answer.choice))
      fail('Jev returned an option outside the question')
    shown = answer.choice
  } else {
    if (
      !Number.isFinite(answer.score) ||
      answer.score < 0 ||
      answer.score > column.levels.length - 1
    )
      fail('Jev returned a score outside the scale')
    shown = column.levels[levelOf(column, answer)]
  }
  const confidence = confidenceOf(column, answer)
  if (!Number.isFinite(confidence)) fail('Jev returned invalid confidence')
  if (
    answer.probabilities &&
    Object.values(answer.probabilities).some(
      (p) => !Number.isFinite(p) || p < 0 || p > 1
    )
  )
    fail('Jev returned invalid probabilities')
  return { shown, confidence, answer: clone(answer) }
}

// Half the challenge sample is the least certain answered rows; half is spread across the rest.
// This deliberately selected set is not a random sample and does not estimate sheet-wide quality.
export function selectTrialRows(
  snapshot,
  column,
  { count = 10, method = 'challenge', pinned = [] } = {}
) {
  if (!Number.isInteger(count) || count < 1 || count > TRIAL_LIMITS.rows)
    fail('Choose 1–40 rows')
  if (!['challenge', 'spread', 'visible'].includes(method))
    fail('Choose challenge, spread or visible rows')
  if (
    !Array.isArray(pinned) ||
    pinned.length > count ||
    new Set(pinned).size !== pinned.length
  )
    fail('Pinned rows must be unique and fit in the sample')
  const byId = new Map(snapshot.rows.map((row) => [row.id, row]))
  if (pinned.some((id) => !byId.has(id)))
    fail('A pinned row is no longer in the sheet')
  const chosen = pinned.map((id) => ({
    ...byId.get(id),
    selectedBecause: 'pinned by you'
  }))
  const ids = new Set(pinned)
  const add = (row, reason) => {
    if (row && !ids.has(row.id) && chosen.length < count) {
      ids.add(row.id)
      chosen.push({ ...row, selectedBecause: reason })
    }
  }
  if (method === 'challenge') {
    const weak = snapshot.rows
      .filter((row) =>
        Number.isFinite(snapshot.confidences?.[column.id]?.[row.id])
      )
      .sort(
        (a, b) =>
          snapshot.confidences[column.id][a.id] -
            snapshot.confidences[column.id][b.id] || a.n - b.n
      )
    let left = Math.ceil(
      (Math.min(count, snapshot.rows.length) - chosen.length) / 2
    )
    for (const row of weak) {
      if (!left) break
      if (!ids.has(row.id)) {
        add(row, 'low confidence in the current sheet')
        left--
      }
    }
  }
  const pool = (
    method === 'visible'
      ? snapshot.order.map((id) => byId.get(id)).filter(Boolean)
      : snapshot.rows
  ).filter((row) => !ids.has(row.id))
  const remaining = Math.min(count - chosen.length, pool.length)
  for (let i = 0; i < remaining; i++) {
    const index =
      method === 'visible'
        ? i
        : Math.floor(((i + 0.5) * pool.length) / remaining)
    add(
      pool[index],
      method === 'visible'
        ? 'first rows in the current view'
        : 'spread across the sheet'
    )
  }
  if (!chosen.length) fail('There are no rows in this view')
  return clone(chosen)
}

function summary(trial) {
  const answered = trial.rows.filter((row) => row.original && row.candidate)
  const votes = { original: 0, candidate: 0, unsure: 0 }
  for (const row of trial.rows) if (row.review?.vote) votes[row.review.vote]++
  return {
    total: trial.rows.length,
    answered: answered.length,
    changed: answered.filter(
      (row) => row.original.shown !== row.candidate.shown
    ).length,
    errors: trial.rows.filter((row) => row.error).length,
    calls: trial.calls,
    votes,
    providers: [...new Set(answered.map((row) => row.provenance.client))],
    inputTokens: answered.reduce(
      (n, row) => n + (Number(row.provenance.usage?.input_tokens) || 0),
      0
    )
  }
}

function safeDirectory(parent, name, create = false) {
  const path = join(parent, name)
  if (!existsSync(path)) {
    if (!create) return null
    mkdirSync(path, { mode: 0o700 })
  }
  const stat = lstatSync(path)
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    realpathSync(path) !== path
  )
    fail('Question Lab folders must be real workspace directories')
  return path
}
function safeFile(dir, name, max = TRIAL_LIMITS.bytes) {
  const path = join(dir, name),
    stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    fail('The saved trial file is unavailable or too large')
  return path
}
const description =
  'Both questions were asked again on the same frozen rows, together in one call per row. The selected rows are not a random sample. Changed answers and higher confidence do not establish accuracy. Human preferences are subjective review notes, not ground truth.'

function filesFor(trial) {
  const rows = trial.rows.map((r) => ({ ...r.meta, id: r.id, text: r.text }))
  const sheet = {
    title: `${trial.title} · frozen trial`,
    description,
    context: trial.context,
    demo: false,
    columns: [
      { id: 'original', header: trial.original.header },
      { id: 'candidate', header: trial.candidate.header }
    ],
    rows
  }
  const lines = [
    [
      'row',
      'text',
      'original',
      'original_confidence',
      'candidate',
      'candidate_confidence',
      'changed',
      'your_preference',
      'your_note',
      'provider',
      'model',
      'error'
    ]
  ]
  for (const row of trial.rows)
    lines.push([
      row.id,
      row.text,
      row.original?.shown,
      row.original?.confidence,
      row.candidate?.shown,
      row.candidate?.confidence,
      row.original && row.candidate
        ? row.original.shown !== row.candidate.shown
        : '',
      row.review?.vote,
      row.review?.note,
      row.provenance?.client,
      row.provenance?.model,
      row.error
    ])
  const mock =
    trial.summary.providers.includes('mock') || !trial.summary.answered
  const report = [
    `# ${trial.title}`,
    '',
    mock
      ? '**OFFLINE STAND-IN / INCOMPLETE: do not use these as research findings.**'
      : `Provider: ${trial.summary.providers.join(', ')}`,
    '',
    `Original: ${trial.original.header}`,
    '',
    `New wording: ${trial.candidate.header}`,
    '',
    `Context: ${trial.context || '(none)'}`,
    '',
    `${trial.summary.answered}/${trial.summary.total} rows answered; ${trial.summary.changed} answer labels changed. ${trial.summary.errors} failed rows. Status: ${trial.status}.`,
    '',
    `Your preferences: original ${trial.summary.votes.original}; new wording ${trial.summary.votes.candidate}; unsure ${trial.summary.votes.unsure}.`,
    '',
    description,
    '',
    `Selection: ${trial.selection.method}. Source: ${trial.source || 'inline rows'}. Dataset SHA-256: ${trial.datasetSha}.`,
    '',
    trial.note || '',
    '',
    '## Row review',
    ''
  ]
  for (const row of trial.rows)
    report.push(
      `### Row ${row.n} (${row.id})`,
      '',
      row.text,
      '',
      row.error
        ? `Error: ${row.error}`
        : `Original: ${row.original?.shown ?? 'not answered'} → New: ${row.candidate?.shown ?? 'not answered'}`,
      '',
      `Preference: ${row.review?.vote ?? 'not reviewed'}. ${row.review?.note ?? ''}`,
      ''
    )
  return {
    'trial.json': JSON.stringify(trial, null, 2) + '\n',
    'sheet.json': JSON.stringify(sheet, null, 2) + '\n',
    'column.json':
      JSON.stringify({ header: trial.candidate.header }, null, 2) + '\n',
    'comparison.csv':
      lines.map((line) => line.map(csv).join(',')).join('\r\n') + '\r\n',
    'review.md': report.join('\n'),
    'README.md': `# Question Lab trial\n\n${description}\n\nThis folder contains the exact sampled text and metadata. Keep it wherever you would keep the original data. No API keys are included.\n\n- trial.json: exact questions sent, raw answers, per-call provider/model/usage, frozen rows and your notes.\n- comparison.csv: answers and preferences, safe to open as a spreadsheet.\n- review.md: readable review.\n- sheet.json: the frozen sample with both headers. Copy it into a separate Jev Sheets workspace to ask the questions again. Live runs can produce different answers. With no key, the viewer explicitly uses its offline stand-in.\n- column.json: the candidate column definition; an agent can add it to the original sheet.json after you decide.\n- checksums.json: SHA-256 hashes of the files in this packet.\n\nKeeping a trial does not change the source file. “Use on whole sheet” saves the chosen wording as a separate question in the original sheet.json, preserving the original question and data. Repeated use of the same kept trial does not duplicate the question. The chosen wording and kept trial survive restart; answers are recomputed in a new viewer session.\n\nSelected ${trial.rows.length} of ${trial.population} rows using ${trial.selection.method}. ${mock ? 'OFFLINE STAND-IN / INCOMPLETE: these results are not model validation or research findings.' : 'No automatic claim of accuracy is made.'}\n`
  }
}

export function createQuestionLab({
  workspace,
  snapshot,
  apply,
  evaluatePair = evaluate,
  notify = () => {},
  writeZip = writeProjectZip
}) {
  const token = randomUUID(),
    drafts = new Map(),
    jobs = new Map()
  let closed = false,
    active = null
  const rootWorkspace = realpathSync(workspace)
  const archiveRoot = (create = false) => {
    const harness = safeDirectory(rootWorkspace, '.harness', create)
    return harness ? safeDirectory(harness, 'question-trials', create) : null
  }
  const stale = (trial) => {
    const now = snapshot(),
      column = now.columns.find((c) => c.id === trial.original.id)
    return (
      !!now.invalid ||
      now.dataSha !== trial.datasetSha ||
      !column ||
      columnKey(column) !== columnKey(trial.original)
    )
  }
  const view = (trial) => ({
    ...clone(trial),
    summary: summary(trial),
    stale: stale(trial)
  })
  const emit = (trial) => {
    notify({ id: trial.id, status: trial.status, ...summary(trial) })
  }
  const read = (id) => {
    if (!UUID.test(id)) fail('Invalid trial identifier')
    const root = archiveRoot(),
      dir = root && safeDirectory(root, id)
    if (!dir) fail('This kept trial is unavailable')
    const body = readFileSync(safeFile(dir, 'trial.json'), 'utf8')
    const checks = JSON.parse(
      readFileSync(safeFile(dir, 'checksums.json', 32768), 'utf8')
    )
    if (checks['trial.json'] !== trialHash(body))
      fail('The kept trial was changed on disk')
    const trial = JSON.parse(body)
    if (
      trial.spec !== 'jev-question-trial/1' ||
      trial.id !== id ||
      !terminal(trial) ||
      !Array.isArray(trial.rows) ||
      trial.rows.length > TRIAL_LIMITS.rows
    )
      fail('Invalid kept trial')
    return { ...trial, kept: true }
  }
  const get = (id) => jobs.get(id) || read(id)
  const list = () => {
    const root = archiveRoot()
    if (!root) return []
    return readdirSync(root)
      .filter((id) => UUID.test(id))
      .slice(-100)
      .flatMap((id) => {
        try {
          const t = read(id)
          return [
            {
              id,
              title: t.title,
              createdAt: t.createdAt,
              candidate: t.candidate.header,
              status: t.status,
              summary: summary(t)
            }
          ]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async function run(trial) {
    const columns = { original: trial.original, candidate: trial.candidate }
    const questions = Object.fromEntries(
      Object.entries(columns).map(([id, col]) => [
        id,
        questionForColumn(col, trial.context)
      ])
    )
    const mock = sheetMock((id) => columns[id])
    let next = 0
    const worker = async () => {
      while (
        !trial.cancelRequested &&
        !trial.haltReason &&
        !closed &&
        next < trial.rows.length
      ) {
        const row = trial.rows[next++]
        row.status = 'asking'
        trial.calls++
        emit(trial)
        try {
          const result = await evaluatePair({
            state: rowState(row),
            questions,
            mock,
            salt: 1,
            model: trial.requestedModel
          })
          const original = trialAnswer(trial.original, result.answers?.original)
          const candidate = trialAnswer(
            trial.candidate,
            result.answers?.candidate
          )
          const provenance = {
            client: result.client,
            model: result.model,
            latencyMs: result.latencyMs,
            usage: clone(result.usage || {}),
            at: new Date().toISOString()
          }
          if (
            Buffer.byteLength(
              JSON.stringify({ original, candidate, provenance }, null, 2)
            ) >
            24 * 1024
          )
            fail('This paired response exceeds the 24 KB trial row limit')
          Object.assign(row, { original, candidate, provenance })
          row.status = 'answered'
        } catch (error) {
          row.error = String(error.message || error).slice(0, 300)
          row.status = 'error'
          if ([401, 402, 403].includes(error.status))
            trial.haltReason = row.error
        }
        emit(trial)
      }
    }
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(TRIAL_LIMITS.concurrency, trial.rows.length) },
          worker
        )
      )
      trial.status =
        trial.cancelRequested || closed
          ? 'cancelled'
          : trial.rows.some((r) => r.error)
            ? 'failed'
            : 'complete'
    } catch {
      trial.status = 'failed'
    }
    trial.finishedAt = new Date().toISOString()
    if (active === trial) active = null
    emit(trial)
  }
  function keep(trial) {
    if (!terminal(trial))
      fail('Wait for the trial to finish or cancel it before keeping it')
    if (trial.kept) return view(trial)
    const root = archiveRoot(true)
    if (existsSync(join(root, trial.id))) {
      const saved = read(trial.id)
      jobs.set(saved.id, saved)
      return view(saved)
    }
    if (readdirSync(root).filter((id) => UUID.test(id)).length >= 100)
      fail(
        'This workspace has 100 kept trials. Move some packets out before keeping another.'
      )
    const saved = {
      ...clone(trial),
      kept: true,
      summary: summary(trial),
      keptAt: new Date().toISOString()
    }
    const files = filesFor(saved)
    const total = Object.values(files).reduce(
      (n, content) => n + Buffer.byteLength(content),
      0
    )
    if (total > TRIAL_LIMITS.bytes * 4)
      fail('This trial exceeds the 8 MB archive limit')
    if (Buffer.byteLength(files['trial.json']) > TRIAL_LIMITS.bytes)
      fail('This trial exceeds the 2 MB result limit')
    const temp = mkdtempSync(join(root, '.pending-'))
    try {
      for (const [name, content] of Object.entries(files))
        writeFileSync(join(temp, name), content, { flag: 'wx', mode: 0o600 })
      writeFileSync(
        join(temp, 'checksums.json'),
        JSON.stringify(
          Object.fromEntries(
            Object.entries(files).map(([name, content]) => [
              name,
              trialHash(content)
            ])
          ),
          null,
          2
        ) + '\n',
        { flag: 'wx', mode: 0o600 }
      )
      writeZip(temp, join(temp, 'trial.zip'))
      renameSync(temp, join(root, trial.id))
    } catch (error) {
      rmSync(temp, { recursive: true, force: true })
      throw error
    }
    Object.assign(trial, saved)
    return view(trial)
  }
  async function control(cmd, body) {
    if (body.token !== token)
      return {
        ok: false,
        code: 'LAB_TOKEN',
        error: 'The viewer restarted. Refresh Question Lab and retry.'
      }
    try {
      if (closed) fail('The viewer is closing')
      if (cmd === 'labPreview') {
        const now = snapshot(true),
          column = now.columns.find((c) => c.id === body.column)
        if (!column) fail('Choose a current question to compare')
        if (column.header.length > TRIAL_LIMITS.header)
          fail('Question Lab supports headers up to 4,000 characters')
        const rows = selectTrialRows(now, column, body)
        const draft = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          title: now.title,
          source: now.source,
          context: now.context,
          original: clone(column),
          rows,
          datasetSha: now.dataSha,
          population: now.rows.length,
          selection: {
            method: body.method || 'challenge',
            requested: body.count || 10,
            pinned: body.pinned || []
          }
        }
        if (
          Buffer.byteLength(JSON.stringify(draft, null, 2)) >
          TRIAL_LIMITS.bytes / 4
        )
          fail('These rows contain too much metadata; select fewer rows')
        if (drafts.size >= TRIAL_LIMITS.active)
          drafts.delete(drafts.keys().next().value)
        drafts.set(draft.id, draft)
        return { draft }
      }
      if (cmd === 'labStart') {
        const previous = jobs.get(body.draft)
        if (previous) {
          if (
            previous.candidate.header !==
            parseHeader(body.header).column?.header
          )
            fail('This preview already started a different trial')
          return { trial: view(previous) }
        }
        if (active)
          fail('One trial is already running. Finish or cancel it first.')
        const draft = drafts.get(body.draft)
        if (!draft) fail('Preview the rows again before starting a trial')
        const parsed = parseHeader(body.header, 'candidate')
        if (!parsed.ok) fail(parsed.error)
        if (parsed.column.header.length > TRIAL_LIMITS.header)
          fail('Question Lab supports headers up to 4,000 characters')
        if (columnKey(parsed.column) === columnKey(draft.original))
          fail('Change the wording before comparing it')
        for (const [id, job] of jobs) if (job.kept) jobs.delete(id)
        if (jobs.size >= TRIAL_LIMITS.active)
          fail('Keep one of your eight open trials before starting another')
        const trial = {
          ...clone(draft),
          spec: 'jev-question-trial/1',
          status: 'running',
          candidate: parsed.column,
          requestedModel: process.env.JEV_MODEL || 'jev-latest',
          note: '',
          calls: 0,
          kept: false,
          questions: toWire({
            original: questionForColumn(draft.original, draft.context),
            candidate: questionForColumn(parsed.column, draft.context)
          }),
          rows: draft.rows.map((row) => ({ ...clone(row), status: 'waiting' }))
        }
        drafts.delete(draft.id)
        jobs.set(trial.id, trial)
        active = trial
        void run(trial)
        return { trial: view(trial) }
      }
      if (cmd === 'labList')
        return {
          kept: list(),
          open: [...jobs.values()]
            .filter((t) => !t.kept)
            .map((t) => ({
              id: t.id,
              title: t.title,
              candidate: t.candidate.header,
              status: t.status,
              summary: summary(t),
              createdAt: t.createdAt
            }))
        }
      const trial = get(String(body.id || ''))
      if (cmd === 'labGet') return { trial: view(trial) }
      if (cmd === 'labCancel') {
        if (!terminal(trial)) {
          trial.cancelRequested = true
          emit(trial)
        }
        return { trial: view(trial) }
      }
      if (cmd === 'labKeep') return { trial: keep(trial) }
      if (cmd === 'labReview') {
        if (trial.kept)
          fail(
            'A kept trial is immutable. Start another trial to record a new review.'
          )
        if (body.row != null) {
          const row = trial.rows.find((r) => r.id === body.row)
          if (!row || !row.original || !row.candidate)
            fail('Review a row with both answers')
          if (
            body.vote !== undefined &&
            ![null, 'original', 'candidate', 'unsure'].includes(body.vote)
          )
            fail('Choose original, new wording or unsure')
          row.review = {
            vote:
              body.vote === undefined ? (row.review?.vote ?? null) : body.vote,
            note:
              body.note === undefined
                ? (row.review?.note ?? '')
                : bounded(body.note, 800, 'Row note')
          }
        }
        if (body.title != null)
          trial.title =
            bounded(body.title, 120, 'Trial title') || 'Question trial'
        if (body.note != null && body.row == null)
          trial.note = bounded(body.note, 2000, 'Trial note')
        return { trial: view(trial) }
      }
      if (cmd === 'labApply') {
        if (!trial.kept)
          fail('Keep this trial before trying it on the whole sheet')
        if (trial.status !== 'complete')
          fail('Only a complete trial can be tried on the whole sheet')
        if (stale(trial))
          fail(
            'The rows, context or original question changed. Preview a new trial on the current sheet.'
          )
        const result = apply(clone(trial))
        if (result?.ok === false) return result
        return { applied: result }
      }
      fail('Unknown Question Lab command')
    } catch (error) {
      return { ok: false, error: String(error.message || error).slice(0, 500) }
    }
  }
  function downloads() {
    const out = {}
    let kept
    try {
      kept = list()
    } catch {
      return out
    }
    for (const trial of kept) {
      try {
        const dir = safeDirectory(archiveRoot(), trial.id)
        out[`question-trial-${trial.id}.zip`] = safeFile(
          dir,
          'trial.zip',
          TRIAL_LIMITS.bytes * 5
        )
      } catch {
        /* an unavailable archive is never served */
      }
    }
    return out
  }
  return {
    token,
    control,
    downloads,
    close() {
      closed = true
      if (active) active.cancelRequested = true
    }
  }
}
