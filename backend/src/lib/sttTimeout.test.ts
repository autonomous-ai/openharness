import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_CLAIM_MS } from '../superTabs/voiceMessages.js'
import { transcribe as deviceDeepgram } from './deepgram.js'
import { transcribeWavWithDeepgram } from './deepgramWav.js'
import { transcribe as deviceGemini } from './gemini.js'

vi.mock('../config/env.js', () => ({ env: { DEEPGRAM_API_KEY: 'dg-key', GEMINI_API_KEY: 'gm-key', GEMINI_STT_MODEL: 'gemini-test' } }))

// A speech-to-text service that stops answering holds its call, and with it a chat voice message's memory slot and claim
// (store.ts readVoice), until the connection gives up on its own, minutes later. Every call ends by its own timeout instead.
const asked: number[] = []

/** A service that never answers, as a hung connection does: the call ends only when its signal does. */
const hungService = () => vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  const signal = init?.signal
  if (!signal) return reject(new Error('The call carries no timeout, so it waits on a silent service for as long as the connection lives.'))
  if (signal.aborted) return reject(signal.reason)
  signal.addEventListener('abort', () => reject(signal.reason), { once: true })
}))

beforeEach(() => {
  asked.length = 0
  // Fired at once: no test waits for a clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    asked.push(ms)
    return AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
  })
  vi.stubGlobal('fetch', hungService())
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('every speech-to-text call', () => {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['Deepgram, for a chat voice message and the dial\'s WAV', () => transcribeWavWithDeepgram(Buffer.from('wav'), 'audio/wav', 'en')],
    ['Deepgram, for the device\'s PCM', () => deviceDeepgram(Buffer.from('pcm'), 16000, 'en')],
    ['Gemini, for the device\'s PCM', () => deviceGemini(Buffer.from('pcm'), 16000)],
  ]

  it.each(calls)('%s ends when the service stays silent, before another may claim the same voice message', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(asked).toHaveLength(1)
    expect(asked[0]!).toBeGreaterThan(0)
    expect(asked[0]!).toBeLessThanOrEqual(VOICE_CLAIM_MS)
  })
})
