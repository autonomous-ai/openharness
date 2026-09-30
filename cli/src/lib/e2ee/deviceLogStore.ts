/**
 * This machine's copy of its account's device key log (deviceLog.ts): the verified state, the last few
 * entries (to hand a peer that is behind, over `group_sync`), and whether the log is frozen.
 *
 * Persistence mirrors machinePeers.ts: ${ADAPTER_DATA_DIR}/e2e/devlog.json, 0600, never cached — the
 * daemon and a short-lived `harness devices …` process both read and write it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { env } from '../../config/env.js'
import type { DevLogEntry, DevLogHead, DevLogState } from './deviceLog.js'

/** How many of the newest entries are kept verbatim, for a peer that is behind. */
export const DEVLOG_RECENT = 64

export interface DevLogFreeze {
  /** 'fork' — two different entries at one position; 'rollback' — the backend served a log older than
   *  one already verified; 'invalid' — the backend served an entry that breaks a rule. */
  reason: 'fork' | 'rollback' | 'invalid'
  at: number
  /** The last head this machine verified before it froze. */
  lastGoodHead: DevLogHead
}

export interface DevLogFile {
  state: DevLogState | null
  recent: DevLogEntry[]
  frozen: DevLogFreeze | null
  /** Entries up to this seq have been announced ("New device: X") — never twice. */
  notifiedUpTo: number
}

const empty = (): DevLogFile => ({ state: null, recent: [], frozen: null, notifiedUpTo: 0 })

export class DeviceLogStore {
  constructor(private readonly file = join(env.ADAPTER_DATA_DIR, 'e2e', 'devlog.json')) {}

  read(): DevLogFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<DevLogFile>
      return {
        state: raw.state && typeof raw.state === 'object' ? raw.state : null,
        recent: Array.isArray(raw.recent) ? raw.recent : [],
        frozen: raw.frozen && typeof raw.frozen === 'object' ? raw.frozen : null,
        notifiedUpTo: typeof raw.notifiedUpTo === 'number' ? raw.notifiedUpTo : 0,
      }
    } catch { return empty() }
  }

  write(next: DevLogFile): void {
    mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(this.file, JSON.stringify({ ...next, recent: next.recent.slice(-DEVLOG_RECENT) }), { mode: 0o600 })
  }

  update(change: (current: DevLogFile) => DevLogFile): DevLogFile {
    const next = change(this.read())
    this.write(next)
    return next
  }
}
