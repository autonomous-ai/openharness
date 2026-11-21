import { chmodSync, close, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createResumeRepairWorker } from '../../engines/resumeRepairs.js'
import { controlTranscriptEvidence } from '../../engines/transcriptBindings.js'
import { RESUME_REPAIR_CAPABILITIES, RESUME_REPAIR_LOCATE, RESUME_REPAIR_PREPARE, repairDirectory, repairFile,
  type RepairAnswer, type RepairPreparation } from '../../engines/worker/resumeRepairProtocol.js'
import { codexSessionMeta } from '../../testing/codexRollout.js'
import { createResumeRepairs } from './resumeRepairs.js'

const closing = vi.hoisted(() => new Set<Promise<void>>())
vi.mock('node:fs', async real => {
  const actual = await real<typeof import('node:fs')>()
  return { ...actual, linkSync: vi.fn(actual.linkSync), openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync), renameSync: vi.fn(actual.renameSync),
    close: vi.fn((fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      let finish!: () => void
      const wait = new Promise<void>(resolve => { finish = resolve }); closing.add(wait)
      actual.close(fd, error => { try { callback(error) } finally { closing.delete(wait); finish() } })
    }),
  }
})
vi.mock('../../engines/transcriptBindings.js', async real => {
  const actual = await real<typeof import('../../engines/transcriptBindings.js')>()
  return { ...actual, controlTranscriptEvidence: vi.fn(actual.controlTranscriptEvidence) }
})
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const id = '01a0a3cd-a374-71f2-a11a-1fc1cc41b36d'
const body = codexSessionMeta(id) + JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', id: 'relay-id', content: [] } }) + '\n'
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const folders: string[] = []
afterEach(async () => { await Promise.all(closing); vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

function holdClose() {
  let retained: { fd: number; callback: (error: NodeJS.ErrnoException | null) => void } | undefined
  vi.mocked(close).mockImplementationOnce((fd, callback) => { retained = { fd, callback: callback! } })
  return {
    get fd() { return retained?.fd },
    async finish(failure?: NodeJS.ErrnoException) {
      const held = retained; retained = undefined
      if (held) await new Promise<void>((resolve, reject) => actualFs.close(held.fd, error => {
        held.callback(failure ?? error)
        if (error) reject(error); else resolve()
      }))
    },
  }
}
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'repair-worker-')); folders.push(home)
  const folder = join(home, 'sessions'); mkdirSync(folder)
  const file = join(folder, `rollout-${id}.jsonl`); writeFileSync(file, body, { mode: 0o600 })
  const source = { engine: 'codex', sessionId: id, transcriptPath: file, codexHome: home }
  const worker = createResumeRepairWorker({ directory: join(home, 'state'), log: vi.fn() })
  let prepared: ((ask: RepairPreparation, answer: RepairAnswer) => Promise<void> | void) | undefined
  let request: RepairPreparation | undefined
  const call = vi.fn(async (_service: string, method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (method === RESUME_REPAIR_CAPABILITIES) return { version: 1, engine: 'codex', resumeRepair: 1 }
    if (method === RESUME_REPAIR_LOCATE) return { version: 1, answer: worker.locate(payload.source as never) }
    if (method === RESUME_REPAIR_PREPARE) {
      request = payload.preparation as RepairPreparation
      const answer = await worker.prepare(request)
      await prepared?.(request, answer)
      return { version: 1, answer }
    }
    return { version: 1, answer: worker.release(payload.token as string) }
  })
  const release = vi.fn(), setTail = vi.fn(), hold = vi.fn(async () => ({ offset: body.length, expired: false, release }))
  const inline = vi.fn(async () => ({ repairedItems: 0 })), handles = vi.fn(() => true)
  const repairs = createResumeRepairs({ call, inline, handles, hold, setTail }); repairs.connected('engine-codex')
  return { home, file, source, worker, call, release, setTail, hold, inline, handles, repairs,
    get request() { return request! }, prepared: (hook: typeof prepared) => { prepared = hook } }
}

