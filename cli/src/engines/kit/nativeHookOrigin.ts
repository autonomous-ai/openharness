/** The original native caller survives retry; a later caller cannot enlarge it. */
import { createHash } from 'node:crypto'
import { controlIdentity, type NativeControlRow, type NativeControlSnapshot } from '../../lib/nativeProcessControlProbe.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { NativeEvidenceBudget, nativeUnavailable } from './nativeEvidence.js'
import { kernelBootId } from './nativeHookBoot.js'

type NativeProbe = (pids: readonly number[], budget: NativeEvidenceBudget) => Promise<NativeControlSnapshot>
export interface NativeHookOriginMember {
  pid: number
  parentPid: number
  birth: string
  identityV1: string
}
export interface NativeHookRuntimeOrigin {
  agentId: string
  routeV1: string
  process: NativeHookOriginMember
}
export interface NativeHookOrigin {
  version: 1
  boot: string
  callerPid: number
  ancestry: readonly NativeHookOriginMember[]
  /** Only Cursor may keep its unique runtime observation from this first invocation. */
  runtime?: NativeHookRuntimeOrigin
}
export interface NativeHookOriginOwner { key: string; identityV1: string }
const MAX_ORIGIN_BYTES = 8_192
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 1 && Number(value) <= 0x7fffffff
const parentPid = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0x7fffffff
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
const member = (value: unknown, boot: string): value is NativeHookOriginMember => object(value)
  && only(value, ['pid', 'parentPid', 'birth', 'identityV1']) && pid(value.pid) && parentPid(value.parentPid)
  && typeof value.birth === 'string' && value.birth.length <= 40
  && (boot.startsWith('linux:') ? /^\d+$/.test(value.birth) : /^\d+:\d+$/.test(value.birth)) && hash(value.identityV1)

/** This serialization is a persisted protocol, including argv boundaries and precise birth.
 * Keep the v1 adapter when a later native control representation/version is introduced. */
export function nativeHookIdentityV1(evidence: string): string {
  if (Buffer.byteLength(evidence) > 128 * 1024) return nativeUnavailable('the original native identity exceeds its byte limit')
  let value: unknown
  try { value = JSON.parse(evidence) } catch { return nativeUnavailable('the original native identity is malformed') }
  if (!Array.isArray(value) || value.length !== 7 || !pid(value[0]) || !parentPid(value[1])
    || typeof value[2] !== 'string' || typeof value[3] !== 'string' || typeof value[4] !== 'string'
    || value[5] !== null && (!Array.isArray(value[5]) || value[5].some(arg => typeof arg !== 'string'))
    || value[6] !== null && !hash(value[6])) {
    return nativeUnavailable('the original native identity version is unavailable')
  }
  return createHash('sha256').update(JSON.stringify([value[0], value[1], value[2], value[3], value[4], value[5], value[6]])).digest('hex')
}
const originMember = (row: NativeControlRow): NativeHookOriginMember => ({
  pid: row.pid, parentPid: row.parentPid, birth: row.birth, identityV1: nativeHookIdentityV1(controlIdentity(row)),
})
export const nativeHookRouteV1 = (row: Pick<RegisteredSession, 'processIdentity' | 'runtimes' | 'primaryRuntimeKey'>): string =>
  JSON.stringify([row.processIdentity, row.runtimes, row.primaryRuntimeKey])

/** Validate before use, and copy before any asynchronous reproof of the engine. */
export function inspectNativeHookOrigin(input: unknown): NativeHookOrigin {
  if (!object(input) || !only(input, ['version', 'boot', 'callerPid', 'ancestry', 'runtime'])
    || input.version !== 1 || typeof input.boot !== 'string'
    || !/^(linux|darwin):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.boot)
    || !pid(input.callerPid) || !Array.isArray(input.ancestry) || input.ancestry.length > 32
    || Buffer.byteLength(JSON.stringify(input)) > MAX_ORIGIN_BYTES) {
    return nativeUnavailable('the original native hook origin is malformed or unsupported')
  }
  const seen = new Set<number>()
  let next: number = input.callerPid
  for (const row of input.ancestry) {
    if (!member(row, input.boot) || row.pid !== next || seen.has(row.pid)) {
      return nativeUnavailable('the original native hook ancestry is not a complete prefix')
    }
    seen.add(row.pid); next = row.parentPid
  }
  if (seen.has(next)) return nativeUnavailable('the original native hook ancestry contains a cycle')
  if (input.runtime !== undefined) {
    const runtime = input.runtime
    if (!object(runtime) || !only(runtime, ['agentId', 'routeV1', 'process'])
      || typeof runtime.agentId !== 'string' || !runtime.agentId || runtime.agentId.length > 200
      || typeof runtime.routeV1 !== 'string' || !runtime.routeV1 || Buffer.byteLength(runtime.routeV1) > 4_096
      || !member(runtime.process, input.boot)) return nativeUnavailable('the original Cursor runtime origin is incomplete')
  }
  if (!input.ancestry.length && !input.runtime) return nativeUnavailable('the original native hook caller could not be retained')
  return structuredClone(input) as unknown as NativeHookOrigin
}

