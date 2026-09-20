#!/usr/bin/env node
// count.mjs — count what Jev answered, so findings rest on one tested reader and not on a parser
// each agent writes by hand. It reads answers.csv in the workspace. It changes nothing.
//
//   node "$JEV_DSH/toolchain/count.mjs"                               every question: counts, shares, unsure cells
//   node … --by topic --and leaving                                    a cross-cut (rows: topic, columns: leaving)
//   node … --where topic=price --where leaving=going --rows 8          read the rows behind a number
//   node … --unsure topic --rows 10                                    the least sure rows of one question
//   node … --find "charged twice" --by topic                           a plain word search, cut by a question
//
// A column is named by its id in sheet.json ("topic"), by its name in answers.csv ("Topic"), or by
// the start of either. The file's own columns work too: --by platform, --where "stars<=2".
// Other flags: --file <answers.csv>  --below 0.65  --json
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseDelimited } from '../viewer/source.mjs'
import { parseHeader } from '../viewer/grammar.mjs'

const argv = process.argv.slice(2)
const flags = { where: [] }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--json') flags.json = true
  else if (a === '--where') flags.where.push(argv[++i])
  else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i]
  else die(`unknown argument "${a}". See the top of toolchain/count.mjs`)
}
function die(msg) { console.error(`count: ${msg}`); process.exit(2) }

const file = flags.file || join(process.env.HARNESS_WORKSPACE || '.', 'answers.csv')
if (!existsSync(file)) die(`${file} is not there yet. The viewer writes it once the sheet has rows`)
const table = parseDelimited(readFileSync(file, 'utf8').replace(/^﻿/, ''), ',')
if (table.length < 2) die('answers.csv has no rows yet')
const headers = table[0]
const rows = table.slice(1).map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])))
const ws = dirname(file)

// Questions are the columns that have a "<name> confidence" twin.
const questions = headers.filter((h) => headers.includes(`${h} confidence`))
// sheet.json gives each question a short id.
const idOf = new Map()
try {
  for (const c of JSON.parse(readFileSync(join(ws, 'sheet.json'), 'utf8')).columns ?? []) {
    const p = parseHeader(typeof c === 'string' ? c : c?.header, c && typeof c === 'object' ? c.id : undefined)
    if (p.ok && questions.includes(p.column.name)) idOf.set(p.column.id, p.column.name)
  }
} catch { /* columns typed in the pane have no id: use their name */ }
let below = Number(flags.below)
if (!(below >= 0 && below <= 1)) {
  try { below = Number(JSON.parse(readFileSync(join(ws, '.harness', 'verdict.json'), 'utf8')).sheet.reviewBelow) } catch { below = NaN }
  if (!(below >= 0 && below <= 1)) below = 0.65
}

/** A column of answers.csv from an id, a name, or the start of either. */
function column(key) {
  const k = String(key ?? '').trim().toLowerCase()
  if (!k) die('a column name is missing')
  if (idOf.has(k)) return idOf.get(k)
  const exact = headers.find((h) => h.toLowerCase() === k)
  if (exact) return exact
  const starts = [...new Set([...[...idOf].filter(([id]) => id.startsWith(k)).map(([, name]) => name), ...headers.filter((h) => h.toLowerCase().startsWith(k) && !h.endsWith(' confidence'))])]
  if (starts.length === 1) return starts[0]
  die(`${starts.length ? `"${key}" fits more than one column` : `no column called "${key}"`}. Questions: ${questions.map((q) => `${[...idOf].find(([, n]) => n === q)?.[0] ?? '-'} = "${q}"`).join(', ')}. File columns: ${headers.filter((h) => !questions.includes(h) && !h.endsWith(' confidence')).join(', ')}`)
}
const conf = (row, q) => Number(row[`${q} confidence`])
const answered = (row, q) => row[q] !== ''

// ---- filters ---------------------------------------------------------------------------------
const tests = flags.where.map((w) => {
  const m = String(w ?? '').match(/^(.*?)(<=|>=|!=|=|<|>)(.*)$/)
  if (!m) die(`--where wants column=value, got "${w}"`)
  const col = column(m[1]), op = m[2], want = m[3].trim()
  return (row) => {
    const have = String(row[col] ?? '').trim()
    if (op === '=') return have.toLowerCase() === want.toLowerCase()
    if (op === '!=') return have.toLowerCase() !== want.toLowerCase()
    const a = Number(have), b = Number(want)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false
    return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b
  }
})
const textCol = headers[1]
if (flags.find != null) { const needle = String(flags.find).toLowerCase(); tests.push((row) => String(row[textCol]).toLowerCase().includes(needle)) }
let picked = rows.filter((row) => tests.every((t) => t(row)))
const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : '-')

