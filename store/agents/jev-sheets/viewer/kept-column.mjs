import { lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeSheet, parseHeader, columnKey, LIMITS } from './grammar.mjs'
import { loadSource } from './source.mjs'
import { trialHash } from './question-lab.mjs'

// Read the actual project, not the watcher's last notification. An agent can save
// between the last preview and this click. Merge only a new question into that file.
export function keepTrialColumn(workspace, trial, liveColumns) {
  const file = join(workspace, 'sheet.json')
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error('Keep questions in a regular sheet.json inside this project.')
  const before = readFileSync(file, 'utf8')
  const raw = JSON.parse(before)
  let expanded = raw, source = null
  if (typeof raw?.source === 'string' && raw.source.trim()) {
    const loaded = loadSource(workspace, raw.source.trim(), { textColumn: raw.textColumn, limit: LIMITS.maxRows })
    if (loaded.error) throw Error(loaded.error)
    source = loaded.info.name
    expanded = { ...raw, rows: [...(Array.isArray(raw.rows) ? raw.rows : []), ...loaded.rows] }
  }
  const normalized = normalizeSheet(expanded)
  if (normalized.errors.length) throw Error(`Fix sheet.json before keeping a question: ${normalized.errors[0]}`)
  if (normalized.offline !== !!trial.offline)
    throw Error('The project switched between practice and live mode. Preview a new trial before keeping its wording.')
  const rows = normalized.rows.map((r, i) => ({ id: r.id, n: i + 1, text: r.text, meta: r.meta }))
  if (trialHash({ context: normalized.context, source, rows }) !== trial.datasetSha)
    throw Error('The project rows or context changed. Preview a new trial before keeping its wording.')
  const original = normalized.columns.find((c) => c.id === trial.original.id)
  if ((original && columnKey(original) !== columnKey(trial.original)) || (!original && trial.original.source === 'file'))
    throw Error('The original question changed in sheet.json. Preview a new trial before keeping its wording.')

  const candidate = parseHeader(trial.candidate.header)
  if (!candidate.ok) throw Error(candidate.error)
  const saved = (raw.columns || []).find((c) => c?.questionTrial === trial.id)
  if (saved) {
    const parsed = parseHeader(saved.header, saved.id)
    if (!parsed.ok || columnKey(parsed.column) !== columnKey(candidate.column))
      throw Error('This saved question was edited. Keep that edit and start a new trial.')
    return { raw, id: parsed.column.id, alreadyApplied: true }
  }
  const occupied = new Set([...normalized.columns, ...liveColumns].map((c) => c.id))
  if (occupied.size >= LIMITS.maxColumns)
    throw Error('This sheet has 12 columns. Remove one from sheet.json before keeping another.')
  let id = candidate.column.id, suffix = 2
  while (occupied.has(id)) id = `${candidate.column.id.slice(0, 24)}_v${suffix++}`
  const next = { ...raw, columns: [...(raw.columns || []), { id, header: candidate.column.header, questionTrial: trial.id }] }
  const temporary = join(workspace, `.sheet-questions-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: stat.mode & 0o777 })
    if (lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== before)
      throw Error('sheet.json changed while saving. Try again after the latest edit loads.')
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
  return { raw: next, id, alreadyApplied: false }
}
