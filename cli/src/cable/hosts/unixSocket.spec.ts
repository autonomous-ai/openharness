import { lstatSync, rmSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectLines, socketStampOf, watchSocket, type LineEnd } from './unixSocket.js'

// Each watch as it is, recorded, so a spec can make one fail.
vi.mock('node:fs', async (real) => {
  const fs = await real<typeof import('node:fs')>()
  return { ...fs, watch: vi.fn(fs.watch) }
})

/** A server of the spec's own on a socket in a temp folder: what each connection wrote, and the next one it takes. */
async function serve(path: string) {
  const server = createServer()
  const written: string[] = []
  server.on('connection', (socket) => {
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { written.push(chunk) })
  })
  await new Promise<void>((resolve) => server.listen(path, () => resolve()))
  const next = async () => (await once(server, 'connection'))[0] as Socket
  return { server, written, next }
}

const stop = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

/** One connection's lines and its end, and `told(n)` once n lines have come. The caller destroys the socket at its end,
 *  as both clients do. */
function lines(path: string, out: string, maxLineBytes: number) {
  const told: string[] = []
  const waits: Array<{ n: number; resolve(): void }> = []
  let socket: Socket | undefined
  const ended = new Promise<LineEnd>((resolve) => {
    socket = connectLines(path, out, maxLineBytes, (text) => {
      told.push(text)
      for (const wait of waits.filter(({ n }) => told.length >= n)) wait.resolve()
    }, (fault) => {
      socket?.destroy()
      resolve(fault)
    })
  })
  const toldN = (n: number) => new Promise<void>((resolve) => {
    if (told.length >= n) resolve()
    else waits.push({ n, resolve })
  })
  return { told, toldN, ended }
}

/** Makes a change once every watch started so far is live, then waits until `count` grows. On macOS fs.watch starts its
 *  stream on another thread, one stream for every folder the process watches (libuv's FSEvents), so a change made at
 *  once can go untold: a watch started after, once it has told of a change of its own, says the stream holds the rest. */
async function toldOf(count: () => number, change: () => Promise<unknown>): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'ws-'))
  let live = false
  const sentinel = watch(folder, () => { live = true })
  try {
    let n = 0
    await vi.waitFor(async () => {
      await mkdir(join(folder, String(n++)))
      expect(live).toBe(true)
    }, { timeout: 10_000 })
    const before = count()
    await change()
    await vi.waitFor(() => expect(count()).toBeGreaterThan(before), { timeout: 10_000 })
  } finally {
    sentinel.close()
  }
}

