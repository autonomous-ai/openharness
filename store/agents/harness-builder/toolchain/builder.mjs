#!/usr/bin/env node
// builder — the Harness Builder's toolchain. Run as "$BUILDER" from a Builder workspace.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPackage, harnessDshCheck } from './lib/check.mjs'
import { runFresh } from './lib/fresh.mjs'
import { readManifest } from './lib/materialize.mjs'
import { markProof, openProof, proofDir, proofStatus, runProof, startProof, stopProof } from './lib/proof.mjs'
import { scaffold } from './lib/scaffold.mjs'
import { snapshot } from './lib/snapshot.mjs'
import { PROOF_IDS, STAGES, ensureWorkspace, log, paths, readBuild, readJson, saveBuild, setStage, writeJsonAtomic } from './lib/state.mjs'
import { alive, currentArtifact, resolveViewer, startViewer, viewerUrl } from './lib/viewer.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const TOOLCHAIN = dirname(SCRIPT)
const DSH = dirname(TOOLCHAIN)
const REFERENCE = process.env.BUILDER_REFERENCE || join(DSH, 'reference', 'openharness')
const WORKSPACE = resolve(process.env.HARNESS_WORKSPACE || process.cwd())

const HELP = `builder — build a domain-specific harness in package/

  promise "A person can now …"
                     the one sentence this harness earns; it leads Builder Studio
  stage <id> <active|done|failed|pending> [--note "…"]
                     mark a stage; stages: ${STAGES.map((s) => s.id).join(', ')}
  status             the stages, the proofs, the latest check
  scaffold <owner/name> --tool "<Tool>" [--engine claude]
                     lay out package/ so the build shows from the first minute
  check [--json]     the quality bar over package/ (and harness dsh check); writes .builder/check.json
  fresh [--keep]     setup, doctor and init on a simulated new machine; writes .builder/fresh.json
  proof open <id>    a workspace for the harness with its viewer running (shown live in the Studio)
  proof run <id> --prompt "…" [--from <proof-id>] [--engine claude|codex] [--every 15] [--timeout 45]
                     --from continues in a copy of that finished proof's workspace: the revision run,
                     where the agent meets the work already in progress
                     (--engine defaults to $BUILDER_PROOF_ENGINE, else the harness's engine: run proofs on
                     the engine you are, so they test the harness where you know it runs)
                     a fresh agent that knows only the harness turns the prompt into a result,
                     photographed as it works; returns at once — follow it with proof wait
  proof wait <id> [--minutes 9]
                     follow a running proof; prints progress, returns when it ends or time is up
  proof status <id>  where a proof is
  proof pass|fail <id> --note "…"
                     your review's verdict on a proof
  proof stop <id|--all>
                     stop a proof's viewer (and its agent, if still running)
  snapshot <proof-id> [--out file.png|.jpg] [--theme dark|light] [--width 1600] [--height 1000]
                     a picture of what that proof's viewer shows right now
  showcase <proof-id>… [--base-url https://…/showcase]
                     Store pictures (1600×1000 JPEG) from passed proofs into package/showcase/, and
                     examples in store.json; --base-url is where those files will be served from
  help               this`

function args(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else { out[key] = next; i++ }
    } else out._.push(a)
  }
  return out
}

function fail(message) {
  console.error(`builder: ${message}`)
  process.exit(2)
}

