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
  const holds: Record<string, unknown>[] = []
  let clock = 0
  const call: CoreApi['account']['backend'] = vi.fn(async (method, path, body) => {
    let data: unknown
    if (path.includes('/hosts/')) data = removed ? [] : [row]
    else if (revoked) return { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Grant removed' } } }
    else if (method === 'GET') data = status === 'delivered' ? [] : [{ id: 'delivery', claimId, status }]
    else {
      const command = body as Record<string, unknown>
      if (command.type === 'claim') { claimId = command.claimId as string; status = 'claimed' }
      else if (command.type === 'hold') holds.push(command)
      else { receipts.push(command); status = command.uncertain ? 'uncertain' : 'delivered' }
      data = { delivery: { id: 'delivery', claimId, status }, message: { id: 'message', conversationId: 'lead', text: 'Build the agreed feature.', author: { name: 'Collaborator' }, ...messageFields } }
    }
    return { status: 200, body: { success: true, data } }
  })
  const core = fakeCore({ dataDir: dir,
    agents: { creationStatus: vi.fn(async creationId => ({ creationId, state: 'created' as const, agentId: 'harness' })), byAgent: vi.fn(() => ({ agentId: 'harness' }) as never), terminalAvailable: vi.fn(() => true) },
    account: { backend: call },
    turns: { onDelivery: vi.fn(fn => { listeners.add(fn); return () => { listeners.delete(fn) } }) },
  })
  const log = vi.fn()
  const open = () => { const host = new SuperTabHost(core, 'machine-1', { log, now: () => clock }); hosts.push(host); return host }
  const event = (state: TurnDelivery['state'], reason?: string) => {
    for (const fn of listeners) fn({ deliveryId: 'team:service:superTabs:delivery', sessionId: 'harness', state, reason })
  }
  const saved = () => JSON.parse(readFileSync(hostJournalFile(dir, 'machine-1'), 'utf8'))
  return { core, call, open, event, receipts, holds, log, wait: (ms: number) => { clock += ms }, saved, dir, remove: () => { removed = true }, revoke: (value = true) => { revoked = value }, foreignClaim: () => { claimId = 'another-process' } }
}

