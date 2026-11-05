import sharp from 'sharp'
import { logger } from '../utils/logger.js'

/**
 * Thumbnails of chat pictures (task #3177): when a PNG, JPEG or WebP is uploaded the server keeps a small WebP copy beside it,
 * so a chat draws that and only the full-screen viewer reads the original. A GIF is left alone (a copy would stop it moving).
 * The copy's address and size travel with the file (`Attachment.thumb`); a file without one is drawn from the original, as
 * before. A failure here never fails an upload: it only means there is no thumbnail.
 */
export const THUMB_LONG_SIDE = 720
const THUMB_QUALITY = 80
/** A thumbnail is kept only when it is clearly smaller than the picture it stands for. */
const WORTH_KEEPING = 0.8
/** Past this many pixels a picture is not decoded (a small file can claim a huge canvas). */
export const MAX_THUMB_PIXELS = 64_000_000
/** Past this long, a thumbnail is given up on; libvips cannot be cancelled, so its slot is held until it ends. */
const THUMB_GIVES_UP_MS = 10_000
/** Thumbnails made at once in one process: each decodes a picture in memory. */
const AT_ONCE = 2
/** Pictures this server thumbnails, whatever type they were declared as. */
const FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp'])

sharp.cache(false)
sharp.concurrency(1)

export interface Thumbnail { bytes: Buffer; width: number; height: number }
/** A picture's size as it is shown (EXIF rotation applied), and its thumbnail when one is worth keeping. */
export interface ImageFacts { width: number; height: number; thumb?: Thumbnail }

/** What a message keeps of a picture: its size, and where its thumbnail is (an address in the same Swarm folder). */
export interface StoredImage { width: number; height: number; thumb?: { url: string; width: number; height: number; size: number } }

/** The thumbnail of the object at [objectKey] is stored beside it: same folder, same random segment. */
export const thumbKeyOf = (objectKey: string) => `${objectKey}.thumb.webp`

let running = 0
const waiting: Array<() => void> = []
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>(resolve => waiting.push(resolve))
  else running++
  try { return await work() } finally {
    const next = waiting.shift()
    if (next) next(); else running--
  }
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** The picture's size and thumbnail, or null when [bytes] are not a PNG, JPEG or WebP this can read within its limits. */
export async function makeThumbnail(bytes: Buffer): Promise<ImageFacts | null> {
  if (!bytes.byteLength) return null
  try {
    return await slot(async () => {
      const timeout = new Promise<null>(resolve => setTimeout(resolve, THUMB_GIVES_UP_MS, null).unref())
      return Promise.race([thumbnailOf(bytes), timeout])
    })
  } catch (error) {
    // A decoder's message can quote what it read: only that it failed is logged.
    logger.warn('[thumbnails] could not read a picture', { error: error instanceof Error ? error.name : 'unknown' })
    return null
  }
}

async function thumbnailOf(bytes: Buffer): Promise<ImageFacts | null> {
  const input = () => sharp(bytes, { limitInputPixels: MAX_THUMB_PIXELS, failOn: 'error' })
  const meta = await input().metadata()
  if (!meta.format || !FORMATS.has(meta.format) || !positive(meta.width) || !positive(meta.height)) return null
  if (meta.width * meta.height > MAX_THUMB_PIXELS) return null
  // EXIF orientation 5 to 8 turns the picture a quarter: what it shows is the other way round.
  const turned = (meta.orientation ?? 1) >= 5
  const width = turned ? meta.height : meta.width, height = turned ? meta.width : meta.height
  const made = await input().rotate().resize({ width: THUMB_LONG_SIDE, height: THUMB_LONG_SIDE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY }).toBuffer({ resolveWithObject: true })
  if (made.data.byteLength >= bytes.byteLength * WORTH_KEEPING) return { width, height }
  return { width, height, thumb: { bytes: made.data, width: made.info.width, height: made.info.height } }
}

/** A stored row's or message file's picture facts, read defensively: only a size, and a thumbnail with an address and counts. */
export function imageFacts(stored: unknown): StoredImage | null {
  if (!stored || typeof stored !== 'object') return null
  const { width, height, thumb } = stored as { width?: unknown; height?: unknown; thumb?: unknown }
  if (!positive(width) || !positive(height)) return null
  const facts: StoredImage = { width, height }
  if (thumb && typeof thumb === 'object') {
    const t = thumb as { url?: unknown; width?: unknown; height?: unknown; size?: unknown }
    if (typeof t.url === 'string' && t.url && positive(t.width) && positive(t.height) && positive(t.size)) {
      facts.thumb = { url: t.url, width: t.width, height: t.height, size: t.size }
    }
  }
  return facts
}

/** The picture facts a file carries when a stored row's `image` is read for the upload's answer or a message. */
export function pictureFields(stored: unknown): { width?: number; height?: number; thumb?: { url: string; width: number; height: number; size: number } } {
  const facts = imageFacts(stored)
  return facts ? { width: facts.width, height: facts.height, ...facts.thumb ? { thumb: facts.thumb } : {} } : {}
}

/** Pictures the server reads back from the bucket for a thumbnail when they were sent straight to it. A bigger one gets none. */
export const MAX_READ_BACK_BYTES = 32 * 1024 * 1024
/** The types thumbnailed, as an upload's checked type names them. */
export const THUMBNAILED_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp'])
