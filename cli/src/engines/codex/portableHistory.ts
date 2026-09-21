import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { resolveCodexRollout } from './rollout.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Match the relay's portable_reasoning_item contract. Plaintext engine reasoning has no
 * vendor-stored id; encrypted vendor reasoning must keep its original fields. */
function repairReasoning(item: unknown): boolean {
  if (!object(item) || item.type !== 'reasoning' || item.encrypted_content) return false
  let changed = false
  if ('id' in item) {
    delete item.id
    changed = true
  }
  if (Array.isArray(item.content) && item.content.length) {
    const text = item.content.map((part) => object(part) && typeof part.text === 'string' ? part.text : '').join('')
    item.content = []
    if (text && (!Array.isArray(item.summary) || !item.summary.length)) {
      item.summary = [{ type: 'summary_text', text }]
    }
    changed = true
  }
  return changed
}

/** Only replayed API items are repaired. Other records (including readable event history) and
 * unchanged lines retain their exact bytes. Invalid JSON aborts the whole repair. */
export function portableCodexHistory(history: string, sessionId: string): { history: string; repairedItems: number } {
  let sawMeta = false
  let repairedItems = 0
  const lines = history.split('\n').map((line, index) => {
    if (!line.trim()) return line
    let record: unknown
    try { record = JSON.parse(line) } catch {
      // JSON.parse's own error can quote conversation text; keep it out of daemon logs.
      throw new Error(`invalid JSON in Codex rollout at line ${index + 1}`)
    }
    if (!object(record)) throw new Error('invalid Codex rollout record')
    if (!sawMeta) {
      if (record.type !== 'session_meta' || !object(record.payload) || record.payload.id !== sessionId) {
        throw new Error('Codex rollout does not belong to the session being resumed')
      }
      sawMeta = true
    }
    const items = record.type === 'response_item' ? [record.payload]
      : record.type === 'compacted' && object(record.payload) && Array.isArray(record.payload.replacement_history)
        ? record.payload.replacement_history : []
    let changed = false
    for (const item of items) {
      if (repairReasoning(item)) { repairedItems++; changed = true }
    }
    return changed ? JSON.stringify(record) + (line.endsWith('\r') ? '\r' : '') : line
  })
  if (!sawMeta) throw new Error('Codex rollout has no session metadata')
  return { history: lines.join('\n'), repairedItems }
}

export interface CodexResumeSource {
  engine: string
  sessionId: string
  transcriptPath?: string | null
  codexHome?: string | null
}

/** Call only after the session's engine has stopped, before launching `codex resume`.
 * Retargeting to the native subscription bypasses Grid, so response-side relay cleanup cannot
 * repair items already persisted here. A private backup precedes an atomic replacement.
 *
 * `repairedBytes` (set only when items were repaired) is the on-disk length of the rewritten
 * rollout. A live tailer of this same file must move its offset there before the engine relaunches:
 * the repair shrinks the file mid-history, which an append-only byte tail would otherwise mistake
 * for a truncation and replay in full. */
export function prepareCodexResume(source: CodexResumeSource): { repairedItems: number; repairedBytes?: number; backupPath?: string } {
  if (source.engine !== 'codex' || !source.sessionId) return { repairedItems: 0 }
  const sessions = join(source.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
  let file = source.transcriptPath || resolveCodexRollout(source.sessionId, sessions)
  // A missing history still follows the engine's existing resume/fresh fallback.
  if (!file) return { repairedItems: 0 }
  let before: ReturnType<typeof lstatSync>
  try { before = lstatSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // The registry may still point at a rollout that was moved; Codex resolves the session by id.
    file = resolveCodexRollout(source.sessionId, sessions)
    if (!file) return { repairedItems: 0 }
    before = lstatSync(file)
  }
  const rel = relative(realpathSync(sessions), realpathSync(file))
  if (!before.isFile() || before.isSymbolicLink() || isAbsolute(rel) || rel === '..' || rel.startsWith('../')
    || (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
    throw new Error('Codex rollout is outside the session profile or is not an owned regular file')
  }
  const original = readFileSync(file, 'utf8')
  const repaired = portableCodexHistory(original, source.sessionId)
  if (!repaired.repairedItems) return { repairedItems: 0 }

  const suffix = randomUUID()
  const backupPath = `${file}.reasoning-backup-${suffix}`
  const temporary = `${file}.reasoning-tmp-${suffix}`
  // Writing the bytes we inspected avoids copying a concurrent writer's partial record.
  writeFileSync(backupPath, original, { flag: 'wx', mode: 0o600, flush: true })
  try {
    writeFileSync(temporary, repaired.history, { flag: 'wx', mode: 0o600, flush: true })
    const current = lstatSync(file)
    if (current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size
      || current.mtimeMs !== before.mtimeMs || readFileSync(file, 'utf8') !== original) {
      throw new Error('Codex rollout changed during resume preparation; retry after its writer stops')
    }
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
  return { repairedItems: repaired.repairedItems, repairedBytes: Buffer.byteLength(repaired.history, 'utf8'), backupPath }
}