describe('Super Tab native delivery handoff', () => {
  it('names all five task parts in the worker delivery header', async () => {
    const t = setup()
    await t.open().tick()
    expect(vi.mocked(t.core.turns.deliver).mock.calls[0]?.[1]).toContain('goal, changes, constraints, owned code and acceptance checks')
  })
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
  it('never types a held delivery that was answered meanwhile, and retires its journal entry', async () => {
    const t = setup(), host = t.open()
    await host.tick(); t.event('rejected', 'team_waiting_busy')
    expect(t.saved().entries.delivery.stage).toBe('prepared')
    // The Lead read the question during its turn and replied; the backend now lists nothing and says answered.
    const original = vi.mocked(t.core.account.backend).getMockImplementation()!
    vi.mocked(t.core.account.backend).mockImplementation(async (method, path, body) => {
      if (path.endsWith('/deliveries/delivery')) return { status: 200, body: { success: true, data: { id: 'delivery', status: 'answered' } } }
      if (path.endsWith('/deliveries')) return { status: 200, body: { success: true, data: [] } }
      return original(method, path, body)
    })
    await host.tick(); await host.reconcileReceipts()
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(1)
    expect(t.saved().entries).toEqual({})
  })
  it('drops the lease of a held delivery answered while its lease was being granted', async () => {
    const t = setup(), host = t.open()
    await host.tick(); t.event('rejected', 'team_waiting_busy')
    const original = vi.mocked(t.core.account.backend).getMockImplementation()!
    vi.mocked(t.core.account.backend).mockImplementation(async (method, path, body) => {
      if (method === 'GET' && path.endsWith('/deliveries/delivery')) return { status: 200, body: { success: true, data: { id: 'delivery', status: 'answered' } } }
      return original(method, path, body)
    })
    vi.mocked(t.core.turns.leaseDeliveries).mockImplementationOnce(async () => { await host.reconcileReceipts(); return true })
    await host.tick()
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(1)
    expect(t.saved().entries).toEqual({})
    // A kept lease id would count toward the core's limit until the host restarts.
    expect(vi.mocked(t.core.turns.leaseDeliveries).mock.lastCall?.[1]).toEqual({})
  })
  it('retires an entry quietly when its claim is refused as answered, and still delivers the next one', async () => {
    const t = setup(), host = t.open()
    const original = vi.mocked(t.core.account.backend).getMockImplementation()!
    vi.mocked(t.core.account.backend).mockImplementation(async (method, path, body) => {
      if (method === 'GET' && path.endsWith('/deliveries')) {
        return { status: 200, body: { success: true, data: [{ id: 'delivery', claimId: null, status: 'queued' }, { id: 'second', claimId: null, status: 'queued' }] } }
      }
      if (method === 'POST' && path.endsWith('/deliveries/delivery')) {
        return { status: 409, body: { success: false, error: { code: 'DELIVERY_RESOLVED', message: 'This message was already answered.' } } }
      }
      if (method === 'POST') return { status: 200, body: { success: true, data: { delivery: { id: 'second' }, message: { id: 'message', conversationId: 'lead', text: 'Next.', author: { name: 'Collaborator' } } } } }
      return original(method, path, body)
    })
    await host.tick()
    expect(Object.keys(t.saved().entries)).toEqual(['second'])
    expect(t.saved().entries.second.stage).toBe('submitting')
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(1)
    expect(t.core.turns.deliver).toHaveBeenCalledWith('harness', expect.any(String), 'team:service:superTabs:second')
    expect(t.core.turns.cancelDelivery).not.toHaveBeenCalled()
  })
  it('keeps a held delivery that is still open when its receipt is checked', async () => {
    const t = setup(), host = t.open()
    await host.tick(); t.event('rejected', 'team_waiting_busy')
    const original = vi.mocked(t.core.account.backend).getMockImplementation()!
    vi.mocked(t.core.account.backend).mockImplementation(async (method, path, body) => {
      if (path.endsWith('/deliveries/delivery') && method === 'GET') return { status: 200, body: { success: true, data: { id: 'delivery', status: 'claimed' } } }
      return original(method, path, body)
    })
    await host.reconcileReceipts()
    expect(Object.keys(t.saved().entries)).toEqual(['delivery'])
  })
  it('tells the agent how to reply to this exact message, in short plain words', async () => {
    const t = setup({ author: { kind: 'person', id: 'p1', name: 'sam@example.com' }, text: 'How is it going?' })
    await t.open().tick()
    const prompt = vi.mocked(t.core.turns.deliver).mock.calls[0]![1] as string
    expect(prompt).toContain('Message message from sam@example.com:\nHow is it going?')
    expect(prompt).toContain("post 'lead' 'your message' UNIQUE_OPERATION_ID --reply-to 'message'")
    expect(prompt).toContain('Ask questions and post results in this conversation.')
    expect(prompt).toContain('Answer each message once')
    expect(prompt).not.toContain('email addresses')
    expect(prompt).not.toContain('Report exact revisions')
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

  it('logs why the core withholds a delivery once per change of reason, with how long it has waited', async () => {
    const t = setup(), host = t.open()
    await host.tick()
    for (const [reason, seconds] of [['team_waiting_draft', 0], ['team_waiting_draft', 5], ['team_waiting_idle', 10]] as const) {
      t.wait(seconds * 1000 - (seconds === 10 ? 5_000 : 0)); t.event('rejected', reason); await host.tick()
    }
    t.event('rejected', 'team_waiting_idle')
    const lines = t.log.mock.calls.map(([line]) => line as string).filter(line => line.includes('withheld'))
    expect(lines).toEqual([
      expect.stringContaining('withheld: team_waiting_draft, waiting 0s'),
      expect.stringContaining('withheld: team_waiting_idle, waiting 10s'),
    ])
  })

  it('tells the conversation once, in plain words, when a delivery waits over 30 seconds', async () => {
    const t = setup(), host = t.open()
    await host.tick()
    t.event('rejected', 'team_waiting_draft'); await host.tick()
    t.wait(29_000); t.event('rejected', 'team_waiting_draft'); await host.tick()
    expect(t.holds).toEqual([])
    t.wait(2_000); t.event('rejected', 'team_waiting_draft'); await host.tick()
    t.event('rejected', 'team_waiting_draft'); await host.tick()
    await vi.waitFor(() => expect(t.holds).toEqual([{ type: 'hold', claimId: expect.any(String), reason: 'team_waiting_draft' }]))
    t.wait(60_000); t.event('rejected', 'team_waiting_draft'); await host.tick()
    expect(t.holds).toHaveLength(1)
  })

  it('asks again for a notice that failed, but only after another 30 seconds, and says an unknown reason as unavailable', async () => {
    const t = setup(), host = t.open()
    await host.tick()
    t.event('rejected', 'team_waiting_busy'); await host.tick()
    const original = vi.mocked(t.call).getMockImplementation()!
    vi.mocked(t.call).mockImplementation(async (method, path, body) => {
      if ((body as any)?.type === 'hold') throw new Error('Backend offline')
      return original(method, path, body)
    })
    t.wait(31_000); t.event('rejected', 'team_waiting_busy'); await host.tick()
    await vi.waitFor(() => expect(t.log).toHaveBeenCalledWith('Backend offline'))
    t.wait(10_000); t.event('rejected', 'team_waiting_busy'); await host.tick()
    vi.mocked(t.call).mockImplementation(original)
    t.wait(21_000); t.event('rejected', 'team_waiting_busy'); await host.tick()
    await vi.waitFor(() => expect(t.holds).toEqual([expect.objectContaining({ reason: 'team_waiting_unavailable' })]))
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

describe('Super Tab attachments in delivered input', () => {
  it('lists the downloaded files after the text and downloads them once while the terminal holds the input', async () => {
    const file = { id: 'a1', name: 'screen.png', mime: 'image/png', size: 5, url: 'https://cdn.example.test/x/screen.png' }
    const t = setup({ text: 'See the screenshot.', attachments: [file] })
    const attachedFiles = vi.fn(async () => ({ text: 'Attached files:\n- /drops/1-screen.png (screen.png, 5 B)', complete: true }))
    const host = new SuperTabHost(t.core, 'machine-1', { log: vi.fn(), attachedFiles }); hosts.push(host)
    await host.tick()
    expect(attachedFiles).toHaveBeenCalledWith(expect.objectContaining({ attachments: [file] }))
    expect(vi.mocked(t.core.turns.deliver).mock.calls[0]?.[1])
      .toMatch(/:\nSee the screenshot\.\n\nAttached files:\n- \/drops\/1-screen\.png \(screen\.png, 5 B\)$/)
    t.event('rejected', 'team_waiting_busy')
    await host.tick()
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(2)
    expect(vi.mocked(t.core.turns.deliver).mock.calls[1]?.[1]).toContain('/drops/1-screen.png')
    expect(attachedFiles).toHaveBeenCalledTimes(1)
  })
  it('downloads a failed file again before the next delivery of the held input', async () => {
    const t = setup({ text: 'Logs.', attachments: [{ id: 'a1', name: 'a.log', mime: 'text/plain', size: 1, url: 'https://cdn.example.test/a.log' }] })
    const attachedFiles = vi.fn()
      .mockResolvedValueOnce({ text: 'Attached files:\n- Could not download https://cdn.example.test/a.log (a.log, 1 B): HTTP 503', complete: false })
      .mockResolvedValue({ text: 'Attached files:\n- /drops/a.log (a.log, 1 B)', complete: true })
    const host = new SuperTabHost(t.core, 'machine-1', { log: vi.fn(), attachedFiles }); hosts.push(host)
    await host.tick()
    expect(vi.mocked(t.core.turns.deliver).mock.calls[0]?.[1]).toContain('Could not download')
    t.event('rejected', 'team_waiting_busy')
    await host.tick()
    expect(vi.mocked(t.core.turns.deliver).mock.calls[1]?.[1]).toContain('/drops/a.log')
    t.event('rejected', 'team_waiting_busy')
    await host.tick()
    expect(attachedFiles).toHaveBeenCalledTimes(2)
  })
  it('delivers a message of files alone', async () => {
    const t = setup({ text: '', attachments: [{ id: 'a1', name: 'a.log', mime: 'text/plain', size: 1, url: 'https://cdn.example.test/a.log' }] })
    const host = new SuperTabHost(t.core, 'machine-1', { log: vi.fn(), attachedFiles: async () => ({ text: 'Attached files:\n- /drops/a.log (a.log, 1 B)', complete: true }) }); hosts.push(host)
    await host.tick()
    expect(vi.mocked(t.core.turns.deliver).mock.calls[0]?.[1]).toMatch(/from Collaborator:\nAttached files:\n/)
  })
})

describe('Super Tab waits for the Harness Pro', () => {
  it('hands the core the roster\'s waits on the first roster and on each change, and takes them back on stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-tab-host-')); roots.push(dir)
    const waiting = { tabId: 'tab', tabName: 'Pilot', attention: { assignmentId: 'as-1', status: 'blocked', result: 'No key' },
      agent: { id: 'agent', harnessId: 'harness', machineId: 'machine-1' } }
    let rows: unknown[] = [waiting], offline = false
    const call: CoreApi['account']['backend'] = vi.fn(async (_method, path) => {
      if (offline) throw new Error('Host offline')
      return { status: 200, body: { success: true, data: path.includes('/hosts/') ? rows : [] } }
    })
    const superTabs = { attention: vi.fn() }
    const core = fakeCore({ dataDir: dir, superTabs, account: { backend: call },
      agents: { creationStatus: vi.fn(async creationId => ({ creationId, state: 'created' as const, agentId: 'harness' })), byAgent: vi.fn(() => ({ agentId: 'harness' }) as never), terminalAvailable: vi.fn(() => true) } })
    const open = () => { const host = new SuperTabHost(core, 'machine-1', { log: vi.fn() }); hosts.push(host); return host }
    const first = open()
    await first.tick()
    expect(superTabs.attention).toHaveBeenCalledTimes(1)
    expect(superTabs.attention).toHaveBeenLastCalledWith([{ agentId: 'harness', requestId: 'supertab:as-1:blocked', superTab: 'Pilot', attention: 'stuck', text: 'Stuck: No key' }])
    await first.tick()
    // A failed roster read closes nothing.
    offline = true
    await first.tick()
    expect(superTabs.attention).toHaveBeenCalledTimes(1)
    offline = false
    rows = [{ ...waiting, attention: null }]
    await first.tick()
    expect(superTabs.attention).toHaveBeenLastCalledWith([])
    first.stop()
    expect(superTabs.attention).toHaveBeenCalledTimes(2)
    // A new host always hands over its first roster, so it closes what an earlier one raised; stopping takes its own back.
    const next = open()
    await next.tick()
    expect(superTabs.attention).toHaveBeenCalledTimes(3)
    rows = [waiting]
    await next.tick()
    expect(superTabs.attention).toHaveBeenCalledTimes(4)
    superTabs.attention.mockImplementationOnce(() => { throw new Error('Core gone') })
    next.stop()
    expect(superTabs.attention).toHaveBeenLastCalledWith([])
  })

  it('keeps a wait through a moment its harness is missing from the live agents, and closes it after 3 s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-tab-host-')); roots.push(dir)
    const rows = [{ tabId: 'tab', tabName: 'Pilot', attention: { assignmentId: 'as-1', status: 'needs_human', result: 'Ship it?' },
      agent: { id: 'agent', harnessId: 'harness', machineId: 'machine-1' } }]
    const call: CoreApi['account']['backend'] = vi.fn(async (_method, path) => ({ status: 200, body: { success: true, data: path.includes('/hosts/') ? rows : [] } }))
    let here = true, clock = 0
    const superTabs = { attention: vi.fn() }
    const core = fakeCore({ dataDir: dir, superTabs, account: { backend: call },
      agents: { byAgent: vi.fn(() => (here ? { agentId: 'harness' } : undefined) as never), terminalAvailable: vi.fn(() => true) } })
    const host = new SuperTabHost(core, 'machine-1', { log: vi.fn(), now: () => clock }); hosts.push(host)
    await host.tick()
    expect(superTabs.attention).toHaveBeenCalledTimes(1)
    here = false
    await host.tick()
    clock += 2_000
    await host.tick()
    here = true
    await host.tick()
    expect(superTabs.attention).toHaveBeenCalledTimes(1)   // back within 3 s: the same wait, never closed
    here = false
    await host.tick()
    clock += 3_000
    await host.tick()
    expect(superTabs.attention).toHaveBeenCalledTimes(2)
    expect(superTabs.attention).toHaveBeenLastCalledWith([])
    // Never raised while missing: a harness the core does not have is not waited on.
    clock += 10_000
    await host.tick()
    expect(superTabs.attention).toHaveBeenCalledTimes(2)
  })
})

