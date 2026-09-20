// `builder check`: the quality bar a harness must clear before the Store, as machine checks.
//
// What a machine can say about a package: the manifest keeps the contract, every file it names exists,
// the scripts are executable, the toolchain is pinned and installs nothing globally, the runtimes
// helper is the canonical copy, the skills are well formed, credit and licences are present, and no
// private data is in any text file. Whether the viewer is delightful or the skills are expert is the
// proofs' job; this is the floor under them.
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { ENGINES, skillDirsIn } from './materialize.mjs'
import { PROOF_IDS } from './state.mjs'

const SKIP_DIRS = new Set(['node_modules', '.venv', '.conda', '.playwright', 'vendor', 'upstream', 'reference', '.git', 'dist', '__pycache__', '.pytest_cache', 'build'])
const TEXT_EXT = new Set(['', '.md', '.json', '.sh', '.mjs', '.js', '.cjs', '.ts', '.py', '.html', '.css', '.txt', '.toml', '.yaml', '.yml', '.in', '.lock'])

function finding(severity, kind, message, ref) {
  return { severity, kind, message, ...(ref ? { ref } : {}) }
}

function isExecutable(file) {
  try { accessSync(file, constants.X_OK); return true } catch { return false }
}

export function walkText(root, limit = 4000) {
  const files = []
  const walk = (dir, depth) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (files.length >= limit) return
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && depth < 8) walk(p, depth + 1); continue }
      if (!e.isFile() || !TEXT_EXT.has(extname(e.name).toLowerCase())) continue
      try { if (statSync(p).size > 512_000) continue } catch { continue }
      files.push(p)
    }
  }
  walk(root, 0)
  return files
}

/** Private data a package must never carry: home paths with a name, email addresses, tokens. */
export function privateDataIn(text) {
  const hits = []
  const home = text.match(/(?:\/Users|\/home)\/(?!example\b|runner\b|user\b|you\b|<)[A-Za-z0-9._-]{2,}\//)
  if (home) hits.push(`home path ${home[0]}`)
  const email = text.match(/\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b|users\.noreply\.github\.com\b|anthropic\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/)
  if (email && !/^(?:git|noreply|no-reply)@/.test(email[0])) hits.push(`email ${email[0]}`)
  const token = text.match(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abp]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/)
  if (token) hits.push('an access token')
  return hits
}

