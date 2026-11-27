/**
 * `harness logout`, `harness reset` and `harness remote-password clear` when the secret's file cannot be deleted. 11-27:
 * both deletes swallowed every failure (an antivirus holding the file open on Windows: EBUSY), the person was told the
 * secret was gone, and the next start loaded it again.
 *
 * Process-boundary tests, in the shape of loginForceRace.spec.ts: the real command under a throwaway HOME. A folder
 * made read-only is the failure a test can make for real (EACCES), so they run where modes hold: not on Windows, and
 * not as root. The retries a held file gets are lib/deleteSecretFile.spec.ts's.
 */
import { spawn, type ChildProcess } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, type RequestListener, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'
import { b64e, newIdentity } from './lib/e2ee/core.js'
import { listenLocalSocket, localSocketPath } from './lib/localSocket.js'

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_SOURCE = join(CLI_ROOT, 'src', 'cli.ts')
const TSX = join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
/** Nothing listens on port 1, so no command here can reach this machine's real daemon. */
const CONTROL_PORT = 1
const dirs: string[] = []
const servers: Server[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const dir of dirs.splice(0)) {
    for (const locked of ['auth', join('data', 'e2e')]) if (existsSync(join(dir, locked))) chmodSync(join(dir, locked), 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hn-secret-delete-'))
  dirs.push(root)
  return root
}

/** [folder] read-only: nothing in it can be deleted (EACCES). */
const lock = (folder: string): void => chmodSync(folder, 0o500)

async function run(root: string, args: string[], backendBase = 'http://127.0.0.1:9'): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [TSX, CLI_SOURCE, ...args], {
    cwd: CLI_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: root,
      HARNESS_AUTH_DIR: join(root, 'auth'),
      ADAPTER_DATA_DIR: join(root, 'data'),
      ADAPTER_CLI_DIR: join(root, 'cli'),
      ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
      ADAPTER_UPDATE_DISABLE: 'true',
      BACKEND_WS_URL: backendBase,
      PORT: String(CONTROL_PORT),
      TMUX: undefined,
      TMUX_PANE: undefined,
      TMUX_TMPDIR: root,
      // No `grid` to sign out: none of this machine's runs.
      DISABLE_GRID_INSTALL: 'true',
      HARNESS_GRID_BIN: join(root, 'no-grid'),
    },
  })
  children.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const status = await new Promise<number | null>((resolve) => child.once('close', resolve))
  return { status, stdout, stderr }
}

/** A daemon's private socket in the data folder, answered by [handler]; a daemon booting there leaves at once beside it. */
async function serveDataFolder(root: string, handler: RequestListener): Promise<void> {
  const dir = join(root, 'data')
  mkdirSync(dir, { recursive: true })
  const path = localSocketPath(dir, CONTROL_PORT)
  if (!path?.startsWith(dir)) throw new Error(`the data folder's socket is not beside it: ${path}`)
  servers.push((await listenLocalSocket(handler, path)).server)
}

/** A running daemon as a stop sees one: a live process the pid file names, which idles until it is stopped. */
function idleDaemon(root: string): void {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
  children.push(child)
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'data', 'adapter.pid'), `${child.pid}\n`)
}

/** The backend, every path it is called on kept. */
function fakeBackend(): Promise<{ base: string; paths: string[] }> {
  const paths: string[] = []
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        paths.push(req.url ?? '')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: {} }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths }))
  })
}

function seedSignIn(root: string): string {
  const file = join(root, 'auth', 'session.json')
  mkdirSync(join(root, 'auth'), { recursive: true })
  writeFileSync(file, JSON.stringify({
    version: 1, accessToken: 'tok', refreshToken: 'hnr_test', expiresAt: Date.now() + 3_600_000,
    autonomousEnv: 'prod', computerId: 'a'.repeat(32), machineId: 'b'.repeat(32), updatedAt: Date.now(),
  }), { mode: 0o600 })
  return file
}

function seedRemotePassword(root: string): string {
  const dir = join(root, 'data', 'e2e')
  mkdirSync(dir, { recursive: true })
  const identity = newIdentity()
  writeFileSync(join(dir, 'identity.json'), JSON.stringify({ priv: b64e(identity.priv), pub: b64e(identity.pub) }), { mode: 0o600 })
  const file = join(dir, 'remotePassword.json')
  writeFileSync(file, JSON.stringify({ v: 1, stretched: b64e(new Uint8Array(32).fill(7)), setAt: 1, recentFailures: [] }), { mode: 0o600 })
  return file
}

const modesHold = process.platform !== 'win32' && process.getuid?.() !== 0

