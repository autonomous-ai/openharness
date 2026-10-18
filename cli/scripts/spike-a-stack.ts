/**
 * THROWAWAY (shared-tabs Spike A). A long-running two-account stack for a member's desktop:
 * the real backend on throwaway Mongo/Redis, an SSO stand-in, and two isolated daemons (alice, bob)
 * with fake engines. Alice makes one harness and shares it with bob; bob makes two harnesses and a desk
 * tab holding them. Writes stack.json + roster.json + app-env.json to SPIKE_OUT, prepares bob's
 * throwaway home so a desktop launched with app-env.json reaches ONLY bob's daemon, and serves a small
 * control API on 127.0.0.1 until killed.
 *
 *   cd cli && HARNESS_E2E_SERVICES_DIR=~/test-services SPIKE_OUT=<dir> npx tsx scripts/spike-a-stack.ts
 */
import { createServer } from 'node:http'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
// e2e/harness/artifacts.ts reads vitest's worker state on every daemon log line; outside vitest there
// is none, so give it an empty one (no test path: artifacts stay off).
;(globalThis as any).__vitest_worker__ = { filepath: undefined, current: undefined, config: {}, ctx: {} }
const { account, signIn, startRealBackend } = await import('../e2e/harness/realBackend.js')
const { until, CLI_ROOT } = await import('../e2e/harness/daemon.js')

const out = process.env.SPIKE_OUT
if (!out) throw new Error('Set SPIKE_OUT')
mkdirSync(out, { recursive: true })
const log = (line: string) => console.log(`[stack] ${line}`)

const alice = account('alice'), bob = account('bob')
const backend = await startRealBackend([alice, bob], log)
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  log('stopping')
  await backend.stop()
  log('stopped')
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