function tally(list, col) {
  const counts = new Map()
  for (const row of list) { const v = row[col] === '' ? '(no answer yet)' : row[col]; counts.set(v, (counts.get(v) ?? 0) + 1) }
  return [...counts].sort((a, b) => b[1] - a[1])
}
function print(lines) { console.log(lines.join('\n')) }
function grid(head, body) {
  const all = [head, ...body].map((r) => r.map(String))
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)))
  return all.map((r, n) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('   ') + (n === 0 ? '\n' + w.map((x) => '-'.repeat(x)).join('   ') : ''))
}

const out = { file, rows: rows.length, matched: picked.length, reviewBelow: below }
const said = []
if (tests.length) said.push(`${picked.length} of ${rows.length} rows match${flags.find != null ? ` (text holds "${flags.find}")` : ''}${flags.where.length ? ` where ${flags.where.join(' and ')}` : ''}  ·  ${pct(picked.length, rows.length)}`)

if (flags.unsure) {
  // The least sure rows of one question, least sure first.
  const q = column(flags.unsure)
  if (!questions.includes(q)) die(`"${q}" is not a Jev question`)
  picked = picked.filter((r) => answered(r, q) && conf(r, q) < below).sort((a, b) => conf(a, q) - conf(b, q))
  const n = Math.max(1, Number(flags.rows) || 10)
  said.push(`${picked.length} rows where "${q}" is under ${below}. The least sure ${Math.min(n, picked.length)}:`)
  out.unsure = picked.slice(0, n).map((r) => ({ row: Number(r.row), answer: r[q], confidence: conf(r, q), text: r[textCol] }))
  for (const r of out.unsure) said.push(`  row ${r.row}  ${r.answer} (${r.confidence.toFixed(2)})  ${r.text}`)
} else if (flags.by) {
  const a = column(flags.by)
  if (flags.and) {
    const b = column(flags.and)
    const bVals = tally(picked, b).map(([v]) => v)
    const body = tally(picked, a).map(([av, n]) => {
      const sub = picked.filter((r) => (r[a] === '' ? '(no answer yet)' : r[a]) === av)
      return [av, n, ...bVals.map((bv) => { const k = sub.filter((r) => (r[b] === '' ? '(no answer yet)' : r[b]) === bv).length; return `${k} (${pct(k, n)})` })]
    })
    said.push(`"${a}" by "${b}". Each share is of its row.`, ...grid([a, 'rows', ...bVals], body))
    out.cross = { rows: a, columns: b, values: bVals, table: body }
  } else {
    const body = tally(picked, a).map(([v, n]) => [v, n, pct(n, picked.length)])
    said.push(...grid([a, 'rows', 'share'], body))
    out.counts = { [a]: Object.fromEntries(body.map(([v, n]) => [v, n])) }
  }
} else if (!flags.rows) {
  // Every question: counts, shares, how sure.
  out.questions = {}
  for (const q of questions) {
    const done = picked.filter((r) => answered(r, q))
    const unsure = done.filter((r) => conf(r, q) < below).length
    const avg = done.length ? done.reduce((s, r) => s + conf(r, q), 0) / done.length : 0
    const id = [...idOf].find(([, n]) => n === q)?.[0]
    said.push('', `${q}${id ? `   [${id}]` : ''}   ·   ${done.length} of ${picked.length} rows answered   ·   ${unsure} under ${below} (${pct(unsure, done.length)})   ·   average confidence ${avg.toFixed(2)}`)
    const body = tally(done, q).map(([v, n]) => { const u = done.filter((r) => r[q] === v && conf(r, q) < below).length; return [`  ${v}`, n, pct(n, done.length), `${u} unsure`] })
    said.push(...grid(['  answer', 'rows', 'share', ''], body))
    out.questions[q] = { id: id ?? null, answered: done.length, unsure, averageConfidence: Number(avg.toFixed(3)), counts: Object.fromEntries(body.map(([v, n]) => [v.trim(), n])) }
  }
  if (!questions.length) said.push('No Jev question has answers yet.')
}
if (flags.rows && !flags.unsure) {
  // Rows to read, spread evenly over the matches so the first ten do not stand in for all of them.
  const n = Math.max(1, Number(flags.rows) || 10)
  const step = Math.max(1, picked.length / n)
  const sample = Array.from({ length: Math.min(n, picked.length) }, (_, i) => picked[Math.floor(i * step)])
  said.push('', `${sample.length} of the ${picked.length} matching rows, spread evenly:`)
  out.sample = sample.map((r) => ({ row: Number(r.row), text: r[textCol], answers: Object.fromEntries(questions.map((q) => [q, r[q]])) }))
  for (const r of sample) said.push(`  row ${r.row}  [${questions.map((q) => r[q]).join(' · ')}]  ${r[textCol]}`)
}
if (flags.json) console.log(JSON.stringify(out, null, 2)); else print(said.filter((l, i) => !(i === 0 && l === '')))
