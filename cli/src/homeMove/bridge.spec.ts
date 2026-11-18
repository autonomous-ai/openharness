/**
 * The bridge (docs/plans/2026-11-18-linux-xdg-paths-design.md, The bridge): after the move ~/.harness holds a link per
 * entry, what a link cannot give an old reader is served there, and it all goes once nothing old is left. The old readers
 * are run for real: the hook script, an agent's MCP shim, and the Store's socket check.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCP_SHIM_SOURCE } from '../lib/connectors/mcpShimSource.js'
import { harnessPaneOwner } from '../lib/harnessSessionLabel.js'
import { hookRouteFile, publishHookRoute } from '../lib/hookRoutes.js'
import { BRIDGE_FILE, isBridge, makeRealFolders, procNow, readBridge, REAL_ENTRIES, removeBridge, serveOldPaths, writeBridge, type BridgeRecord, type Served } from './bridge.js'

vi.mock('node:fs', async (real) => ({ ...await real<object>(), linkSync: vi.fn((await real<typeof import('node:fs')>()).linkSync) }))

const HOOK = fileURLToPath(new URL('../../hook/notify.mjs', import.meta.url))
// The Store's copy of the socket check, another component's file: its path is joined a segment at a time.
const STORE_SOCKETS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'store', 'tools', 'local-daemon.mjs')
const { socketIsPrivate } = await import(pathToFileURL(STORE_SOCKETS).href) as { socketIsPrivate(path: string): boolean }

const PORT = 18473
const SOCKET = `daemon-${PORT}.sock`
/** A folder name that puts a socket beside it past sockaddr_un's room (lib/localSocket.ts, 96 bytes). */
const LONG = 'x'.repeat(60)

const homes: string[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A folder in /tmp, so a socket path under it fits on any machine. */
function shortFolder(): string {
  const folder = realpathSync(mkdtempSync('/tmp/hb-'))
  homes.push(folder)
  return folder
}

const hashed = (folder: string): string => createHash('sha256').update(folder).digest('hex').slice(0, 16)

/** Where a client finds socket [name] of [folder] (lib/localSocket.ts socketPathIn): beside it, or in the state root's short folder. */
const socketOf = (state: string, folder: string, name: string): string =>
  Buffer.byteLength(join(folder, name)) <= 96 ? join(folder, name) : join(state, 's', hashed(folder), name)

/** A server on a 0600 socket, as the daemon and the connections bridge make theirs: it notes each request's path. */
async function listening(path: string, answer: (body: string) => object): Promise<{ heard: string[]; close(): Promise<void> }> {
  const heard: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      heard.push(request.url ?? '')
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer(body)))
    })
  })
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  await new Promise<void>((done) => server.listen(path, done))
  chmodSync(path, 0o600)
  const close = () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) })
  closers.push(close)
  return { heard, close }
}

const toolsAnswer = (body: string) => ({ jsonrpc: '2.0', id: (JSON.parse(body) as { id: number }).id, result: {} })

/** Where an old client looks for the daemon's socket and where it is: both beside the data folder, the old one in a short folder, or the new one. */
type Layout = 'beside' | 'old short' | 'new short'

/**
 * A home the move has just left: the roots under it (XDG_DATA_HOME `<home>/d`, or a long one for 'new short'; XDG_STATE_HOME
 * `<home>/t`), ~/.harness holding a link per entry, the daemon serving its data folder on its socket, and the connections
 * bridge on its own, beside the shim it writes.
 */
