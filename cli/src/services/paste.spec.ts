import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdtemp, mkdir, open, opendir, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPasteFiles, PASTE_LIMITS } from './paste.js'
import { openPreparedPaste } from '../lib/pasteArtifact.js'
import { emptyPorts } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startPaste } from './paste.js'
import { createPasteClipboard } from './pasteClipboard.js'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn(fs.open), unlink: vi.fn(fs.unlink), rename: vi.fn(fs.rename), opendir: vi.fn(fs.opendir), lstat: vi.fn(fs.lstat) }
})
const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const releaseWaits: Array<() => void> = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  releaseWaits.push(() => resolve(undefined as T))
  return { promise, resolve }
}

const roots: string[] = []
const services: ReturnType<typeof createPasteFiles>[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'paste-service-'))
  roots.push(root)
  const log = vi.fn()
  const files = createPasteFiles(root, { log })
  services.push(files)
  const request = { generation: randomUUID(), streamId: randomUUID(), connection: 'client', filename: 'report.pdf', totalBytes: 8 }
  return { root, files, log, request, directory: join(root, 'paste-drops', 'file-uploads') }
}
async function expiringFixture(count: number) {
  const root = await mkdtemp(join(tmpdir(), 'paste-expiring-')); roots.push(root)
  const directory = join(root, 'paste-drops', 'file-uploads')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const names = Array.from({ length: count }, () => `${randomUUID()}-old.txt`)
  const age = new Date(Date.now() - PASTE_LIMITS.retentionMs + 1_000)
  for (let offset = 0; offset < names.length; offset += 4) await Promise.all(names.slice(offset, offset + 4).map(async (name) => {
    await writeFile(join(directory, name), 'old', { mode: 0o600 })
    await utimes(join(directory, name), age, age)
  }))
  const files = createPasteFiles(root, { log: vi.fn() }); services.push(files)
  const request = { generation: randomUUID(), streamId: randomUUID(), connection: 'expiry-fixture', filename: 'new.txt', totalBytes: 1 }
  expect(await files.begin(request)).toEqual({ accepted: true })
  return { files, request, directory }
}
afterEach(async () => {
  for (const release of releaseWaits.splice(0)) release()
  for (const files of services.splice(0)) await files.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(open).mockReset().mockImplementation(filesystem.open)
  vi.mocked(unlink).mockReset().mockImplementation(filesystem.unlink)
  vi.mocked(rename).mockReset().mockImplementation(filesystem.rename)
  vi.mocked(opendir).mockReset().mockImplementation(filesystem.opendir)
  vi.mocked(lstat).mockReset().mockImplementation(filesystem.lstat)
})

