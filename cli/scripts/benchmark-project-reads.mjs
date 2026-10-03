// Real Git, disposable repositories, no daemon, network or engine processes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { arch, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const self = fileURLToPath(import.meta.url)
const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}

if (process.argv[2] === '--worker') {
  const [bundle, fixtureFile, output] = process.argv.slice(3)
  const fixtures = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'))
  const { createAgentProjectReader } = await import(pathToFileURL(bundle).href)
  const observations = []
  for (const fixture of fixtures) {
    const read = async () => {
      const reader = createAgentProjectReader()
      const values = await Promise.all(fixture.paths.map(cwd => reader.read(cwd)))
      for (let i = 0; i < values.length; i++) {
        assert.equal(values[i].branch, fixture.branches[i])
        assert.equal(values[i].remote, 'github.com/example/project-benchmark')
        assert.equal(values[i].cwd, fixture.paths[i])
      }
    }
    // Count processes separately so trace writes do not affect the timed reads.
    const trace = `${output}.${fixture.name}.trace.jsonl`
    process.env.GIT_TRACE2_EVENT = trace
    try { await read() } finally { delete process.env.GIT_TRACE2_EVENT }
    const gitProcesses = fs.readFileSync(trace, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line)).filter(event => event.event === 'start').length
    for (let warmup = 0; warmup < 2; warmup++) await read()
    for (let round = 0; round < 6; round++) {
      const cpu = process.cpuUsage()
      const started = performance.now()
      await read()
      const wallMs = performance.now() - started
      const used = process.cpuUsage(cpu)
      observations.push({ case: fixture.name, count: fixture.paths.length, round,
        gitProcesses, wallMs, nodeCpuMs: (used.user + used.system) / 1000 })
    }
  }
  fs.writeFileSync(output, JSON.stringify(observations, null, 2), { flag: 'wx', mode: 0o600 })
} else {
  const [baselineFile, candidateFile, outputDirectory] = process.argv.slice(2)
  if (!baselineFile || !candidateFile || !outputDirectory) {
    throw new Error('Usage: node benchmark-project-reads.mjs BASELINE.ts CANDIDATE.ts NEW_OUTPUT_DIRECTORY')
  }
  const root = resolve(outputDirectory)
  fs.mkdirSync(root, { mode: 0o700 })
  const directory = join(root, 'fixtures')
  fs.mkdirSync(directory, { mode: 0o700 })
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) if (key.startsWith('GIT_')) delete environment[key]
  const emptyConfig = join(root, 'empty-config')
  fs.writeFileSync(emptyConfig, '')
  Object.assign(environment, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
  const git = (cwd, ...args) => {
    const child = spawnSync('git', ['-C', cwd, ...args], { env: environment, encoding: 'utf8', timeout: 10_000 })
    assert.equal(child.status, 0, child.stderr || child.error?.message)
    return child.stdout.trim()
  }
  const sources = {}
  const observations = []
  try {
    for (const [variant, file] of Object.entries({ baseline: baselineFile, candidate: candidateFile })) {
      const contents = fs.readFileSync(file, 'utf8')
      sources[variant] = { sha256: createHash('sha256').update(contents).digest('hex') }
      fs.writeFileSync(join(root, `${variant}.ts`), contents)
      await build({ stdin: { contents, loader: 'ts', resolveDir: resolve('cli/src/lib') },
        outfile: join(root, `${variant}.mjs`), platform: 'node', format: 'esm', bundle: true, logLevel: 'silent' })
    }
    const fixtures = []
    for (const [mode, count] of [['attached', 1], ['attached', 16], ['unborn', 1], ['detached', 1]]) {
      const name = `${mode}-${count}`
      const main = join(directory, name)
      fs.mkdirSync(main)
      git(main, 'init', '-b', 'main')
      git(main, 'remote', 'add', 'origin', 'https://github.com/example/project-benchmark.git')
      if (mode !== 'unborn') git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--allow-empty', '-m', 'initial')
      if (mode === 'detached') git(main, 'checkout', '--quiet', '--detach')
      const paths = [main]
      const branches = [mode === 'detached' ? `Detached ${git(main, 'rev-parse', '--short', 'HEAD')}` : 'main']
      for (let i = 1; i < count; i++) {
        const cwd = join(directory, `${name}-worktree-${i}`)
        git(main, 'worktree', 'add', '--quiet', '-b', `topic-${i}`, cwd)
        paths.push(cwd)
        branches.push(`topic-${i}`)
      }
      fixtures.push({ name, paths, branches })
    }
    const fixtureFile = join(root, 'fixtures.json')
    fs.writeFileSync(fixtureFile, JSON.stringify(fixtures))
    for (let trial = 0; trial < 4; trial++) {
      for (const variant of trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const output = join(root, `${trial}-${variant}.json`)
        const child = spawnSync(process.execPath, [self, '--worker', join(root, `${variant}.mjs`), fixtureFile, output],
          { env: environment, encoding: 'utf8', timeout: 120_000 })
        assert.equal(child.status, 0, child.stderr || child.error?.message)
        const rows = JSON.parse(fs.readFileSync(output, 'utf8'))
        observations.push(...rows.map(row => ({ trial, variant, ...row })))
        console.log(JSON.stringify({ trial, variant, wallMs: median(rows.map(row => row.wallMs)) }))
      }
    }
    const summary = fixtures.map(fixture => {
      const variants = Object.fromEntries(['baseline', 'candidate'].map(variant => {
        const rows = observations.filter(row => row.case === fixture.name && row.variant === variant)
        const counts = [...new Set(rows.map(row => row.gitProcesses))]
        assert.equal(counts.length, 1)
        return [variant, { gitProcesses: counts[0], medianWallMs: median(rows.map(row => row.wallMs)),
          medianNodeCpuMs: median(rows.map(row => row.nodeCpuMs)) }]
      }))
      return { case: fixture.name, ...variants,
        wallReductionPercent: 100 * (1 - variants.candidate.medianWallMs / variants.baseline.medianWallMs) }
    })
    fs.writeFileSync(join(root, 'results.json'), JSON.stringify({ schema: 1, sources,
      environment: { node: process.version, git: git(directory, '--version'), platform: platform(), arch: arch() },
      scope: 'Uncached project reads; at most four concurrent repositories; six rounds after two warmups; four alternating trials.',
      limitations: ['Node CPU excludes Git child CPU. Wall time includes Git and filesystem work.',
        'Real user work remains active; this is a component benchmark, not a controlled whole-daemon energy comparison.'],
      summary, observations }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
