import { createHash } from 'node:crypto'
import { cpSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, type Dir } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectHookFile, runHookPreparation } from './nativeHookFiles.js'
import { createNativeHookStagePool, type NativeHookStageLease, type NativeHookWriter } from './nativeHookStaging.js'

const fault = vi.hoisted(() => ({ fail: false,
  defer: undefined as ((fd: number, done: (error: Error | null) => void) => boolean) | undefined,
  openDirectory: undefined as ((path: string, open: () => Dir) => Dir) | undefined,
  readLink: undefined as ((path: string, read: () => string) => string) | undefined,
  publish: undefined as ((text: string, path: string) => void) | undefined,
  stat: undefined as ((path: string, read: () => unknown) => unknown) | undefined,
}))
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs,
  fsync: (fd: number, done: (error: Error | null) => void) => {
    if (fault.defer?.(fd, done)) return
    queueMicrotask(() => done(fault.fail ? Error('fixture disk unavailable') : null))
  },
  opendirSync: (path: string, options: Parameters<typeof fs.opendirSync>[1]) => fault.openDirectory?.(path, () => fs.opendirSync(path, options)) ?? fs.opendirSync(path, options),
  readlinkSync: (path: string) => fault.readLink?.(path, () => fs.readlinkSync(path)) ?? fs.readlinkSync(path),
  symlinkSync: (text: string, path: string) => { fault.publish?.(text, path); fs.symlinkSync(text, path) },
  lstatSync: (path: string, options: Parameters<typeof fs.lstatSync>[1]) => fault.stat?.(path, () => fs.lstatSync(path, options)) ?? fs.lstatSync(path, options),
} })
let root: string
const writer = (pid = 8100): NativeHookWriter => ({ boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace: 'linux:4:5', pid, birth: '12345' })
const pool = (options: Partial<Parameters<typeof createNativeHookStagePool>[0]> = {}) => createNativeHookStagePool({ root, writer: writer(), verifyWriter: () => {}, closeWriter: () => {}, dead: async () => false, ...options })
const stages = () => readdirSync(root, { recursive: true }).map(String).filter(name => name.endsWith('.tmp'))
const resetFaults = () => { fault.fail = false; fault.defer = undefined; fault.openDirectory = undefined; fault.readLink = undefined; fault.publish = undefined; fault.stat = undefined }

it('rejects a network-view writer before it can publish a claim visible to a local server', async () => {
  const remote = pool({ verifyWriter: () => { throw Error('fixture root is network mounted') } })
  await expect(remote.acquire()).rejects.toThrow('network mounted')
  expect(readdirSync(root)).toEqual([])
  const local = await pool().acquire()
  await local.close()
})

it('keeps local-root authority on stage publication and cleanup after writer capture', async () => {
  let local = true
  const captured = pool({ verifyWriter: () => { if (!local) throw Error('fixture local mount changed') } })
  const lease = await captured.acquire(), stage = lease.stage(join(root, 'receipt'))
  writeFileSync(stage.path, 'retained private staging bytes', { mode: 0o600 })
  local = false
  expect(() => stage.verify()).toThrow('local mount changed')
  expect(() => stage.verifyCleanup()).toThrow('local mount changed')
  expect(readFileSync(stage.path, 'utf8')).toBe('retained private staging bytes')
})
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-staging-'))); resetFaults() })
afterEach(() => { resetFaults(); rmSync(root, { recursive: true, force: true }) })
async function publish(lease: NativeHookStageLease, text: string, target = join(root, 'receipt')) {
  await runHookPreparation([target], attempt => inspectHookFile(target, 0o600).replace(text, attempt, true, lease.stage))
  return target
}

it('publishes from bounded staging and never creates a random journal temporary', async () => {
  const lease = await pool().acquire()
  const target = await publish(lease, 'original bytes')
  expect(readFileSync(target, 'utf8')).toBe('original bytes')
  expect(stages()).toEqual([])
  const stage = lease.stage(join(root, 'next'))
  expect(stage.path).toMatch(/00000000\.[a-f0-9-]{36}\.2\.tmp$/)
  await stage.finish(); await lease.close()
  expect(() => lease.verify()).toThrow('released')
  expect(stages()).toEqual([])
})

