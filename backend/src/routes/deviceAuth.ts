import type { FastifyInstance } from 'fastify'
import type { Machine } from '@prisma/client'
import { prisma, machineAlive } from '../lib/prisma.js'
import { machineService } from '../services/MachineService.js'
import { userService } from '../services/UserService.js'
import { storedAutonomousEnvironment } from '../lib/autonomousEnvironment.js'
import { AppError } from '../errors/index.js'
import { sendSuccess, sendError } from '../utils/response.js'
import { logger } from '../utils/logger.js'
import { consumeRateLimit } from '../lib/bus.js'
import { countryCodeFromHeaders } from '../lib/clientGeo.js'
import { createDaemonSession, createViewerSession } from '../lib/harnessSession.js'
import {
  startDeviceAuth, pollDeviceAuth, findByUserCode, resolveDeviceAuth, normalizeUserCode,
  normalizeComputerId, claimDeviceAuth, releaseDeviceAuthClaim,
} from '../lib/deviceAuth.js'

/**
 * Device-authorization grant for clients that cannot do a browser redirect — the `harness` CLI and the
 * desktop app (see lib/deviceAuth.ts for why it exists).
 *
 *   app  → POST /api/device-auth/start    (no auth)  → { userCode, deviceCode }
 *   user →      web page, signed in       → POST /api/device-auth/approve { userCode, machineId? }
 *   app  → POST /api/device-auth/poll     (no auth)  → { status: pending | approved + apiKey }
 *
 * `machineId` is optional, and the two shapes are different products:
 *   WITH it    — the Mac app's picker. The user chose a machine they already own; nothing is created.
 *   WITHOUT it — the CLI's `harness auth device`. The server answers with the machine already bound to
 *                the asking computer, or makes one. See machineService.resolveOrCreateForComputer.
 *
 * start/poll are unauthenticated BY DESIGN — the app has no credential yet, which is the whole point.
 * They are safe because neither reveals anything: `start` returns codes it just minted, and `poll`
 * requires the 32-byte device code and hands its payload over exactly once.
 */
const RATE_WINDOW_SEC = 10 * 60
const START_PER_WINDOW = 30
const APPROVE_PER_WINDOW = 20
/** A phone's sealed roster: 256 members at most, each well under 300 bytes of JSON. */
const MAX_SEALED_ROSTER = 128 * 1024
/** Mirrors lib/deviceAuth.ts TTL_SEC, for the confirm screen's countdown. */
const DEVICE_AUTH_TTL_SEC = 180

