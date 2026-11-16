/** Bounded display projections shared by services. No feature's fields or state are interpreted here. */
import { SERVICE_HOSTS, type ServiceHostSpec } from '../harnessd/services.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { AgentView, CoreApi } from './api.js'

type Fields = Readonly<Record<string, unknown>>
type Declaration = NonNullable<ServiceHostSpec['frameParts']>[string]
const EMPTY: Fields = Object.freeze({})
export const FRAME_PART_BYTES = 16 * 1024
export const FRAME_PART_TOTAL_BYTES = 4 * 1024 * 1024
export const FRAME_PART_ENTRIES = 4096
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor', 'toJSON'])
// These fields are session authority, never a service's display projection.
const RESERVED = new Set(['id', 'agentId', 'sessionId', 'userId', 'name', 'nameChosen', 'title', 'status', 'activity',
  'closePlan', 'closeSupported', 'launch', 'identityHold', 'namedState', 'createdAt', 'updatedAt', 'lastOpenedAt',
  'tokenUsage', 'outputStats', 'tmuxPane', 'terminal', 'engine', 'selectedModel', 'workspace', 'grid', 'codexHome',
  'claudeHome', 'launchArgs', 'forkedFrom', 'parentAgentId', 'startedBy', 'forkable', 'resumeMode', 'permissionMode',
  'bypassPermission', 'namedAgent', 'waitingFor', 'gridLaunch', 'frameEpoch'])

/** Reject oversized/unsafe values before serialization; retain only detached, immutable JSON. */
function snapshot(fields: unknown, allowed: ReadonlySet<string>): { fields: Fields; wire: string; bytes: number } | null {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null
  let nodes = 0, textBytes = 0
  const parents = new Set<object>()
  const INVALID = Symbol('invalid frame part')
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 512 || depth > 8) return INVALID
    if (value == null || value === undefined || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID
    if (typeof value === 'string') { textBytes += Buffer.byteLength(value); return textBytes <= FRAME_PART_BYTES ? value : INVALID }
    if (typeof value !== 'object' || parents.has(value)) return INVALID
    const array = Array.isArray(value)
    if (array && value.length > 512) return INVALID
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return INVALID
    const keys = Reflect.ownKeys(value)
    if (keys.length > 512) return INVALID
    // No service object reaches stringify: even a hidden/inherited hook or a changing Proxy cannot run there.
    const copy = (array ? Object.setPrototypeOf(new Array(value.length), null) : Object.create(null)) as Record<string, unknown>
    parents.add(value)
    for (const key of keys) {
      if (typeof key !== 'string' || UNSAFE.has(key) || (depth === 0 && !allowed.has(key))) return INVALID
      if (array && key === 'length') continue
      textBytes += Buffer.byteLength(key)
      if (textBytes > FRAME_PART_BYTES) return INVALID
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return INVALID
      const nested = visit(descriptor.value, depth + 1)
      if (nested === INVALID) return INVALID
      if (descriptor.enumerable || array) copy[key] = nested
    }
    parents.delete(value)
    return copy
  }
  const checked = visit(fields, 0)
  if (checked === INVALID) return null
  const wire = JSON.stringify(checked), bytes = Buffer.byteLength(wire)
  if (bytes > FRAME_PART_BYTES) return null
  const copied = JSON.parse(wire) as Record<string, unknown>
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const nested of Object.values(value)) freeze(nested)
    Object.freeze(value)
  }
  freeze(copied)
  return { fields: copied, wire, bytes }
}

