import { lstatSync, realpathSync, rmSync, symlinkSync, utimesSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectLines, markerStampOf, socketStampOf, watchSocket, type LineEnd } from './unixSocket.js'

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

/** Makes a change once every watch started so far is live, and again under a new name each time until `count` grows
 *  (folderWatch.spec.ts says why). A change that cannot be made twice, a folder made or removed, is made once: a try
 *  after the first does nothing. */
async function toldOf(count: () => number, change: (name: string) => Promise<unknown>): Promise<void> {
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
    let tries = 0
    await vi.waitFor(async () => {
      await change(`${basename(folder)}-${tries++}`)
      expect(count()).toBeGreaterThan(before)
    }, { timeout: 10_000 })
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

  it('end is told once: an oversize line, then the close it leads to, is one end', async () => {
    const accepted = served.next()
    const ends: LineEnd[] = []
    const socket = connectLines(path, '', 16, () => {}, (fault) => {
      ends.push(fault)
      socket.destroy()
    })
    const closed = once(socket, 'close')
    ;(await accepted).write('y'.repeat(17))
    await closed
    expect(ends).toEqual(['oversize'])
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
    // The changes the OS told, each with a name: the one a watch tells once it is live has none (folderWatch.ts), and
    // would end a step before its own change is told.
    const stopWatch = watchSocket(at, (file) => { if (file !== undefined) told++ })
    const count = () => told
    try {
      // With no <config>, a change in home is told.
      await toldOf(count, (name) => mkdir(join(home, name)))
      // <config> appears in home, and the watch moves there: a change in it is told.
      await toldOf(count, () => mkdir(config, { recursive: true }))
      await toldOf(count, (name) => mkdir(join(config, name)))
      // So does <config>/herdr.
      await toldOf(count, () => mkdir(folder, { recursive: true }))
      await toldOf(count, (name) => mkdir(join(folder, name)))
    } finally {
      stopWatch()
    }
    // After its stop nothing is: another watch of the same folder tells of the change.
    const stopped = told
    let seen = 0
    const other = watchSocket(at, (file) => { if (file !== undefined) seen++ })
    try {
      await toldOf(() => seen, (name) => mkdir(join(folder, name)))
    } finally {
      other()
    }
    expect(told).toBe(stopped)
    // A watch that cannot be held tells nothing, and throws nothing.
    expect(() => watchSocket({ socketPath: join(home, 'none', 'herdr', 'herdr.sock'), home: join(home, 'none') }, () => {})()).not.toThrow()
  })

  /** A watch of <config>/herdr in a home of its own, the folder made or not, and how many times it told `name`. */
  async function watchedFor(name: string, made: boolean) {
    const home = await mkdtemp(join(tmpdir(), 'hw-'))
    const config = join(home, '.config')
    const folder = join(config, 'herdr')
    await mkdir(made ? folder : config, { recursive: true })
    let told = 0
    const stopWatch = watchSocket({ socketPath: join(folder, 'herdr.sock'), home }, (file) => {
      if (file === name) told++
    })
    return { folder, count: () => told, stop: stopWatch }
  }

  it('tells the name of the file that changed in the folder it holds', async () => {
    const { folder, count, stop: stopWatch } = await watchedFor('claude-hook-sessions.json', true)
    try {
      await toldOf(count, () => writeFile(join(folder, 'claude-hook-sessions.json'), '{}'))
    } finally {
      stopWatch()
    }
  })

  it('from the parent it tells the name of what changed there', async () => {
    const { folder, count, stop: stopWatch } = await watchedFor('herdr', false)
    try {
      await toldOf(count, () => mkdir(folder, { recursive: true }))
    } finally {
      stopWatch()
    }
  })

  /** A watch of <config>/herdr in a home of its own, and how many changes the OS told, each with a name (as above). */
  async function watchedHerdr() {
    const home = await mkdtemp(join(tmpdir(), 'hw-'))
    const config = join(home, '.config')
    const folder = join(config, 'herdr')
    await mkdir(folder, { recursive: true })
    let told = 0
    const stopWatch = watchSocket({ socketPath: join(folder, 'herdr.sock'), home }, (file) => { if (file !== undefined) told++ })
    return { config, folder, count: () => told, stop: stopWatch }
  }

  // inotify ends the watch of a folder that is removed: a herdr that made it again and started would never be seen.
  it('the watch moves out of a folder that is removed, and back in once it is made again', async () => {
    const { config, folder, count, stop: stopWatch } = await watchedHerdr()
    try {
      await toldOf(count, () => rm(folder, { recursive: true, force: true }))
      // <config> is the nearest existing folder now.
      await toldOf(count, (name) => mkdir(join(config, name)))
      await toldOf(count, () => mkdir(folder, { recursive: true }))
      await toldOf(count, (name) => mkdir(join(folder, name)))
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
      await toldOf(count, (name) => mkdir(join(config, name)))
    } finally {
      stopWatch()
    }
  })
})

// herdr on Windows writes a marker file where its socket would be, and listens on a named pipe named after it.
describe('a marker file\'s stamp, herdr\'s on Windows', () => {
  let root: string
  let marker: string

  beforeEach(async () => {
    // The profile is compared by its real path: a run's folders are under /tmp on macOS, a link to /private/tmp.
    root = realpathSync(await mkdtemp(join(tmpdir(), 'mk-')))
    marker = join(root, 'herdr.sock')
    writeFileSync(marker, '4242:1763600000000000000')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('is <inode>:<mtime in ns> for a real file inside the root', () => {
    const file = lstatSync(marker, { bigint: true })
    expect(markerStampOf(marker, [root])).toBe(`${file.ino}:${file.mtimeNs}`)
  })

  it('is none for a link, a folder, a file outside the root, and a missing one', async () => {
    const link = join(root, 'linked.sock')
    symlinkSync(marker, link)
    const folder = join(root, 'folder.sock')
    await mkdir(folder)
    const outside = realpathSync(await mkdtemp(join(tmpdir(), 'mk-out-')))
    try {
      const away = join(outside, 'herdr.sock')
      writeFileSync(away, '4242:1763600000000000000')
      expect(markerStampOf(link, [root])).toBeUndefined()
      expect(markerStampOf(folder, [root])).toBeUndefined()
      expect(markerStampOf(away, [root])).toBeUndefined()
      expect(markerStampOf(join(root, 'none.sock'), [root])).toBeUndefined()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('is another once herdr writes the marker again', () => {
    const stamp = markerStampOf(marker, [root])
    expect(stamp).toEqual(expect.any(String))
    writeFileSync(marker, '4343:1763600001000000000')
    // A second later, as a herdr that started again writes it: a file's time in quick succession can be the same tick.
    const later = new Date(Date.now() + 1000)
    utimesSync(marker, later, later)
    expect(markerStampOf(marker, [root])).not.toBe(stamp)
  })
})
