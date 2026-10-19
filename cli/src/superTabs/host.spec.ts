import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, TurnDelivery } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { backend, hostJournalFile, SuperTabHost } from './host.js'
import { retainedHarnesses, retentionFile } from './retention.js'

const roots: string[] = []
const hosts: SuperTabHost[] = []
afterEach(() => { for (const host of hosts.splice(0)) host.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup(messageFields: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'super-tab-host-')); roots.push(dir)
  const listeners = new Set<(e: TurnDelivery) => void>()
  const row = { tabId: 'tab', agent: { id: 'agent', harnessId: 'harness', machineId: 'machine-1' } }
  let removed = false, revoked = false, status = 'queued', claimId: string | null = null
  const receipts: Record<string, unknown>[] = []
  const call: CoreApi['account']['backend'] = vi.fn(async (method, path, body) => {
    let data: unknown
    if (path.includes('/hosts/')) data = removed ? [] : [row]
    else if (revoked) return { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Grant removed' } } }
    else if (method === 'GET') data = status === 'delivered' ? [] : [{ id: 'delivery', claimId, status }]
    else {
      const command = body as Record<string, unknown>
      if (command.type === 'claim') { claimId = command.claimId as string; status = 'claimed' }
      else { receipts.push(command); status = command.uncertain ? 'uncertain' : 'delivered' }
      data = { delivery: { id: 'delivery', claimId, status }, message: { id: 'message', conversationId: 'lead', text: 'Build the agreed feature.', author: { name: 'Collaborator' }, ...messageFields } }
    }
    return { status: 200, body: { success: true, data } }
  })
  const core = fakeCore({ dataDir: dir,
    agents: { byAgent: vi.fn(() => ({ agentId: 'harness' }) as never), terminalAvailable: vi.fn(() => true) },
    account: { backend: call },
    turns: { onDelivery: vi.fn(fn => { listeners.add(fn); return () => { listeners.delete(fn) } }) },
  })
  const open = () => { const host = new SuperTabHost(core, 'machine-1', { log: vi.fn() }); hosts.push(host); return host }
  const event = (state: TurnDelivery['state'], reason?: string) => {
    for (const fn of listeners) fn({ deliveryId: 'team:service:superTabs:delivery', sessionId: 'harness', state, reason })
  }
  const saved = () => JSON.parse(readFileSync(hostJournalFile(dir, 'machine-1'), 'utf8'))
  return { core, call, open, event, receipts, saved, dir, remove: () => { removed = true }, revoke: (value = true) => { revoked = value }, foreignClaim: () => { claimId = 'another-process' } }
}

describe('Super Tab native delivery handoff', () => {
  it('keeps roster members through host failure and restart, releasing only a confirmed removal', async () => {
    const t = setup(), first = t.open()
    await first.tick()
    expect(retainedHarnesses(t.dir).has('harness')).toBe(true)
    first.stop()
    expect(retainedHarnesses(t.dir).has('harness')).toBe(true)
    const next = t.open()
    vi.mocked(t.call).mockRejectedValueOnce(new Error('Host offline'))
    await next.tick()
    expect(retainedHarnesses(t.dir).has('harness')).toBe(true)
    t.remove()
    await next.tick()
    expect(retainedHarnesses(t.dir).size).toBe(0)
  })
  it('keeps delivering when retention cannot be saved, and says so once', async () => {
    const t = setup(), log = vi.fn()
    mkdirSync(`${retentionFile(t.dir)}.next`, { recursive: true })
    const host = new SuperTabHost(t.core, 'machine-1', { log }); hosts.push(host)
    await host.tick(); await host.tick()
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(1)
    expect(t.core.turns.leaseDeliveries).toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
  })
  it('preserves the exact reply reference when a short human answer reaches an agent', async () => {
    const t = setup({ replyTo: 'question-2', text: 'Yes, keep them.' })
    await t.open().tick()
    expect(t.core.turns.deliver).toHaveBeenCalledWith('harness', expect.stringContaining(
      'In reply to message question-2. Read it before interpreting the answer:'
    ), 'team:service:superTabs:delivery')
    expect(vi.mocked(t.core.turns.deliver).mock.calls[0]?.[1]).toContain('Message message from Collaborator:\nYes, keep them.')
  })

  it('keeps a slow configuration observation out of the native delivery and lease path', async () => {
    const t = setup(), host = t.open()
    vi.mocked(t.core.agents.byAgent).mockReturnValue({ agentId: 'harness', engine: 'claude' } as never)
    vi.mocked(t.core.agents.runtimeProfile).mockReturnValue('runtime-v1:harness:claude:sonnet@high')
    const original = vi.mocked(t.call).getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let observations = 0
    vi.mocked(t.call).mockImplementation(async (...args) => {
      if (args[1].endsWith('/commands')) {
        observations++
        await gate
        return { status: 200, body: { data: {} } }
      }
      return original(...args)
    })
    await host.tick(); await host.tick()
    expect(observations).toBe(1)
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(1)
    expect(t.core.turns.leaseDeliveries).toHaveBeenCalled()
    host.stop(); release()
    await Promise.resolve()
  })
  it('retires a human-resolved journal entry without resubmitting its native input', async () => {
    const t = setup(), host = t.open()
    await host.tick(); t.event('unknown', 'lost acknowledgement'); await host.tick()
    const original = vi.mocked(t.core.account.backend).getMockImplementation()!
    vi.mocked(t.core.account.backend).mockImplementation(async (method, path, body) => {
      if (method === 'GET' && path.endsWith('/deliveries/delivery')) {
        return { status: 200, body: { success: true, data: { id: 'delivery', status: 'confirmed' } } }
      }
      return original(method, path, body)
    })
    await host.reconcileReceipts()
    expect(t.saved().entries).toEqual({})
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(1)
  })
  it('persists before typing, keeps one native delivery during polls, and acknowledges the exact receipt', async () => {
    const t = setup(), host = t.open()
    vi.mocked(t.core.turns.deliver).mockImplementation(() => expect(t.saved().entries.delivery.stage).toBe('submitting'))
    await host.tick(); await host.tick()
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(1)
    expect(t.core.turns.deliver).toHaveBeenCalledWith('harness', expect.stringContaining('post'), 'team:service:superTabs:delivery')
    expect(t.core.turns.leaseDeliveries).toHaveBeenCalledWith('superTabs', expect.objectContaining({ 'team:service:superTabs:delivery': expect.any(Number) }))
    t.event('queued'); t.event('delivered')
    const receipt = t.saved().entries.delivery.receipt
    await host.tick()
    expect(t.receipts).toEqual([expect.objectContaining({ receipt, uncertain: false })])
    expect(t.saved().entries).toEqual({})
    await host.tick()
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(1)
  })

  it('does not type again after a crash between submission and its native acknowledgement', async () => {
    const t = setup(), first = t.open()
    await first.tick(); first.stop()
    const restarted = t.open()
    await restarted.tick()
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(1)
    expect(t.receipts).toEqual([expect.objectContaining({ uncertain: true, receipt: expect.stringContaining('restarted') })])
  })

  it('replays a saved receipt after a lost backend acknowledgement without another native send', async () => {
    const t = setup(), first = t.open()
    await first.tick(); t.event('delivered'); first.stop()
    const restarted = t.open()
    await restarted.tick()
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(1)
    expect(t.receipts[0].uncertain).toBe(false)
  })

  it('retries an explicitly withheld busy-terminal write but never an ambiguous paste', async () => {
    const t = setup(), host = t.open()
    await host.tick(); t.event('rejected', 'team_waiting_busy')
    await host.tick()
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(2)
    t.event('unknown', 'dispatch_ambiguous')
    await host.tick(); await host.tick()
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(2)
    expect(t.receipts.every(r => r.uncertain === true)).toBe(true)
  })

  it('withdraws queued input on removal or revoked machine access and cannot revive it by re-sharing', async () => {
    const t = setup(), host = t.open()
    await host.tick(); t.revoke(); await host.tick()
    expect(t.core.turns.cancelDelivery).toHaveBeenCalledWith('team:service:superTabs:delivery')
    expect(t.core.turns.leaseDeliveries).toHaveBeenLastCalledWith('superTabs', {})
    t.revoke(false); await host.tick()
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(1)
    expect(t.receipts[0].uncertain).toBe(true)
    t.remove(); await host.tick()
  })

  it('exposes a claim without a local receipt for human recovery without taking over execution', async () => {
    const t = setup(), host = t.open()
    t.foreignClaim(); await host.tick()
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
    expect(t.receipts).toEqual([expect.objectContaining({
      claimId: 'another-process', uncertain: true, receipt: expect.stringContaining('no local receipt'),
    })])
    expect(t.saved().entries.delivery).toMatchObject({ claimId: 'another-process', stage: 'uncertain' })
    expect(t.core.turns.cancelDelivery).toHaveBeenCalledWith('team:service:superTabs:delivery')
    expect(t.core.turns.leaseDeliveries).toHaveBeenLastCalledWith('superTabs', {})
    expect(vi.mocked(t.call).mock.calls.some(([, , body]) => (body as any)?.type === 'claim')).toBe(false)
    vi.mocked(t.core.agents.byAgent).mockReturnValue(undefined)
    await host.tick()
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
  })

  it('retains a recovered claim across another lost acknowledgement and restart', async () => {
    const t = setup(), first = t.open()
    t.foreignClaim()
    const original = vi.mocked(t.call).getMockImplementation()!
    vi.mocked(t.call).mockImplementation(async (...args) => {
      const result = await original(...args)
      if ((args[2] as any)?.type === 'ack') throw new Error('Lost reply')
      return result
    })
    await first.tick()
    const receipt = t.saved().entries.delivery.receipt
    first.stop()
    vi.mocked(t.call).mockImplementation(original)
    await t.open().tick()
    expect(t.receipts).toEqual([
      { type: 'ack', claimId: 'another-process', uncertain: true, receipt },
      { type: 'ack', claimId: 'another-process', uncertain: true, receipt },
    ])
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
  })

  it('preserves an existing uncertain native receipt when its journal is missing', async () => {
    const t = setup(), host = t.open()
    const original = vi.mocked(t.call).getMockImplementation()!
    vi.mocked(t.call).mockImplementation(async (...args) => args[0] === 'GET' && args[1].endsWith('/deliveries')
      ? { status: 200, body: { data: [{ id: 'delivery', status: 'uncertain', claimId: 'old-claim', receipt: 'Native paste was ambiguous.' }] } }
      : original(...args))
    await host.tick()
    expect(t.saved().entries.delivery).toMatchObject({ claimId: 'old-claim', stage: 'uncertain', receipt: 'Native paste was ambiguous.' })
    expect(t.receipts).toEqual([])
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
  })

  it('refuses to type without a durable local intent or the core guard', async () => {
    const t = setup(), host = t.open()
    vi.mocked(t.core.turns.leaseDeliveries).mockResolvedValue(false)
    await host.tick()
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
    host.stop()
    expect(() => new SuperTabHost(t.core, 'machine-1', { write: () => { throw new Error('Disk full') } })).toThrow('Disk full')
    writeFileSync(hostJournalFile(t.dir, 'machine-1'), 'not json')
    expect(() => t.open()).toThrow()
  })

  it('preserves the backend error code and never treats an error body as an empty roster', async () => {
    const t = setup()
    t.revoke()
    await expect(backend(t.core, 'GET', '/api/super-tabs/tab')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })
})

it('confirms a stopped assignment only with fresh native evidence, including after contribution removal', async () => {
  const t = setup()
  const stopped = vi.fn(async (id: string) => id === 'gone')
  t.core.agents.stopped = stopped
  const proof: unknown[] = []
  vi.mocked(t.core.account.backend).mockImplementation(async (method, path, body) => {
    if (method === 'GET') return { status: 200, body: { data: [
      { tabId: 'tab', assignmentId: 'work-1', harnessId: 'gone' },
      { tabId: 'tab', assignmentId: 'work-2', harnessId: 'unconfirmed' },
      { tabId: '', assignmentId: 'bad', harnessId: 'gone' },
    ] } }
    expect(path).toBe('/api/super-tabs/tab/stopped'); proof.push(body)
    return { status: 200, body: { data: { confirmed: true } } }
  })
  const host = t.open()
  await host.reconcileStops()
  expect(proof).toEqual([{ assignmentId: 'work-1', receipt: 'native-stopped:machine-1:gone:work-1' }])
  await host.reconcileStops()
  expect(proof).toHaveLength(1)
  host.stop()
  await host.reconcileStops()
  expect(proof).toHaveLength(1)
})