it('stops a requested worker once, confirms removal, and releases retention on the next roster', async () => {
  const t = setup(), host = t.open()
  vi.mocked(t.core.agents.byAgent).mockReturnValue({ agentId: 'harness', sessionId: 'native', registeredAt: 0, startedBy: 'agent' } as never)
  let closed = false, removed = false, acknowledgements = 0
  const target = { id: 'agent', harnessId: 'harness', machineId: 'machine-1', workDecision: 'stop', startedSession: { creationId: 'super-original-creation', sessionId: 'native', createdAt: new Date(0).toISOString() } }
  t.core.agents.stopped = async () => closed
  t.core.agents.closeSwarm = async request => { expect(request.agentId).toBe('harness'); expect(request.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000); closed = true; return { closed: true } }
  t.core.account.backend = async (method, path, body) => {
    if ((body as any)?.command?.type === 'agent.stopLease') return { status: 200, body: { data: { result: { expiresAt: Date.now() + 3_600_000, durationMs: 120_000 } } } }
    if (path.includes('/hosts/')) return { status: 200, body: { data: removed ? [] : [{ tabId: 'tab', agent: target, stopRequested: true }] } }
    if (method === 'GET') return { status: 200, body: { data: { state: { agents: [target], conversations: [] } } } }
    acknowledgements++; removed = true
    return { status: 200, body: { data: {} } }
  }
  await host.tick()
  await vi.waitFor(() => expect(acknowledgements).toBe(1))
  expect(closed).toBe(true)
  expect(t.core.turns.deliver).not.toHaveBeenCalled()
  await host.tick()
  expect(retainedHarnesses(t.dir).size).toBe(0)
  expect(acknowledgements).toBe(1)
})

