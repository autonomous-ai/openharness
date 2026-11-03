// POST /api/voice/stt — the phone's voice input and the cabled dial, transcribed on Harness's Deepgram key.
//
// Pinned here: that one account cannot spend that key without bound. A burst is cut at a per-minute cap,
// the account's plan bounds its seconds a day, and an upload the process-wide voice memory budget cannot
// hold is refused before it is buffered. Deepgram is never called for a refused clip, and every answered
// clip gives its memory back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const authenticateAccessToken = vi.hoisted(() => vi.fn())
vi.mock('../lib/ssoAuth.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/ssoAuth.js')>()),
  authenticateAccessToken,
}))

const transcribeWavWithDeepgram = vi.hoisted(() => vi.fn())
vi.mock('../lib/deepgramWav.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/deepgramWav.js')>()),
  transcribeWavWithDeepgram,
}))

// The voice usage tables and the plan rows, in memory: enough of Prisma for lib/voiceQuota.ts.
interface MachineRow { userId: string; planId: string | null; deletedAt?: Date | null; billingStatus?: string | null; billingActivatedAt?: Date | null; autonomousEnv?: string }
interface PlanRow { id: string; autonomousEnv: string; isDefault: boolean; dailyVoiceLimitSeconds: number | null }
interface UsageRow { machineId: string; dayKey: string; usedMs: number; expiresAt: Date }
const store = vi.hoisted(() => ({
  machines: [] as MachineRow[],
  plans: [] as PlanRow[],
  usage: new Map<string, UsageRow>(),
  reservations: new Map<string, Record<string, unknown>>(),
}))

vi.mock('../lib/prisma.js', () => {
  const usageKey = (where: { machineId_dayKey?: { machineId: string; dayKey: string }; machineId?: string; dayKey?: string }) => {
    const k = where.machineId_dayKey ?? where
    return `${k.machineId}|${k.dayKey}`
  }
  const alive = (m: MachineRow) => m.deletedAt == null
  const db = {
    machine: {
      findUnique: async () => null,
      findMany: async ({ where }: { where: { userId: string } }) =>
        store.machines.filter((m) => m.userId === where.userId && alive(m)).map((m) => ({ ...m })),
    },
    subscriptionPlan: {
      findUnique: async ({ where }: { where: { id: string } }) => store.plans.find((p) => p.id === where.id) ?? null,
      findFirst: async ({ where }: { where: { autonomousEnv: string; isDefault: boolean } }) =>
        store.plans.find((p) => p.autonomousEnv === where.autonomousEnv && p.isDefault === where.isDefault) ?? null,
    },
    machineVoiceDailyUsage: {
      findUnique: async ({ where }: { where: { machineId_dayKey: { machineId: string; dayKey: string } } }) => {
        const row = store.usage.get(usageKey(where))
        return row ? { ...row } : null
      },
      upsert: async ({ where, create, update }: { where: { machineId_dayKey: { machineId: string; dayKey: string } }; create: UsageRow; update: { expiresAt: Date } }) => {
        const key = usageKey(where)
        const row = store.usage.get(key)
        if (row) row.expiresAt = update.expiresAt
        else store.usage.set(key, { ...create })
        return { ...store.usage.get(key)! }
      },
      updateMany: async ({ where, data }: { where: { machineId: string; dayKey: string; usedMs?: { lte?: number } }; data: { usedMs: { increment?: number; decrement?: number } } }) => {
        const row = store.usage.get(usageKey(where))
        if (!row) return { count: 0 }
        if (where.usedMs?.lte != null && row.usedMs > where.usedMs.lte) return { count: 0 }
        row.usedMs += data.usedMs.increment ?? -(data.usedMs.decrement ?? 0)
        return { count: 1 }
      },
    },
    machineVoiceReservation: {
      findUnique: async ({ where }: { where: { uploadId: string } }) => store.reservations.get(where.uploadId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        store.reservations.set(String(data.uploadId), { ...data })
        return data
      },
      update: async ({ where, data }: { where: { uploadId: string }; data: Record<string, unknown> }) => {
        const next = { ...store.reservations.get(where.uploadId), ...data }
        store.reservations.set(where.uploadId, next)
        return next
      },
      updateMany: async ({ where, data }: { where: { uploadId: string; status?: string }; data: Record<string, unknown> }) => {
        const row = store.reservations.get(where.uploadId)
        if (!row || (where.status && row.status !== where.status)) return { count: 0 }
        store.reservations.set(where.uploadId, { ...row, ...data })
        return { count: 1 }
      },
    },
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => action(db),
  }
  return { prisma: db, machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } }
})

