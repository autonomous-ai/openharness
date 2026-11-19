import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClipboardReservation } from './pasteClipboardReservation.js'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, mkdir: vi.fn(fs.mkdir), open: vi.fn(fs.open), opendir: vi.fn(fs.opendir), unlink: vi.fn(fs.unlink), rmdir: vi.fn(fs.rmdir), lstat: vi.fn(fs.lstat) }
})
const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function markerLeaf(directory: string): Promise<string> {
  const roots = await readdir(directory)
  for (const name of roots) {
    const parent = join(directory, name)
    if (!(await filesystem.lstat(parent)).isDirectory()) continue
    for (const child of await readdir(parent)) {
      const path = join(parent, child)
      if ((await filesystem.lstat(path)).isFile()) return path
    }
  }
  throw new Error('no reservation marker')
}

const roots: string[] = []
const PID = 27182, marker = 'fixture-core-start'
const tokenName = (generation: string, pid = PID, identity: string | null = marker) => `${pid}-${identity === null ? 'unknown' : createHash('sha256').update(identity).digest('hex')}-${generation}`
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'paste-reservation-')); roots.push(root)
  await mkdir(join(root, 'paste-drops'), { mode: 0o700 })
  const deps = { exists: vi.fn((_pid: number) => true), identity: vi.fn((): string | null => marker) }
  const directory = join(root, 'paste-drops', 'clipboard-reservations')
  return { root, deps, directory, reservation: createClipboardReservation(root, deps),
    held: join(directory, 'held'), token: (generation: string) => join(directory, 'held', tokenName(generation)) }
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.mocked(mkdir).mockReset().mockImplementation(filesystem.mkdir)
  vi.mocked(open).mockReset().mockImplementation(filesystem.open)
  vi.mocked(opendir).mockReset().mockImplementation(filesystem.opendir)
  vi.mocked(unlink).mockReset().mockImplementation(filesystem.unlink)
  vi.mocked(rmdir).mockReset().mockImplementation(filesystem.rmdir)
  vi.mocked(lstat).mockReset().mockImplementation(filesystem.lstat)
})

