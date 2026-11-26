import { closeSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The machine the rows were made on, passed in so a spec can choose it. */
export interface Who { home: string; user: string; host: string }

type Row = Record<string, unknown>

const ROW_FILES = ['results.jsonl', 'errors.jsonl', 'probes.jsonl']
const PRIVATE_FILE = 'private.jsonl'

/** The row as it may leave the Mac. The judge's reasons and an error's message are model and tool text: scrub took the
 *  run root, $HOME and the user name out of them, but whatever else the agent or a tool printed is still in there. */
export function publicRow(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'error')
    .map(([key, value]) => [key, key === 'explanation' ? {} : value]))
}

/** What publicRow takes out of a row, with the file and ids that find the row again; null when it takes nothing. */
export function privateRow(row: Row, file: string): Row | null {
  const taken = Object.entries(row).filter(([key, value]) => (key === 'explanation' && !isEmptyObject(value)) || key === 'error')
  return taken.length ? { file, prompt_id: row.prompt_id, rep: row.rep, ...Object.fromEntries(taken) } : null
}

// Only roots a machine's own folders sit under, so a route such as /health in a scenario's prompt is no path.
const ABSOLUTE_PATH = /~\/|\/(?:Users|home|private|var|tmp|Volumes|opt)\/|\b[A-Za-z]:\\/
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A whole word as lib/stage.ts's scrub matches the user name, so a word that merely holds a name is kept.
const wholeWords = (words: string[], flags: string) =>
  new RegExp(`(?<![\\w.-])(?:${words.map(escape).join('|')})(?![\\w.-])`, flags)

/** The first thing in the row that must not be committed, as `<key path>: <kind>`: never the value, which is the very
 *  text that must not be shown. */
