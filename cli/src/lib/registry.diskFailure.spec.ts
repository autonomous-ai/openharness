import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { namesTheDisk } from '../harnessd/supervisor.js'
import { errorKind } from './log.js'
import type { registry as Registry } from './registry.js'

const refuse = vi.hoisted(() => ({ directorySync: undefined as string | undefined }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, fsync: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
    if (refuse.directorySync && actual.fstatSync(fd).isDirectory()) {
      callback(Object.assign(new Error(`${refuse.directorySync}: fixture private directory`), { code: refuse.directorySync }))
      return
    }
    actual.fsync(fd, callback)
  } }
})

let directory: string
let registry: typeof Registry
let storage: typeof import('./sessionStorage.js')['sessionStorage']
let fault: string
let AtomicWriteUnconfirmed: typeof import('./registryPersistence.js').AtomicWriteUnconfirmed
const input = { agentId: 'persisted-agent', engine: 'claude' as const, tmuxPane: '%1',
  processIdentity: { pid: 101, executable: '/fixture/claude', startMarker: 'fixture-101' } }
beforeEach(async () => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'registry-disk-'))
  for (const name of ['home', 'data', 'runtime']) mkdirSync(join(directory, name), { mode: 0o700 })
  for (const [name, value] of Object.entries({ HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'),
    ADAPTER_DATA_DIR: join(directory, 'data'), ADAPTER_RUNTIME_DIR: join(directory, 'runtime'),
    CLAUDE_PROJECTS_DIR: join(directory, 'home', '.claude'), CODEX_HOME: join(directory, 'home', '.codex'), CURSOR_HOME: join(directory, 'home', '.cursor') })) vi.stubEnv(name, value)
  fault = join(directory, 'fault.json')
  const entry = join(directory, 'storage-fixture.mjs')
  // Exercise the real child, framing and Registry classification. Only this private fixture's selected write fails.
  writeFileSync(entry, `
    import fs from 'node:fs/promises';
    import { readFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { childAdmissionFailure } from ${JSON.stringify(new URL('../harnessd/childAdmission.ts', import.meta.url).href)};
    if (childAdmissionFailure(process.env, process.ppid, process.argv[1])) process.exit(2);
    const open = fs.open;
    fs.open = async (...args) => {
      let selected;
      try { selected = JSON.parse(readFileSync(${JSON.stringify(fault)}, 'utf8')); } catch {}
      const temporary = /\\/(registry|agent-names)\\.json\\..*\\.tmp$/.test(String(args[0]));
      const fail = () => { throw Object.assign(new Error(selected.code + ': fixture private write'), { code: selected.code }); };
      if (temporary && selected?.stage === 'open') fail();
      const handle = await open(...args);
      if (temporary && selected) handle[selected.stage] = async () => fail();
      return handle;
    };
    syncBuiltinESMExports();
    (await import(${JSON.stringify(new URL('../storage/process.ts', import.meta.url).href)})).runSessionStorage();
  `, { mode: 0o600 })
  storage = (await import('./sessionStorage.js')).sessionStorage
  const { fingerprint } = await import('../harnessd/bundleFingerprint.js')
  // Source entry keeps the ordinary TSX loader while pinning this exact failure fixture.
  ;(storage as unknown as { entry: () => unknown }).entry = () => ({ file: entry, sha256: fingerprint(entry)!, execArgv: ['--import', import.meta.resolve('tsx')] })
  registry = (await import('./registry.js')).registry
  AtomicWriteUnconfirmed = (await import('./registryPersistence.js')).AtomicWriteUnconfirmed
  await registry.load()
  await registry.openProcessAgent(input)
  await registry.flush()
})
afterEach(async () => {
  rmSync(fault, { force: true })
  refuse.directorySync = undefined
  try { await registry.flush().catch(() => {}) }
  finally {
    try { await storage.close() }
    finally { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) }
  }
})

it.each(['EACCES', 'ENOSPC'])('a save refused with %s logs that code, and no path', async (code) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  writeFileSync(fault, JSON.stringify({ stage: 'open', code }))
  registry.setActive(input.agentId, false) // save(): logged, never thrown
  await registry.flush().catch(() => {})
  const lines = error.mock.calls.map((call) => call.map(String).join(' '))
  expect(lines).toContain(`[registry] save failed · SessionStorageUnavailable ${code}`)
  expect(lines.join('\n')).not.toContain(directory)
})

