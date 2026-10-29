import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { listenLocalSocket, localSocketPath, type LocalSocketServer } from './lib/localSocket.js'
import { SpawnedRuns } from './testing/spawnedRuns.js'

// The second review of #2087 (item 8): the CLI itself runs `harness send`, `new`, `tell` and `close` only past the Buddy
// check (superTabs/buddyPane.ts), and leaves the other verbs alone. Each run is the real CLI under tsx, against a daemon of
// this test's own on a private socket.
const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_SOURCE = join(CLI_ROOT, 'src', 'cli.ts')
const TSX = join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const runs = new SpawnedRuns((command) => command.includes(CLI_SOURCE))
process.once('exit', () => runs.killAllSync())
const PORT = 47391
const REFUSED = 'This command names a pane it does not run in. Run it as your harness gave it, without setting TMUX_PANE.'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  await runs.endAll()
  for (const step of cleanup.splice(0).reverse()) await step()
})

/** A daemon that serves this computer and says the Swarm is on with no Buddy; it records every request it hears. */
async function fakeDaemon(dataDir: string) {
  const heard: string[] = []
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const local: LocalSocketServer = await listenLocalSocket((_req, res) => res.end('{}'), localSocketPath(dataDir, PORT)!)
  const wss = new WebSocketServer({ server: local.server, path: '/api/local-ws' })
  wss.on('connection', socket => socket.on('message', raw => {
    const frame = JSON.parse(raw.toString()) as { type: string; payload?: Record<string, unknown> }
    if (frame.type === 'machine_select') { socket.send(JSON.stringify({ type: 'connected', payload: {} })); return }
    heard.push(frame.payload?.action ? `${frame.type}:${String(frame.payload.action)}` : frame.type)
    const answer = frame.type === 'super_tabs' && frame.payload?.action === 'buddyCheck' ? { ok: true, buddiesHere: false }
      : frame.type === 'agents_list' ? { agents: [] } : { error: 'UNSUPPORTED' }
    socket.send(JSON.stringify({ type: frame.type, payload: { ...answer, requestId: frame.payload?.requestId } }))
  }))
  cleanup.push(() => new Promise<void>(resolve => { wss.close(); local.server.closeAllConnections?.(); local.server.close(() => resolve()) }))
  return heard
}

it('runs send, new, tell and close only past the Buddy check, and other verbs without it', async () => {
  const root = mkdtempSync('/tmp/hn-buddy-guard-')
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  const heard = await fakeDaemon(dataDir)
  writeFileSync(join(root, 'computer-id'), 'machine-test')
  // A pane the command does not run in: no tmux server answers here, so nothing can prove it, and the check refuses.
  const env = { ...process.env, HOME: root, HARNESS_AUTH_DIR: join(root, 'auth'), ADAPTER_DATA_DIR: dataDir, ADAPTER_CLI_DIR: join(root, 'cli'),
    ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'), ADAPTER_UPDATE_DISABLE: 'true', PORT: String(PORT), TMUX: '', TMUX_TMPDIR: root,
    TMUX_PANE: '%42', DISABLE_GRID_INSTALL: 'true', DISABLE_HOOK_INSTALL: 'true', BACKEND_WS_URL: 'http://127.0.0.1:1' }
  const run = (...args: string[]) => runs.complete(root, [TSX, CLI_SOURCE, ...args], { cwd: CLI_ROOT, env, label: `harness ${args.join(' ')}`, ms: 45_000 })
  for (const argv of [['send', 'Hello'], ['new', 'claude'], ['tell', 'builder', '--', 'work'], ['close', 'builder']]) {
    heard.length = 0
    const { status, stderr } = await run(...argv)
    expect({ argv, status, refused: stderr.includes(REFUSED) }).toEqual({ argv, status: 1, refused: true })
    // The check alone reached the daemon: the verb never ran.
    expect(heard).toEqual(['super_tabs:buddyCheck'])
  }
  heard.length = 0
  const { stderr } = await run('ps')
  expect(stderr).not.toContain(REFUSED)
  expect(heard).not.toContain('super_tabs:buddyCheck')
}, 240_000)
