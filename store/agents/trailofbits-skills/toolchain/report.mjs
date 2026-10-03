// The audit as the person sees it, from the one file the agent keeps: security-audit/findings.json.
//
//   node toolchain/report.mjs [workspace] [--pdf]
//   node toolchain/report.mjs --browser [--install]     the PDF's browser: say which, or fetch one
//
// writes security-audit/index.html (the pane), security-audit/report.md (the deliverable), with
// --pdf security-audit/report.pdf, and .harness/verdict.json (the header). Every string in a
// finding may have come from the code under audit, so the page escapes all of it and renders only
// a small Markdown subset: paragraphs, lists, inline code, code blocks, bold, italics. No links, no HTML.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AUDIT_DIR = 'security-audit'
const FINDINGS = `${AUDIT_DIR}/findings.json`
const ARTIFACT = `${AUDIT_DIR}/index.html`
export const PHASES = ['scope', 'context', 'scan', 'review', 'verify', 'report']
const PHASE_NAMES = { scope: 'Scope', context: 'Context', scan: 'Scan', review: 'Review', verify: 'Verify', report: 'Report' }
const SEVERITIES = ['high', 'medium', 'low', 'informational', 'undetermined']
const STATUSES = ['unverified', 'confirmed', 'false-positive']
const ID = /^[A-Za-z0-9._-]{1,40}$/

const isText = (value, max = 20_000) => typeof value === 'string' && value.length <= max
const optionalText = (value, max) => value === undefined || isText(value, max)

// ── read ─────────────────────────────────────────────────────────────────────────────────────────

/** Parse and check [text]; what is wrong is reported and left out, never guessed at. */
export function readAudit(text) {
  const errors = []
  const empty = { target: {}, phase: 'scope', final: false, summary: '', findings: [] }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { audit: empty, errors: [`${FINDINGS} is not valid JSON: ${error.message}`] }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { audit: empty, errors: [`${FINDINGS} must be a JSON object`] }

  const target = raw.target && typeof raw.target === 'object' ? raw.target : {}
  const audit = {
    target: {
      name: isText(target.name, 200) ? target.name : '',
      path: isText(target.path, 1000) ? target.path : '',
      commit: isText(target.commit, 100) ? target.commit : '',
      scope: Array.isArray(target.scope) ? target.scope.filter((s) => isText(s, 1000)) : [],
    },
    phase: PHASES.includes(raw.phase) ? raw.phase : 'scope',
    final: raw.final === true,
    summary: isText(raw.summary) ? raw.summary : '',
    findings: [],
  }
  if (raw.phase !== undefined && !PHASES.includes(raw.phase)) errors.push(`phase must be one of ${PHASES.join(', ')} (got ${JSON.stringify(raw.phase)})`)
  if (raw.findings !== undefined && !Array.isArray(raw.findings)) errors.push('findings must be an array')

  const seen = new Set()
  for (const [index, item] of (Array.isArray(raw.findings) ? raw.findings : []).entries()) {
    const bad = (field, rule) => errors.push(`findings[${index}]${item?.id ? ` (${item.id})` : ''}: ${field} ${rule}`)
    if (!item || typeof item !== 'object') { bad('entry', 'must be an object'); continue }
    const before = errors.length
    if (!isText(item.id, 40) || !ID.test(item.id)) bad('id', 'must be letters, digits, . _ or -, at most 40')
    else if (seen.has(item.id)) bad('id', `is a duplicate id ${item.id}`)
    if (!isText(item.title, 200) || !item.title.trim()) bad('title', 'must be a non-empty line of at most 200 characters')
    if (!SEVERITIES.includes(item.severity)) bad('severity', `must be one of ${SEVERITIES.join(', ')}`)
    if (!STATUSES.includes(item.status)) bad('status', `must be one of ${STATUSES.join(', ')}`)
    const location = item.location ?? []
    if (!Array.isArray(location) || !location.every((l) => l && isText(l.file, 1000) && l.file && (l.line === undefined || (Number.isInteger(l.line) && l.line > 0)))) {
      bad('location', 'must be a list of { file, line? }')
    }
    for (const field of ['description', 'evidence', 'recommendation', 'category', 'source']) {
      if (!optionalText(item[field])) bad(field, 'must be text')
    }
    if (errors.length !== before) continue
    seen.add(item.id)
    audit.findings.push({
      id: item.id, title: item.title.trim(), severity: item.severity, status: item.status, location,
      description: item.description ?? '', evidence: item.evidence ?? '', recommendation: item.recommendation ?? '',
      category: item.category ?? '', source: item.source ?? '',
    })
  }
  return { audit, errors }
}

