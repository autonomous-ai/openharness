import { describe, expect, it, vi } from 'vitest'
import { parseProcessRow } from './processTable.js'

const start = 'Fri Nov 20 12:00:00 2026'
const line = (args: string, executable = 'fixture-engine') => `2147483646 1 ${executable} ${start} ${args}`

describe('owned process text copies', () => {
  it('does not allocate another Buffer for each small identity field', () => {
    const copies = vi.spyOn(Buffer, 'from')
    try {
      const first = parseProcessRow(line('first-arguments'))
      const second = parseProcessRow(line('next-arguments', 'another-engine'))
      expect(first).toMatchObject({ executable: 'fixture-engine', startMarker: start, args: 'first-arguments' })
      expect(second).toMatchObject({ executable: 'another-engine', startMarker: start, args: 'next-arguments' })
      expect(copies.mock.calls.filter((call: readonly unknown[]) => call[1] === 'utf16le')).toHaveLength(0)
    } finally { copies.mockRestore() }
  })

  it.each([4095, 4096, 4097, 65536])('preserves %s UTF-16 units through later short copies', length => {
    const args = 'a'.repeat(length - 1) + '\ud800'
    const copies = vi.spyOn(Buffer, 'from')
    try {
      const saved = parseProcessRow(line(args))
      const largeCopies = copies.mock.calls.filter((call: readonly unknown[]) => call[1] === 'utf16le').length
      for (const text of ['short', '', '😀', 'tail\udfff']) parseProcessRow(line(text))
      expect(saved?.args).toBe(args)
      expect(saved?.executable).toBe('fixture-engine')
      expect(largeCopies).toBe(length > 4096 ? 1 : 0)
    } finally { copies.mockRestore() }
  })

  it.each(['plain', 'Tiếng Việt 引擎', '😀🧪', 'e\u0301', '\ud800', '\udfff', '\\"\t\u0000', ''])(
    'retains exact text %j after the next row is copied', text => {
      const executable = `fixture-${text || 'empty'}`, args = text ? `args-${text}` : ''
      const saved = parseProcessRow(line(args, executable))
      parseProcessRow(line('overwrite-every-used-byte'.repeat(100), 'different-engine'))
      expect(saved).toEqual({ pid: 2147483646, parentPid: 1, executable, startMarker: start, args })
    },
  )
})