it('holds the ninth writer without creating unbounded reservation or stage names', async () => {
  const client = pool(), leases: NativeHookStageLease[] = []
  for (let index = 0; index < 8; index++) leases.push(await client.acquire())
  const before = readdirSync(root, { recursive: true }).map(String).sort()
  await expect(pool({ writer: writer(8200) }).acquire()).rejects.toThrow('another writer owns this lane')
  expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before)
  expect(stages()).toEqual([])
  await Promise.all(leases.map(lease => lease.close()))
})

it('confirms predecessor release before the next generation may stage', async () => {
  const first = await pool().acquire()
  await publish(first, 'first bytes'); await first.close()
  const next = await pool({ writer: writer(8200) }).acquire()
  const stage = next.stage(join(root, 'second'))
  expect(stage.path).toMatch(/00000001\.[a-f0-9-]{36}\.1\.tmp$/)
  await stage.finish(); await next.close()
})

it('keeps actual I/O and the lane after a preparation timeout, then cleans under generation authority', async () => {
  const client = pool(), leases: NativeHookStageLease[] = []
  for (let index = 0; index < 8; index++) leases.push(await client.acquire())
  let flush!: () => void, delayed = false, fdHeld = -1
  fault.defer = (fd, done) => {
    if (delayed || !fstatSync(fd).isFile()) return false
    delayed = true; fdHeld = fd; flush = () => done(null); return true
  }
  const target = join(root, 'timed-out-receipt')
  const preparation = runHookPreparation([target], attempt => inspectHookFile(target, 0o600).replace('held bytes', attempt, true, leases[0].stage), { timeoutMs: 30 })
  await expect(preparation).rejects.toThrow('deadline')
  expect(delayed).toBe(true)
  expect(fstatSync(fdHeld).isFile()).toBe(true)
  expect(stages()).toHaveLength(1)
  let closed = false
  const closing = leases[0].close().then(() => { closed = true })
  await expect(pool({ writer: writer(8200) }).acquire()).rejects.toThrow('another writer owns this lane')
  expect(closed).toBe(false)
  expect(existsSync(target)).toBe(false)
  flush(); await closing
  expect(() => fstatSync(fdHeld)).toThrow()
  expect(stages()).toEqual([])
  expect(existsSync(target)).toBe(false)
  const replacement = await pool({ writer: writer(8200) }).acquire()
  await replacement.close()
  for (const lease of leases.slice(1)) await lease.close()
})

it('reclaims only the dead generation and fences a stale cleaner from the successor stage', async () => {
  const first = await pool().acquire(), old = first.stage(join(root, 'old'))
  writeFileSync(old.path, 'abandoned bytes', { mode: 0o600 })
  const proof = vi.fn(async (owner: NativeHookWriter) => owner.pid === 8100)
  const successor = await pool({ writer: writer(8200), dead: proof }).acquire()
  expect(proof).toHaveBeenCalledWith(writer())
  expect(existsSync(old.path)).toBe(false)
  const live = successor.stage(join(root, 'live'))
  writeFileSync(live.path, 'successor bytes', { mode: 0o600 })
  await expect(old.finish()).rejects.toThrow('later writer')
  await expect(first.close()).rejects.toThrow('later writer')
  expect(readFileSync(live.path, 'utf8')).toBe('successor bytes')
  unlinkSync(live.path); await live.finish(); await successor.close()
})

it('does not treat unavailable process evidence as writer death', async () => {
  const client = pool(), leases: NativeHookStageLease[] = []
  for (let index = 0; index < 8; index++) leases.push(await client.acquire())
  const before = readdirSync(root, { recursive: true }).map(String).sort()
  await expect(pool({ writer: writer(8200), dead: async () => { throw Error('native process table unavailable') } }).acquire())
    .rejects.toThrow('process table unavailable')
  expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before)
  for (const lease of leases) await lease.close()
})