async function movedHome(layout: Layout = 'beside') {
  const home = shortFolder(), oldHome = join(home, '.harness')
  const base = join(home, layout === 'new short' ? LONG : 'd'), data = join(base, 'harness'), state = join(home, 't', 'harness')
  mkdirSync(oldHome)
  for (const [name, root] of [['cli', data], ['connections', data], ['hook-routes', state], ['s', state], ['logs', state]]) {
    mkdirSync(join(root, name), { recursive: true, mode: 0o700 })
    symlinkSync(join(root, name), join(oldHome, name))
  }
  const dataName = layout === 'old short' ? LONG : 'data', dataDir = join(data, 'cli', dataName)
  mkdirSync(dataDir, { mode: 0o700 })
  // What the hook proves itself with (notify.mjs readHookCredential).
  writeFileSync(join(dataDir, 'hook-credential'), `${'a'.repeat(43)}\n`, { mode: 0o600 })
  const socket = socketOf(state, dataDir, SOCKET), daemon = await listening(socket, () => ({}))
  const connections = join(data, 'connections'), bridgeSocket = socketOf(state, connections, 'bridge.sock'), shim = join(connections, 'mcp-shim.mjs')
  writeFileSync(shim, MCP_SHIM_SOURCE, { mode: 0o600 })
  const tools = await listening(bridgeSocket, toolsAnswer)
  const bridge: BridgeRecord = {
    version: 1, movedAt: 1_700_001_234.56, oldHome, oldDataDir: join(oldHome, 'cli', dataName),
    oldTag: '0123456789abcdef', newTag: harnessPaneOwner(dataDir), panes: ['%7'],
  }
  const served: Served = {
    routes: { dataDir, port: PORT },
    sockets: [
      { oldFolder: bridge.oldDataDir, folder: dirname(socket), name: SOCKET },
      { oldFolder: join(oldHome, 'connections'), folder: dirname(bridgeSocket), name: 'bridge.sock' },
    ],
    files: [{ from: shim, name: 'mcp-shim.mjs' }],
  }
  const env = { HOME: home, XDG_DATA_HOME: base, XDG_STATE_HOME: join(home, 't') }
  return { home, oldHome, data, state, dataDir, socket, daemon, bridgeSocket, shim, tools, bridge, served, env }
}

type Home = Awaited<ReturnType<typeof movedHome>>

/** The hook as an old session runs it, with its command's own [args]: in a pane carrying [pane]'s tag when given. */
function oldHook(home: Home, args: string[], pane?: { tag: string; routes: string }): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...home.env, ADAPTER_DATA_DIR: '', HARNESS_HOOK_ROUTES_DIR: pane?.routes ?? '',
    // Room for the hook's optional work on a loaded machine, as hookNotify.spec.ts gives it.
    HARNESS_HOOK_DEADLINE_MS: '30000', TMUX_TMPDIR: home.home,
  }
  for (const name of ['TMUX', 'TMUX_PANE', 'HARNESS_PANE', 'HERDR_SESSION', 'HC_SESSION']) delete env[name]
  if (pane) {
    // tmux as it describes the pane: its process, its session, and the tag the move gave it.
    const bin = join(home.home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' '7000|harness-claude-1790000000000|${pane.tag}'\n`, { mode: 0o755 })
    env.PATH = `${bin}:${env.PATH ?? ''}`
    env.TMUX_PANE = '%7'
  }
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env, stdio: ['pipe', 'ignore', 'inherit'] })
    child.on('error', fail)
    child.on('close', (code) => code === 0 ? done() : fail(new Error(`notify.mjs exited ${code}`)))
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'session-old', reason: 'logout' }))
  })
}

/** An old agent's MCP shim, run from where its client's entry names it: its answers to one initialize. */
function oldShim(script: string, socket: string): Promise<unknown[]> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [script, '--socket', socket, 'linear'])
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', fail)
    child.on('close', () => done(out.split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown)))
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
  })
}

/** Every file's bytes and every link's target under [roots]: what removing the bridge must leave as it was. */
function contents(...roots: string[]): Record<string, string> {
  const found: Record<string, string> = {}
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name), entry = lstatSync(path)
      if (entry.isSymbolicLink()) found[path] = `-> ${readlinkSync(path)}`
      else if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) found[path] = readFileSync(path, 'utf8')
    }
  }
  for (const root of roots) walk(root)
  return found
}