describe.skipIf(process.platform === 'win32')('another program\'s Unix socket', () => {
  let path: string
  let served: Awaited<ReturnType<typeof serve>>

  beforeEach(async () => {
    path = join(await mkdtemp(join(tmpdir(), 'us-')), 'program.sock')
    served = await serve(path)
  })
  afterEach(async () => {
    if (served.server.listening) await stop(served.server)
  })

  it('writes out once connected, and tells each line in order; a line split across two chunks is told once', async () => {
    const accepted = served.next()
    const { told, toldN } = lines(path, 'hello\n', 64)
    const peer = await accepted
    await vi.waitFor(() => expect(served.written.join('')).toBe('hello\n'))
    peer.write('first\nsec')
    // A chunk has been read once its whole lines are told, so the rest of its split line comes in a chunk of its own.
    await toldN(1)
    peer.write('ond\nthird\n')
    await toldN(3)
    expect(told).toEqual(['first', 'second', 'third'])
    peer.destroy()
  })

  it('a line of the bound it was given is told; one byte more ends oversize, before its newline comes', async () => {
    const accepted = served.next()
    const { told, toldN, ended } = lines(path, '', 16)
    const peer = await accepted
    peer.write(`${'x'.repeat(16)}\n`)
    await toldN(1)
    expect(told).toEqual(['x'.repeat(16)])
    peer.write('y'.repeat(17))
    expect(await ended).toBe('oversize')
    expect(told).toEqual(['x'.repeat(16)])
  })

  it('a connection that never opened ends refused; one the server closed ends ended', async () => {
    const accepted = served.next()
    const { ended } = lines(path, '', 64)
    ;(await accepted).end()
    expect(await ended).toBe('ended')
    await stop(served.server)
    expect(await lines(path, '', 64).ended).toBe('refused')
  })

  it('socketStampOf is none for no file, a file that is no socket and another user\'s socket; another once a server starts again at the same path', async () => {
    const uid = process.getuid!()
    const stamp = socketStampOf(path, uid)
    expect(stamp).toEqual(expect.any(String))
    expect(socketStampOf(path, uid)).toBe(stamp)
    expect(socketStampOf(path, uid + 1)).toBeUndefined()
    const file = join(path, '..', 'file.sock')
    await writeFile(file, '')
    expect(socketStampOf(file, uid)).toBeUndefined()

    await stop(served.server)
    expect(socketStampOf(path, uid)).toBeUndefined()
    served = await serve(path)
    const again = socketStampOf(path, uid)
    expect(again).toEqual(expect.any(String))
    expect(again).not.toBe(stamp)
  })

  it('socketStampOf is <inode>:<ctime in ns>, which the sources read a socket\'s age from', () => {
    const stamp = socketStampOf(path, process.getuid!())
    expect(stamp).toMatch(/^\d+:\d+$/)
    const s = lstatSync(path, { bigint: true })
    expect(stamp).toBe(`${s.ino}:${s.ctimeNs}`)
  })

  it('the watch tells of the nearest existing folder', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hw-'))
    const config = join(home, '.config')
    const folder = join(config, 'herdr')
    const at = { socketPath: join(folder, 'herdr.sock'), home }
    let told = 0
    const stopWatch = watchSocket(at, () => { told++ })
    const count = () => told
    try {
      // With no <config>, a change in home is told.
      await toldOf(count, () => mkdir(join(home, 'a')))
      // <config> appears in home, and the watch moves there: a change in it is told.
      await toldOf(count, () => mkdir(config))
      await toldOf(count, () => mkdir(join(config, 'b')))
      // So does <config>/herdr.
      await toldOf(count, () => mkdir(folder))
      await toldOf(count, () => mkdir(join(folder, 'c')))
    } finally {
      stopWatch()
    }
    // After its stop nothing is: another watch of the same folder tells of the change.
    const stopped = told
    let seen = 0
    const other = watchSocket(at, () => { seen++ })
    try {
      await toldOf(() => seen, () => mkdir(join(folder, 'd')))
    } finally {
      other()
    }
    expect(told).toBe(stopped)
    // A watch that cannot be held tells nothing, and throws nothing.
    expect(() => watchSocket({ socketPath: join(home, 'none', 'herdr', 'herdr.sock'), home: join(home, 'none') }, () => {})()).not.toThrow()
  })

  /** A watch of <config>/herdr in a home of its own, and how many changes it told. */
  async function watchedHerdr() {
    const home = await mkdtemp(join(tmpdir(), 'hw-'))
    const config = join(home, '.config')
    const folder = join(config, 'herdr')
    await mkdir(folder, { recursive: true })
    let told = 0
    const stopWatch = watchSocket({ socketPath: join(folder, 'herdr.sock'), home }, () => { told++ })
    return { config, folder, count: () => told, stop: stopWatch }
  }

  // inotify ends the watch of a folder that is removed: a herdr that made it again and started would never be seen.
  it('the watch moves out of a folder that is removed, and back in once it is made again', async () => {
    const { config, folder, count, stop: stopWatch } = await watchedHerdr()
    try {
      await toldOf(count, () => rm(folder, { recursive: true }))
      // <config> is the nearest existing folder now.
      await toldOf(count, () => mkdir(join(config, 'b')))
      await toldOf(count, () => mkdir(folder))
      await toldOf(count, () => mkdir(join(folder, 'c')))
    } finally {
      stopWatch()
    }
  })

  it('a watch that fails as its folder goes moves out too', async () => {
    const { config, folder, count, stop: stopWatch } = await watchedHerdr()
    try {
      const { calls, results } = vi.mocked(watch).mock
      const held = results[calls.findLastIndex(([path]) => path === folder)].value as FSWatcher
      // Failed before its folder's change is told, which it then never is.
      rmSync(folder, { recursive: true })
      held.emit('error', new Error('gone'))
      await toldOf(count, () => mkdir(join(config, 'b')))
    } finally {
      stopWatch()
    }
  })
})
