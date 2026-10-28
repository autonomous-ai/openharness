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
 * - `enable_guests`: turn guest access on (the helper, behind one admin prompt on this computer).
 * - `set_folders` {folders: [{path, write}]}: the owner's folders every guest may work in, read or read-write.
 * Owner only, like every request that changes this machine. `guest_folders` is a guest's: where it may start a
 * harness, its own workspace and the folders shared with it (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
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
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { CoreApi, CorePorts, GuestLaunchInput, ServiceRequests } from '../core/api.js'
import { createGuestAccounts, guestHomeRoot, guestWorkspaceFor, type SharedFolder } from '../lib/guestAccounts.js'
import { guestHelperStatus, installGuestHelper, type GuestHelperInstallResult, type GuestHelperState } from '../lib/guestHelperInstall.js'
import { createOwnerSubscriptions } from '../lib/ownerSubscriptions.js'
import { failed, type PortFailure, type ShareMember, type SharedMachinesPort, type SharePolicy,
  type SharedTrustPeer } from '../lib/sharedMachinesPort.js'
import { startSubscriptionRelay } from '../lib/subscriptionRelay.js'
import { createGuestLaunches, type GuestLaunches } from './guestLaunches.js'

/** The request shared machines answers for the apps, declared in core/api.ts for the core to route. */
export { SHARED_MACHINES_REQUESTS } from '../core/api.js'

/** The most addresses one machine is shared with (the backend's `SHARE_EMAILS_MAX`). */
export const SHARE_EMAILS_MAX = 100
/** The most folders the owner shares with guests. */
export const SHARED_FOLDERS_MAX = 20
/** How often the sharing is read again while anything is shared either way, and while nothing is. */
const BUSY_MS = 2 * 60_000
const IDLE_MS = 15 * 60_000
/** A first read waits for the core and the gateway to settle; a notice is read soon after. */
const START_MS = 5_000
const NOTICE_MS = 1_000

/** The backend's own rule for an address (zod's `email()`): one it refuses is refused here first, by name,
 *  rather than failing the whole list there (an address typed `name@!gmail.com`, 2026-10-15). */
const EMAIL_RE = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/

/** This machine's sharing as its owner set it. `folders` stay here: the backend never hears of them. */
export interface LocalPolicy { emails: string[]; sameDomain: boolean; folders: SharedFolder[] }

export interface SharedMachinesDeps {
  /** The core's `shared_machines` answers, or null signed out: nothing is shared or read. */
  port: SharedMachinesPort | null
  file: string
  setTimer: (fn: () => void, ms: number) => { cancel(): void }
  log: (line: string) => void
  /** Guests' harnesses (services/guestLaunches.ts): their OS accounts and the owner's subscription relay. */
  guests: GuestLaunches
  /** Whether guest access is on here (lib/guestHelperInstall.ts), and turning it on: the owner's one admin prompt. */
  guestAccess: () => Promise<GuestHelperState>
  enableGuests: () => Promise<GuestHelperInstallResult>
  /** Where the core's port goes (serviceHost `start`); absent where only the requests are wanted. */
  ports?: CorePorts
  /** Why the owner may not share [path] with guests, or null when it may (the helper checks it again). */
  folderProblem: (path: string) => string | null
}

const OFF: LocalPolicy = { emails: [], sameDomain: false, folders: [] }

export function readPolicy(file: string): LocalPolicy {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<LocalPolicy>
    return { emails: normalizeEmails(raw.emails) ?? [], sameDomain: raw.sameDomain === true, folders: normalizeFolders(raw.folders) ?? [] }
  } catch { return OFF }
}

/** Folders as the owner shares them: full paths, each once, never /; null when one is not. One a line in the
 *  helper's record, so a name may hold no tab or newline. */
export function normalizeFolders(raw: unknown): SharedFolder[] | null {
  if (!Array.isArray(raw) || raw.length > SHARED_FOLDERS_MAX) return null
  const folders: SharedFolder[] = []
  for (const folder of raw) {
    const { path, write } = (folder ?? {}) as { path?: unknown; write?: unknown }
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\t\n\r\0]/.test(path) || typeof write !== 'boolean') return null
    const resolved = resolve(path)
    if (resolved === '/' || folders.some((f) => f.path === resolved)) return null
    folders.push({ path: resolved, write })
  }
  return folders
}

/** The helper's own rules, said here first in words: a folder of the owner's, on this computer, never its whole
 *  home or a guest's. */
