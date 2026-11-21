import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { fingerprint } from '../harnessd/bundleFingerprint.js'
import { creationFingerprint } from '../lib/agentCreationReceipt.js'
import { SessionStorage } from '../lib/sessionStorage.js'
import type { PendingCreationPage } from '../lib/pendingCreationWire.js'
import type { SessionStorageOperation } from '../lib/sessionStorageWire.js'

let root: string, directory: string, storage: SessionStorage
const id = 'directory-process-fixture', request = { fixture: true }, held = { service: 'models', detail: 'Waiting.' }
const hash = creationFingerprint(request), checksum = creationFingerprint({ fingerprint: hash, request, held })
const pending = { version: 2, fingerprint: hash, request, held, checksum }
const terminal = { version: 1, fingerprint: hash, outcome: { state: 'created', agentId: 'fixture' } }
const child = () => (storage as unknown as { child?: ChildProcess }).child
const operation = <T>(value: SessionStorageOperation) => (storage as unknown as { request(value: SessionStorageOperation): Promise<T> }).request(value)
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pending-directory-process-')); directory = join(root, 'agent-creations')
  useEntry(fileURLToPath(new URL('./entry.ts', import.meta.url)))
})
afterEach(async () => { try { await storage.close() } finally { rmSync(root, { recursive: true, force: true }) } })
function useEntry(file: string) {
  storage = new SessionStorage(root, () => ({ file, sha256: fingerprint(file)!, execArgv: ['--import', import.meta.resolve('tsx')] }))
}
function write(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }) }
function seed(path = directory, value: unknown = pending, key = id) {
  mkdirSync(path, { recursive: true, mode: 0o700 }); write(join(path, `${key}.json`), value)
}
async function found() { const ids = new Set<string>(); for await (const value of storage.creations.scan()) if (value) ids.add(value); return [...ids].sort() }

type Fault = 'admission-close' | 'primary-iterator' | 'marker-iterator' | 'claim' | 'result' | 'hold'
  | 'bind-refused' | 'bind-replaced' | 'cwd-lost' | 'count-classification' | 'none'