it.each(['active', 'foreign', 'changed', 'missing', 'refused', 'unconfirmed', 'unsupported'])('withholds closure or acknowledgement when stop safety is %s', async kind => {
  const t = setup(), host = t.open()
  vi.mocked(t.core.agents.byAgent).mockReturnValue({ agentId: 'harness', sessionId: 'native', registeredAt: 0, startedBy: 'agent' } as never)
  const target = { id: 'agent', harnessId: 'harness', machineId: 'machine-1', workDecision: 'stop', releaseId: 'release-1', startedSession: { creationId: 'super-original-creation', sessionId: 'native', createdAt: new Date(0).toISOString() } }
  const close = vi.fn(async () => kind === 'refused' ? { error: 'NOT_SWARM_STARTED' } : kind === 'unconfirmed' ? { deferred: true as const } : { closed: true as const })
  const acknowledge = vi.fn()
  t.core.agents.closeSwarm = kind === 'unsupported' ? undefined : close
  t.core.agents.stopped = async () => false
  t.core.account.backend = async (method, path, body) => {
    if ((body as any)?.command?.type === 'agent.stopLease') return { status: 200, body: { data: { result: { expiresAt: Date.now() + 3_600_000, durationMs: 120_000 } } } }
    if (path.includes('/hosts/')) return { status: 200, body: { data: [{ tabId: 'tab', agent: target, stopRequested: true }] } }
    if (method === 'GET') return { status: 200, body: { data: { state: {
      agents: kind === 'missing' ? [] : [{ ...target, machineId: kind === 'foreign' ? 'foreign' : target.machineId, releaseId: kind === 'changed' ? 'release-2' : 'release-1' }],
      conversations: [{ assignment: { agentId: 'agent', status: kind === 'active' ? 'working' : 'done' } }],
    } } } }
    acknowledge(); return { status: 200, body: { data: {} } }
  }
  await host.tick()
  // Finish the asynchronous lifecycle pickup without relying on the delivery poll to wait on it.
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(acknowledge).not.toHaveBeenCalled()
  if (['active', 'foreign', 'changed', 'missing', 'unsupported'].includes(kind)) expect(close).not.toHaveBeenCalled()
  else expect(close).toHaveBeenCalledOnce()
  expect(t.core.turns.deliver).not.toHaveBeenCalled()
})