/** The capture may stop above the engine; it may never skip an unreadable edge.
 * A single budget covers the ordered prefix and optional Cursor observation. */
export async function captureNativeHookOrigin(callerPid: number, budget: NativeEvidenceBudget, probe: NativeProbe,
  runtime?: Pick<RegisteredSession, 'agentId' | 'engine' | 'active' | 'processIdentity' | 'runtimes' | 'primaryRuntimeKey'>,
): Promise<NativeHookOrigin> {
  if (!pid(callerPid)) return nativeUnavailable('the native hook caller is unavailable')
  const candidate = runtime && structuredClone(runtime)
  const boot = await kernelBootId(budget)
  const ancestry: NativeHookOriginMember[] = []
  const prefix = async () => {
    let child: NativeControlRow | undefined, next = callerPid, bytes = 0
    while (next > 1 && ancestry.length < 32 && !ancestry.some(row => row.pid === next)) {
      try {
        const rows = (await probe(child ? [child.pid, next] : [next], budget)).rows
        const parent = rows.get(next)
        if (!parent || child && (!rows.get(child.pid) || controlIdentity(rows.get(child.pid)!) !== controlIdentity(child))) break
        if ((bytes += Buffer.byteLength(controlIdentity(parent))) > 128 * 1024) break
        ancestry.push(originMember(parent)); child = parent; next = parent.parentPid
      } catch { break }
    }
  }
  const captureRuntime = async (): Promise<NativeHookRuntimeOrigin | undefined> => {
    if (candidate?.engine !== 'cursor' || !candidate.active || !candidate.processIdentity || !candidate.runtimes?.length) return
    try {
      const row = (await probe([candidate.processIdentity.pid], budget)).rows.get(candidate.processIdentity.pid)
      if (!row) return
      return { agentId: candidate.agentId, routeV1: nativeHookRouteV1(candidate), process: originMember(row) }
    } catch { return }
  }
  const [, capturedRuntime] = await Promise.all([prefix(), captureRuntime()])
  budget.step()
  return inspectNativeHookOrigin({ version: 1, boot, callerPid, ancestry, ...(capturedRuntime ? { runtime: capturedRuntime } : {}) })
}

/** Routing and immutable helper preparation may await before a client can read
 * its ancestry. A frozen numeric parent PID alone could then name a replacement.
 * The still-running client must remain that original parent's exact child on
 * both sides of capture. Reparenting holds instead of inventing a new origin. */
export async function captureNativeHookClientOrigin(selfPid: number, callerPid: number, budget: NativeEvidenceBudget,
  probe: NativeProbe, runtime?: Parameters<typeof captureNativeHookOrigin>[3],
): Promise<NativeHookOrigin> {
  const candidate = runtime && structuredClone(runtime)
  if (!pid(selfPid) || selfPid === callerPid) return nativeUnavailable('the native hook client process is unavailable')
  const before = (await probe([selfPid], budget)).rows.get(selfPid)
  if (!before || before.parentPid !== callerPid) return nativeUnavailable('the original native hook caller exited before capture')
  const identity = controlIdentity(before)
  const origin = await captureNativeHookOrigin(callerPid, budget, probe, candidate)
  const after = (await probe([selfPid], budget)).rows.get(selfPid)
  budget.step()
  if (!after || controlIdentity(after) !== identity) return nativeUnavailable('the original native hook caller changed during capture')
  return origin
}

/** Selection is a restriction on fresh core proof, never native authority by itself. */
export function nativeHookOriginCaller(input: unknown) {
  const origin = inspectNativeHookOrigin(input)
  return { owner(row: RegisteredSession): NativeHookOriginOwner & { source: 'caller' | 'runtime' } {
    const process = row.processIdentity && origin.ancestry.find(member => member.pid === row.processIdentity!.pid)
    const expected = (process: NativeHookOriginMember, source: 'caller' | 'runtime') => ({
      key: `${origin.boot}\u0000${row.engine}\u0000${process.pid}\u0000${process.birth}`, identityV1: process.identityV1, source,
    })
    if (process) return expected(process, 'caller')
    const runtime = origin.runtime
    if (row.engine === 'cursor' && runtime?.agentId === row.agentId && runtime.routeV1 === nativeHookRouteV1(row)
      && row.processIdentity?.pid === runtime.process.pid) return expected(runtime.process, 'runtime')
    return nativeUnavailable('the selected engine is absent from the original native hook origin')
  } }
}