function fixture(fault: Fault, initialCwd?: string) {
  const file = join(root, 'directory-fixture.mjs'), evidence = join(root, 'directory-evidence.json')
  // Filesystem faults live inside the real admitted child. The Vitest worker never changes cwd.
  writeFileSync(file, `
    import fs from 'node:fs';
    import asyncFs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { childAdmissionFailure } from ${JSON.stringify(new URL('../harnessd/childAdmission.ts', import.meta.url).href)};
    if (childAdmissionFailure(process.env, process.ppid, process.argv[1])) process.exit(2);
    if (${JSON.stringify(initialCwd ?? null)}) process.chdir(${JSON.stringify(initialCwd ?? null)});
    const directory = ${JSON.stringify(directory)}, alternate = ${JSON.stringify(join(root, 'alternate'))};
    const displaced = ${JSON.stringify(join(root, 'displaced'))}, evidence = ${JSON.stringify(evidence)};
    const fault = ${JSON.stringify(fault)}, id = ${JSON.stringify(id)};
    const original = fs.existsSync(directory) ? fs.statSync(directory, { bigint: true }).ino : null;
    const notes = { swapped: false, restored: false, reads: [], entries: [], closed: [], changes: 0, classificationChecks: [], primaryOpens: [] };
    const save = () => fs.writeFileSync(evidence, JSON.stringify(notes), { mode: 0o600 });
    const chdir = process.chdir.bind(process);
    let refused = false;
    process.chdir = path => {
      if (fault === 'bind-refused' && !refused) { refused = true; throw Object.assign(new Error('fixture chdir refused'), { code: 'EACCES' }); }
      if (fault === 'bind-replaced') swap();
      chdir(path); notes.changes++; save();
      if (fault === 'bind-replaced') restore();
    };
    const swap = () => {
      if (notes.swapped) return;
      fs.renameSync(directory, displaced); fs.renameSync(alternate, directory);
      notes.swapped = true; save();
    };
    const restore = () => {
      if (!notes.swapped || notes.restored) return;
      fs.renameSync(directory, alternate); fs.renameSync(displaced, directory);
      notes.restored = true; save();
    };
    const open = fs.openSync, close = fs.closeSync, opendir = asyncFs.opendir, lstat = fs.lstatSync;
    let classificationChecks = null;
    fs.lstatSync = (...args) => {
      const value = lstat(...args);
      if (classificationChecks && args[1]?.bigint && (args[0] === '.' || args[0] === directory)) {
        classificationChecks.push(args[0] === '.' ? 'cwd' : 'absolute');
      }
      // Metadata-only admission no longer closes a temporary directory descriptor.
      // Replace the absolute name at the same post-admission boundary, before the primary opens.
      if (fault === 'admission-close' && classified && !args[1]?.bigint && value?.isDirectory()
        && lstat(args[0], { bigint: true }).ino === original && !notes.swapped) swap();
      return value;
    };
    const files = new Map();
    let classified = false;
    fs.openSync = (...args) => {
      const path = String(args[0]);
      const part = path.endsWith(id + '.json.claim') ? 'claim' : path.endsWith(id + '.json.result') ? 'result'
        : path.endsWith(id + '.hold') ? 'hold' : path.endsWith(id + '.json') ? 'primary' : null;
      if ((part === 'primary' || fault === 'count-classification' && path.split('/').pop().startsWith('directory-proof-fixture-') && path.endsWith('.json')) && classificationChecks) {
        notes.classificationChecks.push(classificationChecks); classificationChecks = null; save();
      }
      if (part === fault && !notes.swapped) swap();
      try {
        if (part === 'primary') { notes.primaryOpens.push(notes.swapped && !notes.restored); save(); }
        const fd = open(...args);
        if (part) {
          const originalFile = (notes.swapped && !notes.restored ? displaced : directory)
            + '/' + (part === 'primary' ? id + '.json' : part === 'hold' ? id + '.hold' : id + '.json.' + part);
          const from = fs.existsSync(originalFile) && fs.fstatSync(fd, { bigint: true }).ino === fs.statSync(originalFile, { bigint: true }).ino ? 'original' : 'alternate';
          notes.reads.push({ part, from }); files.set(fd, part); save();
        }
        return fd;
      } catch (error) {
        if (part === fault && error.code === 'ENOENT') {
          notes.reads.push({ part, from: fs.statSync('.', { bigint: true }).ino === original ? 'original-missing' : 'alternate-missing' }); save();
        }
        if (part === fault) restore();
        throw error;
      }
    };
    fs.closeSync = fd => {
      const part = files.get(fd); files.delete(fd);
      close(fd);
      if (notes.swapped && !notes.restored && (fault === 'admission-close' && part === 'primary' || part === fault)) restore();
    };
    asyncFs.opendir = async (...args) => {
      const path = String(args[0]);
      const which = path === directory || path === '.' ? 'primary' : path.endsWith('.pending-v1') ? 'marker' : null;
      const replace = fault === which + '-iterator' && !notes.swapped;
      if (replace) swap();
      let dir;
      try { dir = await opendir(...args); } finally { if (replace) restore(); }
      const read = dir.read.bind(dir), close = dir.closeSync.bind(dir);
      dir.read = async () => {
        const entry = await read();
        if (entry && which) {
          notes.entries.push({ which, name: entry.name }); save();
          if (fault === 'count-classification' && which === 'primary' && entry.name.endsWith('.json')) classificationChecks = [];
          if (which === 'primary' && entry.name === id + '.json') {
            classified = true;
            if (fault === 'cwd-lost' && !notes.swapped) { chdir(alternate); notes.swapped = true; save(); }
          }
        }
        return entry;
      };
      dir.closeSync = () => { close(); notes.closed.push(which); save(); };
      return dir;
    };
    syncBuiltinESMExports(); save();
    (await import(${JSON.stringify(new URL('./process.ts', import.meta.url).href)})).runSessionStorage();
  `, { mode: 0o600 })
  useEntry(file)
  return () => JSON.parse(readFileSync(evidence, 'utf8')) as {
    swapped: boolean; restored: boolean; changes: number; reads: Array<{ part: string; from: string }>;
    entries: Array<{ which: string; name: string }>; closed: string[]; classificationChecks: string[][]; primaryOpens: boolean[]
  }
}

it('uses one fresh directory proof per classified receipt in the actual child', async () => {
  for (let n = 0; n < 32; n++) seed(directory, terminal, `directory-proof-fixture-${n}`)
  const evidence = fixture('count-classification')
  expect(await found()).toEqual([])
  const observed = evidence()
  expect(observed.classificationChecks).toHaveLength(32)
  expect(observed.classificationChecks).toEqual(Array.from({ length: 32 }, () => ['cwd', 'absolute']))
  expect(observed.closed).toEqual(['primary'])
  expect(observed.changes).toBe(1)
})

it.skipIf(process.platform === 'win32')('keeps a pending primary after directory admission and an absolute replacement', async () => {
  seed(); seed(join(root, 'alternate'), terminal)
  const evidence = fixture('admission-close')
  expect(await found()).toEqual([id])
  expect(evidence()).toMatchObject({ swapped: true, restored: true, changes: 1 })
  expect(evidence().primaryOpens[0]).toBe(true)
  expect(evidence().reads).toContainEqual({ part: 'primary', from: 'original' })
  expect(evidence().reads).not.toContainEqual({ part: 'primary', from: 'alternate' })
  expect(evidence().closed).toContain('primary')
  expect(JSON.parse(readFileSync(join(directory, `${id}.json`), 'utf8'))).toEqual(pending)
})