it('retries a lost removal acknowledgement from native stopped evidence without closing twice', async () => {
  const t = setup(), host = t.open()
  vi.mocked(t.core.agents.byAgent).mockReturnValue({ agentId: 'harness', sessionId: 'native', registeredAt: 0, startedBy: 'agent' } as never)
  const target = { id: 'agent', harnessId: 'harness', machineId: 'machine-1', workDecision: 'stop', startedSession: { creationId: 'super-original-creation', sessionId: 'native', createdAt: new Date(0).toISOString() } }
  let stopped = false, attempts = 0
  const close = vi.fn()
  t.core.agents.closeSwarm = async () => { if (!stopped) { close(); stopped = true }; return { closed: true } }
  t.core.agents.stopped = async () => stopped
  t.core.account.backend = async (method, path, body) => {
    if ((body as any)?.command?.type === 'agent.stopLease') return { status: 200, body: { data: { result: { expiresAt: Date.now() + 3_600_000, durationMs: 120_000 } } } }
    if (path.includes('/hosts/')) return { status: 200, body: { data: [{ tabId: 'tab', agent: target, stopRequested: true }] } }
    if (method === 'GET') return { status: 200, body: { data: { state: { agents: [target], conversations: [] } } } }
    attempts++
    if (attempts === 1) throw new Error('Lost acknowledgement')
    return { status: 200, body: { data: {} } }
  }
  await host.tick(); await vi.waitFor(() => expect(attempts).toBe(1))
  t.wait(5_000); await host.tick(); await vi.waitFor(() => expect(attempts).toBe(2))
  expect(close).toHaveBeenCalledOnce()
})


