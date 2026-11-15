/** Matched private native-control work. Run each workload in a fresh process, alone. */
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const workload = process.argv[2] ?? 'capture-codex'
// Adapter verification exercises one outcome without collecting or reporting performance evidence.
const verify = process.argv.includes('--verify')
if (!['capture-codex', 'capture-claude', 'checkpoint-small', 'checkpoint-large', 'checkpoint-reuse', 'stop', 'resume-held'].includes(workload)) throw Error('Unknown workload')
const cli = process.env.CONTROL_COST_CLI ?? resolve(import.meta.dirname, '../..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'control-transcript-cost-')))
// The daemon normally owns live sockets. Its unref'ed zero-delay Stop wait must
// also finish in this standalone process before its measurements are written.
const keepAlive = setInterval(() => {}, 60_000)
const hostPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'linux' })
const forbidden = () => { throw Error('Host binaries are forbidden in the control measurement') }
Object.assign(childProcess, { exec: forbidden, execSync: forbidden,
  execFile: (file: string, args: string[], _options: unknown, done: (error: null, stdout: string, stderr: string) => void) => {
    if (file !== 'ps' || args.join(' ') !== `-p ${process.pid} -o lstart=`) return forbidden()
    queueMicrotask(() => done(null, 'fixture-start', ''))
    return { kill: () => false }
  }, spawn: forbidden,
  spawnSync: forbidden, fork: forbidden, execFileSync: (file: string, args: string[]) => {
    if (file === 'ps' && args.join(' ') === `-p ${process.pid} -o lstart=`) return 'fixture-start'
    return forbidden()
  } })
