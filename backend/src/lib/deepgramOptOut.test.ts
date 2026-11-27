import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transcribe } from './deepgram.js'
import { transcribeWavWithDeepgram } from './deepgramWav.js'

vi.mock('../config/env.js', () => ({ env: { DEEPGRAM_API_KEY: 'dg-key' } }))

// Customer audio must never train Deepgram's models: every request opts out of its Model Improvement Program.
const urls: string[] = []

beforeEach(() => {
  urls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    urls.push(String(url))
    return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'hi' }] }] } }), { status: 200 })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const query = (url: string) => Object.fromEntries(new URL(url).searchParams)

describe('every Deepgram request', () => {
  it('opts the dial\'s WAV out of model improvement and keeps its params', async () => {
    await transcribeWavWithDeepgram(Buffer.from('wav'), 'audio/wav', 'vi')
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatch(/^https:\/\/api\.deepgram\.com\/v1\/listen\?/)
    expect(query(urls[0])).toEqual({
      model: 'nova-2', language: 'vi', punctuate: 'true', smart_format: 'false', mip_opt_out: 'true',
    })
  })

  it('opts the device\'s PCM out of model improvement and keeps its params', async () => {
    await transcribe(Buffer.from('pcm'), 8000, 'fr')
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatch(/^https:\/\/api\.deepgram\.com\/v1\/listen\?/)
    expect(query(urls[0])).toEqual({
      model: 'nova-3', language: 'fr', punctuate: 'true', smart_format: 'false',
      encoding: 'linear16', sample_rate: '8000', channels: '1', mip_opt_out: 'true',
    })
  })
})
