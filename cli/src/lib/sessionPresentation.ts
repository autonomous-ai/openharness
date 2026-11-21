/** One public session shape: native facts are derived, service facts are admitted once and retained. */
import type { AgentFrame } from './agentFrame.js'
import type { ActivityFrame } from './turnActivity.js'

// These values belong to their publishing components. The session layer carries JSON objects, not their schemas.
type DisplayFields = 'tokenUsage' | 'outputStats' | 'grid' | 'project' | 'gitContext' | 'verdict'
export type SessionFrame = Omit<AgentFrame, 'engine' | DisplayFields> & { engine: string; gitContext: object }
  & { [K in Exclude<DisplayFields, 'gitContext'>]: object | null }
export type SessionFacts = Pick<SessionFrame, 'id' | 'engine' | 'name' | 'createdAt' | 'updatedAt'>
  & Partial<Omit<SessionFrame, 'id' | 'engine' | 'name' | 'createdAt' | 'updatedAt' | 'userId' | 'browser'>> & {
    app?: Readonly<Record<string, unknown>>
    turn?: { fullText: string; card: { recap: string; text: string } | null }
    work?: { text?: string; snapshot?: true; elapsedSeconds?: number; processing?: { text?: string } }
  }
export const SESSION_FACTS_FORMAT = 'session-facts-v1' as const
const NULL_FIELDS = ['title', 'activity', 'closePlan', 'lastOpenedAt', 'tokenUsage', 'outputStats', 'tmuxPane',
  'selectedModel', 'grid', 'codexHome', 'project', 'dsh', 'dshName', 'viewerUrl', 'viewerName', 'verdict',
  'forkedFrom', 'parentAgentId', 'startedBy', 'permissionMode', 'bypassPermission', 'namedAgent', 'waitingFor'] as const
const OPTIONAL_FIELDS = ['identityHold', 'namedState', 'workspace', 'claudeHome', 'launchArgs'] as const
/** This order, rather than a public frame's property order, defines the versioned checkpoint bytes. */
export const SESSION_FACT_FIELDS = ['id', 'engine', 'name', 'createdAt', 'updatedAt', 'sessionId',
  ...NULL_FIELDS, ...OPTIONAL_FIELDS, 'nameChosen', 'status', 'closeSupported', 'forkable', 'resumeMode',
  'launch', 'terminal', 'gitContext', 'app', 'turn', 'work', 'starting'] as const satisfies readonly (keyof SessionFacts)[]

// These are shared presentation defaults, never mutable Registry objects.
const EMPTY: never[] = []; Object.freeze(EMPTY)
const READY: SessionFrame['launch'] = Object.freeze({ state: 'ready' })
const NO_TERMINAL: SessionFrame['terminal'] = Object.freeze({ available: false, primary: '', runtimes: EMPTY })
const defaultContext = (project: SessionFrame['project']): SessionFrame['gitContext'] => ({
  state: project ? 'workspace' : 'unavailable', current: project, observedAt: null,
  locations: EMPTY, pullRequests: EMPTY, truncated: false,
})

type Reader<T> = <K extends keyof SessionFacts>(owner: T, key: K) => SessionFacts[K]
type Has<T> = (owner: T, key: keyof SessionFacts) => boolean
type App = Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>>)
/** App values are already admitted/fenced by the actual owner; standard null/absent semantics live here alone. */
function frame<T>(owner: T, read: Reader<T>, has: Has<T>, app?: App): SessionFrame {
  const project = read(owner, 'project') ?? null
  const value: SessionFrame = {
    id: read(owner, 'id'), sessionId: read(owner, 'sessionId') ?? read(owner, 'id'), userId: '', name: read(owner, 'name'),
    nameChosen: read(owner, 'nameChosen') ?? false, title: read(owner, 'title') ?? null, status: read(owner, 'status') ?? 'active',
    activity: read(owner, 'activity') ?? null, closePlan: read(owner, 'closePlan') ?? null,
    closeSupported: read(owner, 'closeSupported') ?? false, launch: read(owner, 'launch') ?? READY,
    ...(read(owner, 'identityHold') === undefined ? {} : { identityHold: read(owner, 'identityHold') }),
    ...(read(owner, 'namedState') === undefined ? {} : { namedState: read(owner, 'namedState') }),
    createdAt: read(owner, 'createdAt'), updatedAt: read(owner, 'updatedAt'), lastOpenedAt: read(owner, 'lastOpenedAt') ?? null,
    tokenUsage: read(owner, 'tokenUsage') ?? null, outputStats: read(owner, 'outputStats') ?? null,
    tmuxPane: read(owner, 'tmuxPane') ?? null, terminal: read(owner, 'terminal') ?? NO_TERMINAL, engine: read(owner, 'engine'),
    selectedModel: read(owner, 'selectedModel') ?? null,
    ...(read(owner, 'workspace') === undefined ? {} : { workspace: read(owner, 'workspace') }),
    grid: read(owner, 'grid') ?? null, codexHome: read(owner, 'codexHome') ?? null,
    ...(has(owner, 'claudeHome') ? { claudeHome: read(owner, 'claudeHome') } : {}),
    ...(read(owner, 'launchArgs') === undefined ? {} : { launchArgs: read(owner, 'launchArgs') }),
    project, gitContext: read(owner, 'gitContext') ?? defaultContext(project), dsh: read(owner, 'dsh') ?? null,
    dshName: read(owner, 'dshName') ?? null, viewerUrl: read(owner, 'viewerUrl') ?? null, viewerName: read(owner, 'viewerName') ?? null,
    verdict: read(owner, 'verdict') ?? null, forkedFrom: read(owner, 'forkedFrom') ?? null,
    parentAgentId: read(owner, 'parentAgentId') ?? null, startedBy: read(owner, 'startedBy') ?? null,
    forkable: read(owner, 'forkable') ?? false, resumeMode: read(owner, 'resumeMode') ?? 'conversation',
    permissionMode: read(owner, 'permissionMode') ?? null, bypassPermission: read(owner, 'bypassPermission') ?? null,
    namedAgent: read(owner, 'namedAgent') ?? null, waitingFor: read(owner, 'waitingFor') ?? null,
    starting: read(owner, 'starting') ?? false,
  }
  return Object.assign(value, typeof app === 'function' ? app() : app)
}
const factsRead: Reader<SessionFacts> = (facts, key) => facts[key]
const factsHas: Has<SessionFacts> = (facts, key) => Object.hasOwn(facts, key)
/** Native callers keep their pre/post-await captures and final fenced app read; no native facts are retained. */
export const sessionFrame = (facts: SessionFacts, app: App | undefined = facts.app): SessionFrame =>
  frame(facts, factsRead, factsHas, app)

