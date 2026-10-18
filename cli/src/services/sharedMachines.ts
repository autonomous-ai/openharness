/**
 * Sharing a whole machine with other accounts (docs/plans/2026-10-15-share-machine-plan.md), in the edge
 * host. Off by default.
 *
 * `shared_machines` takes `{action}`:
 * - `get`: this machine's sharing, `{emails, sameDomain, domain, members}`. `domain` is the owner's, null
 *   at a public one (gmail.com, …), where "everyone at" is never offered; `members` are who use it now.
 * - `set` {emails, sameDomain}: share this machine with these addresses and, or, everyone at the domain.
 *   Empty and false is "not shared".
 * - `add` {machineId}: add a machine shared with this account's domain to its machines; `remove` takes it
 *   back out.
 * Owner only, like every request that changes this machine.
 *
 * The policy is kept here, on the machine (`shared-machines.json`), and published to the backend, which
 * lists the machine to the people it names and lets their relay sessions through. Whom to trust is still
 * this machine's to decide: it reads who uses it from the backend, keeps those its own policy names, and
 * has the gateway trust their machines' keys (gateway/sharedTrust.ts), as Share's owner keeps its grants.
 * The other half is for the machines shared with this account: their keys are pinned, so a window here
 * reaches them as it reaches the account's own.
 *
 * Read again as it starts, when the backend says the machines changed (someone added this machine, the
 * sharing of one shared with this account changed), after each change made here, and every few minutes
 * while anything is shared either way.
 */
import { join } from 'node:path'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { failed, type PortFailure, type ShareMember, type SharedMachinesPort, type SharePolicy,
  type SharedTrustPeer } from '../lib/sharedMachinesPort.js'

/** The request shared machines answers for the apps, declared in core/api.ts for the core to route. */
export { SHARED_MACHINES_REQUESTS } from '../core/api.js'

/** The most addresses one machine is shared with (the backend's `SHARE_EMAILS_MAX`). */
export const SHARE_EMAILS_MAX = 100
/** How often the sharing is read again while anything is shared either way, and while nothing is. */
const BUSY_MS = 2 * 60_000
const IDLE_MS = 15 * 60_000
/** A first read waits for the core and the gateway to settle; a notice is read soon after. */
const START_MS = 5_000
const NOTICE_MS = 1_000

/** The backend's own rule for an address (zod's `email()`): one it refuses is refused here first, by name,
 *  rather than failing the whole list there (an address typed `name@!gmail.com`, 2026-10-15). */
const EMAIL_RE = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/

/** This machine's sharing as its owner set it. */
export interface LocalPolicy { emails: string[]; sameDomain: boolean }

export interface SharedMachinesDeps {
  /** The core's `shared_machines` answers, or null signed out: nothing is shared or read. */
  port: SharedMachinesPort | null
  file: string
  setTimer: (fn: () => void, ms: number) => { cancel(): void }
  log: (line: string) => void
}

const OFF: LocalPolicy = { emails: [], sameDomain: false }

export function readPolicy(file: string): LocalPolicy {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<LocalPolicy>
    return { emails: normalizeEmails(raw.emails) ?? [], sameDomain: raw.sameDomain === true }
  } catch { return OFF }
}

function writePolicy(file: string, policy: LocalPolicy): void {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(policy, null, 2), { mode: 0o600 })
  renameSync(temp, file)
}

/** Addresses trimmed, lower case, each once; null when one is not an address or there are too many. */
export function normalizeEmails(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const emails = [...new Set(raw.map((e) => typeof e === 'string' ? e.trim().toLowerCase() : ''))]
  if (emails.length > SHARE_EMAILS_MAX || emails.some((e) => e.length > 254 || !EMAIL_RE.test(e))) return null
  return emails
}

const shares = (policy: LocalPolicy): boolean => policy.emails.length > 0 || policy.sameDomain
const samePolicy = (a: LocalPolicy, b: LocalPolicy): boolean =>
  a.sameDomain === b.sameDomain && a.emails.length === b.emails.length && a.emails.every((e) => b.emails.includes(e))

/** Whether this machine's own policy names someone the backend says uses it. */
const names = (local: LocalPolicy, domain: string | null, member: ShareMember): boolean => member.via === 'email'
  ? local.emails.includes(member.email)
  : local.sameDomain && !!domain && member.email.endsWith(`@${domain}`)

/** The machines of those the backend says use this one, those this machine's own policy names. */
export function trustedKeys(local: LocalPolicy, remote: SharePolicy): SharedTrustPeer[] {
  return remote.members
    .filter((m) => names(local, remote.domain, m))
    .flatMap((m) => m.machines.map((machine) => ({ ...machine, label: `${machine.label || 'Machine'} · ${m.email}` })))
}

const answerFailure = (f: PortFailure): Record<string, unknown> => ({ error: f.failed.code, message: f.failed.message })