it.each(['ENOSPC', 'EROFS'])('a strict save refused with %s keeps the disk code for the log, off the message', async (code) => {
  writeFileSync(fault, JSON.stringify({ stage: 'open', code }))
  const failure = await registry.transaction(() => { registry.setActive(input.agentId, false) }).catch((error: Error) => error)
  expect(errorKind(failure)).toBe(`RegistryPersistenceUnavailable ${code}`)
  expect((failure as { code?: unknown }).code).toBeUndefined()
})

it('a names save refused with ENOSPC logs the type and the disk code', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await registry.rename(input.agentId, 'Chosen name')
  writeFileSync(fault, JSON.stringify({ stage: 'open', code: 'ENOSPC' }))
  // An inherited name has no request to answer: saveNames() logs its failure, never throws it.
  registry.inheritName(input.agentId, 'next-session')
  await registry.flush().catch(() => {})
  expect(error.mock.calls.map((call) => call.map(String).join(' ')))
    .toContain('[registry] save names failed · RegistryPersistenceUnavailable ENOSPC')
})

it.each([
  ['ENOSPC', 'registry storage has no available space (ENOSPC)'],
  ['EDQUOT', 'registry storage has no available space (EDQUOT)'],
  ['EROFS', 'registry storage is read-only (EROFS)'],
])('a strict save refused with %s says so in words the master reads as the disk', async (code, words) => {
  writeFileSync(fault, JSON.stringify({ code, stage: 'writeFile' }), { mode: 0o600 })
  // The core's own startup save (core/main.ts): every row marked dormant, in one transaction.
  const failure = await registry.transaction(() => { registry.setActive(input.agentId, false) }).catch((error: Error) => error)
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe(`Registry persistence unavailable: ${words}`)
  expect(namesTheDisk((failure as Error).message)).toBe(true)
  expect((failure as Error).message).not.toContain(directory)
})

it.each([['EIO', 'registry storage write failed'], ['EACCES', 'registry storage access was refused'], ['EPERM', 'registry storage access was refused']])(
  'a save refused with %s still does not name the disk', async (code, words) => {
    writeFileSync(fault, JSON.stringify({ code, stage: 'writeFile' }), { mode: 0o600 })
    const failure = await registry.transaction(() => { registry.setActive(input.agentId, false) }).catch((error: Error) => error)
    expect((failure as Error).message).toBe(`Registry persistence unavailable: ${words}`)
    expect(namesTheDisk((failure as Error).message)).toBe(false)
  })

it.each([
  ['ENOSPC', 'has no available space (ENOSPC)'],
  ['EDQUOT', 'has no available space (EDQUOT)'],
  ['EROFS', 'is read-only (EROFS)'],
])('a save left unconfirmed by %s after its rename still names the disk', async (code, words) => {
  refuse.directorySync = code
  const rows = await registry.transaction(() => { registry.setActive(input.agentId, false) }).catch((error: Error) => error)
  const names = await registry.rename(input.agentId, 'Renamed').catch((error: Error) => error)
  for (const [failure, subject] of [[rows, 'registry storage'], [names, 'name storage']] as const) {
    expect(failure).toBeInstanceOf(AtomicWriteUnconfirmed)
    expect((failure as Error).message).toBe(`Registry persistence unavailable: ${subject} ${words}`)
    expect(namesTheDisk((failure as Error).message)).toBe(true)
    expect((failure as Error).message).not.toContain(directory)
  }
})

it.each(['open', 'chmod', 'sync'])('preserves the disk category when the child temporary %s fails', async stage => {
  writeFileSync(fault, JSON.stringify({ code: 'ENOSPC', stage }), { mode: 0o600 })
  const failure = await registry.transaction(() => { registry.setActive(input.agentId, false) }).catch((error: Error) => error)
  expect((failure as Error).message).toBe('Registry persistence unavailable: registry storage has no available space (ENOSPC)')
  expect(namesTheDisk((failure as Error).message)).toBe(true)
  expect((failure as Error).message).not.toContain(directory)
  rmSync(fault)
  await registry.flush()
  expect(await storage.read({ kind: 'registry' })).toMatchObject({ state: 'image' })
})
