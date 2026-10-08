import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PACK_VERSION, decodePack } from './pack.js'
import { PetSheetError, type PetRows } from './sheet.js'
import { PetStore, PetStoreError } from './store.js'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })))
})

// A 768 x 936 sheet; `seed` changes its colours, so each seed is a different source file.
function sheetPng(seed: number): Buffer {
  const png = new PNG({ width: 768, height: 936 })
  for (const row of [0, 7]) {
    for (let c = 0; c < 2; c++) {
      for (let y = 0; y < 30; y++) {
        for (let x = 0; x < 30; x++) {
          const i = ((row * 104 + 30 + y) * 768 + c * 96 + 30 + x) * 4
          png.data.set([(seed * 37) & 255, 90 + c * 40, (x * 5 + y) & 255, 255], i)
        }
      }
    }
  }
  return PNG.sync.write(png)
}

// What the defaults come to on a sheet with only idle and running drawn.
const DEFAULT_ROWS_IDLE: PetRows = { rest: 'idle', working: 'running', listening: 'idle', sending: 'idle', asking: 'idle' }

let work: string
let dir: string
let store: PetStore
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'pet-store-'))
  roots.push(work)
  dir = join(work, 'pets')
  store = new PetStore(dir)
})

async function source(seed: number): Promise<string> {
  const path = join(work, `sheet-${seed}.png`)
  await writeFile(path, sheetPng(seed))
  return path
}

// A 768 x 936 sheet with `rows[row]` cells drawn in the given rows, each cell its own shape and colours.
function richPng(rows: Record<number, number>): Buffer {
  const png = new PNG({ width: 768, height: 936 })
  for (const [row, n] of Object.entries(rows).map(([r, n]) => [Number(r), n])) {
    for (let c = 0; c < n; c++) {
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 30 + c * 3; x++) {
          const i = ((row * 104 + 20 + y + c) * 768 + c * 96 + 20 + x) * 4
          png.data.set([(row * 29 + c * 17) & 255, (x * 5 + row * 11) & 255, (y * 6 + c * 3) & 255, 255], i)
        }
      }
    }
  }
  return PNG.sync.write(png)
}

const hpets = async () => (await readdir(dir)).filter((n) => n.endsWith('.hpet'))

