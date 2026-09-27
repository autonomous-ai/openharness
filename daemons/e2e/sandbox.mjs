#!/usr/bin/env node
/**
 * The daemons sandbox: a real backend, a real harnessd and a scripted engine, all isolated from the person's own
 * Harness. docs/research/2026-09-27-daemons-e2e.md has the recipe and the results.
 *
 *   node daemons/e2e/sandbox.mjs up          [--daemons on|off] [--backend <dir>] [--cli <dir>]
 *   node daemons/e2e/sandbox.mjs backend     [--daemons on|off] [--backend <dir>]     restart the backend only
 *   node daemons/e2e/sandbox.mjs harnessd    start|stop|restart [--cli <dir>] [--kill]  (--kill: HARNESS_DAEMONS=0)
 *   node daemons/e2e/sandbox.mjs status
 *   node daemons/e2e/sandbox.mjs down                                                   everything, always
 *
 * Everything lives under E2E_DIR (required), and nothing else is touched:
 *
 *   HOME        $E2E_DIR/home: harnessd's ~/.harness, ~/.claude (hooks, transcripts), ~/.config/harness.
 *   tmux        a private server, `tmux -L hde2e-<id>`, through a wrapper first on harnessd's PATH; TMUX is unset.
 *   harnessd    `cli.js start` (never `start -f`) on its own port (28473 unless taken), with the self-updater,
 *               the grid installer and the USB dial off. Its data folder is $E2E_DIR/home/.harness/cli/data,
 *               reached as /tmp/hde2e-<id>/data (the link is its parent, ~/.harness/cli) because a Unix socket
 *               path must fit in 104 bytes.
 *   engine      daemons/e2e/fake-claude.mjs as `claude` (CLAUDE_PATH): no real engine, no real credential.
 *   backend     <backend>/dist/server.js on a free port, against a throwaway MongoDB (a replica set, as Prisma
 *               needs) and Redis in uniquely named containers of the CURRENT docker context, and a stub SSO that
 *               accepts one random token: the sandbox user's (created with Prisma). Between harnessd and the
 *               backend sits a logging proxy (services.mjs): $E2E_DIR/logs/requests.jsonl.
 *
 * `down` stops harnessd, kills the private tmux server, stops the backend and services, and removes the
 * containers and the link. It is safe to run twice, and after a failed `up`.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const E2E = process.env.E2E_DIR ? resolve(process.env.E2E_DIR) : null
if (!E2E) { console.error('Set E2E_DIR to an empty scratch folder (everything the sandbox makes goes there).'); process.exit(2) }
const STATE = join(E2E, 'state.json')

const args = process.argv.slice(2)
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback }
const has = (name) => args.includes(name)

function readState() { try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return null } }
function writeState(state) { writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort(preferred) {
  return new Promise((resolvePort) => {
    const server = net.createServer()
    server.once('error', () => { if (preferred) freePort(null).then(resolvePort); else resolvePort(0) })
    server.listen(preferred ?? 0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)) })
  })
}
function run(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
}
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
function which(bin) { const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null }
async function until(label, check, ms = 30_000, every = 250) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try { if (await check()) return } catch { /* not yet */ }
    await sleep(every)
  }
  throw new Error(`timed out: ${label}`)
}

// ── docker: MongoDB (replica set) and Redis, uniquely named ──────────────────────────────────────────
async function startContainers(state) {
  const docker = which('docker')
  if (!docker) throw new Error('docker is not on PATH')
  // The CURRENT context, never switched.
  state.dockerContext = run(docker, ['context', 'show'])
  const mongo = `hde2e-mongo-${state.id}`
  const redis = `hde2e-redis-${state.id}`
  state.containers = [mongo, redis]
  writeState(state)
  run(docker, ['run', '-d', '--rm', '--name', mongo, '-p', `127.0.0.1:${state.ports.mongo}:${state.ports.mongo}`,
    'mongo:7', 'mongod', '--replSet', 'rs0', '--bind_ip_all', '--port', String(state.ports.mongo)])
  run(docker, ['run', '-d', '--rm', '--name', redis, '-p', `127.0.0.1:${state.ports.redis}:6379`, 'redis:7-alpine'])
  const initiate = `try { rs.status().ok } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:${state.ports.mongo}' }] }) }`
  await until('mongo up', () => { run(docker, ['exec', mongo, 'mongosh', '--quiet', '--port', String(state.ports.mongo), '--eval', initiate]); return true }, 60_000, 1000)
  await until('mongo primary', () => run(docker, ['exec', mongo, 'mongosh', '--quiet', '--port', String(state.ports.mongo), '--eval', 'rs.status().myState']) === '1', 60_000, 1000)
}

