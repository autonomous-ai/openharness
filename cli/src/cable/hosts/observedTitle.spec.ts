import { describe, expect, it } from 'vitest'
import { observedTitle } from './observedTitle.js'

describe('observedTitle', () => {
  it.each([
    ['Tho', 'Tho'],
    ['  Fix \t\n login   screen ', 'Fix login screen'],
    ['x'.repeat(70), 'x'.repeat(64)],
    [`${'x'.repeat(63)}😀tail`, 'x'.repeat(63)],
    [`${'x'.repeat(62)}😀tail`, `${'x'.repeat(62)}😀`],
    [`${'x'.repeat(63)} yz`, 'x'.repeat(63)],
    ['😀'.repeat(40), '😀'.repeat(32)],
    ['Thơ "gà" \\ 数学 🙂', 'Thơ "gà" \\ 数学 🙂'],
  ])('cleans %j to %j', (value, result) => {
    expect(observedTitle(value)).toBe(result)
  })

  it.each([
    '',
    ' \t\n ',
    'Th\u0007o',
    'Th\u007fo',
    'Th\u0000o',
    7,
    null,
    undefined,
    true,
    { text: 'Tho' },
    ['Tho'],
  ])('gives none for %j', (value) => {
    expect(observedTitle(value)).toBeUndefined()
  })
})