// ── verdict ──────────────────────────────────────────────────────────────────────────────────────

const open = (audit) => audit.findings.filter((f) => f.status !== 'false-positive')
const dismissed = (audit) => audit.findings.filter((f) => f.status === 'false-positive')
const locationText = (l) => `${l.file}${l.line ? `:${l.line}` : ''}`
const title = (audit) => `Security audit${audit.target.name ? ` — ${audit.target.name}` : ''}`

/** Done before the current phase (every phase, once final), active at it, pending after it. */
function phaseStates(audit) {
  const current = PHASES.indexOf(audit.phase)
  return PHASES.map((id, i) => ({ id, name: PHASE_NAMES[id], state: audit.final || i < current ? 'done' : i === current ? 'active' : 'pending' }))
}

/** The open findings per severity, in the scale's order, with how many of each are unverified. */
function severityGroups(live) {
  return SEVERITIES.map((severity) => {
    const list = live.filter((f) => f.severity === severity)
    return { severity, count: list.length, unverified: list.filter((f) => f.status === 'unverified').length }
  }).filter((group) => group.count)
}

export function verdictFor(audit, { errors = [], now = new Date().toISOString() } = {}) {
  const live = open(audit)
  const groups = severityGroups(live)
  const unverified = groups.reduce((n, g) => n + g.unverified, 0)
  const ready = audit.final && !unverified && errors.length === 0

  const findings = errors.map((message) => ({ severity: 'error', kind: 'findings-file', message, ref: FINDINGS }))
  for (const f of live) {
    const severity = f.status === 'unverified' ? 'warning' : f.severity === 'high' ? 'error' : f.severity === 'medium' ? 'warning' : 'info'
    const where = f.location[0] ? ` (${locationText(f.location[0])})` : ''
    findings.push({ severity, kind: f.status === 'unverified' ? 'unverified' : 'finding', message: `${f.severity}: ${f.title}${where}`, ref: f.id })
  }

  const tally = groups.map((g) => `${g.count} ${g.severity}`)
  if (unverified) tally.push(`${unverified} unverified`)
  if (dismissed(audit).length) tally.push(`${dismissed(audit).length} dismissed`)
  const head = audit.final ? 'Report final' : PHASE_NAMES[audit.phase]
  const body = tally.length ? tally.join(' · ') : audit.final ? 'no findings' : 'no findings yet'
  const summary = `${head} · ${body}${errors.length ? ` · ${errors.length} error${errors.length > 1 ? 's' : ''} in findings.json` : ''}`
  return { spec: 1, ready, summary: summary.slice(0, 200), findings, artifact: ARTIFACT, phases: phaseStates(audit), updatedAt: now }
}

// ── markdown subset ──────────────────────────────────────────────────────────────────────────────

