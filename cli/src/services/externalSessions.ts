/** Search owns external readers even when its optional SQLite index cannot open. */
import { externalProcessGeneration } from '../lib/externalProcessGeneration.js'
import { externalSessionAnswer, externalSessionRequest, externalUnavailable,
  type ExternalSessionAnswer } from '../lib/externalSessionWire.js'
import { ExternalSessions, OpenSessions, type ExternalSessionsOptions, type OpenSessionsOptions,
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
  const inspect = async (payload: unknown): Promise<ExternalSessionAnswer> => {
    const request = externalSessionRequest(payload)
    if (!request) return externalUnavailable('The conversation request could not be verified.')
    // A catalog alias can name another engine. Re-read that provider rather than admit stale display data.
    const known = sessions.get(request.sessionId)
    const provider = options.providers.find(p => p.engine === (known?.engine ?? request.engine))
    if (!provider) return externalUnavailable('The conversation reader is unavailable.')
    const found = await externalEvidence(async () => {
      const rows = await provider.scan(scanMemo({ excluded: options.excluded ?? [] }).context())
      return rows.find(row => row.sessionId === request.sessionId || row.aliases?.includes(request.sessionId)) ?? null
    })
    if (!found.ok) return externalUnavailable(found.detail)
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
      const claim = claims.find(claim => !claim.fromArgs) ?? claims[0]
      if (!claim) return { owner: null, generation: null, busy: false }
      const [ttys, harness] = await Promise.all([
        (options.open?.ttys ?? processTtys)([claim.pid]), (options.open?.harnessTtys ?? harnessTtys)(),
      ])
      const tty = claim.app ? null : ttys.get(claim.pid) ?? null
      const owner: SessionOwner = { pid: claim.pid, engine: provider.engine, record: claim.record, tty,
        ...(tty && harness?.has(tty) ? { harness: true } : {}), ...(tty && !harness ? { unverified: true } : {}),
        ...(claim.fromArgs ? { fromArgs: true } : {}) }
      const identity = generation(claim.pid, processes)
      if (!identity && tty && !owner.harness && !owner.fromArgs && !owner.unverified) throw new Error('unverified process incarnation')
      const activity = await externalEvidence(async () => await provider.busy?.(owner) ?? true, true)
      // Unknown activity cannot grant an idle takeover. Explicit take-over-now still requires ownership.
      return { owner, generation: identity, busy: activity.ok ? activity.value : true }
    })
    if (!observed.ok) return externalUnavailable(observed.detail)
    return externalSessionAnswer({ ok: true, request,
      session: { ...session, title: session.title || options.title?.(request.sessionId) || '' }, ...observed.value,
    }, request)
  }
  return { sessions, open, inspect }
}