export function rowFault(row: Row, who: Who): string | null {
  const home = who.home.replace(/\/+$/, '')
  const hosts = [...new Set([who.host, who.host.split('.')[0]])].filter(Boolean)
  // The most telling kind first: the home folder is also an absolute path, and the user name often sits inside both.
  const kinds: [string, (text: string) => boolean][] = [
    ['home folder', (text) => home !== '' && text.includes(home)],
    ['absolute path', (text) => ABSOLUTE_PATH.test(text)],
    ['user name', (text) => who.user !== '' && wholeWords([who.user], '').test(text)],
    ['host name', (text) => hosts.length > 0 && wholeWords(hosts, 'i').test(text)],
  ]
  const find = (value: unknown, path: string): string | null => {
    if (typeof value === 'string') {
      const kind = kinds.find(([, holds]) => holds(value))
      return kind ? `${path}: ${kind[0]}` : null
    }
    if (value === null || typeof value !== 'object') return null
    for (const [key, inner] of Object.entries(value)) {
      const fault = find(inner, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`)
      if (fault) return fault
    }
    return null
  }
  for (const [key, value] of Object.entries(row)) {
    if (key === 'explanation' && !isEmptyObject(value)) return 'explanation: explanation text'
    if (key === 'error') return 'error: error text'
    const fault = find(value, key)
    if (fault) return fault
  }
  return null
}

function isEmptyObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

/** A scenario's rows leave results.jsonl, so the runner, which resumes on it, runs its cases again. They join
 *  errors.jsonl rather than vanish: each was billed, and the flow's spend, which the runner's cap reads, must still count
 *  it. */
export function supersede(results: Row[], errors: Row[], scenario: string): { results: Row[]; errors: Row[]; moved: number } {
  const moved = results.filter((row) => (row.meta as Row | undefined)?.scenario === scenario)
  return {
    results: results.filter((row) => !moved.includes(row)),
    errors: [...errors, ...moved.map((row) => ({
      prompt_id: row.prompt_id, rep: row.rep, failure_class: 'superseded', model: row.model, usage: row.usage,
      judge_model: row.judge_model, judge_usage: row.judge_usage, latency_s: row.latency_s,
    }))],
    moved: moved.length,
  }
}

/** Rewrites every variant's row files through publicRow, then checks what is left: the rows read per file, as `<n>
 *  <variant>/<file>`, and each fault as `<variant>/<file>:<line> <fault>`. What publicRow takes out is added to the
 *  variant's private.jsonl first, which git ignores, so a later round can still read why a run scored as it did. */
export function scrubFlow(flow: string, who: Who): { read: string[]; faults: string[] } {
  const variants = readdirSync(flow, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => entry.name).sort()
  // Every file is read before any is written, so a refused one leaves the whole flow as it was.
  const read = variants.flatMap((variant) => ROW_FILES.flatMap((file) => {
    const rows = readRows(flow, `${variant}/${file}`)
    return rows ? [{ variant, file, rows }] : []
  }))
  const kept = variants.flatMap((variant) => {
    const taken = read.filter((f) => f.variant === variant)
      .flatMap(({ file, rows }) => rows.map((row) => privateRow(row, file)).filter((row): row is Row => row !== null))
    const rel = `${variant}/${PRIVATE_FILE}`
    return taken.length ? [{ rel, rows: [...(readRows(flow, rel) ?? []), ...taken] }] : []
  })
  const files = read.map(({ variant, file, rows }) => ({ rel: `${variant}/${file}`, rows: rows.map(publicRow) }))
  for (const { rel, rows } of [...kept, ...files]) writeRows(join(flow, rel), rows)
  return {
    read: files.map(({ rel, rows }) => `${rows.length} ${rel}`),
    faults: files.flatMap(({ rel, rows }) => rows.flatMap((row, i) => {
      const fault = rowFault(row, who)
      return fault ? [`${rel}:${i + 1} ${fault}`] : []
    })),
  }
}

/** Supersedes a scenario's rows in one variant (see supersede); the number moved, none written when it is 0. */
export function supersedeFlow(flow: string, variant: string, scenario: string): number {
  const next = supersede(readRows(flow, `${variant}/results.jsonl`) ?? [], readRows(flow, `${variant}/errors.jsonl`) ?? [],
    scenario)
  if (next.moved) {
    // errors.jsonl first: a stop between the two writes counts a moved run twice, never drops its spend.
    writeRows(join(flow, variant, 'errors.jsonl'), next.errors)
    writeRows(join(flow, variant, 'results.jsonl'), next.results)
  }
  return next.moved
}

/** A row file's rows, null when there is none. The flow folder is model-influenced, as the runner treats it: a planted
 *  link would carry a rewrite elsewhere, or read a file from elsewhere into a commit. A hard link is a second name lstat
 *  cannot tell from the file, and nothing in a flow needs one. */
function readRows(flow: string, rel: string): Row[] | null {
  const path = join(flow, rel)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return null
  if (!stat.isFile() || stat.nlink > 1) throw new Error(`${rel} is a symlink, a hard link or not a file: nothing written`)
  return readFileSync(path, 'utf8').split('\n').flatMap((line, i) => {
    if (!line.trim()) return []
    let row: unknown
    try { row = JSON.parse(line) } catch { row = null }
    // A torn last line, as the runner leaves when killed mid-write, may hold model text this cannot take out; the
    // person removes it. JSON.parse's message is not shown: it quotes the line.
    if (row === null || typeof row !== 'object' || Array.isArray(row))
      throw new Error(`${rel}:${i + 1} is not a JSON row: remove the line and run again; nothing written`)
    return [row as Row]
  })
}

// Through a temp file renamed over the old: a stop mid-write leaves the old rows or the new, never half, and a second
// name for the old file is never written through.
function writeRows(path: string, rows: Row[]): void {
  const temp = `${path}.${process.pid}.tmp`
  // 'wx' fails on anything already at the temp name, a planted link included, rather than follow it.
  const fd = openSync(temp, 'wx')
  try {
    try { writeFileSync(fd, rows.map((row) => JSON.stringify(row) + '\n').join('')) } finally { closeSync(fd) }
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
