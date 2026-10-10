/**
 * Save an exact conversation identity while its native process still exists.
 *
 * Pause kills the engine, and afterwards there is nothing left to ask: the id the resume will need
 * has to be read out now. This runs for EVERY engine — it used to be claude and codex only, which is
 * why every other engine's pause archived whatever the registry happened to hold and its resume then
 * had nothing to reopen. `findLiveSession` already knows how to find a live session for all of them,
 * including the four that keep theirs in a database rather than a file.
 */
import { engineKeepsTranscriptFile, type RegisteredSession } from './registry.js'
import { controlTranscriptEvidence, savedTranscriptEvidence } from '../engines/transcriptBindings.js'
import { findLiveSession, findResumedTranscript, processSessionEvidence, type RepairedSession } from './sessionRepair.js'
import { resumeSessionId } from './tmux.js'
import { readProcessEvidence } from './processEvidence.js'
import { NativeEvidenceBudget, nativeUnavailable } from '../engines/kit/nativeEvidence.js'
import { isTerminalEngine } from '../engines/types.js'

export async function captureResumeIdentity(session: RegisteredSession): Promise<RegisteredSession> {
  // A shell holds no conversation; there is nothing here to capture for it.
  if (isTerminalEngine(session.engine)) return session
  const options = { codexHome: session.codexHome ?? undefined,
    ...(session.engine === 'pi' ? { cwd: session.cwd ?? undefined } : {}) }
  const keepsFile = engineKeepsTranscriptFile(session.engine)
  const verifiedPath = (id: string, path: string) => {
    const proof = savedTranscriptEvidence(session.engine, id, path, options.codexHome)
    proof.verify()
    if (proof.path) controlTranscriptEvidence(session.engine, id, proof.path, options.codexHome, session.cwd).verify()
    return proof.path
  }
  if (session.sessionId) {
    // A database-backed engine has the whole record already: the id IS the conversation.
    if (!keepsFile) return session
    if (session.transcriptPath) {
      const path = verifiedPath(session.sessionId, session.transcriptPath)
      if (path) return path === session.transcriptPath ? session : { ...session, transcriptPath: path }
    }
    const transcriptPath = await findResumedTranscript(session.engine, session.sessionId, options)
    const path = transcriptPath && verifiedPath(session.sessionId, transcriptPath)
    if (path) return { ...session, transcriptPath: path }
    if (session.engine === 'pi' && !session.transcriptPath) return session
    return nativeUnavailable('the saved conversation file is unavailable')
  }
  const expected = session.processIdentity
  if (!expected || !session.cwd) return session
  const budget = new NativeEvidenceBudget()
  const owner = await readProcessEvidence(expected.pid, budget, undefined, expected)
  const live = owner.parent
  if (!live) { await owner.verify(); return session }
  const explicit = resumeSessionId(session.engine, live.args, live.nativeArgv)
  // An engine whose process names its own session in a record (Claude Code's, removed at exit) is read now.
  const claim = await processSessionEvidence(session.engine, expected.pid, session.cwd, Date.parse(expected.startMarker), budget)
  const native = claim.session
  const found: RepairedSession | null = native ?? (explicit
    ? { sessionId: explicit, transcriptPath: await findResumedTranscript(session.engine, explicit, options) ?? undefined }
    : await findLiveSession(session.engine, session.cwd, Date.parse(expected.startMarker), {
      ...options, hermesHome: session.hermesHome ?? undefined, pid: expected.pid, bornOnly: true,
      expectedProcess: expected, nativeBudget: budget,
    }))
  // Codex's open-file finder verifies this owner, all candidate headers and its descriptor
  // pool together. Other finders still need this final process fence before a Stop may proceed.
  if (native || explicit || session.engine !== 'codex') await owner.verify()
  claim.verify()
  if (!found?.sessionId) return session
  // A file-backed engine still has to produce a transcript this daemon can point a resume at; a
  // database-backed one has nothing to check and is taken on its id alone.
  const transcriptPath = found.transcriptPath && keepsFile ? verifiedPath(found.sessionId, found.transcriptPath) : found.transcriptPath
  if (keepsFile && !transcriptPath) return nativeUnavailable('the observed conversation file is unavailable')
  return {
    ...session,
    sessionId: found.sessionId,
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(found.hermesHome ? { hermesHome: found.hermesHome } : {}),
    source: 'stop-repair',
    boundAt: Date.now(),
  }
}
