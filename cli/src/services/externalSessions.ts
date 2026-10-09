/** Search owns external readers even when its optional SQLite index cannot open. */
import { externalProcessGeneration } from '../lib/externalProcessGeneration.js'
import { externalSessionAnswer, externalSessionRequest, externalUnavailable,
  type ExternalSessionAnswer } from '../lib/externalSessionWire.js'
import { ExternalSessions, OpenSessions, externalSessionCatalog, type ExternalSessionsOptions, type OpenSessionsOptions,
  type SessionOwner } from '../lib/sessionSearch/external.js'
import { externalEvidence, externalReadFailed } from '../lib/sessionSearch/evidence.js'
import { harnessTtys, processTtys, processView, sameProject, scanMemo } from '../lib/sessionSearch/externals/support.js'
import type { Ownership, OwnerClaim, ProcessView, RunningProcess } from '../lib/sessionSearch/externals/types.js'

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
      const matching = (claims: readonly OwnerClaim[]) => claims.filter(claim =>
        [session.sessionId, ...session.aliases ?? []].includes(claim.sessionId))
      const signature = (claims: readonly OwnerClaim[]) => JSON.stringify([...new Set(claims.map(claim =>
        JSON.stringify([claim.sessionId, claim.pid, claim.record, !!claim.app, !!claim.fromArgs])))].sort())
      const ownership = async (view: ProcessView): Promise<Ownership> =>
        await provider.ownership?.(view) ?? { claims: await provider.owners!(view), unresolved: [] }
      // A process the provider could not place may hold any conversation its own picker lists: Claude Code's
      // `/resume` lists its project's (sameProject, kept wide). One far from this folder cannot hold this one;
      // one near it, or one whose folder could not be read, might, and then nobody can say who holds it. Before,
      // any such process on the machine held every adoption (CLI 0.3.70: "launched 0 of 4 · 4 still waiting"
      // behind two old TUIs). The conversation its arguments name is its fromArgs claim's to answer.
      const ids = [session.sessionId, ...session.aliases ?? []]
      const placed = async (found: Ownership): Promise<OwnerClaim[]> => {
        for (const process of found.unresolved) {
          if (process.named !== undefined && ids.includes(process.named)) continue
          if (process.cwd !== null && !await sameProject(process.cwd, session.cwd)) continue
          externalReadFailed(new Error('an unplaced process may hold it'), 'current owner')
          throw new Error('an unplaced process may hold it')
        }
        return found.claims
      }
      const allClaims = await placed(await ownership(view))
      const claims = matching(allClaims)
      const pids = new Set(claims.map(claim => claim.pid))
      if (pids.size > 1) throw new Error('conflicting owners')
      const exact = claims.filter(claim => !claim.fromArgs)
      if (new Set(exact.map(claim => JSON.stringify([claim.record, !!claim.app]))).size > 1
        || new Set(claims.map(claim => !!claim.app)).size > 1) throw new Error('conflicting owner evidence')
      const claim = claims.find(claim => !claim.fromArgs) ?? claims[0]
      if (!claim) return { owner: null, generation: null, busy: false }
      const candidateClaims = (all: readonly OwnerClaim[]) => all.filter(other => other.pid === claim.pid || matching([other]).length > 0)
      // A terminal process with another exact conversation open cannot be stopped for this one.
      // Keep its other claims in the second-pass comparison too: filtering to this ID hid that race.
      if (allClaims.some(other => other.pid === claim.pid && !other.fromArgs && !matching([other]).length)) throw new Error('process holds another conversation')
      if (!Number.isSafeInteger(claim.pid) || claim.pid <= 0 || claim.pid > 0x7fffffff) throw new Error('invalid owner PID')
      const [ttys, harness] = await Promise.all([
        (options.open?.ttys ?? processTtys)([claim.pid]), (options.open?.harnessTtys ?? harnessTtys)(),
      ])
      if (!claim.app && !ttys.has(claim.pid)) throw new Error('missing terminal evidence')
      const tty = claim.app ? null : ttys.get(claim.pid) ?? null
      const owner: SessionOwner = { pid: claim.pid, engine: provider.engine, record: claim.record, tty,
        ...(tty && harness?.has(tty) ? { harness: true } : {}), ...(tty && !harness ? { unverified: true } : {}),
        ...(claim.fromArgs ? { fromArgs: true } : {}) }
      // A process can switch conversations while terminal reads wait. Its PID surviving
      // does not prove it still owns this conversation. Re-read ownership with a fresh process view.
      const fresh = (options.open?.view ?? processView)()
      await fresh.list()
      // The same rule on the second look: a process that came up in this folder meanwhile may have it now.
      if (signature(candidateClaims(await placed(await ownership(fresh)))) !== signature(candidateClaims(allClaims))) throw new Error('owner changed during observation')
      // Nothing asynchronous follows this proof. Idle must come from a record that also proves
      // the exact current owner; a separate activity read could belong to a previous conversation.
      const activity = await externalEvidence(async () => await provider.confirmOwner?.(claim, processes.find(row => row.pid === claim.pid) ?? null) ?? null, true)
      if (!activity.ok || activity.value && !activity.value.current) throw new Error('current ownership/activity could not be verified')
      const identity = generation(claim.pid, processes)
      if (!identity && tty && !owner.harness && !owner.fromArgs && !owner.unverified) throw new Error('unverified process incarnation')
      // Unknown activity cannot grant an idle takeover. Explicit take-over-now still requires ownership.
      return { owner, generation: identity, busy: activity.value?.busy !== false,
        ...(activity.value?.busy === true && owner.tty && !owner.harness && !owner.fromArgs && !owner.unverified ? { busyConfirmed: true as const } : {}) }
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