try {
const A = await signIn(backend, alice), B = await signIn(backend, bob)
for (const [who, me] of [[alice, A], [bob, B]] as const) {
  await until(`${who.name} machine running`, async () => {
    const ms = (await backend.api(who, '/api/machines')).body.data.machines
    return ms.length === 1 && ms[0].machineId === me.machineId && ms[0].status === 'running'
  }, 60_000, 200)
}
log(`alice daemon ${A.daemon.port} machine ${A.machineId}; bob daemon ${B.daemon.port} machine ${B.machineId}`)

const make = async (who: typeof A, folder: string) => {
  const cwd = join(who.daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  return (await who.client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)).agent
}
const a1 = await make(A, 'alice-project')
const inv = await A.client.request('harness_share_invite', { agentId: a1.id, emails: [bob.email], days: 7 })
const share = inv.shares[0]
log(`alice harness ${a1.id} (${a1.tmuxPane}) shared ${share.id} pending=${share.pending}`)
const b1 = await make(B, 'bob-one'), b2 = await make(B, 'bob-two')

// Bob's desk: one tab holding his two harnesses, written the way another of his computers would.
const tabId = randomBytes(16).toString('hex')
const ops = await backend.api(bob, '/api/desk/ops', 'POST', { ops: [
  { op: 'tab.create', id: tabId, name: 'Spike tab', nameIsCustom: true },
  { op: 'pane.add', tabId, machineId: B.machineId, agentId: b1.id },
  { op: 'pane.add', tabId, machineId: B.machineId, agentId: b2.id },
] })
log(`bob desk ${JSON.stringify(ops.body.data)}`)

const local = async (port: number, path: string) =>
  (await (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-adapter-local': '1' } })).json()) as any
const shares = await until('bob sees the share', async () => {
  const r = await local(B.daemon.port, '/api/harness-shares')
  return r?.data?.machines?.length ? r.data.machines : null
}, 30_000, 300)
const m = shares[0], g = m.shares[0]
const roster = {
  sharedTabId: 'spike0000000000000000000', tabId,
  owner: { name: m.ownerName, publicKey: g.ownerPublicKey },
  harnesses: [{ machineId: m.machineId, agentId: g.agentId, name: g.name ?? a1.name, engine: 'claude',
    grant: { id: g.id, expiresAt: g.expiresAt } }],
}
writeFileSync(join(out, 'roster.json'), JSON.stringify(roster, null, 2))

// Bob's throwaway home made to look like a computer with Harness installed, so the desktop's setup
// never runs the installer: a "managed" node (a link to this node) and a guarded cli.js that runs this
// checkout's CLI in bob's daemon environment and refuses anything that starts, stops or signs in/out.
const bobEnv = { ...B.daemon.env } as Record<string, string>
const home = bobEnv.HOME
mkdirSync(join(home, '.harness/runtime'), { recursive: true })
mkdirSync(join(home, '.harness/cli'), { recursive: true })
const node = join(home, '.harness/runtime/node')
try { symlinkSync(process.execPath, node) } catch { /* exists */ }
writeFileSync(join(home, '.harness/runtime/current-node'), node)
const cliLog = join(out, 'bob-cli-calls.log')
writeFileSync(join(home, '.harness/cli/cli.js'), `// spike guard: bob's CLI only
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(cliLog)}, new Date().toISOString() + ' ' + JSON.stringify(args) + ' PORT=' + process.env.PORT + ' HOME=' + process.env.HOME + '\\n')
if (process.env.PORT !== ${JSON.stringify(String(B.daemon.port))} || process.env.HOME !== ${JSON.stringify(home)}) { console.error('spike guard: wrong environment'); process.exit(1) }
if (args[0] === 'version') { console.log('0.0.1-dev.spike'); process.exit(0) }\nconst blocked = ['start', 'stop', 'restart', 'login', 'logout', 'update', 'uninstall', 'install']
if (blocked.includes(args[0])) { fs.appendFileSync(${JSON.stringify(cliLog)}, '  blocked\\n'); process.exit(args[0] === 'login' || args[0] === 'logout' ? 1 : 0) }
const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: ${JSON.stringify(CLI_ROOT)}, stdio: 'inherit', env: process.env })
process.exit(r.status ?? 1)
`)
const appEnv = { ...bobEnv,
  // Claude Code's Keychain item is named for CLAUDE_CONFIG_DIR and USER: neither names the owner's.
  CLAUDE_CONFIG_DIR: join(home, '.claude'), USER: 'spike-bob', LOGNAME: 'spike-bob' }
writeFileSync(join(out, 'app-env.json'), JSON.stringify(appEnv, null, 2))

// Control API.
const clients = { alice: A, bob: B }
const control = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x')
  const who = (url.searchParams.get('who') ?? 'alice') as 'alice' | 'bob'
  const c = clients[who]
  try {
    let body: unknown = null
    if (url.pathname === '/rpc') {
      body = await c.client.request(url.searchParams.get('type')!, JSON.parse(url.searchParams.get('payload') ?? '{}'), 30_000)
    } else if (url.pathname === '/prompt') {
      const pane = url.searchParams.get('pane') ?? a1.tmuxPane
      await c.daemon.tmux.run('send-keys', '-t', pane, '-l', url.searchParams.get('text')!)
      await c.daemon.tmux.run('send-keys', '-t', pane, 'Enter')
      body = { ok: true, pane }
    } else if (url.pathname === '/capture') {
      body = { text: await c.daemon.capture(url.searchParams.get('pane') ?? a1.tmuxPane) }
    } else if (url.pathname === '/panes') {
      body = { text: await c.daemon.tmux.run('list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{pane_dead}\t#{pane_current_command}') }
    } else if (url.pathname === '/stop') {
      res.end('{"stopping":true}')
      void stop()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  } catch (error) {
    res.writeHead(500).end(JSON.stringify({ error: String(error) }))
  }
}).listen(0, '127.0.0.1')
await new Promise(r => control.once('listening', r))

const stack = {
  backend: backend.url, control: `http://127.0.0.1:${(control.address() as { port: number }).port}`,
  alice: { ...alice, port: A.daemon.port, machineId: A.machineId, root: A.daemon.root, dataDir: A.daemon.dataDir,
    tmuxSocket: A.daemon.tmux.socket, agent: { id: a1.id, tmuxPane: a1.tmuxPane, name: a1.name } },
  bob: { ...bob, port: B.daemon.port, machineId: B.machineId, root: B.daemon.root, home, dataDir: B.daemon.dataDir,
    tmuxSocket: B.daemon.tmux.socket, agents: [b1, b2].map(a => ({ id: a.id, tmuxPane: a.tmuxPane, name: a.name })) },
  share, tabId, pid: process.pid,
}
writeFileSync(join(out, 'stack.json'), JSON.stringify(stack, null, 2))
log(`ready: ${join(out, 'stack.json')}`)
setInterval(() => {}, 1 << 30)
} catch (error) {
  console.error(error)
  await stop()
}
