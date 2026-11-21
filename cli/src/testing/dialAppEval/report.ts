// The dial eval's report: the terminal table, report.md and report.json, from the grader's Report
// (docs/plans/2026-11-21-dial-app-eval-design.md, "Grader and report").
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIMENSIONS, type App, type AppScores, type Report } from './types.js'

/** Reported beside each app's score; a score below it never fails CI. */
const TARGET = 95
const APPS: readonly App[] = ['claude', 'chatgpt']
const APP_NAMES: Record<App, string> = { claude: 'the Claude app', chatgpt: 'the ChatGPT app' }

/** The terminal table: scores, the gate and where points were lost. */
export function summary(report: Report): string {
  const r = clean(report)
  const lines = [`Dial eval (target ${TARGET})`, columns(['', ...DIMENSIONS, 'score', ''])]
  for (const app of APPS) lines.push(columns(scoreRow(app, r.apps[app])))
  lines.push('', 'Held out', columns(['', ...DIMENSIONS, 'score', '']))
  for (const app of APPS) lines.push(columns(scoreRow(app, r.heldOut[app])))
  lines.push('', ...subsetRows(r).map(([run, app, score, leftOut]) =>
    `${run.padEnd(10)} ${app.padEnd(16)} ${score.padStart(5)} ${leftOut}`))
  lines.push('', ...gateLines(r))
  for (const [title, body] of sections(r)) lines.push('', `${title}:`, ...body)
  return lines.join('\n') + '\n'
}

export function markdown(report: Report): string {
  const r = clean(report)
  const table = (head: string[], rows: string[][]): string[] =>
    [head, head.map(() => '---'), ...rows].map((row) => `| ${row.join(' | ')} |`)
  return [
    '# Dial eval', '',
    '## Scores', '', `Target: ${TARGET}`, '',
    ...table(['App', ...DIMENSIONS, 'Score', 'Left out'], APPS.map((app) => scoreRow(app, r.apps[app]))), '',
    '## Held out', '',
    ...table(['App', ...DIMENSIONS, 'Score', 'Left out'], APPS.map((app) => scoreRow(app, r.heldOut[app]))), '',
    '## By tier and platform', '',
    ...table(['Run', 'App', 'Score', 'Left out'], subsetRows(r)), '',
    '## Gate', '', ...gateLines(r),
    ...sections(r).flatMap(([title, body]) => ['', `## ${title}`, '', ...body]),
  ].join('\n') + '\n'
}

/** Writes report.json and report.md into dir, which it makes if missing. */
export function writeReport(dir: string, report: Report): { json: string; md: string } {
  mkdirSync(dir, { recursive: true })
  const json = join(dir, 'report.json')
  const md = join(dir, 'report.md')
  writeFileSync(json, JSON.stringify(clean(report), null, 2) + '\n')
  writeFileSync(md, markdown(report))
  return { json, md }
}

function scoreRow(app: App, s: AppScores): string[] {
  return [APP_NAMES[app], ...DIMENSIONS.map((d) => num(s.dims[d])), num(s.score), `left out: ${s.leftOut}`]
}

function subsetRows(r: Report): string[][] {
  const subsets: Array<[string, Record<App, AppScores>]> = [...Object.entries(r.byTier), ...Object.entries(r.byPlatform)]
  return subsets.flatMap(([run, apps]) =>
    APPS.map((app) => [run, APP_NAMES[app], num(apps[app].score), `left out: ${apps[app].leftOut}`]))
}

function gateLines(r: Report): string[] {
  const { passed, wrongSends } = r.gate
  return [
    passed ? 'Gate: passed' : `Gate: failed, ${wrongSends.length} wrong send${wrongSends.length === 1 ? '' : 's'}`,
    // A wrong send names keys and the delivery path only: the spoken text is personal content.
    ...wrongSends.map((w) =>
      `- ${w.scenario} ${w.platform} tier ${w.tier}: target ${w.target}, got ${w.got ?? 'none'}, path ${w.path}, at ${w.at} ms`),
  ]
}

/** The lists after the gate, each only when it has something in it. */
function sections(r: Report): Array<[string, string[]]> {
  const all: Array<[string, string[]]> = [
    ['Failing checks', r.failing.flatMap((f) => [
      `- ${f.tier}/${f.platform}/${f.scenario}/${f.check} (${APP_NAMES[f.app]}, ${f.dim}): score ${num(f.score)}, ` +
        `${num(f.pointsLost)} points lost${f.ms == null ? '' : `, ${f.ms} ms`}`,
      ...f.evidence.map((line) => `    ${line}`),
    ])],
    ['Points lost', r.groups.map((g) =>
      `- ${APP_NAMES[g.app]} ${g.dim} ${g.scenario}: ${num(g.pointsLost)} (${g.checks.join(', ')})`)],
    ['Coverage gaps', r.gaps.map((g) => `- ${g.tier}/${g.platform}/${g.scenario} (${APP_NAMES[g.app]}): ${g.reason}`)],
    ['Delta', [
      ...Object.entries(r.delta.apps).flatMap(([subset, apps]) =>
        APPS.map((app) => `- ${subset}, ${APP_NAMES[app]}: ${num(apps[app].before)} → ${num(apps[app].after)}`)),
      ...r.delta.checks.map((c) => `- ${c.key}: ${num(c.before)} → ${num(c.after)}`),
      ...(r.delta.heldOutChanged > 0
        ? [`- held out: ${r.delta.heldOutChanged} check${r.delta.heldOutChanged === 1 ? '' : 's'} changed`] : []),
    ]],
  ]
  return all.filter(([, body]) => body.length > 0)
}

function num(n: number | null): string {
  return n === null ? '—' : String(Math.round(n * 10) / 10)
}

function columns(cells: string[]): string {
  return cells.map((cell, i) => (i === 0 ? cell.padEnd(16) : cell.padStart(i > DIMENSIONS.length ? 7 : 5))).join(' ')
    .trimEnd()
}

/** The report with every machine path in its evidence and gap reasons replaced, since the report is shared. */
function clean(report: Report): Report {
  const redact = pathRedactor()
  return {
    ...report,
    failing: report.failing.map((f) => ({ ...f, evidence: f.evidence.map(redact) })),
    gaps: report.gaps.map((g) => ({ ...g, reason: redact(g.reason) })),
  }
}

function pathRedactor(): (line: string) => string {
  const roots = [tmpdir(), realpathSync(tmpdir()), homedir(), '/work/eval-']
    // A root of "/" would swallow every path; longest first, so /private/var/… wins over /var/….
    .filter((root) => root.length > 1)
    .sort((a, b) => b.length - a.length)
    .map((root) => root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // The whole path goes, not just its root: a folder's name below it can name the work too.
  const pattern = new RegExp(`(?:${roots.join('|')})[^\\s"'(),\\]]*`, 'g')
  return (line) => line.replace(pattern, '<path>')
}