function databaseUrl(state) {
  return `mongodb://127.0.0.1:${state.ports.mongo}/harness_e2e?replicaSet=rs0&directConnection=true`
}

// ── the backend, the stub SSO and the proxy ──────────────────────────────────────────────────────────
function backendEnv(state, daemons) {
  return {
    PATH: process.env.PATH,
    HOME: join(E2E, 'backend-home'),
    NODE_ENV: 'development',
    PORT: String(state.ports.backend),
    PORT_APP_PROXY: String(state.ports.appProxy),
    MESH_ENABLED: 'false',
    DATABASE_URL: databaseUrl(state),
    REDIS_URL: `redis://127.0.0.1:${state.ports.redis}`,
    SSO_IDENTITY_URL: `http://127.0.0.1:${state.ports.sso}/identity`,
    SSO_PROFILE_URL: `http://127.0.0.1:${state.ports.sso}/profile`,
    STAGING_SSO_IDENTITY_URL: `http://127.0.0.1:${state.ports.sso}/identity`,
    STAGING_SSO_PROFILE_URL: `http://127.0.0.1:${state.ports.sso}/profile`,
    SSO_PROFILE_CACHE_TTL_MS: '0',
    HARNESS_BILLING_ENABLED: 'false',
    WEB_URL: 'http://127.0.0.1:9',
    HARNESS_DAEMONS: daemons === 'on' ? 'true' : 'false',
    HARNESS_DAEMONS_USERS: daemons === 'on' ? state.user.email : '',
    HARNESS_NEW_MACHINE_PER_HOUR: '0',
    HARNESS_NEW_MACHINE_PER_DAY: '0',
  }
}

function prisma(state, backendDir, argv) {
  return run(join(backendDir, 'node_modules', '.bin', 'prisma'), argv, {
    cwd: backendDir, env: { PATH: process.env.PATH, HOME: join(E2E, 'backend-home'), DATABASE_URL: databaseUrl(state) },
  })
}

async function seedUser(state, backendDir) {
  prisma(state, backendDir, ['db', 'push', '--skip-generate', '--accept-data-loss'])
  // The test user, created with Prisma in the sandbox database: the stub SSO answers its token with this identity.
  const script = `
    const { PrismaClient } = await import(${JSON.stringify(join(backendDir, 'node_modules', '@prisma', 'client', 'index.js'))}).then((m) => m.default ?? m)
    const db = new PrismaClient()
    const user = await db.user.upsert({
      where: { email: ${JSON.stringify(state.user.email)} },
      update: {},
      create: { email: ${JSON.stringify(state.user.email)}, externalId: ${JSON.stringify(state.user.externalId)}, name: 'Daemons E2E', autonomousEnv: 'prod' },
    })
    console.log(user.id)
    await db.$disconnect()`
  state.user.id = run(process.execPath, ['--input-type=module', '-e', script], { cwd: backendDir, env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl(state) } }).split('\n').pop()
  writeState(state)
}

function servicesConfig(state) {
  const file = join(E2E, 'run', 'services.json')
  writeFileSync(file, JSON.stringify({ repo: REPO, logDir: join(E2E, 'logs'), ssoPort: state.ports.sso, proxyPort: state.ports.proxy, backendPort: state.ports.backend, user: state.user }, null, 2))
  return file
}

function startServices(state) {
  const file = servicesConfig(state)
  const log = openSync(join(E2E, 'logs', 'services.log'), 'a')
  const child = spawn(process.execPath, [join(HERE, 'services.mjs'), file], { detached: true, stdio: ['ignore', log, log], cwd: join(E2E, 'run') })
  child.unref()
  state.pids.services = child.pid
  writeState(state)
}

