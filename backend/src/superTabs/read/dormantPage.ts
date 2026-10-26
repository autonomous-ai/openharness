import { fail } from '../model.js'
import type { GroupData, Part } from '../parts/index.js'

/** The dormant list's page cursor: unpadded base64url of `{"la": lastActivityAt ms, "k": key}` (design 4.5). */
export function encodeDormantPage(last: Part<GroupData>): string {
  return Buffer.from(JSON.stringify({ la: Date.parse(last.data!.lastActivityAt!), k: last.key })).toString('base64url')
}

export function decodeDormantPage(cursor: string): { lastActivityAt: number; key: string } {
  try {
    const { la, k } = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { la?: unknown; k?: unknown }
    if (Number.isSafeInteger(la) && typeof k === 'string' && k) return { lastActivityAt: la as number, key: k }
  } catch { /* answered below */ }
  return fail('INVALID_CURSOR', 'Ask for the first page again.', 400)
}
