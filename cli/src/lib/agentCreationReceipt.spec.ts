import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentCreationReceipts, creationFingerprint, type AgentCreationOutcome } from './agentCreationReceipt.js'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-create-receipt-'))
  roots.push(root)
  const directory = join(root, 'receipts')
  return { root, directory, receipts: new AgentCreationReceipts(directory) }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const id = 'creation-intent-0001'
const fingerprint = creationFingerprint({ engine: 'claude', cwd: '/work', bypassPermission: false })

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), linkSync: vi.fn(actual.linkSync) }
})
afterEach(() => vi.restoreAllMocks())

describe('agent creation receipts', () => {
  it('shares an in-flight launch and recovers its result after a lost reply and daemon restart', async () => {
    const { directory, receipts } = fixture()
    let finish!: (outcome: AgentCreationOutcome) => void
    const create = vi.fn(() => new Promise<AgentCreationOutcome>((resolve) => { finish = resolve }))
    const first = receipts.run(id, fingerprint, create)
    const retry = receipts.run(id, fingerprint, create)
    await Promise.resolve()
    expect(create).toHaveBeenCalledTimes(1)
    expect(receipts.status(id)).toEqual({ state: 'pending' })
    // A second daemon cannot claim a reservation whose result is still unknown.
    const other = new AgentCreationReceipts(directory)
    expect(await other.run(id, fingerprint, create)).toEqual({ state: 'unconfirmed' })
    finish({ state: 'created', agentId: 'agent-1' })
    expect(await first).toEqual({ state: 'created', agentId: 'agent-1' })
    expect(await retry).toEqual(await first)
    expect(await new AgentCreationReceipts(directory).run(id, fingerprint, create)).toEqual(await first)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('refuses changed settings on the same intent, but permits an explicit fresh intent', async () => {
    const { receipts } = fixture()
    const create = vi.fn(async () => ({ state: 'created' as const, agentId: 'agent-1' }))
    const first = receipts.run(id, fingerprint, create)
    const changed = creationFingerprint({ engine: 'codex', cwd: '/work' })
    expect(() => receipts.run(id, changed, create)).toThrow('CREATION_CONFLICT')
    await first
    expect(() => receipts.run(id, changed, create)).toThrow('CREATION_CONFLICT')
    await receipts.run('creation-intent-0002', changed, create)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('remembers known failures and refuses to retry an ambiguous exception', async () => {
    const { directory, receipts } = fixture()
    const refused = vi.fn(async () => ({ state: 'failed' as const, error: 'CWD_NOT_FOUND' }))
    await receipts.run(id, fingerprint, refused)
    expect(await new AgentCreationReceipts(directory).run(id, fingerprint, refused)).toEqual({ state: 'failed', error: 'CWD_NOT_FOUND' })
    expect(refused).toHaveBeenCalledTimes(1)
    const crashed = vi.fn(async () => { throw new Error('connection lost after spawn') })
    expect(await receipts.run('creation-intent-0002', fingerprint, crashed)).toEqual({ state: 'unconfirmed' })
    expect(await new AgentCreationReceipts(directory).run('creation-intent-0002', fingerprint, crashed)).toEqual({ state: 'unconfirmed' })
    expect(crashed).toHaveBeenCalledTimes(1)
  })

  it('retains the result in memory if completion cannot be saved, with a fail-closed reservation after restart', async () => {
    const { root, directory, receipts } = fixture()
    const moved = join(root, 'unavailable-disk')
    const create = vi.fn(async () => {
      renameSync(directory, moved)
      return { state: 'created' as const, agentId: 'agent-1' }
    })
    await receipts.run(id, fingerprint, create)
    expect(receipts.status(id)).toEqual({ state: 'created', agentId: 'agent-1' })
    renameSync(moved, directory)
    expect(await new AgentCreationReceipts(directory).run(id, fingerprint, create)).toEqual({ state: 'unconfirmed' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('distinguishes missing from corrupt receipts and never launches without a valid reservation', async () => {
    const { directory, receipts } = fixture()
    const create = vi.fn(async () => ({ state: 'created' as const, agentId: 'agent-1' }))
    expect(receipts.status(id)).toEqual({ state: 'missing' })
    mkdirSync(directory, { mode: 0o700 })
    writeFileSync(join(directory, `${id}.json`), '{partial', { mode: 0o600 })
    expect(() => receipts.run(id, fingerprint, create)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => receipts.run('../invalid-id', fingerprint, create)).toThrow('INVALID_CREATION_ID')
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps launch settings out of private receipts and canonicalizes equivalent requests', async () => {
    const { directory, receipts } = fixture()
    const launch = { cwd: '/private/work', grid: { token: 'fixture-secret', url: 'https://example.invalid' } }
    const reordered = { grid: { url: 'https://example.invalid', token: 'fixture-secret' }, cwd: '/private/work' }
    expect(creationFingerprint(launch)).toEqual(creationFingerprint(reordered))
    await receipts.run(id, creationFingerprint(launch), async () => ({ state: 'created', agentId: 'agent-1' }))
    const file = join(directory, `${id}.json`)
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain('fixture-secret')
    expect(text).not.toContain('/private/work')
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})


it('retains a fork handoff level through a daemon restart', async () => {
  const { directory, receipts } = fixture()
  await receipts.run(id, fingerprint, async () => ({ state: 'created', agentId: 'forked', level: 'handoff' }))
  const restarted = new AgentCreationReceipts(directory)
  expect(restarted.status(id)).toEqual({ state: 'created', agentId: 'forked', level: 'handoff' })
  const launch = vi.fn()
  expect(await restarted.run(id, fingerprint, launch)).toEqual({ state: 'created', agentId: 'forked', level: 'handoff' })
  expect(launch).not.toHaveBeenCalled()
})

it('retains a fresh restart outcome through a daemon restart', async () => {
  const { directory, receipts } = fixture()
  const restart = vi.fn(async () => ({ state: 'created' as const, agentId: 'agent-1', resumed: false }))
  const intent = creationFingerprint({ operation: 'restart', agentId: 'agent-1' })
  await receipts.run(id, intent, restart)
  const recovered = new AgentCreationReceipts(directory)
  expect(recovered.status(id)).toEqual({ state: 'created', agentId: 'agent-1', resumed: false })
  expect(await recovered.run(id, intent, restart)).toEqual(recovered.status(id))
  expect(restart).toHaveBeenCalledTimes(1)
})

describe('recoverable undispatched creation intents', () => {
  const request = { kind: 'model-create', local: false, choices: { engine: 'claude', cwd: '/fixture/work', model: 'fixture-model' } }
  const held = { service: 'models', detail: 'Waiting for the selected model.' }
  const created = { state: 'created' as const, agentId: 'fixture-agent' }

  it('persists a held request, resumes it in another core and dispatches once across two cores', async () => {
    const { directory, receipts } = fixture()
    const offline = vi.fn(async () => null)
    expect(await receipts.runIntent(id, fingerprint, request, held, offline)).toEqual({ state: 'pending', held })
    const recovered = new AgentCreationReceipts(directory)
    expect(recovered.status(id)).toEqual({ state: 'pending', held })
    const found = []
    for await (const row of recovered.pendingIntents()) if (row) found.push(row)
    expect(found).toEqual([{ id, fingerprint, request, held }])
    let ready!: () => void
    const service = new Promise<void>(resolve => { ready = resolve })
    let finish!: (result: AgentCreationOutcome) => void
    const effect = vi.fn(() => new Promise<AgentCreationOutcome>(resolve => { finish = resolve }))
    const prepare = vi.fn(async (saved) => { expect(saved).toEqual(request); await service; return effect })
    const first = recovered.runIntent(id, fingerprint, request, held, prepare)
    const duplicate = recovered.runIntent(id, fingerprint, request, held, prepare)
    const competing = receipts.runIntent(id, fingerprint, request, held, prepare)
    expect(first).toBe(duplicate)
    ready()
    await vi.waitFor(() => expect(effect).toHaveBeenCalledOnce())
    expect(await competing).toEqual({ state: 'unconfirmed' })
    expect(recovered.status(id)).toEqual({ state: 'pending' })
    finish(created)
    expect(await first).toEqual(created)
    expect(new AgentCreationReceipts(directory).status(id)).toEqual(created)
    expect(await receipts.runIntent(id, fingerprint, request, held, prepare)).toEqual(created)
    expect(effect).toHaveBeenCalledOnce()
  })

  it('lets a durable cancellation beat an unresolved dependency without any effect', async () => {
    const { directory, receipts } = fixture()
    let ready!: () => void
    const service = new Promise<void>(resolve => { ready = resolve })
    const effect = vi.fn(async () => created)
    const running = receipts.runIntent(id, fingerprint, request, held, async () => { await service; return effect })
    expect(new AgentCreationReceipts(directory).cancelIntent(id)).toEqual({ state: 'cancelled' })
    ready()
    expect(await running).toEqual({ state: 'cancelled' })
    expect(effect).not.toHaveBeenCalled()
    expect(new AgentCreationReceipts(directory).status(id)).toEqual({ state: 'cancelled' })
  })

  it.each(['missing', 'corrupt', 'changed', 'directory', 'cancelled'])('revokes a deferred callback when its durable intent is %s', async change => {
    const { root, directory, receipts } = fixture()
    let ready!: () => void
    const service = new Promise<void>(resolve => { ready = resolve })
    const effect = vi.fn(async () => created)
    const running = receipts.runIntent(id, fingerprint, request, held, async () => { await service; return effect })
    const answer = running.catch(error => error)
    const file = join(directory, `${id}.json`)
    const bytes = readFileSync(file, 'utf8')
    if (change === 'directory') {
      renameSync(directory, join(root, 'old-receipts'))
      mkdirSync(directory, { mode: 0o700 })
      writeFileSync(file, bytes, { mode: 0o600 })
    } else if (change === 'corrupt') writeFileSync(file, '{')
    else if (change === 'changed') {
      const value = JSON.parse(bytes)
      value.request.changed = true
      value.checksum = creationFingerprint({ fingerprint: value.fingerprint, request: value.request, held: value.held })
      writeFileSync(file, JSON.stringify(value))
    } else {
      rmSync(file)
      if (change === 'cancelled') expect(new AgentCreationReceipts(directory).cancelIntent(id)).toEqual({ state: 'cancelled' })
    }
    ready()
    if (change === 'cancelled') expect(await answer).toEqual({ state: 'cancelled' })
    else expect(await answer).toMatchObject({ code: 'CREATION_STORAGE_FAILED' })
    expect(effect).not.toHaveBeenCalled()
  })

  it('keeps a cancel-before-create tombstone through restart and does not cancel a claimed effect', async () => {
    const { directory, receipts } = fixture()
    expect(receipts.cancelIntent(id)).toEqual({ state: 'cancelled' })
    const next = new AgentCreationReceipts(directory)
    const prepare = vi.fn()
    expect(await next.runIntent(id, fingerprint, request, held, prepare)).toEqual({ state: 'cancelled' })
    expect(await next.run(id, fingerprint, prepare)).toEqual({ state: 'cancelled' })
    expect(prepare).not.toHaveBeenCalled()
    let finish!: (result: AgentCreationOutcome) => void
    const effect = vi.fn(() => new Promise<AgentCreationOutcome>(resolve => { finish = resolve }))
    const running = next.runIntent(`${id}-next`, fingerprint, request, held, async () => effect)
    await vi.waitFor(() => expect(effect).toHaveBeenCalledOnce())
    expect(receipts.cancelIntent(`${id}-next`)).toEqual({ state: 'unconfirmed' })
    finish(created)
    expect(await running).toEqual(created)
    expect(receipts.cancelIntent(`${id}-next`)).toEqual(created)
  })

  it('never replays a claimed effect after an exception or a lost completion record', async () => {
    const { directory, receipts } = fixture()
    const effect = vi.fn(async () => { throw new Error('reply lost after project or terminal effect') })
    expect(await receipts.runIntent(id, fingerprint, request, held, async () => effect)).toEqual({ state: 'unconfirmed' })
    const restarted = new AgentCreationReceipts(directory)
    expect(await restarted.runIntent(id, fingerprint, request, held, async () => effect)).toEqual({ state: 'unconfirmed' })
    expect(effect).toHaveBeenCalledOnce()
    const other = `${id}-lost-result`
    await receipts.runIntent(other, fingerprint, request, held, async () => async () => {
      vi.mocked(fs.linkSync).mockImplementationOnce(() => { throw new Error('disk disconnected') })
      return created
    })
    expect(receipts.status(other)).toEqual(created)
    expect(new AgentCreationReceipts(directory).status(other)).toEqual({ state: 'unconfirmed' })
  })

  it('does not execute after a claim was linked but its directory sync failed', async () => {
    const { directory, receipts } = fixture()
    const effect = vi.fn(async () => created)
    const realSync = vi.mocked(fs.fsyncSync).getMockImplementation()
    const prepare = async () => {
      let calls = 0
      vi.mocked(fs.fsyncSync).mockImplementation(fd => {
        if (++calls === 3) throw new Error('directory sync failed after link')
        realSync!(fd)
      })
      return effect
    }
    await expect(receipts.runIntent(id, fingerprint, request, held, prepare)).rejects.toThrow('CREATION_STORAGE_FAILED')
    vi.mocked(fs.fsyncSync).mockImplementation(realSync!)
    expect(effect).not.toHaveBeenCalled()
    const other = new AgentCreationReceipts(directory)
    expect(await other.runIntent(id, fingerprint, request, held, prepare)).toEqual({ state: 'unconfirmed' })
    expect(effect).not.toHaveBeenCalled()
  })

  it.each(['claim-token', 'result-token', 'outcome', 'preexisting', 'missing-claim', 'cancel-kind', 'missing-all', 'missing-directory', 'tombstone', 'legacy'])('does not hide conflicting %s evidence beneath an unsaved local outcome', async conflict => {
    const { directory, receipts } = fixture()
    const effect = vi.fn(async () => {
      if (conflict === 'preexisting') {
        const claim = JSON.parse(readFileSync(join(directory, `${id}.json.claim`), 'utf8'))
        writeFileSync(join(directory, `${id}.json.result`), JSON.stringify({ ...claim, token: 'other-claim', outcome: created }), { mode: 0o600 })
      } else vi.mocked(fs.linkSync).mockImplementationOnce(() => { throw new Error('disk disconnected') })
      return created
    })
    if (conflict === 'preexisting') {
      await expect(receipts.runIntent(id, fingerprint, request, held, async () => effect)).rejects.toThrow('CREATION_STORAGE_FAILED')
    } else {
      expect(await receipts.runIntent(id, fingerprint, request, held, async () => effect)).toEqual(created)
      const claimFile = join(directory, `${id}.json.claim`)
      const claim = JSON.parse(readFileSync(claimFile, 'utf8'))
      if (conflict === 'claim-token') writeFileSync(claimFile, JSON.stringify({ ...claim, token: 'other-claim' }))
      else if (conflict === 'cancel-kind') writeFileSync(claimFile, JSON.stringify({ ...claim, kind: 'cancel' }))
      else if (['missing-claim', 'missing-all', 'tombstone', 'legacy'].includes(conflict)) {
        rmSync(claimFile)
        if (conflict === 'missing-all') rmSync(join(directory, `${id}.json`))
        if (conflict === 'tombstone') writeFileSync(join(directory, `${id}.json`), JSON.stringify({ version: 2, cancelled: true }))
        if (conflict === 'legacy') writeFileSync(join(directory, `${id}.json`), JSON.stringify({ version: 1, fingerprint, outcome: { state: 'pending' } }))
      }
      else if (conflict === 'missing-directory') rmSync(directory, { recursive: true })
      else writeFileSync(join(directory, `${id}.json.result`), JSON.stringify({ ...claim,
        token: conflict === 'result-token' ? 'other-claim' : claim.token,
        outcome: conflict === 'outcome' ? { state: 'created', agentId: 'different-agent' } : created }), { mode: 0o600 })
    }
    expect(() => receipts.status(id)).toThrow('CREATION_STORAGE_FAILED')
    await expect(async () => await receipts.runIntent(id, fingerprint, request, held, async () => effect)).rejects.toThrow('CREATION_STORAGE_FAILED')
    await expect(async () => await receipts.run(id, fingerprint, effect)).rejects.toThrow('CREATION_STORAGE_FAILED')
    expect(() => receipts.cancelIntent(id)).toThrow('CREATION_STORAGE_FAILED')
    expect(effect).toHaveBeenCalledOnce()
  })

  it('lets a slow successful dependency complete the original request after a prompt pending reply', async () => {
    vi.useFakeTimers()
    try {
      const { receipts } = fixture()
      const effect = vi.fn(async () => created)
      const prepare = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 6_000)); return effect })
      const first = receipts.runIntent(id, fingerprint, request, held, prepare)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await first).toEqual({ state: 'pending', held })
      expect(receipts.status(id)).toEqual({ state: 'pending', held })
      expect(await receipts.runIntent(id, fingerprint, request, held, prepare)).toEqual({ state: 'pending', held })
      expect(prepare).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(receipts.status(id)).toEqual(created)
      expect(effect).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('holds orphan results, missing intents and null records instead of repeating an effect', async () => {
    const { directory, receipts } = fixture()
    const effect = vi.fn(async () => created)
    const prepare = vi.fn(async () => effect)
    await receipts.runIntent(id, fingerprint, request, held, prepare)
    rmSync(join(directory, `${id}.json.claim`))
    const recovered = new AgentCreationReceipts(directory)
    expect(() => recovered.runIntent(id, fingerprint, request, held, prepare)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => recovered.cancelIntent(id)).toThrow('CREATION_STORAGE_FAILED')
    rmSync(join(directory, `${id}.json`))
    expect(() => recovered.run(id, fingerprint, effect)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => recovered.status(id)).toThrow('CREATION_STORAGE_FAILED')
    writeFileSync(join(directory, `${id}.json.result`), 'null', { mode: 0o600 })
    expect(() => recovered.runIntent(id, fingerprint, request, held, prepare)).toThrow('CREATION_STORAGE_FAILED')
    expect(effect).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('flushes new directory names before publishing and refuses an unavailable parent flush', async () => {
    const { directory, receipts } = fixture()
    const effect = vi.fn(async () => created)
    const prepare = vi.fn(async () => effect)
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('parent not durable') })
    expect(() => receipts.runIntent(id, fingerprint, request, held, prepare)).toThrow('CREATION_STORAGE_FAILED')
    expect(prepare).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
    expect(await new AgentCreationReceipts(directory).runIntent(id, fingerprint, request, held, prepare)).toEqual(created)
  })

  it('retains v1 exclusions and refuses changed, corrupt or oversized intent data', async () => {
    const { directory, receipts } = fixture()
    await receipts.run(id, fingerprint, async () => created)
    const prepare = vi.fn(async () => vi.fn())
    expect(await receipts.runIntent(id, fingerprint, request, held, prepare)).toEqual(created)
    expect(() => receipts.runIntent(id, creationFingerprint({ changed: true }), request, held, prepare)).toThrow('CREATION_CONFLICT')
    const other = `${id}-held`
    await receipts.runIntent(other, fingerprint, request, held, async () => null)
    expect(() => receipts.run(other, creationFingerprint({ changed: true }), vi.fn())).toThrow('CREATION_CONFLICT')
    expect(await receipts.run(other, fingerprint, vi.fn())).toEqual({ state: 'pending', held })
    writeFileSync(join(directory, `${other}.json.claim`), '{partial', { mode: 0o600 })
    expect(() => receipts.status(other)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => receipts.runIntent(`${id}-huge`, fingerprint, { text: 'x'.repeat(262_144) }, held, prepare)).toThrow('CREATION_STORAGE_FAILED')
    const found = []
    for await (const item of receipts.pendingIntents()) if (item) found.push(item)
    expect(found).toEqual([])
    expect(prepare).not.toHaveBeenCalled()
  })
})
