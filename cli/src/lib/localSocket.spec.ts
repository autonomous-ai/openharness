import { request } from 'node:http'
import { connect } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isLocalSocketName, isTrustedLocal, listenLocalSocket, localSocketName, localSocketPath, type LocalSocketServer } from './localSocket.js'

const LOCAL_SOCKET_NAME = localSocketName(18473)

// Socket paths are capped near 104 bytes; the test tmpdir on macOS is far longer.
const dirs: string[] = []
const opened: LocalSocketServer[] = []
function shortDir(): string {
  const dir = mkdtempSync('/tmp/hsock-')
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const socket of opened.splice(0)) await socket.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function get(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ socketPath, path }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    r.on('error', reject)
    r.end()
  })
}

describe('localSocketPath', () => {
  it('names one socket per control port, and none on Windows or past the length limit', () => {
    expect(localSocketPath('/Users/me/.harness/cli/data', 18473, 'darwin')).toBe('/Users/me/.harness/cli/data/daemon-18473.sock')
    expect(localSocketPath('/home/me/.harness/cli/data', 18474, 'linux')).toBe('/home/me/.harness/cli/data/daemon-18474.sock')
    expect(localSocketPath('C:\\Users\\me\\.harness', 18473, 'win32')).toBeNull()
    expect(localSocketPath(`/tmp/${'x'.repeat(100)}`, 18473, 'darwin')).toBeNull()
    // 96 bytes fits (the staging name adds 4, still under macOS's 104 with the terminator); 97 does not.
    const dirFor = (total: number) => `/${'d'.repeat(total - '/daemon-18473.sock'.length - 1)}`
    expect(localSocketPath(dirFor(96), 18473, 'darwin')).toHaveLength(96)
    expect(localSocketPath(dirFor(97), 18473, 'darwin')).toBeNull()
    expect(isLocalSocketName('daemon-18473.sock')).toBe(true)
    expect(isLocalSocketName('daemon.sock')).toBe(false)
    expect(isLocalSocketName('daemon-18473.sock.bak')).toBe(false)
  })
})

describe('listenLocalSocket', () => {
  it('serves over a socket only its owner can open, and trusts exactly those requests', async () => {
    const path = join(shortDir(), LOCAL_SOCKET_NAME)
    let trusted: boolean | null = null
    const socket = await listenLocalSocket((req, res) => { trusted = isTrustedLocal(req); res.end('hi') }, path)
    opened.push(socket)

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(await get(path, '/')).toEqual({ status: 200, body: 'hi' })
    expect(trusted).toBe(true)
    expect(isTrustedLocal(undefined)).toBe(false)
  })

  it('replaces a crashed daemon\'s socket file, and refuses to replace anything else', async () => {
    const dir = shortDir()
    const path = join(dir, LOCAL_SOCKET_NAME)
    // A socket file nobody listens on any more: what a crash leaves.
    const first = await listenLocalSocket((_req, res) => res.end('old'), path)
    first.server.close()
    const second = await listenLocalSocket((_req, res) => res.end('new'), path)
    opened.push(second)
    expect((await get(path, '/')).body).toBe('new')

    const notASocket = join(dir, 'plain')
    writeFileSync(notASocket, 'keep me')
    await expect(listenLocalSocket((_req, res) => res.end(), notASocket)).rejects.toThrow(/not a socket/)
    expect(existsSync(notASocket)).toBe(true)
  })

  it('gives daemons on different ports a socket each, in one data directory', async () => {
    // Each port has its own name, so a second daemon never touches the first one's socket and a
    // client that knows its port reaches the daemon on that port.
    const dir = shortDir()
    const first = await listenLocalSocket((_req, res) => res.end('18473'), localSocketPath(dir, 18473, 'darwin')!)
    const second = await listenLocalSocket((_req, res) => res.end('18474'), localSocketPath(dir, 18474, 'darwin')!)
    opened.push(first, second)
    expect((await get(first.path, '/')).body).toBe('18473')
    expect((await get(second.path, '/')).body).toBe('18474')
  })

  it('closes at once even while a peer holds an upgraded connection open', async () => {
    // What a restart-for-update meets: a WebSocket the app has not finished closing. Waiting on
    // `server.close`'s callback would hang the restart until that peer let go.
    const path = join(shortDir(), LOCAL_SOCKET_NAME)
    const socket = await listenLocalSocket((_req, res) => res.end(), path)
    const held: Array<import('node:net').Socket> = []
    socket.server.on('upgrade', (_req, raw) => {
      held.push(raw as import('node:net').Socket)
      raw.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n')
    })
    const client = connect(path)
    await new Promise<void>((resolve) => client.once('connect', () => resolve()))
    client.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n')
    await new Promise<void>((resolve) => client.once('data', () => resolve()))

    const closed = await Promise.race([
      socket.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ])
    expect(closed).toBe('closed')
    expect(existsSync(path)).toBe(false)
    client.destroy()
    for (const raw of held) raw.destroy()
  })

  it('listens at the longest path it allows', async () => {
    const dir = shortDir()
    const padded = join(dir, 'p'.repeat(96 - dir.length - 1 - '/daemon-1.sock'.length))
    mkdirSync(padded)
    const path = localSocketPath(padded, 1, 'darwin')!
    expect(Buffer.byteLength(path)).toBe(96)
    const socket = await listenLocalSocket((_req, res) => res.end('long'), path)
    opened.push(socket)
    expect((await get(path, '/')).body).toBe('long')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('removes the socket file when it closes', async () => {
    const path = join(shortDir(), LOCAL_SOCKET_NAME)
    const socket = await listenLocalSocket((_req, res) => res.end(), path)
    await socket.close()
    expect(existsSync(path)).toBe(false)
    await expect(new Promise((resolve, reject) => {
      const c = connect(path, () => { c.end(); resolve(true) })
      c.on('error', reject)
    })).rejects.toThrow()

    const again = await listenLocalSocket((_req, res) => res.end(), path)
    again.closeSync()
    expect(existsSync(path)).toBe(false)
  })
})