it('publishes only after the held tail drains, sets its byte in the same turn, and retains an exact private backup', async () => {
  const t = setup()
  t.prepared(() => { expect(readFileSync(t.file, 'utf8')).toBe(body); expect(t.hold).not.toHaveBeenCalled() })
  t.setTail.mockImplementation((_id, offset) => { expect(lstatSync(t.file).size).toBe(offset); expect(t.release).not.toHaveBeenCalled() })
  const result = await t.repairs.prepare(t.source, () => true)
  expect(result).toMatchObject({ repairedItems: 1, repairedBytes: lstatSync(t.file).size })
  expect(readFileSync(result.backupPath!, 'utf8')).toBe(body)
  expect(t.setTail).toHaveBeenCalledWith(id, lstatSync(t.file).size)
  expect(t.release).toHaveBeenCalledOnce()
  expect(readdirSync(join(t.home, 'state'))).toEqual([])
  await Promise.all(closing)
  t.prepared(undefined)
  expect(await t.repairs.prepare(t.source, () => true)).toEqual({ repairedItems: 0 })
})

it('pins the original inode through publication and holds admission until its actual asynchronous close', async () => {
  const t = setup(), before = repairFile(lstatSync(t.file, { bigint: true })), held = holdClose()
  let pin: number | undefined
  t.prepared(() => { vi.mocked(openSync).mockImplementationOnce((path, flags, mode) => pin = actualFs.openSync(path, flags, mode)) })
  vi.mocked(renameSync).mockImplementationOnce((source, destination) => {
    expect(pin).toEqual(expect.any(Number))
    expect(repairFile(actualFs.fstatSync(pin!, { bigint: true }))).toEqual(before)
    actualFs.renameSync(source, destination)
  })
  try {
    const answer = await t.repairs.prepare(t.source, () => true)
    expect(answer.repairedItems).toBe(1)
    expect(held.fd).toEqual(expect.any(Number))
    expect(repairFile(actualFs.fstatSync(held.fd!, { bigint: true })).key).toBe(before.key)
    expect(actualFs.fstatSync(held.fd!, { bigint: true }).nlink).toBe(0n)
    expect(readFileSync(answer.backupPath!, 'utf8')).toBe(body)
    expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'busy' })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await vi.advanceTimersByTimeAsync(65_000)
    t.repairs.disconnected('engine-codex'); t.repairs.connected('engine-codex')
    expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'busy' })
    await held.finish()
    expect(await t.repairs.prepare(t.source, () => true)).toEqual({ repairedItems: 0 })
  } finally { await held.finish() }
})

it('retains the pin while cleanup races publication and closes it without changing the source', async () => {
  const t = setup(), held = holdClose()
  vi.mocked(linkSync).mockImplementationOnce((source, target) => { actualFs.linkSync(source, target); t.worker.release(t.request.token) })
  try {
    expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'unavailable' })
    expect(held.fd).toEqual(expect.any(Number))
    expect(readFileSync(held.fd!, 'utf8')).toBe(body)
    expect(readFileSync(t.file, 'utf8')).toBe(body)
    expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'busy' })
  } finally { await held.finish() }
})

it('refuses a pin whose descriptor does not match the original source', async () => {
  const t = setup(), held = holdClose(), foreign = join(t.home, 'foreign.jsonl')
  writeFileSync(foreign, body)
  t.prepared(() => {
    vi.mocked(openSync).mockImplementationOnce((path, flags, mode) => {
      expect(path).toBe(actualFs.realpathSync(t.file))
      expect(Number(flags) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
      return actualFs.openSync(foreign, flags, mode)
    })
  })
  try {
    expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'unavailable' })
    expect(held.fd).toEqual(expect.any(Number))
    expect(readFileSync(t.file, 'utf8')).toBe(body)
    expect(t.setTail).not.toHaveBeenCalled()
  } finally { await held.finish() }
})

it('rechecks caller authority after acquiring the pin and closes it after refusal', async () => {
  const t = setup(), held = holdClose(); let current = true
  t.prepared(() => {
    vi.mocked(openSync).mockImplementationOnce((path, flags, mode) => {
      const fd = actualFs.openSync(path, flags, mode); current = false; return fd
    })
  })
  try {
    expect(await t.repairs.prepare(t.source, () => current)).toMatchObject({ unrepaired: 'cancelled' })
    expect(held.fd).toEqual(expect.any(Number))
    expect(readFileSync(t.file, 'utf8')).toBe(body)
    expect(t.setTail).not.toHaveBeenCalled()
  } finally { await held.finish() }
})

