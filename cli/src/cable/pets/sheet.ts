import { open, stat } from 'node:fs/promises'
import { PNG } from 'pngjs'

// A petdex-layout sprite sheet: 8 columns x 9 rows of cells. The full sheet is 1536 x 1872 (cells of 192 x 208), the
// half size 768 x 936 (cells of 96 x 104). Rows, top to bottom, are the names below.
export type PetRow =
  | 'idle'
  | 'runningRight'
  | 'runningLeft'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

export const PET_ROWS: readonly PetRow[] = [
  'idle',
  'runningRight',
  'runningLeft',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
]

export interface RgbaFrame {
  width: number
  height: number
  data: Uint8Array // RGBA, 4 bytes per pixel
}

export interface PetSheet {
  cellW: number
  cellH: number
  rows: Record<PetRow, RgbaFrame[]>
}

// Which sheet row plays each of the dial's states. The user picks them; without a choice it is the petdex reading.
export type PetState = 'rest' | 'working' | 'listening' | 'sending' | 'asking'
export type PetRows = Record<PetState, PetRow>
export const PET_STATES: readonly PetState[] = ['rest', 'working', 'listening', 'sending', 'asking']
export const DEFAULT_PET_ROWS: Readonly<PetRows> = {
  rest: 'idle',
  working: 'running',
  listening: 'review',
  sending: 'waving',
  asking: 'waiting',
}

export type PetSheetErrorCode = 'NOT_PNG' | 'BAD_SIZE' | 'NO_FRAMES' | 'NO_REST' | 'NO_WORKING' | 'TOO_BIG' | 'TOO_MANY'

// The message is shown to the user as is, so every throw site words it for them.
export class PetSheetError extends Error {
  readonly code: PetSheetErrorCode
  constructor(code: PetSheetErrorCode, message: string) {
    super(message)
    this.name = 'PetSheetError'
    this.code = code
  }
}

export const SHEET_COLS = 8
export const SHEET_MAX_BYTES = 8 * 1024 * 1024
// A cell with alpha >= this is opaque; the dial's cell sprites have no partial alpha.
export const ALPHA_OPAQUE = 128

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// A sheet is read from a path, not bytes: the app and the daemon share the machine and 8 MB would not fit the local
// socket's message limit. Only a regular file is opened (a FIFO would block the open, /dev/zero would never end), and
// at most the limit plus one byte is read, whatever the file grows to.
export async function readPetSource(path: string): Promise<Buffer> {
  const notFile = () => new PetSheetError('NOT_PNG', 'Choose a PNG file')
  try {
    if (!(await stat(path)).isFile()) throw notFile()
  } catch (error) {
    if (error instanceof PetSheetError) throw error
    throw new PetSheetError('NOT_PNG', 'The file could not be read')
  }
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    throw new PetSheetError('NOT_PNG', 'The file could not be read')
  }
  try {
    const info = await fh.stat()
    if (!info.isFile()) throw notFile()
    if (info.size > SHEET_MAX_BYTES) throw new PetSheetError('TOO_BIG', 'The file is over 8 MB')
    const buf = Buffer.alloc(info.size + 1) // size <= the limit, so never more than limit + 1
    let n = 0
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n)
      if (bytesRead === 0) break
      n += bytesRead
    }
    if (n > SHEET_MAX_BYTES) throw new PetSheetError('TOO_BIG', 'The file is over 8 MB')
    return buf.subarray(0, n)
  } catch (error) {
    if (error instanceof PetSheetError) throw error
    throw new PetSheetError('NOT_PNG', 'The file could not be read')
  } finally {
    await fh.close().catch(() => undefined)
  }
}

export async function readPetSheet(path: string): Promise<PetSheet> {
  return parsePetSheet(await readPetSource(path))
}

