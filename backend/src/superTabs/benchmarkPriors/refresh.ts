/** The pure half of the hand-run refresh (scripts/refresh-benchmark-priors.ts): reads the three benchmarks' public boards from
 * text the script fetched, maps their model names to ours and rewrites the checked-in table. No network and no files here. */
import { nameKey, type PriorsTable, type PriorScore } from './priors.js'

export interface BoardRow { benchmarkName: string; score: number; harness: string; date: string }
/** One benchmark's board as read, or why it could not be. */
export type Board = { benchmark: string; source: string; rows: BoardRow[] } | { benchmark: string; error: string }
type Read = Extract<Board, { rows: BoardRow[] }>

const finite = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${what}: accuracy is not a number`)
  return value
}

/** The JSON array at the start of [text], ignoring what follows it (the rest of the page): found by bracket depth outside strings. */
function leadingArray(text: string): unknown[] {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue }
    if (c === '"') inString = true
    else if (c === '[' || c === '{') depth++
    else if ((c === ']' || c === '}') && --depth === 0) return JSON.parse(text.slice(0, i + 1))
  }
  throw new Error('unterminated')
}

/** tbench.ai's leaderboard page, which carries its rows as an escaped JSON string. Only the 4.0 board is read: scores of
 * different Terminal-Bench versions do not compare. */
export function parseTerminalBench(html: string): Read {
  const text = html.replace(/\\"/g, '"')
  const at = text.indexOf('"rows":[')
  let rows: Array<{ metadata: { date: string; model_display: { label: string }; agent_display: { label: string }; reasoning_effort?: string }; metrics: { accuracy: unknown } }> = []
  try { if (at >= 0) rows = leadingArray(text.slice(at + 7)) as typeof rows } catch { /* reported below */ }
  if (rows.length === 0) throw new Error('The Terminal-Bench page has no rows')
  if (!text.includes('"title":"Terminal-Bench 4.0"')) throw new Error('The page is not the Terminal-Bench 4.0 board')
  return { benchmark: 'terminal-bench-4.0', source: 'https://www.tbench.ai/leaderboard', rows: rows.map(r => ({
    benchmarkName: r.metadata.model_display.label,
    score: finite(r.metrics.accuracy, r.metadata.model_display.label),
    harness: r.metadata.reasoning_effort ? `${r.metadata.agent_display.label}, ${r.metadata.reasoning_effort} effort` : r.metadata.agent_display.label,
    date: r.metadata.date,
  })) }
}

/** swebench.com's leaderboards file. Rows of the Verified board that run one model; the agent is the harness. */
export function parseSweBench(file: unknown): Read {
  const boards = (file as { leaderboards?: Array<{ name: string; results?: unknown[] }> } | null)?.leaderboards
  const verified = Array.isArray(boards) ? boards.find(b => b.name === 'Verified') : undefined
  if (!verified?.results) throw new Error('The SWE-bench file has no Verified board')
  const rows: BoardRow[] = []
  for (const entry of verified.results as Array<{ agent?: string; name: string; resolved: number; date: string; tags?: string[] }>) {
    const models = (entry.tags ?? []).filter(t => t.startsWith('Model: ')).map(t => t.slice('Model: '.length))
    if (models.length !== 1 || typeof entry.resolved !== 'number') continue
    rows.push({ benchmarkName: models[0], score: entry.resolved, harness: entry.agent ?? entry.name, date: entry.date })
  }
  return { benchmark: 'swe-bench-verified', source: 'https://www.swebench.com', rows }
}

/** Aider's polyglot leaderboard file (a flat list of `- dirname:` entries with `key: value` lines). The second-try pass rate. */
export function parseAider(yaml: string): Read {
  const rows: BoardRow[] = []
  for (const block of yaml.split(/^- dirname:/m).slice(1)) {
    const field = (key: string) => block.match(new RegExp(`^  ${key}: (.+)$`, 'm'))?.[1].trim()
    const model = field('model')
    const rate = Number(field('pass_rate_2'))
    const date = field('date')
    if (!model || !date || !Number.isFinite(rate)) continue
    rows.push({ benchmarkName: model, score: rate, harness: `aider, ${field('edit_format') ?? 'unknown'} edit format`, date })
  }
  if (rows.length === 0) throw new Error('The Aider file has no entries')
  return { benchmark: 'aider-polyglot', source: 'https://aider.chat/docs/leaderboards/', rows }
}

/** The table with the boards applied: for each benchmark read, every `leaderboard` score is replaced by each of our models'
 * best row under its benchmark names (efforts merged, as on the leaderboards). A benchmark whose board failed keeps its rows,
 * and `model-card` scores are never touched. Returns a new table. */
export function applyBoards(table: PriorsTable, boards: Board[], today: string): { table: PriorsTable; warnings: string[] } {
  const warnings: string[] = []
  const read = new Map<string, Read>()
  for (const board of boards) {
    if ('error' in board) warnings.push(`${board.benchmark} was not refreshed (${board.error}); its previous rows stay.`)
    else read.set(board.benchmark, board)
  }
  const order = table.benchmarks.map(b => b.id)
  const models = table.models.map(model => {
    const kept = model.scores.filter(s => s.via === 'model-card' || !read.has(s.benchmark))
    const added: PriorScore[] = []
    for (const [benchmark, board] of read) {
      const names = new Set(model.benchmarkNames.map(nameKey))
      const best = board.rows.filter(r => names.has(nameKey(r.benchmarkName))).sort((a, b) => b.score - a.score)[0]
      if (best) added.push({ benchmark, score: best.score, harness: best.harness, source: board.source, date: best.date, via: 'leaderboard' })
    }
    const scores = [...kept, ...added].sort((a, b) => order.indexOf(a.benchmark) - order.indexOf(b.benchmark))
    return { ...model, scores }
  })
  return { table: { ...table, refreshed: read.size > 0 ? today : table.refreshed, models }, warnings }
}

const ident = /^[A-Za-z_$][\w$]*$/
const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
function literal(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const inner = value.map(v => `${indent}  ${literal(v, indent + '  ')},`).join('\n')
    return `[\n${inner}\n${indent}]`
  }
  if (value && typeof value === 'object') {
    const inner = Object.entries(value).map(([k, v]) => `${indent}  ${ident.test(k) ? k : quote(k)}: ${literal(v, indent + '  ')},`).join('\n')
    return `{\n${inner}\n${indent}}`
  }
  return typeof value === 'string' ? quote(value) : String(value)
}

/** The text of data.ts for [table]. */
export function renderData(table: PriorsTable): string {
  return `/** Generated by scripts/refresh-benchmark-priors.ts; rows with via: 'model-card' are typed in by hand and kept on refresh.
 * Each score names the board or card it came from, the day it was posted and the harness it ran in (docs/benchmark-priors.md). */
import type { PriorsTable } from './priors.js'

export const BENCHMARK_PRIORS: PriorsTable = ${literal(table, '')}
`
}