const fields = SESSION_FACT_FIELDS.filter(key => key !== 'activity' && key !== 'app')
type ScalarField = typeof fields[number]
const slots = Object.freeze(Object.fromEntries(fields.map(key => [key, Symbol(key)]))) as Readonly<Record<ScalarField, symbol>>
const state = Symbol('activity.state'), epoch = Symbol('activity.epoch'), revision = Symbol('activity.revision'), lease = Symbol('activity.validForMs')
const emptyApp = Symbol('explicit empty app')
declare const retained: unique symbol
export type RetainedSession = Readonly<Record<string, unknown>> & { readonly [retained]: true }
type PrivateSession = Record<PropertyKey, unknown>
const privateValue = (owner: PrivateSession, key: symbol, value: unknown): void => { Object.defineProperty(owner, key, { value }) }
const own = (owner: object, key: symbol): boolean => Object.hasOwn(owner, key)

/** Takes only a detached, structurally and semantically admitted facts value. Its app object becomes the one row. */
export function retainSessionFacts(facts: SessionFacts): RetainedSession {
  const owner = (facts.app ?? {}) as PrivateSession
  if (Object.hasOwn(facts, 'app') && Object.keys(owner).length === 0) privateValue(owner, emptyApp, true)
  for (const key of fields) if (Object.hasOwn(facts, key)) privateValue(owner, slots[key], facts[key])
  if (Object.hasOwn(facts, 'activity')) {
    const value = facts.activity!
    if (value === null) privateValue(owner, state, null)
    else {
      privateValue(owner, state, value.state); privateValue(owner, epoch, value.epoch)
      privateValue(owner, revision, value.revision); privateValue(owner, lease, value.validForMs)
    }
  }
  return owner as RetainedSession
}
export const hasSessionFact: Has<RetainedSession> = (owner, key) => key === 'activity' ? own(owner, state)
  : key === 'app' ? own(owner, emptyApp) || Object.keys(owner).length > 0 : own(owner, slots[key])
export const readSessionFact: Reader<RetainedSession> = <K extends keyof SessionFacts>(owner: RetainedSession, key: K): SessionFacts[K] => {
  const value = owner as PrivateSession
  if (key === 'app') return (hasSessionFact(owner, 'app') ? Object.fromEntries(Object.entries(owner)) : undefined) as SessionFacts[K]
  if (key === 'activity') return (!own(owner, state) ? undefined : value[state] === null ? null : {
    state: value[state], epoch: value[epoch], revision: value[revision], validForMs: value[lease],
  } as ActivityFrame) as SessionFacts[K]
  return (own(owner, slots[key as ScalarField]) ? value[slots[key as ScalarField]] : undefined) as SessionFacts[K]
}
function identity(owner: RetainedSession, key: 'id' | 'engine' | 'createdAt'): string {
  const value = readSessionFact(owner, key)
  if (!hasSessionFact(owner, key) || typeof value !== 'string') throw new Error('SESSION_OWNER_INVALID')
  return value
}
export const sessionOwnerId = (owner: RetainedSession): string => identity(owner, 'id')
export const sessionOwnerFactory = (owner: RetainedSession): string => identity(owner, 'engine')
export const sessionOwnerCreatedAt = (owner: RetainedSession): string => identity(owner, 'createdAt')
/** Raw JSON of a retained row contains only opaque app keys. Explicit facts encoding excludes private authority. */
export function sessionFactsWire(owner: RetainedSession): SessionFacts {
  const facts: Partial<SessionFacts> = {}
  for (const key of SESSION_FACT_FIELDS) if (hasSessionFact(owner, key)) {
    Object.defineProperty(facts, key, { value: readSessionFact(owner, key), enumerable: true, configurable: true, writable: true })
  }
  return facts as SessionFacts
}
/** A component encodes its direct facts without retaining a second presentation or using the private layout. */
export function encodeSessionFacts(facts: SessionFacts): string {
  const ordered: Partial<SessionFacts> = {}
  for (const key of SESSION_FACT_FIELDS) if (Object.hasOwn(facts, key)) {
    Object.defineProperty(ordered, key, { value: facts[key], enumerable: true })
  }
  return JSON.stringify(ordered)
}
export const retainedSessionFrame = (owner: RetainedSession): SessionFrame => frame(owner, readSessionFact, hasSessionFact, owner)