const escapeHtml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function inline(text) {
  return escapeHtml(text)
    .split(/(`[^`]+`)/g)
    .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1
      ? `<code>${part.slice(1, -1)}</code>`
      : part.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1<em>$2</em>')))
    .join('')
}

/** Paragraphs, `-`/`*` lists, inline code, fenced code, bold, italics — everything else stays text. */
export function markdownToHtml(markdown) {
  const out = []
  const chunks = String(markdown).replace(/\r\n/g, '\n').split(/^```[^\n]*\n?/m)
  chunks.forEach((chunk, i) => {
    if (i % 2 === 1) { out.push(`<pre><code>${escapeHtml(chunk.replace(/\n$/, ''))}</code></pre>`); return }
    for (const block of chunk.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)) {
      // A block alternates runs of list items and lines of text, as a list under a heading line does.
      const runs = []
      for (const line of block.split('\n')) {
        const item = /^\s*[-*]\s+/.test(line)
        if (runs.at(-1)?.item !== item) runs.push({ item, lines: [] })
        runs.at(-1).lines.push(item ? line.replace(/^\s*[-*]\s+/, '') : line)
      }
      for (const run of runs) {
        out.push(run.item ? `<ul>${run.lines.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>` : `<p>${run.lines.map(inline).join('<br>')}</p>`)
      }
    }
  })
  return out.join('\n')
}

// ── page ─────────────────────────────────────────────────────────────────────────────────────────

const bySeverity = (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.id.localeCompare(b.id, undefined, { numeric: true })

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1d1f23;--muted:#62666d;--line:#e3e4e6;--card:#fff;--code:#f2f3f4;
--high:#c2362c;--medium:#b86b00;--low:#2f6fb3;--informational:#5d6670;--undetermined:#7a5ab5;--ok:#2e7d4f}
@media (prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e6e7e9;--muted:#9aa0a6;--line:#2c2f35;--card:#1d2025;--code:#262a30;
--high:#ff6b5e;--medium:#f0a73a;--low:#6aa8f0;--informational:#a3abb5;--undetermined:#b69cf0;--ok:#5fc48a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:28px 20px 60px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0}
.meta,.muted{color:var(--muted)}.meta{font-size:13px;margin-bottom:18px}
.phases{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 22px}.phase{font-size:12px;padding:3px 10px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.phase.done{color:var(--ok);border-color:var(--ok)}.phase.active{color:var(--fg);border-color:var(--fg);font-weight:600}
table{border-collapse:collapse;margin:8px 0 26px;font-size:13px}th,td{text-align:left;padding:6px 14px 6px 0;border-bottom:1px solid var(--line)}
.finding{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--sev);border-radius:8px;padding:14px 16px;margin:14px 0}
.head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.id{font:600 12px ui-monospace,monospace;color:var(--muted)}
.badge{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--sev)}
.status{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line)}.status.unverified{border-color:var(--medium);color:var(--medium)}
.loc{font:12px ui-monospace,monospace;color:var(--muted);margin:6px 0 2px}h3{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:14px 0 4px}
code{font:12.5px ui-monospace,monospace;background:var(--code);padding:1px 4px;border-radius:4px}pre{background:var(--code);padding:10px 12px;border-radius:6px;overflow-x:auto}pre code{padding:0;background:none}
.errors{border:1px solid var(--high);border-radius:8px;padding:10px 14px;margin:0 0 20px}.errors li{font:12px ui-monospace,monospace}
details{margin-top:26px}summary{cursor:pointer;color:var(--muted)}.empty{padding:40px 0;text-align:center;color:var(--muted)}`

function findingHtml(f) {
  const section = (title, body) => (body.trim() ? `<h3>${title}</h3>${markdownToHtml(body)}` : '')
  return `<article class="finding" style="--sev:var(--${f.severity})">
