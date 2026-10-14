/** Real mirrored journals and private roots. No engine, daemon or tmux. */
import { existsSync, fstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixtureNativeGenerationFact as fact } from '../../testing/nativeGenerationFactFixture.js'
import { createNativeHookJournal } from './nativeHookJournal.js'
import { nativeCancellationFact, type NativeGenerationCancellation } from './nativeGenerationCancellation.js'

const disk = vi.hoisted(() => ({ fail: false, afterFlush: undefined as ((fd: number) => void) | undefined,
  beforeOpen: undefined as ((path: string) => void) | undefined,
  afterPublication: undefined as ((path: string) => void) | undefined,
  afterStat: undefined as ((path: string) => void) | undefined,
}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
  openSync: (...args: Parameters<typeof fs.openSync>) => { disk.beforeOpen?.(String(args[0])); return fs.openSync(...args) },
  lstatSync: (...args: Parameters<typeof fs.lstatSync>) => { const info = fs.lstatSync(...args); disk.afterStat?.(String(args[0])); return info },
  fsync: (fd: number, done: (error: Error | null) => void) => {
    disk.afterFlush?.(fd)
    queueMicrotask(() => done(disk.fail ? Error('fixture cancellation disk unavailable') : null))
  },
}})
vi.mock('./nativeHookFiles.js', async original => {
  const files = await original<typeof import('./nativeHookFiles.js')>()
  return { ...files, runHookPreparation: async (...args: Parameters<typeof files.runHookPreparation>) => {
    const proof = await files.runHookPreparation(...args)
    disk.afterPublication?.(args[0][0])
    return proof
  } }
})
let root: string, directory: string
const key = 'linux:fixture\u0000cursor\u00005100\u000012345'
const journals: Array<ReturnType<typeof createNativeHookJournal>> = []
const journal = (options: Partial<Parameters<typeof createNativeHookJournal>[0]> = {}) => {
  const value = createNativeHookJournal({ directory, processKey: key, ...options }); journals.push(value); return value
}
const request = async (owner: ReturnType<typeof journal>, extra: Partial<NativeGenerationCancellation> = {}): Promise<NativeGenerationCancellation> => ({
  requestId: 'fixture-cancellation-01', nonce: 'fixture-cancellation-nonce', agentId: 'agent-one', conversationId: 'conversation-one',
  frontier: (await owner.snapshot()).frontier, ...extra,
})
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-cancellation-'))); directory = join(root, 'history')
})
afterEach(() => {
  disk.fail = false; disk.afterFlush = undefined; disk.beforeOpen = undefined; disk.afterPublication = undefined; disk.afterStat = undefined
  journals.splice(0).forEach(journal => journal.close()); rmSync(root, { recursive: true, force: true })
})

it('atomically retains all original nonterminal targets and gives only the publisher one dispatch', async () => {
  const owner = journal()
  for (const [kind, generation] of [['activity', 'one'], ['activity', 'two'], ['submitted', 'queued'], ['stopped', 'closed']] as const) {
    await owner.recordGeneration(fact(kind, `fixture-${generation}-delivery`, generation))
  }
  await owner.recordGeneration({ ...fact('activity', 'fixture-foreign-activity', 'foreign'), agentId: 'foreign-agent' })
  const input = await request(owner), before = await owner.snapshot(), result = await owner.recordCancellation(input)
  expect(result.recorded).toBe(true)
  if (!result.recorded) throw Error('publisher expected')
  expect(result.targets).toEqual(['one', 'queued', 'two'])
  const recovered = await journal().snapshot()
  expect(recovered.length).toBe(before.length + 1)
  expect(recovered.active).toBeUndefined()
  expect(recovered.cancellations.get(input.requestId)).toEqual(input)
  expect([...recovered.generations.values()].filter(fact => fact.kind === 'cancelled').map(fact => fact.generationId).sort())
    .toEqual(['one', 'queued', 'two'])
  const dispatch = vi.fn((verify: () => void) => { verify(); return 'sent once' })
  expect(result.dispatch(dispatch)).toBe('sent once')
  expect(() => result.dispatch(dispatch)).toThrow('already consumed')
  expect(dispatch).toHaveBeenCalledOnce()
  expect(await journal().recordCancellation(input)).toMatchObject({ recorded: false })
  expect((await journal().snapshot()).length).toBe(recovered.length)
})

it('retains an empty-target barrier and the immutable original request across restart', async () => {
  const owner = journal(), input = await request(owner), expected = structuredClone(input)
  const pending = owner.recordCancellation(input)
  Object.assign(input, { nonce: 'changed-caller-nonce', frontier: { index: 100, digest: '0'.repeat(64) } })
  await expect(pending).resolves.toMatchObject({ recorded: true, targets: [] })
  const result = await pending
  expect(result).toMatchObject({ recorded: true, targets: [] })
  owner.close()
  const recovered = await journal().snapshot()
  expect(recovered.frontier.index).toBe(0)
  expect(recovered.generations.size).toBe(0)
  expect(recovered.cancellations.get(expected.requestId)).toEqual(expected)
  expect(recovered.controlReserved).toBe(false)
  expect(await journal().recordCancellation(expected)).toMatchObject({ recorded: false })
})

