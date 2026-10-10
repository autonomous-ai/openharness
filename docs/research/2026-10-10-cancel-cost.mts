/** Compare complete eager Cancel calls against a chosen CLI tree. No daemon, process signals or clients. */
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const workload = process.argv[2] ?? 'small-first'
if (!['small-first', 'large-first', 'small-retained', 'large-retained'].includes(workload)) throw Error('Unknown workload')
const cli = process.env.CANCEL_COST_CLI ?? resolve('cli')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'eager-cancel-cost-')))
for (const key of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
  process.env[key] = join(root, key); mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 })
}
process.env.CLAUDE_PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR!, 'projects')
process.env.HARNESS_CONNECTIONS_PORT = '0'
try {
  const load = (part: string) => import(pathToFileURL(join(cli, 'src', part)).href)
  const { createCancel } = await load('core/turns/cancel.ts')
  const { createAttach } = await load('core/transcripts/attach.ts')
  const { createSessionNormalizers } = await load('core/transcripts/normalizers.ts')
  const { liveFor } = await load('engines/live.ts')
  const file = join(root, 'session.jsonl')
  const prompt = JSON.stringify({ type: 'user', uuid: 'fixture', message: { role: 'user', content: 'fixture' } })
  const prefix = workload.startsWith('large') ? (JSON.stringify({ type: 'system', text: 'x'.repeat(65500) }) + '\n').repeat(256) : ''
  writeFileSync(file, prefix + prompt + '\n', { mode: 0o600 })
  const row = { agentId: 'fixture-agent', sessionId: 'fixture-session', engine: 'claude', transcriptPath: file, codexHome: null }
  const normalizers = createSessionNormalizers()
  const reader = liveFor('claude').create(row)
  normalizers.liveParsers.set(row.sessionId, reader)
  const nothing = () => {}
  const attachment = () => createAttach({ normalizers, watcher: { removeSession: nothing }, resolve: () => row })
  let attach = attachment(), signals = 0
  const cancel = createCancel({ resolve: () => row, normalizers,
    beforeCancel: (session: unknown) => attach.beforeCancel?.(session),
    cursorSubagents: { forget: nothing }, input: { cancel: () => { signals++ }, cancelConfirmed: async () => true },
    device: () => undefined, stopHeartbeat: nothing, questionWatcher: { stop: nothing }, mirror: { cancel: nothing },
    turnActivity: { observe: nothing, snapshot: () => undefined }, turnStartedAt: new Map(), agentIdFor: () => row.agentId,
    clients: { send: nothing } })
  const latenciesMs: number[] = [], outcomes = { closed: 0, held: 0 }
  let cpuMs = 0
  for (let i = 0; i < 100; i++) {
    if (workload.endsWith('first')) attach = attachment()
    const next = JSON.stringify({ type: 'user', uuid: `fixture-${i}`, message: { role: 'user', content: `prompt ${i}` } })
    appendFileSync(file, next + '\n')
    reader.ingest(next)
    if (!reader.turnOpen) throw Error('The measured Cancel must begin with an open turn')
    const cpu = process.cpuUsage(), started = performance.now()
    await cancel(row.agentId)
    latenciesMs.push(performance.now() - started)
    const used = process.cpuUsage(cpu); cpuMs += (used.user + used.system) / 1000
    if (!reader.turnOpen) outcomes.closed++
    if ('interpretationHold' in row) outcomes.held++
  }
  if (outcomes.closed !== 100 || outcomes.held || signals !== 100) throw Error('Cancel did not finish its eager control work')
  console.log(JSON.stringify({ workload, bytes: Buffer.byteLength(prefix + prompt + '\n'), iterations: 100,
    outcomes, signals, latenciesMs, cpuMs, peakRssMiB: process.resourceUsage().maxRSS / 1024,
    node: process.version, platform: process.platform, arch: process.arch }))
} finally { rmSync(root, { recursive: true, force: true }) }
