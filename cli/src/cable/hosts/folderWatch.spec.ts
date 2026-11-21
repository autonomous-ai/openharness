import { realpathSync, watch } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PathToWatchDeps } from '../../lib/pathToWatch.js'
import { watchNearest } from './folderWatch.js'

/** Each folder fs.watch is given, in order. */
const given = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const watch = ((path: string, ...rest: unknown[]) => {
    given.push(path)
    return (actual.watch as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof actual.watch
  return { ...actual, watch, default: { ...actual, watch } }
})
/** This computer, unless a case says Windows. */
const toWatch = vi.hoisted(() => ({ deps: undefined as PathToWatchDeps | undefined }))
vi.mock('../../lib/pathToWatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pathToWatch.js')>()
  return { pathToWatch: (path: string) => actual.pathToWatch(path, toWatch.deps) }
})

afterEach(() => {
  toWatch.deps = undefined
  given.length = 0
})

/** Makes a change once every watch started so far is live, and again under a new name each time until `count` grows.
 *  On macOS every folder the process watches is in one FSEvents stream, which libuv builds anew on another thread at
 *  each watch's start and close (src/unix/fsevents.c): a change made while it is rebuilt is told to no watch, and so is
 *  one fseventsd drops under load. So a change made at once can go untold, and a watch started after that has told of a
 *  change of its own says the stream was live, not that it still is: a move to a nearer folder told late, after it,
 *  rebuilds the stream under the step's change. A change that cannot be made twice, a folder made or removed, is made
 *  once: a try after the first does nothing. */
async function toldOf(count: () => number, change: (name: string) => Promise<unknown>): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'fw-'))
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

/** A watch of `folders` and how many changes it told. */
function watched(folders: string[]) {
  let told = 0
  const stop = watchNearest(folders, () => { told++ })
  return { count: () => told, stop }
}

describe('one watch on the nearest existing folder', () => {
  it('it tells of a change in the nearest existing folder, and moves nearer as one appears', async () => {
    const t = await mkdtemp(join(tmpdir(), 'fw-'))
    const a = join(t, 'a')
    const b = join(a, 'b')
    await mkdir(a)
    const { count, stop } = watched([b, a])
    try {
      await toldOf(count, (name) => writeFile(join(a, name), ''))
      await toldOf(count, () => mkdir(b, { recursive: true }))
      await toldOf(count, (name) => writeFile(join(b, name), ''))
    } finally {
      stop()
    }
  })

  it('a folder made two levels down in one step is found', async () => {
    const t = await mkdtemp(join(tmpdir(), 'fw-'))
    const a = join(t, 'a')
    const b = join(a, 'b')
    const { count, stop } = watched([b, a, t])
    try {
      await toldOf(count, () => mkdir(b, { recursive: true }))
      await toldOf(count, (name) => writeFile(join(b, name), ''))
    } finally {
      stop()
    }
  })

  // inotify ends the watch of a folder that is removed: a program that made it again would never be seen.
  it('it moves out of a folder that is removed, and back in once it is made again', async () => {
    const t = await mkdtemp(join(tmpdir(), 'fw-'))
    const a = join(t, 'a')
    const b = join(a, 'b')
    await mkdir(b, { recursive: true })
    const { count, stop } = watched([b, a])
    try {
      await toldOf(count, () => rm(b, { recursive: true, force: true }))
      await toldOf(count, (name) => writeFile(join(a, name), ''))
      await toldOf(count, () => mkdir(b, { recursive: true }))
      await toldOf(count, (name) => writeFile(join(b, name), ''))
    } finally {
      stop()
    }
  })

  it('with no folder of the list there it holds nothing: nothing is told, and its stop is safe', async () => {
    const t = await mkdtemp(join(tmpdir(), 'fw-'))
    const none = watched([join(t, 'x', 'y'), join(t, 'x')])
    // Another watch, of the folder above, tells of the change; the list's watch, which holds nothing above, does not.
    const above = watched([t])
    try {
      await toldOf(above.count, (name) => writeFile(join(t, name), ''))
    } finally {
      above.stop()
    }
    expect(none.count()).toBe(0)
    expect(() => none.stop()).not.toThrow()
  })

  it('after its stop nothing is told', async () => {
    const t = await mkdtemp(join(tmpdir(), 'fw-'))
    const stopped = watched([t])
    await toldOf(stopped.count, (name) => writeFile(join(t, name), ''))
    stopped.stop()
    const before = stopped.count()
    // Another watch of the same folder tells of the change, which the stopped one does not.
    const other = watched([t])
    try {
      await toldOf(other.count, (name) => writeFile(join(t, name), ''))
    } finally {
      other.stop()
    }
    expect(stopped.count()).toBe(before)
  })

  // libuv aborts the process at the first change in a folder watched by an 8.3 short name (lib/pathToWatch.ts). A
  // short name is another name of the same folder, as a link is here.
  it('on Windows it watches a folder by its long name, and tells the names in it as they are', async () => {
    const t = await mkdtemp(join(tmpdir(), 'fw-'))
    const long = join(t, 'hxdialtest')
    const short = join(t, 'HXDIAL~1')
    await mkdir(long)
    await symlink(long, short)
    toWatch.deps = { platform: 'win32', realpath: (path) => realpathSync.native(path), log: () => {} }
    const names: Array<string | undefined> = []
    const written: string[] = []
    let told = 0
    const stop = watchNearest([join(short, 'b'), short], (file) => { told++; names.push(file) })
    try {
      await toldOf(() => told, () => mkdir(join(long, 'b'), { recursive: true }))
      await toldOf(() => told, (name) => { written.push(name); return writeFile(join(long, 'b', name), '') })
    } finally {
      stop()
    }
    expect(given.filter((folder) => folder.includes('HXDIAL~1'))).toEqual([])
    expect(given).toContain(realpathSync.native(long))
    expect(names).toContain('b')
    expect(names.some((name) => name !== undefined && written.includes(name))).toBe(true)
  })
})
