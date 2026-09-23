/**
 * Save an exact conversation identity while its native process still exists.
 *
 * Pause kills the engine, and afterwards there is nothing left to ask: the id the resume will need
 * has to be read out now. This runs for EVERY engine — it used to be claude and codex only, which is
 * why every other engine's pause archived whatever the registry happened to hold and its resume then
 * had nothing to reopen. `findLiveSession` already knows how to find a live session for all of them,
 * including the four that keep theirs in a database rather than a file.
 */
import { engineKeepsTranscriptFile, validTranscriptPath, type RegisteredSession } from './registry.js'
import { claudeProcessSession, findLiveSession, findResumedTranscript } from './sessionRepair.js'
import { processRows, resumeSessionId } from './tmux.js'
import { isTerminalEngine } from '../engines/types.js'

export async function captureResumeIdentity(session: RegisteredSession): Promise<RegisteredSession> {
  // A shell holds no conversation; there is nothing here to capture for it.
  if (isTerminalEngine(session.engine)) return session
  const options = { codexHome: session.codexHome ?? undefined }
  const keepsFile = engineKeepsTranscriptFile(session.engine)
  if (session.sessionId) {
    // A database-backed engine has the whole record already: the id IS the conversation.
    if (!keepsFile) return session
    if (session.transcriptPath && validTranscriptPath(session.engine, session.transcriptPath, options.codexHome)) return session
    const transcriptPath = await findResumedTranscript(session.engine, session.sessionId, options)
    return transcriptPath && validTranscriptPath(session.engine, transcriptPath, options.codexHome)
      ? { ...session, transcriptPath } : session
  }
  const expected = session.processIdentity
  if (!expected || !session.cwd) return session
  const live = (await processRows())?.find(row => row.pid === expected.pid
    && row.executable === expected.executable && row.startMarker === expected.startMarker)
  if (!live) return session
  const explicit = resumeSessionId(session.engine, live.args)
  const native = session.engine === 'claude'
    ? await claudeProcessSession(expected.pid, session.cwd, Date.parse(expected.startMarker)) : null
  const found = native ?? (explicit
    ? { sessionId: explicit, transcriptPath: await findResumedTranscript(session.engine, explicit, options) }
    : await findLiveSession(session.engine, session.cwd, Date.parse(expected.startMarker), {
      ...options, pid: expected.pid, bornOnly: true,
    }))
  if (!found?.sessionId) return session
  // A file-backed engine still has to produce a transcript this daemon can point a resume at; a
  // database-backed one has nothing to check and is taken on its id alone.
  if (keepsFile && (!found.transcriptPath || !validTranscriptPath(session.engine, found.transcriptPath, options.codexHome))) return session
  return {
    ...session,
    sessionId: found.sessionId,
    ...(found.transcriptPath ? { transcriptPath: found.transcriptPath } : {}),
    source: 'stop-repair',
    boundAt: Date.now(),
  }
}
