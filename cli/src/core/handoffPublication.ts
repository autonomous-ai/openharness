/** Core owns current selection authority and the last synchronous commit, never history interpretation. */
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { controlTranscriptEvidence, transcriptEvidence } from '../engines/transcriptBindings.js'
import { NativeFiles } from '../engines/kit/nativeFiles.js'
import { nativeFileKey, verifyNativePathFacts } from '../engines/kit/nativePaths.js'
import { HandoffError, handoffExcludeText, handoffSessionFact, nativeContentVersion,
  type HandoffPermit, type PreparedHandoff } from '../lib/handoffAuthority.js'
import { handoffGitRoute } from '../lib/handoffGit.js'
import { verifyHandoffVersion } from '../lib/handoffFiles.js'
import { isSubagentTranscript } from '../lib/subagentTranscript.js'
import { SQLITE_BACKED_ENGINES } from '../lib/sqliteRead.js'
import { publishHandoff } from '../lib/handoffPublication.js'
import { validateHandoff } from '../lib/handoffValidation.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { TurnSource } from '../lib/sessionSearch/sessionTurns.js'

export interface HandoffPublicationDeps {
  directory: string
  resolve(agentId: string): RegisteredSession | null | undefined
  ownedByOther(sessionId: string, agentId: string): boolean
  isRecentlyDeleted(sessionId: string): boolean
  now?(): number
}
const hold = (): never => { throw new HandoffError('IDENTITY_UNAVAILABLE') }
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
export function createHandoffPublisher(deps: HandoffPublicationDeps) {
  const now = deps.now ?? (() => performance.now())
  const discoveries = new Map<string, { found: Pick<TurnSource, 'engine' | 'sessionId' | 'transcriptPath'> | null; until: number }>()
  const located = new Map<string, { path: string | null; until: number }>()
  const locatorKey = (engine: string, id: string, profile?: string) => JSON.stringify([engine, id, profile ?? null])
  const selected = (engine: string, id: string, profile: string | undefined, path: string | null): void => {
    for (const [key, value] of located) if (value.until < now()) located.delete(key)
    const key = locatorKey(engine, id, profile)
    if (!located.has(key) && located.size >= 128) throw new HandoffError('HANDOFF_UNAVAILABLE')
    located.set(key, { path, until: now() + 5_000 })
  }
  const observed = (session: RegisteredSession, source: TurnSource | null): void => {
    for (const [key, value] of discoveries) if (value.until < now()) discoveries.delete(key)
    if (!discoveries.has(handoffSessionFact(session).fingerprint) && discoveries.size >= 128) throw new HandoffError('HANDOFF_UNAVAILABLE')
    discoveries.set(handoffSessionFact(session).fingerprint, { found: source && {
      engine: source.engine, sessionId: source.sessionId, transcriptPath: source.transcriptPath }, until: now() + 5_000 })
  }
  const publish = (prepared: PreparedHandoff, permit: HandoffPermit) => {
    try {
      validateHandoff(prepared)
      const request = prepared.request
      const verify = (facts: PreparedHandoff, reserved: boolean): void => {
        validateHandoff(facts)
        if (facts.request.agentId !== request.agentId || facts.request.changeId !== request.changeId
          || facts.request.targetEngine !== request.targetEngine || !permit.current(request)) throw new HandoffError('HANDOFF_UNAVAILABLE')
        const records = facts.sessions.map(session => {
          const current = deps.resolve(session.agentId)
          if (!current || current.identityHold || handoffSessionFact(current).fingerprint !== session.fingerprint) return hold()
          return current
        })
        const root = records[0]
        if (root.cwd !== facts.project.cwd) return hold()
        const files = new NativeFiles(), project = files.locate(root.cwd!)!
        if (!project.info.isDirectory() || project.path !== facts.project.path || nativeFileKey(project.info) !== facts.project.fileKey) return hold()
        files.verify(); verifyNativePathFacts(facts.project.route)
        if (!same(files.paths.snapshot(), facts.project.route)) return hold()
        if (!same(handoffGitRoute(project.path), facts.git) || facts.result.gitRepo !== (facts.git.exclude !== null)
          || facts.documents && facts.result.gitRepo && !facts.exclude || facts.exclude && (facts.exclude.path !== facts.git.exclude || facts.exclude.after !== handoffExcludeText(facts.exclude.before))) return hold()
        let cut = Infinity
        for (let index = 0; index < records.length; index++) {
          const owner = records[index], reads = facts.reads.filter(read => read.ownerAgentId === owner.agentId)
          if (reads.length > 1) return hold()
          let id = owner.sessionId, selectedPath = owner.transcriptPath
          if (index > 0) {
            const child = records[index - 1], link = child.forkedFrom
            if (!link || typeof link !== 'object' || link.agentId !== owner.agentId
              || new NativeFiles().locate(owner.cwd!)?.path !== project.path) return hold()
            cut = Math.min(cut, child.registeredAt)
            if (!Number.isFinite(cut)) return hold()
            if (link.sessionId) id = link.sessionId
            else if (id && !(typeof owner.boundAt === 'number' && owner.boundAt <= cut)) return hold()
            if (id) {
              const candidates = link.sessionId ? [link.transcriptPath?.includes(id) ? link.transcriptPath : null,
                owner.sessionId === id ? owner.transcriptPath : null] : [owner.transcriptPath]
              selectedPath = candidates.find(path => {
                if (!path || isSubagentTranscript(path)) return false
                const proof = transcriptEvidence(owner.engine, path, owner.codexHome ?? undefined)
                proof.verify(); return proof.valid
              }) ?? null
              if (!selectedPath) {
                const found = located.get(locatorKey(owner.engine, id, owner.codexHome ?? undefined))
                if (found && found.until >= now()) selectedPath = found.path
              }
            }
          }
          const discovered = discoveries.get(facts.sessions[index].fingerprint)
          if (!id && index === 0 && !root.forkedFrom && discovered && discovered.until >= now()) {
            id = discovered.found?.sessionId ?? ''
            if (reads[0] && (!discovered.found || discovered.found.engine !== reads[0].engine
              || discovered.found.transcriptPath !== reads[0].path)) return hold()
          }
          if (!reads.length) {
            // A known file must be observed even when its body is empty. An unbound root needs an
            // actual core discovery result; a worker cannot manufacture an empty conversation.
            if (id && (!(SQLITE_BACKED_ENGINES as readonly string[]).includes(owner.engine) || index > 0)
              || index === 0 && !id && !root.forkedFrom && (!discovered || discovered.until < now() || discovered.found)) return hold()
            continue
          }
          const read = reads[0]
          if (!id || read.sessionId !== id || read.engine !== owner.engine || read.profile !== (owner.codexHome ?? undefined)
            || read.cwd !== owner.cwd || (index > 0 || owner.sessionId) && read.path !== selectedPath
            || deps.ownedByOther(id, owner.agentId) || deps.isRecentlyDeleted(id)) return hold()
          const proof = controlTranscriptEvidence(read.engine, read.sessionId, read.path, read.profile, read.cwd)
          const current = new NativeFiles(); current.locate(read.path)
          const file = current.file(proof.path)!
          if (file.path !== read.readPath || nativeFileKey(file.info) !== read.fileKey
            || !reserved && nativeContentVersion(file.info) !== read.version) return hold()
          current.verify(read.path); proof.verify(read.fileKey); verifyNativePathFacts(read.route)
          if (!same(current.paths.snapshot(), read.route)) return hold()
          verifyHandoffVersion(read, reserved ? nativeContentVersion(file.info) : read.version)
        }
        const last = records.at(-1)!
        if (last.forkedFrom && !facts.reads.some(read => read.ownerAgentId === last.agentId)) return hold()
        if (facts.reads.some(read => !records.some(owner => owner.agentId === read.ownerAgentId))) return hold()
        if (!permit.current(request)) throw new HandoffError('HANDOFF_UNAVAILABLE')
      }
      return publishHandoff(join(deps.directory, 'handoff-receipts'), prepared, verify)
    } catch (error) {
      if (error instanceof HandoffError) throw error
      return hold()
    }
  }
  return Object.assign(publish, { observed, selected })
}