it('keeps an older prefix exact and never interrupts after newer observations', async () => {
  const owner = journal()
  await owner.recordGeneration(fact('activity'))
  const input = await request(owner)
  await owner.recordGeneration(fact('activity', 'fixture-newer-activity', 'newer-generation'))
  const result = await owner.recordCancellation(input)
  expect(result).toMatchObject({ recorded: true, targets: ['generation-one'] })
  if (!result.recorded) throw Error('publisher expected')
  const effect = vi.fn()
  expect(() => result.dispatch(effect)).toThrow('dispatch frontier changed')
  expect(effect).not.toHaveBeenCalled()
  const after = await owner.snapshot()
  expect(after.generations.has(nativeCancellationFact(input, 'newer-generation').id)).toBe(false)
  expect(after.cancellations.size).toBe(1)
})

it.each(['append', 'shutdown', 'owner'] as const)('revokes the one-use dispatch after %s', async changed => {
  let current = true
  const owner = journal({ current: () => current }), result = await owner.recordCancellation(await request(owner))
  if (!result.recorded) throw Error('publisher expected')
  if (changed === 'append') await owner.recordGeneration(fact('activity'))
  else if (changed === 'shutdown') owner.close()
  else current = false
  const effect = vi.fn()
  expect(() => result.dispatch(effect)).toThrow()
  expect(effect).not.toHaveBeenCalled()
})

it.each(['record', 'witness', 'predecessor'] as const)('retains original publication identity when the %s is replaced before reconstruction', async changed => {
  const owner = journal()
  await owner.recordGeneration(fact('activity'))
  const input = await request(owner), record = join(directory, '00000001.json')
  let replaced = false
  disk.beforeOpen = path => {
    // The next bootstrap read begins reconstruction after append has returned.
    // Replace before its directory stamps are captured, so only the publisher's
    // retained identity can reject these otherwise identical bytes.
    if (path !== directory + '.bootstrap' || !existsSync(record)) return
    disk.beforeOpen = undefined
    const file = changed === 'record' ? record : changed === 'witness' ? join(directory + '.witnesses', '00000001.json')
      : join(directory, '00000000.json')
    const replacement = join(root, 'replacement')
    writeFileSync(replacement, readFileSync(file), { mode: 0o600 }); renameSync(replacement, file); replaced = true
  }
  const effect = vi.fn()
  await expect(owner.recordCancellation(input).then(result => { if (result.recorded) result.dispatch(effect) })).rejects.toThrow()
  expect(replaced).toBe(true)
  expect(effect).not.toHaveBeenCalled()
  // Recovery can retain the logical barrier, but never reconstructs execution authority.
  expect(await journal().recordCancellation(input)).toMatchObject({ recorded: false })
})

it.each(['outside', 'mirror'] as const)('retains the %s publication proof before append can read back equal replacement bytes', async changed => {
  const owner = journal(), input = await request(owner)
  const file = join(changed === 'outside' ? directory + '.witnesses' : directory, '00000000.json')
  let replaced = false
  disk.afterPublication = path => {
    if (path !== file) return
    disk.afterPublication = undefined
    const replacement = join(root, 'replacement')
    writeFileSync(replacement, readFileSync(file), { mode: 0o600 }); renameSync(replacement, file); replaced = true
  }
  const effect = vi.fn()
  await expect(owner.recordCancellation(input).then(result => { if (result.recorded) result.dispatch(effect) })).rejects.toThrow()
  expect(replaced).toBe(true)
  expect(effect).not.toHaveBeenCalled()
  expect(await journal().recordCancellation(input)).toMatchObject({ recorded: false })
})

it.each(['owner', 'shutdown'] as const)('checks %s after the final disk read at both dispatch boundaries', async changed => {
  const baselineDirectory = join(root, 'baseline'), baseline = journal({ directory: baselineDirectory })
  const baselineResult = await baseline.recordCancellation(await request(baseline))
  if (!baselineResult.recorded) throw Error('publisher expected')
  const reads: string[] = []
  disk.afterStat = path => { reads.push(path) }
  baselineResult.dispatch(() => {})
  disk.afterStat = undefined
  const lastLeaf = join(baselineDirectory + '.witnesses', '00000000.json')
  expect(reads.at(-1)).toBe(lastLeaf)
  const lastRead = reads.filter(path => path === lastLeaf).length
  for (const deferred of [false, true]) {
    let current = true, seen = 0
    const location = join(root, `boundary-${deferred}`), owner = journal({ directory: location, current: () => current })
    const input = await request(owner, { requestId: `fixture-boundary-${changed}-${deferred}`, nonce: 'fixture-boundary-nonce' })
    const result = await owner.recordCancellation(input)
    if (!result.recorded) throw Error('publisher expected')
    const target = join(location + '.witnesses', '00000000.json')
    const revoke = () => { if (changed === 'owner') current = false; else owner.close() }
    // Measure the actual verifier once, then revoke at its final leaf. An earlier
    // revocation could be caught by another disk proof and miss this regression.
    const arm = () => { disk.afterStat = path => { if (path === target && ++seen === lastRead) revoke() } }
    const effect = vi.fn()
    if (deferred) {
      await expect(result.dispatch(async verify => { await Promise.resolve(); arm(); verify(); effect() })).rejects.toThrow('owner changed')
    } else {
      arm()
      expect(() => result.dispatch(effect)).toThrow('owner changed')
    }
    disk.afterStat = undefined
    expect(seen).toBe(lastRead)
    expect(effect).not.toHaveBeenCalled()
  }
})

