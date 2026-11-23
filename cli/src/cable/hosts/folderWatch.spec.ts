import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PathToWatchDeps } from '../../lib/pathToWatch.js'
import { watchNearest } from './folderWatch.js'

// Each watch as it is, unless a spec puts fakes in its place.
vi.mock('node:fs', async (real) => {
  const fs = await real<typeof import('node:fs')>()
  return { ...fs, watch: vi.fn(fs.watch) }
})
/** This computer, unless a case says Windows. */
const toWatch = vi.hoisted(() => ({ deps: undefined as PathToWatchDeps | undefined }))
vi.mock('../../lib/pathToWatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pathToWatch.js')>()
  return { pathToWatch: (path: string) => actual.pathToWatch(path, toWatch.deps) }
})

afterEach(() => {
  toWatch.deps = undefined
  // The real watch again (vitest's mockReset goes back to the function vi.fn was given).
  vi.mocked(watch).mockReset()
  vi.useRealTimers()
})

interface FakeWatch {
  folder: string
  open: boolean
  /** A change the OS tells in the folder, as the real watch's listener hears it. */
  tell(file: string | null): void
  /** The watch fails, as the real one does with an 'error'. */
  fail(): void
}

/** Every watch started from now on, a fake whose changes the spec tells itself. On macOS the real one's FSEvents stream
 *  starts after fs.watch returns and is built anew at every watch's start and close (folderWatch.ts), and tells a change
 *  made meanwhile to no watch: a step that made or removed a folder could not make it again, and failed under load
 *  (2026-11-21). As the real one, a fake throws for a folder that is not there, and tells nothing once closed. */
function fakeWatches() {
  const started: FakeWatch[] = []
  vi.mocked(watch).mockImplementation(((folder: string, _options: unknown, listener: (event: string, file: string | null) => void) => {
    if (!existsSync(folder)) throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${folder}'`), { code: 'ENOENT' })
    const emitter = new EventEmitter()
    const each: FakeWatch = {
      folder,
      open: true,
      tell: (file) => {
        expect(each.open, `a change told by the closed watch of ${folder}`).toBe(true)
        listener('rename', file)
      },
      fail: () => { emitter.emit('error', new Error('EIO')) },
    }
    started.push(each)
    return Object.assign(emitter, { close: () => { each.open = false } })
  }) as unknown as typeof watch)
  const open = () => started.filter((each) => each.open)
  return {
    /** The folders of the watches open now. */
    open: () => open().map((each) => each.folder),
    /** The one watch open on `folder`. */
    on: (folder: string): FakeWatch => {
      const held = open().filter((each) => each.folder === folder)
      expect(held, `the watches open on ${folder}`).toHaveLength(1)
      return held[0]
    },
  }
}

/** What a watch of `folders` told its caller, a change with no name as undefined. */
function told(folders: string[]) {
  const changes: Array<string | undefined> = []
  const stop = watchNearest(folders, (file) => { changes.push(file) })
  return { changes, stop }
}

const folder = () => mkdtempSync(join(tmpdir(), 'fw-'))