<div class="head"><span class="id">${escapeHtml(f.id)}</span><h2>${escapeHtml(f.title)}</h2></div>
<div class="head"><span class="badge">${f.severity}</span><span class="status ${f.status}">${f.status.replace('-', ' ')}</span>${f.category ? `<span class="muted">${escapeHtml(f.category)}</span>` : ''}${f.source ? `<span class="muted">· ${escapeHtml(f.source)}</span>` : ''}</div>
${f.location.length ? `<div class="loc">${f.location.map((l) => escapeHtml(locationText(l))).join('<br>')}</div>` : ''}
${section('Description', f.description)}${section('Evidence', f.evidence)}${section('Recommendation', f.recommendation)}
</article>`
}

export function renderHtml(audit, { errors = [] } = {}) {
  const live = open(audit).sort(bySeverity)
  const gone = dismissed(audit).sort(bySeverity)
  const phases = phaseStates(audit).map((p) => `<span class="phase ${p.state}">${p.name}</span>`).join('')
  const rows = severityGroups(live)
    .map((g) => `<tr><td><span class="badge" style="--sev:var(--${g.severity})">${g.severity}</span></td><td>${g.count}</td><td>${g.unverified}</td></tr>`).join('')
  const meta = [audit.target.path && audit.target.path !== '.' && `path <code>${escapeHtml(audit.target.path)}</code>`,
    audit.target.commit && `commit <code>${escapeHtml(audit.target.commit.slice(0, 12))}</code>`,
    audit.target.scope.length && `scope ${audit.target.scope.map((s) => `<code>${escapeHtml(s)}</code>`).join(', ')}`,
    audit.final ? 'final report' : 'in progress'].filter(Boolean).join(' · ')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><title>${escapeHtml(title(audit))}</title><style>${STYLE}</style></head>
<body><main>
<h1>${escapeHtml(title(audit))}</h1>
<div class="meta">${meta}</div>
<div class="phases">${phases}</div>
${errors.length ? `<div class="errors"><strong>findings.json has problems — these entries are not shown:</strong><ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>` : ''}
${audit.summary.trim() ? `<section>${markdownToHtml(audit.summary)}</section>` : ''}
${rows ? `<table><thead><tr><th>Severity</th><th>Findings</th><th>Unverified</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="empty">${audit.final ? 'No findings.' : 'No findings yet. The audit is in its ' + PHASE_NAMES[audit.phase].toLowerCase() + ' phase.'}</p>`}
${live.map(findingHtml).join('\n')}
${gone.length ? `<details><summary>${gone.length} dismissed as false positive${gone.length > 1 ? 's' : ''}</summary>${gone.map(findingHtml).join('\n')}</details>` : ''}
</main></body></html>
`
}

export function renderMarkdown(audit) {
  const live = open(audit).sort(bySeverity)
  const gone = dismissed(audit)
  const lines = [`# ${title(audit)}`, '']
  if (audit.target.path && audit.target.path !== '.') lines.push(`- Path: \`${audit.target.path}\``)
  if (audit.target.commit) lines.push(`- Commit: \`${audit.target.commit}\``)
  if (audit.target.scope.length) lines.push(`- Scope: ${audit.target.scope.map((s) => `\`${s}\``).join(', ')}`)
  lines.push(`- Status: ${audit.final ? 'final' : `in progress (${PHASE_NAMES[audit.phase]})`}`, '')
  if (audit.summary.trim()) lines.push('## Summary', '', audit.summary.trim(), '')
  lines.push('| Severity | Findings | Unverified |', '|---|---|---|')
  for (const g of severityGroups(live)) lines.push(`| ${g.severity} | ${g.count} | ${g.unverified} |`)
  lines.push('')
  for (const f of live) {
    lines.push(`## ${f.id} · ${f.title}`, '', `- Severity: ${f.severity}`, `- Status: ${f.status}`)
    if (f.category) lines.push(`- Category: ${f.category}`)
    if (f.location.length) lines.push(`- Location: ${f.location.map((l) => `\`${locationText(l)}\``).join(', ')}`)
    lines.push('')
    for (const [title, body] of [['Description', f.description], ['Evidence', f.evidence], ['Recommendation', f.recommendation]]) {
      if (body.trim()) lines.push(`### ${title}`, '', body.trim(), '')
    }
  }
  if (gone.length) lines.push(`Dismissed as false positives: ${gone.map((f) => f.id).join(', ')}`, '')
  return lines.join('\n')
}