it('logs an uncertain close and never retries its descriptor or reuses its admission slot', async () => {
  const t = setup(), held = holdClose(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ repairedItems: 1 })
    expect(held.fd).toEqual(expect.any(Number))
    const before = vi.mocked(close).mock.calls.length
    await held.finish(Object.assign(new Error('injected close uncertainty'), { code: 'EIO' }))
    expect(warning).toHaveBeenCalledWith('[resume] RESUME_REPAIR_CLEANUP_FAILED; restart required')
    expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'busy' })
    expect(close).toHaveBeenCalledTimes(before)
  } finally { await held.finish() }
})

it('rechecks the pinned descriptor at the final publication fence', async () => {
  const t = setup(), held = holdClose(); let pin: number | undefined, checks = 0
  t.prepared(() => {
    vi.mocked(openSync).mockImplementationOnce((path, flags, mode) => pin = actualFs.openSync(path, flags, mode))
    vi.mocked(fstatSync).mockImplementation(((fd: number, options: never) => {
      const info = actualFs.fstatSync(fd, options)
      return fd === pin && ++checks === 2 ? { ...info, nlink: 2n } : info
    }) as typeof fstatSync)
  })
  try {
    expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'unavailable' })
    expect(checks).toBe(2)
    expect(renameSync).not.toHaveBeenCalled()
    expect(readFileSync(t.file, 'utf8')).toBe(body)
  } finally { await held.finish() }
})

it.each(['hold release', 'release RPC'])('starts pin cleanup even when %s throws', async kind => {
  const t = setup(), held = holdClose()
  if (kind === 'hold release') t.release.mockImplementation(() => { throw new Error('injected release failure') })
  else {
    const call = t.call.getMockImplementation()!
    t.call.mockImplementation((service, method, payload) => {
      if (method.endsWith('_release')) throw new Error('injected release failure')
      return call(service, method, payload)
    })
  }
  try {
    await expect(t.repairs.prepare(t.source, () => true)).rejects.toThrow('injected release failure')
    expect(held.fd).toEqual(expect.any(Number))
    expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'busy' })
  } finally { await held.finish() }
})

it('retains admission when close throws before returning a callback', async () => {
  const t = setup(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(close).mockImplementationOnce(fd => {
    actualFs.closeSync(fd)
    throw new Error('injected uncertain close')
  })
  expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ repairedItems: 1 })
  expect(warning).toHaveBeenCalledWith('[resume] RESUME_REPAIR_CLEANUP_FAILED; restart required')
  expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'busy' })
  expect(close).toHaveBeenCalledOnce()
})

it('bounds deferred reclamation to the existing two repair slots across different sessions', async () => {
  const t = setup(), first = holdClose()
  const otherId = '01a0a3cd-a374-71f2-a11a-1fc1cc41b36e'
  const otherFile = join(t.home, 'sessions', `rollout-${otherId}.jsonl`)
  writeFileSync(otherFile, body.replace(id, otherId), { mode: 0o600 })
  let second: ReturnType<typeof holdClose> | undefined
  try {
    expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ repairedItems: 1 })
    second = holdClose()
    expect(await t.repairs.prepare({ ...t.source, sessionId: otherId, transcriptPath: otherFile }, () => true))
      .toMatchObject({ repairedItems: 1 })
    expect(first.fd).toEqual(expect.any(Number)); expect(second.fd).toEqual(expect.any(Number))
    const calls = t.call.mock.calls.length
    expect(await t.repairs.prepare({ ...t.source, sessionId: 'third-session' }, () => true)).toMatchObject({ unrepaired: 'busy' })
    expect(t.call).toHaveBeenCalledTimes(calls)
    await first.finish()
    expect(await t.repairs.prepare(t.source, () => true)).toEqual({ repairedItems: 0 })
  } finally { await first.finish(); await second?.finish() }
})

