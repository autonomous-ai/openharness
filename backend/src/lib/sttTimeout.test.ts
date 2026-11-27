import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transcribe as deviceDeepgram } from './deepgram.js'
import { transcribeWavWithDeepgram } from './deepgramWav.js'
import { transcribe as deviceGemini } from './gemini.js'
import { STT_TIMEOUT_MS } from './sttTimeout.js'

vi.mock('../config/env.js', () => ({ env: { DEEPGRAM_API_KEY: 'dg-key', GEMINI_API_KEY: 'gm-key', GEMINI_STT_MODEL: 'gemini-test' } }))

// A speech-to-text service that stops answering holds its call, and with it what the call holds, until the connection gives up
// on its own, minutes later. Every call ends by its own timeout instead.
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('every speech-to-text call', () => {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['Deepgram, for the dial\'s WAV', () => transcribeWavWithDeepgram(Buffer.from('wav'), 'audio/wav', 'en')],
    ['Deepgram, for the device\'s PCM', () => deviceDeepgram(Buffer.from('pcm'), 16000, 'en')],
    ['Gemini, for the device\'s PCM', () => deviceGemini(Buffer.from('pcm'), 16000)],
  ]

  it.each(calls)('%s ends by its own timeout when the service stays silent', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(asked).toEqual([STT_TIMEOUT_MS])
  })

  // Gemini retries a busy answer: its attempts and their waits share one deadline, or slow answers would add up to minutes.
  it('gives all of Gemini\'s attempts one deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const signals: Array<AbortSignal | null | undefined> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      signals.push(init?.signal)
      return new Response('busy', { status: 503 })
    }))
    const settled = deviceGemini(Buffer.from('pcm'), 16000).then(() => null, (error: Error) => error)
    await vi.advanceTimersByTimeAsync(7_000)
    expect(await settled).toMatchObject({ message: expect.stringContaining('Gemini HTTP 503') })
    expect(signals).toHaveLength(4)
    expect(new Set(signals).size).toBe(1)
    expect(asked).toHaveLength(1)
  })
})