export async function deviceAuthRoutes(app: FastifyInstance): Promise<void> {
  // ── app: begin ───────────────────────────────────────────────────────────────────────────────────
  app.post<{ Body: { computerId?: string; label?: string; fingerprint?: string; kind?: string; pub?: string } }>('/api/device-auth/start', async (req, reply) => {
    // A browser's sign-in page asks as a viewer: there is no computer to bind, only a session to mint.
    const viewer = req.body?.kind === 'viewer'
    const computerId = viewer ? '' : normalizeComputerId(String(req.body?.computerId ?? ''))
    const label = String(req.body?.label ?? '').trim().slice(0, 120)
    if (!viewer && !computerId) {
      return sendError(reply, 'computerId must be a hex computer fingerprint', 'BAD_REQUEST', 400)
    }
    // Unauthenticated by design, so bounded per address: a QR is redrawn every few minutes, not per second.
    if (!(await consumeRateLimit(`devauth:start:${req.ip}`, START_PER_WINDOW, RATE_WINDOW_SEC))) {
      return sendError(reply, 'too many sign-in requests — wait a few minutes', 'RATE_LIMITED', 429)
    }
    const fp = String(req.body?.fingerprint ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')
    // The asker's E2EE public key: 32 bytes of base64, which the approving phone checks against the QR's
    // fingerprint and takes into its trust group.
    const pub = String(req.body?.pub ?? '')
    const pubOk = /^[A-Za-z0-9+/]{43}=$/.test(pub)
    const out = await startDeviceAuth(computerId ?? '', label || (viewer ? 'browser' : 'computer'), {
      ...(viewer ? { kind: 'viewer' as const } : {}),
      ...(pubOk ? { pub } : {}),
      ...(/^[0-9A-Z]{8,64}$/.test(fp) ? { fingerprint: fp } : {}),
      ...(countryCodeFromHeaders(req.headers) ? { country: countryCodeFromHeaders(req.headers) } : {}),
    })
    return sendSuccess(reply, {
      userCode: out.userCode,
      deviceCode: out.deviceCode,
      expiresIn: out.expiresInSec,
      interval: out.intervalSec,
    })
  })

  // ── app: poll ────────────────────────────────────────────────────────────────────────────────────
  app.post<{ Body: { deviceCode?: string } }>('/api/device-auth/poll', async (req, reply) => {
    const deviceCode = String(req.body?.deviceCode ?? '')
    if (!/^[a-f0-9]{64}$/.test(deviceCode)) return sendError(reply, 'bad device code', 'BAD_REQUEST', 400)
    const record = await pollDeviceAuth(deviceCode)
    // Expired or already consumed. Deliberately the same answer for both: a caller holding a stale code
    // learns nothing about whether it was ever valid.
    if (!record) return sendSuccess(reply, { status: 'expired' })
    if (record.state === 'pending') return sendSuccess(reply, { status: 'pending' })
    if (record.state === 'denied') return sendSuccess(reply, { status: 'denied', error: record.error })
    const session = record.session
    if (!session) return sendSuccess(reply, { status: 'expired' })
    return sendSuccess(reply, {
      status: 'approved',
      kind: record.kind ?? 'machine',
      ...(record.sealedRoster ? { sealedRoster: record.sealedRoster } : {}),
      machineId: record.machineId,
      token: session.token,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      autonomousEnv: session.autonomousEnv,
    })
  })

  // ── web: what am I approving? (SSO-authed) ───────────────────────────────────────────────────────
  // Shown before the user commits, so they can see WHICH computer is asking and pick the machine.
  app.get<{ Querystring: { userCode?: string } }>('/api/device-auth/lookup', async (req, reply) => {
    const found = await findByUserCode(String(req.query?.userCode ?? ''))
    if (!found) return sendError(reply, 'that code is not valid or has expired', 'NOT_FOUND', 404)
    if (found.record.state !== 'pending') return sendError(reply, 'that code has already been used', 'GONE', 410)

    // Only machines the user could actually adapt: `remote` is the one authMode /api/adapter-ws accepts.
    const machines = await prisma.machine.findMany({
      where: { userId: req.user!.sub, authMode: 'remote', ...machineAlive },
      orderBy: { createdAt: 'asc' },
    })
    const existing = found.record.kind === 'viewer'
      ? undefined
      : machines.find((m) => !!m.computerId && m.computerId === found.record.computerId)
    return sendSuccess(reply, {
      kind: found.record.kind ?? 'machine',
      ...(found.record.pub ? { pub: found.record.pub } : {}),
      label: found.record.label,
      computerId: found.record.computerId,
      fingerprint: found.record.fingerprint ?? null,
      country: found.record.country ?? null,
      requestedAt: found.record.requestedAt ?? null,
      expiresAt: found.record.requestedAt ? found.record.requestedAt + DEVICE_AUTH_TTL_SEC * 1000 : null,
      existingMachine: existing
        ? { machineId: existing.machineId, name: existing.name?.trim() || existing.hostname || existing.machineId.slice(0, 8) }
        : null,
      machines: machines.map((m) => ({
        machineId: m.machineId,
        name: m.name?.trim() || m.hostname || m.machineId.slice(0, 8),
        hostname: m.hostname,
        // The app supersedes whatever adapter currently holds a machine, so surface which one this
        // computer has used before — reconnecting the same box is safe, taking someone else's is not.
        isThisComputer: !!m.computerId && m.computerId === found.record.computerId,
        billingBlocked: m.billingStatus === 'pending' || m.billingStatus === 'suspended',
      })),
    })
  })

  // ── web: approve (SSO-authed) ────────────────────────────────────────────────────────────────────
  app.post<{ Body: { userCode?: string; machineId?: string; sealedRoster?: string } }>('/api/device-auth/approve', async (req, reply) => {
    // Either kind may carry the phone's trust group, sealed under the QR's code: stored, never read.
    const sealed = String(req.body?.sealedRoster ?? '')
    if (sealed && (sealed.length > MAX_SEALED_ROSTER || !/^[A-Za-z0-9+/=]+$/.test(sealed))) {
      return sendError(reply, 'bad roster', 'BAD_REQUEST', 400)
    }
    if (!(await consumeRateLimit(`devauth:approve:${req.user!.sub}`, APPROVE_PER_WINDOW, RATE_WINDOW_SEC))) {
      return sendError(reply, 'too many approvals — wait a few minutes', 'RATE_LIMITED', 429)
    }
    const found = await findByUserCode(String(req.body?.userCode ?? ''))
    if (!found) return sendError(reply, 'that code is not valid or has expired', 'NOT_FOUND', 404)
    if (found.record.state !== 'pending') return sendError(reply, 'that code has already been used', 'GONE', 410)

    // Exclusive ownership BEFORE anything that can create a machine. Two approvals racing the same code
    // used to both pass the `pending` check above and both create — see lib/deviceAuth.ts.
    if (!(await claimDeviceAuth(found.deviceHash))) {
      return sendError(reply, 'that code is already being used', 'GONE', 410)
    }

    const machineId = String(req.body?.machineId ?? '').trim()
    let machine: Machine | null
    let created = false

    // Any failure past this point hands the claim back, so the user can fix the problem (finish a
    // checkout, pick a different machine) and retry the SAME code while it is still alive.
    const giveUp = async (message: string, code: string, status: number): Promise<void> => {
      await releaseDeviceAuthClaim(found.deviceHash)
      return sendError(reply, message, code, status)
    }

    // ── a browser (kind viewer) ──────────────────────────────────────────────────────────────────
    // A phone's session minting another session: `/api/auth/handoff` refuses that, and this is the
    // deliberate exception — behind a confirm screen naming the browser, its country and its key.
    // Nothing is created or bound. The phone hands the browser its trust group: the roster, sealed
    // under the QR's pairing code, which this server stores and passes on without being able to read.
    async function approveViewer(deviceHash: string, label: string): Promise<void> {
      let session
      try {
        session = await createViewerSession({ userId: req.user!.sub, label })
      } catch (err) {
        await releaseDeviceAuthClaim(deviceHash)
        throw err
      }
      if (!session) return giveUp('user not found', 'NOT_FOUND', 404)
      await resolveDeviceAuth(deviceHash, {
        state: 'approved',
        userId: req.user!.sub,
        session,
        ...(sealed ? { sealedRoster: sealed } : {}),
      })
      logger.info('device-auth approved (viewer)', { userId: req.user!.sub, roster: !!sealed })
      return sendSuccess(reply, { kind: 'viewer' })
    }
    if (found.record.kind === 'viewer') return approveViewer(found.deviceHash, found.record.label)

    if (machineId) {
      // ── explicit pick (the Mac app) ────────────────────────────────────────────────────────────
      // This branch deliberately NEVER creates a machine. Picking one from a list must not be able to
      // start a paid subscription behind the user's back: they choose one they already own, and if
      // they own none the web sends them through the normal purchase flow first. This is also why
      // Cursor costs nothing extra — it reuses the Remote machine the user already bought.
      machine = await prisma.machine.findFirst({
        where: { machineId, userId: req.user!.sub, ...machineAlive },
      })
      if (!machine) return giveUp('machine not found', 'NOT_FOUND', 404)
      if (machine.authMode !== 'remote') {
        return giveUp('that machine is not a Remote machine', 'NOT_REMOTE', 400)
      }
      if (machine.billingStatus === 'pending' || machine.billingStatus === 'suspended') {
        return giveUp('that machine needs its subscription completed first', 'BILLING', 402)
      }
      // Bind the asking computer to it, so a later `harness auth device` from the same box lands here
      // instead of minting a second machine.
      if (machine.computerId !== found.record.computerId) {
        await prisma.machine.update({
          where: { machineId: machine.machineId },
          data: { computerId: found.record.computerId },
        }).catch(() => { /* best effort — the adapter-ws connect stamps it too */ })
      }
    } else {
      // ── no pick (the CLI) ──────────────────────────────────────────────────────────────────────
      // The computer is the subject: reuse the machine already bound to it, else make one. Free, so
      // there is nothing to charge and no checkout to run.
      const owner = await userService.get(req.user!.sub)
      if (!owner) return giveUp('user not found', 'NOT_FOUND', 404)
      try {
        const out = await machineService.resolveOrCreateForComputer(
          req.user!.sub,
          storedAutonomousEnvironment(owner.autonomousEnv),
          found.record.computerId,
          found.record.label,
        )
        machine = out.machine
        created = out.created
      } catch (err) {
        await releaseDeviceAuthClaim(found.deviceHash)
        if (err instanceof AppError) return sendError(reply, err.message, err.code ?? 'ERROR', err.statusCode)
        throw err
      }
    }

    // The machine's own sign-in, bound to the computer that asked — see lib/harnessSession.ts.
    let session
    try {
      session = await createDaemonSession({
        userId: req.user!.sub,
        machineId: machine.machineId,
        computerId: found.record.computerId,
        label: found.record.label,
      })
    } catch (err) {
      await releaseDeviceAuthClaim(found.deviceHash)
      throw err
    }
    await resolveDeviceAuth(found.deviceHash, {
      state: 'approved',
      machineId: machine.machineId,
      userId: req.user!.sub,
      session,
      ...(sealed ? { sealedRoster: sealed } : {}),
    })
    logger.info('device-auth approved', {
      userId: req.user!.sub, machineId: machine.machineId, computerId: found.record.computerId, created,
    })
    return sendSuccess(reply, {
      machineId: machine.machineId,
      machineName: machine.name?.trim() || machine.hostname || null,
      created,
    })
  })

  // ── web: deny (SSO-authed) ───────────────────────────────────────────────────────────────────────
  app.post<{ Body: { userCode?: string } }>('/api/device-auth/deny', async (req, reply) => {
    const found = await findByUserCode(String(req.body?.userCode ?? ''))
    if (!found) return sendError(reply, 'that code is not valid or has expired', 'NOT_FOUND', 404)
    // "Not me": only a request still waiting. An approved one is the machine's already, and this must
    // not let anyone who holds the code snatch its sign-in back out from under it.
    if (found.record.state !== 'pending') return sendError(reply, 'that code has already been used', 'GONE', 410)
    await resolveDeviceAuth(found.deviceHash, { state: 'denied', error: 'declined on the phone' })
    return sendSuccess(reply, { ok: true })
  })
}

export { normalizeUserCode }
