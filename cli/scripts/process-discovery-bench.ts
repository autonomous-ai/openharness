/** Full discovery-scan comparison, with identical current dependencies and tooling.
 * Run from cli/: node --import tsx scripts/process-discovery-bench.ts /tmp/discovery.json
 * Builds the two changed modules from CLI 0.3.46 and the working tree into private
 * temporary bundles. Never attaches to live terminals or starts agents.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import type { AgentCommandOwnershipSnapshot } from '../src/lib/engineBin.js'
import type { ProcessRow } from '../src/lib/tmux.js'
import type { TerminalRootObservation } from '../src/lib/terminalTypes.js'

const BASELINE = 'c1ab7ff1c9a26dba7fb6a27c45e6abd76b90b92d'
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(cli, '..')
const output = process.argv[2]
assert(output, 'Supply a fresh output JSON path')
const temporary = await mkdtemp(join(tmpdir(), 'harness-discovery-benchmark-'))
const ownership: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(),
  agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}
const modules = ['tmux.ts', 'terminalAgentDiscovery.ts']
const previousDataDir = process.env.ADAPTER_DATA_DIR
process.env.ADAPTER_DATA_DIR = join(temporary, 'state')

type Api = typeof import('../src/lib/tmux.js') & typeof import('../src/lib/terminalAgentDiscovery.js') & typeof import('../src/engines/types.js')

async function bundle(mode: 'previous' | 'current'): Promise<Api> {
  const outfile = join(temporary, `${mode}.mjs`)
  await build({
    stdin: {
      contents: `export { discoverTerminalAgentsFromSnapshot } from './src/lib/terminalAgentDiscovery.ts';
        export { engineProcessMatch, ambiguousAgentProcess, argvTokens } from './src/lib/tmux.ts';
        export { PROCESS_ENGINES } from './src/engines/types.ts';`,
      resolveDir: cli, loader: 'ts',
    },
    outfile, platform: 'node', format: 'esm', bundle: true, packages: 'external',
    plugins: mode === 'previous' ? [{
      name: 'released-matching-source',
      setup(builder) {
        builder.onLoad({ filter: /[/\\](tmux|terminalAgentDiscovery)\.ts$/ }, args => ({
          contents: execFileSync('git', ['show', `${BASELINE}:cli/src/lib/${args.path.split(/[/\\]/).pop()}`], { cwd: root, encoding: 'utf8' }),
          loader: 'ts', resolveDir: dirname(args.path),
        }))
      },
    }] : [],
  })
  return import(pathToFileURL(outfile).href) as Promise<Api>
}

function fixture(panes: number, longArguments: boolean) {
  const rows: ProcessRow[] = []
  const roots: TerminalRootObservation[] = []
  const startMarker = 'Thu Oct 1 08:00:00 2026'
  const payload = 'ordinary shell wrapper instruction '.repeat(longArguments ? 115 : 1)
  for (let i = 0; i < panes; i++) {
    const pid = 100 + i * 4
    roots.push({ runtime: { backend: 'tmux', paneId: `%${i}` }, rootPid: pid, cwd: `/fixture/${i}` })
    rows.push({ pid, parentPid: 2, executable: '/bin/zsh', startMarker, args: `/bin/zsh -c ${payload}` })
    rows.push({ pid: pid + 1, parentPid: pid, executable: i % 2 ? 'codex' : 'claude', startMarker,
      args: i % 2 ? 'codex resume 0199aa00-0000-4000-8000-000000000000' : 'claude --resume 0199aa00-0000-4000-8000-000000000000' })
    rows.push({ pid: pid + 2, parentPid: pid + 1, executable: 'python3', startMarker, args: `python3 worker.py ${payload}` })
    rows.push({ pid: pid + 3, parentPid: pid + 1, executable: 'node', startMarker, args: `node /fixture/helper.js ${payload}` })
  }
  for (let i = 0; rows.length < 1022; i++) rows.push({ pid: 10000 + i, parentPid: 1, executable: 'background-service', args: 'background-service', startMarker })
  return { rows, roots }
}

/** Unchanged full-token semantics are the reference, including imperfect ps quoting.
 * Do not silently invent a different shell grammar while reducing allocations. */