async function startBackend(state, daemons, backendDir) {
  stopPid(state, 'backend')
  if (!existsSync(join(backendDir, 'dist', 'server.js'))) throw new Error(`${backendDir}/dist/server.js is missing: build the backend first (node build.mjs)`)
  mkdirSync(join(E2E, 'backend-home'), { recursive: true })
  const log = openSync(join(E2E, 'logs', 'backend.log'), 'a')
  // cwd is the sandbox: dotenv must not find a developer's backend/.env.
  const child = spawn(process.execPath, [join(backendDir, 'dist', 'server.js')], { detached: true, stdio: ['ignore', log, log], cwd: join(E2E, 'run'), env: backendEnv(state, daemons) })
  child.unref()
  state.pids.backend = child.pid
  state.backend = { dir: backendDir, daemons, startedAt: Date.now() }
  writeState(state)
  await until('backend health', async () => (await fetch(`http://127.0.0.1:${state.ports.backend}/api/health`)).ok, 60_000)
}

function stopPid(state, name) {
  const pid = state.pids?.[name]
  if (pid && alive(pid)) {
    try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    const deadline = Date.now() + 8000
    while (alive(pid) && Date.now() < deadline) spawnSync('/bin/sleep', ['0.2'])
    if (alive(pid)) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
  if (state.pids) delete state.pids[name]
  writeState(state)
}

// ── harnessd ─────────────────────────────────────────────────────────────────────────────────────────
function layoutHome(state) {
  const home = join(E2E, 'home')
  const bin = join(E2E, 'bin')
  mkdirSync(join(home, '.harness', 'cli', 'data'), { recursive: true, mode: 0o700 })
  mkdirSync(join(home, '.harness', 'auth'), { recursive: true, mode: 0o700 })
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.config', 'harness'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  // A login zsh with no rc of its own would stop at the new-user menu instead of running the engine.
  for (const rc of ['.zshrc', '.zshenv', '.zprofile']) if (!existsSync(join(home, rc))) writeFileSync(join(home, rc), '# daemons e2e sandbox\n')
  const tmux = which('tmux')
  if (!tmux) throw new Error('tmux is not on PATH')
  // Every tmux call harnessd (and its panes) make lands on the private server, whatever TMUX says.
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec ${JSON.stringify(tmux)} -L ${state.tmuxLabel} "$@"\n`)
  chmodSync(join(bin, 'tmux'), 0o755)
  const fake = join(bin, 'claude')
  copyFileSync(join(HERE, 'fake-claude.mjs'), fake)
  chmodSync(fake, 0o755)
  const node = join(bin, 'node')
  if (!existsSync(node)) symlinkSync(process.execPath, node)
  // The data folder, by a path short enough for its Unix socket. The link is its PARENT: harnessd opens the
  // data folder itself with O_NOFOLLOW (lib/secureState.ts) and rightly refuses a link there.
  try { lstatSync(state.dataLink) } catch { symlinkSync(join(home, '.harness', 'cli'), state.dataLink) }
  mkdirSync(join(E2E, 'work'), { recursive: true })
}

function signIn(state) {
  const home = join(E2E, 'home')
  writeFileSync(join(home, '.harness', 'computer-id'), state.computerId + '\n')
  const session = { version: 1, accessToken: state.user.token, autonomousEnv: 'prod', computerId: state.computerId, updatedAt: Date.now() }
  writeFileSync(join(home, '.harness', 'auth', 'session.json'), JSON.stringify(session) + '\n', { mode: 0o600 })
}

function harnessdEnv(state, opts = {}) {
  const home = join(E2E, 'home')
  return {
    HOME: home,
    USER: process.env.USER ?? 'e2e',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'e2e',
    SHELL: '/bin/zsh',
    PATH: `${join(E2E, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    PORT: String(state.ports.daemon),
    BACKEND_WS_URL: `ws://127.0.0.1:${state.ports.proxy}`,
    WEB_URL: 'http://127.0.0.1:9',
    AUTONOMOUS_ENV: 'prod',
    ADAPTER_DATA_DIR: join(state.dataLink, 'data'),
    // Nothing is downloaded: no self-update, no managed Node or grid runtime, no grid CLI.
    ADAPTER_UPDATE_DISABLE: 'true',
    ADAPTER_UPDATE_URL: 'http://127.0.0.1:9/none',
    ADAPTER_RUNTIME_METADATA_URL: 'http://127.0.0.1:9/none',
    ADAPTER_GRID_RUNTIME_METADATA_URL: 'http://127.0.0.1:9/none',
    HARNESS_GRID_BIN: join(E2E, 'bin', 'grid-not-installed'),
    DISABLE_GRID_INSTALL: 'true',
    CABLE_DISABLE: 'true',
    CABLE_FW_DISABLE: 'true',
    TERMINAL_BACKENDS: 'tmux',
    CLAUDE_PATH: join(E2E, 'bin', 'claude'),
    CODEX_PATH: join(E2E, 'bin', 'codex-not-installed'),
    ...(opts.kill ? { HARNESS_DAEMONS: '0' } : {}),
  }
}

function cliJs(dir) { return join(dir, 'dist', 'cli.js') }

async function startHarnessd(state, cliDir, opts = {}) {
  await stopHarnessd(state)
  signIn(state)
  if (!existsSync(cliJs(cliDir))) throw new Error(`${cliJs(cliDir)} is missing: build the cli first (node build.mjs)`)
  // `start`, not `start -f`: the daemon detaches, and a tool's teardown cannot SIGTERM it. `spawnAt` is after
  // the previous harnessd is gone (its shutdown flush is its own), before this one can ask anything.
  const spawnAt = Date.now()
  const r = spawnSync(process.execPath, [cliJs(cliDir), 'start'], { cwd: join(E2E, 'run'), env: harnessdEnv(state, opts), encoding: 'utf8', timeout: 60_000 })
  writeFileSync(join(E2E, 'logs', `harnessd-start-${Date.now()}.log`), `${r.stdout}\n${r.stderr}`)
  state.harnessd = { dir: cliDir, kill: !!opts.kill, spawnAt, startedAt: Date.now() }
  writeState(state)
  // Ready means discovery ran: before that a window's agent_create is answered UNSUPPORTED_ON_REMOTE.
  await until('harnessd ready', async () => {
    const res = await fetch(`http://127.0.0.1:${state.ports.daemon}/api/status`)
    return res.ok && (await res.json()).discoveryReady === true
  }, 90_000)
  const pidFile = join(E2E, 'home', '.harness', 'cli', 'data', 'harnessd.pid')
  state.harnessd.pid = pidOf(pidFile)
  writeState(state)
}

function pidOf(file) {
  for (const name of [file, join(dirname(file), 'adapter.pid'), join(dirname(file), 'harness.pid')]) {
    try { const n = Number(readFileSync(name, 'utf8').trim().split(/\s/)[0]); if (n) return n } catch { /* next */ }
  }
  // Fall back to whoever holds the port.
  return null
}

async function stopHarnessd(state) {
  // Even `cli.js stop` makes its data folder: lay out the link first, or it would land in /tmp.
  layoutHome(state)
  const cliDir = state.harnessd?.dir
  if (cliDir && existsSync(cliJs(cliDir))) {
    spawnSync(process.execPath, [cliJs(cliDir), 'stop'], { cwd: join(E2E, 'run'), env: harnessdEnv(state), encoding: 'utf8', timeout: 30_000 })
  }
  // Whatever still holds the sandbox port is ours (the port was chosen free at `up`).
  const holder = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${state.ports.daemon}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim()
  for (const pid of holder.split('\n').filter(Boolean).map(Number)) {
    try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
  }
  await until('harnessd gone', () => !spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${state.ports.daemon}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim(), 15_000).catch(() => {})
  if (state.harnessd) state.harnessd.stoppedAt = Date.now()
  writeState(state)
}

function killTmux(state) {
  const tmux = which('tmux')
  // Only ever the private server, by its label; TMUX is unset so nothing can redirect this.
  if (!tmux) return
  const env = { PATH: process.env.PATH, HOME: join(E2E, 'home') }
  spawnSync(tmux, ['-L', state.tmuxLabel, 'kill-server'], { env, encoding: 'utf8' })
  // The server can leave its socket file behind; remove it once nothing answers on it.
  const socket = join('/tmp', `tmux-${process.getuid()}`, state.tmuxLabel)   // harnessd's env has no TMUX_TMPDIR
  if (existsSync(socket) && spawnSync(tmux, ['-L', state.tmuxLabel, 'ls'], { env, encoding: 'utf8' }).status !== 0) {
    try { unlinkSync(socket) } catch { /* gone */ }
  }
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────────────
async function up() {
  mkdirSync(join(E2E, 'logs'), { recursive: true })
  mkdirSync(join(E2E, 'run'), { recursive: true })
  let state = readState()
  if (!state) {
    const id = randomBytes(4).toString('hex')
    state = {
      id,
      repo: REPO,
      tmuxLabel: `hde2e-${id}`,
      dataLink: `/tmp/hde2e-${id}`,
      computerId: randomBytes(16).toString('hex'),
      user: { email: `daemons-e2e-${id}@example.com`, externalId: `e2e-${id}`, token: randomBytes(24).toString('hex') },
      ports: {
        daemon: await freePort(28473), backend: await freePort(), appProxy: await freePort(), proxy: await freePort(),
        sso: await freePort(), mongo: await freePort(), redis: await freePort(),
      },
      pids: {},
    }
    writeState(state)
  }
  const backendDir = resolve(flag('--backend', state.backend?.dir ?? join(REPO, 'backend')))
  const cliDir = resolve(flag('--cli', state.harnessd?.dir ?? join(REPO, 'cli')))
  const daemons = flag('--daemons', 'on')
  // New containers are a new database: the user is created again.
  if (!state.containers) { await startContainers(state); delete state.user.id }
  if (!state.user.id) await seedUser(state, backendDir)
  if (!alive(state.pids.services)) startServices(state)
  if (!alive(state.pids.backend) || state.backend?.dir !== backendDir || state.backend?.daemons !== daemons) await startBackend(state, daemons, backendDir)
  await startHarnessd(state, cliDir, { kill: has('--kill') })
  status()
}

async function down() {
  const state = readState()
  if (!state) { console.log('nothing to take down'); return }
  await stopHarnessd(state).catch(() => {})
  killTmux(state)
  stopPid(state, 'backend')
  stopPid(state, 'services')
  const docker = which('docker')
  for (const name of state.containers ?? []) if (docker) spawnSync(docker, ['rm', '-f', name], { encoding: 'utf8' })
  try { if (lstatSync(state.dataLink).isSymbolicLink()) unlinkSync(state.dataLink) } catch { /* gone */ }
  state.down = Date.now()
  delete state.containers
  writeState(state)
  console.log(`down: harnessd, tmux -L ${state.tmuxLabel}, backend, services, containers, ${state.dataLink}`)
}

function status() {
  const state = readState()
  if (!state) { console.log('{}'); return }
  const socket = join(state.dataLink, 'data', `daemon-${state.ports.daemon}.sock`)
  console.log(JSON.stringify({
    id: state.id, ports: state.ports, socket, tmux: state.tmuxLabel,
    backend: { ...state.backend, alive: alive(state.pids.backend) }, services: alive(state.pids.services),
    harnessd: state.harnessd, containers: state.containers ?? [], dockerContext: state.dockerContext,
  }, null, 2))
}

const command = args[0]
try {
  if (command === 'up') await up()
  else if (command === 'down') await down()
  else if (command === 'status') status()
  else if (command === 'backend') {
    const state = readState()
    await startBackend(state, flag('--daemons', 'on'), resolve(flag('--backend', state.backend?.dir ?? join(REPO, 'backend'))))
    status()
  } else if (command === 'harnessd') {
    const state = readState()
    const verb = args[1]
    const cliDir = resolve(flag('--cli', state.harnessd?.dir ?? join(REPO, 'cli')))
    if (verb === 'stop') await stopHarnessd(state)
    else await startHarnessd(state, cliDir, { kill: has('--kill') })
    status()
  } else if (command === 'env') {
    // For a shell: the environment harnessd runs with (to run `cli.js pair …` against the sandbox, say).
    const state = readState()
    for (const [k, v] of Object.entries(harnessdEnv(state))) console.log(`export ${k}=${JSON.stringify(v)}`)
  } else {
    console.error('usage: sandbox.mjs up|down|status|backend|harnessd|env')
    process.exit(2)
  }
} catch (err) {
  console.error(`sandbox ${command} failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
