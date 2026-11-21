// Tier A's watch on the apps' stores (storeWatch.ts): what each registration hears of a change a step tells, by the
// rules of watchNearest (cable/hosts/folderWatch.ts) on a temp folder, on virtual time.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoreWatch } from './storeWatch.js'

/** How long after a watch starts or stops every watch held looks once more (folderWatch.ts LIVE_MS). */
const LOOK_MS = 5_000

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dial-eval-watch-'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

/** A watch on `folders` (nearest first) and what it heard: each change's name, `undefined` for one with none. */
function watching(watch: ReturnType<typeof createStoreWatch>, folders: string[]): { heard: Array<string | undefined>; stop(): void } {
  const heard: Array<string | undefined> = []
  const stop = watch.watch(folders, (file) => { heard.push(file) })
  return { heard, stop }
}

describe("tier A's store watch", () => {
  it('a change is heard by the watch that holds its folder, by its name, and by none above it', () => {
    const store = join(root, 'store')
    mkdirSync(join(store, 'org'), { recursive: true })
    const watch = createStoreWatch()
    const org = watching(watch, [join(store, 'org'), store])
    const top = watching(watch, [store, root])
    watch.changed(join(store, 'org', 'local_a.json'))
    expect([org.heard, top.heard]).toEqual([['local_a.json'], []])
    watch.changed(join(store, 'org'))
    expect([org.heard, top.heard]).toEqual([['local_a.json'], ['org']])
  })

  // On a Windows host the store's own path is the host's.
  it.skipIf(process.platform === 'win32')("a Windows store's folders are this host's of the same names, with the same rule", () => {
    const store = join(root, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions')
    mkdirSync(join(store, 'org'), { recursive: true })
    const watch = createStoreWatch()
    // As the devices name a Windows store from this host's home (appPlaces.ts claudeStoreRoots).
    const own = win32.join(root, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions')
    const sessions = watching(watch, [own, win32.dirname(own)])
    watch.changed(join(store, 'org', 'local_a.json'))
    expect(sessions.heard).toEqual([])
    watch.changed(join(store, 'org'))
    expect(sessions.heard).toEqual(['org'])
  })

  it('5 s after a watch starts or stops, each held one looks: it moves to a nearer folder and tells a change with no name', () => {
    const store = join(root, 'store')
    mkdirSync(store)
    const watch = createStoreWatch()
    const nearer = watching(watch, [join(store, 'org'), store])
    mkdirSync(join(store, 'org'))
    vi.advanceTimersByTime(LOOK_MS - 1)
    // Another watch starts: the look waits for the last of them.
    const other = watching(watch, [store])
    vi.advanceTimersByTime(LOOK_MS - 1)
    expect([nearer.heard, other.heard]).toEqual([[], []])
    vi.advanceTimersByTime(1)
    expect([nearer.heard, other.heard]).toEqual([[undefined], [undefined]])
    watch.changed(join(store, 'org', 'local_a.json'))
    expect(nearer.heard).toEqual([undefined, 'local_a.json'])
    // A watch stopped hears nothing more, and its stop has the others look again.
    other.stop()
    vi.advanceTimersByTime(LOOK_MS)
    expect([nearer.heard, other.heard]).toEqual([[undefined, 'local_a.json', undefined], [undefined]])
  })

  it('a watch none of whose folders is there holds nothing, hears nothing and never looks', () => {
    const watch = createStoreWatch()
    const missing = watching(watch, [join(root, 'store', 'org'), join(root, 'store')])
    mkdirSync(join(root, 'store', 'org'), { recursive: true })
    watching(watch, [root])
    vi.advanceTimersByTime(LOOK_MS)
    watch.changed(join(root, 'store', 'org', 'local_a.json'))
    expect(missing.heard).toEqual([])
  })
})