describe('one watch on the nearest existing folder', () => {
  it('it tells of a change in the nearest existing folder, and moves nearer as one appears', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const a = join(folder(), 'a')
    const b = join(a, 'b')
    mkdirSync(a)
    const { changes, stop } = told([b, a])
    try {
      expect(watches.open()).toEqual([a])
      watches.on(a).tell('x')
      mkdirSync(b)
      watches.on(a).tell('b')
      expect(watches.open()).toEqual([b])
      watches.on(b).tell('y')
      expect(changes).toEqual(['x', 'b', 'y'])
    } finally {
      stop()
    }
  })

  it('a folder made two levels down in one step is found', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const t = folder()
    const a = join(t, 'a')
    const b = join(a, 'b')
    const { changes, stop } = told([b, a, t])
    try {
      expect(watches.open()).toEqual([t])
      mkdirSync(b, { recursive: true })
      watches.on(t).tell('a')
      expect(watches.open()).toEqual([b])
      expect(changes).toEqual(['a'])
    } finally {
      stop()
    }
  })

  // inotify ends the watch of a folder that is removed: a program that made it again would never be seen.
  it('it moves out of a folder that is removed, and back in once it is made again', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const a = join(folder(), 'a')
    const b = join(a, 'b')
    mkdirSync(b, { recursive: true })
    const { changes, stop } = told([b, a])
    try {
      expect(watches.open()).toEqual([b])
      rmSync(b, { recursive: true })
      watches.on(b).tell(null)
      expect(watches.open()).toEqual([a])
      mkdirSync(b)
      watches.on(a).tell('b')
      expect(watches.open()).toEqual([b])
      expect(changes).toEqual([undefined, 'b'])
    } finally {
      stop()
    }
  })

  it('a watch that fails as its folder goes moves out', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const a = join(folder(), 'a')
    const b = join(a, 'b')
    mkdirSync(b, { recursive: true })
    const { changes, stop } = told([b, a])
    try {
      // Failed before its folder's change is told, which it then never is.
      rmSync(b, { recursive: true })
      vi.advanceTimersByTime(3_000)
      watches.on(b).fail()
      expect(watches.open()).toEqual([a])
      // The watch it moved to looks 5 s after it started, not 5 s after the one that failed.
      vi.advanceTimersByTime(2_000)
      expect(changes).toEqual([])
      vi.advanceTimersByTime(3_000)
      expect(changes).toEqual([undefined])
      watches.on(a).tell('c')
      expect(changes).toEqual([undefined, 'c'])
    } finally {
      stop()
    }
  })

  it('a watch that fails tells nothing more, not even its look', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const t = folder()
    const { changes, stop } = told([t])
    try {
      vi.advanceTimersByTime(1_000)
      watches.on(t).fail()
      expect(watches.open()).toEqual([])
      vi.advanceTimersByTime(60_000)
      expect(changes).toEqual([])
    } finally {
      stop()
    }
  })

  it('with no folder of the list there it holds nothing: nothing is told, and its stop is safe', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const t = folder()
    const { changes, stop } = told([join(t, 'x', 'y'), join(t, 'x')])
    expect(watches.open()).toEqual([])
    vi.advanceTimersByTime(60_000)
    expect(changes).toEqual([])
    expect(() => stop()).not.toThrow()
  })

  it('after its stop nothing is told', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const t = folder()
    const { changes, stop } = told([t])
    watches.on(t).tell('x')
    stop()
    expect(watches.open()).toEqual([])
    vi.advanceTimersByTime(60_000)
    expect(changes).toEqual(['x'])
  })

  // libuv aborts the process at the first change in a folder watched by an 8.3 short name (lib/pathToWatch.ts). A
  // short name is another name of the same folder, as a link is here.
  it('on Windows it watches a folder by its long name, and tells the names in it as they are', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const t = folder()
    const long = join(t, 'hxdialtest')
    const short = join(t, 'HXDIAL~1')
    mkdirSync(long)
    symlinkSync(long, short)
    toWatch.deps = { platform: 'win32', realpath: (path) => realpathSync.native(path), log: () => {} }
    const { changes, stop } = told([join(short, 'b'), short])
    try {
      expect(watches.open()).toEqual([realpathSync.native(long)])
      mkdirSync(join(long, 'b'))
      watches.on(realpathSync.native(long)).tell('b')
      expect(watches.open()).toEqual([realpathSync.native(join(long, 'b'))])
      watches.on(realpathSync.native(join(long, 'b'))).tell('one')
      expect(changes).toEqual(['b', 'one'])
    } finally {
      stop()
    }
    expect(vi.mocked(watch).mock.calls.filter(([given]) => String(given).includes('HXDIAL~1'))).toEqual([])
  })

  // A caller looks as it starts its watch, and the stream starts after: a file made between is told by no change.
  it('a file made before its watch is live is found: the watch tells one change once it is', () => {
    vi.useFakeTimers()
    fakeWatches()
    const t = folder()
    const file = join(t, 'app.sock')
    const found: boolean[] = []
    const stop = watchNearest([t], () => { found.push(existsSync(file)) })
    try {
      writeFileSync(file, '')
      vi.advanceTimersByTime(5_000)
      expect(found).toEqual([true])
      vi.advanceTimersByTime(60_000)
      expect(found).toEqual([true])
    } finally {
      stop()
    }
  })

  // Its look takes the path of a change told: a nearer folder made before the watch was live is told by no change, and
  // without the move the watch held the parent for good.
  it('its look moves to a nearer folder made before the watch was live', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const t = folder()
    const b = join(t, 'b')
    const { changes, stop } = told([b, t])
    try {
      mkdirSync(b)
      vi.advanceTimersByTime(5_000)
      expect(watches.open()).toEqual([b])
      watches.on(b).tell('app.sock')
      expect(changes).toEqual([undefined, 'app.sock'])
    } finally {
      stop()
    }
  })

  // A change told says the stream is live, not what was made before it was: a caller that reads only the entry a change
  // names (claudeAppSource.ts) would never read that.
  it('a change told spares no look', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const t = folder()
    const { changes, stop } = told([t])
    try {
      watches.on(t).tell('one')
      vi.advanceTimersByTime(5_000)
      expect(changes).toEqual(['one', undefined])
      vi.advanceTimersByTime(60_000)
      expect(changes).toEqual(['one', undefined])
    } finally {
      stop()
    }
  })

  // On macOS every folder the process watches is in one FSEvents stream, which libuv builds anew at each watch's start
  // and close: a change made meanwhile is told to no watch, one held long before as well.
  it('a watch looks again once another of the process starts or closes', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const a = folder()
    const first = told([a])
    try {
      vi.advanceTimersByTime(5_000)
      watches.on(a).tell('x')
      expect(first.changes).toEqual([undefined, 'x'])
      const second = told([folder()])
      vi.advanceTimersByTime(5_000)
      expect(first.changes).toEqual([undefined, 'x', undefined])
      expect(second.changes).toEqual([undefined])
      second.stop()
      vi.advanceTimersByTime(5_000)
      expect(first.changes).toEqual([undefined, 'x', undefined, undefined])
      expect(second.changes).toEqual([undefined])
    } finally {
      first.stop()
    }
    // With no watch held, nothing is left to look.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('watches started together look once, 5 s after the last of them', () => {
    vi.useFakeTimers()
    fakeWatches()
    const first = told([folder()])
    vi.advanceTimersByTime(3_000)
    const second = told([folder()])
    try {
      vi.advanceTimersByTime(2_000)
      expect([first.changes, second.changes]).toEqual([[], []])
      vi.advanceTimersByTime(3_000)
      expect([first.changes, second.changes]).toEqual([[undefined], [undefined]])
      vi.advanceTimersByTime(60_000)
      expect([first.changes, second.changes]).toEqual([[undefined], [undefined]])
    } finally {
      first.stop()
      second.stop()
    }
  })

  it('a watch stopped in another\'s look is not looked at', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const b = folder()
    let second: ReturnType<typeof told> | undefined
    const first = watchNearest([folder()], () => second?.stop())
    second = told([b])
    try {
      vi.advanceTimersByTime(5_000)
      expect(second.changes).toEqual([])
      expect(watches.open()).not.toContain(b)
    } finally {
      first()
    }
  })

  it('a move nearer looks again 5 s after the move, for what was made in the new folder before its watch was live', () => {
    vi.useFakeTimers()
    const watches = fakeWatches()
    const t = folder()
    const b = join(t, 'b')
    const { changes, stop } = told([b, t])
    try {
      vi.advanceTimersByTime(3_000)
      mkdirSync(b)
      watches.on(t).tell('b')
      vi.advanceTimersByTime(2_000)
      expect(changes).toEqual(['b'])
      vi.advanceTimersByTime(3_000)
      expect(changes).toEqual(['b', undefined])
    } finally {
      stop()
    }
  })

  it('a change in the folder it holds is told by name, on the real watch', async () => {
    const t = folder()
    const names: string[] = []
    const stop = watchNearest([t], (file) => { if (file !== undefined) names.push(file) })
    try {
      // The stream starts after fs.watch returns and tells a change made before to no watch: the change is made again,
      // under a new name each time, until one is told.
      let tries = 0
      await vi.waitFor(() => {
        writeFileSync(join(t, `f-${tries++}`), '')
        expect(names.some((name) => /^f-\d+$/.test(name))).toBe(true)
      }, { timeout: 25_000, interval: 100 })
    } finally {
      stop()
    }
  })
})