it('re-reads only a discarded batch after ancestor sibling churn without skipping the retained lane', async () => {
  const first = await pool().acquire(); await first.close()
  let scanning = false, changed = false
  fault.openDirectory = (path, original) => {
    if (path === join(root, '.native-hook-stage-0')) scanning = true
    return original()
  }
  fault.readLink = (path, original) => {
    if (scanning && !changed && path.endsWith('/00000000.claim')) {
      changed = true; writeFileSync(join(root, 'unrelated-entry'), 'fixture sibling churn')
    }
    return original()
  }
  const lease = await pool().acquire(), stage = lease.stage(join(root, 'receipt'))
  expect(changed).toBe(true)
  expect(stage.path).toContain('.native-hook-stage-0/00000001.')
  await stage.finish(); await lease.close()
})

it('bounds repeated ancestor churn and never publishes from a discarded batch', async () => {
  const first = await pool().acquire(); await first.close()
  let scanning = false, changes = 0
  fault.openDirectory = (path, original) => {
    if (path === join(root, '.native-hook-stage-0')) scanning = true
    return original()
  }
  fault.readLink = (path, original) => {
    if (scanning && path === join(root, '.native-hook-stage-0.witnesses/00000000.claim')) {
      writeFileSync(join(root, `fixture-churn-${++changes}`), '')
    }
    return original()
  }
  const lease = await pool().acquire(), stage = lease.stage(join(root, 'receipt'))
  expect(changes).toBeGreaterThan(1)
  expect(changes).toBeLessThanOrEqual(9)
  expect(stage.path).toContain('.native-hook-stage-1/00000000.')
  expect(readdirSync(join(root, '.native-hook-stage-0')).filter(name => name.endsWith('.claim'))).toEqual(['00000000.claim'])
  await stage.finish(); await lease.close()
})

it('keeps a lane held when its bounded generation history is exhausted', async () => {
  const client = pool({ maxGenerations: 1 })
  for (let index = 0; index < 8; index++) { const lease = await client.acquire(); await lease.close() }
  const before = readdirSync(root, { recursive: true }).map(String).sort()
  await expect(client.acquire()).rejects.toThrow('generation capacity is exhausted')
  expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before)
})

it('does not treat busy normal writers as exhaustion that unlocks terminal capacity', async () => {
  const client = pool({ maxGenerations: 3, terminalGenerations: 1 }), leases = []
  for (let lane = 0; lane < 8; lane++) leases.push(await client.acquire())
  await expect(client.acquire(() => true, { purpose: 'terminal' })).rejects.toThrow('not proven exhausted')
  expect(readdirSync(root, { recursive: true }).map(String).some(name => name.endsWith('00000002.claim'))).toBe(false)
  await Promise.all(leases.map(lease => lease.close()))
})

it('confirms every exhausted prefix before publishing the first terminal reservation', async () => {
  const client = pool({ maxGenerations: 2, terminalGenerations: 1 })
  for (let index = 0; index < 8; index++) { const lease = await client.acquire(); await lease.close() }
  let release!: () => void, paused = false
  fault.defer = (fd, done) => {
    if (paused || !fstatSync(fd).isDirectory()) return false
    paused = true; release = () => done(null); return true
  }
  const pending = client.acquire(() => true, { purpose: 'terminal' })
  await vi.waitFor(() => expect(paused).toBe(true))
  try {
    expect(readdirSync(root, { recursive: true }).map(String).some(name => name.endsWith('00000001.claim'))).toBe(false)
  } finally { release(); const lease = await pending; await lease.close() }
  await expect(client.acquire()).rejects.toThrow('generation capacity')
})

it('retains a terminal capacity hold after repeated completion attempts consume its finite reserve', async () => {
  const client = pool({ maxGenerations: 2, terminalGenerations: 1 })
  for (let index = 0; index < 8; index++) { const lease = await client.acquire(); await lease.close() }
  for (let index = 0; index < 8; index++) {
    const lease = await client.acquire(() => true, { purpose: 'terminal' }); await lease.close()
  }
  const before = readdirSync(root, { recursive: true }).map(String).sort()
  await expect(client.acquire(() => true, { purpose: 'terminal' })).rejects.toThrow('generation capacity')
  expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before)
})