it.skipIf(process.platform === 'win32').each(['primary', 'marker'] as const)('opens the %s iterator on the pinned directory during an awaited absolute replacement', async which => {
  seed(); seed(join(root, 'alternate'), terminal, 'alternate-process-fixture')
  for (const path of [directory, join(root, 'alternate')]) mkdirSync(join(path, '.pending-v1'), { mode: 0o700 })
  writeFileSync(join(directory, '.pending-v1', id), '', { mode: 0o600 })
  const evidence = fixture(`${which}-iterator`)
  expect(await found()).toEqual([id])
  expect(evidence().entries).toContainEqual({ which, name: which === 'primary' ? `${id}.json` : id })
  expect(evidence().closed).toEqual(expect.arrayContaining(['primary', 'marker']))
  expect(evidence()).toMatchObject({ swapped: true, restored: true, changes: 1 })
})

it.skipIf(process.platform === 'win32').each(['claim', 'result', 'hold'] as const)('keeps %s classification evidence in the pinned directory', async part => {
  seed(); seed(join(root, 'alternate'))
  const claim = { fingerprint: hash, token: 'fixture-token', kind: 'dispatch' }
  if (part === 'claim') {
    write(join(root, 'alternate', `${id}.json.claim`), claim)
  } else if (part === 'result') {
    for (const path of [directory, join(root, 'alternate')]) write(join(path, `${id}.json.claim`), claim)
    write(join(directory, `${id}.json.result`), { ...claim, outcome: { state: 'created', agentId: 'fixture' } })
    write(join(root, 'alternate', `${id}.json.result`), { ...claim, token: 'wrong-token', outcome: { state: 'created', agentId: 'fixture' } })
  } else {
    write(join(directory, `${id}.hold`), { checksum, held })
    write(join(root, 'alternate', `${id}.hold`), { checksum, held: { service: 'fixture', detail: 'Other.' } })
  }
  const evidence = fixture(part)
  const page = await operation<PendingCreationPage>({ kind: 'creation-page', cursor: null })
  expect(page.damaged).toBe(0)
  expect(page.ids).toEqual(part === 'result' ? [] : [id])
  expect(evidence().reads).toContainEqual({ part, from: part === 'claim' ? 'original-missing' : 'original' })
  expect(evidence().reads).not.toContainEqual({ part, from: 'alternate' })
  expect(evidence()).toMatchObject({ swapped: true, restored: true, changes: 1 })
  await operation({ kind: 'creation-close', cursor: page.cursor })
})

