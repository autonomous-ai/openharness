import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PET_ROWS, PetSheetError, parsePetSheet, readPetSheet, resolvePetRows, type PetRow } from './sheet.js'

const ROW_INDEX: Record<PetRow, number> = {
  idle: 0,
  runningRight: 1,
  runningLeft: 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8,
}

// A transparent sheet with `cells[row]` cells drawn (a solid 10 x 10 block) at the start of each row.
function makeSheet(width: number, height: number, cells: Partial<Record<PetRow, number>>): PNG {
  const png = new PNG({ width, height })
  const cw = width / 8
  const ch = height / 9
  for (const [row, n] of Object.entries(cells) as [PetRow, number][]) {
    for (let c = 0; c < n; c++) {
      for (let y = 0; y < 10; y++) {
        for (let x = 0; x < 10; x++) {
          const i = ((ROW_INDEX[row] * ch + 20 + y) * width + c * cw + 20 + x) * 4
          png.data.set([200, 40 + c * 10, 90, 255], i)
        }
      }
    }
  }
  return png
}

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

function expectError(fn: () => unknown, code: string, message?: string) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(PetSheetError)
    expect((e as PetSheetError).code).toBe(code)
    if (message) expect((e as PetSheetError).message).toBe(message)
    return
  }
  throw new Error('did not throw')
}

describe('parsePetSheet', () => {
  it('accepts 1536x1872 and 768x936', () => {
    const full = parsePetSheet(PNG.sync.write(makeSheet(1536, 1872, { idle: 2, running: 2 })))
    expect([full.cellW, full.cellH]).toEqual([192, 208])
    const half = parsePetSheet(PNG.sync.write(makeSheet(768, 936, { idle: 2, running: 2 })))
    expect([half.cellW, half.cellH]).toEqual([96, 104])
    expect(half.rows.idle[0].width).toBe(96)
    expect(half.rows.idle[0].data.length).toBe(96 * 104 * 4)
  })

  it('rejects 1000x1000', () => {
    expectError(
      () => parsePetSheet(PNG.sync.write(makeSheet(1000, 1000, {}))),
      'BAD_SIZE',
      'The sheet must be 1536 × 1872 (8 × 9 cells of 192 × 208)',
    )
  })

  it('row ends at the first transparent cell', () => {
    const png = makeSheet(768, 936, { idle: 3, running: 1 })
    // A drawn cell after the gap is not part of the row.
    const i = ((3 * 104 + 20) * 768 + 5 * 96 + 20) * 4
    png.data.set([1, 2, 3, 255], i)
    const sheet = parsePetSheet(PNG.sync.write(png))
    expect(sheet.rows.idle.length).toBe(3)
    expect(sheet.rows.waving.length).toBe(0)
  })

  it('a sheet with nothing drawn on it', () => {
    expectError(() => parsePetSheet(PNG.sync.write(makeSheet(768, 936, {}))), 'NO_FRAMES', 'The sheet is empty')
  })

  it('empty idle or running rows are left for the row choice to judge', () => {
    expect(parsePetSheet(PNG.sync.write(makeSheet(768, 936, { idle: 2 }))).rows.running).toEqual([])
    expect(parsePetSheet(PNG.sync.write(makeSheet(768, 936, { jumping: 1 }))).rows.idle).toEqual([])
  })

  it('not a PNG', () => {
    expectError(() => parsePetSheet(Buffer.from('definitely not a png file')), 'NOT_PNG')
    const broken = PNG.sync.write(makeSheet(768, 936, { idle: 1, running: 1 })).subarray(0, 60)
    expectError(() => parsePetSheet(broken), 'NOT_PNG')
  })
})