it.each(['cancelled', 'lost_reply', 'stale_worker', 'expired_hold', 'source_changed', 'stage_changed'] as const)('never publishes after %s', async why => {
  const t = setup(); let current = true
  t.prepared((ask, answer) => {
    expect(answer).toMatchObject({ repairedItems: 1 })
    if (why === 'cancelled') current = false
    if (why === 'lost_reply') throw new Error('link lost after staging')
    if (why === 'stale_worker') { t.repairs.disconnected('engine-codex'); t.repairs.connected('engine-codex') }
    if (why === 'source_changed') writeFileSync(t.file, body + '\n')
    if (why === 'stage_changed') writeFileSync(join(repairDirectory(ask.file, ask.token), 'history'), 'bad')
    if (why === 'expired_hold') t.hold.mockResolvedValue({ offset: 0, expired: true, release: t.release })
  })
  expect(await t.repairs.prepare(t.source, () => current)).toMatchObject({ repairedItems: 0, unrepaired: expect.any(String) })
  expect(readFileSync(t.file, 'utf8')).toBe(body + (why === 'source_changed' ? '\n' : ''))
  expect(t.setTail).not.toHaveBeenCalled()
})

it('cleanup racing the backup link cannot remove published backups or replace the original with a missing stage', async () => {
  const t = setup()
  vi.mocked(linkSync).mockImplementationOnce((source, target) => { actualFs.linkSync(source, target); t.worker.release(t.request.token) })
  expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ repairedItems: 0, unrepaired: 'unavailable' })
  expect(readFileSync(t.file, 'utf8')).toBe(body)
  const backup = readdirSync(join(t.home, 'sessions')).find(name => name.includes('reasoning-backup'))!
  expect(readFileSync(join(t.home, 'sessions', backup), 'utf8')).toBe(body)
  expect(t.setTail).not.toHaveBeenCalled()
})

it('a lost acknowledgement expires private staging without deleting published files', async () => {
  const t = setup()
  const call = t.call.getMockImplementation()!
  t.call.mockImplementation(async (service, method, payload) => {
    if (method.endsWith('_release')) throw new Error('ack lost')
    return call(service, method, payload)
  })
  const answer = await t.repairs.prepare(t.source, () => true)
  expect(answer.repairedItems).toBe(1)
  createResumeRepairWorker({ directory: join(t.home, 'state'), ownerAlive: () => false })
  expect(readFileSync(answer.backupPath!, 'utf8')).toBe(body)
  expect(readFileSync(t.file, 'utf8')).not.toContain('relay-id')
})

it('refuses another session inside the same profile before allowing a worker preparation', async () => {
  const t = setup(); writeFileSync(t.file, codexSessionMeta('different-session'))
  expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ repairedItems: 0, unrepaired: 'unavailable' })
  expect(t.call.mock.calls.some(([, method]) => method === RESUME_REPAIR_PREPARE)).toBe(false)
})

it('uses inline only explicitly, reports a down worker, and ignores engines with no repair', async () => {
  const t = setup()
  expect(await t.repairs.prepare({ ...t.source, engine: 'claude' }, () => true)).toEqual({ repairedItems: 0 })
  t.handles.mockReturnValue(false)
  t.inline.mockResolvedValueOnce({ repairedItems: 1, repairedBytes: 9 } as never)
  expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ repairedItems: 1 })
  expect(t.setTail).toHaveBeenCalledWith(id, 9)
  t.handles.mockReturnValue(true); t.call.mockRejectedValue(new Error('worker down'))
  expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ repairedItems: 0, unrepaired: 'unavailable' })
  expect(t.inline).toHaveBeenCalledOnce()
})

it('rejects invalid source values, an absent compatibility adapter and already cancelled work', async () => {
  const t = setup()
  t.repairs.connected('unrelated'); t.repairs.disconnected('unrelated')
  expect(await t.repairs.prepare({ ...t.source, sessionId: '' }, () => true)).toEqual({ repairedItems: 0 })
  expect(await t.repairs.prepare({ ...t.source, transcriptPath: 'a\0b' }, () => true)).toMatchObject({ unrepaired: 'unavailable' })
  expect(await t.repairs.prepare(t.source, () => false)).toMatchObject({ unrepaired: 'cancelled' })
  const without = createResumeRepairs({ call: t.call, handles: () => false, hold: t.hold, setTail: t.setTail })
  expect(await without.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'unavailable' })
  t.handles.mockReturnValue(false)
  expect(await t.repairs.prepare(t.source, () => true)).toEqual({ repairedItems: 0 })
})

