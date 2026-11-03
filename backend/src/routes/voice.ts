/**
 * Transcription for the cabled dial.
 *
 *   POST /api/voice/stt?lang=vi    multipart, one part `file` (WAV) → { transcript, lang }
 *
 * ONE difference from routes/cursor.ts's endpoint, and it is the whole reason this file exists: this one
 * is authenticated by the caller's **SSO access token**, not by a shared secret. The `harness` CLI signs
 * in (`harness login`) and holds a real bearer token that refreshes itself; the dial holds no credential
 * at all and never talks to this service — it hands its audio down a USB cable to the daemon, and the
 * daemon is the one with an account.
 *
 * That matters beyond tidiness. The CLI ships from a PUBLIC repository, so a shared secret baked into it
 * is a secret nobody has. A bearer token is issued per person, expires, and can be revoked.
 *
 * NOT in the auth middleware's skip-list, deliberately: being absent from that list is what applies the
 * SSO gate, so `req.user` is populated here and an unauthenticated request never reaches this handler.
 *
 * WHAT BOUNDS IT. Every clip is paid on Harness's Deepgram key, so a signed-in account is held to what its
 * device would be held to (lib/deviceWs.ts), in this order, each before anything is spent on the next:
 *   1. a per-minute cap per account, counted in Redis across every pod (lib/rateLimit.ts);
 *   2. the process-wide voice memory budget (lib/voiceBudget.ts), taken for the whole request before the
 *      upload is buffered and given back once it is answered;
 *   3. the account's plan's daily voice seconds (lib/voiceQuota.ts), charged by the clip's length before
 *      Deepgram is called and given back when Deepgram fails.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'

import { VOICE_WAV_LANGS, transcribeWavWithDeepgram } from '../lib/deepgramWav.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { releaseVoice, reserveVoice } from '../lib/voiceBudget.js'
import { VoiceQuotaExceededError, voiceQuotaService } from '../lib/voiceQuota.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { logger } from '../utils/logger.js'

export const VOICE_STT_PATH = '/api/voice/stt'

/** ~25 MB — far above any dictation clip this serves, while still bounding one request's buffer. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/** Per account. Dictation is a clip every few seconds at most; a client in a loop does not get far. */
const PER_MINUTE = 10
const MINUTE_MS = 60_000

/** What the phone and the dial record (16 kHz, mono, 16-bit): the rate a WAV is charged at when its
 *  header does not state a believable one. */
const FALLBACK_BYTES_PER_SECOND = 16_000 * 2
const WAV_HEADER_BYTES = 44

/**
 * The clip's length in milliseconds, as Deepgram will hear it: the bytes after the header at the rate the
 * header states. The header is the caller's to write, so a rate outside what a microphone records (which
 * would make a long clip read as no time at all) is not believed and the recorders' own rate is used.
 */
export function wavDurationMs(audio: Buffer): number {
  const pcmBytes = Math.max(0, audio.length - WAV_HEADER_BYTES)
  let bytesPerSecond = FALLBACK_BYTES_PER_SECOND
  if (audio.length >= WAV_HEADER_BYTES && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE') {
    const channels = audio.readUInt16LE(22)
    const sampleRate = audio.readUInt32LE(24)
    const bits = audio.readUInt16LE(34)
    if (channels >= 1 && channels <= 2 && sampleRate >= 8_000 && sampleRate <= 48_000 && [8, 16, 24, 32].includes(bits)) {
      bytesPerSecond = sampleRate * channels * (bits / 8)
    }
  }
  return Math.ceil((pcmBytes / bytesPerSecond) * 1000)
}

function dailyLimitMessage(err: VoiceQuotaExceededError): string {
  const minutes = Math.round(err.snapshot.limitSeconds / 60)
  return `You've used today's voice limit (${minutes} minutes a day). It resets at midnight UTC.`
}

/** The language the dial stated. Unknown values fall back rather than failing: a transcript in the wrong
 *  language is recoverable by the person; a 400 in the middle of a spoken turn is not. */
