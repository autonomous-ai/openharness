import { describe, expect, it, vi } from 'vitest'
import { createSessionModelControl, type NativeApiRun } from './kit/nativeSessionModel.js'
import { OPENCODE_SESSION_MODEL } from './opencode/contract.js'

const requested = { providerID: 'fixture', modelID: 'new' }
const answer = (id = 'new') => ({ stdout: JSON.stringify({ data: { id: 'ses_fixture', model: { providerID: 'fixture', id } } }) })
const control = () => createSessionModelControl(OPENCODE_SESSION_MODEL, () => '/fixture/bin/opencode')

describe('native mutation recovery', () => {
  it('does not write when the required catalog is unavailable', async () => {
    const run = vi.fn<NativeApiRun>(async args => {
      if (args[1] === 'model.list') throw Error('catalog unavailable')
      return answer()
    })
    expect(await control().switchSessionModel('ses_fixture', requested, { run, checkCatalog: true, retryDelayMs: 0 }))
      .toMatchObject({ ok: false })
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(['model.list'])
  })

  it('reads back a lost write reply without sending the mutation again', async () => {
    const run = vi.fn<NativeApiRun>(async args => {
      if (args[1] === 'session.switchModel') throw Error('reply lost after commit')
      return answer()
    })
    expect(await control().switchSessionModel('ses_fixture', requested, { run, retryDelayMs: 0 })).toEqual({ ok: true })
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(['session.switchModel', 'session.get'])
  })

  it('retries only reads when the first confirmation is unavailable', async () => {
    let reads = 0
    const run = vi.fn<NativeApiRun>(async args => {
      if (args[1] === 'session.get' && ++reads === 1) throw Error('read unavailable')
      return answer()
    })
    expect(await control().switchSessionModel('ses_fixture', requested, { run, retryDelayMs: 0 })).toEqual({ ok: true })
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(['session.switchModel', 'session.get', 'session.get'])
  })

  it('does not overwrite a different native choice while reconciling', async () => {
    const run = vi.fn<NativeApiRun>(async () => answer('chosen-in-terminal'))
    expect(await control().switchSessionModel('ses_fixture', requested, { run, retryDelayMs: 0 })).toMatchObject({ ok: false })
    expect(run.mock.calls.filter(([args]) => args[1] === 'session.switchModel')).toHaveLength(1)
  })

  it('keeps an uncertain write read-only across later requests, even for a different requested model', async () => {
    const session = control()
    let unavailable = true
    const run = vi.fn<NativeApiRun>(async args => {
      if (args[1] === 'session.get' && unavailable) throw Error('read unavailable after commit')
      return answer('chosen-in-terminal')
    })
    expect(await session.switchSessionModel('ses_fixture', requested, { run, retryDelayMs: 0 })).toMatchObject({ ok: false })
    unavailable = false
    expect(await session.switchSessionModel('ses_fixture', requested, { run, retryDelayMs: 0 })).toMatchObject({ ok: false })
    expect(await session.switchSessionModel('ses_fixture', { ...requested, modelID: 'another' }, { run, retryDelayMs: 0 })).toMatchObject({ ok: false })
    expect(run.mock.calls.filter(([args]) => args[1] === 'session.switchModel')).toHaveLength(1)
    run.mockImplementation(async () => answer())
    expect(await session.switchSessionModel('ses_fixture', requested, { run, retryDelayMs: 0 })).toEqual({ ok: true })
    expect(run.mock.calls.filter(([args]) => args[1] === 'session.switchModel')).toHaveLength(1)
  })

  it.each(['ses_stranger', undefined])('does not accept matching model data for session %s', async id => {
    const run = vi.fn<NativeApiRun>(async () => ({ stdout: JSON.stringify({ data: { id, model: { providerID: 'fixture', id: 'new' } } }) }))
    expect(await control().switchSessionModel('ses_fixture', requested, { run, retryDelayMs: 0 })).toMatchObject({ ok: false })
    expect(run.mock.calls.filter(([args]) => args[1] === 'session.switchModel')).toHaveLength(1)
  })

  it('serializes the first catalog read, retaining a snapshot of the requested model and folder', async () => {
    const session = control()
    let release!: () => void
    const ready = new Promise<void>(done => { release = done })
    const model = { ...requested }, options = { cwd: '/fixture/original', checkCatalog: true }
    const run = vi.fn<NativeApiRun>(async args => {
      if (args[1] === 'model.list') { await ready; return { stdout: JSON.stringify({ data: [{ providerID: 'fixture', id: 'new' }] }) } }
      return answer()
    })
    const first = session.switchSessionModel('ses_fixture', model, { ...options, run, retryDelayMs: 0 })
    model.modelID = 'later'
    const second = await session.switchSessionModel('ses_fixture', requested, { ...options, run, retryDelayMs: 0 })
    expect(second).toMatchObject({ ok: false, detail: expect.stringContaining('already running') })
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(['model.list'])
    release()
    expect(await first).toEqual({ ok: true })
    const [args, passed] = run.mock.calls.find(([args]) => args[1] === 'session.switchModel')!
    expect(JSON.parse(args.at(-1)!)).toEqual({ model: { providerID: 'fixture', id: 'new' } })
    expect(passed.cwd).toBe('/fixture/original')
  })

  it('keeps unresolved receipts at capacity and holds new conversations', async () => {
    const session = control()
    const run = vi.fn<NativeApiRun>(async args => {
      if (args[1] === 'session.get') throw Error('unavailable')
      return { stdout: '' }
    })
    for (let n = 0; n < 256; n++) {
      await session.switchSessionModel(`ses_fixture${n}`, requested, { run, retryDelayMs: 0 })
    }
    run.mockClear()
    expect(await session.switchSessionModel('ses_overflow', requested, { run, retryDelayMs: 0 }))
      .toMatchObject({ ok: false, detail: expect.stringContaining('outstanding') })
    expect(run).not.toHaveBeenCalled()
    await session.switchSessionModel('ses_fixture0', requested, { run, retryDelayMs: 0 })
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(['session.get', 'session.get'])
  })

  it('does not carry an unresolved write to another native store or folder', async () => {
    const session = control()
    const run = vi.fn<NativeApiRun>(async () => { throw Error('unavailable') })
    await session.switchSessionModel('ses_fixture', requested, { run, store: '/fixture/store', cwd: '/fixture/work', retryDelayMs: 0 })
    run.mockClear()
    for (const options of [{ store: '/fixture/other', cwd: '/fixture/work' }, { store: '/fixture/store', cwd: '/fixture/other' }]) {
      expect(await session.switchSessionModel('ses_fixture', requested, { run, ...options, retryDelayMs: 0 }))
        .toMatchObject({ ok: false, detail: expect.stringContaining('original store and folder') })
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('confirms a previous choice without silently starting a different one', async () => {
    const session = control()
    const run = vi.fn<NativeApiRun>(async () => { throw Error('unavailable') })
    await session.switchSessionModel('ses_fixture', requested, { run, retryDelayMs: 0 })
    run.mockClear().mockImplementation(async () => answer())
    expect(await session.switchSessionModel('ses_fixture', { ...requested, modelID: 'other' }, { run, retryDelayMs: 0 }))
      .toMatchObject({ ok: false, detail: expect.stringContaining('earlier native model change is now confirmed') })
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(['session.get'])
    expect(await session.switchSessionModel('ses_fixture', requested, { run, retryDelayMs: 0 })).toEqual({ ok: true })
  })

  it.each(['catalog', 'write', 'read'] as const)('stops after ownership is revoked during %s', async phase => {
    let current = true
    const run = vi.fn<NativeApiRun>(async args => {
      if (args[1] === ({ catalog: 'model.list', write: 'session.switchModel', read: 'session.get' })[phase]) current = false
      return args[1] === 'model.list' ? { stdout: JSON.stringify([{ providerID: 'fixture', id: 'new' }]) } : answer()
    })
    const session = control()
    const result = await session.switchSessionModel('ses_fixture', requested, { run, current: () => current, checkCatalog: true, retryDelayMs: 0 })
    expect(result).toMatchObject({ ok: false, code: 'AGENT_CHANGED' })
    const writes = () => run.mock.calls.filter(([args]) => args[1] === 'session.switchModel')
    expect(writes()).toHaveLength(phase === 'catalog' ? 0 : 1)
    // A cancelled operation after dispatch still leaves its receipt for a later read.
    if (phase !== 'catalog') {
      run.mockImplementation(async () => answer())
      expect(await session.switchSessionModel('ses_fixture', requested, { run, retryDelayMs: 0 })).toEqual({ ok: true })
      expect(writes()).toHaveLength(1)
    }
  })
})
