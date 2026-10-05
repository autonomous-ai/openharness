/**
 * The device key log read as a history: who was added, renamed or removed, newest first — what
 * `harness devices history` and the apps' History dialog show. Pure: the entries are whatever this
 * machine verified (or kept), the context says what is known about them now.
 *
 * ⚠ Ported to Dart (desktop|mobile/lib/viewer/device_history.dart); the rows are the wire format of
 * `GET /api/devices/history` — change both together.
 */
import type { DevLogEntry, DevLogKind, DevLogMember } from './deviceLog.js'
import { b64d, fingerprint } from './core.js'

export interface DevLogHistoryRow {
  seq: number
  op: 'added' | 'renamed' | 'removed' | 'signedOut'
  pub: string
  kind: DevLogKind
  machineId: string
  label: string
  /** For `renamed`: the name it had before, when known. */
  previousLabel?: string
  fingerprint: string
  /** For `removed`: the key that signed the removal. */
  by?: { pub: string; label: string; fingerprint: string }
  at: number
  thisDevice: boolean
  /** Added after this device joined (its entry is past `joinedSeq`). */
  afterJoin: boolean
  /** Still new: nobody has marked it as seen here. */
  pending: boolean
  /** The key is active in the log now. */
  active: boolean
  /** A removal this device applied while its copy of the log was frozen (unchained, so unverified). */
  whileFrozen: boolean
}

export interface DevLogHistoryContext {
  selfPub: string
  joinedSeq?: number
  pending: readonly string[]
  active: Readonly<Record<string, DevLogMember>>
  /** Removals applied while frozen: not part of `entries`, shown last-known. */
  loose?: readonly DevLogEntry[]
}

const fp = (pub: string): string => {
  try { return fingerprint(b64d(pub)) } catch { return '' }
}

/** Newest first. `entries` may have gaps at the front (only the recent tail is known offline). */
export function devLogHistory(entries: readonly DevLogEntry[], ctx: DevLogHistoryContext): DevLogHistoryRow[] {
  const seen = new Set<string>()
  const ordered: Array<{ e: DevLogEntry; loose: boolean }> = []
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const key = `${e.seq}:${e.sig}`
    if (seen.has(key)) continue
    seen.add(key)
    ordered.push({ e, loose: false })
  }
  for (const e of ctx.loose ?? []) {
    const key = `${e.seq}:${e.sig}`
    if (seen.has(key)) continue
    seen.add(key)
    ordered.push({ e, loose: true })
  }
  // The name each key last went by, to say "renamed from" and to name a signer that is gone.
  const labels = new Map<string, string>()
  for (const m of Object.values(ctx.active)) labels.set(m.pub, m.label)
  const known = new Map<string, { label: string; kind: DevLogKind; machineId: string }>()
  const rows: DevLogHistoryRow[] = []
  for (const { e, loose } of ordered) {
    // A removal names the key as the log had it BEFORE: the remove entry's own label and kind are
    // chosen by whoever signed it, and say nothing checked.
    // When the add is outside what is known (offline, the newest entries only) it is named by its
    // fingerprint alone — an empty label, shown as "A device", and no kind or machine id of the signer's.
    const prior = e.op === 'remove' ? known.get(e.pub) : undefined
    const base = {
      seq: e.seq, pub: e.pub,
      kind: e.op === 'remove' ? prior?.kind ?? 'viewer' : e.kind,
      machineId: e.op === 'remove' ? prior?.machineId ?? '' : e.machineId,
      label: e.op === 'remove' ? prior?.label ?? '' : e.label, fingerprint: fp(e.pub), at: e.at,
      thisDevice: e.pub === ctx.selfPub,
      afterJoin: ctx.joinedSeq !== undefined && e.seq > ctx.joinedSeq,
      pending: ctx.pending.includes(e.pub),
      active: !!ctx.active[e.pub],
      whileFrozen: loose,
    }
    if (e.op === 'add') {
      const before = known.get(e.pub)
      const member = ctx.active[e.pub]
      if (before !== undefined || (member && member.seq < e.seq)) {
        rows.push({ ...base, op: 'renamed', ...(before !== undefined ? { previousLabel: before.label } : {}) })
      } else {
        rows.push({ ...base, op: 'added' })
      }
      known.set(e.pub, { label: e.label, kind: e.kind, machineId: e.machineId })
      labels.set(e.pub, e.label)
    } else if (e.signer === e.pub) {
      rows.push({ ...base, op: 'signedOut' })
      known.delete(e.pub)
    } else {
      const label = known.get(e.signer)?.label ?? labels.get(e.signer) ?? ''
      rows.push({ ...base, op: 'removed', by: { pub: e.signer, label, fingerprint: fp(e.signer) } })
      known.delete(e.pub)
    }
  }
  return rows.sort((a, b) => b.seq - a.seq)
}
