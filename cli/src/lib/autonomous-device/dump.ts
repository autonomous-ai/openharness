import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { env } from '../../config/env.js'

/**
 * Diagnostic dump of every frame between this daemon and a paired Autonomous device, one JSON object
 * per line. OFF unless `HARNESS_DEVICE_DUMP` is set (`harness start --device-dump[=<file>]` sets it).
 *
 * ⚠️ Frames are recorded in the CLEAR — before the E2EE wrap on the way out, after the unwrap on the
 * way in — so the file holds prompts, answers, tool arguments and file paths. Created 0600; delete it
 * when done. Frames still sealed on the wire (the handshake, a reply this daemon wrapped elsewhere) are
 * recorded as they travel.
 *
 * `layer` says which protocol a line belongs to:
 *   rpc       device RPC proto 1 (`autonomous_device_request/_result/_event`), decrypted
 *   legacy    browser-shaped RPCs a device session sends (agents_list, message, …) and their replies
 *   commander device-audience broadcast (commander_event/question, agent_*), before group encryption
 *   wire      anything else to/from a device connection as it travels (e2e_* handshake, rekey, …)
 */
export type DumpDirection = 'in' | 'out'
export type DumpLayer = 'rpc' | 'legacy' | 'commander' | 'wire'
const MAX_BYTES = 256 * 1024 * 1024

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
/** `1`/`true` → a fresh file in the logs dir; anything else non-empty → that path. */
export function resolveDumpPath(value: string | undefined, logsDir = env.HARNESS_LOGS_DIR): string | null {
  const v = value?.trim()
  if (!v || v === '0' || v === 'false') return null
  return v === '1' || v === 'true' ? join(logsDir, `device-dump-${stamp()}.jsonl`) : resolve(v)
}
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString('base64') }
  return value
}

export class DeviceDump {
  private fd: number | null = null
  private bytes = 0
  private resolved = false
  private path: string | null = null
  constructor(private readonly source: () => string | undefined = () => process.env.HARNESS_DEVICE_DUMP) {}

  /** Resolved lazily: `harness start -f` sets the variable after this module is imported. */
  get enabled(): boolean {
    if (!this.resolved) {
      this.resolved = true
      this.path = resolveDumpPath(this.source())
      if (this.path) {
        try {
          mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
          this.fd = openSync(this.path, 'a', 0o600)
          console.log(`[device-dump] recording device traffic IN THE CLEAR to ${this.path}`)
        } catch (e) {
          console.error(`[device-dump] cannot open ${this.path}: ${e instanceof Error ? e.message : e}`)
          this.path = null
        }
      }
    }
    return this.fd !== null
  }
  get file(): string | null { return this.enabled ? this.path : null }

  record(dir: DumpDirection, layer: DumpLayer, connId: string | undefined, frame: unknown): void {
    if (!this.enabled) return
    const type = frame && typeof frame === 'object' && typeof (frame as { type?: unknown }).type === 'string' ? (frame as { type: string }).type : undefined
    const via = !connId ? 'broadcast' : connId.startsWith('autonomous-direct:') ? 'direct' : 'relay'
    let line: string
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), dir, via, layer, ...(connId ? { conn: connId } : {}), ...(type ? { type } : {}), frame }, replacer) + '\n'
    } catch {
      line = JSON.stringify({ ts: new Date().toISOString(), dir, via, layer, conn: connId, type, error: 'unserializable frame' }) + '\n'
    }
    try {
      const size = Buffer.byteLength(line)
      if (this.bytes + size > MAX_BYTES) {
        writeSync(this.fd!, JSON.stringify({ ts: new Date().toISOString(), note: `size cap ${MAX_BYTES} bytes reached; recording stopped` }) + '\n')
        this.close()
        return
      }
      writeSync(this.fd!, line)
      this.bytes += size
    } catch { this.close() }
  }
  close(): void {
    if (this.fd !== null) { try { closeSync(this.fd) } catch { /* already gone */ } }
    this.fd = null
  }
}

export const deviceDump = new DeviceDump()
