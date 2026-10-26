import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { b64e, newEphemeral, newIdentity } from '../lib/e2ee/core.js'
import { recipientHandshake } from '../sharing/crypto.js'
import { HarnessGrantStore } from '../sharing/grants.js'
import { HarnessShareOwner } from '../sharing/owner.js'
import { OBSERVER_VALID_MS, observerSnapshotFile, observerSource, publishObservers } from './observers.js'

it('expires session authority and closes an existing encrypted terminal observer after removal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-observer-')), key = newIdentity()
  const grants = new HarnessGrantStore(join(dir, 'grants.json'))
  let now = Date.now()
  const source = observerSource(dir, () => 'machine', () => now)
  const rows = [{ tabId: 'tab', agent: { machineId: 'machine', harnessId: 'native', name: 'Builder', configuration: { engine: 'codex' } },
    observers: [{ email: 'peer@example.com' }] }]
  publishObservers(dir, 'machine', rows, now + 2500)
  const sent: Array<{ id: string; type: string; payload: Record<string, unknown> }> = []
  const close = vi.fn(), frame = vi.fn(async () => true), publish = vi.fn(async () => ({ status: 200, body: {} }))
  const owner = new HarnessShareOwner({ machineId: () => 'machine', identity: key, grants, now: () => now,
    derivedGrants: source.current, allowsGrant: source.allows,
    resolveAgent: id => id === 'native' ? { agentId: 'native', active: true } as never : undefined,
    streams: () => ({ handleFrame: frame, closeConnection: close, stop: async () => {} }),
    send: (id, type, payload) => { sent.push({ id, type, payload }); return true }, publish })
  try {
    await owner.manage('harness_share_rosters', {}); await owner.sync()
    const grant = grants.all()[0]!
    expect(grant.tab).toBe('super:tab')
    expect(publish).toHaveBeenCalledWith('PUT', expect.any(String), expect.objectContaining({ superTabId: 'tab', agentId: 'native' }))
    const ephemeral = newEphemeral()
    await owner.receive('observer:peer', 'observer_open', { shareId: grant.id, email: 'peer@example.com', ephemeral: b64e(ephemeral.pub) })
    const welcome = sent.find(f => f.type === 'observer_welcome')!
    const cipher = recipientHandshake(ephemeral, 'machine', grant.id, b64e(key.pub), welcome.payload as never)
    await owner.receive('observer:peer', 'observer_frame', cipher.seal({ type: 'terminal_open', payload: { agentId: 'native' } }) as never)
    expect(frame).toHaveBeenCalledOnce()
    publishObservers(dir, 'machine', [], now + 2500); now += 201
    await owner.receive('observer:peer', 'observer_frame', cipher.seal({ type: 'terminal_alive', payload: {} }) as never)
    expect(close).toHaveBeenCalledWith('observer:peer')
    expect(frame).toHaveBeenCalledOnce()
    publishObservers(dir, 'machine', rows, now + 2500); now += 201
    expect(source.allows(grant)).toBe(true)
    now += 2501
    expect(source.allows(grant)).toBe(false)
    await owner.receive('observer:stale', 'observer_open', { shareId: grant.id, email: 'peer@example.com', ephemeral: b64e(newEphemeral().pub) })
    expect(sent.at(-1)).toMatchObject({ type: 'observer_closed' })
    writeFileSync(observerSnapshotFile(dir, 'machine'), '{'); now += 201
    expect(source.current()).toEqual([])
  } finally { await owner.stop(); rmSync(dir, { recursive: true, force: true }) }
})

it('tells a lapsed roster apart from one in force that names nobody, and accepts no roster valid for longer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-observer-'))
  let now = 1_000_000
  const source = observerSource(dir, () => 'machine', () => now)
  const rows = [{ tabId: 'tab', agent: { machineId: 'machine', harnessId: 'native', name: 'Builder', configuration: {} },
    observers: [{ email: 'Peer@Example.com' }] }]
  try {
    expect(source.known()).toBeNull()
    publishObservers(dir, 'machine', rows, now + OBSERVER_VALID_MS); now += 201
    expect(source.known()).toEqual([{ tab: 'super:tab', agentId: 'native', email: 'peer@example.com', name: 'Builder', engine: null }])
    // Read again after the cache's 200 ms, a moment before it lapses: still in force.
    now += OBSERVER_VALID_MS - 202
    expect(source.known()).toHaveLength(1)
    now += 1
    expect(source.known()).toBeNull()
    expect(source.current()).toEqual([])
    publishObservers(dir, 'machine', [], now + OBSERVER_VALID_MS); now += 201
    expect(source.known()).toEqual([])
    publishObservers(dir, 'machine', rows, now + OBSERVER_VALID_MS + 1000); now += 201
    expect(source.known()).toBeNull()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('refuses every share of a session a roster marks confidential, an ordinary one too, until the session closes on this machine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-observer-'))
  let now = 1_000_000
  const source = observerSource(dir, () => 'machine', () => now)
  const row = (harnessId: string, confidential: boolean, tabId = 'tab') => ({ tabId, agent: { machineId: 'machine', harnessId, name: harnessId, configuration: {} },
    observers: [], confidential })
  // Shared the ordinary way, outside any Swarm: a PM that reads private chats, and a Builder.
  const pm = { tab: null, agentId: 'pm', recipientEmail: 'bob@example.com' } as never
  const builder = { tab: null, agentId: 'builder', recipientEmail: 'bob@example.com' } as never
  const running = new Set(['pm', 'builder'])
  const live = (harnessId: string) => running.has(harnessId)
  try {
    expect(source.allows(pm)).toBe(true)
    publishObservers(dir, 'machine', [row('pm', true), row('builder', false)], now + OBSERVER_VALID_MS, live); now += 201
    expect(source.allows(pm)).toBe(false)
    expect(source.allows(builder)).toBe(true)
    // Its registration is removed while the session still runs, and another Swarm's row calls it ordinary: still closed.
    publishObservers(dir, 'machine', [], now + OBSERVER_VALID_MS, live); now += OBSERVER_VALID_MS + 1
    expect(source.allows(pm)).toBe(false)
    publishObservers(dir, 'machine', [row('pm', false, 'other')], now + OBSERVER_VALID_MS, live); now += 201
    expect(source.allows(pm)).toBe(false)
    // The session closes on this machine: only then is the mark gone.
    running.delete('pm')
    publishObservers(dir, 'machine', [], now + OBSERVER_VALID_MS, live); now += 201
    expect(source.allows(pm)).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
