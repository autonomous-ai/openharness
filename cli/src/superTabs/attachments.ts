import { writePasteDropFile } from '../lib/pasteDropFiles.js'
import { identifier, object } from './wire.js'

/** What a message read carries about one attached image (backend superTabs/attachments.ts); never its bytes. */
export interface SuperTabAttachment { id: string; name: string; mime: string; size: number; parts: number }

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
/** The backend's own limits: 5 MB an image, in 256 KiB parts. A row claiming more is refused before anything is read. */
const MAX_BYTES = 5 * 1024 * 1024
const MAX_PARTS = 64
const PARALLEL_PARTS = 4

/** The attachments of a message row; anything malformed is left out. */
export function attachmentsOf(message: unknown): SuperTabAttachment[] {
  const rows = object(message).attachments
  if (!Array.isArray(rows)) return []
  return rows.map(object).filter(a => identifier(a.id) && typeof a.name === 'string' && typeof a.mime === 'string' && Object.hasOwn(EXTENSIONS, a.mime)
    && Number.isInteger(a.size) && (a.size as number) > 0 && (a.size as number) <= MAX_BYTES
    && Number.isInteger(a.parts) && (a.parts as number) > 0 && (a.parts as number) <= MAX_PARTS)
    .map(a => ({ id: a.id as string, name: a.name as string, mime: a.mime as string, size: a.size as number, parts: a.parts as number }))
}

/** The sender's name, with the extension its bytes really have: an agent opens the file by that. Spaces and other
 * characters a shell or a prompt line would split on become dashes. */
function fileName(attachment: SuperTabAttachment): string {
  const dot = attachment.name.lastIndexOf('.')
  const stem = (dot > 0 ? attachment.name.slice(0, dot) : attachment.name).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 100) || 'image'
  return `${stem}.${EXTENSIONS[attachment.mime]}`
}

/**
 * Reads an image part by part, as the agent this machine runs, and saves it where pasted and dropped files go
 * (lib/pasteDropFiles.ts, pruned after a day). Returns the file's absolute path for the agent to open.
 */
export async function saveAttachment(read: (path: string) => Promise<unknown>, tabId: string, agentId: string,
  attachment: SuperTabAttachment): Promise<string> {
  // Four parts at a time: a 5 MB image is 20 small requests, and one at a time made a delivery wait seconds.
  const parts: Buffer[] = new Array(attachment.parts)
  let next = 0
  const worker = async () => {
    for (let index = next++; index < attachment.parts; index = next++) {
      const part = object(await read(`/api/super-tabs/${tabId}/attachments/${attachment.id}/parts/${index}?asAgentId=${agentId}`))
      if (typeof part.data !== 'string') throw new Error('The image is unreadable.')
      parts[index] = Buffer.from(part.data, 'base64')
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, attachment.parts) }, worker))
  const bytes = Buffer.concat(parts)
  if (bytes.length !== attachment.size) throw new Error('The image arrived incomplete.')
  return writePasteDropFile(fileName(attachment), bytes)
}
