/** Search owns external readers even when its optional SQLite index cannot open. */
import { externalProcessGeneration } from '../lib/externalProcessGeneration.js'
import { externalSessionAnswer, externalSessionRequest, externalUnavailable,
  type ExternalSessionAnswer } from '../lib/externalSessionWire.js'
import { ExternalSessions, OpenSessions, externalSessionCatalog, type ExternalSessionsOptions, type OpenSessionsOptions,
  type SessionOwner } from '../lib/sessionSearch/external.js'
import { externalEvidence } from '../lib/sessionSearch/evidence.js'
import { harnessTtys, processTtys, processView, scanMemo } from '../lib/sessionSearch/externals/support.js'
import type { RunningProcess } from '../lib/sessionSearch/externals/types.js'

export interface ExternalReaderOptions extends ExternalSessionsOptions {
  open?: Omit<OpenSessionsOptions, 'providers'>
  /** Process snapshot plus a second incarnation check. Tests provide private synthetic processes. */
  generation?: (pid: number, processes: readonly RunningProcess[]) => string | null
  title?: (sessionId: string) => string | undefined
}

export function createExternalSessions(options: ExternalReaderOptions) {
  const sessions = new ExternalSessions(options)
  const open = new OpenSessions({ ...options.open, providers: options.providers })
  const generation = options.generation ?? ((pid, processes) => {
    const expected = processes.find(row => row.pid === pid)?.generation
    return expected && externalProcessGeneration(pid) === expected ? expected : null
  })
  const inspectOne = async (payload: unknown): Promise<ExternalSessionAnswer> => {
    const request = externalSessionRequest(payload)
    if (!request) return externalUnavailable('The conversation request could not be verified.')
    // A catalog alias can name another engine. Re-read that provider rather than admit stale display data.
    const known = sessions.get(request.sessionId)
    let provider = options.providers.find(p => p.engine === (known?.engine ?? request.engine))
    if (!provider) return externalUnavailable('The conversation reader is unavailable.')
    const initialProvider = provider
    let found = await externalEvidence(async () => {
      const rows = await initialProvider.scan(scanMemo({ excluded: options.excluded ?? [] }).context())
      return externalSessionCatalog(rows).byId.get(request.sessionId) ?? null
    })
    if (!found.ok) return externalUnavailable(found.detail)
    if (!found.value) {
      // A cold catalog may not yet know that the requested ID belongs to another engine. Refresh
      // its display discovery, then re-read that provider before returning a wrong-engine fact.
      await sessions.scan()
      const elsewhere = sessions.get(request.sessionId)
      const other = elsewhere && options.providers.find(candidate => candidate.engine === elsewhere.engine)
      if (other) {
        provider = other
        found = await externalEvidence(async () => externalSessionCatalog(await other.scan(scanMemo({ excluded: options.excluded ?? [] }).context())).byId.get(request.sessionId) ?? null)
        if (!found.ok) return externalUnavailable(found.detail)
      }
    }
    const session = found.value
    if (!session || session.engine !== request.engine || session.archived) return externalSessionAnswer({
      ok: true, request, session, owner: null, generation: null, busy: false,
    }, request)
    if (!provider.owners) return externalUnavailable('The conversation owner could not be verified.')
    const observed = await externalEvidence(async () => {
      const view = (options.open?.view ?? processView)()
      // The process table precedes ownership evidence, so a recycled PID cannot inherit that evidence.
      const processes = await view.list()
      const claims = (await provider.owners!(view)).filter(claim =>
        [session.sessionId, ...session.aliases ?? []].includes(claim.sessionId))
      const pids = new Set(claims.map(claim => claim.pid))
      if (pids.size > 1) throw new Error('conflicting owners')
      const exact = claims.filter(claim => !claim.fromArgs)
      if (new Set(exact.map(claim => JSON.stringify([claim.record, !!claim.app]))).size > 1
        || new Set(claims.map(claim => !!claim.app)).size > 1) throw new Error('conflicting owner evidence')
      const claim = claims.find(claim => !claim.fromArgs) ?? claims[0]
      if (!claim) return { owner: null, generation: null, busy: false }
      if (!Number.isSafeInteger(claim.pid) || claim.pid <= 0 || claim.pid > 0x7fffffff) throw new Error('invalid owner PID')
      const [ttys, harness] = await Promise.all([
        (options.open?.ttys ?? processTtys)([claim.pid]), (options.open?.harnessTtys ?? harnessTtys)(),
      ])
      if (!claim.app && !ttys.has(claim.pid)) throw new Error('missing terminal evidence')
      const tty = claim.app ? null : ttys.get(claim.pid) ?? null
      const owner: SessionOwner = { pid: claim.pid, engine: provider.engine, record: claim.record, tty,
        ...(tty && harness?.has(tty) ? { harness: true } : {}), ...(tty && !harness ? { unverified: true } : {}),
        ...(claim.fromArgs ? { fromArgs: true } : {}) }
      const activity = await externalEvidence(async () => await provider.busy?.(owner) ?? true, true)
      const identity = generation(claim.pid, processes)
      if (!identity && tty && !owner.harness && !owner.fromArgs && !owner.unverified) throw new Error('unverified process incarnation')
      // Unknown activity cannot grant an idle takeover. Explicit take-over-now still requires ownership.
      return { owner, generation: identity, busy: activity.ok ? activity.value : true }
    })
    if (!observed.ok) return externalUnavailable(observed.detail)
    return externalSessionAnswer({ ok: true, request,
      session: { ...session, title: session.title || options.title?.(request.sessionId) || '' }, ...observed.value,
    }, request)
  }
  let active = 0
  const inspect = async (payload: unknown): Promise<ExternalSessionAnswer> => {
    // RPC deadlines do not stop a native read. Charge the actual work until it settles, so a hung
    // provider cannot accumulate another set of scans on every retry from core.
    if (active >= 4) return externalUnavailable('Waiting for the search service to finish verifying conversations.')
    active++
    try { return await inspectOne(payload) } finally { active-- }
  }
  return { sessions, open, inspect }
}
