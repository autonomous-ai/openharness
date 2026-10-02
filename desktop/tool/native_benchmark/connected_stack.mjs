/** Own a private, source-built daemon and tmux server for connected resource measurements.
 * No account, model CLI, existing terminal or installed daemon is used. The macOS sandbox
 * additionally rejects writes outside this run and network connections outside loopback.
 * Keep stdin open while the desktop fixture runs; EOF cleans up only these owned processes.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, createConnection } from 'node:net'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(repo, 'cli/package.json'))
const { WebSocket } = require('ws')
const exec = promisify(execFile)
const options = Object.fromEntries(process.argv.slice(2).map(value => {
  const equal = value.indexOf('=')
  assert(equal > 2, 'Use --root=NEW_DIRECTORY --tmux=ABSOLUTE_BINARY [--terminals=10]')
  return [value.slice(2, equal), value.slice(equal + 1)]
}))
assert(Object.keys(options).every(key => ['root', 'tmux', 'terminals', 'bundle'].includes(key)), 'Unknown option')
assert(process.platform === 'darwin', 'This fixture requires the macOS isolation policy')
const root = resolve(options.root ?? '')
assert(root.startsWith('/private/tmp/harness-connected-') && dirname(root) === '/private/tmp', 'Use a fresh /private/tmp/harness-connected-NAME root')
const tmux = await realpath(options.tmux ?? '')
assert(tmux.startsWith('/') && !tmux.includes('\n'), 'An absolute tmux binary is required')
const bundle = await realpath(options.bundle ?? join(repo, 'cli/dist/cli.js'))
const count = Number(options.terminals ?? 10)
assert(Number.isInteger(count) && count >= 1 && count <= 48, 'Use 1–48 terminals')
await mkdir(root, { mode: 0o700 }) // Refuse an existing run; never erase another run's evidence.
const childHome = join(root, 'home')
const bin = join(root, 'bin')
for (const path of [childHome, bin, join(root, 'workspace'), join(root, 'data'), join(root, 'auth')]) {
  await mkdir(path, { recursive: true, mode: 0o700 })
}
const shellQuote = text => `'${text.replaceAll("'", "'\\''")}'`
const socket = join(root, 'tmux.sock')
await writeFile(join(bin, 'tmux'), `#!/bin/sh\nexec ${shellQuote(tmux)} -S ${shellQuote(socket)} "$@"\n`, { mode: 0o700 })
// A fixture must never request a real Keychain item, even if a future bootstrap adds a reader.
await writeFile(join(bin, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o700 })
const policy = join(root, 'isolation.sb')
// macOS refuses to launch setuid /bin/ps inside an inherited sandbox. Production
// discovery needs this fixed, read-only program; grant it the same narrow exec
// exception used by Apple's sandbox profiles for system inspection tools.
await writeFile(policy, `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null") (regex #"^/dev/(ptmx|ttys[0-9]+|tty|fd/[0-9]+)$"))\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*") (remote unix-socket (subpath ${JSON.stringify(root)})))\n(allow process-exec (with no-sandbox) (literal "/bin/ps"))\n`, { mode: 0o600 })
const listener = createServer()
await new Promise((done, reject) => listener.once('error', reject).listen(0, '127.0.0.1', done))
const port = listener.address().port
await new Promise(done => listener.close(done))
const machineId = randomUUID().replaceAll('-', '')
const env = {
  PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
  HOME: childHome, CFFIXED_USER_HOME: childHome, ZDOTDIR: childHome, SHELL: '/bin/zsh',
  TMPDIR: root, USER: 'harness-benchmark', LOGNAME: 'harness-benchmark', TERM: 'xterm-256color',
  NODE_ENV: 'production', PORT: String(port), TMUX: `${socket},0,0`,
  ADAPTER_COMPUTER_ID: machineId, ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
  ADAPTER_DATA_DIR: join(root, 'data'), HARNESS_AUTH_DIR: join(root, 'auth'),
  ADAPTER_CLI_DIR: join(root, 'cli'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
  HARNESS_BIN_DIR: bin, HARNESS_LOGS_DIR: join(root, 'logs'),
  HARNESS_LESSONS_DIR: join(root, 'lessons'), DSH_DIR: join(root, 'dsh'),
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'share'),
  XDG_CACHE_HOME: join(root, 'cache'),
  BACKEND_WS_URL: 'ws://127.0.0.1:1', WEB_URL: 'http://127.0.0.1:1',
  DISABLE_HOOK_INSTALL: 'true', DISABLE_GRID_INSTALL: 'true',
  ADAPTER_UPDATE_DISABLE: 'true', ANALYTICS_ENABLED: 'false',
  CABLE_DISABLE: 'true', CABLE_FW_DISABLE: 'true',
  RECAP_WITHOUT_DEVICE: 'true', SUMMARY_MODE: 'local',
  TERMINAL_BACKENDS: 'tmux',
}
for (const name of ['CLAUDE_PROJECTS_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME',
  'AGY_HOME', 'AGY_CONFIG_DIR', 'COPILOT_HOME', 'CURSOR_HOME', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR',
  'OPENCODE_DATA_DIR', 'OPENCODE_PLUGIN_DIR', 'KILO_DATA_DIR', 'KILO_PLUGIN_DIR', 'PI_HOME',
  'HERMES_HOME', 'COMMANDCODE_HOME', 'DEVIN_HOME', 'DEVIN_CONFIG_PATH', 'MUSE_HOME', 'MUSE_CONFIG_DIR',
  'AMP_PLUGIN_DIR', 'AMP_SESSIONS_DIR', 'AMP_STATE_DIR', 'ORI_CREDENTIALS_PATH']) env[name] = join(root, name.toLowerCase())
await writeFile(join(root, 'environment.json'), JSON.stringify(env, null, 2), { mode: 0o600 })
let daemon, connection, tmuxStart, stopping, shuttingDown = false
const pending = new Map()
const delay = ms => new Promise(done => setTimeout(done, ms))
function socketListening() {
  return new Promise((done, reject) => {
    const probe = createConnection(socket)
    probe.once('connect', () => { probe.destroy(); done(true) })
    probe.once('error', error => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) done(false)
      else reject(error)
    })
    probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('Private tmux socket probe timed out')) })
  })
}
async function cleanup(code) {
  if (stopping) return stopping
  shuttingDown = true
  stopping = (async () => {
    const errors = []
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Fixture shutting down')) }
    pending.clear()
    connection?.terminate()
    if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
      try { process.kill(-daemon.pid, 'SIGTERM') } catch {}
      for (let i = 0; i < 50 && daemon.exitCode === null && daemon.signalCode === null; i++) await delay(100)
      if (daemon.exitCode === null && daemon.signalCode === null) {
        try { process.kill(-daemon.pid, 'SIGKILL') } catch {}
        for (let i = 0; i < 50 && daemon.exitCode === null && daemon.signalCode === null; i++) await delay(100)
      }
      if (daemon.exitCode === null && daemon.signalCode === null) errors.push('Owned daemon did not exit')
    }
    // If EOF arrived during creation, wait for that one owned operation before
    // checking its socket. Startup checks shuttingDown before any further spawn.
    await tmuxStart?.catch(() => {})
    try {
      if (await socketListening()) {
        await exec(tmux, ['-S', socket, 'kill-server'], { env, timeout: 5000 })
        for (let i = 0; i < 50 && await socketListening(); i++) await delay(100)
        if (await socketListening()) errors.push('Owned tmux server is still listening')
      }
    } catch (error) { errors.push(String(error)) }
    try {
      await writeFile(join(root, 'cleanup.json'), JSON.stringify({
        success: errors.length === 0, errors, daemonExit: daemon?.exitCode, daemonSignal: daemon?.signalCode,
        isolatedSocket: socket, finishedAt: new Date().toISOString(),
      }, null, 2), { mode: 0o600 })
    } catch (error) {
      errors.push(`Could not record cleanup: ${error}`)
      console.error(errors.at(-1))
    }
    process.exit(errors.length ? 1 : code)
  })()
  return stopping
}
process.stdin.resume()
process.stdin.on('end', () => { void cleanup(0) })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void cleanup(0) })
process.on('uncaughtException', error => { console.error(error); void cleanup(1) })
process.on('unhandledRejection', error => { console.error(error); void cleanup(1) })
const request = (type, payload = {}) => new Promise((done, reject) => {
  const requestId = randomUUID()
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${type} timed out`)) }, 30_000)
  pending.set(requestId, { done, reject, timer })
  connection.send(JSON.stringify({ type, payload: { ...payload, requestId } }))
})

try {
  tmuxStart = exec('/usr/bin/sandbox-exec', ['-f', policy, tmux, '-S', socket, '-f', '/dev/null',
    'new-session', '-d', '-s', 'fixture-keeper', '-x', '120', '-y', '40', '/bin/sh'], { env })
  await tmuxStart
  assert(!shuttingDown, 'Fixture stopped during startup')
  daemon = spawn('/usr/bin/sandbox-exec', ['-f', policy, process.execPath, bundle, '__run'], {
    env, cwd: join(root, 'workspace'), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = createWriteStream(join(root, 'daemon.log'), { flags: 'wx', mode: 0o600 })
  daemon.stdout.pipe(log); daemon.stderr.pipe(log)
  const deadline = Date.now() + 30_000
  let status
  while (Date.now() < deadline) {
    assert(!shuttingDown, 'Fixture stopped during startup')
    assert(daemon.exitCode === null && daemon.signalCode === null, 'Fixture daemon exited during startup')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { 'x-adapter-local': '1' }, signal: AbortSignal.timeout(1000),
      })
      status = await response.json()
      if (status.discoveryReady === true) break
    } catch {}
    await delay(200)
  }
  assert(status?.discoveryReady === true && status.machineId === machineId, 'Private daemon did not become ready with its own identity')
  assert(!shuttingDown, 'Fixture stopped during startup')
  assert(status.pid === daemon.pid, 'Daemon port belongs to another process')
  connection = new WebSocket(`ws://127.0.0.1:${port}/api/local-ws`)
  connection.on('message', (raw, binary) => {
    if (binary) return
    const frame = JSON.parse(raw.toString()), reply = pending.get(frame.payload?.requestId)
    if (!reply) return
    clearTimeout(reply.timer); pending.delete(frame.payload.requestId)
    reply.done(frame.payload)
  })
  await new Promise((done, reject) => { connection.once('open', done); connection.once('error', reject) })
  const selected = new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('Private machine selection timed out')), 5000)
    connection.on('message', function selected(raw, binary) {
      if (!binary && JSON.parse(raw.toString()).type === 'connected') {
        clearTimeout(timeout); connection.off('message', selected); done()
      }
    })
  })
  connection.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1, tool: true } }))
  await selected
  const agents = []
  for (let i = 0; i < count; i++) {
    assert(!shuttingDown, 'Fixture stopped during terminal creation')
    const result = await request('agent_create', { engine: 'terminal', cwd: join(root, 'workspace'),
      creationId: randomUUID(), name: `Resource fixture ${i + 1}`, bypassPermission: false })
    assert(result.state === 'created' && result.agent?.id, `Private terminal creation failed: ${JSON.stringify(result)}`)
    agents.push(result.agent)
  }
  const observed = await request('agents_list')
  assert.equal(observed.agents?.length, count, 'The isolated inventory contains unexpected agents')
  const { stdout } = await exec(tmux, ['-S', socket, 'display-message', '-p', '#{pid}'], { env })
  const manifest = { schema: 1, ready: true, root, machineId, port, agents,
    daemonPid: daemon.pid, tmuxPid: Number(stdout.trim()),
    bundleSha256: createHash('sha256').update(await readFile(bundle)).digest('hex'),
    sourceRevision: (await exec('git', ['rev-parse', 'HEAD'], { cwd: dirname(bundle) })).stdout.trim(),
    sourceDiffSha256: createHash('sha256').update((await exec('git',
      ['diff', '--binary', 'HEAD', '--', '../src', '../package.json', '../package-lock.json', '../build-bundle.mjs'],
      { cwd: dirname(bundle), maxBuffer: 10 * 1024 * 1024 })).stdout).digest('hex'),
    startedAt: new Date().toISOString(), boundary: 'Full local daemon and tmux; private terminal shells; no cloud account or model inference.' }
  await writeFile(join(root, 'stack.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  connection.close()
  console.log(JSON.stringify({ ready: true, root, daemonPid: daemon.pid, tmuxPid: manifest.tmuxPid, port, terminals: count }))
} catch (error) {
  console.error(error)
  await cleanup(1)
}
