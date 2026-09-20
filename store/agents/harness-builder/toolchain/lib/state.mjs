// The Builder's state: `.builder/build.json` in the Builder workspace, and the verdict it drives.
//
// build.json is the one record of the build — the target, the stages, the evaluation declared for the
// harness being built, the proofs — and every `builder` command reads and rewrites it atomically. The
// verdict (`.harness/verdict.json`) is derived from it on every write, so the pane header and Builder
// Studio never disagree with the state they show.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const STAGES = [
  { id: 'research', name: 'Research' },
  { id: 'toolchain', name: 'Toolchain' },
  { id: 'skills', name: 'Skills' },
  { id: 'viewer', name: 'Viewer' },
  { id: 'evaluation', name: 'Evaluation' },
  { id: 'proof', name: 'Proof' },
  { id: 'store', name: 'Store' },
]
export const STATES = new Set(['pending', 'active', 'done', 'failed'])
// Three materially different briefs, then the revision: a harness that cannot continue the work
// makes one-shot output, and nobody finishes real work in one shot.
export const PROOF_IDS = ['easy', 'medium', 'hard', 'revision']

export function paths(workspace) {
  const builder = join(workspace, '.builder')
  return {
    workspace,
    builder,
    package: join(workspace, 'package'),
    build: join(builder, 'build.json'),
    brief: join(builder, 'brief.md'),
    decisions: join(builder, 'decisions.md'),
    check: join(builder, 'check.json'),
    fresh: join(builder, 'fresh.json'),
    proofs: join(builder, 'proofs'),
    showcase: join(builder, 'showcase'),
    verdict: join(workspace, '.harness', 'verdict.json'),
  }
}

export function defaultBuild() {
  return {
    spec: 1,
    target: null,
    stages: STAGES.map((s) => ({ ...s, state: 'pending', note: '', updatedAt: null })),
    evaluation: [],
    proofs: {},
    log: [],
    updatedAt: new Date().toISOString(),
  }
}

/** Write JSON through a temporary file, so a reader never sees half a file. */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** build.json, with any stage the file lacks filled in: an older file keeps working. */
export function readBuild(workspace) {
  const p = paths(workspace)
  const build = readJson(p.build, null) ?? defaultBuild()
  const byId = new Map((build.stages ?? []).map((s) => [s.id, s]))
  build.stages = STAGES.map((s) => ({ ...s, state: 'pending', note: '', updatedAt: null, ...byId.get(s.id), name: s.name }))
  build.proofs ??= {}
  build.evaluation ??= []
  build.log ??= []
  return build
}

export function saveBuild(workspace, build) {
  build.updatedAt = new Date().toISOString()
  writeJsonAtomic(paths(workspace).build, build)
  writeVerdict(workspace, build)
  return build
}

export function log(build, message) {
  build.log.push({ at: new Date().toISOString(), message })
  if (build.log.length > 200) build.log.splice(0, build.log.length - 200)
}

export function setStage(build, id, state, note) {
  const stage = build.stages.find((s) => s.id === id)
  if (!stage) throw new Error(`unknown stage "${id}"; stages are ${STAGES.map((s) => s.id).join(', ')}`)
  if (!STATES.has(state)) throw new Error(`unknown state "${state}"; use ${[...STATES].join(', ')}`)
  // One stage is active at a time: starting a stage settles the one before it as it stood. Going back to
  // an earlier stage to fix something a later one found (a proof shows a skill gap) remembers where the
  // work was, and finishing the fix returns there — so the track never shows Proof as not started.
  const order = (sid) => build.stages.findIndex((s) => s.id === sid)
  if (state === 'active') {
    for (const other of build.stages) {
      if (other.id === id || other.state !== 'active') continue
      other.state = 'pending'
      if (order(other.id) > order(id)) build.returnTo = other.id
    }
  }
  stage.state = state
  if (note !== undefined) stage.note = note
  stage.updatedAt = new Date().toISOString()
  log(build, `${stage.name}: ${state}${note ? ` — ${note}` : ''}`)
  if (state === 'done' && build.returnTo && order(build.returnTo) > order(id)) {
    const back = build.stages.find((s) => s.id === build.returnTo)
    delete build.returnTo
    if (back && back.state === 'pending' && !build.stages.some((s) => s.state === 'active')) {
      back.state = 'active'
      back.updatedAt = stage.updatedAt
      log(build, `${back.name}: active — back after the ${stage.name.toLowerCase()} fix`)
    }
  } else if (state === 'active' && build.returnTo === id) {
    delete build.returnTo
  }
  return stage
}

/** The verdict for the Builder workspace, derived from build.json and the latest check. */
export function verdictFor(workspace, build) {
  const p = paths(workspace)
  const check = readJson(p.check, null)
  const fresh = readJson(p.fresh, null)
  const proofs = PROOF_IDS.map((id) => build.proofs[id]).filter(Boolean)
  const passedProofs = proofs.filter((proof) => proof.state === 'passed').length
  const findings = [...(check?.findings ?? [])].slice(0, 50)
  const errors = findings.filter((f) => f.severity === 'error').length
  const warnings = findings.filter((f) => f.severity === 'warning').length

  const evaluation = [
    { method: 'tool', by: 'builder check', passed: check ? errors === 0 : null, gate: true },
    { method: 'tool', by: 'fresh-machine install', passed: fresh ? fresh.passed === true : null, gate: true },
    // Passed when all three passed review, failed when one failed; until then, not yet known.
    { method: 'review', by: 'three briefs and a revision, reviewed frame by frame', passed: passedProofs === PROOF_IDS.length ? true : proofs.some((proof) => proof.state === 'failed') ? false : null, gate: true },
  ]
  const allDone = build.stages.every((s) => s.state === 'done')
  const ready = allDone && evaluation.every((e) => e.passed === true) && errors === 0

  const active = build.stages.find((s) => s.state === 'active') ?? build.stages.find((s) => s.state === 'failed')
  const target = build.target?.name ?? build.target?.tool
  const parts = []
  if (target) parts.push(target)
  if (ready) parts.push('ready for the Store')
  else if (active) parts.push(`${active.name}${active.note ? ` · ${active.note}` : ''}`)
  else if (!target) parts.push('name a tool to build a harness for')
  if (proofs.length) parts.push(`${passedProofs}/${PROOF_IDS.length} proofs`)
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`)
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`)

  const artifact = build.target ? 'package/harness.json' : undefined
  return {
    spec: 1,
    ready,
    summary: parts.join(' · ').slice(0, 200),
    findings,
    ...(artifact ? { artifact } : {}),
    phases: build.stages.map((s) => ({ id: s.id, name: s.name, state: s.state })),
    evaluation,
    updatedAt: new Date().toISOString(),
  }
}

export function writeVerdict(workspace, build) {
  const verdict = verdictFor(workspace, build)
  writeJsonAtomic(paths(workspace).verdict, verdict)
  return verdict
}

export function ensureWorkspace(workspace) {
  const p = paths(workspace)
  mkdirSync(p.builder, { recursive: true })
  if (!existsSync(p.decisions)) {
    writeFileSync(p.decisions, '# Decisions\n\nOne entry per decision: what, and why.\n')
  }
  const build = readBuild(workspace)
  return saveBuild(workspace, build)
}
