import { request } from 'node:http'
import { connect } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  askDataFolderServer, isLocalSocketName, isTrustedLocal, listenLocalSocket, localSocketName, localSocketPath, ORPHAN_STILL_SERVING, ORPHAN_WAIT_MS,
  refuseServedDataFolder, type DataFolderServer, type LocalSocketServer, type ServedFolderDeps,
} from './localSocket.js'

const LOCAL_SOCKET_NAME = localSocketName(18473)

/** A filesystem without hard links, when a test says so. */
const fsState = vi.hoisted(() => ({ noLinks: false }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    linkSync: (...args: Parameters<typeof real.linkSync>) => {
      if (fsState.noLinks) throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' })
      return real.linkSync(...args)
    },
  }
})

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

  it('gives the socket to one of two daemons claiming it at once, and refuses the other', async () => {
    // Two masters racing (e2e/twodaemons.e2e.ts): both used to "claim" it, the second's socket replacing
    // the first's, which went on listening where nothing could reach it.
    for (let round = 0; round < 10; round++) {
      const path = join(shortDir(), LOCAL_SOCKET_NAME)
      const claims = await Promise.allSettled([
        listenLocalSocket((_req, res) => res.end('first'), path),
        listenLocalSocket((_req, res) => res.end('second'), path),
      ])
      const won = claims.flatMap((claim, i) => claim.status === 'fulfilled' ? [{ socket: claim.value, body: i ? 'second' : 'first' }] : [])
      const lost = claims.flatMap((claim) => claim.status === 'rejected' ? [claim.reason as NodeJS.ErrnoException] : [])
      expect(won).toHaveLength(1)
      opened.push(won[0]!.socket)
      expect(lost).toMatchObject([{ code: 'EADDRINUSE', message: `A Harness daemon is already serving ${path}` }])
      expect((await get(path, '/')).body).toBe(won[0]!.body)
      // Nothing staged is left behind.
      expect(readdirSync(join(path, '..'))).toEqual([LOCAL_SOCKET_NAME])
    }
  })

  it('takes its name the way it always did where the filesystem has no hard links', async () => {
    fsState.noLinks = true
    try {
      const path = join(shortDir(), LOCAL_SOCKET_NAME)
      const socket = await listenLocalSocket((_req, res) => res.end('renamed'), path)
      opened.push(socket)
      expect((await get(path, '/')).body).toBe('renamed')
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(readdirSync(join(path, '..'))).toEqual([LOCAL_SOCKET_NAME])
    } finally {
      fsState.noLinks = false
    }
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

describe('refuseServedDataFolder', () => {
  /** A daemon's answer to `GET /api/status`, as `harness start` gives it. */
  const status = (pid: number, corePid?: number) => (_req: unknown, res: { end(body: string): void }) =>
    res.end(JSON.stringify({ pid, ...(corePid === undefined ? {} : { corePid }) }))

  it('refuses only a data folder a daemon is serving right now, as the bind would', async () => {
    const dir = shortDir()
    const path = join(dir, LOCAL_SOCKET_NAME)
    // No socket at all, a crashed daemon's, a file that is not one, and no path where there is none.
    await expect(refuseServedDataFolder(path)).resolves.toBeUndefined()
    const crashed = await listenLocalSocket((_req, res) => res.end(), path)
    crashed.server.close()
    await expect(refuseServedDataFolder(path)).resolves.toBeUndefined()
    await expect(refuseServedDataFolder(null)).resolves.toBeUndefined()
    const plain = join(dir, 'plain')
    writeFileSync(plain, 'not a socket')
    await expect(refuseServedDataFolder(plain)).resolves.toBeUndefined()

    // A daemon with no master, and one whose master is this live process: refused at once.
    for (const answer of [status(process.pid), status(process.pid, process.ppid)]) {
      const running = await listenLocalSocket(answer as never, path)
      const startedAt = Date.now()
      const refused = await refuseServedDataFolder(path).catch((error: unknown) => error as NodeJS.ErrnoException)
      expect(refused).toMatchObject({ code: 'EADDRINUSE', message: `A Harness daemon is already serving ${path}` })
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      await running.close()
    }
  })

  it('waits for the core of a master that is gone to leave, and starts once it has', async () => {
    // Under launchd or systemd a master that died is started again at once, while its old core still
    // serves until it notices. Refused, the new core exited for good and the daemon stayed down.
    const path = join(shortDir(), LOCAL_SOCKET_NAME)
    const orphan = await listenLocalSocket(status(2_000_000_000, process.pid) as never, path)
    const lines: string[] = []
    setTimeout(() => void orphan.close(), 600)
    await expect(refuseServedDataFolder(path, 1_000, {
      who: askDataFolderServer, alive: () => false, sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: () => performance.now(), log: (line) => lines.push(line),
    })).resolves.toBeUndefined()
    expect(lines).toEqual([
      `[cli] this data folder is still served by the core (pid ${process.pid}) of a master that is gone (pid 2000000000) — waiting for it to leave`,
      '[cli] the core whose master is gone has left — starting',
    ])
  })

  it('reads who serves: a daemon and its master, one from before harnessd as its own, and anything else as unknown', async () => {
    const path = join(shortDir(), LOCAL_SOCKET_NAME)
    expect(await askDataFolderServer(path, 500)).toBe('none')
    const answers: Array<[unknown, DataFolderServer]> = [
      [status(10, 20), { pid: 10, corePid: 20 }],
      [status(10), { pid: 10, corePid: 10 }],
      [status(0, 20), 'unknown'],
      [(_req: unknown, res: { end(body: string): void }) => res.end('not json'), 'unknown'],
    ]
    for (const [handler, expected] of answers) {
      const server = await listenLocalSocket(handler as never, path)
      expect(await askDataFolderServer(path, 500)).toEqual(expected)
      await server.close()
    }
    // One that takes the connection and never answers.
    const silent = await listenLocalSocket(() => {}, path)
    expect(await askDataFolderServer(path, 200)).toBe('unknown')
    await silent.close()
  })

  it('decides from who serves: waits on an orphan or a silence until it goes or the wait is over, refuses a live daemon at once', async () => {
    const run = async (answers: DataFolderServer[], alive: (pid: number) => boolean = () => false) => {
      let clock = 0
      const lines: string[] = []
      const deps: ServedFolderDeps = {
        who: async () => answers.length > 1 ? answers.shift()! : answers[0], alive,
        sleep: async (ms) => { clock += ms }, now: () => clock, log: (line) => lines.push(line),
      }
      const outcome = await refuseServedDataFolder('/data/daemon-1.sock', 1_000, deps).then(() => 'started', (error: NodeJS.ErrnoException) => error.code)
      return { outcome, waited: clock, lines }
    }
    expect(await run(['none'])).toEqual({ outcome: 'started', waited: 0, lines: [] })
    expect(await run([{ pid: 7, corePid: 8 }, { pid: 7, corePid: 8 }, 'none'])).toMatchObject({ outcome: 'started', waited: 500 })
    // A daemon that does not say who it is is busy or hung, not leaving: every release with this socket
    // says its pid. Refused at once, as before: a person waiting on a start never waits out the bound
    // for it (the fake daemon of cliCommand.spec.ts answered without a pid, and each start took 20 s).
    expect(await run(['unknown', 'none'])).toMatchObject({ outcome: 'EADDRINUSE', waited: 0, lines: [] })
    // The orphan itself may go quiet while it stops, once it has been seen to be one.
    const stopping = await run([{ pid: 7, corePid: 8 }, 'unknown', 'none'])
    expect(stopping).toMatchObject({ outcome: 'started', waited: 500 })
    expect(stopping.lines).toEqual([
      '[cli] this data folder is still served by the core (pid 8) of a master that is gone (pid 7) — waiting for it to leave',
      '[cli] the core whose master is gone has left — starting',
    ])
    // Its master alive, or no master at all: another daemon.
    expect(await run([{ pid: 7, corePid: 8 }], () => true)).toMatchObject({ outcome: 'EADDRINUSE', waited: 0 })
    expect(await run([{ pid: 8, corePid: 8 }])).toMatchObject({ outcome: 'EADDRINUSE', waited: 0 })
    // One that never leaves is refused once the wait is over.
    // Refused as the orphan it is, which its master starts again, never as another daemon (an exit for good).
    const lingering = await run([{ pid: 7, corePid: 8 }])
    expect(lingering).toMatchObject({ outcome: ORPHAN_STILL_SERVING, waited: ORPHAN_WAIT_MS })
    expect(lingering.lines).toHaveLength(1)
  })
})
