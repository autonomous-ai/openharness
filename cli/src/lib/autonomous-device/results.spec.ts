import { z } from 'zod'
import { DeviceResultSchema } from './resultContract.js'
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutonomousDeviceService, type AutonomousDeviceServiceOptions } from './service.js'
import { DeviceResultJournal } from './resultJournal.js'
import { RESULT_CAPABILITY } from './resultEvidence.js'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../docs/contracts/turn-correlation-v2/${name}.json`, import.meta.url), 'utf8'))
const claude = fixture('claude-native-queue'), codex = fixture('codex-steering')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup(engine = 'claude', overrides: Partial<AutonomousDeviceServiceOptions> = {}) {
  const events: any[] = [], submit = vi.fn()
  const service = new AutonomousDeviceService({ machineId: 'machine', serverInstanceId: 'instance',
    now: () => Date.parse('2026-09-24T00:00:00Z'), trackResultEvidence: true, resultsEnabled: true,
    agents: () => [{ agentId: 'agent', engine, name: 'Agent', state: 'working' }], submit,
    cancelDelivery: () => true, stop: async () => true, answer: async () => true, recent: () => [],
    emit: event => events.push(event), ...overrides })
  const send = async (key: string, text: string, owner = 'owner') => {
    const response = await service.request(owner, { type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', idempotencyKey: key, text })
    const receipt = service.receipt(owner, key)!
    if (response.status === 'accepted') {
      service.inputDispatched('agent', receipt.deliveryId, text)
      service.delivery({ deliveryId: receipt.deliveryId, sessionId: 'agent', state: 'delivered' })
    }
    return receipt
  }
  const ingest = (row: unknown) => service.observeTranscript('agent', 'session', engine, JSON.stringify(row))
  const results = () => events.filter(e => e.kind === 'turn.result')
  return { service, send, ingest, results, events, submit }
}

describe('Device result membership from captured engine evidence', () => {
  it.each(['claude', 'codex'])('%s produces one immutable result for consumed A/B, never queued C', async engine => {
    const capture = engine === 'claude' ? claude : codex
    const f = setup(engine)
    const a = await f.send('A', capture.inputs[0]), b = await f.send('B', capture.inputs[1])
    await f.send('C', 'Still queued, not consumed')
    for (const row of capture.records) f.ingest(row)
    expect(f.results()).toHaveLength(1)
    expect(f.results()[0].payload).toMatchObject({ serverInstanceId: 'instance', outcome: 'completed', correlation: {
      scope: 'group', inputs: [{ deliveryId: a.deliveryId, idempotencyKey: 'A' }, { deliveryId: b.deliveryId, idempotencyKey: 'B' }],
    } })
    expect(f.service.receipt('owner', 'A')?.state).toBe('completed')
    expect(f.service.receipt('owner', 'B')?.state).toBe('completed')
    expect(f.service.receipt('owner', 'C')?.state).toBe('delivered')
    DeviceResultSchema.parse(f.results()[0])
    const original = structuredClone(f.results()[0])
    for (const row of capture.records) f.ingest(row)
    f.service.turnEnded('agent')
    f.service.commander({ type: 'commander_event', agentId: 'agent', payload: { kind: 'summary', text: 'unrelated latest recap' } })
    expect(f.results()).toEqual([original])
    const replay: any[] = []
    f.service.replay({ serverInstanceId: 'instance', cursor: 0 }, e => replay.push(e))
    expect(replay.find(e => e.kind === 'turn.result')).toEqual(original)
    await f.send('B', capture.inputs[1]) // lost RPC acknowledgment
    expect(f.submit).toHaveBeenCalledTimes(3)
  })

  it('Claude enqueue/remove alone cannot complete B; A can finish separately', async () => {
    const f = setup()
    await f.send('A', claude.inputs[0]); await f.send('B', claude.inputs[1])
    f.ingest(claude.records[0])
    for (const row of claude.records.filter((r: any) => r.type === 'queue-operation')) f.ingest(row)
    f.ingest({ type: 'assistant', uuid: 'final-A', parentUuid: claude.records[0].uuid,
      message: { id: 'message-A', stop_reason: 'end_turn', content: [{ type: 'text', text: 'A done' }] } })
    expect(f.results()[0].payload.correlation.scope).toBe('input')
    expect(f.results()[0].payload.correlation.inputs.map((i: any) => i.idempotencyKey)).toEqual(['A'])
    expect(f.service.receipt('owner', 'B')?.state).toBe('delivered')
    f.ingest({ ...claude.records[0], uuid: 'root-B', message: { content: claude.inputs[1] } })
    f.ingest({ type: 'assistant', uuid: 'final-B', parentUuid: 'root-B', message: { id: 'message-B', stop_reason: 'end_turn', content: [{ type: 'text', text: 'B done' }] } })
    expect(f.results().map(e => e.payload.correlation.inputs.map((i: any) => i.idempotencyKey))).toEqual([['A'], ['B']])
  })

  it('does not use a queued attachment from a sibling transcript branch', async () => {
    const f = setup(); await f.send('A', claude.inputs[0]); await f.send('B', claude.inputs[1])
    f.ingest(claude.records[0])
    const queued = claude.records.find((r: any) => r.attachment?.type === 'queued_command')
    f.ingest({ ...queued, parentUuid: claude.records[0].uuid })
    f.ingest({ type: 'assistant', uuid: 'other-branch-final', parentUuid: claude.records[0].uuid,
      message: { id: 'final', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Only A' }] } })
    f.service.turnEnded('agent')
    expect(f.results()[0].payload.correlation.inputs.map((i: any) => i.idempotencyKey)).toEqual(['A'])
    expect(f.service.receipt('owner', 'B')?.state).toBe('unknown')
  })

  it.each(['missing-parent', 'different-owner', 'identical-prompts'])('fails closed for %s', async variant => {
    const f = setup()
    await f.send('A', claude.inputs[0]); await f.send('B', claude.inputs[1], variant === 'different-owner' ? 'other' : 'owner')
    if (variant === 'identical-prompts') await f.send('duplicate-text', claude.inputs[1])
    for (const row of claude.records) f.ingest(variant === 'missing-parent' && row.message?.stop_reason === 'end_turn' ? { ...row, parentUuid: 'missing' } : row)
    f.service.turnEnded('agent')
    expect(f.results()).toHaveLength(0)
    expect(f.service.receipt('owner', 'A')?.state).toBe('unknown')
    expect(f.service.receipt(variant === 'different-owner' ? 'other' : 'owner', 'B')?.state).not.toBe('completed')
  })

  it('Codex requires explicit per-input turn identity, not the currently busy turn', async () => {
    const f = setup('codex'); await f.send('A', codex.inputs[0]); await f.send('B', codex.inputs[1])
    for (const row of codex.records) {
      const copy = structuredClone(row)
      if (copy.type === 'response_item') delete copy.payload.internal_chat_message_metadata_passthrough
      f.ingest(copy)
    }
    f.service.turnEnded('agent')
    expect(f.results()).toHaveLength(0)
    expect(f.service.receipt('owner', 'B')?.state).toBe('delivered')
  })

  it('session gone and bare turn.done never fabricate completion', async () => {
    const f = setup(); const a = await f.send('A', 'A')
    f.service.delivery({ deliveryId: a.deliveryId, sessionId: 'agent', state: 'started' })
    f.service.turnEnded('agent')
    expect(f.service.receipt('owner', 'A')).toMatchObject({ state: 'unknown', error: { code: 'RESULT_EVIDENCE_MISSING' } })
    f.service.agentGone('agent'); expect(f.results()).toHaveLength(0)
  })
})

describe('result persistence, opt-in and authorization', () => {
  it('persists before dispatch, restores receipts without resending, replays stable results after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'device-results-')); dirs.push(dir)
    const journal = new DeviceResultJournal(join(dir, 'journal.json'))
    const f = setup('claude', { resultJournal: journal })
    await f.send('A', claude.inputs[0]); await f.send('B', claude.inputs[1]); await f.send('C', 'unresolved')
    for (const row of claude.records) f.ingest(row)
    const payload = structuredClone(f.results()[0].payload)
    expect(statSync(join(dir, 'journal.json')).mode & 0o777).toBe(0o600)
    const restarted = setup('claude', { resultJournal: journal, serverInstanceId: 'new-instance' })
    expect(restarted.service.receipt('owner', 'C')).toMatchObject({ state: 'unknown', error: { code: 'DAEMON_RESTART' } })
    await restarted.send('C', 'unresolved')
    expect(restarted.submit).not.toHaveBeenCalled()
    const replay: any[] = []
    restarted.service.replay({ serverInstanceId: 'instance', cursor: 0 }, e => replay.push(e))
    expect(replay[0]).toMatchObject({ type: 'resync', reason: 'instance_changed' })
    expect(replay.find(e => e.kind === 'turn.result')).toMatchObject({ serverInstanceId: 'new-instance', payload })
    const event = replay.find(e => e.kind === 'turn.result')
    expect(restarted.service.canSendResult('owner', event, [RESULT_CAPABILITY])).toBe(true)
    expect(restarted.service.canSendResult('other', event, [RESULT_CAPABILITY])).toBe(false)
    expect(restarted.service.canSendResult('owner', event, [])).toBe(false)
    restarted.service.revoke('owner')
    expect(restarted.service.canSendResult('owner', event, [RESULT_CAPABILITY])).toBe(false)
    expect(setup('claude', { resultJournal: journal }).service.receipt('owner', 'A')).toBeNull()
  })

  it('does not dispatch if durable reservation fails', async () => {
    const f = setup('claude', { resultJournal: { load: () => undefined, save: () => { throw new Error('disk full') } } })
    const response = await f.service.request('owner', { type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', idempotencyKey: 'A', text: 'A' })
    expect(response.receipt).toMatchObject({ state: 'unknown' })
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('is off by default and never advertises the capability as an RPC', async () => {
    const f = setup('claude', { resultsEnabled: false })
    expect(f.service.capabilities).not.toContain(RESULT_CAPABILITY)
    await f.send('A', claude.inputs[0]); await f.send('B', claude.inputs[1])
    for (const row of claude.records) f.ingest(row)
    expect(f.results()).toHaveLength(0)
    expect(await f.service.request('owner', { type: RESULT_CAPABILITY, requestId: randomUUID() })).toMatchObject({ error: { code: 'UNSUPPORTED_CAPABILITY' } })
  })

  it('expires result access after the documented retention period', async () => {
    let now = Date.parse('2026-09-24T00:00:00Z')
    const f = setup('claude', { now: () => now }); await f.send('A', claude.inputs[0]); await f.send('B', claude.inputs[1])
    for (const row of claude.records) f.ingest(row)
    const event = f.results()[0]
    now += 30 * 60_000 + 1
    expect(f.service.canSendResult('owner', event, [RESULT_CAPABILITY])).toBe(false)
    expect(f.service.receipt('owner', 'A')).toBeNull()
  })
})


it('publishes the exact runtime result schema and valid shared OS fixtures', () => {
  expect(fixture('result.schema')).toEqual(z.toJSONSchema(DeviceResultSchema))
  DeviceResultSchema.parse(fixture('group-result'))
  DeviceResultSchema.parse(fixture('input-result'))
  for (const step of fixture('os-replay-cases').steps) if (step.event.kind === 'turn.result') DeviceResultSchema.parse(step.event)
  const invalid = fixture('group-result')
  invalid.payload.correlation.scope = 'input'
  expect(DeviceResultSchema.safeParse(invalid).success).toBe(false)
})

it('does not complete a result when journal commit fails and does not trust unwritten/history input', async () => {
  let failWrites = false
  const f = setup('claude', { resultJournal: { load: () => undefined, save: () => { if (failWrites) throw new Error('disk full') } } })
  await f.send('A', claude.inputs[0]); await f.send('B', claude.inputs[1])
  for (const row of claude.records.slice(0, -1)) f.ingest(row)
  failWrites = true
  expect(() => f.ingest(claude.records.at(-1))).toThrow('disk full')
  expect(f.results()).toHaveLength(0)
  expect(f.service.receipt('owner', 'A')?.state).not.toBe('completed')
  expect(f.service.receipt('owner', 'B')?.state).not.toBe('completed')
  const unwritten = setup()
  await unwritten.service.request('owner', { type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', idempotencyKey: 'A', text: claude.inputs[0] })
  for (const row of claude.records) unwritten.ingest(row)
  expect(unwritten.results()).toHaveLength(0)
  expect(unwritten.service.receipt('owner', 'A')?.state).toBe('queued')
})

it('keeps different Codex turn IDs separate and rejects mismatched completion IDs', async () => {
  const f = setup('codex'); await f.send('A', codex.inputs[0]); await f.send('B', codex.inputs[1])
  const users = codex.records.filter((r: any) => r.type === 'response_item' && r.payload.internal_chat_message_metadata_passthrough.content_item_kinds.includes('user.text'))
  f.ingest(users[0])
  f.ingest({ ...users[1], payload: { ...users[1].payload, internal_chat_message_metadata_passthrough: { ...users[1].payload.internal_chat_message_metadata_passthrough, turn_id: 'turn-B' } } })
  const completion = codex.records.at(-1)
  f.ingest({ ...completion, ordinal: 900, payload: { ...completion.payload, turn_id: 'wrong-turn' } })
  expect(f.results()).toHaveLength(0)
  f.ingest(completion)
  expect(f.results()[0].payload.correlation.inputs.map((i: any) => i.idempotencyKey)).toEqual(['A'])
  f.ingest({ ...completion, ordinal: 901, payload: { ...completion.payload, turn_id: 'turn-B' } })
  expect(f.results()[1].payload.correlation.inputs.map((i: any) => i.idempotencyKey)).toEqual(['B'])
})

it('rejects oversize results without truncating or announcing completion', async () => {
  const f = setup(); await f.send('A', claude.inputs[0])
  f.ingest(claude.records[0])
  f.ingest({ type: 'assistant', uuid: 'large-final', parentUuid: claude.records[0].uuid,
    message: { id: 'large-message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x'.repeat(33 * 1024) }] } })
  expect(f.results()).toHaveLength(0)
  expect(f.service.receipt('owner', 'A')?.state).toBe('unknown')
})

it('retains the committed result when transport emission loses its acknowledgment', async () => {
  const f = setup('claude', { emit: event => { if (event.kind === 'turn.result') throw new Error('socket closed') } })
  await f.send('A', claude.inputs[0]); await f.send('B', claude.inputs[1])
  for (const row of claude.records.slice(0, -1)) f.ingest(row)
  const before = f.service.resume().cursor
  expect(() => f.ingest(claude.records.at(-1))).toThrow('socket closed')
  const replay: any[] = []
  f.service.replay({ serverInstanceId: 'instance', cursor: before }, e => replay.push(e))
  expect(replay.filter(e => e.kind === 'turn.result')).toHaveLength(1)
  expect(f.service.receipt('owner', 'B')?.state).toBe('completed')
})

it('cannot match a dispatched input against a different engine session after rebind', async () => {
  const f = setup()
  await f.service.request('owner', { type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', idempotencyKey: 'A', text: claude.inputs[0] })
  f.service.inputDispatched('agent', f.service.receipt('owner', 'A')!.deliveryId, claude.inputs[0], 'old-session')
  for (const row of claude.records) f.ingest(row) // fixture ingests into session, not old-session
  expect(f.results()).toHaveLength(0)
  expect(f.service.receipt('owner', 'A')?.state).not.toBe('completed')
})