describe.skipIf(process.platform === 'win32')('a secret file the command cannot delete', () => {
  it('remote-password clear: the daemon could not delete it, so nothing deletes it behind the daemon, and it says so', async () => {
    const root = tempRoot()
    const file = seedRemotePassword(root)
    await serveDataFolder(root, (req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/remote-password/clear') { res.statusCode = 500; res.end(JSON.stringify({ error: 'REMOTE_PASSWORD_NOT_DELETED (EBUSY)' })); return }
      res.end(JSON.stringify({ version: '0.0.0-test', pid: process.pid, corePid: process.pid }))
    })

    const json = await run(root, ['remote-password', 'clear', '--json'])
    expect(json.status).toBe(1)
    expect(JSON.parse(json.stdout)).toEqual({ ok: false, error: 'REMOTE_PASSWORD_NOT_DELETED (EBUSY)' })
    // The daemon still holds the password in memory: a delete here would only hide it until its next start.
    expect(existsSync(file)).toBe(true)

    const said = await run(root, ['remote-password', 'clear'])
    expect(said.status).toBe(1)
    expect(said.stderr).toContain('✗')
    expect(said.stderr).toContain('REMOTE_PASSWORD_NOT_DELETED (EBUSY)')
    expect(said.stdout).not.toContain('cleared')
    expect(existsSync(file)).toBe(true)
  })

  it.skipIf(!modesHold)('remote-password clear with no daemon: the file it cannot delete is said the same way', async () => {
    const root = tempRoot()
    const file = seedRemotePassword(root)
    lock(join(root, 'data', 'e2e'))

    const json = await run(root, ['remote-password', 'clear', '--json'])
    expect(json.status).toBe(1)
    expect(JSON.parse(json.stdout)).toEqual({ ok: false, error: 'REMOTE_PASSWORD_NOT_DELETED (EACCES)' })
    expect(existsSync(file)).toBe(true)
  })

  it.skipIf(!modesHold)('logout: the sign-in still here is said, the server still ends it, and the daemon is not started again', async () => {
    const root = tempRoot()
    const file = seedSignIn(root)
    idleDaemon(root)
    await serveDataFolder(root, (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ version: '0.0.0-test', pid: process.pid, corePid: process.pid }))
    })
    const backend = await fakeBackend()
    lock(join(root, 'auth'))

    const out = await run(root, ['logout', '--from-sign-out-button'], backend.base)

    expect(out.status).toBe(1)
    expect(out.stderr).toContain('✗')
    expect(out.stderr).toContain('SIGN_IN_NOT_DELETED (EACCES)')
    expect(out.stderr).toContain('harness logout')
    expect(out.stderr).not.toContain(root)
    expect(out.stdout).not.toContain('Signed out')
    expect(out.stderr).not.toContain('Failed to start adapter')
    expect(backend.paths).toContain('/api/auth/revoke')
    expect(existsSync(file)).toBe(true)
  })

  it.skipIf(!modesHold)('reset: the sign-in still here is said, and the server still ends it', async () => {
    const root = tempRoot()
    const file = seedSignIn(root)
    const backend = await fakeBackend()
    lock(join(root, 'auth'))

    const out = await run(root, ['reset', '--from-sign-out-button'], backend.base)

    expect(out.status).toBe(1)
    expect(out.stderr).toContain('SIGN_IN_NOT_DELETED (EACCES)')
    expect(out.stderr).toContain('harness reset')
    expect(out.stdout).not.toContain('Start again with')
    expect(backend.paths).toContain('/api/auth/revoke')
    expect(existsSync(file)).toBe(true)
  })

  it.skipIf(!modesHold)('reset: state it cannot delete is said in a word, and the sign-in is still removed and ended', async () => {
    const root = tempRoot()
    const signIn = seedSignIn(root)
    const password = seedRemotePassword(root)
    const backend = await fakeBackend()
    lock(join(root, 'data', 'e2e'))

    const out = await run(root, ['reset', '--from-sign-out-button'], backend.base)

    expect(out.status).toBe(1)
    expect(out.stderr).toContain('✗')
    // A recursive delete says what it met at the top: ENOTEMPTY on macOS, EACCES elsewhere.
    expect(out.stderr).toMatch(/STATE_NOT_DELETED \((EACCES|ENOTEMPTY)\)/)
    expect(out.stderr).toContain('harness reset')
    expect(out.stderr).not.toContain(root)
    expect(out.stderr).not.toContain('Failed to start adapter')
    expect(out.stdout).not.toContain('Cleared local machine CLI state')
    expect(out.stdout).not.toContain('Start again with')
    expect(backend.paths).toContain('/api/auth/revoke')
    expect(existsSync(signIn)).toBe(false)
    expect(existsSync(password)).toBe(true)
  })
})