it('serializes sequential stages and drains cleanup before allowing another', async () => {
  const lease = await pool().acquire(), first = lease.stage(join(root, 'first'))
  expect(() => lease.stage(join(root, 'second'))).toThrow('already has a stage')
  let release!: () => void, delayed = false
  fault.defer = (_fd, done) => {
    if (delayed) return false
    delayed = true; release = () => done(null); return true
  }
  const cleaning = first.finish()
  await vi.waitFor(() => expect(delayed).toBe(true))
  expect(() => lease.stage(join(root, 'second'))).toThrow('already has a stage')
  release(); await cleaning
  const second = lease.stage(join(root, 'second'))
  expect(second.path).not.toBe(first.path)
  await second.finish(); await lease.close()
})

it.each(['deadline', 'revocation'])('refuses a lease when its final namespace inspection crosses %s', async kind => {
  let now = 0, current = true, crossed = false
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  const client = pool()
  const lane = join(root, '.native-hook-stage-0')
  fault.stat = (path, read) => {
    try { return read() } finally {
      if (path === lane + '.witnesses/00000000.release'
        && readdirSync(lane + '.witnesses').includes('00000000.claim')) {
        crossed = true
        if (kind === 'deadline') now = 5_000
        else current = false
      }
    }
  }
  try {
    await expect(client.acquire(() => current, { timeoutMs: 1_000 })).rejects.toThrow(kind === 'deadline' ? 'deadline' : 'revoked')
    expect(crossed).toBe(true)
    expect(stages()).toEqual([])
    // Expiration prevents admission but cannot revoke exact claim cleanup.
    await client.close()
    expect(lstatSync(lane + '.witnesses/00000000.release').isSymbolicLink()).toBe(true)
  } finally { fault.stat = undefined; clock.mockRestore(); await client.close() }
})

it('retains lease cleanup when the delivery guard throws and its first cleanup publication fails', async () => {
  let throwing = false, cleanupUnavailable = true, crossed = false
  const closeWriter = vi.fn(), client = pool({ closeWriter })
  const lane = join(root, '.native-hook-stage-0')
  fault.stat = (path, read) => {
    try { return read() } finally {
      if (path === lane + '.witnesses/00000000.release'
        && readdirSync(lane + '.witnesses').includes('00000000.claim')) {
        crossed = true; queueMicrotask(() => { throwing = true })
      }
    }
  }
  fault.publish = (_text, path) => {
    if (cleanupUnavailable && path.endsWith('00000000.release')) throw Error('fixture cleanup publication unavailable')
  }
  try {
    await expect(client.acquire(() => {
      if (throwing) throw Error('fixture delivery guard unavailable')
      return true
    })).rejects.toThrow('cleanup publication unavailable')
    expect(crossed).toBe(true)
    expect(closeWriter).not.toHaveBeenCalled()
    cleanupUnavailable = false; fault.stat = undefined
    await client.close()
    expect(readdirSync(lane + '.witnesses')).toContain('00000000.release')
    expect(lstatSync(lane + '.witnesses/00000000.release').isSymbolicLink()).toBe(true)
    expect(closeWriter).toHaveBeenCalledOnce()
  } finally { resetFaults(); await client.close() }
})

it('retains the local-root descriptor until actual acquisition settles after timeout', async () => {
  const closeWriter = vi.fn(), client = pool({ closeWriter })
  let release!: () => void, delayed = false
  fault.defer = (_fd, done) => {
    if (delayed) return false
    delayed = true; release = () => done(null); return true
  }
  const acquisition = client.acquire(() => true, { timeoutMs: 30 })
  await expect(acquisition).rejects.toThrow('deadline')
  const closing = client.close()
  expect(closeWriter).not.toHaveBeenCalled()
  await expect(client.acquire()).rejects.toThrow('pool is closed')
  release(); await closing
  expect(closeWriter).toHaveBeenCalledTimes(1)
  await client.close()
  expect(closeWriter).toHaveBeenCalledTimes(1)
})

