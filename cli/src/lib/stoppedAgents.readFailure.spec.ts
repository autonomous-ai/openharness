/** A bad archive must not hide readable peers; selected actions still report their exact failure. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { registry as Registry } from './registry.js'
import type { sessionStorage as Storage } from './sessionStorage.js'
import type { stoppedAgents as Stopped } from './stoppedAgents.js'

let root: string, fault: string, registry: typeof Registry, storage: typeof Storage, stopped: typeof Stopped
beforeEach(async () => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'stopped-read-failure-'))
  for (const name of ['home', 'data', 'runtime']) mkdirSync(join(root, name), { mode: 0o700 })
  for (const [name, value] of Object.entries({ HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
    CLAUDE_PROJECTS_DIR: join(root, 'home', '.claude'), CODEX_HOME: join(root, 'home', '.codex') })) vi.stubEnv(name, value)
  fault = join(root, 'read-code.json')
  const entry = join(root, 'storage-read-fixture.mjs'), damaged = join(root, 'data', 'stopped-agents', 'damaged.json')
  writeFileSync(entry, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { childAdmissionFailure } from ${JSON.stringify(new URL('../harnessd/childAdmission.ts', import.meta.url).href)};
    if (childAdmissionFailure(process.env, process.ppid, process.argv[1])) process.exit(2);
    const read = fs.readSync;
    fs.readSync = (...args) => {
      let code;
      try { code = JSON.parse(fs.readFileSync(${JSON.stringify(fault)}, 'utf8')); } catch {}
      if (code && fs.fstatSync(args[0]).ino === fs.statSync(${JSON.stringify(damaged)}).ino) {
        throw Object.assign(new Error('fixture unreadable private image'), { code });
      }
      return read(...args);
    };
    syncBuiltinESMExports();
    (await import(${JSON.stringify(new URL('../storage/process.ts', import.meta.url).href)})).runSessionStorage();
  `, { mode: 0o600 })
  storage = (await import('./sessionStorage.js')).sessionStorage
  const { fingerprint } = await import('../harnessd/bundleFingerprint.js')
  ;(storage as unknown as { entry: () => unknown }).entry = () => ({ file: entry, sha256: fingerprint(entry)!, execArgv: ['--import', import.meta.resolve('tsx')] })
  registry = (await import('./registry.js')).registry
  stopped = (await import('./stoppedAgents.js')).stoppedAgents
  await registry.load()
  const row = (await registry.openPendingAgent({ agentId: 'fixture', engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }], cwd: root }))!
  for (const agentId of ['damaged', 'readable']) await stopped.save({ ...row, agentId, sessionId: `conversation-${agentId}` })
  await registry.flush()
})
afterEach(async () => {
  rmSync(fault, { force: true })
  try { await registry.flush() }
  finally {
    try { await storage.close() }
    finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) }
  }
})

it.each(['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM'])(
  'keeps readable saved work visible when one archive read reports %s', async code => {
    writeFileSync(fault, JSON.stringify(code), { mode: 0o600 })
    expect((await stopped.list()).map(row => row.agentId)).toEqual(['readable'])
    await expect(stopped.get('damaged')).rejects.toMatchObject({ code })
    await expect(stopped.query({ kind: 'conversations', ids: ['conversation-damaged'], reservations: false })).rejects.toMatchObject({ code })
    rmSync(fault)
    const fresh = await stopped.list()
    expect(fresh.map(row => row.agentId).sort()).toEqual(['damaged', 'readable'])
    expect(fresh.every(row => stopped.current(row))).toBe(true)
  })
