import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { fingerprint } from '../harnessd/bundleFingerprint.js'
import { closeSessionStorageFixture } from '../testing/sessionStorageFixture.js'
import { SessionStorage } from './sessionStorage.js'
import { stoppedArchiveWitness } from './stoppedAuthorityMetadata.js'
import type { StoppedArchiveQuery } from './sessionStorageWire.js'

let root: string, directory: string, replacement: string, storage: SessionStorage
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-authority-'))
  directory = join(root, 'stopped-agents'); replacement = join(root, 'replacement')
  mkdirSync(directory, { mode: 0o700 }); mkdirSync(replacement, { mode: 0o700 })
  const file = fileURLToPath(new URL('../storage/entry.ts', import.meta.url))
  storage = new SessionStorage(root, () => ({ file, sha256: fingerprint(file)!, execArgv: ['--import', import.meta.resolve('tsx')] }))
})
afterEach(async () => {
  await closeSessionStorageFixture(storage)
  rmSync(root, { recursive: true, force: true })
})
const write = (folder: string, agentId: string, sessionId: string, title = 'Original') => writeFileSync(join(folder, `${agentId}.json`),
  JSON.stringify({ version: 1, session: { schemaVersion: 2, agentId, registeredAt: 1, engine: 'claude', sessionId, title } }), { mode: 0o600 })

function replaceBetweenWitnesses(): void {
  const file = join(root, 'storage-authority-fixture.mjs')
  const processModule = new URL('../storage/process.ts', import.meta.url).href
  const admissionModule = new URL('../harnessd/childAdmission.ts', import.meta.url).href
  // Real queries, row bytes, page fences and final parent current(). Only this private namespace swaps.
  writeFileSync(file, `
    import fs from 'node:fs/promises';
    import syncFs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { childAdmissionFailure } from ${JSON.stringify(admissionModule)};
    if (childAdmissionFailure(process.env, process.ppid, process.argv[1])) process.exit(2);
    const open = fs.opendir;
    let injected = false;
    fs.opendir = async (...args) => {
      const directory = await open(...args);
      if (args[0] === ${JSON.stringify(directory)} && !injected) {
        injected = true;
        syncFs.renameSync(${JSON.stringify(directory)}, ${JSON.stringify(directory + '-held')});
        syncFs.renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(directory)});
        const close = directory.close.bind(directory);
        directory.close = async () => {
          try { return await close(); }
          finally {
            syncFs.renameSync(${JSON.stringify(directory)}, ${JSON.stringify(replacement)});
            syncFs.renameSync(${JSON.stringify(directory + '-held')}, ${JSON.stringify(directory)});
            syncFs.writeFileSync(${JSON.stringify(join(root, 'restored'))}, 'yes', { mode: 0o600 });
          }
        };
      }
      return directory;
    };
    syncBuiltinESMExports();
    (await import(${JSON.stringify(processModule)})).runSessionStorage();
  `, { mode: 0o600 })
  storage = new SessionStorage(root, () => ({ file, sha256: fingerprint(file)!, execArgv: ['--import', import.meta.resolve('tsx')] }))
}

it.each(['absence', 'selected'] as const)('refuses %s authority from a replaced directory restored after its page closes', async purpose => {
  write(directory, 'fixture', 'asked')
  write(replacement, 'fixture', purpose === 'absence' ? 'other' : 'asked', 'Replacement')
  const before = stoppedArchiveWitness(directory)
  replaceBetweenWitnesses()
  const query: StoppedArchiveQuery = purpose === 'absence'
    ? { kind: 'conversations', ids: ['asked'], reservations: false }
    : { kind: 'owners', keys: ['claude\0\0\0asked'], defaultCodexHome: join(root, 'codex') }
  const outcome = await storage.stoppedQuery(query).then(answer => ({
    accepted: true, current: answer.current(), matching: answer.matches[0],
    replacementSelected: answer.selected?.some(image => image.state === 'image' && image.json
      && (image.value as { session: { title: string } }).session.title === 'Replacement') ?? false,
  }), error => ({ accepted: false, code: error.code }))
  expect(readFileSync(join(root, 'restored'), 'utf8')).toBe('yes')
  expect(stoppedArchiveWitness(directory) === before).toBe(true)
  expect(outcome).toEqual({ accepted: false, code: 'changed' })
})

it('keeps excluded records in final metadata authority while ignoring unrelated non-JSON entries', async () => {
  write(directory, 'excluded', 'asked'); write(directory, 'peer', 'asked')
  writeFileSync(join(directory, 'unrelated.tmp'), '{not-json', { mode: 0o600 })
  const answer = await storage.stoppedQuery({ kind: 'conversations', ids: ['asked'], reservations: false, exceptAgentId: 'excluded' })
  expect(answer.matches).toEqual([true]); expect(answer.current()).toBe(true)
  writeFileSync(join(directory, 'another.claim'), '{not-json', { mode: 0o600 })
  expect(answer.current()).toBe(true)
  write(directory, 'excluded', 'asked', 'Changed excluded metadata')
  expect(answer.current()).toBe(false)
})

it('covers every requested conversation across complete bounded pages and non-JSON entries', async () => {
  const ids = Array.from({ length: 65 }, (_, index) => `conversation-${index}`)
  for (let index = 0; index < ids.length; index++) {
    write(directory, `row-${index}`, ids[index])
    writeFileSync(join(directory, `temporary-${index}.tmp`), '', { mode: 0o600 })
  }
  const answer = await storage.stoppedQuery({ kind: 'conversations', ids, reservations: false })
  expect(answer.matches).toEqual(ids.map(() => true)); expect(answer.current()).toBe(true)
})
