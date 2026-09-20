import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