it('retains the local-root descriptor until stage cleanup and every lease release finish', async () => {
  const closeWriter = vi.fn(), client = pool({ closeWriter }), lease = await client.acquire()
  const stage = lease.stage(join(root, 'receipt'))
  let release!: () => void, delayed = false
  fault.defer = (_fd, done) => {
    if (delayed) return false
    delayed = true; release = () => done(null); return true
  }
  const cleaning = stage.finish()
  await vi.waitFor(() => expect(delayed).toBe(true))
  const closing = client.close()
  expect(closeWriter).not.toHaveBeenCalled()
  expect(() => stage.verify()).toThrow('revoked')
  release(); await cleaning; await closing
  expect(closeWriter).toHaveBeenCalledTimes(1)
  expect(readdirSync(join(root, '.native-hook-stage-0'))).toContain('00000000.release')
})

it('retries a failed cleanup sync in the still-live writer before releasing its lane', async () => {
  const lease = await pool().acquire(), stage = lease.stage(join(root, 'receipt'))
  fault.fail = true
  await expect(stage.finish()).rejects.toThrow('fixture disk unavailable')
  await expect(lease.close()).rejects.toThrow('fixture disk unavailable')
  expect(() => lease.stage(join(root, 'late'))).toThrow('released')
  fault.fail = false
  await lease.close()
  const next = await pool().acquire()
  const final = next.stage(join(root, 'next'))
  expect(final.path).toMatch(/00000001\./)
  await final.finish(); await next.close()
})

it('revokes new effects but permits exact cleanup after the request owner changes', async () => {
  let current = true
  const lease = await pool().acquire(() => current), stage = lease.stage(join(root, 'receipt'))
  current = false
  expect(() => stage.verify()).toThrow('revoked')
  await stage.finish(); await lease.close()
  expect(stages()).toEqual([])
})

it('isolates damaged established lane authority and refuses its old lease', async () => {
  const lease = await pool().acquire()
  unlinkSync(join(root, '.native-hook-stage-0.seal'))
  expect(() => lease.verify()).toThrow()
  const healthy = await pool().acquire(), stage = healthy.stage(join(root, 'receipt'))
  expect(stage.path).toContain('.native-hook-stage-1/')
  await stage.finish(); await healthy.close()
})

it('refuses a changed destination directory before creating scratch bytes', async () => {
  const lease = await pool().acquire(), directory = join(root, 'target')
  writeFileSync(directory, 'not a directory', { mode: 0o600 })
  expect(() => lease.stage(join(directory, 'receipt'))).toThrow('another filesystem')
  expect(stages()).toEqual([])
  await lease.close()
})

it('allows the exclusive initializer to retry its own completed failure without transferring ownership', async () => {
  const client = pool()
  fault.fail = true
  await expect(client.acquire()).rejects.toThrow('fixture disk unavailable')
  fault.fail = false
  await expect(pool({ writer: writer(8200) }).acquire()).rejects.toThrow('another initializer')
  const lease = await client.acquire()
  await publish(lease, 'recovered initialization'); await lease.close()
})

it('refuses a nonprivate root without changing its permissions', () => {
  const unsafe = join(root, 'foreign'); mkdirSync(unsafe, { mode: 0o755 })
  expect(() => pool({ root: unsafe })).toThrow('not private')
})

it('does not release a stage recreated while its actual cleanup flush is pending', async () => {
  const lease = await pool().acquire(), stage = lease.stage(join(root, 'receipt'))
  let flush!: () => void
  fault.defer = (_fd, done) => { fault.defer = undefined; flush = () => done(null); return true }
  const cleaning = stage.finish()
  await vi.waitFor(() => expect(flush).toBeTypeOf('function'))
  writeFileSync(stage.path, 'recreated bytes', { mode: 0o600 })
  flush()
  await expect(cleaning).rejects.toThrow('recreated during cleanup')
  expect(() => lease.stage(join(root, 'next'))).toThrow('already has a stage')
  await expect(lease.close()).rejects.toThrow('did not remove')
  expect(readFileSync(stage.path, 'utf8')).toBe('recreated bytes')
  expect(readdirSync(join(root, '.native-hook-stage-0.witnesses'))).not.toContain('00000000.release')
  unlinkSync(stage.path); await lease.close()
})

