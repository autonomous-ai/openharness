import { describe, expect, it } from 'vitest'
import { pickPrivateGrid, privateGridPattern } from './gridDerive.js'

describe('the private grid, derived the way the skill derives it', () => {
  it('slugs the email local part and wants eight hex after it', () => {
    expect(privateGridPattern('tuan.dev@autonomous.ai').test('tuan-dev-991371e4')).toBe(true)
    expect(privateGridPattern('Tuan.Dev@x.io').test('tuan-dev-991371e4')).toBe(true)
    expect(privateGridPattern('tuan.dev@x.io').test('tuan-dev-991371e')).toBe(false)
    expect(privateGridPattern('tuan.dev@x.io').test('tuan-dev-gg1371e4')).toBe(false)
    expect(privateGridPattern('a+b@x.io').test('a-b-0123abcd')).toBe(true)
  })

  it('picks the one permissioned-public grid that matches, never a lookalike', () => {
    const rows = [
      { grid: 'autonomous.ai', type: 'private-domain' },
      { grid: 'tuan-dev-991371e4', type: 'permissioned-public' },
      { grid: 'tuan-dev-11111111', type: 'domain-restricted' }, // right shape, wrong type
      { grid: 'BBB', type: 'domain-restricted' },
    ]
    expect(pickPrivateGrid('tuan.dev@autonomous.ai', rows)).toBe('tuan-dev-991371e4')
  })

  it('answers null for none, and null for more than one — a guess would be someone else\'s grid', () => {
    expect(pickPrivateGrid('tuan.dev@x.io', [{ grid: 'autonomous.ai', type: 'private-domain' }])).toBeNull()
    expect(pickPrivateGrid('tuan.dev@x.io', [
      { grid: 'tuan-dev-991371e4', type: 'permissioned-public' },
      { grid: 'tuan-dev-aaaaaaaa', type: 'permissioned-public' },
    ])).toBeNull()
  })
})