it.skipIf(process.platform === 'win32').each(['creation-page', 'creation-ensure'] as const)('reaps permanent lost binding before a fresh %s can adopt a replacement', async kind => {
  seed(); expect(await found()).toEqual([id])
  const previous = child()!; let exited = false
  previous.once('exit', () => { exited = true })
  renameSync(directory, join(root, 'displaced')); seed(directory, pending, 'replacement-process-fixture')
  await expect(operation(kind === 'creation-page' ? { kind, cursor: null } : { kind, id })).rejects.toMatchObject({ code: 'disconnected' })
  expect(exited).toBe(true); expect(child()).toBeUndefined()
  expect(existsSync(join(directory, '.pending-v1', id))).toBe(false)
  expect(() => process.kill(previous.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  expect(await found()).toEqual(['replacement-process-fixture'])
  expect(child()?.pid).not.toBe(previous.pid)
})

it('leaves missing creation storage absent and unrelated reads usable before its first successful bind', async () => {
  const evidence = fixture('none')
  expect(await found()).toEqual([])
  const previous = child()
  expect(existsSync(directory)).toBe(false)
  expect(evidence().changes).toBe(0)
  expect(await storage.read({ kind: 'registry' })).toEqual({ state: 'missing' })
  await storage.creations.ensure(id)
  expect(evidence().changes).toBe(1); expect(child()).toBe(previous)
  expect(await found()).toEqual([])
  expect(evidence().changes).toBe(1)
})

it.skipIf(process.platform === 'win32').each(['writable', 'file', 'symlink'] as const)('keeps unrelated reads available after refusing an unsafe %s creation directory', async kind => {
  if (kind === 'writable') { mkdirSync(directory, { mode: 0o700 }); chmodSync(directory, 0o777) }
  else if (kind === 'file') writeFileSync(directory, '', { mode: 0o600 })
  else { mkdirSync(join(root, 'alternate'), { mode: 0o700 }); symlinkSync(join(root, 'alternate'), directory) }
  const evidence = fixture('none')
  expect(await storage.read({ kind: 'registry' })).toEqual({ state: 'missing' })
  const previous = child()
  await expect(found()).rejects.toThrow()
  expect(await storage.read({ kind: 'registry' })).toEqual({ state: 'missing' })
  expect(evidence().changes).toBe(0); expect(child()).toBe(previous)
  rmSync(directory, { recursive: true }); seed()
  expect(await found()).toEqual([id]); expect(child()).toBe(previous)
  expect(evidence().changes).toBe(1)
})

it('keeps a healthy bound child after refusing an ordinary stale cursor', async () => {
  seed(); expect(await found()).toEqual([id])
  const previous = child()
  await expect(operation({ kind: 'creation-page', cursor: '00000000-0000-0000-0000-000000000000' })).rejects.toMatchObject({ code: 'changed' })
  expect(await found()).toEqual([id]); expect(child()).toBe(previous)
})

it('keeps unrelated storage and a later first bind available after chdir itself is refused', async () => {
  seed(); const evidence = fixture('bind-refused')
  expect(await storage.read({ kind: 'registry' })).toEqual({ state: 'missing' })
  const previous = child()
  await expect(found()).rejects.toThrow()
  expect(child()).toBe(previous); expect(evidence().changes).toBe(0)
  expect(await storage.read({ kind: 'registry' })).toEqual({ state: 'missing' })
  expect(await found()).toEqual([id]); expect(evidence().changes).toBe(1)
  expect(child()).toBe(previous)
})

it.skipIf(process.platform === 'win32').each(['bind-replaced', 'cwd-lost'] as const)('retires after %s even when the configured absolute directory is original', async fault => {
  seed(); seed(join(root, 'alternate'), terminal)
  const evidence = fixture(fault)
  expect(await storage.read({ kind: 'registry' })).toEqual({ state: 'missing' })
  const previous = child()!; let exited = false
  previous.once('exit', () => { exited = true })
  await expect(found()).rejects.toMatchObject({ code: 'disconnected' })
  expect(exited).toBe(true); expect(child()).toBeUndefined()
  expect(evidence()).toMatchObject({ swapped: true, changes: 1 })
  expect(existsSync(join(directory, '.pending-v1', id))).toBe(false)
})

it.each([false, true])('preserves a legacy relative cwd after binding, realpath target exists: %s', async exists => {
  const originalCwd = join(realpathSync.native(root), 'launch'), project = join(originalCwd, 'project')
  mkdirSync(originalCwd, { mode: 0o700 }); if (exists) mkdirSync(project, { mode: 0o700 })
  seed(); fixture('none', originalCwd)
  mkdirSync(join(root, 'stopped-agents'), { mode: 0o700 })
  write(join(root, 'stopped-agents', 'fixture.json'), { version: 1, session: {
    agentId: 'fixture', schemaVersion: 2, engine: 'codex', sessionId: 'fixture-session', cwd: 'project',
  } })
  const query = { kind: 'folder' as const, root: project, exceptAgentId: 'other' }
  expect((await storage.stoppedQuery(query)).matches).toEqual([true])
  expect(await found()).toEqual([id])
  expect((await storage.stoppedQuery(query)).matches).toEqual([true])
})

it.each([false, true])('preserves Codex home comparison and original profile strings, refuses relative default: %s', async relativeDefault => {
  const originalCwd = join(realpathSync.native(root), 'launch'); mkdirSync(originalCwd, { mode: 0o700 })
  seed(); fixture('none', originalCwd)
  mkdirSync(join(root, 'stopped-agents'), { mode: 0o700 })
  for (const [agentId, codexHome] of [['default-profile', relativeDefault ? join(originalCwd, 'codex') : 'codex'], ['other-profile', './other-codex']]) {
    write(join(root, 'stopped-agents', `${agentId}.json`), { version: 1, session: {
      agentId, schemaVersion: 2, engine: 'codex', sessionId: agentId, codexHome,
    } })
  }
  const query = { kind: 'owners' as const, keys: ['codex\0\0\0default-profile', 'codex\0./other-codex\0\0other-profile'],
    defaultCodexHome: relativeDefault ? 'codex' : join(originalCwd, 'codex') }
  if (relativeDefault) await expect(storage.stoppedQuery(query)).rejects.toMatchObject({ code: 'invalid' })
  else expect((await storage.stoppedQuery(query)).matches).toEqual([true, true])
  expect(await found()).toEqual([id])
  if (relativeDefault) await expect(storage.stoppedQuery(query)).rejects.toMatchObject({ code: 'invalid' })
  else expect((await storage.stoppedQuery(query)).matches).toEqual([true, true])
})
