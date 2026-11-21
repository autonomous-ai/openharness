/** Shared-machine replies parsed in the service that reads them, never the default core. */
import { answerSharedMachinesOp, type SharedMachinesAccount, type SharedTrustPeer } from './sharedMachinesAccount.js'

type Payload = Record<string, unknown>

/** Someone a machine is shared with, as the backend lists them for its owner. */
export interface ShareMember {
  email: string
  name: string | null
  via: 'email' | 'domain'
  machines: SharedTrustPeer[]
}

/** This machine's sharing as the backend holds it. `domain` is the owner's own, null at a public one. */
export interface SharePolicy {
  emails: string[]
  sameDomain: boolean
  domain: string | null
  members: ShareMember[]
}

/** A machine another account shares with this one. */
export interface SharedMachine {
  machineId: string
  name: string | null
  hostname: string | null
  pub: string | null
  share: { ownerName: string; ownerEmail: string; via: 'email' | 'domain'; added: boolean }
}

/** What went wrong, in words an app can show; `code` is the backend's. */
export interface PortFailure { failed: { status: number; code: string; message: string } }

export interface SharedMachinesPort {
  policy(): Promise<SharePolicy | PortFailure>
  publish(emails: string[], sameDomain: boolean): Promise<SharePolicy | PortFailure>
  shared(): Promise<SharedMachine[] | PortFailure>
  add(machineId: string): Promise<true | PortFailure>
  remove(machineId: string): Promise<true | PortFailure>
  trust(desired: { pins?: SharedTrustPeer[]; keys?: SharedTrustPeer[] }): Promise<{ pins: number; keys: number } | PortFailure>
}

export const failed = (value: unknown): value is PortFailure => !!value && typeof value === 'object' && 'failed' in value

const text = (value: unknown): string => typeof value === 'string' ? value : ''
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []

function failure(answer: Payload): PortFailure {
  const body = (answer.body ?? {}) as Payload
  const error = (body.error ?? answer.error) as Payload | string | undefined
  const code = typeof error === 'string' ? error : text(error?.code) || 'UNAVAILABLE'
  const message = typeof error === 'object' && text(error?.message) ? text(error.message) : 'The Harness backend could not be reached. Try again in a moment.'
  return { failed: { status: typeof answer.status === 'number' ? answer.status : 502, code, message } }
}

/** The backend's `data`, or why there is none. */
function data(answer: Payload): Payload | PortFailure {
  const body = answer.body as Payload | undefined
  return answer.status === 200 && body?.success === true && body.data && typeof body.data === 'object' ? body.data as Payload : failure(answer)
}

function peer(raw: unknown): SharedTrustPeer | null {
  const p = (raw ?? {}) as Payload
  return typeof p.machineId === 'string' && typeof p.pub === 'string' ? { machineId: p.machineId, pub: p.pub, label: text(p.name) || text(p.label) } : null
}

function policyOf(d: Payload): SharePolicy {
  return {
    emails: list(d.emails).filter((e): e is string => typeof e === 'string'),
    sameDomain: d.sameDomain === true,
    domain: typeof d.domain === 'string' && d.domain ? d.domain : null,
    members: list(d.members).map((raw) => {
      const m = (raw ?? {}) as Payload
      return { email: text(m.email), name: typeof m.name === 'string' ? m.name : null, via: m.via === 'domain' ? 'domain' as const : 'email' as const,
        machines: list(m.machines).map(peer).filter((p): p is SharedTrustPeer => p !== null) }
    }).filter((m) => m.email),
  }
}

function sharedOf(raw: unknown): SharedMachine | null {
  const r = (raw ?? {}) as Payload
  const share = (r.share ?? {}) as Payload
  if (typeof r.machineId !== 'string') return null
  return {
    machineId: r.machineId, name: typeof r.name === 'string' ? r.name : null, hostname: typeof r.hostname === 'string' ? r.hostname : null,
    pub: typeof r.pub === 'string' ? r.pub : null,
    share: { ownerName: text(share.ownerName), ownerEmail: text(share.ownerEmail), via: share.via === 'domain' ? 'domain' : 'email', added: share.added === true },
  }
}

/** The port over the core's `shared_machines` query, asked in line or over the service's link. */
export function sharedMachinesPortOf(call: (op: string, payload?: Payload) => Promise<Payload>): SharedMachinesPort {
  const policy = (answer: Payload): SharePolicy | PortFailure => { const d = data(answer); return failed(d) ? d : policyOf(d) }
  const done = (answer: Payload): true | PortFailure => { const d = data(answer); return failed(d) ? d : true }
  return {
    policy: async () => policy(await call('policy')),
    publish: async (emails, sameDomain) => policy(await call('publish', { emails, sameDomain })),
    shared: async () => {
      const d = data(await call('shared'))
      return failed(d) ? d : list(d.machines).map(sharedOf).filter((m): m is SharedMachine => m !== null)
    },
    add: async (machineId) => done(await call('add', { machineId })),
    remove: async (machineId) => done(await call('remove', { machineId })),
    trust: async (desired) => {
      const answer = await call('trust', { ...desired })
      return typeof answer.pins === 'number' && typeof answer.keys === 'number' ? { pins: answer.pins, keys: answer.keys } : failure(answer)
    },
  }
}

/** The port in the core's own process, answered in line by the core's sign-in and the gateway it runs;
 *  null signed out, when there is nothing to share or read. */
export function inlineSharedMachinesPort(account: SharedMachinesAccount, signedIn: boolean): SharedMachinesPort | null {
  return signedIn ? sharedMachinesPortOf((op, payload = {}) => answerSharedMachinesOp(account, { ...payload, op })) : null
}
