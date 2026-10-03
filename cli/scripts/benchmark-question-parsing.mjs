// Compare two askQuestion.ts files against identical recorded terminal captures.
// No daemon, provider, or real terminal is opened. See docs/performance for usage.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { cpus, platform, arch } from 'node:os'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const [baselineFile, candidateFile, outputDir] = process.argv.slice(2)
if (!baselineFile || !candidateFile || !outputDir) {
  throw new Error('Usage: node benchmark-question-parsing.mjs BASELINE.ts CANDIDATE.ts NEW_OUTPUT_DIRECTORY')
}
const root = resolve(outputDir)
mkdirSync(root) // Preserve prior evidence: never overwrite a run.
const lib = fileURLToPath(new URL('../src/lib/', import.meta.url))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const sources = {}
const modules = {}
for (const [variant, path] of Object.entries({ baseline: baselineFile, candidate: candidateFile })) {
  const contents = readFileSync(path, 'utf8')
  sources[variant] = { path: resolve(path), sha256: sha256(contents) }
  writeFileSync(`${root}/${variant}.ts`, contents)
  await build({ stdin: { contents: `${contents}\nexport { parseRow as compareRow, unframe as compareFrame };\n`,
    resolveDir: lib, loader: 'ts' }, outfile: `${root}/${variant}.mjs`, bundle: true,
    platform: 'node', format: 'esm', logLevel: 'silent' })
  modules[variant] = await import(pathToFileURL(`${root}/${variant}.mjs`).href)
}
const engines = ['claude', 'commandcode', 'codex', 'cursor', 'devin', 'hermes', 'opencode', 'muse', 'amp', 'kilo', 'grok', 'agy', 'copilot']
const fixtures = readdirSync(`${lib}/__fixtures__`).filter(name => /^(question|permission)-.*\.txt$/.test(name)).sort().map(name => {
  const capture = readFileSync(`${lib}/__fixtures__/${name}`, 'utf8')
  const engine = engines.find(value => name.startsWith(`question-${value}`) || name.startsWith(`permission-${value}`)) ?? 'claude'
  return { name, engine, capture, sha256: sha256(capture) }
})
let comparisons = 0
const equalHelper = (name, text) => {
  assert.deepEqual(modules.candidate[name](text), modules.baseline[name](text), `${name}: ${JSON.stringify(text)}`)
  comparisons++
}
const whitespace = ['', ' ', '\t', '\r', '\v', '\f', '\u00a0', '\u2003', '\u2028', '\u2029', '\uFEFF', ' '.repeat(200)]
for (const prefix of whitespace) for (const mark of ['', '❯', '›', '>', '│', '┃', '|', 'a']) {
  for (const gap of whitespace.slice(0, 10)) for (const tail of ['', '1. Yes', '1. [ ] Zero', '2. [✔] A', '99. B    C ', 'no match', '1.   ', '│', '|   ', 'a|b', '\n1. Test']) {
    equalHelper('compareRow', prefix + mark + gap + tail)
    equalHelper('compareFrame', prefix + mark + gap + tail)
  }
}
// Reproducible mixed Unicode, ANSI, multiline, malformed-row and frame inputs.
let seed = 0x54a19e37
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
const alphabet = [' ', '\t', '\n', '\r', '\u2003', '\u00a0', '\x1b[31m', '❯', '›', '>', '│', '┃', '|', '1', '2', '.', '[', ']', '✔', 'A', '你', '☕']
for (let i = 0; i < 5_000; i++) {
  let text = ''
  const length = random() % 80
  for (let j = 0; j < length; j++) text += alphabet[random() % alphabet.length]
  equalHelper('compareRow', text)
  equalHelper('compareFrame', text)
}
for (let i = 0; i < fixtures.length; i++) for (const engine of engines) {
  const { capture, name } = fixtures[i]
  for (const text of [capture, capture.split('\n').map(line => line.padEnd(240)).join('\n'),
    `${capture}\n${fixtures[(i + 1) % fixtures.length].capture}`]) {
    const baseline = modules.baseline.parseEngineQuestionPane(engine, text)
    const candidate = modules.candidate.parseEngineQuestionPane(engine, text)
    assert.deepEqual(candidate, baseline, `${engine}/${name}`)
    if (baseline?.kind === 'question') {
      assert.equal(modules.candidate.questionRequestId('fixture', candidate), modules.baseline.questionRequestId('fixture', baseline))
    }
    comparisons++
  }
}
console.log(JSON.stringify({ comparisons, differences: 0 }))
const workloads = [
  ...[80, 160, 240].map(width => ({ name: `blank-claude-${width}`, captures: [{ engine: 'claude', capture: Array(60).fill(' '.repeat(width)).join('\n') }] })),
  ...['hermes', 'opencode'].map(engine => ({ name: `blank-${engine}-240`, captures: [{ engine, capture: Array(60).fill(' '.repeat(240)).join('\n') }] })),
  { name: 'recorded-dialogs', captures: fixtures },
  { name: 'recorded-dialogs-padded-240', captures: fixtures.map(f => ({ ...f, capture: f.capture.split('\n').map(line => line.padEnd(240)).join('\n') })) },
]
const observations = []
let checksum = 0
function measure(module, workload, iterations) {
  const cpu = process.cpuUsage()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) for (const { engine, capture } of workload.captures) {
    const view = module.parseEngineQuestionPane(engine, capture)
    checksum += view?.kind === 'question' ? view.rows.length : view?.kind === 'review' ? 1 : 0
  }
  const wallMs = performance.now() - start
  const used = process.cpuUsage(cpu)
  return { wallMs, cpuMs: (used.user + used.system) / 1000 }
}
for (const workload of workloads) {
  for (const module of Object.values(modules)) measure(module, workload, 20)
  const calibration = measure(modules.baseline, workload, 20)
  const iterations = Math.max(5, Math.min(10_000, Math.ceil(20 * 250 / Math.max(1, calibration.wallMs))))
  for (let trial = 0; trial < 7; trial++) for (const variant of trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const row = { workload: workload.name, trial, variant, iterations, parses: iterations * workload.captures.length,
      ...measure(modules[variant], workload, iterations) }
    observations.push(row)
    console.log(JSON.stringify(row))
  }
}
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
const summary = workloads.map(workload => {
  const result = { workload: workload.name }
  for (const variant of ['baseline', 'candidate']) {
    const rows = observations.filter(r => r.workload === workload.name && r.variant === variant)
    result[variant] = { medianWallUsPerParse: median(rows.map(r => r.wallMs * 1000 / r.parses)),
      medianCpuUsPerParse: median(rows.map(r => r.cpuMs * 1000 / r.parses)) }
  }
  result.cpuReductionPercent = (1 - result.candidate.medianCpuUsPerParse / result.baseline.medianCpuUsPerParse) * 100
  return result
})
const report = { recordedAt: new Date().toISOString(), runtime: process.version, platform: `${platform()}-${arch()}`,
  cpuModel: cpus()[0]?.model, scope: 'Pure question parsing; recorded fixtures and synthetic whitespace. No tmux I/O, whole-daemon or battery claim.',
  sources, comparisons, differences: 0, fixtures: fixtures.map(({ name, engine, sha256 }) => ({ name, engine, sha256 })),
  checksum, summary, observations }
writeFileSync(`${root}/results.json`, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ summary, checksum }, null, 2))
