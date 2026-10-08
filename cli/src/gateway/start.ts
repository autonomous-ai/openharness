/**
 * The gateway, started: everything that holds this machine's keys or speaks for them, built in one place
 * so that it runs the same in the core's process (`HARNESSD_SERVICES=none`, or a master that does not run
 * it) and in its own (gateway/gatewayProcess.ts). It is what `runForeground` wired by hand before the relay
 * left the core (docs/design/2026-10-06-core-boundary-next.md, step 10, R2), moved as it was:
 *
 *   - the relay (gateway/gateway.ts): the backend link, the E2EE manager and its sessions, P2P;
 *   - the windows' own sessions to the owner's other machines (lib/remoteRelay.ts `RemoteRelayPool`);
 *   - the trust group (lib/e2ee/groupSyncer.ts) and the account's device key log (deviceLogSyncer.ts);
 *   - the Wi-Fi device's direct links (lib/autonomous-device/direct.ts), which carry its E2EE sessions;
 *   - the daemon's own commands about the keys (`harness pair`, `unpair`, `group`, `devices`, …).
 *
 * The core gives it what it cannot hold itself: its events (`GatewayEvents`), the account's tokens and the
 * backend's REST answers, both through `core.account` (a service holds no credential), and a few facts
 * that it says again whenever they change (`GatewayOps.account`, `reachable`, …).
 */
import { renameSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import type { GatewayAccount, GatewayEvents, GatewayOps, HttpAnswer, WindowRelay } from '../core/api.js'
import { AutonomousDeviceDirect } from '../lib/autonomous-device/direct.js'
import { startDevicePart } from '../lib/autonomous-device/parts.js'
import type { AuthSessionManager } from '../lib/authSession.js'
import { thisDeviceLabel } from '../lib/daemonState.js'
import { switchAccountTrust } from '../lib/e2ee/accountTrust.js'
import { b64d, b64e, fingerprint } from '../lib/e2ee/core.js'
import { DeviceLogStore } from '../lib/e2ee/deviceLogStore.js'
import { DeviceLogSyncer, type DeviceKeysSeen, type DeviceLogFetched, type DeviceLogTrustOutcome } from '../lib/e2ee/deviceLogSyncer.js'
import { GroupSyncer, relayRequester, SELF_STAMP } from '../lib/e2ee/groupSyncer.js'
import { MachinePeerStore } from '../lib/e2ee/machinePeers.js'
import { E2eeStore } from '../lib/e2ee/store.js'
import { TrustGroupStore, type GroupMember } from '../lib/e2ee/trustGroup.js'
import { RemoteRelayPool } from '../lib/remoteRelay.js'
import { HarnessShareRelay, type SharedMachineReference } from '../sharing/relay.js'
import { RelayGateway } from './gateway.js'
import { LaneSessions } from './lane.js'
import { observerKey } from './observerKey.js'
import { shareWindows } from './share.js'
import { createAccountHttp } from './accountHttp.js'

/** What the gateway needs of the core, in whichever process it runs. */
export interface GatewayHost {
  events: GatewayEvents
  /** The id this daemon serves under: the account's machine id signed in, the computer's own signed out. */
  machineId: string
  computerId: string
  autonomousEnv: string
  /** Signed in when the core started: the trust group syncs, and the device key log registers this machine. */
  signedIn: boolean
  /** The account's tokens, as `core.account` hands them out; it never holds the session itself. */
  tokens: Pick<AuthSessionManager, 'accessToken'>
  /** Local identity for the guest list; the core reports these facts without doing network work. */
  machineName: string
  hostname: string
  machines?(state: import('../core/api.js').GatewayMachines): void
  /** The account's sign-in as it stood when the core started; `GatewayOps.account` says it again. */
  account: GatewayAccount
}

export interface StartedGateway {
  port: RelayGateway
  ops: GatewayOps
  windowRelay: Required<WindowRelay>
  stop(): Promise<void>
}

/** A key is looked up in the device key log at most this often for a hello: a client that retries its
 *  hello every few seconds, or a relay replaying one, reads the log once, not each time. */
const UNKNOWN_HELLO_EVERY_MS = 10_000

/** What `trustFromLog` found, as the log line says it. */
const TRUST_OUTCOME: Record<DeviceLogTrustOutcome, string> = {
  trusted: 'trusted: it is on the account\'s device list',
  self: 'not trusted: it is this machine\'s own key',
  absent: 'not on the account\'s device list',
  suspended: 'not trusted: suspended on the device list until it is reviewed (harness devices)',
  blocked: 'not trusted: blocked, it was unpaired here',
  tombstoned: 'not trusted: removed from this machine\'s trust group',
  frozen: 'not trusted: the device log is frozen here until it is reviewed (harness devices)',
  unavailable: 'not trusted: the device log could not be read',
}

/**
 * The gateway's `onUnknownHello`: a hello from a key not paired here re-reads the account's device key log,
 * which trusts the key if it is on it. A web viewer that signs in before this machine does is added to the
 * log before this machine joins it; its hello was denied as unpaired until the next scheduled read, and
 * the person saw "Link required" for up to ten minutes with nothing in the log to say why.
 */
export function unknownHelloReader(
  devlog: Pick<DeviceLogSyncer, 'trustFromLog'>, log: (line: string) => void, now: () => number = Date.now,
): (identityPub: string) => Promise<void> {
  // A hello said again while its key's read is still on its way waits for that read rather than being
  // denied at once: the browser dials again a second after a denial, and the read that trusts it may
  // well take longer than that.
  const lastRead = new Map<string, { at: number; read: Promise<void> }>()
  return (identityPub) => {
    const at = now()
    for (const [pub, r] of lastRead) if (at - r.at >= UNKNOWN_HELLO_EVERY_MS) lastRead.delete(pub)
    const earlier = lastRead.get(identityPub)
    if (earlier) return earlier.read
    const who = fingerprint(b64d(identityPub))
    log(`[e2ee] hello from ${who} is not paired here — re-reading the device log`)
    const read = devlog.trustFromLog(identityPub).then((outcome) => { log(`[e2ee] ${who}: ${TRUST_OUTCOME[outcome]}`) })
    lastRead.set(identityPub, { at, read })
    return read
  }
}

/** Pairing errors as `harness pair` maps them to HTTP. */
const PAIR_STATUS: Record<string, number> = {
  NO_INTENT: 409, EXPIRED: 409, CODE_MISMATCH: 403, BACKEND_DOWN: 503,
  RATE_LIMITED: 429, BUSY: 409, TIMEOUT: 504,
}

export function startGateway(host: GatewayHost): StartedGateway {
  let account = host.account
  let reachable: Set<string> | null = null
  const accountHttp = createAccountHttp({
    tokens: host.tokens, account: () => account,
    computer: { id: host.computerId, name: host.machineName, hostname: host.hostname }, environment: host.autonomousEnv,
    changed: host.machines,
    reachable: (ids) => { reachable = ids ? new Set(ids) : null },
    log: (line) => console.log(`[gateway] ${line}`),
  })
  const gateway = new RelayGateway({
    machineId: host.machineId, auth: host.tokens, computerId: host.computerId, autonomousEnv: host.autonomousEnv, core: host.events,
  })

  /** The identity this machine was removed under is never used again: the next start mints a new one. */
  const spendIdentity = (): void => {
    const identityFile = join(env.ADAPTER_DATA_DIR, 'e2e', 'identity.json')
    try { renameSync(identityFile, `${identityFile}.removed-${Date.now()}`) } catch { /* already gone */ }
  }
  // Same on-disk identity `harness remote-password set`/`link connect` use (E2eeStore.init() is
  // idempotent per file, so a separate in-memory instance here just reads the one this machine
  // already has).
  const relayIdentityStore = new E2eeStore()
  relayIdentityStore.init()
  const relayPeers = new MachinePeerStore()
  // The fleet's lane's sessions, sealed with the same identity (gateway/lane.ts).
  const lane = new LaneSessions(() => relayIdentityStore.getIdentity())
  // Share's owner's welcomes, signed with the same identity (gateway/observerKey.ts).
  const ownerKey = observerKey(() => relayIdentityStore.getIdentity())
  // The trust group and the device key log are built below; the pool's callbacks reach them through these.
  let groupSyncer: GroupSyncer | null = null
  let devLogSyncer: DeviceLogSyncer | null = null
  const relayPool = new RemoteRelayPool(
    host.tokens,
    env.BACKEND_WS_URL.replace(/\/$/, ''),
    relayIdentityStore.getIdentity(),
    relayPeers,
    {
      onSessionReady: (machineId) => groupSyncer?.sessionOpened(machineId),
      // A machine the account's device key log names under this very key will trust us as soon as it
      // reads the log: keep its pin through a few denials, and nudge it (and us) to read.
      expectsTrust: (machineId, pub) => {
        const m = devLogSyncer?.list().members.find((x) => x.pub === pub)
        const expected = !!m && m.kind === 'machine' && m.machineId === machineId && !devLogSyncer?.suspendedKeys().includes(pub)
        if (expected) void devLogSyncer?.refresh()
        return expected
      },
    },
  )
  // The Share relay: a window here watching a harness someone shared with this account, over its own
  // socket to the backend (`/api/observer-ws`), signed in with the account's token. It finds the share
  // among those the backend lists for this account first.
  const shareRelay = new HarnessShareRelay(host.tokens, env.BACKEND_WS_URL, host.autonomousEnv, async () => {
    const result = await accountHttp.backend('GET', '/api/harness-shares')
    if (result.status !== 200) throw new Error('Shared harnesses are temporarily unavailable.')
    return ((result.body as { data?: { machines?: SharedMachineReference[] } }).data?.machines ?? [])
  })
  const windowRelay: Required<WindowRelay> = {
    acquire: (...args) => relayPool.acquire(...args),
    acquireIsolated: (...args) => relayPool.acquireIsolated(...args),
    invalidate: (machineId) => relayPool.invalidate(machineId),
    invalidateIsolated: (machineId) => relayPool.invalidateIsolated(machineId),
    acquireShare: shareWindows(shareRelay),
  }
  /** This machine as its trust group knows it — see groupSyncer.ts's SELF_STAMP for the stamp. */
  const groupSelf = (): GroupMember => {
    const machineId = account.machineId
    return { pub: b64e(relayIdentityStore.getIdentity().pub), kind: 'machine', label: hostname(), at: SELF_STAMP, ...(machineId ? { machineId } : {}) }
  }
  // Every machine and phone linked to this one, directly or through another member, trusts every other:
  // rosters are swapped over any session that opens, and pushed on whenever they change.
  const syncer = new GroupSyncer({
    store: new TrustGroupStore(),
    peers: new MachinePeerStore(),
    self: groupSelf,
    trust: (peer) => gateway.trustPeer(peer),
    untrust: (pub) => { gateway.untrustPeer(pub) },
    paired: () => gateway.pairedPeers(),
    request: relayRequester(relayPool, () => host.autonomousEnv),
    dropSessions: (machineId) => { relayPool.invalidate(machineId); relayPool.invalidateIsolated(machineId) },
    suspended: () => new Set(devLogSyncer?.suspendedKeys() ?? []),
    // Only a list the backend answered says who is offline; otherwise try every member.
    reachable: () => reachable,
    ready: () => devLogSyncer?.current() ?? false,
    log: (line) => console.log(line),
  })
  groupSyncer = syncer
  gateway.groupSync = syncer
  gateway.onPeerLinked = (peer) => syncer.linked(peer)
  gateway.onUnpaired = (pub) => {
    syncer.unpaired(pub)
    // Unpairing a device here takes it out of the account's log too — or the log would trust it again.
    void devLogSyncer?.remove(pub)
  }
  // Started once this machine is signed in: at start, or on the first link-up after a sign-in that the
  // core told it of (`ops.account`).
  let groupStarted = false
  const startGroup = (): void => {
    if (groupStarted || !account.machineId) return
    groupStarted = true
    syncer.start()
  }
  if (host.signedIn) { groupStarted = true; syncer.start() }
  // When each key last opened a session or read the log, from the backend, and since when that record
  // runs: the Devices list's "last active", and what `sweepStale` judges an unused app key by. null when
  // it could not be asked; `since` null from a backend that does not say.
  const deviceKeysSeen = async (): Promise<DeviceKeysSeen | null> => {
    const r = await accountHttp.backend('GET', '/api/device-keys/seen').catch(() => null)
    const data = r?.status === 200 ? r.body.data as { seen?: unknown; since?: unknown } | undefined : undefined
    if (!data?.seen || typeof data.seen !== 'object') return null
    return { seen: data.seen as Record<string, number>, since: Number.isSafeInteger(data.since) ? data.since as number : null }
  }
  const devlog = new DeviceLogSyncer({
    store: new DeviceLogStore(),
    identity: () => { const id = relayIdentityStore.getIdentity(); return { pub: b64e(id.pub), priv: id.priv } },
    self: () => ({ machineId: account.machineId, label: thisDeviceLabel() }),
    // Which sign-in by hand this machine is under (minted by `harness login`, never a backend answer —
    // the machine id is one): the device log can start over only when THIS changes.
    signIn: () => account.signIn,
    switchAccount: (from, to) => {
      // Run once, whatever it throws: the log goes on to the new account either way, and its devices
      // come back from that log. Run again, a half-done switch would put away what it already restored.
      try { switchAccountTrust(from, to) } catch (err) {
        console.log(`[devlog] could not swap the trust stores to the new account: ${err instanceof Error ? err.message : String(err)}`)
      }
      gateway.e2ee.reloadPaired()
      // Sessions to the old account's machines, and who the group last synced with, are that account's.
      relayPool.close()
      syncer.reset()
    },
    fetch: async (since) => {
      // `self`: this read counts as this machine's key being used (a backend from before it ignores it).
      const self = encodeURIComponent(b64e(relayIdentityStore.getIdentity().pub))
      const r = await accountHttp.backend('GET', `/api/device-keys?since=${since}&self=${self}`)
      const data = r.status === 200 ? r.body.data as Partial<DeviceLogFetched> | undefined : undefined
      const head = data?.head as { seq?: unknown; hash?: unknown } | undefined
      if (!data || typeof data.acct !== 'string' || !Array.isArray(data.entries) || typeof head?.seq !== 'number'
        || !Number.isSafeInteger(head.seq) || head.seq < 0 || typeof head.hash !== 'string') return null
      return { acct: data.acct, head: { seq: head.seq, hash: head.hash }, entries: data.entries }
    },
    append: async (entry) => {
      const p = await gateway.appendDeviceLog(entry as unknown as Record<string, unknown>)
      if (!p) return null
      const head = p.head as { seq?: unknown; hash?: unknown } | undefined
      const parsedHead = typeof head?.seq === 'number' && typeof head.hash === 'string' ? { seq: head.seq, hash: head.hash } : undefined
      if (typeof p.error === 'string') return { error: p.error, ...(parsedHead ? { head: parsedHead } : {}) }
      return parsedHead ? { head: parsedHead } : null
    },
    adopt: (members) => syncer.adoptFromLog(members),
    drop: (pub) => { syncer.remove(pub) },
    // Snapshotted once, when this machine joins the log: what it already trusts then is never news.
    trustedNow: () => [...new Set([
      ...gateway.pairedPeers().map((p) => p.identityPub),
      ...relayPeers.list().map((p) => p.pub),
      ...syncer.roster().members.map((m) => m.pub),
    ])],
    tombstoned: (pub) => !!syncer.tombstoned(pub),
    blocked: (pub) => !!syncer.isBlocked(pub),
    isTrusted: (pub) => gateway.pairedPeers().some((p) => p.identityPub === pub),
    announce: (m) => {
      const fp = fingerprint(b64d(m.pub))
      console.log(`[devlog] NEW DEVICE on this account: ${m.label || '(no name)'} (${m.kind}) ${fp} — not yours? harness devices remove ${fp}`)
      host.events.toWindows({ type: 'device_key_added', payload: { pub: m.pub, label: m.label, kind: m.kind, machineId: m.machineId, at: m.addedAt, fingerprint: fp } })
    },
    removed: (n) => {
      if (n.selfRemoved) console.log(`[devlog] ${n.label || '(no name)'} signed out of this account (${n.fingerprint})`)
      else if (n.signerPending) console.log(`[devlog] ⚠ ${n.label || '(no name)'} (${n.fingerprint}) was removed by a NEW device you have not looked at: ${n.signerLabel || 'another device'} (${n.signerFingerprint}) — not yours? harness devices remove ${n.signerFingerprint}`)
      else console.log(`[devlog] ${n.label || '(no name)'} (${n.fingerprint}) was removed from this account by ${n.signerLabel || 'another device'}`)
      host.events.toWindows({ type: 'device_key_removed', payload: { ...n } })
    },
    conflict: (c) => {
      host.events.toWindows({ type: 'device_conflict', payload: { pub: c.pub, label: c.label, fingerprint: c.fingerprint, addedAt: c.addedAt, afterJoin: c.afterJoin } })
    },
    suspend: (pubs) => syncer.suspend(pubs),
    resume: () => syncer.resume(),
    signedOut: () => {
      // This machine's key was removed from the account: it is signed out, and comes back — after a
      // new `harness login` — with a NEW key, which every other device announces as a new device.
      console.log('[devlog] this machine was removed from the account\'s devices — signing out')
      spendIdentity()
      host.events.revoked()
    },
    seen: deviceKeysSeen,
    changed: () => host.events.toWindows({ type: 'device_keys_changed', payload: {} }),
    log: (line) => console.log(line),
  })
  // Each register is also the offer of a sweep of unused app keys (at most one per 6 hours, on one
  // machine of the account: deviceLogSyncer `sweepStale`).
  const registerAndSweep = (): void => { void devlog.register().then(() => devlog.sweepStale()) }
  devLogSyncer = devlog
  syncer.devlog = devlog
  // Removed while online: the backend's `machine_revoked` arrives before this machine reads the log, and
  // stops it. The key is spent all the same, or the next `harness login` would come back under a banned
  // key and be signed out again.
  gateway.onDeviceRemoved = (pub) => {
    if (pub === b64e(relayIdentityStore.getIdentity().pub)) spendIdentity()
  }
  // A removal of another key under this machine id — the earlier install a reinstall waits behind — is
  // not this machine signed out: the log re-read that follows registers this key (deviceLogSyncer).
  gateway.isOwnDeviceKey = (pub) => pub === b64e(relayIdentityStore.getIdentity().pub)
  // A removal the trust group carried in — typically `harness group remove` on a machine that predates
  // the log — goes into the log as well, signed by this machine, so a device that only reads the log
  // stops trusting that key too. A key the log no longer has is left alone.
  syncer.onDropped = (pub) => {
    if (devlog.list().members.some((m) => m.pub === pub && !m.self)) void devlog.remove(pub)
  }
  gateway.onDeviceKeysChanged = () => { void devlog.refresh() }
  // Every time the link comes up: a sign-in from before the log existed joins it with no one doing
  // anything, and one that joined already only reads what it missed while offline. Wired signed out
  // too, and register() rather than refresh() on the timer: a daemon that was signed out when it started
  // never registered after `harness login` signed it in (register does nothing while signed out).
  gateway.onLinkUp = () => {
    startGroup()
    registerAndSweep()
  }
  const devlogTimer = setInterval(registerAndSweep, 10 * 60_000)
  devlogTimer.unref()
  // Signed out there is no account, and no device log of one, to find a key on.
  const readForHello = unknownHelloReader(devlog, (line) => console.log(line))
  gateway.onUnknownHello = (pub) => account.machineId ? readForHello(pub) : Promise.resolve()

  // The Wi-Fi device's direct links, which carry its E2EE sessions: only while its service runs in the
  // core, or a device it connected would be answered by nothing.
  let direct: AutonomousDeviceDirect | undefined
  gateway.onDirectDeviceRevoked = fp => direct?.revoked(fp)
  const startDirect = (): void => {
    if (direct) return
    direct = startDevicePart('Wi-Fi device link', () => new AutonomousDeviceDirect({
      machineId: host.machineId, label: hostname(),
      receive: (connId, frame, pairing) => gateway.receiveDirectDevice(connId, frame, pairing),
      attach: (connId, send) => gateway.attachDirectDevice(connId, send),
      detach: connId => gateway.detachDirectDevice(connId),
      pending: () => gateway.pendingPair(), pendingConnection: () => gateway.e2ee.pendingConnection(),
      authenticatedFingerprint: connId => { const pub = gateway.e2ee.sessionIdentity(connId); return pub ? fingerprint(b64d(pub)) : null },
      pairedFingerprint: connId => gateway.pairedDirectFingerprint(connId),
      pair: code => gateway.pair(code), paired: () => gateway.listPairs(),
    }, env.ADAPTER_DATA_DIR))
    direct?.start()
  }

  /** A trust-group member by machine id, list number, or fingerprint (full or unique prefix). */
  const findGroupMember = (selector: string): { ok: true; pub: string; label: string; fingerprint: string } | { ok: false; error: 'NOT_FOUND' | 'AMBIGUOUS' } => {
    const members = new TrustGroupStore().list()
    const norm = (v: string): string => v.toUpperCase().replace(/[·\s-]/g, '')
    const byIndex = /^\d+$/.test(selector) ? members[Number(selector) - 1] : undefined
    const byMachine = members.find((m) => m.machineId === selector)
    const hit = byMachine ?? byIndex ?? (() => {
      const matches = members.filter((m) => norm(m.fingerprint).startsWith(norm(selector)))
      return matches.length > 1 ? 'AMBIGUOUS' as const : matches[0]
    })()
    if (hit === 'AMBIGUOUS') return { ok: false, error: 'AMBIGUOUS' }
    if (!hit || !selector.trim()) return { ok: false, error: 'NOT_FOUND' }
    return { ok: true, pub: hit.pub, label: hit.label, fingerprint: hit.fingerprint }
  }
  const refusal = (error: unknown): { refused: { code: string; message: string } } =>
    ({ refused: { code: String((error as { code?: unknown }).code ?? 'INTERNAL'), message: error instanceof Error ? error.message : String(error) } })
  const devicePairs = () => gateway.listPairs().filter((p) => p.role === 'device')

  const ops: GatewayOps = {
    backend: accountHttp.backend,
    machines: accountHttp.machines,
    mintGridName: accountHttp.mintGridName,
    status: async () => ({ fingerprint: gateway.fingerprint(), pairs: gateway.listPairs(), pending: gateway.pendingPair() as Record<string, unknown> | null }),
    // `harness pair <code>` → run CPace toward the waiting browser; map the result to an HTTP outcome.
    pair: async (code) => {
      const r = await gateway.pair(code)
      if (r.ok) return { status: 200, body: { label: r.label, fingerprint: r.fingerprint } }
      return { status: PAIR_STATUS[r.error] ?? 400, body: { error: r.error } }
    },
    listPairs: async () => ({ status: 200, body: { pairs: gateway.listPairs() } }),
    revoke: async (id) => {
      const r = gateway.revoke(id)
      if (r.ok) return { status: 200, body: { label: r.label, fingerprint: r.fingerprint } }
      return { status: r.error === 'AMBIGUOUS' ? 409 : 404, body: { error: r.error } }
    },
    revokeAll: async () => ({ status: 200, body: gateway.revokeAll() }),
    // `harness remote-password set|clear|status` — mutate/read the running daemon's live E2EE state
    // directly, so `harness link connect` from another machine sees a just-set password immediately.
    setRemotePassword: async (password) => ({ status: 200, body: await gateway.setRemotePassword(password) }),
    clearRemotePassword: async () => { gateway.clearRemotePassword(); return { status: 200, body: { ok: true } } },
    remotePasswordStatus: async () => ({ status: 200, body: gateway.remotePasswordStatus() }),
    trustLinkedPeer: async (peer) => {
      gateway.trustPeer({ ...peer, kind: 'machine' })
      syncer.linked({ ...peer, kind: 'machine' })
      return { status: 200, body: { ok: true } }
    },
    groupList: async () => ({ status: 200, body: { self: groupSelf(), members: new TrustGroupStore().list() } }),
    groupSync: async () => { void syncer.syncAll(); return { status: 200, body: { ok: true } } },
    groupRemove: async (selector) => {
      const found = findGroupMember(selector)
      if (!found.ok) return { status: found.error === 'AMBIGUOUS' ? 409 : 404, body: { error: found.error } }
      syncer.remove(found.pub)
      // And out of the device key log, or the next read of it would put the device back.
      void devlog.remove(found.pub)
      return { status: 200, body: { label: found.label, fingerprint: found.fingerprint } }
    },
    devicesList: async () => {
      // When each key last opened a session, from the backend — a hint for removing apps not used in a
      // long while. Without it the list is still the list.
      return { status: 200, body: { ...devlog.list(), lastSeen: (await deviceKeysSeen())?.seen ?? {} } }
    },
    devicesRemove: async (pub) => {
      syncer.remove(pub)
      const r = await devlog.remove(pub)
      if (r.ok) return { status: 200, body: { ok: true } }
      const status = r.error === 'NOT_IN_LOG' ? 404 : r.error === 'UNAVAILABLE' ? 503 : 409
      return { status, body: { error: r.error, ...(r.detail ? { detail: r.detail } : {}) } }
    },
    devicesHistory: async () => ({ status: 200, body: { ...(await devlog.history()) } }),
    devicesDismiss: async (body) => { devlog.dismiss(body); return { status: 200, body: { ok: true } } },
    devicesRebaseline: async (confirm, head) => {
      const r = await devlog.rebaseline(confirm, head)
      if (r && 'error' in r) return { status: 409, body: { error: r.error } }
      return r ? { status: 200, body: { ...r, applied: confirm } } : { status: 502, body: { error: 'LOG_UNAVAILABLE' } }
    },
    wifi: async ({ op, device, code, id }) => {
      try {
        if (op === 'discover') {
          if (!direct) throw Object.assign(new Error('The Wi-Fi device link is not running on this computer: its state could not be read. See the daemon\'s log.'), { code: 'UNAVAILABLE' })
          return { result: { devices: await direct.discover() } }
        }
        if (op === 'pair') {
          if (!direct) throw Object.assign(new Error('The Wi-Fi device link is not running on this computer: its state could not be read. See the daemon\'s log.'), { code: 'UNAVAILABLE' })
          return { result: await direct.pair(String(device), String(code)) }
        }
        if (op === 'pairStatus') {
          const pending = gateway.pendingPair()
          return { result: pending?.role === 'device' ? { state: pending.active ? 'running' : 'waiting', pairId: pending.pairId, deviceLabel: pending.label, expiresAt: pending.expiresAt } : { state: 'idle' } }
        }
        if (op === 'list') return { result: { devices: devicePairs().map(p => ({ ...p, id: p.fingerprint })) } }
        if (!devicePairs().some(p => p.fingerprint === id)) throw Object.assign(new Error('Device pairing not found'), { code: 'UNKNOWN_DEVICE' })
        const result = gateway.revoke(String(id))
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.error })
        return { result: { revoked: 1 } }
      } catch (error) { return refusal(error) }
    },
    wifiService: (on) => {
      if (on) { startDirect(); return }
      direct?.stop()
      direct = undefined
    },
    revokeIdentity: (identity) => { gateway.e2ee.revoke(fingerprint(b64d(identity))) },
    account: (next) => {
      account = next
      startGroup()
      registerAndSweep()
    },
    reachable: (machineIds) => { reachable = machineIds ? new Set(machineIds) : null },
    lane,
    observerKey: ownerKey,
  }

  return {
    port: gateway,
    ops,
    windowRelay,
    stop: async () => {
      clearInterval(devlogTimer)
      syncer.stop()
      direct?.stop()
      relayPool.close()
      shareRelay.close()
      lane.clear()
      await gateway.stop()
    },
  }
}
