/** Aggregate usage observations. No transcript readers, parsers, SQLite or live state. */
import { validWorkPath as path, validPullRequestUrl } from './sessionWorkWire.js'
import type { RegisteredSession } from './registry.js'
import type { AgentOutputStats } from './agentOutputStats.js'
import type { SessionWork } from './sessionWork.js'

export type AgentTokenUsage = { totalTokens: number | null; updatedAt: string; inputTokens?: number; outputTokens?: number; cachedTokens?: number; output?: AgentOutputStats; work?: SessionWork }
export type AgentUsageTarget = Pick<RegisteredSession, 'engine' | 'sessionId' | 'transcriptPath' | 'codexHome' | 'agentId' | 'forkedFrom' | 'registeredAt'>
  & Partial<Pick<RegisteredSession, 'cwd'>>
export const USAGE_LIMIT = 512
export const USAGE_REFRESH_MS = 15_000
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const stamp = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v))

export function usageTarget(s: AgentUsageTarget): AgentUsageTarget {
  return { agentId: s.agentId, sessionId: s.sessionId, engine: s.engine, transcriptPath: s.transcriptPath,
    codexHome: s.codexHome ?? null, cwd: s.cwd ?? null, registeredAt: s.registeredAt,
    forkedFrom: s.forkedFrom ? { agentId: s.forkedFrom.agentId, name: s.forkedFrom.name } : null }
}

/** Every input that can affect the reading, including the owner that will display it. */
export const usageTargetKey = (s: AgentUsageTarget): string => JSON.stringify(usageTarget(s))

export function validUsageTarget(v: unknown): v is AgentUsageTarget {
  return object(v) && text(v.agentId) && !!v.agentId && text(v.sessionId) && !!v.sessionId
    && ['claude', 'codex', 'opencode'].includes(String(v.engine))
    && (v.transcriptPath === null || path(v.transcriptPath)) && (v.engine === 'opencode' || !!v.transcriptPath)
    && (v.codexHome === null || path(v.codexHome)) && (v.cwd === null || path(v.cwd)) && count(v.registeredAt)
    && (v.forkedFrom === null || object(v.forkedFrom) && text(v.forkedFrom.agentId) && text(v.forkedFrom.name))
}

export function validUsage(v: unknown): v is AgentTokenUsage | null {
  if (v === null) return true
  if (!object(v) || !(v.totalTokens === null || count(v.totalTokens)) || !stamp(v.updatedAt)
    || !['inputTokens', 'outputTokens', 'cachedTokens'].every(k => v[k] === undefined || count(v[k]))) return false
  if (v.output !== undefined && (!object(v.output) || !['linesAdded', 'linesRemoved', 'pullRequestsCreated']
    .every(k => (v.output as Record<string, unknown>)[k] === null || count((v.output as Record<string, unknown>)[k])))) return false
  if (v.work !== undefined) {
    const w = v.work
    const locations = (a: unknown) => Array.isArray(a) && a.length <= 128 && a.every(x => object(x) && path(x.cwd) && stamp(x.at))
    if (!object(w) || !locations(w.current) || !locations(w.locations) || typeof w.uncertain !== 'boolean' || typeof w.truncated !== 'boolean'
      || !Array.isArray(w.pullRequests) || w.pullRequests.length > 128 || !w.pullRequests.every(p => object(p)
        && text(p.url) && validPullRequestUrl(p.url) && (p.cwd === null || path(p.cwd)) && stamp(p.at))) return false
  }
  return Buffer.byteLength(JSON.stringify(usageSnapshot(v as AgentTokenUsage))) <= 256 * 1024
}

/** Copy only aggregate fields; a worker can never smuggle a ledger or transcript into core memory. */
export function usageSnapshot(v: AgentTokenUsage | null): AgentTokenUsage | null {
  if (!v) return null
  return { totalTokens: v.totalTokens, updatedAt: v.updatedAt,
    ...(v.inputTokens === undefined ? {} : { inputTokens: v.inputTokens }),
    ...(v.outputTokens === undefined ? {} : { outputTokens: v.outputTokens }),
    ...(v.cachedTokens === undefined ? {} : { cachedTokens: v.cachedTokens }),
    ...(v.output ? { output: { linesAdded: v.output.linesAdded, linesRemoved: v.output.linesRemoved, pullRequestsCreated: v.output.pullRequestsCreated } } : {}),
    ...(v.work ? { work: { current: v.work.current.map(p => ({ cwd: p.cwd, at: p.at })), locations: v.work.locations.map(p => ({ cwd: p.cwd, at: p.at })),
      pullRequests: v.work.pullRequests.map(p => ({ url: p.url, cwd: p.cwd, at: p.at })), uncertain: v.work.uncertain, truncated: v.work.truncated } } : {}) }
}
