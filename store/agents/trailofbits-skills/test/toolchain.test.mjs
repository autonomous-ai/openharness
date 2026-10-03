// The package as installed: the template starts a valid audit, the report command writes what the
// pane and the person read, and the plugin skills harness.json links are the ones setup fetched —
// portable to every engine, with every sub-agent they name findable by the bridging skill's rule.
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { browserPath, readAudit, writeReport } from '../toolchain/report.mjs'

const pkg = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(pkg, 'harness.json'), 'utf8'))
const PLUGIN_SKILLS = /^upstream\/plugins\/([a-z0-9-]+)\/skills$/
const plugins = manifest.agent.skills.flatMap((root) => root.match(PLUGIN_SKILLS)?.[1] ?? [])
const fetched = existsSync(join(pkg, 'upstream', '.harness-commit'))
const chrome = existsSync(join(pkg, 'node_modules', 'playwright-core')) && browserPath() !== null
const scratch = []
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'tob-'))
  scratch.push(dir)
  cpSync(join(pkg, 'template'), dir, { recursive: true })
  return dir
}

test('the template starts a valid audit in its scope phase', () => {
  const { audit, errors } = readAudit(readFileSync(join(pkg, 'template', 'security-audit', 'findings.json'), 'utf8'))
  assert.deepEqual(errors, [])
  assert.equal(audit.phase, 'scope')
  assert.equal(manifest.workspace.marker, 'security-audit/findings.json')
})

test('the template adds one folder to a repository, and nothing else', () => {
  assert.deepEqual(readdirSync(join(pkg, 'template')), ['security-audit'])
})

test('the report command writes the page, the Markdown report and the verdict', async () => {
  const dir = workspace()
  const { verdict } = await writeReport(dir, { now: '2026-09-29T00:00:00.000Z' })
  assert.match(readFileSync(join(dir, 'security-audit', 'index.html'), 'utf8'), /<h1>Security audit/)
  assert.match(readFileSync(join(dir, 'security-audit', 'report.md'), 'utf8'), /^# Security audit/)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.harness', 'verdict.json'), 'utf8')), verdict)
  assert.equal(verdict.ready, false)
  assert.equal(verdict.artifact, manifest.viewer.url.match(/file=([^&]+)/)[1])
})

test('a broken findings file still gets a page that says what is wrong', async () => {
  const dir = workspace()
  writeFileSync(join(dir, 'security-audit', 'findings.json'), '{ "phase": "scan", "findings": [ { "id": "F-1" } ] }')
  const { errors, verdict } = await writeReport(dir)
  assert.ok(errors.length > 0)
  assert.match(readFileSync(join(dir, 'security-audit', 'index.html'), 'utf8'), /findings\.json has problems/)
  assert.ok(verdict.findings.some((f) => f.kind === 'findings-file'))
})

test('--pdf prints the report to a PDF', { skip: !chrome && 'needs setup and Chrome' }, async () => {
  const dir = workspace()
  await writeReport(dir, { pdf: true })
  assert.equal(readFileSync(join(dir, 'security-audit', 'report.pdf')).subarray(0, 5).toString(), '%PDF-')
})

test('the plugin skills harness.json links are exactly the plugins VERSIONS fetches', () => {
  const versions = readFileSync(join(pkg, 'VERSIONS'), 'utf8')
  const sparse = versions.match(/UPSTREAM_SPARSE="([^"]+)"/)[1].split(' ')
    .filter((p) => p.startsWith('/plugins/')).map((p) => p.replace(/^\/plugins\/|\/$/g, '')).sort()
  assert.ok(manifest.agent.skills.filter((root) => root !== 'skills').every((root) => PLUGIN_SKILLS.test(root)))
  assert.deepEqual([...plugins].sort(), sparse)
})

test('every plugin harness.json links was fetched, with skills in it', { skip: !fetched && 'run toolchain/setup.sh first' }, () => {
  for (const plugin of plugins) {
    const dir = join(pkg, 'upstream', 'plugins', plugin, 'skills')
    assert.ok(existsSync(dir), plugin)
    assert.ok(readdirSync(dir).some((name) => existsSync(join(dir, name, 'SKILL.md'))), plugin)
  }
})

test('no two linked skills share a name, which would refuse the launch', { skip: !fetched && 'run toolchain/setup.sh first' }, () => {
  const names = manifest.agent.skills.flatMap((root) => readdirSync(join(pkg, root)).filter((n) => existsSync(join(pkg, root, n, 'SKILL.md'))))
  assert.equal(new Set(names).size, names.length, names.join(', '))
})

test('every sub-agent a linked skill names has the prompt file the bridging skill points at', { skip: !fetched && 'run toolchain/setup.sh first' }, () => {
  const named = new Set()
  for (const plugin of plugins) {
    const dir = join(pkg, 'upstream', 'plugins', plugin, 'skills')
    for (const skill of readdirSync(dir)) {
      const text = existsSync(join(dir, skill, 'SKILL.md')) ? readFileSync(join(dir, skill, 'SKILL.md'), 'utf8') : ''
      for (const [, owner, agent] of text.matchAll(/\b([a-z0-9-]+):([a-z0-9-]+-(?:worker|judge|analyzer|verifier|builder|modeler))\b/g)) named.add(`${owner}/${agent}`)
    }
  }
  assert.ok(named.size > 0)
  for (const ref of named) {
    const [owner, agent] = ref.split('/')
    assert.ok(existsSync(join(pkg, 'upstream', 'plugins', owner, 'agents', `${agent}.md`)), ref)
  }
})
