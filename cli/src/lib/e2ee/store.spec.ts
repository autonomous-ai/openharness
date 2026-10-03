import * as fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { b64d as b64, b64e } from './core.js'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Every read of identity.json goes through this hook, so a test can play the other process: the one
// that creates the key between this store's look and its own create.
let onIdentityRead: ((reads: number) => void) | null = null
let identityReads = 0
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    readFileSync: ((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (typeof file === 'string' && file.endsWith(join('e2e', 'identity.json')) && onIdentityRead) onIdentityRead(++identityReads)
      return (real.readFileSync as (f: fs.PathOrFileDescriptor, o?: unknown) => string | Buffer)(file, options)
    }) as typeof real.readFileSync,
  }
})

const { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = fs
// The store resolves its directory when the module loads, so point it at a scratch dir first.
const root = mkdtempSync(join(tmpdir(), 'harness-e2ee-store-'))
vi.stubEnv('ADAPTER_DATA_DIR', root)
const { E2eeStore, peekIdentityPub } = await import('./store.js')
const identityFile = join(root, 'e2e', 'identity.json')
const onDisk = (): { priv: string; pub: string } => JSON.parse(readFileSync(identityFile, 'utf-8')) as { priv: string; pub: string }
const enoent = (): Error => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })

beforeEach(() => {
  rmSync(join(root, 'e2e'), { recursive: true, force: true })
  onIdentityRead = null
  identityReads = 0
})
afterEach(() => { onIdentityRead = null })
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
    onIdentityRead = (n) => {
      if (n !== 1) return
      onIdentityRead = null
      winnerPub = new E2eeStore().init().pub // writes identity.json; the loser's look still found nothing
      onIdentityRead = () => {}
      throw enoent()
    }
    const loser = new E2eeStore().init()
    expect(winnerPub).not.toBeNull()
    expect(loser.pub).toEqual(winnerPub)
    expect(b64(onDisk().pub)).toEqual(winnerPub)
  })

  it('a store that finds the winner key half-written waits for it rather than overwriting it', () => {
    // An exclusive create makes the file before its bytes land: the loser can read it empty.
    const winner = { priv: 'd2lubmVyLXByaXY=', pub: 'd2lubmVyLXB1Yg==' }
    onIdentityRead = (n) => {
      if (n === 1) {
        mkdirSync(join(root, 'e2e'), { recursive: true })
        writeFileSync(identityFile, '') // the winner has opened the file, not written it yet
        throw enoent()
      }
      if (n === 3) writeFileSync(identityFile, JSON.stringify(winner)) // ...and finishes a moment later
    }
    const loser = new E2eeStore().init()
    expect(identityReads).toBeGreaterThanOrEqual(3) // it read the empty file and did not give up on it
    expect(b64e(loser.pub)).toBe(winner.pub)
    expect(onDisk()).toEqual(winner)
  })

  it('replaces an unreadable identity file as it always did', () => {
    mkdirSync(join(root, 'e2e'), { recursive: true })
    writeFileSync(identityFile, 'not json')
    const id = new E2eeStore().init()
    expect(new E2eeStore().init().pub).toEqual(id.pub)
    expect(b64(onDisk().pub)).toEqual(id.pub)
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
