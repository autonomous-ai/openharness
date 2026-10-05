/**
 * The engines that keep a conversation in a database instead of a transcript file, read through
 * the same readers and replay normalizers as `session_get`.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 13: docs/design/2026-10-03-harnessd.md).
 */
import { join } from 'node:path'
import { env } from '../../config/env.js'
import { devinMessagesToEvents } from '../../engines/devin/normalizer.js'
import { readDevinMessages } from '../../engines/devin/reader.js'
import { hermesMessagesToEvents } from '../../engines/hermes/normalizer.js'
import { readHermesMessages } from '../../engines/hermes/reader.js'
import { kiloMessagesToEvents } from '../../engines/kilo/normalizer.js'
import { readKiloMessages } from '../../engines/kilo/reader.js'
import { opencodeMessagesToEvents } from '../../engines/opencode/normalizer.js'
import { readOpencodeMessages } from '../../engines/opencode/reader.js'
import { hermesDbForSession } from '../../lib/hermesHome.js'
import type { LiveEvent } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'

export const databaseHistory = (s: RegisteredSession): (() => Promise<readonly LiveEvent[]>) | undefined => {
  switch (s.engine) {
    case 'opencode': return async () => opencodeMessagesToEvents(await readOpencodeMessages(join(env.OPENCODE_DATA_DIR, 'opencode.db'), s.sessionId))
    case 'kilo': return async () => kiloMessagesToEvents(await readKiloMessages(join(env.KILO_DATA_DIR, 'kilo.db'), s.sessionId))
    case 'devin': return async () => devinMessagesToEvents(await readDevinMessages(join(env.DEVIN_HOME, 'sessions.db'), s.sessionId))
    case 'hermes': return async () => hermesMessagesToEvents(await readHermesMessages(await hermesDbForSession(s), s.sessionId))
    default: return undefined
  }
}
