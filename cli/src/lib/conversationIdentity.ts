import { resolve } from 'node:path'
import { env } from '../config/env.js'
import { isTerminalEngine } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'

type Conversation = Pick<RegisteredSession, 'engine' | 'sessionId' | 'codexHome' | 'hermesHome'>

/** The same conversation, whether its default Codex home was recorded explicitly or left implicit. */
export function conversationKey(row: Conversation): string | null {
  if (!row.sessionId || isTerminalEngine(row.engine)) return null
  // Builder 3's restart was discovered with a null profile while its archive named ~/.codex.
  // Treating those as separate conversations left the stale picker entry refusing every Open.
  const profile = row.codexHome && resolve(row.codexHome) !== resolve(env.CODEX_HOME) ? row.codexHome : ''
  return [row.engine, profile, row.hermesHome ?? '', row.sessionId].join('\u0000')
}
