import { expect, it, vi } from 'vitest'
import { deskRequest, deskStroke } from './deskProtocol.js'

const step = { machineId: 'machine', requestId: 'request', direction: 'next', expiresAt: 5000 }
it('detaches exact bounded probes, steps and strokes without extra authority', () => {
  expect(deskRequest('harness_device_step', { machineId: 'machine', requestId: 'r', probe: true })).toEqual({ kind: 'probe', machineId: 'machine' })
  expect(deskRequest('harness_device_step', step)).toEqual({ kind: 'step', machineId: 'machine', direction: 'next', expiresAt: 5000 })
  expect(deskRequest('harness_device_step', { ...step, direction: 'previous', currentAgentId: 'a' })).toMatchObject({ direction: 'previous', currentAgentId: 'a' })
  expect(deskRequest('harness_device_scroll', { machineId: 'machine', phase: 'move', dy: -4096, velocity: 100000 }))
    .toEqual({ kind: 'scroll', machineId: 'machine', phase: 'move', dy: -4096, velocity: 100000 })
  expect(deskStroke('down', 4096, -100000)).toBe(true)
  expect(deskStroke('up', 0, 0)).toBe(true)
})

it.each([null, false, [], 'text', { ...step, machineId: '' }, { ...step, machineId: 'x'.repeat(201) },
  { ...step, requestId: '' }, { ...step, requestId: 1 }, { ...step, requestId: 'x'.repeat(129) },
  { ...step, probe: true }, { machineId: 'machine', requestId: 'r', probe: true, extra: false },
  { ...step, extra: 'x' }, { ...step, direction: 'sideways' }, { ...step, currentAgentId: '' },
  { ...step, currentAgentId: 'a'.repeat(129) }, { ...step, expiresAt: 1.5 }, { ...step, expiresAt: Infinity },
  { ...step, extra: 'x'.repeat(4096) }, Object.assign(Object.create({ private: true }), step),
])('refuses malformed desk data %#', value => {
  expect(deskRequest('harness_device_step', value)).toBeNull()
})

it.each([{ phase: 'fling', dy: 0, velocity: 0 }, { phase: 'move', dy: 0.5, velocity: 0 },
  { phase: 'move', dy: 4097, velocity: 0 }, { phase: 'move', dy: 0, velocity: '1' },
  { phase: 'up', dy: 0, velocity: 100001 }, { phase: 'down', dy: 0, velocity: 0, requestId: 'unexpected' },
])('refuses malformed or oversized strokes %#', fields => {
  expect(deskRequest('harness_device_scroll', { machineId: 'machine', ...fields })).toBeNull()
})

it('refuses getters without evaluating them', () => {
  const get = vi.fn(() => 'machine')
  expect(deskRequest('harness_device_step', Object.defineProperty({ ...step }, 'machineId', { get, enumerable: true }))).toBeNull()
  expect(get).not.toHaveBeenCalled()
})