export function parsePetSheet(png: Buffer): PetSheet {
  if (png.length < PNG_MAGIC.length || PNG_MAGIC.some((b, i) => png[i] !== b)) {
    throw new PetSheetError('NOT_PNG', 'The file is not a PNG')
  }
  checkHeader(png)
  let image: PNG
  try {
    image = PNG.sync.read(png)
  } catch {
    throw new PetSheetError('NOT_PNG', 'The file is not a PNG')
  }
  const { width, height } = image
  if (!sizeOk(width, height)) throw badSize()
  const cellW = width / SHEET_COLS
  const cellH = height / PET_ROWS.length
  const rows = {} as Record<PetRow, RgbaFrame[]>
  PET_ROWS.forEach((name, r) => {
    const frames: RgbaFrame[] = []
    for (let c = 0; c < SHEET_COLS; c++) {
      const frame = cut(image.data, width, c * cellW, r * cellH, cellW, cellH)
      // A row ends at its first cell with nothing opaque in it. "Opaque" is the dial's own alpha test, so a cell of
      // only faint pixels cannot become an empty frame later.
      if (isBlank(frame)) break
      frames.push({ width: cellW, height: cellH, data: frame })
    }
    rows[name] = frames
  })
  // Which rows must have frames depends on the row choice (resolvePetRows); a sheet with none is no pet at all.
  if (PET_ROWS.every((name) => rows[name].length === 0)) throw new PetSheetError('NO_FRAMES', 'The sheet is empty')
  return { cellW, cellH, rows }
}

// The rows the pack is made from: the choice over the defaults, without judging them. A listening, sending or asking
// row with no frames falls back to the rest row (with the default rest, idle: the petdex reading).
export function pickPetRows(sheet: PetSheet, choice: Partial<PetRows> = {}): PetRows {
  const picked = { ...DEFAULT_PET_ROWS }
  for (const state of PET_STATES) {
    const row = choice[state]
    if (row && PET_ROWS.includes(row)) picked[state] = row
  }
  for (const state of ['listening', 'sending', 'asking'] as const) {
    if (sheet.rows[picked[state]].length === 0) picked[state] = picked.rest
  }
  return picked
}

// pickPetRows, refusing a choice the dial cannot play: rest and working are drawn all the time, so neither may be empty.
export function resolvePetRows(sheet: PetSheet, choice?: Partial<PetRows>): PetRows {
  const picked = pickPetRows(sheet, choice)
  if (sheet.rows[picked.rest].length === 0) throw new PetSheetError('NO_REST', 'The row chosen for Rest is empty')
  if (sheet.rows[picked.working].length === 0) throw new PetSheetError('NO_WORKING', 'The row chosen for Working is empty')
  return picked
}

const badSize = () => new PetSheetError('BAD_SIZE', 'The sheet must be 1536 × 1872 (8 × 9 cells of 192 × 208)')
const sizeOk = (w: number, h: number) => (w === 1536 && h === 1872) || (w === 768 && h === 936)

// The IHDR is read here, before pngjs, which allocates what the header declares: a few bytes claiming 12000 x 12000
// must not become half a gigabyte. Only what the sheet format can be (8-bit RGB, RGBA or palette) is decoded.
function checkHeader(png: Buffer): void {
  if (png.length < 33 || png.readUInt32BE(8) !== 13 || png.toString('latin1', 12, 16) !== 'IHDR') {
    throw new PetSheetError('NOT_PNG', 'The file is not a PNG')
  }
  if (!sizeOk(png.readUInt32BE(16), png.readUInt32BE(20))) throw badSize()
  const depth = png[24]
  const colour = png[25]
  const depthOk = colour === 3 ? [1, 2, 4, 8].includes(depth) : depth === 8
  if (![2, 3, 6].includes(colour) || !depthOk) {
    throw new PetSheetError('NOT_PNG', 'Save the sheet as an 8-bit RGB or RGBA PNG')
  }
  if (png[28] !== 0) throw new PetSheetError('BAD_SIZE', 'Save the sheet without interlacing')
}

function cut(src: Uint8Array, stride: number, x0: number, y0: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * stride + x0) * 4
    out.set(src.subarray(from, from + w * 4), y * w * 4)
  }
  return out
}

function isBlank(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] >= ALPHA_OPAQUE) return false
  return true
}
