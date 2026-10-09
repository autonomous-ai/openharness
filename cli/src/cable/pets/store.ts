import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { convertPet, type ConvertedPet } from './convert.js'
import { PACK_VERSION, encodePack } from './pack.js'
import { PET_ROWS, PET_STATES, PetSheetError, parsePetSheet, pickPetRows, readPetSource, resolvePetRows, type PetRows, type PetSheet } from './sheet.js'

export type PetTarget = 'all' | string // 'all', or an engine name
export interface PetMapping {
  all: string | null
  engines: Record<string, string>
}

export class PetStoreError extends Error {
  readonly code: 'UNKNOWN_PET' | 'BAD_TARGET'
  constructor(code: 'UNKNOWN_PET' | 'BAD_TARGET', message: string) {
    super(message)
    this.name = 'PetStoreError'
    this.code = code
  }
}

// The dial holds every referenced pack in PSRAM: all + three engines fit in its ~5 MB of free PSRAM.
export const MAX_PACKS = 4
// Packs prepared (previewed) but not yet applied are spared by the sweep, so applying one pet cannot delete the one
// the user is still looking at; only the newest few are spared.
const MAX_PENDING = 4
const ID_RE = /^[0-9a-f]{16}$/
// The dial keeps an engine name in 16 bytes with its NUL (pet_store.c: char engine[16], strlen < 16): 15 characters.
const ENGINE_RE = /^[\w.-]{1,15}$/
// ...and a map of MAX_ENGINES = 8 entries; the rest of pet.map is ignored there.
export const MAX_ENGINES = 8
const NAME_MAX = 40
const FORBIDDEN_ENGINES = new Set(['__proto__', 'constructor', 'prototype'])

// <HARNESS_DEVICES_DIR>/pets: <id>.hpet (the pack), <id>.png (its source, to re-convert if the pack format moves on),
// <id>.json ({name, rows}: the source file's base name, for the app, and which row plays which state) and pets.json (which pack stands for what). The daemon's devices process reads this on its own, so a restart
// cannot lose the mapping.
export class PetStore {
  private map: PetMapping
  /** Identity of the pets.json that `map` was read from (mtime, size, inode), so another daemon's write is noticed. */
  private mapStamp: string
  private pending: string[] = []
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dir: string) {
    this.mapStamp = stampOf(join(dir, 'pets.json'))
    this.map = loadMapping(join(dir, 'pets.json'))
  }

  // Two daemons (or a restart) can share the directory: the file is the truth, the field only a cache of it. A cheap
  // stat decides whether to read again.
  private refresh(): void {
    const file = join(this.dir, 'pets.json')
    const stamp = stampOf(file)
    if (stamp === this.mapStamp) return
    this.map = loadMapping(file)
    this.mapStamp = stamp
  }

  mapping(): PetMapping {
    this.refresh()
    return { all: this.map.all, engines: { ...this.map.engines } }
  }

  // Distinct pack ids the mapping references, "all" first.
  mappedIds(): string[] {
    this.refresh()
    return [...new Set([this.map.all, ...Object.values(this.map.engines)].filter((v): v is string => !!v))]
  }

  async pack(id: string): Promise<Buffer> {
    if (!ID_RE.test(id)) throw new PetStoreError('UNKNOWN_PET', 'That pet is not on this computer any more')
    let pack: Buffer
    try {
      pack = await readFile(join(this.dir, `${id}.hpet`))
    } catch {
      throw new PetStoreError('UNKNOWN_PET', 'That pet is not on this computer any more')
    }
    // A pack written by an older format is made again from its kept source, never handed to a dial as it is.
    if (pack.length > 4 && pack[4] !== PACK_VERSION) {
      let source: Buffer | null = null
      try {
        source = await readFile(join(this.dir, `${id}.png`))
      } catch { /* no source kept: the pack is all there is */ }
      if (source) {
        const { pack: fresh } = buildPack(source, (await this.rows(id)) ?? undefined)
        await writeAtomic(join(this.dir, `${id}.hpet`), fresh)
        return fresh
      }
    }
    return pack
  }

  // What the app calls a pack: the base name of the file it was made from ('' when unknown).
  async name(id: string): Promise<string> {
    if (!ID_RE.test(id)) return ''
    try {
      const raw = JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')) as { name?: unknown }
      return typeof raw.name === 'string' ? raw.name.slice(0, NAME_MAX) : ''
    } catch {
      return ''
    }
  }

  // Which row plays which state in a pack (null when unknown: a pack made before rows could be chosen).
  async rows(id: string): Promise<PetRows | null> {
    if (!ID_RE.test(id)) return null
    try {
      const raw = JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')) as { rows?: Record<string, unknown> }
      const rows = {} as PetRows
      for (const state of PET_STATES) {
        const row = raw.rows?.[state]
        if (!PET_ROWS.includes(row as PetRows[typeof state])) return null
        rows[state] = row as PetRows[typeof state]
      }
      return rows
    } catch {
      return null
    }
  }

  // Validate, convert and keep a sheet. The id is the first 8 bytes of the source's sha256 (with the row choice when
  // it is not the default), so the same file and choice is the same pack however many times and for however many
  // engines it is chosen.
  async prepare(sourcePath: string, label?: string, choice?: Partial<PetRows>):
    Promise<{ id: string; pet: ConvertedPet; bytes: number; rows: PetRows; sheet: PetSheet }> {
    const source = await readPetSource(sourcePath)
    const { id, pet, pack, rows, sheet } = buildPack(source, choice)
    // A name from the app (the pet's own, e.g. petdex's displayName) wins over the file's base name. Control characters
    // are stripped and an empty result falls back, so the sidecar never holds an unprintable or oversized name.
    const given = [...(label ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()].slice(0, NAME_MAX).join('').trim()
    const name = given || [...basename(sourcePath, extname(sourcePath))].slice(0, NAME_MAX).join('')
    return this.serial(async () => {
      await mkdir(this.dir, { recursive: true })
      // Each to a temp file and renamed, so a crash never leaves half a pack that pack() would hand to a dial.
      await writeAtomic(join(this.dir, `${id}.hpet`), pack)
      await writeAtomic(join(this.dir, `${id}.png`), source)
      await writeAtomic(join(this.dir, `${id}.json`), JSON.stringify({ name, rows }))
      this.pending = [...this.pending.filter((p) => p !== id), id].slice(-MAX_PENDING)
      // Previews that were never applied would otherwise pile up: only the newest few are kept beside the mapped ones.
      await this.sweep()
      return { id, pet, bytes: pack.length, rows, sheet }
    })
  }

  async apply(target: PetTarget, id: string): Promise<PetMapping> {
    checkTarget(target)
    if (!ID_RE.test(id)) throw new PetStoreError('UNKNOWN_PET', 'That pet is not on this computer any more')
    return this.serial(async () => {
      await this.pack(id) // must exist
      const next = this.mapping()
      if (target === 'all') next.all = id
      else {
        if (!(target in next.engines) && Object.keys(next.engines).length >= MAX_ENGINES) {
          throw new PetStoreError('BAD_TARGET', 'Up to 8 engines can have their own pet')
        }
        next.engines[target] = id
      }
      const distinct = new Set([next.all, ...Object.values(next.engines)].filter(Boolean))
      if (distinct.size > MAX_PACKS) throw new PetSheetError('TOO_MANY', 'Up to 4 pets at once: reset one first')
      this.pending = this.pending.filter((p) => p !== id)
      return this.commit(next)
    })
  }

  async reset(target: PetTarget): Promise<PetMapping> {
    checkTarget(target)
    return this.serial(async () => {
      const next = this.mapping()
      if (target === 'all') next.all = null
      else delete next.engines[target]
      return this.commit(next)
    })
  }

  // Calls run one at a time: each reads the mapping the previous one left.
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async commit(next: PetMapping): Promise<PetMapping> {
    await mkdir(this.dir, { recursive: true })
    const file = join(this.dir, 'pets.json')
    await writeAtomic(file, JSON.stringify(next, null, 2))
    this.map = next
    this.mapStamp = stampOf(file)
    await this.sweep()
    return this.mapping()
  }

  private async sweep(): Promise<void> {
    const keep = new Set([...this.mappedIds(), ...this.pending])
    for (const name of await readdir(this.dir)) {
      const m = /^([0-9a-f]{16})\.(hpet|png|json)(\.tmp)?$/.exec(name)
      if (m && !keep.has(m[1])) await rm(join(this.dir, name), { force: true })
    }
  }
}