describe('the bridge\'s layout', () => {
  it('the two real folders replace their links, owner-only', async () => {
    const home = await movedHome()
    writeFileSync(join(home.state, 'hook-routes', '0123456789abcdef.json'), '{}')
    makeRealFolders(home.oldHome)
    for (const name of REAL_ENTRIES) {
      const entry = lstatSync(join(home.oldHome, name))
      expect(entry.isDirectory(), name).toBe(true)
      expect(entry.mode & 0o777, name).toBe(0o700)
      expect(readdirSync(join(home.oldHome, name)), name).toEqual([])
    }
    // What the links pointed to is where it was.
    expect(readFileSync(join(home.state, 'hook-routes', '0123456789abcdef.json'), 'utf8')).toBe('{}')
    expect(readdirSync(join(home.data, 'connections')).sort()).toEqual(['bridge.sock', 'mcp-shim.mjs'])
  })

  it('the route record is the daemon\'s, under its new tag, and the hook script accepts it', async () => {
    const home = await movedHome()
    makeRealFolders(home.oldHome)
    expect(serveOldPaths(home.bridge, home.served, publishHookRoute)).toEqual([])
    const routes = join(home.oldHome, 'hook-routes')
    expect(JSON.parse(readFileSync(hookRouteFile(home.bridge.newTag, routes), 'utf8'))).toEqual({ dataDir: home.dataDir, port: PORT })
    // The old session's command names a port nothing serves: only the record takes its hook to the daemon.
    await oldHook(home, ['--port', '9', '--data-dir', home.bridge.oldDataDir], { tag: home.bridge.newTag, routes })
    expect(home.daemon.heard).toEqual(['/api/hook/session-end'])
  })

  describe('an old client\'s socket path gets a hard link when it is not where the socket is', () => {
    it('both paths beside the data folder: nothing to do', async () => {
      const home = await movedHome('beside')
      makeRealFolders(home.oldHome)
      expect(serveOldPaths(home.bridge, home.served, publishHookRoute)).toEqual([])
      expect(lstatSync(home.socket).nlink).toBe(1)
      expect(readdirSync(home.dataDir).sort()).toEqual([SOCKET, 'hook-credential'])
    })

    it.each([
      ['the old one in a short folder: a link in the state root\'s short folder of the old one', 'old short'],
      ['the old one beside and the new one short: a link beside the data folder', 'new short'],
    ] as const)('%s', async (_, layout) => {
      const home = await movedHome(layout)
      makeRealFolders(home.oldHome)
      const link = layout === 'old short' ? join(home.state, 's', hashed(home.bridge.oldDataDir), SOCKET) : join(home.dataDir, SOCKET)
      expect(serveOldPaths(home.bridge, home.served, publishHookRoute)).toEqual([])
      expect(statSync(link).ino).toBe(statSync(home.socket).ino)
      expect(statSync(dirname(link)).mode & 0o777).toBe(0o700)
      // The checks an old client makes before it sends anything: the Store's here, and the hook's (notify.mjs privateSocket) by its run.
      expect(socketIsPrivate(link)).toBe(true)
      await oldHook(home, ['--port', String(PORT), '--data-dir', home.bridge.oldDataDir])
      expect(home.daemon.heard).toEqual(['/api/hook/session-end'])
    })
  })

  it('connections holds hard links to bridge.sock and mcp-shim.mjs, and an old agent\'s shim takes the socket for private', async () => {
    const home = await movedHome()
    makeRealFolders(home.oldHome)
    expect(serveOldPaths(home.bridge, home.served, publishHookRoute)).toEqual([])
    const old = join(home.oldHome, 'connections')
    expect(statSync(join(old, 'bridge.sock')).ino).toBe(statSync(home.bridgeSocket).ino)
    expect(statSync(join(old, 'mcp-shim.mjs')).ino).toBe(statSync(home.shim).ino)
    expect(await oldShim(join(old, 'mcp-shim.mjs'), join(old, 'bridge.sock'))).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])
  })

  it('a link is made again when the socket is a new one', async () => {
    const home = await movedHome()
    makeRealFolders(home.oldHome)
    serveOldPaths(home.bridge, home.served, publishHookRoute)
    // The connections bridge started again: a new socket, and the shim written anew beside it.
    await home.tools.close()
    rmSync(home.bridgeSocket, { force: true })
    await listening(home.bridgeSocket, toolsAnswer)
    writeFileSync(`${home.shim}.tmp`, MCP_SHIM_SOURCE, { mode: 0o600 })
    renameSync(`${home.shim}.tmp`, home.shim)
    expect(serveOldPaths(home.bridge, home.served, publishHookRoute)).toEqual([])
    const old = join(home.oldHome, 'connections')
    expect(statSync(join(old, 'bridge.sock')).ino).toBe(statSync(home.bridgeSocket).ino)
    expect(statSync(join(old, 'mcp-shim.mjs')).ino).toBe(statSync(home.shim).ino)
  })

  it('a link across filesystems is not made, and is named in what comes back', async () => {
    const home = await movedHome()
    makeRealFolders(home.oldHome)
    vi.mocked(linkSync).mockImplementationOnce(() => { throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }) })
    expect(serveOldPaths(home.bridge, home.served, publishHookRoute)).toEqual(['bridge.sock'])
    expect(readdirSync(join(home.oldHome, 'connections'))).toEqual(['mcp-shim.mjs'])
  })

  it.each(['beside', 'old short', 'new short'] as const)('removing the bridge removes links without following them (%s)', async (layout) => {
    const home = await movedHome(layout)
    makeRealFolders(home.oldHome)
    writeFileSync(join(home.dataDir, 'registry.json'), '[]')
    writeFileSync(join(home.state, 'logs', 'harness.log'), 'started\n')
    expect(serveOldPaths(home.bridge, home.served, publishHookRoute)).toEqual([])
    const before = contents(home.data, home.state)
    expect(removeBridge(home.bridge, home.state)).toBe('removed')
    expect(existsSync(home.oldHome)).toBe(false)
    expect(contents(home.data, home.state)).toEqual(before)
    // Every hard link it made is gone: each socket and the shim has one name again.
    for (const path of [home.socket, home.bridgeSocket, home.shim]) expect(lstatSync(path).nlink, path).toBe(1)
    expect(existsSync(join(home.state, 's', hashed(home.bridge.oldDataDir)))).toBe(false)
  })

  it('something that is not the bridge\'s stays, and the answer is left', async () => {
    const home = await movedHome()
    makeRealFolders(home.oldHome)
    serveOldPaths(home.bridge, home.served, publishHookRoute)
    writeFileSync(join(home.oldHome, 'notes.txt'), 'mine')
    expect(removeBridge(home.bridge, home.state)).toBe('left')
    expect(readdirSync(home.oldHome)).toEqual(['notes.txt'])
    expect(readFileSync(join(home.oldHome, 'notes.txt'), 'utf8')).toBe('mine')
  })

  it('isBridge: only links and the real folders', async () => {
    const home = await movedHome()
    makeRealFolders(home.oldHome)
    expect(isBridge(home.oldHome)).toBe(true)
    mkdirSync(join(home.oldHome, 'tui'))
    expect(isBridge(home.oldHome)).toBe(false)
    expect(isBridge(shortFolder())).toBe(false)
  })
})

describe('the bridge\'s record', () => {
  it('is read back as it was written, owner only; none without one', () => {
    const state = shortFolder()
    expect(readBridge(state)).toBeNull()
    const record: BridgeRecord = {
      version: 1, movedAt: 1_700_001_234.56, oldHome: '/h/.harness', oldDataDir: '/h/.harness/cli/data',
      oldTag: '0123456789abcdef', newTag: 'fedcba9876543210', panes: ['%1', '%2'],
    }
    writeBridge(state, record)
    expect(readBridge(state)).toEqual(record)
    expect(statSync(join(state, BRIDGE_FILE)).mode & 0o777).toBe(0o600)
    expect(readdirSync(state)).toEqual([BRIDGE_FILE])
  })

  it('the move\'s time is btime of /proc/stat plus /proc/uptime, the clock /proc start times use', () => {
    const proc: Record<string, string> = { '/proc/stat': 'cpu  1 2 3\nbtime 1700000000\nprocesses 9\n', '/proc/uptime': '1234.56 999.00\n' }
    expect(procNow((path) => proc[path])).toBeCloseTo(1_700_001_234.56)
    expect(() => procNow((path) => path === '/proc/stat' ? 'cpu  1 2 3\n' : proc[path])).toThrow()
  })
})