import { voiceRoutes, VOICE_STT_PATH } from './voice.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { env } from '../config/env.js'
import { voiceInflightBytes } from '../lib/voiceBudget.js'

const FREE: PlanRow = { id: 'plan-free', autonomousEnv: 'prod', isDefault: true, dailyVoiceLimitSeconds: 10 * 60 }
const PRO: PlanRow = { id: 'plan-pro', autonomousEnv: 'prod', isDefault: false, dailyVoiceLimitSeconds: 30 * 60 }
const MAX: PlanRow = { id: 'plan-max', autonomousEnv: 'prod', isDefault: false, dailyVoiceLimitSeconds: 0 }

const BYTES_PER_SECOND = 16_000 * 2 // 16 kHz, mono, 16-bit: what the phone and the dial record

/** A WAV of [seconds] of silence, its header stating [sampleRate] (16 kHz mono 16-bit unless forged). */
function wav(seconds: number, sampleRate = 16_000): Buffer {
  const data = Math.round(seconds * BYTES_PER_SECOND)
  const out = Buffer.alloc(44 + data)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + data, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(1, 22) // mono
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE((sampleRate * 2) >>> 0, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(data, 40)
  return out
}

function multipart(file: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = 'harness-test-boundary'
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

async function build(): Promise<FastifyInstance> {
  const app = Fastify()
  app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, authenticateAccessToken)
  await app.register(voiceRoutes)
  await app.ready()
  return app
}

const send = (app: FastifyInstance, file: Buffer, user = 'user-1') => {
  const { payload, headers } = multipart(file)
  return app.inject({
    method: 'POST',
    url: `${VOICE_STT_PATH}?lang=en`,
    payload,
    headers: { ...headers, authorization: `Bearer token-of-${user}` },
  })
}

const usedSeconds = (user: string) => {
  const row = [...store.usage.values()].find((r) => r.machineId === `user:${user}`)
  return row ? row.usedMs / 1000 : 0
}

let app: FastifyInstance
const budget = env.VOICE_INFLIGHT_MAX_BYTES

beforeEach(async () => {
  vi.clearAllMocks()
  store.machines = []
  store.plans = [FREE, PRO, MAX]
  store.usage.clear()
  store.reservations.clear()
  env.VOICE_INFLIGHT_MAX_BYTES = budget
  authenticateAccessToken.mockImplementation(async (token: string) => ({
    sub: token.replace('token-of-', ''), email: 'someone@example.com', role: 'user', autonomousEnv: 'prod',
  }))
  transcribeWavWithDeepgram.mockResolvedValue('hello there')
  app = await build()
})

afterEach(async () => {
  await app.close()
  env.VOICE_INFLIGHT_MAX_BYTES = budget
})

describe('POST /api/voice/stt', () => {
  it('transcribes a clip and charges its seconds to the account', async () => {
    const res = await send(app, wav(3))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true, data: { transcript: 'hello there', lang: 'en' } })
    expect(transcribeWavWithDeepgram).toHaveBeenCalledTimes(1)
    expect(usedSeconds('user-1')).toBe(3)
  })

  describe('per-minute cap', () => {
    it('refuses a burst past the cap with 429 and never calls Deepgram for the refused clips', async () => {
      store.machines = [{ userId: 'user-1', planId: MAX.id }]
      const codes: number[] = []
      for (let i = 0; i < 14; i++) codes.push((await send(app, wav(1))).statusCode)
      expect(codes.slice(0, 10)).toEqual(Array(10).fill(200))
      expect(codes.slice(10)).toEqual(Array(4).fill(429))
      expect(transcribeWavWithDeepgram).toHaveBeenCalledTimes(10)
      const refused = await send(app, wav(1))
      expect(refused.json().error.code).toBe('RATE_LIMITED')
    })

    it('counts each account on its own', async () => {
      for (let i = 0; i < 10; i++) await send(app, wav(1), 'user-1')
      expect((await send(app, wav(1), 'user-1')).statusCode).toBe(429)
      expect((await send(app, wav(1), 'user-2')).statusCode).toBe(200)
    })
  })

  describe('daily seconds by plan', () => {
    it('refuses a Free account past 10 minutes a day, in plain words, without calling Deepgram', async () => {
      for (let i = 0; i < 4; i++) expect((await send(app, wav(140))).statusCode).toBe(200)
      expect(usedSeconds('user-1')).toBe(560)
      transcribeWavWithDeepgram.mockClear()
      const res = await send(app, wav(60))
      expect(res.statusCode).toBe(429)
      expect(res.json().error.code).toBe('DAILY_VOICE_LIMIT_REACHED')
      expect(res.json().error.message).toMatch(/today's voice limit/i)
      expect(res.json().error.message).toMatch(/10 minutes/)
      expect(transcribeWavWithDeepgram).not.toHaveBeenCalled()
      expect(usedSeconds('user-1')).toBe(560)
      // What is left still passes.
      expect((await send(app, wav(40))).statusCode).toBe(200)
    })

    it('gives a Pro account 30 minutes a day', async () => {
      store.machines = [{ userId: 'user-1', planId: FREE.id }, { userId: 'user-1', planId: PRO.id }]
      for (let i = 0; i < 6; i++) expect((await send(app, wav(290))).statusCode).toBe(200)
      expect((await send(app, wav(61))).statusCode).toBe(429)
    })

    it('lifts the cap for an account on an unlimited plan', async () => {
      store.machines = [{ userId: 'user-1', planId: MAX.id }]
      for (let i = 0; i < 3; i++) expect((await send(app, wav(400))).statusCode).toBe(200)
    })

    it('does not grant a plan through a deleted machine or an unpaid checkout', async () => {
      store.machines = [
        { userId: 'user-1', planId: MAX.id, deletedAt: new Date() },
        { userId: 'user-1', planId: PRO.id, billingStatus: 'pending', billingActivatedAt: null },
      ]
      expect((await send(app, wav(590))).statusCode).toBe(200)
      expect((await send(app, wav(20))).statusCode).toBe(429)
    })

    it('holds even with no plan rows: a forgotten default never means unlimited', async () => {
      store.plans = []
      expect((await send(app, wav(590))).statusCode).toBe(200)
      expect((await send(app, wav(20))).statusCode).toBe(429)
    })

    it('charges by the audio, not by a header that claims an absurd sample rate', async () => {
      // 600 s of 16 kHz audio whose header claims 4 GHz would read as ~0 s; it is charged as 16 kHz.
      expect((await send(app, wav(590, 0xffff_fff0))).statusCode).toBe(200)
      expect(usedSeconds('user-1')).toBeGreaterThanOrEqual(590)
      expect((await send(app, wav(20))).statusCode).toBe(429)
    })

    it('gives the seconds back when Deepgram fails', async () => {
      transcribeWavWithDeepgram.mockRejectedValueOnce(new Error('Deepgram HTTP 500'))
      const res = await send(app, wav(30))
      expect(res.statusCode).toBe(502)
      expect(usedSeconds('user-1')).toBe(0)
    })
  })

  describe('voice memory budget', () => {
    it('refuses an upload the budget cannot hold, before Deepgram', async () => {
      env.VOICE_INFLIGHT_MAX_BYTES = 64 * 1024
      const res = await send(app, wav(5)) // ~160 KB
      expect(res.statusCode).toBe(503)
      expect(res.json().error.code).toBe('VOICE_BUSY')
      expect(transcribeWavWithDeepgram).not.toHaveBeenCalled()
      expect(voiceInflightBytes()).toBe(0)
      expect(usedSeconds('user-1')).toBe(0)
    })

    it('holds the upload in the budget while it is transcribed and releases it after each answered clip', async () => {
      let heldDuring = 0
      transcribeWavWithDeepgram.mockImplementation(async () => {
        heldDuring = voiceInflightBytes()
        return 'ok'
      })
      expect((await send(app, wav(2))).statusCode).toBe(200)
      expect(heldDuring).toBeGreaterThanOrEqual(2 * BYTES_PER_SECOND)
      expect(voiceInflightBytes()).toBe(0)

      transcribeWavWithDeepgram.mockRejectedValueOnce(new Error('Deepgram HTTP 500'))
      expect((await send(app, wav(2))).statusCode).toBe(502)
      expect(voiceInflightBytes()).toBe(0)

      store.usage.set(`user:user-1|${new Date().toISOString().slice(0, 10)}`, {
        machineId: 'user:user-1', dayKey: new Date().toISOString().slice(0, 10), usedMs: 600_000, expiresAt: new Date(Date.now() + 86_400_000),
      })
      expect((await send(app, wav(2))).statusCode).toBe(429)
      expect(voiceInflightBytes()).toBe(0)
    })
  })
})