// ── the command ──────────────────────────────────────────────────────────────────────────────────

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const bundledBrowsers = join(packageDir, 'browsers')

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${process.pid}.tmp`)
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/**
 * The browser the PDF is printed with: $BROWSER_EXECUTABLE, this machine's Chrome or Chromium (the
 * macOS app, or on PATH), else the headless shell in browsers/ — `bundled` — which [install] fetches
 * when it is missing. Null when there is none. setup, doctor, --pdf and the tests all ask this.
 */
export function browserPath({ install = false } = {}) {
  const apps = [process.env.BROWSER_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  const onPath = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    .flatMap((name) => (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, name)))
  const system = [...apps, ...onPath].find((path) => path && existsSync(path))
  if (system) return system
  const bundled = () => existsSync(bundledBrowsers) && readdirSync(bundledBrowsers).some((name) => name.startsWith('chromium_headless_shell-'))
  if (!bundled() && install) {
    execFileSync(process.execPath, [join(packageDir, 'node_modules', 'playwright-core', 'cli.js'), 'install', '--only-shell', 'chromium'], {
      stdio: 'ignore', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: bundledBrowsers },
    })
  }
  return bundled() ? 'bundled' : null
}

/** Print the report page to report.pdf in headless Chrome. */
async function writePdf(workspace) {
  const path = browserPath()
  if (!path) throw new Error('no browser for the PDF report: install Chrome, or run toolchain/setup.sh')
  if (path === 'bundled') process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers
  const { chromium } = await import(join(packageDir, 'node_modules', 'playwright-core', 'index.mjs'))
  const browser = await chromium.launch({ headless: true, ...(path === 'bundled' ? {} : { executablePath: path }) })
  try {
    const page = await browser.newPage()
    await page.setContent(readFileSync(join(workspace, ARTIFACT), 'utf8'), { waitUntil: 'load' })
    await page.emulateMedia({ colorScheme: 'light', media: 'print' })
    await page.pdf({ path: join(workspace, AUDIT_DIR, 'report.pdf'), format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } })
  } finally {
    await browser.close()
  }
}

export async function writeReport(workspace, { pdf = false, now } = {}) {
  const file = join(workspace, FINDINGS)
  const { audit, errors } = existsSync(file) ? readAudit(readFileSync(file, 'utf8')) : { audit: readAudit('{}').audit, errors: [] }
  writeAtomic(join(workspace, ARTIFACT), renderHtml(audit, { errors }))
  writeAtomic(join(workspace, AUDIT_DIR, 'report.md'), renderMarkdown(audit))
  if (pdf) await writePdf(workspace)
  const verdict = verdictFor(audit, { errors, now })
  writeAtomic(join(workspace, '.harness', 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`)
  return { audit, errors, verdict }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--browser')) {
  // setup (--install) and doctor: optional, so a missing browser is a warning, never a failure.
  let path = null
  try { path = browserPath({ install: process.argv.includes('--install') }) } catch { /* reported below */ }
  console.log(path ? `ok   browser for the PDF report: ${path === 'bundled' ? 'headless Chromium in browsers/' : path}`
    : 'warn no browser for the PDF report; the HTML and Markdown reports still work')
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const workspace = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd())
  const { errors, verdict } = await writeReport(workspace, { pdf: args.includes('--pdf') })
  for (const error of errors) console.log(`fail ${FINDINGS}: ${error}`)
  console.log(`ok   ${ARTIFACT} and ${AUDIT_DIR}/report.md${args.includes('--pdf') ? ` and ${AUDIT_DIR}/report.pdf` : ''}`)
  console.log(`${verdict.ready ? 'ok  ' : 'info'} verdict: ${verdict.summary}`)
  process.exitCode = errors.length ? 1 : 0
}