it('refuses an iterator redirected through an ancestor to omit a dead writer’s stage', async () => {
  const parent = join(root, 'pool'); mkdirSync(parent, { mode: 0o700 })
  const first = await pool({ root: parent }).acquire(), stage = first.stage(join(root, 'receipt'))
  writeFileSync(stage.path, 'unreleased bytes', { mode: 0o600 })
  const lane = join(parent, '.native-hook-stage-0'), copied = join(root, 'copy')
  cpSync(parent, copied, { recursive: true, verbatimSymlinks: true })
  unlinkSync(join(copied, stage.path.slice(parent.length + 1)))
  let redirected = false
  fault.openDirectory = (path, open) => {
    if (path !== lane || redirected) return open()
    redirected = true
    renameSync(parent, parent + '.preserved'); renameSync(copied, parent)
    try { return open() } finally { renameSync(parent, copied); renameSync(parent + '.preserved', parent) }
  }
  const next = await pool({ root: parent, writer: writer(8200), dead: async () => true }).acquire()
  expect(redirected).toBe(true)
  expect(readFileSync(stage.path, 'utf8')).toBe('unreleased bytes')
  expect(readdirSync(lane).filter(name => name.endsWith('.claim'))).toEqual(['00000000.claim'])
  const healthy = next.stage(join(root, 'healthy'))
  expect(healthy.path).toContain('.native-hook-stage-1/')
  await healthy.finish(); await next.close()
  unlinkSync(stage.path); await stage.finish(); await first.close()
})

it('binds claim text to its own symlink when readlink is redirected through an ancestor', async () => {
  const parent = join(root, 'pool'); mkdirSync(parent, { mode: 0o700 })
  const first = await pool({ root: parent }).acquire(), stage = first.stage(join(root, 'receipt'))
  writeFileSync(stage.path, 'live writer bytes', { mode: 0o600 })
  const directory = join(parent, '.native-hook-stage-0.witnesses'), copied = join(root, 'copy')
  cpSync(parent, copied, { recursive: true, verbatimSymlinks: true })
  const copiedWitness = join(copied, '.native-hook-stage-0.witnesses')
  const name = '00000000.claim', fakeClaim = JSON.parse(readlinkSync(join(directory, name)))
  fakeClaim[2] = 8300
  unlinkSync(join(copiedWitness, name)); symlinkSync(JSON.stringify(fakeClaim), join(copiedWitness, name))
  let redirected = false
  fault.readLink = (path, read) => {
    if (path !== join(directory, name) || redirected) return read()
    redirected = true
    renameSync(parent, parent + '.preserved'); renameSync(copied, parent)
    try { return read() } finally { renameSync(parent, copied); renameSync(parent + '.preserved', parent) }
  }
  const next = await pool({ root: parent, writer: writer(8200), dead: async owner => owner.pid === 8300 }).acquire()
  expect(redirected).toBe(true)
  expect(readFileSync(stage.path, 'utf8')).toBe('live writer bytes')
  expect(readdirSync(directory).filter(name => name.endsWith('.release'))).toEqual([])
  const healthy = next.stage(join(root, 'healthy'))
  expect(healthy.path).toContain('.native-hook-stage-1/')
  await healthy.finish(); await next.close()
  unlinkSync(stage.path); await stage.finish(); await first.close()
})

it.each(['claim mirror', 'release'])('retains exclusive cleanup authority after a failed %s publication', async failure => {
  const client = pool({ maxGenerations: 2 })
  const held: NativeHookStageLease[] = []
  // Fill every lane except the one whose next acquisition will be interrupted.
  for (let index = 0; index < 8; index++) held.push(await client.acquire())
  await held[0].close()
  let injected = false
  fault.publish = (_text, path) => {
    if (path === join(root, '.native-hook-stage-0/00000001.claim') && !injected) {
      injected = true; throw Error('fixture claim mirror unavailable')
    }
    if (failure === 'release' && path.endsWith('00000001.release')) throw Error('fixture release unavailable')
  }
  await expect(client.acquire()).rejects.toThrow(/another writer|generation capacity/)
  expect(injected).toBe(true)
  resetFaults()
  await expect(client.acquire()).rejects.toThrow(/another writer|generation capacity/)
  const outside = join(root, '.native-hook-stage-0.witnesses')
  expect(readdirSync(outside)).toContain('00000001.release')
  expect(readdirSync(join(root, '.native-hook-stage-0'))).toContain('00000001.claim')
  expect(stages()).toEqual([])
  for (const lease of held.slice(1)) await lease.close()
})

