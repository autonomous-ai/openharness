/** Bounded handoff evidence shared by the core's commit and the edge's preparation. No history readers. */
import type { BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import type { AgentEngine } from '../engines/types.js'
import type { NativePathFact } from '../engines/kit/nativePaths.js'
import type { RegisteredSession } from './registry.js'

export interface NativeHandoffRead {
  ownerAgentId: string
  engine: AgentEngine
  sessionId: string
  path: string
  readPath: string
  profile?: string
  cwd: string | null
  fileKey: string
  version: string
  route: NativePathFact[]
}
export type HandoffSessionFact = { agentId: string; fingerprint: string }
export const handoffHash = (text: string): string => createHash('sha256').update(text).digest('hex')
export function handoffSessionFact(session: RegisteredSession): HandoffSessionFact {
  return { agentId: session.agentId, fingerprint: handoffHash(JSON.stringify([
    session.agentId, session.engine, session.sessionId, session.cwd, session.transcriptPath,
    session.registeredAt, session.boundAt, session.codexHome, session.hermesHome,
    session.processIdentity, session.runtimes, session.primaryRuntimeKey, session.forkedFrom,
    session.evidenceRevision, session.identityHold,
  ])) }
}

export const nativeContentVersion = (info: BigIntStats): string =>
  `${info.dev}:${info.ino}:${info.mode}:${info.uid}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
export type HandoffIntent = { agentId: string; changeId: string; targetEngine: string }
export type HandoffOutcome = { file: string | null; gitRepo: boolean; cwd: string; degraded: Array<'transcript' | 'git' | 'file'> }
export type HandoffProject = { cwd: string; path: string; fileKey: string; route: NativePathFact[] }
export type HandoffExclude = { path: string; before: string | null; after: string; route: NativePathFact[]; version: string | null }
export type HandoffGit = { exclude: string | null; route: NativePathFact[]; files: Array<{ path: string; version: string }> }
export interface PreparedHandoff {
  git: HandoffGit
  request: HandoffIntent
  sessions: HandoffSessionFact[]
  reads: NativeHandoffRead[]
  project: HandoffProject
  result: HandoffOutcome
  documents: { markdown: string; transcript: string } | null
  exclude: HandoffExclude | null
}
/** In process this closure belongs to the trusted service request handler. Across processes
 * only the routed request id travels; core reconstructs its own live request witness. */
export type HandoffPermit = { requestId?: string; current(request: HandoffIntent): boolean }
export class HandoffError extends Error {
  constructor(readonly code: 'UNKNOWN_AGENT' | 'NO_PROJECT' | 'BAD_CHANGE_ID' | 'BUSY' | 'TIMEOUT'
    | 'IDENTITY_UNAVAILABLE' | 'HANDOFF_UNAVAILABLE' | 'CHANGE_CONFLICT') {
    super(`handoff: ${code}`)
    this.name = 'HandoffError'
  }
}
export const handoffBaseName = (agentId: string, changeId: string): string =>
  `${agentId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'agent'}-${changeId}`
/** The same explicit intent keeps its durably reserved snapshot as native text appends. Original
 * content versions authorize the reservation; current owner, header, route and key fence recovery. */
export function handoffIntentHash(prepared: PreparedHandoff): string {
  const route = (facts: NativePathFact[]) => facts.map(fact => [fact.path, fact.identity,
    fact.alias ? [fact.alias.target, fact.alias.version] : null])
  const { request, project, git } = prepared
  return handoffHash(JSON.stringify([[request.agentId, request.changeId, request.targetEngine],
    prepared.sessions.map(fact => [fact.agentId, fact.fingerprint]),
    [project.cwd, project.path, project.fileKey, route(project.route)],
    [git.exclude, route(git.route), git.files.map(file => [file.path, file.version])],
    prepared.reads.map(read => [read.ownerAgentId, read.engine, read.sessionId, read.path, read.readPath,
      read.profile ?? null, read.cwd, read.fileKey, route(read.route)])]))
}

export function handoffExcludeText(before: string | null): string {
  const existing = before ?? '', pattern = '**/.harness/handoff/'
  return existing.split(/\r?\n/).some(line => line.trim() === pattern) ? existing
    : existing + (existing && !existing.endsWith('\n') ? '\n' : '') + `\n# Harness agent handoffs (untracked)\n${pattern}\n`
}
