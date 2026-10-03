// The audit's findings file, read strictly, and what it becomes: the pane's report page, the
// Markdown report, and the header's verdict.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdownToHtml, PHASES, readAudit, renderHtml, renderMarkdown, verdictFor } from '../toolchain/report.mjs'

const NOW = '2026-09-29T12:00:00.000Z'

function finding(fields = {}) {
  return {
    id: 'TOB-1', title: 'SQL built from request input', severity: 'high', status: 'confirmed',
    location: [{ file: 'src/db.py', line: 42 }], description: 'The query is concatenated.', ...fields,
  }
}
function audit(fields = {}) {
  return { spec: 1, target: { name: 'shop' }, phase: 'review', final: false, findings: [], ...fields }
}
const read = (value) => readAudit(JSON.stringify(value))

test('a well-formed findings file reads without errors', () => {
  const { audit: a, errors } = read(audit({ findings: [finding()] }))
  assert.deepEqual(errors, [])
  assert.equal(a.findings[0].id, 'TOB-1')
})

test('a findings file that is not JSON is one error, and an empty audit to show', () => {
  const { audit: a, errors } = readAudit('{ nope')
  assert.equal(errors.length, 1)
  assert.match(errors[0], /not valid JSON/)
  assert.deepEqual(a.findings, [])
})

test('each malformed finding is named by its index and field, and left out', () => {
  const { audit: a, errors } = read(audit({ findings: [
    finding(),
    finding({ id: 'TOB-2', severity: 'critical' }),
    finding({ id: 'TOB-3', status: 'maybe' }),
    finding({ id: 'TOB-4', title: '' }),
  ] }))
  assert.deepEqual(a.findings.map((f) => f.id), ['TOB-1'])
  assert.equal(errors.length, 3)
  assert.match(errors[0], /findings\[1\].*severity/)
  assert.match(errors[1], /findings\[2\].*status/)
  assert.match(errors[2], /findings\[3\].*title/)
})

test('two findings with one id are an error', () => {
  const { errors } = read(audit({ findings: [finding(), finding()] }))
  assert.match(errors.join('\n'), /duplicate id TOB-1/)
})

test('an unknown phase is an error and reads as scope', () => {
  const { audit: a, errors } = read(audit({ phase: 'hunting' }))
  assert.equal(a.phase, 'scope')
  assert.match(errors[0], /phase/)
})

test('phases before the current one are done, the current one active', () => {
  const verdict = verdictFor(read(audit({ phase: 'verify' })).audit, { now: NOW })
  assert.deepEqual(verdict.phases.map((p) => [p.id, p.state]),
    PHASES.map((id, i) => [id, i < 4 ? 'done' : i === 4 ? 'active' : 'pending']))
  assert.equal(verdict.artifact, 'security-audit/index.html')
  assert.equal(verdict.updatedAt, NOW)
})

test('confirmed high is an error, medium a warning, low and informational information', () => {
  const verdict = verdictFor(read(audit({ findings: [
    finding({ id: 'A', severity: 'high' }), finding({ id: 'B', severity: 'medium' }),
    finding({ id: 'C', severity: 'low' }), finding({ id: 'D', severity: 'informational' }),
  ] })).audit, { now: NOW })
  assert.deepEqual(verdict.findings.map((f) => [f.ref, f.severity]),
    [['A', 'error'], ['B', 'warning'], ['C', 'info'], ['D', 'info']])
  assert.match(verdict.summary, /1 high · 1 medium · 1 low · 1 informational/)
})

test('an unverified finding is a warning whatever its severity, and false positives are not findings', () => {
  const verdict = verdictFor(read(audit({ findings: [
    finding({ id: 'A', severity: 'low', status: 'unverified' }),
    finding({ id: 'B', status: 'false-positive' }),
  ] })).audit, { now: NOW })
  assert.deepEqual(verdict.findings.map((f) => [f.ref, f.severity, f.kind]), [['A', 'warning', 'unverified']])
  assert.match(verdict.summary, /1 unverified/)
  assert.match(verdict.summary, /1 dismissed/)
})

