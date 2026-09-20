// node --test store/agents/harness-builder/test/ — the Builder's own logic, without a network, a
// browser or an engine: the build record and its verdict, scaffolding, the quality bar, and laying out
// a workspace the way Harness does.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkPackage, evaluationFindings, privateDataIn } from '../toolchain/lib/check.mjs'
import { launchEnv, materialize } from '../toolchain/lib/materialize.mjs'
import { agentEnv, fingerprint, markProof, packageFingerprint } from '../toolchain/lib/proof.mjs'
import { scaffold, slug } from '../toolchain/lib/scaffold.mjs'
import { STAGES, ensureWorkspace, readBuild, saveBuild, setStage, verdictFor } from '../toolchain/lib/state.mjs'
import { currentArtifact, viewerUrl } from '../toolchain/lib/viewer.mjs'

const REPO_STORE = fileURLToPath(new URL('../../../', import.meta.url))
const roots = []
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'builder-test-'))
  roots.push(dir)
  return dir
}
after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }) })

describe('the build record', () => {
  it('starts with every stage pending and a verdict that asks for a tool', () => {
    const ws = tmp()
    const build = ensureWorkspace(ws)
    assert.deepEqual(build.stages.map((s) => s.id), STAGES.map((s) => s.id))
    assert.ok(build.stages.every((s) => s.state === 'pending'))
    const verdict = JSON.parse(readFileSync(join(ws, '.harness', 'verdict.json'), 'utf8'))
    assert.equal(verdict.ready, false)
    assert.match(verdict.summary, /name a tool/)
    assert.equal(verdict.phases.length, STAGES.length)
    assert.ok(existsSync(join(ws, '.builder', 'decisions.md')))
  })

  it('keeps one stage active at a time and says where the work is', () => {
    const ws = tmp()
    const build = ensureWorkspace(ws)
    build.target = { id: 'example/vega-lite', name: 'Vega-Lite', engine: 'claude' }
    setStage(build, 'research', 'active', 'reading the docs')
    setStage(build, 'toolchain', 'active', 'pinning')
    saveBuild(ws, build)
    const again = readBuild(ws)
    assert.equal(again.stages.find((s) => s.id === 'research').state, 'pending')
    assert.equal(again.stages.find((s) => s.id === 'toolchain').state, 'active')
    const verdict = verdictFor(ws, again)
    assert.match(verdict.summary, /^Vega-Lite · Toolchain · pinning/)
    assert.equal(verdict.artifact, 'package/harness.json')
  })

  it('returns to the later stage once a fix it sent the work back for is done', () => {
    const build = ensureWorkspace(tmp())
    for (const id of ['research', 'toolchain', 'skills', 'viewer', 'evaluation']) setStage(build, id, 'done')
    setStage(build, 'proof', 'active', 'three proofs')
    setStage(build, 'skills', 'active', 'a proof found a gap')
    assert.equal(build.stages.find((s) => s.id === 'proof').state, 'pending')
    setStage(build, 'skills', 'done')
    const proof = build.stages.find((s) => s.id === 'proof')
    assert.equal(proof.state, 'active')
    assert.equal(proof.note, 'three proofs')
    assert.equal(build.returnTo, undefined)
    // Moving forward is not a fix: nothing to return to.
    setStage(build, 'store', 'active')
    setStage(build, 'store', 'done')
    assert.equal(build.stages.find((s) => s.id === 'proof').state, 'pending')
  })

  it('settles a finished proof stage as done when the work moves on, and never overstates the rest', () => {
    const ws = tmp()
    const build = ensureWorkspace(ws)
    for (const id of ['research', 'toolchain', 'skills', 'viewer', 'evaluation']) setStage(build, id, 'done')
    setStage(build, 'proof', 'active', 'three briefs and a revision')
    for (const pid of ['easy', 'medium', 'hard', 'revision']) build.proofs[pid] = { state: 'passed' }
    setStage(build, 'store', 'active')
    assert.equal(build.stages.find((s) => s.id === 'proof').state, 'done', 'four passed proofs are a finished proof stage')

    // A proof still outstanding is not a finished stage: the record says pending, as it should.
    const partial = ensureWorkspace(tmp())
    setStage(partial, 'proof', 'active')
    partial.proofs = { easy: { state: 'passed' }, medium: { state: 'passed' }, hard: { state: 'passed' } }
    setStage(partial, 'store', 'active')
    assert.equal(partial.stages.find((s) => s.id === 'proof').state, 'pending')

    // The stages a machine cannot judge stay the agent's word.
    const viewer = ensureWorkspace(tmp())
    setStage(viewer, 'viewer', 'active')
    setStage(viewer, 'evaluation', 'active')
    assert.equal(viewer.stages.find((s) => s.id === 'viewer').state, 'pending')
  })

  it('refuses a stage or state that does not exist', () => {
    const build = ensureWorkspace(tmp())
    assert.throws(() => setStage(build, 'polish', 'active'), /unknown stage/)
    assert.throws(() => setStage(build, 'research', 'started'), /unknown state/)
  })

  it('is ready only when every stage is done, the check is clean, the install passed and every proof passed', () => {
    const ws = tmp()
    const build = ensureWorkspace(ws)
    for (const s of build.stages) setStage(build, s.id, 'done')
    saveBuild(ws, build)
    assert.equal(verdictFor(ws, build).ready, false)
    writeFileSync(join(ws, '.builder', 'check.json'), JSON.stringify({ findings: [], counts: { errors: 0, warnings: 0 } }))
    writeFileSync(join(ws, '.builder', 'fresh.json'), JSON.stringify({ passed: true }))
    build.proofs = { easy: { state: 'passed' }, medium: { state: 'passed' }, hard: { state: 'passed' } }
    assert.equal(verdictFor(ws, build).ready, false, 'the revision is a proof too')
    build.proofs.revision = { state: 'passed' }
    const verdict = verdictFor(ws, build)
    assert.equal(verdict.ready, true)
    assert.match(verdict.summary, /ready for the Store/)
    assert.ok(verdict.evaluation.every((e) => e.passed === true))
  })
})