function compareMatching(previous: Api, current: Api): number {
  const words = ['', 'env', 'A=x', '-i', 'ori', '--model', '--log-level', '--completions',
    'node', 'python3.14', 'bun', 'sh', '--', '-m', '-c', '--eval', '--require', '--import',
    'codex', 'claude', 'agent', 'grok', 'hermes', 'cursor-agent', 'worker.py', '""', "''",
    '"a space"', "'a space'", '"unfinished', "'unfinished", 'x"quoted"',
    '/fixture/cursor-agent/versions/123/index.js', '/fixture/@openai/codex/bin/codex.js']
  let seed = 0x4139a
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 16
  const cases = 2000
  for (let i = 0; i < cases; i++) {
    const args = Array.from({ length: next() % 18 }, () => words[next() % words.length]).join(i % 3 ? ' ' : '\t')
    const row = { executable: ['node', 'agent', 'python3', 'unidentified-launcher'][i % 4], args }
    assert.deepEqual(current.argvTokens(args), previous.argvTokens(args))
    assert.equal(current.ambiguousAgentProcess(row, ownership), previous.ambiguousAgentProcess(row, ownership))
    for (const engine of current.PROCESS_ENGINES) {
      assert.deepEqual(current.engineProcessMatch(row, engine, ownership), previous.engineProcessMatch(row, engine, ownership), `${engine}: ${args}`)
    }
  }
  return cases
}

try {
  await symlink(join(cli, 'node_modules'), join(temporary, 'node_modules'), 'dir')
  const previous = await bundle('previous')
  const current = await bundle('current')
  const differentialCases = compareMatching(previous, current)
  const samples: Array<{ workload: string; panes: number; mode: string; round: number; scans: number; wallMs: number; nodeCpuMs: number }> = []
  for (const workload of ['short-arguments', 'wrapper-4k']) {
    for (const panes of [1, 16, 105]) {
      const { rows, roots } = fixture(panes, workload === 'wrapper-4k')
      const scan = (api: Api) => api.discoverTerminalAgentsFromSnapshot(roots, rows, 99999, ['tmux'], new Map(), ownership)
      const expected = scan(previous)
      assert.deepEqual(scan(current), expected)
      assert.equal(expected.agents.length, panes)
      assert.deepEqual(expected.agents.map(agent => agent.processIdentity.pid), roots.map(observation => observation.rootPid + 1))
      for (let i = 0; i < 30; i++) { scan(previous); scan(current) }
      for (let round = 0; round < 30; round++) {
        for (const mode of round % 2 ? ['current', 'previous'] : ['previous', 'current']) {
          const api = mode === 'current' ? current : previous
          const cpu = process.cpuUsage()
          const started = performance.now()
          for (let i = 0; i < 5; i++) scan(api)
          const wallMs = performance.now() - started
          const usage = process.cpuUsage(cpu)
          samples.push({ workload, panes, mode, round, scans: 5, wallMs, nodeCpuMs: (usage.user + usage.system) / 1000 })
          assert.deepEqual(scan(api), expected)
        }
      }
    }
  }
  const summary = ['short-arguments', 'wrapper-4k'].flatMap(workload => [1, 16, 105].map(panes => ({
    workload, panes,
    ...Object.fromEntries(['previous', 'current'].map(mode => {
      const selected = samples.filter(row => row.workload === workload && row.panes === panes && row.mode === mode)
      return [mode, { nodeCpuMs: selected.reduce((sum, row) => sum + row.nodeCpuMs, 0), wallMs: selected.reduce((sum, row) => sum + row.wallMs, 0) }]
    })),
  })))
  const result = {
    recordedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`,
    baseline: BASELINE, currentHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    currentModuleSha256: Object.fromEntries(await Promise.all(modules.map(async file =>
      [file, createHash('sha256').update(await readFile(join(cli, 'src/lib', file))).digest('hex')]))),
    scope: 'Pure full discovery scans over 1,022 synthetic process rows, including allocations and GC. Excludes process collection, tmux, transport, rendering and battery.',
    differentialCases, warmups: 30, rounds: 30, scansPerRound: 5, summary, samples,
  }
  await writeFile(resolve(output), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ differentialCases, summary }, null, 2))
} finally {
  if (previousDataDir === undefined) delete process.env.ADAPTER_DATA_DIR
  else process.env.ADAPTER_DATA_DIR = previousDataDir
  await rm(temporary, { recursive: true, force: true })
}
