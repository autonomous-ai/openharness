import { join as hookPath } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'
/**
 * What the core knows of kimi without loading its code: declared data, read in line on the hook path
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing of kimi's code.
 */
import { existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** A session id: `session_<uuid>`, measured in SessionStart payloads and on-disk session dirs. */
export const KIMI_SESSION_ID = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `<KIMI_CODE_HOME>/sessions/<workspaceId>/<sessionId>/agents/main/wire.jsonl`. */
export function kimiTranscriptPath(kimiCodeHome: string, sessionId: string): string | null {
  if (!KIMI_SESSION_ID.test(sessionId)) return null
  const root = join(kimiCodeHome, 'sessions')
  try {
    for (const bucket of readdirSync(root, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue
      const wire = join(root, bucket.name, sessionId, 'agents', 'main', 'wire.jsonl')
      if (existsSync(wire)) return wire
    }
  } catch { /* absent root: nothing to scan */ }
  return null
}

/**
 * The wire's path derived from the session id and the cwd, before the file exists. The workspace
 * bucket is `wd_<slug>_<first 12 hex of sha256(realpath(cwd))>` (measured on three real sessions);
 * the slug is the bucket's only unmeasured part, so the bucket is found by its hash suffix rather
 * than recomputed. SessionStart fires before the first wire line is flushed — interactive sessions
 * write the file seconds after the hook — so discovery derives instead of waiting a turn.
 */
export function kimiDerivedTranscript(kimiCodeHome: string, sessionId: string, cwd: string): string | null {
  if (!KIMI_SESSION_ID.test(sessionId) || !cwd) return null
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  const root = join(kimiCodeHome, 'sessions')
  try {
    for (const bucket of readdirSync(root, { withFileTypes: true })) {
      if (bucket.isDirectory() && bucket.name.endsWith(`_${hash}`)) {
        return join(root, bucket.name, sessionId, 'agents', 'main', 'wire.jsonl')
      }
    }
  } catch { /* absent root: nothing to scan */ }
  return null
}

/**
 * Kimi's hooks are [[hooks]] arrays-of-tables in the user config.toml. SessionStart fires for
 * startup AND resume; Stop is deliberately NOT installed — the wire's own turn.ended record is the
 * authoritative boundary (Stop can fire while final records are still being persisted); StopFailure
 * is the error backstop. Sub-agent events carry the parent's session id and are not installed.
 * Only the marked block is replaced (kit/nativeHookToml.ts).
 */
export const KIMI_HOOK_SETTINGS = {
  file: hookPath(hookEnvironment.KIMI_CODE_HOME, 'config.toml'),
  engine: 'kimi',
  events: ['SessionStart', 'SessionEnd', 'StopFailure'],
  timeout: 5,
  startMarker: '# harness:kimi-hooks:start',
  endMarker: '# harness:kimi-hooks:end',
  messages: {
    current: '[hooks] kimi lifecycle hooks already installed',
    installed: '[hooks] installed kimi lifecycle hooks → {file}',
    after: '[hooks] (takes effect on the next kimi session start)',
    failed: '[hooks] failed to write kimi hook file:',
    malformed: [
      '[hooks] kimi config.toml is invalid TOML; leaving it unchanged: {file}',
      '[hooks] fix the file, then restart harness login',
    ],
  },
} as const satisfies import('../kit/nativeHookToml.js').NativeHookTomlSettings