describe('scaffold', () => {
  it('lays out a package that names the tool, with executable scripts and the canonical runtimes helper', () => {
    const pkg = join(tmp(), 'package')
    const made = scaffold(pkg, { id: 'example/vega-lite', tool: 'Vega-Lite', reference: join(REPO_STORE, '..') })
    const manifest = JSON.parse(readFileSync(join(pkg, 'harness.json'), 'utf8'))
    assert.equal(manifest.id, 'example/vega-lite')
    assert.equal(manifest.name, 'Vega-Lite')
    assert.equal(manifest.agent.env.VEGA_LITE_TOOLCHAIN, '${dsh}/toolchain')
    assert.ok(existsSync(join(pkg, 'skills', 'vega-lite', 'SKILL.md')))
    assert.ok(lstatSync(join(pkg, 'toolchain', 'setup.sh')).mode & 0o111)
    assert.equal(readFileSync(join(pkg, 'toolchain', 'runtimes.sh'), 'utf8'), readFileSync(join(REPO_STORE, 'tools', 'runtimes.sh'), 'utf8'))
    assert.ok(made.created.length >= 12)
  })

  it('never overwrites a file the build already wrote', () => {
    const pkg = join(tmp(), 'package')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'AGENTS.md'), '# mine\n')
    scaffold(pkg, { id: 'example/tool', tool: 'Tool' })
    assert.equal(readFileSync(join(pkg, 'AGENTS.md'), 'utf8'), '# mine\n')
  })

  it('refuses an id that is not owner/name', () => {
    assert.throws(() => scaffold(join(tmp(), 'p'), { id: 'Vega-Lite' }), /owner\/name/)
    assert.equal(slug('Vega-Lite 5!'), 'vega-lite-5')
  })
})