it('does not give a retry dispatch permission after an uncertain visible publication', async () => {
  const owner = journal(), input = await request(owner)
  disk.afterFlush = fd => {
    if (fstatSync(fd).isDirectory() && existsSync(join(directory, '00000000.json'))) disk.fail = true
  }
  await expect(owner.recordCancellation(input)).rejects.toThrow('disk unavailable')
  disk.afterFlush = undefined
  expect((await journal().snapshot()).cancellations.get(input.requestId)).toEqual(input)
  await expect(journal().recordCancellation(input)).rejects.toThrow('disk unavailable')
  disk.fail = false
  expect(await journal().recordCancellation(input)).toMatchObject({ recorded: false })
  expect((await journal().snapshot()).length).toBe(1)
})

it.each(['nonce', 'agentId', 'conversationId', 'frontier'] as const)('refuses changed %s under the original cancellation ID', async changed => {
  const owner = journal(), input = await request(owner)
  await owner.recordCancellation(input)
  const revised = { ...input, [changed]: changed === 'frontier' ? (await owner.snapshot()).frontier : 'fixture-different-value' }
  await expect(journal().recordCancellation(revised)).rejects.toThrow('NATIVE_CANCELLATION_CONFLICT')
  expect((await owner.snapshot()).length).toBe(1)
})

it('deduplicates tombstones globally while each later request preserves its own prefix', async () => {
  const owner = journal()
  await owner.recordGeneration(fact('activity'))
  const input = await request(owner)
  await owner.recordCancellation(input)
  await owner.recordCancellation({ ...input, requestId: 'fixture-cancellation-02', nonce: 'fixture-second-nonce' })
  const after = await owner.snapshot()
  expect(after.cancellations.size).toBe(2)
  expect([...after.generations.values()].filter(fact => fact.kind === 'cancelled')).toHaveLength(1)
  await expect(owner.recordGeneration(nativeCancellationFact(input, 'unrelated-generation'))).rejects.toThrow('cannot gain later targets')
})

it('counts the control barrier within the terminal record and byte reservation', async () => {
  const owner = journal({ maxRecords: 6, maxBytes: 90_000 })
  await owner.recordGeneration(fact('activity'))
  expect((await owner.snapshot()).controlReserved).toBe(true)
  await expect(owner.recordGeneration(fact('activity', 'fixture-second-activity', 'second'))).rejects.toThrow('terminal outcomes')
  const result = await owner.recordCancellation(await request(owner))
  expect(result).toMatchObject({ recorded: true, targets: ['generation-one'] })
  expect((await owner.snapshot()).controlReserved).toBe(false)
})

it('reserves a control barrier for Cursor intake before any generation is known', async () => {
  const owner = journal({ maxRecords: 4 })
  await expect(owner.retain({ id: 'fixture-cursor-intake', fingerprint: '0'.repeat(64), agentId: 'agent-one',
    conversationId: 'conversation-one', payload: { engine: 'cursor' } })).rejects.toThrow('terminal outcomes')
  expect((await owner.snapshot()).deliveries.size).toBe(0)
})

it('refuses an invented prefix before writing any cancellation or tombstones', async () => {
  const owner = journal(), input = await request(owner, { frontier: { index: 0, digest: '0'.repeat(64) } })
  await expect(owner.recordCancellation(input)).rejects.toThrow('frontier is unavailable')
  expect((await owner.snapshot()).cancellations.size).toBe(0)
})

it('persists a compact prefix reference, not a partially written list of target facts', async () => {
  const owner = journal()
  for (let index = 0; index < 12; index++) await owner.recordGeneration(fact('submitted', `fixture-prompt-${index}`, `generation-${index}`))
  const result = await owner.recordCancellation(await request(owner))
  expect(result).toMatchObject({ recorded: true, targets: expect.any(Array) })
  const after = await owner.snapshot(), name = `${String(after.length - 1).padStart(8, '0')}.json`
  const bytes = readFileSync(join(directory, name), 'utf8')
  expect(readFileSync(join(directory + '.witnesses', name), 'utf8')).toBe(bytes)
  expect(JSON.parse(bytes).event.kind).toBe('cancellation')
  expect(bytes).not.toContain('generation-')
  expect(Buffer.byteLength(bytes)).toBeLessThan(4096)
})
