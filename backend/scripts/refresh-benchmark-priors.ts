/**
 * Hand-run refresh of the benchmark priors table (docs/benchmark-priors.md). Reads the public Terminal-Bench 4.0, SWE-bench
 * Verified and Aider polyglot boards, maps their model names to ours through the table's own `benchmarkNames`, and rewrites
 * src/superTabs/benchmarkPriors/data.ts. The only place the priors touch the network: the server never does. A board that
 * cannot be read keeps its previous rows and is named in the output. Model-card rows (typed in by hand) are kept.
 *
 *   node --import tsx scripts/refresh-benchmark-priors.ts [--dry-run]
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BENCHMARK_PRIORS } from '../src/superTabs/benchmarkPriors/data.js'
import { applyBoards, parseAider, parseSweBench, parseTerminalBench, renderData, type Board } from '../src/superTabs/benchmarkPriors/refresh.js'

const SOURCES = {
  'terminal-bench-4.0': { url: 'https://www.tbench.ai/leaderboard', read: async (res: Response) => parseTerminalBench(await res.text()) },
  'swe-bench-verified': { url: 'https://raw.githubusercontent.com/SWE-bench/swe-bench.github.io/master/data/leaderboards.json', read: async (res: Response) => parseSweBench(await res.json()) },
  'aider-polyglot': { url: 'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml', read: async (res: Response) => parseAider(await res.text()) },
} as const

async function fetchBoard(benchmark: keyof typeof SOURCES): Promise<Board> {
  try {
    const res = await fetch(SOURCES[benchmark].url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return { benchmark, error: `HTTP ${res.status}` }
    return await SOURCES[benchmark].read(res)
  } catch (error) {
    return { benchmark, error: error instanceof Error ? error.message : String(error) }
  }
}

const boards = await Promise.all((Object.keys(SOURCES) as Array<keyof typeof SOURCES>).map(fetchBoard))
const { table, warnings } = applyBoards(BENCHMARK_PRIORS, boards, new Date().toISOString().slice(0, 10))
for (const board of boards) console.log('rows' in board ? `${board.benchmark}: ${board.rows.length} rows read` : `${board.benchmark}: FAILED ${board.error}`)
for (const warning of warnings) console.warn(warning)
for (const model of table.models) console.log(`${model.engine} ${model.model}: ${model.scores.length ? model.scores.map(s => `${s.benchmark} ${s.score}`).join(', ') : `no data (${model.noData ?? 'unexplained'})`}`)
if (boards.every(b => 'error' in b)) { console.error('No board could be read; the table was not changed.'); process.exit(1) }
if (process.argv.includes('--dry-run')) console.log('Dry run: data.ts not written.')
else writeFileSync(fileURLToPath(new URL('../src/superTabs/benchmarkPriors/data.ts', import.meta.url)), renderData(table))
