/** Matched complete registry/HTTP admissions. Private files and port; no daemon or real host binaries. */
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const workload = process.argv[2] ?? 'registry'
if (!['registry', 'http', 'held'].includes(workload)) throw Error('Unknown workload')
const cli = process.env.ADMISSION_COST_CLI ?? resolve('cli')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-admission-cost-')))
const hostPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'linux' })
const forbidden = () => { throw Error('Host binaries are forbidden in the admission measurement') }
Object.assign(childProcess, { exec: forbidden, execSync: forbidden, execFile: forbidden, spawn: forbidden,
  spawnSync: forbidden, fork: forbidden, execFileSync: (file: string, args: string[]) => {
    if (file === 'ps' && args.join(' ') === `-p ${process.pid} -o lstart=`) return 'fixture-start'
    return forbidden()
  } })
syncBuiltinESMExports()
for (const key of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'HARNESS_HOOK_ROUTES_DIR', 'HARNESS_AUTH_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'CURSOR_HOME', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'HERMES_HOME', 'PI_HOME', 'MUSE_HOME', 'GROK_HOME',
  'COMMANDCODE_HOME', 'AGY_HOME', 'AGY_CONFIG_DIR', 'COPILOT_HOME', 'AMP_SESSIONS_DIR', 'OPENCODE_DATA_DIR',
  'OPENCODE_PLUGIN_DIR', 'KILO_DATA_DIR', 'KILO_PLUGIN_DIR', 'DEVIN_HOME', 'DEVIN_CONFIG_PATH']) {
  process.env[key] = join(root, key); mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 })
}
for (const key of ['TMUX', 'TMUX_PANE']) delete process.env[key]
process.env.CLAUDE_PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR!, 'projects')
process.env.HARNESS_CONNECTIONS_PORT = '0'; process.env.TZ = 'UTC'
console.log = () => {}
let server: import('node:http').Server | undefined
try {
  const load = (part: string) => import(pathToFileURL(join(cli, 'src', part)).href)
  const { SYSTEM_BOOT_SOURCES } = await load('lib/bootId.ts')
  Object.assign(SYSTEM_BOOT_SOURCES, { linuxBootId: () => 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', bootTimeSec: () => 1 })
  const { registry } = await load('lib/registry.ts')
  const id = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
  mkdirSync(join(process.env.CODEX_HOME!, 'sessions'))
  const file = join(process.env.CODEX_HOME!, 'sessions', `rollout-${id}.jsonl`)
  const header = JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source: 'cli' } }) + '\n'
  writeFileSync(file, header)
  writeFileSync(join(process.env.ADAPTER_DATA_DIR!, 'engine-homes.json'), '{}')
  const agent = registry.openProcessAgent({ engine: 'codex', tmuxPane: '%1', cwd: root,
    processIdentity: { pid: 4101, startMarker: 'fixture-start', executable: '<codex>' } })!.entry
  const body = { engine: 'codex', sessionId: id, transcriptPath: file, tmuxPane: '%1', cwd: root }
  let registered = 0, endpoint = '', token = ''
  if (workload !== 'registry') {
    const { startHookServer } = await load('hookServer.ts'), { readHookCredential } = await load('lib/hookAuth.ts')
    const started = await startHookServer(0, { onRegistered: () => { registered++ }, onSessionEnd: () => {} })
    server = started.server; endpoint = `http://127.0.0.1:${started.port}/api/hook/session-start`
    token = readHookCredential(process.env.ADAPTER_DATA_DIR!)
  }
  const iterations = workload === 'held' ? 5 : 100
  const latenciesMs: number[] = [], responseMs: number[] = []
  let cpuMs = 0
  for (let i = 0; i < iterations; i++) {
    const request = { ...body, title: `fixture ${i}`, hookEvent: 'UserPromptSubmit', prompt: `fixture ${i}` }
    if (workload === 'held') rmSync(file)
    const cpu = process.cpuUsage(), started = performance.now()
    if (workload === 'registry') {
      if (registry.register(request)?.entry.agentId !== agent.agentId) throw Error('Registration was not completed')
    } else {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
        'x-harness-hook-token': token, 'x-harness-hook-fired-at': String(Date.now()),
        'x-harness-hook-delivery-id': `fixture-delivery-${String(i).padStart(6, '0')}` }, body: JSON.stringify(request) })
      const reply = await response.json() as { ok?: boolean; pending?: boolean }
      responseMs.push(performance.now() - started)
      if (response.status !== 200 || !(workload === 'held' ? reply.pending : reply.ok)) throw Error('Unexpected admission response')
      if (workload === 'held') {
        writeFileSync(file, header)
        const deadline = performance.now() + 5_000
        while (registered <= i && performance.now() < deadline) await new Promise(done => setTimeout(done, 10))
      }
      if (registered !== i + 1) throw Error('The admitted delivery was not notified exactly once')
    }
    latenciesMs.push(performance.now() - started)
    const used = process.cpuUsage(cpu); cpuMs += (used.user + used.system) / 1000
    const rows = JSON.parse(readFileSync(join(process.env.ADAPTER_DATA_DIR!, 'registry.json'), 'utf8'))
    if (!rows.some((row: { agentId: string; sessionId: string }) => row.agentId === agent.agentId && row.sessionId === id)) throw Error('Durable binding missing')
  }
  process.stdout.write(JSON.stringify({ workload, iterations, latenciesMs, responseMs, cpuMs,
    peakRssMiB: process.resourceUsage().maxRSS / 1024, node: process.version, hostPlatform, evidencePlatform: process.platform,
    arch: process.arch, outcomes: { durableAdmissions: iterations, notifications: registered } }) + '\n')
} finally {
  if (server) await new Promise<void>(done => server!.close(() => done()))
  rmSync(root, { recursive: true, force: true })
}