function releaseFixture(nativeKind = 'swarm', result: Record<string, unknown> = { error: 'NOT_SWARM_STARTED' }) {
  const t = setup(), host = t.open()
  const identity = { creationId: 'super-original-creation', sessionId: 'native', createdAt: new Date(0).toISOString() }
  const target = { id: 'agent', harnessId: 'harness', machineId: 'machine-1', workDecision: 'stop', releaseId: 'release-1',
    ...(nativeKind === 'missing-record' ? {} : { startedSession: identity }) }
  const native = { agentId: 'harness', sessionId: nativeKind === 'changed' ? 'replacement' : 'native', registeredAt: 0,
    startedBy: nativeKind === 'personal' ? undefined : 'agent', processIdentity: { pid: 1, startMarker: 'first', executable: 'codex' } }
  const lookup = vi.fn(async () => ({ creationId: identity.creationId, state: 'created' as const, agentId: 'harness' }))
  const close = vi.fn(async () => result), lease = vi.fn(), remove = vi.fn()
  t.core.agents.byAgent = vi.fn(() => native as never)
  t.core.agents.creationStatus = lookup
  t.core.agents.closeSwarm = close as NonNullable<CoreApi['agents']['closeSwarm']>
  t.core.account.backend = async (method, path, body) => {
    const command = (body as any)?.command
    if (command?.type === 'agent.stopLease') { lease(); return { status: 200, body: { data: { result: { durationMs: 120_000 } } } } }
    if (command?.type === 'agent.remove') { remove(); return { status: 200, body: { data: {} } } }
    if (path.includes('/hosts/')) return { status: 200, body: { data: [{ tabId: 'tab', agent: target, stopRequested: true }] } }
    return { status: 200, body: { data: { state: { agents: [target], conversations: [] } } } }
  }
  const poll = async (advance = 0) => { t.wait(advance); await host.tick(); await new Promise(resolve => setImmediate(resolve)) }
  return { ...t, host, target, native, lookup, close, lease, remove, poll }
}

