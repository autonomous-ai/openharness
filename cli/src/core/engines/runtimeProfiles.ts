/** Route profile interpretation to workers while keeping accepted state and control authority in core. */
import type { LegacyRuntimeProfileManager } from '../../lib/runtimeProfileManager.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { LiveFrame } from '../../engines/worker/liveProtocol.js'
import type { RuntimeProfile, RuntimeRecord } from '../../engines/facets/runtime.js'
import { EngineReadError } from '../../engines/worker/protocol.js'
import { createRuntimeSessions } from './runtimeSessions.js'
import type { RuntimeTransport } from './runtimeTransport.js'

export interface ProfileHydration {
  ingest(rawLine: string): void
  commit(): void
  ingestFrames?(frames: readonly LiveFrame[]): Promise<void>
  config?(): Promise<void>
  commitWith?(install: () => boolean): boolean
}

export interface RuntimeProfilesDeps {
  legacy: LegacyRuntimeProfileManager
  handles(engine: string): boolean
  resolve(id: string): RegisteredSession | undefined
  transport: RuntimeTransport
}

function evidence(frames: readonly LiveFrame[]): RuntimeRecord[] {
  const records: RuntimeRecord[] = []
  for (const frame of frames) {
    // A capable worker must explicitly distinguish no evidence from an old, unsupported frame.
    if (frame.runtime === undefined) throw new EngineReadError('ENGINE_INVALID_REPLY')
    if (frame.runtime !== null) records.push(frame.runtime)
  }
  return records
}

export function createRuntimeProfiles({ legacy, handles, resolve, transport }: RuntimeProfilesDeps) {
  let changed: ((id: string) => void) | null = null
  const remote = createRuntimeSessions({ resolve, transport, changed: id => changed?.(id) })
  legacy.onChanged = id => changed?.(id)
  const forId = (id: string) => handles(resolve(id)?.engine ?? '') ? remote : legacy
  const forSession = (session: RegisteredSession) => handles(session.engine) ? remote : legacy
  const rawUnavailable = (): never => { throw new EngineReadError('ENGINE_INVALID_REQUEST') }
  const observe = async (session: RegisteredSession, operation: { kind: 'config' } | { kind: 'pane'; text: string }, silent: boolean): Promise<boolean> => {
    const before = remote.selectedModel(session)
    await remote.read(session, operation, silent)
    return before !== remote.selectedModel(session)
  }
  return {
    handles,
    get onChanged() { return changed },
    set onChanged(value: ((id: string) => void) | null) { changed = value },
    selectedModel: (session: RegisteredSession) => forSession(session).selectedModel(session),
    getState: (id: string) => forId(id).getState(id),
    beginControl: (session: RegisteredSession, target: RuntimeProfile) => forSession(session).beginControl(session, target),
    cancelControl: (id: string) => forId(id).cancelControl(id),
    finishControl: (session: RegisteredSession) => forSession(session).finishControl(session),
    confirmEffort: (id: string, effort: string) => forId(id).confirmEffort(id, effort),
    confirmControlProfile: (target: RuntimeProfile) => forId(target.sessionId).confirmControlProfile(target),
    waitForModel: (id: string, timeout: number) => forId(id).waitForModel(id, timeout),
    waitForProfile: (id: string, timeout: number) => forId(id).waitForProfile(id, timeout),
    forget(id: string): void { remote.forget(id); legacy.forget(id) },
    stop(): void { remote.stop(); changed = null },
    withoutChangeEvents<T>(run: () => Promise<T>): Promise<T> {
      return remote.withoutChangeEvents(() => legacy.withoutChangeEvents(run))
    },
    ingest(session: RegisteredSession, line: string, silent = false): boolean {
      return handles(session.engine) ? rawUnavailable() : legacy.ingest(session, line, silent)
    },
    hydrate(session: RegisteredSession, lines: string[]): void {
      if (handles(session.engine)) rawUnavailable()
      legacy.hydrate(session, lines)
    },
    transcriptFields(session: RegisteredSession, line: string) {
      return handles(session.engine) ? rawUnavailable() : legacy.transcriptFields(session, line)
    },
    beginHydrate(session: RegisteredSession): ProfileHydration {
      if (!handles(session.engine)) return legacy.beginHydrate(session)
      const pending = remote.stage(session, true, true)
      return { ingest: rawUnavailable, commit: rawUnavailable,
        ingestFrames: frames => pending.ingest(evidence(frames)),
        config: () => pending.config(), commitWith: install => pending.commit(install) }
    },
    async prepareFrames(session: RegisteredSession, frames: readonly LiveFrame[]): Promise<() => boolean> {
      if (!handles(session.engine)) return () => true
      return remote.prepare(session, evidence(frames))
    },
    ingestPane(session: RegisteredSession, text: string, silent = false): boolean | Promise<boolean> {
      return handles(session.engine) ? observe(session, { kind: 'pane', text }, silent) : legacy.ingestPane(session, text, silent)
    },
    ingestConfig(session: RegisteredSession, silent = false): Promise<boolean> {
      return handles(session.engine) ? observe(session, { kind: 'config' }, silent) : legacy.ingestConfig(session, silent)
    },
    async supportsControl(session: RegisteredSession): Promise<boolean> {
      if (session.gateway) return false
      return handles(session.engine) ? (await remote.read(session, { kind: 'describe' })).supportsControl : legacy.supportsControl(session)
    },
    async effortAllowed(session: RegisteredSession, model: string, effort: string, listed: readonly string[] | null): Promise<boolean> {
      return handles(session.engine)
        ? (await remote.read(session, { kind: 'effort', model, effort, listed: listed && [...listed] })).effortAllowed!
        : legacy.effortAllowed(session, model, effort, listed)
    },
    async codexCatalog(session: RegisteredSession) {
      return handles(session.engine) ? (await remote.read(session, { kind: 'catalog' })).catalog! : legacy.codexCatalog(session)
    },
    async modelsForSession(session: RegisteredSession) {
      if (session.gateway) return []
      return handles(session.engine) ? (await remote.read(session, { kind: 'models' })).models! : legacy.modelsForSession(session)
    },
    async modelsForSessions(sessions: RegisteredSession[]) {
      return (await Promise.all(sessions.map(session => this.modelsForSession(session)))).flat()
    },
    cursorTarget: legacy.cursorTarget.bind(legacy),
    devinTarget: legacy.devinTarget.bind(legacy),
    commandcodeTarget: legacy.commandcodeTarget.bind(legacy),
    hermesTarget: legacy.hermesTarget.bind(legacy),
    opencodeCatalog: legacy.opencodeCatalog.bind(legacy),
    kiloCatalog: legacy.kiloCatalog.bind(legacy),
  }
}

export type RuntimeProfiles = ReturnType<typeof createRuntimeProfiles>