it('bounds acquisition responses and shares the actual disk limiter with file publication', async () => {
  const pending = new Map<number, (error: Error | null) => void>()
  fault.defer = (fd, done) => { pending.set(fd, done); return true }
  const publication = runHookPreparation([join(root, 'ordinary')], attempt => inspectHookFile(join(root, 'ordinary'), 0o600).replace('bytes', attempt), { timeoutMs: 40 }).catch(error => error)
  const acquisitions = Array.from({ length: 8 }, (_, index) => {
    const privateRoot = join(root, String(index)); mkdirSync(privateRoot, { mode: 0o700 })
    return pool({ root: privateRoot }).acquire(() => true, { timeoutMs: 40 }).catch(error => error)
  })
  try {
    const replies = await Promise.all([publication, ...acquisitions])
    // A synchronous ownership proof may notice expiry before the deadline timer.
    for (const error of replies) {
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toMatch(/deadline|the preparation expired/)
    }
    expect(pending.size).toBe(2)
    for (const fd of pending.keys()) expect(() => fstatSync(fd)).not.toThrow()
  } finally {
    fault.defer = undefined
    for (const done of pending.values()) done(null)
    await vi.waitFor(() => { for (const fd of pending.keys()) expect(() => fstatSync(fd)).toThrow() })
  }
})

it.each(['initializer', 'claim'])('remembers exclusive %s ownership before a post-publication read fails', async kind => {
  const client = pool(), changed = new Set<string>()
  fault.readLink = (path, read) => {
    if ((kind === 'initializer' ? path.endsWith('.init-0') : path.endsWith('.witnesses/00000000.claim')) && !changed.has(path)) {
      changed.add(path); throw Error('fixture post-publication read unavailable')
    }
    return read()
  }
  await expect(client.acquire()).rejects.toThrow('post-publication read unavailable')
  expect(changed.size).toBe(8)
  resetFaults()
  // Each failed attempt is still ours. Recovery must not need false death
  // evidence or consume every lane for the remaining lifetime of this writer.
  const recovery = await client.acquire().then(lease => ({ lease, error: undefined }), error => ({ lease: undefined, error }))
  expect(recovery.error).toBeUndefined()
  const lease = recovery.lease!
  const file = await publish(lease, 'after transient read failure')
  expect(readFileSync(file, 'utf8')).toBe('after transient read failure')
  await lease.close()
})

it('rechecks retained authority bytes across a readlink-only ancestor redirect', async () => {
  const parent = join(root, 'pool'); mkdirSync(parent, { mode: 0o700 })
  const lease = await pool({ root: parent }).acquire(), copied = join(root, 'copy')
  cpSync(parent, copied, { recursive: true, verbatimSymlinks: true })
  const name = '.native-hook-stage-0.bootstrap', changed = JSON.parse(readlinkSync(join(copied, name)))
  changed[3] = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'
  unlinkSync(join(copied, name)); symlinkSync(JSON.stringify(changed), join(copied, name))
  let redirected = false
  fault.readLink = (path, read) => {
    if (path !== join(parent, name) || redirected) return read()
    redirected = true
    renameSync(parent, parent + '.preserved'); renameSync(copied, parent)
    try { return read() } finally { renameSync(parent, copied); renameSync(parent + '.preserved', parent) }
  }
  expect(() => lease.verify()).toThrow('metadata changed')
  expect(redirected).toBe(true)
  resetFaults(); await lease.close()
})

