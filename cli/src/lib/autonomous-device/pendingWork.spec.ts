import { expect, it } from 'vitest'
import { DeviceWorkBudget } from './pendingWork.js'

it('charges exactly the encoded payload budget and releases each accepted owner once', () => {
  const budget = new DeviceWorkBudget(), release = budget.reserve('x'.repeat(16 * 1024 * 1024 - 2))!
  expect(release).toBeTypeOf('function')
  expect(budget.reserve('')).toBeNull()
  release(); release()
  const owners = Array.from({ length: 100 }, () => budget.reserve({ message: 'small' }))
  expect(owners.every(owner => owner !== null)).toBe(true)
  expect(budget.reserve({ message: 'small' })).toBeNull()
  owners[0]!()
  expect(budget.reserve({ message: 'replacement' })).toBeTypeOf('function')
  expect(budget.reserve(null)).toBeNull()
})

it('refuses unsupported or oversized payloads without running getters or retaining credit', () => {
  const budget = new DeviceWorkBudget()
  const poison = Object.defineProperty({}, 'value', { enumerable: true, get: () => { throw new Error('must not run') } })
  expect(budget.reserve(poison)).toBeNull()
  expect(budget.reserve('x'.repeat(16 * 1024 * 1024))).toBeNull()
  expect(budget.reserve({ value: 'valid' })).toBeTypeOf('function')
})
