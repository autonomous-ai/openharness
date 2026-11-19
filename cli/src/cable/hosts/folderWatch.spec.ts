import { watch } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { watchNearest } from './folderWatch.js'

/** Makes a change once every watch started so far is live, then waits until `count` grows. On macOS fs.watch starts its
 *  stream on another thread, one stream for every folder the process watches (libuv's FSEvents), so a change made at
 *  once can go untold: a watch started after, once it has told of a change of its own, says the stream holds the rest. */
async function toldOf(count: () => number, change: () => Promise<unknown>): Promise<void> {
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
    await change()
    await vi.waitFor(() => expect(count()).toBeGreaterThan(before), { timeout: 10_000 })
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
      await toldOf(count, () => writeFile(join(a, 'one'), ''))
      await toldOf(count, () => mkdir(b))
      await toldOf(count, () => writeFile(join(b, 'two'), ''))
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
      await toldOf(count, () => writeFile(join(b, 'one'), ''))
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
      await toldOf(count, () => rm(b, { recursive: true }))
      await toldOf(count, () => writeFile(join(a, 'one'), ''))
      await toldOf(count, () => mkdir(b))
      await toldOf(count, () => writeFile(join(b, 'two'), ''))
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
      await toldOf(above.count, () => writeFile(join(t, 'one'), ''))
    } finally {
      above.stop()
    }
    expect(none.count()).toBe(0)
    expect(() => none.stop()).not.toThrow()
  })

  it('after its stop nothing is told', async () => {
    const t = await mkdtemp(join(tmpdir(), 'fw-'))
    const stopped = watched([t])
    await toldOf(stopped.count, () => writeFile(join(t, 'one'), ''))
    stopped.stop()
    const before = stopped.count()
    // Another watch of the same folder tells of the change, which the stopped one does not.
    const other = watched([t])
    try {
      await toldOf(other.count, () => writeFile(join(t, 'two'), ''))
    } finally {
      other.stop()
    }
    expect(stopped.count()).toBe(before)
  })
})
