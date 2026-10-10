/** A monotone catalog: exclusive numbered publication serializes writers without a reapable lock. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  opendirSync, readSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { MAX_CATALOG_HOMES, readHomeCatalog, type HomeCatalog, type HomeCatalogRead } from './homeCatalog.js'
import { IdentityReadUnavailable } from './identityScan.js'

const MAX_RECORDS = MAX_CATALOG_HOMES * 2 + 2
const MAX_BYTES = 64 * 1024
const ENGINES = ['claude', 'codex'] as const
type FileRead = { text: string; version: string }
type RecordValue = { version: 1; previous: string | null; legacyRequired: boolean; homes: HomeCatalog }
type Entry = { path: string; digest: string; value: RecordValue; sealed: boolean }
type State = { homes: HomeCatalog; legacy: HomeCatalogRead; entries: Entry[]; directory: string; initialized: boolean; confirmations: string; marker: string; version: string }
const unavailable = (reason: string) => new IdentityReadUnavailable(`the saved engine-home adoption journal ${reason}`)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const stamp = (info: BigIntStats) => [info.dev, info.ino, info.mode, info.uid, info.size, info.mtimeNs, info.ctimeNs].join(':')
const empty = (): HomeCatalog => ({ claude: [], codex: [] })
const deadline = () => {
  const until = performance.now() + 250
  return () => { if (performance.now() > until) throw unavailable('exceeded its work deadline') }
}
function inspect(info: BigIntStats, directory = false): void {
  if (!(directory ? info.isDirectory() : info.isFile())
    || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))
    || (info.mode & 0o022n)) throw unavailable('has an unsafe owner, type or write permission')
}
function read(file: string, check: () => void, max = MAX_BYTES + 1024): FileRead | null {
  check()
  let before: BigIntStats
  try { before = lstatSync(file, { bigint: true }) }
  catch (error) { if (missing(error)) return null; throw unavailable('could not be inspected') }
  inspect(before)
  if (before.size > max) throw unavailable('exceeds its byte limit')
  let fd: number | undefined
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const opened = fstatSync(fd, { bigint: true })
    if (stamp(opened) !== stamp(before)) throw unavailable('changed before its read')
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0, calls = 0
    while (offset < bytes.length) {
      check()
      if (++calls > 64) throw unavailable('exceeded its read-operation limit')
      const count = readSync(fd, bytes, { offset, length: bytes.length - offset, position: offset })
      if (!count) throw unavailable('ended during its read')
      offset += count
    }
    if (stamp(fstatSync(fd, { bigint: true })) !== stamp(opened)
      || stamp(lstatSync(file, { bigint: true })) !== stamp(opened)) throw unavailable('changed during its read')
    check()
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), version: stamp(opened) }
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    throw unavailable('could not be read completely')
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { throw unavailable('could not close its read descriptor') }
  }
}
function merge(...catalogs: HomeCatalog[]): HomeCatalog {
  const result = empty()
  for (const catalog of catalogs) for (const engine of ENGINES) {
    if (!catalog || !Array.isArray(catalog[engine]) || catalog[engine].length > MAX_CATALOG_HOMES
      || catalog[engine].some(home => typeof home !== 'string' || !home.startsWith('/') || home.length > 4096 || home.includes('\0'))) {
      throw unavailable('contains an invalid home list')
    }
    for (const home of catalog[engine]) if (!result[engine].includes(home)) result[engine].push(home)
    if (result[engine].length > MAX_CATALOG_HOMES) throw unavailable('reached the known session-home limit')
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw unavailable('exceeds its combined catalog byte limit')
  return result
}
function parse(text: string, previous: string | null): RecordValue {
  let value: RecordValue
  try { value = JSON.parse(text) } catch { throw unavailable('has an incomplete record') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || value.previous !== previous || typeof value.legacyRequired !== 'boolean'
    || Object.keys(value).sort().join(',') !== 'homes,legacyRequired,previous,version'
    || !value.homes || typeof value.homes !== 'object' || Array.isArray(value.homes)
    || Object.keys(value.homes).sort().join(',') !== 'claude,codex') throw unavailable('has an unknown record schema or broken chain')
  // A repeated property cannot hide an earlier list, including escaped key spellings.
  const keys = new Set<string>()
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    let next = match.index! + match[0].length
    while (' \t\r\n'.includes(text[next] ?? '\0')) next++
    if (text[next] !== ':') continue
    const key = JSON.parse(match[0]) as string
    if (keys.has(key)) throw unavailable('contains a repeated record property')
    keys.add(key)
  }
  for (const engine of ENGINES) {
    const homes = value.homes[engine]
    if (!Array.isArray(homes) || homes.length > MAX_CATALOG_HOMES
      || homes.some(home => typeof home !== 'string' || !home.startsWith('/') || home.length > 4096 || home.includes('\0'))
      || new Set(homes).size !== homes.length) throw unavailable('contains an invalid home list')
  }
  return value
}
function names(directory: string, check: () => void, confirmations = false): string[] | null {
  check()
  let info: BigIntStats
  try { info = lstatSync(directory, { bigint: true }) }
  catch (error) { if (missing(error)) return null; throw unavailable('could not inspect its directory') }
  inspect(info, true)
  const dir = opendirSync(directory)
  const result: string[] = []
  try {
    for (;;) {
      check()
      const entry = dir.readSync()
      if (!entry) break
      if (result.length >= MAX_RECORDS * 2 + 1) throw unavailable('exceeded its entry limit')
      if (confirmations ? !/^\d{3}\.committed$/.test(entry.name)
        : entry.name !== '.staging' && !/^\d{3}\.json$/.test(entry.name)) throw unavailable('contains an unknown entry')
      if (entry.name === '.staging') inspect(lstatSync(join(directory, entry.name), { bigint: true }), true)
      result.push(entry.name)
    }
    // Directory iterators have no public descriptor in Node. Validate every possible numbered
    // slot directly, so an iterator redirected to an older copied directory cannot hide a tail.
    const suffix = confirmations ? '.committed' : '.json'
    for (let index = 0; index < MAX_RECORDS; index++) {
      check()
      const name = String(index).padStart(3, '0') + suffix
      let present = true
      try { present = lstatSync(join(directory, name), { bigint: true, throwIfNoEntry: false }) !== undefined }
      catch (error) { if (missing(error)) present = false; else throw unavailable('could not inspect a numbered entry') }
      if (present !== result.includes(name)) throw unavailable('changed its numbered entry pool')
    }
  } finally { dir.closeSync() }
  const after = lstatSync(directory, { bigint: true })
  if (stamp(after) !== stamp(info)) throw unavailable('changed its directory during enumeration')
  return result.sort()
}
function state(file: string, check: () => void, recover = false): State {
  check()
  const legacy = readHomeCatalog(file), directory = file + '.adoptions', marker = file + '.adopted', confirmations = file + '.confirmations'
  const initialNames = names(directory, check), initialConfirmations = names(confirmations, check, true), genesis = read(marker, check, 128)
  const frontier = (): void => {
    if (readHomeCatalog(file).version !== legacy.version
      || names(confirmations, check, true)?.join(',') !== initialConfirmations?.join(',')
      || names(directory, check)?.join(',') !== initialNames?.join(',')) throw unavailable('changed during its catalog read')
  }
  if (!initialNames) {
    if (genesis || initialConfirmations?.length) throw unavailable('is missing its committed directory')
    if (initialConfirmations && !recover) throw unavailable('has an incomplete initialization')
    if (read(marker, check, 128) !== null) throw unavailable('changed during its catalog read')
    frontier()
    return { homes: legacy.homes, legacy, entries: [], directory, initialized: false, confirmations, marker, version: legacy.version ?? 'new' }
  }
  if (genesis && !initialConfirmations) throw unavailable('is missing its confirmation directory')
  const files = initialNames.filter(name => name.endsWith('.json'))
  if (files.length > MAX_RECORDS || (!recover && !files.length)) throw unavailable('has an incomplete record pool')
  const entries: Entry[] = [], signatures: string[] = [], proofs = new Map<string, string | undefined>()
  proofs.set(marker, genesis?.version)
  let homes = empty(), previous: string | null = null, required = false
  for (let index = 0; index < files.length; index++) {
    check()
    if (files[index] !== `${String(index).padStart(3, '0')}.json`) throw unavailable('has a gap in its record pool')
    const path = join(directory, files[index]), source = read(path, check)
    if (!source) throw unavailable('lost a record during its read')
    const value = parse(source.text, previous), hash = digest(source.text)
    if (required && !value.legacyRequired) throw unavailable('forgot its legacy catalog')
    const merged = merge(homes, value.homes)
    if (index && JSON.stringify(merged) === JSON.stringify(homes) && required === value.legacyRequired) throw unavailable('contains a redundant record')
    homes = merged; required = value.legacyRequired
    const confirmationPath = index === 0 ? marker : join(confirmations, String(index).padStart(3, '0') + '.committed')
    const confirmation = index === 0 ? genesis : read(confirmationPath, check, 128)
    if (confirmation && confirmation.text !== hash + '\n') throw unavailable('has a mismatched durable confirmation')
    if (!confirmation && !recover) throw unavailable('has an unconfirmed adoption')
    entries.push({ path, digest: hash, value, sealed: !!confirmation })
    proofs.set(path, source.version); proofs.set(confirmationPath, confirmation?.version)
    signatures.push(source.version, confirmation?.version ?? '')
    previous = hash
  }
  if (genesis && !entries.length) throw unavailable('lost its initial record')
  const expectedConfirmations = entries.flatMap((entry, index) => index && entry.sealed ? [String(index).padStart(3, '0') + '.committed'] : [])
  if ((initialConfirmations ?? []).join(',') !== expectedConfirmations.sort().join(',')) throw unavailable('has an orphaned durable confirmation')
  if (required && legacy.text === null) throw unavailable('is missing its adopted legacy catalog')
  for (const [path, version] of proofs) {
    if (read(path, check)?.version !== version) throw unavailable('changed during its catalog read')
  }
  // Immutable records cannot change in a cooperating writer; a new record can appear during this pass.
  // Re-observe pool membership last, including the absent-directory case above.
  frontier()
  check()
  return { homes: merge(homes, legacy.homes), legacy, entries, directory, initialized: true, confirmations, marker,
    version: digest(JSON.stringify([legacy.version, genesis?.version, signatures])) }
}

/** Fresh baseline plus every durably committed addition. A partial journal is never an empty catalog. */
export function readAdoptedHomes(file: string): HomeCatalogRead {
  try {
    const found = state(file, deadline())
    return { homes: found.homes, text: JSON.stringify(found.homes), version: found.version }
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    throw unavailable('could not be read completely')
  }
}
function syncDirectory(directory: string, check: () => void, ancestor = false): void {
  check()
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | (ancestor ? 0 : constants.O_NOFOLLOW))
  try {
    const info = fstatSync(fd, { bigint: true })
    if (ancestor) { if (!info.isDirectory()) throw unavailable('has an unavailable ancestor directory') }
    else inspect(info, true)
    fsyncSync(fd); check()
  }
  finally { closeSync(fd) }
}
function directory(path: string, check: () => void, depth = 0): void {
  check()
  if (depth > 32) throw unavailable('exceeded its parent-directory limit')
  try { inspect(lstatSync(path, { bigint: true }), true) }
  catch (error) {
    if (!missing(error)) throw error
    directory(dirname(path), check, depth + 1)
    try { mkdirSync(path, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  inspect(lstatSync(path, { bigint: true }), true)
  // Flush each newly created name before creating anything beneath it. A retry also completes a failed parent flush.
  syncDirectory(dirname(path), check, true)
}
function publish(path: string, text: string, staging: string, check: () => void): boolean {
  check()
  const temporary = join(staging, randomUUID())
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    try { writeFileSync(fd, text); fsyncSync(fd); check() }
    finally { closeSync(fd) }
    try { linkSync(temporary, path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
    return true
  } finally { unlinkSync(temporary) }
}
function seal(entry: Entry, index: number, found: State, staging: string, check: () => void): void {
  // Another writer may finish a crashed writer's complete immutable record. No lock or partial slot is reaped.
  const source = read(entry.path, check)
  if (!source || digest(source.text) !== entry.digest) throw unavailable('changed before durability confirmation')
  const fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (stamp(fstatSync(fd, { bigint: true })) !== source.version) throw unavailable('changed before its durable flush')
    fsyncSync(fd)
  } finally { closeSync(fd) }
  syncDirectory(found.directory, check)
  // Confirmations live outside the journal: losing its newest record cannot look like an older complete pool.
  const marker = index ? join(found.confirmations, String(index).padStart(3, '0') + '.committed') : found.marker
  publish(marker, entry.digest + '\n', staging, check)
  if (read(marker, check, 128)?.text !== entry.digest + '\n') throw unavailable('changed its durable confirmation')
  syncDirectory(dirname(marker), check)
}

/** Positive observations survive a held reply. They constrain retries, never authorize session roots. */
export function createHomeAdopter(file: string) {
  let observed = empty(), legacyObserved = false, exhausted = false
  function adopt(additions: HomeCatalog): HomeCatalog {
    const check = deadline()
    try {
      if (exhausted) throw unavailable('exhausted its retained observation limit')
      merge(additions)
      const remember = (found: State): void => {
        legacyObserved ||= found.legacy.text !== null
        try { observed = merge(observed, found.homes) }
        catch (error) { exhausted = true; throw error }
      }
      const confirmed = (): HomeCatalog | null => {
        const final = state(file, check)
        remember(final)
        const recorded = merge(...final.entries.map(entry => entry.value.homes))
        if (ENGINES.some(engine => observed[engine].some(home => !recorded[engine].includes(home)))
          || (legacyObserved && !final.entries.at(-1)?.value.legacyRequired)) return null
        return final.homes
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        const found = state(file, check, true)
        remember(found)
        if (legacyObserved && found.legacy.text === null) throw unavailable('is missing its observed legacy catalog')
        if (!found.entries.length && !additions.claude.length && !additions.codex.length && !legacyObserved) {
          if (found.initialized) throw unavailable('has no complete initialization intent to recover')
          return found.homes
        }
        directory(dirname(file), check); directory(found.directory, check); directory(found.confirmations, check)
        const staging = join(found.directory, '.staging'); directory(staging, check)
        syncDirectory(dirname(file), check)
        for (const [index, entry] of found.entries.entries()) if (!entry.sealed) seal(entry, index, found, staging, check)
        // A previous reply may have failed after publication but before the directory flush.
        // Confirmation on disk is not permission for this writer to skip its durability obligation.
        syncDirectory(found.directory, check); syncDirectory(found.confirmations, check); syncDirectory(dirname(file), check)
        const wanted = merge(found.homes, observed, additions)
        const prior = found.entries.at(-1), required = !!prior?.value.legacyRequired || legacyObserved
        const recorded = merge(...found.entries.map(entry => entry.value.homes))
        const extra = Object.fromEntries(ENGINES.map(engine => [engine, wanted[engine].filter(home => !recorded[engine].includes(home))])) as HomeCatalog
        if (prior && !extra.claude.length && !extra.codex.length && required === prior.value.legacyRequired) {
          const done = confirmed()
          if (done) return done
          continue
        }
        if (found.entries.length >= MAX_RECORDS) throw unavailable('reached its record limit')
        const value: RecordValue = { version: 1, previous: prior?.digest ?? null, legacyRequired: required, homes: extra }
        const text = JSON.stringify(value) + '\n', path = join(found.directory, String(found.entries.length).padStart(3, '0') + '.json')
        if (!publish(path, text, staging, check)) continue
        seal({ path, value, digest: digest(text), sealed: false }, found.entries.length, found, staging, check)
        const done = confirmed()
        if (done) return done
      }
      throw unavailable('is busy with another adoption')
    } catch (error) {
      if (error instanceof IdentityReadUnavailable) throw error
      throw unavailable('could not confirm durable adoption')
    }
  }
  return {
    adopt,
    observations(): { homes: HomeCatalog; legacyRequired: boolean; exhausted: boolean } {
      return { homes: { claude: [...observed.claude], codex: [...observed.codex] }, legacyRequired: legacyObserved, exhausted }
    },
  }
}
