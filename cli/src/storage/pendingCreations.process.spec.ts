import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { fingerprint } from '../harnessd/bundleFingerprint.js'
import { creationFingerprint } from '../lib/agentCreationReceipt.js'
import { SessionStorage } from '../lib/sessionStorage.js'

let root: string, directory: string, storage: SessionStorage
const id = 'pending-process-fixture', request = { privateText: 'never sent in a discovery frame' }
const hash = creationFingerprint(request), held = { service: 'models', detail: 'Waiting.' }
const child = () => (storage as unknown as { child?: ChildProcess }).child
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pending-process-')); directory = join(root, 'agent-creations')
  useEntry(fileURLToPath(new URL('./entry.ts', import.meta.url)))
})
afterEach(async () => { try { await storage.close() } finally { rmSync(root, { recursive: true, force: true }) } })
function useEntry(file: string) {
  storage = new SessionStorage(root, () => ({ file, sha256: fingerprint(file)!, execArgv: ['--import', import.meta.resolve('tsx')] }))
}
function seed(key = id, pending = true) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const value = pending ? { version: 2, fingerprint: hash, request, held, checksum: creationFingerprint({ fingerprint: hash, request, held }) }
    : { version: 1, fingerprint: hash, outcome: { state: 'created', agentId: 'fixture' } }
  writeFileSync(join(directory, `${key}.json`), JSON.stringify(value), { mode: 0o600 })
}
async function found() { const ids = new Set<string>(); for await (const value of storage.creations.scan()) if (value) ids.add(value); return [...ids].sort() }
function injectCloseFault(kind: 'marker' | 'receipt' | 'iterator') {
  const file = join(root, 'pending-close-fixture.mjs')
  const target = kind === 'marker' ? join(directory, '.pending-v1', id) : join(directory, `${id}.json`)
  writeFileSync(file, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { childAdmissionFailure } from ${JSON.stringify(new URL('../harnessd/childAdmission.ts', import.meta.url).href)};
    if (childAdmissionFailure(process.env, process.ppid, process.argv[1])) process.exit(2);
    const close = fs.closeSync;
    fs.closeSync = fd => {
      if (${JSON.stringify(kind)} !== 'iterator' && fs.existsSync(${JSON.stringify(target)})
        && fs.fstatSync(fd).ino === fs.statSync(${JSON.stringify(target)}).ino) throw new Error('fixture close uncertainty');
      return close(fd);
    };
    if (${JSON.stringify(kind)} === 'iterator') fs.Dir.prototype.closeSync = () => { throw new Error('fixture iterator close uncertainty') };
    syncBuiltinESMExports();
    (await import(${JSON.stringify(new URL('./process.ts', import.meta.url).href)})).runSessionStorage();
  `, { mode: 0o600 })
  useEntry(file)
}

it('keeps discovery and marker publication in the real child while finding later legacy writers', async () => {
  seed()
  expect(await found()).toEqual([id])
  expect(child()?.pid).not.toBe(process.pid)
  expect(statSync(join(directory, '.pending-v1', id)).size).toBe(0)
  seed(`${id}-later`)
  expect(await found()).toEqual([id, `${id}-later`])
  await storage.creations.ensure(`${id}-new`)
  expect(existsSync(join(directory, `${id}-new.json`))).toBe(false)
  await expect(storage.creations.ensure('../escape')).rejects.toMatchObject({ code: 'invalid' })
})

it('rejects the old scan after actual child exit and recovers with a fresh cursor', async () => {
  seed(); await storage.creations.ensure(id)
  for (let n = 0; n < 140; n++) seed(`${id}-${n}`, false)
  const scan = storage.creations.scan()
  expect(await scan.next()).toMatchObject({ value: id, done: false })
  const previous = child()!, exited = new Promise<void>(resolve => previous.once('exit', () => resolve()))
  previous.kill('SIGKILL'); await exited
  expect(child()).toBeUndefined()
  await expect((async () => { for await (const _id of scan) { /* Exhaust the bounded received page. */ } })()).rejects.toMatchObject({ code: 'changed' })
  expect(await found()).toEqual([id])
  expect(child()?.pid).not.toBe(previous.pid)
})

it.each(['marker', 'receipt', 'iterator'] as const)('reaps the real child before releasing uncertain %s custody', async kind => {
  seed(); injectCloseFault(kind)
  const reading = kind === 'marker' ? storage.creations.ensure(id) : found()
  const owner = child()!; let exited = false
  owner.once('exit', () => { exited = true })
  await expect(reading).rejects.toMatchObject({ code: 'disconnected' })
  expect(exited).toBe(true); expect(child()).toBeUndefined()
  expect(existsSync(join(directory, `${id}.json`))).toBe(true)
})
