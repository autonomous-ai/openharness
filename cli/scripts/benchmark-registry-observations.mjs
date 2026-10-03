// Isolated production registry benchmark. No daemon, tmux pane, or engine is started.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { cpus, platform, arch } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const self = fileURLToPath(import.meta.url)
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

if (process.argv[2] === '--worker') {
  const [bundle, directory, countText, output] = process.argv.slice(3)
  const count = Number(countText)
  assert(Number.isInteger(count) && count > 0)
  assert.equal(process.env.HARNESS_REGISTRY_BENCH_DIR, directory)
  const file = `${directory}/registry.json`
  let counters = {}
  const reset = () => { counters = { fsyncs: 0, registryReplacements: 0, registryWriteBytes: 0, psSpawns: 0 } }
  const original = { fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, execFileSync: childProcess.execFileSync }
  fs.fsyncSync = (...args) => { counters.fsyncs++; return original.fsyncSync(...args) }
  fs.renameSync = (...args) => {
    if (args[1] === file) {
      counters.registryReplacements++
      counters.registryWriteBytes += fs.statSync(args[0]).size
    }
    return original.renameSync(...args)
  }
  childProcess.execFileSync = (...args) => {
    if (args[0] === 'ps') counters.psSpawns++
    return original.execFileSync(...args)
  }
  syncBuiltinESMExports()
  reset()
  const { registry } = await import(pathToFileURL(bundle).href)
  registry.load()
  const inputs = Array.from({ length: count }, (_, i) => ({
    agentId: `fixture-agent-${i}`, engine: 'claude', tmuxPane: `%${i}`, cwd: '/fixture/project',
    processIdentity: { pid: 10000 + i, executable: '/fixture/claude', startMarker: `fixture-${i}` },
  }))
  await registry.transaction(() => { for (const input of inputs) assert(registry.openProcessAgent(input)) })
  const initial = JSON.parse(fs.readFileSync(file, 'utf8'))
  const observe = () => registry.transaction(() => {
    // The daemon's actual steady onObserved path, not just initial openProcessAgent adoption.
    for (const input of inputs) {
      assert(registry.updateRuntimes(input.agentId, [{ backend: 'tmux', paneId: input.tmuxPane }]))
      assert(registry.updateProcessIdentity(input.agentId, { ...input.processIdentity }))
    }
  })
  for (let pass = 0; pass < 3; pass++) await observe()
  const observations = []
  for (let pass = 0; pass < 20; pass++) {
    // Outside measurement: ensure repeated legacy timestamps advance even on fast filesystems.
    await new Promise(resolve => setTimeout(resolve, 2))
    reset()
    const cpu = process.cpuUsage()
    const started = performance.now()
    await observe()
    const wallMs = performance.now() - started
    const used = process.cpuUsage(cpu)
    observations.push({ pass, wallMs, nodeCpuMs: (used.user + used.system) / 1000, ...counters })
  }
  const withoutClock = rows => rows.map(({ touchedAt, ...row }) => row)
  assert.deepEqual(withoutClock(JSON.parse(fs.readFileSync(file, 'utf8'))), withoutClock(initial))
  assert.equal(registry.list().length, count)
  for (const input of inputs) assert.equal(registry.byProcess('claude', input.processIdentity)?.agentId, input.agentId)
  fs.writeFileSync(output, JSON.stringify({ count, observations, stateAndIndexesPreserved: true }, null, 2), { flag: 'wx', mode: 0o600 })
} else {
  const [baselineFile, candidateFile, outputDirectory] = process.argv.slice(2)
  if (!baselineFile || !candidateFile || !outputDirectory) {
    throw new Error('Usage: node benchmark-registry-observations.mjs BASELINE.ts CANDIDATE.ts NEW_OUTPUT_DIRECTORY')
  }
  const root = resolve(outputDirectory)
  fs.mkdirSync(root, { mode: 0o700 }) // Never overwrite earlier evidence.
  const lib = fileURLToPath(new URL('../src/lib/', import.meta.url))
  const sources = {}
  const environmentKeys = ['AMP_SESSIONS_DIR', 'MUSE_HOME', 'CODEX_HOME', 'CURSOR_HOME', 'GROK_HOME', 'AGY_HOME',
    'COPILOT_HOME', 'PI_HOME', 'COMMANDCODE_HOME', 'CLAUDE_PROJECTS_DIR', 'ADAPTER_DATA_DIR']
  for (const [variant, path] of Object.entries({ baseline: baselineFile, candidate: candidateFile })) {
    const contents = fs.readFileSync(path, 'utf8')
    sources[variant] = { sha256: createHash('sha256').update(contents).digest('hex') }
    fs.writeFileSync(`${root}/${variant}.ts`, contents)
    await build({ stdin: { contents, resolveDir: lib, loader: 'ts' }, outfile: `${root}/${variant}.mjs`,
      platform: 'node', format: 'esm', bundle: true, logLevel: 'silent', plugins: [{
        // Replace env at build time so importing the registry cannot adopt real Harness state.
        name: 'private-registry-environment', setup(builder) {
          builder.onResolve({ filter: /config\/env\.js$/ }, () => ({ path: 'env', namespace: 'fixture' }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents:
            `const directory = process.env.HARNESS_REGISTRY_BENCH_DIR;
             if (!directory) throw new Error('Missing private registry fixture');
             export const env = Object.fromEntries(${JSON.stringify(environmentKeys)}.map(key => [key, directory]));` }))
        },
      }] })
  }
  const observations = []
  for (const count of [1, 32, 128]) for (let trial = 0; trial < 5; trial++) {
    for (const variant of trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const directory = `${root}/${count}-${trial}-${variant}`
      fs.mkdirSync(directory, { mode: 0o700 })
      const output = `${directory}/measurements.json`
      const child = childProcess.spawnSync(process.execPath, [self, '--worker', `${root}/${variant}.mjs`, directory, String(count), output], {
        env: { ...process.env, HARNESS_REGISTRY_BENCH_DIR: directory }, encoding: 'utf8', timeout: 60_000,
      })
      assert.equal(child.status, 0, child.stderr || child.error?.message)
      const result = JSON.parse(fs.readFileSync(output, 'utf8'))
      for (const row of result.observations) observations.push({ count, trial, variant, ...row })
      console.log(JSON.stringify({ count, trial, variant, medianWallMs: median(result.observations.map(row => row.wallMs)) }))
    }
  }
  const summary = [1, 32, 128].map(count => {
    const row = { agents: count }
    for (const variant of ['baseline', 'candidate']) {
      const samples = observations.filter(r => r.count === count && r.variant === variant)
      row[variant] = Object.fromEntries(['wallMs', 'nodeCpuMs', 'fsyncs', 'registryReplacements', 'registryWriteBytes', 'psSpawns']
        .map(key => [key, median(samples.map(sample => sample[key]))]))
    }
    return { ...row, wallReductionPercent: (1 - row.candidate.wallMs / row.baseline.wallMs) * 100,
      nodeCpuReductionPercent: (1 - row.candidate.nodeCpuMs / row.baseline.nodeCpuMs) * 100 }
  })
  const result = { measuredAt: new Date().toISOString(), node: process.version, platform: platform(), arch: arch(),
    cpu: cpus()[0]?.model, sources, trials: 5, passesPerTrial: 20, summary, observations,
    scope: 'Real production registry and filesystem, synthetic unchanged observations; counters delegate actual calls. Node CPU excludes child ps CPU. No whole-app, battery, GPU or agent-process improvement is measured.',
    validation: 'All 600 observed passes preserved fields other than bookkeeping touchedAt and retained every process index.' }
  fs.writeFileSync(`${root}/results.json`, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(summary, null, 2))
}