export function startSharedMachines(core: CoreApi, overrides: Partial<SharedMachinesDeps> = {}): ServiceRequests {
  const deps: SharedMachinesDeps = {
    port: overrides.port !== undefined ? overrides.port : null,
    file: overrides.file ?? join(core.dataDir, 'shared-machines.json'),
    setTimer: overrides.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms).unref(); return { cancel: () => clearTimeout(t) } }),
    log: overrides.log ?? ((line) => console.log(`[shared-machines] ${line}`)),
  }
  const port = deps.port
  let timer: { cancel(): void } | null = null
  let reading: Promise<void> | null = null
  let again = false
  /** Whether anything was shared with this account at the last read. */
  let sharedWithUs = false

  /** Publish this machine's policy and trust whom it names; pin the machines shared with this account. */
  const refresh = async (port: SharedMachinesPort): Promise<void> => {
    const local = readPolicy(deps.file)
    const desired: { pins?: SharedTrustPeer[]; keys?: SharedTrustPeer[] } = {}
    const shared = await port.shared()
    if (!failed(shared)) {
      sharedWithUs = shared.length > 0
      desired.pins = shared.filter((m) => m.share.added && m.pub).map((m) => ({
        machineId: m.machineId, pub: m.pub!, label: `${m.name || m.hostname || 'Machine'} · ${m.share.ownerEmail || m.share.ownerName}`,
      }))
    }
    let remote = await port.policy()
    // The backend is told again what this machine holds, whenever it says otherwise (a write that failed,
    // a backend that lost it, the owner's domain now public).
    if (!failed(remote) && !samePolicy(local, remote)) {
      const sameDomain = local.sameDomain && !!remote.domain
      remote = await port.publish(local.emails, sameDomain)
      if (!failed(remote) && sameDomain !== local.sameDomain) writePolicy(deps.file, { ...local, sameDomain })
    }
    if (!failed(remote)) desired.keys = shares(local) ? trustedKeys(local, remote) : []
    if (!desired.pins && !desired.keys) return
    const held = await port.trust(desired)
    if (failed(held)) deps.log(`could not update the trust stores: ${held.failed.message}`)
  }

  /** One read at a time; one asked for while another runs follows it. Then the next round. */
  const read = (port: SharedMachinesPort): Promise<void> => {
    if (reading) { again = true; return reading }
    reading = (async () => {
      do {
        again = false
        await refresh(port).catch((error: unknown) => deps.log(`read failed: ${error instanceof Error ? error.message : String(error)}`))
      } while (again)
    })().finally(() => {
      reading = null
      schedule(port, shares(readPolicy(deps.file)) || sharedWithUs ? BUSY_MS : IDLE_MS)
    })
    return reading
  }

  const schedule = (port: SharedMachinesPort, ms: number): void => {
    timer?.cancel()
    timer = deps.setTimer(() => { timer = null; void read(port) }, ms)
  }

  if (port) {
    schedule(port, START_MS)
    core.account.onNotice((notice) => { if (notice.type === 'machines_changed') schedule(port, NOTICE_MS) })
  }

  const view = async (): Promise<Record<string, unknown>> => {
    const local = readPolicy(deps.file)
    const remote = port ? await port.policy() : null
    if (!remote || failed(remote)) {
      return { ...local, domain: null, members: [], ...(remote ? answerFailure(remote) : { error: 'NOT_SIGNED_IN' }) }
    }
    return { ...local, sameDomain: local.sameDomain && !!remote.domain, domain: remote.domain,
      members: remote.members.filter((m) => names(local, remote.domain, m))
        .map((m) => ({ email: m.email, name: m.name, via: m.via, machines: m.machines.length })) }
  }

  return {
    shared_machines: async (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      switch (payload.action) {
        case 'get': return view()
        case 'set': {
          const emails = normalizeEmails(payload.emails)
          if (!emails || typeof payload.sameDomain !== 'boolean') {
            const bad = Array.isArray(payload.emails) && payload.emails.length <= SHARE_EMAILS_MAX
              ? payload.emails.find((e) => typeof e !== 'string' || !EMAIL_RE.test(e.trim().toLowerCase())) : undefined
            return { error: 'BAD_REQUEST', message: typeof bad === 'string' ? `Not an email address: ${bad}` : `Enter up to ${SHARE_EMAILS_MAX} email addresses.` }
          }
          if (!port) return { error: 'NOT_SIGNED_IN', message: 'Sign in to share this machine.' }
          const published = await port.publish(emails, payload.sameDomain)
          if (failed(published)) return answerFailure(published)
          writePolicy(deps.file, { emails: published.emails, sameDomain: published.sameDomain })
          await read(port)
          return view()
        }
        case 'add':
        case 'remove': {
          if (typeof payload.machineId !== 'string') return { error: 'BAD_REQUEST' }
          if (!port) return { error: 'NOT_SIGNED_IN', message: 'Sign in to add a shared machine.' }
          const done = payload.action === 'add' ? await port.add(payload.machineId) : await port.remove(payload.machineId)
          if (failed(done)) return answerFailure(done)
          await read(port)
          return { ok: true }
        }
        default: return { error: 'UNKNOWN_ACTION' }
      }
    },
  }
}