it.each(['personal', 'missing-record', 'changed'])('requests no close lease for an ineligible %s runtime', async kind => {
  const t = releaseFixture(kind)
  for (let i = 0; i < 10; i++) await t.poll(1_000)
  expect(t.lease).not.toHaveBeenCalled()
  expect(t.close).not.toHaveBeenCalled()
})

it('never acquires a lease for a creation receipt naming a different native harness', async () => {
  const t = releaseFixture()
  t.lookup.mockResolvedValue({ creationId: 'super-original-creation', state: 'created', agentId: 'another-harness' })
  for (let i = 0; i < 10; i++) await t.poll(130_000)
  expect(t.lease).not.toHaveBeenCalled()
})

it.each(['NOT_SWARM_STARTED', 'AGENT_CHANGED'])('does not keep leasing a runtime refused as %s; still clears it once gone', async error => {
  const t = releaseFixture('swarm', { error })
  for (let i = 0; i < 10; i++) await t.poll(130_000)
  expect(t.lease).toHaveBeenCalledTimes(1)
  expect(t.close).toHaveBeenCalledTimes(1)
  vi.mocked(t.core.agents.byAgent).mockReturnValue(undefined)
  t.close.mockResolvedValue({ closed: true })
  await t.poll()
  expect(t.remove).toHaveBeenCalledOnce()
  expect(t.lease).toHaveBeenCalledTimes(1)
})

it('backs off transient close failures and caps retries for the same runtime', async () => {
  const t = releaseFixture('swarm', { error: 'SERVICE_UNAVAILABLE' })
  await t.poll()
  for (let i = 0; i < 4; i++) await t.poll(1_000)
  expect(t.lease).toHaveBeenCalledTimes(1)
  await t.poll(1_000)
  expect(t.lease).toHaveBeenCalledTimes(2)
  await t.poll(14_000)
  expect(t.lease).toHaveBeenCalledTimes(2)
  await t.poll(1_000)
  expect(t.lease).toHaveBeenCalledTimes(3)
  for (let i = 0; i < 10; i++) await t.poll(130_000)
  expect(t.lease).toHaveBeenCalledTimes(5)
  t.native.processIdentity.startMarker = 'new-runtime'
  await t.poll()
  expect(t.lease).toHaveBeenCalledTimes(6)
})


it('backs off unavailable launch-receipt reads without writing any close leases', async () => {
  const t = releaseFixture()
  t.lookup.mockRejectedValue(new Error('Core temporarily unavailable'))
  for (let i = 0; i < 10; i++) await t.poll(130_000)
  expect(t.lookup).toHaveBeenCalledTimes(5)
  expect(t.lease).not.toHaveBeenCalled()
})

it('rechecks authoritative native absence before retrying a lost acknowledgement', async () => {
  const t = releaseFixture('swarm', { closed: true })
  t.remove.mockImplementationOnce(() => { throw new Error('Lost acknowledgement') })
  await t.poll()
  t.close.mockResolvedValue({ error: 'NOT_SWARM_STARTED' })
  await t.poll(5_000)
  await t.poll(130_000)
  expect(t.lease).toHaveBeenCalledOnce()
  expect(t.remove).toHaveBeenCalledOnce()
  expect(t.close).toHaveBeenLastCalledWith({ agentId: 'harness' })
})