describe('PetStore', () => {
  it('prepare converts, stores the pack and the source, and returns the id', async () => {
    const { id, bytes, pet } = await store.prepare(await source(1))
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(pet.frames.length).toBeGreaterThan(0)
    const pack = await store.pack(id)
    expect(pack.length).toBe(bytes)
    expect(decodePack(pack).id).toBe(id)
    expect((await readdir(dir)).sort()).toEqual([`${id}.hpet`, `${id}.json`, `${id}.png`])
  })

  it('prepare passes sheet errors through', async () => {
    const bad = join(work, 'bad.png')
    await writeFile(bad, 'nope')
    await expect(store.prepare(bad)).rejects.toMatchObject({ code: 'NOT_PNG' })
  })

  it('store: same source twice → one pack', async () => {
    const path = await source(2)
    const a = await store.prepare(path)
    const b = await store.prepare(path)
    expect(b.id).toBe(a.id)
    await store.apply('claude', a.id)
    const mapping = await store.apply('codex', b.id)
    expect(mapping).toEqual({ all: null, engines: { claude: a.id, codex: a.id } })
    expect(store.mappedIds()).toEqual([a.id])
    expect(await hpets()).toEqual([`${a.id}.hpet`])
  })

  it('store: fifth distinct pack is refused', async () => {
    const ids: string[] = []
    for (const [n, target] of ['all', 'claude', 'codex', 'muse'].entries()) {
      ids.push((await store.prepare(await source(11 + n))).id)
      await store.apply(target, ids[n])
    }
    ids.push((await store.prepare(await source(15))).id)
    const err = await store.apply('gemini', ids[4]).catch((e) => e)
    expect(err).toBeInstanceOf(PetSheetError)
    expect(err).toMatchObject({ code: 'TOO_MANY', message: 'Up to 4 pets at once: reset one first' })
    expect(store.mappedIds().length).toBe(4)
    // Replacing one of the four is fine.
    await store.apply('muse', ids[4])
    expect(store.mappedIds()).toContain(ids[4])
  })

  it('store: reset removes the mapping and deletes the unreferenced pack', async () => {
    const a = await store.prepare(await source(20))
    await store.apply('all', a.id)
    const mapping = await store.reset('all')
    expect(mapping).toEqual({ all: null, engines: {} })
    expect(await readdir(dir)).toEqual(['pets.json'])
  })

  it('a replaced pack is deleted, a still-mapped one kept', async () => {
    const a = await store.prepare(await source(30))
    const b = await store.prepare(await source(31))
    await store.apply('all', a.id)
    await store.apply('claude', a.id)
    await store.apply('all', b.id)
    expect(store.mappedIds().sort()).toEqual([a.id, b.id].sort())
    await store.reset('claude')
    expect(await hpets()).toEqual([`${b.id}.hpet`])
  })

  it('a prepared pack survives another apply until it is applied', async () => {
    const a = await store.prepare(await source(40))
    const b = await store.prepare(await source(41))
    await store.apply('all', a.id)
    await store.reset('all')
    expect(await hpets()).toContain(`${b.id}.hpet`)
    await store.apply('claude', b.id)
    expect(store.mappedIds()).toEqual([b.id])
  })

  it('store: mapping survives a new PetStore on the same dir', async () => {
    const a = await store.prepare(await source(50))
    await store.apply('all', a.id)
    await store.apply('codex', a.id)
    const again = new PetStore(dir)
    expect(again.mapping()).toEqual({ all: a.id, engines: { codex: a.id } })
    expect((await again.pack(a.id)).length).toBeGreaterThan(0)
  })

  it('apply refuses an unknown id and bad targets', async () => {
    await expect(store.apply('all', 'aaaaaaaaaaaaaaaa')).rejects.toMatchObject({ code: 'UNKNOWN_PET' })
    await expect(store.apply('all', '../etc/passwd')).rejects.toMatchObject({ code: 'UNKNOWN_PET' })
    const a = await store.prepare(await source(60))
    await expect(store.apply('__proto__', a.id)).rejects.toMatchObject({ code: 'BAD_TARGET' })
    await expect(store.apply('', a.id)).rejects.toMatchObject({ code: 'BAD_TARGET' })
  })

  it('keeps the source file\'s base name (max 40 chars) in a sidecar, atomically, and sweeps it with the pack', async () => {
    const long = join(work, `${'x'.repeat(60)}.png`)
    await writeFile(long, sheetPng(70))
    const a = await store.prepare(long)
    expect(await store.name(a.id)).toBe('x'.repeat(40))
    expect(JSON.parse(await readFile(join(dir, `${a.id}.json`), 'utf8'))).toEqual({ name: 'x'.repeat(40), rows: DEFAULT_ROWS_IDLE })
    const b = await store.prepare(await source(71))
    expect(await store.name(b.id)).toBe('sheet-71')
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(await store.name('ffffffffffffffff')).toBe('')
    await store.apply('all', b.id)
    await store.reset('all')
    expect((await readdir(dir)).filter((f) => f.startsWith(b.id))).toEqual([]) // pack, source and name go together
  })

  it('engine names are capped at 15 chars (the dial keeps 15) and at most 8 engines get their own pet', async () => {
    const a = await store.prepare(await source(80))
    await expect(store.apply('x'.repeat(16), a.id)).rejects.toMatchObject({ code: 'BAD_TARGET' })
    await store.apply('x'.repeat(15), a.id)
    for (let n = 1; n < 8; n++) await store.apply(`engine${n}`, a.id)
    const err = await store.apply('ninth', a.id).catch((e) => e)
    expect(err).toBeInstanceOf(PetStoreError)
    expect(err.message).toBe('Up to 8 engines can have their own pet')
    await store.apply('engine3', a.id) // replacing one of the eight is fine
    await store.reset('engine3')
    await store.apply('ninth', a.id)
  })

  it('mapping() returns a copy', async () => {
    const m = store.mapping()
    m.all = 'x'
    expect(store.mapping().all).toBeNull()
  })

  it('re-prepares a pack whose version byte is not the current one when its source is kept', async () => {
    const a = await store.prepare(await source(90))
    const file = join(dir, `${a.id}.hpet`)
    const old = await readFile(file)
    old[4] = 0
    await writeFile(file, old)
    const pack = await store.pack(a.id)
    expect(pack[4]).toBe(PACK_VERSION)
    expect(decodePack(pack).id).toBe(a.id)
    expect((await readFile(file))[4]).toBe(PACK_VERSION)
  })

  it('shares the directory with another store: a mapping written there is not overwritten or swept here', async () => {
    const other = new PetStore(dir)
    const x = await store.prepare(await source(91))
    await store.apply('claude', x.id)
    const y = await other.prepare(await source(92))
    await other.apply('codex', y.id)
    expect(other.mapping().engines).toEqual({ claude: x.id, codex: y.id })
    await store.reset('claude')
    expect(store.mapping().engines).toEqual({ codex: y.id })
    expect(await hpets()).toEqual([`${y.id}.hpet`])
    expect(JSON.parse(await readFile(join(dir, 'pets.json'), 'utf8')).engines).toEqual({ codex: y.id })
  })

  it('previews that were never applied do not pile up: mapped plus the newest four stay', async () => {
    const mapped = await store.prepare(await source(100))
    await store.apply('all', mapped.id)
    const previews: string[] = []
    for (let n = 0; n < 7; n++) previews.push((await store.prepare(await source(101 + n))).id)
    expect((await hpets()).sort()).toEqual([mapped.id, ...previews.slice(-4)].map((id) => `${id}.hpet`).sort())
  })

  // Recorded before the row choice existed: without one, a sheet is the very pack (and id) it always was.
  it('without a row choice, the pack and its id are what they were before rows could be chosen', async () => {
    const golden = [
      ['rich', { 0: 3, 3: 2, 5: 1, 6: 2, 7: 4, 8: 2 }, '4ccbe14a80622e7b', 'cda81b4c9f49e6838f8f5989d1e02ec9a0122871f2d1b15acba8c4627a6f9c00'],
      ['plain', { 0: 2, 7: 2 }, '2a6b49cb7b84e278', '9379ef4e9797277e26c15accb15510a70c72b5ff177419aecc891ec8104ffbed'],
      ['wavy', { 0: 4, 3: 3, 7: 1 }, '04b4f64fa278e7c7', '87af31113da33abfb05a0820920120950c1be4e761bec804fcda216e3a0a0076'],
    ] as const
    for (const [label, rows, id, sha] of golden) {
      const path = join(work, `${label}.png`)
      await writeFile(path, richPng(rows))
      expect((await store.prepare(path)).id).toBe(id)
      expect(createHash('sha256').update(await store.pack(id)).digest('hex')).toBe(sha)
      // Naming the defaults is no choice at all, and neither is naming what they fall back to.
      const named = await store.prepare(path, undefined, { rest: 'idle', working: 'running', listening: 'review', sending: 'waving', asking: 'waiting' })
      expect(named.id).toBe(id)
    }
    const plain = join(work, 'plain.png')
    expect((await store.prepare(plain, undefined, { listening: 'idle' })).id).toBe('2a6b49cb7b84e278')
  })

  it('a different row choice is a different pack, and its choice is kept beside its name', async () => {
    const path = join(work, 'rich.png')
    await writeFile(path, richPng({ 0: 3, 3: 2, 5: 1, 6: 2, 7: 4, 8: 2 }))
    const plain = await store.prepare(path)
    expect(plain.rows).toEqual({ rest: 'idle', working: 'running', listening: 'review', sending: 'waving', asking: 'waiting' })
    const swapped = await store.prepare(path, 'Swapped', { working: 'review', listening: 'running', asking: 'jumping' })
    expect(swapped.id).not.toBe(plain.id)
    const rows: PetRows = { rest: 'idle', working: 'review', listening: 'running', sending: 'waving', asking: 'idle' }
    expect(swapped.rows).toEqual(rows)
    expect(swapped.sheet.rows.idle.length).toBe(3)
    expect(JSON.parse(await readFile(join(dir, `${swapped.id}.json`), 'utf8'))).toEqual({ name: 'Swapped', rows })
    expect(await store.rows(swapped.id)).toEqual(rows)
    expect(decodePack(await store.pack(swapped.id)).working.frames.length).toBe(2)
    // The same choice again is the same pack.
    expect((await store.prepare(path, 'Swapped', { working: 'review', listening: 'running', asking: 'jumping' })).id).toBe(swapped.id)
  })

  it('refuses an empty chosen rest or working row', async () => {
    await expect(store.prepare(await source(120), undefined, { working: 'jumping' })).rejects.toMatchObject({ code: 'NO_WORKING' })
    await expect(store.prepare(await source(120), undefined, { rest: 'waving' })).rejects.toMatchObject({ code: 'NO_REST' })
  })

  it('re-prepares an old pack with the row choice it was made with', async () => {
    const path = join(work, 'rich.png')
    await writeFile(path, richPng({ 0: 3, 3: 2, 5: 1, 6: 2, 7: 4, 8: 2 }))
    const a = await store.prepare(path, undefined, { rest: 'review', working: 'waiting' })
    const file = join(dir, `${a.id}.hpet`)
    const fresh = await readFile(file)
    const old = Buffer.from(fresh)
    old[4] = 0
    await writeFile(file, old)
    expect(await store.pack(a.id)).toEqual(fresh)
  })

  it('rows: null for an unknown id, a sidecar without rows, or one with a bad row', async () => {
    expect(await store.rows('nope')).toBeNull()
    expect(await store.rows('ffffffffffffffff')).toBeNull()
    const a = await store.prepare(await source(130))
    await writeFile(join(dir, `${a.id}.json`), JSON.stringify({ name: 'old' }))
    expect(await store.rows(a.id)).toBeNull()
    await writeFile(join(dir, `${a.id}.json`), JSON.stringify({ name: 'old', rows: { ...DEFAULT_ROWS_IDLE, rest: 'sideways' } }))
    expect(await store.rows(a.id)).toBeNull()
    // A pack re-made from a sidecar without rows uses the defaults, as it was made before rows could be chosen.
    await writeFile(join(dir, `${a.id}.json`), JSON.stringify({ name: 'old' }))
    const file = join(dir, `${a.id}.hpet`)
    const fresh = await readFile(file)
    const old = Buffer.from(fresh)
    old[4] = 0
    await writeFile(file, old)
    expect(await store.pack(a.id)).toEqual(fresh)
  })
})
