/** Save an exact conversation identity while its native process still exists. */
import { validTranscriptPath, type RegisteredSession } from './registry.js'
import { claudeProcessSession, findLiveSession, findResumedTranscript } from './sessionRepair.js'
import { processRows, resumeSessionId } from './tmux.js'

export async function captureResumeIdentity(session: RegisteredSession): Promise<RegisteredSession> {
  if (session.engine !== 'claude' && session.engine !== 'codex') return session
  const options = { codexHome: session.codexHome ?? undefined }
  if (session.sessionId) {
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
  if (!found?.transcriptPath || !validTranscriptPath(session.engine, found.transcriptPath, options.codexHome)) return session
  return { ...session, sessionId: found.sessionId, transcriptPath: found.transcriptPath, source: 'stop-repair', boundAt: Date.now() }
}