describe.skipIf(process.platform === 'win32')('clipboard reservation across worker replacement', () => {
  it('uses one global atomic claim even when two core instances observe an empty reservation root', async () => {
    const f = await fixture(), bothAdmitted = deferred()
    let admissions = 0
    vi.mocked(mkdir).mockImplementation(async (...args) => {
      if (String(args[0]) === f.held && admissions < 2) {
        if (++admissions === 2) bothAdmitted.resolve()
        await bothAdmitted.promise
      }
      return filesystem.mkdir(...args)
    })
    const second = createClipboardReservation(f.root, f.deps)
    const outcomes = await Promise.allSettled([f.reservation.claim(PID, randomUUID()), second.claim(PID + 1, randomUUID())])
    const claims = outcomes.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    try { expect(claims.filter(Boolean).length).toBeLessThanOrEqual(1) }
    finally { for (const claim of claims) await claim?.release() }
  })

  it('never lets a stale release unlink the successor marker after another releaser removes A', async () => {
    const f = await fixture(), a = randomUUID(), b = randomUUID(), paused = deferred(), resume = deferred()
    const first = await f.reservation.claim(PID, a)
    const original = await markerLeaf(f.directory)
    let held = false
    vi.mocked(unlink).mockImplementation(async (path) => {
      if (String(path) === original && !held) { held = true; paused.resolve(); await resume.promise }
      return filesystem.unlink(path)
    })
    const releasing = first!.release()
    await paused.promise
    const replacement = createClipboardReservation(f.root, f.deps)
    let successor: Awaited<ReturnType<typeof replacement.claim>> = null
    try {
      await replacement.release(PID, a)
      successor = await replacement.claim(PID, b)
      expect(successor).not.toBeNull()
      const current = await markerLeaf(f.directory)
      resume.resolve(); await releasing
      expect((await filesystem.lstat(current)).isFile()).toBe(true)
    } finally { resume.resolve(); await releasing.catch(() => {}); await successor?.release() }
  })

  it('persists one lease until the current port releases its exact generation', async () => {
    const f = await fixture(), a = randomUUID(), b = randomUUID()
    const claim = await f.reservation.claim(PID, a)
    expect(claim).not.toBeNull()
    expect(await readFile(f.token(a), 'utf8')).toBe('')
    const replacement = createClipboardReservation(f.root, f.deps)
    expect(await replacement.claim(PID, b)).toBeNull()
    await replacement.release(PID, b)
    expect(await replacement.claim(PID, b)).toBeNull()
    await replacement.release(PID, a)
    const successor = await replacement.claim(PID, b)
    expect(successor).not.toBeNull()
    await claim!.release()
    expect(await readFile(f.token(b), 'utf8')).toBe('')
    await successor!.release()
    await expect(readFile(f.token(a))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['claim', 'replacement'] as const)('releases an existing %s marker without publishing its namespace again', async (source) => {
    const f = await fixture(), generation = randomUUID(), claim = await f.reservation.claim(PID, generation)
    vi.mocked(mkdir).mockClear()
    const flushed: string[] = []
    vi.mocked(open).mockImplementation(async (...args) => {
      if (String(args[0]) === join(f.root, 'paste-drops')) throw new Error('unneeded parent flush')
      const fd = await filesystem.open(...args), sync = fd.sync.bind(fd)
      vi.spyOn(fd, 'sync').mockImplementation(async () => { await sync(); flushed.push(String(args[0])) })
      return fd
    })
    await (source === 'claim' ? claim!.release() : createClipboardReservation(f.root, f.deps).release(PID, generation))
    expect(mkdir).not.toHaveBeenCalled()
    expect(flushed).toEqual([f.directory])
    await expect(lstat(f.held)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['missing-root', 'missing-marker'] as const)('does not create or flush a namespace for a %s release', async (state) => {
    const f = await fixture()
    if (state === 'missing-marker') await filesystem.mkdir(f.directory, { mode: 0o700 })
    vi.mocked(mkdir).mockClear(); vi.mocked(open).mockClear()
    await f.reservation.release(PID, randomUUID())
    expect(mkdir).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
    if (state === 'missing-root') await expect(lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still rejects an unsafe empty reservation root during release', async () => {
    const f = await fixture()
    await mkdir(f.directory, { mode: 0o700 }); await chmod(f.directory, 0o777)
    await expect(f.reservation.release(PID, randomUUID())).rejects.toThrow('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
  })

  it('does not settle release before its removal flush settles', async () => {
    const f = await fixture(), claim = await f.reservation.claim(PID, randomUUID()), paused = deferred(), resume = deferred()
    vi.mocked(open).mockImplementation(async (...args) => {
      const fd = await filesystem.open(...args)
      if (String(args[0]) === f.directory) {
        const sync = fd.sync.bind(fd)
        vi.spyOn(fd, 'sync').mockImplementation(async () => { paused.resolve(); await resume.promise; await sync() })
      }
      return fd
    })
    let settled = false
    const releasing = claim!.release().then(() => { settled = true })
    try { await paused.promise; expect(settled).toBe(false) }
    finally { resume.resolve(); await releasing }
    expect(settled).toBe(true)
  })

  it.each(['token-open', 'token-synced'] as const)('keeps the %s crash prefix blocked while its core remains live', async () => {
    const f = await fixture(), a = randomUUID(), b = randomUUID()
    await mkdir(f.held, { recursive: true, mode: 0o700 })
    await writeFile(f.token(a), '', { mode: 0o600 })
    const replacement = createClipboardReservation(f.root, f.deps)
    expect(await replacement.claim(PID, b)).toBeNull()
    await replacement.release(PID, b)
    expect(await replacement.claim(PID, b)).toBeNull()
    f.deps.exists.mockImplementation((pid: number) => pid !== PID)
    const afterRestart = await replacement.claim(PID + 1, b)
    expect(afterRestart).not.toBeNull()
    await expect(readFile(f.token(a))).rejects.toMatchObject({ code: 'ENOENT' })
    await afterRestart!.release()
  })

  it.each(['mkdir', 'open'] as const)('fences a creator suspended after %s when a replacement recovers its empty prefix', async (phase) => {
    const f = await fixture(), a = randomUUID(), b = randomUUID(), paused = deferred(), resume = deferred()
    let intercepted = false
    if (phase === 'mkdir') vi.mocked(mkdir).mockImplementation(async (...args) => {
      const value = await filesystem.mkdir(...args)
      if (String(args[0]) === f.held && !intercepted) { intercepted = true; paused.resolve(); await resume.promise }
      return value
    })
    else vi.mocked(open).mockImplementation(async (...args) => {
      if (String(args[0]) === f.token(a) && !intercepted) { intercepted = true; paused.resolve(); await resume.promise }
      return filesystem.open(...args)
    })
    const attempted = f.reservation.claim(PID, a).then((claim) => ({ claim }), (error: unknown) => ({ error }))
    await paused.promise
    const replacement = createClipboardReservation(f.root, f.deps)
    const next = await replacement.claim(PID, b)
    try {
      expect(next).not.toBeNull()
      resume.resolve()
      expect(await attempted).not.toHaveProperty('claim', expect.anything())
      expect((await lstat(f.token(b))).isFile()).toBe(true)
      expect(await replacement.claim(PID, randomUUID())).toBeNull()
    } finally { resume.resolve(); await attempted; await next?.release() }
  })

  it('retains its slot during token fsync and releases only after that OS operation settles', async () => {
    const f = await fixture(), a = randomUUID(), paused = deferred(), resume = deferred()
    vi.mocked(open).mockImplementation(async (...args) => {
      const fd = await filesystem.open(...args)
      if (String(args[0]) === f.token(a)) {
        const sync = fd.sync.bind(fd)
        vi.spyOn(fd, 'sync').mockImplementation(async () => { paused.resolve(); await resume.promise; await sync() })
      }
      return fd
    })
    const attempted = f.reservation.claim(PID, a)
    await paused.promise
    const replacement = createClipboardReservation(f.root, f.deps)
    try { expect(await replacement.claim(PID + 1, randomUUID())).toBeNull() }
    finally { resume.resolve() }
    const claim = await attempted
    expect(claim).not.toBeNull(); await claim!.release()
  })

  it('treats unreadable native identity as live, and recognizes proven PID reuse', async () => {
    const f = await fixture(), a = randomUUID(), b = randomUUID()
    await f.reservation.claim(PID, a)
    f.deps.identity.mockReturnValue(null)
    expect(await createClipboardReservation(f.root, f.deps).claim(PID, b)).toBeNull()
    f.deps.identity.mockReturnValue('replacement-core-start')
    const next = await createClipboardReservation(f.root, f.deps).claim(PID, b)
    expect(next).not.toBeNull(); await next!.release()
  })

  it('keeps an unknown birth marker blocked until its PID is proven absent', async () => {
    const f = await fixture(), a = randomUUID()
    f.deps.identity.mockReturnValue(null)
    await f.reservation.claim(PID, a)
    f.deps.identity.mockReturnValue(marker)
    expect(await f.reservation.claim(PID, randomUUID())).toBeNull()
    f.deps.exists.mockImplementation((pid: number) => pid !== PID)
    const next = await f.reservation.claim(PID + 1, randomUUID())
    expect(next).not.toBeNull(); await next!.release()
  })

  it('does not mistake a failed process probe for a dead core', async () => {
    const f = await fixture(), a = randomUUID()
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('unreadable'), { code: 'EIO' }) })
    const reservation = createClipboardReservation(f.root, { identity: f.deps.identity })
    const claim = await reservation.claim(PID, a)
    expect(claim).not.toBeNull()
    expect(await reservation.claim(PID, randomUUID())).toBeNull()
    await claim!.release()
  })

  it('admits at most one competing claim within the same worker', async () => {
    const f = await fixture(), a = randomUUID(), b = randomUUID()
    const [first, second] = await Promise.all([f.reservation.claim(PID, a), f.reservation.claim(PID, b)])
    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect(await readFile(f.token(first ? a : b), 'utf8')).toBe('')
    await (first ?? second)!.release()
  })

  it.each(['root', 'held'] as const)('refuses another claim while this worker publishes its %s directory', async (phase) => {
    const f = await fixture(), a = randomUUID(), b = randomUUID(), paused = deferred(), resume = deferred()
    let intercepted = false
    vi.mocked(mkdir).mockImplementation(async (...args) => {
      const value = await filesystem.mkdir(...args)
      if (String(args[0]) === (phase === 'root' ? f.directory : f.held) && !intercepted) {
        intercepted = true; paused.resolve(); await resume.promise
      }
      return value
    })
    const attempted = f.reservation.claim(PID, a).then((claim) => ({ claim }), (error: unknown) => ({ error }))
    await paused.promise
    let competing: Awaited<ReturnType<typeof f.reservation.claim>> = null
    try {
      competing = await f.reservation.claim(PID, b)
      expect(competing).toBeNull()
      resume.resolve()
      const result = await attempted
      expect(result).toHaveProperty('claim', expect.anything())
      expect(await readFile(f.token(a), 'utf8')).toBe('')
    } finally {
      resume.resolve()
      const result = await attempted
      await competing?.release()
      if ('claim' in result) await result.claim?.release()
    }
    const successor = await f.reservation.claim(PID, b)
    expect(successor).not.toBeNull(); await successor!.release()
  })

  it('refuses malformed tokens and bounded malformed or multiple marker children', async () => {
    const f = await fixture()
    await expect(f.reservation.claim(PID, 'not-a-token')).rejects.toThrow('PASTE_INVALID_UPLOAD')
    await f.reservation.release(PID, 'not-a-token')
    await mkdir(f.held, { recursive: true, mode: 0o700 })
    await writeFile(join(f.held, 'unknown'), '', { mode: 0o600 })
    await expect(f.reservation.claim(PID, randomUUID())).rejects.toThrow('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
    await writeFile(join(f.held, 'extra'), '', { mode: 0o600 })
    await expect(f.reservation.claim(PID, randomUUID())).rejects.toThrow('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
    expect(await readdir(f.held)).toHaveLength(2)
  })

  it.skipIf(process.platform === 'win32')('refuses links and writable reservation ancestry without touching their targets', async () => {
    const f = await fixture(), elsewhere = join(f.root, 'elsewhere')
    await mkdir(elsewhere, { mode: 0o700 }); await symlink(elsewhere, f.directory)
    await expect(f.reservation.claim(PID, randomUUID())).rejects.toThrow('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
    expect(await readdir(elsewhere)).toEqual([])
    await rm(f.directory); await mkdir(f.directory, { mode: 0o700 }); await chmod(f.directory, 0o777)
    await expect(f.reservation.claim(PID, randomUUID())).rejects.toThrow('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
  })
  it.each([0, -1, 0x80000000, NaN])('rejects an invalid core PID %s before acquiring a native slot', async (pid) => {
    const f = await fixture()
    await expect(f.reservation.claim(pid, randomUUID())).rejects.toThrow('PASTE_CLIPBOARD_CORE_UNAVAILABLE')
  })

  it('treats only ESRCH as proven absence in the default process probe', async () => {
    const f = await fixture()
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('absent'), { code: 'ESRCH' }) })
    await expect(createClipboardReservation(f.root).claim(PID, randomUUID())).rejects.toThrow('PASTE_CLIPBOARD_CORE_UNAVAILABLE')
  })

  it('rejects writable data ancestry, held directories and altered token contents', async () => {
    const f = await fixture(), a = randomUUID()
    await chmod(join(f.root, 'paste-drops'), 0o777)
    await expect(f.reservation.claim(PID, a)).rejects.toThrow('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
    await chmod(join(f.root, 'paste-drops'), 0o700)
    await mkdir(f.held, { recursive: true, mode: 0o700 }); await chmod(f.held, 0o777)
    await expect(f.reservation.claim(PID, a)).rejects.toThrow('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
    await chmod(f.held, 0o700); await writeFile(f.token(a), 'altered', { mode: 0o600 })
    await expect(f.reservation.claim(PID, randomUUID())).rejects.toThrow('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
    await expect(f.reservation.release(PID, a)).rejects.toThrow('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
  })

  it.each(['root', 'held'] as const)('reports actual %s mkdir failure', async (level) => {
    const f = await fixture()
    vi.mocked(mkdir).mockImplementation(async (...args) => {
      if (String(args[0]) === (level === 'root' ? f.directory : f.held)) throw Object.assign(new Error('fixture IO'), { code: 'EIO' })
      return filesystem.mkdir(...args)
    })
    await expect(f.reservation.claim(PID, randomUUID())).rejects.toThrow('fixture IO')
    vi.mocked(mkdir).mockImplementation(filesystem.mkdir)
    const successor = await f.reservation.claim(PID, randomUUID())
    expect(successor).not.toBeNull(); await successor!.release()
  })

  it('recovers when another releaser removed the directory after mkdir found it occupied', async () => {
    const f = await fixture()
    let intercepted = false
    vi.mocked(mkdir).mockImplementation(async (...args) => {
      if (String(args[0]) === f.held && !intercepted) { intercepted = true; throw Object.assign(new Error('occupied'), { code: 'EEXIST' }) }
      return filesystem.mkdir(...args)
    })
    const claim = await f.reservation.claim(PID, randomUUID())
    expect(claim).not.toBeNull(); await claim!.release()
  })

  it.each(['ENOTEMPTY', 'EACCES'] as const)('does not force-remove an empty prefix changed during recovery (%s)', async (code) => {
    const f = await fixture(), other = randomUUID()
    await mkdir(f.held, { recursive: true, mode: 0o700 })
    vi.mocked(rmdir).mockImplementationOnce(async () => {
      await writeFile(f.token(other), '', { mode: 0o600 })
      throw Object.assign(new Error('changed'), { code })
    })
    const claimed = f.reservation.claim(PID, randomUUID())
    if (code === 'ENOTEMPTY') expect(await claimed).toBeNull()
    else await expect(claimed).rejects.toThrow('changed')
    expect(await readFile(f.token(other), 'utf8')).toBe('')
  })

  it.each(['unlink', 'rmdir'] as const)('keeps release IO failures visible at %s', async (operation) => {
    const f = await fixture(), a = randomUUID(), claim = await f.reservation.claim(PID, a)
    if (operation === 'unlink') vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error('release IO'), { code: 'EIO' }))
    else vi.mocked(rmdir).mockRejectedValueOnce(Object.assign(new Error('release IO'), { code: 'EIO' }))
    await expect(claim!.release()).rejects.toThrow('release IO')
  })

  it('rejects a changed directory descriptor before syncing it', async () => {
    const f = await fixture()
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const fd = await filesystem.open(...args), stat = await fd.stat({ bigint: true })
      vi.spyOn(fd, 'stat').mockResolvedValue({ ...stat, ino: stat.ino + 1n } as never)
      return fd
    })
    await expect(f.reservation.claim(PID, randomUUID())).rejects.toThrow('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
  })

  it('rejects an unsafe directory returned after exclusive creation', async () => {
    const f = await fixture()
    vi.mocked(mkdir).mockImplementation(async (...args) => {
      const value = await filesystem.mkdir(...args)
      if (String(args[0]) === f.held) await chmod(f.held, 0o777)
      return value
    })
    await expect(f.reservation.claim(PID, randomUUID())).rejects.toThrow('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
  })

  it('rejects a token that becomes unsafe after durable directory publication', async () => {
    const f = await fixture(), a = randomUUID()
    vi.mocked(open).mockImplementation(async (...args) => {
      const fd = await filesystem.open(...args)
      if (String(args[0]) === f.directory) {
        const sync = fd.sync.bind(fd)
        vi.spyOn(fd, 'sync').mockImplementation(async () => { await sync(); await writeFile(f.token(a), 'altered') })
      }
      return fd
    })
    await expect(f.reservation.claim(PID, a)).rejects.toThrow('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
  })

  it('refuses a held directory replaced by a regular file before its durability fence', async () => {
    const f = await fixture(), a = randomUUID()
    vi.mocked(open).mockImplementation(async (...args) => {
      const fd = await filesystem.open(...args)
      if (String(args[0]) === f.token(a)) {
        const close = fd.close.bind(fd)
        vi.spyOn(fd, 'close').mockImplementation(async () => {
          await close(); await rename(f.held, join(f.directory, 'replaced')); await writeFile(f.held, '', { mode: 0o600 })
        })
      }
      return fd
    })
    await expect(f.reservation.claim(PID, a)).rejects.toThrow()
    expect((await lstat(f.held)).isFile()).toBe(true)
  })

})