it('does not retire a dead predecessor whose stage reappears during the cleanup flush', async () => {
  const first = await pool().acquire(), stage = first.stage(join(root, 'receipt'))
  writeFileSync(stage.path, 'unreleased bytes', { mode: 0o600 })
  const lane = join(root, '.native-hook-stage-0'), inode = lstatSync(lane).ino
  let flush!: () => void
  fault.defer = (fd, done) => {
    if (existsSync(stage.path) || fstatSync(fd).ino !== inode) return false
    fault.defer = undefined; flush = () => done(null); return true
  }
  const acquisition = pool({ writer: writer(8200), dead: async () => true }).acquire()
  await vi.waitFor(() => expect(flush).toBeTypeOf('function'))
  writeFileSync(stage.path, 'recreated predecessor bytes', { mode: 0o600 })
  flush()
  const healthy = await acquisition, next = healthy.stage(join(root, 'healthy'))
  expect(readFileSync(stage.path, 'utf8')).toBe('recreated predecessor bytes')
  expect(readdirSync(lane + '.witnesses')).not.toContain('00000000.release')
  expect(next.path).toContain('.native-hook-stage-1/')
  await next.finish(); await healthy.close()
})

it('holds missing initializer history instead of recreating a claim beside a live successor', async () => {
  fault.fail = true
  await expect(pool().acquire()).rejects.toThrow('fixture disk unavailable')
  await expect(pool({ writer: writer(8200), dead: async () => true }).acquire()).rejects.toThrow('fixture disk unavailable')
  const directory = join(root, '.native-hook-stage-0'), next = readlinkSync(directory + '.init-1')
  unlinkSync(directory + '.init-0'); resetFaults()
  await expect(pool({ writer: writer(8300) }).acquire()).rejects.toThrow('another initializer')
  expect(readdirSync(root)).not.toContain('.native-hook-stage-0.init-0')
  expect(readlinkSync(directory + '.init-1')).toBe(next)
  expect(readdirSync(root)).not.toContain('.native-hook-stage-0.seal')
})

it('does not adopt coherently replaced authority while detaching the request deadline', async () => {
  const first = await pool().acquire(); await first.close()
  const lane = join(root, '.native-hook-stage-0')
  const bootstrap = JSON.parse(readlinkSync(lane + '.bootstrap')), authority = JSON.parse(readlinkSync(lane + '.authority'))
  bootstrap[3] = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const bootstrapText = JSON.stringify(bootstrap)
  authority[1] = hash(bootstrapText)
  const authorityText = JSON.stringify(authority), sealText = JSON.stringify([1, hash(bootstrapText), hash(authorityText)])
  let reads = 0, replaced = false
  fault.stat = (path, read) => {
    // Initial observation uses three stats; the retained proof uses two more.
    // Replace all leaves before recapture observes its first new inode.
    if (path === lane + '.bootstrap' && ++reads === 6) {
      replaced = true
      for (const [suffix, text] of [['.bootstrap', bootstrapText], ['.authority', authorityText], ['.seal', sealText]]) {
        unlinkSync(lane + suffix); symlinkSync(text, lane + suffix)
      }
    }
    return read()
  }
  const healthy = await pool().acquire(), next = healthy.stage(join(root, 'receipt'))
  expect(replaced).toBe(true)
  expect(next.path).toContain('.native-hook-stage-1/')
  expect(readdirSync(lane).filter(name => name.endsWith('.claim'))).toEqual(['00000000.claim'])
  await next.finish(); await healthy.close()
})

it('checks cleanup authority before unlinking a same-inode stage through a replaced ancestor', async () => {
  const parent = join(root, 'pool'); mkdirSync(parent, { mode: 0o700 })
  const lease = await pool({ root: parent }).acquire()
  let flush!: () => void
  fault.defer = (fd, done) => {
    if (!fstatSync(fd).isFile()) return false
    fault.defer = undefined; flush = () => done(null); return true
  }
  const pending = publish(lease, 'private original bytes').catch(error => error)
  await vi.waitFor(() => expect(flush).toBeTypeOf('function'))
  const relative = stages()[0].slice('pool/'.length), file = join(parent, relative)
  renameSync(parent, parent + '.preserved'); mkdirSync(parent, { mode: 0o700 })
  mkdirSync(join(parent, '.native-hook-stage-0'), { mode: 0o700 })
  linkSync(join(parent + '.preserved', relative), file)
  flush()
  expect(await pending).toBeInstanceOf(Error)
  expect(existsSync(file)).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('private original bytes')
  renameSync(parent, parent + '.replacement'); renameSync(parent + '.preserved', parent)
  unlinkSync(file); await lease.close()
})