function pickLang(value: unknown): string {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return VOICE_WAV_LANGS.has(v) ? v : 'en'
}

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  // Registered inside this plugin's scope, not in server.ts: multipart parsing exists for this route and
  // nothing else, so no other endpoint's body handling changes by adding it.
  await app.register(multipart, { limits: { fileSize: MAX_AUDIO_BYTES, files: 1 } })

  // Per plugin instance, so each app (and each test) counts from zero in this process when Redis is absent.
  const perMinute = createRateLimiter('voice-stt', MINUTE_MS, PER_MINUTE)

  app.post(VOICE_STT_PATH, async (req, reply) => {
    const userId = req.user?.sub ?? ''
    if (!(await perMinute.allows(userId))) {
      sendError(reply, 'Too many voice clips in a minute. Wait a moment and try again.', 'RATE_LIMITED', 429)
      return
    }

    // The whole request is an upper bound on the clip it carries: Node reads no more than Content-Length,
    // and a request without one (chunked) is held to the most this route accepts.
    const declared = Number(req.headers['content-length'])
    const held = Number.isFinite(declared) && declared > 0 ? Math.min(declared, MAX_AUDIO_BYTES + 64 * 1024) : MAX_AUDIO_BYTES
    if (!reserveVoice(held)) {
      logger.warn('voice-stt: voice memory budget full', { user: userId, bytes: held })
      sendError(reply, 'Voice is busy right now. Try again in a moment.', 'VOICE_BUSY', 503)
      return
    }
    try {
      await transcribe(req, reply, userId)
    } finally {
      releaseVoice(held)
    }
  })

  async function transcribe(req: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
    let file
    try {
      file = await req.file()
    } catch {
      sendError(reply, 'Expected a multipart/form-data upload', 'BAD_REQUEST', 400)
      return
    }
    if (!file) {
      sendError(reply, 'Missing audio file', 'BAD_REQUEST', 400)
      return
    }

    let audio: Buffer
    try {
      audio = await file.toBuffer()
    } catch {
      sendError(reply, 'That recording is too long to transcribe', 'PAYLOAD_TOO_LARGE', 413)
      return
    }
    if (audio.length === 0) {
      sendError(reply, 'Empty audio file', 'BAD_REQUEST', 400)
      return
    }

    const uploadId = `stt-${randomUUID()}`
    try {
      await voiceQuotaService.reserveForUser(userId, req.user?.autonomousEnv ?? 'prod', uploadId, wavDurationMs(audio))
    } catch (err) {
      if (err instanceof VoiceQuotaExceededError) {
        sendError(reply, dailyLimitMessage(err), err.code, 429, {
          limitSeconds: err.snapshot.limitSeconds,
          resetAt: err.snapshot.resetAt,
        })
        return
      }
      logger.error('voice-stt: daily voice quota unavailable', { user: userId, error: err instanceof Error ? err.message : String(err) })
      sendError(reply, 'Voice is unavailable right now. Try again in a moment.', 'VOICE_QUOTA_UNAVAILABLE', 503)
      return
    }

    const lang = pickLang((req.query as { lang?: unknown } | undefined)?.lang)
    try {
      const transcript = await transcribeWavWithDeepgram(audio, file.mimetype || 'audio/wav', lang)
      await voiceQuotaService.commit(uploadId).catch((err) => {
        // Left pending, the cleanup worker would hand these seconds back: logged, never silent.
        logger.error('voice-stt: quota commit failed', { user: userId, error: err instanceof Error ? err.message : String(err) })
      })
      // The user is logged, the words are not. A transcript is the most private thing this service sees,
      // and the useful diagnostics — did it arrive, how big, what language, did it come back empty — do
      // not require keeping it.
      logger.info('voice-stt', {
        user: userId,
        bytes: audio.length,
        lang,
        chars: transcript.length,
      })
      sendSuccess(reply, { transcript, lang })
    } catch (err) {
      await voiceQuotaService.release(uploadId).catch(() => { /* the cleanup worker releases a stale pending one */ })
      logger.error('voice-stt failed', {
        user: userId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(reply, 'Transcription failed', 'STT_FAILED', 502)
    }
  }
}