describe('resolvePetRows', () => {
  const parse = (cells: Partial<Record<PetRow, number>>) => parsePetSheet(PNG.sync.write(makeSheet(768, 936, cells)))

  it('without a choice: today’s table, with listening, sending and asking falling back to idle', () => {
    expect(resolvePetRows(parse({ idle: 2, running: 2 }))).toEqual({
      rest: 'idle', working: 'running', listening: 'idle', sending: 'idle', asking: 'idle', relaxing: 'idle',
    })
    expect(resolvePetRows(parse({ idle: 2, running: 2, review: 1, waving: 1, waiting: 1 }))).toEqual(DEFAULT_PET_ROWS)
  })

  it('a choice overrides the default per key; an empty chosen listening, sending or asking row falls back to rest', () => {
    const sheet = parse({ jumping: 2, runningLeft: 3, failed: 1 })
    expect(resolvePetRows(sheet, { rest: 'jumping', working: 'runningLeft', sending: 'failed', asking: 'waiting' })).toEqual({
      rest: 'jumping', working: 'runningLeft', listening: 'jumping', sending: 'failed', asking: 'jumping', relaxing: 'jumping',
    })
  })

  it('relaxing follows the rest row unless chosen; an empty chosen row falls back to rest', () => {
    const sheet = parse({ idle: 2, running: 2, review: 1 })
    expect(resolvePetRows(sheet, { relaxing: 'review' }).relaxing).toBe('review')
    expect(resolvePetRows(sheet, { relaxing: 'waving' }).relaxing).toBe('idle')
    expect(resolvePetRows(sheet, { rest: 'review' }).relaxing).toBe('review')
    expect(resolvePetRows(sheet, { rest: 'review', relaxing: 'idle' }).relaxing).toBe('idle')
  })

  it('the chosen rest and working rows must have frames', () => {
    expectError(() => resolvePetRows(parse({ running: 2 })), 'NO_REST', 'The row chosen for Rest is empty')
    expectError(() => resolvePetRows(parse({ idle: 2 })), 'NO_WORKING', 'The row chosen for Working is empty')
    expectError(() => resolvePetRows(parse({ idle: 2, running: 2 }), { working: 'jumping' }), 'NO_WORKING', 'The row chosen for Working is empty')
    expectError(() => resolvePetRows(parse({ idle: 2, running: 2 }), { rest: 'review' }), 'NO_REST', 'The row chosen for Rest is empty')
  })
})

describe('readPetSheet', () => {
  it('reads a sheet from a path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-sheet-'))
    dirs.push(dir)
    const file = join(dir, 'sheet.png')
    await writeFile(file, PNG.sync.write(makeSheet(768, 936, { idle: 1, running: 1 })))
    const sheet = await readPetSheet(file)
    expect(sheet.rows.running.length).toBe(1)
  })

  it('file over 8 MB', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-sheet-'))
    dirs.push(dir)
    const file = join(dir, 'big.png')
    await writeFile(file, '')
    await truncate(file, 8 * 1024 * 1024 + 1) // sparse: never read, only stat
    await expect(readPetSheet(file)).rejects.toMatchObject({ code: 'TOO_BIG' })
  })

  it('missing file', async () => {
    await expect(readPetSheet('/nonexistent/pet.png')).rejects.toMatchObject({ code: 'NOT_PNG' })
  })
})

// A PNG whose IHDR declares what it likes and whose body is nothing: pngjs would allocate for the declaration.
function fakeHeader(width: number, height: number, depth = 8, colour = 6, interlace = 0): Buffer {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'latin1')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  head[24] = depth
  head[25] = colour
  head[28] = interlace
  return head
}

describe('PNG header check', () => {
  it('rejects a 12000 x 12000 declaration without decoding', () => {
    const spy = vi.spyOn(PNG.sync, 'read')
    const start = performance.now()
    expectError(() => parsePetSheet(fakeHeader(12000, 12000)), 'BAD_SIZE', 'The sheet must be 1536 × 1872 (8 × 9 cells of 192 × 208)')
    expect(performance.now() - start).toBeLessThan(100)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('rejects 16-bit and interlaced sheets without decoding', () => {
    const spy = vi.spyOn(PNG.sync, 'read')
    expectError(() => parsePetSheet(fakeHeader(768, 936, 16)), 'NOT_PNG')
    expectError(() => parsePetSheet(fakeHeader(768, 936, 8, 6, 1)), 'BAD_SIZE', 'Save the sheet without interlacing')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('readPetSource special files', () => {
  const tmp = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-special-'))
    dirs.push(dir)
    return dir
  }

  it('refuses a directory', async () => {
    await expect(readPetSheet(await tmp())).rejects.toMatchObject({ code: 'NOT_PNG', message: 'Choose a PNG file' })
  })

  it('refuses a FIFO promptly', async () => {
    const fifo = join(await tmp(), 'pipe.png')
    execFileSync('mkfifo', [fifo])
    const start = performance.now()
    await expect(readPetSheet(fifo)).rejects.toMatchObject({ code: 'NOT_PNG', message: 'Choose a PNG file' })
    expect(performance.now() - start).toBeLessThan(500)
  })

  it.skipIf(!existsSync('/dev/zero'))('refuses /dev/zero promptly', async () => {
    const start = performance.now()
    await expect(readPetSheet('/dev/zero')).rejects.toMatchObject({ code: 'NOT_PNG', message: 'Choose a PNG file' })
    expect(performance.now() - start).toBeLessThan(500)
  })
})
