import * as fs from 'node:fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { b64d as b64, b64e, type Identity } from './core.js'
import { StateFileUnreadable } from '../secureState.js'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const IDENTITY_TAIL = join('e2e', 'identity.json')
// Pass-through unless a test sets a hook. `identityRead` sees every read of identity.json, so a test can play the
// other process: the one that creates the key between this store's look and its own create. `identityPlaced` runs the
// moment a store puts its key at identity.json: a write to the path (created, not yet filled) or a link onto it.
// `tornWrite` makes the next write stop part way, as a full disk does. `identityTaken` makes every link onto identity.json
// find a name there while a read finds no file (a link to nothing); `identityLinks` counts those links.
const hooks = vi.hoisted(() => ({
  identityRead: null as ((reads: number) => void) | null,
  identityReads: 0,
  identityPlaced: null as (() => void) | null,
  tornWrite: false,
  identityTaken: false,
  identityLinks: 0,
}))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const isIdentity = (file: unknown): file is string => typeof file === 'string' && file.endsWith(IDENTITY_TAIL)
  return {
    ...real,
    readFileSync: ((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (isIdentity(file) && hooks.identityRead) hooks.identityRead(++hooks.identityReads)
      return (real.readFileSync as (f: fs.PathOrFileDescriptor, o?: unknown) => string | Buffer)(file, options)
    }) as typeof real.readFileSync,
    writeFileSync: ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (hooks.tornWrite) {
        hooks.tornWrite = false
        real.writeFileSync(file, String(data).slice(0, 8), options)
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      const placed = isIdentity(file) ? hooks.identityPlaced : null
      if (!placed) return real.writeFileSync(file, data, options)
      hooks.identityPlaced = null
      real.writeFileSync(file, '', options)
      placed()
      return real.writeFileSync(file, data, { ...(typeof options === 'object' ? options : {}), flag: 'w' })
    }) as typeof real.writeFileSync,
    linkSync: ((existing: fs.PathLike, target: fs.PathLike) => {
      if (isIdentity(target) && hooks.identityTaken) {
        // A loop with no end blocks the event loop, and the test's timeout with it: end it here, as a failure.
        if (++hooks.identityLinks > 50) throw new Error('still minting after 50 keys')
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' })
      }
      const placed = isIdentity(target) ? hooks.identityPlaced : null
      if (placed) { hooks.identityPlaced = null; placed() }
      return real.linkSync(existing, target)
    }) as typeof real.linkSync,
  }
})

const { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = fs
// The store resolves its directory when the module loads, so point it at a scratch dir first.
const root = mkdtempSync(join(tmpdir(), 'harness-e2ee-store-'))
vi.stubEnv('ADAPTER_DATA_DIR', root)
const { E2eeStore, e2eeStoreFiles, peekIdentityPub } = await import('./store.js')
const identityFile = join(root, 'e2e', 'identity.json')
const pairedFile = join(root, 'e2e', 'paired.json')
const passwordFile = join(root, 'e2e', 'remotePassword.json')
const onDisk = (): { priv: string; pub: string } => JSON.parse(readFileSync(identityFile, 'utf-8')) as { priv: string; pub: string }
const enoent = (): Error => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
/** Writes [text] at [file] in the store's folder, as another process or an older build left it. */
const leave = (file: string, text: string): void => { mkdirSync(join(root, 'e2e'), { recursive: true }); writeFileSync(file, text) }
const passwordRecord = (recentFailures: number[] = []): string =>
  JSON.stringify({ v: 1, stretched: b64e(new Uint8Array(32).fill(7)), setAt: 1, recentFailures }, null, 2)

beforeEach(() => {
  rmSync(join(root, 'e2e'), { recursive: true, force: true })
  Object.assign(hooks, { identityRead: null, identityReads: 0, identityPlaced: null, tornWrite: false, identityTaken: false, identityLinks: 0 })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  Object.assign(hooks, { identityRead: null, identityPlaced: null, tornWrite: false, identityTaken: false })
  vi.restoreAllMocks()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('E2eeStore.init identity', () => {
  it('mints a key once and every later store adopts it', () => {
    const first = new E2eeStore().init()
    expect(new E2eeStore().init().pub).toEqual(first.pub)
    expect(b64(onDisk().pub)).toEqual(first.pub)
  })

  it('a store that lost the create race adopts the winner key instead of overwriting it', () => {
    // Between this store finding no key and writing its own, another process (login vs the daemon) wins.
    let winnerPub: Uint8Array | null = null
    hooks.identityRead = (n) => {
      if (n !== 1) return
      hooks.identityRead = null
      winnerPub = new E2eeStore().init().pub // writes identity.json; the loser's look still found nothing
      hooks.identityRead = () => {}
      throw enoent()
    }
    const loser = new E2eeStore().init()
    expect(winnerPub).not.toBeNull()
    expect(loser.pub).toEqual(winnerPub)
    expect(b64(onDisk().pub)).toEqual(winnerPub)
  })

  it('two processes minting at once hold one identity', () => {
    let second: Identity | null = null
    hooks.identityPlaced = () => { second = new E2eeStore().init() }
    const first = new E2eeStore().init()
    expect(second).not.toBeNull()
    expect(first.pub).toEqual(second!.pub)
    expect(b64(onDisk().pub)).toEqual(first.pub)
  })

  it('a store that finds the winner key half-written waits for it rather than overwriting it', () => {
    // An older build creates the file before its bytes land: the loser can read it empty.
    const winner = { priv: b64e(new Uint8Array(32).fill(1)), pub: b64e(new Uint8Array(32).fill(2)) }
    hooks.identityRead = (n) => {
      if (n === 1) {
        leave(identityFile, '') // the winner has opened the file, not written it yet
        throw enoent()
      }
      if (n === 3) writeFileSync(identityFile, JSON.stringify(winner)) // ...and finishes a moment later
    }
    const loser = new E2eeStore().init()
    expect(hooks.identityReads).toBeGreaterThanOrEqual(3) // it read the empty file and did not give up on it
    expect(b64e(loser.pub)).toBe(winner.pub)
    expect(onDisk()).toEqual(winner)
  })

  // Windows can leave a link to nothing at identity.json: it reads as missing, and no new key can be put in its place.
  it('a name at identity.json that reads as no file stops minting after a few tries', () => {
    hooks.identityTaken = true
    expect(() => new E2eeStore().init()).toThrow(StateFileUnreadable)
    expect(hooks.identityLinks).toBeLessThanOrEqual(3)
  })

  it('an identity that cannot be read is never replaced', () => {
    leave(identityFile, '{"priv":"')
    expect(() => new E2eeStore().init()).toThrow(StateFileUnreadable)
    expect(readFileSync(identityFile, 'utf8')).toBe('{"priv":"') // a new key here would lose every pairing
  })

  it('mints a fresh key after the old one was spent (renamed away), and peek sees only the new one', () => {
    const old = new E2eeStore().init()
    renameSync(identityFile, `${identityFile}.removed-1`)
    expect(peekIdentityPub()).toBeNull()
    const next = new E2eeStore().init()
    expect(next.pub).not.toEqual(old.pub)
    expect(existsSync(identityFile)).toBe(true)
    expect(peekIdentityPub()).toBe(b64e(next.pub))
  })
})

describe('E2eeStore trust files', () => {
  it('names its three trust files, each read as the store reads it', () => {
    const [identity, paired, password] = e2eeStoreFiles()
    expect([identity, paired, password].map((f) => basename(f.file))).toEqual(['identity.json', 'paired.json', 'remotePassword.json'])
    expect(() => identity.parse(JSON.stringify({ priv: b64e(new Uint8Array(31)), pub: b64e(new Uint8Array(32)) }))).toThrow()
    expect(() => paired.parse('{}')).toThrow()
    expect(() => password.parse('[]')).toThrow()
  })

  it('a torn paired.json refuses every change', () => {
    const torn = '[{"identityPub":"pub-a","label":"A"},{"identityPub":"'
    leave(pairedFile, torn)
    const store = new E2eeStore()
    store.init()
    expect(store.count()).toBe(0)
    expect(store.isPaired('pub-a')).toBe(false)
    expect(() => store.addPaired('pub-c', 'C', 3)).toThrow(StateFileUnreadable)
    expect(() => store.removePaired('pub-a')).toThrow(StateFileUnreadable)
    expect(() => store.removePaired('nobody')).toThrow(StateFileUnreadable)
    expect(() => store.clear()).toThrow(StateFileUnreadable)
    expect(readFileSync(pairedFile, 'utf8')).toBe(torn) // a write here would drop every other client

    // Made whole again, it is read before the change.
    writeFileSync(pairedFile, JSON.stringify([{ identityPub: 'pub-a', label: 'A', pairedAt: 1, role: 'web' }]))
    store.addPaired('pub-c', 'C', 3)
    expect((JSON.parse(readFileSync(pairedFile, 'utf8')) as Array<{ identityPub: string }>).map((p) => p.identityPub)).toEqual(['pub-a', 'pub-c'])
  })

  it('a torn remotePassword.json is no password, and is not replaced', async () => {
    const torn = '{"v":1,"stretched":"'
    leave(passwordFile, torn)
    const store = new E2eeStore()
    store.init()
    expect(store.hasRemotePassword()).toBe(false)
    expect(store.remotePasswordVerifier()).toBeNull()
    await expect(store.setRemotePassword('machine-1', 'a new password')).rejects.toThrow(StateFileUnreadable)
    expect(() => store.clearRemotePassword()).toThrow(StateFileUnreadable)
    expect(() => store.notePwFailure()).toThrow(StateFileUnreadable)
    expect(() => store.notePwSuccess()).toThrow(StateFileUnreadable)
    expect(readFileSync(passwordFile, 'utf8')).toBe(torn) // a write here would lift a lockout

    // Made whole again, it is read before the change.
    writeFileSync(passwordFile, passwordRecord())
    expect(store.notePwFailure()).toEqual({ lockedUntil: null })
    expect((JSON.parse(readFileSync(passwordFile, 'utf8')) as { recentFailures: number[] }).recentFailures).toHaveLength(1)
  })

  it('a pairing or password write that fails part way leaves the old file', () => {
    leave(passwordFile, passwordRecord())
    const store = new E2eeStore()
    store.init()
    store.addPaired('pub-a', 'A', 1)
    store.addPaired('pub-b', 'B', 2)
    const paired = readFileSync(pairedFile, 'utf8')
    const password = readFileSync(passwordFile, 'utf8')
    hooks.tornWrite = true
    expect(() => store.addPaired('pub-c', 'C', 3)).toThrow(/ENOSPC/)
    hooks.tornWrite = true
    expect(() => store.notePwFailure()).toThrow(/ENOSPC/)
    expect(readFileSync(pairedFile, 'utf8')).toBe(paired)
    expect(readFileSync(passwordFile, 'utf8')).toBe(password)
  })
})
