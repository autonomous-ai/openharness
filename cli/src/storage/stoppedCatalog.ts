/** Display reuse only. Selected actions always use the codec's fresh reads and proofs. */
import type { BigIntStats } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { sessionFileIdentity, type SessionImage } from '../lib/sessionStorageWire.js'

const RECORDS = 2048
const BYTES = 4 * 1024 * 1024
const REUSE_MS = 30_000

export function createStoppedCatalog() {
  const entries = new Map<string, { identity: string; at: number; bytes: number; text: string }>()
  let bytes = 0
  const forget = (id: string) => {
    const previous = entries.get(id)
    if (previous) { bytes -= previous.bytes; entries.delete(id) }
  }
  return async (id: string, inspect: () => BigIntStats | null, read: () => Promise<SessionImage>): Promise<SessionImage> => {
    const now = performance.now()
    // Insertion order is read time; hits do not extend the historical thirty-second reuse window.
    for (const [old, entry] of entries) {
      if (now >= entry.at && now - entry.at < REUSE_MS) break
      forget(old)
    }
    try {
      const stat = inspect()
      if (!stat) { forget(id); return { state: 'missing' } }
      const identity = sessionFileIdentity(stat), cached = entries.get(id)
      if (cached?.identity === identity && now >= cached.at && now - cached.at < REUSE_MS) {
        // A caller owns its returned graph; the bounded retained representation is immutable text.
        return JSON.parse(cached.text) as SessionImage
      }
      forget(id)
      const image = await read()
      if (image.state === 'image' && image.json) {
        const text = JSON.stringify(image), size = Buffer.byteLength(text)
        if (entries.size < RECORDS && bytes + size <= BYTES) {
          entries.set(id, { identity: image.proof.identity, at: performance.now(), bytes: size, text })
          bytes += size
        }
      }
      return image
    } catch (error) { forget(id); throw error }
  }
}
