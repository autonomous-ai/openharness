import { expect, it } from 'vitest'
import { compareAdmissionOrder, createAdmissionOrder } from './admissionOrder.js'

const stamp = (firedAt: number | undefined, arrival = 1, scope = 'process-1') => ({ firedAt, arrival, scope })

it('keeps verified native order across retries, scopes it to the exact process, and clears on shutdown', () => {
  const order = createAdmissionOrder()
  expect(order.status('agent', 'a', stamp(10))).toBe('current')
  order.accept('agent', 'b', stamp(20, 2))
  expect(order.status('agent', 'a', stamp(10, 3))).toBe('older')
  expect(order.status('agent', 'a', stamp(20, 4))).toBe('ambiguous')
  expect(order.status('agent', 'a', stamp(21, 5))).toBe('current')
  expect(order.status('agent', 'b', stamp(10, 6))).toBe('current')
  order.accept('agent', 'b', stamp(10, 6))
  expect(order.status('agent', 'a', stamp(15, 7))).toBe('older')
  order.accept('agent', 'c', stamp(30, 8))
  expect(order.status('agent', 'b', stamp(25, 9))).toBe('older')
  expect(order.status('agent', 'a', stamp(1, 10, 'process-2'))).toBe('current')
  order.accept('agent', 'a', stamp(1, 10, 'process-2'))
  expect(order.status('agent', 'b', stamp(2, 11, 'process-2'))).toBe('current')
  order.close()
  expect(order.status('agent', 'old', stamp(1))).toBe('current')
})

it('uses arrival for already observed legacy deliveries but cannot infer that a late conflicting hook is newer', () => {
  const order = createAdmissionOrder()
  order.accept('agent', 'b', stamp(undefined, 2))
  expect(order.status('agent', 'a', stamp(undefined, 1))).toBe('older')
  expect(order.status('agent', 'a', stamp(undefined, 2))).toBe('older')
  expect(order.status('agent', 'a', stamp(undefined, 3))).toBe('ambiguous')
  expect(order.status('agent', 'a', stamp(50, 3))).toBe('ambiguous')
  order.accept('agent', 'b', stamp(50, 4))
  expect(order.status('agent', 'a', stamp(undefined, 5))).toBe('ambiguous')
  order.accept('agent', 'b', stamp(undefined, 6))
  expect(order.status('agent', 'a', stamp(40, 7))).toBe('older')
  order.accept('legacy', 'b', stamp(undefined, 1))
  order.accept('legacy', 'b', stamp(undefined, 2))
  expect(order.status('legacy', 'a', stamp(undefined, 1))).toBe('older')
  expect(compareAdmissionOrder(stamp(undefined, 1), stamp(50, 2))).toBeLessThan(0)
  expect(compareAdmissionOrder(stamp(20, 9), stamp(30, 2))).toBeLessThan(0)
})

it('keeps native sorting transitive with a headerless delivery between two native events', () => {
  const values = [stamp(20, 1), stamp(undefined, 2), stamp(10, 3)]
  expect(values.sort(compareAdmissionOrder)).toEqual([stamp(undefined, 2), stamp(10, 3), stamp(20, 1)])
  expect(compareAdmissionOrder(stamp(20, 1), stamp(20, 2))).toBeLessThan(0)
  expect(compareAdmissionOrder(stamp(undefined, 1), stamp(undefined, 2))).toBeLessThan(0)
})

it('forgets removed process watermarks while retaining authority for a live process', () => {
  const order = createAdmissionOrder(key => key === 'live')
  order.accept('live', 'b', stamp(20))
  order.accept('removed', 'b', stamp(20))
  order.observe('live', 'process-1', undefined)
  expect(order.status('live', 'a', stamp(10))).toBe('older')
  expect(order.status('removed', 'a', stamp(10))).toBe('current')
})

it('retains current binding authority across a restart, external rebind and process replacement', () => {
  const order = createAdmissionOrder()
  order.observe('agent', 'process-1', undefined)
  order.observe('agent', 'process-1', { id: '', at: null })
  expect(order.status('agent', 'a', stamp(10))).toBe('current')
  order.observe('agent', 'process-1', { id: 'b', at: 20 })
  expect(order.status('agent', 'a', stamp(10))).toBe('older')
  // The native timestamp of an accepted B is retained when its registry row is observed again.
  order.accept('agent', 'b', stamp(25, 2))
  order.observe('agent', 'process-1', { id: 'b', at: 20 })
  expect(order.status('agent', 'a', stamp(23, 3))).toBe('older')
  order.observe('agent', 'process-1', { id: 'c', at: 30 })
  expect(order.status('agent', 'b', stamp(26, 4))).toBe('older')
  order.observe('agent', 'process-2', { id: 'd', at: null })
  expect(order.status('agent', 'd', stamp(10, 5, 'process-2'))).toBe('current')
  expect(order.status('agent', 'a', stamp(10, 6, 'process-2'))).toBe('ambiguous')
})
