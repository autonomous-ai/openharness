import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBinaryOnPath } from '../src/lib/binaryOnPath.js'
import { REAL_ENGINE_FOLDERS, realEngineEnvironment, realEnginePlan, redactRealEngineOutput } from '../src/testing/realEnginePolicy.js'

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inherited = { ...process.env }
let root = ''
let output = ''
let child: ReturnType<typeof spawn> | undefined
let timer: NodeJS.Timeout | undefined
let killTimer: NodeJS.Timeout | undefined
let aborted = false
const stop = () => {
  aborted = true
  if (child?.pid) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    killTimer ??= setTimeout(() => { try { process.kill(-child!.pid!, 'SIGKILL') } catch { /* gone */ } }, 5_000)
  }
}

try {
  const plan = realEnginePlan(inherited)
  if (process.argv.length > 2) throw new Error('Use REAL_ENGINE to select an engine; Vitest overrides are not accepted')
  if (process.platform === 'win32') throw new Error('This prototype requires POSIX process groups and tmux')
  const binaries: Record<string, string> = {}
  for (const name of [...plan.engines, 'tmux']) {
    const binary = resolveBinaryOnPath(name)
    if (!binary) throw new Error(`Missing installed binary: ${name}`)
    binaries[name] = realpathSync(binary)
  }
  // Short paths keep the daemon's Unix socket within macOS's sockaddr_un limit.
  root = realpathSync(mkdtempSync('/tmp/hre-'))
  const env = realEngineEnvironment(inherited, root)
  for (const folder of Object.values(REAL_ENGINE_FOLDERS)) mkdirSync(join(root, folder), { recursive: true, mode: 0o700 })
  const owner = randomUUID()
  writeFileSync(join(root, 'owner'), owner, { mode: 0o600, flag: 'wx' })
  writeFileSync(join(root, 'sockets'), '', { mode: 0o600, flag: 'wx' })
  Object.assign(env, { REAL_ENGINE_RUN_ROOT: root, REAL_ENGINE_RUN_ID: owner })
  for (const engine of plan.engines) env[`REAL_${engine.toUpperCase()}_BINARY`] = binaries[engine]
  const versions = Object.fromEntries(plan.engines.map((engine) => [engine,
    execFileSync(binaries[engine], ['--version'], { env, timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()]))
  output += `${JSON.stringify({ plan, versions, started: new Date().toISOString() })}\n`
  child = spawn(process.execPath, [join(cli, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'vitest.real-engines.config.ts'], { cwd: cli, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const take = (chunk: Buffer) => {
    if (aborted) return
    output += chunk.toString('utf8')
    if (Buffer.byteLength(output) > 20 * 1024 * 1024) { output += '\nOutput limit exceeded\n'; stop() }
  }
  child.stdout!.on('data', take)
  child.stderr!.on('data', take)
  timer = setTimeout(() => { output += '\nWhole-run deadline exceeded (45 minutes)\n'; stop() }, 45 * 60_000)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const code = await new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('exit', done) })
  process.exitCode = aborted ? 1 : (code ?? 1)
} catch (error) {
  output += `${error instanceof Error ? error.message : String(error)}\n`
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  clearTimeout(killTimer)
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* group is gone */ } }
  if (root) {
    try {
      for (const socket of readFileSync(join(root, 'sockets'), 'utf8').split('\n').filter(Boolean)) {
        if (!existsSync(dirname(socket))) continue
        const rel = relative(root, realpathSync(dirname(socket)))
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Refusing cleanup of a socket outside this run')
        try { execFileSync('tmux', ['-S', socket, 'kill-server'], { env: realEngineEnvironment(inherited, root), timeout: 5_000, stdio: 'pipe' }) }
        catch { if (existsSync(socket)) throw new Error('The private tmux server did not stop') }
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (error) { output += `Cleanup failed: ${String(error)}\n`; process.exitCode = 1 }
  }
  // Never persist raw chunks or homes. An assertion can contain a screen/record with an echoed token.
  const redacted = redactRealEngineOutput(output, inherited, root || '<no-run-root>')
  if (inherited.REAL_ENGINE_REPORT) writeFileSync(resolve(inherited.REAL_ENGINE_REPORT), redacted, { mode: 0o600, flag: 'wx' })
  process.stdout.write(redacted)
}
