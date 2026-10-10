/** Same private history workload on two revisions, each sample in a fresh process. */
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const workload = process.argv[2]
if (!['inspect-claude', 'inspect-codex', 'inspect-missing-codex', 'purge-codex'].includes(workload)) throw Error('Unknown workload')
const cli = process.env.NATIVE_HISTORY_COST_CLI ?? resolve(import.meta.dirname, '../..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-history-cost-'))), hostPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'linux' })
const forbidden = () => { throw Error('Host binaries are forbidden in the history measurement') }
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
process.env.CLAUDE_PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR!, 'projects')
process.env.HARNESS_CONNECTIONS_PORT = '0'; process.env.TZ = 'UTC'
console.log = () => {}
try {
  const load = (name: string) => import(pathToFileURL(join(cli, 'src', name)).href)
  const { SYSTEM_BOOT_SOURCES } = await load('lib/bootId.ts')
  Object.assign(SYSTEM_BOOT_SOURCES, { linuxBootId: () => 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', bootTimeSec: () => 1 })
  const { inspectNativeHistory, eraseNativeHistory } = await load('lib/purgeAgentService.ts')
  const engine = workload === 'inspect-claude' ? 'claude' : 'codex', id = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
  const folder = join(process.env[engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']!, engine === 'claude' ? 'projects' : 'sessions')
  mkdirSync(folder)
  const file = join(folder, `${id}.jsonl`), missing = workload === 'inspect-missing-codex'
  const contents = JSON.stringify(engine === 'codex' ? { type: 'session_meta', payload: { id, cwd: root, source: 'cli' } }
    : { type: 'user', sessionId: id, cwd: root, isSidechain: false }) + '\n'
    + JSON.stringify({ type: 'event_msg', text: 'x'.repeat(1024) }) + '\n'
  writeFileSync(join(process.env.ADAPTER_DATA_DIR!, 'engine-homes.json'), '{}')
  const row = { agentId: 'fixture-agent', engine, sessionId: id, cwd: root, transcriptPath: file,
    registeredAt: 1, codexHome: null, hermesHome: null, processIdentity: null }
  const iterations = 30, latenciesMs: number[] = []
  let cpuMs = 0
  for (let i = 0; i < iterations; i++) {
    if (!missing) writeFileSync(file, contents)
    const cpu = process.cpuUsage(), started = performance.now()
    const result = await inspectNativeHistory(row)
    if (workload === 'purge-codex') await eraseNativeHistory(result)
    latenciesMs.push(performance.now() - started)
    const used = process.cpuUsage(cpu); cpuMs += (used.user + used.system) / 1000
    if (missing ? result.missingFile !== file || result.bytes !== 0 : result.file?.path !== file || result.bytes <= 0) throw Error('History identity was lost')
    if (workload === 'purge-codex' && existsSync(file)) throw Error('Confirmed private history was not removed')
    if (!existsSync(root)) throw Error('The workspace was removed')
  }
  process.stdout.write(JSON.stringify({ workload, iterations, latenciesMs, cpuMs, sourceBytes: Buffer.byteLength(contents),
    peakRssMiB: process.resourceUsage().maxRSS / 1024, node: process.version, hostPlatform, evidencePlatform: process.platform,
    arch: process.arch, outcomes: { confirmed: iterations } }) + '\n')
} finally { rmSync(root, { recursive: true, force: true }) }
