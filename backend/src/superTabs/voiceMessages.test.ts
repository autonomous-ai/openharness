import { describe, expect, it } from 'vitest'

import { wavDurationMs } from '../lib/wav.js'
import { voiceLabel, voiceLength, voiceWaveform } from './voiceMessages.js'

/** 16 kHz mono 16-bit PCM WAV of `samples`, each one a sample value. */
function wav(samples: number[], sampleRate = 16_000): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + samples.length * 2, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((sample, i) => out.writeInt16LE(sample, 44 + i * 2))
  return out
}

describe('voice message length', () => {
  it('is written M:SS, rounded down to the second', () => {
    expect(voiceLength(81_000)).toBe('1:21')
    expect(voiceLength(81_999)).toBe('1:21')
    expect(voiceLength(600_000)).toBe('10:00')
    expect(voiceLength(999)).toBe('0:00')
    expect(voiceLength(9_000)).toBe('0:09')
  })

  it('labels a voice message with its length', () => {
    expect(voiceLabel(81_000)).toBe('Voice message (1:21)')
  })

  it('is told from a WAV file the way the voice route tells it', () => {
    expect(wavDurationMs(wav(new Array(16_000).fill(0)))).toBe(1000)
    expect(wavDurationMs(Buffer.from('not a wav at all, just some bytes here, long enough to have a header'))).toBeNull()
  })
})

describe('voice message waveform', () => {
  it('is 48 bars of silence for a silent clip', () => {
    expect(voiceWaveform(wav(new Array(16_000).fill(0)))).toEqual(new Array(48).fill(0))
  })

  it('rises where the clip gets loud', () => {
    const quiet = new Array(8_000).fill(0)
    const loud = Array.from({ length: 8_000 }, (_, i) => (i % 2 ? 12_000 : -12_000))
    const bars = voiceWaveform(wav([...quiet, ...loud]))
    expect(bars).toHaveLength(48)
    expect(Math.max(...bars.slice(0, 24))).toBe(0)
    expect(Math.min(...bars.slice(24))).toBeGreaterThan(20)
    expect(Math.max(...bars)).toBeLessThanOrEqual(31)
  })

  it('still has 48 bars for a clip shorter than 48 samples', () => {
    expect(voiceWaveform(wav([5_000, -5_000, 5_000]))).toHaveLength(48)
  })
})