function runCheck(json) {
  const p = paths(WORKSPACE)
  const build = readBuild(WORKSPACE)
  const fresh = readJson(p.fresh, null)
  // The final verdict of each proof that ran: what the harness reported it checked, for the store page.
  const proofVerdicts = PROOF_IDS.map((id) => readJson(join(p.proofs, id, 'result.json'), null)?.verdict ?? null)
  const result = checkPackage(p.package, { reference: REFERENCE, build, fresh, proofVerdicts })
  if (existsSync(join(p.package, 'harness.json'))) {
    const dsh = harnessDshCheck(p.package)
    if (dsh) {
      for (const line of dsh.text.split('\n')) {
        const m = line.match(/^(warn|fail|error|miss)\s+(.*)$/)
        if (m) result.findings.push({ severity: m[1] === 'warn' ? 'warning' : 'error', kind: 'harness_dsh_check', message: m[2].trim(), ref: 'harness dsh check' })
      }
      result.dshCheck = dsh
    }
  }
  result.counts = {
    errors: result.findings.filter((f) => f.severity === 'error').length,
    warnings: result.findings.filter((f) => f.severity === 'warning').length,
  }
  result.at = new Date().toISOString()
  writeJsonAtomic(p.check, result)
  log(build, `Check: ${result.counts.errors} errors, ${result.counts.warnings} warnings`)
  saveBuild(WORKSPACE, build)
  if (json) { console.log(JSON.stringify(result, null, 2)); return result }
  for (const f of result.findings) console.log(`${f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warn ' : 'info '} ${f.message}${f.ref ? `  (${f.ref})` : ''}`)
  console.log(result.counts.errors ? `${result.counts.errors} error(s), ${result.counts.warnings} warning(s)` : `no errors · ${result.counts.warnings} warning(s)`)
  return result
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2)
  const a = args(rest)
  const p = paths(WORKSPACE)

  switch (command) {
    case 'help': case '--help': case '-h':
      console.log(HELP)
      return

    case 'init': {
      const build = ensureWorkspace(WORKSPACE)
      console.log(`ok   Builder workspace ready (${build.stages.length} stages)`)
      return
    }

    case 'promise': {
      // The one sentence the harness earns: what a person can now finish that they could not before.
      // It leads Builder Studio, and the check asks for it, because a build that cannot say this
      // is the kind that gets withdrawn.
      const sentence = a._.join(' ').trim()
      const build = readBuild(WORKSPACE)
      if (!sentence) {
        console.log(build.promise ? build.promise : 'no promise yet: "$BUILDER" promise "A person can now …"')
        return
      }
      if (sentence.length > 160) fail('the promise is one sentence (≤ 160 characters)')
      build.promise = sentence
      log(build, `Promise: ${sentence}`)
      saveBuild(WORKSPACE, build)
      console.log(sentence)
      return
    }

    case 'stage': {
      const [id, state] = a._
      if (!id || !state) fail('usage: stage <id> <active|done|failed|pending> [--note "…"]')
      const build = readBuild(WORKSPACE)
      const stage = setStage(build, id, state, typeof a.note === 'string' ? a.note : undefined)
      saveBuild(WORKSPACE, build)
      console.log(`${stage.name}: ${stage.state}${stage.note ? ` — ${stage.note}` : ''}`)
      return
    }

    case 'status': {
      const build = readBuild(WORKSPACE)
      console.log(build.target ? `${build.target.name} (${build.target.id}, ${build.target.engine})` : 'no target yet: builder scaffold <owner/name> --tool "<Tool>"')
      for (const s of build.stages) console.log(`  ${s.state.padEnd(7)} ${s.name}${s.note ? ` — ${s.note}` : ''}`)
      for (const [id, proof] of Object.entries(build.proofs)) console.log(`  proof ${id}: ${proof.state}${proof.verdict ? ` · ${proof.verdict.summary}` : ''}${proof.viewer?.port ? ` · viewer :${proof.viewer.port}` : ''}`)
      const check = readJson(p.check, null)
      if (check) console.log(`  check: ${check.counts.errors} errors, ${check.counts.warnings} warnings (${check.at})`)
      const fresh = readJson(p.fresh, null)
      if (fresh) console.log(`  fresh: ${fresh.passed ? 'passed' : `failed at ${fresh.failedAt}`} (${fresh.seconds}s)`)
      return
    }

    case 'scaffold': {
      const id = a._[0]
      const engine = typeof a.engine === 'string' ? a.engine : 'claude'
      const made = scaffold(p.package, { id, tool: typeof a.tool === 'string' ? a.tool : undefined, engine, reference: REFERENCE })
      const build = readBuild(WORKSPACE)
      build.target = { id, name: made.name, tool: made.name, engine }
      log(build, `Scaffold: ${id} (${made.created.length} files)`)
      saveBuild(WORKSPACE, build)
      console.log(`package/ laid out for ${id}: ${made.created.length} files. Next: "$BUILDER" stage research active`)
      return
    }

    case 'check': {
      const result = runCheck(Boolean(a.json))
      process.exitCode = result.counts.errors ? 1 : 0
      return
    }

    case 'fresh': {
      if (!existsSync(join(p.package, 'harness.json'))) fail('no package/harness.json yet')
      console.log('Installing package/ on a simulated new machine (setup can take minutes)…')
      const report = runFresh(p.package, { keep: Boolean(a.keep) })
      writeJsonAtomic(p.fresh, report)
      const build = readBuild(WORKSPACE)
      log(build, `Fresh install: ${report.passed ? 'passed' : `failed at ${report.failedAt}`} in ${report.seconds}s`)
      saveBuild(WORKSPACE, build)
      for (const step of report.steps) {
        console.log(`${step.exit === 0 && !step.timedOut ? 'ok  ' : 'FAIL'} ${step.name} (${step.seconds}s)`)
        if (step.exit !== 0 || step.timedOut) console.log(step.output.split('\n').map((l) => `     ${l}`).join('\n'))
      }
      console.log(report.passed ? `fresh install passed in ${report.seconds}s` : `fresh install failed at ${report.failedAt}; see .builder/fresh.json`)
      process.exitCode = report.passed ? 0 : 1
      return
    }

    case 'proof': {
      const [sub, id] = a._
      if (!sub || (!id && sub !== 'stop')) fail('usage: proof <open|run|wait|status|pass|fail|stop> <id>')
      if (!existsSync(join(p.package, 'harness.json'))) fail('no package/harness.json yet')
      if (sub === 'open') {
        // The same engine a run would use, so a workspace opened by hand has its skills where that engine reads them.
        const opened = await openProof(WORKSPACE, id, { engine: typeof a.engine === 'string' ? a.engine : process.env.BUILDER_PROOF_ENGINE || undefined, reset: Boolean(a.reset) })
        console.log(`workspace: ${opened.workspace}`)
        console.log(opened.viewer.error ? `viewer: ${opened.viewer.error}` : `viewer running (shown in Builder Studio); snapshot with: "$BUILDER" snapshot ${id}`)
        for (const w of opened.materialized.warnings) console.log(`warn ${w}`)
        return
      }
      if (sub === 'run') {
        // A proof on its way means the proof stage is under way, whatever the track last said.
        if (PROOF_IDS.includes(id)) {
          const build = readBuild(WORKSPACE)
          const stage = build.stages.find((s) => s.id === 'proof')
          if (stage && stage.state !== 'active' && !build.stages.some((s) => s.state === 'active')) {
            setStage(build, 'proof', 'active')
            saveBuild(WORKSPACE, build)
          }
        }
        const started = await startProof(WORKSPACE, id, typeof a.prompt === 'string' ? a.prompt : '', {
          engine: typeof a.engine === 'string' ? a.engine : process.env.BUILDER_PROOF_ENGINE || undefined,
          every: Number(a.every ?? 15),
          timeoutMinutes: Number(a.timeout ?? 45),
          builderScript: SCRIPT,
          from: typeof a.from === 'string' ? a.from : null,
        })
        console.log(`proof ${id} started: a fresh agent is working in ${started.workspace}`)
        console.log(started.viewer.error ? `viewer: ${started.viewer.error}` : 'viewer running, frames every change')
        console.log(`follow it: "$BUILDER" proof wait ${id}`)
        return
      }
      if (sub === '_runner') {
        await runProof(WORKSPACE, id)
        return
      }
      if (sub === 'wait' || sub === 'status') {
        const minutes = Number(a.minutes ?? 9)
        const until = Date.now() + (sub === 'wait' ? minutes * 60_000 : 0)
        let lastLine = ''
        for (;;) {
          const status = proofStatus(WORKSPACE, id)
          if (!status) fail(`no proof "${id}"`)
          const act = status.activity
          const recent = act?.activity?.filter((x) => x.kind !== 'result').slice(-1)[0]
          const line = `${status.proof.state}${act ? ` · ${Math.round(act.seconds / 60)} min · ${act.frames?.length ?? 0} frames` : ''}${recent ? ` · ${recent.kind === 'tool' ? `${recent.tool} ${recent.detail}` : recent.text.split('\n')[0]}` : ''}`.slice(0, 220)
          if (line !== lastLine) { console.log(line); lastLine = line }
          const running = status.proof.state === 'running' && status.running
          if (!running || Date.now() >= until) {
            if (status.proof.state === 'running' && !status.running) console.log('the runner is gone; the proof did not finish (see agent.log)')
            if (!running && status.proof.state !== 'running') {
              const result = readJson(join(proofDir(WORKSPACE, id), 'result.json'), null)
              if (result) {
                console.log(`done in ${Math.round(result.seconds / 60)} min · exit ${result.exit ?? result.signal} · ${result.frames.length} frames · first content at ${result.firstFrameWithContentAt ?? '—'}s`)
                console.log(`verdict: ${result.verdict ? `${result.verdict.ready ? 'ready' : 'not ready'} · ${result.verdict.summary}` : 'none written'}`)
                console.log(`review it: .builder/proofs/${id}/result.json, agent.log, frames/`)
              }
            }
            return
          }
          await new Promise((r) => setTimeout(r, 10_000))
        }
      }
      if (sub === 'pass' || sub === 'fail') {
        markProof(WORKSPACE, id, sub === 'pass' ? 'passed' : 'failed', typeof a.note === 'string' ? a.note : undefined)
        console.log(`proof ${id}: ${sub === 'pass' ? 'passed' : 'failed'}`)
        return
      }
      if (sub === 'stop') {
        stopProof(WORKSPACE, id ?? '--all')
        console.log(`stopped ${id ?? 'all proofs'}`)
        return
      }
      fail(`unknown proof command "${sub}"`)
      return
    }

    case 'snapshot': {
      const id = a._[0]
      if (!id) fail('usage: snapshot <proof-id> [--out file] [--theme dark|light]')
      const build = readBuild(WORKSPACE)
      const proof = build.proofs[id]
      if (!proof) fail(`no proof "${id}": "$BUILDER" proof open ${id}`)
      let viewer = proof.viewer
      const ws = join(WORKSPACE, proof.workspace)
      if (!viewer?.pid || !alive(viewer.pid)) {
        const started = await startViewer(p.package, ws, { logFile: join(proofDir(WORKSPACE, id), 'viewer.log') })
        if (started.error) fail(started.error)
        viewer = started
        const next = readBuild(WORKSPACE)
        next.proofs[id].viewer = viewer
        saveBuild(WORKSPACE, next)
      }
      const resolved = resolveViewer(p.package)
      const url = viewerUrl(viewer.urlTemplate ?? viewer.url, viewer.port, currentArtifact(ws, resolved?.artifactExtensions ?? []))
      const out = resolve(typeof a.out === 'string' ? a.out : join(proofDir(WORKSPACE, id), `snapshot-${Date.now()}.png`))
      mkdirSync(dirname(out), { recursive: true })
      const shot = await snapshot(url, out, { theme: a.theme === 'light' ? 'light' : 'dark', width: Number(a.width ?? 1600), height: Number(a.height ?? 1000) })
      console.log(out)
      if (shot.consoleErrors.length) console.log(`console errors in the viewer:\n  ${shot.consoleErrors.join('\n  ')}`)
      return
    }

    case 'showcase': {
      const ids = a._
      if (!ids.length) fail('usage: showcase <proof-id>…')
      const build = readBuild(WORKSPACE)
      const storePath = join(p.package, 'store.json')
      const store = readJson(storePath, { examples: [] }) ?? { examples: [] }
      store.examples = Array.isArray(store.examples) ? store.examples : []
      // The pictures belong to the package, so they travel with it. The Store shows them from an https
      // URL (the spec: a catalog carries pictures without carrying bytes), which only the place the
      // package will live can say — `--base-url https://…/showcase`, else the picture waits for one.
      const baseUrl = typeof a['base-url'] === 'string' ? a['base-url'].replace(/\/+$/, '') : null
      if (baseUrl && !baseUrl.startsWith('https://')) fail('--base-url must be an https URL')
      const showcaseDir = join(p.package, 'showcase')
      mkdirSync(showcaseDir, { recursive: true })
      for (const id of ids) {
        const proof = build.proofs[id]
        if (!proof) fail(`no proof "${id}"`)
        if (proof.state !== 'passed') fail(`proof "${id}" has not passed; only passed proofs go on the Store`)
        const out = join(showcaseDir, `${id}.jpg`)
        let quality = 86
        const ws = join(WORKSPACE, proof.workspace)
        let viewer = proof.viewer
        if (!viewer?.pid || !alive(viewer.pid)) {
          const started = await startViewer(p.package, ws, { logFile: join(proofDir(WORKSPACE, id), 'viewer.log') })
          if (started.error) fail(started.error)
          viewer = started
        }
        const resolved = resolveViewer(p.package)
        const base = viewerUrl(viewer.urlTemplate ?? viewer.url, viewer.port, currentArtifact(ws, resolved?.artifactExtensions ?? []))
        const url = `${base}${base.includes('?') ? '&' : '?'}snapshot=1`
        for (;;) {
          await snapshot(url, out, { quality, settleMs: 3500 })
          if (statSync(out).size <= 350_000 || quality <= 60) break
          quality -= 6
        }
        const existing = store.examples.find((ex) => ex.prompt === proof.prompt)
        const image = baseUrl ? `${baseUrl}/${id}.jpg` : undefined
        if (existing) { if (image) existing.image = image; else delete existing.image }
        else store.examples.push({ prompt: proof.prompt, ...(image ? { image } : {}), caption: '' })
        console.log(`${out} (${Math.round(statSync(out).size / 1024)} KB)${image ? ` → ${image}` : ''}`)
      }
      writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n')
      const next = readBuild(WORKSPACE)
      log(next, `Showcase: ${ids.join(', ')}`)
      saveBuild(WORKSPACE, next)
      console.log('store.json examples updated: write a caption for each (what came out, one concrete fact)')
      return
    }

    default:
      fail(`unknown command "${command}"\n\n${HELP}`)
  }
}

main().catch((error) => {
  console.error(`builder: ${error.message ?? error}`)
  process.exit(1)
})
