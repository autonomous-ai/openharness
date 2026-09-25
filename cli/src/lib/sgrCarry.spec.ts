import { describe, expect, it } from 'vitest'
import { SgrCarry } from './sgrCarry.js'

function carriedAfter(...rows: string[]): string {
  const carry = new SgrCarry()
  for (const row of rows) carry.feed(row)
  return carry.restore
}

describe('SgrCarry', () => {
  it('carries nothing out of a row that set nothing, or reset what it set', () => {
    expect(carriedAfter('plain text')).toBe('')
    expect(carriedAfter('\u001b[2mdim\u001b[0m')).toBe('')
    expect(carriedAfter('\u001b[2mdim\u001b[m')).toBe('')
  })

  it('carries what is still open at the end of a row, into rows that restate nothing', () => {
    expect(carriedAfter('\u001b[2mdim text that wraps ')).toBe('\u001b[2m')
    expect(carriedAfter('\u001b[2mdim ', '', 'still dim')).toBe('\u001b[2m')
  })

  it('serializes in one order, whatever order the row set them in', () => {
    expect(carriedAfter('\u001b[31m\u001b[1mbold red')).toBe('\u001b[1;31m')
    expect(carriedAfter('\u001b[1;31m')).toBe('\u001b[1;31m')
  })

  it('clears only what each reset code names', () => {
    expect(carriedAfter('\u001b[1;2;3;31;42m', '\u001b[22m')).toBe('\u001b[3;31;42m')
    expect(carriedAfter('\u001b[31;42m', '\u001b[39m')).toBe('\u001b[42m')
    expect(carriedAfter('\u001b[4;7;9m', '\u001b[24;27;29m')).toBe('')
  })

  it('keeps 256-colour and truecolour whole, and lets a later colour replace an earlier one', () => {
    expect(carriedAfter('\u001b[38;5;244m')).toBe('\u001b[38;5;244m')
    expect(carriedAfter('\u001b[38;2;166;227;161;48;5;236m')).toBe('\u001b[38;2;166;227;161;48;5;236m')
    expect(carriedAfter('\u001b[38;5;244m', '\u001b[91m')).toBe('\u001b[91m')
  })

  it('reads colon sub-parameters as one parameter', () => {
    expect(carriedAfter('\u001b[4:3m')).toBe('\u001b[4:3m')
    expect(carriedAfter('\u001b[4:3m', '\u001b[4:0m')).toBe('')
    expect(carriedAfter('\u001b[38:2::1:2:3m')).toBe('\u001b[38:2::1:2:3m')
  })

  it('drops a truncated extended colour rather than carrying half of it', () => {
    expect(carriedAfter('\u001b[2;38;2;1m')).toBe('\u001b[2m')
  })

  it('ignores CSI that is not SGR', () => {
    expect(carriedAfter('\u001b[>4;2m\u001b[2K\u001b[5;1H')).toBe('')
  })
})