function buildPack(source: Buffer, choice?: Partial<PetRows>): { id: string; pet: ConvertedPet; pack: Buffer; rows: PetRows; sheet: PetSheet } {
  const sheet = parsePetSheet(source)
  const rows = resolvePetRows(sheet, choice)
  // The default rows hash the source alone, so a pet made before rows could be chosen keeps its id. Compared after
  // the fallbacks, so naming a row the defaults fall back to is no choice either: the pack is the same.
  const defaults = pickPetRows(sheet)
  const hash = createHash('sha256').update(source)
  if (PET_STATES.some((state) => rows[state] !== defaults[state])) {
    hash.update(`\0rows:${PET_STATES.map((state) => rows[state]).join(',')}`)
  }
  const digest = hash.digest()
  const pet = convertPet(sheet, rows)
  return { id: digest.subarray(0, 8).toString('hex'), pet, pack: encodePack(pet, digest.subarray(0, 8)), rows, sheet }
}

function stampOf(file: string): string {
  try {
    const st = statSync(file)
    return `${st.mtimeMs}:${st.size}:${st.ino}`
  } catch {
    return ''
  }
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  await writeFile(`${file}.tmp`, data)
  await rename(`${file}.tmp`, file)
}

function checkTarget(target: string): void {
  if (target === 'all') return
  if (!ENGINE_RE.test(target) || FORBIDDEN_ENGINES.has(target)) {
    throw new PetStoreError('BAD_TARGET', 'That is not an engine name')
  }
}

function loadMapping(file: string): PetMapping {
  const empty: PetMapping = { all: null, engines: {} }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { all?: unknown; engines?: unknown }
    const all = typeof raw.all === 'string' && ID_RE.test(raw.all) ? raw.all : null
    const engines: Record<string, string> = {}
    if (raw.engines && typeof raw.engines === 'object') {
      for (const [k, v] of Object.entries(raw.engines)) {
        if (Object.keys(engines).length < MAX_ENGINES && typeof v === 'string' && ID_RE.test(v) && ENGINE_RE.test(k) && !FORBIDDEN_ENGINES.has(k)) engines[k] = v
      }
    }
    return { all, engines }
  } catch {
    return empty
  }
}
