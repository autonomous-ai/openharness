import type { ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fingerprint } from '../harnessd/bundleFingerprint.js'
import { SessionStorage } from './sessionStorage.js'
import { sessionFileIdentity } from './sessionStorageWire.js'
import type { SessionStorageOperation } from './sessionStorageWire.js'
import { ownSessionStorage } from '../harnessd/sessionStorageOwner.js'
import type { ExecutionArtifact } from '../harnessd/executionArtifacts.js'

vi.mock('node:fs', async original => ({ ...await original<object>() }))

let root: string
let storage: SessionStorage
let key: string
let expectedCloseFailure: boolean
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-storage-'))
  key = randomUUID()
  expectedCloseFailure = false
  const file = fileURLToPath(new URL('../storage/entry.ts', import.meta.url))
  storage = new SessionStorage(root, () => ({ file, sha256: fingerprint(file)!, execArgv: ['--import', import.meta.resolve('tsx')] }))
})
afterEach(async () => {
  try { await storage.close() } catch (error) { if (!expectedCloseFailure) throw error }
  finally { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) }
})

const override = () => ({ networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://grid.example.test/v1', apiKey: key })
const row = () => ({ agentId: 'fixture-agent', registeredAt: 1, title: 'fixture', gridLaunch: override() })
const containsKey = (value: unknown) => JSON.stringify(value).includes(key)

function faultChild(fault: 'after-sync' | 'replace-before-open' | 'directory-close' | 'file-close'): void {
  const file = join(root, 'storage-fixture.mjs')
  const processModule = new URL('../storage/process.ts', import.meta.url).href
  const admissionModule = new URL('../harnessd/childAdmission.ts', import.meta.url).href
  // The real child/codec runs. Only this fixture's filesystem prefix injects a deterministic failure.
  writeFileSync(file, `
    import fs from 'node:fs/promises';
    import syncFs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { childAdmissionFailure } from ${JSON.stringify(admissionModule)};
    if (childAdmissionFailure(process.env, process.ppid, process.argv[1])) process.exit(2);
    const closeSync = syncFs.closeSync;
    let directoryFault = false;
    syncFs.closeSync = fd => {
      if (!directoryFault && (${JSON.stringify(fault)} === 'directory-close' && syncFs.fstatSync(fd).isDirectory()
        || ${JSON.stringify(fault)} === 'file-close' && syncFs.fstatSync(fd).isFile())) {
        directoryFault = true; throw new Error('fixture directory close failure');
      }
      return closeSync(fd);
    };
    const open = fs.open;
    fs.open = async (...args) => {
      if (String(args[0]).endsWith('.tmp') && ${JSON.stringify(fault)} === 'replace-before-open') {
        await fs.rename(args[0], String(args[0]) + '.moved');
        await fs.writeFile(args[0], 'replacement', { mode: 0o600 });
      }
      const handle = await open(...args);
      if (String(args[0]).endsWith('.tmp') && ${JSON.stringify(fault)} === 'after-sync') {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); process.exit(73); };
      }
      return handle;
    };
    syncBuiltinESMExports();
    (await import(${JSON.stringify(processModule)})).runSessionStorage();
  `, { mode: 0o600 })
  storage = new SessionStorage(root, () => ({ file, sha256: fingerprint(file)!, execArgv: ['--import', import.meta.resolve('tsx')] }))
}

describe('required session storage process', () => {
  it.each(['missing-result', 'missing-proof'])('reaps an unrecognizable %s preparation reply before releasing its slot', async fault => {
    const owner = storage as unknown as { child?: ChildProcess; request(operation: SessionStorageOperation): Promise<unknown> }
    const request = owner.request.bind(storage)
    let exited = false
    const damaged = vi.spyOn(owner, 'request').mockImplementation(async operation => {
      const answer = await request(operation)
      if (operation.kind !== 'prepare') return answer
      owner.child!.once('exit', () => { exited = true })
      return fault === 'missing-result' ? null : { ...answer as object, proof: null }
    })
    try {
      await expect(storage.prepare({ kind: 'registry' }, null, [])).rejects.toMatchObject({ code: 'changed' })
      expect(exited).toBe(true)
      expect(owner.child).toBeUndefined()
      expect(readdirSync(root).some(name => name.endsWith('.tmp'))).toBe(false)
    } finally { damaged.mockRestore() }
    const next = await storage.prepare({ kind: 'registry' }, null, [])
    await storage.discard(next)
  })

  it.each(['missing', 'changed'])('refuses a %s selected prepared lean entry without using its full fallback', async kind => {
    const full = join(root, 'cohort.mjs'), lean = join(root, 'core.mjs')
    writeFileSync(full, 'throw new Error("full fallback must not run")', { mode: 0o600 })
    writeFileSync(lean, 'throw new Error("lean fixture must not run")', { mode: 0o600 })
    const release = vi.fn(), configure = vi.fn((file: string, hash: string) => storage.configureEntry(file, hash))
    const prepared = await ownSessionStorage({
      entry: () => ({ file: full, sha256: fingerprint(full)!, admitted: false }),
      prepare: async () => ({ fullScript: full, fullFingerprint: fingerprint(full)!, leanCoreScript: lean,
        leanCoreFingerprint: fingerprint(lean)!, release }) as unknown as ExecutionArtifact,
      configure, close: () => storage.close(),
    })
    if (kind === 'missing') rmSync(lean)
    else writeFileSync(lean, 'throw new Error("changed lean must not run")')
    await expect(storage.read({ kind: 'registry' })).rejects.toMatchObject({ code: 'disconnected' })
    expect(configure).toHaveBeenCalledOnce()
    expect(configure.mock.calls[0][0]).toBe(lean)
    expect((storage as unknown as { child?: ChildProcess }).child).toBeUndefined()
    expect(release).not.toHaveBeenCalled()
    await prepared.close()
    expect(release).toHaveBeenCalledOnce()
  })

  it.each(['directory-close', 'file-close'] as const)('reaps the storage child after a shared %s fails', async fault => {
    faultChild(fault)
    writeFileSync(join(root, 'registry.json'), JSON.stringify([row()]), { mode: 0o600 })
    const reading = storage.read({ kind: 'registry' })
    const child = (storage as unknown as { child: ChildProcess }).child
    let exited = false
    child.once('exit', () => { exited = true })
    await expect(reading).rejects.toMatchObject({ code: 'disconnected' })
    expect(exited).toBe(true)
    expect((storage as unknown as { child?: ChildProcess }).child).toBeUndefined()
  })

  it('keeps its first immutable child selection through replacement and refuses later reconfiguration', async () => {
    const file = fileURLToPath(new URL('../storage/entry.ts', import.meta.url)), sha256 = fingerprint(file)!
    let selected = { file, sha256, execArgv: ['--import', import.meta.resolve('tsx')] }
    storage = new SessionStorage(root, () => selected)
    await storage.read({ kind: 'registry' })
    const child = (storage as unknown as { child: ChildProcess }).child
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGKILL'); await exited
    selected = { ...selected, file: join(root, 'missing.mjs') }
    expect(() => storage.configureEntry(selected.file, sha256)).toThrow('changed')
    storage.configureEntry(file, sha256)
    expect(await storage.read({ kind: 'registry' })).toEqual({ state: 'missing' })
  })

  it.each(['fchmodSync', 'fstatSync'] as const)('owns its exclusive temporary before a failed %s', async operation => {
    vi.spyOn(fs, operation).mockImplementationOnce(() => { throw Object.assign(new Error('fixture metadata failure'), { code: 'EIO' }) })
    await expect(storage.prepare({ kind: 'registry' }, null, [])).rejects.toThrow()
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps its descriptor and preparation slot while the exclusive inode cannot be proved', async () => {
    const fault = vi.spyOn(fs, 'fstatSync').mockImplementation(() => { throw Object.assign(new Error('fixture stat failure'), { code: 'EIO' }) })
    expectedCloseFailure = true
    await expect(storage.prepare({ kind: 'registry' }, null, [])).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
    const owner = storage as unknown as { preparation?: { reservation: { descriptor?: number } } }
    expect(typeof owner.preparation?.reservation.descriptor).toBe('number')
    await expect(storage.prepare({ kind: 'registry' }, null, [])).rejects.toMatchObject({ code: 'disconnected' })
    fault.mockRestore()
    await expect(storage.close()).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps its request deadline independent of a caller wall-clock change', async () => {
    writeFileSync(join(root, 'registry.json'), JSON.stringify([row()]), { mode: 0o600 })
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 26, 9, 30))
    const image = await storage.read({ kind: 'registry' })
    expect(image.state).toBe('image')
    expect(containsKey(image)).toBe(false)
  })

  it('reaps a late reply before releasing the original expired request', async () => {
    await storage.read({ kind: 'registry' })
    const owner = storage as unknown as { active: { expires: number }; child?: ChildProcess }
    const child = owner.child!
    let exited = false
    child.once('exit', () => { exited = true })
    const read = storage.read({ kind: 'registry' })
    owner.active.expires = 0
    await expect(read).rejects.toMatchObject({ code: 'disconnected' })
    expect(exited).toBe(true)
    expect(owner.child).toBeUndefined()
  })

  it('does not settle a missing temporary whose original directory was displaced', async () => {
    const prepared = await storage.prepare({ kind: 'registry' }, null, [])
    const moved = `${root}-displaced`
    renameSync(root, moved)
    mkdirSync(root, { mode: 0o700 })
    expectedCloseFailure = true
    try {
      await expect(storage.discard(prepared)).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
      expect(readdirSync(moved).some(name => name.endsWith('.tmp'))).toBe(true)
      await expect(storage.prepare({ kind: 'registry' }, null, [])).rejects.toMatchObject({ code: 'disconnected' })
    } finally {
      rmSync(root, { recursive: true, force: true })
      renameSync(moved, root)
    }
  })

  it.each(['changed', 'missing'] as const)('refuses a %s selected payload before reading an image', async state => {
    const file = join(root, 'selected.mjs')
    writeFileSync(file, 'throw new Error("fixture must never execute")', { mode: 0o600 })
    const sha256 = fingerprint(file)!
    storage = new SessionStorage(root, () => ({ file, sha256 }))
    if (state === 'missing') rmSync(file)
    else writeFileSync(file, 'throw new Error("changed fixture must never execute")')
    await expect(storage.read({ kind: 'registry' })).rejects.toMatchObject({ code: 'disconnected' })
    expect((storage as unknown as { child?: ChildProcess }).child).toBeUndefined()
  })

  it('refuses a replacement child from an incompatible cohort before storage effects', async () => {
    const file = join(root, 'previous-cohort.mjs'), marker = join(root, 'effects')
    const admission = new URL('../harnessd/childAdmission.ts', import.meta.url).href
    const contract = new URL('../harnessd/workerContract.ts', import.meta.url).href
    writeFileSync(file, `
      import { writeFileSync } from 'node:fs';
      import { childAdmissionFailure } from ${JSON.stringify(admission)};
      import { WORKER_PLAN } from ${JSON.stringify(contract)};
      if (childAdmissionFailure(process.env, process.ppid, process.argv[1], undefined, { contract: 2, plan: WORKER_PLAN })) process.exit(2);
      writeFileSync(${JSON.stringify(marker)}, 'unexpected effect');
    `, { mode: 0o600 })
    storage = new SessionStorage(root, () => ({ file, sha256: fingerprint(file)!, execArgv: ['--import', import.meta.resolve('tsx')] }))
    await expect(storage.read({ kind: 'registry' })).rejects.toMatchObject({ code: 'disconnected' })
    expect(readdirSync(root)).not.toContain('effects')
  })

  it('reads large supported rows through credited pages without carrying a key back to core', async () => {
    writeFileSync(join(root, 'registry.json'), JSON.stringify([{ ...row(), title: 'x'.repeat(512 * 1024) }]), { mode: 0o600 })
    const image = await storage.read({ kind: 'registry' })
    expect(image.state === 'image' && image.json).toBe(true)
    expect(containsKey(image)).toBe(false)
    if (image.state === 'image' && image.json) expect((image.value as Array<{ title: string }>)[0].title.length).toBe(512 * 1024)
  })

  it('searches stopped conflicts privately and rejects an in-place change after the answer', async () => {
    const directory = join(root, 'stopped-agents'), file = join(directory, 'fixture-agent.json')
    mkdirSync(directory, { mode: 0o700 })
    const session = { ...row(), schemaVersion: 2, sessionId: 'other', cwd: '/fixture/elsewhere' }
    writeFileSync(file, JSON.stringify({ version: 1, session }), { mode: 0o600 })
    const query = { kind: 'conversations' as const, ids: ['asked'], reservations: false }
    const answer = await storage.stoppedQuery(query)
    expect(answer.matches).toEqual([false])
    expect(containsKey(answer)).toBe(false)
    const directoryBefore = sessionFileIdentity(lstatSync(directory, { bigint: true }))
    writeFileSync(file, JSON.stringify({ version: 1, session: { ...session, sessionId: 'asked' } }))
    expect(sessionFileIdentity(lstatSync(directory, { bigint: true }))).toBe(directoryBefore)
    expect(answer.current()).toBe(false)
    expect((await storage.stoppedQuery(query)).matches).toEqual([true])
    expect((await storage.stoppedQuery({ ...query, exceptAgentIds: ['fixture-agent'] })).matches).toEqual([false])
  })

  it('checks only the selected worktree root and invalidates an earlier absence after addition or mutation', async () => {
    const directory = join(root, 'stopped-agents'), file = join(directory, 'fixture-agent.json')
    const query = { kind: 'folder' as const, root: '/fixture/worktree', exceptAgentId: 'selected' }
    const missing = await storage.stoppedQuery(query)
    mkdirSync(directory, { mode: 0o700 })
    const session = { ...row(), schemaVersion: 2, sessionId: 'other', cwd: '/fixture/elsewhere' }
    writeFileSync(file, JSON.stringify({ version: 1, session }), { mode: 0o600 })
    expect(missing.current()).toBe(false)
    const clear = await storage.stoppedQuery(query)
    expect(clear.matches).toEqual([false])
    writeFileSync(file, JSON.stringify({ version: 1, session: { ...session, cwd: '/fixture/worktree/child' } }))
    expect(clear.current()).toBe(false)
    expect((await storage.stoppedQuery(query)).matches).toEqual([true])
    writeFileSync(file, 'invalid')
    await expect(storage.stoppedQuery(query)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('keeps the bounded conflict search behind actual write-lease settlement', async () => {
    let entered!: () => void, release!: () => void
    const active = new Promise<void>(resolve => { entered = resolve })
    const settlement = new Promise<void>(resolve => { release = resolve })
    const write = storage.withWrite(Infinity, async () => { entered(); await settlement })
    await active
    let answered = false
    const query = storage.stoppedQuery({ kind: 'conversations', ids: ['asked'], reservations: true }).then(value => { answered = true; return value })
    await Promise.resolve()
    expect(answered).toBe(false)
    release()
    await write
    expect((await query).matches).toEqual([false])
  })

  it('recovers an overwritten prior credential after child loss without a second durable image', async () => {
    writeFileSync(join(root, 'registry.json'), JSON.stringify([row()]), { mode: 0o600 })
    const prior = await storage.retain({ kind: 'registry' })
    if (prior.image.state !== 'image' || !prior.image.json) throw new Error('fixture image was not readable')
    const priorImage = prior.image
    const replacementKey = randomUUID()
    const candidate = await storage.withImport({ agentId: 'fixture-agent', registeredAt: 1 }, { ...override(), apiKey: replacementKey }, async gridLaunch => {
      return storage.prepare({ kind: 'registry' }, priorImage.proof, [{ ...row(), title: 'replacement', gridLaunch }])
    })
    prior.check()
    renameSync(join(root, candidate.temporary), join(root, 'registry.json'))
    expect(readFileSync(join(root, 'registry.json'), 'utf8').includes(key)).toBe(false)
    const child = (storage as unknown as { child: ChildProcess }).child
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited
    // Publication consumed the temporary, but its preparation slot stays owned through child reap.
    await storage.discard(candidate)
    const latest = await storage.read({ kind: 'registry' })
    if (latest.state !== 'image' || !latest.json) throw new Error('replacement was not readable')
    const restored = await storage.prepare({ kind: 'registry' }, latest.proof, priorImage.value)
    expect(containsKey(restored)).toBe(false)
    expect(readFileSync(join(root, restored.temporary), 'utf8').includes(key)).toBe(true)
    await storage.discard(restored)
    await prior.release()
  })

  it.each(['accepted', 'EPERM', 'EINVAL', 'ENOSYS'] as const)('retains descriptor custody until actual exit when termination is %s', async failure => {
    writeFileSync(join(root, 'registry.json'), JSON.stringify([row()]), { mode: 0o600 })
    const source = await storage.retain({ kind: 'registry' })
    const child = (storage as unknown as { child: ChildProcess }).child
    const kill = child.kill.bind(child)
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    // A failed signal or IPC send reports error without proving that a running child exited.
    let attempts = 0
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    child.kill = () => {
      attempts++
      if (attempts > 2) throw new Error('fixture prevents recursive signal failure')
      if (failure === 'EPERM') { child.emit('error', Object.assign(new Error('fixture refused signal'), { code: failure })); return false }
      if (failure !== 'accepted') throw Object.assign(new Error('fixture unsupported signal'), { code: failure })
      return true
    }
    let closed = false
    const closing = storage.close().then(() => { closed = true }, () => { closed = true })
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(closed).toBe(false)
      expect(attempts).toBe(1)
      expect(() => source.check()).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(failure === 'accepted' ? 0 : 1)
    } finally {
      kill('SIGKILL')
      await exited
      await closing
    }
  })

  it('waits for an outstanding source open to settle before acknowledging close', async () => {
    const file = join(root, 'registry.json')
    writeFileSync(file, JSON.stringify([row()]), { mode: 0o600 })
    const open = fs.open
    let entered!: () => void, release!: () => void, descriptor: number | undefined
    const reached = new Promise<void>(resolve => { entered = resolve })
    vi.spyOn(fs, 'open').mockImplementation(((...args: any[]) => {
      const callback = args.pop()
      ;(open as (...values: any[]) => void)(...args, (error: unknown, fd: number) => {
        if (args[0] !== file) { callback(error, fd); return }
        descriptor = fd
        release = () => callback(error, fd)
        entered()
      })
    }) as typeof fs.open)
    const reading = storage.retain({ kind: 'registry' }).catch(error => error)
    await reached
    let closed = false
    const closing = storage.close().then(() => { closed = true })
    try {
      await Promise.resolve(); await Promise.resolve()
      expect(closed).toBe(false)
    } finally { release(); await reading; await closing }
    expect(() => fs.fstatSync(descriptor!)).toThrow()
  })

  it('cleans its exact transaction inode after child death before the preparation acknowledgment', async () => {
    faultChild('after-sync')
    writeFileSync(join(root, 'registry.json'), JSON.stringify([row()]), { mode: 0o600 })
    const image = await storage.read({ kind: 'registry' })
    if (image.state !== 'image' || !image.json) throw new Error('fixture image was not readable')
    await expect(storage.prepare({ kind: 'registry' }, image.proof, image.value)).rejects.toMatchObject({ code: 'disconnected' })
    expect(readdirSync(root).some(name => name.endsWith('.tmp'))).toBe(false)
    expect(readFileSync(join(root, 'registry.json'), 'utf8').includes(key)).toBe(true)
  })

  it('refuses replacement-path cleanup and keeps that inode untouched', async () => {
    faultChild('replace-before-open')
    writeFileSync(join(root, 'registry.json'), JSON.stringify([row()]), { mode: 0o600 })
    const image = await storage.read({ kind: 'registry' })
    if (image.state !== 'image' || !image.json) throw new Error('fixture image was not readable')
    expectedCloseFailure = true
    await expect(storage.prepare({ kind: 'registry' }, image.proof, image.value)).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
    const replacement = readdirSync(root).find(name => name.endsWith('.tmp'))!
    expect(readFileSync(join(root, replacement), 'utf8')).toBe('replacement')
    await expect(storage.close()).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
  })
})