it.each([null, { nonsense: true }, { repairedItems: 0, unrepaired: 'too_large' }, { refused: 'foreign_session' }])('validates locator answer %j without guessing a path', async answer => {
  const t = setup(), call = t.call.getMockImplementation()!
  t.call.mockImplementation(async (service, method, payload) => method === RESUME_REPAIR_LOCATE
    ? { version: 1, answer: answer === null ? { file: null } : answer } : call(service, method, payload))
  if (answer && 'refused' in answer) await expect(t.repairs.prepare(t.source, () => true)).rejects.toMatchObject({ kind: 'foreign_session' })
  else expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ repairedItems: 0 })
  expect(t.setTail).not.toHaveBeenCalled()
})

it('cancels between location and preparation, and refuses a locator that reports staged data', async () => {
  const t = setup(); let current = true
  const call = t.call.getMockImplementation()!
  t.call.mockImplementation(async (service, method, payload) => {
    const answer = await call(service, method, payload)
    if (method === RESUME_REPAIR_LOCATE) current = false
    return answer
  })
  expect(await t.repairs.prepare(t.source, () => current)).toMatchObject({ unrepaired: 'cancelled' })
  current = true
  const facts = repairFile(lstatSync(t.file, { bigint: true }))
  t.call.mockImplementation(async (service, method, payload) => method === RESUME_REPAIR_LOCATE ? { version: 1,
    answer: { repairedItems: 1, repairedBytes: facts.size, directoryKey: 'unused', history: facts, backup: facts } } : call(service, method, payload))
  expect(await t.repairs.prepare(t.source, () => current)).toMatchObject({ unrepaired: 'unavailable' })
})

it('bounds concurrent requests and never queues a duplicate resume', async () => {
  const t = setup()
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve }), started = deferred<void>()
  t.prepared(async () => { started.resolve(); await held })
  const first = t.repairs.prepare(t.source, () => true)
  await started.promise
  expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'busy' })
  finish(); expect(await first).toMatchObject({ repairedItems: 1 })
})

it.each(['private_mode', 'backup_size', 'item_count', 'directory_key', 'history_symlink'] as const)('refuses unsafe preparation %s', async kind => {
  const t = setup()
  t.prepared((ask, answer) => {
    if (!('directoryKey' in answer)) throw new Error('expected a stage')
    const directory = repairDirectory(ask.file, ask.token)
    if (kind === 'private_mode') chmodSync(join(directory, 'history'), 0o644)
    if (kind === 'backup_size') { writeFileSync(join(directory, 'backup'), body + '\n'); answer.backup = repairFile(lstatSync(join(directory, 'backup'), { bigint: true })) }
    if (kind === 'item_count') answer.repairedItems = body.length + 1
    if (kind === 'directory_key') answer.directoryKey = 'replaced'
    if (kind === 'history_symlink') { rmSync(join(directory, 'history')); symlinkSync(t.file, join(directory, 'history')) }
  })
  expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'unavailable' })
  expect(readFileSync(t.file, 'utf8')).toBe(body)
})

it('keeps typed invalid-history refusals from the worker', async () => {
  const t = setup(); writeFileSync(t.file, codexSessionMeta(id) + 'invalid line\n')
  await expect(t.repairs.prepare(t.source, () => true)).rejects.toMatchObject({ kind: 'invalid_json' })
  expect(t.setTail).not.toHaveBeenCalled()
})

it('checks authority again after final evidence and after linking a backup', async () => {
  const t = setup(); let checks = 0
  expect(await t.repairs.prepare(t.source, () => ++checks < 5)).toMatchObject({ unrepaired: 'cancelled' })
  expect(t.setTail).not.toHaveBeenCalled()
  await Promise.all(closing)
  let current = true
  vi.mocked(linkSync).mockImplementationOnce((source, destination) => { actualFs.linkSync(source, destination); current = false })
  expect(await t.repairs.prepare(t.source, () => current)).toMatchObject({ unrepaired: 'cancelled' })
  expect(readFileSync(t.file, 'utf8')).toBe(body)
})