describe('the quality bar', () => {
  it('passes the Store\'s own Marp harness on everything a package itself controls', () => {
    const { findings } = checkPackage(join(REPO_STORE, 'agents', 'marp'), { reference: join(REPO_STORE, '..'), fresh: { passed: true } })
    const errors = findings.filter((f) => f.severity === 'error')
    assert.deepEqual(errors, [])
  })

  it('finds what a scaffold has not done yet', () => {
    const pkg = join(tmp(), 'package')
    scaffold(pkg, { id: 'example/tool', tool: 'Tool', reference: join(REPO_STORE, '..') })
    const { findings } = checkPackage(pkg, { reference: join(REPO_STORE, '..'), build: { proofs: {} } })
    const kinds = new Set(findings.map((f) => f.kind))
    for (const kind of ['manifest_description', 'agent_instructions_thin', 'skill_thin', 'store_examples', 'proofs', 'fresh_not_run']) {
      assert.ok(kinds.has(kind), `expected ${kind}`)
    }
    assert.ok(!kinds.has('global_install'), 'the runtimes helper\'s comments are not an install')
  })

  it('refuses global installs and private data', () => {
    const pkg = join(tmp(), 'package')
    scaffold(pkg, { id: 'example/tool', tool: 'Tool', reference: join(REPO_STORE, '..') })
    writeFileSync(join(pkg, 'toolchain', 'setup.sh'), '#!/usr/bin/env bash\n# brew install is how people do it, but not here\nbrew install lilypond\n')
    chmodSync(join(pkg, 'toolchain', 'setup.sh'), 0o755)
    writeFileSync(join(pkg, 'skills', 'tool', 'notes.md'), 'Built on /Users/alice/code/tool by alice@corp.io\n')
    const kinds = checkPackage(pkg, {}).findings.filter((f) => f.severity === 'error').map((f) => f.kind)
    assert.ok(kinds.includes('global_install'))
    assert.equal(kinds.filter((k) => k === 'private_data').length, 1)
  })

  it('holds the store page\'s evaluation to what the proofs\' verdicts reported', () => {
    const kinds = (declared, verdicts) => evaluationFindings(declared, verdicts).map((f) => `${f.severity}:${f.kind}`)
    const tool = { method: 'tool', by: 'the Vega-Lite compiler' }
    const checks = { method: 'checks', by: 'the request' }
    assert.deepEqual(kinds(undefined), ['warning:store_evaluation'])
    assert.deepEqual(kinds([]), ['error:store_evaluation'])
    assert.deepEqual(kinds([{ method: 'vibes' }]), ['error:store_evaluation'])
    assert.deepEqual(kinds([{ ...tool, passed: true }]), ['error:store_evaluation'])
    assert.deepEqual(kinds([tool, { method: 'none' }]), ['error:store_evaluation'])
    assert.deepEqual(kinds([tool, checks]), [], 'no proofs yet: nothing to hold it to')
    const reported = { ready: true, evaluation: [{ method: 'tool', passed: true, gate: true }] }
    assert.deepEqual(kinds([tool], [reported, null]), [])
    assert.deepEqual(kinds([tool, checks], [reported]), ['error:store_evaluation_unproved'])
    assert.deepEqual(kinds([checks], [reported]), ['error:store_evaluation_unproved', 'warning:store_evaluation_missing'])
    assert.deepEqual(kinds([tool], [{ ready: true }]), ['warning:verdict_evaluation'])
    assert.deepEqual(kinds([{ method: 'none' }], [{ ready: true, evaluation: [{ method: 'none', passed: null }] }]), [])
  })

  it('notices the harness changing under a proof, and refuses to pass a void run', () => {
    const ws = tmp()
    const build = ensureWorkspace(ws)
    const pkg = join(ws, 'package')
    scaffold(pkg, { id: 'example/tool', tool: 'Tool', reference: join(REPO_STORE, '..') })
    const before = packageFingerprint(pkg)
    writeFileSync(join(pkg, 'skills', 'tool', 'SKILL.md'), '---\nname: tool\ndescription: changed mid-run\n---\n')
    assert.notEqual(packageFingerprint(pkg), before)
    // node_modules is the toolchain's, not the harness's: installing does not void a proof.
    mkdirSync(join(pkg, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(pkg, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    assert.equal(packageFingerprint(pkg), packageFingerprint(pkg))

    build.proofs.easy = { id: 'easy', state: 'void' }
    saveBuild(ws, build)
    assert.throws(() => markProof(ws, 'easy', 'passed', 'looked fine'), /void/)
    markProof(ws, 'easy', 'failed', 'run again')
    assert.equal(readBuild(ws).proofs.easy.state, 'failed')
  })

  it('holds a package to the 2026-09-20 bar: a face, a tagline, and a pane that opens before the first prompt', () => {
    const pkg = join(tmp(), 'package')
    scaffold(pkg, { id: 'example/tool', tool: 'Tool', reference: join(REPO_STORE, '..') })
    const kinds = new Set(checkPackage(pkg, {}).findings.map((f) => f.kind))
    for (const kind of ['store_tagline', 'brand_missing', 'template_empty']) {
      assert.ok(kinds.has(kind), `expected ${kind}`)
    }

    // Met: a logo, a tagline, and a template that already opens something real.
    mkdirSync(join(pkg, 'brand'), { recursive: true })
    writeFileSync(join(pkg, 'brand', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
    writeFileSync(join(pkg, 'store.json'), JSON.stringify({ tagline: 'Turn a recording into a printed score', examples: [] }))
    writeFileSync(join(pkg, 'template', 'example.tool'), 'an authored example of the craft\n'.repeat(30))
    const met = new Set(checkPackage(pkg, {}).findings.map((f) => f.kind))
    for (const kind of ['store_tagline', 'brand_missing', 'template_empty']) {
      assert.ok(!met.has(kind), `${kind} should be met`)
    }

    writeFileSync(join(pkg, 'store.json'), JSON.stringify({ tagline: 't'.repeat(81), examples: [] }))
    assert.equal(checkPackage(pkg, {}).findings.find((f) => f.kind === 'store_tagline')?.severity, 'error')
  })

  it('counts the revision among the proofs, and hears three briefs that are one brief', () => {
    const pkg = join(tmp(), 'package')
    scaffold(pkg, { id: 'example/tool', tool: 'Tool', reference: join(REPO_STORE, '..') })
    const proofs = (prompts) => ({
      proofs: {
        easy: { state: 'passed', prompt: prompts[0] },
        medium: { state: 'passed', prompt: prompts[1] },
        hard: { state: 'passed', prompt: prompts[2] },
      },
    })
    const outstanding = checkPackage(pkg, { build: proofs(['Make a lead sheet for a waltz.', 'Engrave my recording of the fiddle tune.', 'Set a string quartet with parts.']) })
      .findings.find((f) => f.kind === 'proofs')
    assert.match(outstanding.message, /3 of 4 proofs passed \(revision outstanding\)/)

    const alike = ['Make a chart of rainfall.', 'Make a chart of sunshine.', 'Make a chart of wind.']
    assert.ok(checkPackage(pkg, { build: proofs(alike) }).findings.some((f) => f.kind === 'proof_briefs_alike'))
  })

  it('refuses a store picture the Store cannot show', () => {
    const pkg = join(tmp(), 'package')
    scaffold(pkg, { id: 'example/tool', tool: 'Tool', reference: join(REPO_STORE, '..') })
    mkdirSync(join(pkg, 'showcase'), { recursive: true })
    writeFileSync(join(pkg, 'showcase', 'easy.jpg'), 'not really a jpeg')
    const store = { homepage: 'https://example.com', examples: [{ prompt: 'A chart.', image: 'showcase/easy.jpg', caption: 'A chart · 6 bars' }] }
    writeFileSync(join(pkg, 'store.json'), JSON.stringify(store))
    const paths = checkPackage(pkg, {}).findings.filter((f) => f.kind === 'store_example_image')
    assert.deepEqual(paths.map((f) => f.severity), ['error', 'warning'], 'the path is wrong, and the picture it names reaches nobody')

    delete store.examples[0].image
    writeFileSync(join(pkg, 'store.json'), JSON.stringify(store))
    const waiting = checkPackage(pkg, {}).findings.filter((f) => f.kind === 'store_example_image')
    assert.deepEqual(waiting.map((f) => f.severity), ['warning'], 'a picture with no URL yet is a warning')

    store.examples[0].image = 'https://example.com/showcase/easy.jpg'
    writeFileSync(join(pkg, 'store.json'), JSON.stringify(store))
    assert.deepEqual(checkPackage(pkg, {}).findings.filter((f) => f.kind === 'store_example_image'), [])
  })

  it('tells private data from placeholders', () => {
    assert.deepEqual(privateDataIn('/Users/example/work and you@example.com and /home/runner/x'), [])
    assert.equal(privateDataIn('see /home/bob/.config').length, 1)
    assert.equal(privateDataIn('token sk-ant-abcdefghijklmnopqrstuvwxyz0123').length, 1)
  })
})

describe('a workspace laid out as Harness lays it out', () => {
  function pkgWithTemplate() {
    const pkg = join(tmp(), 'package')
    scaffold(pkg, { id: 'example/tool', tool: 'Tool', reference: join(REPO_STORE, '..') })
    writeFileSync(join(pkg, 'AGENTS.md'), '# Tool\n\nUse the pane.\n')
    writeFileSync(join(pkg, 'toolchain', 'init-workspace.sh'), '#!/usr/bin/env bash\necho "$HARNESS_DSH $TOOL_TOOLCHAIN" > init.txt\n')
    chmodSync(join(pkg, 'toolchain', 'init-workspace.sh'), 0o755)
    return pkg
  }

  it('copies the template, runs init with the launch env, writes AGENTS.md and CLAUDE.md, links skills', () => {
    const pkg = pkgWithTemplate()
    const ws = join(tmp(), 'ws')
    const result = materialize(pkg, ws)
    assert.deepEqual(result.warnings, [])
    assert.ok(existsSync(join(ws, 'brief.json')))
    assert.equal(readFileSync(join(ws, 'init.txt'), 'utf8').trim(), `example/tool ${pkg}/toolchain`)
    assert.match(readFileSync(join(ws, 'AGENTS.md'), 'utf8'), /^<!-- harness:dsh example\/tool -->\n# Tool/)
    assert.equal(readFileSync(join(ws, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
    assert.equal(readlinkSync(join(ws, '.claude', 'skills', 'tool')), join(pkg, 'skills', 'tool'))
    assert.ok(existsSync(join(ws, '.harness')))
  })

  it('links skills where Codex reads them, and is idempotent', () => {
    const pkg = pkgWithTemplate()
    const ws = join(tmp(), 'ws')
    materialize(pkg, ws, { engine: 'codex' })
    assert.ok(existsSync(join(ws, '.agents', 'skills', 'tool')))
    assert.ok(!existsSync(join(ws, 'CLAUDE.md')))
    writeFileSync(join(ws, 'init.txt'), 'kept')
    const again = materialize(pkg, ws, { engine: 'codex' })
    assert.equal(readFileSync(join(ws, 'init.txt'), 'utf8'), 'kept', 'the marker exists, so init does not run again')
    assert.ok(again.kept.includes('AGENTS.md'))
  })

  it('gives a proof agent the harness\'s environment and none of the Builder\'s', () => {
    const manifest = { id: 'example/tool', agent: { env: { TOOL_HOME: '${dsh}/x', TOOL_WS: '${workspace}/y' } } }
    const env = agentEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', BUILDER: '/b', HARNESS_DSH: 'autonomous/harness-builder' }, manifest, '/pkg', '/ws')
    assert.equal(env.PATH, '/bin')
    assert.equal(env.CLAUDECODE, undefined)
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined)
    assert.equal(env.BUILDER, undefined)
    assert.equal(env.HARNESS_DSH, 'example/tool')
    assert.equal(env.TOOL_HOME, '/pkg/x')
    assert.equal(env.TOOL_WS, '/ws/y')
    assert.deepEqual(launchEnv(manifest, '/pkg', '/ws').HARNESS_WORKSPACE, '/ws')
  })

  it('notices a save, and finds the artifact a pane would open', () => {
    const ws = tmp()
    const before = fingerprint(ws)
    mkdirSync(join(ws, 'out'), { recursive: true })
    writeFileSync(join(ws, 'out', 'chart.svg'), '<svg/>')
    assert.notEqual(fingerprint(ws), before)
    assert.equal(currentArtifact(ws, ['.svg']), 'out/chart.svg')
    mkdirSync(join(ws, '.harness'), { recursive: true })
    writeFileSync(join(ws, 'score.pdf'), '%PDF')
    writeFileSync(join(ws, '.harness', 'verdict.json'), JSON.stringify({ artifact: 'score.pdf' }))
    assert.equal(currentArtifact(ws, ['.svg']), 'score.pdf')
    assert.equal(viewerUrl('http://127.0.0.1:${port}/?file=${artifact}', 4100, 'a b.pdf'), 'http://127.0.0.1:4100/?file=a%20b.pdf')
  })
})
