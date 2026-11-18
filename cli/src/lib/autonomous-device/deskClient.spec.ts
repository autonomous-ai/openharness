import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import * as daemon from '../../agentClient/daemon.js'
import type { ClientSocket } from '../../agentClient/daemon.js'
import { stepDeviceDesk } from './deskClient.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
async function fixture(agentId?: string, standard = false) {
  const socket = new EventEmitter() as EventEmitter & ClientSocket, sent: any[] = []
  socket.send = text => { sent.push(JSON.parse(text)) }
  socket.close = vi.fn(() => socket.emit('close', 1000))
  let current = true
  const closed = new AbortController()
  if (standard) vi.spyOn(daemon, 'connectSocket').mockResolvedValue(socket)
  const result = stepDeviceDesk({ dataDir: '/data', port: 1, machineId: 'machine' }, 'next', agentId,
    () => current, closed.signal, standard ? undefined : () => socket)
  await Promise.resolve(); socket.emit('open')
  const frame = (type: string, payload: object) => socket.emit('message', Buffer.from(JSON.stringify({ type, payload })), false)
  frame('connected', { machineId: 'machine', transport: 'local', localProtocolVersion: 1 })
  return { socket, sent, closed, result, frame, revoke: () => { current = false }, reply: (payload: object) => frame('harness_device_step_result', { requestId: sent[1].payload.requestId, ...payload }) }
}

it.each([{ machineId: 'remote', agentId: 'next' }, { step: 'no_app' }, { step: 'no_agents' }])('preserves one bounded step result %j', async answer => {
  const f = await fixture('agent')
  expect(f.sent).toHaveLength(2)
  expect(f.sent[1]).toMatchObject({ type: 'harness_device_step', payload: { direction: 'next', machineId: 'machine', currentAgentId: 'agent', expiresAt: expect.any(Number) } })
  f.reply(answer)
  expect(await f.result).toEqual('step' in answer ? answer.step : answer)
  expect(f.socket.close).toHaveBeenCalledOnce()
})

it.each([{}, { error: 'UNSUPPORTED' }, { machineId: 1, agentId: 'a' }, { machineId: '', agentId: 'a' },
  { machineId: 'm'.repeat(201), agentId: 'a' }, { machineId: 'm', agentId: 1 },
  { machineId: 'm', agentId: '' }, { machineId: 'm', agentId: 'a'.repeat(129) }])('refuses malformed step reply %j', async answer => {
  const f = await fixture(undefined)
  expect(f.sent[1].payload).not.toHaveProperty('currentAgentId')
  f.reply(answer); expect(await f.result).toBe('no_agents')
})

it.each(['current', 'abort'] as const)('rechecks %s after actual reply settlement', async mode => {
  const f = await fixture()
  f.reply({ machineId: 'machine', agentId: 'next' })
  if (mode === 'current') f.revoke(); else f.closed.abort()
  expect(await f.result).toBe('no_agents')
})

it('uses five seconds including setup and refuses replies above 4 KiB without retry', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {})
  const timed = await fixture()
  await vi.advanceTimersByTimeAsync(5000)
  expect(await timed.result).toBe('no_agents'); expect(timed.sent).toHaveLength(2)
  expect(console.warn).toHaveBeenCalledWith('[wifi] DESK_TIMEOUT')
  const large = await fixture()
  large.reply({ machineId: 'machine', agentId: 'next', extra: 'x'.repeat(4096) })
  expect(await large.result).toBe('no_agents'); expect(large.sent).toHaveLength(2)
  expect(console.warn).toHaveBeenCalledWith('[wifi] DESK_PROTOCOL')
})

it('uses the ordinary owner socket connector by default', async () => {
  const f = await fixture(undefined, true); f.reply({ step: 'no_agents' })
  expect(await f.result).toBe('no_agents'); expect(daemon.connectSocket).toHaveBeenCalledOnce()
})