/** Skill frontmatter: name and description, name matching its folder. */
function checkSkill(dir, pkg, findings) {
  const rel = relative(pkg, join(dir, 'SKILL.md'))
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  const front = text.match(/^---\n([\s\S]*?)\n---/)
  if (!front) { findings.push(finding('error', 'skill_frontmatter', 'SKILL.md has no frontmatter (name, description)', rel)); return }
  const name = front[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = front[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  const folder = dir.split('/').pop()
  if (!name) findings.push(finding('error', 'skill_frontmatter', 'SKILL.md frontmatter has no name', rel))
  else if (name !== folder) findings.push(finding('warning', 'skill_name', `skill name "${name}" differs from its folder "${folder}"`, rel))
  if (!description) findings.push(finding('error', 'skill_frontmatter', 'SKILL.md frontmatter has no description', rel))
  else if (description.length < 40) findings.push(finding('warning', 'skill_description', 'a skill description should say what it is and when to use it', rel))
  if (text.length < 600) findings.push(finding('warning', 'skill_thin', 'the skill is very short for an expert workflow', rel))
}

export const EVALUATION_METHODS = ['tool', 'checks', 'review', 'none']

/**
 * How the harness says it judges its output, on the store page (`store.json` `evaluation`), against
 * what its verdicts reported in the proofs: declared, well formed, honest (`none` alone), and the
 * same methods the harness actually ran — a page may not promise a check the verdict never reports.
 */
export function evaluationFindings(declared, proofVerdicts = []) {
  const findings = []
  if (declared === undefined) {
    findings.push(finding('warning', 'store_evaluation', 'store.json does not say how the harness judges its output (evaluation: [{ method, by }])', 'store.json'))
    return findings
  }
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > 4) {
    findings.push(finding('error', 'store_evaluation', 'store.json evaluation is one to four { method, by } entries', 'store.json'))
    return findings
  }
  for (const [i, entry] of declared.entries()) {
    if (!EVALUATION_METHODS.includes(entry?.method)) findings.push(finding('error', 'store_evaluation', `evaluation ${i + 1}: method is tool, checks, review or none`, 'store.json'))
    if (entry?.by !== undefined && (typeof entry.by !== 'string' || !entry.by.trim() || entry.by.length > 80)) findings.push(finding('error', 'store_evaluation', `evaluation ${i + 1}: by is a short phrase (≤ 80 characters)`, 'store.json'))
    for (const key of Object.keys(entry ?? {})) if (!['method', 'by'].includes(key)) findings.push(finding('error', 'store_evaluation', `evaluation ${i + 1}: unknown field ${key} (passed and gate belong in the verdict)`, 'store.json'))
  }
  const methods = new Set(declared.map((e) => e?.method))
  if (methods.has('none') && methods.size > 1) findings.push(finding('error', 'store_evaluation', 'evaluation "none" means nothing verifies the output; it cannot sit beside a check', 'store.json'))

  const reported = proofVerdicts.filter(Boolean)
  if (reported.length) {
    const ran = new Set(reported.flatMap((v) => (Array.isArray(v.evaluation) ? v.evaluation : []).map((e) => e?.method)))
    if (ran.size === 0) {
      findings.push(finding('warning', 'verdict_evaluation', 'no proof verdict says what ready rests on: write evaluation into .harness/verdict.json', 'toolchain/check'))
    } else {
      for (const method of methods) {
        if (method !== 'none' && !ran.has(method)) findings.push(finding('error', 'store_evaluation_unproved', `store.json declares a ${method} evaluation no proof verdict reported`, 'store.json'))
      }
      for (const method of ran) {
        if (!methods.has(method)) findings.push(finding('warning', 'store_evaluation_missing', `the proofs' verdicts report a ${method} evaluation store.json does not declare`, 'store.json'))
      }
    }
  }
  return findings
}

/** The whole bar, for the package at `pkg`. `options.reference` is the OpenHarness copy. */
export function checkPackage(pkg, { reference, build, fresh, proofVerdicts = [] } = {}) {
  const findings = []
  const manifestPath = join(pkg, 'harness.json')
  if (!existsSync(manifestPath)) {
    findings.push(finding('error', 'manifest_missing', 'package/harness.json does not exist; run "$BUILDER" scaffold', 'package/harness.json'))
    return { findings, counts: count(findings) }
  }
  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch (error) {
    findings.push(finding('error', 'manifest_json', `harness.json is not valid JSON: ${error.message}`, 'package/harness.json'))
    return { findings, counts: count(findings) }
  }

  // The contract.
  if (manifest.spec !== 1) findings.push(finding('error', 'manifest_spec', 'spec must be 1', 'harness.json'))
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(manifest.id ?? '')) findings.push(finding('error', 'manifest_id', 'id must be owner/name in lower case', 'harness.json'))
  for (const field of ['name', 'description', 'category', 'author']) {
    if (!manifest[field]) findings.push(finding(field === 'name' || field === 'description' ? 'error' : 'warning', `manifest_${field}`, `harness.json has no ${field}`, 'harness.json'))
  }
  if (!ENGINES.includes(manifest.engine)) findings.push(finding('error', 'manifest_engine', `engine must be one of ${ENGINES.join(', ')}`, 'harness.json'))

  const ws = manifest.workspace ?? {}
  if (!ws.template) findings.push(finding('warning', 'workspace_template', 'no workspace template: a new workspace starts empty', 'harness.json'))
  else if (!existsSync(join(pkg, ws.template))) findings.push(finding('error', 'workspace_template', `template ${ws.template} does not exist`, 'harness.json'))
  if (!ws.marker) findings.push(finding('warning', 'workspace_marker', 'no marker: the template is copied and init runs at every create', 'harness.json'))
  else if (ws.template && existsSync(join(pkg, ws.template)) && !existsSync(join(pkg, ws.template, ws.marker)) && !ws.init) {
    findings.push(finding('warning', 'workspace_marker', `the template has no ${ws.marker} and there is no init to create it`, 'harness.json'))
  }
  for (const key of ['init']) {
    if (ws[key] && !existsSync(join(pkg, ws[key]))) findings.push(finding('error', 'workspace_init', `${ws[key]} does not exist`, 'harness.json'))
    else if (ws[key] && !isExecutable(join(pkg, ws[key]))) findings.push(finding('error', 'not_executable', `${ws[key]} is not executable`, ws[key]))
  }

  const agent = manifest.agent ?? {}
  if (!agent.instructions) findings.push(finding('error', 'agent_instructions', 'no agent.instructions: the harness agent is told nothing', 'harness.json'))
  else if (!existsSync(join(pkg, agent.instructions))) findings.push(finding('error', 'agent_instructions', `${agent.instructions} does not exist`, 'harness.json'))
  else {
    const text = readFileSync(join(pkg, agent.instructions), 'utf8')
    if (text.length < 1200) findings.push(finding('warning', 'agent_instructions_thin', 'AGENTS.md is short: role, where things are, how to work so the pane moves, what good looks like', agent.instructions))
    if (!/pane|viewer/i.test(text)) findings.push(finding('warning', 'agent_instructions_pane', 'AGENTS.md never mentions the viewer pane', agent.instructions))
  }
  const skillDirs = (agent.skills ?? []).flatMap((root) => {
    if (!existsSync(join(pkg, root))) { findings.push(finding('error', 'skills_missing', `skills folder ${root} does not exist`, 'harness.json')); return [] }
    return skillDirsIn(join(pkg, root))
  })
  if (!skillDirs.length) findings.push(finding('error', 'skills_none', 'the harness ships no skills', 'harness.json'))
  for (const dir of skillDirs) checkSkill(dir, pkg, findings)

  // Toolchain.
  const toolchain = manifest.toolchain ?? {}
  for (const key of ['setup', 'doctor']) {
    const file = toolchain[key]
    if (!file) { findings.push(finding(key === 'setup' ? 'warning' : 'error', `toolchain_${key}`, `no toolchain.${key}`, 'harness.json')); continue }
    if (!existsSync(join(pkg, file))) findings.push(finding('error', `toolchain_${key}`, `${file} does not exist`, 'harness.json'))
    else if (!isExecutable(join(pkg, file))) findings.push(finding('error', 'not_executable', `${file} is not executable`, file))
  }
  const scripts = walkText(pkg).filter((f) => f.endsWith('.sh') || !extname(f))
  // The package's own commands, without the shared runtimes helper (whose comments name the very
  // installs it exists to avoid) and without comment lines.
  const setupText = scripts
    .filter((f) => !f.endsWith('runtimes.sh'))
    .map((f) => { try { return readFileSync(f, 'utf8') } catch { return '' } })
    .join('\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  const globalInstall = setupText.match(/\bbrew install\b|\bsudo\s|\bnpm (?:install|i) -g\b|\bpip3? install --user\b|\bapt(?:-get)? install\b/)
  if (globalInstall) findings.push(finding('error', 'global_install', `a script installs outside the package (${globalInstall[0].trim()}); use runtimes.sh and the package directory`, 'toolchain'))
  const downloads = /\bcurl\b|\bwget\b|\bnpm (?:ci|install)\b|\bharness_pip\b|\bpip3? install\b|\bharness_conda_env\b|\buv (?:pip|sync)\b/.test(setupText)
  const pinned = ['VERSIONS', 'toolchain/VERSIONS', 'package-lock.json', 'toolchain/package-lock.json', 'requirements.lock', 'toolchain/requirements.lock', 'uv.lock']
    .some((f) => existsSync(join(pkg, f)))
  if (downloads && !pinned) findings.push(finding('warning', 'toolchain_unpinned', 'setup downloads, but there is no VERSIONS file or lockfile pinning what it gets', 'toolchain'))
  const loosePip = setupText.match(/harness_pip\s+\S+\s+(?:[^\n]*\s)?([A-Za-z][\w.-]+)(?=\s|$)(?![^\n]*==)/)
  if (loosePip && !/==|-r\s/.test(loosePip[0])) findings.push(finding('warning', 'toolchain_unpinned', `a pip install without an exact version (${loosePip[0].trim().slice(0, 80)})`, 'toolchain'))

  const sourcesRuntimes = scripts.some((f) => !f.endsWith('runtimes.sh') && /runtimes\.sh/.test(readFileSync(f, 'utf8')))
  if (sourcesRuntimes) {
    const copy = join(pkg, 'toolchain', 'runtimes.sh')
    const canonical = reference ? join(reference, 'store', 'tools', 'runtimes.sh') : null
    if (!existsSync(copy)) findings.push(finding('error', 'runtimes_missing', 'a script sources runtimes.sh but toolchain/runtimes.sh is missing', 'toolchain/runtimes.sh'))
    else if (canonical && existsSync(canonical) && readFileSync(copy, 'utf8') !== readFileSync(canonical, 'utf8')) {
      findings.push(finding('warning', 'runtimes_drift', 'toolchain/runtimes.sh differs from the canonical store/tools/runtimes.sh; copy it verbatim', 'toolchain/runtimes.sh'))
    }
  }

  // Viewer and verdict.
  if (!manifest.verdict) findings.push(finding('error', 'verdict_missing', 'no verdict: the harness declares no evaluation the pane can show', 'harness.json'))
  const viewer = manifest.viewer
  if (!viewer) findings.push(finding('warning', 'viewer_missing', 'no viewer: the work in progress is not shown', 'harness.json'))
  else if (viewer.use) {
    if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(viewer.use)) findings.push(finding('error', 'viewer_use', `viewer.use "${viewer.use}" is not a package id`, 'harness.json'))
  } else {
    if (!viewer.command) findings.push(finding('error', 'viewer_command', 'viewer has neither use nor command', 'harness.json'))
    else if (!/[\s;&|]/.test(viewer.command) && !existsSync(join(pkg, viewer.command))) findings.push(finding('error', 'viewer_command', `${viewer.command} does not exist`, 'harness.json'))
    else if (!/[\s;&|]/.test(viewer.command) && !isExecutable(join(pkg, viewer.command))) findings.push(finding('error', 'not_executable', `${viewer.command} is not executable`, viewer.command))
    if (!viewer.url || !viewer.url.includes('${port}')) findings.push(finding('error', 'viewer_url', 'viewer.url must contain ${port}', 'harness.json'))
    if (viewer.url && !/^http:\/\/127\.0\.0\.1:/.test(viewer.url)) findings.push(finding('error', 'viewer_url', 'viewer.url must be http://127.0.0.1:${port}/…', 'harness.json'))
  }

  // Credit, licences, the Store.
  if (!existsSync(join(pkg, 'LICENSE'))) findings.push(finding('error', 'license_missing', 'no LICENSE for the harness', 'LICENSE'))
  if (!existsSync(join(pkg, 'README.md'))) findings.push(finding('error', 'readme_missing', 'no README.md', 'README.md'))
  else if (!/credit/i.test(readFileSync(join(pkg, 'README.md'), 'utf8'))) findings.push(finding('warning', 'readme_credit', 'README.md has no credit section for the upstream project', 'README.md'))
  const storePath = join(pkg, 'store.json')
  if (!existsSync(storePath)) findings.push(finding('warning', 'store_missing', 'no store.json (homepage, upstream, license, examples)', 'store.json'))
  else {
    let store = null
    try { store = JSON.parse(readFileSync(storePath, 'utf8')) } catch { findings.push(finding('error', 'store_json', 'store.json is not valid JSON', 'store.json')) }
    if (store) {
      for (const field of ['homepage', 'upstream', 'license']) if (!store[field]) findings.push(finding('warning', `store_${field}`, `store.json has no ${field}`, 'store.json'))
      const examples = Array.isArray(store.examples) ? store.examples : []
      if (examples.length < 3) findings.push(finding('warning', 'store_examples', `store.json has ${examples.length} example${examples.length === 1 ? '' : 's'}; the Store page leads with three from the proofs`, 'store.json'))
      for (const [i, ex] of examples.entries()) {
        if (!ex.prompt) findings.push(finding('error', 'store_example', `example ${i + 1} has no prompt`, 'store.json'))
        if (!ex.caption) findings.push(finding('warning', 'store_example', `example ${i + 1} has no caption`, 'store.json'))
        // The registry's limits (StoreExampleSchema): a longer one is refused when the Store publishes.
        else if (String(ex.caption).length > 120) findings.push(finding('error', 'store_example', `example ${i + 1}: the caption is ${String(ex.caption).length} characters; the Store takes 120`, 'store.json'))
        if (ex.prompt && String(ex.prompt).length > 600) findings.push(finding('error', 'store_example', `example ${i + 1}: the prompt is ${String(ex.prompt).length} characters; the Store takes 600`, 'store.json'))
        // The Store reads pictures from an https URL and ignores anything else, so a path here is a
        // page with no picture — the one thing the page is for.
        if (ex.image !== undefined && !String(ex.image).startsWith('https://')) {
          findings.push(finding('error', 'store_example_image', `example ${i + 1}: an image is an https URL, not "${ex.image}"; pass --base-url to "$BUILDER" showcase`, 'store.json'))
        }
      }
      const shots = existsSync(join(pkg, 'showcase')) ? readdirSync(join(pkg, 'showcase')).filter((f) => /\.(jpe?g|png)$/i.test(f)) : []
      if (shots.length && !examples.some((ex) => String(ex.image ?? '').startsWith('https://'))) {
        findings.push(finding('warning', 'store_example_image', `showcase/ has ${shots.length} picture${shots.length === 1 ? '' : 's'} no example points at; the page shows none until they have a public URL`, 'store.json'))
      }
      findings.push(...evaluationFindings(store.evaluation, proofVerdicts))
      // The line under the name in the picker: what a person can now finish, in their words.
      if (!store.tagline) findings.push(finding('warning', 'store_tagline', 'store.json has no tagline: one line, what a person can now finish', 'store.json'))
      else if (String(store.tagline).length > 80) findings.push(finding('error', 'store_tagline', `the tagline is ${String(store.tagline).length} characters; the Store takes 80`, 'store.json'))
      if (store.listed === false) findings.push(finding('info', 'store_unlisted', 'listed: false — the package stays out of the Store until the proofs meet the bar', 'store.json'))
    }
  }

  // The tile's face. A project's own logo or nothing: a mark invented for someone else's project is
  // worse than the initial the app draws.
  const brand = ['brand/logo.svg', 'brand/logo.png', 'brand/icon.png', 'brand/icon.svg'].filter((f) => existsSync(join(pkg, f)))
  if (!brand.length) findings.push(finding('warning', 'brand_missing', 'no brand/logo.svg or brand/icon.png: the tile draws an initial (right when the project publishes no logo, a gap otherwise)', 'brand/'))

  // The pane must open something real before the first prompt: a person sees the craft the moment
  // the tab appears, and the agent's first save changes something rather than filling a void.
  const templateDir = manifest.workspace?.template ? join(pkg, manifest.workspace.template) : null
  if (templateDir && existsSync(templateDir)) {
    // Every file, not only the text ones: a craft's example is as often a mesh, a WAV or a PDF.
    let bytes = 0
    const weigh = (dir, depth) => {
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name === '.harness' || e.name === '.builder' || e.name === '.gitkeep') continue
        const f = join(dir, e.name)
        if (e.isDirectory()) { if (depth < 6) weigh(f, depth + 1); continue }
        try { bytes += statSync(f).size } catch { /* raced */ }
      }
    }
    weigh(templateDir, 0)
    if (bytes < 400) {
      findings.push(finding('warning', 'template_empty', 'the template opens nothing before the first prompt: ship a small, complete, authored example of the craft', manifest.workspace.template))
    }
  }

  // Private data, in every text file of the package. Home paths and tokens are never right. An email
  // address can be a project's public contact, and a licence's copyright line names its maintainers, so
  // an address outside a licence file asks to be confirmed rather than failing the check.
  for (const file of walkText(pkg)) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const licence = /^(LICEN[SC]E|COPYING|NOTICE|THIRD_PARTY_NOTICES)/i.test(file.split('/').pop())
    for (const hit of privateDataIn(text)) {
      if (hit.startsWith('email')) {
        if (!licence) findings.push(finding('warning', 'email_address', `${hit} — confirm it is a public project contact, not a person's address`, relative(pkg, file)))
      } else {
        findings.push(finding('error', 'private_data', `${hit} — no private data in the package`, relative(pkg, file)))
      }
    }
  }

  // The build around the package: the promise, evaluation declared, fresh install, proofs.
  if (build) {
    if (!build.promise) {
      findings.push(finding('warning', 'promise_missing', 'the build does not say what a person can now finish: "$BUILDER" promise "A person can now …"', '.builder/build.json'))
    }
    if (!existsSync(join(pkg, 'toolchain', 'check')) && !build.evaluation?.length) {
      findings.push(finding('warning', 'evaluation_undeclared', 'no toolchain/check and no evaluation declared', 'toolchain/check'))
    }
    const passed = PROOF_IDS.filter((id) => build.proofs?.[id]?.state === 'passed')
    if (passed.length < PROOF_IDS.length) findings.push(finding('warning', 'proofs', `${passed.length} of ${PROOF_IDS.length} proofs passed (${PROOF_IDS.filter((id) => !passed.includes(id)).join(', ')} outstanding)`, '.builder/proofs'))
    // Three briefs that read as one brief three times is the withdrawn kind: one answer, retyped.
    // Materially different jobs share little vocabulary; a swapped noun shares nearly all of it.
    const briefs = ['easy', 'medium', 'hard'].map((id) => build.proofs?.[id]?.prompt).filter(Boolean)
    if (briefs.length === 3) {
      const words = briefs.map((b) => new Set(b.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []))
      const overlap = (a, b) => {
        const shared = [...a].filter((w) => b.has(w)).length
        const union = new Set([...a, ...b]).size
        return union ? shared / union : 1
      }
      const pairs = [overlap(words[0], words[1]), overlap(words[0], words[2]), overlap(words[1], words[2])]
      const alike = pairs.reduce((s, v) => s + v, 0) / pairs.length
      if (alike >= 0.5) {
        findings.push(finding('warning', 'proof_briefs_alike', `the three briefs share ${Math.round(alike * 100)}% of their words; they must be materially different jobs, not one brief with a noun swapped`, '.builder/proofs'))
      }
    }
  }
  if (fresh === null || fresh === undefined) findings.push(finding('warning', 'fresh_not_run', 'the fresh-machine install has not been run ("$BUILDER" fresh)', '.builder/fresh.json'))
  else if (!fresh.passed) findings.push(finding('error', 'fresh_failed', `the fresh-machine install failed at ${fresh.failedAt ?? 'a step'}`, '.builder/fresh.json'))

  return { findings, counts: count(findings) }
}

/** `harness dsh check`, when the CLI is on this machine: the registry's own conformance check. */
export function harnessDshCheck(pkg) {
  const run = spawnSync('harness', ['dsh', 'check', pkg], { encoding: 'utf8', timeout: 60_000 })
  if (run.error) return null
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`
  return { exit: run.status, text: text.slice(-4000) }
}

function count(findings) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
  }
}