describe('paste files in the worker', () => {
  it('uses the same bounded writer for images and grants one clipboard claim to the publication owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paste-image-service-')); roots.push(root)
    const native = vi.fn((file: ReturnType<typeof openPreparedPaste>) => {
      expect(file.current()).toBe(true); file.close()
      return { ready: Promise.resolve({ state: 'written' as const }), settled: Promise.resolve(), cancel: vi.fn() }
    })
    const files = createPasteFiles(root, { log: vi.fn(), clipboard: (directory, deps) => createPasteClipboard(directory, { ...deps, start: native }) })
    services.push(files)
    const request = { kind: 'image' as const, generation: randomUUID(), connection: 'image-client', streamId: randomUUID(), filename: 'ignored.txt', totalBytes: 8 }
    expect(await files.begin({ ...request, totalBytes: PASTE_LIMITS.imageBytes + 1 })).toEqual({ error: 'PASTE_INVALID_UPLOAD' })
    expect(await files.begin({ ...request, kind: 'video' as 'image' })).toEqual({ error: 'PASTE_INVALID_UPLOAD' })
    expect(await files.begin(request)).toEqual({ accepted: true })
    const bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10)
    const result = await files.chunk({ ...request, seq: 0 }, bytes)
    if (!('artifact' in result) || !result.artifact) throw new Error('missing image artifact')
    expect(result.artifact.name).toBe(`${request.generation}-image.png`)
    const path = join(root, 'paste-drops', 'file-uploads', result.artifact.name)
    expect(await readFile(path)).toEqual(Buffer.from(bytes))
    const selected = { ...request, artifact: result.artifact }
    for (const invalid of [{ ...selected, connection: 'other' }, { ...selected, streamId: randomUUID() },
      { ...selected, artifact: { ...selected.artifact, version: 'old' } }]) {
      expect(await files.clipboard(invalid)).toEqual({ state: 'unavailable', reason: 'PASTE_UPLOAD_UNAVAILABLE' })
    }
    expect(native).not.toHaveBeenCalled()
    for (const connection of [request.connection, 'another-client']) {
      expect(await files.begin({ ...request, kind: 'file', generation: randomUUID(), connection })).toEqual({ accepted: true })
    }
    expect(await files.clipboard(selected)).toEqual({ state: 'written' })
    expect(await files.clipboard(selected)).toEqual({ state: 'unavailable', reason: 'PASTE_UPLOAD_UNAVAILABLE' })
    files.releaseClipboard(request.generation)
    expect(native).toHaveBeenCalledOnce()
    expect(await readFile(path)).toEqual(Buffer.from(bytes))
  })

  it('uses exact image chunk geometry and revokes a published image before any clipboard claim', async () => {
    const { files, request } = await fixture()
    const image = { ...request, kind: 'image' as const }
    expect(await files.begin(image)).toEqual({ accepted: true })
    expect(await files.chunk({ ...image, seq: 0 }, new Uint8Array(7))).toEqual({ error: 'PASTE_INVALID_CHUNK' })
    const next = { ...image, generation: randomUUID() }
    expect(await files.begin(next)).toEqual({ accepted: true })
    const result = await files.chunk({ ...next, seq: 0 }, new Uint8Array(8))
    if (!('artifact' in result) || !result.artifact) throw new Error('missing image artifact')
    files.cancel(next.generation)
    expect(await files.clipboard({ ...next, artifact: result.artifact })).toEqual({ state: 'unavailable', reason: 'PASTE_UPLOAD_UNAVAILABLE' })
  })

  it('expires recognized owned legacy PNGs in place while preserving foreign names, links and writable files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paste-image-legacy-')); roots.push(root)
    const directory = join(root, 'paste-drops'); await mkdir(directory, { mode: 0o700 })
    const old = join(directory, `${randomUUID()}.png`), current = join(directory, `${randomUUID()}.png`)
    const foreign = join(directory, 'other.png'), writable = join(directory, `${randomUUID()}.png`)
    await writeFile(old, 'owned', { mode: 0o644 }); await writeFile(current, 'current', { mode: 0o644 })
    await writeFile(foreign, 'foreign'); await writeFile(writable, 'writable'); await chmod(writable, 0o666)
    const age = new Date(Date.now() - PASTE_LIMITS.retentionMs - 1_000)
    await utimes(old, age, age); await utimes(foreign, age, age); await utimes(writable, age, age)
    const link = join(directory, `${randomUUID()}.png`)
    if (process.platform !== 'win32') await symlink(foreign, link)
    const files = createPasteFiles(root, { log: vi.fn() }); services.push(files)
    await files.begin({ generation: randomUUID(), connection: 'client', streamId: randomUUID(), filename: 'new.txt', totalBytes: 1 })
    await expect(readFile(old)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(current, 'utf8')).toBe('current')
    expect(await readFile(foreign, 'utf8')).toBe('foreign')
    if (process.platform !== 'win32') {
      expect(await readFile(writable, 'utf8')).toBe('writable')
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
    }
  })

  it.each(['future mtime', 'backward clock jump'] as const)('bounds expiry scheduling after a %s without changing the artifact lifetime', async (cause) => {
    vi.useFakeTimers()
    const maximumDelay = 2 ** 31 - 1, started = Date.now()
    const root = await mkdtemp(join(tmpdir(), 'paste-expiring-')); roots.push(root)
    const directory = join(root, 'paste-drops', 'file-uploads')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const artifact = join(directory, `${randomUUID()}-retained.txt`)
    await writeFile(artifact, 'retained', { mode: 0o600 })
    const modified = new Date(started + (cause === 'future mtime' ? maximumDelay : 0))
    await utimes(artifact, modified, modified)
    const expires = Number((await filesystem.lstat(artifact, { bigint: true })).mtimeMs) + PASTE_LIMITS.retentionMs
    const files = createPasteFiles(root, { log: vi.fn() }); services.push(files)
    const request = { generation: randomUUID(), streamId: randomUUID(), connection: 'expiry-clock', filename: 'new.txt', totalBytes: 1 }
    expect(await files.begin(request)).toEqual({ accepted: true })
    files.cancel(request.generation)
    if (cause === 'backward clock jump') {
      vi.setSystemTime(started - maximumDelay - PASTE_LIMITS.retentionMs)
      // Let the existing retention timer wake once under the new wall clock.
      await vi.advanceTimersByTimeAsync(PASTE_LIMITS.retentionMs)
    }
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(scheduled).not.toHaveBeenCalled()
      expect(await readFile(artifact, 'utf8')).toBe('retained')
      await vi.advanceTimersByTimeAsync(expires - Date.now() - 1)
      expect(await readFile(artifact, 'utf8')).toBe('retained')
      const deleted = deferred<void>()
      vi.mocked(unlink).mockImplementation(async (file) => {
        await filesystem.unlink(file)
        if (file === artifact) deleted.resolve()
      })
      await vi.advanceTimersByTimeAsync(2)
      await deleted.promise
      await expect(readFile(artifact)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { scheduled.mockRestore() }
  })

  it('keeps expiry four-wide while publication schedules cleanup during an unresolved pass', async () => {
    vi.useFakeTimers()
    const { files, request } = await expiringFixture(130)
    const held = deferred<void>(), entered = deferred<void>(), all = deferred<void>()
    let active = 0, peak = 0, removed = 0
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (!String(args[0]).endsWith('-old.txt')) return filesystem.lstat(...args)
      active++; peak = Math.max(peak, active); if (active === 4) entered.resolve()
      try { await held.promise; return await filesystem.lstat(...args) } finally { active-- }
    })
    vi.mocked(unlink).mockImplementation(async (file) => {
      await filesystem.unlink(file)
      if (String(file).endsWith('-old.txt')) {
        removed++; if (removed === 130) all.resolve()
      }
    })
    await vi.advanceTimersByTimeAsync(1_001)
    await entered.promise
    expect(await files.chunk({ ...request, seq: 0 }, Uint8Array.of(1))).toHaveProperty('artifact')
    await vi.advanceTimersByTimeAsync(1)
    expect.soft(peak).toBe(4)
    const stopping = files.stop()
    held.resolve()
    await stopping
    // The original overlapping implementation does not own expiry at stop; drain its extra pass for RED cleanup.
    if (peak > 4) await all.promise
    expect(active).toBe(0)
    expect(removed).toBe(128)
  })

  it('keeps stop pending until its already-started expiry operations settle', async () => {
    vi.useFakeTimers()
    const { files, request } = await expiringFixture(4)
    // Leave no active upload cleanup that could accidentally keep stop pending for a different reason.
    expect(await files.chunk({ ...request, seq: 0 }, Uint8Array.of(1))).toHaveProperty('artifact')
    const held = deferred<void>(), entered = deferred<void>(), removedAll = deferred<void>()
    let inspected = 0, removed = 0, stopped = false
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('-old.txt')) { if (++inspected === 4) entered.resolve(); await held.promise }
      return filesystem.lstat(...args)
    })
    vi.mocked(unlink).mockImplementation(async (file) => {
      await filesystem.unlink(file)
      if (String(file).endsWith('-old.txt') && ++removed === 4) removedAll.resolve()
    })
    await vi.advanceTimersByTimeAsync(1_001); await entered.promise
    const stopping = files.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(0)
    expect.soft(stopped).toBe(false)
    held.resolve()
    await Promise.all([stopping, removedAll.promise])
  })

  it('accepts an already-removed staging file between its identity check and owned unlink', async () => {
    const { files, request, directory, log } = await fixture()
    await files.begin(request)
    vi.mocked(unlink).mockImplementationOnce(async (file) => {
      await filesystem.unlink(file)
      throw Object.assign(new Error('fixture raced owned unlink'), { code: 'ENOENT' })
    })
    files.cancel(request.generation)
    await files.stop()
    expect(await readdir(directory)).toEqual([])
    expect(log).not.toHaveBeenCalledWith('PASTE_CLEANUP_FAILED')
  })

  it('closes an owned descriptor but preserves its pathname when descriptor identity could not be established', async () => {
    const closed = vi.fn()
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await filesystem.open(...args)
      vi.spyOn(handle, 'stat').mockRejectedValueOnce(new Error('fixture descriptor inspection failed'))
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => { closed(); await close() })
      return handle
    })
    const { files, request, directory, log } = await fixture()
    expect(await files.begin(request)).toEqual({ error: 'PASTE_STORAGE_FAILED' })
    await files.stop()
    expect(closed).toHaveBeenCalledOnce()
    expect(await readdir(directory)).toEqual([`${request.generation}.part`])
    expect(log).toHaveBeenCalledWith('PASTE_CLEANUP_FAILED')
  })

  it('releases a cancelled reservation when the owned staging file has already gone', async () => {
    const { files, request, directory, log } = await fixture()
    await files.begin(request)
    await filesystem.unlink(join(directory, `${request.generation}.part`))
    files.cancel(request.generation)
    await files.stop()
    expect(log).not.toHaveBeenCalledWith('PASTE_CLEANUP_FAILED')
    expect(await readdir(directory)).toEqual([])
  })

  it('reports a failed staging read before publication without losing ownership of cleanup', async () => {
    const { files, request, directory } = await fixture()
    await files.begin(request)
    vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('fixture staging read failed'), { code: 'EACCES' }))
    expect(await files.chunk({ ...request, seq: 0 }, new Uint8Array(8))).toEqual({ error: 'PASTE_STORAGE_FAILED' })
    await files.stop()
    expect(await readdir(directory)).toEqual([])
  })

  it('refuses publication when its descriptor reports an unexpected final size', async () => {
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await filesystem.open(...args), stat = handle.stat.bind(handle)
      let inspected = false
      vi.spyOn(handle, 'stat').mockImplementation((async (...options: Parameters<typeof stat>) => {
        const info = await stat(...options)
        if (!inspected) { inspected = true; return info }
        return { ...info, size: 7n }
      }) as typeof stat)
      return handle
    })
    const { files, request, directory } = await fixture()
    await files.begin(request)
    expect(await files.chunk({ ...request, seq: 0 }, new Uint8Array(8))).toEqual({ error: 'PASTE_STAGING_CHANGED' })
    await files.stop()
    expect(await readdir(directory)).toEqual([])
  })

  it('does not publish when cancelled while the final owned staging identity is inspected', async () => {
    const { files, request, directory } = await fixture()
    await files.begin(request)
    vi.mocked(lstat).mockImplementationOnce(async (...args) => {
      const info = await filesystem.lstat(...args)
      files.cancel(request.generation)
      return info
    })
    expect(await files.chunk({ ...request, seq: 0 }, new Uint8Array(8))).toEqual({ ignored: true })
    await files.stop()
    expect(await readdir(directory)).toEqual([])
  })

  it('reports a named failure to a live caller after its idle upload expired', async () => {
    vi.useFakeTimers()
    const { files, request, log } = await fixture()
    expect(await files.begin(request)).toEqual({ accepted: true })
    await vi.advanceTimersByTimeAsync(PASTE_LIMITS.operationMs)
    expect(await files.chunk({ ...request, seq: 0 }, new Uint8Array(8))).toEqual({ error: 'PASTE_UPLOAD_UNAVAILABLE' })
    expect(log).toHaveBeenCalledWith('PASTE_UPLOAD_TIMEOUT')
  })

  it.each(['cancelled', 'inventory-failed'] as const)('preserves an unowned staging file when initial begin is %s', async (mode) => {
    const entered = deferred<void>(), release = deferred<void>()
    vi.mocked(opendir).mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise
      if (mode === 'inventory-failed') throw new Error('fixture inventory failure')
      return filesystem.opendir(...args)
    })
    const { files, request, directory } = await fixture()
    const beginning = files.begin(request)
    await entered.promise
    const unowned = join(directory, `${request.generation}.part`)
    await filesystem.writeFile(unowned, 'foreign staging fixture', { mode: 0o600 })
    if (mode === 'cancelled') files.cancel(request.generation)
    release.resolve()
    expect(await beginning).toHaveProperty('error')
    await files.stop()
    expect(await readFile(unowned, 'utf8')).toBe('foreign staging fixture')
  })

  it('rechecks retained generations discovered by initial inventory before opening or publishing', async () => {
    const entered = deferred<void>(), release = deferred<void>()
    vi.mocked(opendir).mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return filesystem.opendir(...args) })
    const { files, request, directory } = await fixture()
    const beginning = files.begin(request)
    await entered.promise
    const existing = join(directory, `${request.generation}-report.pdf`)
    await filesystem.writeFile(existing, 'original', { mode: 0o600 })
    release.resolve()
    expect.soft(await beginning).toEqual({ error: 'PASTE_UPLOAD_BUSY' })
    await files.chunk({ ...request, seq: 0 }, new Uint8Array(8).fill(9))
    expect(await readFile(existing, 'utf8')).toBe('original')
  })

  it('preserves a foreign replacement of its staging pathname during cancellation', async () => {
    const { files, request, directory, log } = await fixture()
    await files.begin(request)
    const part = join(directory, `${request.generation}.part`)
    await filesystem.rename(part, join(directory, 'moved-owned-part'))
    await filesystem.writeFile(part, 'foreign replacement fixture', { mode: 0o600 })
    files.cancel(request.generation)
    await files.stop()
    expect(await readFile(part, 'utf8')).toBe('foreign replacement fixture')
    expect(log).toHaveBeenCalledWith('PASTE_CLEANUP_FAILED')
  })

  it('retains a published generation and its artifact when inspection after rename fails', async () => {
    vi.useFakeTimers()
    const { files, request, directory, log } = await fixture()
    await files.begin(request)
    const target = join(directory, `${request.generation}-report.pdf`)
    vi.mocked(lstat).mockImplementation((async (...args: Parameters<typeof lstat>) => {
      if (args[0] === target) throw new Error('fixture post-publication inspection failure')
      return filesystem.lstat(...args)
    }) as typeof lstat)
    expect(await files.chunk({ ...request, seq: 0 }, new Uint8Array(8))).toEqual({ error: 'PASTE_STORAGE_FAILED' })
    expect(await files.begin(request)).toEqual({ error: 'PASTE_UPLOAD_BUSY' })
    expect(await readFile(target)).toEqual(Buffer.alloc(8))
    const unverified = deferred<void>()
    log.mockImplementation((code: string) => { if (code === 'PASTE_CLEANUP_UNVERIFIED') unverified.resolve() })
    await vi.advanceTimersByTimeAsync(PASTE_LIMITS.retentionMs)
    await unverified.promise
    expect(await readFile(target)).toEqual(Buffer.alloc(8))
  })

  it('does not unlink a file that made exclusive staging creation fail', async () => {
    const { files, request, directory } = await fixture()
    await files.begin(request) // Inventory has finished before the conflicting file appears.
    const next = { ...request, generation: randomUUID() }, part = join(directory, `${next.generation}.part`)
    await filesystem.writeFile(part, 'foreign exclusive-create fixture', { mode: 0o600 })
    expect(await files.begin(next)).toEqual({ error: 'PASTE_STORAGE_FAILED' })
    await files.stop()
    expect(await readFile(part, 'utf8')).toBe('foreign exclusive-create fixture')
  })

  it('cancels begin before its file opens and bounds a failed create without leaking error content', async () => {
    const { files, request } = await fixture()
    const beginning = files.begin(request)
    files.cancel(request.generation)
    expect(await beginning).toEqual({ error: 'PASTE_CANCELLED' })
    await files.stop()
    const root = await mkdtemp(join(tmpdir(), 'paste-create-failure-')); roots.push(root)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const other = createPasteFiles(root); services.push(other)
    vi.mocked(open).mockRejectedValueOnce(new Error('private fixture path'))
    expect(await other.begin({ ...request, generation: randomUUID() })).toEqual({ error: 'PASTE_STORAGE_FAILED' })
    expect(warning.mock.calls.flat().join(' ')).not.toContain('private fixture path')
  })

  it('bounds partial write attempts rather than looping forever', async () => {
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await filesystem.open(...args)
      vi.spyOn(handle, 'write').mockImplementation(async (buffer) => ({ bytesWritten: 1, buffer }))
      return handle
    })
    const { files, request } = await fixture()
    request.totalBytes = 65
    await files.begin(request)
    expect(await files.chunk({ ...request, seq: 0 }, new Uint8Array(65))).toEqual({ error: 'PASTE_WRITE_LIMIT' })
  })

  it('does not publish after cancellation during close, and retains uncertain publication after rename', async () => {
    const { files, request, directory } = await fixture()
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await filesystem.open(...args), close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); files.cancel(request.generation) })
      return handle
    })
    await files.begin(request)
    expect(await files.chunk({ ...request, seq: 0 }, new Uint8Array(8))).toEqual({ ignored: true })
    const next = { ...request, generation: randomUUID() }
    await files.begin(next)
    vi.mocked(rename).mockImplementationOnce(async (...args) => { await filesystem.rename(...args); files.cancel(next.generation) })
    expect(await files.chunk({ ...next, seq: 0 }, new Uint8Array(8))).toEqual({ ignored: true })
    await files.stop()
    expect(await readdir(directory)).toEqual([`${next.generation}-report.pdf`])
  })

  it('charges inventoried bytes before accepting an upload and preserves oversized existing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paste-capacity-')); roots.push(root)
    const directory = join(root, 'paste-drops', 'file-uploads')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const existing = join(directory, 'foreign.txt'); await writeFile(existing, 'fixture', { mode: 0o600 })
    const info = await filesystem.lstat(existing, { bigint: true })
    vi.mocked(lstat).mockImplementation(((path: Parameters<typeof lstat>[0], options: Parameters<typeof lstat>[1]) =>
      path === existing ? Promise.resolve(Object.assign(Object.create(info), { size: BigInt(PASTE_LIMITS.storedBytes) }))
        : filesystem.lstat(path, options)) as typeof lstat)
    const files = createPasteFiles(root, { log: vi.fn() }); services.push(files)
    const request = { generation: randomUUID(), streamId: randomUUID(), connection: 'client', filename: 'x', totalBytes: 1 }
    expect(await files.begin(request)).toEqual({ error: 'PASTE_CAPACITY' })
    expect(await files.begin({ ...request, generation: randomUUID() })).toEqual({ error: 'PASTE_CAPACITY' })
    expect(await readFile(existing, 'utf8')).toBe('fixture')
  })

  it.each(['current', 'legacy'] as const)('refuses an oversized %s inventory without deleting unexamined entries', async (location) => {
    const root = await mkdtemp(join(tmpdir(), 'paste-inventory-limit-')); roots.push(root)
    const directory = join(root, 'paste-drops', 'file-uploads')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const existing = join(directory, 'foreign.txt'); await writeFile(existing, 'fixture', { mode: 0o600 })
    // A bounded synthetic directory stream avoids creating thousands of unrelated fixture files.
    if (location === 'legacy') vi.mocked(opendir).mockImplementationOnce(filesystem.opendir)
    vi.mocked(opendir).mockResolvedValueOnce({ async *[Symbol.asyncIterator]() {
      for (let index = 0; index <= PASTE_LIMITS.inventory; index++) yield { name: 'foreign.txt' }
    } } as unknown as Awaited<ReturnType<typeof opendir>>)
    const files = createPasteFiles(root, { log: vi.fn() }); services.push(files)
    expect(await files.begin({ generation: randomUUID(), streamId: randomUUID(), connection: 'client', filename: 'x', totalBytes: 1 }))
      .toEqual({ error: 'PASTE_INVENTORY_LIMIT' })
    expect(await readFile(existing, 'utf8')).toBe('fixture')
  })

  it('refuses links inside its private ancestry, writable parents and non-file inventory entries', async () => {
    for (const kind of ['parent-link', 'writable-parent', 'directory-entry']) {
      if (kind === 'writable-parent' && process.platform === 'win32') continue // NTFS mode bits do not express ACL writes.
      const root = await mkdtemp(join(tmpdir(), 'paste-unsafe-parent-')); roots.push(root)
      if (kind === 'parent-link') {
        await mkdir(join(root, 'target')); await symlink(join(root, 'target'), join(root, 'paste-drops'))
      } else {
        await mkdir(join(root, 'paste-drops', 'file-uploads'), { recursive: true, mode: 0o700 })
        if (kind === 'writable-parent') await chmod(join(root, 'paste-drops'), 0o777)
        else await mkdir(join(root, 'paste-drops', 'file-uploads', 'foreign-directory'))
      }
      const files = createPasteFiles(root, { log: vi.fn() }); services.push(files)
      expect(await files.begin({ generation: randomUUID(), streamId: randomUUID(), connection: 'client', filename: 'x', totalBytes: 1 }), kind).toHaveProperty('error')
      if (kind === 'parent-link') expect(await readdir(join(root, 'target'))).toEqual([])
    }
  })

  it.each(['removed', 'changed', 'denied', 'expires'] as const)('handles a retained artifact that is %s at expiry', async (mode) => {
    vi.useFakeTimers()
    const { files, request, directory, log } = await fixture()
    await files.begin(request)
    const answer = await files.chunk({ ...request, seq: 0 }, new Uint8Array(8))
    if (!('artifact' in answer) || !answer.artifact) throw new Error('missing artifact')
    const file = join(directory, answer.artifact.name), observed = deferred<void>()
    if (mode === 'removed') {
      await filesystem.unlink(file)
      vi.mocked(lstat).mockImplementation((async (...args: Parameters<typeof lstat>) => {
        try { return await filesystem.lstat(...args) } finally { if (args[0] === file) observed.resolve() }
      }) as typeof lstat)
    } else if (mode === 'changed') {
      await writeFile(file, 'changed')
      log.mockImplementation((code: string) => { if (code === 'PASTE_CLEANUP_CHANGED') observed.resolve() })
    } else if (mode === 'denied') {
      vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error('private details'), { code: 'EACCES' }))
      log.mockImplementation((code: string) => { if (code === 'PASTE_CLEANUP_FAILED') observed.resolve() })
    } else {
      vi.mocked(unlink).mockImplementationOnce(async (...args) => { await filesystem.unlink(...args); observed.resolve() })
    }
    await vi.advanceTimersByTimeAsync(PASTE_LIMITS.retentionMs)
    await observed.promise
    if (mode === 'removed' || mode === 'expires') expect(await readdir(directory)).toEqual([])
    else expect(await readdir(directory)).toEqual([answer.artifact.name])
  })
  it('validates begin bounds and leaves the original reservation alone on duplicate begin', async () => {
    const { files, request } = await fixture()
    for (const change of [{ generation: 'bad' }, { streamId: 'bad' }, { connection: '' }, { connection: 'x'.repeat(513) },
      { filename: '' }, { filename: 'x'.repeat(4097) }, { totalBytes: NaN }, { totalBytes: 0 }, { totalBytes: PASTE_LIMITS.fileBytes + 1 }]) {
      expect(await files.begin({ ...request, ...change })).toEqual({ error: 'PASTE_INVALID_UPLOAD' })
    }
    expect(await files.begin(request)).toEqual({ accepted: true })
    expect(await files.begin(request)).toEqual({ error: 'PASTE_UPLOAD_BUSY' })
    files.cancel('unknown')
    expect(await files.chunk({ ...request, streamId: randomUUID(), seq: 0 }, new Uint8Array(8))).toEqual({ error: 'PASTE_INVALID_UPLOAD' })
  })

  it('bounds the global admission count and does not release cancelled I/O reservations early', async () => {
    const held = deferred<void>(), entered = deferred<void>()
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await filesystem.open(...args)
      const write = handle.write.bind(handle)
      vi.spyOn(handle, 'write').mockImplementation((async (...call: unknown[]) => {
        entered.resolve(); await held.promise
        return Reflect.apply(write, handle, call)
      }) as typeof handle.write)
      return handle
    })
    const { files, request } = await fixture()
    const uploads = Array.from({ length: 32 }, (_, index) => ({ ...request, generation: randomUUID(), connection: `client-${index}` }))
    expect(await files.begin(uploads[0])).toEqual({ accepted: true })
    const writing = files.chunk({ ...uploads[0], seq: 0 }, new Uint8Array(8))
    await entered.promise
    for (const upload of uploads.slice(1)) expect(await files.begin(upload)).toEqual({ accepted: true })
    files.cancel(uploads[0].generation)
    expect(await files.begin(request)).toEqual({ error: 'PASTE_CAPACITY' })
    held.resolve()
    expect(await writing).toEqual({ ignored: true })
    await files.stop()
  })

  it('bounds an operation timeout while its actual write and reservation remain unsettled', async () => {
    vi.useFakeTimers()
    const held = deferred<void>(), entered = deferred<void>()
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await filesystem.open(...args), write = handle.write.bind(handle)
      vi.spyOn(handle, 'write').mockImplementation((async (...call: unknown[]) => {
        entered.resolve(); await held.promise; return Reflect.apply(write, handle, call)
      }) as typeof handle.write)
      return handle
    })
    const { files, request, log } = await fixture()
    await files.begin(request)
    const writing = files.chunk({ ...request, seq: 0 }, new Uint8Array(8))
    await entered.promise
    await vi.advanceTimersByTimeAsync(PASTE_LIMITS.operationMs)
    expect(await writing).toEqual({ error: 'PASTE_UPLOAD_TIMEOUT' })
    expect(log).toHaveBeenCalledWith('PASTE_UPLOAD_TIMEOUT')
    held.resolve()
    await files.stop()
  })

  it('rejects a fifth unacknowledged chunk and removes its four queued predecessors on cancellation', async () => {
    const held = deferred<void>(), entered = deferred<void>()
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await filesystem.open(...args), write = handle.write.bind(handle)
      vi.spyOn(handle, 'write').mockImplementationOnce((async (...call: unknown[]) => {
        entered.resolve(); await held.promise; return Reflect.apply(write, handle, call)
      }) as typeof handle.write)
      return handle
    })
    const { files, request } = await fixture()
    request.totalBytes = PASTE_LIMITS.chunkBytes * 5
    await files.begin(request)
    const bytes = new Uint8Array(PASTE_LIMITS.chunkBytes)
    const pending = Array.from({ length: 4 }, (_, seq) => files.chunk({ ...request, seq }, bytes))
    await entered.promise
    expect(await files.chunk({ ...request, seq: 4 }, bytes)).toEqual({ error: 'PASTE_WINDOW_EXCEEDED' })
    held.resolve()
    expect(await Promise.all(pending)).toEqual(pending.map(() => ({ ignored: true })))
  })

  it('reports write failures and failed deletion by name without releasing capacity', async () => {
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await filesystem.open(...args)
      vi.spyOn(handle, 'write').mockImplementation(async (buffer) => ({ bytesWritten: 0, buffer }))
      return handle
    })
    const { files, request, log } = await fixture()
    await files.begin(request)
    vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error('private fixture detail'), { code: 'EACCES' }))
    expect(await files.chunk({ ...request, seq: 0 }, new Uint8Array(8))).toEqual({ error: 'PASTE_WRITE_STALLED' })
    await files.stop()
    expect(log).toHaveBeenCalledWith('PASTE_CLEANUP_FAILED')
    expect(log.mock.calls.flat().join(' ')).not.toContain('private fixture detail')
  })

  it('expires only recognized old artifacts and preserves foreign files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paste-inventory-')); roots.push(root)
    const dir = join(root, 'paste-drops', 'file-uploads')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const old = [`${randomUUID()}-old.txt`, `${randomUUID()}.part`, 'foreign.txt']
    for (const name of old) { await writeFile(join(dir, name), 'fixture', { mode: 0o600 }); await utimes(join(dir, name), 1, 1) }
    const files = createPasteFiles(root, { now: () => Date.now(), log: vi.fn() }); services.push(files)
    const request = { generation: randomUUID(), streamId: randomUUID(), connection: 'client', filename: 'x', totalBytes: 1 }
    expect(await files.begin(request)).toEqual({ accepted: true })
    await files.stop()
    expect(await readdir(dir)).toEqual(['foreign.txt'])
  })

  it('orders retained expiries and preserves generation reservations until every artifact expires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paste-expiry-order-')); roots.push(root)
    const dir = join(root, 'paste-drops', 'file-uploads')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const oldGeneration = randomUUID(), future = `${randomUUID()}-future.txt`
    const names = [future, `${oldGeneration}-a.txt`, `${oldGeneration}-b.txt`]
    for (const name of names) {
      await writeFile(join(dir, name), 'fixture', { mode: 0o600 })
      if (name !== future) await utimes(join(dir, name), 1, 1)
    }
    vi.mocked(opendir).mockResolvedValueOnce({ async *[Symbol.asyncIterator]() { for (const name of names) yield { name } } } as unknown as Awaited<ReturnType<typeof opendir>>)
    const files = createPasteFiles(root, { log: vi.fn() }); services.push(files)
    const request = { generation: randomUUID(), streamId: randomUUID(), connection: 'client', filename: 'x', totalBytes: 1 }
    expect(await files.begin(request)).toEqual({ accepted: true })
    await files.stop()
    expect(await readdir(dir)).toEqual([future])
  })

  it('tolerates a removed staging file when cancellation releases its reservation', async () => {
    const { files, request, directory, log } = await fixture()
    await files.begin(request)
    await filesystem.unlink(join(directory, `${request.generation}.part`))
    files.cancel(request.generation)
    await files.stop()
    expect(log).not.toHaveBeenCalledWith('PASTE_CLEANUP_FAILED')
  })

  it('sanitizes terminal controls, path syntax and long UTF-8 names inside the worker', async () => {
    const { files, request } = await fixture()
    for (const filename of ['  ... ', '\u001b[2J/\\:'.repeat(30), '猫'.repeat(120)]) {
      const upload = { ...request, generation: randomUUID(), filename }
      await files.begin(upload)
      const result = await files.chunk({ ...upload, seq: 0 }, new Uint8Array(8))
      if (!('artifact' in result) || !result.artifact) throw new Error('missing artifact')
      expect(Buffer.byteLength(result.artifact.name)).toBeLessThanOrEqual(157)
      expect(result.artifact.name).not.toMatch(/[\x00-\x1f/\\:]/)
    }
  })
  it('publishes only complete private bytes and proves the selected artifact without reading it in core', async () => {
    const { files, request, root } = await fixture()
    expect(await files.begin(request)).toEqual({ accepted: true })
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
    const answer = await files.chunk({ ...request, seq: 0 }, bytes)
    expect(answer).toMatchObject({ bytesWritten: 8, totalBytes: 8 })
    if (!('artifact' in answer) || !answer.artifact) throw new Error('missing artifact')
    const prepared = openPreparedPaste(request.generation, answer.artifact, root)
    expect(prepared.current()).toBe(true)
    expect(await readFile(prepared.path)).toEqual(Buffer.from(bytes))
    expect(await files.chunk({ ...request, seq: 0 }, bytes)).toEqual({ ignored: true })
    prepared.close()
    expect(await files.begin(request)).toEqual({ error: 'PASTE_UPLOAD_BUSY' })
  })

  it('accepts ten independent four-chunk windows and has no complete file before the last chunk', async () => {
    const { files, request, directory } = await fixture()
    const requests = Array.from({ length: 10 }, (_, index) => ({ ...request, generation: randomUUID(), streamId: randomUUID(),
      connection: `client-${index}`, totalBytes: PASTE_LIMITS.chunkBytes * 5 }))
    expect(await Promise.all(requests.map((upload) => files.begin(upload)))).toEqual(requests.map(() => ({ accepted: true })))
    const bytes = new Uint8Array(PASTE_LIMITS.chunkBytes)
    const answers = await Promise.all(requests.flatMap((upload) => Array.from({ length: 4 }, (_, seq) => files.chunk({ ...upload, seq }, bytes))))
    expect(answers.every((answer) => 'bytesWritten' in answer && !answer.artifact)).toBe(true)
    expect((await readdir(directory)).every((name) => name.endsWith('.part'))).toBe(true)
    const complete = await Promise.all(requests.map((upload) => files.chunk({ ...upload, seq: 4 }, bytes)))
    expect(complete.every((answer) => 'artifact' in answer)).toBe(true)
  })

  it('refuses a fifth upload on one connection, retaining all four reservations', async () => {
    const { files, request } = await fixture()
    const requests = Array.from({ length: 4 }, () => ({ ...request, generation: randomUUID() }))
    expect(await Promise.all(requests.map((upload) => files.begin(upload)))).toEqual(requests.map(() => ({ accepted: true })))
    expect(await files.begin({ ...request, generation: randomUUID() })).toEqual({ error: 'PASTE_CAPACITY' })
    files.cancel(null)
  })

  it('rejects wrong geometry, stray uploads and the wrong connection without publishing a path', async () => {
    const { files, request, directory } = await fixture()
    expect(await files.chunk({ ...request, seq: 0 }, new Uint8Array(8))).toEqual({ error: 'PASTE_UPLOAD_UNAVAILABLE' })
    expect(await files.begin(request)).toEqual({ accepted: true })
    expect(await files.chunk({ ...request, connection: 'other', seq: 0 }, new Uint8Array(8))).toEqual({ error: 'PASTE_INVALID_UPLOAD' })
    expect(await files.chunk({ ...request, seq: 0 }, new Uint8Array(7))).toEqual({ error: 'PASTE_INVALID_CHUNK' })
    await files.stop()
    expect(await readdir(directory)).toEqual([])
  })

  it('counts a repeated chunk once and accepts reordered chunks', async () => {
    const { files, request } = await fixture()
    request.totalBytes = PASTE_LIMITS.chunkBytes + 8
    await files.begin(request)
    expect(await files.chunk({ ...request, seq: 1 }, new Uint8Array(8))).toEqual({ bytesWritten: 8, totalBytes: request.totalBytes })
    expect(await files.chunk({ ...request, seq: 1 }, new Uint8Array(8))).toEqual({ bytesWritten: 8, totalBytes: request.totalBytes })
    expect(await files.chunk({ ...request, seq: 0 }, new Uint8Array(PASTE_LIMITS.chunkBytes))).toHaveProperty('artifact')
  })

  it('removes cancelled staging work but preserves legacy files and completed drops', async () => {
    const { files, request, root, directory } = await fixture()
    await mkdir(join(root, 'paste-drops'), { recursive: true })
    const legacy = join(root, 'paste-drops', 'legacy.pdf')
    await writeFile(legacy, 'legacy')
    await files.begin(request)
    files.cancel(request.generation)
    await files.stop()
    expect(await readFile(legacy, 'utf8')).toBe('legacy')
    expect(await readdir(directory)).toEqual([])
    expect(await files.begin({ ...request, generation: randomUUID() })).toEqual({ error: 'PASTE_UNAVAILABLE' })
  })

  it('refuses an unsafe storage child and does not follow its link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paste-unsafe-')); roots.push(root)
    await mkdir(join(root, 'paste-drops'))
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(root, 'paste-drops', 'file-uploads'))
    const files = createPasteFiles(root, { log: vi.fn() }); services.push(files)
    expect(await files.begin({ generation: randomUUID(), streamId: randomUUID(), connection: 'client', filename: 'x', totalBytes: 1 }))
      .toHaveProperty('error')
    expect(await readdir(join(root, 'outside'))).toEqual([])
  })

  it('starts through the standard service port without a client route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paste-inline-')); roots.push(root)
    const core = fakeCore(); core.dataDir = root
    const ports = emptyPorts()
    expect(startPaste(core, ports)).toEqual({})
    expect(ports.paste).not.toBeNull()
    await ports.paste!.stop()
  })
})