test('ready only when the report is final and nothing is left unverified', () => {
  const done = audit({ phase: 'report', final: true, findings: [finding()] })
  assert.equal(verdictFor(read(done).audit, { now: NOW }).ready, true)
  assert.ok(verdictFor(read(done).audit, { now: NOW }).phases.every((p) => p.state === 'done'))
  const pending = audit({ phase: 'report', final: true, findings: [finding({ status: 'unverified' })] })
  assert.equal(verdictFor(read(pending).audit, { now: NOW }).ready, false)
  assert.equal(verdictFor(read(audit({ phase: 'report' })).audit, { now: NOW }).ready, false)
})

test('a final report with no findings says so plainly', () => {
  const verdict = verdictFor(read(audit({ phase: 'report', final: true })).audit, { now: NOW })
  assert.equal(verdict.ready, true)
  assert.match(verdict.summary, /no findings/i)
})

test('errors in the findings file are error findings and keep it not ready', () => {
  const { audit: a, errors } = read(audit({ phase: 'report', final: true, findings: [finding({ severity: 'nope' })] }))
  const verdict = verdictFor(a, { errors, now: NOW })
  assert.equal(verdict.ready, false)
  assert.deepEqual(verdict.findings.map((f) => [f.severity, f.kind]), [['error', 'findings-file']])
})

test('the page escapes everything the audited code could have put in a finding', () => {
  const html = renderHtml(read(audit({ target: { name: '<img src=x onerror=alert(1)>' }, findings: [finding({
    title: '<script>alert(1)</script>', description: 'uses `<b>` and <a href="javascript:x">here</a>',
    location: [{ file: '"><svg onload=1>', line: 3 }],
  })] })).audit)
  assert.doesNotMatch(html, /<script>alert|<img src=x|<svg onload|<a href="javascript/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('the page lists findings by severity, with their locations and a summary table', () => {
  const html = renderHtml(read(audit({ findings: [
    finding({ id: 'L', severity: 'low', title: 'Low one' }), finding({ id: 'H', severity: 'high', title: 'High one' }),
  ] })).audit)
  assert.ok(html.indexOf('High one') < html.indexOf('Low one'))
  assert.match(html, /src\/db\.py:42/)
  assert.match(html, /<table/)
})

test('the Markdown report carries every confirmed and unverified finding, not false positives', () => {
  const md = renderMarkdown(read(audit({ findings: [
    finding({ id: 'A', title: 'Kept' }), finding({ id: 'B', title: 'Dismissed', status: 'false-positive' }),
  ] })).audit)
  assert.match(md, /## A · Kept/)
  assert.doesNotMatch(md, /## B/)
  assert.match(md, /Dismissed as false positives: B/)
})

test('markdown renders code, emphasis and lists, and nothing else as markup', () => {
  const html = markdownToHtml('Use `exec()` **never**.\n\n- one\n- two\n\n```\nrm -rf <dir>\n```')
  assert.match(html, /<code>exec\(\)<\/code>/)
  assert.match(html, /<strong>never<\/strong>/)
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/)
  assert.match(html, /<pre><code>rm -rf &lt;dir&gt;<\/code><\/pre>/)
})

test('single-asterisk emphasis renders as italics, without touching bold, lists or code', () => {
  assert.match(markdownToHtml('a *deliberately vulnerable* app'), /a <em>deliberately vulnerable<\/em> app/)
  assert.match(markdownToHtml('**bold** and *it*'), /<strong>bold<\/strong> and <em>it<\/em>/)
  assert.match(markdownToHtml('- one\n- two'), /<ul><li>one<\/li><li>two<\/li><\/ul>/)
  assert.match(markdownToHtml('`a*b*c`'), /<code>a\*b\*c<\/code>/)
  assert.match(markdownToHtml('2 * 3 * 4'), /2 \* 3 \* 4/)
})

test('a list right under a line of text is still a list', () => {
  const html = markdownToHtml('**Headline risks:**\n- one\n- two\nAfter.')
  assert.match(html, /<p><strong>Headline risks:<\/strong><\/p>\s*<ul><li>one<\/li><li>two<\/li><\/ul>\s*<p>After\.<\/p>/)
})
