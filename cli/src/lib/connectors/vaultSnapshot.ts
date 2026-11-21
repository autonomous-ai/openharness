/** Pure connector snapshot parsing and merge rules, shared by the gateway and compatibility readers. */
import { createHash } from 'node:crypto'
import { CODE, RENAMED, cleanClient, cleanToken, removalsIn, type Client, type Store, type Token } from './store.js'
import { VAULT_PLAINTEXT_BYTES } from './vaultBounds.js'

/** What travels, sealed: every connection, its OAuth client, and the disconnects. */
export interface Snapshot {
  v: 1
  connections: Record<string, { token: Token, client?: Client }>
  removed: Record<string, number>
}

/** Disconnects older than this are forgotten: every computer that was on has heard of them. */
const REMOVED_KEPT_S = 180 * 24 * 3600

const issued = (token: Token | undefined): number => token?.obtained_at ?? 0

/** This computer's connections as a snapshot. */
export function snapshotOf(vault: Store): Snapshot {
  const connections: Snapshot['connections'] = {}
  for (const [code, token] of Object.entries(vault.tokens())) {
    const client = token.source === 'dcr' && token.issuer ? vault.client(token.issuer) : undefined
    connections[code] = client ? { token, client } : { token }
  }
  return { v: 1, connections, removed: vault.removed() }
}

/** A snapshot from another computer, with nothing kept that this one would not write itself. */
export function parseSnapshot(text: string): Snapshot | null {
  if (Buffer.byteLength(text) > VAULT_PLAINTEXT_BYTES) return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  const data = raw as Partial<Snapshot> | null
  if (!data || data.v !== 1 || !data.connections || typeof data.connections !== 'object' || Array.isArray(data.connections)
    || (data.removed !== undefined && (!data.removed || typeof data.removed !== 'object' || Array.isArray(data.removed)))) return null
  const result: Snapshot = { v: 1, connections: {}, removed: {} }
  for (const [code, entry] of Object.entries(data.connections)) {
    if (!CODE.test(code)) continue
    const name = RENAMED[code] ?? code
    if (Object.hasOwn(result.connections, name)) continue
    try {
      const token = cleanToken((entry as { token?: unknown }).token)
      const client = cleanClient((entry as { client?: unknown }).client, true)
      result.connections[name] = client ? { token, client } : { token }
    } catch { /* A connection this computer could not use is left out. */ }
  }
  result.removed = removalsIn(data.removed ?? {})
  return result
}

/** The two copies of one service's connection: which is the one to keep. */
function newer(a: Snapshot['connections'][string] | undefined, b: Snapshot['connections'][string] | undefined) {
  if (!a) return b
  if (!b) return a
  if (issued(a.token) !== issued(b.token)) return issued(a.token) > issued(b.token) ? a : b
  if (b.token.needs_reconnect && !a.token.needs_reconnect) return b
  // A partial older publication may have kept this exact token but missed its OAuth client.
  // Never borrow a client from a different credential merely because both were issued in the same second.
  if (!a.client && b.client && fingerprint({ v: 1, connections: { x: { token: a.token } }, removed: {} })
    === fingerprint({ v: 1, connections: { x: { token: b.token } }, removed: {} })) return { ...a, client: b.client }
  return a
}

/** [a] and [b] merged by the rules above. `now` forgets old disconnects. */
export function merge(a: Snapshot, b: Snapshot, now = Math.floor(Date.now() / 1000)): Snapshot {
  const result: Snapshot = { v: 1, connections: {}, removed: {} }
  for (const code of new Set([...Object.keys(a.removed), ...Object.keys(b.removed)])) {
    const at = Math.max(a.removed[code] ?? 0, b.removed[code] ?? 0)
    if (at > now - REMOVED_KEPT_S) result.removed[code] = at
  }
  for (const code of new Set([...Object.keys(a.connections), ...Object.keys(b.connections)])) {
    const kept = newer(a.connections[code], b.connections[code])
    const removedAt = Math.max(a.removed[code] ?? 0, b.removed[code] ?? 0)
    if (kept && issued(kept.token) > removedAt) result.connections[code] = kept
  }
  return result
}

/** The same snapshot always reads the same: for telling whether anything moved. */
export function fingerprint(snapshot: Snapshot): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted((value as Record<string, unknown>)[k])]))
      : value
  return createHash('sha256').update(JSON.stringify(sorted(snapshot))).digest('hex')
}
