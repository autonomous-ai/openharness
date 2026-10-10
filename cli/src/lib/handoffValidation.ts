/** Reject malformed preparations before any filesystem work. These values cross a JSON boundary. */
import { isAbsolute } from 'node:path'
import { ENGINES } from '../engines/types.js'
import { HandoffError, handoffBaseName, type PreparedHandoff } from './handoffAuthority.js'
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
export const handoffShape = (value: unknown, keys: readonly string[]): value is Record<string, any> =>
  object(value) && Object.keys(value).length <= keys.length && Object.keys(value).every(key => keys.includes(key))
const string = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0') && Buffer.byteLength(value) <= max
const text = (value: unknown, max = 4096): value is string => string(value, max) && value.length > 0
const path = (value: unknown): value is string => text(value) && isAbsolute(value)
const hex = (value: unknown) => text(value, 64) && /^[a-f0-9]{64}$/.test(value)
const list = (value: unknown, max: number, valid: (item: any) => boolean): boolean => Array.isArray(value) && value.length <= max && value.every(valid)
const engine = (value: unknown) => (ENGINES as readonly unknown[]).includes(value)
export const handoffRoute = (value: unknown) => Array.isArray(value) && value.length > 0 && list(value, 256, fact => handoffShape(fact, ['path', 'identity', 'alias']) && path(fact.path)
  && (fact.identity === null || text(fact.identity, 256)) && (fact.alias === undefined || handoffShape(fact.alias, ['target', 'version']) && text(fact.alias.target) && text(fact.alias.version, 256)))
const route = handoffRoute
export function validateHandoff(value: unknown): asserts value is PreparedHandoff {
  const fail = (): never => { throw new HandoffError('IDENTITY_UNAVAILABLE') }
  if (!handoffShape(value, ['request', 'sessions', 'reads', 'project', 'result', 'documents', 'exclude', 'git'])) return fail()
  const { request, sessions, reads, project, result, documents, exclude, git } = value
  if (!handoffShape(request, ['agentId', 'changeId', 'targetEngine']) || !text(request.agentId, 200) || !text(request.changeId, 32) || !/^[a-f0-9]{32}$/.test(request.changeId)
    || !engine(request.targetEngine) || !Array.isArray(sessions) || !sessions.length
    || !list(sessions, 6, fact => handoffShape(fact, ['agentId', 'fingerprint']) && text(fact.agentId, 200) && hex(fact.fingerprint))
    || sessions[0].agentId !== request.agentId || new Set(sessions.map(fact => fact.agentId)).size !== sessions.length
    || !list(reads, 6, read => handoffShape(read, ['ownerAgentId', 'engine', 'sessionId', 'path', 'readPath', 'profile', 'cwd', 'fileKey', 'version', 'route']) && text(read.ownerAgentId, 200) && engine(read.engine) && text(read.sessionId, 200)
      && path(read.path) && path(read.readPath) && (read.profile === undefined || path(read.profile))
      && (read.cwd === null || path(read.cwd)) && text(read.fileKey, 128) && text(read.version, 256) && route(read.route))
    || !handoffShape(project, ['cwd', 'path', 'fileKey', 'route']) || !path(project.cwd) || !path(project.path) || !text(project.fileKey, 128) || !route(project.route)
    || !handoffShape(result, ['cwd', 'file', 'gitRepo', 'degraded']) || result.cwd !== project.cwd || typeof result.gitRepo !== 'boolean'
    || !list(result.degraded, 3, item => ['git', 'transcript', 'file'].includes(item))
    || !handoffShape(git, ['exclude', 'route', 'files']) || !(git.exclude === null || path(git.exclude)) || !route(git.route)
    || !list(git.files, 2, file => handoffShape(file, ['path', 'version']) && path(file.path) && text(file.version, 256))) return fail()
  if (documents === null ? result.file !== null : !handoffShape(documents, ['markdown', 'transcript'])
    || result.file !== `.harness/handoff/${handoffBaseName(request.agentId, request.changeId)}.md`
    || !string(documents.markdown, 512 * 1024) || !string(documents.transcript, 8 * 1024 * 1024)) return fail()
  if (exclude !== null && (!handoffShape(exclude, ['path', 'before', 'after', 'route', 'version']) || !path(exclude.path) || !route(exclude.route)
    || !(exclude.before === null || string(exclude.before, 128 * 1024)) || !string(exclude.after, 129 * 1024)
    || !(exclude.version === null || text(exclude.version, 256)))) return fail()
}