export function ownerFolderProblem(path: string, home = homedir(), guests = guestHomeRoot(), uid = process.getuid?.()): string | null {
  let info
  try { info = statSync(path) } catch { return `No such folder on this computer: ${path}` }
  if (!info.isDirectory()) return `Not a folder: ${path}`
  if (resolve(path) === resolve(home)) return 'Your whole home folder cannot be shared. Choose a folder in it.'
  if (path === guests || path.startsWith(`${guests}/`)) return `This folder belongs to someone you share with and can't be shared: ${path}`
  if (uid !== undefined && info.uid !== uid) return `Only your own folders can be shared: ${path}`
  return null
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

type Sharing = Pick<LocalPolicy, 'emails' | 'sameDomain'>
const shares = (policy: Sharing): boolean => policy.emails.length > 0 || policy.sameDomain
const samePolicy = (a: Sharing, b: Sharing): boolean =>
  a.sameDomain === b.sameDomain && a.emails.length === b.emails.length && a.emails.every((e) => b.emails.includes(e))

/** Whether this machine's own policy names someone the backend says uses it. */
const names = (local: LocalPolicy, domain: string | null, member: ShareMember): boolean => member.via === 'email'
  ? local.emails.includes(member.email)
  : local.sameDomain && !!domain && member.email.endsWith(`@${domain}`)

/** Whether this machine's own policy still shares it with [email]: by address, or by the owner's domain. */
export function stillShared(local: LocalPolicy, domain: string | null, email: string): boolean {
  return local.emails.includes(email) || (local.sameDomain && !!domain && email.endsWith(`@${domain}`))
}

/** The machines of those the backend says use this one, those this machine's own policy names. */
export function trustedKeys(local: LocalPolicy, remote: SharePolicy): SharedTrustPeer[] {
  return remote.members
    .filter((m) => names(local, remote.domain, m))
    .flatMap((m) => m.machines.map((machine) => ({ ...machine, label: `${machine.label || 'Machine'} · ${m.email}`, email: m.email })))
}

const answerFailure = (f: PortFailure): Record<string, unknown> => ({ error: f.failed.code, message: f.failed.message })

/** The real guests: OS accounts through the helper, the owner's sign-ins read where the engines keep them. */
function machineGuests(log: (line: string) => void, file: string): GuestLaunches {
  return createGuestLaunches({
    accounts: createGuestAccounts(),
    helperState: async () => (await guestHelperStatus()).state,
    folders: () => readPolicy(file).folders,
    startRelay: () => startSubscriptionRelay({ owner: createOwnerSubscriptions(), log: (line) => log(`relay · ${line}`) }),
    ...(process.env.LANG ? { lang: process.env.LANG } : {}),
    log: (line) => log(`guest ${line}`),
  })
}

/** A guest launch as the core asks for it; null when it is not one. */
export function guestLaunchInput(payload: Record<string, unknown>): GuestLaunchInput | null {
  if (typeof payload.email !== 'string' || typeof payload.engine !== 'string' || typeof payload.bypassPermission !== 'boolean') return null
  if (payload.prompt !== undefined && typeof payload.prompt !== 'string') return null
  if (payload.cwd !== undefined && typeof payload.cwd !== 'string') return null
  // Flags as an engine takes them (`--permission-mode`, `auto`): never a word that is not one.
  const flags = payload.permissionFlags
  if (flags !== undefined && (!Array.isArray(flags) || flags.length > 4 || !flags.every((f) => typeof f === 'string' && /^-{0,2}[A-Za-z][A-Za-z0-9-]*$/.test(f)))) return null
  return { email: payload.email, engine: payload.engine, bypassPermission: payload.bypassPermission,
    ...(payload.prompt ? { prompt: payload.prompt } : {}), ...(payload.cwd ? { cwd: payload.cwd } : {}),
    ...(flags ? { permissionFlags: flags as string[] } : {}) }
}

export function startSharedMachines(core: CoreApi, overrides: Partial<SharedMachinesDeps> = {}): ServiceRequests {
  const log = overrides.log ?? ((line: string) => console.log(`[shared-machines] ${line}`))
  const file = overrides.file ?? join(core.dataDir, 'shared-machines.json')
  const deps: SharedMachinesDeps = {
    port: overrides.port !== undefined ? overrides.port : null,
    file,
    setTimer: overrides.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms).unref(); return { cancel: () => clearTimeout(t) } }),
    log,
    guests: overrides.guests ?? machineGuests(log, file),
    folderProblem: overrides.folderProblem ?? ((path) => ownerFolderProblem(path)),
    guestAccess: overrides.guestAccess ?? (async () => (await guestHelperStatus()).state),
    enableGuests: overrides.enableGuests ?? (() => installGuestHelper()),
  }
  const port = deps.port
  const guests = deps.guests
  if (overrides.ports) {
    overrides.ports.sharedMachines = {
      guestLaunch: (input) => guests.launch(input),
      stop: async () => { timer?.cancel(); await guests.stop() },
    }
  }
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
    // a backend that lost it, the owner's domain now public). What it then holds is kept here, as `set` keeps it:
    // it drops an address it never shares with (the owner's own), and a policy still naming one read back as
    // different at every read, so it was written again every two minutes and each write had every member's
    // apps re-read their machines (Diego's, every 1 to 3 minutes, 2026-10-28).
    if (!failed(remote) && !samePolicy(local, remote)) {
      remote = await port.publish(local.emails, local.sameDomain && !!remote.domain)
      if (!failed(remote) && !samePolicy(local, remote)) {
        writePolicy(deps.file, { ...local, emails: remote.emails, sameDomain: remote.sameDomain })
      }
    }
    if (!failed(remote)) desired.keys = shares(local) ? trustedKeys(local, remote) : []
    if (desired.pins || desired.keys) {
      const held = await port.trust(desired)
      if (failed(held)) deps.log(`could not update the trust stores: ${held.failed.message}`)
    }
    // A guest sharing no longer names spends nothing more of the owner's subscriptions and keeps none of the
    // owner's folders; every guest it names has the folders the owner shares.
    if (!failed(remote)) await syncGuests(local, remote.domain, remote.members.map((m) => m.email))
  }

  const syncGuests = (local: LocalPolicy, domain: string | null, members: string[]): Promise<void> =>
    guests.sync((email) => stillShared(local, domain, email), [...new Set([...local.emails, ...members])])

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
    // A harness shared or taken back (`harness_shares`) changes no machine's sharing: read again on every one of those, every
    // member's daemon followed each Swarm agent's invitations with this read (review of #1977, 2026-10-28).
    core.account.onNotice((notice) => { if (notice.type === 'machines_changed' && notice.reason !== 'harness_shares') schedule(port, NOTICE_MS) })
  }

  const view = async (): Promise<Record<string, unknown>> => {
    const local = readPolicy(deps.file)
    const remote = port ? await port.policy() : null
    if (!remote || failed(remote)) {
      return { ...local, domain: null, members: [], ...(remote ? answerFailure(remote) : { error: 'NOT_SIGNED_IN' }) }
    }
    return { ...local, sameDomain: local.sameDomain && !!remote.domain, domain: remote.domain,
      members: remote.members.filter((m) => names(local, remote.domain, m))
        .map((m) => ({ email: m.email, name: m.name, via: m.via, machines: m.machines.length })),
      guestAccess: await deps.guestAccess().catch(() => 'missing' as const) }
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
          writePolicy(deps.file, { ...readPolicy(deps.file), emails: published.emails, sameDomain: published.sameDomain })
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
        // Guest access: the helper that runs guests' harnesses as their own OS accounts, installed behind
        // one admin prompt on this computer (lib/guestHelperInstall.ts). Sharing turns it on first.
        case 'enable_guests': {
          const installed = await deps.enableGuests()
          if (!installed.ok) return { error: installed.code, message: installed.message }
          return { ok: true, guestAccess: await deps.guestAccess().catch(() => 'missing' as const) }
        }
        case 'set_folders': {
          const folders = normalizeFolders(payload.folders)
          if (!folders) return { error: 'BAD_REQUEST', message: `Choose up to ${SHARED_FOLDERS_MAX} folders, each by its full path.` }
          const problem = folders.map((f) => deps.folderProblem(f.path)).find((p) => p !== null)
          if (problem) return { error: 'BAD_REQUEST', message: problem }
          const local = { ...readPolicy(deps.file), folders }
          writePolicy(deps.file, local)
          // Given to every guest now (or taken back), not at their next harness.
          if (port) await read(port)
          else await syncGuests(local, null, [])
          return view()
        }
        default: return { error: 'UNKNOWN_ACTION' }
      }
    },
    // A guest's: where it may start a harness. Its workspace, and the folders the owner shares with guests.
    guest_folders: async (_payload, asker) => {
      if (!asker.guest && !asker.owner) return { error: 'OWNER_REQUIRED' }
      return { workspace: asker.guest ? guestWorkspaceFor(asker.guest) : null, folders: readPolicy(deps.file).folders }
    },
  }
}
