/**
 * Core's submission evidence: an engine's reading of its composer after a paste, and of a turn's prompt as
 * it recorded it. Core passes plain text and keeps every verdict (lib/sessionInput.ts, core/deviceInput.ts);
 * an answer is fenced to the session binding it was asked under and never cached.
 */
import { sessionBinding as identity } from './sessionBinding.js'
import type { EngineSubmission, SubmissionPolicy } from '../../engines/facets/submission.js'
import type { AgentEngine } from '../../engines/types.js'
import { submissionCapture, submissionText } from '../../engines/worker/submissionProtocol.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { SubmissionReader } from '../../lib/submissionReader.js'
import type { SubmissionTransport } from './submissionTransport.js'

export interface SubmissionDeps {
  /** The declared timing (engines/submissionPolicies.ts), passed in so the input path loads no engine. */
  policy(engine: string): SubmissionPolicy | undefined
  /** The engine's readings run in its supervised worker. */
  handles(engine: AgentEngine): boolean
  transport: Pick<SubmissionTransport, 'read' | 'echo'>
  resolve(id: string): RegisteredSession | undefined
  /** Explicit inline mode and older masters only; a failed worker never selects it. */
  inline(engine: AgentEngine): EngineSubmission | undefined
}

export function createSubmissions(deps: SubmissionDeps): SubmissionReader {
  const fenced = async <T>(session: RegisteredSession, ask: (engine: AgentEngine) => Promise<T> | T | undefined): Promise<T | null> => {
    const key = identity(session), agentId = session.agentId
    if (!agentId || identity(deps.resolve(agentId)) !== key) return null
    try {
      const answer = await ask(session.engine)
      return answer !== undefined && identity(deps.resolve(agentId)) === key ? answer : null
    } catch { return null }
  }
  return {
    policy: engine => deps.policy(engine),
    read: (session, capture, prompt) => !submissionCapture(capture) || !submissionText(prompt) ? Promise.resolve(null)
      : fenced(session, engine => deps.handles(engine) ? deps.transport.read(engine, capture, prompt) : deps.inline(engine)?.read(capture, prompt)),
    echo: (session, recorded) => !submissionText(recorded) ? Promise.resolve(null)
      : fenced(session, engine => deps.handles(engine) ? deps.transport.echo(engine, recorded) : deps.inline(engine)?.echo(recorded)),
  }
}
