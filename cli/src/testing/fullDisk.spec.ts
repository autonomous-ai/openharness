import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ open: vi.fn(), write: vi.fn(), close: vi.fn() }))
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), openSync: io.open, writeSync: io.write, closeSync: io.close }))
// The end-to-end harness is outside tsconfig's rootDir (src), so it is loaded untyped, as releaseFixtures.spec.ts
// loads release.ts.
const { fillVolume } = await import('../../e2e/harness/fullDisk.js' as string) as { fillVolume: (volume: string) => string }

const refused = (code: string) => Object.assign(new Error(code), { code })
const filler = join('/v', 'filler')
const tail = join('/v', 'filler-tail')
/** A volume: what each file opens as (a descriptor, or the error its open throws), and how many writes each
 *  descriptor takes before the volume refuses. */
function volume(opens: Record<string, number | Error>, room: Record<number, number> = {}): void {
  io.open.mockImplementation((path: string) => { const fd = opens[path]; if (fd instanceof Error) throw fd; return fd })
  io.write.mockImplementation((fd: number, chunk: Buffer) => { if ((room[fd] ?? 0) <= 0) throw refused('ENOSPC'); room[fd]--; return chunk.length })
}
beforeEach(() => { for (const fn of Object.values(io)) fn.mockReset() })

describe('fillVolume', () => {
  it('appends to the filler until the volume refuses, then to the tail, and returns the filler', () => {
    volume({ [filler]: 3, [tail]: 4 }, { 3: 2, 4: 1 })
    expect(fillVolume('/v')).toBe(filler)
    expect(io.open.mock.calls).toEqual([[filler, 'a'], [tail, 'a']])
    expect(io.write.mock.calls.map(([fd, chunk]) => [fd, chunk.length])).toEqual([[3, 1048576], [3, 1048576], [3, 1048576], [4, 4096], [4, 4096]])
    expect(io.close.mock.calls).toEqual([[3], [4]])
  })

  it('a volume too full to create the tail is full: it returns', () => {
    volume({ [filler]: 3, [tail]: refused('ENOSPC') })
    expect(fillVolume('/v')).toBe(filler)
    expect(io.close.mock.calls).toEqual([[3]])
  })

  it('a volume too full to open the filler is full: it returns', () => {
    volume({ [filler]: refused('ENOSPC'), [tail]: refused('ENOSPC') })
    expect(fillVolume('/v')).toBe(filler)
    expect(io.close).not.toHaveBeenCalled()
  })

  it('throws an error that is not ENOSPC, from an open or a write, and closes what it opened', () => {
    volume({ [filler]: 3, [tail]: refused('EACCES') })
    expect(() => fillVolume('/v')).toThrow('EACCES')
    expect(io.close.mock.calls).toEqual([[3]])
    io.close.mockClear()
    volume({ [filler]: 3, [tail]: 4 })
    io.write.mockImplementation((fd: number) => { throw refused(fd === 4 ? 'EIO' : 'ENOSPC') })
    expect(() => fillVolume('/v')).toThrow('EIO')
    expect(io.close.mock.calls).toEqual([[3], [4]])
  })
})