it('refuses over-limit history before asking the worker to stage it', async () => {
  const t = setup(); truncateSync(t.file, 1024 ** 3 + 1)
  expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'too_large' })
  expect(t.call.mock.calls.some(([, method]) => method === RESUME_REPAIR_PREPARE)).toBe(false)
})

it('never overwrites an existing backup name', async () => {
  const t = setup(); let backup = ''
  t.prepared(ask => { backup = `${ask.file}.reasoning-backup-${ask.token}`; writeFileSync(backup, 'keep existing backup') })
  expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'unavailable' })
  expect(readFileSync(backup, 'utf8')).toBe('keep existing backup')
  expect(readFileSync(t.file, 'utf8')).toBe(body)
})

it('refuses a symlink leaf even when its target has the right session header', async () => {
  const t = setup(), alias = join(t.home, 'sessions', 'alias.jsonl'); symlinkSync(t.file, alias)
  const call = t.call.getMockImplementation()!
  t.call.mockImplementation(async (service, method, payload) => method === RESUME_REPAIR_LOCATE
    ? { version: 1, answer: { file: alias } } : call(service, method, payload))
  expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ unrepaired: 'unavailable' })
})

it('asks native identity evidence for the default profile without substituting a worker assertion', async () => {
  const t = setup(), call = t.call.getMockImplementation()!
  t.call.mockImplementation(async (service, method, payload) => method === RESUME_REPAIR_LOCATE
    ? { version: 1, answer: { file: t.file } } : call(service, method, payload))
  vi.mocked(controlTranscriptEvidence).mockImplementationOnce(() => { throw new Error('default profile unavailable') })
  expect(await t.repairs.prepare({ ...t.source, codexHome: null }, () => true)).toMatchObject({ unrepaired: 'unavailable' })
  expect(controlTranscriptEvidence).toHaveBeenLastCalledWith('codex', id, t.file, undefined, undefined, 'candidate-only')
})

it('bounds a stuck Watcher hold and releases one that arrives after the operation ended', async () => {
  const t = setup(), started = deferred<void>()
  const held = deferred<Awaited<ReturnType<typeof t.hold>>>()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  t.hold.mockImplementationOnce(() => { started.resolve(); return held.promise })
  const work = t.repairs.prepare(t.source, () => true)
  await started.promise
  await vi.advanceTimersByTimeAsync(65_000)
  expect(await work).toMatchObject({ unrepaired: 'unavailable' })
  held.resolve({ offset: 0, expired: true, release: t.release })
  await Promise.resolve()
  expect(t.release).toHaveBeenCalledOnce()
  expect(t.setTail).not.toHaveBeenCalled()
  expect(readFileSync(t.file, 'utf8')).toBe(body)
})

it('a restore can publish before Watcher tracks the history', async () => {
  const t = setup(); t.hold.mockResolvedValueOnce(null as never)
  expect(await t.repairs.prepare(t.source, () => true)).toMatchObject({ repairedItems: 1 })
  expect(t.setTail).toHaveBeenCalledOnce()
})

it('leaves an overwritten child candidate unrepaired instead of discovering its parent in core', async () => {
  const t = setup(), child = join(t.home, 'sessions', 'child.jsonl'), call = t.call.getMockImplementation()!
  writeFileSync(child, JSON.stringify({ type: 'session_meta', payload: { id: 'child-session',
    source: { subagent: { thread_spawn: { parent_thread_id: id } } } } }) + '\n')
  t.call.mockImplementation(async (service, method, payload) => method === RESUME_REPAIR_LOCATE
    ? { version: 1, answer: { file: child } } : call(service, method, payload))
  expect(await t.repairs.prepare(t.source, () => true)).toEqual({ repairedItems: 0, unrepaired: 'unavailable' })
  expect(t.call.mock.calls.some(([, method]) => method === RESUME_REPAIR_PREPARE)).toBe(false)
  expect(readFileSync(t.file, 'utf8')).toBe(body)
})