syncBuiltinESMExports()
for (const key of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'PI_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
  process.env[key] = join(root, key); mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 })
}
for (const key of ['TMUX', 'TMUX_PANE']) delete process.env[key]
process.env.CLAUDE_PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR!, 'projects')
process.env.HARNESS_CONNECTIONS_PORT = '0'; process.env.TZ = 'UTC'
console.log = () => {}
const hashFile = (path: string) => {
  const hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024), fd = openSync(path, 'r')
  try { for (;;) { const bytes = readSync(fd, buffer); if (!bytes) break; hash.update(buffer.subarray(0, bytes)) } }
  finally { closeSync(fd) }
  return hash.digest('hex')
}
let settleRegistry: (() => unknown) | undefined
try {
  const load = (part: string) => import(pathToFileURL(join(cli, 'src', part)).href)
  const { SYSTEM_BOOT_SOURCES } = await load('lib/bootId.ts')
  Object.assign(SYSTEM_BOOT_SOURCES, { linuxBootId: () => 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', bootTimeSec: () => 1 })
  const { registry } = await load('lib/registry.ts')
  settleRegistry = () => registry.flush({ exiting: true })
  // This historical workload also targets recorded pre-async CLI trees through CONTROL_COST_CLI.
  const removeAgent = async (id: string, options?: { authority?: import('../../src/lib/registry.js').RegistryAuthority }) => {
    if (typeof registry.confirmEngineExit === 'function') {
      const result = await registry.confirmEngineExit(id, 'remove', options?.authority)
      if (result.state !== 'confirmed') throw Error('Fixture removal was not durably confirmed')
    } else registry.removeAgent(id)
    if (registry.byAgent(id)) throw Error('Fixture removal retained a live owner')
  }
  const { captureResumeIdentity } = await load('lib/captureResumeIdentity.ts')
  const { SessionCheckpointStore } = await load('lib/sessionCheckpoint.ts')
  const { StoppedAgentStore } = await load('lib/stoppedAgents.ts')
  const { AgentRestartCoordinator } = await load('lib/restartAgent.ts')
  const { createStopAgentService } = await load('lib/stopAgentService.ts')
  const { createResumeAgentService } = await load('lib/resumeAgentService.ts')
  const engine = workload === 'capture-claude' ? 'claude' : 'codex'
  const id = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
  const folder = join(process.env[engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']!, engine === 'claude' ? 'projects' : 'sessions')
  mkdirSync(folder)
  const file = join(folder, `rollout-${id}.jsonl`)
  const header = JSON.stringify(engine === 'codex' ? { type: 'session_meta', payload: { id, cwd: root, source: 'cli' } }
    : { type: 'user', sessionId: id, cwd: root, isSidechain: false }) + '\n'
  const large = workload === 'checkpoint-large' || workload === 'checkpoint-reuse'
  const contents = header + JSON.stringify({ type: 'event_msg', text: 'x'.repeat(large ? 8 * 1024 * 1024 : 1024) }) + '\n'
  writeFileSync(file, contents)
  writeFileSync(join(process.env.ADAPTER_DATA_DIR!, 'engine-homes.json'), '{}')
  const directory = join(root, 'checkpoints'), checkpoints = new SessionCheckpointStore(directory)
  const stopped = new StoppedAgentStore(join(root, 'stopped')), restartJobs = new AgentRestartCoordinator(), stopJobs = new Map()
  let killedPanes = 0
  const stopBackend = { kill: async (_runtime: unknown, current?: () => boolean) => {
    if (current?.() === false) return { state: 'failed', dispatch: 'not_started', reason: 'Fixture ownership changed' }
    killedPanes++; return { state: 'succeeded', dispatch: 'executed' }
  } }
  const resumeBackend = { create: forbidden, kill: forbidden, releaseHold: forbidden,
    paneState: forbidden, rootProcess: forbidden, inventory: forbidden }
  const stop = createStopAgentService({ registry, stoppedAgents: stopped, restartJobs, stopJobs,
    // Both dependency shapes are fixture-only: the same workload can target the recorded older tree.
    tmuxBackend: stopBackend, backendFor: (runtime: { backend: string }) => runtime.backend === 'tmux' ? stopBackend : undefined,
    agentReconciler: { suppress() {}, holdRoute() {}, releaseRoute() {}, trigger: async () => {} },
    forgetSession: removeAgent, markDeleted() {}, clearDeleted() {}, stopNative: async () => {} })
  const resume = createResumeAgentService({ registry, stoppedAgents: stopped, restartJobs, stopJobs, pinnedControls: new Set(),
    tmuxBackend: resumeBackend, createBackend: resumeBackend, backendFor: () => resumeBackend,
    retainExitedSession: forbidden, announceSession: forbidden,
    relaunchOverrides: async () => ({ ok: false, error: 'SERVICE_UNAVAILABLE', detail: 'Fixture dependency is unavailable.' }),
    prepareSessionResume: forbidden, refreshGridWebSearch: forbidden, clearDeleted() {}, attachDsh: forbidden, attachSession: forbidden })
  const iterations = verify ? 1 : workload.startsWith('checkpoint') ? 5 : 50
  const latenciesMs: number[] = []
  let cpuMs = 0, agent: import('../../src/lib/registry.js').RegisteredSession | undefined
  for (let i = 0; i < iterations; i++) {
    if (!agent || workload === 'stop' || workload === 'resume-held') {
      const admitted = await registry.openPendingAgent({ engine, cwd: root, runtimes: [{ backend: 'tmux', paneId: `%${i + 1}` }] })
      const live = admitted && registry.byAgent(admitted.agentId)
      if (!live) throw Error('Fixture owner was not admitted')
      // Admission returns an immutable receipt now; seed the selected fixture row outside timed work.
      Object.assign(live, { sessionId: id, transcriptPath: file, processIdentity: null })
      await registry.flush()
      agent = structuredClone(registry.byAgent(live.agentId))
      if (!agent || agent.sessionId !== id || registry.byAgent(agent.agentId)?.sessionId !== id) throw Error('Fixture registry binding was not installed')
      if (workload === 'resume-held') { stopped.save(agent); await removeAgent(agent.agentId) }
    }
    if (workload === 'checkpoint-reuse' && i === 0) await checkpoints.save(agent)
    if (workload.startsWith('checkpoint') && workload !== 'checkpoint-reuse') writeFileSync(file, contents + JSON.stringify({ turn: i }) + '\n')
    const cpu = verify ? undefined : process.cpuUsage(), started = verify ? 0 : performance.now()
    if (workload.startsWith('capture')) {
      const result = await captureResumeIdentity(agent)
      if (result.sessionId !== id || result.transcriptPath !== file) throw Error('Capture lost native identity')
    } else if (workload.startsWith('checkpoint')) await checkpoints.save(agent, { screen: 'Private unsent draft' })
    else if (workload === 'stop') await stop(agent.agentId)
    else {
      const result = await resume(agent.agentId)
      if (result.ok || result.error !== 'SERVICE_UNAVAILABLE' || stopped.resumeReservedAt(agent.agentId) !== null) throw Error('Resume did not retain a retryable dependency hold')
    }
    if (!verify) {
      latenciesMs.push(performance.now() - started)
      const used = process.cpuUsage(cpu); cpuMs += (used.user + used.system) / 1000
    }
    if (workload.startsWith('checkpoint')) {
      const manifest = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name))!), 'utf8'))
      if (hashFile(join(directory, manifest.file)) !== hashFile(file)) throw Error('Checkpoint bytes differ from their source')
    }
    if (workload === 'stop' && (killedPanes !== i + 1 || registry.byAgent(agent.agentId) || stopped.get(agent.agentId)?.sessionId !== id)) throw Error('Stop did not retain its conversation')
  }
  process.stdout.write(JSON.stringify(verify ? { workload, verified: iterations } : { workload, iterations, latenciesMs, cpuMs, sourceBytes: statSync(file).size,
    peakRssMiB: process.resourceUsage().maxRSS / 1024, node: process.version, hostPlatform, evidencePlatform: process.platform,
    arch: process.arch, outcomes: { confirmed: iterations } }) + '\n')
} finally {
  try { await settleRegistry?.() }
  finally { clearInterval(keepAlive); rmSync(root, { recursive: true, force: true }) }
}
