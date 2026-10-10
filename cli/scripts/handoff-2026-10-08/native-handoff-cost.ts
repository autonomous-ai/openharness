/** Same private Change agent workload on two revisions, each sample in a fresh process. */
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const workload = process.argv[2]
if (!['own', 'fork', 'retry'].includes(workload)) throw Error('Unknown workload')
const cli = process.env.NATIVE_HANDOFF_COST_CLI ?? resolve(import.meta.dirname, '../..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-handoff-cost-'))), hostPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'linux' })
const forbidden = () => { throw Error('Host binaries are forbidden in the handoff measurement') }
Object.assign(childProcess, { exec: forbidden, execSync: forbidden, execFile: forbidden, spawn: forbidden,
  spawnSync: forbidden, fork: forbidden, execFileSync: (file: string, args: string[]) => {
    if (file === 'ps' && args.join(' ') === `-p ${process.pid} -o lstart=`) return 'fixture-start'
    return forbidden()
  } })
syncBuiltinESMExports()
for (const key of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'PI_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMUX_TMPDIR']) {
  process.env[key] = join(root, key); mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 })
}
for (const key of ['TMUX', 'TMUX_PANE']) delete process.env[key]
process.env.HARNESS_CONNECTIONS_PORT = '0'; process.env.TZ = 'UTC'
console.log = () => {}
try {
  const load = (name: string) => import(pathToFileURL(join(cli, 'src', name)).href)
  const { prepareAgentHandoff } = await load('lib/agentHandoff.ts')
  const { validTranscriptPath } = await load('lib/registry.ts')
  const compose = existsSync(join(cli, 'src/core/handoffDependencies.ts'))
    ? (await load('core/handoffDependencies.ts')).createHandoffDependencies
    : (await load('lib/handoffDiscovery.ts')).handoffProviderDeps
  const cwd = join(root, 'project'), folder = join(process.env.CODEX_HOME!, 'sessions')
  mkdirSync(cwd); mkdirSync(folder)
  const id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', file = join(folder, `${id}.jsonl`)
  const at = Date.parse('2026-10-10T09:00:00Z'), records: unknown[] = [{ type: 'session_meta', payload: { id, cwd, source: 'cli' } }]
  for (let turn = 0; turn < 20; turn++) records.push(
    { timestamp: new Date(at - 60_000 + turn * 1_000).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: `Keep native turn ${turn}. ${'bounded conversation '.repeat(50)}` } },
    { timestamp: new Date(at - 59_999 + turn * 1_000).toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: `Retained answer ${turn}. ${'reviewed context '.repeat(50)}` } },
    { timestamp: new Date(at - 59_998 + turn * 1_000).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } },
  )
  const contents = records.map(record => JSON.stringify(record)).join('\n') + '\n'
  writeFileSync(file, contents, { mode: 0o600 }); writeFileSync(join(process.env.ADAPTER_DATA_DIR!, 'engine-homes.json'), '{}')
  const parent = { agentId: 'parent', engine: 'codex', sessionId: id, cwd, transcriptPath: file,
    registeredAt: at, boundAt: at - 120_000, codexHome: null, hermesHome: null, processIdentity: null,
    runtimes: [{ backend: 'tmux', paneId: '%1' }] }
  const row = { ...parent, agentId: 'selected', ...(workload === 'fork' ? { sessionId: '', transcriptPath: null,
    forkedFrom: { agentId: 'parent', name: 'Parent', sessionId: id, transcriptPath: file } } : {}) }
  const deps = compose({
    registry: { resolve: (key: string) => key === row.agentId ? row : key === parent.agentId ? parent : undefined,
      byAgent: () => row, bySession: () => undefined },
    stopped: { get: () => null, ids: () => [] }, mirror: { recentAsks: () => [], lastFullText: () => undefined, recent: () => [] },
    databaseHistory: () => undefined, findLiveSession: async () => null, processSession: async () => null,
    isRecentlyDeleted: () => false, findResumedTranscript: async () => file, validTranscriptPath,
  }, process.env.ADAPTER_DATA_DIR!)
  const request = (index: number) => ({ agentId: row.agentId, targetEngine: 'claude', changeId: index.toString(16).padStart(32, '0') })
  if (workload === 'retry') await prepareAgentHandoff(deps, request(1))
  const iterations = 3, latenciesMs: number[] = [], callbackDelaysMs: number[] = []
  let cpuMs = 0
  for (let index = 1; index <= iterations; index++) {
    let last = performance.now(), worst = 0
    const timer = setInterval(() => { const current = performance.now(); worst = Math.max(worst, current - last); last = current }, 1)
    const cpu = process.cpuUsage(), started = performance.now()
    let result
    try {
      result = await prepareAgentHandoff(deps, request(workload === 'retry' ? 1 : index))
      // Include the last synchronous block; clearing the timer immediately would miss its delay.
      await new Promise(resolve => setTimeout(resolve, 1))
      latenciesMs.push(performance.now() - started); callbackDelaysMs.push(worst)
      const used = process.cpuUsage(cpu); cpuMs += (used.user + used.system) / 1000
    } finally { clearInterval(timer) }
    if (!result.file || !readFileSync(join(cwd, result.file), 'utf8').includes('Keep native turn')) throw Error('Selected history was lost')
  }
  process.stdout.write(JSON.stringify({ workload, iterations, latenciesMs, callbackDelaysMs, cpuMs,
    sourceBytes: Buffer.byteLength(contents), peakRssMiB: process.resourceUsage().maxRSS / 1024,
    node: process.version, hostPlatform, evidencePlatform: process.platform, arch: process.arch,
    outcomes: { confirmed: iterations } }) + '\n')
} finally { rmSync(root, { recursive: true, force: true }) }