export function createFrameParts(deps: {
  core: Pick<CoreApi, 'agents'>
  epoch(agentId: string): string | undefined
  available?(service: string): boolean
  hosts?: Readonly<Record<string, ServiceHostSpec>>
  log?(line: string): void
}) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const declarations = new Map<string, { fields: Set<string>; having: Declaration['having'] }>()
  const owners = new Set<string>()
  for (const host of Object.values(deps.hosts ?? SERVICE_HOSTS)) {
    for (const [service, declaration] of Object.entries(host.frameParts ?? {})) {
      if (!host.services.includes(service) || declarations.has(service) || !declaration.fields.length || declaration.fields.length > 32
        || declaration.fields.some(field => !field || field.length > 64 || RESERVED.has(field) || UNSAFE.has(field) || owners.has(field))) {
        throw new Error('FRAME_PART_DECLARATION')
      }
      for (const field of declaration.fields) owners.add(field)
      declarations.set(service, { fields: new Set(declaration.fields), having: declaration.having })
    }
  }
  type Part = NonNullable<ReturnType<typeof snapshot>>
  const agents = new Map<string, { epoch: string; parts: Map<string, Part>; merged: Fields }>()
  const scopes = new Map<string, object>()
  let entries = 0, bytes = 0
  const refused = (error: string): Record<string, unknown> => { log(`[frames] ${error}`); return { error } }
  const matches = (service: string, session: RegisteredSession): boolean =>
    declarations.get(service)!.having?.every(key => Object.hasOwn(session, key) && !!(session as unknown as Fields)[key]) ?? true
  const rebuild = (agent: { parts: Map<string, Part>; merged: Fields }): void => {
    agent.merged = Object.freeze(Object.assign({}, ...[...agent.parts.values()].map(part => part.fields)))
  }
  const forget = (agentId: string): void => {
    const before = agents.get(agentId)
    if (!before) return
    for (const part of before.parts.values()) { entries--; bytes -= part.bytes }
    agents.delete(agentId)
    const session = deps.core.agents.byAgent(agentId)
    if (session) deps.core.agents.sync(session)
  }
  deps.core.agents.follow?.(event => {
    if (event.kind === 'ended' || event.kind === 'purged') forget(event.agentId)
  }, { running: true })

  const publish = (service: string, agentId: unknown, epoch: unknown, raw: unknown): Record<string, unknown> => {
    const declaration = declarations.get(service)
    if (!declaration) return refused('FRAME_PART_OWNER')
    if (deps.available?.(service) === false) return refused('FRAME_PART_UNAVAILABLE')
    if (typeof agentId !== 'string' || typeof epoch !== 'string' || epoch !== deps.epoch(agentId)) return refused('FRAME_PART_STALE')
    const session = deps.core.agents.byAgent(agentId)
    if (!session || !matches(service, session)) return refused('FRAME_PART_STALE')
    let part: ReturnType<typeof snapshot>
    try { part = snapshot(raw, declaration.fields) } catch { return refused('FRAME_PART_INVALID') }
    if (!part) return refused('FRAME_PART_INVALID')
    let agent = agents.get(agentId)
    if (agent && agent.epoch !== epoch) { forget(agentId); agent = undefined }
    const before = agent?.parts.get(service)
    if (before?.wire === part.wire) return { ok: true }
    const empty = Object.keys(part.fields).length === 0
    if ((!empty && !before && entries >= FRAME_PART_ENTRIES) || bytes - (before?.bytes ?? 0) + (empty ? 0 : part.bytes) > FRAME_PART_TOTAL_BYTES) return refused('FRAME_PART_LIMIT')
    if (!agent) {
      if (empty) return { ok: true }
      agent = { epoch: epoch as string, parts: new Map(), merged: EMPTY }
      agents.set(agentId, agent)
    }
    if (before) { entries--; bytes -= before.bytes }
    if (empty) agent.parts.delete(service)
    else { agent.parts.set(service, part); entries++; bytes += part.bytes }
    if (!agent.parts.size) agents.delete(agentId)
    else rebuild(agent)
    // A frame before terminal attachment closes a viewer tile; the attach's own sync publishes what arrived first.
    if (deps.core.agents.terminalAvailable(agentId)) deps.core.agents.sync(session)
    return { ok: true }
  }
  const read = (agentId: string): Fields => {
    const agent = agents.get(agentId), session = deps.core.agents.byAgent(agentId)
    if (!agent || !session || agent.epoch !== deps.epoch(agentId)) return EMPTY
    // A row that lost a required field cannot keep showing the old service's projection.
    for (const [service, part] of agent.parts) if (deps.available?.(service) === false || !matches(service, session)) {
      agent.parts.delete(service); entries--; bytes -= part.bytes
      rebuild(agent)
    }
    if (!agent.parts.size) agents.delete(agentId)
    return agent.merged
  }
  return {
    services: [...declarations.keys()],
    read,
    /** Capture the run before asynchronous frame construction; read its newest projection only if still that run. */
    forFrame(session: RegisteredSession): () => Fields {
      const epoch = deps.epoch(session.agentId)
      return () => epoch !== undefined && epoch === deps.epoch(session.agentId) ? read(session.agentId) : EMPTY
    },
    answer(service: string, query: string, payload: Record<string, unknown>, current: () => boolean): Record<string, unknown> | undefined {
      if (query !== 'frame_part') return undefined
      return current() ? publish(service, payload.agentId, payload.frameEpoch, payload.fields) : refused('FRAME_PART_STALE')
    },
    scope(service: string, core: CoreApi): CoreApi {
      const owner = {}
      scopes.set(service, owner)
      return { ...core, agents: { ...core.agents, publishFrame: (session: AgentView, fields: Fields) => {
        if (scopes.get(service) !== owner) { refused('FRAME_PART_STALE'); return }
        publish(service, session.agentId, session.frameEpoch, fields)
      } } }
    },
    disabled(service: string): void {
      scopes.delete(service)
      for (const [agentId, agent] of agents) {
        const part = agent.parts.get(service)
        if (!part) continue
        agent.parts.delete(service); entries--; bytes -= part.bytes
        if (!agent.parts.size) agents.delete(agentId)
        else rebuild(agent)
        const session = deps.core.agents.byAgent(agentId)
        if (session) deps.core.agents.sync(session)
      }
    },
  }
}
